import test from "node:test";
import assert from "node:assert/strict";
import {
  localPointer,
  easePoint,
  gazeOffset,
} from "../src/components/motion/pointer.ts";
test("pointer position uses local scene coordinates and clamps at its edges", () => {
  assert.deepEqual(
    localPointer(250, 180, { left: 100, top: 80, width: 300, height: 200 }),
    { x: 150, y: 100 },
  );
  assert.deepEqual(
    localPointer(-20, 500, { left: 100, top: 80, width: 300, height: 200 }),
    { x: 0, y: 200 },
  );
});
test("spotlight approaches target without overshooting and snaps to rest", () => {
  assert.deepEqual(easePoint({ x: 0, y: 0 }, { x: 100, y: 50 }), {
    x: 10,
    y: 5,
  });
  assert.deepEqual(easePoint({ x: 99.95, y: 50 }, { x: 100, y: 50 }), {
    x: 100,
    y: 50,
  });
});
test("bear gaze stays inside its eye radius for any cursor distance", () => {
  const offset = gazeOffset(1000, 1000, 6);
  assert.ok(Math.hypot(offset.x, offset.y) <= 6.00001);
  assert.deepEqual(gazeOffset(0, 0, 6), { x: 0, y: 0 });
});
