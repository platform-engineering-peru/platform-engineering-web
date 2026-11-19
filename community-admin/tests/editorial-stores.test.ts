import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createPool, migrate, COMMUNITY_ID } from "../src/server/db";
import { createApp } from "../src/server/app";
import { EditorialService } from "../src/server/editorial-sync/service";
import { eventProjection } from "../src/server/editorial-sync/validation";
import { entityDefinitions } from "../src/shared/product-contract";
import { hashRevision } from "../src/shared/content";
import { FakeEditorialGitHub } from "./helpers/editorial-fixture";
import type { Session } from "../src/server/context";
const config = {
  mode: "github" as const,
  repository: "example/community",
  branch: "main",
  remoteWritesEnabled: true,
};
const user: Session = {
  id: "10000000-0000-4000-8000-000000000004",
  communityId: COMMUNITY_ID,
  name: "Isolated owner",
  role: "owner",
  roles: ["owner"],
  capabilities: ["*"],
  csrfToken: "",
  isFixture: true,
};
const stores: {
  name: string;
  pool: ReturnType<typeof createPool>;
  service: EditorialService;
}[] = [];
const eventId = "30000000-0000-4000-8000-000000000001",
  event2 = "30000000-0000-4000-8000-000000000002";
const payload = (order = 10) => ({
  ...structuredClone(
    entityDefinitions.find((d) => d.type === "events")!.defaults,
  ),
  slug: "event-" + order,
  title: { "es-pe": "Evento " + order, en: "Event " + order },
  description: { "es-pe": "Prueba aislada.", en: "Isolated test." },
  city: { "es-pe": "Lima", en: "Lima" },
  date: "2026-12-01",
  venue: "Test site",
  displayOrder: order,
});
let github: FakeEditorialGitHub;
before(async () => {
  github = new FakeEditorialGitHub([
    {
      type: "events",
      record: await eventProjection(eventId, payload(), "published"),
    },
    {
      type: "events",
      record: await eventProjection(event2, payload(20), "published"),
    },
  ]);
  for (let i = 0; i < 3; i++) {
    const name = "test_editorial_" + randomUUID().replaceAll("-", ""),
      pool = createPool(process.env.DATABASE_URL!, name);
    await migrate(pool, name);
    stores.push({
      name,
      pool,
      service: new EditorialService(pool, config, github, true),
    });
  }
});
after(async () => {
  for (const s of stores) {
    await s.pool.query(`DROP SCHEMA "${s.name}" CASCADE`);
    await s.pool.end();
  }
});
async function draft(
  store: number,
  recordId = eventId,
  patch: Record<string, any> = {},
) {
  const service = stores[store].service,
    snapshot = await service.events(user),
    record = snapshot.records.find((r: any) => r.id === recordId),
    def = entityDefinitions.find((d) => d.type === "events")!;
  const input = {
    recordId,
    baseCommit: snapshot.commit,
    baseRecordHash: snapshot.recordHashes[recordId] ?? null,
    payload: {
      ...Object.fromEntries(
        def.fields.map((f) => [f.key, record?.[f.key] ?? def.defaults[f.key]]),
      ),
      ...patch,
    },
    desiredStatus: "published" as const,
  };
  return service.save(user, randomUUID(), input);
}
test("three independent stores share only approved Git snapshots; merge appears only after pull", async () => {
  for (const s of stores) await s.service.pull(user);
  const baseline = (await stores[1].service.events(user)).commit;
  const a = await draft(0, eventId, { venue: "Proposed venue A" }),
    b = await draft(1, eventId, { venue: "Local venue B" });
  const proposed = await stores[0].service.propose(
    user,
    [{ id: a.id, expectedVersion: 1 }],
    randomUUID(),
  );
  assert.equal(proposed.items[0].state, "proposed");
  assert.equal(
    (await stores[2].service.events(user)).records[0].venue,
    "Test site",
  );
  github.merge("editorial/" + proposed.proposal.marker);
  const reconciled = await stores[0].service.reconcile(user, a.id);
  assert.equal(reconciled.state, "merged");
  assert.equal((await stores[2].service.events(user)).commit, baseline);
  await stores[2].service.pull(user);
  assert.equal(
    (await stores[2].service.events(user)).records.find(
      (r: any) => r.id === eventId,
    ).venue,
    "Proposed venue A",
  );
  await assert.rejects(
    stores[1].service.propose(
      user,
      [{ id: b.id, expectedVersion: 1 }],
      randomUUID(),
    ),
    (e: any) => e.code === "REMOTE_RECORD_CONFLICT",
  );
  await stores[1].service.pull(user);
  const preserved = (await stores[1].service.drafts(user)).items.find(
    (r: any) => r.id === b.id,
  )!;
  assert.equal(preserved.state, "conflict");
  assert.equal(preserved.baseCommit, baseline);
  assert.equal(preserved.payload.venue, "Local venue B");
  assert.equal(preserved.conflict.remote.venue, "Proposed venue A");
  for (const s of stores)
    assert.equal(
      (await s.pool.query("SELECT count(*)::int AS n FROM records")).rows[0].n,
      0,
    );
});
test("disjoint records tolerate unrelated head advancement and atomic batches can swap order", async () => {
  const [a, b] = stores;
  await a.service.pull(user);
  await b.service.pull(user);
  const first = await draft(0, eventId, { venue: "Disjoint first" }),
    second = await draft(1, event2, { venue: "Disjoint second" });
  const p = await a.service.propose(
    user,
    [{ id: first.id, expectedVersion: 1 }],
    randomUUID(),
  );
  github.merge("editorial/" + p.proposal.marker);
  const q = await b.service.propose(
    user,
    [{ id: second.id, expectedVersion: 1 }],
    randomUUID(),
  );
  assert.equal(q.items[0].state, "proposed");
  github.merge("editorial/" + q.proposal.marker);
  await stores[2].service.pull(user);
  const x = await draft(2, eventId, { displayOrder: 20 }),
    y = await draft(2, event2, { displayOrder: 10 });
  await assert.rejects(
    stores[2].service.propose(
      user,
      [{ id: x.id, expectedVersion: 1 }],
      randomUUID(),
    ),
    (e: any) => e.code === "DUPLICATE_ORDER",
  );
  const batch = await stores[2].service.propose(
    user,
    [
      { id: x.id, expectedVersion: 1 },
      { id: y.id, expectedVersion: 1 },
    ],
    randomUUID(),
  );
  assert.equal(batch.items.length, 2);
  assert.equal(batch.proposal.files.length, 2);
});
test("offline saves preserve base; failed or invalid pulls retain last complete cache and dirty draft", async () => {
  const s = stores[0];
  await s.service.pull(user);
  const d = await draft(0, eventId, { venue: "OFFLINE_LOCAL_SENTINEL" }),
    before = await s.service.events(user);
  github.offline = true;
  await assert.rejects(s.service.pull(user));
  const cached = await s.service.events(user);
  assert.equal(cached.commit, before.commit);
  assert.equal(cached.fetchedAt, before.fetchedAt);
  assert.equal(cached.stale, true);
  const saved = await s.service.save(
    user,
    d.id,
    {
      recordId: d.recordId,
      baseCommit: d.baseCommit,
      baseRecordHash: d.baseRecordHash,
      payload: { ...d.payload, venue: "Offline edit" },
      desiredStatus: d.desiredStatus,
    },
    1,
  );
  assert.equal(saved.version, 2);
  github.offline = false;
  const good = structuredClone(github.records);
  github.approve([
    {
      type: "events",
      record: { ...good[0].record, privateNotes: "PRIVATE_SENTINEL" },
    },
  ]);
  await assert.rejects(s.service.pull(user));
  assert.equal((await s.service.events(user)).commit, before.commit);
  assert.equal(
    (await s.service.drafts(user)).items.find((r) => r.id === d.id)!.payload
      .venue,
    "Offline edit",
  );
  github.approve(good);
});
test("ambiguous create reconciles the same PR; repeated keys and new local revisions never resend", async () => {
  const s = stores[2];
  await s.service.pull(user);
  const d = await draft(2, eventId, { venue: "One proposal after timeout" }),
    key = randomUUID(),
    calls = github.createCalls;
  github.uncertainAfterCreate = true;
  await assert.rejects(
    s.service.propose(user, [{ id: d.id, expectedVersion: 1 }], key),
    (e: any) => e.code === "PROPOSAL_UNCERTAIN",
  );
  const retry = await s.service.propose(
    user,
    [{ id: d.id, expectedVersion: 1 }],
    key,
  );
  assert.equal(retry.items[0].state, "proposed");
  assert.equal(github.createCalls, calls + 1);
  const again = await s.service.propose(
    user,
    [{ id: d.id, expectedVersion: 1 }],
    randomUUID(),
  );
  assert.equal(again.proposal.number, retry.proposal.number);
  assert.equal(github.createCalls, calls + 1);
  await assert.rejects(
    s.service.propose(user, [{ id: d.id, expectedVersion: 2 }], key),
    (e: any) => e.code === "IDEMPOTENCY_CONFLICT",
  );
  const edited = await s.service.save(
    user,
    d.id,
    {
      recordId: d.recordId,
      baseCommit: d.baseCommit,
      baseRecordHash: d.baseRecordHash,
      payload: { ...d.payload, venue: "New revision separate intent" },
      desiredStatus: d.desiredStatus,
    },
    1,
  );
  assert.equal(edited.state, "local");
  assert.equal(edited.proposal, undefined);
  const newer = await s.service.propose(
    user,
    [{ id: d.id, expectedVersion: 2 }],
    randomUUID(),
  );
  assert.notEqual(newer.proposal.number, retry.proposal.number);
  github.proposals.get("editorial/" + newer.proposal.marker)!.state = "closed";
  assert.equal((await s.service.reconcile(user, d.id)).state, "closed");
});
test("local capabilities, CSRF, write opt-in and account identity remain enforced", async () => {
  const s = stores[0],
    origin = "http://127.0.0.1:4888";
  const app = createApp({
    pool: s.pool,
    media: [],
    origin,
    fixtureAuthEnabled: true,
    environment: "test",
    editorial: {
      config: { ...config, remoteWritesEnabled: false },
      transport: github,
      testTransport: true,
    },
  });
  const agent = request.agent(app),
    login = await agent
      .post("/api/dev/login")
      .set("Origin", origin)
      .send({ persona: "owner" });
  assert.equal(login.status, 200);
  const pull = await agent
    .post("/api/editorial/pull")
    .set("Origin", origin)
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({});
  assert.equal(pull.status, 200);
  assert.equal(
    (await agent.post("/api/editorial/pull").set("Origin", origin).send({}))
      .status,
    403,
  );
  const d = await draft(0, eventId, { venue: "Write-disabled draft" });
  const disabled = await agent
    .post(`/api/editorial/drafts/${d.id}/propose`)
    .set("Origin", origin)
    .set("X-CSRF-Token", login.body.csrfToken)
    .set("Idempotency-Key", randomUUID())
    .send({ expectedVersion: 1 });
  assert.equal(disabled.body.code, "REMOTE_WRITES_DISABLED");
  const privateInput = await agent
    .put("/api/editorial/drafts/" + randomUUID())
    .set("Origin", origin)
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({
      type: "people",
      recordId: eventId,
      baseCommit: pull.body.commit,
      baseRecordHash: null,
      payload: { email: "PRIVATE_SENTINEL" },
      desiredStatus: "published",
    });
  assert.equal(privateInput.status, 422);
  const realIdentity = new EditorialService(s.pool, config, github, false);
  await assert.rejects(
    realIdentity.identity(user),
    (e: any) => e.code === "AUTH_IDENTITY_MISMATCH",
  );
  assert.ok(
    !JSON.stringify((await agent.get("/api/editorial/status")).body).match(
      /accessToken|refreshToken|storageKey|password/,
    ),
  );
});

