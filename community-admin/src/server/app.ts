import { createLifecycleRouter } from "./lifecycle-router";
import type { Transport } from "./integrations/http";
import type { JobsPublicationOptions } from "./jobs/publication";
import { createBrandAssetsRouter } from "./brand-assets";
import { legacyEventGuard } from "./editorial-sync/legacy-guard";
import {
  createEditorialRouter,
  type EditorialOptions,
} from "./editorial-sync/router";
import {
  createLocalGhAuth,
  localGhCookie,
  readCookie,
  type GhRunner,
} from "./local-gh-auth";
import { openapiDocument } from "./openapi";
import { fullIntegrationOptions } from "./integration-bridge";
import { createIntegrationRouter } from "./integrations/router";
import { createGitHubWebhookRouter } from "./integrations/runtime";
import { IntegrationError } from "./integrations/security";
import { createSocialOAuthCallbackRouter } from "./integrations/oauth";
import { ApiError, capabilitiesFor, requireCapability } from "./context";
import { createAuthRouter, createMembersRouter, oauthConfigured } from "./auth";
import { createProductRouter } from "./product-router";
import { createMediaRouter } from "./uploads";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { resolve } from "node:path";
import type pg from "pg";
import { z, ZodError } from "zod";
import {
  transaction,
  hasRequiredMigrations,
  hasDirectPublicationSchema,
} from "./db";
import {
  payloadSchema,
  buildPublicRecord,
  canonicalJson,
  hashRevision,
  publicErrors,
  type MemoryPayload,
  type VerifiedMedia,
} from "../shared/content";
interface Options {
  editorial?: EditorialOptions;
  jobsTest?: {
    transport?: Transport;
    now?: () => Date;
    enabled?: boolean;
    publication?: JobsPublicationOptions;
    websitePublication?: import("./website-publication").WebsitePublicationOptions;
  };
  oauthFetch?: typeof fetch;
  localGhAuthEnabled?: boolean;
  localGhExpectedSubject?: string;
  ghRunner?: GhRunner;
  pool: pg.Pool;
  media: VerifiedMedia[];
  origin: string;
  fixtureAuthEnabled?: boolean;
  environment?: string;
}
interface Session {
  id: string;
  communityId: string;
  name: string;
  role: "editor" | "reviewer" | "viewer";
  csrfToken: string;
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const token = (req: Request) =>
  req.headers.cookie
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith("ca_session="))
    ?.slice(11) ?? "";
