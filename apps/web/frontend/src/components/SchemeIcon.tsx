import { colorOnWheel } from "../utils/color";

// Scheme angles in degrees, clockwise from the reference (which sits at the
// top). Mirrors SCHEMES in hyperwheel_recommender/rotation.py; only the
// geometry is needed here, so the names are the sole link between the two.
export const SCHEME_ANGLES: Record<string, number[]> = {
  complementary: [180],
  triadic: [120, -120],
  analogous: [30, -30],
  "wide-analogous": [60, -60],
  "split-complementary": [150, -150],
  square: [90, 180, -90],
  monochromatic: [0],
};

// Fixed icon palette for the hue ring (top, right, bottom, left), in the
// same order colorOnWheel uses for a disc, so a point's color matches the
// ring underneath it. Not tied to any PC axis in pc_config.json.
const COLOR_TOP = "#7560B6";
const COLOR_RIGHT = "#D95A36";
const COLOR_BOTTOM = "#31A9C7";
const COLOR_LEFT = "#E7B936";

const hueAt = (bearingDeg: number) =>
  colorOnWheel(bearingDeg, COLOR_RIGHT, COLOR_LEFT, COLOR_BOTTOM, COLOR_TOP);

const VIEW = 48;
const CENTER = VIEW / 2;
const RING_R = 17;
const RING_WIDTH = 4;
const REF_R = 4.6;
const TARGET_R = 3.2;
const MONO_TARGET_R = 2.4;

// Point at a clockwise bearing (0 = top) and distance `r` from the center.
function polar(bearingDeg: number, r: number): { x: number; y: number } {
  const rad = (bearingDeg * Math.PI) / 180;
  return {
    x: +(CENTER + r * Math.sin(rad)).toFixed(2),
    y: +(CENTER - r * Math.cos(rad)).toFixed(2),
  };
}

// SVG has no conic gradient, so the hue ring is a chain of short arcs, each
// in its own color. Arcs overlap slightly to hide seams.
const RING_SEGMENTS = 36;
const SEGMENT_DEG = 360 / RING_SEGMENTS;
const SEGMENT_OVERLAP_DEG = 1;
const RING_ARCS = Array.from({ length: RING_SEGMENTS }, (_, k) => {
  const from = k * SEGMENT_DEG;
  const to = from + SEGMENT_DEG + SEGMENT_OVERLAP_DEG;
  const a = polar(from, RING_R);
  const b = polar(to, RING_R);
  return {
    d: `M ${a.x} ${a.y} A ${RING_R} ${RING_R} 0 0 1 ${b.x} ${b.y}`,
    color: hueAt(from + SEGMENT_DEG / 2),
  };
});

interface Props {
  scheme: string;
  size?: number;
}

export default function SchemeIcon({ scheme, size = 44 }: Props) {
  const angles = SCHEME_ANGLES[scheme];
  if (!angles) return null;

  // A target on the reference's own bearing (monochromatic) is drawn
  // smaller so it stays visible inside the hollow reference marker.
  const targets = angles.map((a) => ({
    bearing: a,
    r: a === 0 ? MONO_TARGET_R : TARGET_R,
    outlined: a !== 0,
  }));

  return (
    <svg width={size} height={size} viewBox={`0 0 ${VIEW} ${VIEW}`} fill="none" aria-hidden="true">
      <circle cx={CENTER} cy={CENTER} r={RING_R} fill="rgba(6, 8, 14, 0.55)" />
      {RING_ARCS.map((arc, i) => (
        <path key={i} d={arc.d} stroke={arc.color} strokeWidth={RING_WIDTH} />
      ))}
      {[0, ...angles].map((bearing, i) => {
        const end = polar(bearing, RING_R);
        return (
          <line
            key={`spoke-${i}`}
            x1={CENTER}
            y1={CENTER}
            x2={end.x}
            y2={end.y}
            stroke="#fff"
            strokeWidth="1.2"
            strokeLinecap="round"
            opacity="0.3"
          />
        );
      })}
      {targets.map((t, i) => {
        const p = polar(t.bearing, RING_R);
        return (
          <circle
            key={`target-${i}`}
            cx={p.x}
            cy={p.y}
            r={t.r}
            fill={hueAt(t.bearing)}
            stroke={t.outlined ? "#fff" : "none"}
            strokeWidth="1.4"
          />
        );
      })}
      {/* Reference on top: hollow, so a coincident target shows through. */}
      <circle
        cx={CENTER}
        cy={CENTER - RING_R}
        r={REF_R}
        fill="rgba(10, 13, 20, 0.85)"
        stroke="#fff"
        strokeWidth="1.8"
      />
      {angles.includes(0) && (
        <circle cx={CENTER} cy={CENTER - RING_R} r={MONO_TARGET_R} fill={hueAt(0)} />
      )}
    </svg>
  );
}