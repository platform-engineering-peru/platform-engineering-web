import test from "node:test";
import assert from "node:assert/strict";
import {
  discoverCareers,
  identifyBoard,
  robotsDenied,
} from "../src/server/jobs/discovery";
import {
  normalizeJob,
  collectSource,
  reconcileJobs,
  classifyRole,
} from "../src/server/jobs/engine";
import type { Transport } from "../src/server/integrations/http";
const response = (value: any, type = "application/json", status = 200) => ({
  status,
  headers: { "content-type": type },
  body: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)),
});
const source = {
  id: "fixture",
  adapter: "greenhouse" as const,
  boardIdentifier: "fixture",
  company: "Fixture",
  enabled: true,
  reviewedAt: "2026-01-01T00:00:00Z",
  reviewReference: "fixture-review",
  permissionBasis: "fixture permission",
  termsUrl: "https://example.com/terms",
  allowedHosts: ["boards-api.greenhouse.io"],
};
const raw = (title: string, id = "1", extra: any = {}) => ({
  id,
  title,
  location: { name: "Remote" },
  absolute_url: `https://boards.greenhouse.io/fixture/jobs/${id}`,
  content: "Maintain reliable systems.",
  ...extra,
});
const developerPlatformNonEngineeringTitles = [
  "Senior Solutions Architect, APJC (Developer Platform) - India Market",
  "Principal Solutions Architect, APJC (Developer Platform) - Mandarin Speaking",
  "Technical Support Engineer - Developer Platform",
  "Senior Practice Leader, Developer Platform for Professional Services, APAC",
  "Technical Support Engineer, Developer Platform",
  "Executive Assistant - Developer Platform",
  "Principal, Developer Platform Positioning",
  "Executive Assistant - Developer Experience",
  "Technical Support Engineer - Developer Experience",
];
const developerPlatformEngineeringTitles = [
  "Software Engineer, Developer Platform",
  "Senior Software Engineer - Developer Experience",
  "Developer Platform Engineer",
  "Developer Experience Engineering Manager",
  "Engineering Manager, Developer Platform",
];
test("developer platform and experience team names require an engineering role", () => {
  for (const title of developerPlatformNonEngineeringTitles)
    assert.equal(classifyRole(title), null, title);
  for (const title of developerPlatformEngineeringTitles)
    assert.equal(classifyRole(title), "platform", title);
});
test("requested role families are explicit and unrelated titles do not match", () => {
  for (const [title, family] of [
    ["Senior DevOps Engineer", "devops"],
    ["Platform Engineer", "platform"],
    ["Site Reliability Engineer", "sre"],
    ["SRE", "sre"],
    ["Forward Deployed Engineer", "fde"],
    ["FDE", "fde"],
    ["Cloud Infrastructure Engineer", "infrastructure"],
  ]) {
    const j = normalizeJob(raw(title), source, new Date());
    assert.equal(j.roleFamily, family, title);
    assert.ok(j.relevanceScore >= 4);
    assert.equal(j.eligibility, "unknown");
    assert.equal(j.approved, false);
  }
  for (const title of [
    "DevOps Account Executive",
    "SRE Recruiter",
    "Infrastructure Sales Engineer",
    "Marketing Platform Manager",
    "Software Engineer",
    "Civil Infrastructure Engineer",
    "Forward Deployment Sales",
  ]) {
    assert.equal(classifyRole(title), null, title);
  }
});
test("source URLs identify exact supported public boards without network or invented approval", async () => {
  let calls = 0;
  const transport: Transport = async () => {
    calls++;
    throw Error("no fetch");
  };
  for (const url of [
    "https://boards.greenhouse.io/acme",
    "https://boards.greenhouse.io/embed/job_board?for=acme",
    "https://job-boards.greenhouse.io/acme/jobs/123",
    "https://jobs.lever.co/acme/123",
    "https://api.lever.co/v0/postings/acme?mode=json",
  ]) {
    const d = await discoverCareers(url, "Acme", transport);
    assert.equal(d.supported, true);
    assert.equal(d.boardIdentifier, "acme");
    assert.equal(d.config.enabled, false);
    assert.equal(d.config.reviewedAt, undefined);
  }
  assert.equal(calls, 0);
  for (const url of [
    "http://jobs.lever.co/acme",
    "https://user:pass@jobs.lever.co/acme",
    "https://127.0.0.1/careers",
    "https://localhost/careers",
    "https://jobs.lever.co.evil.example/acme",
  ]) {
    if (url.includes("evil")) assert.equal(identifyBoard(new URL(url)), null);
    else await assert.rejects(() => discoverCareers(url, "Acme", transport));
  }
});
test("company HTML discovery is bounded and detects explicit links/iframes, unsupported stays honest", async () => {
  const transport: Transport = async (url) =>
    url.endsWith("/robots.txt")
      ? response("User-agent: *\nAllow: /", "text/plain")
      : response(
          '<html><iframe src="https://boards.greenhouse.io/acme"></iframe></html>',
          "text/html",
        );
  const d = await discoverCareers(
    "https://company.example/careers",
    "Acme",
    transport,
  );
  assert.equal(d.supported, true);
  assert.equal(d.provider, "greenhouse");
  assert.equal(d.evidence.method, "html-link");
  const unsupported = await discoverCareers(
    "https://company.example/careers",
    "Acme",
    async (url) =>
      url.endsWith("/robots.txt")
        ? response("", "text/plain", 404)
        : response("<div id=app>JavaScript careers</div>", "text/html"),
  );
  assert.equal(unsupported.supported, false);
  assert.equal(unsupported.reason, "UNSUPPORTED_CAREERS_PAGE");
  const denied = await discoverCareers(
    "https://company.example/careers",
    "Acme",
    async () => response("User-agent: *\nDisallow: /careers", "text/plain"),
  );
  assert.equal(denied.supported, false);
  assert.equal(denied.reason, "ROBOTS_DISALLOWED");
  await assert.rejects(() =>
    discoverCareers("https://company.example/careers", "Acme", async (url) =>
      url.endsWith("/robots.txt")
        ? response("", "text/plain", 404)
        : {
            status: 302,
            headers: { location: "https://127.0.0.1/x" },
            body: Buffer.alloc(0),
          },
    ),
  );
});
test("complete collection filters requested roles while preserving complete board identity evidence and expiry", async () => {
  const r = await collectSource(
    source,
    async () =>
      response({
        jobs: [
          raw("DevOps Engineer", "a", {
            validThrough: "2026-12-01T00:00:00Z",
            datePosted: "2026-10-01T00:00:00Z",
          }),
          raw("Account Executive", "b"),
        ],
      }),
    new Date("2026-11-01"),
  );
  assert.equal(r.status, "complete");
  assert.equal(r.recordsFetched, 2);
  assert.equal(r.records.length, 1);
  assert.equal(r.records[0].expiresAt, "2026-12-01T00:00:00.000Z");
  assert.equal(r.records[0].sourcePublishedAt, "2026-10-01T00:00:00.000Z");
  assert.equal(r.records[0].roleFamily, "devops");
  assert.ok(r.observedIds.includes("greenhouse:fixture:b"));
  for (const date of ["not-a-date", "2026-02-30", "2026-99-99"])
    assert.equal(
      normalizeJob(raw("SRE", "x", { validThrough: date }), source, new Date())
        .expiresAt,
      null,
    );
});
test("expiry retires stale/candidate records, missing closure needs two distinct complete snapshots twelve hours apart", () => {
  const now = new Date("2026-11-17T12:00:00Z");
  for (const status of ["candidate", "active", "stale", "needs-review"]) {
    const j = reconcileJobs(
      [
        {
          id: "x",
          sourceId: "fixture",
          status,
          expiresAt: "2026-11-16T00:00:00Z",
        },
      ],
      { sourceId: "fixture", status: "failed", records: [] },
      now,
    ).jobs[0];
    assert.equal(j.status, "closed");
    assert.equal(j.closureReason, "expired");
  }
  const jobs = Array.from({ length: 10 }, (_, i) => ({
    id: String(i),
    sourceId: "fixture",
    status: "active",
    approved: true,
    eligibility: "peru",
    relevanceScore: 5,
    workplace: "remote",
    lastVerifiedAt: now.toISOString(),
  }));
  const run = {
    sourceId: "fixture",
    runId: "run-a",
    status: "complete",
    records: jobs.slice(1),
  };
  const first = reconcileJobs(jobs, run, now);
  assert.equal(first.jobs[0].status, "active");
  assert.equal(
    reconcileJobs(first.jobs, run, new Date(now.getTime() + 13 * 3600000))
      .jobs[0].status,
    "active",
  );
  assert.equal(
    reconcileJobs(
      first.jobs,
      { ...run, runId: "run-b" },
      new Date(now.getTime() + 13 * 3600000),
    ).jobs[0].status,
    "closed",
  );
  for (const status of ["failed", "incomplete", "quarantined"]) {
    assert.notEqual(
      reconcileJobs(
        first.jobs,
        { ...run, runId: "run-c", status },
        new Date(now.getTime() + 13 * 3600000),
      ).jobs[0].status,
      "closed",
    );
  }
  assert.equal(
    reconcileJobs([jobs[0]], { ...run, records: [] }, now).status,
    "quarantined",
  );
});

