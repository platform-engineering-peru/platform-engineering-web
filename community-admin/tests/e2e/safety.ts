/** E2E safety policy is deliberately separate from application configuration. */
export function validateDatabaseURL(value: string | undefined) {
  if (!value) throw Error("E2E_DATABASE_URL_REQUIRED");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw Error("E2E_UNSAFE_DATABASE_TARGET");
  }
  const database = decodeURIComponent(url.pathname.slice(1));
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !/^(?:[a-z0-9_]+_)?e2e(?:_[a-z0-9_]+)?$/.test(database) ||
    [...url.searchParams].length ||
    url.hash
  )
    throw Error("E2E_UNSAFE_DATABASE_TARGET");
  return { url: url.href, database };
}
export function disposableSchema(value: string) {
  if (!/^e2e_[a-f0-9]{32}$/.test(value)) throw Error("E2E_UNSAFE_SCHEMA");
  return value;
}
export function childEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    INTEGRATIONS_LIVE_ENABLED: "false",
  };
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "SystemRoot",
    "LANG",
    "LC_ALL",
    "TERM",
    "USER",
    "E2E_DATABASE_URL",
    "E2E_PG_BIN",
    "E2E_BROWSER_CHANNEL",
    "E2E_FILTER",
    "E2E_KEEP_TEMP",
  ])
    if (input[key]) result[key] = input[key];
  if (result.E2E_DATABASE_URL) validateDatabaseURL(result.E2E_DATABASE_URL);
  return result;
}
export async function cleanupAll(actions: (() => Promise<unknown>)[]) {
  const errors: unknown[] = [];
  for (const action of actions)
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  if (errors.length) throw new AggregateError(errors, "E2E_CLEANUP_FAILED");
}
export interface JourneyResult {
  id: string;
  requirements: string[];
  status: "passed" | "failed" | "not-run";
  providerMode: "none" | "synthetic";
  error?: string;
  artifacts?: string[];
  durationMs?: number;
  executionLayer?: string;
}
export function reportCoverage(
  requirements: string[],
  results: JourneyResult[],
) {
  const known = new Set(requirements);
  for (const result of results)
    for (const requirement of result.requirements)
      if (!known.has(requirement))
        throw Error(`E2E_UNKNOWN_REQUIREMENT:${requirement}`);
  return requirements.map((id) => {
    const covered = results.filter((r) => r.requirements.includes(id));
    return {
      id,
      state: covered.some((r) => r.status === "failed")
        ? "failed"
        : covered.some(
              (r) => r.status === "passed" && r.providerMode === "none",
            )
          ? "real-e2e"
          : covered.some((r) => r.status === "passed")
            ? "synthetic-provider"
            : "not-verified",
      journeys: covered.map((r) => r.id),
    };
  });
}

export interface RequirementMatrix {
  requirements: {
    id: string;
    disposition:
      | "local-required"
      | "external-notverified"
      | "observed-notimplemented"
      | "superseded";
    scenarioIds: string[];
    reason?: string;
    externalProofRequired?: string[];
    localAssertionScope?: string;
  }[];
  scenarios: {
    id: string;
    executionLayer: string;
    providerMode: "none" | "synthetic";
    requirementIds: string[];
  }[];
}
export function evaluateMatrix(
  matrix: RequirementMatrix,
  results: JourneyResult[],
) {
  const ids = matrix.requirements.map((r) => r.id),
    scenarios = matrix.scenarios.map((s) => s.id);
  if (
    new Set(ids).size !== ids.length ||
    new Set(scenarios).size !== scenarios.length ||
    new Set(results.map((r) => r.id)).size !== results.length
  )
    throw Error("E2E_DUPLICATE_COVERAGE_ID");
  for (const requirement of matrix.requirements) {
    if (
      ![
        "local-required",
        "external-notverified",
        "observed-notimplemented",
        "superseded",
      ].includes(requirement.disposition) ||
      !Array.isArray(requirement.scenarioIds)
    )
      throw Error("E2E_INVALID_DISPOSITION");
    for (const id of requirement.scenarioIds)
      if (!scenarios.includes(id)) throw Error(`E2E_UNKNOWN_SCENARIO:${id}`);
  }
  for (const scenario of matrix.scenarios)
    for (const id of scenario.requirementIds)
      if (!ids.includes(id)) throw Error(`E2E_UNKNOWN_REQUIREMENT:${id}`);
  for (const result of results) {
    const declared = matrix.scenarios.find(
      (scenario) => scenario.id === result.id,
    );
    if (!declared) throw Error(`E2E_UNKNOWN_RESULT:${result.id}`);
    if (
      result.providerMode !== declared.providerMode ||
      (result.status !== "not-run" &&
        result.executionLayer !== declared.executionLayer)
    )
      throw Error(`E2E_RESULT_METADATA_MISMATCH:${result.id}`);
  }
  return matrix.requirements.map((requirement) => {
    const proofs = requirement.scenarioIds.map((id) => {
      const result = results.find((r) => r.id === id),
        declared = matrix.scenarios.find((s) => s.id === id)!;
      return {
        id,
        status: result?.status ?? "not-run",
        executionLayer: result?.executionLayer ?? declared.executionLayer,
        providerMode: result?.providerMode ?? declared.providerMode,
      };
    });
    const verified =
      proofs.length > 0 && proofs.every((p) => p.status === "passed");
    return {
      id: requirement.id,
      disposition: requirement.disposition,
      state:
        requirement.disposition === "superseded"
          ? "superseded"
          : requirement.disposition === "external-notverified"
            ? "not-verified-external"
            : requirement.disposition === "observed-notimplemented"
              ? "not-implemented"
              : verified
                ? "verified-local"
                : proofs.some((p) => p.status === "failed")
                  ? "failed"
                  : "not-verified",
      realE2E:
        verified &&
        proofs.some(
          (p) =>
            p.executionLayer === "built-client-built-api-pg" ||
            p.executionLayer === "built-client-source-api-pg",
        ),
      providerMode: proofs.some((p) => p.providerMode === "synthetic")
        ? "synthetic"
        : "none",
      proofs,
      reason: requirement.reason,
      externalProofRequired: requirement.externalProofRequired ?? [],
      localAssertionScope:
        requirement.localAssertionScope ??
        "Only local assertions in the listed scenarios; external scope requires separate proof.",
    };
  });
}

/** Test-runner emergency cleanup trigger, never a reason to continue a failed scenario. */
export function captureFatalErrors(controller: AbortController) {
  const errors: string[] = [];
  const capture = (error: unknown) => {
    errors.push(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    controller.abort();
  };
  process.on("unhandledRejection", capture);
  process.on("uncaughtException", capture);
  return {
    errors,
    remove: () => {
      process.removeListener("unhandledRejection", capture);
      process.removeListener("uncaughtException", capture);
    },
  };
}
