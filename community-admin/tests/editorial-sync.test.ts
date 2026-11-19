import test from "node:test";
import assert from "node:assert/strict";
import {
  eventProjection,
  validateSnapshot,
  compareDraft,
} from "../src/server/editorial-sync/validation";
import { entityDefinitions } from "../src/shared/product-contract";
const id = "20000000-0000-4000-8000-000000000001";
const payload = () => ({
  ...structuredClone(
    entityDefinitions.find((d) => d.type === "events")!.defaults,
  ),
  slug: "isolated-event",
  title: { "es-pe": "Evento de prueba", en: "Test event" },
  description: { "es-pe": "Una prueba local.", en: "A local test." },
  date: "2026-12-01",
  city: { "es-pe": "Lima", en: "Lima" },
  venue: "Local test",
  speakerIds: [],
});
test("pure event projection is schema-aware and rejects private/unknown input", async () => {
  const record = await eventProjection(id, payload(), "published");
  assert.equal(record.startsAt, "2026-12-01T14:00:00Z");
  assert.equal(record.updatedAt, null);
  await assert.rejects(
    eventProjection(
      id,
      { ...payload(), privateNotes: "PRIVATE_SENTINEL" },
      "published",
    ),
  );
  await assert.rejects(
    validateSnapshot([
      {
        type: "people",
        record: { id, status: "published", email: "private@example.org" },
      },
    ]),
  );
});
test("stale same-record changes conflict and unrelated records do not", async () => {
  const base = await eventProjection(id, payload(), "published");
  assert.equal(compareDraft(base, base), false);
  assert.equal(compareDraft(base, { ...base, venue: "Another site" }), true);
  assert.equal(compareDraft(null, null), false);
  assert.equal(compareDraft(base, null), true);
});
test("full candidate set validates multi-record ordering and references atomically", async () => {
  const a = await eventProjection(id, payload(), "published");
  const b = await eventProjection(
    "20000000-0000-4000-8000-000000000002",
    { ...payload(), slug: "second-event" },
    "published",
  );
  await assert.rejects(
    validateSnapshot([
      { type: "events", record: a },
      { type: "events", record: b },
    ]),
    /orden|order/i,
  );
  await assert.rejects(
    validateSnapshot([
      {
        type: "events",
        record: { ...a, speakerIds: ["20000000-0000-4000-8000-000000000009"] },
      },
    ]),
    /referencia|reference/i,
  );
});
