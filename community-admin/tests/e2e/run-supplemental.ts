import { withBrowserTemporary } from "./browser-temporary";
import { speakerFixtures } from "./speaker-fixtures";
import { rewriteLegacyEntry } from "./legacy-entry";
import {
  mkdir,
  symlink,
  rm,
  readFile,
  writeFile,
  readdir,
  copyFile,
  cp,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { chromium } from "playwright";
import apiFiles from "./api-files.json";
import { command, freePort } from "./postgres";
import {
  childEnvironment,
  validateDatabaseURL,
  type JourneyResult,
} from "./safety";
import type { supplementalScenarios } from "./supplemental";
type SupplementalOptions = {
  repository: string;
  temporary: string;
  artifacts: string;
  databaseURL: string;
  web: string;
  serverModule?: string;
  signal?: AbortSignal;
  log(text: string): void;
};
export async function runSupplemental(
  scenario: (typeof supplementalScenarios)[number],
  requirements: string[],
  options: SupplementalOptions,
): Promise<JourneyResult & { executionLayer: string; skipped?: string[] }> {
  return withBrowserTemporary((browserTemporary) =>
    runWithBrowserTemporary(scenario, requirements, options, browserTemporary),
  );
}
async function runWithBrowserTemporary(
  scenario: (typeof supplementalScenarios)[number],
  requirements: string[],
  options: SupplementalOptions,
  browserTemporary: string,
): Promise<JourneyResult & { executionLayer: string; skipped?: string[] }> {
  const started = performance.now(),
    scenarioTemporary = resolve(options.temporary, scenario.id),
    temporary = resolve(scenarioTemporary, "workspace/community-admin"),
    artifacts = resolve(options.artifacts, scenario.id),
    database = validateDatabaseURL(options.databaseURL),
    pool = new pg.Pool({
      connectionString: database.url,
      connectionTimeoutMillis: 5000,
    });
  let error: unknown,
    output = "",
    before: string[] = [],
    skipped: string[] = [];
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  await mkdir(artifacts, { recursive: true });
  try {
    before = (await pool.query("SELECT nspname FROM pg_namespace")).rows.map(
      (r) => r.nspname,
    );
    for (const name of ["migrations", "public", "contracts", "src"])
      await cp(join(options.repository, name), join(temporary, name), {
        recursive: true,
      });
    await symlink(
      join(options.repository, "node_modules"),
      join(temporary, "node_modules"),
    );
    for (const name of [
      "public",
      "content",
      "src",
      "scripts",
      "package.json",
      "astro.config.mjs",
      "tsconfig.json",
    ])
      await cp(
        resolve(options.repository, "..", name),
        resolve(temporary, "..", name),
        { recursive: true },
      );
    await symlink(
      resolve(options.repository, "../node_modules"),
      resolve(temporary, "../node_modules"),
    );
    await writeFile(join(temporary, "package.json"), '{"type":"module"}');
    await mkdir(join(temporary, ".local"), { recursive: true, mode: 0o700 });
    await mkdir(join(temporary, "tmp"), { recursive: true, mode: 0o700 });
    const guardDir = join(temporary, "guard");
    await mkdir(guardDir);
    const ownedPorts = join(temporary, "owned-ports");
    await writeFile(ownedPorts, "");
    let suiteFile: string | undefined, editorialPort: number | undefined;
    if (scenario.file === "tests/editorial-browser.ts") {
      editorialPort = await freePort();
      const original = resolve(options.repository, scenario.file);
      let source = await readFile(original, "utf8");
      source = rewriteLegacyEntry(
        source,
        pathToFileURL(original),
        editorialPort,
      );
      suiteFile = join(temporary, "editorial-entry.ts");
      await writeFile(suiteFile, source);
    }
    const speakerAssets =
      scenario.file === "tests/vacancy-product-browser.ts"
        ? await speakerFixtures(
            options.repository,
            join(temporary, "speaker-fixtures"),
          )
        : undefined;
    const env = {
      ...childEnvironment(process.env),
      DATABASE_URL: database.url,
      ...(speakerAssets
        ? {
            SPEAKER_BASELINE: speakerAssets.baseline,
            SPEAKER_IMAGE_CACHE_DIR: speakerAssets.images,
          }
        : {}),
      TMPDIR: browserTemporary,
      TEMP: browserTemporary,
      NODE_OPTIONS:
        scenario.file === "safety"
          ? "--import=tsx"
          : `--import=tsx --import=${pathToFileURL(join(options.repository, "tests/e2e/preload.ts")).href}`,
      PRIVATE_KEY_DIR: join(temporary, "keys"),
      PRIVATE_STORAGE_DIR: join(temporary, "storage"),
      GH_CONFIG_DIR: join(temporary, "gh-disabled"),
      GIT_CONFIG_GLOBAL: join(temporary, "git-disabled"),
      GIT_CONFIG_NOSYSTEM: "1",
      PRODUCT_WEB_DIST: options.web,
      E2E_BUILT_APP: options.serverModule ?? "",
      E2E_BUILT_MAIN:
        options.serverModule?.replace(/app\.js$/, "main.js") ?? "",
      ARTIFACTS_DIR: join(temporary, ".local/qa/scenario"),
      WEBSITE_CHECKOUT: resolve(options.repository, ".."),
      E2E_SOURCE_REPOSITORY: resolve(options.repository, ".."),
      E2E_ALLOWED_BROWSER_EXECUTABLE: chromium.executablePath(),
      E2E_ALLOWED_BIN_ROOT: join(options.repository, "node_modules/@esbuild"),
      E2E_ALLOWED_ROOT_BIN_ROOT: resolve(
        options.repository,
        "../node_modules/@esbuild",
      ),
      EDITORIAL_BROWSER_BUILT: "1",
      ...(editorialPort
        ? { E2E_ALLOWED_TEST_PORT: String(editorialPort) }
        : {}),
      E2E_GUARD_REPORT_DIR: guardDir,
      E2E_OWNED_PORTS_FILE: ownedPorts,
      ...(["api", "safety"].includes(scenario.file)
        ? {}
        : {
            E2E_SUITE_FILE:
              suiteFile ?? resolve(options.repository, scenario.file),
          }),
    };
    const args = ["api", "safety"].includes(scenario.file)
      ? [
          "--test",
          "--test-concurrency=1",
          ...(scenario.file === "safety"
            ? [resolve(options.repository, "tests/e2e-harness.test.ts")]
            : apiFiles.map((path) => resolve(options.repository, path))),
        ]
      : [resolve(options.repository, "tests/e2e/supplemental-entry.ts")];
    await command(process.execPath, args, {
      cwd: temporary,
      env,
      timeout: scenario.file === "api" ? 240000 : 180000,
      signal: options.signal,
      log: (text) => {
        output += text;
      },
    });
    skipped = output.split("\n").filter((line) => /# SKIP/.test(line));
    if (
      skipped.some((line) => !line.includes("actual saved Inetum236 inventory"))
    )
      throw Error("E2E_UNEXPECTED_SKIPPED_TEST");
    if (
      ["api", "safety"].includes(scenario.file) &&
      (!/# fail 0\b/.test(output) ||
        /not ok \d+/.test(output) ||
        !Number(output.match(/^# tests (\d+)$/m)?.[1] ?? 0))
    )
      throw Error("E2E_API_TEST_FAILURE_OR_MISSING_TAP_SUMMARY");
    const guardReports = [];
    for (const file of await readdir(guardDir)) {
      const proof = JSON.parse(await readFile(join(guardDir, file), "utf8"));
      guardReports.push(proof);
      if (proof.violations?.length)
        throw Error("E2E_SUPPLEMENTAL_NETWORK_GUARD_FAILED");
    }
    // Export synthetic screenshots only; private keys, uploads and cookie traces stay temporary.
    const copyScreenshots = async (directory: string) => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (e: any) {
        if (e.code === "ENOENT") return;
        throw e;
      }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await copyScreenshots(path);
        else if (entry.name.endsWith(".png"))
          await copyFile(
            path,
            join(
              artifacts,
              path.slice(temporary.length + 1).replaceAll("/", "__"),
            ),
          );
      }
    };
    await copyScreenshots(join(temporary, ".local/qa"));
  } catch (caught) {
    error = caught;
  } finally {
    try {
      const after = (
          await pool.query("SELECT nspname FROM pg_namespace")
        ).rows.map((r) => r.nspname),
        leftovers = after.filter((name) => !before.includes(name));
      for (const name of leftovers) {
        if (!/^(?:test_[a-z0-9_]+|e2e_[a-f0-9]{32})$/.test(name))
          throw Error("E2E_UNEXPECTED_SCHEMA_LEFTOVER");
        await pool.query(`DROP SCHEMA "${name}" CASCADE`);
      }
      if (leftovers.length)
        throw Error(`E2E_SUITE_LEFT_SCHEMAS:${leftovers.length}:cleaned`);
    } catch (cleanupError) {
      error = new AggregateError(
        [...(error ? [error] : []), cleanupError],
        "E2E_SUPPLEMENTAL_CLEANUP_FAILED",
      );
    }
    await pool.end();
    const guardDirectory = join(temporary, "guard");
    try {
      const reports = await Promise.all(
        (await readdir(guardDirectory)).map(async (file) =>
          JSON.parse(await readFile(join(guardDirectory, file), "utf8")),
        ),
      );
      await writeFile(
        join(artifacts, "network-guard.json"),
        JSON.stringify(reports, null, 2),
      );
    } catch (guardError: any) {
      if (guardError.code !== "ENOENT")
        error = new AggregateError(
          [...(error ? [error] : []), guardError],
          "E2E_GUARD_REPORT_FAILED",
        );
    }
    await rm(scenarioTemporary, { recursive: true, force: true });
    await writeFile(join(artifacts, "suite.log"), output);
    await writeFile(
      join(artifacts, "state-proof.json"),
      JSON.stringify(
        {
          dedicatedDatabase: true,
          noActiveAdmin: true,
          privateTemporaryStorageRemoved: true,
          executionLayer: scenario.executionLayer,
          providerMode: scenario.providerMode,
          skippedHistoricalEvidence: skipped,
          status: error ? "failed" : "passed",
        },
        null,
        2,
      ),
    );
  }
  return {
    id: scenario.id,
    requirements,
    executionLayer: scenario.executionLayer,
    providerMode: scenario.providerMode,
    status: error ? "failed" : "passed",
    ...(error
      ? {
          error:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
        }
      : {}),
    durationMs: Math.round(performance.now() - started),
    ...(["api", "safety"].includes(scenario.file)
      ? {
          assertionCounts: {
            total: Number(output.match(/^# tests (\d+)$/m)?.[1] ?? 0),
            passed: Number(output.match(/^# pass (\d+)$/m)?.[1] ?? 0),
            failed: Number(output.match(/^# fail (\d+)$/m)?.[1] ?? 0),
            skipped: Number(output.match(/^# skipped (\d+)$/m)?.[1] ?? 0),
          },
        }
      : {}),
    skipped,
    artifacts: [join(artifacts, "suite.log")],
  };
}
