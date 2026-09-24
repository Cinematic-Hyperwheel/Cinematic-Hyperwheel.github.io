import "./WheelPointLabels.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { RecAngle, RecItem, StarfieldItem, WheelCircle } from "../api";
import { COMPACT_BELOW, RING_PAD } from "./Wheel";
import { useHighlight, useHighlightedItem } from "../contexts/HighlightContext";
import { useActiveCard } from "../contexts/ActiveCardContext";
import { supportsHover } from "../utils/hover";

interface Props {
  circle: WheelCircle;
  size: number;
  title?: string;
  overlays?: RecAngle[];
  /** Background star field for this circle - see Wheel.tsx. Hovering a
   * star shows its title and a highlight ring, but doesn't open the
   * recommendation info card or cross-light the Recommendations list
   * (starfield items have no corresponding list row). */
  starfield?: StarfieldItem[];
  /** Identity of the circle this instance belongs to (see
   * utils/circleKey.ts) - scopes this instance's hover to the shared
   * HighlightContext, so it only lights up (and only lights up) the
   * matching legend row / list row / big-wheel point that share this
   * same circle. */
  circleKey: string;
}

interface Point {
  x: number;
  y: number;
  title: string;
  reference: boolean;
  /** True for a background star-field point (see Wheel.tsx) - gets a
   * smaller radius and is excluded from cross-circle highlighting and
   * the recommendation info card. */
  star: boolean;
  index: number;
  itemId: number | null;
}

const Z_CLAMP = 3;
// Frozen reference space for the continuously-resized main wheel only -
// see Wheel.tsx's own GEOMETRY_SIZE comment. Compact wheels (size 
// COMPACT_BELOW) skip this and compute directly in real pixels instead,
// mirroring Wheel.tsx's own compact branch exactly - see the `compact`
// block in WheelPointLabels below. This is what keeps a point drawn
// here landing on the same disc point Wheel.tsx itself draws, at any
// wheel size.
const GEOMETRY_SIZE = 460;
const GEOMETRY_WRAP = GEOMETRY_SIZE + RING_PAD * 2;
const LABEL_GAP = 10;
const LABEL_FONT = 10;
const LABEL_LINE_HEIGHT = 15;
const LABEL_MAX_WIDTH = 250;
const POINT_HOVER_PADDING = 0;
const POINT_HOVER_CLUSTER_OVERLAP = 0.8;
const DIMMED_POINT_OPACITY = 0.8;
const DIMMED_POINT_SCALE = 0.4;
const REFERENCE_LABEL_GAP = 6;
// Matches the non-reference branch of pointRadius() below - the label
// vs. point overlap check needs a plain radius value to test against.
const REC_POINT_RADIUS = 6;
// Extra clearance kept between the reference label's box and a
// recommendation point's own drawn radius.
const POINT_AVOID_PADDING = 4;

// center/maxR are the caller's own gCenter/gMaxR (frozen-space values
// for the main wheel, real-pixel values for compact wheels - see
// WheelPointLabels below), so this always lands on the same point
// Wheel.tsx itself draws.
function pointPosition(zx: number, zy: number, center: number, maxR: number): { x: number; y: number } {
  const radius = Math.hypot(zx, zy);
  const scale = radius > Z_CLAMP ? Z_CLAMP / radius : 1;
  return {
    x: center + ((zx * scale) / Z_CLAMP) * maxR,
    y: center + ((zy * scale) / Z_CLAMP) * maxR,
  };
}

function pointRadius(point: Point): number {
  if (point.reference) return 10.5;
  if (point.star) return 3.5;
  return 6;
}

