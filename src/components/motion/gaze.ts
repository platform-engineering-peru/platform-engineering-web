import frames from "./gaze-frames.json" with { type: "json" };
const TAU = Math.PI * 2;
/** Calibrated to the supplied 1920×1080 reference video, not a linear orbit. */
export function timeForAngle(angle: number): number {
  const target = ((angle % TAU) + TAU) % TAU;
  let nearestTime = frames[0][1],
    nearestDistance = Infinity;
  for (const [sampleAngle, time] of frames) {
    const difference = Math.abs(target - sampleAngle);
    const distance = Math.min(difference, TAU - difference);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestTime = time;
    }
  }
  return nearestTime + 1 / 240;
}
export function angleFromPointer(
  x: number,
  y: number,
  rect: { left: number; top: number; width: number; height: number },
): number | null {
  const scale = Math.max(rect.width / 1920, rect.height / 1080);
  const dx = x - (rect.left + rect.width / 2 - 12 * scale);
  const dy = y - (rect.top + rect.height / 2 - 122 * scale);
  return Math.hypot(dx, dy) > 8 ? Math.atan2(dy, dx) : null;
}
