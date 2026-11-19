import test from "node:test";
import assert from "node:assert/strict";
import {
  lifecycleMutation,
  descriptorMatches,
  lifecycleSurfacePolicy,
  lifecycleEffectAllowed,
  lifecycleDescriptorValid,
  mediaSelectable,
} from "../src/web/lifecycle";
const target = {
  module: "records" as const,
  id: "identity/one",
  version: 7,
  name: "Synthetic",
};
test("lifecycle dispatch uses fixed domain routes and captured exact version types", () => {
  assert.deepEqual(lifecycleMutation(target, "erase", "specific reason"), {
    path: "/records/identity%2Fone/delete",
    method: "POST",
    headers: { "If-Match": '"7"' },
    body: { reason: "specific reason" },
  });
  assert.equal(
    lifecycleMutation({ ...target, module: "editorial-drafts" }, "discard", "")
      .method,
    "DELETE",
  );
  assert.deepEqual(
    lifecycleMutation(
      { ...target, module: "jobs" },
      "withdraw",
      "curator choice",
    ).body,
    { version: 7, decision: "withdraw", reason: "curator choice" },
  );
  assert.deepEqual(
    lifecycleMutation(
      { ...target, module: "changesets", version: "sha-token" },
      "cancel",
      "cancel",
    ).body,
    { revisionHash: "sha-token", reason: "cancel" },
  );
  assert.equal(
    lifecycleMutation(
      { ...target, module: "media", version: "a".repeat(64) },
      "remove",
      "unused",
    ).headers["If-Match"],
    '"' + "a".repeat(64) + '"',
  );
  assert.equal(
    lifecycleMutation(
      { ...target, module: "video-assets", version: "captured-upload-token" },
      "remove",
      "unused",
    ).path,
    "/video/uploads/identity%2Fone",
  );
  assert.throws(() => lifecycleMutation(target, "remove", "unused"));
  assert.throws(() =>
    lifecycleMutation(
      { ...target, module: "publications" },
      "cancel",
      "cancel",
    ),
  );
});
test("fresh descriptor may block a displayed revision but never replace its token", () => {
  assert.equal(
    descriptorMatches(target, { module: "records", id: target.id, version: 7 }),
    true,
  );
  for (const value of [
    { module: "records", id: target.id, version: 8 },
    { module: "records", id: target.id, version: "7" },
    { module: "jobs", id: target.id, version: 7 },
  ])
    assert.equal(descriptorMatches(target, value), false);
});
test("all navigation destinations and nested/legacy surfaces have action or explicit retention policy", async () => {
  const { workspaces } = await import("../src/web/navigation");
  const ids = [
    ...workspaces.flatMap((w) => w.items.map((i) => i.id)),
    "image-library",
    "video-upload",
    "legacy-memories",
  ];
  assert.equal(ids.length, 37);
  for (const id of ids) assert.ok(lifecycleSurfacePolicy[id], id);
  assert.equal(lifecycleSurfacePolicy.audit, "retained");
  assert.equal(lifecycleSurfacePolicy.members, "access");
});

test("capability wording must match the domain effect of the fixed mutation", () => {
  assert.equal(
    lifecycleEffectAllowed("records", "erase", "private-erasure"),
    true,
  );
  assert.equal(
    lifecycleEffectAllowed("records", "erase", "local-discard"),
    false,
  );
  assert.equal(
    lifecycleEffectAllowed("jobs", "withdraw", "public-withdrawal"),
    true,
  );
  assert.equal(
    lifecycleEffectAllowed("publications", "cancel", "public-withdrawal"),
    false,
  );
});

test("untrusted inherited fields and missing revision tokens fail closed", () => {
  for (const name of ["toString", "constructor", "__proto__"]) {
    assert.equal(
      lifecycleEffectAllowed(name, "erase", "private-erasure"),
      false,
    );
    assert.equal(
      lifecycleEffectAllowed("records", name, "private-erasure"),
      false,
    );
  }
  for (const version of [0, -1, NaN, "7", ""])
    assert.throws(() =>
      lifecycleMutation({ ...target, version }, "erase", "reason"),
    );
});

test("capability DTO fails closed for malformed, unknown or misleading domain actions", () => {
  const action = {
    action: "erase",
    effect: "private-erasure",
    allowed: true,
    reason: null,
    requiresReason: true,
    requiresRecentAuth: true,
    blockers: [],
  };
  const dto = {
    module: "records",
    id: "one",
    version: 1,
    state: "archived",
    remoteEffect: "none",
    actions: [action],
  };
  assert.equal(lifecycleDescriptorValid(dto), true);
  for (const delta of [
    { actions: [{ ...action, effect: "local-discard" }] },
    {
      actions: [
        {
          ...action,
          action: "fetch-any-url",
          url: "https://arbitrary.invalid",
        },
      ],
    },
    { actions: [action, action] },
    { actions: [{ ...action, requiresReason: undefined }] },
    { version: 0 },
    { remoteEffect: "already-deleted" },
  ])
    assert.equal(lifecycleDescriptorValid({ ...dto, ...delta }), false);
});

test("pending cleanup images remain evidence rather than attachment choices", () => {
  assert.equal(mediaSelectable({ id: "owned" }), true);
  for (const asset of [
    { cleanupPending: true },
    { state: "cleanup-pending" },
    { state: "removed" },
    null,
  ])
    assert.equal(mediaSelectable(asset), false);
});
