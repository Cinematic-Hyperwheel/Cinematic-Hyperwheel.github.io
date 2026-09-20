"""Find real items matching a chosen color-wheel scheme."""

from __future__ import annotations

import sys

import numpy as np
import pandas as pd

from .basis import TasteBasis, build_taste_basis
from .planes import select_hue_plane
from .rotation import SCHEMES

ANGLE_TOL_RAD = np.radians(15.0)  # bucket width for "angularly tied" candidates in Stage B;
                                   # see /docs/math.md section 6b - radius only breaks ties
                                   # within this window, it never overrides a clearly better angle

# HARD radius tolerance for Stage B, |log(cand_r / target_r)|. Whitened radius
# ("saturation") has no fixed absolute scale - it varies per reference item and per
# plane - so the gate is a dimensionless, symmetric ratio; RADIUS_TOL_LOG is tunable
# (e.g. log(1.5) ~ +/-50%; the tighter the window, the fewer candidates pass).
# A candidate is eligible for Stage B only if its radius is within this window.
RADIUS_TOL_LOG = np.log(1.1)

# Threshold on the "modified z-score" (Iglewicz & Hoaglin's robust
# outlier statistic: (x - median) / (1.4826 * MAD), MAD = median
# absolute deviation) below which an item counts as a genuine outlier on
# the NEAR side of a distance distribution - i.e. meaningfully closer
# than the bulk of the catalog, not merely "one of the N closest
# available regardless of how close that actually is". A fixed top-N
# alone can't tell those apart: if fewer than N items are genuinely
# close, the rest are padding that can still slip through Stage B's
# angle/radius gate by coincidence (see _stage_ab_rows) and be reported
# as a match despite sharing little of the reference's character. -3.5
# is the conventional cutoff for this statistic; also used by
# starfield.find_plane_neighbors for the same reason.
NEAR_OUTLIER_Z = -2.5


def _near_outlier_indices(
    dists: np.ndarray,
    exclude_idx: int,
    z_threshold: float = NEAR_OUTLIER_Z,
    max_count: int | None = None,
) -> np.ndarray:
    """
    Indices of items that are a statistically significant near-outlier on
    `dists`' own distribution across the catalog (robust modified
    z-score, median/MAD rather than mean/std, since the bulk of the
    distribution - not the near tail itself - should anchor "typical"),
    ordered by ascending distance. `exclude_idx` (the reference item) is
    always excluded regardless of its own distance. `max_count`, if
    given, is a safety CAP on how many are returned (guards against a
    degenerate distribution producing an unreasonably large result) - it
    never pads the result back up if fewer items actually qualify.
    Self-calibrating per call: a distribution with only a handful of
    genuinely close items yields a handful of results, one with hundreds
    yields hundreds.
    """
    d = dists.copy()
    d[exclude_idx] = np.inf
    finite = d[np.isfinite(d)]
    if finite.size == 0:
        return np.array([], dtype=int)
    median = np.median(finite)
    mad = np.median(np.abs(finite - median))
    if mad < 1e-12:
        # Every item (effectively) equidistant - nothing statistically
        # stands out as "close".
        return np.array([], dtype=int)
    modified_z = (d - median) / (1.4826 * mad)
    candidates = np.where(modified_z <= z_threshold)[0]
    order = candidates[np.argsort(d[candidates])]
    return order[:max_count] if max_count is not None else order

_RESULT_COLUMNS = [
    "scheme", "angle_deg", "rank", "item",
    "distance_to_target", "angular_error_deg", "radius_ratio",
]


def _circular_diff_rad(a: np.ndarray | float, b: float) -> np.ndarray | float:
    """Smallest absolute angular distance between a and b, wrapped to [0, pi]."""
    d = np.abs(a - b) % (2 * np.pi)
    return np.minimum(d, 2 * np.pi - d)


