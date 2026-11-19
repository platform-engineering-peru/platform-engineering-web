import { AsyncLocalStorage } from "node:async_hooks";
import { auditEvent } from "../context";
import { videoRemovalBlockers } from "../lifecycle";
import { hashValue } from "./security";
import express, { Router } from "express";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  writeFile,
  readFile,
  open,
  unlink,
  stat,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { resolve } from "node:path";
import type pg from "pg";
import { z } from "zod";
import { getSession, requireCapability } from "../context";
import { IntegrationError } from "./security";
export interface MultipartBackend {
  name: string;
  begin(key: string, mime: string): Promise<string>;
  signPart(key: string, uploadId: string, part: number): Promise<string>;
  complete(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<void>;
  read(key: string, offset: number, length: number): Promise<Buffer>;
  digest(
    key: string,
  ): Promise<{ bytes: number; sha256: string; signature: Buffer }>;
  abort(key: string, uploadId: string): Promise<void>;
}
const chunkSize = 8 * 1024 * 1024,
  root = resolve(".local/video");
export const videoVersion = (row: any) =>
  hashValue({
    id: row.id,
    sha256: row.sha256,
    state: row.state,
    parts: row.parts,
    updatedAt: new Date(row.updated_at).toISOString(),
  });
export class VideoAssets {
  private connections = new AsyncLocalStorage<pg.PoolClient>();
  private get db(): pg.Pool | pg.PoolClient {
    return this.connections.getStore() ?? this.pool;
  }
  private async locked<T>(
    community: string,
    id: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const db = await this.pool.connect(),
      key = `video-asset:${community}:${id}`;
    let held = false;
    try {
      held = (
        await db.query("SELECT pg_try_advisory_lock(hashtext($1)) AS held", [
          key,
        ])
      ).rows[0].held;
      if (!held) throw new IntegrationError("VIDEO_IN_PROGRESS", 409);
      return await this.connections.run(db, fn);
    } finally {
      try {
        if (held)
          await db.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
      } finally {
        db.release();
      }
    }
  }
  async descriptor(c: string, id: string, part: number) {
    return this.locked(c, id, () => this.descriptorLocked(c, id, part));
  }
  async localPart(c: string, id: string, part: number, bytes: Buffer) {
    return this.locked(c, id, () => this.localPartLocked(c, id, part, bytes));
  }
  async complete(
    c: string,
    id: string,
    parts: { partNumber: number; etag: string }[],
  ) {
    return this.locked(c, id, async () => {
      const result = await this.completeLocked(c, id, parts);
      return { ...result, version: videoVersion(await this.get(c, id)) };
    });
  }
  async read(c: string, id: string, offset: number, length: number) {
    return this.locked(c, id, () => this.readLocked(c, id, offset, length));
  }

