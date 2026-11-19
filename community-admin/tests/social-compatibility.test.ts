import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { rendererVerifier } from "../src/server/editorial-sync/compatibility";
test("the reviewed local blog/calendar descriptor verifies exact files and never treats missing reader support as ready", async () => {
  const calls = new Map<string, number>();
  const reader = async (path: string) => {
    calls.set(path, (calls.get(path) ?? 0) + 1);
    return readFile(resolve("..", path));
  };
  const v = rendererVerifier(reader);
  await v.verify(["blog", "events"]);
  for (const count of calls.values()) assert.equal(count, 1);
  assert.ok(calls.has("src/pages/[lang]/blog/[slug].astro"));
  assert.ok(calls.has("src/modules/calendar/controller.ts"));
  await assert.rejects(
    () =>
      rendererVerifier(async (path) =>
        path === "src/modules/blog/BlogDetail.astro"
          ? Buffer.from("unreviewed")
          : reader(path),
      ).verify(["blog"]),
    { code: "WEBSITE_RENDERER_NOT_READY" },
  );
});
