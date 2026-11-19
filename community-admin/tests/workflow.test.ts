import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import request, { type Agent } from "supertest";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import schema from "../contracts/memory-v1.schema.json";
import { createApp } from "../src/server/app";
import { createPool, migrate } from "../src/server/db";
import { verifySeedMedia } from "../src/server/media";
import { hashRevision } from "../src/shared/content";

const origin = "http://127.0.0.1:4455";
const schemaName = `test_${randomUUID().replaceAll("-", "")}`;
let pool: ReturnType<typeof createPool>, app: ReturnType<typeof createApp>;
let editor: Agent, reviewer: Agent, viewer: Agent;
let editorCsrf: string, reviewerCsrf: string, viewerCsrf: string;
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const publicSchema = ajv.compile(schema);
before(async () => {
  assert.ok(
    process.env.DATABASE_URL,
    "Set DATABASE_URL to the isolated local PostgreSQL instance before tests.",
  );
  pool = createPool(process.env.DATABASE_URL!, schemaName);
  await migrate(pool, schemaName);
  const media = await verifySeedMedia();
  app = createApp({
    pool,
    media,
    origin,
    fixtureAuthEnabled: true,
    environment: "test",
  });
  const login = async (role: string) => {
    const agent = request.agent(app);
    const r = await agent
      .post("/api/dev/login")
      .set("Origin", origin)
      .send({ persona: role });
    assert.equal(r.status, 200);
    return { agent, csrf: r.body.csrfToken };
  };
  ({ agent: editor, csrf: editorCsrf } = await login("editor"));
  ({ agent: reviewer, csrf: reviewerCsrf } = await login("reviewer"));
  ({ agent: viewer, csrf: viewerCsrf } = await login("viewer"));
});
after(async () => {
  if (pool) {
    await pool.query(`DROP SCHEMA "${schemaName}" CASCADE`);
    await pool.end();
  }
});
const write = (
  agent: Agent,
  method: "post" | "patch",
  path: string,
  csrf: string,
  revision?: number,
) => {
  const r = agent[method](path).set("Origin", origin).set("X-CSRF-Token", csrf);
  return revision === undefined ? r : r.set("If-Match", `"${revision}"`);
};
async function draft() {
  const r = await write(editor, "post", "/api/drafts", editorCsrf).send({});
  assert.equal(r.status, 201);
  return r.body;
}
function completed(d: any) {
  return {
    ...d.payload,
    title: { "es-pe": "Encuentro sintético", en: "Synthetic gathering" },
    description: {
      "es-pe": "Contenido de prueba, sin personas reales.",
      en: "Fixture content with no real people.",
    },
    media: d.payload.media.map((m: any) => ({
      ...m,
      alt: {
        "es-pe": "Formas geométricas de prueba.",
        en: "Synthetic geometric shapes.",
      },
    })),
  };
}
async function ready() {
  let d = await draft();
  let r = await write(
    editor,
    "patch",
    `/api/drafts/${d.id}`,
    editorCsrf,
    d.revision,
  ).send({ payload: completed(d) });
  assert.equal(r.status, 200);
  d = r.body;
  r = await write(
    editor,
    "post",
    `/api/drafts/${d.id}/submit`,
    editorCsrf,
    d.revision,
  ).send({});
  assert.equal(r.status, 200);
  return r.body;
}
async function approve(d: any) {
  return write(
    reviewer,
    "post",
    `/api/drafts/${d.id}/review`,
    reviewerCsrf,
    d.revision,
  ).send({
    decision: "approved",
    revisionHash: d.revisionHash,
    comment: "Revisión sintética.",
  });
}

