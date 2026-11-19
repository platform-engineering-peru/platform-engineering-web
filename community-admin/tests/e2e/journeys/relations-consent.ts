import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Journey } from "../harness";
import {
  createInBrowser,
  field,
  saveAndRead,
  reopen,
  read,
  change,
  watchResponse,
  visualVariants,
} from "./record-ui";

export const relationsConsentJourney: Journey = {
  id: "community-relations-consent",
  title:
    "Consent withdrawal and agenda/reference conflicts preserve source facts and reject unsafe edits",
  requirements: [
    "EDIT-LINKS",
    "EDIT-REVISION",
    "PRIV-PROJECTION",
    "DELETE-SEMANTICS",
    "SURFACE-CONSENTS",
    "SURFACE-SESSIONS",
  ],
  providerMode: "none",
  async run(ctx) {
    await ctx.login("owner");
    const catalog = await read(ctx, "/catalog");
    async function seed(type: string, values: Record<string, unknown>) {
      const response = await change(ctx, "POST", "/records", {
        type,
        payload: {
          ...catalog.entities.find((d: any) => d.type === type).defaults,
          ...values,
        },
      });
      assert.equal(response.status(), 201, await response.text());
      return response.json();
    }
    const person = await seed("people", {
      name: "Synthetic consenting speaker",
    });
    const profile = await seed("speaker-profiles", {
      personId: person.id,
      publicConsent: true,
      consentEvidence: "Synthetic signed evidence",
    });
    const permission = await seed("consents", {
      personId: person.id,
      purpose: "Synthetic public profile",
      evidence: "Synthetic permission",
      grantedAt: "2026-11-18T12:00:00Z",
    });
    const projected = await change(
      ctx,
      "POST",
      "/speaker-profiles/" + profile.id + "/public-projection",
      {},
      profile.revision,
    );
    assert.equal(projected.status(), 201, await projected.text());
    const publicProfile = await projected.json();
    await reopen(ctx, "consents", permission.id);
    await field(ctx, "Revocación ISO", "2026-11-18T13:00:00Z");
    const revoked = await saveAndRead(ctx, permission.id);
    assert.equal(revoked.payload.revokedAt, "2026-11-18T13:00:00.000Z");
    const withdrawn = await read(ctx, "/records/" + publicProfile.id);
    assert.equal(withdrawn.desiredStatus, "archived");
    assert.equal(withdrawn.withdrawalRequested, true);
    assert.equal(withdrawn.approvedHash, null);
    assert.equal(
      (await ctx.pool.query("SELECT count(*) FROM integration_changesets"))
        .rows[0].count,
      "0",
      "Revocation stages removal; it does not claim deployment",
    );
    const missing = await change(
      ctx,
      "PATCH",
      "/records/" + person.id,
      { payload: { ...person.payload, organizationId: randomUUID() } },
      person.revision,
    );
    assert.equal(missing.status(), 422);
    assert.equal((await missing.json()).code, "REFERENCE_UNKNOWN");
    assert.equal(
      (await read(ctx, "/records/" + person.id)).payload.organizationId,
      null,
    );
    const first = await seed("sessions", {
      title: "Synthetic first session",
      room: "Fixture room",
      startsAt: "2026-12-01T10:00:00-05:00",
      endsAt: "2026-12-01T11:00:00-05:00",
      speakerIds: [person.id],
    });
    const second = await createInBrowser(ctx, "sessions");
    await field(ctx, "Título", "Synthetic conflicting session");
    await field(ctx, "Sala", "Fixture room");
    await field(ctx, "Inicio ISO con zona", "2026-12-01T10:30:00-05:00");
    const rejected = watchResponse(
      ctx.page,
      (r) =>
        r.url().endsWith("/api/records/" + second.id) &&
        r.request().method() === "PATCH" &&
        r.status() === 409,
    );
    await field(ctx, "Fin ISO con zona", "2026-12-01T11:30:00-05:00");
    await ctx.page
      .getByRole("button", { name: "Guardar revisión", exact: true })
      .click();
    assert.equal((await (await rejected).json()).code, "SESSION_OVERLAP");
    assert.equal(
      await ctx.page
        .getByLabel("Fin ISO con zona", { exact: true })
        .inputValue(),
      "2026-12-01T11:30:00-05:00",
    );
    assert.notEqual(
      (await read(ctx, "/records/" + second.id)).payload.endsAt,
      "2026-12-01T11:30:00-05:00",
    );
    await ctx.screenshot("agenda-conflict-preserved");
    const rejectedRecord = await read(ctx, "/records/" + second.id);
    assert.equal(
      await ctx.page
        .getByText("Tu versión local se conserva.", { exact: true })
        .count(),
      0,
      "A schedule overlap must not lock the editor as a stale revision",
    );
    assert.equal(
      await ctx.page
        .getByText("Hay una superposición en la agenda", { exact: true })
        .count(),
      1,
    );
    await visualVariants(ctx, "agenda-overlap-editable");
    await field(ctx, "Sala", "Fixture corrected room");
    assert.equal(
      await ctx.page
        .getByRole("button", { name: "Guardar revisión", exact: true })
        .isEnabled(),
      true,
    );
    const corrected = await saveAndRead(ctx, second.id);
    assert.ok(corrected.revision > rejectedRecord.revision);
    assert.equal(corrected.payload.room, "Fixture corrected room");
    assert.equal(corrected.payload.title, "Synthetic conflicting session");
    assert.equal(corrected.payload.startsAt, "2026-12-01T15:30:00.000Z");
    assert.equal(corrected.payload.endsAt, "2026-12-01T16:30:00.000Z");
    const reloaded = await read(ctx, "/records/" + second.id);
    assert.deepEqual(reloaded.payload, corrected.payload);
    const untouched = await read(ctx, "/records/" + first.id);
    assert.equal(untouched.revision, first.revision);
    assert.deepEqual(untouched.payload, first.payload);
    await ctx.screenshot("agenda-conflict-corrected");
    await visualVariants(ctx, "agenda-correction-saved");
  },
};
