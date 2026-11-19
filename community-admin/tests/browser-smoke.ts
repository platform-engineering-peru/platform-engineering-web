import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import express from "express";
import { chromium } from "playwright";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import schema from "../contracts/memory-v1.schema.json";
import { createPool, migrate } from "../src/server/db";
import { createApp } from "../src/server/app";
import { verifySeedMedia } from "../src/server/media";
if (!process.env.DATABASE_URL)
  throw new Error("DATABASE_URL is required for isolated browser checks.");
const schemaName = `test_browser_${randomUUID().replaceAll("-", "")}`;
const pool = createPool(process.env.DATABASE_URL, schemaName);
const servers: ReturnType<typeof createServer>[] = [];
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
page.setDefaultTimeout(15000);
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile<Record<string, any>>(schema);
await mkdir(".local/qa", { recursive: true });
try {
  await migrate(pool, schemaName);
  const media = await verifySeedMedia();
  async function start(enabled: boolean) {
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const app = createApp({
      pool,
      media,
      origin,
      fixtureAuthEnabled: enabled,
      environment: "test",
    });
    app.use(
      express.static(resolve(process.env.PRODUCT_WEB_DIST ?? "dist/web")),
    );
    app.get("/{*path}", (_req, res) =>
      res.sendFile(
        resolve(process.env.PRODUCT_WEB_DIST ?? "dist/web", "index.html"),
        { dotfiles: "allow" },
      ),
    );
    server.on("request", app);
    return origin;
  }
  const origin = await start(true);
  await page.goto(origin + "/#fixture-memories");
  await page.getByRole("button", { name: /Entrar como editor/ }).click();
  await page.getByText("Un momento para compartir.", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "+ Nuevo recuerdo", exact: true })
    .click();
  await page.getByLabel("Título (español)", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Enviar a revisión", exact: true })
    .click();
  await page
    .locator(".alert.error")
    .filter({ hasText: "Completa el contenido" })
    .waitFor();
  for (const [label, value] of [
    ["Título (español)", "Encuentro sintético local"],
    ["Título (inglés)", "Local synthetic gathering"],
    [
      "Descripción (español)",
      "Una prueba local del recorrido editorial. No contiene datos reales.",
    ],
    ["Descripción (inglés)", "A local editorial workflow test. No real data."],
    [
      "Texto alternativo (español)",
      "Dos círculos sintéticos conectados sobre un fondo violeta.",
    ],
    [
      "Texto alternativo (inglés)",
      "Two connected synthetic circles on a violet background.",
    ],
    ["Slug", "synthetic-browser-memory"],
    ["Etiquetas, separadas por comas", "synthetic, local"],
  ])
    await page.getByLabel(label, { exact: true }).fill(value);
  await page
    .getByLabel("Imagen sintética verificada", { exact: true })
    .selectOption(media[1].id);
  assert.equal(
    await page
      .getByRole("button", { name: "+ Nuevo recuerdo", exact: true })
      .isDisabled(),
    true,
    "Creating another memory must not discard unsaved edits",
  );
  await page
    .getByRole("button", { name: "Guardar revisión", exact: true })
    .click();
  await page
    .locator(".alert.success")
    .filter({ hasText: "Revisión guardada" })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "+ Nuevo recuerdo", exact: true })
      .isEnabled(),
    true,
    "Creating another memory is available after saving",
  );
  assert.equal(
    await page.getByLabel("Etiquetas, separadas por comas").inputValue(),
    "synthetic, local",
  );
  const list = await (await page.request.get(`${origin}/api/drafts`)).json();
  const id = list.items[0].id;
  await page.screenshot({
    path: ".local/qa/memories-desktop-editor.png",
    fullPage: true,
  });
  // Advance the saved server version while preserving the UI's stale local form.
  const me = await (await page.request.get(`${origin}/api/me`)).json(),
    current = await (
      await page.request.get(`${origin}/api/drafts/${id}`)
    ).json();
  const other = await page.request.patch(`${origin}/api/drafts/${id}`, {
    headers: {
      Origin: origin,
      "X-CSRF-Token": me.csrfToken,
      "If-Match": `"${current.revision}"`,
    },
    data: {
      payload: {
        ...current.payload,
        title: {
          "es-pe": "Otra versión sintética",
          en: "Another synthetic version",
        },
      },
    },
  });
  assert.equal(other.status(), 200);
  await page
    .getByLabel("Título (español)", { exact: true })
    .fill("Mi texto local conservado");
  await page
    .getByRole("button", { name: "Guardar revisión", exact: true })
    .click();
  await page.getByText("Hay cambios de otra sesión", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Título (español)", { exact: true }).inputValue(),
    "Mi texto local conservado",
  );
  await page
    .getByText("Ver y copiar mi borrador local", { exact: true })
    .click();
  assert.ok(
    (await page.getByLabel("Borrador local para copiar").inputValue()).includes(
      "Mi texto local conservado",
    ),
  );
  await page.screenshot({
    path: ".local/qa/memories-conflict.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Cargar versión guardada", exact: true })
    .click();
  await page
    .locator(".editor-header h2")
    .filter({ hasText: "Otra versión sintética" })
    .waitFor();
  await page
    .getByRole("button", { name: "Enviar a revisión", exact: true })
    .click();
  await page
    .locator(".alert.success")
    .filter({ hasText: "Enviado." })
    .waitFor();
  await page.locator(".shell-session summary").click();
  await page
    .getByRole("button", { name: "Cambiar cuenta", exact: true })
    .click();
  await page.getByRole("button", { name: /Entrar como revisor/ }).click();
  await page
    .locator(".draft-list button")
    .filter({ hasText: "Otra versión sintética" })
    .click();
  await page
    .getByRole("heading", { name: "Revisar esta versión", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "+ Nuevo recuerdo", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page.getByLabel("Título (español)", { exact: true }).isDisabled(),
    true,
  );
  await page
    .getByLabel("Comentario para el editor", { exact: true })
    .fill("Contenido sintético revisado en ambos idiomas.");
  await page.getByRole("button", { name: /^Aprobar revisión / }).click();
  await page
    .getByRole("heading", { name: "Lista para exportar", exact: true })
    .waitFor();
  await page.screenshot({
    path: ".local/qa/memories-desktop-approved.png",
    fullPage: true,
  });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("button", { name: "Descargar JSON aprobado", exact: true })
      .click(),
  ]);
  await download.saveAs(".local/qa/approved-memory.json");
  const bytes = await readFile(".local/qa/approved-memory.json", "utf8"),
    record = JSON.parse(bytes);
  assert.ok(validate(record), JSON.stringify(validate.errors));
  assert.equal(record.media[0].fit, "contain");
  assert.equal(record.media[0].width, 520);
  assert.equal(record.capturedAt, null);
  assert.equal(
    await (await page.request.get(`${origin}/api/drafts/${id}/export`)).text(),
    bytes,
  );
  assert.ok(!/authorId|reviewerId|csrfToken|revisionHash|comment/.test(bytes));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({
    path: ".local/qa/memories-mobile-approved.png",
    fullPage: true,
  });
  await page.locator(".shell-session summary").click();
  await page
    .getByRole("button", { name: "Cambiar cuenta", exact: true })
    .click();
  await page.getByRole("button", { name: /Entrar como editor/ }).click();
  await page
    .locator(".draft-list button")
    .filter({ hasText: "Otra versión sintética" })
    .click();
  await page
    .getByLabel("Descripción (español)", { exact: true })
    .fill("Nueva revisión sintética después de aprobar.");
  await page
    .getByRole("button", { name: "Guardar revisión", exact: true })
    .click();
  await page
    .locator(".alert.success")
    .filter({ hasText: "Revisión guardada" })
    .waitFor();
  assert.equal(
    (await page.request.get(`${origin}/api/drafts/${id}/export`)).status(),
    409,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Descargar JSON aprobado", exact: true })
      .count(),
    0,
  );
  await page.locator(".shell-session summary").click();
  await page
    .getByRole("button", { name: "Cambiar cuenta", exact: true })
    .click();
  await page.getByRole("button", { name: /Entrar como lector/ }).click();
  await page
    .locator(".draft-list button")
    .filter({ hasText: "Otra versión sintética" })
    .click();
  await page.getByText("Modo de solo lectura.", { exact: false }).waitFor();
  assert.equal(
    await page.getByLabel("Título (español)", { exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Guardar revisión", exact: true })
      .count(),
    0,
  );
  const disabledOrigin = await start(false);
  await page.goto(disabledOrigin + "/#fixture-memories");
  await page
    .getByText("Acceso de prueba deshabilitado", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: /Entrar como/ }).count(),
    0,
  );
  await page.screenshot({
    path: ".local/qa/memories-disabled-login.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "Browser workflow passed: empty/error states, bilingual portrait editing, conflict recovery, separate reviewer approval, deterministic JSON download, edit invalidation, read-only role, disabled fixture access, desktop/mobile no overflow, reduced-motion preference and no page errors.",
  );
  console.log(
    "Readable Chromium screenshots and exported fixture JSON saved only in ignored .local/qa/.",
  );
} catch (error) {
  await page.screenshot({ path: ".local/qa/failure.png", fullPage: true });
  throw error;
} finally {
  await browser.close();
  for (const server of servers)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.query(`DROP SCHEMA "${schemaName}" CASCADE`);
  await pool.end();
}
