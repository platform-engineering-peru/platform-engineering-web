import assert from "node:assert/strict";
import type { Journey } from "./e2e/harness";
import {
  destination,
  read,
  visualVariants,
  watchResponse,
} from "./e2e/journeys/record-ui";
export const socialBlogJourney: Journey = {
  id: "social-blog-confirmation",
  title:
    "Operator handoff creates one versioned local blog without provider or website writes",
  requirements: ["BLOG-HANDOFF", "BLOG-CONFIRM", "BLOG-NO-DUPLICATE"],
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
    const confirmed = await response;
    assert.equal(confirmed.status(), 200, await confirmed.text());
    const receipt = await confirmed.json();
    assert.equal(receipt.website.state, "local");
    assert.equal(receipt.confirmationMethod, "operator-attested");
    await ctx.page
      .getByRole("heading", {
        name: "Publicación social confirmada",
        exact: true,
      })
      .waitFor();
    await ctx.page.reload();
    await ctx.page
      .locator("#publication-list button")
      .filter({ hasText: "Approved synthetic English original" })
      .first()
      .click();
    await ctx.page
      .getByRole("heading", {
        name: "Publicación social confirmada",
        exact: true,
      })
      .waitFor();
    const rows = (
      await ctx.pool.query("SELECT * FROM records WHERE type='blog'")
    ).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, "draft");
    assert.equal(rows[0].payload.body.en, "Editorial <script> inert text");
    assert.equal(
      (await ctx.pool.query("SELECT count(*) FROM integration_changesets"))
        .rows[0].count,
      "0",
    );
    assert.equal(
      (await ctx.pool.query("SELECT count(*) FROM worker_outbox")).rows[0]
        .count,
      "0",
    );
    await destination(ctx, "blog");
    await ctx.page
      .locator(".record-list button")
      .filter({ hasText: "Publicación sintética revisada" })
      .first()
      .click();
    await ctx.page
      .getByRole("button", { name: "Contenido", exact: true })
      .click();
    await ctx.page.getByLabel("Contenido (inglés)", { exact: true }).waitFor();
    await visualVariants(ctx, "blog-local-editor");
  },
};