test("truncated/missing/malformed provider reads preserve the last successful cache and dirty base", async () => {
  const { GhEditorialTransport } =
    await import("../src/server/editorial-sync/github");
  const head = "a".repeat(40),
    blob = "b".repeat(40),
    record = await eventProjection(eventId, payload(), "published");
  let mode = "valid";
  const http = (value: unknown, status = 200) =>
    `HTTP/2.0 ${status} OK\r\n\r\n${JSON.stringify(value)}`;
  const gh = new GhEditorialTransport(config, async (args) => {
    const path = args.find((a) => a.startsWith("/"))!;
    if (path === "/user")
      return http({ id: 42, login: "isolated-editor", type: "User" });
    if (path.includes("/git/ref/")) return http({ object: { sha: head } });
    if (path.includes("/git/trees/"))
      return http({
        truncated: mode === "truncated",
        tree: [
          {
            path: `content/events/${eventId}.json`,
            mode: "100644",
            type: "blob",
            sha: blob,
            size: 300,
          },
        ],
      });
    if (mode === "missing") return http({}, 404);
    if (mode === "forbidden") return http({}, 403);
    return http({
      encoding: "base64",
      content: Buffer.from(
        mode === "malformed" ? "{" : JSON.stringify(record),
      ).toString("base64"),
    });
  });
  const service = new EditorialService(stores[1].pool, config, gh, true);
  await service.pull(user);
  const cache = await service.events(user),
    d = await draft(1, eventId, { venue: "DIRTY_BASE_PRESERVED" });
  for (mode of ["truncated", "missing", "malformed", "forbidden"]) {
    await assert.rejects(service.pull(user));
    const kept = await service.events(user);
    assert.equal(kept.commit, cache.commit);
    assert.equal(kept.fetchedAt, cache.fetchedAt);
    assert.deepEqual(kept.records, cache.records);
    assert.equal(kept.stale, true);
    const keptDraft = (await service.drafts(user)).items.find(
      (x) => x.id === d.id,
    )!;
    assert.equal(keptDraft.baseCommit, d.baseCommit);
    assert.deepEqual(keptDraft.payload, d.payload);
  }
});
test("concurrent pulls serialize remote reads and cannot roll an approved cache backward", async () => {
  const s = stores[0],
    original = github.snapshot.bind(github);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((done) => (release = done)),
    start = new Promise<void>((done) => (started = done));
  let calls = 0;
  github.snapshot = async (commit) => {
    const result = await original(commit);
    if (++calls === 1) {
      started();
      await gate;
    }
    return result;
  };
  try {
    const first = s.service.pull(user);
    await start;
    const records = structuredClone(github.records);
    records[0].record.venue = "Newest canonical after concurrent read";
    const newest = github.approve(records);
    const second = s.service.pull(user);
    release();
    await Promise.all([first, second]);
    assert.equal((await s.service.events(user)).commit, newest);
  } finally {
    release();
    github.snapshot = original;
  }
});

