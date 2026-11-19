import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

test("website TypeScript checks its source and tools without absorbing independent packages or generated trees", () => {
  const fixture = mkdtempSync(join(tmpdir(), "website-ts-boundary-"));
  const write = (path, content) => {
    const target = join(fixture, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    symlinkSync(
      fileURLToPath(new URL("../node_modules", import.meta.url)),
      join(fixture, "node_modules"),
      "dir",
    );
    write(
      "tsconfig.json",
      readFileSync(new URL("../tsconfig.json", import.meta.url)),
    );
    write(
      "community-admin/tsconfig.json",
      readFileSync(
        new URL("../community-admin/tsconfig.json", import.meta.url),
      ),
    );
    write(".astro/types.d.ts", "declare const generatedAstroType: string;");
    write(
      "src/modules/new-feature/controller.ts",
      "export const checkedSiteValue: string = 42;",
    );
    write("src/pages/example.astro", "<h1>Website fixture</h1>");
    write("astro.config.mjs", "export default {};");
    write("scripts/verify-fixture.mjs", "export const verify = true;");
    write("tests/fixture.test.mjs", "export const testFixture = true;");
    for (const path of [
      "community-admin/src/web/example.tsx",
      "community-admin/src/server/example.ts",
      "community-admin/scripts/example.ts",
      "community-admin/tests/example.test.ts",
      "website-update/new-files/src/archived.ts",
      "future-package/src/independent.ts",
      ".local/cache/generated.ts",
      ".olimpo/runtime/generated.ts",
      "dist/generated.ts",
    ])
      write(path, "export const independentValue = true;");

    const programAt = (path, astro = false) => {
      const configPath = join(fixture, path);
      const config = ts.readConfigFile(configPath, ts.sys.readFile);
      assert.equal(config.error, undefined);
      const parsed = ts.parseJsonConfigFileContent(
        config.config,
        ts.sys,
        dirname(configPath),
        undefined,
        configPath,
        undefined,
        astro
          ? [
              {
                extension: ".astro",
                isMixedContent: true,
                scriptKind: ts.ScriptKind.Deferred,
              },
            ]
          : undefined,
      );
      assert.deepEqual(parsed.errors, []);
      return ts.createProgram(parsed.fileNames, parsed.options);
    };
    const website = programAt("tsconfig.json", true);
    const websiteRoots = website
      .getRootFileNames()
      .map((path) => relative(fixture, path).replaceAll("\\", "/"));
    for (const path of [
      ".astro/types.d.ts",
      "src/modules/new-feature/controller.ts",
      "src/pages/example.astro",
      "astro.config.mjs",
      "scripts/verify-fixture.mjs",
      "tests/fixture.test.mjs",
    ]) {
      assert.ok(
        websiteRoots.includes(path),
        `Website check must retain ${path}`,
      );
    }
    assert.deepEqual(
      websiteRoots.filter((path) =>
        /^(community-admin|website-update|future-package|\.local|\.olimpo|dist)\//.test(
          path,
        ),
      ),
      [],
      "Independent packages and non-source trees must not become website program roots",
    );
    assert.ok(
      website
        .getSemanticDiagnostics()
        .some(
          (diagnostic) =>
            diagnostic.code === 2322 &&
            diagnostic.file?.fileName.endsWith(
              "/src/modules/new-feature/controller.ts",
            ),
        ),
      "The website program must still report a real site type error",
    );

    const adminRoots = programAt("community-admin/tsconfig.json")
      .getRootFileNames()
      .map((path) =>
        relative(join(fixture, "community-admin"), path).replaceAll("\\", "/"),
      );
    for (const path of [
      "src/web/example.tsx",
      "src/server/example.ts",
      "scripts/example.ts",
      "tests/example.test.ts",
    ]) {
      assert.ok(
        adminRoots.includes(path),
        `The independent admin program must retain ${path}`,
      );
    }
    assert.ok(
      adminRoots.every((path) => !path.startsWith("../")),
      "Admin checking must remain independent",
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
