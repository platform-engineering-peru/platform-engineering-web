import assert from "node:assert/strict";
import test from "node:test";
import {
  calendarDate,
  monthCells,
  shiftMonth,
  shiftDate,
  groupPublications,
} from "../src/web/calendar";
test("Lima dates preserve day at UTC midnight and reject invalid values", () => {
  assert.equal(calendarDate("2026-11-01T04:59:59Z"), "2026-10-31");
  assert.equal(calendarDate("2026-11-01T05:00:00Z"), "2026-11-01");
  assert.equal(calendarDate("bad"), "");
});
test("Monday-first month grid has real dates and complete weeks", () => {
  const cells = monthCells("2026-11");
  assert.equal(cells.length, 42);
  assert.equal(cells[0], "2026-10-26");
  assert.equal(cells[6], "2026-11-01");
  assert.equal(cells[41], "2026-12-06");
  assert.equal(
    monthCells("2024-02").filter((d) => d.startsWith("2024-02")).length,
    29,
  );
  assert.equal(monthCells("2021-02").length, 28);
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
  assert.equal(shiftDate("2026-11-01", -1), "2026-10-31");
});
test("publication grouping uses persisted schedules and retains unscheduled records", () => {
  const records = [
    { id: "later", schedule_at: "2026-11-02T05:00:00Z" },
    { id: "earlier", scheduleAt: "2026-11-02T04:30:00Z" },
    { id: "draft", schedule_at: null },
    { id: "bad", schedule_at: "invalid" },
  ];
  const result = groupPublications(records);
  assert.deepEqual(
    result.days.get("2026-11-01")?.map((r) => r.id),
    ["earlier"],
  );
  assert.deepEqual(
    result.days.get("2026-11-02")?.map((r) => r.id),
    ["later"],
  );
  assert.deepEqual(
    result.unscheduled.map((r) => r.id),
    ["draft", "bad"],
  );
  assert.equal(records[0].id, "later");
});

import { createHash } from "node:crypto";
import {
  canonicalRecordHash,
  canonicalEventPayload,
  mergedInSnapshot,
  editorialStateLabel,
  type EditorialDraft,
} from "../src/web/editorial-state";
test("browser base hash matches canonical key ordering without private form metadata", async () => {
  const record = {
    id: "stable",
    status: "published",
    title: { en: "Event", "es-pe": "Evento" },
    displayOrder: 1,
  };
  const canonical =
    '{"displayOrder":1,"id":"stable","status":"published","title":{"en":"Event","es-pe":"Evento"}}';
  assert.equal(
    await canonicalRecordHash(record),
    createHash("sha256").update(canonical).digest("hex"),
  );
  assert.deepEqual(
    canonicalEventPayload(
      { ...record, privateNotes: "never" },
      { title: { "es-pe": "", en: "" }, slug: "" },
    ),
    { title: record.title, slug: "" },
  );
});
test("PR review and verified merge remain distinct from consulted canonical state", () => {
  const draft = {
    id: "draft",
    type: "events",
    baseCommit: "abc",
    baseRecordHash: null,
    version: 1,
    updatedAt: "2026-11-16T00:00:00Z",
    recordId: "stable",
    state: "proposed",
    desiredStatus: "published",
    payload: { title: { en: "New", "es-pe": "Nuevo" } },
  } as EditorialDraft;
  const snapshot = {
    commit: "abc",
    recordHashes: {},
    fetchedAt: "2026-11-16T00:00:00Z",
    stale: false,
    records: [
      {
        id: "stable",
        status: "published",
        title: { en: "Old", "es-pe": "Anterior" },
      },
    ],
  };
  assert.equal(mergedInSnapshot(draft, snapshot), false);
  draft.state = "merged";
  assert.equal(mergedInSnapshot(draft, snapshot), false);
  snapshot.records[0].title = draft.payload.title;
  assert.equal(mergedInSnapshot(draft, snapshot), true);
  assert.match(editorialStateLabel("proposed"), /aún no integrado/);
  assert.match(editorialStateLabel("conflict"), /se conserva/);
});

import { needsReconciliation, mayEditDraft } from "../src/web/editorial-state";
test("pending submission status remains truthful after reload and blocks editing saved intent", () => {
  const draft = {
    state: "unknown",
    submission: {
      id: "intent",
      state: "unknown",
      branch: "editorial/intent",
      errorCode: "PROPOSAL_UNCERTAIN",
      reconcileRequired: true,
      canEdit: false,
    },
  } as EditorialDraft;
  assert.equal(needsReconciliation(draft), true);
  assert.equal(mayEditDraft(draft), false);
  assert.match(editorialStateLabel(draft.state), /Resultado por confirmar/);
  draft.state = "retryable";
  draft.submission = {
    ...draft.submission!,
    state: "retryable",
    canEdit: true,
    reconcileRequired: false,
  };
  assert.equal(needsReconciliation(draft), false);
  assert.equal(mayEditDraft(draft), true);
});

import { sameEditorialPayload } from "../src/web/editorial-state";
test("PostgreSQL JSONB key ordering does not create false unsaved edits", () => {
  assert.equal(
    sameEditorialPayload(
      { title: { "es-pe": "Evento", en: "Event" }, date: "2026-11-16" },
      { date: "2026-11-16", title: { en: "Event", "es-pe": "Evento" } },
    ),
    true,
  );
  assert.equal(
    sameEditorialPayload({ title: { en: "New" } }, { title: { en: "Old" } }),
    false,
  );
});
