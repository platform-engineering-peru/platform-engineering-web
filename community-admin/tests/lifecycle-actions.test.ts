import { JobsPublisher } from "../src/server/jobs/publication";
import { directRemote } from "./direct-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { createApp } from "../src/server/app";
import { createPool, migrate, COMMUNITY_ID } from "../src/server/db";
import { JobsService } from "../src/server/jobs/service";
import { IntegrationService } from "../src/server/integrations/service";
import { privateStorage } from "../src/server/storage";
import { hashRevision } from "../src/shared/content";
import {
  normalizeJob,
  publicJobs,
  reconcileJobs,
} from "../src/server/jobs/engine";
import { entityDefinitions } from "../src/shared/product-contract";
import { encryptPrivate } from "../src/server/private-data";

test("source retirement fences active collection and retains data; cancellation is versioned and rejects leased sends", async () => {
  const schema = "test_lifecycle_actions_" + randomUUID().replaceAll("-", ""),
    pool = createPool(process.env.DATABASE_URL!, schema);
  try {
    await migrate(pool, schema);
    const actor = (await pool.query("SELECT id FROM users WHERE role='owner'"))
        .rows[0].id,
      svc = new JobsService({ pool });
    const source: any = {
      id: "lifecycle",
      adapter: "greenhouse",
      boardIdentifier: "lifecycle",
      company: "Synthetic",
      enabled: true,
      schedule: { enabled: true, intervalHours: 24 },
    };
    await svc.save(COMMUNITY_ID, actor, source.id, source);
    const lock = await pool.connect();
    await lock.query("SELECT pg_advisory_lock(hashtext($1))", [
      `jobs-source:${COMMUNITY_ID}:${source.id}`,
    ]);
    await assert.rejects(
      svc.retire(COMMUNITY_ID, actor, source.id, 1, "Retire synthetic source"),
      { code: "SOURCE_IN_PROGRESS" },
    );
    await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [
      `jobs-source:${COMMUNITY_ID}:${source.id}`,
    ]);
    lock.release();
    await assert.rejects(
      svc.retire(COMMUNITY_ID, actor, source.id, 2, "Retire synthetic source"),
      { code: "REVISION_CONFLICT" },
    );
    const retired = await svc.retire(
      COMMUNITY_ID,
      actor,
      source.id,
      1,
      "Retire synthetic source",
    );
    assert.equal(retired.retired, true);
    assert.equal(retired.config.enabled, false);
    assert.equal(retired.config.schedule.enabled, false);
    await assert.rejects(svc.save(COMMUNITY_ID, actor, source.id, source, 2), {
      code: "SOURCE_RETIRED",
    });
    assert.equal(await svc.scheduleDue(), 0);
    await assert.rejects(svc.run(COMMUNITY_ID, source.id, actor, 2), {
      code: "SOURCE_NOT_ENABLED",
    });
    const pub = randomUUID(),
      integration = new IntegrationService({ pool, liveEnabled: false });
    await pool.query(
      "INSERT INTO integration_publications(id,community_id,author_id,channel,destination,payload,revision_hash,state) VALUES($1,$2,$3,'manual','manual','{}','hash','scheduled')",
      [pub, COMMUNITY_ID, actor],
    );
    await assert.rejects(
      integration.cancel(
        COMMUNITY_ID,
        pub,
        2,
        "hash",
        actor,
        "Cancel synthetic",
      ),
      { code: "REVISION_CONFLICT" },
    );
    const out = randomUUID();
    await pool.query(
      "INSERT INTO worker_outbox(id,community_id,actor_id,kind,subject_id,intent_key,request_hash,state) VALUES($1,$2,$3,'publication',$4,$5,'hash','sending')",
      [out, COMMUNITY_ID, actor, pub, randomUUID()],
    );
    await assert.rejects(
      integration.cancel(
        COMMUNITY_ID,
        pub,
        1,
        "hash",
        actor,
        "Cancel synthetic",
      ),
      { code: "ALREADY_SENDING" },
    );
    await pool.query("UPDATE worker_outbox SET state='queued' WHERE id=$1", [
      out,
    ]);
    const cancelled = await integration.cancel(
      COMMUNITY_ID,
      pub,
      1,
      "hash",
      actor,
      "Cancel synthetic",
    );
    assert.equal(cancelled.version, 2);
    assert.equal(cancelled.remoteUnchanged, true);
    assert.equal(
      (await pool.query("SELECT state FROM worker_outbox WHERE id=$1", [out]))
        .rows[0].state,
      "cancelled",
    );
  } finally {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});