test("identical submissions from independent installations reuse one verified PR", async () => {
  for (const s of stores) await s.service.pull(user);
  const a = await draft(0, event2, {
      venue: "Same content on two independent installs",
    }),
    b = await draft(1, event2, {
      venue: "Same content on two independent installs",
    }),
    calls = github.createCalls;
  const first = await stores[0].service.propose(
    user,
    [{ id: a.id, expectedVersion: 1 }],
    randomUUID(),
  );
  const second = await stores[1].service.propose(
    user,
    [{ id: b.id, expectedVersion: 1 }],
    randomUUID(),
  );
  assert.equal(first.proposal.number, second.proposal.number);
  assert.equal(github.createCalls, calls + 1);
  assert.notEqual(a.id, b.id);
});
test("new record absence, local stale versions and draft ownership are explicit", async () => {
  const s = stores[0];
  await s.service.pull(user);
  const snapshot = await s.service.events(user),
    recordId = "30000000-0000-4000-8000-000000000077";
  const d = await s.service.save(user, randomUUID(), {
    recordId,
    baseCommit: snapshot.commit,
    baseRecordHash: null,
    payload: payload(70),
    desiredStatus: "published",
  });
  const actual = await eventProjection(
    recordId,
    { ...payload(70), venue: "Created on another installation" },
    "published",
  );
  github.approve([...github.records, { type: "events", record: actual }]);
  await assert.rejects(
    s.service.propose(user, [{ id: d.id, expectedVersion: 1 }], randomUUID()),
    (e: any) => e.code === "REMOTE_RECORD_CONFLICT",
  );
  await assert.rejects(
    s.service.save(
      user,
      d.id,
      {
        recordId,
        baseCommit: d.baseCommit,
        baseRecordHash: null,
        payload: d.payload,
        desiredStatus: "published",
      },
      99,
    ),
    (e: any) => e.code === "DRAFT_VERSION_CONFLICT",
  );
  const other = { ...user, id: "10000000-0000-4000-8000-000000000001" };
  await assert.rejects(
    s.service.draftRow(other, d.id),
    (e: any) => e.code === "NOT_FOUND",
  );
  await assert.rejects(
    s.service.discard(user, d.id, 99),
    (e: any) => e.code === "DRAFT_VERSION_CONFLICT",
  );
  assert.equal((await s.service.discard(user, d.id, 1)).remoteUnchanged, true);
  assert.ok(github.records.some((r) => r.record.id === recordId));
});
test("remote PR edits and unverifiable merged content cannot become a merged local state", async () => {
  const s = stores[2];
  await s.service.pull(user);
  const d = await draft(2, event2, { venue: "Exact submitted revision only" }),
    result = await s.service.propose(
      user,
      [{ id: d.id, expectedVersion: 1 }],
      randomUUID(),
    );
  const pr = github.proposals.get("editorial/" + result.proposal.marker)!;
  const original = structuredClone(pr.files);
  pr.files[0].record.venue = "Unexpected external edit";
  await assert.rejects(
    s.service.reconcile(user, d.id),
    (e: any) => e.code === "PROPOSAL_CONTENT_MISMATCH",
  );
  pr.files = original;
  pr.state = "merged";
  pr.mergeCommit = github.head;
  await assert.rejects(
    s.service.reconcile(user, d.id),
    (e: any) => e.code === "PROPOSAL_MERGE_UNVERIFIED",
  );
  assert.equal(
    (await s.service.drafts(user)).items.find((x) => x.id === d.id)!.state,
    "proposed",
  );
  pr.state = "open";
  pr.mergeCommit = null;
});

