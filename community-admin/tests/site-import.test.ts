import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createPool, migrate } from "../src/server/db";
import { createApp } from "../src/server/app";
import { verifySeedMedia } from "../src/server/media";
const name = `test_site_${randomUUID().replaceAll("-", "")}`,
  origin = "http://127.0.0.1:4455";
let pool: ReturnType<typeof createPool>,
  app: ReturnType<typeof createApp>,
  owner: any,
  reviewer: any;
before(async () => {
  pool = createPool(process.env.DATABASE_URL!, name);
  await migrate(pool, name);
  app = createApp({
    pool,
    media: await verifySeedMedia(),
    origin,
    fixtureAuthEnabled: true,
    environment: "test",
  });
  async function login(role: string) {
    const agent = request.agent(app),
      r = await agent
        .post("/api/dev/login")
        .set("Origin", origin)
        .send({ persona: role });
    assert.equal(r.status, 200);
    return { agent, csrf: r.body.csrfToken };
  }
  owner = await login("owner");
  reviewer = await login("reviewer");
});
after(async () => {
  await pool.query(`DROP SCHEMA "${name}" CASCADE`);
  await pool.end();
});
const write = (u: any, path: string, body: any, rev?: number) => {
  const r = u.agent
    .post(path)
    .set("Origin", origin)
    .set("X-CSRF-Token", u.csrf)
    .set("Idempotency-Key", randomUUID());
  return (rev ? r.set("If-Match", `"${rev}"`) : r).send(body);
};
test("trusted website dry run reports stable identity maps then repeat import preserves drafts", async () => {
  const dry = await write(owner, "/api/import/site", { dryRun: true });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.counts.memories, 5);
  assert.equal(dry.body.counts.organizers, 3);
  assert.equal(dry.body.counts.resources + dry.body.counts.courses, 12);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM records")).rows[0].n,
    0,
  );
  const imported = await write(owner, "/api/import/site", { dryRun: false });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.ok(imported.body.imported >= 40);
  const again = await write(owner, "/api/import/site", { dryRun: false });
  assert.equal(again.body.imported, 0);
  assert.equal(again.body.unchanged, imported.body.imported);
  const organizers = (
    await owner.agent.get("/api/records?type=organizers")
  ).body.items.sort(
    (a: any, b: any) => a.payload.displayOrder - b.payload.displayOrder,
  );
  assert.deepEqual(
    organizers.map((r: any) => r.payload.name),
    ["Josua Castro", "Oscar Lobaton Salas", "Ronald Requena"],
  );
  const assets = (await owner.agent.get("/api/media")).body;
  assert.ok(
    assets
      .find((a: any) => a.id === organizers[1].payload.figurineAssetId)
      .path.endsWith("oscar-coffee.webp"),
  );
});
test("authenticated preview actually builds the unchanged website renderer with a draft overlay", async () => {
  const memories = (await owner.agent.get("/api/records?type=memories")).body
    .items;
  const memory = memories[0];
  const preview = await write(owner, `/api/records/${memory.id}/preview`, {});
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.renderer, "Astro website build");
  const html = await owner.agent.get(preview.body.url);
  assert.equal(html.status, 200);
  assert.ok(html.text.includes("data-memory-stage"));
  assert.ok(html.text.includes(memory.payload.title["es-pe"]));
  assert.equal((await request(app).get(preview.body.url)).status, 401);
});
test("public projection from private speaker profile excludes all CRM-only values", async () => {
  const defs = (await owner.agent.get("/api/catalog")).body.entities;
  const person = (
    await write(owner, "/api/records", {
      type: "people",
      payload: {
        ...defs.find((d: any) => d.type === "people").defaults,
        name: "Synthetic approved speaker",
        email: "private@example.invalid",
        notes: "PRIVATE_NOTES",
        provenance: "synthetic",
        permissionBasis: "test",
      },
    })
  ).body;
  const profile = (
    await write(owner, "/api/records", {
      type: "speaker-profiles",
      payload: {
        ...defs.find((d: any) => d.type === "speaker-profiles").defaults,
        personId: person.id,
        publicBio: { "es-pe": "Biografía autorizada", en: "Approved bio" },
        availability: "PRIVATE_AVAILABILITY",
        compensation: "PRIVATE_COMPENSATION",
        publicConsent: true,
        consentEvidence: "Synthetic explicit approval",
      },
    })
  ).body;
  const projection = await write(
    owner,
    `/api/speaker-profiles/${profile.id}/public-projection`,
    {},
  );
  assert.equal(projection.status, 201, JSON.stringify(projection.body));
  assert.ok(!/PRIVATE_|private@example/.test(JSON.stringify(projection.body)));
  const submitted = await write(
    owner,
    `/api/records/${projection.body.id}/submit`,
    {},
    projection.body.revision,
  );
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const approval = await write(
    reviewer,
    `/api/records/${projection.body.id}/review`,
    {
      decision: "approved",
      revisionHash: projection.body.revisionHash,
      comment: "Approved synthetic projection",
    },
    projection.body.revision,
  );
  assert.equal(approval.status, 200);
  const exported = await reviewer.agent.get(
    `/api/records/${projection.body.id}/export`,
  );
  assert.equal(exported.status, 200);
  assert.ok(
    !/PRIVATE_|private@example|availability|compensation|notes|email/.test(
      exported.text,
    ),
  );
});

test("new consent revocation withdraws linked public approval and blocks projection", async () => {
  const defs = (await owner.agent.get("/api/catalog")).body.entities;
  const profile = (await owner.agent.get("/api/records?type=speaker-profiles"))
    .body.items[0];
  const linked = (
    await pool.query(
      "SELECT public_record_id FROM public_projections WHERE profile_id=$1",
      [profile.id],
    )
  ).rows[0];
  const revoked = await write(owner, "/api/records", {
    type: "consents",
    payload: {
      ...defs.find((d: any) => d.type === "consents").defaults,
      personId: profile.payload.personId,
      purpose: "public-profile",
      evidence: "Synthetic withdrawal",
      grantedAt: "2026-01-01T00:00:00Z",
      revokedAt: "2026-11-08T00:00:00Z",
    },
  });
  assert.equal(revoked.status, 201, JSON.stringify(revoked.body));
  const publicRow = (
    await pool.query("SELECT * FROM records WHERE id=$1", [
      linked.public_record_id,
    ])
  ).rows[0];
  assert.equal(publicRow.approved_hash, null);
  assert.equal(publicRow.desired_status, "archived");
  assert.equal(
    (
      await write(
        owner,
        `/api/speaker-profiles/${profile.id}/public-projection`,
        {},
      )
    ).status,
    422,
  );
});
