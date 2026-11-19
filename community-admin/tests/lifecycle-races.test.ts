import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createPool, migrate, COMMUNITY_ID } from "../src/server/db";
import { createApp } from "../src/server/app";
import { entityDefinitions } from "../src/shared/product-contract";
import { encryptPrivate } from "../src/server/private-data";
const delay = () => new Promise((r) => setTimeout(r, 10));
test("archive versus reference creation uses one lock order; immutable uncertain journal and sender lease both block destructive mutation", async () => {
  const schema = "test_lifecycle_race_" + randomUUID().replaceAll("-", ""),
    pool = createPool(process.env.DATABASE_URL!, schema),
    origin = "http://127.0.0.1:4455";
  pool.options.application_name = schema;
  let gate: any;
  try {
    await migrate(pool, schema);
    const actor = (await pool.query("SELECT id FROM users WHERE role='owner'"))
      .rows[0].id;
    const app = createApp({
        pool,
        media: [],
        origin,
        fixtureAuthEnabled: true,
        environment: "test",
      }),
      agent = request.agent(app),
      login = await agent
        .post("/api/dev/login")
        .set("Origin", origin)
        .send({ persona: "owner" });
    const headers = { Origin: origin, "X-CSRF-Token": login.body.csrfToken };
    const person = randomUUID(),
      payload = {
        ...entityDefinitions.find((d) => d.type === "people")!.defaults,
        name: "Synthetic reference race",
        provenance: "test",
        permissionBasis: "test",
      };
    await pool.query(
      "INSERT INTO records(id,community_id,type,scope,author_id,payload,state,revision_hash,updated_at) VALUES($1,$2,'people','private',$3,$4,'active','hash',now())",
      [person, COMMUNITY_ID, actor, encryptPrivate(person, payload)],
    );
    gate = await pool.connect();
    await gate.query("SELECT pg_advisory_lock(hashtext($1))", [
      COMMUNITY_ID + ":record-lifecycle",
    ]);
    const archived = agent
      .post(`/api/records/${person}/archive`)
      .set(headers)
      .set("If-Match", '"1"')
      .send({ reason: "Archive synthetic race target" })
      .then((r) => r);
    // Wait for the archive to queue on the explicit lifecycle lock, not for an arbitrary timer outcome.
    for (let i = 0; i < 100; i++) {
      const waiting = (
        await pool.query(
          "SELECT count(*)::int n FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND NOT l.granted AND l.objid=(hashtext($1)::bigint & 4294967295) AND a.application_name=$2",
          [COMMUNITY_ID + ":record-lifecycle", schema],
        )
      ).rows[0].n;
      if (waiting) break;
      await delay();
      if (i === 99) throw Error("Archive never reached gate");
    }
    const follow = {
      ...entityDefinitions.find((d) => d.type === "followups")!.defaults,
      personId: person,
    };
    const late = agent
      .post("/api/records")
      .set({ ...headers, "Idempotency-Key": randomUUID() })
      .send({ type: "followups", payload: follow })
      .then((r) => r);
    await gate.query("SELECT pg_advisory_unlock(hashtext($1))", [
      COMMUNITY_ID + ":record-lifecycle",
    ]);
    gate.release();
    gate = undefined;
    const archiveResponse = await archived;
    assert.equal(
      archiveResponse.status,
      200,
      JSON.stringify(archiveResponse.body),
    );
    const refused = await late;
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.equal(refused.body.code, "REFERENCE_UNKNOWN");
    const resource = randomUUID(),
      op = randomUUID();
    await pool.query(
      "INSERT INTO records(id,community_id,type,scope,author_id,payload,state,revision_hash,updated_at) VALUES($1,$2,'resources','public',$3,'{}','draft','hash',now())",
      [resource, COMMUNITY_ID, actor],
    );
    await pool.query(
      "INSERT INTO integration_changesets(id,community_id,actor_id,revision_hash,files,state,result) VALUES($1,$2,$3,'immutable',$4,'failed',$5)",
      [
        op,
        COMMUNITY_ID,
        actor,
        JSON.stringify([{ record: { id: resource } }]),
        { bridge: "website-cli", operationId: op, recordIds: [resource] },
      ],
    );
    await pool.query(
      "INSERT INTO website_publication_attempts(operation_id,attempt_id,repository,branch,subject,attempt) VALUES($1,'unknown','example/repo','main','42','{\"state\":\"uncertain\"}')",
      [op],
    );
    const archive = () =>
      agent
        .post(`/api/records/${resource}/archive`)
        .set(headers)
        .set("If-Match", '"1"')
        .send({ reason: "Archive synthetic resource" });
    assert.equal((await archive()).body.code, "PUBLICATION_PENDING");
    const cancel = await agent
      .post(`/api/changesets/${op}/cancel`)
      .set(headers)
      .send({
        revisionHash: "immutable",
        reason: "Cancel unknown synthetic operation",
      });
    assert.equal(cancel.body.code, "PUBLICATION_PENDING");
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM website_publication_attempts WHERE operation_id=$1",
          [op],
        )
      ).rows[0].n,
      1,
    );
    await pool.query(
      'UPDATE website_publication_attempts SET attempt=\'{"state":"absent"}\' WHERE operation_id=$1',
      [op],
    );
    const sender = await pool.connect();
    await sender.query("SELECT pg_advisory_lock(hashtext($1))", [
      `website-operation:${COMMUNITY_ID}:${op}`,
    ]);
    assert.equal((await archive()).body.code, "PUBLICATION_PENDING");
    await sender.query("SELECT pg_advisory_unlock(hashtext($1))", [
      `website-operation:${COMMUNITY_ID}:${op}`,
    ]);
    sender.release();
    const cancelled = await agent
      .post(`/api/changesets/${op}/cancel`)
      .set(headers)
      .send({
        revisionHash: "immutable",
        reason: "Cancel proven unsent synthetic operation",
      });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal((await archive()).status, 200);
    const proof = randomUUID(),
      jobChangeset = randomUUID(),
      proposal = "jobs-proof-" + proof;
    await pool.query(
      "INSERT INTO integration_changesets(id,community_id,actor_id,revision_hash,files,state,result) VALUES($1,$2,$3,'proof','[]','committed',$4)",
      [
        jobChangeset,
        COMMUNITY_ID,
        actor,
        { bridge: "jobs-cli", proposalId: proposal },
      ],
    );
    await pool.query(
      "INSERT INTO website_publication_attempts(operation_id,attempt_id,repository,branch,subject,attempt) VALUES($1,$2,'example/repo','main','42','{\"state\":\"committed\"}')",
      [proposal, proof],
    );
    const history = await agent.get(
      `/api/lifecycle/publication-attempts/${proof}`,
    );
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.actions, []);
    assert.equal(history.body.retentionReason, "IMMUTABLE_HISTORY");
    const other = randomUUID();
    await pool.query(
      "INSERT INTO records(id,community_id,type,scope,author_id,payload,state,revision_hash,updated_at) VALUES($1,$2,'resources','public',$3,'{}','draft','hash',now())",
      [other, randomUUID(), actor],
    );
    assert.equal(
      (await agent.get(`/api/lifecycle/records/${other}`)).status,
      404,
    );
  } finally {
    if (gate) {
      await gate.query("SELECT pg_advisory_unlock_all()");
      gate.release();
    }
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});

