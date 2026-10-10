import type { RecItem, RecommendCircle } from "../api";
import { useDebug } from "../contexts/DebugContext";
import { circleKey } from "../utils/circleKey";
import "./DebugInfo.css";

const DISPLACED_SHOWN = 5;

const fmtAngle = (deg: number) => `${deg > 0 ? "+" : ""}${deg}°`;
const fmtPcs = (pcs: [number, number]) => `PC${pcs[0]}/PC${pcs[1]}`;

/** Global ordinal badge for one recommendation ("#17"). */
export function RecNumber({ cKey, itemId }: { cKey: string; itemId: number }) {
  const { enabled, numbering } = useDebug();
  if (!enabled) return null;
  const n = numbering.get(`${cKey}:${itemId}`);
  return n ? <span className="dbg-num">#{n}</span> : null;
}

/** Per-circle technical readout: axes, reference intensity, match counts. */
export function CircleDebugInfo({ circle }: { circle: RecommendCircle }) {
  const { enabled } = useDebug();
  if (!enabled) return null;
  const ref = circle.reference;
  const matches = circle.angles.map((a) => `${fmtAngle(a.angle_deg)}:${a.matches.length}`);
  const displaced = circle.debug?.displaced ?? [];
  return (
    <div className="dbg-block">
      <div>PC{circle.axis_x.pc} (x) / PC{circle.axis_y.pc} (y) · {circleKey(circle)}</div>
      {ref && (
        <>
          <div>z_x {ref.z_x.toFixed(2)} · z_y {ref.z_y.toFixed(2)}</div>
          <div>r {ref.radius.toFixed(2)} · θ {ref.angle_deg.toFixed(1)}° · r_max {circle.max_radius?.toFixed(2) ?? "—"}</div>
        </>
      )}
      <div>matches {matches.join("  ")}</div>
      <div>starfield {circle.starfield.length} · displaced {displaced.length}</div>
      {displaced.slice(0, DISPLACED_SHOWN).map((d) => (
        <div key={d.item_id}>
          ↳ <span className="dbg-mark">-</span>{d.title} #{d.item_id} → {fmtPcs(d.owner_pcs)} {fmtAngle(d.owner_angle_deg)}
        </div>
      ))}
      {displaced.length > DISPLACED_SHOWN && <div>↳ …+{displaced.length - DISPLACED_SHOWN}</div>}
    </div>
  );
}

/** Per-item readout for the info card: ids, similarity, pool planes, gate errors. */
export function ItemDebugInfo({ item }: { item: RecItem }) {
  const { enabled } = useDebug();
  if (!enabled) return null;
  return (
    <div className="dbg-block">
      <div>id {item.item_id} · imdb {item.imdb_id ?? "—"} · tmdb {item.tmdb_id ?? "—"}</div>
      {item.similarity !== undefined && <div>sim {item.similarity.toFixed(4)}</div>}
      {/* {item.qualified_planes && <div>planes {item.qualified_planes.map(fmtPcs).join(" ")}</div>} */}
      <div>z_x {item.z_x.toFixed(2)} · z_y {item.z_y.toFixed(2)} · θ {item.angle_deg.toFixed(1)}°</div>
      {item.angular_error_deg != null && (
        <div>Δθ {item.angular_error_deg.toFixed(1)}° · r-ratio {item.radius_ratio?.toFixed(2) ?? "—"}</div>
      )}
    </div>
  );
}

/** Page-level readout, pinned to the viewport corner. */
export function DebugHud({ lines }: { lines: string[] }) {
  const { enabled } = useDebug();
  if (!enabled) return null;
  return (
    <div className="dbg-hud" aria-hidden="true">
      {lines.map((l) => <div key={l}>{l}</div>)}
    </div>
  );
}

/**
 * Search marker rendered directly before a displayed recommendation title
 * ("+Title"); displaced matches use "-Title". Lets in-page text search tell
 * the two apart.
 */
export function RecMark() {
  const { enabled } = useDebug();
  return enabled ? <span className="dbg-mark">+</span> : null;
}