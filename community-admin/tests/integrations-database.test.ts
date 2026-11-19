import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createPool } from "../src/server/db";
import { enqueue, OutboxWorker } from "../src/server/worker/outbox";
import {
  IntegrationError,
  hashValue,
} from "../src/server/integrations/security";
import { IntegrationService } from "../src/server/integrations/service";
import { GitHub } from "../src/server/integrations/github";
const schema = `test_${randomUUID().replaceAll("-", "")}`,
  community = "00000000-0000-4000-8000-000000000001",
  actor = "10000000-0000-4000-8000-000000000007";
let pool: ReturnType<typeof createPool>;
before(async () => {
  assert.ok(process.env.DATABASE_URL);
  pool = createPool(process.env.DATABASE_URL!, schema);
  await pool.query(`CREATE SCHEMA "${schema}"`);
  for (const name of [
    "001_memories.sql",
    "002_product.sql",
    "003_integrations.sql",
  ])
    await pool.query(await readFile(`migrations/${name}`, "utf8"));
});
after(async () => {
  await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await pool.end();
});
const intent = () => ({
  communityId: community,
  actorId: actor,
  kind: "publication",
  subjectId: randomUUID(),
  key: randomUUID(),
  payload: { text: "fixture" },
});
test("PG outbox idempotent intent, hash conflict and concurrent claims", async () => {
  const i = intent(),
    a = await enqueue(pool, i),
    b = await enqueue(pool, i);
  assert.equal(a.id, b.id);
  await assert.rejects(
    enqueue(pool, { ...i, payload: { text: "changed" } }),
    /IDEMPOTENCY_CONFLICT/,
  );
  const workers = [new OutboxWorker(pool), new OutboxWorker(pool)];
  const claimed = await Promise.all(workers.map((w) => w.claim()));
  assert.equal(claimed.filter(Boolean).length, 1);
  await workers[0]
    .heartbeat(a.id)
    .catch(async () => workers[1].heartbeat(a.id));
  await pool.query("UPDATE worker_outbox SET state='complete' WHERE id=$1", [
    a.id,
  ]);
});
test("expired sending lease becomes unknown and is never resent", async () => {
  const op = await enqueue(pool, intent());
  await pool.query(
    "UPDATE worker_outbox SET state='sending',lease_until=now()-interval '1 second' WHERE id=$1",
    [op.id],
  );
  assert.equal(await new OutboxWorker(pool).claim(), undefined);
  assert.equal(
    (await pool.query("SELECT state FROM worker_outbox WHERE id=$1", [op.id]))
      .rows[0].state,
    "unknown",
  );
});
test("ambiguous sender result is unknown with one attempt; bounded retries deadletter", async () => {
  const op = await enqueue(pool, intent()),
    worker = new OutboxWorker(pool);
  let calls = 0;
  await worker.runOne(
    async () => {
      calls++;
      throw new IntegrationError("TIMEOUT", 503, true);
    },
    async () => {},
  );
  await worker.runOne(
    async () => {
      calls++;
    },
    async () => {},
  );
  assert.equal(calls, 1);
  assert.equal(
    (await pool.query("SELECT state FROM worker_outbox WHERE id=$1", [op.id]))
      .rows[0].state,
    "unknown",
  );
  const retry = await enqueue(pool, intent());
  for (let i = 0; i < 3; i++) {
    await pool.query(
      "UPDATE worker_outbox SET available_at=now() WHERE id=$1",
      [retry.id],
    );
    await worker.runOne(
      async () => {
        throw new IntegrationError("RATE_LIMIT", 503, false, 1);
      },
      async () => {},
    );
  }
  assert.equal(
    (
      await pool.query("SELECT state FROM worker_outbox WHERE id=$1", [
        retry.id,
      ])
    ).rows[0].state,
    "deadletter",
  );
});
test("publication schedule and outbox atomic, author revocation and cancellation block sends", async () => {
  const service = new IntegrationService({ pool }),
    id = randomUUID(),
    hash = hashValue({ text: "approved" }),
    reviewer = "10000000-0000-4000-8000-000000000002";
  await pool.query(
    "INSERT INTO integration_publications(id,community_id,author_id,reviewer_id,channel,destination,payload,revision_hash,approved_hash,state) VALUES($1,$2,$3,$4,'manual','manual',$5,$6,$6,'approved')",
    [id, community, actor, reviewer, { text: "approved" }, hash],
  );
  const scheduled = new Date();
  await pool.query(
    "UPDATE integration_publications SET schedule_at=$2 WHERE id=$1",
    [id, scheduled],
  );
  const op = await service.schedule(
    community,
    actor,
    id,
    hash,
    scheduled,
    "America/Lima",
    "",
    randomUUID(),
  );
  await service.validateOperation(op);
  await pool.query("UPDATE users SET active=false WHERE id=$1", [actor]);
  await assert.rejects(service.validateOperation(op), /ACTOR_REVOKED/);
  await pool.query("UPDATE users SET active=true WHERE id=$1", [actor]);
  await service.cancel(community, id, 1, hash, actor, "Synthetic cancellation");
  assert.equal(
    (await pool.query("SELECT state FROM worker_outbox WHERE id=$1", [op.id]))
      .rows[0].state,
    "cancelled",
  );
  await assert.rejects(service.validateOperation(op), /CANCELLED/);
});
test("credential ciphertext persisted and webhook replay deduplicated", async () => {
  const service = new IntegrationService({
    pool,
    secretKey: Buffer.alloc(32, 8),
    webhookSecret: "fixture",
    github: new GitHub({
      appId: "1",
      installationId: "1",
      privateKey: "unused",
      owner: "fixture",
      repo: "website",
      enabled: false,
      requiredChecks: [],
      requiredApprovals: 1,
    }),
  });
  await service.connect(
    community,
    "linkedin",
    "urn:li:organization:1",
    ["scope"],
    { accessToken: "never-plaintext" },
    {},
  );
  const row = (await pool.query("SELECT * FROM integration_accounts")).rows[0];
  assert.equal(row.encrypted_secret.includes("never-plaintext"), false);
  const body = Buffer.from(
      JSON.stringify({ repository: { full_name: "fixture/website" } }),
    ),
    sig =
      "sha256=" + createHmac("sha256", "fixture").update(body).digest("hex"),
    id = randomUUID();
  assert.equal((await service.webhook(id, sig, body)).duplicate, false);
  assert.equal((await service.webhook(id, sig, body)).duplicate, true);
  await assert.rejects(
    service.webhook(randomUUID(), "invalid", body),
    /INVALID_WEBHOOK/,
  );
});
test("video multipart rejects bad checksums and verifies bounded synthetic local MP4 header", async () => {
  const { VideoAssets } = await import("../src/server/integrations/video");
  const { createHash } = await import("node:crypto");
  const assets = new VideoAssets(pool);
  const bytes = Buffer.alloc(64);
  bytes.write("ftyp", 4);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const upload = await assets.begin(
      community,
      actor,
      bytes.length,
      "video/mp4",
      sha,
    ),
    descriptor = await assets.descriptor(community, upload.id, 1);
  assert.equal(descriptor.url, `/api/video/uploads/${upload.id}/parts/1`);
  await assert.rejects(
    assets.localPart(community, upload.id, 1, Buffer.alloc(1)),
    /UPLOAD_PART_SIZE/,
  );
  const part = await assets.localPart(community, upload.id, 1, bytes);
  const complete = await assets.complete(community, upload.id, [part]);
  assert.equal(complete.state, "verified");
  assert.deepEqual(
    await assets.read(community, upload.id, 0, 8),
    bytes.subarray(0, 8),
  );
  await pool.query(
    "UPDATE integration_video_assets SET expires_at=now()-interval '1 second' WHERE id=$1",
    [upload.id],
  );
  assert.equal(await assets.cleanup(), 1);
});
test("approval binds schedule and semantic intent prevents duplicate sends with a new key", async () => {
  const service = new IntegrationService({ pool }),
    id = randomUUID(),
    hash = hashValue({ fixture: "schedule" }),
    at = new Date(),
    reviewer = "10000000-0000-4000-8000-000000000002";
  await pool.query(
    "INSERT INTO integration_publications(id,community_id,author_id,reviewer_id,channel,destination,payload,revision_hash,approved_hash,state,schedule_at) VALUES($1,$2,$3,$4,'manual','manual',$5,$6,$6,'approved',$7)",
    [id, community, actor, reviewer, { text: "fixture" }, hash, at],
  );
  await assert.rejects(
    service.schedule(
      community,
      actor,
      id,
      hash,
      new Date(at.getTime() + 60000),
      "America/Lima",
      "",
      randomUUID(),
    ),
    /SCHEDULE_APPROVAL_REQUIRED/,
  );
  const a = await service.schedule(
      community,
      actor,
      id,
      hash,
      at,
      "America/Lima",
      "",
      randomUUID(),
    ),
    b = await service.schedule(
      community,
      actor,
      id,
      hash,
      at,
      "America/Lima",
      "",
      randomUUID(),
    );
  assert.equal(a.id, b.id);
  await service.tick();
  const done = (
    await pool.query("SELECT state FROM integration_publications WHERE id=$1", [
      id,
    ])
  ).rows[0];
  assert.equal(done.state, "manual-export");
  await assert.rejects(service.validateOperation(a), /PUBLICATION_STATE/);
});
test("webhook payload replay with a changed delivery ID is still deduplicated", async () => {
  const service = new IntegrationService({
    pool,
    webhookSecret: "fixture",
    github: new GitHub({
      appId: "1",
      installationId: "1",
      privateKey: "unused",
      owner: "fixture",
      repo: "website",
      enabled: false,
      requiredChecks: [],
      requiredApprovals: 1,
    }),
  });
  const body = Buffer.from(
      JSON.stringify({
        repository: { full_name: "fixture/website" },
        action: "unique-fixture",
      }),
    ),
    sig =
      "sha256=" + createHmac("sha256", "fixture").update(body).digest("hex");
  assert.equal(
    (await service.webhook(randomUUID(), sig, body)).duplicate,
    false,
  );
  assert.equal(
    (await service.webhook(randomUUID(), sig, body)).duplicate,
    true,
  );
});
test("social OAuth state is single-use, actor-bound and backend tokens encrypted", async () => {
  const { SocialOAuth } = await import("../src/server/integrations/oauth");
  const service = new IntegrationService({
    pool,
    liveEnabled: true,
    secretKey: Buffer.alloc(32, 5),
  });
  const owner = "10000000-0000-4000-8000-000000000004";
  let calls = 0;
  const oauth = new SocialOAuth(
    service,
    async (url, options) => {
      calls++;
      if (url.includes("/token")) {
        assert.match(String(options?.body), /code_verifier=/);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(
            JSON.stringify({
              access_token: "oauth-fixture-secret",
              refresh_token: "fixture-refresh",
              expires_in: 3600,
              scope:
                "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
            }),
          ),
        };
      }
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from(
          JSON.stringify({ items: [{ id: "fixture-channel" }] }),
        ),
      };
    },
    () => ({
      clientId: "fixture",
      clientSecret: "fixture-secret",
      redirectUri:
        "http://127.0.0.1:4455/api/integrations/youtube/oauth/callback",
      scopes: [
        "https://www.googleapis.com/auth/youtube.upload",
        "https://www.googleapis.com/auth/youtube.readonly",
      ],
    }),
  );
  const start = await oauth.begin(
      "youtube",
      community,
      owner,
      "fixture-channel",
    ),
    url = new URL(start.url),
    state = url.searchParams.get("state")!;
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const connected = await oauth.callback("youtube", state, "fixture-code");
  assert.equal(connected.health, "connected");
  assert.equal(
    JSON.stringify(connected).includes("oauth-fixture-secret"),
    false,
  );
  await assert.rejects(
    oauth.callback("youtube", state, "fixture-code"),
    /OAUTH_STATE_INVALID/,
  );
  const second = await oauth.begin(
    "youtube",
    community,
    owner,
    "fixture-channel",
  );
  await pool.query("UPDATE users SET active=false WHERE id=$1", [owner]);
  const before = calls;
  await assert.rejects(
    oauth.callback(
      "youtube",
      new URL(second.url).searchParams.get("state")!,
      "code",
    ),
    /ACTOR_REVOKED/,
  );
  assert.equal(calls, before);
  await pool.query("UPDATE users SET active=true WHERE id=$1", [owner]);
});
test("YouTube processing remains private until ready and approved visibility is applied once", async () => {
  const { YouTube } = await import("../src/server/integrations/social");
  const youtube = new YouTube(async () => {
    throw new Error("Unexpected transport");
  });
  let reads = 0,
    published = false,
    visibilityCalls = 0;
  youtube.read = async () => ({
    id: "fixture-video",
    state: published
      ? "published"
      : reads++ === 0
        ? "processing"
        : "uploaded-private",
    visibility: published ? "public" : "private",
    url: "https://www.youtube.com/watch?v=fixture-video",
  });
  youtube.visibility = async () => {
    visibilityCalls++;
    published = true;
    return {};
  };
  const service = new IntegrationService({
    pool,
    liveEnabled: true,
    secretKey: Buffer.alloc(32, 6),
    youtube,
  });
  await service.connect(
    community,
    "youtube",
    "fixture-channel",
    [
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube.force-ssl",
    ],
    { accessToken: "fixture" },
    {},
  );
  const id = randomUUID(),
    hash = hashValue({ fixture: "processing" }),
    at = new Date(),
    reviewer = "10000000-0000-4000-8000-000000000002";
  await pool.query(
    "INSERT INTO integration_publications(id,community_id,author_id,reviewer_id,channel,destination,payload,revision_hash,approved_hash,state,schedule_at,remote_id) VALUES($1,$2,$3,$4,'youtube','fixture-channel',$5,$6,$6,'uploaded-private',$7,'fixture-video')",
    [id, community, actor, reviewer, { desiredVisibility: "public" }, hash, at],
  );
  const operation = await enqueue(pool, {
    communityId: community,
    actorId: actor,
    kind: "video-process",
    subjectId: id,
    key: randomUUID(),
    payload: {
      revisionHash: hash,
      destination: "fixture-channel",
      schedule: at.toISOString(),
      dependencyId: null,
    },
  });
  await service.tick();
  assert.equal(
    (
      await pool.query(
        "SELECT state FROM integration_publications WHERE id=$1",
        [id],
      )
    ).rows[0].state,
    "processing",
  );
  assert.equal(visibilityCalls, 0);
  await pool.query("UPDATE worker_outbox SET available_at=now() WHERE id=$1", [
    operation.id,
  ]);
  await service.tick();
  assert.equal(
    (
      await pool.query(
        "SELECT state FROM integration_publications WHERE id=$1",
        [id],
      )
    ).rows[0].state,
    "published",
  );
  assert.equal(visibilityCalls, 1);
});
test("curated jobs create one website changeset and later editorial changes invalidate it", async () => {
  const { normalizeJob } = await import("../src/server/jobs/engine");
  const job = {
    ...normalizeJob(
      {
        id: "fixture-db",
        text: "Platform Engineer",
        location: { name: "Peru" },
        content: "Work Mode: Hybrid",
        absolute_url: "https://boards.greenhouse.io/fixture/jobs/1",
      },
      {
        id: "fixture",
        adapter: "greenhouse",
        boardIdentifier: "fixture",
        company: "Fixture",
      },
      new Date(),
    ),
    approved: true,
    status: "active",
    summary: { "es-pe": "Descripción revisada.", en: "Reviewed summary." },
  };
  await pool.query(
    "INSERT INTO job_records(id,community_id,source_id,payload) VALUES($1,$2,$3,$4)",
    [job.id, community, "fixture", job],
  );
  const service = new IntegrationService({ pool }),
    key = randomUUID(),
    a = await service.createJobsChangeset(community, actor, [job.id], key),
    b = await service.createJobsChangeset(community, actor, [job.id], key);
  assert.equal(a.id, b.id);
  await service.validateOperation(a);
  const row = (
    await pool.query("SELECT files FROM integration_changesets WHERE id=$1", [
      a.subject_id,
    ])
  ).rows[0];
  assert.equal(row.files[0].path, `content/jobs/${job.id}.json`);
  assert.equal(row.files[0].baseEntityHash, null);
  await pool.query(
    "UPDATE job_records SET payload=jsonb_set(payload,'{title}','\"Changed\"') WHERE id=$1",
    [job.id],
  );
  await assert.rejects(service.validateOperation(a), /APPROVAL_REVOKED/);
  await pool.query("UPDATE worker_outbox SET state='cancelled' WHERE id=$1", [
    a.id,
  ]);
});
test("content changeset request retry preserves deterministic subject ID", async () => {
  const record = randomUUID(),
    service = new IntegrationService({
      pool,
      exportRecords: async () => ({
        files: [{ path: `content/memories/${record}.json`, content: "{}" }],
        revisionHashes: { [record]: "revision" },
      }),
    }),
    key = randomUUID(),
    a = await service.createChangeset(community, actor, [record], key),
    b = await service.createChangeset(community, actor, [record], key);
  assert.equal(a.id, b.id);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::integer AS n FROM integration_changesets WHERE id=$1",
        [a.subject_id],
      )
    ).rows[0].n,
    1,
  );
  await pool.query("UPDATE worker_outbox SET state='cancelled' WHERE id=$1", [
    a.id,
  ]);
});
test("core asset bridge requires invoking community and rejects a foreign asset ID", async () => {
  const { VideoAssets } = await import("../src/server/integrations/video");
  const { fullIntegrationOptions } =
    await import("../src/server/integration-bridge");
  const { createHash } = await import("node:crypto");
  const assets = new VideoAssets(pool),
    bytes = Buffer.alloc(64);
  bytes.write("ftyp", 4);
  const upload = await assets.begin(
    community,
    actor,
    bytes.length,
    "video/mp4",
    createHash("sha256").update(bytes).digest("hex"),
  );
  const part = await assets.localPart(community, upload.id, 1, bytes);
  await assets.complete(community, upload.id, [part]);
  const bridge = fullIntegrationOptions(pool);
  await assert.rejects(
    bridge.readAsset(upload.id, 0, 8),
    /VIDEO_COMMUNITY_REQUIRED/,
  );
  await assert.rejects(
    bridge.readAsset(upload.id, 0, 8, "00000000-0000-4000-8000-000000000099"),
    /VIDEO_NOT_FOUND/,
  );
  assert.deepEqual(
    await bridge.readAsset(upload.id, 0, 8, community),
    bytes.subarray(0, 8),
  );
  await pool.query(
    "UPDATE integration_video_assets SET expires_at=now()-interval '1 second' WHERE id=$1",
    [upload.id],
  );
  await assets.cleanup();
});
test("AC05 concurrent fresh request keys and record permutations share one approved changeset and PR", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const ids = [randomUUID(), randomUUID()];
  let revision = "approved-v1",
    pr: any = null,
    prCreates = 0;
  const response = (data: any, status = 200) => ({
    status,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(data)),
  });
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const github = new GitHub(
    {
      appId: "1",
      installationId: "1",
      privateKey,
      owner: "fixture",
      repo: "website",
      enabled: true,
      requiredChecks: ["Validate website"],
      requiredApprovals: 1,
    },
    async (url, options) => {
      if (url.endsWith("/access_tokens"))
        return response({ token: "fixture", expires_at: "2099-01-01" });
      if (url.includes("/pulls?")) return response(pr ? [pr] : []);
      if (url.endsWith("/git/ref/heads/main"))
        return response({ object: { sha: "main" } });
      if (url.endsWith("/git/commits/main"))
        return response({ tree: { sha: "base" } });
      if (url.includes("/git/ref/heads/content/")) return response({}, 404);
      if (url.endsWith("/git/blobs")) return response({ sha: "blob" });
      if (url.endsWith("/git/trees")) return response({ sha: "tree" });
      if (url.endsWith("/git/commits")) return response({ sha: "head" });
      if (url.endsWith("/git/refs")) return response({});
      if (url.endsWith("/pulls")) {
        prCreates++;
        pr = {
          number: 99,
          head: { sha: "head" },
          body: JSON.parse(String(options?.body)).body,
        };
        return response(pr, 201);
      }
      throw new Error("Unexpected fixture endpoint: " + url);
    },
  );
  const service = new IntegrationService({
    pool,
    liveEnabled: true,
    github,
    exportRecords: async (_db, _community, recordIds) => ({
      files: recordIds.map((id) => ({
        path: `content/memories/${id}.json`,
        content: JSON.stringify({ id }),
      })),
      revisionHashes: Object.fromEntries(recordIds.map((id) => [id, revision])),
    }),
  });
  const keyA = randomUUID(),
    keyB = randomUUID();
  const [a, b] = await Promise.all([
    service.createChangeset(community, actor, ids, keyA),
    service.createChangeset(community, actor, [...ids].reverse(), keyB),
  ]);
  assert.equal(a.id, b.id);
  assert.equal(a.subject_id, b.subject_id);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::integer AS n FROM worker_outbox WHERE subject_id=$1",
        [a.subject_id],
      )
    ).rows[0].n,
    1,
  );
  await service.tick();
  assert.equal(prCreates, 1);
  const again = await service.createChangeset(
    community,
    actor,
    ids,
    randomUUID(),
  );
  assert.equal(again.id, a.id);
  await service.tick();
  assert.equal(prCreates, 1);
  revision = "approved-v2";
  await assert.rejects(
    service.createChangeset(community, actor, ids, keyB),
    /IDEMPOTENCY_CONFLICT/,
  );
  const changed = await service.createChangeset(
    community,
    actor,
    ids,
    randomUUID(),
  );
  assert.notEqual(changed.subject_id, a.subject_id);
  await pool.query("UPDATE worker_outbox SET state='cancelled' WHERE id=$1", [
    changed.id,
  ]);
});

