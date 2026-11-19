import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createPool, migrate } from "../src/server/db";
import { createApp } from "../src/server/app";
import { localTimeFor } from "../src/server/integrations/schedule";
const schema = `test_${randomUUID().replaceAll("-", "")}`,
  origin = "http://127.0.0.1:4455";
let pool: ReturnType<typeof createPool>, app: ReturnType<typeof createApp>;
before(async () => {
  pool = createPool(process.env.DATABASE_URL!, schema);
  await migrate(pool, schema);
  const previousKey = process.env.CONNECTOR_ENCRYPTION_KEY;
  process.env.CONNECTOR_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  app = createApp({
    pool,
    media: [],
    origin,
    fixtureAuthEnabled: true,
    environment: "test",
  });
  if (previousKey === undefined) delete process.env.CONNECTOR_ENCRYPTION_KEY;
  else process.env.CONNECTOR_ENCRYPTION_KEY = previousKey;
});
after(async () => {
  await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await pool.end();
});
async function login(persona: string) {
  const agent = request.agent(app),
    response = await agent
      .post("/api/dev/login")
      .set("Origin", origin)
      .send({ persona });
  assert.equal(response.status, 200);
  return {
    agent,
    headers: {
      Origin: origin,
      "X-CSRF-Token": response.body.csrfToken,
      "Idempotency-Key": randomUUID(),
    },
  };
}
test("independent reviewer can inspect and approve scheduled publication; changed schedule refused", async () => {
  const owner = await login("owner"),
    reviewer = await login("reviewer"),
    created = await owner.agent
      .post("/api/publications")
      .set(owner.headers)
      .send({
        channel: "manual",
        destination: "manual",
        payload: { text: "Approved synthetic copy" },
      });
  assert.equal(created.status, 201);
  const at = new Date().toISOString(),
    local = localTimeFor(new Date(at), "America/Lima").slice(0, 16),
    saved = await owner.agent
      .patch(`/api/publications/${created.body.id}`)
      .set(owner.headers)
      .send({
        version: created.body.version,
        payload: created.body.payload,
        scheduledAt: at,
        timezone: "America/Lima",
        localTime: local,
      });
  assert.equal(saved.status, 200);
  const detail = await reviewer.agent.get(
    `/api/publications/${created.body.id}`,
  );
  assert.equal(detail.status, 200);
  assert.equal("upload_state" in detail.body, false);
  const approved = await reviewer.agent
    .post(`/api/publications/${created.body.id}/approve`)
    .set(reviewer.headers)
    .send({ revisionHash: saved.body.revision_hash });
  assert.equal(approved.status, 200);
  const path = `/api/publications/${created.body.id}/schedule`;
  const changed = await owner.agent
    .post(path)
    .set({ ...owner.headers, "Idempotency-Key": randomUUID() })
    .send({
      revisionHash: saved.body.revision_hash,
      scheduledAt: new Date(Date.now() + 60000).toISOString(),
      timezone: "America/Lima",
      localTime: local,
    });
  assert.equal(changed.status, 422);
  assert.equal(changed.body.code, "SCHEDULE_ZONE_MISMATCH");
  const value = {
      revisionHash: saved.body.revision_hash,
      scheduledAt: at,
      timezone: "America/Lima",
      localTime: local,
    },
    a = await owner.agent
      .post(path)
      .set({ ...owner.headers, "Idempotency-Key": randomUUID() })
      .send(value),
    b = await owner.agent
      .post(path)
      .set({ ...owner.headers, "Idempotency-Key": randomUUID() })
      .send(value);
  assert.equal(a.status, 202);
  assert.equal(b.body.id, a.body.id);
  const cancel = await owner.agent
    .post(`/api/publications/${created.body.id}/cancel`)
    .set(owner.headers)
    .send({
      version: saved.body.version,
      revisionHash: saved.body.revision_hash,
      reason: "Cancel synthetic publication",
    });
  assert.equal(cancel.status, 200);
});
test("publication creation replay is idempotent and viewers cannot mutate", async () => {
  const owner = await login("owner"),
    payload = {
      channel: "manual",
      destination: "manual",
      payload: { text: "Idempotent" },
    },
    a = await owner.agent
      .post("/api/publications")
      .set(owner.headers)
      .send(payload),
    b = await owner.agent
      .post("/api/publications")
      .set(owner.headers)
      .send(payload);
  assert.equal(a.status, 201);
  assert.equal(a.body.id, b.body.id);
  const viewer = await login("viewer");
  assert.equal(
    (
      await viewer.agent
        .post("/api/publications")
        .set(viewer.headers)
        .send(payload)
    ).status,
    403,
  );
});
test("integrations never expose encrypted credentials and default network actions fail closed", async () => {
  const owner = await login("owner");
  const list = await owner.agent.get("/api/integrations");
  assert.equal(list.status, 200);
  assert.equal(list.body.liveEnabled, false);
  assert.equal(
    (
      await owner.agent
        .post("/api/integrations/linkedin/oauth/start")
        .set(owner.headers)
        .send({ destination: "urn:li:organization:1" })
    ).status,
    503,
  );
  assert.equal(
    (await request(app).post("/api/webhooks/github").send({})).status,
    403,
  );
});

test("sensitive integration changes require recent authentication and audit outcomes", async () => {
  const owner = await login("owner");
  const input = {
    provider: "linkedin",
    destination: "urn:li:organization:synthetic-auth",
    scopes: ["w_organization_social"],
    secret: { accessToken: "synthetic-never-sent" },
    config: { apiVersion: "202610" },
  };
  const connected = await owner.agent
    .post("/api/integrations")
    .set(owner.headers)
    .send(input);
  assert.equal(connected.status, 201);
  const me = await owner.agent.get("/api/me");
  await pool.query(
    "UPDATE sessions SET created_at=now()-interval '16 minutes' WHERE user_id=$1",
    [me.body.id],
  );
  for (const [path, body] of [
    ["/api/integrations", input],
    [`/api/integrations/${connected.body.id}/disconnect`, {}],
    [
      "/api/integrations/linkedin/oauth/start",
      { destination: input.destination },
    ],
    [
      "/api/integrations/youtube/oauth/start",
      { destination: "synthetic-channel" },
    ],
  ] as const) {
    const denied = await owner.agent.post(path).set(owner.headers).send(body);
    assert.equal(denied.status, 403, path);
    assert.equal(denied.body.code, "REAUTHENTICATION_REQUIRED", path);
  }
  const fresh = await login("owner");
  const reassigned = await fresh.agent
    .post("/api/integrations")
    .set(fresh.headers)
    .send(input);
  assert.equal(reassigned.status, 201);
  assert.equal(reassigned.body.id, connected.body.id);
  const disconnected = await fresh.agent
    .post(`/api/integrations/${connected.body.id}/disconnect`)
    .set(fresh.headers)
    .send({});
  assert.equal(disconnected.status, 200);
  const audits = (
    await pool.query(
      "SELECT action,details FROM audit_events WHERE action LIKE 'integration_%' OR action LIKE 'oauth_%'",
    )
  ).rows;
  assert.ok(audits.some((r) => r.action === "integration_connected"));
  assert.ok(audits.some((r) => r.action === "integration_disconnected"));
  assert.ok(
    audits.filter((r) => r.details?.code === "REAUTHENTICATION_REQUIRED")
      .length >= 4,
  );
  assert.equal(JSON.stringify(audits).includes("synthetic-never-sent"), false);
});
