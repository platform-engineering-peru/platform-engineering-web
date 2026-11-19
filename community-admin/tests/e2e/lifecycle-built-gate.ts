/** Negative compiled-main startup is fenced before sockets; positive ready/live uses the compiled app. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { pathToFileURL } from "node:url";
import request from "supertest";
import { createPool, migrate } from "../../src/server/db";
import { validateDatabaseURL, disposableSchema } from "./safety";
const target = validateDatabaseURL(process.env.DATABASE_URL),
  appFile = process.env.E2E_BUILT_APP,
  mainFile = process.env.E2E_BUILT_MAIN;
assert.ok(appFile && mainFile, "Compiled app/main artifacts are mandatory");
const { createApp } = await import(pathToFileURL(appFile).href),
  cases: any[] = [];
for (const defect of [
  "version",
  "journal-table",
  "journal-column",
  "lifecycle-constraint",
]) {
  const schema = disposableSchema("e2e_" + randomUUID().replaceAll("-", "")),
    pool = createPool(target.url, schema),
    operation = randomUUID();
  try {
    await migrate(pool, schema);
    await pool.query(
      "INSERT INTO website_publication_attempts(operation_id,attempt_id,repository,branch,subject,attempt) VALUES($1,'gate-proof','example/community','main','42',$2)",
      [operation, { state: "uncertain", expectedHeadOid: "a".repeat(40) }],
    );
    const app = createApp({
      pool,
      media: [],
      origin: "http://127.0.0.1:4999",
      fixtureAuthEnabled: true,
      environment: "test",
    });
    assert.equal((await request(app).get("/api/health/ready")).status, 200);
    if (defect === "version")
      await pool.query("DELETE FROM schema_migrations WHERE version=8");
    if (defect === "journal-table")
      await pool.query(
        "ALTER TABLE website_publication_attempts RENAME TO held_attempts",
      );
    if (defect === "journal-column")
      await pool.query(
        "ALTER TABLE website_publication_attempts RENAME COLUMN attempt TO held_attempt",
      );
    if (defect === "lifecycle-constraint")
      await pool.query("ALTER TABLE drafts DROP CONSTRAINT drafts_state_check");
    assert.equal(
      (await request(app).get("/api/health/ready")).status,
      503,
      defect,
    );
    assert.equal(
      (await request(app).get("/api/health/live")).status,
      200,
      defect,
    );
    const startup: SpawnSyncReturns<string> = spawnSync(
      process.execPath,
      [mainFile],
      {
        encoding: "utf8",
        timeout: 15000,
        env: {
          ...process.env,
          DATABASE_URL: target.url,
          DATABASE_SCHEMA: schema,
          NODE_ENV: "test",
          PORT: "4455",
          SERVE_BUILD: "1",
          DEV_FIXTURE_AUTH: "0",
        },
      },
    );
    assert.equal(startup.error, undefined, String(startup.error));
    assert.equal(
      startup.status,
      1,
      `${defect}: ${startup.stdout}\n${startup.stderr}`,
    );
    assert.match(
      startup.stderr,
      /Database migrations are incomplete/,
      "Must fail the compiled migration gate, not a later bind/provider error",
    );
    if (defect === "journal-table")
      await pool.query(
        "ALTER TABLE held_attempts RENAME TO website_publication_attempts",
      );
    if (defect === "journal-column")
      await pool.query(
        "ALTER TABLE website_publication_attempts RENAME COLUMN held_attempt TO attempt",
      );
    if (defect === "lifecycle-constraint")
      await pool.query("DELETE FROM schema_migrations WHERE version=8");
    await migrate(pool, schema);
    assert.equal((await request(app).get("/api/health/ready")).status, 200);
    assert.equal(
      (
        await pool.query(
          "SELECT attempt FROM website_publication_attempts WHERE operation_id=$1",
          [operation],
        )
      ).rows[0].attempt.state,
      "uncertain",
    );
    cases.push({
      defect,
      compiledStartupRefusedBeforeSocket: true,
      ready503Live200: true,
      normalMigrateReady200: true,
      journalPreserved: true,
    });
  } finally {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
}
console.log(
  JSON.stringify({
    scenario: "startup-built-gate",
    executionLayer: "compiled-main-startup-built-api-pg",
    cases,
    providerWrites: 0,
  }),
);
