/** Built main client, real isolated PostgreSQL/cookies/CSRF, deterministic public-provider fixtures. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import express from "express";
import { chromium } from "playwright";
import { createPool, migrate } from "../src/server/db";
import { createApp } from "../src/server/app";
import { IntegrationService } from "../src/server/integrations/service";
import { jobsWorkerState } from "../src/server/jobs/service";
import { publicJobs } from "../src/server/jobs/engine";
import type { Transport } from "../src/server/integrations/http";
assert.ok(
  process.env.DATABASE_URL,
  "An explicit isolated test database connection is required",
);
const schema = "test_jobs_browser_" + randomUUID().replaceAll("-", ""),
  pool = createPool(process.env.DATABASE_URL, schema),
  temporary = resolve(".local", schema),
  artifacts = resolve(".local/qa/jobs-product-browser");
process.env.PRIVATE_KEY_DIR = resolve(temporary, "keys");
process.env.PRIVATE_STORAGE_DIR = resolve(temporary, "storage");
process.env.INTEGRATIONS_LIVE_ENABLED = "false";
delete process.env.LOCAL_GH_AUTH;
delete process.env.CONNECTOR_ENCRYPTION_KEY;
const titles = [
  "DevOps Engineer",
  "Platform Engineer",
  "Site Reliability Engineer",
  "Forward Deployed Engineer",
  "Infrastructure Engineer",
  "Sales Executive",
];
let calls = 0;
const transport: Transport = async (url) => {
  calls++;
  assert.match(
    String(url),
    /^https:\/\/(boards-api\.greenhouse\.io|careers\.example\.org)\//,
  );
  if (String(url).includes("careers.example.org"))
    return {
      status: 200,
      headers: { "content-type": "text/html" },
      body: Buffer.from(
        String(url).includes("robots.txt")
          ? "User-agent: *\nAllow: /"
          : "<html><p>Unsupported board</p></html>",
      ),
    };
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(
      JSON.stringify({
        jobs: titles.map((title, i) => ({
          id: i + 1,
          title,
          location: { name: "Remote Peru" },
          absolute_url: `https://example.org/careers/${i + 1}`,
          content: "Maintain reliable infrastructure.",
          updated_at: new Date().toISOString(),
        })),
      }),
    ),
  };
};
const service = new IntegrationService({
    pool,
    liveEnabled: false,
    jobsTransport: transport,
  }),
  server = createServer(),
  browser = await chromium.launch({ channel: "chrome", headless: true }),
  page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  }),
  errors: string[] = [],
  mutations: string[] = [];
page.setDefaultTimeout(20000);
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  if (r.method() !== "GET") mutations.push(new URL(r.url()).pathname);
});
let timer: ReturnType<typeof setInterval> | undefined,
  ticking = false;
await mkdir(artifacts, { recursive: true });
try {
  await migrate(pool, schema);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  assert.ok(a && typeof a === "object");
  const origin = `http://127.0.0.1:${a.port}`;
  const app = createApp({
    pool,
    media: [],
    origin,
    fixtureAuthEnabled: true,
    environment: "test",
    jobsTest: { transport },
  });
  app.use(express.static(resolve(process.env.PRODUCT_WEB_DIST ?? "dist/web")));
  app.get("/{*path}", (_, res) =>
    res.sendFile(
      resolve(process.env.PRODUCT_WEB_DIST ?? "dist/web", "index.html"),
      { dotfiles: "allow" },
    ),
  );
  server.on("request", app);
  async function json(path: string) {
    const r = await page.request.get(origin + "/api" + path);
    assert.equal(r.status(), 200, await r.text());
    return r.json();
  }
  async function navigate(section: string) {
    await page.goto(origin + "/?section=" + section);
    await page.locator(".product-main").waitFor();
  }
  async function capture(name: string) {
    await page.screenshot({
      path: resolve(artifacts, name + ".png"),
      fullPage: true,
    });
  }
  await page.goto(origin + "/?section=job-sources");
  await page.getByRole("button", { name: /Entrar como propietario/ }).click();
  await page
    .getByRole("heading", { name: "Empresas y fuentes", exact: true })
    .waitFor();
  await page
    .getByLabel("URL de empleos", { exact: true })
    .fill("https://careers.example.org/careers");
  await page
    .getByRole("button", { name: "Comprobar fuente", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "No encontramos una fuente compatible" })
    .waitFor();
  assert.equal(
    await page.getByLabel("URL de empleos", { exact: true }).inputValue(),
    "https://careers.example.org/careers",
  );
  assert.equal((await json("/job-sources")).items.length, 0);
  await capture("unsupported-desktop-light");
  await page
    .getByLabel("URL de empleos", { exact: true })
    .fill("https://boards.greenhouse.io/fixturejobs");
  await page
    .getByLabel("Empresa (opcional)", { exact: true })
    .fill("Fixture Infrastructure");
  await page
    .getByRole("button", { name: "Comprobar fuente", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Guardar fuente sin activar" })
    .click();
  await page
    .getByText("Empresa guardada sin activar.", { exact: false })
    .waitFor();
  let sources = (await json("/job-sources")).items;
  assert.equal(sources.length, 1);
  assert.equal(sources[0].config.enabled, false);
  assert.equal(
    await page
      .getByRole("button", { name: "Recolectar ahora", exact: true })
      .isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "Revisar fuente y horario" }).click();
  await page
    .getByLabel("URL de términos revisados")
    .fill("https://example.org/terms");
  await page
    .getByLabel("Base de permiso o condiciones de lectura")
    .fill(
      "Synthetic provider fixture explicitly permitted for isolated acceptance.",
    );
  await page
    .getByLabel("Referencia de tu revisión")
    .fill("Isolated browser acceptance");
  await page
    .getByLabel("Atribución pública")
    .fill("Fixture Infrastructure careers");
  await page.getByLabel("Programar lecturas mientras").check();
  await page.getByLabel("He revisado esta fuente").check();
  await capture("review-source-desktop-light");
  for (const width of [390, 320])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(
        (t) => (document.documentElement.dataset.theme = t),
        theme,
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth + 1,
        ),
        false,
      );
      await capture(`review-source-${width}-${theme}`);
    }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  await page
    .getByRole("button", { name: "Guardar revisión y habilitar" })
    .click();
  await page
    .getByText("Fuente revisada y habilitada.", { exact: false })
    .waitFor();
  sources = (await json("/job-sources")).items;
  assert.equal(sources[0].config.schedule.enabled, true);
  assert.ok(sources[0].runtime.nextDueAt);
  assert.equal(sources[0].config._runtime, undefined);
  await page
    .getByRole("button", { name: "Recolectar ahora", exact: true })
    .click();
  await page.getByRole("heading", { name: "Tu solicitud" }).waitFor();
  jobsWorkerState(pool, true);
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void service.tick().finally(() => {
      ticking = false;
    });
  }, 200);
  async function until(check: () => Promise<boolean>) {
    const deadline = Date.now() + 20000;
    while (!(await check())) {
      assert.ok(
        Date.now() < deadline,
        "Durable collection did not finish within20seconds",
      );
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  await until(
    async () =>
      (await json("/jobs/candidates?state=candidate")).items.length === 5,
  );
  await until(async () =>
    Boolean((await json("/jobs/status")).lastSuccessfulFetchAt),
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM job_records")).rows[0].n,
    5,
  );
  await page.getByRole("button", { name: "Actualizar", exact: true }).click();
  assert.doesNotMatch(
    await page.locator(".jobs-workspace").innerText(),
    /No se pudo completar esta lectura/,
  );
  await capture("source-success-desktop-light");
  assert.ok(calls > 0);
  await until(
    async () =>
      (await page
        .locator(".jobs-run-summary")
        .getByText("5", { exact: true })
        .count()) > 0,
  );
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  while (ticking) await new Promise((r) => setTimeout(r, 20));
  await navigate("collection-runs");
  await page.locator(".jobs-manager-list button").first().click();
  await page
    .getByRole("heading", { name: "Resultado de recolección", exact: true })
    .waitFor();
  assert.ok(
    (await page
      .locator(".jobs-run-summary")
      .getByText("5", { exact: true })
      .count()) > 0,
  );
  assert.match(
    await page.locator(".jobs-run-summary").innerText(),
    /Lectura completa de la bolsa/,
  );
  await capture("collection-outcome-desktop-light");
  await navigate("jobs-candidates");
  await page
    .getByRole("heading", { name: "Vacantes por revisar", exact: true })
    .waitFor();
  for (const width of [1440, 390, 320])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({
        width,
        height: width === 1440 ? 1000 : 844,
      });
      await page.evaluate(
        (t) => (document.documentElement.dataset.theme = t),
        theme,
      );
      const visibleText = await page.locator(".product-main").innerText();
      assert.doesNotMatch(visibleText, /candidat|applicant|postulante/i);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth + 1,
        ),
        false,
      );
      await capture(`vacancies-review-${width}-${theme}`);
    }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  await page
    .locator(".jobs-manager-list button")
    .filter({ hasText: "DevOps Engineer" })
    .click();
  await page.getByLabel("Elegibilidad para Perú").selectOption("remote-peru");
  await page
    .getByLabel("Resumen revisado (español)")
    .fill(
      "Mantén infraestructura confiable con el equipo de plataforma de esta empresa de prueba.",
    );
  await page
    .getByLabel("Resumen revisado (inglés)")
    .fill(
      "Maintain reliable infrastructure with this synthetic company platform team.",
    );
  await page
    .getByLabel("Motivo y evidencia")
    .fill("Reviewed synthetic original source and Peru eligibility.");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .locator(".shell-context-nav")
    .getByRole("button", { name: "Activas", exact: true })
    .click();
  assert.equal(
    new URL(page.url()).searchParams.get("section"),
    "jobs-candidates",
  );
  assert.match(
    await page.getByLabel("Motivo y evidencia").inputValue(),
    /Reviewed synthetic/,
  );
  await page
    .getByRole("button", { name: "Aprobar oportunidad", exact: true })
    .click();
  await page.getByText("Decisión guardada.", { exact: false }).waitFor();
  assert.equal((await json("/jobs/candidates?state=active")).items.length, 1);
  const payloads = (
    await pool.query("SELECT payload FROM job_records ORDER BY id")
  ).rows.map((r) => r.payload);
  const canonical = publicJobs(payloads);
  assert.equal(canonical.length, 1);
  assert.equal(canonical[0].applyUrl, "https://example.org/careers/1");
  assert.equal(canonical[0].salary, null);
  assert.equal("sourceExcerpt" in canonical[0], false);
  await writeFile(
    resolve(artifacts, "approved-public-jobs.json"),
    JSON.stringify(canonical, null, 2),
  );
  await navigate("jobs-active");
  await page
    .locator(".jobs-manager-list button")
    .filter({ hasText: "DevOps Engineer" })
    .click();
  await page
    .getByLabel("Confirmo los datos públicos de esta oportunidad", {
      exact: true,
    })
    .check();
  assert.equal(
    await page
      .getByRole("button", { name: "Publicar oportunidad", exact: true })
      .isDisabled(),
    true,
    "unconfigured target is not presented as published",
  );
  // Without a configured target, even an explicit API request creates no publication intent.
  const beforePublicationIntents = (await json("/changesets")).items.length;
  const me = await json("/me"),
    selectedJob = (await json("/jobs/candidates?state=active")).items.find(
      (r: any) => r.payload.title === "DevOps Engineer",
    );
  const prepared = await page.request.post(origin + "/api/jobs/changeset", {
    headers: {
      Origin: origin,
      "X-CSRF-Token": me.csrfToken,
      "Idempotency-Key": randomUUID(),
    },
    data: {
      jobIds: [selectedJob.id],
      expectedVersions: { [selectedJob.id]: selectedJob.version },
    },
  });
  assert.equal(prepared.status(), 503, await prepared.text());
  assert.equal((await prepared.json()).code, "JOBS_PUBLICATION_UNCONFIGURED");
  assert.equal(
    (await json("/changesets")).items.length,
    beforePublicationIntents,
  );
  await capture("active-desktop-light");
  for (const width of [1440, 390, 320])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({
        width,
        height: width === 1440 ? 1000 : 844,
      });
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
        localStorage.setItem("community-admin-theme", t);
      }, theme);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth + 1,
        ),
        false,
        `overflow ${width}/${theme}`,
      );
      await capture(`active-${width}-${theme}`);
    }
  await page.emulateMedia({ reducedMotion: "no-preference" });
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (t) => (document.documentElement.dataset.theme = t),
      theme,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      ),
      false,
    );
    await capture(`active-320-${theme}-motion`);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page
    .getByText("Vencimiento y cierre revisados", { exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Marcar cerrada por la empresa…",
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Evidencia del cierre de la empresa")
    .fill("Confirmed closed in the synthetic employer source.");
  await page
    .getByRole("dialog")
    .getByRole("button", {
      name: "Registrar cierre con evidencia",
      exact: true,
    })
    .click();
  await page
    .getByText(
      "Cierre informado guardado; comprueba por separado la retirada del sitio.",
      { exact: true },
    )
    .waitFor();
  await navigate("jobs-closed");
  await page
    .locator(".jobs-manager-list button")
    .filter({ hasText: "DevOps Engineer" })
    .waitFor();
  assert.equal(
    await page
      .locator(".jobs-manager-list button")
      .filter({ hasText: "DevOps Engineer" })
      .count(),
    1,
  );
  await page
    .locator(".jobs-manager-list button")
    .filter({ hasText: "DevOps Engineer" })
    .click();
  await capture("closed-320-dark");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByLabel("Motivo y evidencia")
    .fill("Unsaved note to discard explicitly.");
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .locator(".shell-context-nav")
    .getByRole("button", { name: "Vacantes por revisar", exact: true })
    .click();
  assert.equal(
    new URL(page.url()).searchParams.get("section"),
    "jobs-candidates",
  );
  assert.equal(await page.locator(".jobs-search input").isEnabled(), true);
  assert.equal(await page.getByLabel("Motivo y evidencia").count(), 0);
  await page.setViewportSize({ width: 320, height: 844 });
  await navigate("job-sources");
  await page
    .locator(".jobs-manager-list button")
    .filter({ hasText: "Fixture Infrastructure" })
    .click();
  await page
    .getByRole("button", { name: "Pausar fuente", exact: true })
    .click();
  await page.getByText("Fuente pausada.", { exact: false }).waitFor();
  assert.equal(
    (await json("/job-sources")).items[0].config.schedule.enabled,
    false,
  );
  await navigate("integrations");
  await page
    .getByLabel("URN de organización de LinkedIn", { exact: true })
    .fill("https://www.linkedin.com/in/example/");
  const authorize = page.getByRole("button", {
    name: "Iniciar autorización oficial",
  });
  assert.equal(await authorize.first().isDisabled(), true);
  await page
    .getByText("Una URL de perfil personal de LinkedIn no es válida", {
      exact: false,
    })
    .waitFor();
  await capture("social-unconfigured-320-dark");
  const readiness = await json("/integrations");
  assert.equal(readiness.providers.linkedin.ready, false);
  assert.equal(readiness.providers.youtube.ready, false);
  await page
    .getByRole("combobox", { name: /Proveedor/ })
    .selectOption("youtube");
  await page
    .getByLabel("ID del canal de YouTube", { exact: true })
    .fill("UC1234567890123456789012");
  assert.equal(
    await page
      .getByRole("button", {
        name: "Iniciar autorización oficial",
        exact: true,
      })
      .isDisabled(),
    true,
  );
  await capture("youtube-unconfigured-320-dark");
  await page
    .getByRole("button", {
      name: "Ir a Publicaciones y preparar un paquete manual",
    })
    .click();
  assert.equal(new URL(page.url()).searchParams.get("section"), "calendar");
  assert.equal(
    mutations.some((p) => /oauth.*start|integrations\/authorize/.test(p)),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        builtMainClient: true,
        realPostgres: true,
        realCookieCsrf: true,
        providerTransport: "synthetic-public-GET-fixtures",
        roles: 5,
        sourceOnboarding: "PASS",
        scheduleAndPause: "PASS",
        collectWorkerPersistReviewClose: "PASS",
        socialUnavailable: "PASS",
        themesAndWidths: [1440, 390, 320],
        pageErrors: errors,
        artifacts,
      },
      null,
      2,
    ),
  );
} catch (error) {
  await page.screenshot({
    path: resolve(artifacts, "failure.png"),
    fullPage: true,
  });
  await writeFile(resolve(artifacts, "failure.html"), await page.content());
  await writeFile(
    resolve(artifacts, "failure-db.json"),
    JSON.stringify(
      {
        jobs: (
          await pool.query("SELECT id,payload FROM job_records ORDER BY id")
        ).rows,
        sources: (await pool.query("SELECT config FROM job_sources")).rows,
        api: await page.evaluate(async () => ({
          jobs: await (
            await fetch("/api/jobs/candidates?state=candidate")
          ).json(),
          status: await (await fetch("/api/jobs/status")).json(),
        })),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  if (timer) clearInterval(timer);
  while (ticking) await new Promise((r) => setTimeout(r, 20));
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await pool.end();
  await rm(temporary, { recursive: true, force: true });
}