test("unknown submission survives reload and cannot detach through save or discard", async () => {
  const s = stores[0];
  await s.service.pull(user);
  const d = await draft(0, event2, { venue: "UNKNOWN_RELOAD_STATE" });
  github.uncertainAfterCreate = true;
  await assert.rejects(
    s.service.propose(user, [{ id: d.id, expectedVersion: 1 }], randomUUID()),
  );
  const reloaded = (await s.service.drafts(user)).items.find(
    (x) => x.id === d.id,
  )!;
  assert.equal(reloaded.state, "unknown");
  assert.equal(reloaded.submission!.state, "unknown");
  assert.equal(reloaded.submission!.reconcileRequired, true);
  assert.equal(reloaded.proposal, undefined);
  await assert.rejects(
    s.service.save(
      user,
      d.id,
      {
        recordId: d.recordId,
        baseCommit: d.baseCommit,
        baseRecordHash: d.baseRecordHash,
        payload: { ...d.payload, venue: "Unsaved text retained by client" },
        desiredStatus: "published",
      },
      1,
    ),
    (e: any) => e.code === "SUBMISSION_PENDING",
  );
  await assert.rejects(
    s.service.discard(user, d.id, 1),
    (e: any) => e.code === "SUBMISSION_PENDING",
  );
  const recovered = await s.service.reconcile(user, d.id);
  assert.equal(recovered.state, "proposed");
  assert.ok(recovered.proposal!.url);
  const revised = await s.service.save(
    user,
    d.id,
    {
      recordId: d.recordId,
      baseCommit: d.baseCommit,
      baseRecordHash: d.baseRecordHash,
      payload: { ...d.payload, venue: "New revision after confirmedPR" },
      desiredStatus: "published",
    },
    1,
  );
  assert.equal(revised.state, "local");
  assert.ok(
    revised.submissionHistory.some((x) => x.id === reloaded.submission!.id),
  );
  assert.ok(
    (await s.service.submissions(user)).items.some(
      (x) => x.id === reloaded.submission!.id,
    ),
  );
});
test("known-unsent initial proposal GET failure retries with the same durable request", async () => {
  const s = stores[1];
  await s.service.pull(user);
  const d = await draft(1, event2, { venue: "INITIAL_GET_FAILED_NO_WRITE" }),
    key = randomUUID(),
    original = github.findProposal.bind(github);
  let once = true;
  github.findProposal = async (branch) => {
    if (once) {
      once = false;
      throw new Error("Read failed before any mutation");
    }
    return original(branch);
  };
  try {
    const calls = github.createCalls;
    await assert.rejects(
      s.service.propose(user, [{ id: d.id, expectedVersion: 1 }], key),
    );
    const reloaded = (await s.service.drafts(user)).items.find(
      (x) => x.id === d.id,
    )!;
    assert.equal(reloaded.state, "retryable");
    assert.equal(reloaded.submission!.canEdit, true);
    const retried = await s.service.propose(
      user,
      [{ id: d.id, expectedVersion: 1 }],
      key,
    );
    assert.equal(retried.items[0].state, "proposed");
    assert.equal(github.createCalls, calls + 1);
  } finally {
    github.findProposal = original;
  }
});
test("partial branch creation reconciles to explicit same-branch retry rather than a duplicate intent", async () => {
  const { hashRevision } = await import("../src/shared/content");
  class PartialGitHub extends FakeEditorialGitHub {
    branchInput: any;
    failOnce = true;
    async createProposal(input: any) {
      this.branchInput ??= structuredClone(input);
      if (this.failOnce) {
        this.failOnce = false;
        throw new Error("Response lost after branch creation");
      }
      assert.equal(input.branch, this.branchInput.branch);
      return super.createProposal(input);
    }
    async inspectProposal(input: any) {
      assert.equal(
        hashRevision(input.files),
        hashRevision(this.branchInput.files),
      );
      return { state: "branch_verified" as const, headCommit: "d".repeat(40) };
    }
  }
  const partial = new PartialGitHub(github.records),
    service = new EditorialService(stores[2].pool, config, partial, true);
  await service.pull(user);
  const d = await draft(2, event2, { venue: "AFTER_BRANCH_BEFORE_PR" }),
    key = randomUUID();
  await assert.rejects(
    service.propose(user, [{ id: d.id, expectedVersion: 1 }], key),
  );
  assert.equal(partial.proposals.size, 0);
  const reloaded = (await service.drafts(user)).items.find(
    (x) => x.id === d.id,
  )!;
  assert.equal(reloaded.state, "unknown");
  const reconciled = await service.reconcile(user, d.id);
  assert.equal(reconciled.state, "retryable");
  assert.equal(partial.proposals.size, 0, "Reconcile never creates a PR");
  const retry = await service.propose(
    user,
    [{ id: d.id, expectedVersion: 1 }],
    key,
  );
  assert.equal(retry.items[0].state, "proposed");
  assert.equal(partial.proposals.size, 1);
  assert.equal(retry.items[0].submission!.id, reloaded.submission!.id);
});
test("overlapping pending batches cannot overwrite claims and active sends block local edits", async () => {
  const s = stores[0];
  await s.service.pull(user);
  const a = await draft(0, eventId, { venue: "BATCH_A" }),
    b = await draft(0, event2, { venue: "BATCH_B" }),
    c = await draft(0, "30000000-0000-4000-8000-000000000077", {
      venue: "BATCH_C",
    });
  const original = github.createProposal.bind(github);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    start = new Promise<void>((r) => (started = r));
  github.createProposal = async (input) => {
    started();
    await gate;
    return original(input);
  };
  try {
    const pending = s.service.propose(
      user,
      [
        { id: a.id, expectedVersion: 1 },
        { id: b.id, expectedVersion: 1 },
      ],
      randomUUID(),
    );
    await start;
    const active = (await s.service.drafts(user)).items.find(
      (x) => x.id === a.id,
    )!;
    assert.equal(active.state, "sending");
    await assert.rejects(
      s.service.propose(
        user,
        [
          { id: a.id, expectedVersion: 1 },
          { id: c.id, expectedVersion: 1 },
        ],
        randomUUID(),
      ),
      (e: any) => e.code === "SUBMISSION_PENDING",
    );
    await assert.rejects(
      s.service.save(
        user,
        a.id,
        {
          recordId: a.recordId,
          baseCommit: a.baseCommit,
          baseRecordHash: a.baseRecordHash,
          payload: a.payload,
          desiredStatus: "published",
        },
        1,
      ),
      (e: any) => e.code === "SUBMISSION_PENDING",
    );
    await assert.rejects(
      s.service.reconcile(user, a.id),
      (e: any) => e.code === "SUBMISSION_PENDING",
    );
    release();
    const result = await pending;
    assert.equal(result.items.length, 2);
    assert.equal(
      (await s.service.drafts(user)).items.find((x) => x.id === a.id)!
        .submission!.id,
      result.items[0].submission!.id,
    );
  } finally {
    release();
    github.createProposal = original;
  }
});

