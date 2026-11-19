import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { collectSource, publicJobs, reconcileJobs } from "./engine.mjs";
export function validateSource(source) {
  const allowed = [
    "id",
    "adapter",
    "boardIdentifier",
    "company",
    "enabled",
    "reviewedAt",
    "reviewReference",
    "permissionBasis",
    "termsUrl",
    "allowedHosts",
    "attribution",
    "expectedMinRecords",
    "pageLimit",
    "requestLimit",
    "timeoutSeconds",
    "rulesVersion",
    "robotsReviewedAt",
    "autoMergeClosures",
  ];
  if (Object.keys(source).some((k) => !allowed.includes(k)))
    throw new Error("Unknown source field");
  if (
    !/^[a-z0-9_-]{1,100}$/.test(source.id) ||
    !["greenhouse", "lever", "smartrecruiters"].includes(source.adapter)
  )
    throw new Error("Invalid source");
  if (
    !/^[a-zA-Z0-9_-]{1,100}$/.test(source.boardIdentifier ?? "") ||
    typeof source.company !== "string" ||
    !source.company.trim() ||
    !Array.isArray(source.allowedHosts) ||
    source.allowedHosts.some(
      (h) =>
        ![
          "api.lever.co",
          "boards-api.greenhouse.io",
          "api.smartrecruiters.com",
        ].includes(h),
    )
  )
    throw new Error("Source host or board invalid");
  for (const [key, max] of [
    ["pageLimit", 100],
    ["requestLimit", 2000],
    ["timeoutSeconds", 15],
  ])
    if (
      source[key] !== undefined &&
      (!Number.isInteger(source[key]) || source[key] < 1 || source[key] > max)
    )
      throw new Error("Invalid source limit");
  if (
    source.enabled &&
    (!source.reviewedAt ||
      !source.reviewReference ||
      !source.permissionBasis ||
      !source.termsUrl ||
      !source.attribution)
  )
    throw new Error("Reviewed source required");
}
export async function collect(
  registry,
  transport,
  previous = [],
  now = new Date(),
) {
  if (
    registry.schemaVersion !== 1 ||
    !Array.isArray(registry.sources) ||
    registry.sources.length > 50
  )
    throw new Error("Registry invalid");
  const results = [];
  let jobs = previous;
  for (const source of registry.sources) {
    validateSource(source);
    if (!source.enabled) continue;
    const result = await collectSource(source, transport, now);
    result.records = result.records.map((record) => ({
      ...record,
      evidenceRunId: process.env.GITHUB_RUN_ID ?? "local-fixture",
    }));
    const reconciled = reconcileJobs(jobs, result, now);
    jobs = reconciled.jobs;
    results.push({ ...result, status: reconciled.status });
  }
  return {
    schemaVersion: 1,
    rulesVersion: registry.rulesVersion,
    runId: process.env.GITHUB_RUN_ID ?? "local-fixture",
    runUrl: process.env.GITHUB_RUN_ID
      ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null,
    startedAt: now.toISOString(),
    finishedAt: new Date().toISOString(),
    sources: results.map(({ records, ...result }) => result),
    candidates: results.flatMap((r) =>
      r.records.map(({ sourceExcerpt, ...record }) => record),
    ),
    jobs: publicJobs(jobs),
    state: jobs.map((j) => ({
      id: j.id,
      sourceId: j.sourceId,
      missingSince: j.missingSince ?? null,
      missingRunId: j.missingRunId ?? null,
      status: j.status,
      lastVerifiedAt: j.lastVerifiedAt,
    })),
  };
}
export function validateArtifact(value) {
  const top = [
    "schemaVersion",
    "rulesVersion",
    "runId",
    "runUrl",
    "startedAt",
    "finishedAt",
    "sources",
    "candidates",
    "jobs",
    "state",
  ];
  if (Object.keys(value).some((k) => !top.includes(k)))
    throw new Error("Unknown artifact field");
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.sources) ||
    !Array.isArray(value.candidates) ||
    !Array.isArray(value.jobs)
  )
    throw new Error("Invalid artifact");
  if (value.candidates.length > 100000 || value.jobs.length > 100000)
    throw new Error("Artifact limit");
  const scan = (v) => {
    if (!v || typeof v !== "object") return;
    for (const [key, val] of Object.entries(v)) {
      if (
        /token|secret|credential|authorization|cookie|email|phone|private|storagekey|presigned/i.test(
          key,
        )
      )
        throw new Error("Private artifact field");
      scan(val);
    }
  };
  scan(value);
  const fields = [
    "schemaVersion",
    "id",
    "slug",
    "status",
    "title",
    "company",
    "sourceId",
    "externalId",
    "sourceUrl",
    "applyUrl",
    "contentLanguage",
    "workplace",
    "eligibility",
    "locations",
    "seniority",
    "salary",
    "summary",
    "tags",
    "sourcePublishedAt",
    "firstSeenAt",
    "lastSeenAt",
    "lastVerifiedAt",
    "expiresAt",
    "closureReason",
    "evidenceRunId",
    "approved",
    "relevanceScore",
    "roleFamily",
    "sourceClosed",
  ];
  for (const job of [...value.candidates, ...value.jobs]) {
    if (
      Object.keys(job).some((k) => !fields.includes(k)) ||
      job.schemaVersion !== 1 ||
      typeof job.title !== "string" ||
      job.title.length > 4000 ||
      !Array.isArray(job.locations) ||
      !Array.isArray(job.tags) ||
      ![
        "candidate",
        "active",
        "needs-review",
        "stale",
        "closed",
        "excluded",
      ].includes(job.status)
    )
      throw new Error("Invalid normalized job schema");
    for (const key of ["sourceUrl", "applyUrl"]) {
      const url = new URL(job[key]);
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error("Invalid public link");
    }
    if (
      !["greenhouse:", "lever:", "smartrecruiters:"].some((p) =>
        job.id.startsWith(p),
      )
    )
      throw new Error("Invalid source job ID");
  }
  return value;
}
if (process.argv[1]?.endsWith("collect.mjs")) {
  const registry = JSON.parse(
    await readFile("scripts/jobs/sources.json", "utf8"),
  );
  let previous = [];
  try {
    const { readdir } = await import("node:fs/promises");
    for (const name of await readdir("content/jobs"))
      if (name.endsWith(".json"))
        previous.push(
          JSON.parse(await readFile("content/jobs/" + name, "utf8")),
        );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let evidence;
  try {
    evidence = JSON.parse(
      await readFile("content/collection/latest.json", "utf8"),
    );
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  previous = previous.map((j) => ({
    ...j,
    approved: true,
    missingSince:
      evidence?.state?.find((s) => s.id === j.id)?.missingSince ?? null,
    missingRunId:
      evidence?.state?.find((s) => s.id === j.id)?.missingRunId ?? null,
  }));
  const value = validateArtifact(await collect(registry, undefined, previous));
  const body = JSON.stringify(value, null, 2) + "\n";
  await mkdir(".jobs-artifact", { recursive: true });
  await writeFile(".jobs-artifact/normalized.json", body);
  await writeFile(
    ".jobs-artifact/normalized.sha256",
    createHash("sha256").update(body).digest("hex") + "\n",
  );
  const summary = `## Job collection\nRun: ${value.runUrl ?? value.runId}\nSources: ${value.sources.length}\nCandidates: ${value.candidates.length}\nPublic records: ${value.jobs.length}\n${value.sources.map((s) => `- ${s.sourceId}: ${s.status}, fetched ${s.recordsFetched}, pages ${s.pagesFetched}, code ${s.errorCode ?? "OK"}`).join("\n")}\n`;
  if (process.env.GITHUB_STEP_SUMMARY)
    await writeFile(process.env.GITHUB_STEP_SUMMARY, summary, { flag: "a" });
}
