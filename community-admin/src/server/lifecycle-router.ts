import { pendingMediaCleanup } from "./uploads";
import { videoVersion } from "./integrations/video";
import { Router } from "express";
import type pg from "pg";
import { z } from "zod";
import { getSession, requireCapability, ApiError, auditEvent } from "./context";
import { transaction } from "./db";
import type { VerifiedMedia } from "../shared/content";
import {
  containsReference,
  operationIdentity,
  publicationBlockers,
  recordReferences,
  videoRemovalBlockers,
  type LifecycleBlocker,
  type LifecycleAction,
  type LifecycleEffect,
} from "./lifecycle";
import { decryptPrivate } from "./private-data";
import { privateStorage } from "./storage";
const reasonInput = z
  .object({ reason: z.string().trim().min(5).max(1000) })
  .strict();
const terminal = [
  "committed",
  "merged",
  "published",
  "deployed",
  "deployment_failed",
  "superseded",
  "pr_open",
  "sending",
  "unknown",
  "uncertain",
  "publishing",
];
function fail(code: string) {
  throw new ApiError(
    409,
    code,
    "La acción está bloqueada; revisa sus dependencias y el estado actual.",
  );
}
export async function mediaBlockers(
  db: pg.Pool | pg.PoolClient,
  community: string,
  asset: any,
  seeds: VerifiedMedia[],
): Promise<LifecycleBlocker[]> {
  const blockers: LifecycleBlocker[] = [];
  if (
    seeds.some(
      (s) =>
        s.id === asset.id || s.path === asset.path || s.sha256 === asset.sha256,
    )
  )
    return [{ code: "SEEDED_MEDIA_PROTECTED", module: "media", id: asset.id }];
  const targets = [asset.id, asset.path, asset.sha256];
  const groups = [
    [
      "records",
      "SELECT id,payload,scope FROM records WHERE community_id=$1 AND state<>'deleted'",
    ],
    [
      "records",
      "SELECT r.id,v.payload,r.scope FROM record_revisions v JOIN records r ON r.id=v.record_id WHERE r.community_id=$1 AND r.state<>'deleted'",
    ],
    ["drafts", "SELECT id,payload FROM drafts WHERE community_id=$1"],
    [
      "drafts",
      "SELECT d.id,v.payload FROM draft_revisions v JOIN drafts d ON d.id=v.draft_id WHERE d.community_id=$1",
    ],
    [
      "editorial-drafts",
      "SELECT id,payload FROM editorial_drafts WHERE community_id=$1",
    ],
    [
      "editorial-proposals",
      "SELECT id,manifest AS payload FROM editorial_proposals WHERE community_id=$1",
    ],
    [
      "changesets",
      "SELECT id,files AS payload FROM integration_changesets WHERE community_id=$1",
    ],
    [
      "publications",
      "SELECT id,payload FROM integration_publications WHERE community_id=$1",
    ],
  ];
  for (const [module, sql] of groups) {
    const rows = (await db.query(sql, [community])).rows;
    for (const row of rows) {
      const payload =
        row.scope === "private"
          ? decryptPrivate(row.id, row.payload)
          : row.payload;
      if (
        containsReference(payload, targets) &&
        !blockers.some((b) => b.module === module && b.id === row.id)
      )
        blockers.push({ code: "MEDIA_REFERENCED", module, id: row.id });
    }
  }
  const shared = (
    await db.query(
      "SELECT id FROM media_assets WHERE storage_key=$1 AND id<>$2",
      [asset.storage_key, asset.id],
    )
  ).rows;
  if (shared.length)
    blockers.push({ code: "MEDIA_SHARED", module: "media", id: asset.id });
  return blockers;
}
export function createLifecycleRouter({
  pool,
  seeds,
}: {
  pool: pg.Pool;
  seeds: VerifiedMedia[];
}) {
  const router = Router();
  router.get("/lifecycle/:module/:id", async (req, res) => {
    const user = getSession(res),
      module = String(req.params.module),
      id = String(req.params.id);
    let row: any,
      version: number | string = 0,
      actions: any[] = [],
      state = "",
      remoteEffect = "none";
    const cap = (name: string) =>
      user.capabilities.includes("*") || user.capabilities.includes(name);
    const action = (
      action: LifecycleAction,
      effect: LifecycleEffect,
      capability: string,
      blockers: LifecycleBlocker[] = [],
      recent = false,
    ) => ({
      action,
      effect,
      allowed: cap(capability) && !blockers.length,
      reason: !cap(capability)
        ? "PERMISSION_DENIED"
        : (blockers[0]?.code ?? null),
      blockers: cap(capability) ? blockers : [],
      requiresReason: action !== "reopen",
      requiresRecentAuth: recent,
    });
    const load = async (table: string) => {
      const r = (
        await pool.query(
          `SELECT * FROM ${table} WHERE community_id=$1 AND id=$2`,
          [user.communityId, id],
        )
      ).rows[0];
      if (!r) throw new ApiError(404, "NOT_FOUND", "Registro no encontrado.");
      return r;
    };
    if (module === "records") {
      row = await load("records");
      if (row.state === "deleted")
        throw new ApiError(404, "NOT_FOUND", "Registro no encontrado.");
      requireCapability(
        res,
        row.scope === "private" ? "contacts:read" : "content:read",
      );
      version = row.revision;
      state = row.state;
      remoteEffect = row.scope === "public" ? "publication-required" : "none";
      const blockers = [
        ...(row.type === "settings"
          ? [{ code: "MANDATORY_SETTINGS", module, id }]
          : []),
        ...(await recordReferences(pool, user.communityId, id)),
        ...(await publicationBlockers(pool, user.communityId, id)),
      ];
      // A public caller must not learn the identities of private records.
      const visible = blockers.map((b) =>
        b.module === "records" && !cap("contacts:read") ? { ...b, id: "" } : b,
      );
      actions = [
        action(
          "archive",
          row.scope === "public" ? "public-withdrawal" : "local-archive",
          row.scope === "public" ? "content:write" : "contacts:write",
          visible,
        ),
      ];
      if (row.scope === "private")
        actions.push(
          action(
            "erase",
            "private-erasure",
            "members:manage",
            [
              ...(row.state !== "archived"
                ? [{ code: "ARCHIVE_FIRST", module, id }]
                : []),
              ...visible,
            ],
            true,
          ),
        );
    } else if (module === "drafts") {
      requireCapability(res, "content:read");
      row = await load("drafts");
      version = row.revision;
      state = row.state;
      actions = [
        action(
          "discard",
          "local-discard",
          "content:write",
          row.state === "discarded"
            ? [{ code: "ALREADY_DISCARDED", module, id }]
            : [],
        ),
      ];
    } else if (module === "editorial-drafts") {
      requireCapability(res, "content:read");
      row = await load("editorial_drafts");
      if (row.actor_id !== user.id)
        throw new ApiError(404, "NOT_FOUND", "Borrador no encontrado.");
      version = row.version;
      state = row.state;
      const p = row.proposal_id
        ? (
            await pool.query(
              "SELECT state FROM editorial_proposals WHERE id=$1 AND community_id=$2",
              [row.proposal_id, user.communityId],
            )
          ).rows[0]
        : null;
      actions = [
        {
          ...action(
            "discard",
            "local-discard",
            "content:write",
            p && ["preparing", "sending", "unknown"].includes(p.state)
              ? [
                  {
                    code: "PUBLICATION_PENDING",
                    module: "editorial-proposals",
                    id: row.proposal_id,
                  },
                ]
              : [],
          ),
          requiresReason: false,
        },
      ];
    } else if (module === "jobs") {
      requireCapability(res, "jobs:curate");
      row = await load("job_records");
      version = row.version;
      state = row.payload.status;
      const pending = await publicationBlockers(pool, user.communityId, id);
      const published = Boolean(row.payload.baseEntityHash);
      remoteEffect = published ? "publication-required" : "none";
      actions = [
        action(
          published ? "withdraw" : "exclude",
          published ? "public-withdrawal" : "local-exclusion",
          "jobs:curate",
          pending,
        ),
      ];
      if (["excluded", "closed"].includes(state))
        actions.push(
          action("reopen", "review-required", "jobs:curate", pending),
        );
    } else if (module === "job-sources") {
      requireCapability(res, "jobs:curate");
      row = await load("job_sources");
      version = row.version;
      state = row.config._retired
        ? "retired"
        : row.config.enabled
          ? "enabled"
          : "paused";
      const busy = (
        await pool.query(
          "SELECT id FROM worker_outbox WHERE community_id=$1 AND kind='jobs' AND payload->>'sourceId'=$2 AND state IN('sending','unknown')",
          [user.communityId, id],
        )
      ).rows;
      actions = [
        action("retire", "source-retirement", "jobs:curate", [
          ...(row.config._retired
            ? [{ code: "SOURCE_RETIRED", module, id }]
            : []),
          ...busy.map((r) => ({
            code: "SOURCE_IN_PROGRESS",
            module: "operations",
            id: r.id,
          })),
        ]),
      ];
    } else if (module === "publications") {
      requireCapability(res, "publishing:write");
      row = await load("integration_publications");
      version = row.version;
      state = row.state;
      const busy = (
        await pool.query(
          "SELECT id FROM worker_outbox WHERE community_id=$1 AND subject_id=$2 AND state IN('sending','unknown')",
          [user.communityId, id],
        )
      ).rows;
      actions = [
        action("cancel", "unsent-cancellation", "publishing:write", [
          ...(terminal.includes(state) || state === "processing"
            ? [{ code: "ALREADY_SENDING", module, id }]
            : []),
          ...busy.map((r) => ({
            code: "ALREADY_SENDING",
            module: "operations",
            id: r.id,
          })),
        ]),
      ];
    } else if (module === "changesets") {
      requireCapability(res, "publishing:write");
      row = await load("integration_changesets");
      version = row.revision_hash;
      state = row.state;
      const a = (
        await pool.query(
          "SELECT attempt FROM website_publication_attempts WHERE operation_id=$1 ORDER BY sequence DESC LIMIT 1",
          [operationIdentity(row)],
        )
      ).rows[0]?.attempt;
      actions = [
        action(
          "cancel",
          "unsent-cancellation",
          "publishing:write",
          terminal.includes(state) || (a && a.state !== "absent")
            ? [{ code: "PUBLICATION_PENDING", module, id }]
            : [],
        ),
      ];
    } else if (module === "video-assets") {
      requireCapability(res, "publishing:write");
      row = await load("integration_video_assets");
      if (row.actor_id !== user.id)
        throw new ApiError(404, "NOT_FOUND", "Carga no encontrada.");
      version = videoVersion(row);
      state = row.state;
      const blockers = await videoRemovalBlockers(pool, user.communityId, row);
      if (row.state === "removed")
        blockers.push({ code: "UPLOAD_REMOVED", module, id });
      if (
        row.backend !== "local" &&
        row.backend !== (process.env.STORAGE_BACKEND ?? "local")
      )
        blockers.push({ code: "STORAGE_BACKEND_UNAVAILABLE", module, id });
      actions = [
        action("remove", "owned-upload-removal", "publishing:write", blockers),
      ];
    } else if (module === "media") {
      requireCapability(res, "content:read");
      row = (
        await pool.query(
          "SELECT * FROM media_assets WHERE community_id=$1 AND id=$2",
          [user.communityId, id],
        )
      ).rows[0];
      if (!row) {
        const seed = seeds.find((s) => s.id === id);
        row = seed
          ? { ...seed, storage_key: "" }
          : (await pendingMediaCleanup(pool, user.communityId, user.id, id))[0];
        if (!row) throw new ApiError(404, "NOT_FOUND", "Imagen no encontrada.");
      }
      version = row.sha256;
      state = row.state ?? (row.uploader_id ? "uploaded" : "seeded");
      const blockers = await mediaBlockers(pool, user.communityId, row, seeds);
      if (row.uploader_id !== user.id)
        blockers.push({ code: "MEDIA_NOT_OWNED", module, id });
      actions = [
        action(
          "remove",
          "owned-upload-removal",
          "content:write",
          blockers.map((b) =>
            b.module === "records" && !cap("contacts:read")
              ? { ...b, id: "" }
              : b,
          ),
        ),
      ];
    } else if (
      [
        "audit",
        "operations",
        "job-runs",
        "editorial-proposals",
        "publication-attempts",
      ].includes(module)
    ) {
      requireCapability(res, "operations:read");
      const table = (
        {
          audit: "audit_events",
          operations: "worker_outbox",
          "job-runs": "job_runs",
          "editorial-proposals": "editorial_proposals",
          "publication-attempts": "website_publication_attempts",
        } as Record<string, string>
      )[module];
      if (module === "publication-attempts") {
        const found = (
          await pool.query(
            "SELECT a.sequence FROM website_publication_attempts a WHERE a.attempt_id=$1 AND (EXISTS(SELECT 1 FROM integration_changesets c WHERE c.community_id=$2 AND (c.id::text=a.operation_id OR c.result->>'operationId'=a.operation_id OR c.result->>'proposalId'=a.operation_id)) OR EXISTS(SELECT 1 FROM editorial_proposals p WHERE p.community_id=$2 AND p.id=a.operation_id))",
            [id, user.communityId],
          )
        ).rows;
        if (!found.length)
          throw new ApiError(404, "NOT_FOUND", "Intento no encontrado.");
      } else await load(table);
      state = "retained";
      actions = [];
    } else
      throw new ApiError(
        422,
        "LIFECYCLE_MODULE_INVALID",
        "Módulo no disponible.",
      );
    res.json({
      module,
      id,
      version,
      state,
      actions,
      remoteEffect,
      retentionReason: actions.length ? null : "IMMUTABLE_HISTORY",
      ...(module === "publications" ? { revisionHash: row.revision_hash } : {}),
    });
  });
  router.post("/changesets/:id/cancel", async (req, res) => {
    const user = requireCapability(res, "publishing:write"),
      id = z.string().uuid().parse(req.params.id),
      body = reasonInput
        .extend({ revisionHash: z.string().min(1).max(200) })
        .parse(req.body);
    const value = await transaction(pool, async (db) => {
      const row = (
        await db.query(
          "SELECT * FROM integration_changesets WHERE community_id=$1 AND id=$2 FOR UPDATE",
          [user.communityId, id],
        )
      ).rows[0];
      if (!row)
        throw new ApiError(404, "NOT_FOUND", "Operación no encontrada.");
      const key =
        (row.result.bridge === "jobs-cli"
          ? "jobs-cli-operation:"
          : "website-operation:") +
        user.communityId +
        ":" +
        id;
      if (
        !(
          await db.query(
            "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS held",
            [key],
          )
        ).rows[0].held
      )
        fail("PUBLICATION_PENDING");
      if (row.revision_hash !== body.revisionHash) fail("REVISION_CONFLICT");
      const attempts = (
        await db.query(
          "SELECT attempt FROM website_publication_attempts WHERE operation_id=$1 ORDER BY sequence DESC LIMIT 1",
          [operationIdentity(row)],
        )
      ).rows;
      if (
        terminal.includes(row.state) ||
        (attempts[0] && attempts[0].attempt.state !== "absent")
      )
        fail("PUBLICATION_PENDING");
      const outbox = (
        await db.query(
          "SELECT * FROM worker_outbox WHERE community_id=$1 AND subject_id=$2 ORDER BY id FOR UPDATE",
          [user.communityId, id],
        )
      ).rows;
      if (outbox.some((o) => ["sending", "unknown"].includes(o.state)))
        fail("PUBLICATION_PENDING");
      await db.query(
        "UPDATE worker_outbox SET state='cancelled',updated_at=now() WHERE community_id=$1 AND subject_id=$2 AND state='queued'",
        [user.communityId, id],
      );
      await db.query(
        "UPDATE integration_changesets SET state='cancelled',updated_at=now() WHERE community_id=$1 AND id=$2",
        [user.communityId, id],
      );
      await auditEvent(db, user, id, "changeset_cancelled", {
        reason: body.reason,
        revisionHash: body.revisionHash,
      });
      return { id, state: "cancelled", remoteUnchanged: true };
    });
    res.json(value);
  });
  router.delete("/media/:id", async (req, res) => {
    const user = requireCapability(res, "content:write"),
      id = z.string().uuid().parse(req.params.id),
      body = reasonInput.parse(req.body),
      tag = req.get("If-Match");
    if (!tag)
      throw new ApiError(
        428,
        "PRECONDITION_REQUIRED",
        "Envía el checksum guardado.",
      );
    const db = await pool.connect(),
      lock = user.communityId + ":storage";
    let committed = false,
      asset: any;
    try {
      await db.query("SELECT pg_advisory_lock(hashtext($1))", [lock]);
      await db.query("BEGIN");
      asset = (
        await db.query(
          "SELECT * FROM media_assets WHERE community_id=$1 AND id=$2 FOR UPDATE",
          [user.communityId, id],
        )
      ).rows[0];
      let retry = false;
      if (!asset) {
        if (seeds.some((s) => s.id === id)) fail("SEEDED_MEDIA_PROTECTED");
        const tombstone = (
          await db.query(
            "SELECT details FROM audit_events WHERE community_id=$1 AND entity_id=$2 AND action='media_removed' ORDER BY created_at DESC LIMIT 1",
            [user.communityId, id],
          )
        ).rows[0]?.details;
        if (!tombstone)
          throw new ApiError(404, "NOT_FOUND", "Imagen no encontrada.");
        asset = {
          id,
          uploader_id: tombstone.ownerId,
          path: tombstone.path,
          sha256: tombstone.sha256,
          storage_key: tombstone.storageKey,
          storage_backend: tombstone.storageBackend,
        };
        retry = true;
      }
      if (asset.uploader_id !== user.id) fail("MEDIA_NOT_OWNED");
      if (tag !== `"${asset.sha256}"`) fail("REVISION_CONFLICT");
      const blockers = await mediaBlockers(db, user.communityId, asset, seeds);
      if (blockers.length) fail(blockers[0].code);
      if (privateStorage().backend !== asset.storage_backend)
        fail("STORAGE_BACKEND_UNAVAILABLE");
      if (!retry)
        await db.query(
          "DELETE FROM media_assets WHERE community_id=$1 AND id=$2",
          [user.communityId, id],
        );
      if (!retry)
        await auditEvent(db, user, id, "media_removed", {
          reason: body.reason,
          sha256: asset.sha256,
          path: asset.path,
          storageKey: asset.storage_key,
          storageBackend: asset.storage_backend,
          ownerId: asset.uploader_id,
          width: asset.width,
          height: asset.height,
          label: asset.original_name,
        });
      await db.query("COMMIT");
      committed = true;
      try {
        await privateStorage().remove(asset.storage_key);
      } catch {
        res.json({
          id,
          state: "removed",
          bytesRemoved: false,
          cleanupPending: true,
          remoteUnchanged: true,
        });
        return;
      }
      await auditEvent(db, user, id, "media_cleanup_completed", {
        sha256: asset.sha256,
      });
      res.json({
        id,
        state: "removed",
        bytesRemoved: true,
        remoteUnchanged: true,
      });
    } catch (error) {
      if (!committed) await db.query("ROLLBACK");
      throw error;
    } finally {
      try {
        await db.query("SELECT pg_advisory_unlock(hashtext($1))", [lock]);
      } finally {
        db.release();
      }
    }
  });
  return router;
}
