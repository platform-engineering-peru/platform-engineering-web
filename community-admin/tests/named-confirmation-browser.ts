/** Named lifecycle confirmations against the built client and existing API shapes, synthetic records only. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import express from "express";
import { chromium } from "playwright";
import { entityDefinitions } from "../src/shared/product-contract";
const app = express(),
  server = createServer(app);
const user = {
  id: "synthetic-lifecycle",
  name: "Synthetic owner",
  role: "owner",
  roles: ["owner"],
  capabilities: ["*"],
  csrfToken: "isolated",
};
let assets: any[] = [];
let mediaCleanup = false;
let records: any[] = [],
  drafts: any[] = [],
  stale = false,
  deny = false;
const mutations: { path: string; body: any; version: string }[] = [];
const record = (
  id: string,
  type: string,
  name: string,
  state: string,
  revision: number,
) => ({
  id,
  type,
  state,
  revision,
  revisionHash: "hash",
  updatedAt: "2026-11-18T15:00:00Z",
  payload: {
    ...structuredClone(
      entityDefinitions.find((d) => d.type === type)!.defaults,
    ),
    ...(["people", "organizers"].includes(type)
      ? { name }
      : { title: { "es-pe": name, en: name } }),
  },
});
function reset() {
  mediaCleanup = false;
  assets = [
    {
      id: "owned",
      label: "Carga propia sin uso",
      sha256: "a".repeat(64),
      width: 1,
      height: 1,
    },
    {
      id: "official",
      label: "Archivo oficial conservado",
      sha256: "b".repeat(64),
      width: 1,
      height: 1,
    },
  ];
  records = [
    record("one", "people", "Primer contacto sintético", "archived", 1),
    record("two", "people", "Segundo contacto sintético", "archived", 7),
    record("resource", "resources", "Recurso sintético visible", "approved", 2),
    record("organizer", "organizers", "Organizador sintético", "draft", 1),
    record("settings", "settings", "Configuración necesaria", "approved", 1),
  ];
  drafts = [
    {
      id: "00000000-0000-4000-8000-000000000001",
      recordId: "00000000-0000-4000-8000-000000000002",
      type: "events",
      version: 1,
      state: "local",
      baseCommit: "a".repeat(40),
      baseRecordHash: null,
      desiredStatus: "published",
      updatedAt: "2026-11-18T15:00:00Z",
      payload: {
        ...structuredClone(
          entityDefinitions.find((d) => d.type === "events")!.defaults,
        ),
        title: {
          "es-pe": "Evento sintético local",
          en: "Local synthetic event",
        },
      },
    },
  ];
  stale = false;
  deny = false;
}
app.use(express.json());
app.use("/api", (req, res) => {
  if (req.method !== "GET")
    mutations.push({
      path: req.path,
      body: req.body,
      version: String(req.get("If-Match")),
    });
  if (req.path === "/config")
    return res.json({
      fixtureAuthEnabled: false,
      localGhAuthEnabled: true,
      editorialMode: "github",
    });
  if (req.path === "/me") return res.json(user);
  if (req.path === "/catalog") return res.json({ entities: entityDefinitions });
  if (req.path === "/media") return res.json(assets);
  if (req.path.startsWith("/media/")) {
    if (req.method === "GET")
      return res
        .type("png")
        .send(
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=",
            "base64",
          ),
        );
    const asset = assets.find((a) => a.id === req.path.split("/")[2]);
    assert.equal(asset.id, "owned");
    assert.equal(req.get("If-Match"), '"' + asset.sha256 + '"');
    if (!mediaCleanup) {
      mediaCleanup = true;
      asset.cleanupPending = true;
      asset.state = "cleanup-pending";
      return res.json({
        state: "removed",
        cleanupPending: true,
        bytesRemoved: false,
      });
    }
    assets = assets.filter((a) => a.id !== asset.id);
    return res.json({ state: "removed", bytesRemoved: true });
  }
  if (req.path === "/overview")
    return res.json({ counts: {}, reviewQueue: [], upcoming: [] });
  if (req.path === "/website/publication/status")
    return res.json({ ready: false, reasons: ["UNCONFIGURED"] });
  if (req.path.startsWith("/lifecycle/")) {
    const [, , module, id] = req.path.split("/");
    if (module === "media") {
      const asset = assets.find((a) => a.id === id);
      assert.ok(asset);
      return res.json({
        module,
        id,
        version: asset.sha256,
        state: "available",
        remoteEffect: "none",
        retentionReason: null,
        actions: [
          {
            action: "remove",
            effect: "owned-upload-removal",
            allowed: id === "owned",
            reason: id === "owned" ? null : "SEEDED_MEDIA_PROTECTED",
            blockers: [],
            requiresReason: true,
            requiresRecentAuth: false,
          },
        ],
      });
    }
    const row =
      module === "records"
        ? records.find((r) => r.id === id)
        : drafts.find((r) => r.id === id);
    assert.ok(row);
    const action = (
      action: string,
      effect: string,
      allowed = true,
      reason: string | null = null,
    ) => ({
      action,
      effect,
      allowed,
      reason,
      blockers: [],
      requiresReason: action === "erase",
      requiresRecentAuth: action === "erase",
    });
    return res.json({
      module,
      id,
      version: row.revision ?? row.version,
      state: row.state,
      remoteEffect: row.type === "resources" ? "publication-required" : "none",
      retentionReason: null,
      actions:
        module !== "records"
          ? [action("discard", "local-discard")]
          : row.type === "settings"
            ? [action("archive", "local-archive", false, "MANDATORY_SETTINGS")]
            : row.type === "people"
              ? [
                  action(
                    "erase",
                    "private-erasure",
                    !deny,
                    deny ? "PERMISSION_DENIED" : null,
                  ),
                ]
              : [action("archive", "public-withdrawal")],
    });
  }
  if (req.path === "/records")
    return res.json({
      items: records.filter((r) => r.type === req.query.type),
      nextCursor: null,
    });
  if (req.path.endsWith("/audit")) return res.json([]);
  const parts = req.path.split("/");
  if (parts[1] === "records") {
    const row = records.find((r) => r.id === parts[2]);
    assert.ok(row);
    if (req.method === "GET") return res.json(row);
    assert.equal(req.get("X-CSRF-Token"), "isolated");
    assert.equal(req.get("If-Match"), `"${row.revision}"`);
    if (parts[3] === "delete") {
      assert.equal(row.state, "archived");
      assert.ok(req.body.reason.trim().length >= 5);
      if (stale) {
        stale = false;
        row.revision++;
        return res.status(409).json({
          code: "REVISION_CONFLICT",
          message: "La revisión cambió. Vuelve a cargar el registro.",
        });
      }
      records = records.filter((r) => r.id !== row.id);
      return res.json({ id: row.id, state: "deleted", cryptoErased: true });
    }
    if (parts[3] === "archive") {
      row.state = row.type === "resources" ? "draft" : "archived";
      row.revision++;
      return res.json(row);
    }
  }
  if (req.path === "/editorial/status")
    return res.json({
      mode: "github",
      configured: true,
      remoteWritesEnabled: false,
      repository: "synthetic/site",
      branch: "main",
      supportedTypes: ["events"],
      identity: { login: "synthetic", subject: "1" },
      connection: "online",
    });
  if (req.path === "/editorial/events")
    return res.json({
      commit: "a".repeat(40),
      fetchedAt: "2026-11-18T15:00:00Z",
      stale: false,
      records: [],
      recordHashes: {},
      references: { speakers: [] },
    });
  if (req.path === "/editorial/drafts") return res.json({ items: drafts });
  if (req.path === "/editorial/submissions") return res.json({ items: [] });
  if (
    parts[1] === "editorial" &&
    parts[2] === "drafts" &&
    req.method === "DELETE"
  ) {
    const draft = drafts.find((d) => d.id === parts[3]);
    assert.ok(draft);
    assert.equal(req.get("If-Match"), `"${draft.version}"`);
    assert.equal(draft.state, "local");
    drafts = [];
    return res.json({ discarded: true, remoteUnchanged: true });
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
const artifacts = resolve(
  process.env.ARTIFACTS_DIR ??
    ".local/qa/deletion-actions/confirmation-browser",
);
await mkdir(artifacts, { recursive: true });
const openRecord = async (name: string) => {
  await page
    .locator(".record-list li")
    .filter({ hasText: name })
    .getByRole("button")
    .click();
  await page.getByRole("heading", { name, exact: true }).waitFor();
  if (
    !(await page
      .locator(".lifecycle-actions")
      .evaluate((e) => (e as HTMLDetailsElement).open))
  )
    await page.locator(".lifecycle-actions summary").click();
};
try {
  for (const width of [1440, 390, 320])
    for (const theme of ["light", "dark"]) {
      reset();
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`http://127.0.0.1:${address.port}/?section=people`);
      await page
        .getByRole("button", { name: "Importar CSV", exact: true })
        .waitFor();
      if ((await page.locator("html").getAttribute("data-theme")) !== theme)
        await page
          .getByRole("button", { name: "Cambiar tema", exact: true })
          .click();
      await openRecord("Primer contacto sintético");
      const erase = page.getByRole("button", {
        name: "Eliminar definitivamente…",
        exact: true,
      });
      const dialog = page.getByRole("dialog");
      const reason = dialog.getByLabel(/Motivo de la eliminación/);
      const cancel = dialog.getByRole("button", {
        name: "Volver sin cambios",
        exact: true,
      });
      const confirm = dialog.getByRole("button", {
        name: "Eliminar definitivamente",
        exact: true,
      });
      const before = mutations.length;
      await erase.click();
      await dialog
        .getByRole("heading", {
          name: "Eliminar definitivamente «Primer contacto sintético»",
          exact: true,
        })
        .waitFor();
      assert.equal(
        await cancel.evaluate((n) => document.activeElement === n),
        true,
      );
      assert.equal(await confirm.isDisabled(), true);
      await reason.fill("Solo para la primera identidad");
      await page.keyboard.press("Escape");
      assert.equal(await dialog.isVisible(), false);
      assert.equal(
        await erase.evaluate((n) => document.activeElement === n),
        true,
      );
      assert.equal(mutations.length, before);
      await erase.click();
      assert.equal(await reason.inputValue(), "");
      await cancel.click();
      await page
        .getByRole("button", { name: "Volver a la lista", exact: true })
        .click();
      await openRecord("Segundo contacto sintético");
      await erase.click();
      assert.equal(await reason.inputValue(), "");
      await reason.fill("Razón para el segundo contacto sintético");
      const beforeRevocation = mutations.length;
      deny = true;
      await confirm.click();
      await dialog
        .getByRole("alert")
        .filter({ hasText: "Tu cuenta no tiene permiso" })
        .waitFor();
      assert.equal(mutations.length, beforeRevocation);
      assert.equal(
        await reason.inputValue(),
        "Razón para el segundo contacto sintético",
      );
      deny = false;
      stale = true;
      await confirm.click();
      await dialog
        .getByRole("alert")
        .filter({ hasText: "Otra sesión cambió este registro" })
        .waitFor();
      assert.equal(
        await reason.inputValue(),
        "Razón para el segundo contacto sintético",
      );
      await page.screenshot({
        path: resolve(artifacts, `conflict-${width}-${theme}.png`),
        fullPage: true,
      });
      await cancel.click();
      await page
        .getByRole("button", { name: "Volver a la lista", exact: true })
        .click();
      await openRecord("Segundo contacto sintético");
      await erase.click();
      assert.equal(await reason.inputValue(), "");
      await reason.fill("Borrado sintético de la revisión actual");
      await confirm.click();
      await page
        .getByText(/«Segundo contacto sintético»:.*Contenido privado/)
        .waitFor();
      assert.equal(
        records.some((r) => r.id === "two"),
        false,
      );
      await page.goto(`http://127.0.0.1:${address.port}/?section=resources`);
      await openRecord("Recurso sintético visible");
      await page
        .getByRole("button", { name: "Retirar del sitio…", exact: true })
        .click();
      await dialog.getByText(/puede seguir visible/).waitFor();
      await dialog
        .getByRole("button", { name: "Preparar retirada", exact: true })
        .click();
      await page
        .getByText(/«Recurso sintético visible»:.*Retirada preparada/)
        .waitFor();
      assert.equal(records.find((r) => r.id === "resource").state, "draft");
      await page.goto(`http://127.0.0.1:${address.port}/?section=events`);
      await page
        .getByRole("button", { name: /Evento sintético local/ })
        .click();
      await page.locator(".lifecycle-actions summary").click();
      await page
        .getByRole("button", { name: "Descartar borrador local…", exact: true })
        .click();
      await dialog.getByText(/contenido publicado.*no cambian/).waitFor();
      await page.screenshot({
        path: resolve(artifacts, `event-discard-${width}-${theme}.png`),
        fullPage: true,
      });
      await dialog
        .getByRole("button", { name: "Descartar borrador", exact: true })
        .click();
      await page
        .getByText(/GitHub y el historial de envíos no cambiaron/)
        .waitFor();
      assert.equal(drafts.length, 0);
      await page.goto(`http://127.0.0.1:${address.port}/?section=organizers`);
      await openRecord("Organizador sintético");
      await page
        .locator(".editor-section-nav button")
        .filter({ hasText: "Medios" })
        .click();
      await page.locator(".picker-browser summary").first().click();
      await page
        .getByRole("button", {
          name: "Ver uso y acciones de Archivo oficial conservado",
          exact: true,
        })
        .first()
        .click();
      const management = page.getByRole("region", {
        name: "Gestión del archivo seleccionado",
      });
      await management.locator(".lifecycle-actions summary").click();
      await management
        .getByText("Este archivo oficial o de referencia se conserva.", {
          exact: true,
        })
        .waitFor();
      assert.equal(
        await management
          .getByRole("button", {
            name: "Eliminar archivo sin uso…",
            exact: true,
          })
          .count(),
        0,
      );
      await page
        .getByRole("button", {
          name: "Ver uso y acciones de Carga propia sin uso",
          exact: true,
        })
        .first()
        .click();
      await management
        .getByRole("button", { name: "Eliminar archivo sin uso…", exact: true })
        .click();
      const mediaBefore = mutations.length;
      await dialog.getByRole("button", { name: "Volver sin cambios" }).click();
      assert.equal(mutations.length, mediaBefore);
      await management
        .getByRole("button", { name: "Eliminar archivo sin uso…", exact: true })
        .click();
      await dialog
        .getByLabel("Motivo de la acción")
        .fill("Synthetic unused own asset removal");
      await dialog
        .getByRole("button", { name: "Eliminar archivo sin uso", exact: true })
        .click();
      await page
        .getByText(
          /La referencia se retiró, pero la limpieza de bytes sigue pendiente/,
        )
        .waitFor();
      assert.equal(
        await page.locator('select option[value="owned"]').count(),
        0,
      );
      assert.equal(
        assets.some((a) => a.id === "owned"),
        true,
      );
      await page.screenshot({
        path: resolve(artifacts, `image-cleanup-${width}-${theme}.png`),
        fullPage: true,
      });
      await management
        .getByRole("button", { name: "Eliminar archivo sin uso…", exact: true })
        .click();
      await dialog
        .getByLabel("Motivo de la acción")
        .fill("Explicit image cleanup retry exact checksum");
      await dialog
        .getByRole("button", { name: "Eliminar archivo sin uso", exact: true })
        .click();
      await management.waitFor({ state: "hidden" });
      assert.equal(
        assets.some((a) => a.id === "owned"),
        false,
      );

      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth,
        ),
        false,
      );
    }
  assert.deepEqual(errors, []);
  console.log(
    "PASS named entity/revision confirmation, cancelEscape/focus0effects, crossentityreasonreset, stale409preservesinput, privateerase/publicpendingwithdraw/Eventslocaldiscard;1440/390/320both themes, synthetic APIs only, fresh capability revocation0mutation and protected/owned media disposal",
  );
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
