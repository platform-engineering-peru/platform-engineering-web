import test from "node:test";
import assert from "node:assert/strict";
import {
  parseVacancyDetail,
  inspectVacancy,
  canonicalVacancyUrl,
  strongVacancyDuplicates,
} from "../src/server/jobs/intake";
import type { Transport } from "../src/server/integrations/http";
const url = "https://employer.example/jobs/123?utm_source=test&jobId=123";
const ld = (value: unknown) =>
  `<html><script type="application/ld+json">${JSON.stringify(value)}</script></html>`;
const posting = {
  "@type": "JobPosting",
  title: "Platform Engineer",
  hiringOrganization: { name: "Employer" },
  identifier: { value: "REQ-123" },
  jobLocation: { address: { addressLocality: "Lima", addressCountry: "PE" } },
  datePosted: "2026-11-01",
  validThrough: "2027-01-01",
};
test("single original detail extracts factual JSON-LD and explicit Peru, not salary or summaries", () => {
  const p = parseVacancyDetail(ld(posting), url, new Date("2026-11-18"));
  assert.equal(p.support, "extracted");
  assert.equal(p.draft.title, "Platform Engineer");
  assert.equal(p.draft.eligibility, "peru");
  assert.match(p.evidence.eligibilityText, /PE/);
  assert.equal(p.draft.requisitionId, "REQ-123");
  assert.equal(p.draft.salary, undefined);
  assert.equal(p.draft.summary, undefined);
  assert.equal(
    p.draft.sourceUrl,
    "https://employer.example/jobs/123?jobId=123",
  );
});
test("explicit remote LATAM qualifies while worldwide remote and company presence require review", () => {
  const remote = {
    ...posting,
    jobLocation: undefined,
    jobLocationType: "TELECOMMUTE",
    applicantLocationRequirements: { name: "Latin America" },
  };
  assert.equal(
    parseVacancyDetail(ld(remote), url).draft.eligibility,
    "remote-latam-confirmed",
  );
  assert.equal(
    parseVacancyDetail(ld([posting, { ...posting, title: "SRE" }]), url)
      .support,
    "manual-required",
  );
  assert.equal(
    parseVacancyDetail("<html>We work in Peru. Join us</html>", url).support,
    "manual-required",
  );
  assert.equal(
    parseVacancyDetail(
      ld({ ...remote, applicantLocationRequirements: undefined }),
      url,
    ).draft.eligibility,
    "unknown",
  );
  const pe = {
    ...remote,
    applicantLocationRequirements: { "@type": "Country", name: "Peru" },
  };
  assert.equal(
    parseVacancyDetail(ld(pe), url).draft.eligibility,
    "remote-peru",
  );
});
test("closed or expired detail never reports an active vacancy", () => {
  assert.equal(
    parseVacancyDetail(
      ld({ ...posting, validThrough: "2026-01-01" }),
      url,
      new Date("2026-11-18"),
    ).evidence.active,
    "closed",
  );
  assert.equal(
    parseVacancyDetail(
      "<p>No longer accepting applications</p>" + ld(posting),
      url,
    ).evidence.active,
    "closed",
  );
});
test("evidenced HireHive encoded type and Globant original detail layouts remain scoped", () => {
  const hire = ld(posting).replace(
    "application/ld+json",
    "application/ld&#x2B;json",
  );
  assert.equal(
    parseVacancyDetail(hire, "https://credicorp.hirehive.com/job-lima-Abc123")
      .support,
    "extracted",
  );
  const html =
    "<h1>BUILD THE FUTURE</h1><h3>DevOps Engineer, Azure/AWS, Senior - PE</h3><span>Lima, Peru</span><p>This job can be filled in <strong>Perú</strong> #LI-hybrid</p><button>Apply</button><h3>Find answers to all your questions</h3>";
  const parsed = parseVacancyDetail(
    html,
    "https://career.globant.com/job/devops-engineer/74591",
  );
  assert.equal(parsed.support, "extracted");
  assert.equal(parsed.draft.company, "Globant");
  assert.equal(parsed.draft.eligibility, "peru");
  assert.equal(parsed.draft.workplace, "hybrid");
  assert.equal(
    parseVacancyDetail(html, "https://other.example/job/devops-engineer/74591")
      .support,
    "manual-required",
  );
});
test("canonical URLs preserve identity query keys and reject private/credential URLs", () => {
  assert.equal(
    canonicalVacancyUrl(url),
    "https://employer.example/jobs/123?jobId=123",
  );
  for (const u of [
    "http://example.com/jobs/1",
    "https://127.0.0.1/a",
    "https://user:pass@example.com/a",
  ])
    assert.throws(() => canonicalVacancyUrl(u));
});
test("detail fetch checks robots, fails closed for denial and never follows cross-origin links", async () => {
  const calls: string[] = [];
  let robots = "User-agent: *\nDisallow: /jobs";
  const transport: Transport = async (input) => {
    calls.push(input);
    return {
      status: 200,
      headers: {
        "content-type": input.endsWith("robots.txt")
          ? "text/plain"
          : "text/html",
      },
      body: Buffer.from(input.endsWith("robots.txt") ? robots : ld(posting)),
    };
  };
  const blocked = await inspectVacancy(url, transport);
  assert.equal(blocked.reason, "ROBOTS_DISALLOWED");
  assert.equal(calls.length, 1);
  robots = "User-agent: *\nAllow: /";
  calls.length = 0;
  assert.equal((await inspectVacancy(url, transport)).support, "extracted");
  assert.equal(calls.length, 2);
  const redirect: Transport = async (input) =>
    input.endsWith("robots.txt")
      ? {
          status: 404,
          headers: {} as Record<string, string>,
          body: Buffer.alloc(0),
        }
      : {
          status: 302,
          headers: { location: "https://different.example/jobs/1" },
          body: Buffer.alloc(0),
        };
  assert.equal(
    (await inspectVacancy(url, redirect)).reason,
    "DETAIL_REDIRECT_BLOCKED",
  );
});
test("403/429/invalid content are honest manual-required outcomes without fake source facts", async () => {
  for (const status of [403, 429]) {
    const transport: Transport = async (input) => ({
      status: input.endsWith("robots.txt") ? 404 : status,
      headers: { "content-type": "text/html" },
      body: Buffer.from(ld(posting)),
    });
    const result = await inspectVacancy(url, transport);
    assert.equal(result.support, "manual-required");
    assert.equal(result.draft.title, undefined);
    assert.equal(result.evidence.status, status);
  }
});
test("strong duplicates use canonical original URL or same employer requisition, not title alone", () => {
  const jobs = [
    {
      id: "1",
      company: "Employer",
      applyUrl: url,
      requisitionId: "REQ-123",
      requisitionVerified: true,
    },
    {
      id: "2",
      company: "employer",
      applyUrl: "https://other.example/jobs/2",
      requisitionId: "REQ-123",
      requisitionVerified: true,
    },
    {
      id: "3",
      company: "Different",
      applyUrl: "https://other.example/jobs/3",
      requisitionId: "REQ-123",
      requisitionVerified: true,
    },
  ];
  assert.deepEqual(
    strongVacancyDuplicates(jobs).map((g) => g.ids),
    [["1", "2"]],
  );
});

test("structured applicant restrictions outrank Peru location and remote LATAM", () => {
  const restricted = parseVacancyDetail(
    ld({
      ...posting,
      jobLocationType: "TELECOMMUTE",
      applicantLocationRequirements: { name: "United States" },
    }),
    url,
  );
  assert.equal(restricted.draft.eligibility, "restricted");
  const prose = parseVacancyDetail(
    ld({
      ...posting,
      description: "Applicants must reside in the United States only.",
    }),
    url,
  );
  assert.equal(prose.draft.eligibility, "restricted");
});

test("applicant scope explicitly excluding Peru cannot qualify via LATAM or Peru location", () => {
  const value = parseVacancyDetail(
    ld({
      ...posting,
      jobLocationType: "TELECOMMUTE",
      applicantLocationRequirements: { name: "Latin America except Peru" },
    }),
    url,
  );
  assert.equal(value.draft.eligibility, "restricted");
});
