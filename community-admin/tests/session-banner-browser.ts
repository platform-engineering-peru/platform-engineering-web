/** Session heartbeat banner recovery against the built client; no provider, DB, or runtime writes. */
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
let sessionUnavailable = false;
app.use(express.json());
app.use("/api", (req, res) => {
  if (req.method !== "GET") mutations++;
  if (req.path === "/config")
    return res.json({
      fixtureAuthEnabled: false,
      localGhAuthEnabled: true,
      editorialMode: "local",
    });
  if (req.path === "/me")
    return sessionUnavailable
      ? res.status(503).json({
          code: "AUTH_UNAVAILABLE",
          message: "Verificación temporalmente no disponible",
        })
      : res.json({
          ...user,
          github: { login: "synthetic", subject: "42", source: "local-gh" },
        });
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
  process.env.ARTIFACTS_DIR ?? ".local/qa/direct-publication/session-browser",
);
await mkdir(artifacts, { recursive: true });
try {
  await page.addInitScript(() => {
    const nativeInterval = window.setInterval.bind(window);
    window.setInterval = ((
      callback: TimerHandler,
      timeout?: number,
      ...args: any[]
    ) =>
      nativeInterval(
        callback,
        timeout === 15000 ? 200 : timeout,
        ...args,
      )) as typeof window.setInterval;
  });
  await page.goto(`${origin}/?section=people`);
  await page
    .getByRole("button", { name: "Importar CSV", exact: true })
    .waitFor({ timeout: 3000 });
  sessionUnavailable = true;
  await page
    .getByText("Verificación temporalmente no disponible", { exact: true })
    .waitFor();
  await page.screenshot({ path: resolve(artifacts, "heartbeat-error.png") });
  sessionUnavailable = false;
  await page
    .getByText("Verificación temporalmente no disponible", { exact: true })
    .waitFor({ state: "hidden", timeout: 2000 });
  assert.equal(
    await page
      .getByText("Verificación temporalmente no disponible", { exact: true })
      .count(),
    0,
    "successful session check clears only its own old failure",
  );
  assert.equal(mutations, 0);
  console.log(
    "PASS temporary session failure clears on successful heartbeat without changing section or private data",
  );
} catch (error) {
  console.log(await page.locator("body").innerText(), errors);
  await page.screenshot({ path: resolve(artifacts, "failure.png") });
  throw error;
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
