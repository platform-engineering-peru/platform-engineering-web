import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { createPool, migrate, COMMUNITY_ID } from "../src/server/db";
import { JobsService, jobsWorkerState } from "../src/server/jobs/service";
import { IntegrationService } from "../src/server/integrations/service";
import { createIntegrationRouter } from "../src/server/integrations/router";
import { capabilitiesFor } from "../src/server/context";
import type { Transport } from "../src/server/integrations/http";
const schema = "test_jobs_" + randomUUID().replaceAll("-", ""),
  actor = "10000000-0000-4000-8000-000000000004";
let pool: ReturnType<typeof createPool>,
  clock = new Date("2026-11-17T00:00:00Z"),
  api: any,
  service: IntegrationService,
  calls = 0;
let fetchImpl: Transport = async () => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: Buffer.from(
    JSON.stringify({
      jobs: [
        {
          id: 1,
          title: "DevOps Engineer",
          location: { name: "Remote" },
          absolute_url: "https://boards.greenhouse.io/acme/jobs/1",
          content: "Maintain cloud infrastructure",
          validThrough: "2026-12-01T00:00:00Z",
        },
        {
          id: 2,
          title: "Sales Executive",
          location: { name: "Peru" },
          absolute_url: "https://boards.greenhouse.io/acme/jobs/2",
        },
      ],
    }),
  ),
});
const transport: Transport = async (...args) => {
  calls++;
  return fetchImpl(...args);
};
const config = (id: string) => ({
  id,
  adapter: "greenhouse" as const,
  boardIdentifier: id,
  company: id,
  enabled: true,
  reviewedAt: "2026-01-01T00:00:00Z",
  reviewReference: "explicit reviewed source",
  permissionBasis: "fixture authorization",
  termsUrl: "https://example.com/terms",
  allowedHosts: ["boards-api.greenhouse.io"],
  attribution: "Source company",
  schedule: { enabled: false, intervalHours: 12 },
});
before(async () => {
  pool = createPool(process.env.DATABASE_URL!, schema);
  await migrate(pool, schema);
  service = new IntegrationService({
    pool,
    liveEnabled: false,
    jobsTransport: transport,
    jobsNow: () => new Date(clock),
  });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.get("X-Actor") === "anonymous")
      return res.status(401).json({ code: "UNAUTHENTICATED" });
    const role = req.get("X-Actor") === "viewer" ? "viewer" : "owner";
    res.locals.session = {
      id: actor,
      communityId: COMMUNITY_ID,
      role,
      roles: [role],
      capabilities: capabilitiesFor([role]),
      csrfToken: "fixture",
    };
    if (req.method !== "GET" && req.get("X-CSRF-Token") !== "fixture")
      return res.status(403).json({ code: "CSRF_DENIED" });
    next();
  });
  app.use(
    "/api",
    createIntegrationRouter({
      pool,
      origin: "http://127.0.0.1:4881",
      liveEnabled: false,
      jobsTransport: transport,
      jobsNow: () => new Date(clock),
    }),
  );
  api = request(app);
});
after(async () => {
  if (pool) {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});
const put = (id: string, c: any, version = 1) =>
  api
    .put(`/api/job-sources/${id}`)
    .set("X-CSRF-Token", "fixture")
    .send({ config: c, version });
const run = (id: string, key = randomUUID()) =>
  api
    .post(`/api/job-sources/${id}/run`)
    .set("X-CSRF-Token", "fixture")
    .set("Idempotency-Key", key)
    .send({});
test("discover, review/save, manual enqueue, actual worker persistence works with publication globally disabled", async () => {
  assert.equal(
    (
      await api
        .post("/api/job-sources/discover")
        .send({ careersUrl: "https://jobs.lever.co/acme" })
    ).status,
    403,
  );
  assert.equal(
    (
      await api
        .post("/api/job-sources/discover")
        .set("X-CSRF-Token", "fixture")
        .set("X-Actor", "viewer")
        .send({ careersUrl: "https://jobs.lever.co/acme" })
    ).status,
    403,
  );
  const discovery = await api
    .post("/api/job-sources/discover")
    .set("X-CSRF-Token", "fixture")
    .send({ careersUrl: "https://boards.greenhouse.io/acme", company: "Acme" });
  assert.equal(discovery.status, 200);
  assert.equal(discovery.body.config.enabled, false);
  const saved = await put("acme", config("acme"));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.config._runtime, undefined);
  const key = randomUUID(),
    one = await run("acme", key),
    again = await run("acme", key);
  assert.equal(one.status, 202);
  assert.equal(one.body.id, again.body.id);
  assert.equal(await service.tick(), true);
  const operation = (
    await pool.query("SELECT * FROM worker_outbox WHERE id=$1", [one.body.id])
  ).rows[0];
  assert.equal(operation.state, "complete", operation.last_code);
  const qualified = await api.get("/api/jobs/candidates");
  assert.equal(qualified.body.items.length, 0);
  const jobs = await api.get("/api/jobs/candidates?scope=ineligible");
  assert.equal(jobs.body.items.length, 1);
  assert.equal(jobs.body.items[0].payload.roleFamily, "devops");
  assert.equal(jobs.body.items[0].payload.eligibility, "unknown");
  assert.equal(
    jobs.body.items[0].payload.expiresAt,
    "2026-12-01T00:00:00.000Z",
  );
  const runs = await api.get("/api/jobs/runs");
  assert.equal(runs.body.items[0].summary.recordsFetched, 2);
  assert.equal(runs.body.items[0].summary.relevantRecords, 1);
  const status = await api.get("/api/jobs/status");
  assert.equal(status.body.collectionEnabled, true);
  assert.equal(status.body.publishingEnabled, false);
  assert.equal(status.body.processRunning, false);
  assert.equal(status.body.actionsRegistryLinked, false);
  assert.equal(status.body.lastSuccessfulFetchAt, clock.toISOString());
});
test("source canonical-board aliases deduplicate, revisions and review activation remain guarded", async () => {
  const duplicate = await put("alias", {
    ...config("alias"),
    boardIdentifier: "ACME",
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, "SOURCE_ALREADY_EXISTS");
  assert.equal(duplicate.body.existingSourceId, "acme");
  assert.equal((await put("acme", config("acme"), 99)).status, 409);
  assert.equal(
    (await put("unreviewed", { ...config("unreviewed"), reviewReference: "" }))
      .status,
    422,
  );
  const off = new JobsService({ pool, jobsEnabled: false });
  const before = calls;
  await assert.rejects(
    () => off.enqueueRun(COMMUNITY_ID, actor, "acme", randomUUID()),
    /COLLECTION_DISABLED/,
  );
  assert.equal(calls, before);
});
test("recurring local scheduling survives service recreation and two schedulers enqueue once", async () => {
  const scheduled = await put("scheduled", {
    ...config("scheduled"),
    schedule: { enabled: true, intervalHours: 12 },
  });
  assert.equal(scheduled.status, 200);
  const other = new JobsService({
    pool,
    jobsTransport: transport,
    jobsNow: () => new Date(clock),
  });
  const results = await Promise.all([
    service.jobs.scheduleDue(),
    other.scheduleDue(),
  ]);
  assert.equal(
    results.reduce((a, b) => a + b, 0),
    1,
  );
  assert.equal(await service.tick(), true);
  const first = calls;
  assert.equal(await other.scheduleDue(), 0);
  const next = new Date(clock.getTime() + 12 * 3600000);
  clock = next;
  assert.equal(await other.scheduleDue(), 1);
  assert.equal(await service.tick(), true);
  assert.equal(calls, first + 1);
  jobsWorkerState(pool, true);
  assert.equal((await other.status(COMMUNITY_ID)).processRunning, true);
  jobsWorkerState(pool, false);
  assert.equal((await other.status(COMMUNITY_ID)).processRunning, false);
});
test("disabled or revoked scheduled actor blocks before network", async () => {
  await put("revoked", {
    ...config("revoked"),
    schedule: { enabled: true, intervalHours: 1 },
  });
  await pool.query("UPDATE users SET active=false WHERE id=$1", [actor]);
  const before = calls;
  await service.jobs.scheduleDue();
  assert.equal(calls, before);
  await assert.rejects(
    () => service.jobs.run(COMMUNITY_ID, "revoked"),
    /ACTOR_REVOKED/,
  );
  assert.equal(calls, before);
  await pool.query("UPDATE users SET active=true WHERE id=$1", [actor]);
  const source = (await api.get("/api/job-sources")).body.items.find(
    (s: any) => s.id === "revoked",
  );
  await put("revoked", { ...source.config, enabled: false }, source.version);
  await assert.rejects(
    () => service.jobs.run(COMMUNITY_ID, "revoked", actor),
    /SOURCE_NOT_ENABLED/,
  );
  assert.equal(calls, before);
});
test("source mutex precedes network and changed config fences old responses", async () => {
  await put("concurrent", config("concurrent"));
  const original = fetchImpl;
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  fetchImpl = async (...args) => {
    entered();
    await gate;
    return original(...args);
  };
  const first = service.jobs.run(COMMUNITY_ID, "concurrent", actor);
  await enteredPromise;
  const before = calls;
  await assert.rejects(
    () => service.jobs.run(COMMUNITY_ID, "concurrent", actor),
    /RETRY_LATER/,
  );
  assert.equal(calls, before);
  await put("concurrent", { ...config("concurrent"), enabled: false }, 1);
  release();
  await assert.rejects(() => first, /SOURCE_CHANGED/);
  fetchImpl = original;
  assert.equal(
    (
      await pool.query(
        "SELECT id FROM job_records WHERE source_id='concurrent'",
      )
    ).rowCount,
    0,
  );
});
test("offline and malformed responses persist run outcome and preserve jobs; exclusions survive reappearance", async () => {
  const original = fetchImpl;
  const saved = (
    await pool.query("SELECT * FROM job_records WHERE source_id='acme'")
  ).rows[0];
  await pool.query(
    "UPDATE job_records SET payload=jsonb_set(payload,'{status}','\"excluded\"') WHERE id=$1",
    [saved.id],
  );
  fetchImpl = async () => {
    throw Error("offline fixture");
  };
  const failed = await service.jobs.run(COMMUNITY_ID, "acme", actor);
  assert.equal(failed.status, "failed");
  assert.equal(
    (
      await pool.query("SELECT payload FROM job_records WHERE id=$1", [
        saved.id,
      ])
    ).rows[0].payload.status,
    "excluded",
  );
  fetchImpl = original;
  await service.jobs.run(COMMUNITY_ID, "acme", actor);
  assert.equal(
    (
      await pool.query("SELECT payload FROM job_records WHERE id=$1", [
        saved.id,
      ])
    ).rows[0].payload.status,
    "excluded",
  );
});

test("more than one hundred not-due sources cannot starve a due source", async () => {
  for (let i = 0; i < 101; i++)
    await pool.query(
      "INSERT INTO job_sources(id,community_id,config) VALUES($1,$2,$3)",
      [
        `zz-bulk-${String(i).padStart(3, "0")}`,
        COMMUNITY_ID,
        {
          ...config(`zz-bulk-${i}`),
          schedule: { enabled: true, intervalHours: 12 },
          _runtime: {
            actorId: actor,
            nextDueAt:
              i === 100
                ? clock.toISOString()
                : new Date(clock.getTime() + 86400000).toISOString(),
          },
        },
      ],
    );
  assert.equal(await service.jobs.scheduleDue(), 1);
  assert.equal(
    (
      await pool.query(
        "SELECT id FROM worker_outbox WHERE kind='jobs' AND payload->>'sourceId'='zz-bulk-100'",
      )
    ).rowCount,
    1,
  );
  await pool.query(
    "UPDATE worker_outbox SET state='complete' WHERE kind='jobs' AND payload->>'sourceId' LIKE 'zz-bulk-%'",
  );
});
test("curator-confirmed close is versioned, audited and distinct from exclusion; reviewed expiry can be set", async () => {
  const item = (
    await pool.query("SELECT * FROM job_records WHERE source_id='acme'")
  ).rows[0];
  const r = await api
    .post(`/api/jobs/${encodeURIComponent(item.id)}/review`)
    .set("X-CSRF-Token", "fixture")
    .send({
      version: item.version,
      decision: "close",
      reason: "Employer confirmed the position is closed",
      expiresAt: "2026-11-01T00:00:00Z",
    });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.payload.status, "closed");
  assert.ok(r.body.payload.editorialClosure);
  await service.jobs.run(COMMUNITY_ID, "acme", actor);
  const after = (
    await pool.query("SELECT * FROM job_records WHERE id=$1", [item.id])
  ).rows[0];
  assert.equal(after.payload.status, "closed");
  assert.equal(
    after.payload.editorialClosure.reason,
    "Employer confirmed the position is closed",
  );
  assert.equal(after.payload.expiresAt, "2026-11-01T00:00:00Z");
  assert.ok(
    (
      await pool.query(
        "SELECT id FROM audit_events WHERE action='job_reviewed'",
      )
    ).rowCount! > 0,
  );
  const missing = await api
    .post(`/api/jobs/${encodeURIComponent(item.id)}/review`)
    .set("X-CSRF-Token", "fixture")
    .send({ version: after.version, decision: "close" });
  assert.equal(missing.status, 422);
  assert.equal(missing.body.code, "CLOSURE_REASON_REQUIRED");
});
test("rejected preflight and fenced attempts remain visible without overwriting job records", async () => {
  const runs = (
    await pool.query(
      "SELECT summary FROM job_runs WHERE source_id='concurrent' AND status='rejected'",
    )
  ).rows;
  assert.ok(runs.some((r) => r.summary.errorCode === "SOURCE_CHANGED"));
  const revoked = (
    await pool.query(
      "SELECT summary FROM job_runs WHERE source_id='revoked' AND status='rejected'",
    )
  ).rows;
  assert.ok(revoked.some((r) => r.summary.errorCode === "ACTOR_REVOKED"));
  assert.equal(
    (
      await pool.query(
        "SELECT id FROM job_records WHERE source_id='concurrent'",
      )
    ).rowCount,
    0,
  );
});