test("fixture login is disabled by default and always disabled in production", async () => {
  const media = await verifySeedMedia();
  for (const config of [
    {},
    { fixtureAuthEnabled: true, environment: "production" },
  ]) {
    const closed = createApp({ pool, media, origin, ...config });
    const r = await request(closed)
      .post("/api/dev/login")
      .set("Origin", origin)
      .send({ persona: "editor" });
    assert.equal(r.status, 404);
  }
  const login = await request(app)
    .post("/api/dev/login")
    .set("Origin", origin)
    .send({ persona: "editor" });
  const closed = createApp({ pool, media, origin });
  assert.equal(
    (
      await request(closed)
        .get("/api/me")
        .set("Cookie", login.headers["set-cookie"])
    ).status,
    401,
  );
  assert.match(login.headers["set-cookie"][0], /HttpOnly/);
  assert.match(login.headers["set-cookie"][0], /SameSite=Strict/);
});
test("unauthenticated access and untrusted origins fail closed", async () => {
  assert.equal((await request(app).get("/api/drafts")).status, 401);
  assert.equal(
    (
      await request(app)
        .post("/api/dev/login")
        .set("Origin", "https://attacker.example")
        .send({ persona: "editor" })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(app)
        .post("/api/dev/login")
        .set("Origin", origin)
        .send({ persona: "unknown-persona" })
    ).status,
    422,
  );
  assert.equal(
    (
      await editor
        .post("/api/drafts")
        .set("Origin", "https://attacker.example")
        .send({})
    ).status,
    403,
  );
  assert.equal(
    (await editor.post("/api/drafts").set("Origin", origin).send({})).status,
    403,
  );
});
test("roles are enforced on the API independently of the UI", async () => {
  assert.equal(
    (await write(viewer, "post", "/api/drafts", viewerCsrf).send({})).status,
    403,
  );
  assert.equal(
    (await write(reviewer, "post", "/api/drafts", reviewerCsrf).send({}))
      .status,
    403,
  );
  const d = await ready();
  assert.equal(
    (
      await write(
        editor,
        "post",
        `/api/drafts/${d.id}/review`,
        editorCsrf,
        d.revision,
      ).send({
        decision: "approved",
        revisionHash: d.revisionHash,
        comment: "",
      })
    ).status,
    403,
  );
});
test("drafts persist and update with mandatory optimistic preconditions", async () => {
  const d = await draft();
  assert.equal((await editor.get(`/api/drafts/${d.id}`)).body.id, d.id);
  assert.equal(
    (
      await write(editor, "patch", `/api/drafts/${d.id}`, editorCsrf).send({
        payload: completed(d),
      })
    ).status,
    428,
  );
  const r = await write(
    editor,
    "patch",
    `/api/drafts/${d.id}`,
    editorCsrf,
    d.revision,
  ).send({ payload: completed(d) });
  assert.equal(r.status, 200);
  assert.equal(r.body.revision, d.revision + 1);
  const stale = await write(
    editor,
    "patch",
    `/api/drafts/${d.id}`,
    editorCsrf,
    d.revision,
  ).send({ payload: { ...completed(d), slug: "stale-overwrite" } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "REVISION_CONFLICT");
  assert.equal(
    (await editor.get(`/api/drafts/${d.id}`)).body.payload.slug,
    d.payload.slug,
  );
  const row = await pool.query("SELECT revision FROM drafts WHERE id=$1", [
    d.id,
  ]);
  assert.equal(row.rows[0].revision, 2);
});
test("concurrent writes have exactly one winner", async () => {
  const d = await draft();
  const results = await Promise.all(
    [1, 2].map((i) =>
      write(
        editor,
        "patch",
        `/api/drafts/${d.id}`,
        editorCsrf,
        d.revision,
      ).send({
        payload: {
          ...completed(d),
          title: { "es-pe": `Versión ${i}`, en: `Version ${i}` },
        },
      }),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
});
test("incomplete bilingual drafts save but cannot be submitted", async () => {
  const d = await draft();
  const r = await write(
    editor,
    "post",
    `/api/drafts/${d.id}/submit`,
    editorCsrf,
    d.revision,
  ).send({});
  assert.equal(r.status, 422);
  assert.ok(r.body.fieldErrors.some((e: any) => e.path.includes("title")));
});
test("unknown/private fields and unverified media cannot cross the draft boundary", async () => {
  const d = await draft();
  for (const payload of [
    { ...completed(d), email: "private@example.org" },
    {
      ...completed(d),
      media: [{ ...d.payload.media[0], assetId: randomUUID() }],
    },
    { ...completed(d), media: [{ ...d.payload.media[0], fit: "cover" }] },
  ]) {
    const r = await write(
      editor,
      "patch",
      `/api/drafts/${d.id}`,
      editorCsrf,
      d.revision,
    ).send({ payload });
    assert.equal(r.status, 422);
  }
});
test("review requires a submitted revision and an exact matching hash", async () => {
  const d = await draft();
  assert.equal((await approve(d)).status, 409);
  const submitted = await ready();
  assert.equal(
    (
      await write(
        reviewer,
        "post",
        `/api/drafts/${submitted.id}/review`,
        reviewerCsrf,
        submitted.revision,
      ).send({
        decision: "approved",
        revisionHash: "0".repeat(64),
        comment: "",
      })
    ).status,
    409,
  );
  const approved = await approve(submitted);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.state, "approved");
  assert.equal((await approve(submitted)).status, 409);
});
test("editing after approval invalidates that approval and blocks export", async () => {
  const d = await ready();
  assert.equal((await approve(d)).status, 200);
  const r = await write(
    editor,
    "patch",
    `/api/drafts/${d.id}`,
    editorCsrf,
    d.revision,
  ).send({
    payload: {
      ...d.payload,
      title: { "es-pe": "Revisado de nuevo", en: "Edited again" },
    },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.state, "draft");
  assert.equal(r.body.approvedHash, null);
  assert.equal((await reviewer.get(`/api/drafts/${d.id}/export`)).status, 409);
  const audit = await reviewer.get(`/api/drafts/${d.id}/audit`);
  assert.ok(audit.body.some((e: any) => e.action === "approval_invalidated"));
});
test("change requests preserve the draft and require a new submission", async () => {
  const d = await ready();
  const r = await write(
    reviewer,
    "post",
    `/api/drafts/${d.id}/review`,
    reviewerCsrf,
    d.revision,
  ).send({
    decision: "changes_requested",
    revisionHash: d.revisionHash,
    comment: "Completar el texto alternativo.",
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.state, "changes_requested");
  assert.equal((await reviewer.get(`/api/drafts/${d.id}/export`)).status, 409);
});
test("approved export is deterministic, schema-valid, and contains public fields only", async () => {
  const d = await ready();
  assert.equal((await approve(d)).status, 200);
  const a = await reviewer.get(`/api/drafts/${d.id}/export`),
    b = await reviewer.get(`/api/drafts/${d.id}/export`);
  assert.equal(a.status, 200);
  assert.equal(a.text, b.text);
  assert.equal(publicSchema(a.body), true, JSON.stringify(publicSchema.errors));
  assert.match(a.headers["content-disposition"], new RegExp(d.id));
  for (const privateKey of [
    "authorId",
    "reviewerId",
    "revisionHash",
    "approvedHash",
    "internalNotes",
    "email",
    "csrfToken",
  ])
    assert.ok(!a.text.includes(privateKey));
  assert.equal(a.body.media[0].fit, "contain");
  assert.equal(a.body.media[0].credit, null);
  assert.ok(a.body.updatedAt);
  assert.equal(a.body.capturedAt, null);
  const row = await pool.query(
    "SELECT payload,updated_at FROM draft_revisions WHERE draft_id=$1 AND revision=$2",
    [d.id, d.revision],
  );
  assert.deepEqual(row.rows[0].payload, d.payload);
});
test("export is denied before approval and for viewer role", async () => {
  const d = await ready();
  assert.equal((await reviewer.get(`/api/drafts/${d.id}/export`)).status, 409);
  assert.equal((await viewer.get(`/api/drafts/${d.id}/export`)).status, 403);
});
test("revision hashing is canonical and stable across key ordering", () => {
  assert.equal(hashRevision({ b: 2, a: 1 }), hashRevision({ a: 1, b: 2 }));
  assert.notEqual(hashRevision({ a: 1 }), hashRevision({ a: 2 }));
});
test("media inventory decodes image bytes, verifies dimensions and matches content hashes", async () => {
  const media = await verifySeedMedia();
  assert.ok(media.length >= 2);
  for (const m of media) {
    const bytes = await readFile(
      new URL(`../public/${m.path}`, import.meta.url),
    );
    assert.equal(createHash("sha256").update(bytes).digest("hex"), m.sha256);
    assert.ok(m.width > 0 && m.height > 0);
  }
  assert.equal(
    (
      await editor
        .post("/api/media/upload")
        .set("Origin", origin)
        .set("X-CSRF-Token", editorCsrf)
        .send({})
    ).status,
    404,
  );
});
test("audit and revision snapshots reject UPDATE/DELETE attempts", async () => {
  const d = await draft();
  await assert.rejects(
    pool.query("DELETE FROM audit_events WHERE entity_id=$1", [d.id]),
    /immutable/,
  );
  await assert.rejects(
    pool.query("UPDATE draft_revisions SET revision=9 WHERE draft_id=$1", [
      d.id,
    ]),
    /immutable/,
  );
});
test("deactivated users lose access and logout revokes the session", async () => {
  const inactive = request.agent(app);
  await inactive
    .post("/api/dev/login")
    .set("Origin", origin)
    .send({ persona: "viewer" });
  await pool.query(
    "UPDATE fixture_users SET active=false WHERE persona='viewer'",
  );
  try {
    assert.equal((await inactive.get("/api/me")).status, 401);
  } finally {
    await pool.query(
      "UPDATE fixture_users SET active=true WHERE persona='viewer'",
    );
  }
  const agent = request.agent(app);
  const l = await agent
    .post("/api/dev/login")
    .set("Origin", origin)
    .send({ persona: "viewer" });
  const out = await write(agent, "post", "/api/logout", l.body.csrfToken).send(
    {},
  );
  assert.equal(out.status, 204);
  assert.equal((await agent.get("/api/me")).status, 401);
});

test("migrations are repeatable and public slugs cannot collide", async () => {
  await migrate(pool, schemaName);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS count FROM fixture_users"))
      .rows[0].count,
    7,
  );
  const first = await draft(),
    second = await draft();
  const r = await write(
    editor,
    "patch",
    `/api/drafts/${second.id}`,
    editorCsrf,
    second.revision,
  ).send({ payload: { ...completed(second), slug: first.payload.slug } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "DUPLICATE_CONTENT");
  assert.equal((await editor.get(`/api/drafts/${second.id}`)).body.revision, 1);
});
test("community boundaries are checked on every read", async () => {
  const d = await draft();
  await pool.query(
    "UPDATE fixture_users SET community_id=$1 WHERE persona='viewer'",
    [randomUUID()],
  );
  try {
    assert.equal((await viewer.get(`/api/drafts/${d.id}`)).status, 404);
    assert.equal((await viewer.get("/api/drafts")).body.items.length, 0);
    assert.equal((await viewer.get(`/api/drafts/${d.id}/audit`)).status, 404);
  } finally {
    await pool.query(
      "UPDATE fixture_users SET community_id=$1 WHERE persona='viewer'",
      ["00000000-0000-4000-8000-000000000001"],
    );
  }
});

test("corrupt or dimension-mismatched seed bytes fail media verification", async () => {
  await assert.rejects(
    verifySeedMedia(async () => Buffer.from("not an image")),
  );
  const { default: sharp } = await import("sharp");
  const validButWrong = await sharp({
    create: { width: 1, height: 1, channels: 4, background: "#5b2eff" },
  })
    .png()
    .toBuffer();
  await assert.rejects(
    verifySeedMedia(async () => validButWrong),
    /verification failed/,
  );
});

test("an approved ordering collision rolls back the review atomically", async () => {
  const first = await ready();
  assert.equal((await approve(first)).status, 200);
  const second = await draft();
  const saved = await write(
    editor,
    "patch",
    `/api/drafts/${second.id}`,
    editorCsrf,
    second.revision,
  ).send({
    payload: { ...completed(second), displayOrder: first.payload.displayOrder },
  });
  assert.equal(saved.status, 200);
  const submitted = await write(
    editor,
    "post",
    `/api/drafts/${second.id}/submit`,
    editorCsrf,
    saved.body.revision,
  ).send({});
  assert.equal(submitted.status, 200);
  const collision = await approve(submitted.body);
  assert.equal(collision.status, 409);
  assert.equal(collision.body.code, "DUPLICATE_CONTENT");
  assert.equal(
    (await editor.get(`/api/drafts/${second.id}`)).body.state,
    "submitted",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM reviews WHERE draft_id=$1",
        [second.id],
      )
    ).rows[0].count,
    0,
  );
});
