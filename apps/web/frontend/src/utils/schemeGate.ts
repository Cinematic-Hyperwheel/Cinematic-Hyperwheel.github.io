import type {
  DisplacedMatch,
  NeighborItem,
  NeighborsResponse,
  RecAngle,
  RecItem,
  RecommendCircle,
  StarfieldItem,
} from "../api";

// Recommendations shown per scheme angle (and the legend's page size).
export const TOP_K = 6;

// A plane becomes a circle only if the reference is pronounced on both
// of its axes (|z| in whitened units). The pool itself is computed for
// every plane, so neighbors that are pronounced on an axis where the
// reference is weak are still found, but only as points on circles the
// reference actually has a character on.
const AXIS_Z_MIN = 0;
const MIN_CIRCLES = 1;

const RAD_TO_DEG = 180 / Math.PI;
const TWO_PI = Math.PI * 2;

interface Candidate {
  item: NeighborItem;
  zx: number;
  zy: number;
  r: number;
  theta: number;
  /** PC pairs of the planes this item qualified on. */
  qualified: [number, number][];
}

interface Eligible {
  cand: Candidate;
  angleErr: number;
  radiusMismatch: number;
  bucket: number;
}

interface BuiltCircle {
  circle: RecommendCircle;
  radius: number;
  /** Total matches across angles, each angle capped at TOP_K. Used for ordering only. */
  rankedTotal: number;
  /** Match count of the weakest angle, capped at TOP_K. */
  minPerAngle: number;
  /** Unique matched item ids across all angles (uncapped). */
  matched: Set<number>;
}

/** Gate-ordering key: (angle bucket, radius mismatch, exact angle error), smaller is closer to the rotated target. */
type MatchKey = [number, number, number];

interface ScoredMatch {
  item: RecItem;
  key: MatchKey;
}

interface PlaneMatches {
  i: number;
  j: number;
  refX: number;
  refY: number;
  cands: Candidate[];
  maxRadius: number;
  angles: { angleDeg: number; scored: ScoredMatch[] }[];
  pcs: [number, number];
}

function compareKeys(a: MatchKey, b: MatchKey): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function circularDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % TWO_PI;
  return Math.min(d, TWO_PI - d);
}

function bearingDeg(theta: number): number {
  return (((theta * RAD_TO_DEG) % 360) + 360) % 360;
}

/**
 * Stage B of the engine (recommend.py's _stage_ab_rows) applied to the
 * neighbor pool: rotate the reference within the plane, keep candidates
 * inside the angle AND radius window around the rotated target, then
 * order by angle bucket, radius mismatch, exact angle and finally
 * similarity. Tolerances come from the server so they are defined once.
 * Each match carries its ordering key so matches can be compared across
 * planes (see dedupeAcrossPlanes).
 */
function recommendAtAngle(
  cands: Candidate[],
  refX: number,
  refY: number,
  schemeAngleDeg: number,
  gate: NeighborsResponse["gate"]
): ScoredMatch[] {
  const rot = schemeAngleDeg / RAD_TO_DEG;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const tx = c * refX - s * refY;
  const ty = s * refX + c * refY;
  const targetR = Math.hypot(tx, ty);
  const targetTheta = Math.atan2(ty, tx);
  // A target at the origin has no meaningful radius to compare against.
  const hasRadius = targetR > 1e-9;

  const eligible: Eligible[] = [];
  for (const cand of cands) {
    const angleErr = circularDiff(cand.theta, targetTheta);
    if (angleErr > gate.angle_tol_rad) continue;
    let radiusMismatch = 0;
    if (hasRadius) {
      radiusMismatch = Math.abs(Math.log(Math.max(cand.r, 1e-6) / Math.max(targetR, 1e-6)));
      if (radiusMismatch > gate.radius_tol_log) continue;
    }
    eligible.push({ cand, angleErr, radiusMismatch, bucket: Math.round(angleErr / gate.angle_tol_rad) });
  }

  eligible.sort(
    (a, b) =>
      a.bucket - b.bucket ||
      a.radiusMismatch - b.radiusMismatch ||
      a.angleErr - b.angleErr ||
      b.cand.item.similarity - a.cand.item.similarity
  );

  return eligible.map((e) => ({
    key: [e.bucket, e.radiusMismatch, e.angleErr],
    item: {
      item_id: e.cand.item.item_id,
      title: e.cand.item.title,
      genres: e.cand.item.genres,
      imdb_id: e.cand.item.imdb_id,
      tmdb_id: e.cand.item.tmdb_id,
      rank: 0, // assigned after cross-plane deduplication
      angular_error_deg: e.angleErr * RAD_TO_DEG,
      radius_ratio: hasRadius ? e.cand.r / targetR : null,
      z_x: e.cand.zx,
      z_y: e.cand.zy,
      angle_deg: bearingDeg(e.cand.theta),
      similarity: e.cand.item.similarity,
      qualified_planes: e.cand.qualified,
    },
  }));
}

