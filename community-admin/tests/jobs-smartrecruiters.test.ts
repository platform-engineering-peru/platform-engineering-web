import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { collectSmartRecruiters } from "../src/server/jobs/providers/smartrecruiters";
import type { Transport } from "../src/server/integrations/http";
const source = {
  boardIdentifier: "Inetum2",
  allowedHosts: ["api.smartrecruiters.com"],
};
const relevant = (title: string) => /devsecops/i.test(title);
const response = (value: unknown, status = 200) => ({
  status,
  headers: { "content-type": "application/json" },
  body: Buffer.from(JSON.stringify(value)),
});
const row = (id = "123") => ({
  id,
  name: "DevSecOps Engineer",
  company: { identifier: "Inetum2" },
  location: {
    country: "pe",
    fullLocation: "Lima, Peru",
    remote: false,
    hybrid: false,
  },
});
const detail = (extra: any = {}) => ({
  ...row(),
  refNumber: "REF123",
  active: true,
  postingUrl: "https://jobs.smartrecruiters.com/Inetum2/123-devsecops",
  applyUrl: "https://jobs.smartrecruiters.com/Inetum2/123-devsecops?oga=true",
  jobAd: {
    sections: {
      jobDescription: { text: "<p>Maintain Kubernetes CI/CD.</p>" },
      additionalInformation: { text: "<p>Trabajo híbrido</p>" },
    },
  },
  ...extra,
});
test("bounded official requests preserve original URLs, requisition and explicit mode", async () => {
  const calls: string[] = [];
  const transport: Transport = async (url, options) => {
    calls.push(url);
    assert.deepEqual(options?.hosts, ["api.smartrecruiters.com"]);
    assert.equal(options?.maxBytes, 4_000_000);
    assert.equal(options?.timeoutMs, 15_000);
    return response(
      calls.length === 1
        ? { offset: 0, limit: 100, totalFound: 1, content: [row()] }
        : detail(),
    );
  };
  const run = await collectSmartRecruiters(source, transport, {
    isRelevantTitle: relevant,
  });
  assert.equal(run.status, "complete");
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0]).searchParams.get("country"), "pe");
  assert.deepEqual(run.observed, [{ id: "123", title: "DevSecOps Engineer" }]);
  assert.equal(run.records[0].requisition_id, "REF123");
  assert.equal(run.records[0].metadata[0].value, "hybrid");
  assert.match(run.records[0].applyUrl, /\?oga=true$/);
});
test("false remote/hybrid flags stay unknown and unsafe/mismatched detail is refused", async () => {
  for (const extra of [
    {
      jobAd: {
        sections: {
          jobDescription: { text: "Operate hybrid cloud and remote servers" },
        },
      },
    },
    { postingUrl: "https://127.0.0.1/x" },
    { id: "other" },
    { company: { identifier: "Other" } },
    { location: { country: "cl" } },
  ]) {
    const run = await collectSmartRecruiters(
      source,
      async (url) =>
        response(
          url.endsWith("/123")
            ? detail(extra)
            : { offset: 0, limit: 100, totalFound: 1, content: [row()] },
        ),
      { isRelevantTitle: relevant },
    );
    if (extra.jobAd) {
      assert.equal(run.status, "complete");
      assert.equal(run.records[0].metadata[0].value, "unknown");
    } else {
      assert.notEqual(run.status, "complete");
      assert.equal(run.records.length, 0);
    }
  }
});
test("incomplete listing/detail/rate-limit/budget never authorizes closures", async () => {
  for (const scenario of [
    "detail",
    "page",
    "duplicate",
    "count",
    "limit",
    "oversize",
  ]) {
    let calls = 0;
    const run = await collectSmartRecruiters(
      { ...source, pageLimit: scenario === "limit" ? 1 : 3 },
      async () => {
        calls++;
        if (scenario === "oversize")
          return { ...response({}), body: Buffer.alloc(4_000_001) };
        if (scenario === "detail" && calls === 2) return response({}, 429);
        if (scenario === "page" && calls === 2) return response({}, 503);
        return response({
          offset: (calls - 1) * 100,
          limit: 100,
          totalFound:
            scenario === "count" && calls > 1
              ? 202
              : scenario === "detail"
                ? 1
                : 201,
          content:
            scenario === "duplicate"
              ? [row(), row()]
              : scenario === "detail"
                ? [row()]
                : Array.from({ length: 100 }, (_, i) =>
                    row(String((calls - 1) * 100 + i)),
                  ),
        });
      },
      { isRelevantTitle: relevant },
    );
    assert.notEqual(run.status, "complete", scenario);
    assert.ok(calls <= 3, scenario);
  }
  const denied = await collectSmartRecruiters(
    { ...source, allowedHosts: [] },
    async () => {
      throw Error("must not request");
    },
    { isRelevantTitle: relevant },
  );
  assert.equal(denied.status, "failed");
});
const corpus = new URL(
  "../.local/qa/peru-additional-coverage/",
  import.meta.url,
);
test(
  "actual saved Inetum236 inventory and four relevant details replay without network",
  { skip: !existsSync(new URL("inetum2-raw.json", corpus)) },
  async () => {
    const load = (name: string) =>
      JSON.parse(readFileSync(new URL(name, corpus), "utf8"));
    const pages = [
      load("inetum2-raw.json"),
      load("inetum2-page-100.json"),
      load("inetum2-page-200.json"),
    ];
    const ids = [
      "744000041197550",
      "744000071578685",
      "744000091660675",
      "744000104342420",
    ];
    const calls: string[] = [];
    const run = await collectSmartRecruiters(
      source,
      async (url) => {
        calls.push(url);
        const u = new URL(url);
        const id = u.pathname.split("/").at(-1)!;
        return response(
          u.searchParams.has("offset")
            ? pages[Number(u.searchParams.get("offset")) / 100]
            : load(`inetum-detail-${id}.json`),
        );
      },
      { isRelevantTitle: (title) => relevant(title) },
    );
    assert.equal(run.status, "complete");
    assert.equal(run.observed.length, 236);
    assert.deepEqual(
      run.observed,
      pages.flatMap((page) =>
        page.content.map((entry: any) => ({
          id: entry.id,
          title: entry.name.trim(),
        })),
      ),
    );
    for (const record of run.records) {
      const original = load(`inetum-detail-${record.id}.json`);
      assert.equal(record.applyUrl, original.applyUrl);
      assert.equal(record.absolute_url, original.postingUrl);
      assert.equal(record.requisition_id, original.refNumber);
    }
    assert.equal(new Set(run.observed.map((x) => x.id)).size, 236);
    assert.equal(calls.length, 7);
    assert.deepEqual(run.records.map((x) => x.id).sort(), ids.sort());
    const modes = Object.fromEntries(
      run.records.map((x) => [x.id, x.metadata[0].value]),
    );
    assert.equal(modes["744000041197550"], "hybrid");
    assert.equal(modes["744000071578685"], "unknown");
    assert.equal(modes["744000091660675"], "remote");
    assert.equal(modes["744000104342420"], "hybrid");
  },
);

