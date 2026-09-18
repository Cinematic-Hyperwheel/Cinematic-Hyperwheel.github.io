import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { RecAngle, WheelCircle } from "../api";
import { colorOnWheel } from "../utils/color";

interface Props {
  circle: WheelCircle;
  size?: number;
  title?: string;
  overlays?: RecAngle[];
}

// z-scores are unbounded in principle; clamp to a comfortable display range
const Z_CLAMP = 3;
// below this disc size, skip the four pole-label strings around the disc
// (no room to render them legibly) - full labels are still available as
// a native tooltip on hover. Also the threshold WheelPointLabels.tsx
// uses to switch to the same real-pixel (non-frozen) geometry as this
// component's own compact branch below - exported so the two stay in
// sync.
export const COMPACT_BELOW = 220;
// Extra page-background margin around the wheel, so the single pole-label
// ring sits OUTSIDE the disc's coloured gradient (radius = size/2).
// Otherwise the curved labels would overlap the "mood" conic gradient and
// blend with it. Compact wheels use a smaller fixed margin because their
// ring labels are shortened to a single "/" segment.
// Exported so callers (e.g. App.tsx, sizing the main wheel to fill its
// column) can size a wheel wrapper knowing how much of it is ring
// padding vs. the actual disc.
export const RING_PAD = 36;
export const WHEEL_GAP = 14;
// Fixed reference size used to compute EVERYTHING drawn inside the <svg>
// (ring, axis lines, point, arc-hosted label paths, overlay dots) - for
// non-compact wheels only (see below). The SVG's `viewBox` stays pinned
// to this constant while its actual on-screen CSS width/height instead
// track the real, possibly continuously-changing `size` prop (e.g. the
// big central wheel adapting to available viewport height on every
// scroll frame - see App.tsx's sizing effect). The mismatch between a
// fixed viewBox and a varying display size is exactly what the SVG
// viewport mechanism exists for - the browser performs a single uniform
// scale natively, the same way any vector icon resizes smoothly, with:
//   - no per-frame recomputation of arc paths / canvas-measured label
//     widths (only reruns when labels/title/circle actually change);
//   - a plain CSS `width`/`height` transition (see index.css) that the
//     browser can genuinely interpolate, instead of a full SVG geometry
//     recompute + relayout snapping to a new value every frame - which
//     is what produced the visibly distinct "stepped" frames during a
//     single scroll gesture.
// An arbitrary constant, unrelated to any specific rendered size -
// chosen generously so label measurement stays proportionally accurate
// whether the wheel ends up displayed smaller or larger than this.
const GEOMETRY_SIZE = 460;
// Ring geometry for the main (non-compact) wheel: all four pole labels
// (axis X negative/positive, axis Y negative/positive) sit on a single ring
// curving around the circle, so the text follows a radius around it instead
// of sitting on straight lines. SVG uses a down-right (+y down) coordinate
// space; angles are measured clockwise from the +x (right).
const HALF_PI = Math.PI / 2;
// Labels sit on arcs of the ring, each sized from the label's measured pixel
// width so the text is never clipped at the arc ends. The cap stays generous:
// on hover the full text is drawn on the same ring and may overlap the
// neighbouring labels while it has focus (that's intentional).
const MAX_HALF_ANGLE = (150 * Math.PI) / 180;

// Reused across every call instead of creating a fresh <canvas> per
// label per render - canvas/context creation is the actually expensive
// part of text measurement, not measureText() itself. Previously this
// ran fresh on every resize frame (4 labels x a new canvas each); now
// that geometry no longer depends on the continuously-changing `size`
// (see GEOMETRY_SIZE above) it barely runs at all during a resize, but
// caching the canvas is a correct, low-risk improvement regardless of
// how often it's called.
let _measureCtx: CanvasRenderingContext2D | null | undefined;
function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (_measureCtx === undefined) {
    _measureCtx = typeof document !== "undefined"
      ? document.createElement("canvas").getContext("2d")
      : null;
  }
  return _measureCtx;
}

// Approximate the on-screen pixel width of a label (uppercase, with the
// rings' 0.06em letter-spacing) so we can size the host arc correctly.
function measureTextWidth(text: string, fontPx: number): number {
  const spaced = (text.length - 1) * fontPx * 0.06;
  const ctx = getMeasureCtx();
  if (ctx) {
    ctx.font = `${fontPx}px Inter, system-ui, sans-serif`;
    return ctx.measureText(text.toUpperCase()).width + spaced;
  }
  return text.length * fontPx * 0.72 + spaced;
}

