export type Point = { x: number; y: number };
export function localPointer(
  x: number,
  y: number,
  rect: { left: number; top: number; width: number; height: number },
): Point {
  return {
    x: Math.max(0, Math.min(rect.width, x - rect.left)),
    y: Math.max(0, Math.min(rect.height, y - rect.top)),
  };
}
export function easePoint(current: Point, target: Point, factor = 0.1): Point {
  if (Math.hypot(target.x - current.x, target.y - current.y) < 0.1)
    return { ...target };
  return {
    x: current.x + (target.x - current.x) * factor,
    y: current.y + (target.y - current.y) * factor,
  };
}
export function gazeOffset(x: number, y: number, radius: number): Point {
  const length = Math.hypot(x, y);
  if (!length) return { x: 0, y: 0 };
  const scale = (Math.min(1, length / 180) * radius) / length;
  return { x: x * scale, y: y * scale };
}
