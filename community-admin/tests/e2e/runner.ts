import { inputManifest, changedInputs, builtFiles } from "./provenance";
import { acquireRunLock } from "./run-lock";
import { supplementalScenarios } from "./supplemental";
import { runSupplemental } from "./run-supplemental";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { chromium } from "playwright";
import { build as viteBuild } from "vite";
import { build as serverBuild } from "tsup";
import { verifySeedMedia } from "../../src/server/media";
import { runJourney, type Journey } from "./harness";
import { startPostgres } from "./postgres";
import { installNetworkFence } from "./network";
import {
  cleanupAll,
  reportCoverage,
  evaluateMatrix,
  captureFatalErrors,
  type RequirementMatrix,
  type JourneyResult,
} from "./safety";

const repository = fileURLToPath(new URL("../../", import.meta.url)),
  runId =
    new Date().toISOString().replace(/[^0-9]/g, "") +
    "-" +
    randomUUID().slice(0, 8),
  artifacts = resolve(repository, ".local/qa/e2e", runId),
  temporary = await mkdtemp(join(tmpdir(), "admin-e2e-")),
  result: { [key: string]: any } = {
    schemaVersion: 1,
    runId,
    startedAt: new Date().toISOString(),
    node: process.versions.node,
    status: "running",
    execution: "serial",
    liveProviders: false,
    artifacts: ".local/qa/e2e/" + runId,
  },
  results: JourneyResult[] = [],
  violations: string[] = [];
const abort = new AbortController();
const fatal = captureFatalErrors(abort);
const interrupt = () => abort.abort();
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
let database: Awaited<ReturnType<typeof startPostgres>> | undefined,
  browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
  restoreFence: (() => void) | undefined,
  failed = false,
  releaseRunLock: (() => Promise<void>) | undefined,
  inputs: Awaited<ReturnType<typeof inputManifest>> | undefined,
  matrix: RequirementMatrix | undefined;
