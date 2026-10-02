/**
 * Radial placement of whitened plane coordinates on the wheel disc.
 *
 * The radius is compressed logarithmically and normalized by the
 * circle's largest radius (reference and whole neighbor pool):
 *
 *   r' = ln(1 + r / RADIAL_SCALE) / ln(1 + maxRadius / RADIAL_SCALE)
 *
 * - strictly monotonic, so radial order and relative distances are
 *   preserved (nothing is clamped);
 * - r' is in [0, 1] and the farthest point lands exactly on the rim, so
 *   any outlier fits and the disc is fully used;
 * - RADIAL_SCALE expands the neighbourhood of the origin, keeping
 *   points near the center from collapsing together.
 *
 * The angle is never altered. maxRadius must come from the circle's own
 * data (see buildCircles), so every wheel drawing the same circle
 * places a given point identically.
 */
const RADIAL_SCALE = 0.5;

/** Used only until a circle's own maxRadius is known (reference-only wheel). */
export const DEFAULT_MAX_RADIUS = 3;

/** Maps a whitened radius to a fraction of the disc radius, in [0, 1]. */
export function radialFraction(r: number, maxRadius: number = DEFAULT_MAX_RADIUS): number {
  const m = Math.max(maxRadius, 1e-6);
  return Math.min(1, Math.log1p(r / RADIAL_SCALE) / Math.log1p(m / RADIAL_SCALE));
}

/**
 * Position on the unit disc (x right, y down) for whitened coordinates.
 * Multiply by the disc radius and add the disc center to get pixels.
 */
export function diskPosition(
  zx: number,
  zy: number,
  maxRadius: number = DEFAULT_MAX_RADIUS
): { x: number; y: number } {
  const r = Math.hypot(zx, zy);
  if (r === 0) return { x: 0, y: 0 };
  const k = radialFraction(r, maxRadius) / r;
  return { x: zx * k, y: zy * k };
}