import assert from "node:assert/strict";
import type { Journey } from "../harness";
import {
  createInBrowser,
  field,
  saveAndRead,
  read,
  reveal,
  watchResponse,
  visualVariants,
} from "./record-ui";
export const calendarAttributionJourney: Journey = {
  id: "calendar-admin-attribution",
  title:
    "Guest attribution is editable, validated and retained in the real local event manager",
  requirements: ["CAL-ATTRIBUTION"],
  providerMode: "none",
  async run(ctx) {
    await ctx.login("owner");
    const record = await createInBrowser(ctx, "events");
    assert.equal(record.payload.communityKind, "own");
    await field(ctx, "Título (español)", "Actividad invitada QA");
    await field(ctx, "Título (inglés)", "QA guest activity");
    const kind = ctx.page
      .getByLabel("Comunidad propia o invitada", { exact: false })
      .first();
    await reveal(ctx.page, kind);
    await kind.selectOption("guest");
    await field(ctx, "Nombre de comunidad", "QA Guest community");
    const denied = watchResponse(
      ctx.page,
      (r) =>
        r.url().endsWith("/api/records/" + record.id) &&
        r.request().method() === "PATCH" &&
        r.status() === 422,
    );
    await ctx.page
      .getByRole("button", { name: "Guardar revisión", exact: true })
      .click();
    await denied;
    assert.equal(
      (await read(ctx, "/records/" + record.id)).payload.communityKind,
      "own",
    );
    assert.equal(
      await ctx.page
        .getByLabel("Nombre de comunidad", { exact: false })
        .first()
        .inputValue(),
      "QA Guest community",
    );
    await field(ctx, "URL de comunidad", "https://community.example/");
    await field(ctx, "URL de actividad", "https://community.example/event/1");
    const saved = await saveAndRead(ctx, record.id);
    assert.equal(saved.payload.communityKind, "guest");
    assert.equal(saved.payload.communityName, "QA Guest community");
    assert.equal(saved.payload.communityUrl, "https://community.example/");
    assert.equal(
      saved.payload.activityUrl,
      "https://community.example/event/1",
    );
    await ctx.page.reload();
    await ctx.page
      .locator(".record-list button")
      .filter({ hasText: "Actividad invitada QA" })
      .first()
      .click();
    const retained = ctx.page
      .getByLabel("Comunidad propia o invitada", { exact: false })
      .first();
    await reveal(ctx.page, retained);
    assert.equal(await retained.inputValue(), "guest");
    assert.equal(
      await ctx.page
        .getByLabel("URL de comunidad", { exact: false })
        .first()
        .inputValue(),
      "https://community.example/",
    );
    assert.equal(
      (await ctx.pool.query("SELECT count(*) FROM worker_outbox")).rows[0]
        .count,
      "0",
    );
    assert.equal(
      (await ctx.pool.query("SELECT count(*) FROM integration_changesets"))
        .rows[0].count,
      "0",
    );
    await visualVariants(ctx, "guest-attribution-retained");
  },
};