test("robots groups, specificity, encoded octets, and redirect destinations are enforced before each fetch", async () => {
  assert.equal(
    robotsDenied(
      "User-agent: *\nUser-agent: OtherBot\nDisallow: /private",
      "/private-careers",
    ),
    true,
  );
  assert.equal(
    robotsDenied(
      "User-agent: *\nDisallow: /careers\nAllow: /careers/open$",
      "/careers/open",
    ),
    false,
  );
  assert.equal(
    robotsDenied(
      "User-agent: *\nDisallow: /careers\nAllow: /careers/open$",
      "/careers/open/more",
    ),
    true,
  );
  assert.equal(
    robotsDenied("User-agent: *\nDisallow: /*private$", "/x/private"),
    true,
  );
  assert.equal(
    robotsDenied("User-agent: *\nDisallow: /careers", "/%63areers"),
    true,
  );
  const calls: string[] = [];
  const d = await discoverCareers(
    "https://company.example/careers",
    "Acme",
    async (url) => {
      calls.push(url);
      if (url.endsWith("/robots.txt"))
        return response(
          "User-agent: *\nDisallow: /private-careers",
          "text/plain",
        );
      return {
        status: 302,
        headers: { location: "/private-careers" },
        body: Buffer.alloc(0),
      };
    },
  );
  assert.equal(d.reason, "ROBOTS_DISALLOWED");
  assert.equal(
    calls.some((c) => c.endsWith("/private-careers")),
    false,
  );
});
test("known expiry is retained when omitted; observed loss of role invalidates public approval", () => {
  const now = new Date("2026-11-17"),
    original = normalizeJob(
      raw("Platform Engineer", "1", { validThrough: "2026-11-01T00:00:00Z" }),
      source,
      now,
    );
  original.status = "closed";
  original.approved = true;
  original.eligibility = "peru";
  const incoming = normalizeJob(raw("Platform Engineer", "1"), source, now);
  const result = reconcileJobs(
    [original],
    {
      sourceId: "fixture",
      runId: "new",
      status: "complete",
      records: [incoming],
    },
    now,
  );
  assert.equal(result.jobs[0].expiresAt, original.expiresAt);
  assert.equal(result.jobs[0].status, "closed");
  original.status = "active";
  original.expiresAt = null;
  const changed = reconcileJobs(
    [original],
    {
      sourceId: "fixture",
      runId: "changed",
      status: "complete",
      records: [],
      observedIds: [original.id],
    },
    now,
  ).jobs[0];
  assert.equal(changed.status, "needs-review");
  assert.equal(changed.approved, false);
  assert.equal(changed.missingSince, undefined);
  original.status = "closed";
  original.editorialClosure = { reason: "curator confirmed" };
  const closed = reconcileJobs(
    [original],
    {
      sourceId: "fixture",
      status: "complete",
      records: [{ ...incoming, eligibility: "peru" }],
    },
    now,
  ).jobs[0];
  assert.equal(closed.status, "closed");
  assert.equal(closed.approved, true);
});

test("standalone public collector keeps normalization and lifecycle behavior aligned", async () => {
  const publicEnginePath = "../../scripts/jobs/engine.mjs";
  const publicEngine: any = await import(publicEnginePath);
  const now = new Date("2026-11-17");
  for (const title of [
    "DevOps Engineer",
    "Platform Engineer",
    "SRE",
    "FDE",
    "Infrastructure Engineer",
    "Sales Engineer",
    ...developerPlatformNonEngineeringTitles,
    ...developerPlatformEngineeringTitles,
  ]) {
    assert.deepEqual(
      publicEngine.normalizeJob(raw(title), source, now),
      normalizeJob(raw(title), source, now),
    );
  }
  const j = normalizeJob(
    raw("SRE", "one", { validThrough: "2026-11-01T00:00:00Z" }),
    source,
    now,
  );
  const run = { sourceId: "fixture", status: "failed", records: [] };
  assert.deepEqual(
    publicEngine.reconcileJobs([j], run, now),
    reconcileJobs([j], run, now),
  );
});
