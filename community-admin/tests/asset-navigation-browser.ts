/** Built main client; mocked authentication/records, actual approved checkout image bytes. No live DB or provider writes. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import express from "express";
import { chromium } from "playwright";
import { entityDefinitions } from "../src/shared/product-contract";
import { stableUuid } from "../src/server/import-site";
const site = resolve(process.env.WEBSITE_CHECKOUT ?? ".."),
  web = resolve(process.env.PRODUCT_WEB_DIST ?? "dist/web");
const rows: any[] = [],
  assets = new Map<string, string>();
for (const type of ["organizers", "brands"]) {
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
const browser = await chromium.launch({ channel: "chrome", headless: true }),
  page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  }),
  errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
page.setDefaultTimeout(10000);
const artifacts = resolve(".local/qa/asset-navigation-built");
await mkdir(artifacts, { recursive: true });
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
async function section(id: string) {
  await page.waitForURL((u) => u.searchParams.get("section") === id);
  await page.locator(".product-main").waitFor();
}
async function decoded() {
  await page.locator(".record-cover img").first().waitFor();
  await page
    .locator(".record-cover img")
    .evaluateAll((images) =>
      images.forEach(
        (image) => ((image as HTMLImageElement).loading = "eager"),
      ),
    );
  await page.waitForFunction(() =>
    [...document.querySelectorAll<HTMLImageElement>(".record-cover img")].every(
      (i) => i.complete && i.naturalWidth > 0,
    ),
  );
}
try {
  await page.goto(`${origin}/?section=organizers&keep=1`);
  await section("organizers");
  await decoded();
  const srcs = await page
    .locator(".record-cover img")
    .evaluateAll((imgs) => imgs.map((i) => i.getAttribute("src")));
  const organizers = rows.filter((r) => r.type === "organizers");
  assert.equal(srcs.length, 3);
  assert.deepEqual(
    srcs,
    organizers.map((r) => `/api/media/${r.payload.figurineAssetId}`),
  );
  assert.deepEqual(
    organizers.map((r) => r.payload.shortName),
    ["Josua", "Oscar", "Ronald"],
  );
  await page.screenshot({
    path: `${artifacts}/organizers-desktop-light.png`,
    fullPage: true,
  });
  await page.reload();
  await decoded();
  await section("organizers");
  await navigate("Marca");
  await section("brands");
  await decoded();
  assert.equal(new URL(page.url()).searchParams.get("keep"), "1");
  for (const filename of [
    "linkedin-cover-1584x396.svg",
    "logo-isometrico-3capas-ukuku-transparent.svg",
    "meetup.svg",
  ]) {
    const record = rows.find(
      (r) => r.type === "brands" && r.payload.path.endsWith(filename),
    );
    assert.ok(record);
    const image = page.locator(
      `.record-cover img[src="/api/brand-assets/${record.id}/preview"]`,
    );
    assert.equal(await image.count(), 1);
    assert.ok(
      await image.evaluate(
        (i: HTMLImageElement) => i.complete && i.naturalWidth > 0,
      ),
    );
  }
  await page.reload();
  await decoded();
  await section("brands");
  await page.goBack();
  await section("organizers");
  await page.goForward();
  await section("brands");
  await decoded();
  // Browser history cancellation must restore URL AND content without losing the forward entry.
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("product-dirty", { detail: true })),
  );
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(resolve)),
  );
  page.once("dialog", (d) => d.dismiss());
  await page.goBack();
  await page.waitForURL((u) => u.searchParams.get("section") === "brands");
  assert.equal(
    await page.locator(".manager-workspace").getAttribute("data-view"),
    "grid",
  );
  page.once("dialog", (d) => d.accept());
  await page.goBack();
  await section("organizers");
  await page.goForward();
  await section("brands");
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({
        width,
        height: width === 1440 ? 1000 : 844,
      });
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        localStorage.setItem("admin-theme", theme);
      }, theme);
      await decoded();
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.screenshot({
        path: `${artifacts}/brands-${width}-${theme}.png`,
        fullPage: true,
      });
    }
  // Missing image bytes are explicit; organizer portraits never become a fallback.
  const missingBrand = rows.find(
    (r) => r.type === "brands" && r.payload.path.endsWith("meetup.svg"),
  );
  const blocked = `**/api/brand-assets/${missingBrand.id}/preview`;
  await page.route(blocked, (route) =>
    route.fulfill({ status: 404, body: "missing" }),
  );
  await page.reload();
  await page
    .locator(
      `.record-cover img[src="/api/brand-assets/${missingBrand.id}/preview"]`,
    )
    .scrollIntoViewIfNeeded();
  await page
    .getByRole("img", { name: "Vista previa no disponible", exact: true })
    .waitFor();
  await page.unroute(blocked);
  missingBrand.revision += 1;
  await page
    .getByRole("button", { name: "Actualizar lista", exact: true })
    .click();
  const recovered = page.locator(
    `.record-cover img[src="/api/brand-assets/${missingBrand.id}/preview"]`,
  );
  await recovered.scrollIntoViewIfNeeded();
  assert.ok(
    await recovered.evaluate((image: HTMLImageElement) =>
      image.decode().then(() => image.naturalWidth > 0),
    ),
  );
  const organizer = organizers[0],
    savedFigurine = organizer.payload.figurineAssetId;
  organizer.payload.figurineAssetId = null;
  await navigate("Organizadores");
  await page
    .getByRole("img", { name: "Figura oficial no disponible", exact: true })
    .waitFor();
  assert.equal(
    await page
      .locator(
        `.record-cover img[src="/api/media/${organizer.payload.photoAssetId}"]`,
      )
      .count(),
    0,
  );
  organizer.payload.figurineAssetId = savedFigurine;
  await navigate("Marca");
  await decoded();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator(".shell-session summary").click();
  await page
    .getByRole("button", {
      name: /Verificar.*GitHub|Verificar cuenta|Volver a verificar/i,
    })
    .click();
  await section("brands");
  failReverify = true;
  await page.locator(".shell-session summary").click();
  await page
    .getByRole("button", {
      name: /Verificar.*GitHub|Verificar cuenta|Volver a verificar/i,
    })
    .click();
  await page
    .getByText("GitHub CLI no está disponible.", { exact: true })
    .waitFor();
  await section("brands");
  // Expired session auto-CLI authentication retains the deep link; a logout stays logged out on reload.
  authenticated = false;
  await page.reload();
  await decoded();
  await section("brands");
  assert.ok(mutations.includes("/auth/local-gh"));
  await page.locator(".shell-session summary").click();
  await page.getByRole("button", { name: /Cerrar sesión/ }).click();
  await page.reload();
  assert.equal(await page.locator(".admin-shell").count(), 0);
  assert.equal(authenticated, false);
  await page.evaluate(() => sessionStorage.removeItem("local-gh-paused"));
  authenticated = true;
  await page.goto(`${origin}/?section=invalid`);
  await section("overview");
  assert.deepEqual(errors, []);
  assert.ok(
    mutations.every((p) =>
      ["/auth/local-gh", "/auth/local-gh/reverify", "/logout"].includes(p),
    ),
    mutations.join(","),
  );
  console.log(
    JSON.stringify(
      {
        builtMainClient: "PASS",
        officialAssetDecode: "PASS",
        refreshHistoryDirtyAuth: "PASS",
        desktopMobileThemes: "PASS",
        dataWrites: 0,
        pageErrors: errors,
        artifacts,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