/**
 * Keeps every item as a match in exactly one place. The owning plane is
 * the one with the larger reference radius (the reference is more
 * pronounced there); within that plane, the angle where the item sits
 * closest to the rotated target by the gate ordering key. Remaining ties
 * (equal radius, or the same plane) fall back to the ordering key, then
 * to the plane that comes first in component-pair order.
 */
function dedupeAcrossPlanes(planes: PlaneMatches[]): DisplacedMatch[][] {
  //return;

  const radius = planes.map((p) => Math.hypot(p.refX, p.refY));
  const best = new Map<number, { plane: number; angle: number; key: MatchKey }>();
  planes.forEach((p, pi) =>
    p.angles.forEach((a, ai) =>
      a.scored.forEach((m) => {
        const cur = best.get(m.item.item_id);
        const wins =
          !cur ||
          radius[pi] > radius[cur.plane] ||
          (radius[pi] === radius[cur.plane] && compareKeys(m.key, cur.key) < 0);
        if (wins) best.set(m.item.item_id, { plane: pi, angle: ai, key: m.key });
      })
    )
  );

  // Per plane: the matches it lost to another plane, for diagnostics.
  const displaced: DisplacedMatch[][] = planes.map(() => []);
  planes.forEach((p, pi) =>
    p.angles.forEach((a, ai) => {
      a.scored = a.scored.filter((m) => {
        const owner = best.get(m.item.item_id)!;
        if (owner.plane === pi && owner.angle === ai) return true;
        displaced[pi].push({
          item_id: m.item.item_id,
          title: m.item.title,
          owner_pcs: planes[owner.plane].pcs,
          owner_angle_deg: planes[owner.plane].angles[owner.angle].angleDeg,
        });
        return false;
      });
    })
  );
  return displaced;
}

/**
 * Builds every circle (each pair of curated components) for a scheme from
 * the neighbor pool: per-angle recommendations (top-K for lists, all gate
 * matches for the big wheel) plus a star field of the remaining pool items.
 * An item matched on several circles is kept only on the one where it is
 * closest to the rotated target (see dedupeAcrossPlanes); on the others it
 * falls back to the star field.
 * Circles are ordered by the match count of their weakest scheme angle (descending),
 * then by total matches, then by the reference radius; the first one is primary.
 * Circles whose matches are fully included in another circle's matches are omitted.
 */
