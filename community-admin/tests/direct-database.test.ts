import pg from "pg";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPool, migrate, COMMUNITY_ID } from "../src/server/db";
import { directRemote } from "./direct-fixture";
import { WebsitePublisher } from "../src/server/website-publication";
import { JobsPublisher } from "../src/server/jobs/publication";
import { EditorialService } from "../src/server/editorial-sync/service";
import { normalizeJob } from "../src/server/jobs/engine";
import { entityDefinitions } from "../src/shared/product-contract";
import { exportApprovedRecords } from "../src/server/export";
import { hashRevision } from "../src/shared/content";
import { capabilitiesFor } from "../src/server/context";
const schema = "test_direct_" + randomUUID().replaceAll("-", ""),
  actor = "10000000-0000-4000-8000-000000000004",
  config = {
    mode: "github" as const,
    repository: "platform-engineering-peru/platform-engineering-web",
    branch: "main",
    remoteWritesEnabled: true,
  };
let pool: ReturnType<typeof createPool>;
before(async () => {
  pool = createPool(process.env.DATABASE_URL!, schema);
  await migrate(pool, schema);
  await pool.query("UPDATE users SET provider_subject='42' WHERE id=$1", [
    actor,
  ]);
});
after(async () => {
  await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await pool.end();
});
async function resource(order: number) {
  const id = randomUUID(),
    payload = {
      ...structuredClone(
        entityDefinitions.find((d) => d.type === "resources")!.defaults,
      ),
      slug: "direct-" + id,
      title: { "es-pe": "Recurso", en: "Resource" },
      description: {
        "es-pe": "Descripción del recurso.",
        en: "Resource description.",
      },
      href: "https://example.com/" + id,
      displayOrder: order,
    };
  await pool.query(
    "INSERT INTO records(id,community_id,type,scope,author_id,payload,state,revision_hash,updated_at,desired_status) VALUES($1,$2,'resources','public',$3,$4,'draft',$5,now(),'published')",
    [id, COMMUNITY_ID, actor, payload, hashRevision(payload)],
  );
  return id;
}
const exporter = async (db: any, c: string, ids: string[]) => {
  const x = await exportApprovedRecords(db, c, ids);
  return { files: x.files, revisionHashes: x.revisionHashes };
};
async function prepare(publisher: any, db: any, ids: string[], key: string) {
  const jobs = publisher instanceof JobsPublisher;
  const rows = (
    await db.query(
      `SELECT id,${jobs ? "version" : "revision"} AS version FROM ${jobs ? "job_records" : "records"} WHERE community_id=$1 AND id=ANY($2::${jobs ? "text" : "uuid"}[])`,
      [COMMUNITY_ID, ids],
    )
  ).rows;
  return publisher.create(
    COMMUNITY_ID,
    actor,
    ids,
    key,
    Object.fromEntries(rows.map((r: any) => [r.id, r.version])),
  );
}
test("generic admin publication validates exact revision, directly commits, and distinguishes deployment failure/success", async () => {
  const remote = directRemote(),
    publisher = new WebsitePublisher(
      pool,
      { config, transport: remote.view(["resources"]) },
      exporter,
    );
  const id = await resource(401),
    operation = await prepare(publisher, pool, [id], randomUUID());
  const first = await publisher.send(COMMUNITY_ID, actor, operation.subject_id);
  assert.equal(first.state, "committed");
  assert.ok("commitSha" in first && first.commitSha);
  assert.equal(
    (await pool.query("SELECT state FROM records WHERE id=$1", [id])).rows[0]
      .state,
    "approved",
  );
  remote.deployment("failed");
  assert.equal(
    (await publisher.send(COMMUNITY_ID, actor, operation.subject_id, true))
      .state,
    "deployment_failed",
  );
  remote.deployment("deployed");
  assert.equal(
    (await publisher.send(COMMUNITY_ID, actor, operation.subject_id, true))
      .state,
    "deployed",
  );
  assert.equal(remote.proofs.size, 1);
});
test("generic revision changes and revoked actor cannot send; private records rejected", async () => {
  const remote = directRemote(),
    publisher = new WebsitePublisher(
      pool,
      { config, transport: remote.view(["resources"]) },
      exporter,
    );
  const id = await resource(402),
    operation = await prepare(publisher, pool, [id], randomUUID());
  await pool.query(
    "UPDATE records SET approved_hash=NULL,state='draft' WHERE id=$1",
    [id],
  );
  await assert.rejects(
    publisher.send(COMMUNITY_ID, actor, operation.subject_id),
  );
  assert.equal(remote.proofs.size, 0);
  const id2 = await resource(403),
    op2 = await prepare(publisher, pool, [id2], randomUUID());
  await pool.query("UPDATE users SET active=false WHERE id=$1", [actor]);
  await assert.rejects(publisher.send(COMMUNITY_ID, actor, op2.subject_id), {
    code: "ACTOR_REVOKED",
  });
  await pool.query("UPDATE users SET active=true WHERE id=$1", [actor]);
  await pool.query("UPDATE records SET scope='private' WHERE id=$1", [id2]);
  await assert.rejects(prepare(publisher, pool, [id2], randomUUID()), {
    code: "PRIVATE_RECORD_NOT_EXPORTABLE",
  });
});
test("jobs direct lost-response recovery is durable and does not resubmit", async () => {
  const remote = directRemote(),
    publisher = new JobsPublisher(pool, {
      config,
      transport: remote.view(["jobs"]),
    });
  const payload = {
    ...normalizeJob(
      {
        id: randomUUID(),
        title: "Platform Engineer",
        location: { name: "Remote Peru" },
        absolute_url: "https://example.com/job",
      },
      {
        id: "direct",
        adapter: "greenhouse",
        boardIdentifier: "direct",
        company: "Example",
      },
      new Date(),
    ),
    approved: true,
    status: "active",
    summary: {
      "es-pe": "Ingeniería de plataforma.",
      en: "Platform engineering.",
    },
  };
  await pool.query(
    "INSERT INTO job_records(id,community_id,source_id,payload)VALUES($1,$2,$3,$4)",
    [payload.id, COMMUNITY_ID, "direct", payload],
  );
  const operation = await prepare(publisher, pool, [payload.id], randomUUID());
  remote.lose();
  await assert.rejects(
    publisher.publish(COMMUNITY_ID, actor, operation.subject_id),
    { code: "PUBLICATION_UNCERTAIN" },
  );
  const found = await publisher.reconcile(
    COMMUNITY_ID,
    actor,
    operation.subject_id,
  );
  assert.equal(found.state, "committed");
  assert.equal(remote.proofs.size, 1);
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT count(*) FROM website_publication_attempts WHERE operation_id=$1",
          [hashRevision({})],
        )
      ).rows[0].count,
    ),
    0,
  );
});
test("Events direct operation updates only submitted draft version and keeps PR history absent", async () => {
  const remote = directRemote(),
    service = new EditorialService(
      pool,
      config,
      remote.view(["events", "speakers"]),
    );
  const user: any = {
    id: actor,
    communityId: COMMUNITY_ID,
    role: "owner",
    roles: ["owner"],
    capabilities: capabilitiesFor(["owner"]),
  };
  await service.pull(user);
  const id = randomUUID(),
    recordId = randomUUID(),
    payload = {
      ...structuredClone(
        entityDefinitions.find((d) => d.type === "events")!.defaults,
      ),
      slug: "direct-" + recordId,
      title: { "es-pe": "Evento", en: "Event" },
      description: { "es-pe": "Evento local.", en: "Local event." },
      date: "2027-01-10",
      city: { "es-pe": "Lima", en: "Lima" },
      venue: "Fixture",
      speakerIds: [],
    };
  const draft = await service.save(user, id, {
    recordId,
    baseCommit: remote.head(),
    baseRecordHash: null,
    payload,
    desiredStatus: "published",
  });
  const result = await service.propose(
    user,
    [{ id, expectedVersion: draft.version }],
    randomUUID(),
  );
  assert.equal((result.items[0] as any).submission.publicationMode, "direct");
  assert.equal((result.items[0] as any).submission.state, "committed");
  assert.equal((result.items[0] as any).proposal, undefined);
  assert.equal(remote.proofs.size, 1);
});

