import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Journey } from "../harness";
import { destination, read, change, watchResponse } from "./record-ui";

/** These identities/connections exist only in the harness-owned disposable schema. */
export const consoleControlsJourney: Journey = {
  id: "console-local-controls",
  title:
    "Synthetic member and connector controls require confirmation and invalidate obsolete sessions",
  requirements: [
    "SURFACE-MEMBERS",
    "SURFACE-INTEGRATIONS",
    "SEC-RBAC",
    "SEC-CSRF",
  ],
  providerMode: "none",
  async run(ctx) {
    await ctx.login("owner");
    await destination(ctx, "members");
    await ctx.page
      .getByLabel("Identidad de GitHub", { exact: true })
      .fill("999999999999993");
    await ctx.page
      .locator("form")
      .getByLabel("Rol", { exact: false })
      .selectOption("viewer");
    for (const member of (await read(ctx, "/members")).items) {
      const memberCard = ctx.page.locator(".member-card").filter({
        has: ctx.page.getByRole("heading", {
          name: member.name,
          exact: true,
        }),
      });
      assert.equal(
        await memberCard
          .getByLabel("Rol asignado", { exact: false })
          .inputValue(),
        member.roles.length ? member.roles[0] : member.role,
        "Displayed role matches effective primary membership role",
      );
    }
    await ctx.page.evaluate(() => scrollTo(0, 0));
    await ctx.screenshot("member-roles-effective");
    const created = watchResponse(
      ctx.page,
      (r) =>
        r.url().endsWith("/api/invitations") && r.request().method() === "POST",
    );
    await ctx.page
      .getByRole("button", { name: "Crear invitación", exact: true })
      .click();
    assert.equal((await created).status(), 201);
    const invites = await read(ctx, "/invitations");
    assert.ok(
      invites.items.some((i: any) => i.providerSubject === "999999999999993"),
    );
    const viewer = (await read(ctx, "/members")).items.find(
      (m: any) => m.role === "viewer",
    );
    assert.ok(viewer);
    const other = await ctx.browser.newContext();
    try {
      const login = await other.request.post(ctx.origin + "/api/dev/login", {
        headers: { Origin: ctx.origin },
        data: { persona: "viewer" },
      });
      assert.equal(login.status(), 200);
      assert.equal(
        (await other.request.get(ctx.origin + "/api/me")).status(),
        200,
      );
      const card = ctx.page.locator(".member-card").filter({
        has: ctx.page.getByRole("heading", {
          name: viewer.name,
          exact: true,
        }),
      });
      ctx.page.once("dialog", (dialog) => dialog.dismiss());
      await card
        .getByRole("button", { name: "Revocar acceso", exact: true })
        .click();
      assert.equal(
        (await read(ctx, "/members")).items.find((m: any) => m.id === viewer.id)
          .active,
        true,
        "Cancel does not revoke access",
      );
      ctx.page.once("dialog", (dialog) => dialog.accept());
      const changed = watchResponse(
        ctx.page,
        (r) =>
          r.url().endsWith("/api/members/" + viewer.id) &&
          r.request().method() === "PATCH",
      );
      await card
        .getByLabel("Rol asignado", { exact: false })
        .selectOption("reviewer");
      assert.equal((await changed).status(), 200);
      assert.equal(
        (await other.request.get(ctx.origin + "/api/me")).status(),
        401,
        "Role change revokes existing session",
      );
      const stale = await change(
        ctx,
        "PATCH",
        "/members/" + viewer.id,
        { roles: ["viewer"], active: true },
        viewer.version,
      );
      assert.equal(stale.status(), 409);
      const current = (await read(ctx, "/members")).items.find(
        (m: any) => m.id === viewer.id,
      );
      assert.deepEqual(current.roles, ["reviewer"]);
      assert.equal(
        await card.getByLabel("Rol asignado", { exact: false }).inputValue(),
        "reviewer",
        "Explicit nonempty roles remain authoritative in the selector",
      );
      const invalidRole = await change(
        ctx,
        "PATCH",
        "/members/" + viewer.id,
        { roles: ["unknown-invalid-role"], active: true },
        current.version,
      );
      assert.equal(
        invalidRole.status(),
        422,
        "Unknown role is rejected by server validation",
      );
      assert.deepEqual(
        (await read(ctx, "/members")).items.find((m: any) => m.id === viewer.id)
          .roles,
        ["reviewer"],
        "Invalid role submission preserves membership",
      );
      ctx.page.once("dialog", (dialog) => dialog.accept());
      const revoked = watchResponse(
        ctx.page,
        (r) =>
          r.url().endsWith("/api/members/" + viewer.id) &&
          r.request().method() === "PATCH",
      );
      await card
        .getByRole("button", { name: "Revocar acceso", exact: true })
        .click();
      assert.equal((await revoked).status(), 200);
      assert.equal(
        (await read(ctx, "/members")).items.find((m: any) => m.id === viewer.id)
          .active,
        false,
      );
      assert.equal(
        (await other.request.get(ctx.origin + "/api/me")).status(),
        401,
      );
    } finally {
      await other.close();
    }
    const legacy = (await read(ctx, "/members")).items.find(
      (m: any) => m.role === "publisher" && m.roles.length === 0,
    );
    assert.ok(
      legacy,
      "Normal migration retains a legacy primary-role-only fixture",
    );
    const legacyCard = ctx.page.locator(".member-card").filter({
      has: ctx.page.getByRole("heading", { name: legacy.name, exact: true }),
    });
    ctx.page.once("dialog", (dialog) => dialog.accept());
    const legacyRevoke = watchResponse(
      ctx.page,
      (r) =>
        r.url().endsWith("/api/members/" + legacy.id) &&
        r.request().method() === "PATCH",
    );
    await legacyCard
      .getByRole("button", { name: "Revocar acceso", exact: true })
      .click();
    const legacyResponse = await legacyRevoke;
    assert.equal(legacyResponse.status(), 200);
    assert.deepEqual(
      legacyResponse.request().postDataJSON().roles,
      ["publisher"],
      "Legacy revoke sends the effective primary role rather than an empty list",
    );
    assert.equal(
      (await read(ctx, "/members")).items.find((m: any) => m.id === legacy.id)
        .active,
      false,
    );
    const id = randomUUID();
    const communityId = (
      await ctx.pool.query(
        "SELECT community_id FROM users WHERE persona='owner'",
      )
    ).rows[0].community_id;
    await ctx.pool.query(
      "INSERT INTO integration_accounts(id,community_id,provider,destination,scopes,encrypted_secret) VALUES($1,$2,'linkedin','synthetic-only','[]','synthetic-not-a-credential')",
      [id, communityId],
    );
    await destination(ctx, "integrations");
    const disconnect = ctx.page.getByRole("button", {
      name: "Desconectar linkedin · synthetic-only",
      exact: true,
    });
    await disconnect.waitFor();
    ctx.page.once("dialog", (dialog) => dialog.dismiss());
    await disconnect.click();
    assert.equal(
      (
        await ctx.pool.query(
          "SELECT health FROM integration_accounts WHERE id=$1",
          [id],
        )
      ).rows[0].health,
      "connected",
    );
    ctx.page.once("dialog", (dialog) => dialog.accept());
    const removed = watchResponse(
      ctx.page,
      (r) =>
        r.url().endsWith("/api/integrations/" + id + "/disconnect") &&
        r.request().method() === "POST",
    );
    await disconnect.click();
    assert.equal((await removed).status(), 200);
    assert.equal(
      (
        await ctx.pool.query(
          "SELECT encrypted_secret FROM integration_accounts WHERE id=$1",
          [id],
        )
      ).rows[0].encrypted_secret,
      "",
    );
    await ctx.pool.query(
      "UPDATE sessions SET created_at=now()-interval '16 minutes'",
    );
    const recent = await change(ctx, "POST", "/invitations", {
      providerSubject: "999999999999994",
      roles: ["viewer"],
    });
    assert.equal(recent.status(), 403);
    assert.equal((await recent.json()).code, "REAUTHENTICATION_REQUIRED");
    assert.equal(
      (
        await ctx.pool.query(
          "SELECT count(*) FROM invitations WHERE provider_subject='999999999999994'",
        )
      ).rows[0].count,
      "0",
    );
    assert.equal(
      (await ctx.pool.query("SELECT count(*) FROM worker_outbox")).rows[0]
        .count,
      "0",
      "Local controls make no provider sends",
    );
    await ctx.page.evaluate(() => scrollTo(0, 0));
    await ctx.screenshot("local-controls-confirmed");
  },
};
