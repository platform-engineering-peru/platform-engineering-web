import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
export async function inputManifest(repository: string) {
  const entries: { path: string; sha256: string }[] = [];
  const walk = async (relative: string) => {
    for (const entry of await readdir(resolve(repository, relative), {
      withFileTypes: true,
    })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile())
        entries.push({
          path,
          sha256: createHash("sha256")
            .update(await readFile(resolve(repository, path)))
            .digest("hex"),
        });
    }
  };
  for (const directory of ["src", "migrations", "contracts", "tests"])
    await walk(directory);
  // Supplemental preview/import suites consume this exact website topology.
  for (const directory of ["public", "content", "src", "scripts"])
    await walk(join("..", directory));
  for (const path of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "vite.config.ts",
    "scripts/test-e2e.ts",
    "../package.json",
    "../package-lock.json",
    "../astro.config.mjs",
    "../tsconfig.json",
  ])
    entries.push({
      path,
      sha256: createHash("sha256")
        .update(await readFile(resolve(repository, path)))
        .digest("hex"),
    });
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
export function changedInputs(
  before: Awaited<ReturnType<typeof inputManifest>>,
  after: Awaited<ReturnType<typeof inputManifest>>,
) {
  const a = new Map(before.map((r) => [r.path, r.sha256])),
    b = new Map(after.map((r) => [r.path, r.sha256]));
  return [...new Set([...a.keys(), ...b.keys()])]
    .filter((path) => a.get(path) !== b.get(path))
    .sort();
}
export async function builtFiles(directory: string) {
  const entries: { path: string; sha256: string }[] = [];
  const walk = async (relative: string) => {
    for (const entry of await readdir(resolve(directory, relative), {
      withFileTypes: true,
    })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile())
        entries.push({
          path,
          sha256: createHash("sha256")
            .update(await readFile(resolve(directory, path)))
            .digest("hex"),
        });
    }
  };
  await walk("");
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
