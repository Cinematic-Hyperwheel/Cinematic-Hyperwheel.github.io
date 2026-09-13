/** Small color-interpolation helpers for coloring a point to match the
 * wheel's conic-gradient background underneath it. */

export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpRgb(
  c1: [number, number, number],
  c2: [number, number, number],
  t: number
): [number, number, number] {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

function rgbToCss([r, g, b]: [number, number, number]): string {
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

/**
 * Color at a given compass bearing (0 = top/north, clockwise, matching
 * the disc's `conic-gradient(from 0deg, ...)` stops exactly): top =
 * yNegative, right = xPositive, bottom = yPositive, left = xNegative.
 * Interpolating along the same 4 stops guarantees the point's color
 * always agrees with the background directly underneath it.
 */
export function colorOnWheel(
  bearingDeg: number,
  xPositive: string,
  xNegative: string,
  yPositive: string,
  yNegative: string
): string {
  const stops: [number, string][] = [
    [0, yNegative],
    [90, xPositive],
    [180, yPositive],
    [270, xNegative],
    [360, yNegative],
  ];
  const b = ((bearingDeg % 360) + 360) % 360;
  for (let i = 0; i < stops.length - 1; i++) {
    const [a0, c0] = stops[i];
    const [a1, c1] = stops[i + 1];
    if (b >= a0 && b <= a1) {
      const t = a1 === a0 ? 0 : (b - a0) / (a1 - a0);
      return rgbToCss(lerpRgb(hexToRgb(c0), hexToRgb(c1), t));
    }
  }
  return xPositive; // unreachable - stops cover [0, 360]
}
