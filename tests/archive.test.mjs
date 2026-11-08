import test from "node:test";
import assert from "node:assert/strict";
import {
  arcPose,
  wrapIndex,
  relativeIndex,
} from "../src/modules/resources/archive-geometry.ts";
import { searchEntries } from "../src/lib/search.ts";
test("archive wraps both directions and follows the shortest circular distance", () => {
  assert.equal(wrapIndex(-1, 12), 11);
  assert.equal(wrapIndex(12, 12), 0);
  assert.equal(relativeIndex(11, 0, 12), -1);
  assert.equal(relativeIndex(0, 11, 12), 1);
});
test("active cover turns forward while outer spines recede symmetrically", () => {
  const center = arcPose(0, 300),
    left = arcPose(-3, 300),
    right = arcPose(3, 300);
  assert.equal(center.rotation, -90);
  assert.equal(center.x, 0);
  assert.ok(right.z < center.z);
  assert.ok(right.scale < 1);
  assert.ok(Math.abs(left.x + right.x) < 0.0001);
  assert.equal(left.z, right.z);
});
test("a single filtered item remains finite and centered", () => {
  assert.equal(relativeIndex(0, 0, 1), 0);
  const p = arcPose(0, 220);
  assert.ok(Object.values(p).every(Number.isFinite));
});
test("search ignores accents, matches all terms, and ranks titles above descriptions", () => {
  const entries = [
    { title: "Orquestación de plataformas", text: "Kubernetes y equipos" },
    { title: "Comunidades", text: "Aprende orquestación de plataformas" },
  ];
  assert.equal(
    searchEntries(entries, "orquestacion plataformas")[0].title,
    entries[0].title,
  );
  assert.equal(searchEntries(entries, "orquestacion inexistente").length, 0);
  assert.equal(searchEntries(entries, "  ").length, 2);
});
