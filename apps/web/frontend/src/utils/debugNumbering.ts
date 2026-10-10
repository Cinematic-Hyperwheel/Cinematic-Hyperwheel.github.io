import type { RecommendCircle } from "../api";
import { circleKey } from "./circleKey";

/**
 * Global 1-based ordinal of every recommendation, in the order the
 * Recommendations panel lists them (circle order, then scheme angle, then
 * rank). Numbered over `matches`: `items` is a prefix of it, so list rows,
 * legend tiles and big-wheel points all agree.
 */
export function buildRecNumbering(circles: RecommendCircle[]): Map<string, number> {
  const numbering = new Map<string, number>();
  let n = 0;
  for (const circle of circles) {
    const key = circleKey(circle);
    for (const angle of circle.angles) {
      for (const item of angle.matches) numbering.set(`${key}:${item.item_id}`, ++n);
    }
  }
  return numbering;
}