test("site import cannot recreate a dependent public draft while its referenced event is staged for withdrawal", async () => {
  const schema = "test_lifecycle_import_" + randomUUID().replaceAll("-", ""),
    pool = createPool(process.env.DATABASE_URL!, schema),
    previous = process.env.WEBSITE_CHECKOUT;
  const fs = await import("node:fs/promises"),
    { resolve } = await import("node:path"),
    dir = await fs.mkdtemp(resolve(".local/import-lifecycle-"));
  try {
    await migrate(pool, schema);
    const actor = (await pool.query("SELECT id FROM users WHERE role='owner'"))
        .rows[0].id,
      parent = randomUUID(),
      id = randomUUID();
    await pool.query(
      "INSERT INTO records(id,community_id,type,scope,author_id,payload,state,desired_status,revision_hash,updated_at) VALUES($1,$2,'events','public',$3,'{}','draft','archived','hash',now())",
      [parent, COMMUNITY_ID, actor],
    );
    const files = await fs.readdir(resolve("../content/memories")),
      record = JSON.parse(
        await fs.readFile(
          resolve(
            "../content/memories",
            files.find((x) => x.endsWith(".json"))!,
          ),
          "utf8",
        ),
      );
    record.id = id;
    record.eventId = parent;
    await fs.mkdir(resolve(dir, "content/memories"), { recursive: true });
    await fs.writeFile(
      resolve(dir, "content/memories", id + ".json"),
      JSON.stringify(record),
    );
    await fs.writeFile(resolve(dir, "astro.config.mjs"), "export default {};");
    await fs.symlink(resolve("../public"), resolve(dir, "public"), "dir");
    process.env.WEBSITE_CHECKOUT = dir;
    const { importSite } = await import("../src/server/import-site");
    const result = await importSite(
      pool,
      {
        id: actor,
        communityId: COMMUNITY_ID,
        name: "Synthetic",
        role: "owner",
        roles: ["owner"],
        capabilities: ["*"],
        csrfToken: "fixture",
      },
      false,
    );
    assert.equal(result.imported, 0);
    assert.ok(result.conflicts.includes(id));
    assert.equal(
      (
        await pool.query("SELECT count(*)::int n FROM records WHERE id=$1", [
          id,
        ])
      ).rows[0].n,
      0,
    );
  } finally {
    if (previous === undefined) delete process.env.WEBSITE_CHECKOUT;
    else process.env.WEBSITE_CHECKOUT = previous;
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
