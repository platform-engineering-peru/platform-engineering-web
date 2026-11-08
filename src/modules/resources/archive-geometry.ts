export const wrapIndex = (index: number, count: number) =>
  count ? ((index % count) + count) % count : 0;
export const relativeIndex = (index: number, center: number, count: number) =>
  count > 1 ? wrapIndex(index - center + count / 2, count) - count / 2 : 0;
// Integrate screen-space falloff once, normalized by the depth parameter U.
const step = 0.01;
const integral = [0];
for (let i = 1; i <= 400; i++)
  integral[i] = integral[i - 1] + step / (1 + Math.pow((i - 0.5) * step, 1.6));
export function arcPose(relative: number, height: number, mobile = false) {
  const spine = (height * 142) / 840,
    cover = (height * 474) / 900,
    gap = height * 0.035,
    U = height * (mobile ? 1.05 : 1.3),
    P = 1400;
  const a = Math.abs(relative),
    blend =
      a < 1
        ? (relative + Math.sin(Math.PI * relative) / Math.PI) / 2
        : Math.sign(relative) * 0.5;
  const u = relative * (spine + gap) + (cover - spine + 1.4 * gap) * blend;
  const normalized = Math.abs(u) / U,
    scale = 1 / (1 + Math.pow(normalized, 1.6)),
    k = 1 / scale;
  const value = Math.min(399, normalized / step),
    i = Math.floor(value),
    screenX =
      (integral[i] + (integral[i + 1] - integral[i]) * (value - i)) *
      U *
      Math.sign(u);
  const t = Math.max(0, 1 - a),
    open = t * t * (3 - 2 * t);
  return {
    x: screenX * k,
    y: (height * 0.5 * (1 - scale) * 0.42 + open * height * 0.012) * k,
    z: P * (1 - k) + open * height * 0.1,
    rotation:
      Math.sign(u) * Math.min(1, normalized) * 26 * (1 - open) - 90 * open,
    scale,
    open,
    shade: Math.min(0.6, open * 0.55 + (1 - scale) * 0.32),
  };
}