// Half-angular sweep that guarantees the full label fits on a ring of
// radius r (with a 25% safety margin), capped by MAX_HALF_ANGLE.
function labelArcHalf(r: number, text: string, fontPx: number): number {
  const width = measureTextWidth(text, fontPx);
  return Math.min((width * 1.25) / 2 / r, MAX_HALF_ANGLE);
}

function ringArcPath(
  center: number,
  r: number,
  a0: number,
  a1: number,
  sweep: 0 | 1
): string {
  const s = `${center + r * Math.cos(a0)},${center + r * Math.sin(a0)}`;
  const e = `${center + r * Math.cos(a1)},${center + r * Math.sin(a1)}`;
  return `M ${s} A ${r} ${r} 0 0 ${sweep} ${e}`;
}

// For the small (compact) rings we only draw the first "/" segment of a
// label ("Wilderness / travel ..." -> "Wilderness") so it fits the tiny disc.
function shortLabel(text: string): string {
  const cut = text.indexOf("/");
  return (cut >= 0 ? text.slice(0, cut) : text).trim();
}

export default function Wheel({
  circle,
  size = 320,
  title,
  overlays = [],
}: Props) {
  const { i18n } = useTranslation();
  const [activeLabel, setActiveLabel] = useState<null | string>(null);
  // Unique per mounted Wheel instance - the axis pair alone (pid) is NOT
  // enough: the same (pc_x, pc_y) can now render twice at once (the main
  // wheel in App.tsx and its duplicate small wheel in the primary
  // Recommendations section both show the primary circle), and SVG
  // <path> ids must be unique per document or <textPath href="#..."> on
  // one instance can resolve to the OTHER instance's (differently
  // sized/positioned) arc.
  const uid = useId();

  const compact = size < COMPACT_BELOW;
  const halfBox = size / 2;
  const pad = compact ? 20 : RING_PAD;
  // REAL, current pixel dimensions - drive the outer CSS box (stage
  // wrapper, svg's displayed width/height, the plain HTML disc div) and
  // the external size/RING_PAD contract other components rely on
  // (App.tsx, RecommendationsPanel.tsx). Unaffected by the geometry
  // freeze below.
  const wrap = size + pad * 2;
  const center = wrap / 2;
  const discOffset = pad;
  const maxR = halfBox - (compact ? 10 : 28);

  // Geometry used for EVERYTHING drawn inside the <svg> - see
  // GEOMETRY_SIZE's doc comment above. Compact wheels (small, static
  // previews that never resize continuously - see
  // RecommendationsPanel.tsx) keep computing this directly from the
  // real `size`, unchanged from before; only the big, continuously
  // resized wheel (always non-compact - MIN_WHEEL_SIZE=260 >
  // COMPACT_BELOW=220) actually uses the frozen reference.
  const gHalfBox = compact ? halfBox : GEOMETRY_SIZE / 2;
  const gWrap = compact ? wrap : GEOMETRY_SIZE + pad * 2;
  const gCenter = gWrap / 2;
  const gMaxR = gHalfBox - (compact ? 10 : 28);

  // A single label ring curving around and OUTSIDE the disc (radius >
  // halfBox, on the page background, so it never sits over the coloured
  // gradient). All four pole labels share this one radius: axis X negative
  // left / positive right, axis Y negative top / positive bottom. On the
  // compact (secondary) wheels the ring uses a shorter radius and shortened
  // labels (first "/" segment) so they fit the small disc.
  const ringR = gHalfBox + (compact ? 8 : 16);
  const pid = `${uid}-${circle.axis_x.pc}-${circle.axis_y.pc}`;
  const idXNeg = `ring-${pid}-xneg`;
  const idXPos = `ring-${pid}-xpos`;
  const idYNeg = `ring-${pid}-yneg`;
  const idYPos = `ring-${pid}-ypos`;
  const lang = i18n.resolvedLanguage ?? "en";
  const labelsX = circle.axis_x.labels[lang] ?? circle.axis_x.labels.en;
  const labelsY = circle.axis_y.labels[lang] ?? circle.axis_y.labels.en;

  // What is actually drawn on the ring: the full label on the main wheel, the
  // first "/" segment (trimmed) on the compact wheels.
  const gXNeg = compact ? shortLabel(labelsX.negative) : labelsX.negative;
  const gXPos = compact ? shortLabel(labelsX.positive) : labelsX.positive;
  const gYNeg = compact ? shortLabel(labelsY.negative) : labelsY.negative;
  const gYPos = compact ? shortLabel(labelsY.positive) : labelsY.positive;

  // Size each label's host arc from its measured width so long labels are
  // never clipped at the arc ends (fixed tiny arcs used to cut text off).
  const fontPx = 9;
  // Arcs are sized to the FULL label so the hovered (expanded) text fits.
  const hTop = labelArcHalf(ringR, labelsY.negative, fontPx);
  const hBottom = labelArcHalf(ringR, labelsY.positive, fontPx);
  const hRight = labelArcHalf(ringR, labelsX.positive, fontPx);
  const hLeft = labelArcHalf(ringR, labelsX.negative, fontPx);
  // Left (negative) reads bottom->top, right (positive) top->bottom.
  const dXNeg = ringArcPath(gCenter, ringR, Math.PI - hLeft, Math.PI + hLeft, 1);
  const dXPos = ringArcPath(gCenter, ringR, -hRight, hRight, 1);
  // Top (negative) reads left->right, bottom (positive) left->right.
  const dYNeg = ringArcPath(gCenter, ringR, -HALF_PI - hTop, -HALF_PI + hTop, 1);
  const dYPos = ringArcPath(gCenter, ringR + 6, HALF_PI + hBottom, HALF_PI - hBottom, 0);

  // Clamp by VECTOR MAGNITUDE, not per-axis - clamping z_x and z_y
  // independently would let a point near the diagonal (both axes close
  // to the clamp) land in the corner of the surrounding square, whose
  // diagonal (maxR*sqrt(2)) is longer than the disc's radius (maxR) -
  // i.e. visibly outside the ring. Scaling the whole vector keeps it on
  // or inside the circle.
  const rawR = Math.hypot(circle.z_x, circle.z_y);
  const scale = rawR > Z_CLAMP ? Z_CLAMP / rawR : 1;
  const zx = circle.z_x * scale;
  const zy = circle.z_y * scale;

  // +x (right) = axis_x positive pole, +y (down) = axis_y positive pole -
  // screen y grows downward, so +z_y maps to +y directly.
  const x = gCenter + (zx / Z_CLAMP) * gMaxR;
  const y = gCenter + (zy / Z_CLAMP) * gMaxR;

  // Point color: same 4-stop interpolation as the disc's background, at
  // this point's own compass bearing - so the marker always reads as
  // "part of" the wheel under it rather than a generic white dot.
  // atan2(dx, -dy): dx = zx (screen-right), -dy = zy negated (screen "up")
  // so 0deg = top/north, increasing clockwise - matches the CSS
  // conic-gradient(from 0deg, ...) orientation used for the disc.
  const bearingDeg = (Math.atan2(zx, -zy) * 180) / Math.PI;
  const pointColor = colorOnWheel(
    bearingDeg,
    circle.axis_x.colors.positive,
    circle.axis_x.colors.negative,
    circle.axis_y.colors.positive,
    circle.axis_y.colors.negative
  );

  // Glow grows with how far the item's UNCLAMPED vector reaches - a
  // point sitting right on the ring because it got clamped (a strong
  // outlier) reads as visually "hotter" than one that naturally landed
  // near the edge with a small radius.
  const glowBase = compact ? 3 : 5;
  const glowPx = glowBase;

  // Recommendation overlay points - one per recommendation item (all top-k
  // per scheme angle), drawn on the same disc with the same vector-magnitude
  // clamp as the reference point.
  // Reference hue in the plane, converted to the disc's "compass" bearing
  // (0 = top/north, clockwise). angle_deg used by the backend is a RELATIVE
  // rotation of this hue, so the scheme target bearing =
  // refCompassBearing + angle_deg - feeding angle_deg straight into
  // colorOnWheel (which expects an absolute compass bearing) gives wrong hues.
  const refCompassBearing =
    ((Math.atan2(circle.z_y, circle.z_x) * 180) / Math.PI + 90 + 360) % 360;

  // Each recommendation point is coloured by the disc's hue at ITS GROUP's
  // scheme target angle (refCompassBearing + scheme angle), so all points of
  // one scheme angle share the same colour.
  const recPoints = overlays.flatMap((o) =>
    o.items.map((it) => {
      const rr = Math.hypot(it.z_x, it.z_y);
      const rs = rr > Z_CLAMP ? Z_CLAMP / rr : 1;
      const color = colorOnWheel(
        refCompassBearing + o.angle_deg,
        circle.axis_x.colors.positive,
        circle.axis_x.colors.negative,
        circle.axis_y.colors.positive,
        circle.axis_y.colors.negative
      );
      return {
        // Frozen SVG-space (see GEOMETRY_SIZE) - what the <circle> below
        // is actually drawn at; the browser's own viewport scaling maps
        // this to the correct on-screen spot regardless of the wheel's
        // current displayed size.
        cx: gCenter + ((it.z_x * rs) / Z_CLAMP) * gMaxR,
        cy: gCenter + ((it.z_y * rs) / Z_CLAMP) * gMaxR,
        // Real, CSS-pixel space (current actual displayed size) - the
        // hover popup below is a plain HTML div positioned via left/top
        // relative to `.wheel__stage`'s own REAL box, not the SVG's
        // (possibly differently-scaled) internal viewport - so it needs
        // coordinates in that same real space, not the frozen one.
        popupX: center + ((it.z_x * rs) / Z_CLAMP) * maxR,
        popupY: center + ((it.z_y * rs) / Z_CLAMP) * maxR,
        angle: o.angle_deg,
        item: it,
        color,
      };
    })
  );

  const gradient =
    `conic-gradient(from 0deg,` +
    `${circle.axis_y.colors.negative} 0deg,` +
    `${circle.axis_x.colors.positive} 90deg,` +
    `${circle.axis_y.colors.positive} 180deg,` +
    `${circle.axis_x.colors.negative} 270deg,` +
    `${circle.axis_y.colors.negative} 360deg)`;

  return (
    <div className={"wheel" + (compact ? " wheel--compact" : "")}>
      <div className="wheel__stage" style={{ width: wrap, height: wrap }}>
        <div
          className="wheel__disc"
          style={{
            width: size,
            height: size,
            left: discOffset,
            top: discOffset,
            background: gradient,
          }}
        />
        <svg viewBox={`0 0 ${gWrap} ${gWrap}`} style={{ width: wrap, height: wrap }}>
          <circle cx={gCenter} cy={gCenter} r={gMaxR} className="wheel__ring" />
          <line
            x1={gCenter} y1={gCenter - gMaxR + 4}
            x2={gCenter} y2={gCenter + gMaxR - 4}
            className="wheel__axis"
          />
          <line
            x1={gCenter - gMaxR + 4} y1={gCenter}
            x2={gCenter + gMaxR - 4} y2={gCenter}
            className="wheel__axis"
          />
          <line x1={gCenter} y1={gCenter} x2={x} y2={y} className="wheel__vector" />
          <circle
            cx={x} cy={y}
            r={compact ? 6 : 8}
            className="wheel__point"
            fill={pointColor}
            style={{ filter: `drop-shadow(0 0 ${glowPx}px ${pointColor})` }}
          />
          <g className="wheel__rings">
            <defs>
              <path id={idYNeg} d={dYNeg} />
              <path id={idYPos} d={dYPos} />
              <path id={idXNeg} d={dXNeg} />
              <path id={idXPos} d={dXPos} />
            </defs>
            <text
              className={"wheel__ring-text" + (activeLabel === "yneg" ? " wheel__ring-text--active" : "")}
              onMouseEnter={() => setActiveLabel("yneg")}
              onMouseLeave={() => setActiveLabel(null)}
            >
              <textPath href={`#${idYNeg}`} startOffset="50%" textAnchor="middle">
                {activeLabel === "yneg" ? labelsY.negative : gYNeg}
              </textPath>
            </text>
            <text
              className={"wheel__ring-text" + (activeLabel === "ypos" ? " wheel__ring-text--active" : "")}
              onMouseEnter={() => setActiveLabel("ypos")}
              onMouseLeave={() => setActiveLabel(null)}
            >
              <textPath href={`#${idYPos}`} startOffset="50%" textAnchor="middle">
                {activeLabel === "ypos" ? labelsY.positive : gYPos}
              </textPath>
            </text>
            <text
              className={"wheel__ring-text" + (activeLabel === "xneg" ? " wheel__ring-text--active" : "")}
              onMouseEnter={() => setActiveLabel("xneg")}
              onMouseLeave={() => setActiveLabel(null)}
            >
              <textPath href={`#${idXNeg}`} startOffset="50%" textAnchor="middle">
                {activeLabel === "xneg" ? labelsX.negative : gXNeg}
              </textPath>
            </text>
            <text
              className={"wheel__ring-text" + (activeLabel === "xpos" ? " wheel__ring-text--active" : "")}
              onMouseEnter={() => setActiveLabel("xpos")}
              onMouseLeave={() => setActiveLabel(null)}
            >
              <textPath href={`#${idXPos}`} startOffset="50%" textAnchor="middle">
                {activeLabel === "xpos" ? labelsX.positive : gXPos}
              </textPath>
            </text>
          </g>
          {recPoints.map((p, i) => (
            <circle
              key={`${p.item.item_id}-${i}`}
              cx={p.cx}
              cy={p.cy}
              r={compact ? 3.75 : 6}
              className="wheel__rec-point"
              data-point-item-id={p.item.item_id}
              style={{ fill: p.color, filter: `drop-shadow(0 0 ${glowPx}px ${p.color})` }}
            />
          ))}
        </svg>
      </div>
    </div>
  );
}
