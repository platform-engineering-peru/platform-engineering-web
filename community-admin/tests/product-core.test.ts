import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import sharp from "sharp";
import { createPool, migrate } from "../src/server/db";
import { createApp } from "../src/server/app";
import { verifySeedMedia } from "../src/server/media";
import { entityDefinitions } from "../src/shared/product-contract";
import { validatePayload } from "../src/server/product-schema";
const schema = `test_product_${randomUUID().replaceAll("-", "")}`,
  origin = "http://127.0.0.1:4455";
let pool: ReturnType<typeof createPool>, app: ReturnType<typeof createApp>;
let editor: any, reviewer: any, owner: any, coordinator: any, viewer: any;
before(async () => {
  assert.ok(process.env.DATABASE_URL);
  pool = createPool(process.env.DATABASE_URL!, schema);
  await migrate(pool, schema);
  app = createApp({
    pool,
    media: await verifySeedMedia(),
    origin,
    fixtureAuthEnabled: true,
    environment: "test",
  });
  async function login(persona: string) {
    const agent = request.agent(app);
    const r = await agent
      .post("/api/dev/login")
      .set("Origin", origin)
      .send({ persona });
    assert.equal(r.status, 200);
    return { agent, csrf: r.body.csrfToken };
  }
  editor = await login("editor");
  reviewer = await login("reviewer");
  owner = await login("owner");
  coordinator = await login("coordinator");
  viewer = await login("viewer");
});
after(async () => {
  if (pool) {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});
const write = (
  u: any,
  path: string,
  body: any,
  revision?: number,
  method = "post",
) => {
  let r = u.agent[method](path)
    .set("Origin", origin)
    .set("X-CSRF-Token", u.csrf)
    .set("Idempotency-Key", randomUUID());
  if (revision) r = r.set("If-Match", `"${revision}"`);
  return r.send(body);
};
const base = (type: string) =>
  structuredClone(entityDefinitions.find((e) => e.type === type)!.defaults);
async function create(u: any, type: string, payload: any) {
  const r = await write(u, "/api/records", { type, payload });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
test("all public and private modules have strict form-backed runtime contracts", () => {
  assert.equal(entityDefinitions.length, 17);
  assert.ok(
    entityDefinitions.some((d) => d.type === "blog" && d.scope === "public"),
  );
  for (const d of entityDefinitions) {
    assert.ok(d.fields.length);
    assert.throws(() =>
      validatePayload(d.type, { ...d.defaults, password: "secret" }),
    );
  }
});
test("capabilities separate private CRM from public content and export", async () => {
  assert.equal(
    (await viewer.agent.get("/api/records?type=people")).status,
    403,
  );
  assert.equal(
    (
      await write(editor, "/api/records", {
        type: "people",
        payload: base("people"),
      })
    ).status,
    403,
  );
  assert.equal((await coordinator.agent.get("/api/people/export")).status, 403);
  const me = await owner.agent.get("/api/me");
  assert.ok(me.body.capabilities.includes("*"));
});
test("private records persist and never become public DTOs", async () => {
  const d = await create(coordinator, "people", {
    ...base("people"),
    name: "Synthetic person",
    email: "synthetic@example.invalid",
    notes: "PRIVATE_SENTINEL",
    provenance: "test",
    permissionBasis: "synthetic",
  });
  assert.equal(
    (await coordinator.agent.get(`/api/records/${d.id}`)).body.payload.notes,
    "PRIVATE_SENTINEL",
  );
  assert.equal(
    (await coordinator.agent.get(`/api/records/${d.id}/export`)).status,
    403,
  );
  assert.equal((await viewer.agent.get(`/api/records/${d.id}`)).status, 403);
});
test("generic public workflow preserves optimistic revisions and invalidates approval", async () => {
  const d = await create(editor, "resources", {
    ...base("resources"),
    slug: "test-resource",
    href: "https://example.org/guide",
    title: { "es-pe": "Guía", en: "Guide" },
    description: { "es-pe": "Prueba", en: "Test" },
  });
  const submit = await write(
    editor,
    `/api/records/${d.id}/submit`,
    {},
    d.revision,
  );
  assert.equal(submit.status, 200);
  const approve = await write(
    reviewer,
    `/api/records/${d.id}/review`,
    { decision: "approved", revisionHash: d.revisionHash, comment: "Reviewed" },
    d.revision,
  );
  assert.equal(approve.status, 200);
  const out = await reviewer.agent.get(`/api/records/${d.id}/export`);
  assert.equal(out.status, 200);
  assert.equal(out.body.href, "https://example.org/guide");
  assert.ok(!out.text.includes("authorId"));
  const edit = await write(
    editor,
    `/api/records/${d.id}`,
    { payload: { ...d.payload, title: { "es-pe": "Otra", en: "Other" } } },
    d.revision,
    "patch",
  );
  assert.equal(edit.status, 200);
  assert.equal(edit.body.approvedHash, null);
  assert.equal(
    (await reviewer.agent.get(`/api/records/${d.id}/export`)).status,
    409,
  );
  assert.equal(
    (
      await write(
        editor,
        `/api/records/${d.id}`,
        { payload: d.payload },
        d.revision,
        "patch",
      )
    ).status,
    409,
  );
});
test("memory upload decodes/reencodes bytes, strips metadata, keeps multiple ordered images private", async () => {
  const image = await sharp({
    create: { width: 400, height: 700, channels: 3, background: "#5b2eff" },
  })
    .jpeg()
    .withMetadata({ exif: { IFD0: { Copyright: "SYNTHETIC_PRIVATE" } } })
    .toBuffer();
  const r = await editor.agent
    .post("/api/media/uploads")
    .set("Origin", origin)
    .set("X-CSRF-Token", editor.csrf)
    .field("source", "synthetic test")
    .field("permissionBasis", "self-created fixture")
    .attach("file", image, { filename: "test.jpg", contentType: "image/jpeg" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const bytes = await editor.agent.get(`/api/media/${r.body.id}`);
  assert.equal(bytes.status, 200);
  const metadata = await sharp(bytes.body).metadata();
  assert.equal(metadata.width, 400);
  assert.equal(metadata.height, 700);
  assert.ok(!metadata.exif);
  assert.equal((await request(app).get(`/api/media/${r.body.id}`)).status, 401);
  const fake = await editor.agent
    .post("/api/media/uploads")
    .set("Origin", origin)
    .set("X-CSRF-Token", editor.csrf)
    .field("source", "test")
    .field("permissionBasis", "test")
    .attach("file", Buffer.from("<svg/>"), {
      filename: "evil.png",
      contentType: "image/png",
    });
  assert.equal(fake.status, 422);
});
test("sessions reject overlapping room or speaker assignments atomically", async () => {
  const person = await create(coordinator, "people", {
    ...base("people"),
    name: "Synthetic speaker",
  });
  const event = await create(editor, "events", {
    ...base("events"),
    slug: "test-event",
    title: { "es-pe": "Evento", en: "Event" },
    description: { "es-pe": "Prueba", en: "Test" },
    date: "2026-11-20",
  });
  const payload = {
    ...base("sessions"),
    eventId: event.id,
    speakerIds: [person.id],
    title: "First",
    room: "A",
    startsAt: "2026-11-20T14:00:00-05:00",
    endsAt: "2026-11-20T15:00:00-05:00",
  };
  await create(coordinator, "sessions", payload);
  assert.equal(
    (
      await write(coordinator, "/api/records", {
        type: "sessions",
        payload: { ...payload, title: "Overlap", room: "B" },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await write(coordinator, "/api/records", {
        type: "sessions",
        payload: { ...payload, title: "Room overlap", speakerIds: [] },
      })
    ).status,
    409,
  );
});
test("CSV dry run deduplicates and export neutralizes formulas with explicit permission", async () => {
  const csv =
    "name,email,provenance,permissionBasis\n=FORMULA,formula@example.invalid,synthetic,test\n=FORMULA,formula@example.invalid,synthetic,test\n";
  const preview = await write(owner, "/api/people/import", {
    csv,
    dryRun: true,
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.duplicates.length, 1);
  const imported = await write(owner, "/api/people/import", {
    csv,
    dryRun: false,
  });
  assert.equal(imported.status, 200);
  const out = await owner.agent
    .get("/api/people/export")
    .set("X-CSRF-Token", owner.csrf)
    .query({ reason: "Synthetic test" });
  assert.equal(out.status, 200);
  assert.ok(out.text.includes("'=FORMULA"));
});
test("unconfigured OAuth reports unavailable and owner invitations use GitHub subject IDs only", async () => {
  assert.equal((await request(app).get("/api/auth/github/start")).status, 503);
  assert.equal(
    (
      await write(editor, "/api/invitations", {
        providerSubject: "12345",
        roles: ["owner"],
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await write(owner, "/api/invitations", {
        providerSubject: "12345",
        roles: ["editor"],
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await write(owner, "/api/invitations", {
        providerSubject: "someone@example.org",
        roles: ["owner"],
      })
    ).status,
    422,
  );
});

test("settings channels reject active schemes and private endpoints; viewer cannot build or open private previews", async () => {
  const defaults = base("settings");
  defaults.globalLinks = Object.fromEntries(
    Object.keys(defaults.globalLinks as Record<string, unknown>).map((k) => [
      k,
      "https://example.org/" + k,
    ]),
  );
  defaults.contactEmail = "public@example.org";
  for (const href of [
    "javascript:alert(1)",
    "data:text/html,<script>",
    "https://127.0.0.1/a",
    "https://localhost/a",
    "https://foo.internal/a",
  ]) {
    assert.throws(
      () =>
        validatePayload("settings", {
          ...defaults,
          communityLinks: {
            ...(defaults.communityLinks as Record<string, unknown>),
            linkedin: href,
          },
        }),
      href,
    );
  }
  const d = await create(editor, "resources", {
    ...base("resources"),
    slug: "preview-policy",
    displayOrder: 500,
    href: "https://example.org/preview",
    title: { "es-pe": "Prueba", en: "Test" },
    description: { "es-pe": "Prueba", en: "Test" },
  });
  assert.equal(
    (await write(viewer, `/api/records/${d.id}/preview`, {})).status,
    403,
  );
  assert.equal(
    (await viewer.agent.get(`/api/previews/${randomUUID()}/es-pe/`)).status,
    403,
  );
});
test("record create retries are idempotent and changed payload reuse fails", async () => {
  const key = randomUUID(),
    payload = {
      ...base("organizations"),
      name: "Idempotent synthetic organization",
    };
  const send = (value: any) =>
    owner.agent
      .post("/api/records")
      .set("Origin", origin)
      .set("X-CSRF-Token", owner.csrf)
      .set("Idempotency-Key", key)
      .send({ type: "organizations", payload: value });
  const first = await send(payload),
    again = await send(payload);
  assert.equal(first.status, 201);
  assert.equal(again.body.id, first.body.id);
  assert.equal((await send({ ...payload, name: "Changed" })).status, 409);
});

test("sensitive membership and contact exports require recent authentication; invitation revocation is audited", async () => {
  const invited = await write(owner, "/api/invitations", {
    providerSubject: "912345678",
    roles: ["viewer"],
  });
  assert.equal(invited.status, 201);
  const revoked = await write(
    owner,
    `/api/invitations/${invited.body.id}/revoke`,
    {},
  );
  assert.equal(revoked.status, 200);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND action='invitation_revoked'",
        [invited.body.id],
      )
    ).rows[0].n,
    1,
  );
  const me = (await owner.agent.get("/api/me")).body;
  await pool.query(
    "UPDATE sessions SET created_at=now()-interval '16 minutes' WHERE user_id=$1",
    [me.id],
  );
  try {
    const denied = await write(owner, "/api/people/exports", {
      reason: "Synthetic privacy check",
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, "REAUTHENTICATION_REQUIRED");
    const invitation = await write(owner, "/api/invitations", {
      providerSubject: "912345679",
      roles: ["editor"],
    });
    assert.equal(invitation.status, 403);
    assert.equal(invitation.body.code, "REAUTHENTICATION_REQUIRED");
  } finally {
    await pool.query("UPDATE sessions SET created_at=now() WHERE user_id=$1", [
      me.id,
    ]);
  }
});
