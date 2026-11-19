import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Journey } from "../harness";
import {
  createInBrowser,
  field,
  saveAndRead,
  destination,
  read,
  assertContained,
} from "./record-ui";

export const observabilityJourney: Journey = {
  id: "console-observability",
  title:
    "Real saved activity is observable without inventing integration or publication success",
  requirements: [
    "SURFACE-OVERVIEW",
    "SURFACE-AUDIT",
    "SURFACE-OPERATIONS",
    "SURFACE-INTEGRATIONS",
    "SURFACE-MEMBERS",
    "SEC-RBAC",
  ],
  providerMode: "none",
  async run(ctx) {
    await ctx.login("owner");
    const record = await createInBrowser(ctx, "people");
    await field(ctx, "Nombre preferido", "Synthetic observable contact");
    await field(
      ctx,
      "Notas privadas",
      "Private note must never appear in activity summaries",
    );
    await saveAndRead(ctx, record.id);
    const history = await read(ctx, "/records/" + record.id + "/audit");
    assert.ok(JSON.stringify(history).includes("record_updated"));
    const audit = await read(ctx, "/audit");
    assert.ok(audit.items.some((row: any) => row.entity_id === record.id));
    assert.ok(
      !JSON.stringify(audit).includes("Private note must never appear"),
    );
    const overview = await read(ctx, "/overview");
    assert.equal(overview.counts.people, 1);
    assert.equal(overview.counts.records, 1);
    assert.deepEqual(overview.reviewQueue, []);
    const baseline = (await ctx.pool.query("SELECT count(*) FROM audit_events"))
      .rows[0].count;
    const operations = await read(ctx, "/operations");
    assert.deepEqual(operations.items, []);
    const actor = (
      await ctx.pool.query(
        "SELECT id,community_id FROM users WHERE persona='owner'",
      )
    ).rows[0];
    const seededIds: string[] = [];
    for (const state of ["queued", "failed", "unknown"]) {
      const id = randomUUID();
      seededIds.push(id);
      await ctx.pool.query(
        "INSERT INTO worker_outbox(id,community_id,actor_id,kind,subject_id,intent_key,request_hash,state,last_code,result) VALUES($1,$2,$3,$4,$5,$6,'synthetic-hash',$7,$8,$9)",
        [
          id,
          actor.community_id,
          actor.id,
          "synthetic-" + state,
          randomUUID(),
          id,
          state,
          "SYNTHETIC_" + state.toUpperCase(),
          { copy: "Private operation text must not leak", synthetic: true },
        ],
      );
      const detail = await read(ctx, "/operations/" + id);
      assert.equal(detail.state, state);
      assert.equal(
        detail.result.copy,
        undefined,
        "Operation detail strips private copy",
      );
    }
    const integration = await read(ctx, "/integrations");
    assert.equal(integration.liveEnabled, false);
    assert.equal(integration.items.length, 0);
    const status = await read(ctx, "/operations/status");
    assert.equal(status.storage.private, true);
    assert.equal(status.oauth.configured, false);
    const members = await read(ctx, "/members");
    assert.ok((members.items ?? members).length > 0);
    for (const [section, heading] of [
      ["overview", "Hagamos comunidad."],
      ["audit", "Registro de actividad"],
      ["operations", "Centro de operaciones"],
      ["integrations", "Conexiones y servicios"],
      ["members", "Equipo de coordinación"],
    ]) {
      await destination(ctx, section);
      await ctx.page.locator("main h1").filter({ hasText: heading }).waitFor();
      await assertContained(ctx.page, section);
      if (section === "operations") {
        for (const state of ["queued", "failed", "unknown"])
          await ctx.page
            .locator(".activity-row")
            .filter({ hasText: "synthetic-" + state })
            .waitFor();
        assert.equal(
          await ctx.page
            .getByRole("button", { name: /Reintentar|Publicar ahora/ })
            .count(),
          0,
          "Unknown operation exposes no unsafe retry control",
        );
      }
      assert.equal(
        await ctx.page
          .getByRole("button", {
            name: /Eliminar.*(auditoría|intento|historial)/i,
          })
          .count(),
        0,
      );
    }
    assert.equal(
      (await ctx.pool.query("SELECT count(*) FROM worker_outbox")).rows[0]
        .count,
      "3",
      "Status inspection enqueues nothing beyond explicit synthetic fixtures",
    );
    assert.equal(
      (await ctx.pool.query("SELECT count(*) FROM audit_events")).rows[0].count,
      baseline,
      "Read-only console inspection mutates no audit history",
    );
    await ctx.page.setViewportSize({ width: 320, height: 900 });
    await destination(ctx, "integrations");
    await ctx.page
      .getByRole("heading", { name: "Almacenamiento privado" })
      .waitFor();
    await assertContained(ctx.page, "mobile integrations");
    await ctx.screenshot("observability-mobile");
  },
};