test("changeset retry reuses failed operation and refuses ambiguous sends", async () => {
  const id = randomUUID(),
    service = new IntegrationService({
      pool,
      exportRecords: async () => ({
        files: [{ path: `content/memories/${id}.json`, content: "{}" }],
        revisionHashes: { [id]: "approved" },
      }),
    });
  const operation = await service.createChangeset(
    community,
    actor,
    [id],
    randomUUID(),
  );
  await pool.query(
    "UPDATE worker_outbox SET state='failed',attempts=3 WHERE id=$1",
    [operation.id],
  );
  const retried = await service.retryChangeset(
    community,
    actor,
    operation.subject_id,
  );
  assert.equal(retried.id, operation.id);
  assert.equal(retried.state, "queued");
  await pool.query("UPDATE worker_outbox SET state='unknown' WHERE id=$1", [
    operation.id,
  ]);
  await assert.rejects(
    service.retryChangeset(community, actor, operation.subject_id),
    /RECONCILE_REQUIRED/,
  );
  await pool.query("UPDATE worker_outbox SET state='cancelled' WHERE id=$1", [
    operation.id,
  ]);
});

test("unknown changeset reconciliation only looks up its branch and recovers the same PR", async () => {
  const record = randomUUID();
  let lookups = 0,
    found = false;
  const github = {
    config: { owner: "fixture", repo: "website" },
    root: "/repos/fixture/website",
    request: async (method: string) => {
      assert.equal(method, "GET");
      lookups++;
      return found
        ? [
            {
              number: 99,
              body: `export-hash:${hashValue([{ path: `content/memories/${record}.json`, content: "{}" }])}`,
            },
          ]
        : [];
    },
    status: async (number: number) => {
      assert.equal(number, 99);
      return {
        state: "pr_open",
        headSha: "head",
        mergedSha: null,
        deployedSha: null,
      };
    },
  } as unknown as GitHub;
  const service = new IntegrationService({
    pool,
    github,
    liveEnabled: true,
    exportRecords: async () => ({
      files: [{ path: `content/memories/${record}.json`, content: "{}" }],
      revisionHashes: { [record]: "approved" },
    }),
  });
  const op = await service.createChangeset(
    community,
    actor,
    [record],
    randomUUID(),
  );
  await pool.query("UPDATE worker_outbox SET state='unknown' WHERE id=$1", [
    op.id,
  ]);
  await assert.rejects(
    service.reconcileChangeset(community, op.subject_id),
    /RECONCILE_PENDING/,
  );
  assert.equal(
    (await pool.query("SELECT state FROM worker_outbox WHERE id=$1", [op.id]))
      .rows[0].state,
    "unknown",
  );
  found = true;
  const result = await service.reconcileChangeset(community, op.subject_id);
  assert.equal(result.state, "pr_open");
  assert.equal(lookups, 2);
  assert.equal(
    (await pool.query("SELECT state FROM worker_outbox WHERE id=$1", [op.id]))
      .rows[0].state,
    "complete",
  );
});

