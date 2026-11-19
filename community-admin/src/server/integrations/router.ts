import { confirmSocialPost } from "./social-indexing";
import {
  assertLifecyclePublication,
  mediaReferenceFence,
  videoReferenceFence,
} from "../lifecycle";
import { providerReadiness } from "./readiness";
import { VacancyIntakeService } from "../jobs/intake-service";
import { JobsPublisher } from "../jobs/publication";
import { jobGeography } from "../jobs/geography";
import { geographicQueue } from "../jobs/queue";
import { strongVacancyDuplicates } from "../jobs/intake";
import {
  discoverCareers,
  validateCareersUrl,
  identifyBoard,
  identifyDetailProvider,
} from "../jobs/discovery";
import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { z } from "zod";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import { transaction } from "../db";
import {
  getSession,
  requireCapability,
  requireRecentAuthentication,
  auditEvent,
  ApiError,
} from "../context";
import { IntegrationService, type IntegrationOptions } from "./service";
import {
  hashValue,
  deterministicId,
  IntegrationError,
  integrationMessage,
  publicIntegrationError,
} from "./security";
import { enqueue } from "../worker/outbox";
import { duplicateSuggestions, publicJobs } from "../jobs/engine";
import { manualPackage, YouTube } from "./social";
import { createVideoRouter, VideoAssets } from "./video";
import { S3Multipart } from "./s3-multipart";
import { createSocialOAuthStartRouter } from "./oauth";
import { idempotent } from "./idempotency";
import { verifySchedule } from "./schedule";
import { hashRevision } from "../../shared/content";
import { mediaBytes } from "../uploads";
import { verifySeedMedia } from "../media";
const idSchema = z.string().uuid();
const text = z.string().max(4000);
const payloadSchema = z
  .object({
    text: text.optional(),
    title: z.string().max(200).optional(),
    description: text.optional(),
    link: z.string().url().startsWith("https://").optional(),
    media: z.array(z.string().max(200)).max(30).optional(),
    mediaHashes: z
      .record(z.string(), z.string().regex(/^[a-f0-9]{64}$/))
      .optional(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    existingVideoUrl: z
      .string()
      .url()
      .startsWith("https://www.youtube.com/")
      .optional(),
    recordingConsent: z.boolean().optional(),
    assetId: z.string().uuid().optional(),
    eventId: z.string().uuid().optional(),
    playlistId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{10,100}$/)
      .optional(),
    thumbnailAssetId: z.string().uuid().optional(),
    sessionId: z.string().uuid().optional(),
    bytes: z
      .number()
      .int()
      .positive()
      .max(5 * 1024 ** 3)
      .optional(),
    mime: z
      .string()
      .regex(/^video\/[a-z0-9.+-]+$/)
      .optional(),
    language: z.string().max(10).optional(),
    madeForKids: z.boolean().optional(),
    imageUrn: z.string().max(200).optional(),
    altText: z.string().max(1000).optional(),
    categoryId: z.string().max(10).optional(),
    desiredVisibility: z.enum(["private", "unlisted", "public"]).optional(),
  })
  .strict();
const sourceSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]{1,100}$/),
    adapter: z.enum([
      "greenhouse",
      "lever",
      "hirehive",
      "globant",
      "smartrecruiters",
    ]),
    boardIdentifier: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    company: z.string().min(1).max(200),
    enabled: z.boolean(),
    reviewedAt: z.string().datetime().optional(),
    reviewReference: z.string().max(300).optional(),
    permissionBasis: z.string().max(1000).optional(),
    termsUrl: z.string().url().startsWith("https://").optional(),
    allowedHosts: z
      .array(
        z
          .string()
          .regex(/^[a-z0-9.-]+$/)
          .max(200),
      )
      .max(2),
    attribution: z.string().max(300).optional(),
    expectedMinRecords: z.number().int().nonnegative().optional(),
    pageLimit: z.number().int().min(1).max(100).optional(),
    requestLimit: z.number().int().min(1).max(2000).optional(),
    timeoutSeconds: z.number().int().min(1).max(15).optional(),
    rulesVersion: z.string().max(20).optional(),
    careersUrl: z.string().url().startsWith("https://").max(2000).optional(),
    coverage: z.literal("single-detail").optional(),
    schedule: z
      .object({
        enabled: z.boolean(),
        intervalHours: z.number().int().min(1).max(168),
      })
      .strict()
      .optional(),
  })
  .strict();
