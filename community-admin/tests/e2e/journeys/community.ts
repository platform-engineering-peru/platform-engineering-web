import assert from "node:assert/strict";
import type { Journey } from "../harness";
import {
  createInBrowser,
  field,
  reference,
  saveAndRead,
  reopen,
  read,
  assertContained,
  visualVariants,
} from "./record-ui";

/** Every private manager performs a UI write, fresh HTTP read and browser reload. */
export const communityJourney: Journey = {
  id: "community-private-crud",
  title:
    "Private community managers persist edits and references without publication",
  requirements: [
    "SURFACE-PEOPLE",
    "SURFACE-ORGANIZATIONS",
    "SURFACE-SPEAKER-PROFILES",
    "SURFACE-PROPOSALS",
    "SURFACE-PARTICIPATIONS",
    "SURFACE-SESSIONS",
    "SURFACE-FOLLOWUPS",
    "SURFACE-CONSENTS",
    "EDIT-LINKS",
    "PRIV-PROJECTION",
    "ADM-040",
    "ADM-043",
  ],
  providerMode: "none",
  async run(ctx) {
    await ctx.login("owner");
    const ids: Record<string, string> = {};
    const cases = [
      {
        type: "organizations",
        label: "Nombre",
        value: "Synthetic organization",
        extra: { Sitio: "https://example.org/team" },
      },
      {
        type: "people",
        label: "Nombre preferido",
        value: "Synthetic private contact",
        extra: {
          "Correo privado": "contact@example.org",
          Ubicación: "Lima, Perú",
        },
      },
      {
        type: "speaker-profiles",
        label: "Disponibilidad privada",
        value: "Synthetic private availability",
        extra: {
          "Biografía propuesta (español)": "Biografía sintética",
          "Biografía propuesta (inglés)": "Synthetic biography",
        },
      },
      {
        type: "proposals",
        label: "Título",
        value: "Synthetic proposal",
        extra: { Resumen: "Synthetic private proposal summary" },
      },
      {
        type: "participations",
        label: "Notas",
        value: "Synthetic participation",
        extra: {},
      },
      {
        type: "sessions",
        label: "Título",
        value: "Synthetic session",
        extra: { Sala: "Local fixture room" },
      },
      {
        type: "followups",
        label: "Tarea",
        value: "Synthetic followup",
        extra: {},
      },
      {
        type: "consents",
        label: "Finalidad",
        value: "Synthetic profile consent",
        extra: {
          Evidencia: "Synthetic isolated signed consent",
          "Base de permiso": "Explicit synthetic permission",
        },
      },
    ];
    for (const [index, item] of cases.entries()) {
      await ctx.page.setViewportSize({
        width: index % 3 === 0 ? 320 : index % 3 === 1 ? 390 : 1440,
        height: 1000,
      });
      const record = await createInBrowser(ctx, item.type);
      ids[item.type] = record.id;
      await field(ctx, item.label, item.value);
      for (const [label, value] of Object.entries(item.extra))
        await field(ctx, label, value);
      if (item.type === "people")
        await reference(ctx, "Organización", ids.organizations);
      if (
        [
          "speaker-profiles",
          "participations",
          "followups",
          "consents",
        ].includes(item.type)
      )
        await reference(ctx, "Persona", ids.people);
      if (item.type === "proposals")
        await reference(ctx, "Speaker", ids.people);
      if (["participations", "sessions"].includes(item.type))
        await reference(ctx, "Propuesta", ids.proposals);
      if (item.type === "followups")
        await reference(ctx, "Sesión", ids.sessions);
      const persisted = await saveAndRead(ctx, record.id);
      assert.equal(persisted.approvedHash, null);
      const values = JSON.stringify(persisted.payload);
      assert.ok(
        values.includes(item.value),
        item.type + " persisted edited input",
      );
      assert.ok(
        persisted.revision > record.revision,
        item.type + " revision advances",
      );
      const stored = (
        await ctx.pool.query("SELECT payload,scope FROM records WHERE id=$1", [
          record.id,
        ])
      ).rows[0];
      assert.equal(stored.scope, "private");
      assert.ok(
        !JSON.stringify(stored.payload).includes(item.value),
        item.type + " is encrypted at rest",
      );
      await reopen(
        ctx,
        item.type,
        ["speaker-profiles", "participations", "consents"].includes(item.type)
          ? record.id
          : item.value,
      );
      const visibleField = ctx.page
        .getByLabel(item.label, { exact: false })
        .first();
      assert.equal(
        await visibleField.inputValue(),
        item.value,
        item.type + " reload retains value",
      );
      await assertContained(ctx.page, item.type);
    }
    const person = await read(ctx, "/records/" + ids.people);
    assert.equal(person.payload.organizationId, ids.organizations);
    assert.equal(
      (await read(ctx, "/records/" + ids.participations)).payload.proposalId,
      ids.proposals,
    );
    assert.equal(
      (await read(ctx, "/records/" + ids.followups)).payload.sessionId,
      ids.sessions,
    );
    assert.equal(
      (await read(ctx, "/records/" + ids.consents)).payload.personId,
      ids.people,
    );
    assert.equal(
      (await ctx.pool.query("SELECT count(*) FROM integration_changesets"))
        .rows[0].count,
      "0",
      "Private edits create no publication intent",
    );
    await visualVariants(ctx, "private-consent-editor");
  },
};
