import { useRef, useState, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import type { NeighborsResponse, TargetPoint, WheelCircle } from "../api";
import { colorOnWheel } from "../utils/color";
import { radialFraction, radiusFromFraction } from "../utils/radial";
import { GEOMETRY_SIZE, RING_PAD } from "./Wheel";

export interface TargetEditor {
  /** Scheme angles in degrees: one target per angle. */
  angles: number[];
  /** Stage B tolerances, defining the drawn gate area. */
  gate: NeighborsResponse["gate"];
  /** Commits a new virtual reference for a circle, or null to reset it. */
  onChange: (circleKey: string, target: TargetPoint | null) => void;
}

interface Props {
  circle: WheelCircle;
  /** Disc size in px; the main wheel is always non-compact. */
  size: number;
  circleKey: string;
  editor: TargetEditor;
}

// Frozen geometry shared with Wheel.tsx / WheelPointLabels.tsx for
// non-compact wheels: gMaxR there is GEOMETRY_SIZE / 2 - 28.
const GEOMETRY_WRAP = GEOMETRY_SIZE + RING_PAD * 2;
const CENTER = GEOMETRY_WRAP / 2;
const MAX_R = GEOMETRY_SIZE / 2 - 28;

const DEG = Math.PI / 180;
// Keeps a dragged target off the exact origin, where its angle is undefined.
const MIN_FRACTION = 0.03;
const RING_R = 11;
const GRAB_WIDTH = 8;

interface DragState {
  index: number;
  ref: TargetPoint;
  moved: boolean;
}

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
 * Draggable reticles on the big wheel: one per scheme angle, each ringing
 * the gate area around its rotated target. Dragging any reticle moves the
 * virtual reference the whole scheme is rotated from: the other reticles
 * follow with their angular offsets kept and the same radius. The new
 * picks are computed on release (see buildCircles' `targets`).
 */
export default function TargetCrosshairs({ circle, size, circleKey, editor }: Props) {
  const { t } = useTranslation();
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const anchor: TargetPoint = drag?.ref ?? circle.target ?? { z_x: circle.z_x, z_y: circle.z_y };
  const anchorTheta = Math.atan2(anchor.z_y, anchor.z_x);
  const anchorR = Math.hypot(anchor.z_x, anchor.z_y);
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

  const onDown = (e: PointerEvent<SVGGElement>, index: number) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ index, ref: anchor, moved: false });
  };

  const onMove = (e: PointerEvent<SVGGElement>, index: number, angleDeg: number) => {
    if (drag?.index !== index) return;
    const p = toPolar(e);
    if (!p) return;
    // Undo this target's scheme rotation to get the reference it implies.
    const theta = p.phi - angleDeg * DEG;
    setDrag({
      index,
      moved: true,
      ref: { z_x: p.r * Math.cos(theta), z_y: p.r * Math.sin(theta) },
    });
  };

  const onUp = () => {
    if (drag?.moved) editor.onChange(circleKey, drag.ref);
    setDrag(null);
  };

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
      {editor.angles.map((angleDeg, index) => {
        const theta = anchorTheta + angleDeg * DEG;
        const hasRadius = anchorR > 1e-9;
        // Without a radius the gate has no radial limit (see recommendAtAngle).
        const f1 = hasRadius ? radialFraction(anchorR * Math.exp(-editor.gate.radius_tol_log), maxRadius) : 0;
        const f2 = hasRadius ? radialFraction(anchorR * Math.exp(editor.gate.radius_tol_log), maxRadius) : 1;
        const center = disc(radialFraction(anchorR, maxRadius), theta);
        const bearing = ((((theta / DEG) + 90) % 360) + 360) % 360;
        const color = colorOnWheel(
          bearing,
          circle.axis_x.colors.positive,
          circle.axis_x.colors.negative,
          circle.axis_y.colors.positive,
          circle.axis_y.colors.negative
        );
        const dragging = drag?.index === index;

        return (
          <g key={index}>
            <path
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
              style={{ cursor: dragging ? "grabbing" : "grab", touchAction: "none" }}
              onPointerDown={(e) => onDown(e, index)}
              onPointerMove={(e) => onMove(e, index, angleDeg)}
              onPointerUp={onUp}
              onPointerCancel={() => setDrag(null)}
              onDoubleClick={() => editor.onChange(circleKey, null)}
            >
              {/* Only the ring is grabbable, so points inside the reticle stay hoverable. */}
              <circle
                r={RING_R}
                fill="none"
                stroke="transparent"
                strokeWidth={GRAB_WIDTH}
                style={{ pointerEvents: "stroke" }}
              />
              <g style={{ pointerEvents: "none" }} stroke="#fff" strokeWidth={1.6} strokeLinecap="round">
                <circle r={RING_R} fill="none" style={{ filter: `drop-shadow(0 0 4px ${color})` }} />
                <line x1={-RING_R - 6} y1={0} x2={-RING_R + 3} y2={0} />
                <line x1={RING_R - 3} y1={0} x2={RING_R + 6} y2={0} />
                <line x1={0} y1={-RING_R - 6} x2={0} y2={-RING_R + 3} />
                <line x1={0} y1={RING_R - 3} x2={0} y2={RING_R + 6} />
              </g>
              <title>{t("wheel.dragTarget")}</title>
            </g>
          </g>
        );
      })}
    </svg>
  );
}