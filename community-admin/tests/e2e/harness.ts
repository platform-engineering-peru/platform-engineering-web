import { copyJourneyContracts } from "./contracts-fixture";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import express from "express";
import type pg from "pg";
import type { Browser, BrowserContext, Page, APIResponse } from "playwright";
import type { createApp } from "../../src/server/app";
import type { VerifiedMedia } from "../../src/shared/content";
import {
  createPool,
  migrate,
  hasRequiredMigrations,
  hasDirectPublicationSchema,
} from "../../src/server/db";
import {
  validateDatabaseURL,
  disposableSchema,
  cleanupAll,
  type JourneyResult,
} from "./safety";
type AppOptions = Parameters<typeof createApp>[0];
export interface JourneyContext {
  page: Page;
  browser: Browser;
  context: BrowserContext;
  origin: string;
  pool: pg.Pool;
  schema: string;
  artifacts: string;
  temporary: string;
  media: VerifiedMedia[];
  signal: AbortSignal;
  login(persona: string): Promise<any>;
  api(
    method: string,
    path: string,
    body?: unknown,
    options?: {
      version?: number | string;
      key?: string;
      headers?: Record<string, string>;
      csrf?: boolean;
      origin?: boolean;
    },
  ): Promise<APIResponse>;
  screenshot(name: string): Promise<string>;
  sql: pg.Pool["query"];
}
export interface Journey {
  id: string;
  title: string;
  requirements: string[];
  providerMode: "none" | "synthetic";
  configure?(
    context: Pick<JourneyContext, "pool" | "schema" | "media">,
  ): Promise<Pick<AppOptions, "editorial" | "jobsTest">>;
  run(context: JourneyContext): Promise<void>;
}
export interface HarnessOptions {
  browser: Browser;
  databaseURL: string;
  repository: string;
  temporary: string;
  artifacts: string;
  web: string;
  serverModule: string;
  media: VerifiedMedia[];
  ports: Set<number>;
  violations: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}