test("GitHub mode rejects every legacy SQL event write/export path and event-linked integrations", async () => {
  const s = stores[1],
    origin = "http://127.0.0.1:4889",
    legacyId = randomUUID(),
    changesetId = randomUUID(),
    publicationId = randomUUID();
  await s.pool.query(
    "INSERT INTO records(id,community_id,type,scope,author_id,payload,state,revision_hash,updated_at) VALUES($1,$2,'events','public',$3,$4,'approved',$5,now())",
    [legacyId, COMMUNITY_ID, user.id, payload(), hashRevision(payload())],
  );
  await s.pool.query(
    "INSERT INTO integration_changesets(id,community_id,actor_id,revision_hash,files) VALUES($1,$2,$3,$4,$5)",
    [
      changesetId,
      COMMUNITY_ID,
      user.id,
      "x",
      JSON.stringify([
        { path: `content/events/${legacyId}.json`, content: "{}" },
      ]),
    ],
  );
  await s.pool.query(
    "INSERT INTO integration_publications(id,community_id,author_id,channel,destination,payload,revision_hash,state) VALUES($1,$2,$3,'youtube','isolated',$4,'x','draft')",
    [publicationId, COMMUNITY_ID, user.id, { eventId: legacyId }],
  );
  const app = createApp({
      pool: s.pool,
      media: [],
      origin,
      fixtureAuthEnabled: true,
      environment: "test",
      editorial: { config, transport: github, testTransport: true },
    }),
    agent = request.agent(app),
    login = await agent
      .post("/api/dev/login")
      .set("Origin", origin)
      .send({ persona: "owner" }),
    csrf = login.body.csrfToken;
  const cases: [string, string, any?][] = [
    ["get", "/records?type=events"],
    ["get", "/content/events"],
    ["get", `/records/${legacyId}`],
    ["post", "/records", { type: "events", payload: payload() }],
    ["post", "/drafts", { entityType: "events", payload: payload() }],
    ["patch", `/records/${legacyId}`, { payload: payload() }],
    ["patch", `/drafts/${legacyId}`, { payload: payload() }],
    ...["submit", "review", "archive", "delete", "preview", "validate"].map(
      (action) =>
        ["post", `/records/${legacyId}/${action}`, {}] as [string, string, any],
    ),
    ["get", `/records/${legacyId}/export`],
    ["post", "/import/site", { dryRun: false }],
    ["post", "/changesets", { recordIds: [legacyId] }],
    ...["retry", "merge", "revert", "reconcile"].map(
      (action) =>
        ["post", `/changesets/${changesetId}/${action}`, {}] as [
          string,
          string,
          any,
        ],
    ),
    [
      "post",
      "/publications",
      {
        channel: "youtube",
        destination: "test",
        payload: { eventId: legacyId },
      },
    ],
    [
      "patch",
      `/publications/${publicationId}`,
      { payload: { eventId: legacyId } },
    ],
    ["post", `/publications/${publicationId}/schedule`, {}],
    ["post", `/publications/${publicationId}/recording-link`, {}],
  ];
  for (const alias of [
    "people",
    "organizations",
    "proposals",
    "sessions",
    "participations",
    "followups",
    "consents",
  ]) {
    cases.push(
      ["patch", `/${alias}/${legacyId}`, { payload: payload() }],
      ["get", `/${alias}/${legacyId}`],
    );
  }
  const variants = cases.flatMap(([method, path, body]) => {
    const [base, query] = path.split("?");
    const suffix = query ? "?" + query : "";
    const encoded = base.replace(
      /[a-f0-9]{8}-[a-f0-9-]{27}/i,
      (match) => "%" + match.charCodeAt(0).toString(16) + match.slice(1),
    );
    return [
      [method, base + "/" + suffix, body],
      [method, base.toUpperCase() + suffix, body],
      [method, encoded + suffix, body],
      [method, base.replaceAll("/", "//") + suffix, body],
      [method, "/" + base + suffix, body],
    ] as [string, string, any][];
  });
  for (const [method, path, body] of [...cases, ...variants]) {
    const r = (agent as any)
      [method]("/api" + path)
      .set("Origin", origin)
      .set("X-CSRF-Token", csrf)
      .set("Idempotency-Key", randomUUID());
    const response = await (body ? r.send(body) : r);
    assert.equal(
      response.status,
      409,
      `${method} ${path}: ${JSON.stringify(response.body)}`,
    );
    assert.equal(response.body.code, "EDITORIAL_GITHUB_AUTHORITY");
  }
  assert.equal(
    (await agent.get("/api/records?type=people")).status,
    200,
    "Private CRM remains available",
  );
  const person = await agent
    .post("/api/records")
    .set("Origin", origin)
    .set("X-CSRF-Token", csrf)
    .set("Idempotency-Key", randomUUID())
    .send({
      type: "people",
      payload: entityDefinitions.find((d) => d.type === "people")!.defaults,
    });
  assert.equal(person.status, 201, JSON.stringify(person.body));
  for (const path of [
    `/api/people/${person.body.id}`,
    `/api/people//${person.body.id}`,
  ]) {
    assert.equal(
      (await agent.get(path)).status,
      200,
      "Private aliases remain readable: " + path,
    );
    const current = await agent.get(path);
    const saved = await agent
      .patch(path)
      .set("Origin", origin)
      .set("X-CSRF-Token", csrf)
      .set("If-Match", `"${current.body.revision}"`)
      .send({ payload: current.body.payload });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  }
  for (const method of ["get", "patch"]) {
    const r = (agent as any)
      [method](`/api//people/${person.body.id}`)
      .set("Origin", origin)
      .set("X-CSRF-Token", csrf);
    assert.equal(
      (
        await (method === "patch"
          ? r.send({ payload: person.body.payload })
          : r)
      ).status,
      404,
      "Unmatched private leading-separator routes remain unmatched",
    );
  }
  await s.pool.query("UPDATE records SET state='submitted' WHERE id=$1", [
    legacyId,
  ]);
  const overview = await agent.get("/api/overview");
  assert.equal(overview.status, 200);
  assert.equal(
    overview.body.reviewQueue.some((r: any) => r.type === "events"),
    false,
  );
  const expected = (
    await s.pool.query(
      "SELECT count(*)::int AS count FROM records WHERE community_id=$1 AND type<>'events' AND state<>'deleted'",
      [COMMUNITY_ID],
    )
  ).rows[0].count;
  assert.equal(
    overview.body.counts.records,
    expected,
    "GitHub overview excludes legacy SQL Events",
  );
  assert.equal(
    (await agent.get("/api/editorial/events")).status,
    200,
    "Canonical route stays available",
  );
  assert.deepEqual(
    (await s.pool.query("SELECT payload FROM records WHERE id=$1", [legacyId]))
      .rows[0].payload,
    payload(),
  );
  const { integrationEnvironment } =
    await import("../src/server/integrations/runtime");
  const mode = process.env.EDITORIAL_MODE,
    live = process.env.INTEGRATIONS_LIVE_ENABLED;
  try {
    process.env.EDITORIAL_MODE = "github";
    process.env.INTEGRATIONS_LIVE_ENABLED = "true";
    assert.throws(() => integrationEnvironment(s.pool), /incompatible/);
    process.env.INTEGRATIONS_LIVE_ENABLED = "false";
    assert.equal(integrationEnvironment(s.pool).liveEnabled, false);
  } finally {
    if (mode === undefined) delete process.env.EDITORIAL_MODE;
    else process.env.EDITORIAL_MODE = mode;
    if (live === undefined) delete process.env.INTEGRATIONS_LIVE_ENABLED;
    else process.env.INTEGRATIONS_LIVE_ENABLED = live;
  }
});

