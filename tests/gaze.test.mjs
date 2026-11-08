import test from "node:test";
import assert from "node:assert/strict";
import {
  timeForAngle,
  angleFromPointer,
} from "../src/components/motion/gaze.ts";
const offset = 1 / 240;
test("calibrated cardinal directions select the supplied video frames", () => {
  for (const [angle, expected] of [
    [0, 2.54167],
    [Math.PI / 2, 0.33333],
    [Math.PI, 1],
    [Math.PI * 1.5, 1.70833],
  ])
    assert.ok(Math.abs(timeForAngle(angle) - offset - expected) < 0.00001);
});
test("angles wrap around the circle", () => {
  assert.equal(timeForAngle(0), timeForAngle(Math.PI * 2));
  assert.equal(timeForAngle(-Math.PI / 2), timeForAngle(Math.PI * 1.5));
});
test("cover-cropped video coordinates account for screen position", () => {
  const rect = { left: 100, top: 200, width: 640, height: 600 };
  const scale = 600 / 1080;
  const eyeX = 420 - 12 * scale,
    eyeY = 500 - 122 * scale;
  assert.equal(angleFromPointer(eyeX + 100, eyeY, rect), 0);
  assert.equal(angleFromPointer(eyeX, eyeY + 100, rect), Math.PI / 2);
  assert.equal(angleFromPointer(eyeX + 2, eyeY + 2, rect), null);
});
