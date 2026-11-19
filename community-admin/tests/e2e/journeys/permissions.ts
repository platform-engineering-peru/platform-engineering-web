import assert from "node:assert/strict";
import type { Journey } from "../harness";
import {
  createInBrowser,
  field,
  saveAndRead,
  change,
  read,
  destination,
  visualVariants,
  watchResponse,
} from "./record-ui";

export const permissionsJourney: Journey = {
  id: "community-stale-permissions",
  title:
    "Concurrent updates and session capabilities preserve local inputs and deny unauthorized effects",
  requirements: [
    "SEC-RBAC",
    "SEC-CSRF",
    "EDIT-REVISION",
    "EDIT-LINKS",
    "ADM-022",
  ],
  providerMode: "none",
  async run(ctx) {
    await ctx.login("owner");
    const record = await createInBrowser(ctx, "organizations");
    await field(ctx, "Nombre", "Synthetic original organization");
    const saved = await saveAndRead(ctx, record.id);
    const remote = await change(
      ctx,
      "PATCH",
      "/records/" + record.id,
      { payload: { ...saved.payload, name: "Synthetic concurrent edit" } },
      saved.revision,
    );
    assert.equal(remote.status(), 200, await remote.text());
    const rejected = watchResponse(
      ctx.page,
      (r) =>
        r.url().endsWith("/api/records/" + record.id) &&
        r.request().method() === "PATCH" &&
        r.status() === 409,
    );
    await field(ctx, "Nombre", "Synthetic preserved local input");
    await ctx.page
      .getByRole("button", { name: "Guardar revisión", exact: true })
      .click();
    assert.equal((await (await rejected).json()).code, "REVISION_CONFLICT");
    assert.equal(
      await ctx.page
        .getByRole("button", { name: "Guardar revisión", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(
      await ctx.page
        .getByRole("button", { name: "Descargar mi copia", exact: true })
        .count(),
      1,
    );
    assert.equal(
      await ctx.page
        .getByRole("button", { name: "Cargar versión guardada", exact: true })
        .count(),
      1,
    );
    assert.equal(
      await ctx.page.getByLabel("Nombre", { exact: true }).inputValue(),
      "Synthetic preserved local input",
    );
    const concurrent = await read(ctx, "/records/" + record.id);
    assert.equal(concurrent.payload.name, "Synthetic concurrent edit");
    await visualVariants(ctx, "stale-edit-preserved");
    const noCsrf = await ctx.page.request.post(ctx.origin + "/api/records", {
      headers: { Origin: ctx.origin },
      data: { type: "organizations", payload: saved.payload },
    });
    assert.equal(noCsrf.status(), 403);
    const before = (await ctx.pool.query("SELECT count(*) FROM records"))
      .rows[0].count;
    await ctx.login("viewer");
    await destination(ctx, "organizations");
    assert.equal(
      await ctx.page
        .getByRole("button", { name: "Nuevo registro", exact: true })
        .count(),
      0,
    );
    const denied = await change(
      ctx,
      "PATCH",
      "/records/" + record.id,
      { payload: { ...concurrent.payload, name: "Forbidden viewer edit" } },
      concurrent.revision,
    );
    assert.equal(denied.status(), 403);
    assert.equal(
      (await ctx.pool.query("SELECT count(*) FROM records")).rows[0].count,
      before,
    );
    await ctx.login("owner");
    const catalog = await read(ctx, "/catalog");
    const profile = await change(ctx, "POST", "/records", {
      type: "speaker-profiles",
      payload: catalog.entities.find((e: any) => e.type === "speaker-profiles")
        .defaults,
    });
    assert.equal(profile.status(), 201);
    const privateProfile = await profile.json();
    const publicCount = (
      await ctx.pool.query("SELECT count(*) FROM records WHERE type='speakers'")
    ).rows[0].count;
    const projection = await change(
      ctx,
      "POST",
      "/speaker-profiles/" + privateProfile.id + "/public-projection",
      {},
      privateProfile.revision,
    );
    assert.equal(projection.status(), 422);
    assert.equal((await projection.json()).code, "CONSENT_REQUIRED");
    assert.equal(
      (
        await ctx.pool.query(
          "SELECT count(*) FROM records WHERE type='speakers'",
        )
      ).rows[0].count,
      publicCount,
      "Missing consent creates no public projection",
    );
  },
};
