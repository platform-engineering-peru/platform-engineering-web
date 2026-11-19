import assert from "node:assert/strict";
import type { Journey } from "../harness";
import { destination, read, visualVariants, watchResponse } from "./record-ui";
export const socialStaleJourney: Journey = {
  id: "social-blog-stale-confirmation",
  title:
    "Stale social confirmation preserves captured input and creates no index",
  requirements: ["BLOG-FENCES"],
  providerMode: "synthetic",
  async run(ctx) {
    await ctx.login("editor");
    const created = await ctx.api("POST", "/publications", {
      channel: "linkedin",
      destination: "urn:li:organization:fixture",
      payload: { text: "Approved synthetic English original" },
    });
    assert.equal(created.status(), 201, await created.text());
    const pub = await created.json();
    await ctx.login("reviewer");
    const approved = await ctx.api("POST", `/publications/${pub.id}/approve`, {
      revisionHash: pub.revision_hash,
    });
    assert.equal(approved.status(), 200, await approved.text());
    await ctx.login("owner");
    await destination(ctx, "linkedin");
    await ctx.page
      .locator("#publication-list button")
      .filter({ hasText: "Approved synthetic English original" })
      .first()
      .click();
    const panel = ctx.page.getByRole("region", {
      name: "Publicación social e índice del blog",
    });
    await panel.waitFor();
    await ctx.context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await panel
      .getByRole("button", { name: "Copiar texto aprobado", exact: true })
      .click();
    assert.equal(
      await ctx.page.evaluate(() => navigator.clipboard.readText()),
      "Approved synthetic English original",
    );
    await ctx.context.route("https://www.linkedin.com/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<title>Synthetic official destination</title>",
      }),
    );
    const popupPromise = ctx.context.waitForEvent("page");
    await panel.getByRole("link", { name: "Abrir LinkedIn" }).click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    assert.equal(new URL(popup.url()).hostname, "www.linkedin.com");
    await popup.close();
    assert.equal(
      (await read(ctx, `/publications/${pub.id}`)).state,
      "approved",
    );
    assert.equal(
      (await ctx.pool.query("SELECT count(*) FROM social_blog_links")).rows[0]
        .count,
      "0",
    );
    await panel
      .getByLabel("URL publicada", { exact: true })
      .fill(
        "https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A123456789/",
      );
    await panel
      .getByLabel("Fecha original con zona", { exact: true })
      .fill("2026-11-18T10:00:00-05:00");
    await panel
      .getByLabel("Idioma original", { exact: true })
      .selectOption("en");
    for (const [label, es, en] of [
      [
        "Título del blog",
        "Publicación sintética revisada",
        "Reviewed synthetic post",
      ],
      [
        "Resumen del blog",
        "Resumen editorial sintético",
        "Synthetic editorial excerpt",
      ],
      [
        "Contenido del blog",
        "Texto editorial <script> inerte",
        "Editorial <script> inert text",
      ],
    ]) {
      await panel.getByLabel(`${label} (español)`, { exact: true }).fill(es);
      await panel.getByLabel(`${label} (inglés)`, { exact: true }).fill(en);
    }
    await ctx.page.reload();
    const restored = ctx.page.getByRole("region", {
      name: "Publicación social e índice del blog",
    });
    await ctx.page
      .locator("#publication-list button")
      .filter({ hasText: "Approved synthetic English original" })
      .first()
      .click();
    await restored.waitFor();
    assert.equal(
      await restored
        .getByLabel("Título del blog (inglés)", { exact: true })
        .inputValue(),
      "Reviewed synthetic post",
    );
    await restored
      .getByLabel("Confirmo que publiqué", { exact: false })
      .check();
    await visualVariants(ctx, "social-confirmation-review");
    const captured = await read(ctx, `/publications/${pub.id}`);
    await ctx.pool.query(
      "UPDATE integration_publications SET version=version+1 WHERE id=$1",
      [pub.id],
    );
    const response = watchResponse(
      ctx.page,
      (r) =>
        r.url().endsWith(`/publications/${pub.id}/manual-confirm`) &&
        r.request().method() === "POST",
    );
    await restored
      .getByRole("button", {
        name: "Confirmar e indexar borrador de blog",
        exact: true,
      })
      .click();
    const rejected = await response;
    assert.equal(rejected.status(), 409);
    assert.equal((await rejected.json()).code, "REVISION_CONFLICT");
    assert.equal(rejected.request().postDataJSON().version, captured.version);
    assert.equal(
      await restored
        .getByLabel("Título del blog (inglés)", { exact: true })
        .inputValue(),
      "Reviewed synthetic post",
    );
    assert.equal(
      await restored.getByLabel("URL publicada", { exact: true }).inputValue(),
      "https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A123456789/",
    );
    await restored
      .getByText("Otra sesión cambió este registro.", { exact: false })
      .waitFor();
    assert.equal(
      (await ctx.pool.query("SELECT count(*) FROM records WHERE type='blog'"))
        .rows[0].count,
      "0",
    );
    assert.equal(
      (await ctx.pool.query("SELECT count(*) FROM social_blog_links")).rows[0]
        .count,
      "0",
    );
    await ctx.screenshot("stale-confirmation-preserves-captured-form");
  },
};
