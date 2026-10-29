import type {
  AxisConfig,
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

// A plane becomes a circle only if the reference is pronounced on BOTH of
// its axes: the weaker axis must reach AXIS_Z_MIN. Z is the whitened
// coordinate (standard deviations from the category mean), so one
// threshold fits every component. The pool itself is computed for every
// plane regardless.
const AXIS_Z_MIN = 0.0;
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
  /** Reference radius in the plane (diagnostics). */
  radius: number;
  /** planeScore of the reference; ordering tie-break between circles. */
  score: number;
  /** Total matches across angles, each angle capped at TOP_K. Used for ordering only. */
  rankedTotal: number;
  /** Match count of the weakest angle, capped at TOP_K. */
  minPerAngle: number;
  /** Unique matched item ids across all angles (uncapped). */
  matched: Set<number>;
  /** Weighted plane score of the reference; orders the circles. */
  rankScore: number;
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
  /** Character weights of the poles the reference points to on the x and y axes. */
  weights: [number, number];
  /** Weighted plane score of the reference: the order circles are
   * deduplicated and displayed in. */
  rankScore: number;
}

/** |z| of the weaker axis: a plane is only as meaningful as its weakest axis. */
function weakAxis(zx: number, zy: number): number {
  return Math.min(Math.abs(zx), Math.abs(zy));
}

/**
 * Geometric mean of |zx| and |zy|. Radius-like (stronger reference scores
 * higher) but lopsided planes score low: one dominant axis paired with a
 * noise axis would otherwise outrank a plane with two pronounced axes.
 */
function planeScore(zx: number, zy: number): number {
  return Math.sqrt(Math.abs(zx * zy));
}

/**
 * planeScore with the character weights of the poles the reference points
 * to. Each weight scales its axis's |z|, so the effect is proportional to
 * how strongly the reference is expressed toward that pole.
 */
function weightedPlaneScore(zx: number, zy: number, wx: number, wy: number): number {
  return Math.sqrt(wx * wy * Math.abs(zx * zy));
}

