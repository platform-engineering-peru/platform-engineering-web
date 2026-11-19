import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { journeys } from "./e2e/journeys";
import apiFiles from "./e2e/api-files.json";
import matrix from "./e2e/matrix.json";

test("normal E2E registry requires social handoff, stale recovery, reviewed export and guest attribution", () => {
  for (const id of [
    "social-blog-confirmation",
    "social-blog-stale-confirmation",
    "calendar-admin-attribution",
  ]) {
    const journey = journeys.find((entry) => entry.id === id);
    assert.ok(journey, `Missing normal E2E journey: ${id}`);
    assert.ok(matrix.scenarios.some((scenario) => scenario.id === id));
    for (const requirement of journey.requirements) {
      assert.ok(
        matrix.requirements.some(
          (entry) =>
            entry.id === requirement &&
            entry.scenarioIds.some((scenarioId) => scenarioId === id),
        ),
      );
    }
  }
  for (const file of [
    "social-source",
    "social-indexing",
    "social-indexing-api",
    "social-handoff",
    "social-compatibility",
  ]) {
    assert.ok(
      apiFiles.includes(`tests/${file}.test.ts`),
      `Missing API regression: ${file}`,
    );
  }
});

test("disposable contracts are exact private copies and reject symbolic-link inputs", async () => {
  const { copyJourneyContracts } = await import("./e2e/contracts-fixture");
  const root = await mkdtemp(join(tmpdir(), "e2e-contracts-"));
  try {
    const source = join(root, "source"),
      target = join(root, "target");
    await mkdir(join(source, "contracts"), { recursive: true });
    await mkdir(target);
    const bytes = '{"schemaVersion":1,"fixture":true}\n';
    await writeFile(join(source, "contracts/blog-v1.schema.json"), bytes);
    await copyJourneyContracts(source, target);
    assert.equal(
      await readFile(join(target, "contracts/blog-v1.schema.json"), "utf8"),
      bytes,
    );
    await writeFile(
      join(target, "contracts/blog-v1.schema.json"),
      "private modified copy",
    );
    assert.equal(
      await readFile(join(source, "contracts/blog-v1.schema.json"), "utf8"),
      bytes,
    );
    await symlink(
      join(source, "contracts/blog-v1.schema.json"),
      join(source, "contracts/linked.json"),
    );
    await assert.rejects(
      copyJourneyContracts(source, join(root, "unsafe")),
      /E2E_UNSAFE_CONTRACT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
