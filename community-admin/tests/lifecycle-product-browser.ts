/** Built console with real isolated PostgreSQL, authenticated cookies/Origin/CSRF and synthetic content only. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import express from "express";
import { chromium } from "playwright";
import { createPool, migrate, COMMUNITY_ID } from "../src/server/db";
import { createApp } from "../src/server/app";
import { JobsService } from "../src/server/jobs/service";
import { normalizeJob, publicJobs } from "../src/server/jobs/engine";
import { hashRevision } from "../src/shared/content";
import { encryptPrivate } from "../src/server/private-data";
import { entityDefinitions } from "../src/shared/product-contract";
assert.ok(
  process.env.DATABASE_URL,
  "Explicit disposable test database connection required",
);
const schema = "test_lifecycle_browser_" + randomUUID().replaceAll("-", ""),
  pool = createPool(process.env.DATABASE_URL, schema),
  temporary = resolve(".local", schema),
  artifacts = resolve(
    process.env.ARTIFACTS_DIR ??
      ".local/qa/deletion-actions/actual-pg-captures",
  );
process.env.PRIVATE_KEY_DIR = resolve(temporary, "keys");
process.env.PRIVATE_STORAGE_DIR = resolve(temporary, "storage");
process.env.INTEGRATIONS_LIVE_ENABLED = "false";
delete process.env.LOCAL_GH_AUTH;
const server = createServer(),
  browser = await chromium.launch({ channel: "chrome", headless: true }),
  page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
page.setDefaultTimeout(15000);
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
await mkdir(artifacts, { recursive: true });
try {
  await migrate(pool, schema);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const a = server.address();
  assert.ok(a && typeof a === "object");
  const origin = `http://127.0.0.1:${a.port}`;
  const app = createApp({
    pool,
    media: [],
    origin,
    fixtureAuthEnabled: true,
    environment: "test",
  });
  const web = resolve(process.env.PRODUCT_WEB_DIST ?? "dist/web");
  app.use(express.static(web));
  app.get("/{*path}", (_, res) =>
    res.sendFile("index.html", { root: web, dotfiles: "allow" }),
  );
  server.on("request", app);
  await page.goto(origin + "/?section=people");
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/api/me") && r.status() === 200,
    ),
    page.getByRole("button", { name: /Entrar como propietario/ }).click(),
  ]);
  await page.goto(origin + "/?section=people");
  await page
    .getByRole("button", { name: "Importar CSV", exact: true })
    .waitFor();
  const actor = (await pool.query("SELECT id FROM users WHERE role='owner'"))
    .rows[0].id;
  const json = async (path: string) => {
    const r = await page.request.get(origin + "/api" + path);
    assert.equal(r.status(), 200, await r.text());
    return r.json();
  };
  async function go(section: string, theme: string) {
    await page.goto(origin + "/?section=" + section);
    await page.locator(".product-main").waitFor();
    if ((await page.locator("html").getAttribute("data-theme")) !== theme)
      await page
        .getByRole("button", { name: "Cambiar tema", exact: true })
        .click();
  }
  async function confirm(label: string, submit: string) {
    const details = page
      .locator(".lifecycle-actions")
      .filter({
        has: page.getByRole("button", {
          name: label,
          exact: true,
          includeHidden: true,
        }),
      })
      .first();
    if (!(await details.evaluate((e) => (e as HTMLDetailsElement).open)))
      await details.locator("summary").click();
    await page.getByRole("button", { name: label, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog
      .locator("textarea")
      .fill("Synthetic confirmed lifecycle operation");
    await dialog.getByRole("button", { name: submit, exact: true }).click();
  }
  async function insert(type: string, name: string, state: string) {
    const definition = entityDefinitions.find((d) => d.type === type)!,
      id = randomUUID(),
      payload = {
        ...structuredClone(definition.defaults),
        ...(["people", "organizers"].includes(type)
          ? { name }
          : {
              slug: "synthetic-" + id,
              title: { "es-pe": name, en: name },
              href: "https://example.org/resource",
            }),
      };
    await pool.query(
      "INSERT INTO records(id,community_id,type,scope,state,payload,revision,revision_hash,author_id,updated_at) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,now())",
      [
        id,
        COMMUNITY_ID,
        type,
        definition.scope,
        state,
        definition.scope === "private" ? encryptPrivate(id, payload) : payload,
        hashRevision(payload),
        actor,
      ],
    );
    return id;
  }
  for (const [width, theme] of [
    [1440, "light"],
    [320, "dark"],
  ] as const) {
    await page.setViewportSize({ width, height: 1000 });
    const title = "Synthetic public resource " + width,
      resource = await insert("resources", title, "published");
    await go("resources", theme);
    await page
      .locator(".record-list li")
      .filter({ hasText: title })
      .getByRole("button")
      .click();
    await confirm("Retirar del sitio…", "Preparar retirada");
    await page
      .getByText(new RegExp("«" + title + "»: Retirada preparada"))
      .waitFor();
    const dto = await json("/records/" + resource);
    assert.equal(dto.desiredStatus, "archived");
    assert.equal(dto.withdrawalRequested, true);
    assert.equal(dto.revision, 2);
    assert.equal(dto.state, "draft");
    assert.equal(
      await page
        .getByText(/Este registro solicita retirarse del sitio/)
        .count(),
      1,
    );
    assert.equal(
      (await pool.query("SELECT count(*)::int n FROM integration_changesets"))
        .rows[0].n,
      0,
      "archive must not publish",
    );
    const person = "Synthetic archived private contact " + width,
      privateId = await insert("people", person, "archived");
    await go("people", theme);
    await page
      .locator(".record-list li")
      .filter({ hasText: person })
      .getByRole("button")
      .click();
    await confirm("Eliminar definitivamente…", "Eliminar definitivamente");
    await page
      .getByText(new RegExp("«" + person + "»: Contenido privado eliminado"))
      .waitFor();
    const erased = (
      await pool.query("SELECT state,payload FROM records WHERE id=$1", [
        privateId,
      ])
    ).rows[0];
    assert.equal(erased.state, "deleted");
    assert.equal(erased.payload.encrypted, undefined);
    const svc = new JobsService({ pool }),
      source = {
        id: "browser-" + width,
        adapter: "greenhouse" as const,
        boardIdentifier: "synthetic" + width,
        company: "Synthetic source " + width,
        enabled: true,
        schedule: { enabled: true, intervalHours: 24 },
      };
    await svc.save(COMMUNITY_ID, actor, source.id, source);
    await go("job-sources", theme);
    await page
      .locator(".jobs-manager-list button")
      .filter({ hasText: source.company })
      .click();
    await confirm("Retirar fuente…", "Retirar fuente");
    await page.getByText(/Fuente retirada: no se habilitan/).waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Recolectar ahora", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(
      (
        await pool.query("SELECT config FROM job_sources WHERE id=$1", [
          source.id,
        ])
      ).rows[0].config._retired !== undefined,
      true,
    );
    const normalized = normalizeJob(
      {
        id: "1",
        title: "Platform Engineer synthetic " + width,
        location: { name: "Peru" },
        absolute_url: "https://example.org/jobs/" + width,
      },
      source,
      new Date(),
    );
    const baseline = publicJobs([
      {
        ...normalized,
        approved: true,
        status: "active",
        summary: {
          "es-pe": "Resumen técnico revisado",
          en: "Reviewed technical summary",
        },
      },
    ])[0];
    assert.ok(baseline);
    await pool.query(
      "INSERT INTO job_records(id,community_id,source_id,payload) VALUES($1,$2,$3,$4)",
      [
        normalized.id,
        COMMUNITY_ID,
        source.id,
        {
          ...normalized,
          status: "excluded",
          approved: false,
          baseEntityHash: hashRevision(baseline),
          sourceClosed: false,
        },
      ],
    );
    await go("job-exclusions", theme);
    await page
      .locator(".jobs-manager-list button")
      .filter({ hasText: normalized.title })
      .click();
    await confirm("Retirar del sitio…", "Preparar retirada");
    await page
      .getByText(new RegExp("«" + normalized.title + "»: Retirada preparada"))
      .waitFor();
    const withdrawn = (
      await pool.query("SELECT payload FROM job_records WHERE id=$1", [
        normalized.id,
      ])
    ).rows[0].payload;
    assert.equal(withdrawn.sourceClosed, false);
    assert.equal(withdrawn.closureReason, "curator-withdrawn");
    assert.equal(withdrawn.status, "closed");
    await page.getByText(/Retirada editorial solicitada/).waitFor();
    const pub = randomUUID();
    await pool.query(
      "INSERT INTO integration_publications(id,community_id,author_id,channel,destination,payload,revision_hash,state) VALUES($1,$2,$3,'youtube','synthetic-channel',$4,'synthetic-hash','scheduled')",
      [
        pub,
        COMMUNITY_ID,
        actor,
        {
          title: "Synthetic pending video " + width,
          description: "Synthetic only",
          media: [],
          desiredVisibility: "private",
          recordingConsent: false,
        },
      ],
    );
    await go("youtube", theme);
    await page
      .locator("#publication-list button")
      .filter({ hasText: "Synthetic pending video " + width })
      .click();
    await confirm("Cancelar trabajo pendiente…", "Cancelar trabajo pendiente");
    await page.getByText(/Trabajo pendiente cancelado/).waitFor();
    const cancelled = await json("/publications/" + pub);
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.version, 2);
    if (width === 320) {
      const image = randomUUID(),
        sha = "f".repeat(64),
        key = `${COMMUNITY_ID}/derived/${sha}.webp`,
        blockedPath = resolve(process.env.PRIVATE_STORAGE_DIR!, key);
      await mkdir(blockedPath, { recursive: true });
      await pool.query(
        "INSERT INTO media_assets(id,community_id,uploader_id,path,sha256,width,height,mime,bytes,storage_key,storage_backend,original_name,rights) VALUES($1,$2,$3,$4,$5,1,1,'image/webp',9,$6,'local','synthetic-cleanup.webp','{}')",
        [
          image,
          COMMUNITY_ID,
          actor,
          `media/${sha.slice(0, 16)}/image.webp`,
          sha,
          key,
        ],
      );
      const name = "Synthetic media manager";
      await insert("organizers", name, "draft");
      await go("organizers", theme);
      await page
        .locator(".record-list li")
        .filter({ hasText: name })
        .getByRole("button")
        .click();
      await page
        .locator(".editor-section-nav button")
        .filter({ hasText: "Medios" })
        .click();
      await page.locator(".picker-browser summary").first().click();
      await page
        .getByRole("button", { name: /Ver uso y acciones de/ })
        .first()
        .click();
      const management = page.getByRole("region", {
        name: "Gestión del archivo seleccionado",
      });
      await management.locator(".lifecycle-actions summary").click();
      await confirm("Eliminar archivo sin uso…", "Eliminar archivo sin uso");
      await page
        .getByText(
          /La referencia se retiró, pero la limpieza de bytes sigue pendiente/,
        )
        .waitFor();
      const pending = (await json("/media")).find((m: any) => m.id === image);
      assert.equal(pending.cleanupPending, true);
      assert.equal(
        await page.locator(`select option[value="${image}"]`).count(),
        0,
      );
      await page.screenshot({
        path: resolve(artifacts, "real-pg-image-pending-320-dark.png"),
        fullPage: true,
      });
      await page.reload();
      await page
        .locator(".record-list li")
        .filter({ hasText: name })
        .getByRole("button")
        .click();
      await page
        .locator(".editor-section-nav button")
        .filter({ hasText: "Medios" })
        .click();
      await page.locator(".picker-browser summary").first().click();
      await page
        .getByRole("button", { name: /Ver uso y acciones de/ })
        .first()
        .click();
      await page
        .getByRole("region", { name: "Gestión del archivo seleccionado" })
        .locator(".lifecycle-actions summary")
        .click();
      assert.equal(
        await page.locator(`select option[value="${image}"]`).count(),
        0,
      );
      await rm(blockedPath, { recursive: true, force: true });
      await confirm("Eliminar archivo sin uso…", "Eliminar archivo sin uso");
      await page
        .getByText(/Archivo propio retirado del almacenamiento/)
        .waitFor();
      assert.equal(
        (await json("/media")).some((m: any) => m.id === image),
        false,
      );
    }
    await page.screenshot({
      path: resolve(artifacts, `real-pg-lifecycle-${width}-${theme}.png`),
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS exact built client actual isolatedPG/cookie/Origin/CSRF public desiredStatus+pendingwithdrawal updatedrevision callback, privateerase, terminalsource, excludedjobwithdraw source-open, version/hash queuedcancel;1440light320dark;zero provider/main effects",
  );
} catch (error) {
  console.error(
    "BROWSER DEBUG",
    page.url(),
    errors,
    (await page.locator("body").innerText()).slice(0, 4500),
  );
  await page.screenshot({
    path: resolve(artifacts, "failure.png"),
    fullPage: true,
  });
  throw error;
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
  await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await pool.end();
  await rm(temporary, { recursive: true, force: true });
}
