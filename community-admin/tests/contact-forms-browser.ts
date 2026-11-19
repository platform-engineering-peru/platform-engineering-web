/** Synthetic private contact geometry replay against the built client; no provider, DB, or runtime writes. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import express from "express";
import { chromium } from "playwright";
import { entityDefinitions } from "../src/shared/product-contract";
const definition = entityDefinitions.find((d) => d.type === "people")!;
const person = {
  id: "synthetic-contact",
  type: "people",
  state: "draft",
  revision: 1,
  updatedAt: "2026-11-18T05:00:00Z",
  payload: {
    ...structuredClone(definition.defaults),
    name: "Contacto sintético de revisión",
    location: "Lima Metropolitana, Perú — solo prueba",
    email: "synthetic@example.invalid",
    phone: "+51 000000000",
    provenance: "Synthetic fixture",
    permissionBasis: "Test only",
  },
};
const user = {
  id: "isolated",
  name: "Revisión aislada",
  role: "owner",
  roles: ["owner"],
  capabilities: ["*"],
  csrfToken: "isolated",
};
const app = express(),
  server = createServer(app),
  web = resolve(process.env.PRODUCT_WEB_DIST ?? "dist/web");
let mutations = 0;
app.use(express.json());
app.use("/api", (req, res) => {
  if (req.method !== "GET") mutations++;
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
  if (req.path === "/records")
    return res.json({
      items: req.query.type === "people" ? [person] : [],
      nextCursor: null,
    });
  if (req.path === "/records/synthetic-contact") return res.json(person);
  if (req.path.endsWith("/audit")) return res.json([]);
  return res
    .status(404)
    .json({ code: "UNEXPECTED_TEST_REQUEST", message: req.path });
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
const artifacts = resolve(
  process.env.ARTIFACTS_DIR ?? ".local/qa/contact-forms/browser",
);
await mkdir(artifacts, { recursive: true });
const geometry: any[] = [];
try {
  for (const width of [1440, 390, 320])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${origin}/?section=people`);
      await page
        .getByRole("button", { name: "Importar CSV", exact: true })
        .waitFor();
      if ((await page.locator("html").getAttribute("data-theme")) !== theme)
        await page
          .getByRole("button", { name: "Cambiar tema", exact: true })
          .click();
      const controls = [
        page.getByRole("button", { name: "Importar CSV", exact: true }),
        page.getByLabel("Motivo de la exportación privada", { exact: true }),
        page.getByRole("button", { name: "Exportar CSV privado", exact: true }),
      ];
      const toolbar = await Promise.all(controls.map((c) => c.boundingBox()));
      await page.screenshot({
        path: resolve(artifacts, `toolbar-${width}-${theme}.png`),
        fullPage: true,
      });
      assert.ok(
        toolbar.every((b) => b && b.x >= 0 && b.x + b.width <= width),
        "CSV controls stay within viewport",
      );
      const toolbarAligned =
        width !== 1440 ||
        Math.max(...toolbar.map((b) => b!.y + b!.height)) -
          Math.min(...toolbar.map((b) => b!.y + b!.height)) <
          2;
      await controls[0].focus();
      await page.keyboard.press("Tab");
      assert.equal(
        await controls[1].evaluate((e) => e === document.activeElement),
        true,
      );
      await controls[1].fill("Revisión sintética de alineación");
      await page.keyboard.press("Tab");
      assert.equal(
        await controls[2].evaluate((e) => e === document.activeElement),
        true,
      );
      await page
        .locator(".record-list li")
        .filter({ hasText: person.payload.name })
        .getByRole("button")
        .click();
      await page.locator(".focused-editor").waitFor();
      const name = page.getByLabel("Nombre preferido", { exact: true }),
        location = page.getByLabel("Ubicación", { exact: true });
      const inputs = await Promise.all([
        name.boundingBox(),
        location.boundingBox(),
      ]);
      const contactRow = await Promise.all([
        page.getByLabel("Correo privado", { exact: true }).boundingBox(),
        page.getByLabel("Teléfono privado", { exact: true }).boundingBox(),
      ]);
      if (width === 1440)
        assert.ok(Math.abs(contactRow[0]!.y - contactRow[1]!.y) < 2);
      const labels = await Promise.all(
        [name, location].map((c) =>
          c.evaluate((e) => {
            const r = e.closest("label")!.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width };
          }),
        ),
      );
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: resolve(artifacts, `contact-${width}-${theme}.png`),
        fullPage: true,
      });
      geometry.push({ width, theme, toolbar, toolbarAligned, inputs, labels });
      await writeFile(
        resolve(artifacts, "geometry.json"),
        JSON.stringify(geometry, null, 2),
      );
      assert.ok(
        toolbarAligned,
        `CSV control alignment ${JSON.stringify(toolbar)}`,
      );
      if (width === 1440) {
        assert.ok(
          Math.abs(inputs[0]!.y - inputs[1]!.y) < 2,
          `First-row controls ${JSON.stringify(inputs)}`,
        );
        assert.ok(
          Math.abs(labels[0].y - labels[1].y) < 2,
          `First-row labels ${JSON.stringify(labels)}`,
        );
      } else {
        assert.ok(inputs[1]!.y > inputs[0]!.y);
        assert.ok(inputs.every((b) => b!.x >= 0 && b!.x + b!.width <= width));
      }
      await name.focus();
      await page.keyboard.press("Tab");
      assert.equal(
        await location.evaluate((e) => e === document.activeElement),
        true,
      );
      assert.ok(
        await page
          .locator(".focused-editor")
          .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
      );
    }
  assert.equal(mutations, 0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS synthetic contact firstrow/CSVtoolbar geometry+keyboard1440/390/320themes; no mutations/exports/pageerrors",
  );
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
