import type {
  NeighborItem,
  NeighborsResponse,
  RecAngle,
  RecItem,
  RecommendCircle,
  StarfieldItem,
} from "../api";

// Recommendations shown per scheme angle.
const TOP_K = 6;

const RAD_TO_DEG = 180 / Math.PI;
const TWO_PI = Math.PI * 2;

interface Candidate {
  item: NeighborItem;
  zx: number;
  zy: number;
  r: number;
  theta: number;
}

interface Eligible {
  cand: Candidate;
  angleErr: number;
  radiusMismatch: number;
  bucket: number;
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
 */
function recommendAtAngle(
  cands: Candidate[],
  refX: number,
  refY: number,
  schemeAngleDeg: number,
  gate: NeighborsResponse["gate"]
): RecItem[] {
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

  return eligible.map((e, k) => ({
    item_id: e.cand.item.item_id,
    title: e.cand.item.title,
    genres: e.cand.item.genres,
    imdb_id: e.cand.item.imdb_id,
    tmdb_id: e.cand.item.tmdb_id,
    rank: k + 1,
    angular_error_deg: e.angleErr * RAD_TO_DEG,
    radius_ratio: hasRadius ? e.cand.r / targetR : null,
    z_x: e.cand.zx,
    z_y: e.cand.zy,
    angle_deg: bearingDeg(e.cand.theta),
  }));
}

/**
 * Builds every circle (each pair of curated components) for a scheme from
 * the neighbor pool: per-angle recommendations (top-K for lists, all gate
 * matches for the big wheel) plus a star field of the remaining pool items.
 * Circles are ordered by the match count of their weakest scheme angle (descending),
 * then by total matches, then by the reference radius; the first one is primary.
 * Circles whose matches are fully included in another circle's matches are omitted.
 */
export function buildCircles(data: NeighborsResponse, scheme: string): RecommendCircle[] {
  const schemeAngles = data.schemes[scheme];
  if (!schemeAngles) return [];
  const { pcs, axes, reference, items, gate } = data;
  
  const built: {
    circle: RecommendCircle;
    radius: number;
    total: number;
    minPerAngle: number;
    matched: Set<number>;
  }[] = [];

  for (let i = 0; i < pcs.length; i++) {
    for (let j = i + 1; j < pcs.length; j++) {
      const refX = reference[i];
      const refY = reference[j];

      const cands: Candidate[] = items.map((item) => {
        const zx = item.z[i];
        const zy = item.z[j];
        return { item, zx, zy, r: Math.hypot(zx, zy), theta: Math.atan2(zy, zx) };
      });
      
      const maxRadius = cands.reduce((m, c) => Math.max(m, c.r), Math.hypot(refX, refY)); 

      const angles: RecAngle[] = schemeAngles.map((angleDeg) => {
        const matches = recommendAtAngle(cands, refX, refY, angleDeg, gate);
        return { angle_deg: angleDeg, items: matches.slice(0, TOP_K), matches };
      });

      const used = new Set<number>();
      let total = 0;
      for (const a of angles) {
        total += a.matches.length;
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
        });
      }

      // Match count of the circle's weakest angle: a circle that fills
      // every angle ranks above one concentrated on a single angle.
      const minPerAngle = angles.reduce(
        (m, a) => Math.min(m, a.matches.length),
        angles.length > 0 ? Infinity : 0
      );

      const radius = Math.hypot(refX, refY);
      built.push({
        radius,
        total,
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
        },
      });
    }
  }

  // Array.prototype.sort is stable: equal keys keep component-pair order.
  built.sort(
    (a, b) => b.minPerAngle - a.minPerAngle || b.total - a.total || b.radius - a.radius
  );

  // A circle whose matches are fully contained in another circle's matches
  // adds nothing new and is dropped. Of two circles with identical match
  // sets, the higher-ranked one is kept. Circles without matches are kept
  // as is.
  const isSubset = (a: Set<number>, b: Set<number>) => {
    for (const id of a) if (!b.has(id)) return false;
    return true;
  };
  const kept = built.filter((b, i) => {
    if (b.total === 0) return true;
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