import { useRef, useState, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import type { NeighborsResponse, WheelCircle } from "../api";
import { colorOnWheel } from "../utils/color";
import { radialFraction, radiusFromFraction } from "../utils/radial";
import { shiftPoint, type TargetShift } from "../utils/schemeGate";
import { GEOMETRY_SIZE, RING_PAD } from "./Wheel";
import "./TargetCrosshairs.css";

export interface TargetEditor {
  /** Scheme angles in degrees: one target per angle. */
  angles: number[];
  /** Stage B tolerances, defining the drawn gate area. */
  gate: NeighborsResponse["gate"];
  /** Current shift shared by all circles, or null when the real reference is used. */
  shift: TargetShift | null;
  /** Commits a new shift for every circle, or null to reset it. */
  onChange: (shift: TargetShift | null) => void;
}

interface Props {
  circle: WheelCircle;
  /** Disc size in px; the main wheel is always non-compact. */
  size: number;
  editor: TargetEditor;
}

// Frozen geometry shared with Wheel.tsx / WheelPointLabels.tsx for
// non-compact wheels: gMaxR there is GEOMETRY_SIZE / 2 - 28.
const GEOMETRY_WRAP = GEOMETRY_SIZE + RING_PAD * 2;
const CENTER = GEOMETRY_WRAP / 2;
const MAX_R = GEOMETRY_SIZE / 2 - 28;
// Ruler ring sits between the plotted area (MAX_R) and the disc rim.
const RULER_R = GEOMETRY_SIZE / 2 - 12;
const RULER_HALF = 8;
const RULER_HIT_WIDTH = 18;

const DEG = Math.PI / 180;
// Keeps a dragged target off the exact origin, where its angle is undefined.
const MIN_FRACTION = 0.03;
const RING_R = 11;
const GRAB_WIDTH = 8;
const IDENTITY: TargetShift = { dTheta: 0, scale: 1 };

type DragKind = "reticle" | "ruler";

interface DragState {
  kind: DragKind;
  index: number;
  shift: TargetShift;
  moved: boolean;
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

const disc = (fraction: number, phi: number) => ({
  x: CENTER + fraction * MAX_R * Math.cos(phi),
  y: CENTER + fraction * MAX_R * Math.sin(phi),
});

// Annular sector of the gate in disc space. The radial scale is monotonic
// and keeps angles, so its edges are two circular arcs and two radial lines.
function sectorPath(f1: number, f2: number, theta: number, tol: number): string {
  const a0 = theta - tol;
  const a1 = theta + tol;
  const s0 = disc(f1, a0);
  const s1 = disc(f1, a1);
  const e1 = disc(f2, a1);
  const e0 = disc(f2, a0);
  const r1 = f1 * MAX_R;
  const r2 = f2 * MAX_R;
  return `M ${s0.x} ${s0.y} A ${r1} ${r1} 0 0 1 ${s1.x} ${s1.y} L ${e1.x} ${e1.y} A ${r2} ${r2} 0 0 0 ${e0.x} ${e0.y} Z`;
}

/**
 * Draggable controls on the big wheel, one gizmo per scheme angle:
 * - a reticle ringing the gate area around the rotated target;
 * - a ruler on the bright rim ring at the same bearing.
 *
 * Both move the same shared shift (see TargetShift): the reticle changes
 * rotation and radius, the ruler only rotation. The shift applies to the
 * reference of every circle, not just the displayed one, so all circles
 * are recomputed on release (see buildCircles).
 */
export default function TargetCrosshairs({ circle, size, editor }: Props) {
  const { t } = useTranslation();
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  // circle.z_x/z_y is always the real reference; the shift is applied on top.
  const real = { z_x: circle.z_x, z_y: circle.z_y };
  const realTheta = Math.atan2(real.z_y, real.z_x);
  const realR = Math.hypot(real.z_x, real.z_y);

  const shift = drag?.shift ?? editor.shift ?? IDENTITY;
  const anchorTheta = realTheta + shift.dTheta;
  const anchorR = realR * shift.scale;
  const maxRadius = circle.max_radius;
  const display = size + RING_PAD * 2;

  const toPolar = (e: PointerEvent): { r: number; phi: number } | null => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    const x = ((e.clientX - rect.left) / rect.width) * GEOMETRY_WRAP - CENTER;
    const y = ((e.clientY - rect.top) / rect.height) * GEOMETRY_WRAP - CENTER;
    const f = Math.min(1, Math.max(MIN_FRACTION, Math.hypot(x, y) / MAX_R));
    return { r: radiusFromFraction(f, maxRadius), phi: Math.atan2(y, x) };
  };

  const onDown = (e: PointerEvent<SVGGElement>, kind: DragKind, index: number) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ kind, index, shift, moved: false });
  };

  const onMove = (e: PointerEvent<SVGGElement>, kind: DragKind, index: number, angleDeg: number) => {
    if (drag?.kind !== kind || drag.index !== index) return;
    const p = toPolar(e);
    if (!p) return;
    // Undo this target's scheme rotation to get the anchor bearing it implies.
    const theta = p.phi - angleDeg * DEG;
    const scale = kind === "reticle" ? (realR > 1e-9 ? p.r / realR : 1) : drag.shift.scale;
    setDrag({ ...drag, moved: true, shift: { dTheta: wrapAngle(theta - realTheta), scale } });
  };

  const onUp = () => {
    if (drag?.moved) editor.onChange(drag.shift);
    setDrag(null);
  };

  const reset = () => editor.onChange(null);

  return (
    <svg
      ref={svgRef}
      className="wheel__targets"
      viewBox={`0 0 ${GEOMETRY_WRAP} ${GEOMETRY_WRAP}`}
      width={display}
      height={display}
      aria-hidden="true"
      style={{ position: "absolute", left: 0, top: 0, overflow: "visible", zIndex: 4, pointerEvents: "none" }}
    >
      <circle className="target-ruler__ring" cx={CENTER} cy={CENTER} r={RULER_R} />

      {editor.angles.map((angleDeg, index) => {
        const theta = anchorTheta + angleDeg * DEG;
        const hasRadius = anchorR > 1e-9;
        // Without a radius the gate has no radial limit (see recommendAtAngle).
        const f1 = hasRadius ? radialFraction(anchorR * Math.exp(-editor.gate.radius_tol_log), maxRadius) : 0;
        const f2 = hasRadius ? radialFraction(anchorR * Math.exp(editor.gate.radius_tol_log), maxRadius) : 1;
        const center = disc(radialFraction(anchorR, maxRadius), theta);
        const rulerX = CENTER + RULER_R * Math.cos(theta);
        const rulerY = CENTER + RULER_R * Math.sin(theta);
        const bearing = ((((theta / DEG) + 90) % 360) + 360) % 360;
        const color = colorOnWheel(
          bearing,
          circle.axis_x.colors.positive,
          circle.axis_x.colors.negative,
          circle.axis_y.colors.positive,
          circle.axis_y.colors.negative
        );
        const dragging = drag?.index === index;
        const cursor = dragging ? "grabbing" : "grab";

        return (
          <g key={index} className={"target-gizmo" + (dragging ? " target-gizmo--dragging" : "")}>
            <path
              className="target-gizmo__sector"
              d={sectorPath(f1, f2, theta, editor.gate.angle_tol_rad)}
              fill={color}
              fillOpacity={0.1}
              stroke={color}
              strokeWidth={1.2}
              strokeDasharray="4 3"
              style={{ pointerEvents: "none", filter: `drop-shadow(0 0 3px ${color})` }}
            />

            <g
              transform={`translate(${center.x} ${center.y})`}
              style={{ cursor, touchAction: "none" }}
              onPointerDown={(e) => onDown(e, "reticle", index)}
              onPointerMove={(e) => onMove(e, "reticle", index, angleDeg)}
              onPointerUp={onUp}
              onPointerCancel={() => setDrag(null)}
              onDoubleClick={reset}
            >
              {/* Only the ring is grabbable, so points inside the reticle stay hoverable. */}
              <circle
                r={RING_R}
                fill="none"
                stroke="transparent"
                strokeWidth={GRAB_WIDTH}
                style={{ pointerEvents: "stroke" }}
              />
              <circle className="target-reticle__halo" r={RING_R} />
              <circle className="target-reticle__halo target-reticle__halo--late" r={RING_R} />
              <g
                className="target-reticle__mark"
                style={{ pointerEvents: "none" }}
                stroke="#fff"
                strokeWidth={1.6}
                strokeLinecap="round"
              >
                <circle r={RING_R} fill="none" style={{ filter: `drop-shadow(0 0 4px ${color})` }} />
                <line x1={-RING_R - 6} y1={0} x2={-RING_R + 3} y2={0} />
                <line x1={RING_R - 3} y1={0} x2={RING_R + 6} y2={0} />
                <line x1={0} y1={-RING_R - 6} x2={0} y2={-RING_R + 3} />
                <line x1={0} y1={RING_R - 3} x2={0} y2={RING_R + 6} />
              </g>
              <title>{t("wheel.dragTarget")}</title>
            </g>

            <g
              className="target-ruler"
              transform={`translate(${rulerX} ${rulerY}) rotate(${theta / DEG})`}
              style={{ cursor, touchAction: "none" }}
              onPointerDown={(e) => onDown(e, "ruler", index)}
              onPointerMove={(e) => onMove(e, "ruler", index, angleDeg)}
              onPointerUp={onUp}
              onPointerCancel={() => setDrag(null)}
              onDoubleClick={reset}
            >
              <line
                x1={-RULER_HALF}
                x2={RULER_HALF}
                stroke="transparent"
                strokeWidth={RULER_HIT_WIDTH}
                strokeLinecap="round"
                style={{ pointerEvents: "stroke" }}
              />
              <line
                className="target-ruler__outline"
                x1={-RULER_HALF}
                x2={RULER_HALF}
                style={{ pointerEvents: "none" }}
              />
              <line
                className="target-ruler__fill"
                x1={-RULER_HALF}
                x2={RULER_HALF}
                stroke={color}
                style={{ pointerEvents: "none", filter: `drop-shadow(0 0 4px ${color})` }}
              />
              <title>{t("wheel.dragRuler")}</title>
            </g>
          </g>
        );
      })}
    </svg>
  );
}