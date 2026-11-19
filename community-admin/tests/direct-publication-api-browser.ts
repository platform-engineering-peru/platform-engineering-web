/** Built real HTTP/cookie/CSRF/isolatedPG; only GitHub transport is synthetic. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import express from "express";
import { chromium } from "playwright";
import { createApp } from "../src/server/app";
import { createPool, migrate } from "../src/server/db";
import { verifySeedMedia } from "../src/server/media";
import { entityDefinitions } from "../src/shared/product-contract";
import { fullIntegrationOptions } from "../src/server/integration-bridge";
import { IntegrationService } from "../src/server/integrations/service";
import { FakeDirectGitHub } from "./helpers/direct-github-fixture";
assert.ok(process.env.DATABASE_URL, "Explicit isolated loopback DB required");
const schema = "test_direct_ui_" + randomUUID().replaceAll("-", "");
const pool = createPool(process.env.DATABASE_URL, schema),
  server = createServer(),
  temporary = resolve(".local", schema);
process.env.PRIVATE_KEY_DIR = resolve(temporary, "keys");
process.env.PRIVATE_STORAGE_DIR = resolve(temporary, "storage");
process.env.INTEGRATIONS_LIVE_ENABLED = "false";
delete process.env.LOCAL_GH_AUTH;
delete process.env.EDITORIAL_MODE;
delete process.env.EDITORIAL_REPOSITORY;
delete process.env.JOBS_WEBSITE_REPOSITORY;
const remote = new FakeDirectGitHub(),
  publication = {
    config: {
      mode: "github" as const,
      repository: "example/community",
      branch: "main",
      remoteWritesEnabled: true,
    },
    transport: remote,
  };
const browser = await chromium.launch({ channel: "chrome", headless: true }),
  page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
page.setDefaultTimeout(15000);
const artifacts = resolve(
  process.env.ARTIFACTS_DIR ??
    ".local/qa/direct-publication/actual-api-browser",
);
await mkdir(artifacts, { recursive: true });
try {
  await migrate(pool, schema);
  await pool.query(
    "UPDATE users SET provider_subject='42' WHERE id='10000000-0000-4000-8000-000000000004'",
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const origin = `http://127.0.0.1:${addr.port}`;
  // Backend provides this override only in environment=test; it cannot activate a live provider.
  const app = createApp({
    pool,
    origin,
    media: await verifySeedMedia(),
    fixtureAuthEnabled: true,
    environment: "test",
    jobsTest: { websitePublication: publication },
  } as any);
  const web = resolve(process.env.PRODUCT_WEB_DIST ?? "dist/web");
  app.use(express.static(web));
  app.get("/{*path}", (_, res) =>
    res.sendFile("index.html", { root: web, dotfiles: "allow" }),
  );
  server.on("request", app);
  const service = new IntegrationService({
    ...fullIntegrationOptions(pool),
    pool,
    liveEnabled: false,
    websitePublication: publication,
  });
  await page.goto(origin);
  await page.getByRole("button", { name: /Entrar como propietario/ }).click();
  await page.locator(".admin-shell").waitFor();
  const me = await (await page.request.get(origin + "/api/me")).json();
  async function post(path: string, body: any) {
    return page.request.post(origin + "/api" + path, {
      headers: {
        Origin: origin,
        "X-CSRF-Token": me.csrfToken,
        "Idempotency-Key": randomUUID(),
      },
      data: body,
    });
  }
  const def = entityDefinitions.find((d) => d.type === "resources")!,
    payload = {
      ...structuredClone(def.defaults),
      slug: "synthetic-direct-resource",
      title: {
        "es-pe": "Recurso directo de prueba",
        en: "Synthetic direct resource",
      },
      description: {
        "es-pe": "Solo datos sintéticos de aceptación.",
        en: "Synthetic acceptance data only.",
      },
      href: "https://example.org/platform-engineering",
    };
  const created = await post("/records", { type: "resources", payload });
  assert.equal(created.status(), 201, await created.text());
  const resource = await created.json();
  assert.equal(resource.state, "draft");
  const privateDef = entityDefinitions.find((d) => d.type === "people")!;
  const privateResponse = await post("/records", {
    type: "people",
    payload: {
      ...structuredClone(privateDef.defaults),
      name: "Synthetic private contact",
      provenance: "Test",
      permissionBasis: "Synthetic",
    },
  });
  assert.equal(privateResponse.status(), 201, await privateResponse.text());
  const privateRow = await privateResponse.json();
  const denied = await post("/changesets", {
    recordIds: [privateRow.id],
    expectedRevisions: { [privateRow.id]: privateRow.revision },
  });
  assert.equal(denied.status(), 422, await denied.text());
  assert.equal((await denied.json()).code, "PRIVATE_RECORD_NOT_EXPORTABLE");
  const stale = await post("/changesets", {
    recordIds: [resource.id],
    expectedRevisions: { [resource.id]: resource.revision + 1 },
  });
  assert.equal(stale.status(), 409, await stale.text());
  assert.equal(remote.commitCalls, 0);
  remote.websiteChecks = [];
  await page.goto(origin + "/?section=resources");
  await page
    .locator(".record-list li")
    .filter({ hasText: "Recurso directo de prueba" })
    .getByRole("button")
    .click();
  await page
    .locator(".focused-editor .editor-section-nav button")
    .filter({ hasText: "Revisión" })
    .click();
  const inline = page.getByRole("region", {
    name: "Publicación de esta revisión en el sitio",
    exact: true,
  });
  await inline
    .getByLabel(
      "Confirmo el contenido y los permisos públicos de esta revisión",
      { exact: true },
    )
    .check();
  await inline
    .getByRole("button", {
      name: "Publicar esta revisión en main",
      exact: true,
    })
    .click();
  await inline.getByText("Publicando en GitHub", { exact: true }).waitFor();
  assert.ok(remote.websiteChecks.length > 0);
  assert.ok(
    remote.websiteChecks.every((check) =>
      check.types.every((type) => type === "resources"),
    ),
    "inline readiness checks the displayed resource type, not unrelated public types",
  );
  assert.equal(
    remote.commitCalls,
    0,
    "capture queues validated intent, no fake success",
  );
  await service.tick();
  assert.equal(remote.commitCalls, 1);
  assert.equal(remote.createCalls, 0, "direct flow creates no PR");
  assert.ok(remote.records.some((r) => r.record.id === resource.id));
  await inline
    .getByRole("button", {
      name: "Comprobar publicación y despliegue",
      exact: true,
    })
    .click();
  await inline
    .getByText("Guardado en GitHub · despliegue pendiente", { exact: true })
    .waitFor();
  assert.equal(
    await inline.getByText("Publicado en el sitio", { exact: true }).count(),
    0,
  );
  await page.goto(origin + "/?section=changesets");
  await page
    .getByRole("heading", { name: "Publicación del sitio", exact: true })
    .waitFor();
  const stored = await (
    await page.request.get(origin + "/api/changesets")
  ).json();
  await page.locator(`[data-changeset-id="${stored.items[0].id}"]`).click();
  const check = page.getByRole("button", {
    name: "Comprobar publicación y despliegue",
    exact: true,
  });
  remote.failDeployment = true;
  await check.click();
  await page
    .getByText("El commit está guardado; falló el despliegue", { exact: true })
    .last()
    .waitFor();
  assert.equal(remote.commitCalls, 1);
  remote.failDeployment = false;
  remote.deployed = true;
  await check.click();
  await page
    .getByText("Publicado en el sitio", { exact: true })
    .last()
    .waitFor();
  assert.equal(remote.commitCalls, 1);
  for (const width of [1440, 390, 320])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 1000 });
      if ((await page.locator("html").getAttribute("data-theme")) !== theme)
        await page
          .getByRole("button", { name: "Cambiar tema", exact: true })
          .click();
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: resolve(artifacts, `generic-${width}-${theme}.png`),
        fullPage: true,
      });
      assert.ok(
        await page
          .locator(".product-main")
          .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
      );
    }
  assert.ok(
    remote.websiteChecks.some((check) => check.types.includes("resources")),
    "publication must check website compatibility at an immutable commit",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(artifacts, "result.json"),
    JSON.stringify(
      {
        realPG: true,
        cookieOriginCsrf: true,
        privateRejected: true,
        draftPublishedWithoutPriorApproval: true,
        commitCount: remote.commitCalls,
        prCount: remote.createCalls,
        commitVsDeployment: true,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS genericdraft→explicitpublish→directcommit→deploymentfailure→verifieddeployment, private rejection,0PRs; fakeGitHub only",
  );
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.end();
  await rm(temporary, { recursive: true, force: true });
}