test("encrypted restore preserves editorial bases/history and requires reconciliation without remote sends", async () => {
  const { backupSnapshot, restoreSnapshot } =
      await import("../src/server/recovery"),
    { randomBytes } = await import("node:crypto");
  const source = stores[0],
    before = await source.service.drafts(user),
    calls = github.createCalls,
    key = randomBytes(32),
    bytes = await backupSnapshot(source.pool, source.name, key),
    name = "test_editorial_restore_" + randomUUID().replaceAll("-", ""),
    pool = createPool(process.env.DATABASE_URL!, name);
  try {
    await restoreSnapshot(pool, name, bytes, key);
    const restored = new EditorialService(pool, config, github, true),
      drafts = await restored.drafts(user);
    assert.equal(drafts.items.length, before.items.length);
    for (const old of before.items) {
      const current = drafts.items.find((d) => d.id === old.id)!;
      assert.equal(current.baseCommit, old.baseCommit);
      assert.deepEqual(current.payload, old.payload);
      assert.equal(
        current.submissionHistory.length,
        old.submissionHistory.length,
      );
    }
    const proposals = (
      await pool.query(
        "SELECT state,lease_until FROM editorial_proposals WHERE state NOT IN('merged','closed')",
      )
    ).rows;
    assert.ok(proposals.length);
    assert.ok(
      proposals.every((p) => p.state === "unknown" && p.lease_until === null),
    );
    assert.equal(
      github.createCalls,
      calls,
      "Restore performs no provider calls",
    );
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
    await pool.end();
  }
});

