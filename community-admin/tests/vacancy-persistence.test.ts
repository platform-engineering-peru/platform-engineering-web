import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createPool, migrate, COMMUNITY_ID } from "../src/server/db";
import { VacancyIntakeService } from "../src/server/jobs/intake-service";
import { JobsPublisher, type JobsRemote } from "../src/server/jobs/publication";
import { IntegrationService } from "../src/server/integrations/service";
import { capabilitiesFor, type Session } from "../src/server/context";
import {
  publicJobs,
  collectSource,
  reconcileJobs,
} from "../src/server/jobs/engine";
import { discoverCareers } from "../src/server/jobs/discovery";
import type { Transport } from "../src/server/integrations/http";
import type {
  RemoteProposal,
  ProposalInput,
} from "../src/server/editorial-sync/types";
import type { PublicJobRecord } from "../src/server/jobs/publication-contract";
const schema = "test_vacancy_" + randomUUID().replaceAll("-", ""),
  actor = "10000000-0000-4000-8000-000000000004";
const user: Session = {
  id: actor,
  communityId: COMMUNITY_ID,
  name: "Owner",
  role: "owner",
  roles: ["owner"],
  capabilities: capabilitiesFor(["owner"]),
  csrfToken: "fixture",
  authenticatedAt: new Date().toISOString(),
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
  if (pool) {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});