export function createIntegrationRouter(
  options: IntegrationOptions & { origin: string },
) {
  const router = Router(),
    pool = options.pool;
  const intake = new VacancyIntakeService(
    pool,
    options.jobsTransport,
    options.jobsNow,
  );
  const backend =
    process.env.STORAGE_BACKEND === "s3"
      ? new S3Multipart(
          process.env.S3_BUCKET ?? "",
          process.env.S3_REGION ?? "",
          process.env.S3_ENDPOINT,
        )
      : undefined;
  const videos = new VideoAssets(pool, backend);
  const service = new IntegrationService({
    ...options,
    readAsset:
      options.readAsset ??
      ((id, offset, length, communityId) =>
        videos.read(communityId ?? "", id, offset, length)),
  });
  router.use(createVideoRouter(pool, backend));
  router.use(createSocialOAuthStartRouter(options));
  const enrich = async (communityId: string, payload: any) => {
    const mediaHashes: Record<string, string> = {};
    for (const id of [
      ...(payload.media ?? []),
      ...(payload.thumbnailAssetId ? [payload.thumbnailAssetId] : []),
    ])
      mediaHashes[id] = (
        await mediaBytes(pool, communityId, id, await verifySeedMedia())
      ).sha256;
    if (payload.assetId) {
      const asset = await videos.get(communityId, payload.assetId);
      if (asset.state !== "verified")
        throw new IntegrationError("VIDEO_NOT_VERIFIED");
      payload = {
        ...payload,
        bytes: Number(asset.bytes),
        mime: asset.mime,
        sha256: asset.sha256,
      };
    }
    return {
      ...payload,
      ...(Object.keys(mediaHashes).length ? { mediaHashes } : {}),
    };
  };
  const path = (req: Request) => String(req.params.id ?? "");
  const wrap =
    (cap: string, fn: (req: Request, res: Response) => Promise<unknown>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (cap === "publication:draft") {
          const caps = getSession(res).capabilities;
          if (
            !["*", "content:write", "publishing:write"].some((c) =>
              caps.includes(c),
            )
          )
            throw new IntegrationError("PERMISSION_DENIED", 403);
        } else requireCapability(res, cap);
        if (
          cap === "members:manage" &&
          String(req.route.path).startsWith("/integrations")
        )
          requireRecentAuthentication(res);
        if (!["GET", "HEAD", "OPTIONS"].includes(req.method))
          await transaction(pool, (db) =>
            auditEvent(
              db,
              getSession(res),
              /^[a-f0-9-]{36}$/.test(String(req.params.id))
                ? String(req.params.id)
                : randomUUID(),
              "integration_requested",
              { method: req.method, route: req.route.path },
            ),
          );
        await fn(req, res);
      } catch (e) {
        if (
          cap === "members:manage" &&
          String(req.route.path).startsWith("/integrations") &&
          getSession(res)
        )
          await transaction(pool, (db) =>
            auditEvent(
              db,
              getSession(res),
              randomUUID(),
              "integration_change_denied",
              {
                route: req.route.path,
                code:
                  e instanceof ApiError || e instanceof IntegrationError
                    ? e.code
                    : "VALIDATION",
              },
            ),
          );
        if (e instanceof IntegrationError)
          return res.status(e.status).json({
            ...publicIntegrationError(e),
            ...(e.code === "SOURCE_ALREADY_EXISTS"
              ? { existingSourceId: (e as any).existingSourceId }
              : {}),
            ...(e.code === "DUPLICATE_VACANCY_REVIEW_REQUIRED"
              ? { duplicateSuggestions: (e as any).duplicateSuggestions }
              : {}),
          });
        if (e instanceof z.ZodError)
          return res.status(422).json({
            code: "VALIDATION",
            message: "Revisa los campos.",
            fieldErrors: e.issues.map((i) => ({
              path: i.path.join("."),
              message: i.message,
            })),
          });
        next(e);
      }
    };
  const user = (res: Response) => getSession(res);
  const limit = (req: Request) =>
      Math.max(1, Math.min(100, Number(req.query.limit) || 50)),
    offset = (req: Request) => Math.max(0, Number(req.query.cursor) || 0);
  const list = async (
    req: Request,
    res: Response,
    table: string,
    columns = "*",
  ) => {
    const result = await pool.query(
      `SELECT ${columns} FROM ${table} WHERE community_id=$1 ORDER BY id LIMIT $2 OFFSET $3`,
      [user(res).communityId, limit(req) + 1, offset(req)],
    );
    res.json({
      items: result.rows.slice(0, limit(req)),
      nextCursor:
        result.rows.length > limit(req)
          ? String(offset(req) + limit(req))
          : null,
    });
  };
  router.get(
    "/integrations",
    wrap("operations:read", async (req, res) => {
      const rows = await pool.query(
        "SELECT id,provider,destination,scopes,health,version FROM integration_accounts WHERE community_id=$1 ORDER BY provider",
        [user(res).communityId],
      );
      res.json({
        items: rows.rows,
        liveEnabled: options.liveEnabled === true,
        githubConfigured: !!options.github,
        providers: providerReadiness(options),
      });
    }),
  );
  router.post(
    "/integrations",
    wrap("members:manage", async (req, res) => {
      const input = z
        .object({
          provider: z.enum(["linkedin", "youtube"]),
          destination: z.string().min(1).max(200),
          scopes: z.array(z.string().max(200)).max(30),
          secret: z
            .object({
              accessToken: z.string().min(1),
              refreshToken: z.string().optional(),
              expiresAt: z.string().datetime().optional(),
              clientId: z.string().optional(),
              clientSecret: z.string().optional(),
            })
            .strict(),
          config: z
            .object({
              apiVersion: z
                .string()
                .regex(/^\d{6}$/)
                .optional(),
            })
            .strict(),
        })
        .strict()
        .parse(req.body);
      const value = await service.connect(
        user(res).communityId,
        input.provider,
        input.destination,
        input.scopes,
        input.secret,
        input.config,
      );
      await transaction(pool, (db) =>
        auditEvent(db, user(res), value.id, "integration_connected", {
          provider: input.provider,
          outcome: "success",
          version: value.version,
        }),
      );
      res.status(201).json(value);
    }),
  );
  router.post(
    "/integrations/:id/disconnect",
    wrap("members:manage", async (req, res) => {
      idSchema.parse(path(req));
      const disconnected = await pool.query(
        "UPDATE integration_accounts SET encrypted_secret='',health='disconnected',version=version+1 WHERE id=$1 AND community_id=$2 RETURNING id",
        [path(req), user(res).communityId],
      );
      if (!disconnected.rowCount) throw new IntegrationError("NOT_FOUND", 404);
      await transaction(pool, (db) =>
        auditEvent(db, user(res), path(req), "integration_disconnected", {
          outcome: "success",
        }),
      );
      res.json({ state: "disconnected" });
    }),
  );
  router.post(
    "/job-sources/discover",
    wrap("jobs:curate", async (req, res) => {
      service.jobs.assertEnabled();
      const input = z
        .object({
          careersUrl: z.string().max(2000),
          company: z.string().max(200).optional(),
        })
        .strict()
        .parse(req.body);
      res.json(
        await discoverCareers(
          input.careersUrl,
          input.company,
          options.jobsTransport,
          options.jobsNow?.(),
        ),
      );
    }),
  );
  router.post(
    "/jobs/intake/preview",
    wrap("jobs:curate", async (req, res) => {
      const input = z
        .object({
          url: z.string().max(2000),
          company: z.string().max(200).optional(),
        })
        .strict()
        .parse(req.body);
      res.json(await intake.preview(user(res), input.url));
    }),
  );
  router.get(
    "/website/publication/status",
    wrap("content:read", async (req, res) => {
      const u = user(res);
      res.json(
        service.websitePublisher
          ? await service.websitePublisher.status(
              u.communityId,
              u.id,
              typeof req.query.types === "string"
                ? req.query.types.split(",")
                : undefined,
            )
          : {
              ready: false,
              reasons: ["UNCONFIGURED"],
              publicationMode: "direct",
              supportedTypes: [],
            },
      );
    }),
  );
  router.get(
    "/jobs/publication/status",
    wrap("jobs:curate", async (_req, res) => {
      const publisher =
        service.jobsPublisher ??
        new JobsPublisher(pool, {
          config: {
            mode: "github",
            repository: null,
            branch: "main",
            remoteWritesEnabled: false,
          },
        });
      res.json(await publisher.status(user(res).communityId, user(res).id));
    }),
  );
  router.post(
    "/jobs/intake",
    wrap("jobs:curate", async (req, res) => {
      res
        .status(201)
        .json(
          await intake.save(
            user(res),
            req.body,
            req.get("Idempotency-Key") ?? "",
          ),
        );
    }),
  );
  router.put(
    "/jobs/intake/:id",
    wrap("jobs:curate", async (req, res) => {
      res.json(
        await intake.save(
          user(res),
          req.body,
          req.get("Idempotency-Key") ?? "",
          path(req),
        ),
      );
    }),
  );
  router.get(
    "/jobs/status",
    wrap("jobs:curate", async (_req, res) =>
      res.json(await service.jobs.status(user(res).communityId)),
    ),
  );
  router.get(
    "/job-sources",
    wrap("jobs:curate", async (req, res) => {
      const rows = await service.jobs.listSources(
        user(res).communityId,
        limit(req) + 1,
        offset(req),
      );
      res.json({
        items: rows.slice(0, limit(req)),
        nextCursor:
          rows.length > limit(req) ? String(offset(req) + limit(req)) : null,
      });
    }),
  );
  router.put(
    "/job-sources/:id",
    wrap("jobs:curate", async (req, res) => {
      const config = sourceSchema.parse(req.body.config);
      if (config.careersUrl) {
        const url = validateCareersUrl(config.careersUrl);
        config.careersUrl = url.href;
        const board = identifyBoard(url) ?? identifyDetailProvider(url);
        if (
          board &&
          (board.provider !== config.adapter ||
            board.boardIdentifier.toLowerCase() !==
              config.boardIdentifier.toLowerCase())
        )
          throw new IntegrationError("SOURCE_URL_MISMATCH");
        if (
          ["hirehive", "globant"].includes(config.adapter) &&
          (!board || !config.allowedHosts.includes(url.hostname))
        )
          throw new IntegrationError("SOURCE_URL_MISMATCH");
      }
      if (config.id !== path(req))
        throw new IntegrationError("SOURCE_ID_MISMATCH");
      if (
        config.enabled &&
        (!config.reviewReference ||
          !config.reviewedAt ||
          !config.permissionBasis ||
          !config.termsUrl ||
          !config.attribution)
      )
        throw new IntegrationError("SOURCE_REVIEW_REQUIRED");
      res.json(
        await service.jobs.save(
          user(res).communityId,
          user(res).id,
          config.id,
          config,
          req.body.version ?? 1,
        ),
      );
    }),
  );
  router.post(
    "/job-sources/:id/retire",
    wrap("jobs:curate", async (req, res) => {
      const input = z
        .object({
          version: z.number().int().positive(),
          reason: z.string().trim().min(5).max(1000),
        })
        .strict()
        .parse(req.body);
      res.json(
        await service.jobs.retire(
          user(res).communityId,
          user(res).id,
          path(req),
          input.version,
          input.reason,
        ),
      );
    }),
  );
  router.post(
    "/job-sources/:id/run",
    wrap("jobs:curate", async (req, res) => {
      res
        .status(202)
        .json(
          await service.jobs.enqueueRun(
            user(res).communityId,
            user(res).id,
            path(req),
            req.get("Idempotency-Key") ?? "",
          ),
        );
    }),
  );
  router.get(
    "/jobs/candidates",
    wrap("jobs:curate", async (req, res) => {
      const state = String(req.query.state ?? ""),
        scope = z
          .enum(["qualified", "ineligible", "all"])
          .parse(
            req.query.scope ?? (state === "excluded" ? "all" : "qualified"),
          );
      const page = await geographicQueue(
        pool,
        user(res).communityId,
        state,
        String(req.query.q ?? "").slice(0, 200),
        scope,
        limit(req),
        offset(req),
      );
      res.json({
        ...page,
        duplicateSuggestions: duplicateSuggestions(
          page.items.map((r) => r.payload),
        ),
        strongDuplicateSuggestions: strongVacancyDuplicates(
          page.items.map((r) => r.payload),
        ),
      });
    }),
  );
  router.get(
    "/jobs/exclusions",
    wrap("jobs:curate", async (req, res) => {
      const rows = await pool.query(
        `SELECT * FROM job_records WHERE community_id=$1 AND payload->>'status'='excluded' ORDER BY id LIMIT $2 OFFSET $3`,
        [user(res).communityId, limit(req) + 1, offset(req)],
      );
      res.json({
        items: rows.rows.slice(0, limit(req)),
        nextCursor:
          rows.rows.length > limit(req)
            ? String(offset(req) + limit(req))
            : null,
      });
    }),
  );
  router.post(
    "/jobs/changeset",
    wrap("content:publish", async (req, res) => {
      if (service.jobsPublisher?.configured) requireRecentAuthentication(res);
      const ids = z
        .array(z.string().max(300))
        .min(1)
        .max(100)
        .parse(req.body.jobIds);
      res
        .status(202)
        .json(
          await service.createJobsChangeset(
            user(res).communityId,
            user(res).id,
            ids,
            req.get("Idempotency-Key") ?? "",
            req.body.expectedVersions,
          ),
        );
    }),
  );
  router.get(
    "/jobs/runs",
    wrap("jobs:curate", (req, res) => list(req, res, "job_runs")),
  );
  router.post(
    "/jobs/:id/review",
    wrap("jobs:curate", async (req, res) => {
      const input = z
        .object({
          version: z.number().int().positive(),
          decision: z.enum([
            "approve",
            "exclude",
            "reopen",
            "close",
            "withdraw",
          ]),
          expiresAt: z.string().datetime().nullable().optional(),
          reason: z.string().min(1).max(1000).optional(),
          eligibility: z
            .enum([
              "peru",
              "remote-peru",
              "remote-latam-confirmed",
              "restricted",
              "unknown",
            ])
            .optional(),
          summary: z
            .object({
              "es-pe": z.string().min(1).max(4000),
              en: z.string().min(1).max(4000),
            })
            .optional(),
          tags: z.array(z.string().max(40)).max(20).optional(),
        })
        .strict()
        .parse(req.body);
      const reviewed = await transaction(pool, async (db) => {
        const row = (
          await db.query(
            "SELECT * FROM job_records WHERE id=$1 AND community_id=$2 FOR UPDATE",
            [path(req), user(res).communityId],
          )
        ).rows[0];
        if (!row) throw new IntegrationError("NOT_FOUND", 404);
        await assertLifecyclePublication(db, user(res).communityId, row.id);
        if (input.decision === "exclude" && row.payload.baseEntityHash)
          throw new IntegrationError("PUBLIC_WITHDRAWAL_REQUIRED", 409);
        if (input.decision === "withdraw" && !row.payload.baseEntityHash)
          throw new IntegrationError("PUBLIC_BASELINE_REQUIRED", 409);
        if (input.decision === "approve") {
          if (
            !["remote", "hybrid", "onsite", "unknown"].includes(
              row.payload.workplace,
            )
          )
            throw new IntegrationError("WORKPLACE_REVIEW_REQUIRED");
          const others = (
            await db.query(
              "SELECT payload FROM job_records WHERE community_id=$1 AND id<>$2 AND payload->>'status'<>'excluded' ORDER BY id",
              [user(res).communityId, row.id],
            )
          ).rows;
          const duplicates = strongVacancyDuplicates([
            row.payload,
            ...others.map((r) => r.payload),
          ]).filter((g) => g.ids.includes(row.id));
          if (duplicates.length)
            throw Object.assign(
              new IntegrationError("DUPLICATE_VACANCY_REVIEW_REQUIRED", 409),
              { duplicateSuggestions: duplicates },
            );
        }
        if (
          (["close", "withdraw"].includes(input.decision) ||
            Object.hasOwn(input, "expiresAt")) &&
          !input.reason
        )
          throw new IntegrationError("CLOSURE_REASON_REQUIRED");
        if (input.eligibility && !input.reason)
          throw new IntegrationError("ELIGIBILITY_REASON_REQUIRED");
        if (
          input.decision === "approve" &&
          ((!input.summary && !row.payload.summary) ||
            Object.values(input.summary ?? row.payload.summary ?? {}).some(
              (v) =>
                typeof v !== "string" ||
                !v.trim() ||
                /pending|pendiente/i.test(v),
            ))
        )
          throw new IntegrationError("REVIEWED_SUMMARY_REQUIRED");
        if (
          input.decision === "approve" &&
          (!jobGeography({
            ...row.payload,
            eligibility: input.eligibility ?? row.payload.eligibility,
            editorialEligibility:
              input.eligibility ?? row.payload.editorialEligibility,
          }).qualified ||
            row.payload.relevanceScore < 4)
        )
          throw new IntegrationError("ELIGIBILITY_REVIEW_REQUIRED");
        let withdrawalRecord: any = null;
        if (input.decision === "withdraw") {
          const history = (
            await db.query(
              "SELECT files FROM integration_changesets WHERE community_id=$1 AND (result->'jobIds' ? $3 OR files @> $2::jsonb) ORDER BY created_at DESC",
              [
                user(res).communityId,
                JSON.stringify([{ record: { id: row.id } }]),
                row.id,
              ],
            )
          ).rows;
          const records = history
            .flatMap((h) => h.files)
            .map((f: any) => {
              try {
                return f.record ?? JSON.parse(f.content);
              } catch {
                return null;
              }
            });
          withdrawalRecord =
            records.find(
              (r: any) =>
                r?.id === row.id &&
                hashRevision(r) === row.payload.baseEntityHash,
            ) ?? null;
          if (
            !withdrawalRecord &&
            !["peru", "remote-peru", "remote-latam-confirmed"].includes(
              row.payload.eligibility,
            )
          )
            throw new IntegrationError("PUBLIC_BASELINE_REQUIRED", 409);
        }
        const payload = {
          ...row.payload,
          ...(input.eligibility
            ? {
                eligibility: input.eligibility,
                editorialEligibility: input.eligibility,
              }
            : {}),
          ...(input.reason ? { reviewReason: input.reason } : {}),
          ...(input.summary ? { summary: input.summary } : {}),
          ...(input.tags ? { tags: input.tags } : {}),
          ...(Object.hasOwn(input, "expiresAt")
            ? {
                expiresAt: input.expiresAt,
                editorialExpiresAt: input.expiresAt,
              }
            : {}),
          ...(["close", "withdraw"].includes(input.decision)
            ? {
                ...(input.decision === "withdraw"
                  ? {
                      editorialWithdrawal: {
                        reason: input.reason,
                        requestedAt: new Date().toISOString(),
                        actorId: user(res).id,
                        publicRecord: withdrawalRecord,
                      },
                    }
                  : {}),
                editorialClosure: {
                  reason: input.reason,
                  closedAt: new Date().toISOString(),
                  actorId: user(res).id,
                },
                closureReason:
                  input.decision === "withdraw"
                    ? "curator-withdrawn"
                    : "curator-confirmed-closed",
              }
            : {}),
          ...(input.decision === "reopen"
            ? {
                editorialClosure: null,
                editorialWithdrawal: null,
                closureReason: null,
              }
            : {}),
          approved:
            input.decision === "approve" ||
            (input.decision === "close" && row.payload.approved === true) ||
            input.decision === "withdraw",
          status:
            input.decision === "exclude"
              ? "excluded"
              : ["close", "withdraw"].includes(input.decision)
                ? "closed"
                : input.decision === "approve"
                  ? row.payload.editorialClosure
                    ? "closed"
                    : "active"
                  : "needs-review",
        };
        const expiry = payload.expiresAt ? Date.parse(payload.expiresAt) : null;
        if (
          input.decision === "approve" &&
          (row.payload.status === "closed" ||
            payload.sourceClosed ||
            payload.editorialClosure ||
            (expiry !== null &&
              expiry <= (options.jobsNow?.() ?? new Date()).getTime()))
        )
          throw new IntegrationError("JOB_NOT_ACTIVE", 409);
        const result = await db.query(
          "UPDATE job_records SET payload=$4,version=version+1 WHERE id=$1 AND community_id=$2 AND version=$3 RETURNING *",
          [path(req), user(res).communityId, input.version, payload],
        );
        if (!result.rowCount)
          throw new IntegrationError("REVISION_CONFLICT", 409);
        await auditEvent(
          db,
          user(res),
          deterministicId({ job: path(req) }),
          "job_reviewed",
          {
            jobId: path(req),
            decision: input.decision,
            reason: input.reason ?? null,
            expiresAt: input.expiresAt ?? null,
            version: result.rows[0].version,
          },
        );
        return result.rows[0];
      });
      res.json({ ...reviewed, geography: jobGeography(reviewed.payload) });
    }),
  );
  router.get(
    "/publications/:id",
    wrap("content:read", async (req, res) => {
      const row = await service.publication(
        user(res).communityId,
        idSchema.parse(path(req)),
      );
      const { upload_state, ...safe } = row;
      const link = (
        await pool.query(
          "SELECT r.id,r.revision,r.state,r.desired_status FROM social_blog_links l JOIN records r ON r.id=l.blog_record_id AND r.community_id=l.community_id WHERE l.community_id=$1 AND l.publication_id=$2",
          [user(res).communityId, row.id],
        )
      ).rows[0];
      res.json({
        ...safe,
        socialIndex: link
          ? {
              id: link.id,
              revision: link.revision,
              state: link.state,
              desiredStatus: link.desired_status,
              confirmationMethod: "operator-attested",
            }
          : null,
      });
    }),
  );
  router.get(
    "/publications",
    wrap("content:read", async (req, res) => {
      const rows = await pool.query(
        `SELECT id,community_id,author_id,reviewer_id,channel,destination,payload,revision_hash,approved_hash,state,schedule_at,timezone,local_time,dependency_id,remote_id,remote_url,version,updated_at FROM integration_publications WHERE community_id=$1 AND ($2='' OR channel=$2) AND ($3='' OR state=$3) AND ($4='' OR payload->>'text' ILIKE '%'||$4||'%' OR payload->>'title' ILIKE '%'||$4||'%') ORDER BY id LIMIT $5 OFFSET $6`,
        [
          user(res).communityId,
          String(req.query.channel ?? ""),
          String(req.query.state ?? ""),
          String(req.query.q ?? "").slice(0, 200),
          limit(req) + 1,
          offset(req),
        ],
      );
      const linkedRows = await pool.query(
        "SELECT l.publication_id,r.id,r.revision,r.state,r.desired_status FROM social_blog_links l JOIN records r ON r.id=l.blog_record_id AND r.community_id=l.community_id WHERE l.community_id=$1 AND l.publication_id=ANY($2::uuid[])",
        [user(res).communityId, rows.rows.map((r) => r.id)],
      );
      const links = new Map(
        linkedRows.rows.map((r) => [
          r.publication_id,
          {
            id: r.id,
            revision: r.revision,
            state: r.state,
            desiredStatus: r.desired_status,
            confirmationMethod: "operator-attested",
          },
        ]),
      );
      res.json({
        items: rows.rows
          .slice(0, limit(req))
          .map((r) => ({ ...r, socialIndex: links.get(r.id) ?? null })),
        nextCursor:
          rows.rows.length > limit(req)
            ? String(offset(req) + limit(req))
            : null,
      });
    }),
  );
  router.post(
    "/publications",
    wrap("publication:draft", async (req, res) => {
      const value = z
        .object({
          channel: z.enum(["linkedin", "youtube", "manual"]),
          destination: z.string().min(1).max(200),
          payload: payloadSchema,
        })
        .strict()
        .parse(req.body);
      const u = user(res),
        id = randomUUID();
      value.payload = await enrich(u.communityId, value.payload);
      const hash = hashValue(value);
      const created = await idempotent(
        pool,
        u.communityId,
        req.get("Idempotency-Key") ?? "",
        value,
        async (db) => {
          await mediaReferenceFence(db, u.communityId, value.payload);
          await videoReferenceFence(db, u.communityId, value.payload);
          const result = await db.query(
            "INSERT INTO integration_publications(id,community_id,author_id,channel,destination,payload,revision_hash) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
            [
              id,
              u.communityId,
              u.id,
              value.channel,
              value.destination,
              value.payload,
              hash,
            ],
          );
          return result.rows[0];
        },
      );
      res.status(201).json(created);
    }),
  );
  router.patch(
    "/publications/:id",
    wrap("publication:draft", async (req, res) => {
      idSchema.parse(path(req));
      const input = z
        .object({
          version: z.number().int().positive(),
          payload: payloadSchema,
          destination: z.string().min(1).max(200).optional(),
          scheduledAt: z.string().datetime().nullable().optional(),
          timezone: z.string().max(100).optional(),
          localTime: z.string().max(100).optional(),
          dependencyId: z.string().uuid().nullable().optional(),
        })
        .strict()
        .parse(req.body);
      const row = await service.publication(user(res).communityId, path(req));
      if (
        ["sending", "published", "unknown", "manual-published"].includes(
          row.state,
        )
      )
        throw new IntegrationError("PUBLICATION_STATE", 409);
      input.payload = await enrich(user(res).communityId, input.payload);
      const destination = input.destination ?? row.destination;
      const scheduledAt =
          input.scheduledAt !== undefined
            ? input.scheduledAt
            : row.schedule_at
              ? new Date(row.schedule_at).toISOString()
              : null,
        timezone = input.timezone ?? row.timezone,
        localTime = input.localTime ?? row.local_time ?? "",
        dependencyId =
          input.dependencyId !== undefined
            ? input.dependencyId
            : row.dependency_id;
      try {
        new Intl.DateTimeFormat("en", { timeZone: timezone });
      } catch {
        throw new IntegrationError("INVALID_TIMEZONE");
      }
      if (scheduledAt)
        verifySchedule(new Date(scheduledAt), timezone, localTime);
      const hash = hashValue({
        channel: row.channel,
        destination,
        payload: input.payload,
        scheduledAt,
        timezone,
        localTime,
        dependencyId,
      });
      const updated = await transaction(pool, async (db) => {
        const current = (
          await db.query(
            "SELECT * FROM integration_publications WHERE community_id=$1 AND id=$2 FOR UPDATE",
            [user(res).communityId, row.id],
          )
        ).rows[0];
        if (!current || current.version !== input.version)
          throw new IntegrationError("REVISION_CONFLICT", 409);
        if (
          [
            "sending",
            "published",
            "unknown",
            "manual-published",
            "processing",
          ].includes(current.state)
        )
          throw new IntegrationError("PUBLICATION_STATE", 409);
        await mediaReferenceFence(db, user(res).communityId, input.payload);
        await videoReferenceFence(db, user(res).communityId, input.payload);
        return db.query(
          "UPDATE integration_publications SET payload=$4,destination=$5,revision_hash=$6,approved_hash=NULL,reviewer_id=NULL,state='draft',schedule_at=$7,timezone=$8,local_time=$9,dependency_id=$10,version=version+1,updated_at=now() WHERE id=$1 AND community_id=$2 AND version=$3 RETURNING *",
          [
            row.id,
            user(res).communityId,
            input.version,
            input.payload,
            destination,
            hash,
            scheduledAt,
            timezone,
            localTime,
            dependencyId,
          ],
        );
      });
      if (!updated.rowCount)
        throw new IntegrationError("REVISION_CONFLICT", 409);
      res.json(updated.rows[0]);
    }),
  );
  router.post(
    "/publications/:id/approve",
    wrap("content:review", async (req, res) => {
      const row = await service.publication(user(res).communityId, path(req));
      if (row.author_id === user(res).id)
        throw new IntegrationError("SELF_APPROVAL", 403);
      if (row.revision_hash !== req.body.revisionHash)
        throw new IntegrationError("REVISION_CONFLICT", 409);
      const result = await pool.query(
        "UPDATE integration_publications SET approved_hash=revision_hash,reviewer_id=$3,state='approved' WHERE id=$1 AND community_id=$2 AND revision_hash=$4 AND state IN('draft','approved','failed') RETURNING *",
        [row.id, user(res).communityId, user(res).id, req.body.revisionHash],
      );
      if (!result.rowCount)
        throw new IntegrationError("PUBLICATION_STATE", 409);
      res.json(result.rows[0]);
    }),
  );
  router.post(
    "/publications/:id/schedule",
    wrap("publishing:write", async (req, res) => {
      const input = z
        .object({
          revisionHash: z.string().length(64),
          scheduledAt: z.string().datetime(),
          timezone: z.string(),
          localTime: z.string().optional(),
          dependencyId: z.string().uuid().optional(),
        })
        .strict()
        .parse(req.body);
      const u = user(res);
      res
        .status(202)
        .json(
          await service.schedule(
            u.communityId,
            u.id,
            path(req),
            input.revisionHash,
            new Date(input.scheduledAt),
            input.timezone,
            input.localTime ?? "",
            req.get("Idempotency-Key") ?? "",
            input.dependencyId,
          ),
        );
    }),
  );
  router.post(
    "/publications/:id/cancel",
    wrap("publishing:write", async (req, res) => {
      const input = z
        .object({
          version: z.number().int().positive(),
          revisionHash: z.string().min(1).max(200),
          reason: z.string().trim().min(5).max(1000),
        })
        .strict()
        .parse(req.body);
      res.json(
        await service.cancel(
          user(res).communityId,
          path(req),
          input.version,
          input.revisionHash,
          user(res).id,
          input.reason,
        ),
      );
    }),
  );
  router.post(
    "/publications/:id/reconcile",
    wrap("publishing:write", async (req, res) =>
      res.json(
        await service.reconcilePublication(user(res).communityId, path(req)),
      ),
    ),
  );
  router.get(
    "/publications/:id/manual-export",
    wrap("publishing:write", async (req, res) => {
      const row = await service.publication(user(res).communityId, path(req));
      if (row.approved_hash !== row.revision_hash)
        throw new IntegrationError("APPROVAL_REQUIRED", 409);
      res.json(manualPackage(row.payload));
    }),
  );
  router.post(
    "/publications/:id/manual-confirm",
    wrap("publishing:write", async (req, res) => {
      requireCapability(res, "content:write");
      res.json(
        await confirmSocialPost(
          pool,
          user(res),
          path(req),
          req.body,
          req.get("Idempotency-Key") ?? "",
        ),
      );
    }),
  );
  router.get(
    "/changesets/:id",
    wrap("content:read", async (req, res) => {
      const row = (
        await pool.query(
          "SELECT id,state,files,result,pr_number,head_sha,merged_sha,deployed_sha,created_at,updated_at FROM integration_changesets WHERE id=$1 AND community_id=$2",
          [idSchema.parse(path(req)), user(res).communityId],
        )
      ).rows[0];
      if (!row) throw new IntegrationError("NOT_FOUND", 404);
      res.json(row);
    }),
  );
  router.get(
    "/changesets",
    wrap("content:read", (req, res) =>
      list(
        req,
        res,
        "integration_changesets",
        "id,state,pr_number,head_sha,merged_sha,deployed_sha,result,created_at,updated_at",
      ),
    ),
  );
  router.post(
    "/changesets",
    wrap("content:publish", async (req, res) => {
      const ids = z
          .array(z.string().uuid())
          .min(1)
          .max(30)
          .parse(req.body.recordIds),
        key = req.get("Idempotency-Key");
      if (!key) throw new IntegrationError("IDEMPOTENCY_KEY_REQUIRED", 428);
      const u = user(res);
      res
        .status(202)
        .json(
          await service.createChangeset(
            u.communityId,
            u.id,
            ids,
            key,
            req.body.expectedRevisions,
          ),
        );
    }),
  );
  router.post(
    "/changesets/:id/retry",
    wrap("content:publish", async (req, res) => {
      const u = user(res);
      res
        .status(202)
        .json(await service.retryChangeset(u.communityId, u.id, path(req)));
    }),
  );
  router.post(
    "/changesets/:id/reconcile",
    wrap("content:publish", async (req, res) =>
      res.json(
        await service.reconcileChangeset(
          user(res).communityId,
          path(req),
          user(res).id,
        ),
      ),
    ),
  );
  router.post(
    "/changesets/:id/merge",
    wrap("content:publish", async (req, res) => {
      if (!options.liveEnabled || !options.github)
        throw new IntegrationError("INTEGRATION_DISABLED", 503);
      const row = (
        await pool.query(
          "SELECT * FROM integration_changesets WHERE id=$1 AND community_id=$2",
          [path(req), user(res).communityId],
        )
      ).rows[0];
      if (!row?.pr_number) throw new IntegrationError("NOT_FOUND", 404);
      await service.validateOperation({
        actor_id: user(res).id,
        community_id: user(res).communityId,
        kind: row.result?.jobIds ? "jobs-changeset" : "changeset",
        subject_id: row.id,
      });
      res.json(
        await options.github.merge(
          row.pr_number,
          z
            .string()
            .regex(/^[a-f0-9]{40}$/)
            .parse(req.body.headSha),
        ),
      );
    }),
  );
  router.post(
    "/changesets/:id/revert",
    wrap("content:publish", async (req, res) => {
      if (!options.liveEnabled || !options.github)
        throw new IntegrationError("INTEGRATION_DISABLED", 503);
      const row = (
        await pool.query(
          "SELECT * FROM integration_changesets WHERE id=$1 AND community_id=$2",
          [path(req), user(res).communityId],
        )
      ).rows[0];
      if (!row?.pr_number) throw new IntegrationError("NOT_FOUND", 404);
      z.string().min(1).max(1000).parse(req.body.reason);
      res.status(202).json(
        await options.github.revert(
          randomUUID(),
          row.pr_number,
          z
            .string()
            .regex(/^[a-f0-9]{40}$/)
            .parse(req.body.expectedCurrentSha),
        ),
      );
    }),
  );
  router.post(
    "/publications/:id/resume",
    wrap("publishing:write", async (req, res) => {
      const u = user(res),
        row = await service.publication(u.communityId, path(req));
      if (
        row.channel !== "youtube" ||
        !row.upload_state.sessionUrl ||
        row.remote_id
      )
        throw new IntegrationError("UPLOAD_NOT_RESUMABLE", 409);
      if (row.approved_hash !== row.revision_hash)
        throw new IntegrationError("APPROVAL_REQUIRED", 409);
      const key = req.get("Idempotency-Key");
      if (!key) throw new IntegrationError("IDEMPOTENCY_KEY_REQUIRED", 428);
      const operation = await service.schedule(
        u.communityId,
        u.id,
        row.id,
        row.revision_hash,
        new Date(row.schedule_at),
        row.timezone,
        row.local_time ?? "",
        key,
        row.dependency_id ?? undefined,
      );
      res.status(202).json(operation);
    }),
  );
  router.post(
    "/publications/:id/visibility",
    wrap("publishing:write", async (req, res) => {
      const u = user(res),
        row = await service.publication(u.communityId, path(req));
      if (
        row.channel !== "youtube" ||
        !row.remote_id ||
        row.approved_hash !== row.revision_hash ||
        row.revision_hash !== req.body.revisionHash
      )
        throw new IntegrationError("APPROVAL_REQUIRED", 409);
      const visibility = z
        .enum(["private", "unlisted", "public"])
        .parse(req.body.visibility);
      if (visibility !== row.payload.desiredVisibility)
        throw new IntegrationError("APPROVED_VISIBILITY_REQUIRED", 409);
      await service.actor(row.reviewer_id, u.communityId, "content:review");
      const account = await service.connector(
          u.communityId,
          "youtube",
          row.destination,
        ),
        youtube = options.youtube ?? new YouTube();
      const status = await youtube.read(account, row.remote_id);
      if (status.state === "processing" || status.state === "failed")
        throw new IntegrationError("PROCESSING_NOT_READY", 409);
      await youtube.visibility(account, row.remote_id, visibility);
      res.json(await service.reconcilePublication(u.communityId, row.id));
    }),
  );
  router.get(
    "/integration-health",
    wrap("operations:read", async (_req, res) => {
      const u = user(res),
        queue = await pool.query(
          `SELECT state,count(*)::integer AS count,min(created_at) AS oldest FROM worker_outbox WHERE community_id=$1 GROUP BY state`,
          [u.communityId],
        ),
        runs = await pool.query(
          `SELECT source_id,min(created_at) AS first_run,max(created_at) AS last_run,max(created_at) FILTER(WHERE status='complete') AS last_success,count(*)::integer AS observed_runs,count(DISTINCT date(created_at AT TIME ZONE 'America/Lima'))::integer AS observed_days,(array_agg(status ORDER BY created_at DESC))[1:2] AS recent_statuses FROM job_runs WHERE community_id=$1 GROUP BY source_id`,
          [u.communityId],
        );
      res.json({
        queue: queue.rows,
        sources: runs.rows,
        liveEnabled: options.liveEnabled === true,
        pilot: {
          requiredDays: 7,
          observedDays: runs.rows.length
            ? Math.min(...runs.rows.map((r) => r.observed_days))
            : 0,
          observed:
            runs.rows.length > 0 &&
            runs.rows.every((r) => r.observed_days >= 7),
          accepted: false,
        },
        alerts: queue.rows
          .filter(
            (r) =>
              r.state === "deadletter" ||
              r.state === "unknown" ||
              (r.state === "queued" &&
                Date.now() - new Date(r.oldest).getTime() > 900000),
          )
          .map((r) => ({
            code:
              r.state === "queued" ? "QUEUE_BACKLOG" : r.state.toUpperCase(),
            count: r.count,
          }))
          .concat(
            runs.rows
              .filter(
                (r) =>
                  (r.recent_statuses?.length >= 2 &&
                    r.recent_statuses.every((s: string) => s !== "complete")) ||
                  !r.last_success ||
                  Date.now() - new Date(r.last_success).getTime() > 86400000,
              )
              .map((r) => ({
                code: "SOURCE_DEGRADED",
                sourceId: r.source_id,
                count: r.observed_runs,
              })),
          ),
        backupRestore: "unverified",
      });
    }),
  );
  router.post(
    "/publications/:id/recording-link",
    wrap("content:write", async (req, res) => {
      const u = user(res),
        publication = await service.publication(u.communityId, path(req));
      if (
        !["published", "manual-published"].includes(publication.state) ||
        !publication.payload.eventId ||
        !publication.remote_url
      )
        throw new IntegrationError("CONFIRMED_VIDEO_REQUIRED", 409);
      const recordingUrl = new URL(publication.remote_url);
      if (
        recordingUrl.protocol !== "https:" ||
        !["www.youtube.com", "youtube.com", "youtu.be"].includes(
          recordingUrl.hostname,
        )
      )
        throw new IntegrationError("CONFIRMED_VIDEO_REQUIRED", 409);
      const result = await idempotent(
        pool,
        u.communityId,
        `recording-link:${publication.id}:${hashValue(publication.remote_id ?? publication.remote_url)}`,
        { eventId: publication.payload.eventId, url: publication.remote_url },
        async (db) => {
          const row = (
            await db.query(
              "SELECT * FROM records WHERE id=$1 AND community_id=$2 AND type='events' AND scope='public' FOR UPDATE",
              [publication.payload.eventId, u.communityId],
            )
          ).rows[0];
          if (!row) throw new IntegrationError("NOT_FOUND", 404);
          if (row.state !== "approved")
            throw new IntegrationError("EVENT_DRAFT_EXISTS", 409);
          const payload = { ...row.payload, recording: publication.remote_url },
            updatedAt = new Date().toISOString(),
            revision = row.revision + 1,
            hash = hashRevision({ id: row.id, revision, payload, updatedAt });
          await db.query(
            "UPDATE records SET payload=$2,revision=$3,revision_hash=$4,state='draft',approved_hash=NULL,submitted_hash=NULL,reviewer_id=NULL,updated_at=$5 WHERE id=$1",
            [row.id, payload, revision, hash, updatedAt],
          );
          await db.query(
            "INSERT INTO record_revisions(record_id,revision,payload,revision_hash,updated_at) VALUES($1,$2,$3,$4,$5)",
            [row.id, revision, payload, hash, updatedAt],
          );
          await auditEvent(db, u, row.id, "recording_link_drafted", {
            publicationId: publication.id,
          });
          return {
            recordId: row.id,
            revision,
            state: "draft",
            next: "submit-for-review",
          };
        },
      );
      res.status(201).json(result);
    }),
  );
  router.get(
    "/operations",
    wrap("operations:read", (req, res) =>
      list(
        req,
        res,
        "worker_outbox",
        "id,kind,subject_id,state,attempts,available_at,last_code,result - ARRAY['copy','media','links','instructions','title'] AS result,created_at,updated_at",
      ),
    ),
  );
  router.get(
    "/operations/:id",
    wrap("operations:read", async (req, res) => {
      const row = (
        await pool.query(
          "SELECT id,kind,subject_id,state,attempts,available_at,last_code,result - ARRAY['copy','media','links','instructions','title'] AS result,created_at,updated_at FROM worker_outbox WHERE id=$1 AND community_id=$2",
          [idSchema.parse(path(req)), user(res).communityId],
        )
      ).rows[0];
      if (!row) throw new IntegrationError("NOT_FOUND", 404);
      res.json(row);
    }),
  );
  router.post(
    "/operations/run",
    wrap("members:manage", async (_req, res) =>
      res.json({ processed: await service.tick() }),
    ),
  );
  router.use(
    (error: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (error instanceof IntegrationError)
        return res.status(error.status).json(publicIntegrationError(error));
      if (error instanceof z.ZodError)
        return res
          .status(422)
          .json({ code: "VALIDATION", message: "Revisa los campos." });
      next(error);
    },
  );
  return router;
}