  constructor(
    private pool: pg.Pool,
    private backend?: MultipartBackend,
  ) {}
  async get(communityId: string, id: string) {
    const row = (
      await this.db.query(
        "SELECT * FROM integration_video_assets WHERE community_id=$1 AND id=$2",
        [communityId, id],
      )
    ).rows[0];
    if (!row) throw new IntegrationError("NOT_FOUND", 404);
    if (["removed", "cleanup-pending"].includes(row.state))
      throw new IntegrationError("UPLOAD_REMOVED", 409);
    if (new Date(row.expires_at).getTime() <= Date.now())
      throw new IntegrationError("UPLOAD_EXPIRED", 409);
    return row;
  }
  async begin(
    communityId: string,
    actorId: string,
    bytes: number,
    mime: string,
    sha256: string,
  ) {
    const id = randomUUID(),
      key = `${communityId}/videos/${id}`;
    const quota = (
      await this.db.query(
        "SELECT COALESCE(sum(bytes),0) AS total FROM integration_video_assets WHERE community_id=$1 AND expires_at>now()",
        [communityId],
      )
    ).rows[0];
    if (
      Number(quota.total) + bytes >
      Number(process.env.VIDEO_STORAGE_QUOTA_BYTES ?? 10 * 1024 ** 3)
    )
      throw new IntegrationError("STORAGE_QUOTA", 413);
    if (!this.backend && process.env.NODE_ENV === "production")
      throw new IntegrationError("DIRECT_STORAGE_REQUIRED", 503);
    let uploadId = "local";
    if (this.backend) uploadId = await this.backend.begin(key, mime);
    else await mkdir(resolve(root, id), { recursive: true, mode: 0o700 });
    await this.db.query(
      "INSERT INTO integration_video_assets(id,community_id,actor_id,upload_id,storage_key,backend,bytes,mime,sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        id,
        communityId,
        actorId,
        uploadId,
        key,
        this.backend?.name ?? "local",
        bytes,
        mime,
        sha256,
      ],
    );
    return {
      id,
      version: videoVersion(await this.get(communityId, id)),
      state: "uploading",
      sha256,
      chunkSize,
      partCount: Math.ceil(bytes / chunkSize),
      backend: this.backend?.name ?? "local",
      expiresInSeconds: 900,
    };
  }
  private async descriptorLocked(
    communityId: string,
    id: string,
    part: number,
  ) {
    const row = await this.get(communityId, id);
    if (
      row.state !== "uploading" ||
      part < 1 ||
      part > Math.ceil(Number(row.bytes) / chunkSize)
    )
      throw new IntegrationError("UPLOAD_PART");
    return {
      partNumber: part,
      method: "PUT",
      url: this.backend
        ? await this.backend.signPart(row.storage_key, row.upload_id, part)
        : `/api/video/uploads/${id}/parts/${part}`,
      headers: this.backend
        ? {}
        : { "Content-Type": "application/octet-stream" },
    };
  }
  private async localPartLocked(
    communityId: string,
    id: string,
    part: number,
    bytes: Buffer,
  ) {
    const row = await this.get(communityId, id);
    if (row.backend !== "local" || row.state !== "uploading")
      throw new IntegrationError("DIRECT_STORAGE_REQUIRED");
    const expected = Math.min(
      chunkSize,
      Number(row.bytes) - (part - 1) * chunkSize,
    );
    if (part < 1 || expected <= 0 || bytes.length !== expected)
      throw new IntegrationError("UPLOAD_PART_SIZE");
    await writeFile(resolve(root, id, `part-${part}`), bytes, { mode: 0o600 });
    return {
      partNumber: part,
      etag: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  private async completeLocked(
    communityId: string,
    id: string,
    parts: { partNumber: number; etag: string }[],
  ) {
    const row = await this.get(communityId, id);
    if (row.state === "verified")
      return {
        id,
        state: "verified",
        bytes: Number(row.bytes),
        mime: row.mime,
      };
    if (
      row.state !== "uploading" ||
      parts.length !== Math.ceil(Number(row.bytes) / chunkSize) ||
      parts.some((p, i) => p.partNumber !== i + 1)
    )
      throw new IntegrationError("UPLOAD_PARTS_REQUIRED");
    let actual: { bytes: number; sha256: string; signature: Buffer };
    if (this.backend) {
      await this.backend.complete(row.storage_key, row.upload_id, parts);
      actual = await this.backend.digest(row.storage_key);
    } else {
      const destination = resolve(root, id, "video");
      async function* chunks() {
        for (const part of parts) {
          const bytes = await readFile(
            resolve(root, id, `part-${part.partNumber}`),
          );
          if (createHash("sha256").update(bytes).digest("hex") !== part.etag)
            throw new IntegrationError("CHECKSUM_MISMATCH");
          yield bytes;
        }
      }
      await pipeline(
        Readable.from(chunks()),
        createWriteStream(destination, { mode: 0o600 }),
      );
      const hash = createHash("sha256"),
        signature = Buffer.alloc(32);
      let bytes = 0;
      for await (const chunk of createReadStream(destination)) {
        const b = chunk as Buffer;
        if (bytes < 32)
          b.copy(signature, bytes, 0, Math.min(32 - bytes, b.length));
        hash.update(b);
        bytes += b.length;
      }
      actual = { bytes, sha256: hash.digest("hex"), signature };
    }
    const signatureOk =
      row.mime === "video/mp4"
        ? actual.signature.subarray(4, 8).toString() === "ftyp"
        : row.mime === "video/webm"
          ? actual.signature.subarray(0, 4).toString("hex") === "1a45dfa3"
          : false;
    if (
      actual.bytes !== Number(row.bytes) ||
      actual.sha256 !== row.sha256 ||
      !signatureOk
    ) {
      await this.db.query(
        "UPDATE integration_video_assets SET state='quarantined' WHERE id=$1",
        [id],
      );
      throw new IntegrationError("VIDEO_VALIDATION_FAILED");
    }
    await this.db.query(
      "UPDATE integration_video_assets SET state='verified',parts=$2,updated_at=now() WHERE id=$1",
      [id, JSON.stringify(parts)],
    );
    return {
      id,
      state: "verified",
      bytes: actual.bytes,
      mime: row.mime,
      sha256: actual.sha256,
    };
  }
  private async readLocked(
    communityId: string,
    id: string,
    offset: number,
    length: number,
  ) {
    const row = await this.get(communityId, id);
    if (row.state !== "verified")
      throw new IntegrationError("VIDEO_NOT_VERIFIED");
    if (this.backend) return this.backend.read(row.storage_key, offset, length);
    const file = await open(resolve(root, id, "video"), "r");
    try {
      const bytes = Buffer.alloc(length),
        result = await file.read(bytes, 0, length, offset);
      return bytes.subarray(0, result.bytesRead);
    } finally {
      await file.close();
    }
  }
  async remove(
    community: string,
    actor: string,
    id: string,
    version: string,
    reason: string,
  ) {
    return this.locked(community, id, async () => {
      const db = this.db as pg.PoolClient;
      let row: any;
      await db.query("BEGIN");
      try {
        row = (
          await db.query(
            "SELECT * FROM integration_video_assets WHERE community_id=$1 AND id=$2 FOR UPDATE",
            [community, id],
          )
        ).rows[0];
        if (!row) throw new IntegrationError("NOT_FOUND", 404);
        if (row.actor_id !== actor)
          throw new IntegrationError("VIDEO_NOT_OWNED", 403);
        if (videoVersion(row) !== version)
          throw new IntegrationError("REVISION_CONFLICT", 409);
        if (row.state === "removed")
          return await db.query("ROLLBACK").then(() => ({
            id,
            state: "removed",
            version,
            bytesRemoved: true,
            remoteUnchanged: true,
          }));
        const blockers = await videoRemovalBlockers(db, community, row);
        if (blockers.length) throw new IntegrationError(blockers[0].code, 409);
        if (row.storage_key !== `${community}/videos/${id}`)
          throw new IntegrationError("VIDEO_STORAGE_IDENTITY_INVALID", 409);
        if (row.backend !== "local" && row.backend !== this.backend?.name)
          throw new IntegrationError("STORAGE_BACKEND_UNAVAILABLE", 409);
        await db.query(
          "UPDATE integration_video_assets SET state='cleanup-pending',updated_at=now() WHERE community_id=$1 AND id=$2",
          [community, id],
        );
        await auditEvent(
          db,
          { id: actor, communityId: community },
          id,
          "video_upload_removal_requested",
          {
            reason,
            sha256: row.sha256,
            backend: row.backend,
            remoteUnchanged: true,
          },
        );
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
      let bytesRemoved = true;
      try {
        if (row.backend === "local") {
          const { rm } = await import("node:fs/promises");
          await rm(resolve(root, id), { recursive: true, force: true });
        } else await this.backend!.abort(row.storage_key, row.upload_id);
      } catch {
        bytesRemoved = false;
      }
      // Pending intent is durable before touching storage. A crash at either
      // boundary leaves a listable, attachment-fenced cleanup retry. Only a
      // completed idempotent storage cleanup earns the removed marker.
      if (bytesRemoved)
        await db.query(
          "UPDATE integration_video_assets SET state='removed',updated_at=now() WHERE community_id=$1 AND id=$2",
          [community, id],
        );
      const updated = (
        await db.query(
          "SELECT * FROM integration_video_assets WHERE community_id=$1 AND id=$2",
          [community, id],
        )
      ).rows[0];
      return {
        id,
        state: updated.state,
        version: videoVersion(updated),
        bytesRemoved,
        cleanupPending: !bytesRemoved,
        remoteUnchanged: true,
      };
    });
  }
  async cleanup() {
    const rows = (
      await this.db.query(
        "SELECT * FROM integration_video_assets WHERE expires_at<now() AND state NOT IN('expired','removed')",
      )
    ).rows;
    let count = 0;
    for (const row of rows) {
      if ((await videoRemovalBlockers(this.db, row.community_id, row)).length)
        continue;
      try {
        await this.remove(
          row.community_id,
          row.actor_id,
          row.id,
          videoVersion(row),
          "Expired unused upload retention cleanup",
        );
        count++;
      } catch (error: any) {
        if (
          ![
            "VIDEO_IN_PROGRESS",
            "REVISION_CONFLICT",
            "VIDEO_REFERENCED",
            "VIDEO_SHARED",
          ].includes(error.code)
        )
          throw error;
      }
    }
    return count;
  }
}
export function createVideoRouter(pool: pg.Pool, backend?: MultipartBackend) {
  const router = Router(),
    assets = new VideoAssets(pool, backend);
  const owned = async (community: string, actor: string, id: string) => {
    if (
      !(
        await pool.query(
          "SELECT id FROM integration_video_assets WHERE community_id=$1 AND actor_id=$2 AND id=$3",
          [community, actor, id],
        )
      ).rowCount
    )
      throw new IntegrationError("NOT_FOUND", 404);
  };
  router.get("/video/uploads", async (req, res, next) => {
    try {
      const user = requireCapability(res, "publishing:write");
      const rows = (
        await pool.query(
          "SELECT * FROM integration_video_assets WHERE community_id=$1 AND actor_id=$2 AND state<>'removed' ORDER BY created_at DESC LIMIT 100",
          [user.communityId, user.id],
        )
      ).rows;
      res.json({
        items: rows.map((row) => ({
          id: row.id,
          version: videoVersion(row),
          state: row.state,
          sha256: row.sha256,
          bytes: Number(row.bytes),
          mime: row.mime,
          expiresAt: row.expires_at,
        })),
      });
    } catch (error) {
      next(error);
    }
  });
  router.delete("/video/uploads/:id", async (req, res, next) => {
    try {
      const user = requireCapability(res, "publishing:write"),
        id = z.string().uuid().parse(req.params.id),
        body = z
          .object({ reason: z.string().trim().min(5).max(1000) })
          .strict()
          .parse(req.body),
        tag = req.get("If-Match");
      if (!tag) throw new IntegrationError("PRECONDITION_REQUIRED", 428);
      if (!/^"[a-f0-9]{64}"$/.test(tag))
        throw new IntegrationError("REVISION_INVALID", 422);
      res.json(
        await assets.remove(
          user.communityId,
          user.id,
          id,
          tag.slice(1, -1),
          body.reason,
        ),
      );
    } catch (error) {
      next(error);
    }
  });
  router.post("/video/uploads", async (req, res, next) => {
    try {
      requireCapability(res, "publishing:write");
      const data = z
          .object({
            bytes: z
              .number()
              .int()
              .positive()
              .max(5 * 1024 ** 3),
            mime: z.enum(["video/mp4", "video/webm"]),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict()
          .parse(req.body),
        user = getSession(res);
      res
        .status(201)
        .json(
          await assets.begin(
            user.communityId,
            user.id,
            data.bytes,
            data.mime,
            data.sha256,
          ),
        );
    } catch (e) {
      next(e);
    }
  });
  router.post("/video/uploads/:id/parts", async (req, res, next) => {
    try {
      requireCapability(res, "publishing:write");
      await owned(
        getSession(res).communityId,
        getSession(res).id,
        z.string().uuid().parse(req.params.id),
      );
      const part = z.number().int().positive().parse(req.body.partNumber);
      res.json(
        await assets.descriptor(
          getSession(res).communityId,
          z.string().uuid().parse(req.params.id),
          part,
        ),
      );
    } catch (e) {
      next(e);
    }
  });
  router.put(
    "/video/uploads/:id/parts/:part",
    express.raw({ type: "application/octet-stream", limit: chunkSize }),
    async (req, res, next) => {
      try {
        requireCapability(res, "publishing:write");
        await owned(
          getSession(res).communityId,
          getSession(res).id,
          z.string().uuid().parse(req.params.id),
        );
        res.json(
          await assets.localPart(
            getSession(res).communityId,
            z.string().uuid().parse(req.params.id),
            Number(req.params.part),
            req.body,
          ),
        );
      } catch (e) {
        next(e);
      }
    },
  );
  router.post("/video/uploads/:id/complete", async (req, res, next) => {
    try {
      requireCapability(res, "publishing:write");
      await owned(
        getSession(res).communityId,
        getSession(res).id,
        z.string().uuid().parse(req.params.id),
      );
      const parts = z
        .array(
          z.object({
            partNumber: z.number().int().positive(),
            etag: z.string().min(1).max(200),
          }),
        )
        .max(640)
        .parse(req.body.parts);
      res.json(
        await assets.complete(
          getSession(res).communityId,
          z.string().uuid().parse(req.params.id),
          parts,
        ),
      );
    } catch (e) {
      next(e);
    }
  });
  return router;
}
