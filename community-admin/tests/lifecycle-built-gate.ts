/** Verify the exact compiled server refuses incomplete disposable lifecycle schemas before listen/worker startup. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createPool, migrate } from "../src/server/db";
import { createApp } from "../src/server/app";
assert.ok(process.env.DATABASE_URL);
const schema = "test_lifecycle_built_" + randomUUID().replaceAll("-", ""),
  pool = createPool(process.env.DATABASE_URL, schema),
  temporary = resolve(".local", schema),
  server = createServer(
    createApp({
      pool,
      media: [],
      origin: "http://127.0.0.1:65501",
      environment: "test",
    }),
  );
try {
  await mkdir(temporary, { recursive: true });
  const preload = resolve(temporary, "no-listen.cjs");
  await writeFile(
    preload,
    "require('node:net').Server.prototype.listen=function(){throw new Error('Unexpected listen before migration gate')};\n",
  );
  await migrate(pool, schema);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const a = server.address();
  assert.ok(a && typeof a === "object");
  const origin = `http://127.0.0.1:${a.port}`;
  await pool.query(
    "INSERT INTO website_publication_attempts(operation_id,attempt_id,repository,branch,subject,attempt) VALUES('fixture','fixture','example/repo','main','42','{\"state\":\"uncertain\"}')",
  );
  const child = () =>
    spawnSync(process.execPath, ["--require", preload, "dist/server/main.js"], {
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        DATABASE_SCHEMA: schema,
        SERVE_BUILD: "1",
        PORT: "65501",
        PUBLIC_ORIGIN: "http://127.0.0.1:65501",
        NODE_ENV: "test",
        DEV_FIXTURE_AUTH: "0",
        LOCAL_GH_AUTH: "0",
        INTEGRATIONS_LIVE_ENABLED: "false",
        EDITORIAL_MODE: "local",
        JOBS_WEBSITE_WRITES: "false",
        PRIVATE_KEY_DIR: resolve(temporary, "keys"),
      },
    });
  assert.equal((await fetch(origin + "/api/health/ready")).status, 200);
  for (const [label, breakSql, restoreSql] of [
    ["missing8", "DELETE FROM schema_migrations WHERE version=8", null],
    [
      "physical-discard-constraint",
      "ALTER TABLE drafts DROP CONSTRAINT drafts_state_check; ALTER TABLE drafts ADD CONSTRAINT drafts_state_check CHECK(state IN('draft','submitted','approved','changes_requested'))",
      "ALTER TABLE drafts DROP CONSTRAINT drafts_state_check; ALTER TABLE drafts ADD CONSTRAINT drafts_state_check CHECK(state IN('draft','submitted','approved','changes_requested','discarded'))",
    ],
    [
      "missing-journal",
      "ALTER TABLE website_publication_attempts RENAME TO saved_publication_attempts",
      "ALTER TABLE saved_publication_attempts RENAME TO website_publication_attempts",
    ],
  ] as const) {
    await pool.query(breakSql);
    const refused = child();
    assert.equal(refused.status, 1, label + refused.stderr);
    assert.match(refused.stderr, /Database migrations are incomplete/);
    assert.doesNotMatch(refused.stderr, /Unexpected listen/);
    const ready = await fetch(origin + "/api/health/ready");
    assert.equal(ready.status, 503, label);
    assert.equal((await ready.json()).code, "MIGRATIONS_REQUIRED");
    assert.equal((await fetch(origin + "/api/health/live")).status, 200);
    if (restoreSql) await pool.query(restoreSql);
    else await migrate(pool, schema);
    assert.equal((await fetch(origin + "/api/health/ready")).status, 200);
  }
  await migrate(pool, schema);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM schema_migrations WHERE version=8",
      )
    ).rows[0].n,
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
  console.log(
    JSON.stringify(
      {
        compiledServerSha256: createHash("sha256")
          .update(await readFile("dist/server/main.js"))
          .digest("hex"),
        missing8: "startup-refused/ready503/live200/normal-migrate-repair",
        physicalDiscardConstraint: "startup-refused/ready503/live200/restored",
        journalMissing: "startup-refused/ready503/live200/restored",
        journalPreserved: true,
        version8Once: true,
        mainEffects: false,
      },
      null,
      2,
    ),
  );
} finally {
  await new Promise<void>((done) => server.close(() => done()));
  await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await pool.end();
  await rm(temporary, { recursive: true, force: true });
}
