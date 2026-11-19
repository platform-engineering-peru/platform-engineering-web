import test from "node:test";
import assert from "node:assert/strict";
import {
  confirmationAllowed,
  sameConfirmationTarget,
} from "../src/web/confirmation-intent";
const first = {
  module: "records",
  id: "one",
  version: 2,
  name: "Synthetic contact",
};
test("confirmation is bound to the exact module, entity and displayed revision", () => {
  assert.equal(sameConfirmationTarget(first, { ...first }), true);
  for (const changed of [
    { ...first, id: "two" },
    { ...first, version: 3 },
    { ...first, module: "editorial-drafts" },
  ])
    assert.equal(sameConfirmationTarget(first, changed), false);
  assert.equal(sameConfirmationTarget(first, null), false);
});
test("reason, stale identity, pending action and current guards cannot be bypassed by submitting a dialog", () => {
  assert.equal(
    confirmationAllowed(first, first, false, false, "specific reason", 5),
    true,
  );
  assert.equal(
    confirmationAllowed(first, first, false, false, "    ", 5),
    false,
  );
  assert.equal(
    confirmationAllowed(
      first,
      { ...first, version: 3 },
      false,
      false,
      "specific reason",
      5,
    ),
    false,
  );
  assert.equal(
    confirmationAllowed(first, first, true, false, "specific reason", 5),
    false,
  );
  assert.equal(
    confirmationAllowed(first, first, false, true, "specific reason", 5),
    false,
  );
  assert.equal(confirmationAllowed(first, first, false, false, "", 0), true);
});