test("concurrent registrations cannot replace source identity or duplicate a board under different IDs", async () => {
  const first = await Promise.allSettled([
    service.jobs.save(COMMUNITY_ID, actor, "race-id", config("race-id")),
    service.jobs.save(COMMUNITY_ID, actor, "race-id", {
      ...config("race-id"),
      boardIdentifier: "other-race-board",
    }),
  ]);
  assert.equal(first.filter((r) => r.status === "fulfilled").length, 1);
  const second = await Promise.allSettled([
    service.jobs.save(COMMUNITY_ID, actor, "race-one", {
      ...config("race-one"),
      boardIdentifier: "shared-board",
    }),
    service.jobs.save(COMMUNITY_ID, actor, "race-two", {
      ...config("race-two"),
      boardIdentifier: "SHARED-BOARD",
    }),
  ]);
  assert.equal(second.filter((r) => r.status === "fulfilled").length, 1);
});
test("collector row locks prevent a committed curator decision from being overwritten", async () => {
  await put("review-race", config("review-race"));
  await service.jobs.run(COMMUNITY_ID, "review-race", actor);
  const item = (
    await pool.query("SELECT * FROM job_records WHERE source_id='review-race'")
  ).rows[0];
  let reached!: () => void, release!: () => void;
  const read = new Promise<void>((r) => (reached = r)),
    gate = new Promise<void>((r) => (release = r));
  const wrapped = new Proxy(pool, {
    get(target, key) {
      if (key === "connect")
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(c, k) {
              if (k === "query")
                return async (sql: any, ...args: any[]) => {
                  const result = await (c.query as any)(sql, ...args);
                  if (
                    typeof sql === "string" &&
                    sql.startsWith("SELECT payload FROM job_records")
                  ) {
                    reached();
                    await gate;
                  }
                  return result;
                };
              const value = (c as any)[k];
              return typeof value === "function" ? value.bind(c) : value;
            },
          });
        };
      const value = (target as any)[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const collector = new JobsService({
    pool: wrapped,
    jobsTransport: transport,
    jobsNow: () => new Date(clock),
  });
  const collecting = collector.run(COMMUNITY_ID, "review-race", actor);
  await read;
  let settled = false;
  const reviewing = api
    .post(`/api/jobs/${encodeURIComponent(item.id)}/review`)
    .set("X-CSRF-Token", "fixture")
    .send({
      version: item.version,
      decision: "close",
      reason: "Concurrent employer confirmation",
    })
    .then((r: any) => {
      settled = true;
      return r;
    });
  try {
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(settled, false, "Review must wait for collector row lock");
  } finally {
    release();
  }
  await collecting;
  const reviewed = await reviewing;
  assert.ok([200, 409].includes(reviewed.status));
  if (reviewed.status === 200) {
    const current = (
      await pool.query("SELECT payload FROM job_records WHERE id=$1", [item.id])
    ).rows[0];
    assert.equal(current.payload.status, "closed");
    assert.equal(
      current.payload.editorialClosure.reason,
      "Concurrent employer confirmation",
    );
  }
});
test("review decision and audit roll back together on audit failure", async () => {
  const item = (
    await pool.query("SELECT * FROM job_records WHERE source_id='review-race'")
  ).rows[0];
  await pool.query(
    `CREATE FUNCTION reject_job_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='job_reviewed' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$`,
  );
  await pool.query(
    "CREATE TRIGGER reject_job_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_job_audit()",
  );
  try {
    const r = await api
      .post(`/api/jobs/${encodeURIComponent(item.id)}/review`)
      .set("X-CSRF-Token", "fixture")
      .send({
        version: item.version,
        decision: "exclude",
        reason: "Must roll back",
      });
    assert.equal(r.status, 500);
    assert.deepEqual(
      (
        await pool.query(
          "SELECT payload,version FROM job_records WHERE id=$1",
          [item.id],
        )
      ).rows[0],
      { payload: item.payload, version: item.version },
    );
  } finally {
    await pool.query("DROP TRIGGER reject_job_audit ON audit_events");
    await pool.query("DROP FUNCTION reject_job_audit()");
  }
});
test("expired or source-closed jobs cannot be approved into active status", async () => {
  const base = (
    await pool.query("SELECT * FROM job_records WHERE source_id='review-race'")
  ).rows[0];
  for (const extra of [
    { expiresAt: "2020-01-01T00:00:00Z" },
    { sourceClosed: true },
  ]) {
    await pool.query("UPDATE job_records SET payload=$2 WHERE id=$1", [
      base.id,
      {
        ...base.payload,
        sourceUrl:
          "https://boards.greenhouse.io/fixture/jobs/approval-guard-unique",
        applyUrl:
          "https://boards.greenhouse.io/fixture/jobs/approval-guard-unique",
        status: "needs-review",
        approved: false,
        sourceClosed: false,
        editorialClosure: null,
        closureReason: null,
        expiresAt: null,
        ...extra,
        summary: { "es-pe": "Resumen revisado", en: "Reviewed summary" },
        eligibility: "peru",
        locations: ["Peru"],
        relevanceScore: 5,
      },
    ]);
    const r = await api
      .post(`/api/jobs/${encodeURIComponent(base.id)}/review`)
      .set("X-CSRF-Token", "fixture")
      .send({ version: base.version, decision: "approve" });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "JOB_NOT_ACTIVE");
  }
  await pool.query("UPDATE job_records SET payload=$2 WHERE id=$1", [
    base.id,
    {
      ...base.payload,
      sourceUrl:
        "https://boards.greenhouse.io/fixture/jobs/approval-guard-unique",
      applyUrl:
        "https://boards.greenhouse.io/fixture/jobs/approval-guard-unique",
      status: "needs-review",
      approved: false,
      sourceClosed: false,
      editorialClosure: null,
      closureReason: null,
      expiresAt: null,
      summary: { "es-pe": "Resumen revisado", en: "Reviewed summary" },
      eligibility: "peru",
      locations: ["Peru"],
      relevanceScore: 5,
    },
  ]);
  const valid = await api
    .post(`/api/jobs/${encodeURIComponent(base.id)}/review`)
    .set("X-CSRF-Token", "fixture")
    .send({ version: base.version, decision: "approve" });
  assert.equal(valid.status, 200, JSON.stringify(valid.body));
  assert.equal(valid.body.payload.status, "active");
});
test("actual app auth and CSRF can exercise test-only jobs transport; production override is rejected", async () => {
  const { createApp } = await import("../src/server/app");
  const origin = "http://127.0.0.1:4881";
  assert.throws(
    () =>
      createApp({
        pool,
        media: [],
        origin,
        environment: "production",
        jobsTest: { transport },
      }),
    /test-only/,
  );
  const actual = createApp({
      pool,
      media: [],
      origin,
      environment: "test",
      fixtureAuthEnabled: true,
      jobsTest: { transport, now: () => new Date(clock) },
    }),
    agent = request.agent(actual);
  assert.equal((await request(actual).get("/api/jobs/status")).status, 401);
  const login = await agent
    .post("/api/dev/login")
    .set("Origin", origin)
    .send({ persona: "owner" });
  assert.equal(login.status, 200);
  const csrf = login.body.csrfToken;
  assert.equal(
    (
      await agent
        .post("/api/job-sources/discover")
        .set("Origin", origin)
        .send({ careersUrl: "https://jobs.lever.co/acme" })
    ).status,
    403,
  );
  const discovery = await agent
    .post("/api/job-sources/discover")
    .set("Origin", origin)
    .set("X-CSRF-Token", csrf)
    .send({ careersUrl: "https://boards.greenhouse.io/actual-app" });
  assert.equal(discovery.status, 200);
  const saved = await agent
    .put("/api/job-sources/actual-app")
    .set("Origin", origin)
    .set("X-CSRF-Token", csrf)
    .send({ config: config("actual-app") });
  assert.equal(saved.status, 200);
  const queued = await agent
    .post("/api/job-sources/actual-app/run")
    .set("Origin", origin)
    .set("X-CSRF-Token", csrf)
    .set("Idempotency-Key", randomUUID())
    .send({});
  assert.equal(queued.status, 202);
  assert.equal(await service.tick(), true);
  assert.equal(
    (
      await pool.query(
        "SELECT payload FROM job_records WHERE source_id='actual-app'",
      )
    ).rowCount,
    1,
  );
});