def recommend_on_basis(
    basis: TasteBasis,
    reference_item: str,
    scheme: str,
    plane: tuple[int, int],
    top_k: int = 5,
    shortlist_size: int = 50,
) -> pd.DataFrame:
    """
    Single-plane, single-reference recommendations. Thin wrapper around
    recommend_many_planes([plane]) - kept as a distinct entry point
    because it's public API (see __init__.py) and the CLI's single
    `--hue-components i,j` path (recommend() below) calls it directly
    with exactly one plane.

    plane: explicit 1-based (i, j) component pair forming the hue plane
        on which to rotate (the caller decides it - typically the same
        reviewed, labelled plane the wheel UI shows). shortlist_size:
        safety cap on the Stage-A character shortlist (see
        _stage_ab_rows / _near_outlier_indices) - Stage A itself already
        selects only statistically close items; this just bounds how
        many, at most, enter Stage B. Must be >= top_k.
    """
    if reference_item not in basis.items:
        raise ValueError(f"Item '{reference_item}' not found in the data.")
    if scheme not in SCHEMES:
        raise ValueError(f"Unknown scheme '{scheme}'. Available: {list(SCHEMES)}")
    if max(plane) > len(basis.pc_std):
        raise ValueError(
            f"plane={plane} requires at least {max(plane)} components "
            f"(basis has {len(basis.pc_std)})."
        )
    if shortlist_size < top_k:
        raise ValueError(
            f"shortlist_size ({shortlist_size}) must be >= top_k ({top_k})."
        )
    return recommend_many_planes(
        basis, reference_item, scheme, planes=[plane],
        top_k=top_k, shortlist_size=shortlist_size,
    )[plane]

def _base_distance_sq(basis: TasteBasis, ref_idx: int) -> np.ndarray:
    """
    Squared standardized shape-space distance from every item to the
    reference - Stage A's own character-similarity metric (see
    _stage_ab_rows): ||Q_scaled[k] - Q_scaled[ref]||^2 across every
    criterion, not just a PCA-reduced subset. Shared by
    recommend_many_planes (as the base term before a plane's rotation
    delta is added) and starfield.find_plane_neighbors (as the full,
    un-adjusted distance used with no rotation at all). Computed once per
    reference - the only O(n_items x n_criteria) pass either caller needs.
    """
    dot_ref = basis.Q_scaled @ basis.Q_scaled[ref_idx]
    base = basis.Q_norm_sq + basis.Q_norm_sq[ref_idx] - 2.0 * dot_ref
    return np.clip(base, 0.0, None)


def _plane_projection_terms(
    basis: TasteBasis, ref_idx: int, plane: tuple[int, int]
) -> tuple[float, float, float, np.ndarray, np.ndarray]:
    """
    Per-plane geometry shared by recommend_many_planes and
    starfield.find_plane_neighbors: the plane's own two axis directions
    pulled back into standardized shape space (v_pi, v_pj), their Gram
    matrix entries (vpp, vqq, vpq), and every item's own dot product with
    each direction relative to the reference (proj_i, proj_j) - see
    /docs/math.md section 6c for the derivation. proj_i(k) is exactly
    <Q_scaled[k] - Q_scaled[ref], v_pi> (verified by matching terms
    against recommend_many_planes's own distance expansion). O(n_criteria)
    for the scalars, O(n_items) for proj_i/proj_j.
    """
    pi, pj = plane[0] - 1, plane[1] - 1
    y_ref = basis.scores[ref_idx]

    w_pi = basis.U[pi] * basis.scale
    w_pj = basis.U[pj] * basis.scale
    mw_pi, mw_pj = w_pi.mean(), w_pj.mean()
    v_pi = (w_pi - mw_pi) * basis.inv_scale
    v_pj = (w_pj - mw_pj) * basis.inv_scale
    vpp = float(v_pi @ v_pi)
    vqq = float(v_pj @ v_pj)
    vpq = float(v_pi @ v_pj)

    proj_i = (basis.scores[:, pi] - y_ref[pi]) - mw_pi * (basis.s - basis.s[ref_idx])
    proj_j = (basis.scores[:, pj] - y_ref[pj]) - mw_pj * (basis.s - basis.s[ref_idx])

    return vpp, vqq, vpq, proj_i, proj_j

