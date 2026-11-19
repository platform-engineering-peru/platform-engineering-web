import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/server/app";
import { createPool, migrate, COMMUNITY_ID } from "../src/server/db";
import { entityDefinitions } from "../src/shared/product-contract";
import { hashRevision } from "../src/shared/content";
import { encryptPrivate } from "../src/server/private-data";

test("versioned lifecycle protects settings, references and uncertain manifests; local discard retains history", async () => {
  const schema = "test_lifecycle_" + randomUUID().replaceAll("-", ""),
    pool = createPool(process.env.DATABASE_URL!, schema),
    origin = "http://127.0.0.1:4455";
  try {
    await migrate(pool, schema);
    const agent = request.agent(
      createApp({
        pool,
        media: [],
        origin,
        environment: "test",
        fixtureAuthEnabled: true,
      }),
    );
    const login = await agent
        .post("/api/dev/login")
        .set("Origin", origin)
        .send({ persona: "owner" }),
      csrf = login.body.csrfToken;
    const actor = (await pool.query("SELECT id FROM users WHERE role='owner'"))
      .rows[0].id;
    const post = (url: string, body: any = {}, revision = 1) =>
      agent
        .post(url)
        .set("Origin", origin)
        .set("X-CSRF-Token", csrf)
        .set("If-Match", `"${revision}"`)
        .send(body);
    const insert = async (type: string, payload: any = {}, state = "draft") => {
      const def = entityDefinitions.find((x) => x.type === type)!,
        id = randomUUID(),
        value = { ...def.defaults, ...payload };
      await pool.query(
        "INSERT INTO records(id,community_id,type,scope,state,payload,revision,revision_hash,author_id,updated_at) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,now())",
        [
          id,
          COMMUNITY_ID,
          type,
          def.scope,
          state,
          def.scope === "private" ? encryptPrivate(id, value) : value,
          hashRevision(value),
          actor,
        ],
      );
      return id;
    };
    const settings = await insert("settings");
    assert.equal(
      (await post(`/api/records/${settings}/archive`)).body.code,
      "MANDATORY_SETTINGS",
    );
    const target = await insert(
      "people",
      { name: "Synthetic dependency" },
      "archived",
    );
    await insert("followups", { personId: target });
    assert.equal(
      (
        await post(`/api/records/${target}/delete`, {
          reason: "Synthetic test erase",
        })
      ).body.code,
      "RECORD_REFERENCED",
    );
    const resource = await insert("resources");
    const op = randomUUID();
    await pool.query(
      "INSERT INTO integration_changesets(id,community_id,actor_id,revision_hash,files,state,result) VALUES($1,$2,$3,'hash',$4,'uncertain',$5)",
      [
        op,
        COMMUNITY_ID,
        actor,
        JSON.stringify([
          {
            path: `content/resources/${resource}.json`,
            record: { id: resource },
          },
        ]),
        { bridge: "website-cli", recordIds: [resource] },
      ],
    );
    assert.equal(
      (await post(`/api/records/${resource}/archive`)).body.code,
      "PUBLICATION_PENDING",
    );
    const cap = await agent.get(`/api/lifecycle/records/${resource}`);
    assert.equal(cap.status, 200);
    assert.equal(
      cap.body.actions.find((x: any) => x.action === "archive").allowed,
      false,
    );
    const draft = randomUUID();
    await pool.query(
      "INSERT INTO drafts(id,community_id,author_id,slug,display_order,revision,state,payload,revision_hash,updated_at) VALUES($1,$2,$3,'discard-test',90,1,'draft','{}','hash',now())",
      [draft, COMMUNITY_ID, actor],
    );
    await pool.query(
      "INSERT INTO draft_revisions(draft_id,revision,payload,revision_hash,updated_at) VALUES($1,1,'{}','hash',now())",
      [draft],
    );
    const stale = await agent
      .delete(`/api/drafts/${draft}`)
      .set("Origin", origin)
      .set("X-CSRF-Token", csrf)
      .set("If-Match", '"2"')
      .send({ reason: "Discard synthetic local draft" });
    assert.equal(stale.status, 409);
    const discarded = await agent
      .delete(`/api/drafts/${draft}`)
      .set("Origin", origin)
      .set("X-CSRF-Token", csrf)
      .set("If-Match", '"1"')
      .send({ reason: "Discard synthetic local draft" });
    assert.equal(discarded.status, 200);
    assert.equal(discarded.body.remoteUnchanged, true);
    assert.equal((await agent.get(`/api/drafts/${draft}`)).status, 404);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM draft_revisions WHERE draft_id=$1",
          [draft],
        )
      ).rows[0].n,
      1,
    );
  } finally {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});