test("paused reconciliation serializes with a new claim and cannot clear an active sender lease", async () => {
  const s = stores[1];
  await s.service.pull(user);
  const d = await draft(1, event2, { venue: "SERIAL_RECONCILE_CLAIM" }),
    key = randomUUID(),
    find = github.findProposal.bind(github),
    inspect = github.inspectProposal.bind(github);
  let fail = true;
  github.findProposal = async (branch) => {
    if (fail) {
      fail = false;
      throw new Error("Known-unsent read failure");
    }
    return find(branch);
  };
  await assert.rejects(
    s.service.propose(user, [{ id: d.id, expectedVersion: 1 }], key),
  );
  github.findProposal = find;
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    start = new Promise<void>((r) => (started = r));
  github.inspectProposal = async (input) => {
    started();
    await gate;
    return inspect(input);
  };
  try {
    const reconciliation = s.service.reconcile(user, d.id);
    await start;
    const calls = github.createCalls;
    await assert.rejects(
      s.service.propose(user, [{ id: d.id, expectedVersion: 1 }], key),
      (e: any) => e.code === "SUBMISSION_PENDING",
    );
    assert.equal(github.createCalls, calls);
    release();
    await reconciliation;
    const result = await s.service.propose(
      user,
      [{ id: d.id, expectedVersion: 1 }],
      key,
    );
    assert.equal(result.items[0].state, "proposed");
    assert.equal(github.createCalls, calls + 1);
  } finally {
    release();
    github.inspectProposal = inspect;
    github.findProposal = find;
  }
});
test("lease expiry cannot let another reconciler supersede a still-running sender", async () => {
  const s = stores[2];
  await s.service.pull(user);
  const d = await draft(2, event2, { venue: "SERIAL_EXPIRED_ACTIVE_SENDER" }),
    key = randomUUID(),
    create = github.createProposal.bind(github);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    start = new Promise<void>((r) => (started = r));
  github.createProposal = async (input) => {
    started();
    await gate;
    return create(input);
  };
  try {
    const sending = s.service.propose(
      user,
      [{ id: d.id, expectedVersion: 1 }],
      key,
    );
    await start;
    const row = (await s.service.drafts(user)).items.find(
      (x) => x.id === d.id,
    )!;
    await s.pool.query(
      "UPDATE editorial_proposals SET lease_until=now()-interval '1 minute' WHERE id=$1",
      [row.submission!.id],
    );
    await assert.rejects(
      s.service.reconcile(user, d.id),
      (e: any) => e.code === "SUBMISSION_PENDING",
    );
    await assert.rejects(
      s.service.propose(user, [{ id: d.id, expectedVersion: 1 }], key),
      (e: any) => e.code === "SUBMISSION_PENDING",
    );
    assert.equal(
      (
        await s.pool.query(
          "SELECT state FROM editorial_proposals WHERE id=$1",
          [row.submission!.id],
        )
      ).rows[0].state,
      "sending",
    );
    release();
    const result = await sending;
    assert.equal(result.items[0].state, "proposed");
  } finally {
    release();
    github.createProposal = create;
  }
});