export async function runJourney(
  journey: Journey,
  options: HarnessOptions,
): Promise<JourneyResult> {
  validateDatabaseURL(options.databaseURL);
  if (!/^[a-z][a-z0-9-]+$/.test(journey.id) || !journey.requirements.length)
    throw Error("E2E_INVALID_JOURNEY");
  const started = performance.now(),
    schema = disposableSchema("e2e_" + randomUUID().replaceAll("-", "")),
    temporary = resolve(options.temporary, schema),
    artifacts = resolve(options.artifacts, journey.id),
    pool = createPool(options.databaseURL, schema),
    server = createServer(),
    controller = new AbortController();
  pool.options.statement_timeout = 15000;
  pool.options.query_timeout = 20000;
  pool.options.application_name = schema;
  let context: BrowserContext | undefined,
    page: Page | undefined,
    migrated = false,
    listening = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    origin = "",
    port = 0,
    error: unknown;
  const cleanupProof = {
    browserClosed: false,
    serverClosed: false,
    schemaDropped: false,
    poolClosed: false,
    privateTemporaryRemoved: false,
  };
  const abortFromRunner = () => controller.abort();
  options.signal?.addEventListener("abort", abortFromRunner, { once: true });
  if (options.signal?.aborted) controller.abort();
  let stopReject: (error: Error) => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    stopReject = reject;
  });
  // A handler is present immediately, even if the abort happens during setup.
  void stopped.catch(() => {});
  controller.signal.addEventListener(
    "abort",
    () => stopReject(Error("E2E_JOURNEY_ABORTED_OR_TIMEOUT")),
    { once: true },
  );
  timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 120000);
  const oldCwd = process.cwd(),
    oldEnv = { ...process.env },
    errors: string[] = [],
    network: any[] = [],
    artifactsList: string[] = [],
    violationStart = options.violations.length;
  try {
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    await mkdir(artifacts, { recursive: true });
    for (const [name, source] of [
      ["migrations", join(options.repository, "migrations")],
      ["public", join(options.repository, "public")],
    ])
      await symlink(source, join(temporary, name));
    await copyJourneyContracts(options.repository, temporary);
    process.chdir(temporary);
    await mkdir(join(temporary, "tmp"), { recursive: true, mode: 0o700 });
    process.env.TMPDIR = join(temporary, "tmp");
    process.env.TEMP = join(temporary, "tmp");
    process.env.PRIVATE_KEY_DIR = join(temporary, "keys");
    process.env.PRIVATE_STORAGE_DIR = join(temporary, "storage");
    process.env.GH_CONFIG_DIR = join(temporary, "gh-disabled");
    process.env.GIT_CONFIG_GLOBAL = join(temporary, "git-disabled");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.WEBSITE_CHECKOUT = resolve(options.repository, "..");
    await migrate(pool, schema);
    migrated = true;
    assert.equal(
      (await pool.query("SELECT current_schema() AS schema")).rows[0].schema,
      schema,
    );
    const migrations = (
      await pool.query("SELECT version FROM schema_migrations")
    ).rows.map((r) => r.version);
    assert.ok(hasRequiredMigrations(migrations));
    assert.ok(await hasDirectPublicationSchema(pool));
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", done);
    });
    listening = true;
    const address = server.address();
    assert.ok(
      address &&
        typeof address === "object" &&
        address.address === "127.0.0.1" &&
        address.port !== 4455,
    );
    port = address.port;
    options.ports.add(port);
    origin = `http://127.0.0.1:${port}`;
    const configured = await Promise.race([
      Promise.resolve(
        journey.configure?.({ pool, schema, media: options.media }),
      ),
      stopped,
    ]);
    if (configured && journey.providerMode !== "synthetic")
      throw Error("E2E_PROVIDER_CLASSIFICATION_REQUIRED");
    const { createApp: builtCreateApp } = await import(
      pathToFileURL(options.serverModule).href
    );
    const app = builtCreateApp({
      ...configured,
      pool,
      media: options.media,
      origin,
      fixtureAuthEnabled: true,
      localGhAuthEnabled: false,
      environment: "test",
    });
    app.use(express.static(options.web));
    app.get("/{*path}", (_: any, res: any) =>
      res.sendFile("index.html", { root: options.web, dotfiles: "allow" }),
    );
    server.on("request", app);
    context = await options.browser.newContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
      timezoneId: "America/Lima",
      serviceWorkers: "block",
    });
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) {
        options.violations.push("blocked-browser-request");
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    await context.tracing.start({ screenshots: true, snapshots: true });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(20000);
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("response", (r) => {
      const url = new URL(r.url());
      network.push({
        method: r.request().method(),
        path: url.pathname,
        status: r.status(),
      });
    });
    let me: any;
    const api: JourneyContext["api"] = async (
      method,
      path,
      body,
      requestOptions = {},
    ) => {
      if (
        !path.startsWith("/") ||
        path.startsWith("//") ||
        new URL(path, origin).origin !== origin
      )
        throw Error("E2E_API_ORIGIN_REQUIRED");
      const write = !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase()),
        headers: Record<string, string> = {};
      if (write) {
        if (requestOptions.origin !== false) headers.Origin = origin;
        if (requestOptions.csrf !== false && me?.csrfToken)
          headers["X-CSRF-Token"] = me.csrfToken;
        headers["Idempotency-Key"] = requestOptions.key ?? randomUUID();
      }
      if (requestOptions.version !== undefined)
        headers["If-Match"] = `"${requestOptions.version}"`;
      Object.assign(headers, requestOptions.headers);
      return page!.request.fetch(
        origin + (path.startsWith("/api/") ? path : "/api" + path),
        {
          method,
          headers,
          ...(body === undefined ? {} : { data: body }),
          timeout: 20000,
        },
      );
    };
    const screenshot = async (name: string) => {
      if (!/^[a-zA-Z0-9_-]+$/.test(name))
        throw Error("E2E_ARTIFACT_NAME_INVALID");
      const path = join(artifacts, name + ".png");
      await page!.screenshot({ path, fullPage: true });
      artifactsList.push(path);
      return path;
    };
    const ctx: JourneyContext = {
      page,
      browser: options.browser,
      context,
      origin,
      pool,
      schema,
      artifacts,
      temporary,
      media: options.media,
      signal: controller.signal,
      api,
      screenshot,
      sql: pool.query.bind(pool) as pg.Pool["query"],
      login: async (persona) => {
        const response = await api(
          "POST",
          "/dev/login",
          { persona },
          { csrf: false },
        );
        assert.equal(response.status(), 200, await response.text());
        const current = await api("GET", "/me");
        assert.equal(current.status(), 200);
        me = await current.json();
        return me;
      },
    };
    await Promise.race([journey.run(ctx), stopped]);
    assert.deepEqual(errors, [], "Browser page errors");
    assert.equal(
      options.violations.length,
      violationStart,
      "Unexpected network/subprocess activity",
    );
    await writeFile(
      join(artifacts, "state-proof.json"),
      JSON.stringify(
        {
          schema,
          loopbackOrigin: true,
          migrations,
          temporaryStorage: true,
          builtServer: true,
          cleanupPending: true,
          providerMode: journey.providerMode,
        },
        null,
        2,
      ),
    );
  } catch (caught) {
    error = caught;
    if (page && !page.isClosed())
      try {
        await page.screenshot({
          path: join(artifacts, "failure.png"),
          fullPage: true,
          timeout: 5000,
        });
        artifactsList.push(join(artifacts, "failure.png"));
      } catch (screenshotError) {
        errors.push(
          `Failure screenshot unavailable: ${String(screenshotError)}`,
        );
      }
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortFromRunner);
    controller.abort();
    const actions: (() => Promise<unknown>)[] = [];
    if (context) {
      actions.push(() =>
        context!.tracing.stop({ path: join(artifacts, "trace.zip") }),
      );
      actions.push(async () => {
        await context!.close();
        cleanupProof.browserClosed = true;
      });
    }
    if (listening)
      actions.push(async () => {
        server.closeAllConnections();
        await new Promise<void>((done, reject) =>
          server.close((e) => (e ? reject(e) : done())),
        );
        cleanupProof.serverClosed = true;
      });
    actions.push(async () => {
      if (migrated)
        await pool.query(`DROP SCHEMA "${disposableSchema(schema)}" CASCADE`);
      cleanupProof.schemaDropped = true;
    });
    actions.push(async () => {
      await pool.end();
      cleanupProof.poolClosed = true;
    });
    actions.push(async () => {
      process.chdir(oldCwd);
      for (const key of Object.keys(process.env))
        if (!(key in oldEnv)) delete process.env[key];
      Object.assign(process.env, oldEnv);
      await rm(temporary, { recursive: true, force: true });
      options.ports.delete(port);
      cleanupProof.privateTemporaryRemoved = true;
    });
    try {
      await cleanupAll(actions);
    } catch (cleanupError) {
      error = new AggregateError(
        [...(error ? [error] : []), cleanupError],
        "E2E_JOURNEY_OR_CLEANUP_FAILED",
      );
    }
    await writeFile(
      join(artifacts, "cleanup.json"),
      JSON.stringify(cleanupProof, null, 2),
    );
    await writeFile(
      join(artifacts, "network.json"),
      JSON.stringify(
        {
          responses: network,
          errors,
          violations: options.violations.slice(violationStart),
        },
        null,
        2,
      ),
    );
  }
  return {
    id: journey.id,
    executionLayer: "built-client-built-api-pg",
    requirements: journey.requirements,
    providerMode: journey.providerMode,
    status: error ? "failed" : "passed",
    ...(error
      ? {
          error:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
        }
      : {}),
    durationMs: Math.round(performance.now() - started),
    artifacts: artifactsList,
  };
}