test("two independent local stores race disjoint writes safely and same-record writes conflict", async () => {
  const schema2 = "test_direct_other_" + randomUUID().replaceAll("-", "");
  const other = createPool(process.env.DATABASE_URL!, schema2);
  await migrate(other, schema2);
  await other.query("UPDATE users SET provider_subject='42' WHERE id=$1", [
    actor,
  ]);
  try {
    const remote = directRemote();
    const p1 = new WebsitePublisher(
        pool,
        { config, transport: remote.view(["resources"]) },
        exporter,
      ),
      p2 = new WebsitePublisher(
        other,
        { config, transport: remote.view(["resources"]) },
        exporter,
      );
    const first = await resource(410),
      row = (await pool.query("SELECT * FROM records WHERE id=$1", [first]))
        .rows[0];
    const second = randomUUID(),
      secondPayload = {
        ...row.payload,
        slug: "second-" + second,
        href: "https://example.com/" + second,
        displayOrder: 411,
      };
    await other.query(
      "INSERT INTO records(id,community_id,type,scope,author_id,payload,state,revision_hash,updated_at,desired_status)VALUES($1,$2,'resources','public',$3,$4,'draft',$5,now(),'published')",
      [second, COMMUNITY_ID, actor, secondPayload, hashRevision(secondPayload)],
    );
    const a = await prepare(p1, pool, [first], randomUUID()),
      b = await prepare(p2, other, [second], randomUUID());
    let arrivals = 0,
      release!: () => void;
    const barrier = new Promise<void>((r) => (release = r));
    remote.before(async () => {
      arrivals++;
      if (arrivals === 2) release();
      if (arrivals <= 2) await barrier;
    });
    const results = await Promise.all([
      p1.send(COMMUNITY_ID, actor, a.subject_id),
      p2.send(COMMUNITY_ID, actor, b.subject_id),
    ]);
    assert.ok(results.every((r) => r.state === "committed"));
    assert.equal(remote.proofs.size, 2);
    const shared = await resource(420),
      local = (await pool.query("SELECT * FROM records WHERE id=$1", [shared]))
        .rows[0];
    const alternative = {
      ...local.payload,
      title: { "es-pe": "Otra revisión", en: "Another revision" },
    };
    await other.query(
      "INSERT INTO records(id,community_id,type,scope,author_id,payload,state,revision_hash,updated_at,desired_status)VALUES($1,$2,'resources','public',$3,$4,'draft',$5,now(),'published')",
      [shared, COMMUNITY_ID, actor, alternative, hashRevision(alternative)],
    );
    remote.before(async () => {});
    const x = await prepare(p1, pool, [shared], randomUUID()),
      y = await prepare(p2, other, [shared], randomUUID());
    await p1.send(COMMUNITY_ID, actor, x.subject_id);
    await assert.rejects(p2.send(COMMUNITY_ID, actor, y.subject_id), {
      code: "REMOTE_RECORD_CONFLICT",
    });
    assert.equal(
      (await other.query("SELECT payload FROM records WHERE id=$1", [shared]))
        .rows[0].payload.title.en,
      "Another revision",
    );
  } finally {
    await other.query(`DROP SCHEMA "${schema2}" CASCADE`);
    await other.end();
  }
});

