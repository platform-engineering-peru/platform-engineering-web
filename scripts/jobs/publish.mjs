import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { validateArtifact, validateSource } from "./collect.mjs";
import { GitHub } from "./github.mjs";
export async function prepareExport(
  body,
  checksum,
  registry,
  approvedIds = [],
) {
  if (createHash("sha256").update(body).digest("hex") !== checksum.trim())
    throw new Error("Artifact checksum mismatch");
  const value = validateArtifact(JSON.parse(body));
  for (const source of registry.sources) validateSource(source);
  const enabled = new Set(
    registry.sources.filter((s) => s.enabled).map((s) => s.id),
  );
  if (value.sources.some((s) => !enabled.has(s.sourceId)))
    throw new Error("Unreviewed source in artifact");
  if (value.sources.length !== enabled.size)
    throw new Error("Incomplete source inventory");
  const files = [];
  // Fetched records are candidates, never silently approved. Review evidence is public and traceable.
  const summary = {
    schemaVersion: 1,
    rulesVersion: value.rulesVersion,
    runId: value.runId,
    runUrl: value.runUrl,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    sources: value.sources,
    candidates: value.candidates,
    state: value.state ?? [],
  };
  files.push({
    path: "content/collection/latest.json",
    content: JSON.stringify(summary, null, 2) + "\n",
  });
  for (const record of value.jobs) {
    if (!approvedIds.includes(record.id))
      throw new Error("New jobs require human approval");
    if (
      !enabled.has(record.sourceId) ||
      !["active", "stale", "closed"].includes(record.status) ||
      ["unknown", "restricted"].includes(record.eligibility)
    )
      throw new Error("Unapproved public job");
    files.push({
      path: `content/jobs/${record.id}.json`,
      content: JSON.stringify(record, null, 2) + "\n",
    });
  }
  return files;
}
export function meaningfulEvidence(value) {
  const strip = (v) =>
    Array.isArray(v)
      ? v.map(strip)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .filter(
                ([k]) =>
                  ![
                    "startedAt",
                    "finishedAt",
                    "runId",
                    "runUrl",
                    "lastSeenAt",
                    "lastVerifiedAt",
                    "evidenceRunId",
                    "adapterVersion",
                  ].includes(k),
              )
              .map(([k, v]) => [k, strip(v)]),
          )
        : v;
  return JSON.stringify(strip(value));
}
if (process.argv[1]?.endsWith("publish.mjs")) {
  if (process.env.GITHUB_REF !== "refs/heads/main")
    throw new Error("Trusted main branch required");
  const registry = JSON.parse(
    await readFile("scripts/jobs/sources.json", "utf8"),
  );
  const { readdir } = await import("node:fs/promises");
  let approvedIds = [];
  try {
    for (const name of await readdir("content/jobs"))
      if (name.endsWith(".json")) {
        const record = JSON.parse(
          await readFile("content/jobs/" + name, "utf8"),
        );
        if (
          ["active", "stale", "closed"].includes(record.status) &&
          !["unknown", "restricted"].includes(record.eligibility)
        )
          approvedIds.push(record.id);
      }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const files = await prepareExport(
    await readFile(".jobs-artifact/normalized.json", "utf8"),
    await readFile(".jobs-artifact/normalized.sha256", "utf8"),
    registry,
    approvedIds,
  );
  let previousEvidence;
  try {
    previousEvidence = await readFile("content/collection/latest.json", "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (
    previousEvidence &&
    meaningfulEvidence(JSON.parse(previousEvidence)) ===
      meaningfulEvidence(JSON.parse(files[0].content))
  ) {
    process.stdout.write("No meaningful source changes; no PR created.\n");
  } else if (!registry.sources.some((s) => s.enabled)) {
    process.stdout.write("No enabled sources; no PR created.\n");
  } else {
    if (
      !process.env.JOBS_APP_ID ||
      !process.env.JOBS_APP_INSTALLATION_ID ||
      !process.env.JOBS_APP_PRIVATE_KEY
    )
      throw new Error("Scoped GitHub App configuration required");
    const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
    const github = new GitHub({
      appId: process.env.JOBS_APP_ID,
      installationId: process.env.JOBS_APP_INSTALLATION_ID,
      privateKey: process.env.JOBS_APP_PRIVATE_KEY,
      owner,
      repo,
      enabled: true,
      installationPermissions: { contents: "write", pull_requests: "write" },
      requiredChecks: ["Validate website"],
      requiredApprovals: 1,
    });
    const result = await github.syncJobs(files);
    process.stdout.write(`Review PR ${result.number}\n`);
  }
}