def recommend_many_planes(
    basis: TasteBasis,
    reference_item: str,
    scheme: str,
    planes: list[tuple[int, int]],
    top_k: int = 5,
    shortlist_size: int = 50,
) -> dict[tuple[int, int], pd.DataFrame]:
    """
    Stage A/B recommendations for MANY hue planes against the SAME
    reference item in one call - the shape a web endpoint needs when it
    shows one circle per curated axis pair (see apps/web/backend, which
    calls this once per /recommend request instead of once per circle).

    Algebraic shortcut (see /docs/math.md section 6c): for a fixed
    reference, a rotation confined to plane (i, j) only ever moves the
    target within the 2D subspace spanned by U[i], U[j]. This means Stage
    A distance to every candidate decomposes into a per-item "base" term
    that is IDENTICAL across every plane and angle (computed once here,
    O(n_items x n_criteria)), plus per-plane scalars (O(n_criteria),
    independent of n_items) and O(n_items) vector arithmetic per (plane,
    angle). This is an exact algebraic identity of the previous
    full-reconstruction Stage A distance (target_vec = X[ref] + delta,
    then a fresh O(n_items x n_criteria) norm per angle) - not an
    approximation of it. Verified: identical
    item order and distance_to_target (to float rounding) on every plane
    and every scheme tested. Concretely, `dists` computed below is the
    exact same STANDARDIZED SHAPE SPACE distance Stage A has always used
    ((Q - M) / scale, not raw criteria units - see _stage_ab_rows's
    docstring for why that matters) - the algebraic decomposition changes
    HOW it's computed, never WHAT it measures.

    planes: each entry is an explicit 1-based (i, j) component pair
        forming a hue plane to rotate within (the caller decides it -
        typically the same reviewed, labelled planes the wheel UI shows,
        one per circle). shortlist_size: safety cap on the Stage-A
        character shortlist (see _stage_ab_rows / _near_outlier_indices),
        shared across every plane and angle in this call.

    Returns: {plane: DataFrame}, one entry per requested plane, each in
    the same schema recommend_on_basis returns (scheme, angle_deg, rank,
    item, distance_to_target, angular_error_deg, radius_ratio).
    """
    if reference_item not in basis.items:
        raise ValueError(f"Item '{reference_item}' not found in the data.")
    if scheme not in SCHEMES:
        raise ValueError(f"Unknown scheme '{scheme}'. Available: {list(SCHEMES)}")
    if shortlist_size < top_k:
        raise ValueError(
            f"shortlist_size ({shortlist_size}) must be >= top_k ({top_k})."
        )

    ref_idx = basis.items.index(reference_item)
    base = _base_distance_sq(basis, ref_idx)
    y_ref = basis.scores[ref_idx]

    results: dict[tuple[int, int], pd.DataFrame] = {}

    for plane in planes:
        if max(plane) > len(basis.pc_std):
            raise ValueError(
                f"plane={plane} requires at least {max(plane)} components "
                f"(basis has {len(basis.pc_std)})."
            )
        pi, pj = plane[0] - 1, plane[1] - 1   # 1-based -> 0-based
        std_i, std_j = basis.pc_std[pi], basis.pc_std[pj]
        vpp, vqq, vpq, proj_i, proj_j = _plane_projection_terms(basis, ref_idx, plane)

        # Precompute every item's own whitened angle in the hue plane once -
        # basis.scores is already in the same (scaled, doubly-centered) space
        # as y_ref/y_target, so no re-projection from X is needed here.
        z_i_all = basis.scores[:, pi] / std_i
        z_j_all = basis.scores[:, pj] / std_j
        angle_all = np.arctan2(z_j_all, z_i_all)

        rows: list[dict] = []
        for angle_deg in SCHEMES[scheme]:
            # Same rotation math as rotation.rotate_whitened, inlined here
            # to avoid materializing/copying the full y vector per angle -
            # only the two plane components ever change.
            theta = np.radians(angle_deg)
            z_i, z_j = y_ref[pi] / std_i, y_ref[pj] / std_j
            c_, s_ = np.cos(theta), np.sin(theta)
            z_i_new = c_ * z_i - s_ * z_j
            z_j_new = s_ * z_i + c_ * z_j
            dy_i = z_i_new * std_i - y_ref[pi]
            dy_j = z_j_new * std_j - y_ref[pj]

            dists_sq = (
                base
                - 2.0 * dy_i * proj_i
                - 2.0 * dy_j * proj_j
                + dy_i * dy_i * vpp
                + dy_j * dy_j * vqq
                + 2.0 * dy_i * dy_j * vpq
            )
            dists = np.sqrt(np.clip(dists_sq, 0.0, None))

            target_r = float(np.hypot(z_i_new, z_j_new))
            target_angle = float(np.arctan2(z_j_new, z_i_new))

            rows.extend(_stage_ab_rows(
                dists, ref_idx, z_i_all, z_j_all, angle_all,
                target_r, target_angle, shortlist_size, top_k,
                basis.items, scheme, angle_deg,
            ))

        results[plane] = pd.DataFrame(rows, columns=_RESULT_COLUMNS)

    return results