test("changeset identity includes repository and queued intent cannot switch targets", async () => {
  const record = randomUUID();
  const github = {
    config: { owner: "fixture", repo: "one" },
  } as unknown as GitHub;
  const service = new IntegrationService({
    pool,
    github,
    exportRecords: async () => ({
      files: [{ path: `content/memories/${record}.json`, content: "{}" }],
      revisionHashes: { [record]: "approved" },
    }),
  });
  const one = await service.createChangeset(
    community,
    actor,
    [record],
    randomUUID(),
  );
  github.config.repo = "two";
  await assert.rejects(
    service.validateOperation(one),
    /TARGET_REPOSITORY_CHANGED/,
  );
  const two = await service.createChangeset(
    community,
    actor,
    [record],
    randomUUID(),
  );
  assert.notEqual(two.subject_id, one.subject_id);
  await service.validateOperation(two);
  await pool.query(
    "UPDATE worker_outbox SET state='cancelled' WHERE id=ANY($1::uuid[])",
    [[one.id, two.id]],
  );
});

test("confirmed merge advances exact public source baseline and preserves newer drafts", async () => {
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const capturedHashes = Object.fromEntries(
    ids.map((id) => [id, "approved-revision"]),
  );
  const merged = Object.fromEntries(
    ids.map((id, index) => [
      id,
      {
        id,
        status: index < 2 ? "archived" : "published",
        title: "actual merged JSON",
      },
    ]),
  );
  for (const [index, id] of ids.entries())
    await pool.query(
      "INSERT INTO records(id,community_id,type,scope,author_id,payload,revision,state,revision_hash,approved_hash,source_hash,source_commit,updated_at,desired_status) VALUES($1,$2,'resources','public',$3,$4,$5,$6,$7,$8,'old-source','old-commit',now(),$9)",
      [
        id,
        community,
        actor,
        { title: "local payload" },
        index === 1 ? 2 : 1,
        index === 1 ? "draft" : "approved",
        index === 1 ? "newer-revision" : "approved-revision",
        index === 1 ? null : "approved-revision",
        index < 2 ? "archived" : "published",
      ],
    );
  let confirmed = false;
  const sha = "a".repeat(40);
  let reads = 0;
  const github = {
    config: { owner: "fixture", repo: "website" },
    root: "/repos/fixture/website",
    status: async () => ({
      state: confirmed ? "merged" : "checks_passed",
      headSha: "head",
      mergedSha: confirmed ? sha : null,
      deployedSha: null,
    }),
    request: async (method: string, path: string) => {
      assert.equal(method, "GET");
      assert.ok(path.endsWith("?ref=" + sha));
      reads++;
      const id = path.split("/").pop()!.split(".json")[0];
      return {
        encoding: "base64",
        content: Buffer.from(JSON.stringify(merged[id])).toString("base64"),
      };
    },
  } as unknown as GitHub;
  const service = new IntegrationService({
    pool,
    github,
    liveEnabled: true,
    exportRecords: async () => ({
      files: ids.map((id) => ({
        path: `content/resources/${id}.json`,
        content: JSON.stringify({ ...merged[id], title: "captured export" }),
      })),
      revisionHashes: capturedHashes,
    }),
  });
  const op = await service.createChangeset(community, actor, ids, randomUUID());
  await pool.query(
    "UPDATE integration_changesets SET pr_number=1 WHERE id=$1",
    [op.subject_id],
  );
  await service.reconcileChangeset(community, op.subject_id);
  assert.equal(reads, 0);
  assert.equal(
    (await pool.query("SELECT source_hash FROM records WHERE id=$1", [ids[0]]))
      .rows[0].source_hash,
    "old-source",
  );
  confirmed = true;
  await service.reconcileChangeset(community, op.subject_id);
  for (const [index, id] of ids.entries()) {
    const row = (await pool.query("SELECT * FROM records WHERE id=$1", [id]))
      .rows[0];
    assert.equal(row.source_hash, hashValue(merged[id]));
    assert.equal(row.source_commit, sha);
    assert.deepEqual(row.payload, { title: "local payload" });
    assert.equal(row.revision, index === 1 ? 2 : 1);
    assert.equal(
      row.revision_hash,
      index === 1 ? "newer-revision" : "approved-revision",
    );
    assert.equal(
      row.state,
      index === 0 ? "archived" : index === 1 ? "draft" : "approved",
    );
  }
  const beforeReplay = reads;
  await pool.query(
    "UPDATE records SET source_hash='newer-baseline',source_commit=$2 WHERE id=$1",
    [ids[0], "b".repeat(40)],
  );
  await service.reconcileChangeset(community, op.subject_id);
  assert.equal(reads, beforeReplay);
  assert.equal(
    (await pool.query("SELECT source_hash FROM records WHERE id=$1", [ids[0]]))
      .rows[0].source_hash,
    "newer-baseline",
  );
  await pool.query("UPDATE worker_outbox SET state='cancelled' WHERE id=$1", [
    op.id,
  ]);
});
