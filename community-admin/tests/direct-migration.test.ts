import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPool, migrate, hasRequiredMigrations } from "../src/server/db";
import request from "supertest";
import { createApp } from "../src/server/app";
import { spawnSync } from "node:child_process";

test("normal migration runner registers direct publication once and preserves its journal on rerun", async () => {
  const schema = "test_direct_migration_" + randomUUID().replaceAll("-", ""),
    pool = createPool(process.env.DATABASE_URL!, schema);
  try {
    await migrate(pool, schema);
    assert.deepEqual(
      (
        await pool.query(
          "SELECT version FROM schema_migrations ORDER BY version",
        )
      ).rows.map((r) => r.version),
      [1, 2, 3, 4, 7, 8, 9],
    );
    await pool.query(
      "INSERT INTO website_publication_attempts(operation_id,attempt_id,repository,branch,subject,attempt) VALUES('fixture','fixture','example/repo','main','42','{\"state\":\"uncertain\"}')",
    );
    await migrate(pool, schema);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM schema_migrations WHERE version=7",
        )
      ).rows[0].count,
      1,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT attempt->>'state' AS state FROM website_publication_attempts WHERE operation_id='fixture'",
        )
      ).rows[0].state,
      "uncertain",
    );
    assert.equal(hasRequiredMigrations([1, 2, 3, 4]), false);
    assert.equal(hasRequiredMigrations([1, 2, 3, 4, 7]), false);
    assert.equal(hasRequiredMigrations([1, 2, 3, 4, 7, 8, 9]), true);
    const app = createApp({
      pool,
      media: [],
      origin: "http://127.0.0.1:4455",
      environment: "test",
    });
    assert.equal((await request(app).get("/api/health/ready")).status, 200);
    await pool.query("DELETE FROM schema_migrations WHERE version=9");
    assert.equal((await request(app).get("/api/health/ready")).status, 503);
    await migrate(pool, schema);
    await pool.query(
      "ALTER TABLE social_blog_links RENAME TO social_blog_links_held",
    );
    assert.equal((await request(app).get("/api/health/ready")).status, 503);
    await pool.query(
      "ALTER TABLE social_blog_links_held RENAME TO social_blog_links",
    );
    assert.equal((await request(app).get("/api/health/ready")).status, 200);
    await pool.query(
      "ALTER TABLE social_blog_links DROP CONSTRAINT social_blog_source_once",
    );
    assert.equal((await request(app).get("/api/health/ready")).status, 503);
    await pool.query(
      "ALTER TABLE social_blog_links ADD CONSTRAINT social_blog_source_once UNIQUE(community_id,source_network,canonical_permalink_key)",
    );
    assert.equal((await request(app).get("/api/health/ready")).status, 200);
    await pool.query("DELETE FROM schema_migrations WHERE version=7");
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
        timeout: 10_000,
      },
    );
    assert.equal(startup.status, 1);
    assert.match(startup.stderr, /Database migrations are incomplete/);
    const unready = await request(app).get("/api/health/ready");
    assert.equal(unready.status, 503);
    assert.equal(unready.body.code, "MIGRATIONS_REQUIRED");
    assert.equal((await request(app).get("/api/health/live")).status, 200);
    await migrate(pool, schema);
    assert.equal((await request(app).get("/api/health/ready")).status, 200);
    for (const missing of [
      "DROP TABLE website_publication_attempts",
      "ALTER TABLE editorial_proposals DROP COLUMN publication_mode",
    ]) {
      await pool.query(missing);
      const drift = await request(app).get("/api/health/ready");
      assert.equal(drift.status, 503);
      assert.equal(drift.body.code, "MIGRATIONS_REQUIRED");
      const driftStartup = spawnSync(
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
          timeout: 10_000,
        },
      );
      assert.equal(driftStartup.status, 1);
      assert.match(driftStartup.stderr, /Database migrations are incomplete/);
      await pool.query("DELETE FROM schema_migrations WHERE version=7");
      await migrate(pool, schema);
      assert.equal((await request(app).get("/api/health/ready")).status, 200);
    }
  } finally {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});
