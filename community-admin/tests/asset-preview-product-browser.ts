/** Built main client with actual authenticated app, isolated PostgreSQL, original approved images. */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import express from "express";
import sharp from "sharp";
import { chromium } from "playwright";
import { createPool, migrate, COMMUNITY_ID } from "../src/server/db";
import { createApp } from "../src/server/app";
import { privateStorage } from "../src/server/storage";
import { stableUuid } from "../src/server/import-site";
import { entityDefinitions } from "../src/shared/product-contract";
assert.ok(process.env.DATABASE_URL);
const site = resolve(process.env.WEBSITE_CHECKOUT ?? ".."),
  schema = "test_cover_browser_" + randomUUID().replaceAll("-", ""),
  temporary = await mkdtemp(join(tmpdir(), "cover-browser-")),
  pool = createPool(process.env.DATABASE_URL, schema),
  server = createServer();
process.env.PRIVATE_STORAGE_DIR = join(temporary, "storage");
process.env.PRIVATE_KEY_DIR = join(temporary, "keys");
process.env.WEBSITE_CHECKOUT = site;
const browser = await chromium.launch({ channel: "chrome", headless: true }),
  page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  }),
  errors: string[] = [];
page.setDefaultTimeout(12000);
page.on("pageerror", (e) => errors.push(e.message));
const artifacts = resolve(".local/qa/asset-navigation-built");
await mkdir(artifacts, { recursive: true });
try {
  await migrate(pool, schema);
  const snapshot = process.env.PUBLIC_RECORDS_FIXTURE
    ? JSON.parse(await readFile(process.env.PUBLIC_RECORDS_FIXTURE, "utf8"))
    : null;
  for (const type of ["organizers", "brands"]) {
    const definition = entityDefinitions.find((d) => d.type === type)!;
    for (const filename of (
      await readdir(resolve(site, "content", type))
    ).filter((f) => f.endsWith(".json"))) {
      const source = JSON.parse(
          await readFile(resolve(site, "content", type, filename), "utf8"),
        ),
        payload = { ...structuredClone(definition.defaults), ...source };
      if (snapshot) {
        const current = snapshot.find(
          (r: any) => r.type === type && r.id === source.id,
        );
        if (!current) continue;
        Object.assign(payload, current.payload);
      }
      if (type === "organizers")
        for (const field of ["photo", "figurine"]) {
          const path = source[field],
            id = stableUuid("asset:" + path),
            bytes = await readFile(resolve(site, "public", path)),
            meta = await sharp(bytes).metadata(),
            sha = createHash("sha256").update(bytes).digest("hex"),
            key = "fixture/" + sha,
            mime =
              meta.format === "jpeg" ? "image/jpeg" : `image/${meta.format}`;
          await privateStorage().put(key, bytes, mime);
          await pool.query(
            "INSERT INTO media_assets(id,community_id,path,sha256,width,height,mime,bytes,storage_key,original_name,rights) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$3,$10) ON CONFLICT(id) DO NOTHING",
            [
              id,
              COMMUNITY_ID,
              path,
              sha,
              meta.width,
              meta.height,
              mime,
              bytes.length,
              key,
              {
                source: "existing public fixture",
                permissionBasis: "test only",
              },
            ],
          );
          payload[field + "AssetId"] = id;
        }
      await pool.query(
        "INSERT INTO records(id,community_id,type,scope,author_id,payload,state,revision_hash,updated_at) VALUES($1,$2,$3,'public',$4,$5,'draft','fixture',now()) ON CONFLICT(id) DO NOTHING",
        [
          source.id,
          COMMUNITY_ID,
          type,
          "10000000-0000-4000-8000-000000000004",
          payload,
        ],
      );
    }
  }
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const app = createApp({
      pool,
      media: [],
      origin,
      fixtureAuthEnabled: true,
      environment: "test",
    }),
    web = resolve(process.env.PRODUCT_WEB_DIST ?? "dist/web");
  app.use(express.static(web));
  app.get("/{*path}", (_req, res) =>
    res.sendFile("index.html", { root: web, dotfiles: "allow" }),
  );
  server.on("request", app);
  await page.goto(`${origin}/?section=organizers`);
  await page.getByRole("button", { name: /Entrar como propietario/ }).click();
  await page.locator(".record-cover img").first().waitFor();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll<HTMLImageElement>(".record-cover img")]
        .length === 3 &&
      [
        ...document.querySelectorAll<HTMLImageElement>(".record-cover img"),
      ].every((i) => i.complete && i.naturalWidth > 0),
  );
  const images = await page
    .locator(".record-cover img")
    .evaluateAll((imgs) => imgs.map((i) => i.getAttribute("src")));
  assert.deepEqual(
    images,
    ["team/josua-3d.webp", "team/oscar-coffee.webp", "team/ronald-3d.webp"].map(
      (p) => `/api/media/${stableUuid("asset:" + p)}`,
    ),
  );
  await page.screenshot({
    path: `${artifacts}/actual-api-organizers-desktop-light.png`,
    fullPage: true,
  });
  await page.reload();
  await page.getByRole("heading", { name: /^Organizadores\s*3$/ }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("section"), "organizers");
  await page
    .getByRole("button", { name: "Buscar sección", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Ir a una sección" });
  await dialog.getByRole("searchbox").fill("Marca");
  await dialog.getByRole("button", { name: /^Marca/ }).click();
  const input = page.getByRole("searchbox", { name: "Buscar", exact: true });
  for (const term of [
    "linkedin-cover-1584x396.svg",
    "logo-isometrico-3capas-ukuku-transparent.svg",
    "meetup.svg",
  ]) {
    await input.fill(term);
    await page.waitForFunction(() => {
      const imgs = [
        ...document.querySelectorAll<HTMLImageElement>(".record-cover img"),
      ];
      return (
        imgs.length === 1 && imgs.every((i) => i.complete && i.naturalWidth > 0)
      );
    });
    const src = await page.locator(".record-cover img").getAttribute("src");
    assert.match(src!, /^\/api\/brand-assets\/[a-f0-9-]+\/preview$/);
    const response = await page.request.get(origin + src);
    assert.equal(response.status(), 200);
    assert.match(response.headers()["content-type"], /^image\/svg\+xml/);
  }
  await input.fill("");
  await page.locator(".record-cover img").first().waitFor();
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({
        width,
        height: width === 1440 ? 1000 : 844,
      });
      await page.evaluate(
        (theme) => (document.documentElement.dataset.theme = theme),
        theme,
      );
      await page
        .locator(".record-cover img")
        .evaluateAll((images) =>
          images.forEach(
            (image) => ((image as HTMLImageElement).loading = "eager"),
          ),
        );
      await page.waitForFunction(() =>
        [
          ...document.querySelectorAll<HTMLImageElement>(".record-cover img"),
        ].every((image) => image.complete && image.naturalWidth > 0),
      );
      await page.screenshot({
        path: `${artifacts}/actual-api-brands-${width}-${theme}.png`,
        fullPage: true,
      });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
    }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        actualAppPgAssets: "PASS",
        originalSpriteIdentity: "PASS",
        authenticatedBrandSvgDecode: "PASS",
        reload: "PASS",
        schema,
        mainDbWrites: 0,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
  await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await pool.end();
  await rm(temporary, { recursive: true, force: true });
}