function distanceBetween(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Overlap depth (0 if none) between an axis-aligned box centered at
// (rectCx, rectCy) and a circle - used to keep the reference label
// clear of other points' own drawn dots.
function rectOverlapsCircle(
  rectCx: number,
  rectCy: number,
  halfWidth: number,
  halfHeight: number,
  circleX: number,
  circleY: number,
  radius: number
): number {
  const nearestX = Math.min(Math.max(circleX, rectCx - halfWidth), rectCx + halfWidth);
  const nearestY = Math.min(Math.max(circleY, rectCy - halfHeight), rectCy + halfHeight);
  const dist = Math.hypot(circleX - nearestX, circleY - nearestY);
  return Math.max(0, radius - dist);
}

interface AvoidCircle {
  x: number;
  y: number;
  radius: number;
}

// Total overlap depth of a label box against every circle it must stay
// clear of - the reference point's own dot plus every recommendation
// point's dot, each with its own radius.
function totalPointOverlap(
  cx: number,
  cy: number,
  halfWidth: number,
  halfHeight: number,
  avoid: AvoidCircle[]
): number {
  let total = 0;
  for (const c of avoid) {
    total += rectOverlapsCircle(cx, cy, halfWidth, halfHeight, c.x, c.y, c.radius + POINT_AVOID_PADDING);
  }
  return total;
}

// Minimum distance from an axis-aligned box (the label) to a line
// segment (the radius line from the disc center to the reference
// point) - sampled along the segment since an exact closed-form
// rect-vs-segment distance isn't needed at this scale.
function rectDistanceToSegment(
  rectCx: number,
  rectCy: number,
  halfWidth: number,
  halfHeight: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const samples = 24;
  let minDist = Infinity;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const px = x1 + (x2 - x1) * t;
    const py = y1 + (y2 - y1) * t;
    const nearestX = Math.min(Math.max(px, rectCx - halfWidth), rectCx + halfWidth);
    const nearestY = Math.min(Math.max(py, rectCy - halfHeight), rectCy + halfHeight);
    const dist = Math.hypot(px - nearestX, py - nearestY);
    if (dist < minDist) minDist = dist;
  }
  return minDist;
}

// Clearance kept between the label and the radius line itself.
const LINE_AVOID_GAP = 1;

// Per-direction nearest-clear-spot search around the reference point:
// for each sampled direction, find the SMALLEST offset along that exact
// direction that clears the point's own dot, every recommendation
// point's dot, and the radius line, then compare those per-direction
// results by actual offset distance. A single shared radius swept
// across all directions doesn't work here because the label box is
// wide and short - clearing the point itself needs a much larger offset
// sideways than vertically, so a uniform-radius sweep would always stop
// at whichever direction empties out first by coincidence of the box's
// own shape, not by genuine proximity.
const RADIAL_ANGLE_STEPS = 36; // 10° resolution
const RADIAL_STEP = 4;
const RADIAL_MAX_STEPS = 5;
// Candidates within this many px of the current best are treated as
// tied on distance; ties are broken by preferring the direction closer
// to perpendicular to the radius line (the original, tidiest look).
const TIE_EPSILON = 2;

function labelWidth(title: string): number {
  return Math.min(LABEL_MAX_WIDTH, title.length * LABEL_FONT * 0.6);
}

