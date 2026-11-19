import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import request from "supertest";
import { createPool, migrate } from "../src/server/db";
import { createApp } from "../src/server/app";
test("normal migration8 registers once, preserves uncertain journal, and physical discard readiness fails closed before startup", async () => {
  const schema = "test_lifecycle_migrate_" + randomUUID().replaceAll("-", ""),
    pool = createPool(process.env.DATABASE_URL!, schema);
  try {
    await migrate(pool, schema);
    await pool.query(
      "INSERT INTO website_publication_attempts(operation_id,attempt_id,repository,branch,subject,attempt) VALUES('lifecycle','lifecycle','example/repo','main','42','{\"state\":\"uncertain\"}')",
    );
    await migrate(pool, schema);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM schema_migrations WHERE version=8",
        )
      ).rows[0].n,
      1,
    );
    const app = createApp({
      pool,
      media: [],
      origin: "http://127.0.0.1:4455",
      environment: "test",
    });
    assert.equal((await request(app).get("/api/health/ready")).status, 200);
    for (const mutation of [
      "DELETE FROM schema_migrations WHERE version=8",
      "ALTER TABLE drafts DROP CONSTRAINT drafts_state_check",
    ]) {
      await pool.query(mutation);
      assert.equal((await request(app).get("/api/health/ready")).status, 503);
      assert.equal((await request(app).get("/api/health/live")).status, 200);
      const startup = spawnSync(
        process.execPath,
        ["--import", "tsx", "src/server/main.ts"],
        {
          env: {
            ...process.env,
            DATABASE_SCHEMA: schema,
            SERVE_BUILD: "1",
            PORT: "65500",
          },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      assert.equal(startup.status, 1);
      assert.match(startup.stderr, /Database migrations are incomplete/);
      // Disposable-schema repair only; never a production migration procedure.
      await pool.query("DELETE FROM schema_migrations WHERE version=8");
      await migrate(pool, schema);
      assert.equal((await request(app).get("/api/health/ready")).status, 200);
    }
    assert.equal(
      (
        await pool.query(
          "SELECT attempt->>'state' state FROM website_publication_attempts WHERE operation_id='lifecycle'",
        )
      ).rows[0].state,
      "uncertain",
    );
  } finally {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});