test("editorial vacancy withdrawal retains source-open facts, can publish old baseline despite changed geography, and does not resurrect", async () => {
  const schema = "test_lifecycle_withdraw_" + randomUUID().replaceAll("-", ""),
    pool = createPool(process.env.DATABASE_URL!, schema),
    origin = "http://127.0.0.1:4455";
  try {
    await migrate(pool, schema);
    const actor = (await pool.query("SELECT id FROM users WHERE role='owner'"))
      .rows[0].id;
    const agent = request.agent(
        createApp({
          pool,
          media: [],
          origin,
          fixtureAuthEnabled: true,
          environment: "test",
        }),
      ),
      login = await agent
        .post("/api/dev/login")
        .set("Origin", origin)
        .send({ persona: "owner" });
    const source: any = {
      id: "withdraw",
      adapter: "greenhouse",
      boardIdentifier: "withdraw",
      company: "Employer",
    };
    const open = normalizeJob(
      {
        id: "1",
        title: "Platform Engineer",
        location: { name: "Peru" },
        absolute_url: "https://employer.example/jobs/1",
      },
      source,
      new Date(),
    );
    const baseline = publicJobs([
        {
          ...open,
          summary: {
            "es-pe": "Resumen revisado",
            en: "Reviewed engineering vacancy",
          },
          approved: true,
          status: "active",
        },
      ])[0],
      hash = hashRevision(baseline),
      id = open.id;
    await pool.query(
      "INSERT INTO job_records(id,community_id,source_id,payload) VALUES($1,$2,$3,$4)",
      [
        id,
        COMMUNITY_ID,
        source.id,
        {
          ...open,
          eligibility: "restricted",
          title: "Accountant",
          roleFamily: null,
          locations: ["United States"],
          sourceClosed: false,
          status: "needs-review",
          baseEntityHash: hash,
        },
      ],
    );
    await pool.query(
      "INSERT INTO integration_changesets(id,community_id,actor_id,revision_hash,files,state,result) VALUES($1,$2,$3,'hash',$4,'committed',$5)",
      [
        randomUUID(),
        COMMUNITY_ID,
        actor,
        JSON.stringify([
          {
            path: `content/jobs/${id}.json`,
            content: JSON.stringify(baseline),
          },
        ]),
        { bridge: "jobs-cli", jobIds: [id] },
      ],
    );
    const mutate = (decision: string, version: number) =>
      agent
        .post(`/api/jobs/${encodeURIComponent(id)}/review`)
        .set("Origin", origin)
        .set("X-CSRF-Token", login.body.csrfToken)
        .send({ decision, version, reason: "Curator withdraws republication" });
    assert.equal(
      (await mutate("exclude", 1)).body.code,
      "PUBLIC_WITHDRAWAL_REQUIRED",
    );
    const result = await mutate("withdraw", 1);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.payload.sourceClosed, false);
    assert.equal(result.body.payload.closureReason, "curator-withdrawn");
    await pool.query("UPDATE users SET provider_subject='42' WHERE id=$1", [
      actor,
    ]);
    const remote = directRemote();
    remote.tree.set(`content/jobs/${id}.json`, baseline);
    const publisher = new JobsPublisher(pool, {
      config: {
        mode: "github",
        repository: "example/repo",
        branch: "main",
        remoteWritesEnabled: true,
      },
      transport: remote.view(["jobs"]),
    });
    const prepared = await publisher.create(
      COMMUNITY_ID,
      actor,
      [id],
      randomUUID(),
      { [id]: result.body.version },
    );
    assert.equal(prepared.kind, "jobs-changeset");
    assert.equal(remote.proofs.size, 0);
    const projected = publicJobs([result.body.payload]);
    assert.equal(projected.length, 1);
    assert.equal(projected[0].status, "closed");
    assert.equal(projected[0].eligibility, "peru");
    assert.ok(!Object.hasOwn(projected[0], "editorialWithdrawal"));
    const refreshed = reconcileJobs(
      [result.body.payload],
      {
        status: "complete",
        sourceId: source.id,
        records: [open],
        observedIds: [id],
      },
      new Date(),
    ).jobs[0];
    assert.equal(refreshed.status, "closed");
    assert.equal(refreshed.sourceClosed, false);
    assert.equal(refreshed.closureReason, "curator-withdrawn");
    const pairedPath = "../../scripts/jobs/engine.mjs",
      paired = await import(pairedPath);
    assert.deepEqual(paired.publicJobs([result.body.payload]), projected);
    assert.deepEqual(
      paired.reconcileJobs(
        [result.body.payload],
        {
          status: "complete",
          sourceId: source.id,
          records: [open],
          observedIds: [id],
        },
        new Date("2026-11-18T16:00:00Z"),
      ),
      reconcileJobs(
        [result.body.payload],
        {
          status: "complete",
          sourceId: source.id,
          records: [open],
          observedIds: [id],
        },
        new Date("2026-11-18T16:00:00Z"),
      ),
    );
  } finally {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});

