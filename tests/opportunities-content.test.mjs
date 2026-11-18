import test from "node:test";
import assert from "node:assert/strict";
import {
  validatePublicJobs,
  activeOpportunities,
} from "../src/data/opportunities-contract.ts";
const job = () => ({
  schemaVersion: 1,
  id: "greenhouse:fixture:1",
  slug: "fixture-platform-1",
  status: "active",
  title: "Platform Engineer",
  company: "Fixture employer",
  sourceId: "fixture",
  externalId: "1",
  sourceUrl: "https://example.org/careers/1",
  applyUrl: "https://example.org/apply/1",
  contentLanguage: "en",
  workplace: "remote",
  eligibility: "remote-peru",
  locations: ["Perú"],
  seniority: null,
  salary: null,
  summary: {
    "es-pe": "Resumen revisado de prueba.",
    en: "Reviewed fixture summary.",
  },
  tags: ["platform"],
  sourcePublishedAt: null,
  firstSeenAt: "2026-11-01T00:00:00Z",
  lastSeenAt: "2026-11-16T00:00:00Z",
  lastVerifiedAt: "2026-11-16T00:00:00Z",
  expiresAt: null,
  closureReason: null,
  evidenceRunId: "fixture-run",
});
test("canonical public jobs validate strict export shape and preserve original employer URLs", () => {
  const source = job();
  assert.deepEqual(validatePublicJobs([source]), [source]);
  assert.equal(
    activeOpportunities([source], new Date("2026-11-17T00:00:00Z"))[0].applyUrl,
    source.applyUrl,
  );
});
test("only active unexpired canonical records reach default public jobs, including zero records", () => {
  const now = new Date("2026-11-17T00:00:00Z");
  assert.deepEqual(activeOpportunities([], now), []);
  for (const status of ["stale", "closed"])
    assert.deepEqual(activeOpportunities([{ ...job(), status }], now), []);
  assert.deepEqual(
    activeOpportunities([{ ...job(), expiresAt: now.toISOString() }], now),
    [],
  );
});
test("public boundary rejects private fields, draft states, duplicate IDs/slugs, unsafe apply URLs and unknown eligibility", () => {
  for (const changed of [
    { privateNotes: "secret" },
    { approved: true },
    { status: "candidate" },
    { applyUrl: "javascript:alert(1)" },
    { applyUrl: "https://127.0.0.1/a" },
    { eligibility: "unknown" },
    { summary: { "es-pe": "", en: "missing" } },
    { expiresAt: "bad" },
  ])
    assert.throws(() => validatePublicJobs([{ ...job(), ...changed }]));
  assert.throws(() => validatePublicJobs([job(), job()]));
});

test("public jobs accept only the approved provider namespaces", () => {
  for (const namespace of ["greenhouse", "lever", "manual", "hirehive", "globant", "smartrecruiters"])
    assert.equal(validatePublicJobs([{ ...job(), id: `${namespace}:fixture:1` }])[0].id, `${namespace}:fixture:1`);
  for (const namespace of ["unknown", "custom", "Manual"])
    assert.throws(() => validatePublicJobs([{ ...job(), id: `${namespace}:fixture:1` }]));
  assert.throws(() => validatePublicJobs([{ ...job(), provenance: "private" }]));
});

test("unconfirmed workplace stays explicit without weakening Peru eligibility or lifecycle rules", () => {
  const now = new Date("2026-11-17T00:00:00Z");
  const source = {
    ...job(),
    workplace: "unknown",
    eligibility: "peru",
    seniority: "Senior",
  };
  assert.deepEqual(validatePublicJobs([source]), [source]);
  const [active] = activeOpportunities([source], now);
  assert.equal(active.workplace, "unknown");
  assert.equal(active.eligibility, "peru");
  assert.equal(active.applyUrl, source.applyUrl);
  assert.deepEqual(
    activeOpportunities([{ ...source, expiresAt: now.toISOString() }], now),
    [],
  );
  assert.deepEqual(activeOpportunities([{ ...source, status: "closed" }], now), []);
  assert.throws(() => validatePublicJobs([{ ...source, eligibility: "unknown" }]));
  for (const workplace of ["", "unconfirmed", "Remote", null])
    assert.throws(() => validatePublicJobs([{ ...source, workplace }]));
  for (const workplace of ["remote", "hybrid", "onsite"])
    assert.equal(validatePublicJobs([{ ...source, workplace }])[0].workplace, workplace);
});
