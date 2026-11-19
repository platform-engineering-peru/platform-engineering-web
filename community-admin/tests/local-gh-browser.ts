/** Read-only content acceptance against the running opt-in local CLI review server. */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { createPool } from "../src/server/db";
const origin = process.env.PUBLIC_ORIGIN ?? "http://127.0.0.1:4455";
assert.equal(new URL(origin).hostname, "127.0.0.1");
const pool = createPool(process.env.DATABASE_URL!, process.env.DATABASE_SCHEMA);
const fingerprint = async () =>
  (
    await pool.query(
      "SELECT count(*)::int AS records,md5(string_agg(id::text||revision_hash||payload::text,',' ORDER BY id)) AS fingerprint FROM records",
    )
  ).rows[0];
const before = await fingerprint();
const { stdout } = await promisify(execFile)(
  "gh",
  ["api", "--hostname", "github.com", "user"],
  { encoding: "utf8", timeout: 8000, maxBuffer: 65536 },
);
const profile = JSON.parse(stdout);
const browser = await chromium.launch({
  headless: true,
  channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome",
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: "reduce",
});
const page = await context.newPage(),
  errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  const config = await (
    await context.request.get(origin + "/api/config")
  ).json();
  assert.equal(config.localGhAuthEnabled, true);
  assert.equal(config.fixtureAuthEnabled, false);
  assert.equal(config.developmentOnly, true);
  await page.goto(origin, { waitUntil: "networkidle" });
  await page
    .locator(".topbar .user-role")
    .filter({ hasText: profile.name ?? profile.login })
    .waitFor();
  assert.equal(await page.locator(".personas").count(), 0);
  assert.equal(
    await page.getByRole("button", { name: /Entrar como/ }).count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("link", { name: "@" + profile.login })
      .getAttribute("href"),
    profile.html_url,
  );
  const me = await page.evaluate(async () => (await fetch("/api/me")).json());
  assert.equal(me.github.subject, String(profile.id));
  assert.equal(me.isFixture, false);
  assert.equal(me.role, "owner");
  assert.equal(me.authMethod, "local-gh");
  assert.ok(!("email" in me.github));
  assert.ok(!("token" in me.github));
  const cookie = (await context.cookies()).find(
    (c) => c.name === "ca_local_gh",
  );
  assert.ok(cookie?.httpOnly);
  assert.equal(cookie?.sameSite, "Strict");
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".topbar").waitFor();
  const same = await page.evaluate(async () => (await fetch("/api/me")).json());
  assert.equal(
    same.authenticatedAt,
    me.authenticatedAt,
    "page reload must not silently refresh recent-auth",
  );
  await page
    .getByRole("button", { name: "Reverificar GitHub CLI", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "verificada nuevamente" })
    .waitFor();
  const statusBox = await page
    .getByRole("status")
    .filter({ hasText: "verificada nuevamente" })
    .boundingBox();
  assert.ok(
    statusBox && statusBox.x >= 220,
    "The reverify status must remain readable beside the desktop navigation",
  );
  const refreshed = await page.evaluate(async () =>
    (await fetch("/api/me")).json(),
  );
  assert.ok(
    Date.parse(refreshed.authenticatedAt) > Date.parse(me.authenticatedAt),
  );
  await mkdir(".local/qa", { recursive: true });
  await page.screenshot({
    path: ".local/qa/local-gh-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Cambiar tema" }).click();
  await page.screenshot({
    path: ".local/qa/local-gh-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  );
  await page
    .getByRole("button", { name: "Cerrar sesión", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Verificar GitHub CLI e ingresar" })
    .waitFor();
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(
    await page.locator(".topbar").count(),
    0,
    "logout must remain logged out after reload",
  );
  assert.equal((await context.request.get(origin + "/api/me")).status(), 401);
  await page
    .getByRole("button", { name: "Verificar GitHub CLI e ingresar" })
    .click();
  await page.locator(".topbar").waitFor();
  const disabled = await context.request.post(origin + "/api/dev/login", {
    headers: { Origin: origin },
    data: { persona: "owner" },
  });
  assert.equal(disabled.status(), 404);
  const overview = await page.evaluate(async () =>
    (await fetch("/api/overview")).json(),
  );
  assert.equal(overview.operations.liveIntegrationsEnabled, false);
  // Simulate only a local CLI verification failure response; never change the real CLI account.
  const failed = await browser.newContext(),
    failure = await failed.newPage();
  await failure.route("**/api/auth/local-gh", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        code: "GH_CLI_UNAVAILABLE",
        message: "No se pudo verificar GitHub CLI. Vuelve a verificar.",
      }),
    }),
  );
  await failure.goto(origin, { waitUntil: "networkidle" });
  await failure
    .getByRole("alert")
    .filter({ hasText: "No se pudo verificar GitHub CLI" })
    .waitFor();
  assert.equal(
    await failure
      .getByRole("button", { name: "Verificar GitHub CLI e ingresar" })
      .isEnabled(),
    true,
  );
  assert.equal(await failure.locator(".personas").count(), 0);
  await failed.close();
  assert.deepEqual(
    await fingerprint(),
    before,
    "authentication review must not mutate content",
  );
  assert.deepEqual(errors, []);
  const evidence = {
    url: origin,
    profile: {
      subject: String(profile.id),
      login: profile.login,
      name: profile.name,
      profileUrl: profile.html_url,
    },
    role: me.role,
    isFixture: me.isFixture,
    records: before.records,
    contentUnchanged: true,
    fixtureAuthEnabled: false,
    liveIntegrationsEnabled: false,
    automaticBoot: true,
    logoutReloadPaused: true,
    reverifyRotates: true,
    readiness: (
      await context.request.get(origin + "/api/health/ready")
    ).status(),
    pageErrors: errors,
    checkedAt: new Date().toISOString(),
  };
  await writeFile(
    ".local/qa/local-gh-acceptance.json",
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
} finally {
  await context.close();
  await browser.close();
  await pool.end();
}