test("owned upload removal protects seeded and historical media; unreferenced bytes are removed under checksum fence", async () => {
  const schema = "test_lifecycle_media_" + randomUUID().replaceAll("-", ""),
    pool = createPool(process.env.DATABASE_URL!, schema),
    origin = "http://127.0.0.1:4455",
    dir = await mkdtemp(join(tmpdir(), "admin-delete-media-")),
    previous = process.env.PRIVATE_STORAGE_DIR;
  process.env.PRIVATE_STORAGE_DIR = dir;
  try {
    await migrate(pool, schema);
    const actor = (await pool.query("SELECT id FROM users WHERE role='owner'"))
      .rows[0].id;
    const seed: any = {
      id: randomUUID(),
      path: "brand/official/mark.png",
      sha256: "a".repeat(64),
      width: 1,
      height: 1,
    };
    const agent = request.agent(
        createApp({
          pool,
          media: [seed],
          origin,
          fixtureAuthEnabled: true,
          environment: "test",
        }),
      ),
      login = await agent
        .post("/api/dev/login")
        .set("Origin", origin)
        .send({ persona: "owner" });
    const remove = (id: string, sha: string) =>
      agent
        .delete(`/api/media/${id}`)
        .set("Origin", origin)
        .set("X-CSRF-Token", login.body.csrfToken)
        .set("If-Match", `"${sha}"`)
        .send({ reason: "Remove synthetic unused upload" });
    assert.equal(
      (await remove(seed.id, seed.sha256)).body.code,
      "SEEDED_MEDIA_PROTECTED",
    );
    const create = async (sha: string) => {
      const id = randomUUID(),
        path = `media/${sha.slice(0, 16)}/image.webp`,
        key = `${COMMUNITY_ID}/derived/${sha}.webp`;
      await privateStorage().put(key, Buffer.from("synthetic"), "image/webp");
      await pool.query(
        "INSERT INTO media_assets(id,community_id,uploader_id,path,sha256,width,height,mime,bytes,storage_key,storage_backend,original_name,rights) VALUES($1,$2,$3,$4,$5,1,1,'image/webp',9,$6,'local','synthetic','{}')",
        [id, COMMUNITY_ID, actor, path, sha, key],
      );
      return { id, key };
    };
    const kept = await create("b".repeat(64)),
      draft = randomUUID();
    await pool.query(
      "INSERT INTO drafts(id,community_id,author_id,slug,display_order,revision,state,payload,revision_hash,updated_at) VALUES($1,$2,$3,'history-media',80,1,'draft','{}','hash',now())",
      [draft, COMMUNITY_ID, actor],
    );
    await pool.query(
      "INSERT INTO draft_revisions(draft_id,revision,payload,revision_hash,updated_at) VALUES($1,1,$2,'hash',now())",
      [draft, { media: [{ assetId: kept.id }] }],
    );
    assert.equal(
      (await remove(kept.id, "b".repeat(64))).body.code,
      "MEDIA_REFERENCED",
    );
    assert.equal(
      (await privateStorage().get(kept.key)).toString(),
      "synthetic",
    );
    const unused = await create("c".repeat(64));
    assert.equal(
      (await remove(unused.id, "d".repeat(64))).body.code,
      "REVISION_CONFLICT",
    );
    const removed = await remove(unused.id, "c".repeat(64));
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(removed.body.bytesRemoved, true);
    await assert.rejects(privateStorage().get(unused.key), { code: "ENOENT" });
  } finally {
    if (previous === undefined) delete process.env.PRIVATE_STORAGE_DIR;
    else process.env.PRIVATE_STORAGE_DIR = previous;
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  }
});

