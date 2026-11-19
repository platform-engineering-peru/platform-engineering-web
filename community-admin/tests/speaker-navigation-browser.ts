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
for (const type of ["speakers"]) {
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
  if (/^\/speaker-assets\/[^/]+\/preview$/.test(req.path)) {
    const record = rows.find((r) => r.id === req.path.split("/")[2]);
    return record?.payload.photo?.startsWith("speakers/")
      ? res.sendFile(record.payload.photo, { root: resolve(site, "public") })
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
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  reducedMotion: "reduce",
});
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const artifacts = resolve(
  process.env.ARTIFACTS_DIR ?? ".local/qa/sticky-speakers/browser",
);
await mkdir(artifacts, { recursive: true });
try {
  for (const width of [1440, 390, 320])
    for (const dark of [false, true]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${origin}/?section=speakers`);
      await page.locator(".record-cover").first().waitFor();
      if (
        ((await page.locator("html").getAttribute("data-theme")) === "dark") !==
        dark
      )
        await page
          .getByRole("button", { name: "Cambiar tema", exact: true })
          .click();
      await page.evaluate(() => {
        const main = document.querySelector(".product-main")!;
        const space = document.createElement("div");
        space.style.height = "2500px";
        space.dataset.testSpacer = "true";
        main.append(space);
      });
      await page.screenshot({
        path: `${artifacts}/before-scroll-${width}-${dark ? "dark" : "light"}.png`,
      });
      await page.evaluate(() => window.scrollTo(0, 650));
      await page.waitForTimeout(80);
      await page.screenshot({
        path: `${artifacts}/scrolled-${width}-${dark ? "dark" : "light"}.png`,
      });
      const rect = await page.locator(".shell-context").boundingBox();
      assert.ok(
        rect && rect.y >= 0 && rect.y + rect.height < 400,
        `Section navigation must stay reachable: ${JSON.stringify(rect)}`,
      );
      for (const name of [
        "Grecia Vargas",
        "Danielle Nascimento",
        "Jose Luis Buga",
      ]) {
        const card = page.locator(".record-list li").filter({ hasText: name });
        const image = card.locator(".record-cover img");
        await image.waitFor();
        if (name === "Jose Luis Buga")
          assert.equal(
            await image.getAttribute("src"),
            rows.find((r) => r.payload.name === name).payload.photo,
          );
        await image.evaluate((i: HTMLImageElement) => (i.loading = "eager"));
        await page.waitForFunction(
          (src) => {
            const i = document.querySelector<HTMLImageElement>(
              `img[src="${src}"]`,
            );
            return i?.complete && i.naturalWidth > 0;
          },
          await image.getAttribute("src"),
        );
      }
      for (const name of [
        "Grecia Vargas",
        "Danielle Nascimento",
        "Jose Luis Buga",
      ]) {
        const card = page.locator(".record-list li").filter({ hasText: name });
        await card.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: `${artifacts}/portrait-${name.split(" ")[0]}-${width}-${dark ? "dark" : "light"}.png`,
        });
      }
      await page
        .getByRole("button", { name: "Buscar sección", exact: true })
        .focus();
      assert.ok(
        await page
          .getByRole("button", { name: "Buscar sección", exact: true })
          .evaluate((e) => e === document.activeElement),
      );
    }
  assert.deepEqual(errors, []);
  console.log(
    "PASS section navigation scroll, local speaker decode, keyboard,1440/390/320 both themes",
  );
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
