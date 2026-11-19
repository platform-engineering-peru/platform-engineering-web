import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  encryptSecret,
  decryptSecret,
  verifyWebhook,
  hashValue,
} from "../src/server/integrations/security";
import { reconcileJobs, normalizeJob } from "../src/server/jobs/engine";
import { isPublicAddress } from "../src/server/integrations/http";
import { manualPackage } from "../src/server/integrations/social";
test("credentials authenticated encryption and webhook signatures", () => {
  const key = Buffer.alloc(32, 7);
  const encrypted = encryptSecret({ token: "private" }, key);
  assert.equal(encrypted.includes("private"), false);
  assert.deepEqual(decryptSecret(encrypted, key), { token: "private" });
  assert.throws(() => decryptSecret(encrypted, Buffer.alloc(32, 8)));
  const body = Buffer.from('{"action":"opened"}');
  const signature =
    "sha256=" + createHmac("sha256", "secret").update(body).digest("hex");
  assert.equal(verifyWebhook(body, signature, "secret"), true);
  assert.equal(verifyWebhook(body, "sha256=00", "secret"), false);
  assert.equal(hashValue({ a: 1, b: 2 }), hashValue({ b: 2, a: 1 }));
});
test("SSRF excludes loopback private mapped IPv6 and special ranges", () => {
  for (const address of [
    "127.0.0.1",
    "10.1.1.1",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "100.64.0.1",
    "198.18.0.1",
  ])
    assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress("8.8.8.8"), true);
});
test("unknown Peru eligibility held, HTML stripped and salary never invented", () => {
  const job = normalizeJob(
    {
      id: "1",
      text: "Platform Engineer",
      categories: { location: "Remote" },
      hostedUrl: "https://jobs.lever.co/example/1",
      descriptionPlain: "Kubernetes Terraform",
    },
    {
      id: "example",
      adapter: "lever",
      boardIdentifier: "example",
      company: "Example",
    },
    new Date("2026-01-01"),
  );
  assert.equal(job.eligibility, "unknown");
  assert.equal(job.status, "candidate");
  assert.equal(job.salary, null);
});
test("failed/incomplete/abnormal empty runs cannot close jobs; exclusion survives", () => {
  const now = new Date("2026-01-03");
  const previous = [
    {
      id: "one",
      sourceId: "source",
      status: "active",
      lastVerifiedAt: "2026-01-02T00:00:00Z",
      missingSince: null,
      approved: true,
    },
    { id: "two", sourceId: "source", status: "excluded" },
  ];
  for (const state of ["failed", "incomplete", "quarantined"])
    assert.equal(
      reconcileJobs(
        previous,
        { sourceId: "source", status: state, records: [] },
        now,
      ).jobs[0].status,
      "active",
    );
  assert.equal(
    reconcileJobs(
      previous,
      { sourceId: "source", status: "complete", records: [] },
      now,
    ).status,
    "quarantined",
  );
});
test("two complete missing snapshots 12 hours apart close only below anomaly gate", () => {
  const previous = Array.from({ length: 10 }, (_, i) => ({
    id: String(i),
    sourceId: "s",
    status: "active",
    approved: true,
    eligibility: "peru",
    relevanceScore: 5,
    workplace: "remote",
    lastVerifiedAt: "2026-01-01T00:00:00Z",
  }));
  const records = previous.slice(1);
  const first = reconcileJobs(
    previous,
    { sourceId: "s", status: "complete", records },
    new Date("2026-01-02"),
  );
  assert.equal(first.jobs.find((j: any) => j.id === "0").status, "active");
  const second = reconcileJobs(
    first.jobs,
    { sourceId: "s", status: "complete", records },
    new Date("2026-01-02T12:00:00Z"),
  );
  assert.equal(second.jobs.find((j: any) => j.id === "0").status, "closed");
});
test("manual package does not claim API publication", () => {
  const value = manualPackage({
    text: "Copy",
    link: "https://example.org",
    media: [],
  });
  assert.equal(value.state, "manual-export");
  assert.equal(value.providerId, null);
});
test("job private destination literal is rejected before it can reach public export", () => {
  for (const url of [
    "https://127.0.0.1/private",
    "https://[::1]/private",
    "https://169.254.169.254/token",
    "https://service.local/",
  ])
    assert.throws(
      () =>
        normalizeJob(
          { id: "1", text: "Platform Engineer", hostedUrl: url },
          {
            id: "s",
            adapter: "lever",
            boardIdentifier: "s",
            company: "Fixture",
          },
          new Date(),
        ),
      /BLOCKED/,
    );
});
test("reopened and materially changed jobs need a fresh review on subsequent runs", () => {
  const now = new Date("2026-01-05"),
    old = {
      id: "1",
      sourceId: "s",
      status: "closed",
      approved: true,
      eligibility: "peru",
      relevanceScore: 4,
      title: "Engineer",
      lastVerifiedAt: now.toISOString(),
    },
    record = { ...old, status: "candidate" };
  const first = reconcileJobs(
    [old],
    { sourceId: "s", status: "complete", records: [record] },
    now,
  );
  assert.equal(first.jobs[0].status, "needs-review");
  assert.equal(first.jobs[0].approved, false);
  const second = reconcileJobs(
    first.jobs,
    { sourceId: "s", status: "complete", records: [record] },
    now,
  );
  assert.notEqual(second.jobs[0].status, "active");
  const changed = reconcileJobs(
    [{ ...old, status: "active" }],
    {
      sourceId: "s",
      status: "complete",
      records: [{ ...record, title: "Different" }],
    },
    now,
  );
  assert.equal(changed.jobs[0].approved, false);
});