def recommend(
    wide: pd.DataFrame,
    reference_item: str,
    scheme: str,
    n_components: int = 3,
    top_k: int = 5,
    standardize: bool = True,
    hue_components: tuple[int, int] | str = (2, 3),
    exclude_components: tuple[int, ...] = (1,),
    candidate_components: int | None = None,
    shortlist_size: int = 50,
) -> pd.DataFrame:
    """
    hue_components: either an explicit 1-based (i, j) pair, fixed across
        all reference items, or the string "auto" to pick, per reference,
        the two components on which THAT item is most expressive (see
        planes.select_hue_plane). "auto" is generally the better default
        when the variance spectrum is diffuse (no clearly dominant pair) -
        see /docs/math.md, section 7.
    exclude_components, candidate_components: only used when
        hue_components="auto" - passed straight to select_hue_plane.
    shortlist_size: safety cap on the Stage-A character shortlist (see
        recommend_on_basis / _near_outlier_indices).
    """
    if reference_item not in wide.index:
        raise ValueError(f"Item '{reference_item}' not found in the data.")
    if scheme not in SCHEMES:
        raise ValueError(f"Unknown scheme '{scheme}'. Available: {list(SCHEMES)}")
    if n_components < 2:
        raise ValueError("n_components must be >= 2.")
    if hue_components != "auto" and max(hue_components) > n_components:
        raise ValueError(
            f"hue_components={hue_components} requires n_components >= "
            f"{max(hue_components)} (currently {n_components})."
        )

    basis = build_taste_basis(wide, n_components=n_components, standardize=standardize)
    
    ref_idx = basis.items.index(reference_item)
    L_ref = basis.L[ref_idx]
    q_ref = basis.Q[ref_idx]
    y_ref = basis.U @ ((q_ref - basis.M) / basis.scale)   # projection in the scaled, doubly-centered space
    S_ref = np.linalg.norm(q_ref - basis.M)

    if hue_components == "auto":
        resolved_components = select_hue_plane(
            basis, ref_idx,
            exclude_components=exclude_components,
            candidate_components=candidate_components,
        )
        print(
            f"[info] auto-selected hue plane for '{reference_item}': "
            f"PC{resolved_components[0]}/PC{resolved_components[1]} "
            f"(this item's own most expressive axes, excluding {exclude_components})",
            file=sys.stderr,
        )
    else:
        resolved_components = hue_components

    plane = (resolved_components[0] - 1, resolved_components[1] - 1)   # 1-based -> 0-based

    aspect = basis.pc_std[plane[0]] / basis.pc_std[plane[1]] if basis.pc_std[plane[1]] > 0 else float("inf")
    if aspect > 2 or aspect < 0.5:
        print(
            f"[info] spread ratio PC{resolved_components[0]}/PC{resolved_components[1]} = "
            f"{aspect:.2f} - the plane is noticeably elongated, rotation is "
            f"performed in whitened coordinates.",
            file=sys.stderr,
        )

    plane_var = basis.explained[plane[0]] + basis.explained[plane[1]]
    print(
        f"[info] hue plane PC{resolved_components[0]}/PC{resolved_components[1]} "
        f"explains {plane_var:.1%} of variance combined - Stage A (shortlist_size="
        f"{shortlist_size}) enforces character similarity on the rest; Stage B "
        f"re-ranks that shortlist by angle in this plane.",
        file=sys.stderr,
    )

    result = recommend_on_basis(
        basis,
        reference_item=reference_item,
        scheme=scheme,
        plane=resolved_components,
        top_k=top_k,
        shortlist_size=shortlist_size,
    )
    print(
        f"\nReference: {reference_item}  "
        f"(L={L_ref:.3f}, S={S_ref:.3f}, "
        f"PCA explained variance: {basis.explained.sum():.1%})\n"
    )
    return result
    
