import { fullIntegrationOptions } from "./integration-bridge";
import { startIntegrationWorker } from "./integrations/runtime";
import express from "express";
import { resolve } from "node:path";
import { createServer as createHttpServer } from "node:http";
import {
  createPool,
  hasRequiredMigrations,
  hasDirectPublicationSchema,
} from "./db";
import { verifySeedMedia } from "./media";
import { createApp } from "./app";
const port = Number(process.env.PORT ?? 4455);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("PORT must be an integer between 1024 and 65535.");
if (!process.env.DATABASE_URL)
  throw new Error("DATABASE_URL is required. See README for local setup.");
const pool = createPool(process.env.DATABASE_URL, process.env.DATABASE_SCHEMA);
const applied = (
  await pool.query("SELECT version FROM schema_migrations")
).rows.map((r) => r.version);
if (
  !hasRequiredMigrations(applied) ||
  !(await hasDirectPublicationSchema(pool))
)
  throw new Error(
    "Database migrations are incomplete. Run npm run migrate before startup.",
  );
const media = await verifySeedMedia(),
  origin = process.env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`;
const app = createApp({
  pool,
  media,
  origin,
  localGhAuthEnabled: process.env.LOCAL_GH_AUTH === "1",
  localGhExpectedSubject: process.env.LOCAL_GH_EXPECTED_SUBJECT,
  fixtureAuthEnabled: process.env.DEV_FIXTURE_AUTH === "1",
  environment: process.env.NODE_ENV ?? "development",
});
const worker = startIntegrationWorker(fullIntegrationOptions(pool));
const server = createHttpServer(app);
if (process.env.SERVE_BUILD === "1" || process.env.NODE_ENV === "production") {
  app.use(express.static(resolve("dist/web"), { index: false }));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(resolve("dist/web/index.html")),
  );
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    server: { middlewareMode: true, hmr: { server, host: "127.0.0.1" } },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
server.listen(port, "::", () =>
  console.log(
    `Community administration: ${origin}\nFixture login: ${process.env.DEV_FIXTURE_AUTH === "1" && process.env.NODE_ENV !== "production" ? "explicitly enabled" : "disabled (fail closed)"}`,
  ),
);
const stop = () =>
  server.close(() => {
    void worker
      .stop()
      .then(() => pool.end())
      .then(() => process.exit(0));
  });
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
