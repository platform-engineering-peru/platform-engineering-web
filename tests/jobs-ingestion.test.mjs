import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  collect,
  validateArtifact,
  validateSource,
} from "../scripts/jobs/collect.mjs";
import { reconcileJobs, normalizeJob } from "../scripts/jobs/engine.mjs";
import { isPublicAddress } from "../scripts/jobs/http.mjs";
test("collector registry defaults to no enabled sources, no network", async () => {
  const registry = JSON.parse(
    await readFile("scripts/jobs/sources.json", "utf8"),
  );
  assert.equal(registry.sources.filter((s) => s.enabled).length, 0);
  let calls = 0;
  const result = await collect(registry, async () => {
    calls++;
    throw 0;
  });
  assert.equal(calls, 0);
  assert.equal(result.candidates.length, 0);
  validateArtifact(result);
});
test("public collector rejects unreviewed sources and private artifacts", () => {
  assert.throws(() =>
    validateSource({ id: "source", adapter: "lever", enabled: true }),
  );
  assert.throws(() =>
    validateArtifact({
      schemaVersion: 1,
      sources: [],
      candidates: [],
      jobs: [],
      accessToken: "secret",
    }),
  );
  for (const ip of ["127.0.0.1", "169.254.169.254", "::ffff:10.0.0.1"])
    assert.equal(isPublicAddress(ip), false);
});
test("source failure retains jobs and abnormal empty result quarantines", () => {
  const old = [
    {
      id: "lever:s:1",
      sourceId: "s",
      status: "active",
      lastVerifiedAt: new Date().toISOString(),
    },
  ];
  assert.equal(
    reconcileJobs(old, { sourceId: "s", status: "failed", records: [] }).jobs[0]
      .status,
    "active",
  );
  assert.equal(
    reconcileJobs(old, { sourceId: "s", status: "complete", records: [] })
      .status,
    "quarantined",
  );
});
test("job normalization holds unknown remote eligibility", () => {
  const job = normalizeJob(
    {
      id: "1",
      text: "Platform Engineer",
      categories: { location: "Remote" },
      hostedUrl: "https://jobs.lever.co/f/1",
    },
    { id: "f", adapter: "lever", company: "Fixture" },
    new Date(),
  );
  assert.equal(job.eligibility, "unknown");
  assert.equal(job.approved, false);
  assert.equal(job.salary, null);
});
test("publish artifact checksum and reviewed-source gates and no-op timestamps", async () => {
  const { prepareExport, meaningfulEvidence } =
    await import("../scripts/jobs/publish.mjs");
  const { createHash } = await import("node:crypto");
  const value = {
      schemaVersion: 1,
      rulesVersion: "1",
      sources: [],
      candidates: [],
      jobs: [],
    },
    body = JSON.stringify(value),
    checksum = createHash("sha256").update(body).digest("hex");
  assert.equal(
    (await prepareExport(body, checksum, { sources: [] }))[0].path,
    "content/collection/latest.json",
  );
  await assert.rejects(prepareExport(body, "bad", { sources: [] }), /checksum/);
  assert.equal(
    meaningfulEvidence({ ...value, startedAt: "a", runId: "1" }),
    meaningfulEvidence({ ...value, startedAt: "b", runId: "2" }),
  );
});
test("scheduled ingestion has two least-privileged SHA-pinned jobs and no automatic source activation", async () => {
  const workflow = await readFile(".github/workflows/jobs-sync.yml", "utf8");
  assert.match(
    workflow,
    /concurrency:\n  group: jobs-sync\n  cancel-in-progress: false/,
  );
  assert.equal((workflow.match(/timeout-minutes: 20/g) || []).length, 2);
  for (const action of workflow.matchAll(/uses: ([^\s]+)/g))
    assert.match(action[1], /@[a-f0-9]{40}$/);
  const fetch = workflow.split("  publish:")[0];
  assert.doesNotMatch(fetch, /JOBS_APP_PRIVATE_KEY|secrets\./);
  assert.doesNotMatch(workflow, /pull_request_target|contents: write/);
});
