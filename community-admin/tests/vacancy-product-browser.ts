import { FakeDirectGitHub } from "./helpers/direct-github-fixture";
/** Actual cookie/CSRF API + isolated PG + built web; synthetic provider/GitHub transport, no real writes. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import express from "express";
import { chromium } from "playwright";
import { createPool, migrate, COMMUNITY_ID } from "../src/server/db";
import { createApp } from "../src/server/app";
import { IntegrationService } from "../src/server/integrations/service";
import { publicJobs } from "../src/server/jobs/engine";
import { hashValue } from "../src/server/integrations/security";
import type { JobsRemote } from "../src/server/jobs/publication";
import type { Transport } from "../src/server/integrations/http";
assert.ok(process.env.DATABASE_URL, "Explicit loopback test DB required");
const schema = "test_direct_jobs_browser_" + randomUUID().replaceAll("-", ""),
  pool = createPool(process.env.DATABASE_URL, schema),
  temporary = resolve(".local", schema),
  artifacts = resolve(
    process.env.ARTIFACTS_DIR ??
      ".local/qa/direct-publication/jobs-api-browser",
  );
process.env.PRIVATE_KEY_DIR = resolve(temporary, "keys");
process.env.PRIVATE_STORAGE_DIR = resolve(temporary, "storage");
process.env.INTEGRATIONS_LIVE_ENABLED = "false";
process.env.WEBSITE_CHECKOUT = resolve(process.env.WEBSITE_CHECKOUT ?? "..");
delete process.env.LOCAL_GH_AUTH;
delete process.env.JOBS_WEBSITE_REPOSITORY;
delete process.env.JOBS_WEBSITE_WRITES;
const owner = "10000000-0000-4000-8000-000000000004";
const remote = new FakeDirectGitHub();
const publication = {
  config: {
    mode: "github" as const,
    repository: "example/community",
    branch: "main",
    remoteWritesEnabled: true,
  },
  transport: remote as unknown as JobsRemote,
};
const provider: Transport = async (url) => {
  assert.ok(url.startsWith("https://careers.example.org/"));
  return {
    status: 200,
    headers: { "content-type": "text/html" },
    body: Buffer.from(
      url.endsWith("robots.txt")
        ? "User-agent: *\nAllow: /"
        : `<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title: "Platform Engineer", hiringOrganization: { name: "Empresa de prueba" }, jobLocationType: "TELECOMMUTE", applicantLocationRequirements: { name: "Peru" }, jobLocation: { address: { addressCountry: "PE", addressLocality: "Lima" } }, validThrough: "2099-01-01T00:00:30Z", url: "https://careers.example.org/vacancy/1" })}</script>`,
    ),
  };
};
const service = new IntegrationService({
    pool,
    liveEnabled: false,
    jobsPublication: publication,
    jobsTransport: provider,
  }),
  server = createServer(),
  browser = await chromium.launch({ channel: "chrome", headless: true }),
  page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  }),
  errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
page.setDefaultTimeout(20000);
await mkdir(artifacts, { recursive: true });
try {
  await migrate(pool, schema);
  await pool.query("UPDATE users SET provider_subject='42' WHERE id=$1", [
    owner,
  ]);
  const speakers = JSON.parse(
    await readFile(
      process.env.SPEAKER_BASELINE ??
        ".local/qa/sticky-speakers/speaker-baseline.json",
      "utf8",
    ),
  );
  for (const row of speakers)
    await pool.query(
      "INSERT INTO records(id,community_id,type,scope,author_id,payload,state,revision_hash,updated_at) VALUES($1,$2,'speakers','public',$3,$4,'approved',$5,now())",
      [row.id, COMMUNITY_ID, owner, row.payload, hashValue(row.payload)],
    );
  await page.route("https://img.evbuc.com/**", async (route) => {
    const row = speakers.find(
      (r: any) => r.payload.photo === route.request().url(),
    );
    if (!row) return route.abort();
    await route.fulfill({
      status: 200,
      contentType: "image/jpeg",
      body: await readFile(
        resolve(
          process.env.SPEAKER_IMAGE_CACHE_DIR ??
            ".local/qa/sticky-speakers/photos",
          row.id + ".img",
        ),
      ),
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const app = createApp({
    pool,
    media: [],
    origin,
    fixtureAuthEnabled: true,
    environment: "test",
    jobsTest: { transport: provider, publication },
  });
  const web = resolve(process.env.PRODUCT_WEB_DIST ?? "dist/web");
  app.use(express.static(web));
  app.get("/{*path}", (_, res) =>
    res.sendFile(resolve(web, "index.html"), { dotfiles: "allow" }),
  );
  server.on("request", app);
  async function json(path: string) {
    const response = await page.request.get(origin + "/api" + path);
    assert.equal(response.status(), 200, await response.text());
    return response.json();
  }
  await page.goto(origin + "/?section=jobs-candidates");
  await page.getByRole("button", { name: /Entrar como propietario/ }).click();
  await page
    .getByRole("button", { name: "Añadir vacante por enlace", exact: true })
    .click();
  await page
    .getByLabel("Enlace original de la vacante", { exact: true })
    .fill("https://careers.example.org/vacancy/1");
  await page
    .locator(".jobs-intake")
    .getByLabel("Empresa", { exact: true })
    .fill("Empresa de prueba");
  await page
    .getByRole("button", { name: "Comprobar vacante", exact: true })
    .click();
  await page
    .getByText("Datos encontrados en la publicación", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("Título original", { exact: true }).inputValue(),
    "Platform Engineer",
  );
  assert.equal(
    await page
      .getByLabel("Idioma original de la oferta", { exact: true })
      .inputValue(),
    "und",
    "missing original language stays unknown",
  );
  await page
    .getByLabel("Idioma original de la oferta", { exact: true })
    .selectOption("en");
  await page
    .getByLabel("Evidencia de ubicación y acceso", { exact: true })
    .fill(
      "La fuente original indica Perú como país permitido para trabajo remoto.",
    );
  await page
    .getByLabel("Evidencia de vigencia", { exact: true })
    .fill(
      "Publicación original observada abierta hoy en el proveedor sintético.",
    );
  await page
    .getByLabel("Resumen para compartir · Español", { exact: true })
    .fill("Vacante de ingeniería de plataforma para Perú.");
  await page
    .getByLabel("Resumen para compartir · English", { exact: true })
    .fill("Platform engineering vacancy explicitly available in Peru.");
  await page
    .getByLabel("Verifiqué estos datos en la publicación original.", {
      exact: false,
    })
    .check();
  await page.screenshot({ path: resolve(artifacts, "intake-real-api.png") });
  await page
    .getByRole("button", { name: "Guardar vacante para revisión", exact: true })
    .click();
  await page
    .getByText(
      "Vacante guardada para revisión. Todavía no se publicó en el sitio.",
      { exact: true },
    )
    .waitFor();
  let row = (await json("/jobs/candidates?state=needs-review")).items[0];
  assert.equal(row.payload.approved, false);
  assert.equal(
    row.payload.contentLanguage,
    "en",
    "operator-selected original English survives actual API persistence",
  );
  assert.equal(
    row.payload.intake.curator.contentLanguage,
    "en",
    "original language choice has private provenance",
  );
  assert.equal(row.payload.eligibility, "remote-peru");
  assert.equal(row.payload.expiresAt, "2099-01-01T00:00:30.000Z");
  assert.equal(row.payload.intake.verificationMethod, "json-ld");
  await page
    .locator(".jobs-manager-list button")
    .filter({ hasText: "Platform Engineer" })
    .click();
  await page
    .getByLabel("Motivo y evidencia", { exact: true })
    .fill("Reviewed synthetic original employer evidence for Peru.");
  await page
    .getByRole("button", { name: "Aprobar oportunidad", exact: true })
    .click();
  await page.getByText("Decisión guardada.", { exact: false }).waitFor();
  await page.goto(origin + "/?section=jobs-active");
  await page
    .locator(".jobs-manager-list button")
    .filter({ hasText: "Platform Engineer" })
    .click();
  const panel = page.getByRole("region", {
    name: "Publicación de la vacante en el sitio",
  });
  await panel
    .getByLabel("Confirmo los datos públicos de esta oportunidad")
    .check();
  await panel
    .getByRole("button", {
      name: "Publicar oportunidad",
      exact: true,
    })
    .click();
  await panel.getByText("Publicando en GitHub", { exact: true }).waitFor();
  assert.equal(remote.commitCalls, 0);
  await service.tick();
  await panel
    .getByText("Guardado en GitHub · despliegue pendiente", { exact: true })
    .waitFor();
  assert.equal(remote.commitCalls, 1);
  row = (await json("/jobs/candidates?state=active")).items[0];
  assert.deepEqual(remote.records[0].record, publicJobs([row.payload])[0]);
  assert.ok(
    !JSON.stringify(remote.records[0].record).includes("activeEvidence"),
  );
  assert.equal(remote.createCalls, 0, "direct jobs creates no PR");
  remote.deployed = true;
  await panel
    .getByRole("button", {
      name: "Comprobar publicación y despliegue",
      exact: true,
    })
    .click();
  await panel.getByText("Publicado en el sitio", { exact: true }).waitFor();
  assert.equal(remote.commitCalls, 1);
  await page.screenshot({
    path: resolve(artifacts, "publication-real-api-fake-remote.png"),
  });
  const beforeEdit = (await json("/jobs/candidates?state=active")).items[0]
    .version;
  await page
    .getByRole("button", {
      name: "Editar datos de la vacante original",
      exact: true,
    })
    .click();
  assert.equal(
    await page
      .getByLabel("Cierre indicado (opcional, hora de Lima)", { exact: true })
      .inputValue(),
    "2098-12-31T19:00",
  );
  await page
    .getByLabel("Título original", { exact: true })
    .fill("Senior Platform Engineer");
  await page
    .getByLabel("Verifiqué estos datos en la publicación original.", {
      exact: false,
    })
    .check();
  await page
    .getByRole("button", { name: "Guardar vacante para revisión", exact: true })
    .click();
  await page
    .getByText(
      "Actualización guardada. Requiere nueva revisión; el sitio todavía no cambió.",
      { exact: true },
    )
    .waitFor();
  row = (await json("/jobs/candidates?state=needs-review")).items[0];
  assert.equal(row.payload.approved, false);
  assert.equal(row.version, beforeEdit + 1);
  assert.equal(row.payload.expiresAt, "2099-01-01T00:00:30.000Z");
  for (const width of [1440, 390, 320])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(origin + "/?section=speakers");
      await page.locator(".record-cover img").first().waitFor();
      await page.evaluate(
        (t) => (document.documentElement.dataset.theme = t),
        theme,
      );
      await page
        .locator(".record-cover img")
        .evaluateAll((images) =>
          images.forEach((i) => ((i as HTMLImageElement).loading = "eager")),
        );
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll<HTMLImageElement>(".record-cover img")]
            .length === 13 &&
          [
            ...document.querySelectorAll<HTMLImageElement>(".record-cover img"),
          ].every((i) => i.complete && i.naturalWidth === 294),
      );
      await page.evaluate(() => scrollTo(0, 650));
      const rect = await page.locator(".shell-context").boundingBox();
      assert.ok(rect && rect.y >= 0 && rect.y + rect.height < 400);
      await page.screenshot({
        path: resolve(artifacts, `speakers-${width}-${theme}.png`),
      });
    }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        realCookieOriginCsrf: true,
        isolatedPostgres: true,
        provider: "synthetic-jsonld",
        remote: "injected-transport-no-network",
        intakeReviewPublishReconcileEdit: true,
        photos: "8actualcheckout+5cachedoriginalHTTPSbytes",
        themesWidths: [1440, 390, 320],
        pageErrors: errors,
        schema,
      },
      null,
      2,
    ),
  );
} catch (e) {
  await page.screenshot({
    path: resolve(artifacts, "failure.png"),
    fullPage: true,
  });
  await writeFile(resolve(artifacts, "failure.html"), await page.content());
  throw e;
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await pool.end();
  await rm(temporary, { recursive: true, force: true });
}