test("generic content plus immutable owned-media bundle uses one atomic direct commit", async () => {
  const remote = directRemote(),
    id = await resource(430),
    media = "public/media/" + randomUUID() + ".png",
    bytes = Buffer.from("controlled-owned-asset-fixture").toString("base64");
  const mediaExporter = async (db: any, c: string, ids: string[]) => {
    const value = await exporter(db, c, ids);
    return {
      ...value,
      files: [
        ...value.files,
        { path: media, content: bytes, encoding: "base64" as const },
      ],
    };
  };
  const publisher = new WebsitePublisher(
    pool,
    { config, transport: remote.view(["resources"]) },
    mediaExporter,
  );
  const op = await prepare(publisher, pool, [id], randomUUID());
  await publisher.send(COMMUNITY_ID, actor, op.subject_id);
  assert.equal(remote.proofs.size, 1);
  assert.equal(remote.tree.get(media).bytes, bytes);
  assert.ok(remote.tree.has("content/resources/" + id + ".json"));
});

test("direct generic send and reconciliation work with pool max1 and deployment API outage retains committed proof", async () => {
  const single = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    options: `-c search_path=${schema},public`,
    max: 1,
    connectionTimeoutMillis: 1000,
  });
  try {
    const remote = directRemote(),
      transport = remote.view(["resources"]);
    transport.deployment = async () => {
      throw Error("503");
    };
    const publisher = new WebsitePublisher(
        single,
        { config, transport },
        exporter,
      ),
      id = await resource(440),
      key = randomUUID();
    const op = await prepare(publisher, pool, [id], key);
    const first = await publisher.send(COMMUNITY_ID, actor, op.subject_id);
    assert.equal(first.state, "committed");
    const retry = await prepare(publisher, pool, [id], key);
    assert.equal(retry.subject_id, op.subject_id);
    assert.equal(
      (await publisher.send(COMMUNITY_ID, actor, op.subject_id, true)).state,
      "committed",
    );
    assert.equal(remote.proofs.size, 1);
  } finally {
    await single.end();
  }
});

