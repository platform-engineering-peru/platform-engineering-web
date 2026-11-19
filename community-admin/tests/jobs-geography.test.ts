import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeJob,
  publicJobs,
  reconcileJobs,
} from "../src/server/jobs/engine";
const now = new Date("2026-11-18T15:00:00Z");
const source: any = {
  id: "geo",
  adapter: "greenhouse",
  boardIdentifier: "geo",
  company: "Company operating in Peru",
};
const raw = (location: string, extra: any = {}) => ({
  id: "one",
  title: "Storage Platform Engineer",
  location: { name: location },
  absolute_url: "https://employer.example/jobs/one",
  ...extra,
});
const reviewed = (record: any) => ({
  ...record,
  approved: true,
  status: "active",
  summary: {
    "es-pe": "Ingeniería de plataforma.",
    en: "Platform engineering.",
  },
});
test("explicit Peru or remote LATAM qualifies; remote alone and employer presence never do", async () => {
  for (const location of [
    "Kuala Lumpur, Malaysia",
    "Remote",
    "London, United Kingdom",
  ]) {
    const job = normalizeJob(raw(location), source, now);
    assert.equal(job.eligibility, "unknown");
    assert.equal(
      publicJobs([reviewed({ ...job, eligibility: "peru" })]).length,
      0,
      location,
    );
  }
  for (const [location, fields] of [
    ["Peru", {}],
    ["Lima, Perú", {}],
    ["Remote Peru", {}],
    ["Remote LATAM", {}],
    ["Latin America", { workplaceType: "remote" }],
    ["América Latina", { workplaceType: "remote" }],
  ] as const) {
    const job = normalizeJob(raw(location, fields), source, now);
    assert.notEqual(job.eligibility, "unknown", location);
    assert.equal(publicJobs([reviewed(job)]).length, 1, location);
    const pairedPath = "../../scripts/jobs/engine.mjs";
    const paired = await import(pairedPath);
    assert.deepEqual(
      paired.normalizeJob(raw(location, fields), source, now),
      job,
    );
    assert.deepEqual(
      paired.publicJobs([reviewed(job)]),
      publicJobs([reviewed(job)]),
    );
  }
  for (const location of ["LATAM", "Latin America"]) {
    const job = normalizeJob(
      raw(location, { workplaceType: "onsite" }),
      source,
      now,
    );
    assert.equal(job.eligibility, "unknown");
    assert.equal(
      publicJobs([reviewed({ ...job, eligibility: "remote-latam-confirmed" })])
        .length,
      0,
    );
  }
});
test("unknown facts stay blocked while trusted Peru applicant-country facts and closed withdrawals survive", () => {
  const job = normalizeJob(raw("Kuala Lumpur, Malaysia"), source, now);
  assert.equal(
    publicJobs([
      reviewed({
        ...job,
        eligibility: "remote-peru",
        sourceExcerpt: "Our employer has offices in Peru",
      }),
    ]).length,
    0,
  );
  const peru = normalizeJob(raw("Peru"), source, now);
  assert.equal(
    publicJobs([reviewed({ ...peru, eligibility: "unknown" })]).length,
    0,
  );
  const applicant = reviewed({
    ...job,
    workplace: "remote",
    eligibility: "remote-peru",
    detailEvidence: { eligibilityText: "Peru" },
  });
  assert.equal(publicJobs([applicant]).length, 1);
  const withdrawal = {
    ...reviewed(job),
    status: "closed",
    eligibility: "peru",
    baseEntityHash: "a".repeat(64),
  };
  assert.equal(publicJobs([withdrawal]).length, 1);
  assert.equal(publicJobs([{ ...withdrawal, baseEntityHash: null }]).length, 0);
});

test("explicit applicant restrictions outrank location and stale editorial overrides", async () => {
  const initial = reviewed(normalizeJob(raw("Lima, Peru"), source, now));
  const restricted = normalizeJob(
    raw("Lima, Peru", {
      content:
        "Platform duties. Applicants must reside in the United States only.",
    }),
    source,
    now,
  );
  assert.equal(restricted.eligibility, "restricted");
  assert.equal(
    publicJobs([
      reviewed({
        ...restricted,
        eligibility: "peru",
        editorialEligibility: "peru",
      }),
    ]).length,
    0,
  );
  const result = reconcileJobs(
    [{ ...initial, editorialEligibility: "peru" }],
    {
      sourceId: source.id,
      status: "complete",
      records: [restricted],
      observedIds: [restricted.id],
      totalFound: 1,
      fetchedCount: 1,
    },
    now,
  );
  assert.equal(result.jobs[0].approved, false);
  assert.equal(result.jobs[0].editorialEligibility, undefined);
  assert.equal(result.jobs[0].eligibility, "restricted");
  const pairedPath = "../../scripts/jobs/engine.mjs";
  const paired = await import(pairedPath);
  assert.deepEqual(
    paired.normalizeJob(
      raw("Lima, Peru", {
        content:
          "Platform duties. Applicants must reside in the United States only.",
      }),
      source,
      now,
    ),
    restricted,
  );
});

test("incidental Peru prose cannot neutralize an explicit foreign applicant restriction", () => {
  const job = normalizeJob(
    raw("Lima, Peru", {
      content:
        "Our company operates in Peru and applicants must reside in the United States only.",
    }),
    source,
    now,
  );
  assert.equal(job.eligibility, "restricted");
  assert.equal(publicJobs([reviewed(job)]).length, 0);
  const skills = normalizeJob(
    raw("Peru", {
      content:
        "Applicants must have five years of platform engineering experience.",
    }),
    source,
    now,
  );
  assert.equal(skills.eligibility, "peru");
  const long = normalizeJob(
    raw("Peru", {
      content:
        "Platform engineering duties. ".repeat(30) +
        "Applicants must reside in the United States only.",
    }),
    source,
    now,
  );
  assert.doesNotMatch(long.sourceExcerpt, /United States/);
  assert.equal(
    publicJobs([reviewed({ ...long, eligibility: "peru" })]).length,
    0,
  );
  assert.ok(
    !Object.hasOwn(publicJobs([reviewed(skills)])[0], "geographyEvidence"),
  );
});

test("Peru exclusions and foreign residents-only facts override positive region labels", async () => {
  const pairedPath = "../../scripts/jobs/engine.mjs";
  const paired = await import(pairedPath);
  for (const [location, content] of [
    ["Remote LATAM excluding Peru", ""],
    ["Remote Latin America (except Peru)", ""],
    ["Remoto LATAM excepto Perú", ""],
    ["Remote Peru", "United States residents only."],
  ]) {
    const next = normalizeJob(raw(location, { content }), source, now);
    assert.equal(next.eligibility, "restricted", location + content);
    assert.equal(
      publicJobs([
        reviewed({
          ...next,
          eligibility: "peru",
          editorialEligibility: "peru",
        }),
      ]).length,
      0,
    );
    assert.deepEqual(
      paired.normalizeJob(raw(location, { content }), source, now),
      next,
    );
    const before = reviewed({
      ...normalizeJob(raw("Remote Peru"), source, now),
      editorialEligibility: "peru",
    });
    const refreshed = reconcileJobs(
      [before],
      {
        sourceId: source.id,
        status: "complete",
        records: [next],
        observedIds: [next.id],
      },
      now,
    ).jobs[0];
    assert.equal(refreshed.approved, false);
    assert.equal(refreshed.editorialEligibility, undefined);
  }
});
