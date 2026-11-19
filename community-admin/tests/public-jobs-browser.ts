/** Real static public renderer from an isolated website build; never reads the admin database. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import express from "express";
import { chromium } from "playwright";
assert.ok(
  process.env.PUBLIC_SITE_DIST,
  "PUBLIC_SITE_DIST must identify the isolated static build",
);
const mode = process.env.PUBLIC_JOBS_EXPECT ?? "empty",
  base = (process.env.PUBLIC_SITE_BASE ?? "").replace(/\/$/, ""),
  app = express(),
  server = createServer(app);
app.use(base || "/", express.static(resolve(process.env.PUBLIC_SITE_DIST)));
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert.ok(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`,
  browser = await chromium.launch({ channel: "chrome", headless: true }),
  errors: string[] = [],
  apiRequests: string[] = [];
const artifacts = resolve(
  `.local/qa/public-jobs-${mode}${base ? "-subpath" : ""}`,
);
await mkdir(artifacts, { recursive: true });
try {
  for (const lang of ["es-pe", "en"]) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
    });
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (new URL(r.url()).pathname.includes("/api/"))
        apiRequests.push(r.url());
    });
    await page.goto(`${origin}${base}/${lang}/opportunities/`);
    await page.locator("[data-jobs]").waitFor();
    assert.equal(
      await page.getByText("Lorem Labs", { exact: true }).count(),
      0,
    );
    if (mode === "empty") {
      assert.equal(await page.locator("[data-job]").count(), 0);
      await page.locator("[data-jobs-empty]").waitFor();
      assert.match(await page.locator("[data-job-count]").innerText(), /00/);
    } else {
      const count = await page.locator("[data-job]").count();
      assert.ok(count > 0);
      for (const title of [
        "Closed fixture",
        "Expired fixture",
        "Stale fixture",
      ])
        assert.equal(await page.getByText(title, { exact: true }).count(), 0);
      await page.locator("[data-job-stage]").scrollIntoViewIfNeeded();
      await page.locator("[data-job-open]").click();
      await page.locator("[data-job-dialog]").waitFor({ state: "visible" });
      const apply = page.locator("[data-job-dialog] a").first();
      assert.match(
        (await apply.getAttribute("href"))!,
        /^https:\/\/example\.org\//,
      );
      assert.equal(await apply.getAttribute("target"), "_blank");
      await page.locator("[data-job-close]").click();
      assert.equal(
        await page
          .locator("[data-job-open]")
          .evaluate((e) => e === document.activeElement),
        true,
      );
      await page.locator('[data-job-filter="onsite"]').click();
      if ((await page.locator("[data-job]:not([hidden])").count()) === 0) {
        assert.equal(await page.locator("[data-job-open]").isDisabled(), true);
        await page
          .locator("[data-job-filter-empty]")
          .waitFor({ state: "visible" });
      }
      await page.locator('[data-job-filter="all"]').click();
      await page.locator("[data-job-stage]").focus();
      await page.keyboard.press("ArrowRight");
      assert.ok(
        (await page.locator("[data-job-position]").innerText()).includes("/"),
      );
    }
    for (const width of [1440, 390, 320])
      for (const theme of ["light", "dark"]) {
        await page.setViewportSize({
          width,
          height: width === 1440 ? 1000 : 844,
        });
        await page.evaluate(
          (theme) => (document.documentElement.dataset.theme = theme),
          theme,
        );
        await page.locator("[data-jobs]").scrollIntoViewIfNeeded();
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        );
        await page.screenshot({
          path: `${artifacts}/${lang}-${width}-${theme}.png`,
          fullPage: true,
        });
      }
    await page.emulateMedia({ reducedMotion: "no-preference" });
    if (mode !== "empty") {
      if (await page.locator("[data-job-motion]").isEnabled())
        await page.locator("[data-job-motion]").click();
      await page.locator("[data-job-stage]").scrollIntoViewIfNeeded();
    }
    await page.close();
  }
  if (mode !== "empty") {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.clock.install();
    await page.goto(`${origin}${base}/es-pe/opportunities/`);
    await page.locator("[data-job-stage]").waitFor();
    await page.evaluate(() => {
      document
        .querySelectorAll<HTMLElement>("[data-job]")
        .forEach(
          (c) =>
            (c.dataset.expiresAt = new Date(Date.now() + 1000).toISOString()),
        );
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.locator("[data-job-open]").click();
    await page.clock.fastForward(1200);
    assert.equal(
      await page
        .locator("[data-job-dialog]")
        .evaluate((d: HTMLDialogElement) => d.open),
      false,
    );
    assert.equal(await page.locator("[data-job-content] a").count(), 0);
    assert.equal(
      await page.locator("[data-job-list]:not([hidden])").count(),
      0,
    );
    assert.equal(await page.locator("[data-job-open]").isDisabled(), true);
    await page.locator('[data-job-filter="all"]').click();
    assert.equal(await page.locator("[data-job]:not([hidden])").count(), 0);
    await page.screenshot({
      path: `${artifacts}/runtime-expired.png`,
      fullPage: true,
    });
    await page.close();
    const afterDeadline = await browser.newPage({ reducedMotion: "reduce" });
    await afterDeadline.clock.install({
      time: new Date("2999-01-01T00:00:00Z"),
    });
    await afterDeadline.goto(`${origin}${base}/es-pe/opportunities/`);
    // Fixture expiry is present in the built canonical JSON, so boot itself must reject it.
    const expiring = afterDeadline.locator(
      '[data-job][data-expires-at]:not([data-expires-at=""])',
    );
    assert.ok((await expiring.count()) > 0);
    assert.equal(await expiring.filter({ visible: true }).count(), 0);
    await afterDeadline.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(apiRequests, []);
  console.log(
    JSON.stringify(
      {
        staticCanonicalJobs: mode,
        base: base || "/",
        desktopMobileThemes: "PASS",
        originalApplyLinks: "PASS",
        emptyAndFilteredZero: "PASS",
        privateApiRequests: 0,
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