await mkdir(artifacts, { recursive: true });
let logs = "";
const log = (value: string) => {
  logs += value;
  process.stdout.write(value);
};
try {
  releaseRunLock = await acquireRunLock(
    resolve(repository, ".local/qa/e2e"),
    runId,
  );
  if (Number(process.versions.node.split(".")[0]) !== 22)
    throw Error("E2E_NODE_22_REQUIRED");
  for (const key of [
    "DATABASE_URL",
    "DATABASE_SCHEMA",
    "LOCAL_GH_AUTH",
    "NODE_OPTIONS",
    "PGOPTIONS",
    "GITHUB_TOKEN",
    "GH_TOKEN",
  ])
    if (process.env[key]) throw Error(`E2E_UNSANITIZED_ENVIRONMENT:${key}`);
  matrix = JSON.parse(
    await readFile(join(repository, "tests/e2e/matrix.json"), "utf8"),
  ) as RequirementMatrix;
  result.complete = false;
  result.completeAllOriginal = false;
  result.originalRequirementsComplete = false;
  result.coverage = evaluateMatrix(matrix!, []);
  inputs = await inputManifest(repository);
  await writeFile(
    join(artifacts, "inputs.json"),
    JSON.stringify(inputs, null, 2),
  );
  const web = join(artifacts, "build/web"),
    server = join(artifacts, "build/server");
  log(
    "Building isolated client and server module (active dist is untouched).\n",
  );
  await viteBuild({
    configFile: join(repository, "vite.config.ts"),
    envDir: false,
    build: { outDir: web, emptyOutDir: true },
  });
  await serverBuild({
    entry: {
      app: join(repository, "src/server/app.ts"),
      main: join(repository, "src/server/main.ts"),
    },
    outDir: server,
    format: ["esm"],
    platform: "node",
    target: "node22",
    bundle: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    external: ["pg", "sharp", "vite"],
    silent: true,
  });
  const serverModule = join(server, "app.js");
  result.build = {
    serverSHA256: createHash("sha256")
      .update(await readFile(serverModule))
      .digest("hex"),
    files: await builtFiles(join(artifacts, "build")),
  };
  await writeFile(
    join(artifacts, "build-manifest.json"),
    JSON.stringify(result.build, null, 2),
  );
  database = await startPostgres(temporary, log, abort.signal);
  result.database = {
    dedicated: true,
    loopback: true,
    ownedEphemeralCluster: database.ownedCluster,
  };
  const channel = process.env.E2E_BROWSER_CHANNEL;
  if (channel && !["chrome", "chromium"].includes(channel))
    throw Error("E2E_UNSUPPORTED_BROWSER_CHANNEL");
  browser = await chromium.launch({
    headless: true,
    channel: channel === "chrome" ? "chrome" : "chromium",
  });
  result.browser = {
    engine: "chromium",
    channel: channel ?? "bundled",
    version: browser.version(),
  };
  const media = await verifySeedMedia(),
    ports = new Set([Number(new URL(database.url).port || "5432")]);
  restoreFence = installNetworkFence(ports, violations);
  const { journeys } = (await import("./journeys")) as { journeys: Journey[] };
  if (
    !Array.isArray(journeys) ||
    !journeys.length ||
    new Set(journeys.map((j) => j.id)).size !== journeys.length
  )
    throw Error("E2E_EXPLICIT_UNIQUE_JOURNEY_REGISTRY_REQUIRED");
  if (
    !Array.isArray(matrix.requirements) ||
    !matrix.requirements.length ||
    matrix.requirements.some(
      (r: any) =>
        !r.id ||
        ![
          "local-required",
          "external-notverified",
          "observed-notimplemented",
          "superseded",
        ].includes(r.disposition) ||
        !Array.isArray(r.scenarioIds),
    )
  )
    throw Error("E2E_REQUIREMENT_MATRIX_INVALID");
  const ids = matrix.requirements.map((r: any) => r.id);
  if (new Set(ids).size !== ids.length)
    throw Error("E2E_DUPLICATE_REQUIREMENT");
  // Validate mappings before running anything; typoed requirements never disappear.
  reportCoverage(
    ids,
    journeys.map((j) => ({
      id: j.id,
      requirements: j.requirements,
      providerMode: j.providerMode,
      status: "not-run",
    })),
  );
  const combined = [
    ...journeys.map((journey) => ({
      kind: "journey" as const,
      definition: journey,
      id: journey.id,
    })),
    ...supplementalScenarios.map((scenario) => ({
      kind: "supplemental" as const,
      definition: scenario,
      id: scenario.id,
    })),
  ];
  const args = process.argv.slice(2),
    filterArg = args.find((a) => a.startsWith("--filter="));
  if (args.some((a) => !a.startsWith("--filter=")))
    throw Error("E2E_UNKNOWN_ARGUMENT");
  const filter = filterArg?.slice("--filter=".length) ?? process.env.E2E_FILTER;
  if (filter && !combined.some((j) => j.id === filter))
    throw Error("E2E_UNKNOWN_JOURNEY_FILTER");
  result.focused = !!filter;
  for (const entry of combined) {
    if (abort.signal.aborted) throw Error("E2E_RUN_INTERRUPTED");
    const requirements =
      entry.kind === "journey"
        ? entry.definition.requirements
        : matrix.requirements
            .filter((r: any) => r.scenarioIds.includes(entry.id))
            .map((r: any) => r.id);
    const providerMode = entry.definition.providerMode;
    if (failed || (filter && entry.id !== filter)) {
      results.push({
        id: entry.id,
        requirements,
        providerMode,
        status: "not-run",
      });
      continue;
    }
    log(`Running ${entry.id}\n`);
    let outcome: JourneyResult;
    if (entry.kind === "journey")
      outcome = await runJourney(entry.definition, {
        browser,
        databaseURL: database.url,
        repository,
        temporary,
        artifacts,
        web,
        serverModule,
        media,
        ports,
        violations,
        signal: abort.signal,
      });
    else {
      restoreFence();
      restoreFence = undefined;
      try {
        outcome = await runSupplemental(entry.definition, requirements, {
          repository,
          temporary,
          artifacts,
          databaseURL: database.url,
          web,
          serverModule,
          signal: abort.signal,
          log,
        });
      } finally {
        restoreFence = installNetworkFence(ports, violations);
      }
    }
    results.push(outcome);
    log(
      `${outcome.status.toUpperCase()} ${entry.id} (${outcome.durationMs}ms)\n`,
    );
    if (outcome.status !== "passed") failed = true;
  }
  result.coverage = evaluateMatrix(matrix, results);
  result.complete =
    !filter &&
    !failed &&
    result.coverage.every(
      (r: any) =>
        r.disposition !== "local-required" || r.state === "verified-local",
    );
  result.externalProofRequired = matrix.requirements
    .filter((r: any) => r.disposition === "external-notverified")
    .map((r: any) => ({ id: r.id, reason: r.reason }));
  result.observedProductGaps = matrix.requirements
    .filter((r: any) => r.disposition === "observed-notimplemented")
    .map((r: any) => ({ id: r.id, reason: r.reason }));
  result.completeAllOriginal =
    result.complete &&
    !result.coverage.some((r: any) =>
      [
        "not-implemented",
        "not-verified",
        "not-verified-external",
        "failed",
      ].includes(r.state),
    );
  result.originalRequirementsComplete = result.completeAllOriginal;
  if (!filter && !result.complete) failed = true;
  result.journeys = results;
} catch (error) {
  failed = true;
  result.error =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  const cleanup: (() => Promise<unknown>)[] = [];
  if (restoreFence) cleanup.push(async () => restoreFence!());
  if (browser) cleanup.push(() => browser!.close());
  if (database) cleanup.push(() => database!.stop());
  if (releaseRunLock) cleanup.push(() => releaseRunLock!());
  cleanup.push(async () => {
    if (process.env.E2E_KEEP_TEMP === "1") {
      failed = true;
      result.cleanupWarning =
        "Temporary diagnostics explicitly retained; run is not clean";
    } else await rm(temporary, { recursive: true, force: true });
  });
  try {
    await cleanupAll(cleanup);
    result.cleanup =
      process.env.E2E_KEEP_TEMP === "1" ? "retained-explicitly" : "complete";
  } catch (error) {
    failed = true;
    result.cleanup = "failed";
    result.cleanupError = String(error);
  }
  if (inputs) {
    try {
      result.changedInputs = changedInputs(
        inputs,
        await inputManifest(repository),
      );
      if (result.changedInputs.length) failed = true;
    } catch (error) {
      failed = true;
      result.provenanceError = String(error);
    }
  }
  result.fatalErrors = fatal.errors;
  if (fatal.errors.length) failed = true;
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  if (abort.signal.aborted) {
    failed = true;
    result.interrupted = true;
  }
  if (matrix) {
    try {
      result.coverage = evaluateMatrix(matrix, results);
    } catch (error) {
      failed = true;
      result.reportValidationError = String(error);
    }
    result.externalProofRequired ??= matrix.requirements
      .filter((r) => r.disposition === "external-notverified")
      .map((r) => ({ id: r.id, reason: r.reason }));
    result.observedProductGaps ??= matrix.requirements
      .filter((r) => r.disposition === "observed-notimplemented")
      .map((r) => ({ id: r.id, reason: r.reason }));
    result.journeys = matrix.scenarios.map(
      (scenario) =>
        results.find((r) => r.id === scenario.id) ?? {
          id: scenario.id,
          requirements: scenario.requirementIds,
          executionLayer: scenario.executionLayer,
          providerMode: scenario.providerMode,
          status: "not-run",
        },
    );
  }
  if (failed) {
    result.complete = false;
    result.completeAllOriginal = false;
    result.originalRequirementsComplete = false;
  }
  result.completeImplementedLocal = result.complete === true;
  result.status = failed ? "failed" : "passed";
  result.finishedAt = new Date().toISOString();
  result.violations = violations;
  result.journeys ??= results;
  await writeFile(
    join(artifacts, "report.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  await writeFile(join(artifacts, "runner.log"), logs);
  await writeFile(
    resolve(repository, ".local/qa/e2e/latest.json"),
    JSON.stringify(
      {
        runId,
        report: `.local/qa/e2e/${runId}/report.json`,
        status: result.status,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`E2E ${result.status}: .local/qa/e2e/${runId}/report.json`);
  if (result.error) console.error(result.error);
  if (failed) process.exitCode = 1;
  fatal.remove();
}
