import { assertBlogConfirmation } from "./integrations/social-indexing";
import {
  assertLifecyclePublication,
  assertRecordReferences,
  mediaReferenceFence,
} from "./lifecycle";
import { invalidatePublicConsent, requirePublicConsent } from "./consent";
import { replay, remember } from "./idempotency";
import { Router } from "express";
import type pg from "pg";
import { z } from "zod";
import { randomUUID, createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import {
  entityDefinitions,
  roleCapabilities,
} from "../shared/product-contract";
import {
  hashRevision,
  canonicalJson,
  type VerifiedMedia,
} from "../shared/content";
import { definition, validatePayload } from "./product-schema";
import {
  ApiError,
  getSession,
  requireCapability,
  auditEvent,
  requireRecentAuthentication,
  type Session,
} from "./context";
import { transaction } from "./db";
import { listMedia } from "./uploads";
import { projectPublicRecord } from "./export";
import { importSite } from "./import-site";
import {
  decryptPrivate,
  encryptPrivate,
  erasePrivateKey,
  exportPrivateKey,
  rememberDeletion,
} from "./private-data";
import { createPreview, servePreview } from "./preview";
function readCap(type: string) {
  return definition(type).scope === "public" ? "content:read" : "contacts:read";
}
function writeCap(type: string) {
  return definition(type).scope === "public"
    ? "content:write"
    : "contacts:write";
}
function decoded(row: any) {
  return {
    ...row,
    payload:
      row.scope === "private"
        ? decryptPrivate(row.id, row.payload)
        : row.payload,
  };
}
function dto(row: any) {
  row = decoded(row);
  return {
    id: row.id,
    type: row.type,
    payload: row.payload,
    revision: row.revision,
    revisionHash: row.revision_hash,
    state: row.state,
    authorId: row.author_id,
    approvedHash: row.approved_hash,
    updatedAt: new Date(row.updated_at).toISOString(),
    desiredStatus: row.desired_status,
    withdrawalRequested:
      row.scope === "public" && row.desired_status === "archived",
  };
}
function expected(req: any) {
  const s = req.get("If-Match");
  if (!s)
    throw new ApiError(
      428,
      "PRECONDITION_REQUIRED",
      "Recarga la revisión guardada antes de cambiar el registro.",
    );
  if (!/^"[1-9]\d*"$/.test(s))
    throw new ApiError(422, "REVISION_INVALID", "Revisión no válida.");
  return Number(s.slice(1, -1));
}
async function getRow(
  db: pg.Pool | pg.PoolClient,
  id: string,
  user: Session,
  lock = false,
  includeDeleted = false,
) {
  if (!z.string().uuid().safeParse(id).success)
    throw new ApiError(404, "NOT_FOUND", "Registro no encontrado.");
  if (lock)
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      user.communityId + ":record-lifecycle",
    ]);
  const r = await db.query(
    `SELECT * FROM records WHERE id=$1 AND community_id=$2 ${includeDeleted ? "" : "AND state<>'deleted'"}${lock ? " FOR UPDATE" : ""}`,
    [id, user.communityId],
  );
  if (!r.rows[0])
    throw new ApiError(404, "NOT_FOUND", "Registro no encontrado.");
  return r.rows[0];
}
async function checkReferences(
  db: pg.PoolClient,
  user: Session,
  type: string,
  payload: any,
  id: string,
) {
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    user.communityId + ":record-lifecycle",
  ]);
  await mediaReferenceFence(db, user.communityId, payload);
  if (definition(type).scope === "public")
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      user.communityId +
        ":public:" +
        (["resources", "courses"].includes(type) ? "resources" : type),
    ]);
  for (const field of definition(type).fields.filter(
    (f) => f.kind === "reference" && f.target !== "media",
  )) {
    const values = field.multiple
      ? payload[field.key]
      : payload[field.key]
        ? [payload[field.key]]
        : [];
    for (const ref of values) {
      const found = await db.query(
        "SELECT id FROM records WHERE id=$1 AND community_id=$2 AND type=$3 AND state NOT IN('archived','deleted') AND desired_status<>'archived' FOR KEY SHARE",
        [ref, user.communityId, field.target],
      );
      if (!found.rows[0])
        throw new ApiError(
          422,
          "REFERENCE_UNKNOWN",
          "Un registro relacionado no existe o está archivado.",
          [{ path: `/${field.key}`, message: "Referencia no disponible." }],
        );
    }
  }
  if (["resources", "courses"].includes(type) && payload.href) {
    const r = await db.query(
      "SELECT id,payload FROM records WHERE community_id=$1 AND type IN('resources','courses') AND id<>$2 AND state NOT IN('archived','deleted')",
      [user.communityId, id],
    );
    if (
      r.rows.some(
        (row) =>
          row.payload.href.replace(/\/$/, "") ===
          payload.href.replace(/\/$/, ""),
      )
    )
      throw new ApiError(
        409,
        "DUPLICATE_URL",
        "Este enlace ya está en el inventario.",
      );
  }
  if (
    definition(type).scope === "public" &&
    payload.displayOrder !== undefined
  ) {
    const types = ["resources", "courses"].includes(type)
      ? ["resources", "courses"]
      : [type];
    const clash = await db.query(
      "SELECT id FROM records WHERE community_id=$1 AND type=ANY($2::text[]) AND id<>$3 AND state NOT IN('archived','deleted') AND (payload->>'displayOrder')::integer=$4",
      [user.communityId, types, id, payload.displayOrder],
    );
    if (clash.rows[0])
      throw new ApiError(
        409,
        "DUPLICATE_ORDER",
        "El orden editorial ya está ocupado.",
        [{ path: "/displayOrder", message: "Elige un orden disponible." }],
      );
  }
  if (payload.slug) {
    const r = await db.query(
      "SELECT id FROM records WHERE community_id=$1 AND type=$2 AND payload->>'slug'=$3 AND id<>$4 AND state NOT IN('archived','deleted')",
      [user.communityId, type, payload.slug, id],
    );
    if (r.rows[0])
      throw new ApiError(409, "DUPLICATE_SLUG", "El slug ya está en uso.");
  }
  if (
    type === "sessions" &&
    payload.status !== "cancelled" &&
    payload.startsAt &&
    payload.endsAt
  ) {
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      user.communityId + ":agenda",
    ]);
    const candidates = await db.query(
      "SELECT * FROM records WHERE community_id=$1 AND type='sessions' AND id<>$2 AND state NOT IN('archived','deleted')",
      [user.communityId, id],
    );
    for (const row of candidates.rows) {
      const p = decoded(row).payload;
      if (
        p.status === "cancelled" ||
        Date.parse(p.endsAt) <= Date.parse(payload.startsAt) ||
        Date.parse(p.startsAt) >= Date.parse(payload.endsAt)
      )
        continue;
      if (
        (payload.room &&
          p.eventId === payload.eventId &&
          p.room.toLowerCase() === payload.room.toLowerCase()) ||
        payload.speakerIds.some((s: string) => p.speakerIds.includes(s))
      )
        throw new ApiError(
          409,
          "SESSION_OVERLAP",
          "Hay una superposición de sala o speaker.",
        );
    }
  }
}
async function checkMedia(
  pool: pg.Pool,
  user: Session,
  type: string,
  payload: any,
  seeds: VerifiedMedia[],
) {
  if (!["memories", "organizers"].includes(type)) return;
  const inventory = await listMedia(pool, user.communityId, seeds);
  const ids =
    type === "memories"
      ? payload.media.map((m: any) => m.assetId)
      : [payload.photoAssetId, payload.figurineAssetId].filter(Boolean);
  for (const id of ids)
    if (!inventory.some((a) => a.id === id))
      throw new ApiError(
        422,
        "MEDIA_UNKNOWN",
        "La imagen seleccionada no está disponible.",
      );
  if (type === "memories" && new Set(ids).size !== ids.length)
    throw new ApiError(
      422,
      "DUPLICATE_MEDIA",
      "Cada imagen debe aparecer una sola vez.",
    );
}
export function createProductRouter({
  pool,
  media,
  origin,
  githubEditorial = false,
}: {
  pool: pg.Pool;
  media: VerifiedMedia[];
  origin: string;
  githubEditorial?: boolean;
}) {
  const router = Router();
  router.use(async (req, res, next) => {
    const parsed = new URL(req.url, "http://internal"),
      path = parsed.pathname;
    if (req.method === "GET" && path.startsWith("/content/")) {
      parsed.searchParams.set("type", path.slice("/content/".length));
      req.url = "/records?" + parsed.searchParams.toString();
    }
    const aliases: Record<string, string> = {
      people: "people",
      organizations: "organizations",
      proposals: "proposals",
      sessions: "sessions",
      participations: "participations",
      followups: "followups",
      consents: "consents",
    };
    const parts = path.split("/").filter(Boolean),
      type = aliases[parts[0]];
    if (
      type &&
      (parts.length === 1 ||
        (parts.length === 2 &&
          !["export", "exports", "import"].includes(parts[1])))
    ) {
      if (parts.length === 1) {
        if (req.method === "GET") {
          parsed.searchParams.set("type", type);
          req.url = "/records?" + parsed.searchParams.toString();
        } else if (req.method === "POST") {
          req.body = { type, payload: req.body.payload ?? req.body };
          req.url = "/records";
        }
      } else req.url = "/records/" + parts[1];
    }
    if (
      path === "/drafts" &&
      req.method === "POST" &&
      (req.body.type || req.body.entityType)
    ) {
      const type = req.body.type ?? req.body.entityType;
      req.body = {
        type,
        payload: req.body.payload ?? structuredClone(definition(type).defaults),
      };
      req.url = "/records";
    }
    if (
      path.startsWith("/drafts/") &&
      parts[1] &&
      z.string().uuid().safeParse(parts[1]).success
    ) {
      const found = await pool.query(
        "SELECT id FROM records WHERE id=$1 AND community_id=$2",
        [parts[1], getSession(res).communityId],
      );
      if (found.rows[0]) req.url = "/records/" + parts.slice(1).join("/");
    }
    next();
  });

  router.get("/overview", async (_req, res) => {
    const user = getSession(res),
      canPrivate =
        user.capabilities.includes("*") ||
        user.capabilities.includes("contacts:read");
    const rows = (
      await pool.query(
        "SELECT type,scope,state,count(*)::int AS count FROM records WHERE community_id=$1 AND state<>'deleted' AND (NOT $2::boolean OR type<>'events') GROUP BY type,scope,state",
        [user.communityId, githubEditorial],
      )
    ).rows.filter((r) => r.scope === "public" || canPrivate);
    const count = (fn: (r: any) => boolean) =>
      rows.filter(fn).reduce((s, r) => s + r.count, 0);
    const queue = (
      await pool.query(
        "SELECT id,type,revision,state FROM records WHERE community_id=$1 AND scope='public' AND state='submitted' AND (NOT $2::boolean OR type<>'events') ORDER BY updated_at DESC LIMIT 10",
        [user.communityId, githubEditorial],
      )
    ).rows;
    res.json({
      counts: {
        records: count(() => true),
        drafts: count((r) => r.state === "draft"),
        pendingReviews: count((r) => r.state === "submitted"),
        approved: count((r) => r.state === "approved"),
        ...(canPrivate ? { people: count((r) => r.type === "people") } : {}),
      },
      reviewQueue: queue,
      operations: {
        oauthConfigured: Boolean(
          process.env.GITHUB_OAUTH_CLIENT_ID &&
          process.env.GITHUB_OAUTH_CLIENT_SECRET &&
          process.env.GITHUB_OWNER_SUBJECT,
        ),
        liveIntegrationsEnabled:
          process.env.INTEGRATIONS_LIVE_ENABLED === "true",
        storage: process.env.STORAGE_BACKEND ?? "local",
      },
    });
  });
  router.get("/audit", async (req, res) => {
    const u = requireCapability(res, "operations:read"),
      limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30)),
      cursor = typeof req.query.cursor === "string" ? req.query.cursor : null,
      privateRead =
        u.capabilities.includes("*") ||
        u.capabilities.includes("contacts:read");
    const r = await pool.query(
      "SELECT a.id,a.action,a.entity_id,a.created_at,u.display_name AS actor FROM audit_events a JOIN users u ON u.id=a.actor_id LEFT JOIN records r ON r.id=a.entity_id WHERE a.community_id=$1 AND ($2::uuid IS NULL OR a.id>$2) AND ($3 OR r.scope='public') ORDER BY a.id LIMIT $4",
      [u.communityId, cursor, privateRead, limit + 1],
    );
    res.json({
      items: r.rows.slice(0, limit),
      nextCursor: r.rows.length > limit ? r.rows[limit - 1].id : null,
    });
  });
  router.get("/catalog", (_req, res) =>
    res.json({
      entities: entityDefinitions,
      roles: roleCapabilities,
      capabilities: getSession(res).capabilities,
    }),
  );
  router.get("/records", async (req, res) => {
    const q = z
      .object({
        type: z.string(),
        q: z.string().max(200).default(""),
        state: z.string().optional(),
        cursor: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .parse(req.query);
    const user = requireCapability(res, readCap(q.type));
    const rows = await pool.query(
      "SELECT * FROM records WHERE community_id=$1 AND type=$2 AND state<>'deleted' AND ($3::uuid IS NULL OR id>$3) AND ($4::text IS NULL OR state=$4) ORDER BY id LIMIT 10000",
      [user.communityId, q.type, q.cursor ?? null, q.state ?? null],
    );
    const selected = rows.rows
      .map(dto)
      .filter(
        (r) =>
          !q.q ||
          JSON.stringify(r.payload).toLowerCase().includes(q.q.toLowerCase()),
      );
    res.json({
      items: selected.slice(0, q.limit),
      nextCursor: selected.length > q.limit ? selected[q.limit - 1].id : null,
    });
  });
  const createRecord = async (
    user: Session,
    type: string,
    input: any,
    client?: pg.PoolClient,
  ) => {
    if (type === "blog")
      throw new ApiError(
        409,
        "BLOG_CONFIRMATION_REQUIRED",
        "Registra primero la URL publicada mediante la confirmación social.",
      );
    const def = definition(type),
      payload = validatePayload(type, input),
      id = randomUUID();
    await checkMedia(pool, user, type, payload, media);
    const perform = async (db: pg.PoolClient) => {
      if (def.scope === "public") {
        if (!payload.slug) payload.slug = `${type}-${id}`;
        if (!payload.title?.["es-pe"]?.trim() && !payload.name?.trim()) {
          const types = ["resources", "courses"].includes(type)
            ? ["resources", "courses"]
            : [type];
          const highest = await db.query(
            "SELECT COALESCE(MAX((payload->>'displayOrder')::integer),0)::integer AS maximum FROM records WHERE community_id=$1 AND type=ANY($2::text[]) AND state NOT IN('archived','deleted')",
            [user.communityId, types],
          );
          if (payload.displayOrder <= highest.rows[0].maximum)
            payload.displayOrder = highest.rows[0].maximum + 10;
        }
      }

      await checkReferences(db, user, type, payload, id);
      const updatedAt = new Date().toISOString(),
        hash = hashRevision({ id, revision: 1, payload, updatedAt }),
        stored =
          def.scope === "private" ? encryptPrivate(id, payload) : payload;
      const row = (
        await db.query(
          "INSERT INTO records(id,community_id,type,scope,author_id,payload,revision,state,revision_hash,updated_at) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9) RETURNING *",
          [
            id,
            user.communityId,
            type,
            def.scope,
            user.id,
            stored,
            def.scope === "public" ? "draft" : "active",
            hash,
            updatedAt,
          ],
        )
      ).rows[0];
      await db.query(
        "INSERT INTO record_revisions(record_id,revision,payload,revision_hash,updated_at) VALUES($1,1,$2,$3,$4)",
        [id, stored, hash, updatedAt],
      );
      await invalidatePublicConsent(db, user, type, payload);
      await auditEvent(db, user, id, "record_created", { type, revision: 1 });
      return dto(row);
    };
    return client ? perform(client) : transaction(pool, perform);
  };
  router.post("/records", async (req, res) => {
    const body = z
      .object({ type: z.string(), payload: z.record(z.string(), z.unknown()) })
      .strict()
      .parse(req.body);
    const u = requireCapability(res, writeCap(body.type));
    const result = await transaction(pool, async (db) => {
      const entry = await replay(db, u, req);
      if (entry.cached) return entry.cached;
      const record = await createRecord(u, body.type, body.payload, db);
      await remember(db, u, entry, record);
      return record;
    });
    res.status(201).json(result);
  });
  router.get("/records/:id", async (req, res) => {
    const row = await getRow(pool, String(req.params.id), getSession(res));
    requireCapability(res, readCap(row.type));
    res.json(dto(row));
  });
  router.patch("/records/:id", async (req, res) => {
    const revision = expected(req),
      u = getSession(res),
      body = z
        .object({ payload: z.record(z.string(), z.unknown()) })
        .strict()
        .parse(req.body);
    const out = await transaction(pool, async (db) => {
      const row = await getRow(db, String(req.params.id), u, true);
      requireCapability(res, writeCap(row.type));
      if (row.revision !== revision)
        throw new ApiError(
          409,
          "REVISION_CONFLICT",
          "Otra sesión guardó una revisión más reciente.",
          [],
          row.revision,
        );
      const payload = validatePayload(row.type, body.payload);
      if (row.type === "blog")
        await assertBlogConfirmation(db, u.communityId, row.id, payload);
      await checkReferences(db, u, row.type, payload, row.id);
      await checkMedia(pool, u, row.type, payload, media);
      const updatedAt = new Date().toISOString(),
        hash = hashRevision({
          id: row.id,
          revision: revision + 1,
          payload,
          updatedAt,
        }),
        stored =
          row.scope === "private" ? encryptPrivate(row.id, payload) : payload;
      const updated = (
        await db.query(
          "UPDATE records SET payload=$1,revision=revision+1,state=$2,revision_hash=$3,submitted_hash=NULL,approved_hash=NULL,reviewer_id=NULL,updated_at=$4 WHERE id=$5 RETURNING *",
          [
            stored,
            row.scope === "private" ? "active" : "draft",
            hash,
            updatedAt,
            row.id,
          ],
        )
      ).rows[0];
      await db.query(
        "INSERT INTO record_revisions(record_id,revision,payload,revision_hash,updated_at) VALUES($1,$2,$3,$4,$5)",
        [row.id, revision + 1, stored, hash, updatedAt],
      );
      await invalidatePublicConsent(db, u, row.type, payload);
      await auditEvent(
        db,
        u,
        row.id,
        row.approved_hash ? "approval_invalidated" : "record_updated",
        {
          type: row.type,
          revision: revision + 1,
          previousHash: row.revision_hash,
          revisionHash: hash,
        },
      );
      return dto(updated);
    });
    res.json(out);
  });
  router.post("/records/:id/validate", async (req, res) => {
    const row = await getRow(pool, String(req.params.id), getSession(res));
    requireCapability(res, readCap(row.type));
    validatePayload(row.type, decoded(row).payload, true);
    res.json({ valid: true, revisionHash: row.revision_hash });
  });
  router.post("/records/:id/submit", async (req, res) => {
    const rev = expected(req),
      u = getSession(res);
    const out = await transaction(pool, async (db) => {
      const entry = await replay(db, u, req);
      if (entry.cached) return entry.cached;
      const row = await getRow(db, String(req.params.id), u, true);
      requireCapability(res, "content:write");
      if (row.scope !== "public")
        throw new ApiError(
          403,
          "PRIVATE_EXPORT_DENIED",
          "Un registro privado no se publica.",
        );
      if (row.revision !== rev)
        throw new ApiError(409, "REVISION_CONFLICT", "La revisión cambió.");
      if (!["draft", "changes_requested"].includes(row.state))
        throw new ApiError(
          409,
          "INVALID_STATE",
          "Esta revisión ya fue enviada.",
        );
      validatePayload(row.type, row.payload, true);
      await checkReferences(db, u, row.type, row.payload, row.id);
      await checkMedia(pool, u, row.type, row.payload, media);
      await projectPublicRecord(db, u.communityId, row);
      const updated = (
        await db.query(
          "UPDATE records SET state='submitted',submitted_hash=revision_hash WHERE id=$1 RETURNING *",
          [row.id],
        )
      ).rows[0];
      await auditEvent(db, u, row.id, "review_submitted", {
        revisionHash: row.revision_hash,
      });
      const result = dto(updated);
      await remember(db, u, entry, result);
      return result;
    });
    res.json(out);
  });
  router.post("/records/:id/review", async (req, res) => {
    const rev = expected(req),
      u = requireCapability(res, "content:review"),
      body = z
        .object({
          decision: z.enum(["approved", "changes_requested"]),
          revisionHash: z.string().regex(/^[a-f0-9]{64}$/),
          comment: z.string().max(2000),
        })
        .strict()
        .parse(req.body);
    const out = await transaction(pool, async (db) => {
      const row = await getRow(db, String(req.params.id), u, true);
      if (row.scope !== "public")
        throw new ApiError(
          403,
          "PRIVATE_EXPORT_DENIED",
          "No es contenido público.",
        );
      if (row.author_id === u.id)
        throw new ApiError(
          403,
          "SELF_APPROVAL_DENIED",
          "Otra persona debe revisar esta versión.",
        );
      if (
        row.revision !== rev ||
        row.state !== "submitted" ||
        row.submitted_hash !== body.revisionHash ||
        row.revision_hash !== body.revisionHash
      )
        throw new ApiError(
          409,
          "STALE_REVIEW",
          "La versión cambió o ya no está pendiente.",
        );
      await db.query(
        "INSERT INTO record_reviews(id,record_id,revision_hash,reviewer_id,decision,comment) VALUES($1,$2,$3,$4,$5,$6)",
        [
          randomUUID(),
          row.id,
          row.revision_hash,
          u.id,
          body.decision,
          body.comment,
        ],
      );
      const updated = (
        await db.query(
          "UPDATE records SET state=$1,approved_hash=$2,reviewer_id=$3 WHERE id=$4 RETURNING *",
          [
            body.decision,
            body.decision === "approved" ? row.revision_hash : null,
            u.id,
            row.id,
          ],
        )
      ).rows[0];
      await auditEvent(db, u, row.id, body.decision, {
        revisionHash: row.revision_hash,
        comment: body.comment,
      });
      return dto(updated);
    });
    res.json(out);
  });
  router.get("/records/:id/export", async (req, res) => {
    const u = getSession(res);
    const record = await transaction(pool, async (db) => {
      const row = await getRow(db, String(req.params.id), u, true);
      if (row.scope !== "public")
        throw new ApiError(
          403,
          "PRIVATE_EXPORT_DENIED",
          "Los contactos no se exportan como contenido.",
        );
      requireCapability(res, "content:read");
      if (row.state !== "approved" || row.approved_hash !== row.revision_hash)
        throw new ApiError(
          409,
          "APPROVAL_REQUIRED",
          "La revisión actual no está aprobada.",
        );
      const record = await projectPublicRecord(db, u.communityId, row);
      await auditEvent(db, u, row.id, "public_json_exported", {
        revisionHash: row.revision_hash,
      });
      return record;
    });
    res
      .attachment(`${record.id}.json`)
      .type("json")
      .send(canonicalJson(record) + "\n");
  });
  router.get("/records/:id/audit", async (req, res) => {
    const u = getSession(res),
      row = await getRow(pool, String(req.params.id), u);
    requireCapability(res, readCap(row.type));
    const r = await pool.query(
      "SELECT a.id,a.action,a.details,a.created_at,u.display_name AS actor FROM audit_events a JOIN users u ON u.id=a.actor_id WHERE a.community_id=$1 AND a.entity_id=$2 ORDER BY a.created_at DESC LIMIT 100",
      [u.communityId, row.id],
    );
    res.json(r.rows);
  });
  router.post("/records/:id/archive", async (req, res) => {
    const u = getSession(res),
      rev = expected(req),
      body = z
        .object({ reason: z.string().trim().min(5).max(1000).optional() })
        .strict()
        .parse(req.body ?? {});
    const row = await transaction(pool, async (db) => {
      const row = await getRow(db, String(req.params.id), u, true);
      requireCapability(res, writeCap(row.type));
      if (row.revision !== rev)
        throw new ApiError(409, "REVISION_CONFLICT", "La revisión cambió.");
      if (row.type === "settings")
        throw new ApiError(
          409,
          "MANDATORY_SETTINGS",
          "La configuración obligatoria del sitio debe conservarse.",
        );
      await assertLifecyclePublication(db, u.communityId, row.id);
      await assertRecordReferences(db, u.communityId, row.id);
      await invalidatePublicConsent(
        db,
        u,
        row.type,
        { ...decoded(row).payload, id: row.id },
        true,
      );
      const updatedAt = new Date().toISOString(),
        revisionHash = hashRevision({
          id: row.id,
          revision: row.revision + 1,
          payload: row.payload,
          state: "archived",
          updatedAt,
        });
      const out = (
        await db.query(
          "UPDATE records SET state=$1,desired_status='archived',approved_hash=NULL,submitted_hash=NULL,revision=revision+1,revision_hash=$2,updated_at=$3 WHERE id=$4 RETURNING *",
          [
            row.scope === "public" ? "draft" : "archived",
            revisionHash,
            updatedAt,
            row.id,
          ],
        )
      ).rows[0];
      await db.query(
        "INSERT INTO record_revisions(record_id,revision,payload,revision_hash,updated_at) VALUES($1,$2,$3,$4,$5)",
        [row.id, out.revision, row.payload, revisionHash, updatedAt],
      );
      await auditEvent(
        db,
        u,
        row.id,
        row.scope === "public" ? "public_removal_requested" : "record_archived",
        { revisionHash, reason: body.reason ?? null },
      );
      return dto(out);
    });
    res.json(row);
  });
  router.post("/records/:id/delete", async (req, res) => {
    const u = requireCapability(res, "members:manage"),
      body = z
        .object({ reason: z.string().trim().min(5).max(1000) })
        .strict()
        .parse(req.body);
    requireRecentAuthentication(res);
    const rev = expected(req);
    const id = String(req.params.id);
    await transaction(pool, async (db) => {
      const row = await getRow(db, id, u, true, true);
      if (row.revision !== rev)
        throw new ApiError(409, "REVISION_CONFLICT", "La revisión cambió.");
      if (row.scope === "private" && row.state === "deleted") {
        const tombstone = (
          await db.query(
            "SELECT * FROM deletion_tombstones WHERE community_id=$1 AND record_id=$2 ORDER BY created_at LIMIT 1",
            [u.communityId, id],
          )
        ).rows[0];
        if (!tombstone)
          throw new ApiError(
            409,
            "DELETION_INTENT_REQUIRED",
            "No existe una intención de eliminación recuperable.",
          );
        rememberDeletion({
          recordId: id,
          communityId: u.communityId,
          reason: tombstone.reason,
          createdAt: new Date(tombstone.created_at).toISOString(),
        });
        return;
      }
      if (row.scope !== "private" || row.state !== "archived")
        throw new ApiError(
          409,
          "ARCHIVE_FIRST",
          "Archiva primero el registro privado. El contenido público requiere un cambio revisado.",
        );
      if (row.revision !== rev)
        throw new ApiError(409, "REVISION_CONFLICT", "La revisión cambió.");
      await assertLifecyclePublication(db, u.communityId, row.id);
      await assertRecordReferences(db, u.communityId, row.id);
      await invalidatePublicConsent(
        db,
        u,
        row.type,
        { ...decoded(row).payload, id: row.id },
        true,
      );
      // Durable recovery intent precedes the database tombstone. Failure here
      // leaves the archived record/key intact; later failures remain retryable.
      rememberDeletion({
        recordId: id,
        communityId: u.communityId,
        reason: body.reason,
        createdAt: new Date().toISOString(),
      });
      await db.query(
        "INSERT INTO deletion_tombstones(id,community_id,record_id,actor_id,subject_hash,reason) VALUES($1,$2,$3,$4,$5,$6)",
        [
          randomUUID(),
          u.communityId,
          id,
          u.id,
          hashRevision(decoded(row).payload),
          body.reason,
        ],
      );
      await db.query(
        "UPDATE records SET state='deleted',payload='{}',approved_hash=NULL WHERE id=$1",
        [id],
      );
      await auditEvent(db, u, id, "record_deleted", { reason: body.reason });
    });
    erasePrivateKey(id);
    if (exportPrivateKey(id) !== null)
      throw new ApiError(
        503,
        "ERASURE_PENDING",
        "La limpieza de la clave sigue pendiente.",
      );
    res.json({ id, state: "deleted", cryptoErased: true });
  });
  router.post("/speaker-profiles/:id/public-projection", async (req, res) => {
    const u = requireCapability(res, "contacts:write");
    const output = await transaction(pool, async (db) => {
      const row = decoded(await getRow(db, String(req.params.id), u, true));
      if (
        row.type !== "speaker-profiles" ||
        !row.payload.publicConsent ||
        !row.payload.consentEvidence
      )
        throw new ApiError(
          422,
          "CONSENT_REQUIRED",
          "Se necesita permiso verificable para el perfil público.",
        );
      await requirePublicConsent(
        db,
        u.communityId,
        row.payload.personId,
        row.id,
      );
      const person = decoded(await getRow(db, row.payload.personId, u, true)),
        d = definition("speakers");
      const payload = {
        ...structuredClone(d.defaults),
        displayOrder: (
          await db.query(
            "SELECT COALESCE(MAX((payload->>'displayOrder')::integer),0)+10 AS value FROM records WHERE type='speakers' AND community_id=$1",
            [u.communityId],
          )
        ).rows[0].value,
        slug: `speaker-${person.id}`,
        name: person.payload.name,
        bio: row.payload.publicBio,
        photo: row.payload.publicPhoto,
        url: row.payload.publicUrl,
        topics: row.payload.topics,
      };
      const existing = await db.query(
        "SELECT public_record_id FROM public_projections WHERE person_id=$1",
        [person.id],
      );
      if (existing.rows[0])
        throw new ApiError(
          409,
          "PROJECTION_EXISTS",
          "Ya existe un perfil público para esta identidad. Edita ese borrador.",
        );
      const output = await createRecord(u, "speakers", payload, db);
      await db.query(
        "INSERT INTO public_projections(public_record_id,person_id,profile_id) VALUES($1,$2,$3)",
        [output.id, person.id, row.id],
      );
      return output;
    });
    res.status(201).json(output);
  });
  router.post("/import/site", async (req, res) => {
    const u = requireCapability(res, "content:write");
    const body = z
      .object({ dryRun: z.boolean().default(true) })
      .strict()
      .parse(req.body);
    res.json(await importSite(pool, u, body.dryRun));
  });
  router.post("/people/import", async (req, res) => {
    const u = requireCapability(res, "contacts:write");
    const body = z
      .object({ csv: z.string().max(1_000_000), dryRun: z.boolean() })
      .strict()
      .parse(req.body);
    let rows: any[];
    try {
      rows = parse(body.csv, {
        columns: true,
        skip_empty_lines: true,
        bom: true,
        relax_column_count: false,
      });
    } catch {
      throw new ApiError(422, "CSV_INVALID", "El CSV no es válido.");
    }
    if (rows.length > 5000)
      throw new ApiError(413, "IMPORT_LIMIT", "Máximo 5.000 contactos.");
    const seen = new Set<string>(),
      duplicates: number[] = [],
      errors: { row: number; message: string }[] = [],
      valid: any[] = [];
    const existing = await pool.query(
      "SELECT * FROM records WHERE community_id=$1 AND type='people' AND state<>'deleted'",
      [u.communityId],
    );
    existing.rows.forEach((r) => {
      const p = decoded(r).payload;
      seen.add(
        String(p.email || p.name)
          .toLowerCase()
          .trim(),
      );
    });
    for (const [i, row] of rows.entries()) {
      const unknown = Object.keys(row).filter(
        (k) =>
          ![
            "name",
            "email",
            "phone",
            "location",
            "notes",
            "provenance",
            "permissionBasis",
          ].includes(k),
      );
      if (
        unknown.length ||
        !row.name ||
        !row.provenance ||
        !row.permissionBasis
      ) {
        errors.push({
          row: i + 2,
          message:
            "Nombre, procedencia y permiso son obligatorios; columnas desconocidas no permitidas.",
        });
        continue;
      }
      const key = String(row.email || row.name)
        .toLowerCase()
        .trim();
      if (seen.has(key)) {
        duplicates.push(i + 2);
        continue;
      }
      seen.add(key);
      try {
        valid.push(
          validatePayload("people", {
            ...structuredClone(definition("people").defaults),
            ...row,
          }),
        );
      } catch {
        errors.push({
          row: i + 2,
          message: "Los datos del contacto no son válidos.",
        });
      }
    }
    let imported = 0;
    if (!body.dryRun) {
      if (errors.length)
        throw new ApiError(
          422,
          "IMPORT_INVALID",
          "Corrige los errores del CSV.",
        );
      await transaction(pool, async (db) => {
        await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          u.communityId + ":people-import",
        ]);
        const current = (
          await db.query(
            "SELECT * FROM records WHERE community_id=$1 AND type='people' AND state<>'deleted'",
            [u.communityId],
          )
        ).rows;
        const keys = new Set(
          current.map((r) => {
            const p = decoded(r).payload;
            return String(p.email || p.name)
              .toLowerCase()
              .trim();
          }),
        );
        for (const payload of valid) {
          const key = String(payload.email || payload.name)
            .toLowerCase()
            .trim();
          if (keys.has(key)) continue;
          await createRecord(u, "people", payload, db);
          keys.add(key);
          imported++;
        }
      });
    }
    res.json({
      dryRun: body.dryRun,
      total: rows.length,
      accepted: valid.length,
      duplicates,
      errors,
      imported,
    });
  });
  const exportContacts = async (req: any, res: any) => {
    const u = requireCapability(res, "contacts:export");
    requireRecentAuthentication(res);
    if (req.method === "GET" && req.get("X-CSRF-Token") !== u.csrfToken)
      throw new ApiError(
        403,
        "CSRF_DENIED",
        "Confirma la exportación desde esta aplicación.",
      );
    const reason = z
      .string()
      .trim()
      .min(5)
      .max(1000)
      .parse(
        (req.method === "POST" ? req.body.reason : req.query.reason) ?? "",
      );
    const r = await pool.query(
      "SELECT * FROM records WHERE community_id=$1 AND type='people' AND state NOT IN('archived','deleted') ORDER BY id LIMIT 5000",
      [u.communityId],
    );
    const quote = (v: any) => {
      let s = String(v ?? "");
      if (/^[\s]*[=+@-]/.test(s)) s = "'" + s;
      return '"' + s.replaceAll('"', '""') + '"';
    };
    const fields = [
      "name",
      "email",
      "phone",
      "location",
      "provenance",
      "permissionBasis",
    ];
    const csv = [
      fields.join(","),
      ...r.rows.map((row) => {
        const p = decoded(row).payload;
        return fields.map((f) => quote(p[f])).join(",");
      }),
    ].join("\r\n");
    await transaction(pool, (db) =>
      auditEvent(db, u, u.id, "contacts_exported", {
        reason,
        count: r.rows.length,
      }),
    );
    res
      .attachment("contacts.csv")
      .type("text/csv")
      .send("\uFEFF" + csv);
  };
  router.get("/people/export", exportContacts);
  router.post("/people/exports", exportContacts);

  router.post("/records/:id/preview", async (req, res) => {
    const u = requireCapability(res, "content:read"),
      row = await getRow(pool, String(req.params.id), u);
    if (row.scope !== "public")
      throw new ApiError(
        403,
        "PRIVATE_EXPORT_DENIED",
        "Un contacto privado no tiene vista pública.",
      );
    res.json(await createPreview(pool, u, row, origin));
  });
  router.get("/previews/:id/{*path}", async (req, res) =>
    servePreview(pool, getSession(res), String(req.params.id), req, res),
  );
  router.get("/operations/status", async (_req, res) => {
    requireCapability(res, "operations:read");
    const u = getSession(res),
      r = await pool.query(
        "SELECT type,state,count(*)::int AS count FROM records WHERE community_id=$1 AND state<>'deleted' GROUP BY type,state",
        [u.communityId],
      );
    res.json({
      records: r.rows,
      storage: {
        backend: process.env.STORAGE_BACKEND ?? "local",
        private: true,
      },
      oauth: {
        configured: Boolean(
          process.env.GITHUB_OAUTH_CLIENT_ID &&
          process.env.GITHUB_OAUTH_CLIENT_SECRET &&
          process.env.GITHUB_OWNER_SUBJECT,
        ),
      },
    });
  });
  return router;
}