export function buildCircles(data: NeighborsResponse, scheme: string): RecommendCircle[] {
  const schemeAngles = data.schemes[scheme];
  if (!schemeAngles) return [];
  const { pcs, axes, reference, items, gate, planes: planeDefs } = data;

  const strong = (pc: number) => Math.abs(reference[pc - 1]) >= AXIS_Z_MIN;
  let usable = planeDefs
    .map((def, p) => ({ def, p }))
    .filter(({ def: [a, b] }) => strong(a) && strong(b));

  // Fallback so a typical reference (no pronounced axes) still gets a
  // circle: the plane with the largest reference radius.
  if (usable.length < MIN_CIRCLES) {
    usable = planeDefs
      .map((def, p) => ({ def, p }))
      .sort(
        (x, y) =>
          Math.hypot(reference[y.def[0] - 1], reference[y.def[1] - 1]) -
          Math.hypot(reference[x.def[0] - 1], reference[x.def[1] - 1])
      )
      .slice(0, MIN_CIRCLES);
  }

  const planes: PlaneMatches[] = [];

  // One shared array per item. Building it per (plane, item) pair would be
  // quadratic in the number of planes an item qualifies on.
  const qualifiedByItem = new Map<number, [number, number][]>();
  for (const item of items) {
    qualifiedByItem.set(item.item_id, item.planes.map((q) => planeDefs[q]));
  }

  usable.forEach(({ def: [pcA, pcB], p }) => {

    const i = pcs.indexOf(pcA);
    const j = pcs.indexOf(pcB);
    const refX = reference[pcA - 1];
    const refY = reference[pcB - 1];

    // Only items that qualified on this exact plane.
    const cands: Candidate[] = items
      .filter((item) => item.planes.includes(p))
      .map((item) => {
        const zx = item.z[i];
        const zy = item.z[j];
        return {
          item, zx, zy, r: Math.hypot(zx, zy), theta: Math.atan2(zy, zx),
          qualified: qualifiedByItem.get(item.item_id)!,
        };
      });
    const maxRadius = cands.reduce((m, c) => Math.max(m, c.r), Math.hypot(refX, refY));

    planes.push({
      i, j, pcs: [pcA, pcB], refX, refY, cands, maxRadius,
      angles: schemeAngles.map((angleDeg) => ({
        angleDeg,
        scored: recommendAtAngle(cands, refX, refY, angleDeg, gate),
      })),
    });
  });

  const displaced = dedupeAcrossPlanes(planes);

  const built: BuiltCircle[] = [];

  for (const [pi, plane] of planes.entries()) {
    const { i, j, refX, refY, cands, maxRadius } = plane;

    const angles: RecAngle[] = plane.angles.map(({ angleDeg, scored }) => {
      const matches = scored.map((m, k) => ({ ...m.item, rank: k + 1 }));
      return { angle_deg: angleDeg, items: matches.slice(0, TOP_K), matches };
    });

    const used = new Set<number>();
    // Matches beyond TOP_K are not visible in the lists, so they give no
    // ordering advantage: each angle contributes at most TOP_K.
    let rankedTotal = 0;
    for (const a of angles) {
      rankedTotal += Math.min(a.matches.length, TOP_K);
      for (const it of a.matches) used.add(it.item_id);
    }

    const starfield: StarfieldItem[] = [];
    for (const cand of cands) {
      if (used.has(cand.item.item_id)) continue;
      starfield.push({
        item_id: cand.item.item_id,
        title: cand.item.title,
        genres: cand.item.genres,
        imdb_id: cand.item.imdb_id,
        tmdb_id: cand.item.tmdb_id,
        z_x: cand.zx,
        z_y: cand.zy,
        angle_deg: bearingDeg(cand.theta),
        similarity: cand.item.similarity,
        qualified_planes: cand.qualified,
      });
    }

    // Capped match count of the circle's weakest angle: a circle that
    // fills every angle ranks above one concentrated on a single angle.
    const minPerAngle = angles.reduce(
      (m, a) => Math.min(m, Math.min(a.matches.length, TOP_K)),
      angles.length > 0 ? Infinity : 0
    );

    const radius = Math.hypot(refX, refY);
    built.push({
      radius,
      rankedTotal,
      minPerAngle,
      matched: used,
      circle: {
        primary: false,
        axis_x: axes[i],
        axis_y: axes[j],
        max_radius: maxRadius,
        reference: {
          z_x: refX,
          z_y: refY,
          angle_deg: bearingDeg(Math.atan2(refY, refX)),
          radius,
        },
        angles,
        starfield,
        debug: { displaced: displaced[pi] },
      },
    });
  }

  // Array.prototype.sort is stable: equal keys keep component-pair order.
  // Match counts are capped at TOP_K per angle, so once every angle of two
  // circles is saturated the reference radius decides.
  built.sort(
    // still experimenting with sorting
    (a, b) => /*b.minPerAngle - a.minPerAngle ||*/ b.rankedTotal - a.rankedTotal || b.radius - a.radius
  );

  // After deduplication matched sets are disjoint across circles, so only
  // circles without any match could be "contained"; the subset check is
  // kept as a guard for empty-vs-nonempty edge cases.
  const isSubset = (a: Set<number>, b: Set<number>) => {
    for (const id of a) if (!b.has(id)) return false;
    return true;
  };
  const kept = built.filter((b, i) => {
    if (b.matched.size === 0) return true;
    return !built.some(
      (o, k) =>
        k !== i &&
        isSubset(b.matched, o.matched) &&
        (o.matched.size > b.matched.size || k < i)
    );
  });

  const circles = kept.map((b) => b.circle);
  circles.forEach((c, k) => {
    c.primary = k === 0;
  });
  return circles;
}

/**
 * Overlays for the big wheel: same angles, but `items` carries every
 * gate-passing match instead of the top-K subset.
 */
export function withAllMatches(angles: RecAngle[] | undefined): RecAngle[] | undefined {
  return angles?.map((a) => ({ ...a, items: a.matches }));
}