/** Exact real-run DTO replay against the built client; no provider, DB, or runtime writes. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import express from "express";
import { chromium } from "playwright";
import { entityDefinitions } from "../src/shared/product-contract";
const run = {
  runId: "d2fc0788-8e79-4539-8983-34f717e761d4",
  sourceId: "encora",
  status: "complete",
  startedAt: "2026-11-18T05:00:00Z",
  finishedAt: "2026-11-18T05:01:00Z",
  recordsFetched: 296,
  relevantRecords: 21,
  newRecords: 21,
  changedRecords: 0,
  closedRecords: 0,
  publicCount: 0,
  errorCode: null,
  evidence: { scope: "board", complete: true },
};
const source = {
  id: "encora",
  config: {
    company: "Encora",
    adapter: "greenhouse",
    boardIdentifier: "encora10",
    enabled: true,
  },
  runtime: {
    lastStatus: "complete",
    lastErrorCode: null,
    lastOperation: { state: "complete", lastCode: "OK", outcome: "complete" },
  },
};
const user = {
  id: "isolated",
  name: "Revisión aislada",
  role: "owner",
  roles: ["owner"],
  capabilities: ["*"],
  csrfToken: "isolated",
};
const app = express(),
  server = createServer(app),
  web = resolve(process.env.PRODUCT_WEB_DIST ?? "dist/web");
let mutations = 0;
app.use(express.json());
app.use("/api", (req, res) => {
  if (req.method !== "GET") mutations++;
  if (req.path === "/config")
    return res.json({
      fixtureAuthEnabled: false,
      localGhAuthEnabled: true,
      editorialMode: "local",
    });
  if (req.path === "/me") return res.json(user);
  if (req.path === "/catalog") return res.json({ entities: entityDefinitions });
  if (req.path === "/media") return res.json([]);
  if (req.path === "/overview")
    return res.json({ counts: {}, reviewQueue: [], upcoming: [] });
  if (req.path === "/jobs/status")
    return res.json({
      collectionEnabled: true,
      processRunning: true,
      sources: 1,
    });
  if (req.path === "/job-sources")
    return res.json({ items: [source], nextCursor: null });
  if (req.path === "/jobs/runs")
    return res.json({
      items: [
        {
          id: run.runId,
          source_id: source.id,
          status: "complete",
          summary: run,
        },
      ],
      nextCursor: null,
    });
  if (req.path === "/jobs/candidates")
    return res.json({ items: [], nextCursor: null });
  if (req.path === "/job-sources/encora/run")
    return res.json({
      id: "operation-replay",
      state: "complete",
      last_code: "OK",
      result: run,
    });
  return res
    .status(404)
    .json({ code: "UNEXPECTED_TEST_REQUEST", message: req.path });
});
app.use(express.static(web));
app.get("/{*path}", (_req, res) =>
  res.sendFile("index.html", { root: web, dotfiles: "allow" }),
);
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert.ok(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: "reduce",
});
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const artifacts = resolve(
  process.env.ARTIFACTS_DIR ?? ".local/qa/run-result-followup/browser",
);
await mkdir(artifacts, { recursive: true });
try {
  for (const width of [1440, 390, 320])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${origin}/?section=job-sources`);
      await page.locator(".jobs-manager-list button").first().click();
      if ((await page.locator("html").getAttribute("data-theme")) !== theme)
        await page
          .getByRole("button", { name: "Cambiar tema", exact: true })
          .click();
      await page.getByText("Última solicitud:").waitFor();
      assert.match(
        await page.locator(".jobs-workspace").innerText(),
        /Lectura completada sin errores/,
      );
      assert.doesNotMatch(
        await page.locator(".jobs-workspace").innerText(),
        /No se pudo completar esta lectura/,
      );
      await page
        .getByRole("button", { name: "Recolectar ahora", exact: true })
        .click();
      await page.locator(".jobs-run-summary").waitFor();
      const summary = await page.locator(".jobs-run-summary").innerText();
      assert.match(summary, /Lectura completa de la bolsa/);
      assert.match(summary, /296/);
      assert.match(summary, /21/);
      assert.match(summary, /Sin error informado/);
      assert.doesNotMatch(
        summary,
        /Consulta la evidencia|No se pudo completar/,
      );
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: resolve(artifacts, `source-${width}-${theme}.png`),
        fullPage: true,
      });
      await page.goto(`${origin}/?section=collection-runs`);
      await page.locator(".jobs-manager-list button").first().click();
      await page
        .getByRole("heading", { name: "Resultado de recolección" })
        .waitFor();
      assert.match(
        await page.locator(".jobs-run-summary").innerText(),
        /Lectura completa de la bolsa/,
      );
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: resolve(artifacts, `history-${width}-${theme}.png`),
        fullPage: true,
      });
    }
  assert.equal(mutations, 6);
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(artifacts, "result.json"),
    JSON.stringify(
      {
        run,
        widths: [1440, 390, 320],
        themes: ["light", "dark"],
        mutations: "six simulated collection requests only",
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS real completed296/21 DTO source/request/history at1440/390/320 both themes, zero page errors",
  );
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