test("new direct preparations require displayed revisions and reject stale or rebound idempotency maps before approval", async () => {
  const remote = directRemote(),
    publisher = new WebsitePublisher(
      pool,
      { config, transport: remote.view(["resources"]) },
      exporter,
    ),
    id = await resource(450),
    key = randomUUID();
  await assert.rejects(publisher.create(COMMUNITY_ID, actor, [id], key), {
    code: "EXPECTED_REVISIONS_REQUIRED",
  });
  await assert.rejects(
    publisher.create(COMMUNITY_ID, actor, [id], key, { [id]: 1, other: 1 }),
    { code: "EXPECTED_VERSION_MAP_INVALID" },
  );
  await pool.query("UPDATE records SET revision=2 WHERE id=$1", [id]);
  await assert.rejects(
    publisher.create(COMMUNITY_ID, actor, [id], key, { [id]: 1 }),
    { code: "DRAFT_VERSION_CONFLICT" },
  );
  assert.equal(
    (await pool.query("SELECT state FROM records WHERE id=$1", [id])).rows[0]
      .state,
    "draft",
  );
  await publisher.create(COMMUNITY_ID, actor, [id], key, { [id]: 2 });
  await assert.rejects(
    publisher.create(COMMUNITY_ID, actor, [id], key, { [id]: 3 }),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
});

test("job publish action binds displayed version and validates then approves that exact unapproved draft", async () => {
  const remote = directRemote(),
    publisher = new JobsPublisher(pool, {
      config,
      transport: remote.view(["jobs"]),
    }),
    external = randomUUID();
  const payload = {
    ...normalizeJob(
      {
        id: external,
        title: "Platform Engineer",
        location: { name: "Remote Peru" },
        absolute_url: "https://example.com/job/" + external,
      },
      {
        id: "version",
        adapter: "greenhouse",
        boardIdentifier: "version",
        company: "Example",
      },
      new Date(),
    ),
    status: "candidate",
    approved: false,
    summary: { "es-pe": "Plataformas en Perú.", en: "Platform role in Peru." },
  };
  await pool.query(
    "INSERT INTO job_records(id,community_id,source_id,payload)VALUES($1,$2,$3,$4)",
    [payload.id, COMMUNITY_ID, "version", payload],
  );
  const key = randomUUID();
  await assert.rejects(
    publisher.create(COMMUNITY_ID, actor, [payload.id], key),
    { code: "EXPECTED_VERSIONS_REQUIRED" },
  );
  await assert.rejects(
    publisher.create(COMMUNITY_ID, actor, [payload.id], key, {
      [payload.id]: 2,
    }),
    { code: "JOB_VERSION_CONFLICT" },
  );
  assert.equal(
    (
      await pool.query("SELECT payload FROM job_records WHERE id=$1", [
        payload.id,
      ])
    ).rows[0].payload.approved,
    false,
  );
  const op = await publisher.create(COMMUNITY_ID, actor, [payload.id], key, {
    [payload.id]: 1,
  });
  assert.equal(
    (
      await pool.query("SELECT payload FROM job_records WHERE id=$1", [
        payload.id,
      ])
    ).rows[0].payload.approved,
    true,
  );
  await publisher.publish(COMMUNITY_ID, actor, op.subject_id);
  const replay = await publisher.create(
    COMMUNITY_ID,
    actor,
    [payload.id],
    key,
    { [payload.id]: 1 },
  );
  assert.equal(replay.subject_id, op.subject_id);
  await assert.rejects(
    publisher.create(COMMUNITY_ID, actor, [payload.id], key, {
      [payload.id]: 2,
    }),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
});

test("worker preflight failures persist actionable direct changeset status without enabling legacy integrations", async () => {
  const { IntegrationService } =
    await import("../src/server/integrations/service");
  await pool.query(
    "UPDATE worker_outbox SET state='cancelled' WHERE state='queued'",
  );
  const remote = directRemote(),
    service = new IntegrationService({
      pool,
      liveEnabled: false,
      websitePublication: { config, transport: remote.view(["resources"]) },
      exportRecords: exporter,
    });
  const id = await resource(460),
    op = await service.createChangeset(
      COMMUNITY_ID,
      actor,
      [id],
      randomUUID(),
      { [id]: 1 },
    );
  await pool.query(
    "UPDATE records SET approved_hash=NULL,state='draft' WHERE id=$1",
    [id],
  );
  await service.tick();
  const row = (
    await pool.query(
      "SELECT state,result FROM integration_changesets WHERE id=$1",
      [op.subject_id],
    )
  ).rows[0];
  assert.equal(row.state, "blocked");
  assert.ok(row.result.errorCode);
  assert.equal(remote.proofs.size, 0);
});

test("Events recovery keeps unproven writes locked and releases proven-absent conflicts", async () => {
  for (const stage of [
    "inspect",
    "snapshot",
    "hashes",
    "validation",
    "absent-conflict",
  ]) {
    const remote = directRemote(),
      transport = remote.view(["events", "speakers"]),
      original = {
        snapshot: transport.snapshot,
        hashes: transport.hashesDirect,
        inspect: transport.inspectDirect,
        commit: transport.commitDirect,
      };
    const service = new EditorialService(pool, config, transport),
      user: any = {
        id: actor,
        communityId: COMMUNITY_ID,
        role: "owner",
        roles: ["owner"],
        capabilities: capabilitiesFor(["owner"]),
      };
    await service.pull(user);
    const id = randomUUID(),
      recordId = randomUUID(),
      payload = {
        ...structuredClone(
          entityDefinitions.find((d) => d.type === "events")!.defaults,
        ),
        slug: "replay-" + recordId,
        title: { "es-pe": "Evento", en: "Event" },
        description: { "es-pe": "Evento local.", en: "Local event." },
        date: "2027-02-10",
        city: { "es-pe": "Lima", en: "Lima" },
        venue: "Fixture",
        speakerIds: [],
      };
    const body = {
      recordId,
      baseCommit: remote.head(),
      baseRecordHash: null,
      payload,
      desiredStatus: "published" as const,
    };
    const draft = await service.save(user, id, body),
      key = randomUUID();
    let pending: any;
    transport.commitDirect = async (input, attempt) => {
      pending = { input, attempt };
      throw Error("response lost while original may still execute");
    };
    await assert.rejects(
      service.propose(user, [{ id, expectedVersion: draft.version }], key),
      { code: "PUBLICATION_UNCERTAIN" },
    );
    if (stage === "absent-conflict") {
      await original.commit(
        {
          ...pending.input,
          files: pending.input.files.map((f: any) => ({
            ...f,
            record: { ...f.record, venue: "Another administrator" },
          })),
        },
        { ...pending.attempt, id: "other-administrator" },
      );
      await assert.rejects(
        service.propose(user, [{ id, expectedVersion: draft.version }], key),
        { code: "REMOTE_RECORD_CONFLICT" },
      );
      const dto = await service.draftDTO(await service.draftRow(user, id));
      assert.equal(dto.submission?.state, "conflict");
      assert.equal(dto.submission?.canEdit, true);
      await service.save(user, id, body, draft.version);
      assert.equal(remote.proofs.size, 1);
      continue;
    }
    if (stage === "inspect")
      transport.inspectDirect = async () => {
        throw Error("inspection unavailable");
      };
    if (stage === "snapshot")
      transport.snapshot = async () => {
        throw Error("immutable read unavailable");
      };
    if (stage === "hashes")
      transport.hashesDirect = async () => {
        throw Error("hash read unavailable");
      };
    if (stage === "validation")
      transport.snapshot = async (commit?: string) => ({
        commit: commit!,
        records: [
          {
            type: "events",
            record: { id: "invalid", status: "published" } as any,
          },
        ],
      });
    await assert.rejects(
      service.propose(user, [{ id, expectedVersion: draft.version }], key),
      { code: "PUBLICATION_UNCERTAIN" },
    );
    const row = await service.draftRow(user, id),
      dto = await service.draftDTO(row);
    assert.equal(dto.state, "unknown");
    assert.equal(dto.submission?.canEdit, false);
    await assert.rejects(
      service.save(
        user,
        id,
        { ...body, payload: { ...payload, venue: "Later local edit" } },
        draft.version,
      ),
      { code: "SUBMISSION_PENDING" },
    );
    await assert.rejects(service.discard(user, id, draft.version), {
      code: "SUBMISSION_PENDING",
    });
    transport.snapshot = original.snapshot;
    transport.hashesDirect = original.hashes;
    transport.inspectDirect = original.inspect;
    transport.commitDirect = original.commit;
    await original.commit(pending.input, pending.attempt);
    const recovered = await service.reconcile(user, id);
    assert.equal(recovered.submission?.state, "committed");
    assert.equal(remote.proofs.size, 1);
  }
});

test("generic SQL publication cannot bypass the configured GitHub Events draft authority", async () => {
  const remote = directRemote(),
    publisher = new WebsitePublisher(
      pool,
      {
        config,
        eventsAuthority: "github",
        transport: remote.view(["events", "speakers"]),
      },
      exporter,
    ),
    id = randomUUID();
  const payload = structuredClone(
    entityDefinitions.find((d) => d.type === "events")!.defaults,
  );
  await pool.query(
    "INSERT INTO records(id,community_id,type,scope,author_id,payload,state,revision_hash,updated_at)VALUES($1,$2,'events','public',$3,$4,'draft',$5,now())",
    [id, COMMUNITY_ID, actor, payload, hashRevision(payload)],
  );
  await assert.rejects(
    publisher.create(COMMUNITY_ID, actor, [id], randomUUID(), { [id]: 1 }),
    { code: "EDITORIAL_AUTHORITY_REQUIRED" },
  );
  assert.equal(remote.proofs.size, 0);
});
