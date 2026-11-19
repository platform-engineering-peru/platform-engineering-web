/** Built application, real isolated PostgreSQL/HTTP/session/CSRF; only GitHub is an injected fake. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import express from "express";
import { chromium } from "playwright";
import { createPool, migrate } from "../src/server/db";
import { createApp } from "../src/server/app";
import { verifySeedMedia } from "../src/server/media";
import { entityDefinitions } from "../src/shared/product-contract";
import { eventProjection } from "../src/server/editorial-sync/validation";
import { FakeDirectGitHub } from "./helpers/direct-github-fixture";
if (!process.env.DATABASE_URL)
  throw Error(
    "DATABASE_URL required for isolated PostgreSQL browser acceptance.",
  );
const schema = `test_direct_events_browser_${randomUUID().replaceAll("-", "")}`,
  temporary = resolve(".local", schema),
  pool = createPool(process.env.DATABASE_URL, schema),
  server = createServer();
process.env.PRIVATE_KEY_DIR = resolve(temporary, "keys");
process.env.PRIVATE_STORAGE_DIR = resolve(temporary, "storage");
const browser = await chromium.launch({ channel: "chrome", headless: true }),
  page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
    reducedMotion: "reduce",
    timezoneId: "America/Los_Angeles",
  });
page.setDefaultTimeout(15000);
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const artifact = resolve(".local/qa/direct-publication/events-api-browser");
await mkdir(artifact, { recursive: true });
try {
  await migrate(pool, schema);
  const media = await verifySeedMedia();
  const payload = {
    ...structuredClone(
      entityDefinitions.find((d) => d.type === "events")!.defaults,
    ),
    slug: "browser-isolated",
    title: { "es-pe": "Encuentro aislado real", en: "Real isolated gathering" },
    description: {
      "es-pe": "Datos sintéticos de aceptación.",
      en: "Synthetic acceptance data.",
    },
    date: "2026-11-16",
    city: { "es-pe": "Lima", en: "Lima" },
    venue: "Prueba local",
    speakerIds: [],
  };
  const event = await eventProjection(
      "20000000-0000-4000-8000-000000000041",
      payload,
      "published",
    ),
    github = new FakeDirectGitHub([{ type: "events", record: event }]);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const app = createApp({
    pool,
    media,
    origin,
    fixtureAuthEnabled: true,
    environment: "test",
    editorial: {
      config: {
        mode: "github",
        repository: "example/community",
        branch: "main",
        remoteWritesEnabled: true,
      },
      transport: github,
      testTransport: true,
    },
  });
  const web = resolve(process.env.PRODUCT_WEB_DIST ?? "dist/web");
  app.use(express.static(web));
  app.get("/{*path}", (_req, res) =>
    res.sendFile("index.html", { root: web, dotfiles: "allow" }),
  );
  server.on("request", app);
  await page.goto(origin);
  await page.getByRole("button", { name: /Entrar como propietario/ }).click();
  await page.locator(".admin-shell").waitFor();
  async function navigate(label: string) {
    await page
      .getByRole("button", { name: "Buscar sección", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Ir a una sección" });
    await dialog.getByRole("searchbox").fill(label);
    await dialog
      .getByRole("button", { name: new RegExp(`^${label}`) })
      .first()
      .click();
  }
  await navigate("Eventos");
  await page
    .getByRole("button", { name: "Consultar GitHub", exact: true })
    .click();
  await page
    .locator(".editorial-event-list")
    .getByRole("button", { name: /Encuentro aislado real/ })
    .click();
  const spanish = page.getByRole("textbox", {
      name: "Título (español)",
      exact: true,
    }),
    english = page.getByRole("textbox", {
      name: "Título (inglés)",
      exact: true,
    });
  await spanish.fill("Encuentro con edición guardada");
  await english.fill("Gathering with saved edit");
  await page
    .getByRole("button", { name: "Guardar borrador local", exact: true })
    .click();
  await page
    .getByText("Guardado en este equipo. Todavía no se ha enviado a GitHub.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    (await pool.query("SELECT count(*) FROM editorial_drafts")).rows[0].count,
    "1",
  );
  assert.equal(github.createCalls, 0);
  const publicationKeys: string[] = [];
  page.on("request", (req) => {
    if (req.url().endsWith("/propose") && req.method() === "POST")
      publicationKeys.push(req.headers()["idempotency-key"]);
  });
  github.uncertainBeforeMutationOnce = true;
  await page
    .getByRole("button", { name: "Publicar evento en main", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "No se confirmó el resultado del envío" })
    .waitFor();
  assert.equal(github.commitCalls, 0);
  await page.reload();
  await page
    .locator(".editorial-event-list")
    .getByRole("button", { name: /Encuentro con edición guardada/ })
    .click();
  assert.equal(
    await page
      .getByRole("button", { name: "Reintentar el mismo envío", exact: true })
      .count(),
    0,
    "unverified uncertainty cannot be retried",
  );
  await page
    .getByRole("button", { name: "Comprobar resultado", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reintentar el mismo envío", exact: true })
    .waitFor();
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: `${artifact}/events-safe-retry.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Reintentar el mismo envío", exact: true })
    .click();
  await page
    .locator(".editorial-status-note")
    .getByText("Guardado en GitHub · despliegue pendiente", { exact: true })
    .waitFor();
  assert.equal(github.commitCalls, 1);
  assert.equal(github.createCalls, 0);
  assert.equal(publicationKeys.length, 2);
  assert.equal(
    publicationKeys[1],
    publicationKeys[0],
    "reloaded safe retry uses exact original idempotency key",
  );
  assert.equal(
    (await pool.query("SELECT count(*) FROM editorial_proposals")).rows[0]
      .count,
    "1",
    "retry does not create another immutable operation",
  );
  assert.equal(github.records[0].record.title.en, "Gathering with saved edit");
  assert.equal(await page.getByRole("link", { name: /PR #/ }).count(), 0);
  github.deployed = true;
  await page
    .getByRole("button", { name: "Comprobar resultado", exact: true })
    .click();
  await page
    .locator(".editorial-status-note")
    .getByText("Publicado en el sitio", { exact: true })
    .waitFor();
  assert.equal(
    github.commitCalls,
    1,
    "deployment reconciliation never recommits content",
  );
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: `${artifact}/events-direct-deployed.png`,
    fullPage: true,
  });
  await navigate("Calendario");
  await page.getByRole("grid").waitFor();
  await page.locator('[data-day="2026-11-16"]').click();
  await page
    .locator(".calendar-day-detail")
    .getByText("Encuentro con edición guardada", { exact: true })
    .waitFor();
  assert.equal(await page.locator(".calendar-local-drafts").count(), 1);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: `${artifact}/real-http-calendar.png`,
    fullPage: true,
  });
  assert.ok(
    github.websiteChecks.some((check) => check.types.includes("events")),
    "publication must check website compatibility at an immutable commit",
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        realPostgresHttpBrowser: "passed",
        localSave: "passed",
        directCommitAndDeployment: "passed",
        sameOperationRetryAfterReload: "passed",
        sameIdempotencyKey: true,
        immutableOperations: 1,
        canonicalCalendar: "passed",
        schema,
        remoteCalls: "fake only",
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
  await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await pool.end();
  await rm(temporary, { recursive: true, force: true });
}
