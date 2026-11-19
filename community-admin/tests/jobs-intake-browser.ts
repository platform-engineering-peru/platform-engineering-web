/** Built main client; mocked authentication/records, actual approved checkout image bytes. No live DB or provider writes. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import express from "express";
import { chromium } from "playwright";
import { entityDefinitions } from "../src/shared/product-contract";
import { stableUuid } from "../src/server/import-site";
const site = resolve(process.env.WEBSITE_CHECKOUT ?? ".."),
  web = resolve(process.env.PRODUCT_WEB_DIST ?? "dist/web");
const rows: any[] = [],
  assets = new Map<string, string>();
for (const type of ["speakers"]) {
  const definition = entityDefinitions.find((d) => d.type === type)!;
  for (const filename of (await readdir(resolve(site, "content", type))).filter(
    (f) => f.endsWith(".json"),
  )) {
    const record = JSON.parse(
      await readFile(resolve(site, "content", type, filename), "utf8"),
    );
    const payload = { ...structuredClone(definition.defaults), ...record };
    if (type === "organizers") {
      for (const key of ["photo", "figurine"]) {
        const id = stableUuid("asset:" + record[key]);
        assets.set(id, record[key]);
        payload[key + "AssetId"] = id;
      }
    }
    rows.push({
      id: record.id,
      type,
      payload,
      state: "approved",
      revision: 1,
      updatedAt: "2026-11-17T00:00:00Z",
    });
  }
}
rows.sort((a, b) => a.payload.displayOrder - b.payload.displayOrder);
const created: any[] = [];
const app = express(),
  server = createServer(app),
  mutations: string[] = [];
let authenticated = true,
  failReverify = false;
const user = {
  id: "isolated-review",
  name: "Revisión aislada",
  role: "owner",
  roles: ["owner"],
  capabilities: ["*"],
  csrfToken: "fixture-only",
  github: {
    subject: "123",
    login: "isolated",
    name: "Revisión aislada",
    source: "local-gh",
    profileUrl: "https://github.com/isolated",
    avatarUrl: "",
    verifiedAt: "2026-11-17T00:00:00Z",
  },
};
app.use(express.json());
app.use("/api", (req, res, next) => {
  if (req.method !== "GET") mutations.push(req.path);
  if (req.path === "/config")
    return res.json({
      fixtureAuthEnabled: false,
      localGhAuthEnabled: true,
      localGhAuthRequested: true,
      editorialMode: "local",
    });
  if (req.path === "/me")
    return authenticated
      ? res.json(user)
      : res
          .status(401)
          .json({ code: "UNAUTHENTICATED", message: "Sesión vencida." });
  if (req.path === "/auth/local-gh/challenge")
    return res.json({ csrfToken: "challenge-only" });
  if (req.path === "/auth/local-gh") {
    authenticated = true;
    return res.json(user);
  }
  if (req.path === "/auth/local-gh/reverify")
    return failReverify
      ? res.status(503).json({
          code: "AUTH_UNAVAILABLE",
          message: "GitHub CLI no está disponible.",
        })
      : res.json(user);
  if (req.path === "/logout") {
    authenticated = false;
    return res.sendStatus(204);
  }
  if (req.path === "/jobs/status")
    return res.json({
      collectionEnabled: true,
      publishingEnabled: false,
      execution: "local-process",
      processRunning: true,
      sources: 0,
      queued: 0,
      running: 0,
    });
  if (
    req.path === "/job-sources" ||
    req.path === "/jobs/runs" ||
    req.path === "/jobs/candidates"
  )
    return res.json({ items: [], nextCursor: null });
  if (req.path === "/jobs/intake/preview")
    return res.json({
      support: "manual-required",
      reason: "UNSUPPORTED_CAREERS_PAGE",
      draft: {
        company: req.body.company,
        locations: [],
        eligibility: "unknown",
      },
      evidence: {
        checkedAt: new Date().toISOString(),
        active: "unknown",
        method: "manual-required",
      },
      previewHash: "actor-bound-server-token",
    });
  if (req.path === "/jobs/intake") {
    created.push(req.body);
    return res.json({
      created: true,
      item: { id: "local-test", payload: req.body },
      duplicateSuggestions: [],
    });
  }
  if (req.path === "/catalog") return res.json({ entities: entityDefinitions });
  if (req.path === "/media")
    return res.json(
      [...assets].map(([id, path]) => ({
        id,
        path,
        label: path,
        width: 100,
        height: 100,
      })),
    );
  if (req.path.startsWith("/media/")) {
    const path = assets.get(req.path.slice(7));
    return path
      ? res.sendFile(path, { root: resolve(site, "public") })
      : res.sendStatus(404);
  }
  if (/^\/brand-assets\/[^/]+\/preview$/.test(req.path)) {
    const record = rows.find(
      (r) => r.type === "brands" && r.id === req.path.split("/")[2],
    );
    const path = record?.payload.previewPath || record?.payload.path;
    return path
      ? res.sendFile(path, { root: resolve(site, "public") })
      : res.sendStatus(404);
  }
  if (/^\/speaker-assets\/[^/]+\/preview$/.test(req.path)) {
    const record = rows.find((r) => r.id === req.path.split("/")[2]);
    return record?.payload.photo?.startsWith("speakers/")
      ? res.sendFile(record.payload.photo, { root: resolve(site, "public") })
      : res.sendStatus(404);
  }
  if (req.path === "/records")
    return res.json({
      items: rows.filter((r) => r.type === req.query.type),
      nextCursor: null,
    });
  if (req.path.endsWith("/audit")) return res.json([]);
  if (req.path.startsWith("/records/"))
    return res.json(rows.find((r) => r.id === req.path.slice(9)));
  if (req.path === "/overview")
    return res.json({ counts: {}, reviewQueue: [], upcoming: [] });
  return next();
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
page.setDefaultTimeout(10000);
const artifacts = resolve(
  process.env.ARTIFACTS_DIR ?? ".local/qa/sticky-speakers/intake-browser",
);
await mkdir(artifacts, { recursive: true });
try {
  for (const width of [1440, 390, 320])
    for (const dark of [false, true]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${origin}/?section=jobs-candidates`);
      await page
        .getByRole("button", { name: "Añadir vacante por enlace", exact: true })
        .waitFor();
      if (
        ((await page.locator("html").getAttribute("data-theme")) === "dark") !==
        dark
      )
        await page
          .getByRole("button", { name: "Cambiar tema", exact: true })
          .click();
      await page
        .getByRole("button", { name: "Añadir vacante por enlace", exact: true })
        .click();
      await page
        .getByLabel("Enlace original de la vacante", { exact: true })
        .fill("https://careers.example.org/devops-peru");
      await page
        .locator(".jobs-intake")
        .getByLabel("Empresa", { exact: true })
        .fill("Empresa de prueba");
      await page
        .getByRole("button", { name: "Comprobar vacante", exact: true })
        .click();
      await page
        .getByText("Completa los datos manualmente", { exact: true })
        .waitFor();
      await page
        .getByLabel("Título original", { exact: true })
        .fill("DevOps Engineer");
      assert.equal(
        await page
          .getByLabel("Idioma original de la oferta", { exact: true })
          .inputValue(),
        "und",
      );
      await page
        .getByLabel("Idioma original de la oferta", { exact: true })
        .selectOption("en");
      await page
        .getByLabel("Ubicaciones publicadas", { exact: false })
        .fill("Lima, Perú");
      await page
        .getByLabel("Modalidad", { exact: true })
        .selectOption("hybrid");
      await page
        .getByLabel("Disponibilidad para nuestra comunidad", { exact: true })
        .selectOption("peru");
      await page
        .getByLabel("Evidencia de ubicación y acceso", { exact: true })
        .fill("La publicación original indica Lima, Perú.");
      await page
        .getByLabel("Evidencia de vigencia", { exact: true })
        .fill("Enlace original abierto y vigente al revisar hoy.");
      await page
        .getByLabel("Resumen para compartir · Español", { exact: true })
        .fill("Vacante DevOps publicada por la empresa en Perú.");
      await page
        .getByLabel("Resumen para compartir · English", { exact: true })
        .fill("Employer DevOps vacancy explicitly available in Peru.");
      const form = page.locator(".jobs-intake");
      await page.screenshot({
        path: `${artifacts}/form-${width}-${dark ? "dark" : "light"}.png`,
      });
      await page
        .getByLabel("Idioma original de la oferta", { exact: true })
        .scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `${artifacts}/language-${width}-${dark ? "dark" : "light"}.png`,
      });
      const a = await page
          .getByLabel("Modalidad", { exact: true })
          .boundingBox(),
        b = await page
          .getByLabel("Disponibilidad para nuestra comunidad", { exact: true })
          .boundingBox();
      if (width === 1440)
        assert.ok(
          a &&
            b &&
            Math.abs(a.y - b.y) < 2 &&
            Math.abs(a.height - b.height) < 2,
          `Paired selects align: ${JSON.stringify({ a, b })}`,
        );
      assert.ok(await form.evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
      assert.equal(
        await page
          .getByRole("button", {
            name: "Guardar vacante para revisión",
            exact: true,
          })
          .isDisabled(),
        true,
      );
      page.once("dialog", (d) => d.dismiss());
      await form.getByRole("button", { name: "Cancelar", exact: true }).click();
      assert.equal(
        await page.getByLabel("Título original", { exact: true }).inputValue(),
        "DevOps Engineer",
      );
      await page
        .getByLabel("Verifiqué estos datos en la publicación original.", {
          exact: false,
        })
        .check();
      await page
        .getByRole("button", {
          name: "Guardar vacante para revisión",
          exact: true,
        })
        .click();
      await page
        .getByText(
          "Vacante guardada para revisión. Todavía no se publicó en el sitio.",
          { exact: true },
        )
        .waitFor();
    }
  assert.equal(created.length, 6);
  for (const r of created) {
    assert.equal(r.eligibility, "peru");
    assert.equal(
      r.contentLanguage,
      "en",
      "operator-selected source language is sent without title inference",
    );
    assert.equal(r.previewHash, "actor-bound-server-token");
    assert.equal(r.url, "https://careers.example.org/devops-peru");
  }
  assert.ok(!mutations.some((path) => /changeset|publish/.test(path)));
  assert.deepEqual(errors, []);
  console.log(
    "PASS manual intake, source facts, attestation, dirty cancel, no publication, form geometry1440/390/320 both themes",
  );
} catch (e) {
  await writeFile(`${artifacts}/failure.html`, await page.content());
  await page.screenshot({ path: `${artifacts}/failure.png`, fullPage: true });
  throw e;
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
