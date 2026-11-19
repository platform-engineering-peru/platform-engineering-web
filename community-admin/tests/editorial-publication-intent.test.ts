import assert from "node:assert/strict";
import test from "node:test";
import {
  captureEditorialIntent,
  recoverEditorialIntent,
} from "../src/web/editorial-publication-intent";
test("event retry after reload preserves the original key and complete batch version set", () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => values.set(k, v),
      removeItem: (k: string) => values.delete(k),
    },
  });
  try {
    const selected = [
      { id: "event-a", version: 3 },
      { id: "event-b", version: 7 },
    ];
    const first = captureEditorialIntent("actor", selected);
    assert.deepEqual(recoverEditorialIntent("actor", "event-b", 7), first);
    assert.equal(
      captureEditorialIntent("actor", [...selected].reverse()).key,
      first.key,
    );
    assert.equal(recoverEditorialIntent("other-actor", "event-b", 7), null);
    assert.equal(recoverEditorialIntent("actor", "event-b", 8), null);
    assert.throws(
      () => captureEditorialIntent("actor", [selected[0]]),
      /envío conjunto/,
    );
    assert.notEqual(
      captureEditorialIntent("actor", [{ id: "event-a", version: 4 }]).key,
      first.key,
    );
    assert.ok(
      [...values.values()].every(
        (v) => !v.includes("payload") && !v.includes("csrf"),
      ),
    );
  } finally {
    delete (globalThis as any).sessionStorage;
  }
});