/** Character weight of the pole of `axis` that coordinate `z` points to. */
function poleWeight(axis: AxisConfig, z: number): number {
  const w = axis.character_weight;
  if (!w) return 1;
  return z >= 0 ? w.positive : w.negative;
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
    // still experimenting with sorting
    (a, b) =>
      // a.bucket - b.bucket ||
      // a.radiusMismatch - b.radiusMismatch ||
      //a.angleErr - b.angleErr //||
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
 * Keeps every item as a match in exactly one place, filling circles
 * evenly instead of letting the strongest one absorb everything.
 *
 * Circles are visited in their display order (highest rank score first,
 * the same key buildCircles sorts by). Within a circle, the first TOP_K
 * matches of each angle are "firm": they are the visible ones, and no
 * other circle can take them. Matches beyond TOP_K are "soft": they stay
 * with the circle only until a later circle can show them within its own
 * TOP_K. An item nobody else can show stays where it was first seen, so
 * the big wheel still plots every match.
 *
 * An item matched at several angles of one plane is kept at the angle
 * closest to the rotated target (gate ordering key).
 */
function dedupeAcrossPlanes(planes: PlaneMatches[]): DisplacedMatch[][] {
  // Per plane: the matches it lost to another plane, for diagnostics.
  const displaced: DisplacedMatch[][] = planes.map(() => []);

  // return displaced;

  // Array.prototype.sort is stable: equal scores keep component-pair
  // order, exactly as in buildCircles' final sort.
  const order = planes.map((_, pi) => pi).sort((a, b) => planes[b].rankScore - planes[a].rankScore);

  interface Owner {
    plane: number;
    angle: number;
    firm: boolean;
  }
  const owners = new Map<number, Owner>();

  for (const pi of order) {
    const plane = planes[pi];

    const bestAngle = new Map<number, { angle: number; key: MatchKey }>();
    plane.angles.forEach((a, ai) =>
      a.scored.forEach((m) => {
        const cur = bestAngle.get(m.item.item_id);
        if (!cur || compareKeys(m.key, cur.key) < 0) {
          bestAngle.set(m.item.item_id, { angle: ai, key: m.key });
        }
      })
    );

    plane.angles.forEach((a, ai) => {
      // Candidates keep their ranking order; items firmly owned by a
      // stronger circle are not available here.
      const open = a.scored.filter(
        (m) => bestAngle.get(m.item.item_id)!.angle === ai && !owners.get(m.item.item_id)?.firm
      );
      open.forEach((m, k) => {
        const id = m.item.item_id;
        if (k < TOP_K) owners.set(id, { plane: pi, angle: ai, firm: true });
        else if (!owners.has(id)) owners.set(id, { plane: pi, angle: ai, firm: false });
      });
    });
  }

  planes.forEach((p, pi) =>
    p.angles.forEach((a, ai) => {
      a.scored = a.scored.filter((m) => {
        const owner = owners.get(m.item.item_id)!;
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
 * An item matched on several circles is kept on one of them: circles
 * are visited in display order, each keeps its top-K per angle, and its
 * surplus matches go to later circles that can show them (see
 * dedupeAcrossPlanes); on the others the item falls back to the star
 * field.
 * Circles are ordered by the match count of their weakest scheme angle (descending),
 * then by total matches, then by the reference radius; the first one is primary.
 * Circles whose matches are fully included in another circle's matches are omitted.
 */
export function buildCircles(data: NeighborsResponse, scheme: string): RecommendCircle[] {
  const schemeAngles = data.schemes[scheme];
  if (!schemeAngles) return [];
  const { pcs, axes, reference, items, gate, planes: planeDefs } = data;

  const strong = (pc: number) => Math.abs(reference[pc - 1]) >= AXIS_Z_MIN;
  const rankScoreOf = (a: number, b: number) => {
      const za = reference[a - 1];
      const zb = reference[b - 1];
      return weightedPlaneScore(
        za, zb,
        poleWeight(axes[pcs.indexOf(a)], za),
        poleWeight(axes[pcs.indexOf(b)], zb)
      );
    };
  let usable = planeDefs
  .map((def, p) => ({ def, p }))
  .filter(({ def: [a, b] }) => weakAxis(reference[a - 1], reference[b - 1]) >= AXIS_Z_MIN);

  // Fallback so a typical reference (no pronounced axes) still gets a
  // circle: the most balanced plane.
  if (usable.length < MIN_CIRCLES) {
    usable = planeDefs
      .map((def, p) => ({ def, p }))
      .sort((x, y) => rankScoreOf(y.def[0], y.def[1]) - rankScoreOf(x.def[0], x.def[1]))
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
    const wx = poleWeight(axes[i], refX);
    const wy = poleWeight(axes[j], refY);

    planes.push({
      i, j, pcs: [pcA, pcB], refX, refY, cands, maxRadius,
      weights: [wx, wy],
      rankScore: weightedPlaneScore(refX, refY, wx, wy),
      angles: schemeAngles.map((angleDeg) => ({
        angleDeg,
        scored: recommendAtAngle(cands, refX, refY, angleDeg, gate),
      })),
    });
  });

  // (bug): move to after built.sort
  const displaced = dedupeAcrossPlanes(planes);

  const built: BuiltCircle[] = [];

    for (const [pi, plane] of planes.entries()) {
    const { i, j, refX, refY, cands, maxRadius, weights: [wx, wy], rankScore } = plane;

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
      rankScore,
      score: planeScore(refX, refY),
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
        debug: {
          displaced: displaced[pi],
          raw_score: planeScore(refX, refY),
          rank_score: rankScore,
          weights: [wx, wy],
        },
      },
    });
  }

  // Array.prototype.sort is stable: equal keys keep component-pair order.
  // Match counts are capped at TOP_K per angle, so once every angle of two
  // circles is saturated the reference radius decides.
  built.sort(
    // still experimenting with sorting
    (a, b) => /*b.minPerAngle - a.minPerAngle || b.rankedTotal - a.rankedTotal || b.radius - a.radius || */ b.rankScore  - a.rankScore
  );

  const circles = built.map((b) => b.circle);
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