import { hexToRgb } from "../utils/color";

/**
 * The title's own brand gradient stops (but more vibrant) (see .appheader__title in
 * header.css and .app__header-text h1 in index.css) - duplicated here
 * because each initial's color is pre-computed in JS (see capColorAt
 * below) rather than read from the CSS gradient itself. Keep these in
 * sync with both stylesheet rules if the brand gradient ever changes.
 */
const GRADIENT_FROM = "#ff6c3b";
const GRADIENT_TO = "#9d7fff";

function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  switch (max) {
    case rn: h = (gn - bn) / d + (gn < bn ? 6 : 0); break;
    case gn: h = (bn - rn) / d + 2; break;
    default: h = (rn - gn) / d + 4;
  }
  return [h * 60, s, l];
}

function hslToRgb([h, s, l]: [number, number, number]): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue2rgb = (p: number, q: number, t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hn = h / 360;
  return [
    hue2rgb(p, q, hn + 1 / 3) * 255,
    hue2rgb(p, q, hn) * 255,
    hue2rgb(p, q, hn - 1 / 3) * 255,
  ];
}

// Fine-tuning the subtle neon boost for this specific color scheme
const CAP_LIGHTNESS_BOOST = 0.12; // Slightly increase initial letter lightness (by 12%)
const CAP_MAX_LIGHTNESS = 0.80;   // Prevent the letter from washing out to pure white

export function capColorAt(t: number): string {
  const rgbFrom = hexToRgb(GRADIENT_FROM);
  const rgbTo = hexToRgb(GRADIENT_TO);

  // STEP 1: Interpolate strictly in RGB (syncing with standard CSS gradient behavior)
  const baseR = lerp(rgbFrom[0], rgbTo[0], t);
  const baseG = lerp(rgbFrom[1], rgbTo[1], t);
  const baseB = lerp(rgbFrom[2], rgbTo[2], t);

  // STEP 2: Convert the resulting CSS gradient point to HSL
  const [h, s, l] = rgbToHsl([baseR, baseG, baseB]);

  // STEP 3: Boost lightness while preserving original Saturation (S) and Hue (H)
  // This ensures the letter stays in its color family, just "lights up"
  const boostedLightness = Math.min(CAP_MAX_LIGHTNESS, l + CAP_LIGHTNESS_BOOST);

  // STEP 4: Convert back to RGB for final rendering
  const finalRgb = hslToRgb([h, s, boostedLightness]);

  return `rgb(${Math.round(finalRgb[0])}, ${Math.round(finalRgb[1])}, ${Math.round(finalRgb[2])})`;
}


/**
 * Renders a title string with each word's first letter picked out in a
 * brighter, more saturated tint of the title's own brand gradient (see
 * GRADIENT_FROM/GRADIENT_TO above), sampled at that letter's position
 * along the gradient - so the emphasis stays visually part of the same
 * gradient rather than reading as an unrelated highlight color.
 */
export default function BrandTitle({ text }: { text: string }) {
  const words = text.split(" ");
  return (
    <>
      {words.map((word, i) => {
        const t = words.length > 1 ? i / (words.length - 1) : 0;
        return (
          <span key={i}>
            {i > 0 && " "}
            <span className="appheader__title-cap" style={{ color: capColorAt(t) }}>
              {word.charAt(0)}
            </span>
            {word.slice(1)}
          </span>
        );
      })}
    </>
  );
}