test("consent archive stages linked public withdrawal and prevents consent erasure from reauthorizing it", async () => {
  const schema = "test_lifecycle_consent_" + randomUUID().replaceAll("-", ""),
    pool = createPool(process.env.DATABASE_URL!, schema),
    origin = "http://127.0.0.1:4455";
  try {
    await migrate(pool, schema);
    const actor = (await pool.query("SELECT id FROM users WHERE role='owner'"))
      .rows[0].id;
    const insert = async (type: string, payload: any) => {
      const id = randomUUID(),
        def = entityDefinitions.find((d) => d.type === type)!,
        value = { ...def.defaults, ...payload };
      await pool.query(
        "INSERT INTO records(id,community_id,type,scope,author_id,payload,revision,state,revision_hash,updated_at) VALUES($1,$2,$3,$4,$5,$6,1,'active','hash',now())",
        [
          id,
          COMMUNITY_ID,
          type,
          def.scope,
          actor,
          def.scope === "private" ? encryptPrivate(id, value) : value,
        ],
      );
      return id;
    };
    const person = await insert("people", { name: "Synthetic person" }),
      profile = await insert("speaker-profiles", {
        personId: person,
        publicConsent: true,
        consentEvidence: "Synthetic evidence",
      }),
      consent = await insert("consents", { personId: person, revokedAt: null }),
      speaker = await insert("speakers", { name: "Synthetic speaker" });
    await pool.query(
      "INSERT INTO public_projections(public_record_id,person_id,profile_id) VALUES($1,$2,$3)",
      [speaker, person, profile],
    );
    const agent = request.agent(
        createApp({
          pool,
          media: [],
          origin,
          fixtureAuthEnabled: true,
          environment: "test",
        }),
      ),
      login = await agent
        .post("/api/dev/login")
        .set("Origin", origin)
        .send({ persona: "owner" });
    const archive = await agent
      .post(`/api/records/${consent}/archive`)
      .set("Origin", origin)
      .set("X-CSRF-Token", login.body.csrfToken)
      .set("If-Match", '"1"')
      .send({ reason: "Withdraw synthetic consent" });
    assert.equal(archive.status, 200, JSON.stringify(archive.body));
    const row = (
      await pool.query("SELECT * FROM records WHERE id=$1", [speaker])
    ).rows[0];
    assert.equal(row.desired_status, "archived");
    assert.equal(row.state, "draft");
    assert.equal(row.revision, 2);
    const { requirePublicConsent } = await import("../src/server/consent");
    await assert.rejects(
      requirePublicConsent(pool, COMMUNITY_ID, person, profile),
      { code: "CONSENT_REQUIRED" },
    );
    const erased = await agent
      .post(`/api/records/${consent}/delete`)
      .set("Origin", origin)
      .set("X-CSRF-Token", login.body.csrfToken)
      .set("If-Match", '"2"')
      .send({ reason: "Erase synthetic archived consent" });
    assert.equal(erased.status, 200, JSON.stringify(erased.body));
    await assert.rejects(
      requirePublicConsent(pool, COMMUNITY_ID, person, profile),
      { code: "CONSENT_REQUIRED" },
    );
  } finally {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});

test("publication cancel waits for and rechecks the actual queued lease row instead of cancelling past a concurrent claim", async () => {
  const schema =
      "test_lifecycle_cancel_race_" + randomUUID().replaceAll("-", ""),
    pool = createPool(process.env.DATABASE_URL!, schema);
  let gate: any;
  try {
    await migrate(pool, schema);
    const actor = (await pool.query("SELECT id FROM users WHERE role='owner'"))
        .rows[0].id,
      pub = randomUUID(),
      out = randomUUID(),
      svc = new IntegrationService({ pool, liveEnabled: false });
    await pool.query(
      "INSERT INTO integration_publications(id,community_id,author_id,channel,destination,payload,revision_hash,state) VALUES($1,$2,$3,'manual','manual','{}','hash','scheduled')",
      [pub, COMMUNITY_ID, actor],
    );
    await pool.query(
      "INSERT INTO worker_outbox(id,community_id,actor_id,kind,subject_id,intent_key,request_hash,state) VALUES($1,$2,$3,'publication',$4,$5,'hash','queued')",
      [out, COMMUNITY_ID, actor, pub, randomUUID()],
    );
    gate = await pool.connect();
    await gate.query("BEGIN");
    const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await gate.query("SELECT id FROM worker_outbox WHERE id=$1 FOR UPDATE", [
      out,
    ]);
    const cancelled = svc
      .cancel(
        COMMUNITY_ID,
        pub,
        1,
        "hash",
        actor,
        "Cancel synthetic raced operation",
      )
      .then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error }),
      );
    for (let i = 0; i < 100; i++) {
      const waiting = (
        await pool.query(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting",
          [pid],
        )
      ).rows[0].waiting;
      if (waiting) break;
      await new Promise((r) => setTimeout(r, 10));
      if (i === 99) throw Error("Cancellation never reached held outbox");
    }
    await gate.query(
      "UPDATE worker_outbox SET state='sending',lease_owner='synthetic',lease_until=now()+interval '1 minute' WHERE id=$1",
      [out],
    );
    await gate.query("COMMIT");
    gate.release();
    gate = null;
    const result = await cancelled;
    assert.equal(result.error?.code, "ALREADY_SENDING");
    assert.equal(
      (
        await pool.query(
          "SELECT state FROM integration_publications WHERE id=$1",
          [pub],
        )
      ).rows[0].state,
      "scheduled",
    );
  } finally {
    if (gate) {
      await gate.query("ROLLBACK");
      gate.release();
    }
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});

