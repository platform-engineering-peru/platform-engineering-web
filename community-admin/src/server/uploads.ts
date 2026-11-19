import { Router } from "express";
import multer from "multer";
import sharp, { type Metadata } from "sharp";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type pg from "pg";
import { getSession, requireCapability, ApiError, auditEvent } from "./context";
import { transaction } from "./db";
import { privateStorage } from "./storage";
import type { VerifiedMedia } from "../shared/content";
export async function listMedia(
  pool: pg.Pool,
  communityId: string,
  seeds: VerifiedMedia[] = [],
) {
  const r = await pool.query(
    "SELECT id,path,sha256,width,height,original_name AS label FROM media_assets WHERE community_id=$1 ORDER BY created_at DESC LIMIT 1000",
    [communityId],
  );
  return [
    ...r.rows,
    ...seeds.filter((s) => !r.rows.some((r) => r.id === s.id)),
  ];
}
/** Cleanup intents are management-only; never include these in validation inventory. */
export async function pendingMediaCleanup(
  db: pg.Pool | pg.PoolClient,
  communityId: string,
  ownerId: string,
  id?: string,
) {
  const rows = (
    await db.query(
      `SELECT a.entity_id AS id,a.details FROM audit_events a
     WHERE a.community_id=$1 AND a.action='media_removed' AND a.details->>'ownerId'=$2
       AND ($3::text IS NULL OR a.entity_id::text=$3)
       AND NOT EXISTS(SELECT 1 FROM media_assets m WHERE m.community_id=a.community_id AND m.id=a.entity_id)
       AND NOT EXISTS(SELECT 1 FROM audit_events c WHERE c.community_id=a.community_id AND c.entity_id=a.entity_id AND c.action='media_cleanup_completed' AND c.created_at>=a.created_at)
     ORDER BY a.created_at DESC LIMIT 1000`,
      [communityId, ownerId, id ?? null],
    )
  ).rows;
  return rows.map(({ id, details: d }) => ({
    id,
    path: d.path,
    sha256: d.sha256,
    width: d.width ?? 1,
    height: d.height ?? 1,
    label: d.label ?? "",
    uploader_id: d.ownerId,
    storage_key: d.storageKey,
    storage_backend: d.storageBackend,
    state: "cleanup-pending",
    cleanupPending: true,
  }));
}
export async function mediaBytes(
  pool: pg.Pool,
  communityId: string,
  id: string,
  seeds: VerifiedMedia[] = [],
): Promise<{ bytes: Buffer; mime: string; path: string; sha256: string }> {
  const r = await pool.query(
    "SELECT * FROM media_assets WHERE id=$1 AND community_id=$2",
    [id, communityId],
  );
  if (r.rows[0]) {
    const a = r.rows[0];
    return {
      bytes: await privateStorage().get(a.storage_key),
      mime: a.mime,
      path: a.path,
      sha256: a.sha256,
    };
  }
  const seed = seeds.find((m) => m.id === id);
  if (!seed) throw new ApiError(404, "NOT_FOUND", "Imagen no encontrada.");
  return {
    bytes: await readFile(resolve("public", seed.path)),
    mime: "image/png",
    path: seed.path,
    sha256: seed.sha256,
  };
}
export function createMediaRouter({
  pool,
  seeds,
}: {
  pool: pg.Pool;
  seeds: VerifiedMedia[];
}) {
  const router = Router(),
    upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 8 },
    });
  router.get("/media", async (_req, res) => {
    requireCapability(res, "content:read");
    const user = getSession(res),
      inventory = await listMedia(pool, user.communityId, seeds),
      pending = await pendingMediaCleanup(pool, user.communityId, user.id);
    res.json([
      ...inventory,
      ...pending.map(
        ({
          id,
          path,
          sha256,
          width,
          height,
          label,
          state,
          cleanupPending,
        }) => ({
          id,
          path,
          sha256,
          width,
          height,
          label,
          state,
          cleanupPending,
        }),
      ),
    ]);
  });
  router.post(
    "/media/uploads",
    (req, res, next) => {
      requireCapability(res, "content:write");
      upload.single("file")(req, res, (error) =>
        next(
          error
            ? new ApiError(
                422,
                "UPLOAD_INVALID",
                "La imagen excede el límite o la solicitud no es válida.",
              )
            : undefined,
        ),
      );
    },
    async (req, res) => {
      const user = getSession(res);
      if (
        !req.file ||
        !req.body.source?.trim() ||
        !req.body.permissionBasis?.trim()
      )
        throw new ApiError(
          422,
          "RIGHTS_REQUIRED",
          "Agrega una imagen, su procedencia y la base del permiso.",
        );
      if (
        req.body.sha256 &&
        (!/^[a-f0-9]{64}$/.test(req.body.sha256) ||
          createHash("sha256").update(req.file.buffer).digest("hex") !==
            req.body.sha256)
      )
        throw new ApiError(
          422,
          "CHECKSUM_MISMATCH",
          "El checksum de la imagen no coincide.",
        );
      let derived: Buffer, metadata: Metadata;
      try {
        metadata = await sharp(req.file.buffer, {
          limitInputPixels: 40_000_000,
          failOn: "warning",
        }).metadata();
        if (
          !["jpeg", "png", "webp"].includes(metadata.format ?? "") ||
          req.file.mimetype !==
            (
              {
                jpeg: "image/jpeg",
                png: "image/png",
                webp: "image/webp",
              } as any
            )[metadata.format!]
        )
          throw new Error("Spoofed type");
        derived = await sharp(req.file.buffer, {
          limitInputPixels: 40_000_000,
          failOn: "warning",
        })
          .rotate()
          .resize({
            width: 2560,
            height: 2560,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: 92 })
          .toBuffer();
      } catch {
        throw new ApiError(
          422,
          "IMAGE_INVALID",
          "La imagen no se pudo decodificar o su tipo no coincide.",
        );
      }
      const actual = await sharp(derived).metadata(),
        sha256 = createHash("sha256").update(derived).digest("hex"),
        id = randomUUID(),
        name =
          req.file.originalname
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 50) || "image",
        path = `media/${sha256.slice(0, 16)}/image.webp`,
        key = `${user.communityId}/derived/${sha256}.webp`,
        storage = privateStorage();
      const asset = await transaction(pool, async (db) => {
        await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          user.communityId + ":storage",
        ]);
        const quota = await db.query(
          "SELECT COALESCE(SUM(bytes),0)::bigint AS total,COALESCE(SUM(bytes) FILTER(WHERE uploader_id=$2),0)::bigint AS personal FROM media_assets WHERE community_id=$1",
          [user.communityId, user.id],
        );
        if (
          Number(quota.rows[0].total) + derived.length >
            Number(process.env.STORAGE_QUOTA_BYTES ?? 10_000_000_000) ||
          Number(quota.rows[0].personal) + derived.length >
            Number(process.env.USER_STORAGE_QUOTA_BYTES ?? 500_000_000)
        )
          throw new ApiError(
            413,
            "STORAGE_QUOTA",
            "Se alcanzó la cuota de almacenamiento.",
          );
        await storage.put(key, derived, "image/webp");
        const r = await db.query(
          "INSERT INTO media_assets(id,community_id,uploader_id,path,sha256,width,height,mime,bytes,storage_key,storage_backend,original_name,rights) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(community_id,path) DO UPDATE SET path=EXCLUDED.path RETURNING id,path,sha256,width,height,original_name AS label",
          [
            id,
            user.communityId,
            user.id,
            path,
            sha256,
            actual.width,
            actual.height,
            "image/webp",
            derived.length,
            key,
            storage.backend,
            req.file!.originalname,
            {
              source: req.body.source.slice(0, 1000),
              permissionBasis: req.body.permissionBasis.slice(0, 1000),
              uploaderId: user.id,
            },
          ],
        );
        await auditEvent(db, user, r.rows[0].id, "media_uploaded", {
          sha256,
          width: actual.width,
          height: actual.height,
        });
        return r.rows[0];
      });
      res.status(201).json(asset);
    },
  );
  router.get("/media/:id", async (req, res) => {
    requireCapability(res, "content:read");
    const a = await mediaBytes(
      pool,
      getSession(res).communityId,
      String(req.params.id),
      seeds,
    );
    res.type(a.mime);
    if (req.query.download === "1") res.attachment(a.path.split("/").pop()!);
    res.send(a.bytes);
  });
  return router;
}
