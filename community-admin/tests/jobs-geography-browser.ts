/** Built UI geography review with synthetic source facts; no provider or database writes. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import express from "express";
import { chromium } from "playwright";
import { entityDefinitions } from "../src/shared/product-contract";
const jobs = [
  ["peru", "DevOps Engineer Peru", "Lima, Peru", "peru", "onsite"],
  [
    "latam",
    "SRE Remote LATAM",
    "Remote LATAM",
    "remote-latam-confirmed",
    "remote",
  ],
  [
    "malaysia",
    "Storage Platform Engineer",
    "Kuala Lumpur, Malaysia",
    "peru",
    "onsite",
  ],
  [
    "unknown",
    "Infrastructure Engineer",
    "Location not provided",
    "unknown",
    "unknown",
  ],
].map(([id, title, location, eligibility, workplace]) => ({
  id,
  version: 1,
  geography: {
    qualified: ["peru", "latam"].includes(id),
    eligibility,
    reason: (
      {
        peru: "explicit-peru",
        latam: "explicit-remote-latam",
        malaysia: "outside-region",
        unknown: "location-unconfirmed",
      } as Record<string, string>
    )[id],
  },
  payload: {
    id,
    title,
    company: "Synthetic Coforge",
    status: "candidate",
    locations: [location],
    eligibility,
    workplace,
    sourceUrl: `https://careers.example.org/jobs/${id}`,
    applyUrl: `https://careers.example.org/jobs/${id}`,
    summary: { "es-pe": "", en: "" },
    lastVerifiedAt: "2026-11-18T15:00:00Z",
  },
}));
const app = express(),
  server = createServer(app);
const user = {
  id: "isolated-geography",
  name: "Synthetic reviewer",
  roles: ["owner"],
  role: "owner",
  capabilities: ["*"],
  csrfToken: "synthetic",
};
const writes: string[] = [];
app.use("/api", (req, res) => {
  if (req.method !== "GET") {
    writes.push(req.path);
    return res.status(405).json({ message: "Read-only fixture" });
  }
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
    return res.json({ collectionEnabled: true, processRunning: true });
  if (req.path === "/job-sources" || req.path === "/jobs/runs")
    return res.json({ items: [], nextCursor: null });
  if (req.path === "/jobs/publication/status")
    return res.json({
      ready: false,
      reasons: ["JOBS_PUBLICATION_UNCONFIGURED"],
    });
  if (req.path === "/jobs/candidates") {
    assert.ok(
      ["qualified", "ineligible", "all"].includes(String(req.query.scope)),
      "client explicitly requests the authoritative geographic scope",
    );
    const rows = jobs.filter(
      (r) =>
        (req.query.scope === "all" ||
          r.geography.qualified === (req.query.scope === "qualified")) &&
        r.payload.title
          .toLowerCase()
          .includes(String(req.query.q ?? "").toLowerCase()),
    );
    return res.json({
      items: req.query.state === "candidate" ? rows : [],
      nextCursor: null,
    });
  }
  return res
    .status(404)
    .json({ code: "UNEXPECTED_TEST_REQUEST", message: req.path });
});
const web = resolve(process.env.PRODUCT_WEB_DIST ?? "dist/web");
app.use(express.static(web));
app.get("/{*path}", (_, res) =>
  res.sendFile("index.html", { root: web, dotfiles: "allow" }),
);
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert.ok(address && typeof address === "object");
const browser = await chromium.launch({ channel: "chrome", headless: true }),
  page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (dialog) => dialog.accept());
const artifacts = resolve(
  process.env.ARTIFACTS_DIR ?? ".local/qa/jobs-geography/captures",
);
await mkdir(artifacts, { recursive: true });
try {
  for (const width of [1440, 390, 320])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(
        `http://127.0.0.1:${address.port}/?section=jobs-candidates`,
      );
      await page
        .getByRole("heading", { name: "Vacantes por revisar", exact: true })
        .waitFor();
      if ((await page.locator("html").getAttribute("data-theme")) !== theme)
        await page
          .getByRole("button", { name: "Cambiar tema", exact: true })
          .click();
      await page
        .getByRole("button", { name: /DevOps Engineer Peru/ })
        .waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: /Storage Platform Engineer/ })
          .count(),
        0,
        "Kuala Lumpur must not appear in the default actionable review queue",
      );
      await page.screenshot({
        path: resolve(artifacts, `default-${width}-${theme}.png`),
        fullPage: true,
      });
      await page.getByRole("button", { name: /SRE Remote LATAM/ }).waitFor();
      await page
        .getByText("Mostrando 2 vacantes en esta vista", { exact: true })
        .waitFor();
      const scope = page.getByLabel("Alcance geográfico", { exact: true });
      await scope.focus();
      assert.equal(
        await scope.evaluate((node) => document.activeElement === node),
        true,
      );
      await scope.selectOption("ineligible");
      await page
        .getByRole("button", { name: /Storage Platform Engineer/ })
        .waitFor();
      assert.equal(await scope.inputValue(), "ineligible");
      assert.equal(
        await page
          .getByRole("button", { name: /DevOps Engineer Peru/ })
          .count(),
        0,
      );
      await page
        .getByRole("button", { name: /Infrastructure Engineer/ })
        .waitFor();
      await page
        .getByRole("button", { name: /Storage Platform Engineer/ })
        .click();
      const detail = page.getByRole("region", {
        name: "Detalle de oportunidad o fuente",
      });
      await detail.getByText("Fuera de región", { exact: true }).waitFor();
      assert.equal(
        await detail
          .getByRole("link", { name: "Ver fuente original" })
          .getAttribute("href"),
        "https://careers.example.org/jobs/malaysia",
      );
      await detail
        .getByLabel("Resumen revisado (español)", { exact: true })
        .fill("Resumen sintético");
      await detail
        .getByLabel("Resumen revisado (inglés)", { exact: true })
        .fill("Synthetic summary");
      await detail
        .getByLabel("Motivo y evidencia", { exact: true })
        .fill("Synthetic curator choice cannot override source geography");
      await detail.getByLabel(/Elegibilidad para Perú/).selectOption("peru");
      assert.equal(
        await detail
          .getByRole("button", { name: "Aprobar oportunidad", exact: true })
          .isDisabled(),
        true,
      );
      assert.equal(
        await scope.isDisabled(),
        true,
        "dirty edits cannot silently switch scope",
      );
      await page.screenshot({
        path: resolve(artifacts, `outside-${width}-${theme}.png`),
        fullPage: true,
      });
      await page.reload();
      await page
        .getByRole("button", { name: /DevOps Engineer Peru/ })
        .waitFor();
      await scope.selectOption("all");
      await page
        .getByText("Mostrando 4 vacantes en esta vista", { exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: /Infrastructure Engineer/ })
        .click();
      await detail
        .getByText("Ubicación sin confirmar", { exact: true })
        .waitFor();
      await page.screenshot({
        path: resolve(artifacts, `all-${width}-${theme}.png`),
        fullPage: true,
      });
      await page
        .getByLabel("Buscar vacantes", { exact: true })
        .fill("no-such-job");
      await page
        .getByText("Mostrando 0 vacantes en esta vista", { exact: true })
        .waitFor();
      await page
        .getByRole("heading", {
          name: "No hay vacantes en esta vista",
          exact: true,
        })
        .waitFor();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      assert.equal(overflow, false);
    }
  assert.deepEqual(errors, []);
  assert.deepEqual(writes, []);
  console.log(
    "PASS geography queue1440/390/320both themes; synthetic source facts, no writes",
  );
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