function referenceLabelPosition(
  point: Point,
  title: string,
  avoidPoints: Point[],
  center: number,
  wrap: number
): { x: number; y: number; textAnchor: "middle" | "start" | "end" } {
  const dx = point.x - center;
  const dy = point.y - center;
  const length = Math.hypot(dx, dy);

  if (length === 0) {
    return { x: point.x + LABEL_GAP, y: point.y, textAnchor: "start" };
  }

  // Perpendicular to the radius line - used only as a tiebreak between
  // otherwise-equidistant candidates, not as a constraint.
  const perpX = -dy / length;
  const perpY = dx / length;

  const halfWidth = labelWidth(title) / 2;
  const halfHeight = LABEL_FONT / 2;
  const avoid: AvoidCircle[] = [
    { x: point.x, y: point.y, radius: pointRadius(point) },
    ...avoidPoints.map((p) => ({ x: p.x, y: p.y, radius: REC_POINT_RADIUS })),
  ];

  const combinedOverlap = (x: number, y: number) => {
    const pointPart = totalPointOverlap(x, y, halfWidth, halfHeight, avoid);
    const lineDist = rectDistanceToSegment(x, y, halfWidth, halfHeight, center, center, point.x, point.y);
    const linePart = Math.max(0, LINE_AVOID_GAP - lineDist);
    return pointPart + linePart;
  };

  const exceedsViewport = (x: number, y: number) =>
    x - halfWidth < 0 || x + halfWidth > wrap || y - halfHeight < 0 || y + halfHeight > wrap;

  const getBestAnchorInfo = (rectX: number, rectY: number) => {
    const xs = [rectX - halfWidth, rectX, rectX + halfWidth];
    const ys = [rectY - halfHeight, rectY, rectY + halfHeight];
    
    let minSqDistToPoint = Infinity;
    let chosenXIdx = 1;
    let anchorX = rectX;
    let anchorY = rectY;

    for (let ix = 0; ix < 3; ix++) {
      for (let iy = 0; iy < 3; iy++) {
        if (ix === 1 && iy === 1) continue; // rect center not needed
        
        const cx = xs[ix];
        const cy = ys[iy];
        const dSq = (cx - point.x) ** 2 + (cy - point.y) ** 2;
        
        if (dSq < minSqDistToPoint) {
          minSqDistToPoint = dSq;
          chosenXIdx = ix;
          anchorX = cx;
          anchorY = cy;
        }
      }
    }

    return {
      minDist: Math.sqrt(minSqDistToPoint),
      chosenXIdx,
      distToCenter: Math.hypot(anchorX - center, anchorY - center)
    };
  };

  let best: { 
    x: number; 
    y: number; 
    minDist: number; 
    chosenXIdx: number; 
    distToCenter: number; 
    perpAlign: number; 
  } | null = null;

  for (let i = 0; i < RADIAL_ANGLE_STEPS; i++) {
    const theta = (i * 2 * Math.PI) / RADIAL_ANGLE_STEPS;
    const dirX = Math.cos(theta);
    const dirY = Math.sin(theta);
    // Exact minimum offset along this direction that clears the
    // reference point's own circle (support-function distance of the
    // box plus the circle's radius) - the true per-direction starting
    // point, rather than one shared radius for every direction.
    const baseR = Math.abs(dirX) * halfWidth + Math.abs(dirY) * halfHeight + pointRadius(point) + POINT_AVOID_PADDING;
    let foundX: number | null = null;
    let foundY: number | null = null;

    for (let step = 0; step <= RADIAL_MAX_STEPS; step++) {
      const r = baseR + step * RADIAL_STEP;
      const x = point.x + dirX * r;
      const y = point.y + dirY * r;
      // Moving further out along a fixed direction from an interior
      // point never re-enters the viewport once it's left it - safe to
      // stop growing r for this direction entirely.
      if (exceedsViewport(x, y)) break;
      if (combinedOverlap(x, y) <= 0) {
        foundX = x;
        foundY = y;
        break;
      }
    }
    if (foundX === null || foundY === null) continue;

    const anchorInfo = getBestAnchorInfo(foundX, foundY);
    const perpAlign = Math.max(dirX * perpX + dirY * perpY, dirX * -perpX + dirY * -perpY);
    const isBetter = !best || 
      anchorInfo.minDist < best.minDist - TIE_EPSILON || 
      (Math.abs(anchorInfo.minDist - best.minDist) <= TIE_EPSILON && anchorInfo.distToCenter > best.distToCenter + TIE_EPSILON) ||
      (Math.abs(anchorInfo.minDist - best.minDist) <= TIE_EPSILON && Math.abs(anchorInfo.distToCenter - best.distToCenter) <= TIE_EPSILON && perpAlign > best.perpAlign);
    if (isBetter) {
      best = { 
        x: foundX, 
        y: foundY, 
        minDist: anchorInfo.minDist, 
        chosenXIdx: anchorInfo.chosenXIdx, 
        distToCenter: anchorInfo.distToCenter, 
        perpAlign 
      };
    }
  }

  if (best) {
    let anchorType: "start" | "middle" | "end" = "middle";
    let outputX = best.x;

    if (best.chosenXIdx === 0) {
      anchorType = "start";
      outputX = best.x - halfWidth;
    } else if (best.chosenXIdx === 2) {
      anchorType = "end";
      outputX = best.x + halfWidth;
    }

    // Baseline shift to compensate for the missing dominant-baseline="central"
    const outputY = best.y + LABEL_FONT * 0.35; 

    return { x: outputX, y: outputY, textAnchor: anchorType };
  }

  // Fallback if no clear space was found
  const fallbackOffset = Math.abs(perpX) * halfWidth + Math.abs(perpY) * halfHeight + pointRadius(point) + REFERENCE_LABEL_GAP;
  return {
    x: point.x + perpX * fallbackOffset,
    y: point.y + perpY * fallbackOffset + LABEL_FONT * 0.35,
    textAnchor: "middle",
  };
}

