import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EditorSections,
  MediaLibrary,
  WorkflowTrack,
} from "../src/web/product-ui";
import { fieldSection, fieldPriority } from "../src/web/field-presentation";
test("focused editor preserves explicit information, media, review and history routes", () => {
  const html = renderToStaticMarkup(
    React.createElement(EditorSections, {
      active: "media",
      onChange: () => {},
    }),
  );
  for (const label of [
    "Información",
    "Contenido",
    "Relaciones",
    "Medios",
    "Revisión",
    "Historial",
  ])
    assert.ok(html.includes(label));
  assert.match(html, /aria-current="step"/);
  assert.match(html, /<svg/);
});
test("visual media library names assets and exposes selection without replacing native data", () => {
  const html = renderToStaticMarkup(
    React.createElement(MediaLibrary, {
      media: [
        { id: "asset-one", label: "Encuentro Lima", width: 800, height: 520 },
      ],
      value: "asset-one",
      onSelect: () => {},
    }),
  );
  assert.match(html, /Encuentro Lima/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /800/);
  assert.match(html, /Buscar imagen/);
});
test("event information puts title and local time before editorial metadata", () => {
  assert.equal(fieldSection("title", "localized"), "info");
  assert.equal(fieldSection("date", "text"), "info");
  assert.equal(fieldSection("description", "localized"), "content");
  assert.equal(
    fieldSection("speakerIds", "reference", "speakers"),
    "relationships",
  );
  assert.equal(fieldSection("media", "media"), "media");
  assert.ok(fieldPriority("title") < fieldPriority("slug"));
  assert.ok(fieldPriority("date") < fieldPriority("displayOrder"));
});
test("editorial progress distinguishes draft, review and approval", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkflowTrack, { state: "submitted" }),
  );
  assert.match(html, /Flujo editorial/);
  assert.match(html, /Revisión/);
  assert.match(html, /Aprobado/);
});

import { nextUpcomingEvent, loadEventPages } from "../src/web/next-event";
test("next event uses Lima wall clock after UTC midnight and exact start time", () => {
  const event = {
    state: "draft",
    payload: { date: "2026-11-16", time: "20:00", timeZone: "America/Lima" },
  };
  assert.equal(
    nextUpcomingEvent([event], Date.parse("2026-11-17T00:30Z")),
    event,
  );
  assert.equal(
    nextUpcomingEvent([event], Date.parse("2026-11-17T01:01Z")),
    null,
  );
});
test("next event reads every page and propagates load errors", async () => {
  const rows = await loadEventPages(async (cursor) =>
    cursor ? { items: [2] } : { items: [1], nextCursor: "page2" },
  );
  assert.deepEqual(rows, [1, 2]);
  await assert.rejects(
    loadEventPages(async () => {
      throw new Error("offline");
    }),
    /offline/,
  );
});

import { agendaMonth } from "../src/web/calendar";
test("agenda month follows Lima across UTC month and year boundaries", () => {
  assert.equal(agendaMonth("2026-11-01T02:30:00Z"), "2026-10");
  assert.equal(agendaMonth("2027-01-01T04:59:00Z"), "2026-12");
  assert.equal(agendaMonth("2026-11-01T05:00:00Z"), "2026-11");
  assert.equal(agendaMonth(null), "");
  assert.equal(agendaMonth("invalid"), "");
});
