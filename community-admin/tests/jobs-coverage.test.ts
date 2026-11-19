import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import {
  normalizeJob,
  publicJobs,
  collectSource,
  reconcileJobs,
  classifyRole,
} from "../src/server/jobs/engine";
import { discoverCareers } from "../src/server/jobs/discovery";
import { jobRecordPath } from "../src/server/jobs/publication-contract";
import { EditorialService } from "../src/server/editorial-sync/service";
const now = new Date("2026-11-18T07:00:00Z");
test("Events exposes exact-operation replay only for server-proven unchanged-head uncertainty", () => {
  const row = {
    id: "operation",
    publication_mode: "direct",
    state: "unknown",
    recovery: { canRetryExact: true },
  };
  const dto = (change: any = {}) =>
    EditorialService.prototype.submissionDTO.call({}, { ...row, ...change });
  assert.equal(dto().canRetryExact, true);
  assert.equal(dto().canEdit, false);
  assert.equal(dto({ recovery: null }).canRetryExact, false);
  assert.equal(dto({ state: "conflict" }).canRetryExact, false);
  assert.equal(dto({ publication_mode: "pull-request" }).canRetryExact, false);
});
const source: any = {
  id: "coderio",
  adapter: "lever",
  boardIdentifier: "coderio",
  company: "Coderio",
};
const raw = {
  id: "e2caacf4",
  text: "Sr Devops Engineer",
  hostedUrl: "https://jobs.lever.co/coderio/e2caacf4",
  categories: {
    location: "Argentina",
    allLocations: ["Argentina", "Peru"],
    commitment: "Global | LATAM",
  },
  workplaceType: "remote",
  descriptionPlain: "",
  salaryDescriptionPlain: "Build cloud infrastructure for our team in Peru.",
  createdAt: 1794506194961,
  salaryRange: { min: 1, max: 1, currency: "USD" },
};
test("Lever explicit allLocations and factual provider fields survive without LATAM inference", async () => {
  assert.equal(classifyRole("Especialista DevSecOps"), "devops");
  assert.equal(classifyRole("Technical Specialist DevSecOps"), "devops");
  assert.equal(classifyRole("Sales Specialist DevSecOps"), null);
  assert.equal(classifyRole("DevSecOps Support Specialist"), null);
  const record = normalizeJob(raw, source, now);
  assert.deepEqual(record.locations, ["Argentina", "Peru"]);
  assert.equal(record.eligibility, "peru");
  assert.equal(record.workplace, "remote");
  assert.match(record.sourceExcerpt, /infrastructure/);
  assert.equal(record.sourcePublishedAt, new Date(raw.createdAt).toISOString());
  assert.equal(record.salary, null);
  assert.equal(
    normalizeJob(
      { ...raw, categories: { location: "Remote LATAM" } },
      source,
      now,
    ).eligibility,
    "remote-latam-confirmed",
  );
  assert.equal(
    normalizeJob({ ...raw, createdAt: -1 }, source, now).sourcePublishedAt,
    null,
  );
  const pairedPath = "../../scripts/jobs/engine.mjs";
  const paired = await import(pairedPath);
  assert.deepEqual(paired.normalizeJob(raw, source, now), record);
});
test("approved Peru roles with unknown modality export honestly under the dedicated schema", () => {
  const record = {
    ...normalizeJob({ ...raw, workplaceType: undefined }, source, now),
    approved: true,
    status: "active",
    summary: {
      "es-pe": "Construye infraestructura.",
      en: "Build infrastructure.",
    },
  };
  assert.equal(record.workplace, "unknown");
  const exported = publicJobs([record]);
  assert.equal(exported.length, 1);
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  const validate = ajv.compile(
    JSON.parse(readFileSync("contracts/jobs-v1.schema.json", "utf8")),
  );
  assert.equal(validate(exported[0]), true, JSON.stringify(validate.errors));
  assert.equal(publicJobs([{ ...record, eligibility: "unknown" }]).length, 0);
  assert.equal(publicJobs([{ ...record, approved: false }]).length, 0);
  assert.equal("workplaceEvidence" in exported[0], false);
  assert.equal("sourceExcerpt" in exported[0], false);
  assert.equal(
    jobRecordPath("smartrecruiters:inetum2:123"),
    "content/jobs/smartrecruiters:inetum2:123.json",
  );
  assert.throws(() => jobRecordPath("other:inetum2:123"));
});
test("SmartRecruiters discovery and engine use bounded full inventory and preserve jobs on detail failure", async () => {
  const discovery = await discoverCareers(
    "https://jobs.smartrecruiters.com/Inetum2",
    "Inetum",
    async () => {
      throw Error("board discovery needs no fetch");
    },
    now,
  );
  assert.equal(discovery.supported, true);
  assert.equal(discovery.config?.adapter, "smartrecruiters");
  const config: any = {
    ...discovery.config,
    enabled: true,
    reviewedAt: now.toISOString(),
    reviewReference: "fixture",
    permissionBasis: "fixture",
    termsUrl: "https://developers.smartrecruiters.com/",
    attribution: "Inetum",
  };
  const listed = {
    id: "123",
    name: "DevSecOps Engineer",
    company: { identifier: "Inetum2" },
    location: { country: "pe", city: "Lima" },
  };
  const detail = {
    ...listed,
    active: true,
    refNumber: "REF123",
    postingUrl: "https://jobs.smartrecruiters.com/Inetum2/123-devsecops",
    applyUrl: "https://jobs.smartrecruiters.com/Inetum2/123-devsecops?oga=true",
    jobAd: {
      sections: {
        jobDescription: { text: "Maintain Kubernetes infrastructure." },
      },
    },
  };
  const transport: any = async (url: string) => ({
    status: 200,
    headers: {},
    body: Buffer.from(
      JSON.stringify(
        url.endsWith("/123")
          ? detail
          : { offset: 0, limit: 100, totalFound: 1, content: [listed] },
      ),
    ),
  });
  const run = await collectSource(config, transport, now);
  assert.equal(run.status, "complete");
  assert.equal(run.recordsFetched, 1);
  assert.equal(run.records[0].workplace, "unknown");
  assert.match(run.records[0].applyUrl, /oga=true/);
  assert.equal(run.records[0].requisitionId, "REF123");
  const pairedPath = "../../scripts/jobs/engine.mjs";
  const paired = await import(pairedPath);
  const pairedRun = await paired.collectSource(config, transport, now);
  assert.deepEqual(pairedRun.records, run.records);
  assert.deepEqual(pairedRun.observedIds, run.observedIds);
  const collectorPath = "../../scripts/jobs/collect.mjs";
  const collector = await import(collectorPath);
  const {
    careersUrl: _careers,
    schedule: _schedule,
    ...registryConfig
  } = config;
  assert.doesNotThrow(() => collector.validateSource(registryConfig));
  assert.equal(
    run.observedIds[0],
    "smartrecruiters:smartrecruiters-inetum2:123",
  );
  const inactive = await collectSource(
    config,
    async (url: string) => ({
      status: 200,
      headers: {},
      body: Buffer.from(
        JSON.stringify(
          url.endsWith("/123")
            ? { ...detail, active: false }
            : { offset: 0, limit: 100, totalFound: 1, content: [listed] },
        ),
      ),
    }),
    now,
  );
  const active = { ...run.records[0], status: "active", approved: true };
  const closed = reconcileJobs([active], inactive, now).jobs[0];
  assert.equal(inactive.status, "complete");
  assert.equal(closed.status, "closed");
  assert.equal(closed.sourceClosed, true);
  assert.equal(closed.closureReason, "source-explicit-closed");
  assert.equal(closed.id, active.id);
  assert.equal(closed.applyUrl, active.applyUrl);
  assert.notEqual(closed.reviewReason, "source-role-no-longer-matches");
  const reopened = reconcileJobs([closed], run, now).jobs[0];
  assert.equal(reopened.status, "needs-review");
  assert.equal(reopened.approved, false);
  const pairedInactive = await paired.collectSource(
    config,
    async (url: string) => ({
      status: 200,
      headers: {},
      body: Buffer.from(
        JSON.stringify(
          url.endsWith("/123")
            ? { ...detail, active: false }
            : { offset: 0, limit: 100, totalFound: 1, content: [listed] },
        ),
      ),
    }),
    now,
  );
  assert.deepEqual(paired.reconcileJobs([active], pairedInactive, now).jobs, [
    closed,
  ]);
  const failed = await collectSource(
    config,
    async () => ({ status: 429, headers: {}, body: Buffer.from("") }),
    now,
  );
  assert.equal(failed.status, "failed");
  const prior = { ...run.records[0], status: "active", approved: true };
  assert.deepEqual(reconcileJobs([prior], failed, now).jobs, [prior]);
});