const ld = JSON.stringify({
  "@type": "JobPosting",
  title: "Platform Engineer",
  hiringOrganization: { name: "Example" },
  identifier: { value: "REQ-101" },
  jobLocation: { address: { addressCountry: "PE", addressLocality: "Lima" } },
});
const transport: Transport = async (url) => ({
  status: url.endsWith("robots.txt") ? 404 : 200,
  headers: { "content-type": "text/html" },
  body: Buffer.from(`<script type="application/ld+json">${ld}</script>`),
});
const fields = (url: string) => ({
  url,
  title: "Platform Engineer",
  company: "Example",
  locations: ["Lima, Peru"],
  workplace: "hybrid",
  eligibility: "peru",
  eligibilityEvidence: "Original employer page explicitly states Lima, Peru.",
  activeEvidence: "Original employer page is open and accepting applications.",
  summary: {
    "es-pe": "Rol de ingeniería de plataforma en Lima.",
    en: "Platform engineering role in Lima.",
  },
});
test("unsupported sites have explicit audited manual intake without fabricated remote verification", async () => {
  const intake = new VacancyIntakeService(pool, transport);
  for (const [i, name] of [
    "bcp",
    "pacifico",
    "credicorp",
    "mibanco",
    "interbank",
    "bbva",
    "entel",
    "scotiabank",
    "globant",
    "indra",
    "encora",
    "coforge",
    "raven",
    "nttdata",
    "tcs",
    "tivit",
  ].entries()) {
    const result = await intake.save(
      user,
      fields(`https://${name}.example/jobs/${i}`),
      "manual-" + name,
    );
    assert.equal(result.item.payload.approved, false);
    assert.equal(result.item.payload.status, "needs-review");
    assert.equal(
      result.item.payload.intake.verificationMethod,
      "operator-attestation",
    );
    assert.equal(result.item.payload.intake.completeSourceSnapshot, false);
    assert.equal(result.item.payload.intake.sourceFacts, null);
  }
});
test("preview is actor-bound/read-only, duplicate URLs are idempotent and edited facts need CAS", async () => {
  const intake = new VacancyIntakeService(pool, transport),
    url = "https://employer.example/jobs/unique";
  const count = (await pool.query("SELECT count(*) FROM job_records")).rows[0]
    .count;
  const preview = await intake.preview(user, url);
  assert.equal(
    (await pool.query("SELECT count(*) FROM job_records")).rows[0].count,
    count,
  );
  await assert.rejects(
    intake.save(
      { ...user, id: randomUUID() },
      { ...fields(url), previewHash: preview.previewHash },
      "different-actor",
    ),
  );
  const created = await intake.save(
    user,
    { ...fields(url), previewHash: preview.previewHash },
    "first",
  );
  assert.equal(
    created.item.payload.intake.sourceFacts.draft.company,
    "Example",
  );
  const repeat = await intake.save(
    user,
    { ...fields(url), previewHash: preview.previewHash },
    "first",
  );
  assert.equal(repeat.item.id, created.item.id);
  await assert.rejects(
    intake.save(
      user,
      { ...fields(url), title: "SRE", previewHash: preview.previewHash },
      "first",
    ),
  );
  const alias = await intake.save(
    user,
    fields(url + "?utm_source=duplicate"),
    "alias",
  );
  assert.equal(alias.created, false);
  assert.equal(alias.item.id, created.item.id);
  const updated = await intake.save(
    user,
    { ...fields(url), title: "SRE", version: created.item.version },
    "edit",
    created.item.id,
  );
  assert.equal(updated.item.version, 2);
  await assert.rejects(
    intake.save(
      user,
      { ...fields(url), version: 1 },
      "stale-edit",
      created.item.id,
    ),
  );
});
test("single-detail provider monitoring ingests observed job without retiring siblings", async () => {
  const url =
      "https://credicorp.hirehive.com/example-platform-engineer-lima-Abc123",
    detected = await discoverCareers(url, "Example", transport);
  assert.equal(detected.config.coverage, "single-detail");
  const run = await collectSource(
    {
      ...detected.config,
      enabled: true,
      reviewedAt: new Date().toISOString(),
      reviewReference: "fixture",
      permissionBasis: "fixture",
      termsUrl: url,
    },
    transport,
  );
  assert.equal(run.status, "complete");
  assert.equal(run.completeSourceSnapshot, false);
  assert.equal(run.records.length, 1);
  assert.equal(run.records[0].eligibility, "peru");
  const sibling = {
    ...run.records[0],
    id: "hirehive:fixture:sibling",
    status: "active",
    approved: true,
    missingSince: "2020-01-01T00:00:00Z",
    missingRunId: "prior",
  };
  const result = reconcileJobs(
    [sibling],
    { ...run, runId: "new" },
    new Date("2026-11-18"),
  );
  assert.equal(result.jobs.find((j) => j.id === sibling.id).status, "active");
});
function remote() {
  const state = {
    records: [] as { type: string; record: PublicJobRecord }[],
    proposal: null as RemoteProposal<PublicJobRecord> | null,
    sent: 0,
    subject: "42",
    uncertain: false,
    deployed: false,
    history: new Map<string, { type: string; record: PublicJobRecord }[]>(),
  };
  const api: JobsRemote = {
    identity: async () => ({ subject: state.subject, login: "operator" }),
    snapshot: async (commit) => ({
      commit: commit ?? "a".repeat(40),
      records:
        (commit ? state.history.get(commit) : undefined) ?? state.records,
    }),
    findProposal: async () => state.proposal,
    inspectProposal: async () => ({ state: "absent", headCommit: null }),
    createProposal: async (input: ProposalInput<PublicJobRecord>) => {
      state.sent++;
      state.proposal = {
        number: 1,
        url: "https://github.com/example/community/pull/1",
        headCommit: "b".repeat(40),
        state: "open",
        mergeCommit: null,
        files: input.files,
        marker: input.id,
        branch: input.branch,
        baseBranch: "main",
        authorSubject: input.subject,
      };
      if (state.uncertain)
        throw Object.assign(Error("timeout"), {
          code: "NETWORK",
          remoteMutationAttempted: true,
        });
      return state.proposal;
    },
    deployment: async () => ({ state: state.deployed ? "deployed" : "merged" }),
  };
  return { state, api };
}
const config = {
  mode: "github" as const,
  repository: "example/community",
  branch: "main",
  remoteWritesEnabled: true,
};
async function approved(suffix: string) {
  const intake = new VacancyIntakeService(pool);
  const row = (
    await intake.save(
      user,
      fields("https://employer.example/jobs/" + suffix),
      "approve-" + suffix,
    )
  ).item;
  await pool.query(
    'UPDATE job_records SET payload=payload||\'{"approved":true,"status":"active"}\'::jsonb WHERE id=$1',
    [row.id],
  );
  return (await pool.query("SELECT * FROM job_records WHERE id=$1", [row.id]))
    .rows[0];
}
test("website-only worker creates actual PR, preserves projection, idempotency and distinct deployment states", async () => {
  const r = remote(),
    record = await approved("publish"),
    service = new IntegrationService({
      pool,
      liveEnabled: false,
      jobsPublication: { config, transport: r.api },
    });
  const op = await service.createJobsChangeset(
    COMMUNITY_ID,
    actor,
    [record.id],
    "publish",
  );
  assert.equal(r.state.sent, 0);
  const repeated = await service.createJobsChangeset(
    COMMUNITY_ID,
    actor,
    [record.id],
    "publish",
  );
  assert.equal(op.id, repeated.id);
  await service.validateOperation(op);
  const outcome: any = await service.handleOperation(op);
  assert.equal(outcome.state, "pr_open");
  assert.equal(r.state.sent, 1);
  assert.deepEqual(
    r.state.proposal!.files[0].record,
    publicJobs([record.payload])[0],
  );
  const publisher = service.jobsPublisher!;
  r.state.proposal!.state = "merged";
  r.state.proposal!.mergeCommit = "c".repeat(40);
  r.state.records = r.state.proposal!.files.map((f) => ({
    type: "jobs",
    record: f.record,
  }));
  const merged: any = await publisher.reconcile(
    COMMUNITY_ID,
    actor,
    op.subject_id,
  );
  assert.equal(merged.state, "merged");
  assert.equal(merged.deployedSha, null);
  r.state.deployed = true;
  assert.equal(
    (await publisher.reconcile(COMMUNITY_ID, actor, op.subject_id)).state,
    "deployed",
  );
});
test("stale local approval, changed remote baseline and actor account switch cannot send", async () => {
  for (const kind of ["local", "remote", "identity"]) {
    const r = remote(),
      record = await approved("conflict-" + kind),
      publisher = new JobsPublisher(pool, { config, transport: r.api });
    const op = await publisher.create(
      COMMUNITY_ID,
      actor,
      [record.id],
      "key-" + kind,
    );
    if (kind === "local")
      await pool.query(
        "UPDATE job_records SET payload=payload||'{\"approved\":false}'::jsonb WHERE id=$1",
        [record.id],
      );
    if (kind === "remote")
      r.state.records = [
        {
          type: "jobs",
          record: {
            ...publicJobs([record.payload])[0],
            title: "Other operator edit",
          },
        },
      ];
    if (kind === "identity") r.state.subject = "different";
    await assert.rejects(publisher.publish(COMMUNITY_ID, actor, op.subject_id));
    assert.equal(r.state.sent, 0);
  }
});
test("uncertain PR response reconciles exact original remote result without a duplicate send", async () => {
  const r = remote(),
    record = await approved("uncertain"),
    publisher = new JobsPublisher(pool, { config, transport: r.api }),
    op = await publisher.create(COMMUNITY_ID, actor, [record.id], "uncertain");
  r.state.uncertain = true;
  await assert.rejects(
    publisher.publish(COMMUNITY_ID, actor, op.subject_id),
    /PROPOSAL_UNCERTAIN/,
  );
  assert.equal(r.state.sent, 1);
  const recovered = await publisher.reconcile(
    COMMUNITY_ID,
    actor,
    op.subject_id,
  );
  assert.equal(recovered.state, "pr_open");
  assert.equal(r.state.sent, 1);
});
test("send and reconcile share a nonblocking mutex and target fence", async () => {
  const r = remote(),
    record = await approved("mutex"),
    publisher = new JobsPublisher(pool, { config, transport: r.api }),
    op = await publisher.create(COMMUNITY_ID, actor, [record.id], "mutex");
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve));
  r.api.inspectProposal = async () => {
    enter();
    await gate;
    return { state: "absent", headCommit: null };
  };
  const sending = publisher.publish(COMMUNITY_ID, actor, op.subject_id);
  await entered;
  try {
    await assert.rejects(
      new JobsPublisher(pool, { config, transport: r.api }).reconcile(
        COMMUNITY_ID,
        actor,
        op.subject_id,
      ),
      /OPERATION_IN_PROGRESS/,
    );
  } finally {
    release();
  }
  assert.equal((await sending).state, "pr_open");
  assert.equal(
    (
      await pool.query("SELECT state FROM integration_changesets WHERE id=$1", [
        op.subject_id,
      ])
    ).rows[0].state,
    "pr_open",
  );
  await assert.rejects(
    new JobsPublisher(pool, {
      config: { ...config, repository: "other/repository" },
      transport: r.api,
    }).reconcile(COMMUNITY_ID, actor, op.subject_id),
    /TARGET_REPOSITORY_CHANGED/,
  );
});
test("single-connection publisher does not take nested pool connections", async () => {
  const single = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    options: `-c search_path=${schema},public`,
    max: 1,
    connectionTimeoutMillis: 500,
  });
  try {
    const r = remote(),
      record = await approved("single-connection"),
      publisher = new JobsPublisher(single, { config, transport: r.api }),
      op = await publisher.create(
        COMMUNITY_ID,
        actor,
        [record.id],
        "single-connection",
      );
    assert.equal(
      (await publisher.publish(COMMUNITY_ID, actor, op.subject_id)).state,
      "pr_open",
    );
    assert.equal(
      (await publisher.reconcile(COMMUNITY_ID, actor, op.subject_id)).state,
      "pr_open",
    );
  } finally {
    await single.end();
  }
});
test("merged manual edits preserve baseline; older merged reconciliation cannot regress a newer baseline", async () => {
  const r = remote(),
    record = await approved("baseline-order"),
    publisher = new JobsPublisher(pool, { config, transport: r.api }),
    first = await publisher.create(
      COMMUNITY_ID,
      actor,
      [record.id],
      "baseline-first",
    );
  await publisher.publish(COMMUNITY_ID, actor, first.subject_id);
  const a = structuredClone(r.state.proposal!);
  a.state = "merged";
  a.mergeCommit = "c".repeat(40);
  r.state.proposal = a;
  r.state.records = a.files.map((f) => ({ type: "jobs", record: f.record }));
  r.state.history.set(a.mergeCommit, r.state.records);
  await publisher.reconcile(COMMUNITY_ID, actor, first.subject_id);
  const before = (
      await pool.query("SELECT * FROM job_records WHERE id=$1", [record.id])
    ).rows[0],
    intake = new VacancyIntakeService(pool);
  const edited = await intake.save(
    user,
    {
      ...fields(record.payload.sourceUrl),
      title: "Senior Platform Engineer",
      version: before.version,
    },
    "baseline-edit",
    record.id,
  );
  assert.equal(
    edited.item.payload.baseEntityHash,
    before.payload.baseEntityHash,
  );
  assert.equal(edited.item.payload.approved, false);
  await pool.query(
    'UPDATE job_records SET payload=payload||\'{"approved":true,"status":"active"}\'::jsonb WHERE id=$1',
    [record.id],
  );
  r.state.proposal = null;
  const second = await publisher.create(
    COMMUNITY_ID,
    actor,
    [record.id],
    "baseline-second",
  );
  await publisher.publish(COMMUNITY_ID, actor, second.subject_id);
  const b = structuredClone(r.state.proposal!);
  b.state = "merged";
  b.mergeCommit = "d".repeat(40);
  r.state.proposal = b;
  r.state.records = b.files.map((f) => ({ type: "jobs", record: f.record }));
  r.state.history.set(b.mergeCommit, r.state.records);
  await publisher.reconcile(COMMUNITY_ID, actor, second.subject_id);
  const current = (
    await pool.query("SELECT * FROM job_records WHERE id=$1", [record.id])
  ).rows[0];
  r.state.proposal = a;
  await publisher.reconcile(COMMUNITY_ID, actor, first.subject_id);
  const after = (
    await pool.query("SELECT * FROM job_records WHERE id=$1", [record.id])
  ).rows[0];
  assert.equal(after.payload.baseEntityHash, current.payload.baseEntityHash);
  assert.equal(after.version, current.version);
  await pool.query(
    "UPDATE job_records SET payload=payload||$2::jsonb WHERE id=$1",
    [
      record.id,
      {
        editorialClosure: { reason: "Confirmed closed" },
        status: "closed",
        expiresAt: "2026-12-01T00:00:00Z",
        editorialExpiresAt: "2026-12-01T00:00:00Z",
      },
    ],
  );
  const closed = await intake.save(
    user,
    { ...fields(record.payload.sourceUrl), version: after.version },
    "closed-edit",
    record.id,
  );
  assert.equal(closed.item.payload.status, "closed");
  assert.equal(closed.item.payload.editorialClosure.reason, "Confirmed closed");
  assert.equal(closed.item.payload.editorialExpiresAt, "2026-12-01T00:00:00Z");
  assert.equal(
    closed.item.payload.baseEntityHash,
    current.payload.baseEntityHash,
  );
});