def _stage_ab_rows(
    dists: np.ndarray,
    ref_idx: int,
    z_i_all: np.ndarray,
    z_j_all: np.ndarray,
    angle_all: np.ndarray,
    target_r: float,
    target_angle: float,
    shortlist_size: int,
    top_k: int,
    items: list,
    scheme: str,
    angle_deg: float,
) -> list[dict]:
    """
    Shared Stage A (character shortlist) + Stage B (angle/radius hard-gated
    re-rank) core. Used by BOTH recommend_on_basis (single plane) and
    recommend_many_planes (many planes, same reference) - the only thing
    that differs between callers is how `dists` itself is computed (full
    O(n_items x n_criteria) norm vs. the algebraic per-plane shortcut);
    this function's logic is otherwise identical regardless of caller, so
    it lives in exactly one place instead of being duplicated per caller.

    Selection is two-stage because a single full-space nearest-neighbor
    search conflates two different things the scheme is supposed to
    deliver at once - "still feels like the reference" and "actually sits
    at the target angle" - and when the hue plane explains only a modest
    share of total variance (see /docs/math.md, section 6b), the first
    criterion silently drowns out the second: the target differs from the
    reference in only two of hundreds of dimensions, so full-space
    distance is dominated by everything BUT the rotation.

    Stage A (character shortlist): `dists` (computed by the caller) is
        the distance from each candidate to the rotated target, measured
        in the STANDARDIZED SHAPE SPACE the PCA basis was fit on - i.e.
        distance between each candidate's own (Q - M) / scale and the
        target's own (Q - M) / scale - NOT raw Euclidean distance in the
        original [0,1] criteria units. This is what enforces "preserving
        the reference's overall character" (/docs/math.md section 5,
        readme "Delta reconstruction"): delta is nonzero only inside the
        hue plane, so distance in the OTHER dimensions is a genuine
        measure of shared character - but only if measured in the same
        standardized space PCA itself uses, since raw criteria units let
        a large-L or high-variance criterion dominate the distance
        regardless of actual shape similarity. The shortlist itself is
        the items that are a statistically significant near-outlier on
        the LOW side of `dists`' own distribution (_near_outlier_indices,
        NEAR_OUTLIER_Z) - not simply the `shortlist_size` closest
        available regardless of how close that is: with a fixed top-N,
        an item far from the reference can still be "closest available"
        purely because too few genuinely close items exist, and later
        passing Stage B's angle/radius gate by coincidence doesn't make
        it a good match. `shortlist_size` is a safety CAP on this
        near-outlier set, not the selection mechanism itself (see
        _near_outlier_indices).
    Stage B (angular re-rank): among that shortlist, keep the `top_k`
        whose own position in the (whitened) hue plane is angularly
        closest to the target angle - i.e. the ones that actually express
        the requested rotation, not just any nearby item. This is a HARD
        gate on a sector of (angle, radius), not a single blended score:
        a candidate is eligible only if BOTH its angular error is within
        ANGLE_TOL_RAD of the target angle AND its radius is within
        RADIUS_TOL_LOG (a dimensionless log-ratio, since whitened radius
        has no fixed absolute scale) of the target radius. Among eligible
        candidates, the coarse angle bucket (width ANGLE_TOL_RAD) keeps
        angularly "tied" candidates together and lets the tightest radius
        win within a bucket, with the exact angle as the final tie-break.

    shortlist_size: safety cap on how many near-outlier candidates Stage
        B ever has to consider (see _near_outlier_indices) - not a target
        pool size to fill regardless of actual closeness. Must be >=
        top_k (enforced by the callers, not here).

    dists: (n_items,) Stage-A distance for THIS scheme angle. The
        ref_idx entry is excluded from the shortlist regardless of its
        own value (see _near_outlier_indices) - never recommend the
        reference to itself. `dists` itself is left untouched by this
        function; each returned row's `distance_to_target` is read
        straight from it, so callers can inspect it directly, but it is
        not comparable to a naive `||X_a - X_b||` computed elsewhere (raw
        criteria units).

    Returns a list of row dicts (possibly empty, if no candidate is a
    near-outlier at all, or none clears both the angle and radius gates
    for this angle - see /docs/math.md section 6b). Each row's
    `angular_error_deg` is how far (in degrees, within the hue plane) the
    chosen item's own position sits from the exact target angle - 0 would
    be a perfect angular match.
    """
    shortlist = _near_outlier_indices(dists, ref_idx, max_count=shortlist_size)
    if shortlist.size == 0:
        # No candidate is a statistically meaningful character match for
        # this reference at all - report nothing rather than fall back to
        # "closest available regardless of how close that is".
        return []

    cand_r = np.hypot(z_i_all[shortlist], z_j_all[shortlist])
    angle_err = _circular_diff_rad(angle_all[shortlist], target_angle)
    radius_mismatch = (
        np.abs(np.log(np.maximum(cand_r, 1e-6) / max(target_r, 1e-6)))
        if target_r > 1e-9 else np.zeros_like(cand_r)
    )
    radius_ok = (
        radius_mismatch <= RADIUS_TOL_LOG
        if target_r > 1e-9 else np.ones_like(radius_mismatch, dtype=bool)
    )
    both = radius_ok & (angle_err <= ANGLE_TOL_RAD)
    eligible = shortlist[both]
    if eligible.size == 0:
        # no candidates within both the radius and angle sectors: report
        # nothing for this angle rather than substitute an unsuitable item
        return []

    el_angle = angle_err[both]
    el_radius = radius_mismatch[both]
    el_bucket = np.round(el_angle / ANGLE_TOL_RAD)
    order = eligible[np.lexsort((el_angle, el_radius, el_bucket))][:top_k]

    cand_r_ord = np.hypot(z_i_all[order], z_j_all[order])
    ang_err_ord = np.degrees(_circular_diff_rad(angle_all[order], target_angle))

    rows = []
    for rank, (idx, ce, ar) in enumerate(zip(order, cand_r_ord, ang_err_ord), start=1):
        rows.append({
            "scheme": scheme,
            "angle_deg": angle_deg,
            "rank": rank,
            "item": items[idx],
            "distance_to_target": round(float(dists[idx]), 4),
            "angular_error_deg": round(float(ar), 2),
            "radius_ratio": round(float(ce / target_r), 3) if target_r > 1e-9 else None,
        })
    return rows