test("zero board, detail budgets, conflicting evidence and redirects fail safely", async () => {
  const empty = await collectSmartRecruiters(
    source,
    async () => response({ offset: 0, limit: 100, totalFound: 0, content: [] }),
    { isRelevantTitle: relevant },
  );
  assert.equal(empty.status, "complete");
  assert.equal(empty.requestCount, 1);
  const budget = await collectSmartRecruiters(
    { ...source, requestLimit: 1 },
    async () =>
      response({ offset: 0, limit: 100, totalFound: 1, content: [row()] }),
    { isRelevantTitle: relevant },
  );
  assert.equal(budget.status, "incomplete");
  assert.deepEqual(budget.errors, ["REQUEST_LIMIT"]);
  const conflict = await collectSmartRecruiters(
    source,
    async (url) =>
      response(
        url.endsWith("/123")
          ? detail({
              location: {
                country: "pe",
                fullLocation: "Lima, Peru",
                remote: true,
              },
            })
          : { offset: 0, limit: 100, totalFound: 1, content: [row()] },
      ),
    { isRelevantTitle: relevant },
  );
  assert.equal(conflict.records[0].metadata[0].value, "unknown");
  assert.equal(conflict.records[0].workplaceEvidence.conflict, true);
  let calls = 0;
  const tooMany = await collectSmartRecruiters(
    source,
    async () => {
      const offset = calls++ * 100;
      return response({
        offset,
        limit: 100,
        totalFound: 101,
        content: Array.from({ length: offset === 0 ? 100 : 1 }, (_, i) =>
          row(String(offset + i)),
        ),
      });
    },
    { isRelevantTitle: relevant },
  );
  assert.equal(calls, 2);
  assert.deepEqual(tooMany.errors, ["DETAIL_LIMIT"]);
  const redirect = await collectSmartRecruiters(
    source,
    async () => response({}, 302),
    { isRelevantTitle: relevant },
  );
  assert.equal(redirect.status, "failed");
  assert.equal(redirect.requestCount, 1);
});