export default function WheelPointLabels({ circle, size, title, overlays = [], starfield = [], circleKey }: Props) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Mirrors Wheel.tsx's own compact/frozen-geometry split exactly.
  // Getting this wrong - always using the frozen constants regardless
  // of size - is what makes a compact wheel's overlay box and its point
  // coordinates disagree with the real disc drawn by Wheel.tsx, which
  // shows up as the hover highlight landing off the actual point.
  const compact = size < COMPACT_BELOW;
  const pad = compact ? 20 : RING_PAD;
  const displayWrap = size + pad * 2;
  const gHalfBox = compact ? size / 2 : GEOMETRY_SIZE / 2;
  const gWrap = compact ? displayWrap : GEOMETRY_WRAP;
  const gCenter = gWrap / 2;
  const gMaxR = gHalfBox - (compact ? 10 : 28);

  const { setHighlighted, clearHighlighted } = useHighlight();
  const highlightedItemId = useHighlightedItem(circleKey);
  const reportedItemIdRef = useRef<number | null>(null);
  const { showCard, hideCard } = useActiveCard();
  const reportedCardKeyRef = useRef<string | null>(null);

  const points = useMemo<Point[]>(() => {
    const result: Point[] = [];
    let index = 0;
    if (title) {
      const position = pointPosition(circle.z_x, circle.z_y, gCenter, gMaxR);
      result.push({ x: position.x, y: position.y, title, reference: true, star: false, index: index++, itemId: null });
    }

    for (const angle of overlays) {
      for (const item of angle.items) {
        const position = pointPosition(item.z_x, item.z_y, gCenter, gMaxR);
        result.push({ x: position.x, y: position.y, title: item.title, reference: false, star: false, index: index++, itemId: item.item_id });
      }
    }

    for (const item of starfield) {
      const position = pointPosition(item.z_x, item.z_y, gCenter, gMaxR);
      result.push({ x: position.x, y: position.y, title: item.title, reference: false, star: true, index: index++, itemId: item.item_id });
    }
    return result;
  }, [circle, overlays, starfield, title, gCenter, gMaxR]);

  const referencePoint = useMemo(
    () => points.find((point) => point.reference) ?? null,
    [points]
  );

  const localHoveredPoint = hoveredIndex === null
    ? null
    : points.find((point) => point.index === hoveredIndex) ?? null;

  // A point highlighted from elsewhere within THIS SAME circle (another
  // wheel point, the legend, or a recommendations-list row - see
  // HighlightContext) - only relevant when this instance isn't itself
  // the one currently driving the hover.
  const highlightedPoint = highlightedItemId === null
    ? null
    : points.find((point) => point.itemId === highlightedItemId) ?? null;

  const hoveredPoint = localHoveredPoint ?? highlightedPoint;

  // Reports this instance's own local hover into the shared context -
  // recommendation points only (reference has no itemId and never
  // appears anywhere else, so it never needs cross-surface highlight).
  useEffect(() => {
    const itemId = localHoveredPoint?.itemId ?? null;
    const previous = reportedItemIdRef.current;
    if (itemId === previous) return;

    if (previous !== null) clearHighlighted(circleKey, previous);
    if (itemId !== null) setHighlighted(circleKey, itemId);
    reportedItemIdRef.current = itemId;
  }, [localHoveredPoint, circleKey, setHighlighted, clearHighlighted]);

  useEffect(() => {
    return () => {
      if (reportedItemIdRef.current !== null) {
        clearHighlighted(circleKey, reportedItemIdRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

    // Hovering a recommendation or starfield point directly opens the info
    // card anchored to the point itself (see contexts/ActiveCardContext.tsx).
    // Both point types use the same card surface; starfield items simply
    // don't have recommendation-specific ranking fields.
    useEffect(() => {
      if (!supportsHover()) return;

      const itemId = localHoveredPoint?.itemId ?? null;

      if (itemId === null) {
        if (reportedCardKeyRef.current) hideCard(reportedCardKeyRef.current);
        reportedCardKeyRef.current = null;
        return;
      }

      const recItem = overlays
        .flatMap((angle) => angle.items)
        .find((candidate) => candidate.item_id === itemId);

      const starItem = starfield.find((candidate) => candidate.item_id === itemId);

      const item: RecItem | undefined = recItem ?? (
        starItem
          ? {
              item_id: starItem.item_id,
              title: starItem.title,
              genres: starItem.genres,
              imdb_id: starItem.imdb_id,
              tmdb_id: starItem.tmdb_id,
              rank: 0,
              distance_to_target: 0,
              angular_error_deg: null,
              radius_ratio: null,
              z_x: starItem.z_x,
              z_y: starItem.z_y,
              angle_deg: starItem.angle_deg,
            }
          : undefined
      );

      if (!item) return;

      const pointEl = svgRef.current?.parentElement?.querySelector<SVGCircleElement>(
        `[data-point-item-id="${itemId}"]`
      );

      if (!pointEl) return;

      const key = `${circleKey}:point:${itemId}`;
      showCard({
        key,
        item,
        source: "point",
        rect: pointEl.getBoundingClientRect(),
      });
      reportedCardKeyRef.current = key;
    }, [
      localHoveredPoint,
      overlays,
      starfield,
      circleKey,
      showCard,
      hideCard,
    ]);

  useEffect(() => {
    return () => {
      if (reportedCardKeyRef.current) hideCard(reportedCardKeyRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visiblePoints = useMemo(() => {
    if (!hoveredPoint || hoveredPoint.reference) return [];

    return points
      .filter((point) => {
        if (point.reference) return false;
        if (point.index === hoveredPoint.index) return true;

        const hoveredRadius = pointRadius(hoveredPoint);
        const candidateRadius = pointRadius(point) * DIMMED_POINT_SCALE;
        const combinedRadius = hoveredRadius + candidateRadius;
        const overlapDistance = combinedRadius * (1 - POINT_HOVER_CLUSTER_OVERLAP);
        return distanceBetween(point, hoveredPoint) <= overlapDistance;
      })
      .sort((a, b) => a.y - b.y);
  }, [hoveredPoint, points]);

  useEffect(() => {
    const stage = svgRef.current?.parentElement;
    if (!stage) return;

    const activeIndexes = new Set(
      visiblePoints.map((point) => point.index - (title ? 1 : 0))
    );
    const allPoints = stage.querySelectorAll<SVGCircleElement>(".wheel__rec-point, .wheel__star-point");

    allPoints.forEach((point, index) => {
      const active = hoveredPoint !== null && !hoveredPoint.reference && activeIndexes.has(index);
      point.style.opacity = hoveredPoint === null || active ? "" : String(DIMMED_POINT_OPACITY);
      point.style.transform = hoveredPoint === null ? "" : `scale(${DIMMED_POINT_SCALE})`;
    });

    return () => {
      allPoints.forEach((point) => {
        point.style.opacity = "";
        point.style.transform = "";
      });
    };
  }, [hoveredPoint, title, visiblePoints]);

  if (points.length === 0) return null;

  const setHoveredFromPointer = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return;

    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const pointerPoint = {
      x: ((clientX - rect.left) / rect.width) * gWrap,
      y: ((clientY - rect.top) / rect.height) * gWrap,
    };

    if (localHoveredPoint) {
      const hoveredRadius = pointRadius(localHoveredPoint);
      if (distanceBetween(pointerPoint, localHoveredPoint) <= hoveredRadius + POINT_HOVER_PADDING) {
        return;
      }
    }

    let nearest: Point | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const point of points) {
      const radius = pointRadius(point);
      const distance = distanceBetween(pointerPoint, point);
      if (distance <= radius + POINT_HOVER_PADDING && distance < nearestDistance) {
        nearest = point;
        nearestDistance = distance;
      }
    }

    setHoveredIndex(nearest?.index ?? null);
  };

  const referenceLabel = referencePoint
    ? referenceLabelPosition(referencePoint, referencePoint.title, points.filter((p) => !p.reference), gCenter, gWrap)
    : null;
  const labelOffset = visiblePoints.length > 1
    ? ((visiblePoints.length - 1) * LABEL_LINE_HEIGHT) / 2
    : 0;

  return (
    <svg
      ref={svgRef}
      className="wheel__point-labels"
      viewBox={`0 0 ${gWrap} ${gWrap}`}
      width={displayWrap}
      height={displayWrap}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      onMouseMove={(event) => setHoveredFromPointer(event.clientX, event.clientY)}
      onMouseLeave={() => setHoveredIndex(null)}
      style={{ position: "absolute", inset: 0, overflow: "visible", zIndex: 3, pointerEvents: "auto" }}
    >
      {referencePoint && referenceLabel && (
        <g key="reference-label" style={{ pointerEvents: "none" }}>
          <text
            x={referenceLabel.x}
            y={referenceLabel.y}
            fill="#ffffff"
            fontFamily="Inter, system-ui, sans-serif"
            fontSize={LABEL_FONT}
            fontWeight={650}
            textAnchor={referenceLabel.textAnchor}
            dominantBaseline="middle"
            className="wheel__point-label-text"
            style={{
              filter: "none",
              pointerEvents: "none",
            }}
          >
            {referencePoint.title}
          </text>
        </g>
      )}

      {visiblePoints.map((point, index) => {
        const side = point.x + LABEL_GAP + labelWidth(point.title) <= gWrap ? 1 : -1;
        const textAnchor = side === 1 ? "start" : "end";
        const x = point.x + side * LABEL_GAP;
        const y = point.y - labelOffset + index * LABEL_LINE_HEIGHT;

        return (
          <g key={`label-${point.index}`} style={{ pointerEvents: "none" }}>
            <text
              x={x}
              y={y}
              fill="#ffffff"
              fontFamily="Inter, system-ui, sans-serif"
              fontSize={LABEL_FONT}
              fontWeight={450}
              textAnchor={textAnchor}
              dominantBaseline="middle"
              className="wheel__point-label-text"
              style={{
                filter: "drop-shadow(0 0 7px #e8ecf4)",
                pointerEvents: "none",
              }}
            >
              {point.title}
            </text>
          </g>
        );
      })}

      {hoveredPoint && !hoveredPoint.reference && (
        <g key={`highlight-${hoveredPoint.index}`}>
          <circle
            cx={hoveredPoint.x}
            cy={hoveredPoint.y}
            r={9.5}
            fill="none"
            stroke="rgba(232, 236, 244, 0.75)"
            strokeWidth={1.5}
            opacity={0.95}
            style={{
              filter: "drop-shadow(0 0 9px #e8ecf4)",
              pointerEvents: "none",
            }}
          >
            <animate
              attributeName="opacity"
              values="0.65;1;0.65"
              dur="1.4s"
              repeatCount="indefinite"
            />
            <animate
              attributeName="r"
              values="9.5;12;9.5"
              dur="1.4s"
              repeatCount="indefinite"
            />
          </circle>
          <circle
            cx={hoveredPoint.x}
            cy={hoveredPoint.y}
            r={4.5 * DIMMED_POINT_SCALE}
            fill="#e8ecf4"
            opacity={0.95}
            style={{
              filter: "drop-shadow(0 0 7px #e8ecf4)",
              pointerEvents: "none",
            }}
          >
            <animate
              attributeName="opacity"
              values="0.65;1;0.65"
              dur="1.4s"
              repeatCount="indefinite"
            />
          </circle>
        </g>
      )}
    </svg>
  );
}
