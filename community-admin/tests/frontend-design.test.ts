import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProductNavigation, workspaces } from "../src/web/navigation";
import { fieldInputType } from "../src/web/field-presentation";

test("navigation keeps every destination within six meaningful workspaces", () => {
  assert.equal(workspaces.length, 6);
  assert.equal(workspaces.flatMap((w) => w.items).length, 34);
  const html = renderToStaticMarkup(
    React.createElement(ProductNavigation, {
      active: "courses",
      onSelect: () => {},
    }),
  );
  assert.match(html, /Administración de la comunidad/);
  assert.match(html, /Contenido/);
  assert.match(html, /<svg/);
  for (const label of [
    "Memories",
    "Blog",
    "Contactos",
    "LinkedIn",
    "Sitio web",
    "Miembros y roles",
  ])
    assert.ok(
      workspaces.flatMap((w) => w.items).some((i) => i.label === label),
    );
});

test("native controls preserve local date and time semantics", () => {
  assert.equal(fieldInputType("date", "text"), "date");
  assert.equal(fieldInputType("endTime", "text"), "time");
  assert.equal(fieldInputType("timeZone", "text"), "text");
  assert.equal(fieldInputType("occurredAt", "text"), "text");
  assert.equal(fieldInputType("url", "url"), "url");
});
