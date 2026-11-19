import { Router, type ErrorRequestHandler } from "express";
import { z, ZodError } from "zod";
import type pg from "pg";
import { ApiError, getSession, requireCapability } from "../context";
import { EditorialService } from "./service";
import { GhEditorialTransport } from "./github";
import {
  editorialConfig,
  type EditorialConfig,
  type EditorialTransport,
} from "./types";
export interface EditorialOptions {
  config?: EditorialConfig;
  transport?: EditorialTransport;
  testTransport?: boolean;
}
const save = z
  .object({
    recordId: z.string().uuid(),
    baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
    baseRecordHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    payload: z.record(z.string(), z.unknown()),
    desiredStatus: z.enum(["published", "archived"]),
  })
  .strict();
const selected = z
  .object({
    id: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
function match(header: string | undefined) {
  if (!header) return undefined;
  if (
    !/^"[1-9]\d*"$/.test(header) ||
    !Number.isSafeInteger(Number(header.slice(1, -1)))
  )
    throw new ApiError(
      422,
      "DRAFT_VERSION_INVALID",
      "La versión local no es válida.",
    );
  return Number(header.slice(1, -1));
}
function key(value: string | undefined) {
  if (!value || !/^[a-zA-Z0-9_-]{8,128}$/.test(value))
    throw new ApiError(
      428,
      "IDEMPOTENCY_REQUIRED",
      "Envía una clave única para esta propuesta.",
    );
  return value;
}
export function createEditorialRouter(
  pool: pg.Pool,
  options: EditorialOptions = {},
  environment?: string,
  origin = "http://127.0.0.1",
) {
  const config = options.config ?? editorialConfig();
  const localOrigin = new URL(origin);
  if (
    config.mode === "github" &&
    (environment === "production" ||
      localOrigin.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(localOrigin.hostname))
  )
    throw new Error(
      "GitHub editorial mode requires a non-production loopback runtime",
    );
  const transport = options.transport ?? new GhEditorialTransport(config),
    service = new EditorialService(
      pool,
      config,
      transport,
      environment === "test" &&
        Boolean(options.transport) &&
        options.testTransport === true,
    ),
    router = Router();
  router.use("/editorial", (_req, res, next) => {
    requireCapability(res, "content:read");
    next();
  });
  router.get("/editorial/status", async (_req, res) =>
    res.json(await service.status(getSession(res))),
  );
  router.get("/editorial/events", async (_req, res) =>
    res.json(await service.events(getSession(res))),
  );
  router.get("/editorial/submissions", async (_req, res) =>
    res.json(await service.submissions(getSession(res))),
  );
  router.post("/editorial/submissions/:id/reconcile", async (req, res) => {
    z.object({}).strict().parse(req.body);
    res.json(
      await service.reconcileSubmission(
        getSession(res),
        z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(req.params.id),
      ),
    );
  });
  router.get("/editorial/drafts", async (_req, res) =>
    res.json(await service.drafts(getSession(res))),
  );
  router.post("/editorial/pull", async (req, res) => {
    z.object({}).strict().parse(req.body);
    res.json(await service.pull(getSession(res)));
  });
  router.put("/editorial/drafts/:id", async (req, res) => {
    requireCapability(res, "content:write");
    const id = z.string().uuid().parse(req.params.id);
    res.json(
      await service.save(
        getSession(res),
        id,
        save.parse(req.body),
        match(req.get("If-Match")),
      ),
    );
  });
  router.delete("/editorial/drafts/:id", async (req, res) => {
    requireCapability(res, "content:write");
    const version = match(req.get("If-Match"));
    if (!version)
      throw new ApiError(
        428,
        "PRECONDITION_REQUIRED",
        "Envía la versión local antes de descartar.",
      );
    res.json(
      await service.discard(
        getSession(res),
        z.string().uuid().parse(req.params.id),
        version,
      ),
    );
  });
  router.post("/editorial/drafts/:id/propose", async (req, res) => {
    requireCapability(res, "content:write");
    const body = z
        .object({ expectedVersion: z.number().int().positive() })
        .strict()
        .parse(req.body),
      id = z.string().uuid().parse(req.params.id);
    const result = await service.propose(
      getSession(res),
      [{ id, expectedVersion: body.expectedVersion }],
      key(req.get("Idempotency-Key")),
    );
    res.json(result.items[0]);
  });
  router.post("/editorial/proposals", async (req, res) => {
    requireCapability(res, "content:write");
    const body = z
      .object({ drafts: z.array(selected).min(1).max(25) })
      .strict()
      .parse(req.body);
    res.json(
      await service.propose(
        getSession(res),
        body.drafts,
        key(req.get("Idempotency-Key")),
      ),
    );
  });
  router.post("/editorial/drafts/:id/reconcile", async (req, res) => {
    z.object({}).strict().parse(req.body);
    res.json(
      await service.reconcile(
        getSession(res),
        z.string().uuid().parse(req.params.id),
      ),
    );
  });
  const errors: ErrorRequestHandler = (error, _req, _res, next) => {
    if (error instanceof ZodError)
      return next(
        new ApiError(
          422,
          "VALIDATION_FAILED",
          "Revisa los campos indicados.",
          error.issues.map((i) => ({
            path: i.path.join("/"),
            message: i.message,
          })),
        ),
      );
    if (
      error instanceof ApiError &&
      ["CONTENT_INVALID", "PUBLIC_SCHEMA_INVALID"].includes(error.code)
    )
      return next(
        new ApiError(
          422,
          "VALIDATION_FAILED",
          error.message,
          error.fieldErrors,
        ),
      );
    next(error);
  };
  router.use("/editorial", errors);
  return { router, config, service };
}
