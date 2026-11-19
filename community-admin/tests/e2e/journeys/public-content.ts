import assert from "node:assert/strict";
import type { Journey } from "../harness";
import {
  createInBrowser,
  field,
  saveAndRead,
  reopen,
  read,
  change,
  assertContained,
  watchResponse,
} from "./record-ui";

export const publicContentJourney: Journey = {
  id: "public-generic-crud",
  title:
    "Resource, brand and singleton forms persist bilingual drafts and reject invalid values",
  requirements: [
    "SURFACE-RESOURCES",
    "SURFACE-BRANDS",
    "SURFACE-SETTINGS",
    "EDIT-REVISION",
    "ADM-037",
  ],
  providerMode: "none",
  async run(ctx) {
    await ctx.login("owner");
    for (const type of ["resources", "brands", "settings"] as const) {
      await ctx.page.setViewportSize({
        width: type === "brands" ? 320 : type === "settings" ? 390 : 1440,
        height: 1000,
      });
      const record = await createInBrowser(ctx, type);
      if (type === "settings") {
        await field(ctx, "Correo público del capítulo", "chapter@example.org");
      } else {
        await field(ctx, "Título (español)", "Borrador sintético " + type);
        await field(ctx, "Título (inglés)", "Synthetic draft " + type);
        await field(
          ctx,
          "Descripción (español)",
          "Descripción sintética preservada",
        );
        await field(
          ctx,
          "Descripción (inglés)",
          "Preserved synthetic description",
        );
        await field(ctx, "Slug", "synthetic-" + type);
        if (type === "resources")
          await field(ctx, "URL", "https://example.org/resource");
        else
          await field(ctx, "Dimensiones visibles", "Synthetic dimensions only");
      }
      const persisted = await saveAndRead(ctx, record.id);
      assert.equal(persisted.approvedHash, null);
      assert.equal(persisted.state, "draft");
      if (type === "settings") {
        assert.equal(persisted.payload.contactEmail, "chapter@example.org");
        const capability = await read(ctx, "/lifecycle/records/" + record.id);
        assert.ok(
          !capability.actions.some(
            (a: any) => a.allowed && ["archive", "erase"].includes(a.action),
          ),
          "Singleton does not advertise destructive deletion",
        );
        const denied = await change(
          ctx,
          "POST",
          "/records/" + record.id + "/archive",
          { reason: "Synthetic forbidden singleton archive" },
          persisted.revision,
        );
        assert.equal(denied.status(), 409);
      } else {
        assert.equal(persisted.payload.title.en, "Synthetic draft " + type);
        await reopen(ctx, type, "Borrador sintético " + type);
        await field(ctx, "Título (inglés)", "Reloaded edit " + type);
        const updated = await saveAndRead(ctx, record.id);
        assert.equal(
          updated.payload.title["es-pe"],
          "Borrador sintético " + type,
        );
        assert.equal(updated.payload.title.en, "Reloaded edit " + type);
        if (type === "resources") {
          const rejected = watchResponse(
            ctx.page,
            (r) =>
              r.url().endsWith("/api/records/" + record.id) &&
              r.request().method() === "PATCH" &&
              r.status() === 422,
          );
          await field(ctx, "URL", "http://127.0.0.1/private");
          await ctx.page
            .getByRole("button", { name: "Guardar revisión", exact: true })
            .click();
          await rejected;
          assert.equal(
            (await read(ctx, "/records/" + record.id)).payload.href,
            "https://example.org/resource",
            "Rejected private URL never reaches persisted content",
          );
          assert.equal(
            await ctx.page
              .getByLabel("URL", { exact: false })
              .first()
              .inputValue(),
            "http://127.0.0.1/private",
            "Invalid edit is preserved for correction",
          );
          await field(ctx, "URL", "https://example.org/corrected");
          assert.equal(
            (await saveAndRead(ctx, record.id)).payload.href,
            "https://example.org/corrected",
          );
        }
      }
      await assertContained(ctx.page, type);
    }
    assert.equal(
      (await ctx.pool.query("SELECT count(*) FROM integration_changesets"))
        .rows[0].count,
      "0",
      "Saving public drafts creates no publication intent",
    );
  },
};