test("failed byte cleanup retains an owned checksum-bound retry and never deletes a newly shared key", async () => {
  const schema = "test_lifecycle_cleanup_" + randomUUID().replaceAll("-", ""),
    pool = createPool(process.env.DATABASE_URL!, schema),
    origin = "http://127.0.0.1:4455",
    dir = await mkdtemp(join(tmpdir(), "admin-cleanup-")),
    previous = process.env.PRIVATE_STORAGE_DIR;
  process.env.PRIVATE_STORAGE_DIR = dir;
  try {
    await migrate(pool, schema);
    const actor = (await pool.query("SELECT id FROM users WHERE role='owner'"))
        .rows[0].id,
      id = randomUUID(),
      sha = "e".repeat(64),
      key = `${COMMUNITY_ID}/derived/${sha}.webp`;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, key), { recursive: true });
    await pool.query(
      "INSERT INTO media_assets(id,community_id,uploader_id,path,sha256,width,height,mime,bytes,storage_key,storage_backend,original_name,rights) VALUES($1,$2,$3,$4,$5,1,1,'image/webp',9,$6,'local','synthetic','{}')",
      [
        id,
        COMMUNITY_ID,
        actor,
        `media/${sha.slice(0, 16)}/image.webp`,
        sha,
        key,
      ],
    );
    let failCompletion = false;
    const faultPool: any = new Proxy(pool, {
      get(target, property) {
        if (property === "connect")
          return async () => {
            const client = await target.connect();
            return new Proxy(client, {
              get(connection, key) {
                if (key === "query")
                  return async (...args: any[]) => {
                    if (
                      args[1]?.[4] === "media_cleanup_completed" &&
                      failCompletion
                    ) {
                      failCompletion = false;
                      throw Error(
                        "synthetic interruption after byte deletion before completion proof",
                      );
                    }
                    return (connection.query as any)(...args);
                  };
                const value = Reflect.get(connection, key);
                return typeof value === "function"
                  ? value.bind(connection)
                  : value;
              },
            });
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const agent = request.agent(
        createApp({
          pool: faultPool,
          media: [],
          origin,
          fixtureAuthEnabled: true,
          environment: "test",
        }),
      ),
      login = await agent
        .post("/api/dev/login")
        .set("Origin", origin)
        .send({ persona: "owner" });
    const remove = () =>
      agent
        .delete(`/api/media/${id}`)
        .set("Origin", origin)
        .set("X-CSRF-Token", login.body.csrfToken)
        .set("If-Match", `"${sha}"`)
        .send({ reason: "Retry synthetic byte cleanup" });
    const failed = await remove();
    assert.equal(failed.status, 200);
    assert.equal(failed.body.cleanupPending, true);
    assert.equal(failed.body.bytesRemoved, false);
    const pendingList = await agent.get("/api/media");
    const pendingImage = pendingList.body.find((item: any) => item.id === id);
    assert.equal(pendingImage?.cleanupPending, true);
    assert.equal("storage_key" in pendingImage, false);
    const foreign = request.agent(
      createApp({
        pool,
        media: [],
        origin,
        fixtureAuthEnabled: true,
        environment: "test",
      }),
    );
    await foreign
      .post("/api/dev/login")
      .set("Origin", origin)
      .send({ persona: "editor" });
    assert.equal(
      (await foreign.get("/api/media")).body.some(
        (item: any) => item.id === id,
      ),
      false,
    );
    assert.equal((await foreign.get(`/api/lifecycle/media/${id}`)).status, 404);
    const pendingDescriptor = await agent.get(`/api/lifecycle/media/${id}`);
    assert.equal(pendingDescriptor.status, 200);
    assert.equal(pendingDescriptor.body.version, sha);
    assert.equal(pendingDescriptor.body.state, "cleanup-pending");
    assert.equal(pendingDescriptor.body.actions[0].allowed, true);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM media_assets WHERE id=$1",
          [id],
        )
      ).rows[0].n,
      0,
    );
    await rm(join(dir, key), { recursive: true });
    await privateStorage().put(key, Buffer.from("synthetic"), "image/webp");
    const shared = randomUUID();
    await pool.query(
      "INSERT INTO media_assets(id,community_id,uploader_id,path,sha256,width,height,mime,bytes,storage_key,storage_backend,original_name,rights) VALUES($1,$2,$3,$4,$5,1,1,'image/webp',9,$6,'local','synthetic','{}')",
      [
        shared,
        COMMUNITY_ID,
        actor,
        `media/${sha.slice(0, 16)}/image.webp`,
        sha,
        key,
      ],
    );
    assert.equal((await remove()).body.code, "MEDIA_SHARED");
    assert.equal((await privateStorage().get(key)).toString(), "synthetic");
    await pool.query("DELETE FROM media_assets WHERE id=$1", [shared]);
    failCompletion = true;
    const interrupted = await remove();
    assert.equal(interrupted.status, 503);
    await assert.rejects(privateStorage().get(key), { code: "ENOENT" });
    assert.equal(
      (await agent.get("/api/media")).body.find((item: any) => item.id === id)
        ?.cleanupPending,
      true,
    );
    assert.equal((await agent.get(`/api/lifecycle/media/${id}`)).status, 200);
    const retried = await remove();
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(retried.body.bytesRemoved, true);
    assert.equal(
      (await agent.get("/api/media")).body.some((item: any) => item.id === id),
      false,
    );
    assert.equal((await agent.get(`/api/lifecycle/media/${id}`)).status, 404);
    await assert.rejects(privateStorage().get(key), { code: "ENOENT" });
  } finally {
    if (previous === undefined) delete process.env.PRIVATE_STORAGE_DIR;
    else process.env.PRIVATE_STORAGE_DIR = previous;
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  }
});
