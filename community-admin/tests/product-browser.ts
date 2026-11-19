/** Isolated product acceptance: real PostgreSQL and HTTP, no live providers. */
import assert from "node:assert/strict";
import { workspaces } from "../src/web/navigation";
import { randomUUID, createHash } from "node:crypto";
import { hashFile } from "../src/web/file-hash";
import { localTimeToInstant } from "../src/web/schedule";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import express from "express";
import { chromium } from "playwright";
import { createPool, migrate, COMMUNITY_ID } from "../src/server/db";
import { createApp } from "../src/server/app";
import { verifySeedMedia } from "../src/server/media";
if (!process.env.DATABASE_URL)
  throw new Error(
    "DATABASE_URL is required for isolated product browser checks.",
  );
const suffix = randomUUID().replaceAll("-", "");
const schemaName = `test_product_${suffix}`;
const temporary = resolve(".local", schemaName);
process.env.PRIVATE_KEY_DIR = resolve(temporary, "keys");
process.env.PRIVATE_STORAGE_DIR = resolve(temporary, "storage");
const pool = createPool(process.env.DATABASE_URL, schemaName);
const server = createServer();
const originalFetch = globalThis.fetch;
const oauthEnvironment = {
  clientId: process.env.GITHUB_OAUTH_CLIENT_ID,
  clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
  owner: process.env.GITHUB_OWNER_SUBJECT,
};
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHANNEL
    ? { channel: process.env.PLAYWRIGHT_CHANNEL }
    : {}),
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: "reduce",
});
page.setDefaultTimeout(20000);
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
await mkdir(".local/qa", { recursive: true });
try {
  for (const size of [0, 3, 55, 56, 63, 64, 65, 1024 * 1024 + 13]) {
    const bytes = Buffer.alloc(size, 97);
    assert.equal(
      await hashFile(new Blob([bytes])),
      createHash("sha256").update(bytes).digest("hex"),
      "Streaming video checksum matches Node SHA-256 at block boundaries",
    );
  }
  assert.equal(
    localTimeToInstant("2026-11-08T14:30", "America/Lima"),
    "2026-11-08T19:30:00.000Z",
  );
  assert.throws(
    () => localTimeToInstant("2026-03-08T02:30", "America/New_York"),
    /no existe/,
  );
  assert.throws(
    () => localTimeToInstant("2026-11-01T01:30", "America/New_York"),
    /se repite/,
  );
  assert.throws(
    () => localTimeToInstant("2026-04-05T01:45", "Australia/Lord_Howe"),
    /se repite/,
  );
  assert.throws(
    () => localTimeToInstant("2026-10-04T02:15", "Australia/Lord_Howe"),
    /no existe/,
  );
  assert.equal(
    localTimeToInstant("2026-04-05T02:15", "Australia/Lord_Howe"),
    "2026-04-04T15:45:00.000Z",
  );
  await migrate(pool, schemaName);
  const media = await verifySeedMedia();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  // Mock only provider HTTP responses; the local callback/session/invitation checks stay real.
  process.env.GITHUB_OAUTH_CLIENT_ID = "isolated-fixture-client";
  process.env.GITHUB_OAUTH_CLIENT_SECRET = "isolated-fixture-secret";
  process.env.GITHUB_OWNER_SUBJECT = "999999999999999";
  globalThis.fetch = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url === "https://github.com/login/oauth/access_token")
      return Response.json({ access_token: "isolated-provider-token" });
    if (url === "https://api.github.com/user")
      return Response.json({
        id: 987654321,
        login: "uninvited-isolated-fixture",
        name: "Uninvited fixture",
      });
    throw new Error(
      "Unexpected external provider request in isolated product acceptance.",
    );
  };
  const app = createApp({
    pool,
    media,
    origin,
    fixtureAuthEnabled: true,
    environment: "test",
  });
  app.use(express.static(resolve(process.env.PRODUCT_WEB_DIST ?? "dist/web")));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(
      resolve(process.env.PRODUCT_WEB_DIST ?? "dist/web", "index.html"),
      { dotfiles: "allow" },
    ),
  );
  server.on("request", app);
  async function login(name: string) {
    await page.goto(origin);
    await page.locator(".admin-shell,.personas").first().waitFor();
    const account = page.locator(".shell-session summary");
    if (await account.count()) {
      await account.click();
      await page
        .getByRole("button", { name: "Cambiar cuenta", exact: true })
        .click();
    }
    await page
      .getByRole("button", { name: new RegExp(`Entrar como ${name}`) })
      .click();
    await page.locator(".admin-shell").waitFor({ state: "attached" });
  }
  async function json(path: string) {
    const response = await page.request.get(origin + "/api" + path);
    assert.equal(response.status(), 200, await response.text());
    return response.json();
  }
  async function mutate(
    path: string,
    data: any,
    method = "POST",
    revision?: number,
  ) {
    const me = await json("/me");
    const response = await page.request.fetch(origin + "/api" + path, {
      method,
      headers: {
        Origin: origin,
        "X-CSRF-Token": me.csrfToken,
        "Idempotency-Key": randomUUID(),
        ...(revision ? { "If-Match": `"${revision}"` } : {}),
      },
      data,
    });
    assert.ok(
      response.ok(),
      `${path}: ${response.status()} ${await response.text()}`,
    );
    return response.json();
  }
  async function nav(label: string) {
    await page
      .getByRole("button", { name: "Buscar sección", exact: true })
      .click();
    await page.getByRole("dialog").getByRole("searchbox").fill(label);
    await page
      .locator(".shell-search-result")
      .filter({ has: page.getByText(label, { exact: true }) })
      .first()
      .click();
  }
  async function editorPane(id: string) {
    const name: Record<string, string> = {
      info: "Información",
      content: "Contenido",
      relationships: "Relaciones",
      media: "Medios",
      review: "Revisión",
      history: "Historial",
    };
    await page
      .getByRole("navigation", { name: "Secciones del editor" })
      .getByRole("button", { name: new RegExp(name[id]) })
      .click();
  }
  async function fillField(label: string, value: string, exact = true) {
    const input = page.getByLabel(label, { exact }).first();
    const pane = await input.evaluate((el) =>
      el.closest("[data-editor-pane]")?.getAttribute("data-editor-pane"),
    );
    if (pane) await editorPane(pane);
    const disclosure = input.locator("xpath=ancestor::details[1]");
    if (
      (await disclosure.count()) &&
      !((await disclosure.getAttribute("open")) !== null)
    )
      await disclosure.locator("summary").first().click();
    await input.fill(value);
  }
  // First mobile navigation must survive a lazily loaded destination.
  const freshContext = await browser.newContext({
    viewport: { width: 320, height: 844 },
    reducedMotion: "no-preference",
  });
  const freshPage = await freshContext.newPage();
  await freshPage.route("**/assets/product-*.js", async (route) => {
    await new Promise((done) => setTimeout(done, 500));
    await route.continue();
  });
  await freshPage.goto(origin);
  await freshPage
    .getByRole("button", { name: /Entrar como propietario/ })
    .click();
  await freshPage
    .getByRole("button", { name: "Buscar sección", exact: true })
    .click();
  await freshPage.getByRole("dialog").getByRole("searchbox").fill("Resumen");
  await freshPage
    .locator(".shell-search-result")
    .filter({ hasText: "Resumen" })
    .first()
    .click();
  await freshPage.waitForFunction(
    () => document.getElementById("main-content") === document.activeElement,
  );
  await freshContext.close();
  await login("propietario");
  // Redesign contract: every destination remains reachable, searchable, and readable.
  const destinations = workspaces.flatMap((w) => w.items.map((i) => i.label));
  for (const label of destinations) {
    await nav(label);
    await page.locator("main h1").waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      label,
    );
  }
  await page
    .getByRole("button", { name: "Buscar sección", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("searchbox").fill("publicos");
  assert.equal(await page.locator(".shell-search-result").count(), 1);
  await page
    .getByRole("dialog")
    .getByRole("searchbox")
    .fill("unfindable-section");
  assert.equal(await page.locator(".shell-search-result").count(), 0);
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 0);
  const catalog = await json("/catalog");
  const defaults = (type: string) =>
    structuredClone(
      catalog.entities.find((d: any) => d.type === type).defaults,
    );
  // Memories support multiple complete images and real private image upload with rights metadata.
  await nav("Memories");
  await page
    .getByRole("button", { name: "Nuevo registro", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Enviar a revisión", exact: true })
    .click();
  await page.locator('[id="field-title.en"][aria-invalid="true"]').waitFor();
  assert.ok(
    await page
      .getByLabel("Título (inglés)", { exact: true })
      .getAttribute("aria-describedby"),
  );
  await page
    .getByRole("button", { name: "Español", exact: true })
    .first()
    .click();
  await editorPane("content");
  await page.locator('.alert.error a[href="#field-title.en"]').click();
  await page.locator('[id="field-title.en"]').waitFor({ state: "visible" });
  await page.waitForFunction(
    () => document.activeElement?.id === "field-title.en",
  );
  assert.equal(
    await page
      .locator('[id="field-title.en"]')
      .evaluate((el) => el === document.activeElement),
    true,
    "Hidden English error reveals its editor section and focuses the control",
  );
  await fillField(
    "Título (español)",
    "Recuerdo de prueba con dos imágenes",
    true,
  );
  assert.equal(
    await page.locator("#record-list").isVisible(),
    false,
    "Creating a record enters a focused editor instead of offering duplicate creation",
  );
  await fillField("Título (inglés)", "Two-image test memory", true);
  await fillField(
    "Descripción (español)",
    "Prueba aislada de imagen vertical y horizontal.",
    true,
  );
  await fillField(
    "Descripción (inglés)",
    "Isolated portrait and landscape test.",
    true,
  );
  await fillField("Slug", "browser-two-image-memory", true);
  await editorPane("media");
  await page
    .getByRole("button", { name: "Añadir imagen", exact: true })
    .click();
  await page.getByLabel("Imagen 1", { exact: true }).selectOption(media[0].id);
  await page
    .getByRole("button", { name: "Añadir imagen", exact: true })
    .click();
  await page.getByLabel("Imagen 2", { exact: true }).selectOption(media[1].id);
  for (let i = 0; i < 2; i++) {
    await page
      .getByLabel("Texto alternativo (español)", { exact: true })
      .nth(i)
      .fill(`Imagen sintética ${i + 1}.`);
    await page
      .getByLabel("Texto alternativo (inglés)", { exact: true })
      .nth(i)
      .fill(`Synthetic image ${i + 1}.`);
  }
  await page
    .getByRole("button", { name: "Guardar revisión", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Revisión guardada" })
    .waitFor();
  const memories = await json("/records?type=memories");
  const memory = memories.items.find(
    (r: any) => r.payload.slug === "browser-two-image-memory",
  );
  assert.equal(memory.payload.media.length, 2);
  assert.equal(memory.payload.media[0].assetId, media[0].id);
  assert.equal(memory.payload.media[1].assetId, media[1].id);
  await page.getByText("Subir una imagen", { exact: true }).click();
  await fillField(
    "Procedencia de la imagen",
    "Synthetic browser fixture",
    true,
  );
  await fillField(
    "Base de permiso para publicar",
    "Synthetic local acceptance asset",
    true,
  );
  await page
    .getByLabel("Archivo de imagen", { exact: true })
    .setInputFiles(resolve("public", media[0].path));
  await page
    .getByRole("status")
    .filter({ hasText: "Imagen verificada" })
    .waitFor();
  const inventory = await json("/media");
  assert.ok(inventory.length > media.length);
  assert.equal(
    await page.locator(".media-picker > section > img.media-thumb").count(),
    2,
  );
  // A course edited through the UI persists through reload and loses approval after changes.
  await page.screenshot({
    path: ".local/qa/redesign-memory-desktop.png",
    fullPage: false,
  });
  for (const width of [375, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      `Editor overflow at ${width}`,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Buscar sección", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("searchbox").fill("cursos");
  await page
    .getByRole("button", { name: "Cerrar búsqueda", exact: true })
    .click();
  await page.locator(".back-to-records").first().click();
  await page.locator(".record-list li button").first().click();
  await page.waitForFunction(
    () => document.getElementById("record-editor") === document.activeElement,
  );
  await page.locator(".record-editor .back-to-records").click();
  await page.screenshot({
    path: ".local/qa/redesign-memory-mobile.png",
    fullPage: false,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await nav("Cursos");
  await page
    .getByRole("button", { name: "Nuevo registro", exact: true })
    .click();
  await fillField("Título (español)", "Curso de prueba de plataforma", true);
  await fillField("Título (inglés)", "Platform test course", true);
  await fillField(
    "Descripción (español)",
    "Curso sintético para la prueba aislada.",
    true,
  );
  await fillField(
    "Descripción (inglés)",
    "Synthetic course for isolated acceptance.",
    true,
  );
  await fillField("URL", "https://example.org/product-course", false);
  await fillField("Slug", "product-test-course", true);
  await fillField("Proveedor", "Proveedor de prueba", true);
  await editorPane("info");
  const tagsInput = page.getByLabel("Etiquetas", { exact: false });
  await tagsInput.pressSequentially("platform, kubernetes", { delay: 10 });
  assert.equal(
    await tagsInput.inputValue(),
    "platform, kubernetes",
    "Typing a comma must preserve the separator while entering multiple tags",
  );
  // Complex-field validation stays beside the input and preserves the unfinished form.
  let rejectTagsOnce = true;
  const rejectTags = async (route: import("playwright").Route) => {
    if (route.request().method() === "PATCH" && rejectTagsOnce) {
      rejectTagsOnce = false;
      await route.fulfill({
        status: 422,
        json: {
          code: "VALIDATION_FAILED",
          message: "Revisa las etiquetas.",
          fieldErrors: [
            { path: "tags", message: "Revisa los valores antes de guardar." },
          ],
        },
      });
    } else await route.continue();
  };
  await page.route("**/api/records/*", rejectTags);
  await page
    .getByRole("button", { name: "Guardar revisión", exact: true })
    .click();
  await page.locator('[id="field-tags"][aria-invalid="true"]').waitFor();
  assert.equal(
    await page.locator("#field-tags").getAttribute("aria-describedby"),
    "field-errors-tags",
  );
  await page.locator(".alert.error a").filter({ hasText: "Etiquetas" }).click();
  assert.equal(
    await page
      .locator("#field-tags")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.unroute("**/api/records/*", rejectTags);
  await tagsInput.fill("platform, kubernetes, retry");
  await tagsInput.fill("platform, kubernetes");
  await page
    .getByRole("button", { name: "Guardar revisión", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Revisión guardada" })
    .waitFor();
  const courses = await json("/records?type=courses");
  const course = courses.items.find(
    (r: any) => r.payload.slug === "product-test-course",
  );
  assert.ok(course);
  assert.equal(course.payload.provider, "Proveedor de prueba");
  assert.deepEqual(course.payload.tags, ["platform", "kubernetes"]);
  assert.equal(course.payload.priceModel, "unknown");
  await fillField("Proveedor", "Proveedor actualizado con autosave", true);
  await page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/records/${course.id}`) &&
      r.request().method() === "PATCH" &&
      r.status() === 200,
  );
  assert.equal(
    (await json(`/records/${course.id}`)).payload.provider,
    "Proveedor actualizado con autosave",
  );
  // Organizer identity keeps distinct photo/figurine references when name and order change.
  const organizer = await mutate("/records", {
    type: "organizers",
    payload: {
      ...defaults("organizers"),
      slug: "organizer-test",
      name: "Organizador de prueba",
      photoAssetId: media[0].id,
      figurineAssetId: media[1].id,
      displayOrder: 20,
    },
  });
  await nav("Organizadores");
  await page
    .locator(".record-list button")
    .filter({ hasText: "Organizador de prueba" })
    .click();
  await fillField("Nombre", "Identidad editada", true);
  await fillField("Orden editorial", "1", true);
  await page
    .getByRole("button", { name: "Guardar revisión", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Revisión guardada" })
    .waitFor();
  const changed = await json(`/records/${organizer.id}`);
  assert.equal(changed.id, organizer.id);
  assert.equal(changed.payload.photoAssetId, media[0].id);
  assert.equal(changed.payload.figurineAssetId, media[1].id);
  assert.equal(await page.locator(".reference-field > img").count(), 2);
  const recordingEvent = await mutate("/records", {
    type: "events",
    payload: {
      ...defaults("events"),
      slug: "recording-event-fixture",
      title: {
        "es-pe": "Evento de grabación de prueba",
        en: "Recording test event",
      },
      description: { "es-pe": "Prueba aislada.", en: "Isolated test." },
      city: { "es-pe": "Lima", en: "Lima" },
      date: "2026-11-09",
    },
  });
  await mutate(
    `/records/${recordingEvent.id}/submit`,
    {},
    "POST",
    recordingEvent.revision,
  );
  // A private contact creates only an explicit safe public speaker projection.
  const person = await mutate("/records", {
    type: "people",
    payload: {
      ...defaults("people"),
      name: "Contacto privado de prueba",
      email: "private@example.org",
      phone: "+510000000",
      notes: "PRIVATE_SENTINEL",
      provenance: "isolated test",
      permissionBasis: "synthetic fixture",
    },
  });
  const profile = await mutate("/records", {
    type: "speaker-profiles",
    payload: {
      ...defaults("speaker-profiles"),
      personId: person.id,
      publicBio: {
        "es-pe": "Biografía pública autorizada.",
        en: "Approved public biography.",
      },
      publicConsent: true,
      consentEvidence: "Synthetic test consent",
    },
  });
  await nav("Ponentes privados");
  await page
    .locator(".record-list button")
    .filter({ hasText: profile.id })
    .click();
  await page
    .getByRole("navigation", { name: "Secciones del editor" })
    .getByRole("button", { name: /Proyección pública/ })
    .click();
  await page
    .getByRole("button", {
      name: "Crear borrador público autorizado",
      exact: true,
    })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Perfil público creado" })
    .waitFor();
  const speakers = await json("/records?type=speakers");
  const speaker = speakers.items.find(
    (r: any) => r.payload.name === "Contacto privado de prueba",
  );
  assert.ok(speaker);
  assert.ok(
    !/PRIVATE_SENTINEL|private@example.org|\+510000000/.test(
      JSON.stringify(speaker.payload),
    ),
  );
  // CSV column mapping, duplicate preview and formula-safe private export.
  await nav("Contactos");
  await page.getByRole("button", { name: "Importar CSV", exact: true }).click();
  await page
    .getByLabel("Contenido CSV", { exact: true })
    .fill(
      "Nombre,Correo,Origen,Permiso\n=1+1,formula@example.org,isolated fixture,synthetic test\nDuplicate,formula@example.org,isolated fixture,synthetic test",
    );
  for (const [label, column] of [
    ["nombre", "Nombre"],
    ["correo", "Correo"],
    ["procedencia", "Origen"],
    ["base de permiso", "Permiso"],
  ])
    await page
      .getByLabel(`Columna para ${label}`, { exact: true })
      .selectOption({ label: column });
  await page
    .getByRole("button", { name: "Previsualizar importación", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Importar filas válidas", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Importar filas válidas", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Importación procesada" })
    .waitFor();
  const imported = (await json("/records?type=people")).items.filter(
    (r: any) => r.payload.email === "formula@example.org",
  );
  assert.equal(imported.length, 1);
  await fillField(
    "Motivo de la exportación privada",
    "Isolated browser acceptance export.",
    true,
  );
  const [csvDownload] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("button", { name: "Exportar CSV privado", exact: true })
      .click(),
  ]);
  const csvStream = await csvDownload.createReadStream();
  assert.ok(csvStream);
  const csvChunks: Buffer[] = [];
  for await (const chunk of csvStream) csvChunks.push(chunk as Buffer);
  assert.ok(
    Buffer.concat(csvChunks).toString().includes("'=1+1"),
    "Private CSV neutralizes spreadsheet formula prefixes",
  );
  await mutate(`/records/${speaker.id}/submit`, {}, "POST", speaker.revision);
  await login("revisor");
  await nav("Ponentes públicos");
  await page
    .locator(".record-list button")
    .filter({ hasText: "Contacto privado de prueba" })
    .click();
  await editorPane("review");
  await page
    .getByRole("button", {
      name: `Aprobar revisión ${speaker.revision}`,
      exact: true,
    })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Decisión registrada" })
    .waitFor();
  await mutate(
    `/records/${recordingEvent.id}/review`,
    {
      decision: "approved",
      revisionHash: recordingEvent.revisionHash,
      comment: "Synthetic event approval.",
    },
    "POST",
    recordingEvent.revision,
  );
  const publicSpeaker = await json(`/records/${speaker.id}/export`);
  assert.ok(
    !/email|phone|notes|PRIVATE_SENTINEL/.test(JSON.stringify(publicSpeaker)),
  );
  // Transparent jobs review uses only a synthetic fixture in this disposable schema.
  const jobId = "greenhouse:browser-fixture:1";
  await pool.query(
    "INSERT INTO job_records(id,community_id,source_id,payload) VALUES($1,$2,$3,$4)",
    [
      jobId,
      COMMUNITY_ID,
      "browser-fixture",
      {
        id: jobId,
        schemaVersion: 1,
        slug: "browser-fixture-1",
        sourceId: "browser-fixture",
        externalId: "1",
        contentLanguage: "en",
        workplace: "remote",
        locations: ["Remote Peru"],
        sourceExcerpt:
          "Synthetic source explicitly accepts applicants located in Peru for remote work.",
        seniority: null,
        salary: null,
        tags: [],
        sourcePublishedAt: null,
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        expiresAt: null,
        closureReason: null,
        evidenceRunId: null,
        title: "Platform Engineer — isolated fixture",
        company: "Synthetic test employer",
        status: "candidate",
        eligibility: "remote-peru",
        relevanceScore: 6,
        sourceUrl: "https://example.org/test-job",
        applyUrl: "https://example.org/test-job",
        summary: { "es-pe": "Prueba aislada.", en: "Isolated test." },
        lastVerifiedAt: new Date().toISOString(),
      },
    ],
  );
  await login("curador de oportunidades");
  await nav("Vacantes por revisar");
  await page
    .locator(".jobs-manager-list button")
    .filter({ hasText: "Platform Engineer — isolated fixture" })
    .click();
  await page.screenshot({
    path: ".local/qa/replacement-jobs-review-desktop-light.png",
    fullPage: false,
  });
  await page.getByLabel("Elegibilidad para Perú").selectOption("remote-peru");
  await page
    .getByLabel("Motivo y evidencia")
    .fill("Confirmed Peru eligibility in synthetic source fixture.");
  await page
    .getByLabel("Resumen revisado (español)", { exact: true })
    .fill(
      "Rol de plataforma revisado, elegible para Perú en esta prueba sintética.",
    );
  await fillField(
    "Resumen revisado (inglés)",
    "Reviewed platform role eligible for Peru in this synthetic test.",
    true,
  );
  await page
    .getByRole("button", { name: "Aprobar oportunidad", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Decisión guardada" })
    .waitFor();
  await nav("Activas");
  await page
    .locator(".jobs-manager-list button")
    .filter({ hasText: "Platform Engineer — isolated fixture" })
    .waitFor();
  await login("propietario");
  await nav("Activas");
  await page
    .locator(".jobs-manager-list button")
    .filter({ hasText: "Platform Engineer — isolated fixture" })
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
    "unconfigured website never presents local export as publication",
  );
  // Unconfigured publication must fail before creating any immutable remote intent.
  const beforeJobIntents = (await json("/changesets")).items.length;
  const publicationUser = await json("/me");
  const blockedPublication = await page.request.post(
    origin + "/api/jobs/changeset",
    {
      headers: {
        Origin: origin,
        "X-CSRF-Token": publicationUser.csrfToken,
        "Idempotency-Key": randomUUID(),
      },
      data: {
        jobIds: [jobId],
        expectedVersions: {
          [jobId]: (await json("/jobs/candidates?state=active")).items.find(
            (r: any) => r.id === jobId,
          ).version,
        },
      },
    },
  );
  assert.equal(
    blockedPublication.status(),
    503,
    await blockedPublication.text(),
  );
  assert.equal(
    (await blockedPublication.json()).code,
    "JOBS_PUBLICATION_UNCONFIGURED",
  );
  assert.equal((await json("/changesets")).items.length, beforeJobIntents);
  // Independent social approval is invalidated by a changed payload.
  await login("publicador");
  await nav("LinkedIn");
  await page
    .getByRole("button", { name: "Nueva publicación", exact: true })
    .click();
  await page
    .getByLabel("Cuenta de destino")
    .fill("urn:li:organization:fixture");
  await page
    .getByLabel("Texto de la publicación")
    .fill("Texto de prueba local.");
  await page
    .getByRole("button", { name: "Guardar borrador", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Borrador guardado" })
    .waitFor();
  const publication = (await json("/publications")).items.find(
    (p: any) => p.payload.text === "Texto de prueba local.",
  );
  assert.ok(publication);
  assert.equal(
    await page.getByLabel("Canal", { exact: false }).isDisabled(),
    true,
    "Existing publication channel cannot be silently changed",
  );
  await login("revisor");
  await nav("LinkedIn");
  await page
    .locator(".operation-list button")
    .filter({ hasText: "Texto de prueba local." })
    .click();
  await page
    .getByRole("button", { name: "Aprobar publicación", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Acción registrada" })
    .waitFor();
  await login("publicador");
  await nav("LinkedIn");
  await page
    .locator(".operation-list button")
    .filter({ hasText: "Texto de prueba local." })
    .click();
  await page
    .getByLabel("Texto de la publicación")
    .fill("Texto revisado después de aprobar.");
  await page
    .getByRole("button", { name: "Guardar borrador", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Borrador guardado" })
    .waitFor();
  const revised = await json(`/publications/${publication.id}`);
  assert.equal(revised.approved_hash, null);
  assert.equal(revised.state, "draft");
  // Private video staging recovers a failed second chunk without duplicating the asset.
  await nav("YouTube");
  await page
    .getByRole("button", { name: "Nueva publicación", exact: true })
    .click();
  await page.getByLabel("Cuenta de destino").fill("isolated-test-channel");
  await page
    .getByRole("combobox", { name: "Evento relacionado", exact: true })
    .selectOption(recordingEvent.id);
  await fillField(
    "Video existente (URL)",
    "https://www.youtube.com/watch?v=fixture1234",
    true,
  );
  await page
    .getByLabel("Título del video")
    .fill("Video sintético de aceptación");
  await page
    .getByLabel("Descripción de YouTube")
    .fill("Synthetic local fixture; never sent to YouTube.");
  await page.getByLabel("Permiso de grabación registrado").check();
  await page
    .getByRole("button", { name: "Guardar borrador", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Borrador guardado" })
    .waitFor();
  const videoBytes = Buffer.alloc(8 * 1024 * 1024 + 32);
  videoBytes.write("ftyp", 4);
  let interrupted = false;
  await page.route("**/api/video/uploads/*/parts/2", async (route) => {
    if (!interrupted && route.request().method() === "PUT") {
      interrupted = true;
      await route.abort("failed");
    } else await route.continue();
  });
  const videoFile = {
    name: "isolated-browser-fixture.mp4",
    mimeType: "video/mp4",
    buffer: videoBytes,
  };
  await page.getByLabel("Archivo de video privado").setInputFiles(videoFile);
  await page
    .getByRole("alert")
    .filter({ hasText: /Failed to fetch|No se pudo transferir|fetch/i })
    .waitFor();
  assert.equal(interrupted, true);
  await page.getByLabel("Archivo de video privado").setInputFiles([]);
  await page.getByLabel("Archivo de video privado").setInputFiles(videoFile);
  await page
    .getByRole("status")
    .filter({ hasText: "Video verificado en almacenamiento privado" })
    .first()
    .waitFor();
  await page
    .getByRole("button", { name: "Guardar borrador", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Borrador guardado" })
    .waitFor();
  const videoPublication = (
    await json("/publications?channel=youtube")
  ).items.find((p: any) => p.payload.title === "Video sintético de aceptación");
  assert.equal(videoPublication.payload.bytes, videoBytes.length);
  assert.ok(videoPublication.payload.assetId);
  const staged = (
    await pool.query(
      "SELECT * FROM integration_video_assets WHERE community_id=$1",
      [COMMUNITY_ID],
    )
  ).rows;
  assert.equal(
    staged.length,
    1,
    "Resuming reuses the same private staged asset",
  );
  assert.equal(staged[0].state, "verified");
  assert.equal(
    staged[0].sha256,
    createHash("sha256").update(videoBytes).digest("hex"),
  );
  assert.equal(videoPublication.state, "draft");
  assert.equal(videoPublication.approved_hash, null);
  await rm(resolve(".local/video", videoPublication.payload.assetId), {
    recursive: true,
    force: true,
  });
  // An expired checkpoint is recoverable through an explicit fresh transfer.
  const retryBytes = Buffer.from(videoBytes);
  retryBytes.write("retry-fixture", 16);
  const retryFile = {
    name: "expired-checkpoint-fixture.mp4",
    mimeType: "video/mp4",
    buffer: retryBytes,
  };
  interrupted = false;
  const retryHash = createHash("sha256").update(retryBytes).digest("hex");
  await page.evaluate(
    (key) => localStorage.setItem(key, "legacy unscoped checkpoint"),
    `video-upload:${retryHash}`,
  );
  await page.getByLabel("Archivo de video privado").setInputFiles(retryFile);
  await page
    .getByRole("alert")
    .filter({ hasText: /Failed to fetch|No se pudo transferir|fetch/i })
    .waitFor();

  const stale = (
    await pool.query(
      "SELECT * FROM integration_video_assets WHERE community_id=$1 AND sha256=$2",
      [COMMUNITY_ID, retryHash],
    )
  ).rows[0];
  assert.ok(stale);
  const actor = await json("/me");
  const checkpointKeys = await page.evaluate(() =>
    Object.keys(localStorage).filter((key) => key.startsWith("video-upload:")),
  );
  assert.deepEqual(checkpointKeys, [
    `video-upload:v2:${encodeURIComponent(origin)}:${actor.communityId}:${actor.id}:${retryHash}`,
  ]);
  await pool.query(
    "UPDATE integration_video_assets SET expires_at=now()-interval '1 minute' WHERE id=$1",
    [stale.id],
  );
  await page.getByLabel("Archivo de video privado").setInputFiles([]);
  const expiredResponse = page.waitForResponse(
    (response) =>
      response.url().includes(`/video/uploads/${stale.id}/parts`) &&
      response.status() >= 400,
  );
  await page.getByLabel("Archivo de video privado").setInputFiles(retryFile);
  await expiredResponse;
  await page
    .getByRole("button", { name: "Reiniciar transferencia", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Video verificado en almacenamiento privado" })
    .first()
    .waitFor();
  await page
    .getByRole("button", { name: "Guardar borrador", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Borrador guardado" })
    .waitFor();
  const replacements = (
    await pool.query(
      "SELECT * FROM integration_video_assets WHERE community_id=$1 AND sha256=$2 ORDER BY created_at",
      [COMMUNITY_ID, retryHash],
    )
  ).rows;
  assert.equal(replacements.length, 2);
  assert.equal(replacements[1].state, "verified");
  assert.notEqual(replacements[1].id, stale.id);
  assert.deepEqual(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) =>
        key.startsWith("video-upload:"),
      ),
    ),
    [],
  );
  for (const asset of replacements)
    await rm(resolve(".local/video", asset.id), {
      recursive: true,
      force: true,
    });
  // A confirmed manual video creates a fresh event draft, never a publication bypass.
  await login("revisor");
  await nav("YouTube");
  await page
    .locator(".operation-list button")
    .filter({ hasText: "Video sintético de aceptación" })
    .click();
  await page
    .getByRole("button", { name: "Aprobar publicación", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Acción registrada" })
    .waitFor();
  await login("propietario");
  await nav("YouTube");
  await page
    .locator(".operation-list button")
    .filter({ hasText: "Video sintético de aceptación" })
    .click();
  const socialPanel = page.getByRole("region", {
    name: "Publicación social e índice del blog",
  });
  await socialPanel
    .getByLabel("URL publicada", { exact: true })
    .fill("https://www.youtube.com/watch?v=fixture1234");
  await socialPanel
    .getByLabel("Fecha original con zona", { exact: true })
    .fill("2026-11-18T10:00:00-05:00");
  await socialPanel
    .getByLabel("Idioma original", { exact: true })
    .selectOption("en");
  for (const [label, es, en] of [
    [
      "Título del blog",
      "Video sintético de aceptación",
      "Synthetic acceptance video",
    ],
    [
      "Resumen del blog",
      "Resumen sintético revisado",
      "Reviewed synthetic excerpt",
    ],
    [
      "Contenido del blog",
      "Contenido sintético revisado",
      "Reviewed synthetic content",
    ],
  ]) {
    await socialPanel
      .getByLabel(`${label} (español)`, { exact: true })
      .fill(es);
    await socialPanel.getByLabel(`${label} (inglés)`, { exact: true }).fill(en);
  }
  await socialPanel
    .getByLabel("Confirmo que publiqué", { exact: false })
    .check();
  const confirmationResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/manual-confirm") &&
      response.request().method() === "POST",
  );
  await socialPanel
    .getByRole("button", {
      name: "Confirmar e indexar borrador de blog",
      exact: true,
    })
    .click();
  const confirmation = await confirmationResponse;
  assert.equal(confirmation.status(), 200, await confirmation.text());
  const indexed = await confirmation.json();
  assert.equal(indexed.website.state, "local");
  assert.equal(indexed.confirmationMethod, "operator-attested");
  assert.equal(
    (await json(`/publications/${indexed.publication.id}`)).state,
    "manual-published",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM social_blog_links WHERE publication_id=$1",
        [indexed.publication.id],
      )
    ).rows[0].count,
    "1",
  );
  await page
    .getByRole("heading", {
      name: "Publicación social confirmada",
      exact: true,
    })
    .waitFor();
  await page
    .getByRole("button", {
      name: "Preparar enlace de grabación para revisión",
      exact: true,
    })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Enlace de grabación preparado como borrador" })
    .waitFor();
  const recordingDraft = await json(`/records/${recordingEvent.id}`);
  assert.equal(recordingDraft.state, "draft");
  assert.equal(recordingDraft.approvedHash, null);
  assert.equal(
    recordingDraft.payload.recording,
    "https://www.youtube.com/watch?v=fixture1234",
  );
  // A failed deployment stays visibly failed even though merge has completed.
  const changesetId = randomUUID();
  await pool.query(
    "INSERT INTO integration_changesets(id,community_id,actor_id,revision_hash,files,state,pr_number,head_sha,merged_sha) VALUES($1,$2,$3,$4,$5,'deploy_failed',7,$6,$6)",
    [
      changesetId,
      COMMUNITY_ID,
      (await json("/me")).id,
      "a".repeat(64),
      JSON.stringify([]),
      "b".repeat(40),
    ],
  );
  await nav("Sitio web");
  await page.locator(`[data-changeset-id="${changesetId}"]`).click();
  await page
    .getByRole("region", { name: "Estado de publicación", exact: true })
    .getByText("El commit está guardado; falló el despliegue", { exact: true })
    .waitFor();
  await page.screenshot({
    path: ".local/qa/replacement-changeset-desktop-light.png",
    fullPage: false,
  });
  await page.screenshot({
    path: ".local/qa/product-desktop-light.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Cambiar tema", exact: true }).click();
  await page.screenshot({
    path: ".local/qa/product-desktop-dark.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  const mobileTop = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scrollY,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({
    path: ".local/qa/product-mobile-dark.png",
    fullPage: false,
  });
  await page.getByRole("button", { name: "Cambiar tema", exact: true }).click();
  await page.screenshot({
    path: ".local/qa/product-mobile-light.png",
    fullPage: false,
  });
  await page
    .getByRole("region", { name: "Estado de publicación", exact: true })
    .getByText("El commit está guardado; falló el despliegue", { exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: ".local/qa/product-mobile-deployment.png",
    fullPage: false,
  });
  const mobileMiddle = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scrollY,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  await page.evaluate(() =>
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: "instant",
    }),
  );
  await page.screenshot({
    path: ".local/qa/product-mobile-bottom.png",
    fullPage: false,
  });
  const mobileBottom = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scrollY,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  assert.equal(mobileTop.scrollY, 0);
  assert.ok(mobileMiddle.scrollY >= 0);
  assert.ok(mobileBottom.scrollY >= mobileMiddle.scrollY);
  assert.ok(
    mobileBottom.scrollY + mobileBottom.height >= mobileBottom.scrollHeight - 2,
  );
  assert.equal(mobileBottom.width, 390);
  await writeFile(
    ".local/qa/product-mobile-scroll.json",
    JSON.stringify(
      { top: mobileTop, middle: mobileMiddle, bottom: mobileBottom },
      null,
      2,
    ),
  );
  // A read-only user cannot access private contacts or mutate records.
  await login("lector");
  await nav("Contactos");
  await page
    .getByRole("alert")
    .filter({ hasText: "Tu cuenta no tiene permiso" })
    .waitFor();
  assert.equal(
    (await page.request.get(origin + "/api/records?type=people")).status(),
    403,
  );
  // An OAuth identity without an invitation is denied through the real callback and gets no session.
  const uninvitedContext = await browser.newContext();
  const uninvited = await uninvitedContext.newPage();
  const oauthState =
    randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
  await pool.query(
    "INSERT INTO oauth_states(state_hash,verifier,expires_at) VALUES($1,$2,now()+interval '10 minutes')",
    [
      createHash("sha256").update(oauthState).digest("hex"),
      "isolated-verifier",
    ],
  );
  await uninvitedContext.addCookies([
    {
      name: "ca_oauth",
      value: oauthState,
      domain: "127.0.0.1",
      path: "/api/auth",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const denied = await uninvited.goto(
    `${origin}/api/auth/github/callback?code=isolated-code&state=${oauthState}`,
  );
  assert.equal(denied?.status(), 403);
  assert.match(
    await uninvited.locator("body").innerText(),
    /INVITATION_REQUIRED/,
  );
  assert.equal(
    (await uninvitedContext.request.get(`${origin}/api/me`)).status(),
    401,
  );
  await uninvitedContext.close();
  assert.deepEqual(errors, []);
  console.log(
    "Product acceptance passed: multiimage memory/private image upload, course persistence/autosave, organizer identity, private speaker projection and reviewed safe export, CSV mapped import/dedup/formula-safe export, jobs bilingual eligibility review and fail-closed unconfigured publication, social approval invalidation, interrupted private multipart video resume and explicit expired-checkpoint restart, confirmed video recording-link draft, distinct deployment failure, viewer and uninvited OAuth denial, desktop/mobile light/dark, reduced motion and no page errors.",
  );
} catch (error) {
  await page
    .screenshot({ path: ".local/qa/product-failure.png", fullPage: true })
    .catch(() => {});
  throw error;
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries({
    GITHUB_OAUTH_CLIENT_ID: oauthEnvironment.clientId,
    GITHUB_OAUTH_CLIENT_SECRET: oauthEnvironment.clientSecret,
    GITHUB_OWNER_SUBJECT: oauthEnvironment.owner,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
  await pool.query(`DROP SCHEMA "${schemaName}" CASCADE`);
  await pool.end();
  await rm(temporary, { recursive: true, force: true });
}