const session = (res: Response) => res.locals.session as Session;
function allow(res: Response, roles: Session["role"][]) {
  if (!roles.includes(session(res).role))
    throw new ApiError(
      403,
      "PERMISSION_DENIED",
      "Tu rol no permite esta acción.",
    );
}
function revision(req: Request) {
  const header = req.get("If-Match");
  if (!header)
    throw new ApiError(
      428,
      "PRECONDITION_REQUIRED",
      "Envía la revisión guardada antes de cambiar el borrador.",
    );
  if (!/^"[1-9][0-9]*"$/.test(header))
    throw new ApiError(422, "INVALID_REVISION", "La revisión no es válida.");
  const n = Number(header.slice(1, -1));
  if (!Number.isSafeInteger(n))
    throw new ApiError(422, "INVALID_REVISION", "La revisión no es válida.");
  return n;
}
function dto(row: any) {
  return {
    id: row.id,
    authorId: row.author_id,
    revision: row.revision,
    state: row.state,
    payload: row.payload as MemoryPayload,
    revisionHash: row.revision_hash,
    approvedHash: row.approved_hash,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
async function audit(
  db: pg.PoolClient,
  user: Session,
  id: string,
  action: string,
  details: unknown = {},
) {
  await db.query(
    "INSERT INTO audit_events(id,community_id,actor_id,entity_id,action,details) VALUES($1,$2,$3,$4,$5,$6)",
    [randomUUID(), user.communityId, user.id, id, action, details],
  );
}
async function snapshot(db: pg.PoolClient, row: any) {
  await db.query(
    "INSERT INTO draft_revisions(draft_id,revision,payload,revision_hash,updated_at) VALUES($1,$2,$3,$4,$5)",
    [row.id, row.revision, row.payload, row.revision_hash, row.updated_at],
  );
}
function ensureMedia(payload: MemoryPayload, media: VerifiedMedia[]) {
  for (const [i, item] of payload.media.entries())
    if (!media.some((m) => m.id === item.assetId))
      throw new ApiError(
        422,
        "INVALID_MEDIA",
        "Selecciona una imagen sintética verificada.",
        [{ path: `/media/${i}/assetId`, message: "Imagen no verificada." }],
      );
}
export function createApp(options: Options) {
  const { pool, media, origin } = options;
  const configuredOrigin = new URL(origin);
  if (!(
    configuredOrigin.protocol === "https:" ||
    (configuredOrigin.protocol === "http:" &&
      configuredOrigin.hostname === "127.0.0.1")
  ))
    throw new Error("This slice only accepts an HTTP loopback origin.");
  const enabled =
    options.fixtureAuthEnabled === true &&
    !options.localGhAuthEnabled &&
    (options.environment ?? process.env.NODE_ENV) !== "production";
  const localGh = createLocalGhAuth({
    pool,
    origin,
    requested: options.localGhAuthEnabled,
    expectedSubject: options.localGhExpectedSubject,
    environment: options.environment ?? process.env.NODE_ENV,
    runner: options.ghRunner,
  });
  const appToken = (req: Request) =>
    readCookie(req, localGh.requested ? localGhCookie : "ca_session");
  const sessionHash = (raw: string) =>
    sha((localGh.requested ? "local-gh:" : "") + raw);
  const app = express();
  app.disable("x-powered-by");
  app.use((req, _res, next) => {
    if (req.url.startsWith("/api/v1/"))
      req.url = req.url.replace("/api/v1/", "/api/");
    next();
  });
  if (
    options.jobsTest &&
    (options.environment ?? process.env.NODE_ENV) !== "test"
  )
    throw new Error("Jobs transport overrides are test-only.");
  const integrations = {
    ...fullIntegrationOptions(pool),
    ...(options.jobsTest
      ? {
          jobsTransport: options.jobsTest.transport,
          jobsNow: options.jobsTest.now,
          jobsEnabled: options.jobsTest.enabled,
          ...(options.jobsTest.websitePublication
            ? { websitePublication: options.jobsTest.websitePublication }
            : {}),
          ...(options.jobsTest.publication
            ? { jobsPublication: options.jobsTest.publication }
            : {}),
        }
      : {}),
  };
  const editorial = createEditorialRouter(
    pool,
    options.editorial,
    options.environment ?? process.env.NODE_ENV,
    origin,
  );
  if (integrations.websitePublication)
    integrations.websitePublication.eventsAuthority = editorial.config.mode;
  if (editorial.config.mode === "github" && integrations.liveEnabled)
    throw new Error(
      "GitHub editorial mode cannot start the legacy live integration worker.",
    );
  app.use("/api", createGitHubWebhookRouter(integrations));
  app.use("/api", createSocialOAuthCallbackRouter(integrations));
  app.use("/api", (req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    const allowedOrigins = [
      origin,
      origin.replace("127.0.0.1", "localhost"),
      "http://localhost:" + configuredOrigin.port,
    ];
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !allowedOrigins.includes(req.get("Origin") ?? "")
    )
      return next(
        new ApiError(
          403,
          "ORIGIN_DENIED",
          "La solicitud debe venir de esta aplicación local.",
        ),
      );
    next();
  });
  app.use(express.json({ limit: "2mb", strict: true }));
  app.get("/api/openapi.json", (_req, res) => res.json(openapiDocument()));
  app.get("/api/config", (_req, res) =>
    res.json({
      editorialMode: editorial.config.mode,
      oauthConfigured: oauthConfigured(),
      fixtureAuthEnabled: enabled,
      localGhAuthEnabled: localGh.enabled,
      localGhAuthRequested: localGh.requested,
      developmentOnly: enabled || localGh.requested,
      notice: localGh.requested
        ? "Revisión local con tu cuenta verificada de GitHub CLI. Las integraciones siguen deshabilitadas."
        : enabled
          ? "Acceso de prueba explícito. Usa solo datos sintéticos."
          : "Administración privada. El acceso requiere invitación y OAuth configurado.",
    }),
  );
  app.get("/api/health/live", (_req, res) => res.json({ status: "ok" }));
  app.get("/api/health/ready", async (_req, res) => {
    const versions = (
      await pool.query("SELECT version FROM schema_migrations")
    ).rows.map((r) => r.version);
    if (
      !hasRequiredMigrations(versions) ||
      !(await hasDirectPublicationSchema(pool))
    )
      throw new ApiError(
        503,
        "MIGRATIONS_REQUIRED",
        "Aplica las migraciones locales antes de iniciar esta versión.",
      );
    res.json({ status: "ready" });
  });
  app.get("/api/health", async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({ status: "ok", mode: "community-administration" });
  });
  app.use(
    "/api",
    createAuthRouter({ pool, origin, fetcher: options.oauthFetch }),
  );
  app.use("/api", localGh.router);
  app.post("/api/dev/login", async (req, res) => {
    if (!enabled)
      throw new ApiError(
        404,
        "FIXTURE_AUTH_DISABLED",
        "El acceso de prueba está deshabilitado.",
      );
    const { persona } = z
      .object({
        persona: z.enum([
          "editor",
          "reviewer",
          "viewer",
          "owner",
          "coordinator",
          "jobs_curator",
          "publisher",
        ]),
      })
      .strict()
      .parse(req.body);
    const result = await pool.query(
      "SELECT * FROM fixture_users WHERE persona=$1 AND active=true",
      [persona],
    );
    const user = result.rows[0];
    if (!user)
      throw new ApiError(
        403,
        "USER_INACTIVE",
        "La cuenta de prueba está desactivada.",
      );
    const raw = randomBytes(32).toString("hex"),
      csrfToken = randomBytes(32).toString("hex");
    await transaction(pool, async (db) => {
      if (token(req))
        await db.query("DELETE FROM sessions WHERE token_hash=$1", [
          sha(token(req)),
        ]);
      await db.query(
        "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '8 hours')",
        [sha(raw), user.id, csrfToken],
      );
      await audit(
        db,
        {
          id: user.id,
          communityId: user.community_id,
          name: user.display_name,
          role: user.role,
          csrfToken,
        },
        user.id,
        "fixture_login",
      );
    });
    res.cookie("ca_session", raw, {
      httpOnly: true,
      sameSite: "strict",
      secure: false,
      path: "/api",
      maxAge: 8 * 60 * 60 * 1000,
    });
    res.json({
      id: user.id,
      name: user.display_name,
      role: user.role,
      roles: [...new Set([user.role, ...(user.roles ?? [])])],
      capabilities: capabilitiesFor([user.role, ...(user.roles ?? [])]),
      csrfToken,
    });
  });
  app.use("/api", async (req, res, next) => {
    const raw = appToken(req);
    if (!/^[a-f0-9]{64}$/.test(raw))
      throw new ApiError(
        401,
        "AUTH_REQUIRED",
        "Inicia una sesión local de prueba.",
      );
    const result = await pool.query(
      "SELECT u.*,s.csrf_token,s.created_at AS authenticated_at FROM sessions s JOIN fixture_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND s.last_seen_at>now()-interval '30 minutes' AND u.active=true",
      [sessionHash(raw)],
    );
    const user = result.rows[0];
    if (!user)
      throw new ApiError(
        401,
        "AUTH_REQUIRED",
        "La sesión venció o fue revocada.",
      );
    if (user.is_fixture && !enabled)
      throw new ApiError(
        401,
        "FIXTURE_AUTH_DISABLED",
        "El acceso de prueba está deshabilitado.",
      );
    const github =
      localGh.requested &&
      req.path !== "/logout" &&
      req.path !== "/auth/local-gh/reverify"
        ? await localGh.verifySession(req, user)
        : undefined;
    res.locals.session = {
      id: user.id,
      communityId: user.community_id,
      name: user.display_name,
      role: user.role,
      csrfToken: user.csrf_token,
      roles: [...new Set([user.role, ...(user.roles ?? [])])],
      capabilities: capabilitiesFor([user.role, ...(user.roles ?? [])]),
      isFixture: user.is_fixture,
      authenticatedAt: new Date(user.authenticated_at).toISOString(),
      ...(github ? { github, authMethod: "local-gh", name: github.name } : {}),
    };
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const csrf = req.get("X-CSRF-Token") ?? "";
      if (
        !/^[a-f0-9]{64}$/.test(csrf) ||
        !timingSafeEqual(Buffer.from(csrf), Buffer.from(user.csrf_token))
      )
        throw new ApiError(
          403,
          "CSRF_DENIED",
          "Actualiza la sesión antes de guardar.",
        );
    }
    await pool.query(
      "UPDATE sessions SET last_seen_at=now() WHERE token_hash=$1",
      [sessionHash(raw)],
    );
    next();
  });
  app.post("/api/auth/local-gh/reverify", localGh.reverify);
  app.use("/api", createMembersRouter({ pool }));
  app.use("/api", createMediaRouter({ pool, seeds: media }));
  app.use("/api", createLifecycleRouter({ pool, seeds: media }));
  app.use("/api", createBrandAssetsRouter({ pool }));
  app.use("/api", editorial.router);
  if (editorial.config.mode === "github")
    app.use("/api", legacyEventGuard(pool));
  app.use(
    "/api",
    createProductRouter({
      pool,
      media,
      origin,
      githubEditorial: editorial.config.mode === "github",
    }),
  );

  app.use("/api", createIntegrationRouter({ ...integrations, origin }));
  app.get("/api/me", (_req, res) => res.json(session(res)));
  app.post("/api/logout", async (req, res) => {
    await pool.query("DELETE FROM sessions WHERE token_hash=$1", [
      sessionHash(appToken(req)),
    ]);
    if (localGh.requested)
      await transaction(pool, (db) =>
        audit(db, session(res), session(res).id, "local_gh_logout"),
      );
    res.clearCookie(localGhCookie, {
      path: "/api",
      sameSite: "strict",
      httpOnly: true,
    });
    res.clearCookie("ca_session", {
      path: "/api",
      sameSite: "strict",
      httpOnly: true,
    });
    res.status(204).end();
  });
  app.get("/api/media", (_req, res) => res.json(media));
  app.get("/api/media/:id", async (req, res) => {
    const asset = media.find((a) => a.id === req.params.id);
    if (!asset) throw new ApiError(404, "NOT_FOUND", "Imagen no encontrada.");
    if (req.query.download === "1")
      res.attachment(asset.path.split("/").pop()!);
    res.type("png").sendFile(resolve("public", asset.path));
  });
  app.get("/api/drafts", async (req, res) => {
    const query = z
      .object({
        cursor: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      })
      .strict()
      .parse(req.query);
    const result = await pool.query(
      "SELECT * FROM drafts WHERE community_id=$1 AND state<>'discarded' AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3",
      [session(res).communityId, query.cursor ?? null, query.limit + 1],
    );
    res.json({
      items: result.rows.slice(0, query.limit).map(dto),
      nextCursor:
        result.rows.length > query.limit
          ? result.rows[query.limit - 1].id
          : null,
    });
  });
  app.post("/api/drafts", async (req, res) => {
    allow(res, ["editor"]);
    const body = z
      .object({ payload: payloadSchema.optional() })
      .strict()
      .parse(req.body);
    const user = session(res),
      id = randomUUID();
    const row = await transaction(pool, async (db) => {
      const max = await db.query(
        "SELECT COALESCE(MAX(display_order),0)+10 AS value FROM drafts WHERE community_id=$1",
        [user.communityId],
      );
      const payload = body.payload ?? {
        slug: `memory-${id}`,
        title: { "es-pe": "", en: "" },
        description: { "es-pe": "", en: "" },
        media: [{ assetId: media[0].id, alt: { "es-pe": "", en: "" } }],
        captureYear: null,
        tags: [],
        displayOrder: max.rows[0].value,
      };
      ensureMedia(payload, media);
      const updatedAt = new Date().toISOString(),
        hash = hashRevision({ id, revision: 1, payload, updatedAt });
      const r = await db.query(
        "INSERT INTO drafts(id,community_id,author_id,slug,display_order,revision,state,payload,revision_hash,updated_at) VALUES($1,$2,$3,$4,$5,1,'draft',$6,$7,$8) RETURNING *",
        [
          id,
          user.communityId,
          user.id,
          payload.slug,
          payload.displayOrder,
          payload,
          hash,
          updatedAt,
        ],
      );
      await snapshot(db, r.rows[0]);
      await audit(db, user, id, "draft_created", { revision: 1 });
      return r.rows[0];
    });
    res.status(201).json(dto(row));
  });
  app.param("id", (req, _res, next, value) => {
    if (!z.string().uuid().safeParse(value).success)
      return next(new ApiError(404, "NOT_FOUND", "Registro no encontrado."));
    next();
  });
  const load = async (
    db: pg.Pool | pg.PoolClient,
    id: string,
    user: Session,
    lock = false,
  ) => {
    const r = await db.query(
      `SELECT * FROM drafts WHERE id=$1 AND community_id=$2 AND state<>'discarded'${lock ? " FOR UPDATE" : ""}`,
      [id, user.communityId],
    );
    if (!r.rows[0])
      throw new ApiError(404, "NOT_FOUND", "Borrador no encontrado.");
    return r.rows[0];
  };
  const locked = async (
    req: Request,
    res: Response,
    action: (db: pg.PoolClient, row: any, user: Session) => Promise<unknown>,
  ) => {
    const expected = revision(req),
      user = session(res);
    return transaction(pool, async (db) => {
      const row = await load(db, String(req.params.id), user, true);
      if (row.revision !== expected)
        throw new ApiError(
          409,
          "REVISION_CONFLICT",
          "Hay una versión más reciente. Recárgala antes de guardar.",
          [],
          row.revision,
        );
      return action(db, row, user);
    });
  };
  app.get("/api/drafts/:id", async (req, res) =>
    res.json(dto(await load(pool, String(req.params.id), session(res)))),
  );
  app.delete("/api/drafts/:id", async (req, res) => {
    requireCapability(res, "content:write");
    const body = z
      .object({ reason: z.string().trim().min(5).max(1000) })
      .strict()
      .parse(req.body);
    const value = await locked(req, res, async (db, row, user) => {
      if (
        row.source_hash ||
        row.source_commit ||
        ["published", "merged", "deployed", "sending", "unknown"].includes(
          row.state,
        )
      )
        throw new ApiError(
          409,
          "PUBLIC_WITHDRAWAL_REQUIRED",
          "El contenido publicado requiere un retiro mediante publicación.",
        );
      await db.query(
        "UPDATE drafts SET state='discarded',revision=revision+1,approved_hash=NULL,submitted_hash=NULL WHERE id=$1",
        [row.id],
      );
      await audit(db, user, row.id, "local_draft_discarded", {
        reason: body.reason,
        revision: row.revision,
      });
      return {
        id: row.id,
        state: "discarded",
        revision: row.revision + 1,
        remoteUnchanged: true,
      };
    });
    res.json(value);
  });
  app.patch("/api/drafts/:id", async (req, res) => {
    allow(res, ["editor"]);
    const { payload } = z
      .object({ payload: payloadSchema })
      .strict()
      .parse(req.body);
    ensureMedia(payload, media);
    const row = await locked(req, res, async (db, current, user) => {
      const n = current.revision + 1,
        updatedAt = new Date().toISOString(),
        hash = hashRevision({
          id: current.id,
          revision: n,
          payload,
          updatedAt,
        });
      const r = await db.query(
        "UPDATE drafts SET slug=$1,display_order=$2,payload=$3,revision=$4,revision_hash=$5,updated_at=$6,state='draft',submitted_hash=NULL,approved_hash=NULL,reviewer_id=NULL WHERE id=$7 RETURNING *",
        [
          payload.slug,
          payload.displayOrder,
          payload,
          n,
          hash,
          updatedAt,
          current.id,
        ],
      );
      await snapshot(db, r.rows[0]);
      if (current.approved_hash)
        await audit(db, user, current.id, "approval_invalidated", {
          previousRevision: current.revision,
        });
      await audit(db, user, current.id, "draft_updated", { revision: n });
      return r.rows[0];
    });
    res.json(dto(row));
  });
  app.post("/api/drafts/:id/submit", async (req, res) => {
    allow(res, ["editor"]);
    z.object({}).strict().parse(req.body);
    const row = await locked(req, res, async (db, current, user) => {
      if (!["draft", "changes_requested"].includes(current.state))
        throw new ApiError(
          409,
          "INVALID_STATE",
          "Guarda una nueva revisión antes de enviar.",
        );
      const payload = payloadSchema.parse(current.payload);
      ensureMedia(payload, media);
      const errors = publicErrors(
        buildPublicRecord(
          current.id,
          payload,
          new Date(current.updated_at).toISOString(),
          media,
        ),
      );
      if (errors.length)
        throw new ApiError(
          422,
          "CONTENT_INVALID",
          "Completa el contenido en español e inglés.",
          errors,
        );
      const r = await db.query(
        "UPDATE drafts SET state='submitted',submitted_hash=revision_hash,approved_hash=NULL,reviewer_id=NULL WHERE id=$1 RETURNING *",
        [current.id],
      );
      await audit(db, user, current.id, "review_submitted", {
        revision: current.revision,
        revisionHash: current.revision_hash,
      });
      return r.rows[0];
    });
    res.json(dto(row));
  });
  app.post("/api/drafts/:id/review", async (req, res) => {
    allow(res, ["reviewer"]);
    const body = z
      .object({
        decision: z.enum(["approved", "changes_requested"]),
        revisionHash: z.string().regex(/^[a-f0-9]{64}$/),
        comment: z.string().max(2000),
      })
      .strict()
      .parse(req.body);
    const row = await locked(req, res, async (db, current, user) => {
      if (current.author_id === user.id)
        throw new ApiError(
          403,
          "SELF_APPROVAL_DENIED",
          "Otra persona debe revisar el contenido.",
        );
      if (
        current.state !== "submitted" ||
        current.submitted_hash !== current.revision_hash ||
        body.revisionHash !== current.revision_hash
      )
        throw new ApiError(
          409,
          "STALE_REVIEW",
          "Esta revisión ya cambió o no está pendiente.",
        );
      await db.query(
        "INSERT INTO reviews(id,draft_id,revision,revision_hash,reviewer_id,decision,comment) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          randomUUID(),
          current.id,
          current.revision,
          current.revision_hash,
          user.id,
          body.decision,
          body.comment,
        ],
      );
      const r = await db.query(
        "UPDATE drafts SET state=$1,approved_hash=$2,reviewer_id=$3 WHERE id=$4 RETURNING *",
        [
          body.decision,
          body.decision === "approved" ? current.revision_hash : null,
          user.id,
          current.id,
        ],
      );
      await audit(db, user, current.id, body.decision, {
        revision: current.revision,
        revisionHash: current.revision_hash,
        comment: body.comment,
      });
      return r.rows[0];
    });
    res.json(dto(row));
  });
  app.get("/api/drafts/:id/export", async (req, res) => {
    allow(res, ["editor", "reviewer"]);
    const output = await transaction(pool, async (db) => {
      const user = session(res),
        row = await load(db, String(req.params.id), user, true);
      if (row.state !== "approved" || row.approved_hash !== row.revision_hash)
        throw new ApiError(
          409,
          "APPROVAL_REQUIRED",
          "La revisión actual necesita aprobación antes de exportar.",
        );
      const payload = payloadSchema.parse(row.payload);
      ensureMedia(payload, media);
      const record = buildPublicRecord(
          row.id,
          payload,
          new Date(row.updated_at).toISOString(),
          media,
        ),
        errors = publicErrors(record);
      if (errors.length)
        throw new ApiError(
          422,
          "CONTENT_INVALID",
          "El contenido público no es válido.",
          errors,
        );
      await audit(db, user, row.id, "public_json_exported", {
        revision: row.revision,
        revisionHash: row.revision_hash,
      });
      return record;
    });
    res
      .attachment(`${req.params.id}.json`)
      .type("json")
      .send(canonicalJson(output) + "\n");
  });
  app.get("/api/drafts/:id/audit", async (req, res) => {
    const user = session(res);
    await load(pool, String(req.params.id), user);
    const r = await pool.query(
      "SELECT a.id,a.action,a.details,a.created_at,u.display_name AS actor FROM audit_events a JOIN fixture_users u ON u.id=a.actor_id WHERE a.community_id=$1 AND a.entity_id=$2 ORDER BY a.created_at DESC,a.id DESC LIMIT 100",
      [user.communityId, req.params.id],
    );
    res.json(r.rows);
  });
  app.use("/api", (_req, _res, next) =>
    next(
      new ApiError(
        404,
        "NOT_FOUND",
        "Ruta no disponible en esta versión local.",
      ),
    ),
  );
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    const correlationId = randomUUID();
    if (error instanceof IntegrationError)
      return res.status(error.status).json({
        code: error.code,
        message: error.code,
        fieldErrors: [],
        correlationId,
      });
    if (error instanceof ZodError)
      return res.status(422).json({
        code: "INPUT_INVALID",
        message: "Revisa los campos indicados.",
        fieldErrors: error.issues.map((i) => ({
          path: `/${i.path.join("/")}`,
          message: i.message,
        })),
        correlationId,
      });
    if (error instanceof ApiError)
      return res.status(error.status).json({
        code: error.code,
        message: error.message,
        fieldErrors: error.fieldErrors,
        currentRevision: error.currentRevision,
        correlationId,
      });
    if (error.code === "23505")
      return res.status(409).json({
        code: "DUPLICATE_CONTENT",
        message: "El slug o el orden aprobado ya está en uso.",
        fieldErrors: [],
        correlationId,
      });
    if (
      error.type === "entity.parse.failed" ||
      error.type === "entity.too.large"
    )
      return res.status(error.type === "entity.too.large" ? 413 : 400).json({
        code: "INVALID_JSON",
        message: "El cuerpo JSON no es válido o excede el límite.",
        fieldErrors: [],
        correlationId,
      });
    console.error(
      `Local API request failed [${correlationId}]`,
      error.code ?? error.name ?? "Error",
    );
    return res.status(503).json({
      code: "DEPENDENCY_UNAVAILABLE",
      message:
        "El servicio local no está disponible. Conserva tu texto y vuelve a intentar.",
      fieldErrors: [],
      correlationId,
    });
  });
  return app;
}
