"""
Find real items matching a chosen color-wheel scheme.
"""

from __future__ import annotations

import sys

import numpy as np
import pandas as pd

from .basis import FeatureBasis, build_feature_basis
from .planes import select_hue_plane
from .rotation import SCHEMES
from .similarity import feature_cosine, high_similarity_outlier_indices

ANGLE_TOL_RAD = np.radians(15.0)  # bucket width for "angularly tied" candidates in Stage B,
                                   # and the hard angle gate; public so callers can reuse the gate.

# HARD radius tolerance for Stage B, |log(cand_r / target_r)|. Whitened radius has no
# fixed absolute scale (it varies per reference and plane), so the gate is a
# dimensionless symmetric ratio. Public, like ANGLE_TOL_RAD.
RADIUS_TOL_LOG = np.log(1.2)

_RESULT_COLUMNS = [
    "scheme", "angle_deg", "rank", "item",
    "distance_to_target", "angular_error_deg", "radius_ratio",
]


def _circular_diff_rad(a: np.ndarray | float, b: float) -> np.ndarray | float:
    """Smallest absolute angular distance between a and b, wrapped to [0, pi]."""
    d = np.abs(a - b) % (2 * np.pi)
    return np.minimum(d, 2 * np.pi - d)


def recommend_on_basis(
    basis: FeatureBasis,
    reference_item: str,
    scheme: str,
    plane: tuple[int, int],
    top_k: int = 5,
    shortlist_size: int = 50,
) -> pd.DataFrame:
    """
    Single-plane recommendations; a thin wrapper around
    recommend_many_planes([plane]).

    plane: explicit 1-based (i, j) component pair forming the hue plane.
    shortlist_size: safety cap on the Stage A shortlist (see
    _stage_ab_rows); must be >= top_k.
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


def recommend_many_planes(
    basis: FeatureBasis,
    reference_item: str,
    scheme: str,
    planes: list[tuple[int, int]],
    top_k: int = 5,
    shortlist_size: int = 50,
) -> dict[tuple[int, int], pd.DataFrame]:
    """
    Stage A/B recommendations for MANY hue planes against the SAME
    reference item in one call.

    The rotated target is the reference's feature vector shifted along the
    plane's two axes, Phi_t = Phi_ref + dy_i*U_i + dy_j*U_j. U is
    orthonormal, so every inner product with the target and its squared
    norm follow from the reference's cached inner products and the item
    scores - no pass over the feature matrix per (plane, angle).

    Returns: {plane: DataFrame} in the schema recommend_on_basis returns.
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
    sc = basis.scores
    y_ref = sc[ref_idx].astype(np.float64)
    g = basis.Phi @ basis.Phi[ref_idx]          # inner product of every item with the reference
    n_ref = float(basis.norm_sq[ref_idx])

    results: dict[tuple[int, int], pd.DataFrame] = {}

    for plane in planes:
        if max(plane) > len(basis.pc_std):
            raise ValueError(
                f"plane={plane} requires at least {max(plane)} components "
                f"(basis has {len(basis.pc_std)})."
            )
        pi, pj = plane[0] - 1, plane[1] - 1
        std_i, std_j = float(basis.pc_std[pi]), float(basis.pc_std[pj])

        # Every item's own whitened angle in the hue plane.
        z_i_all = sc[:, pi] / std_i
        z_j_all = sc[:, pj] / std_j
        angle_all = np.arctan2(z_j_all, z_i_all)

        rows: list[dict] = []
        for angle_deg in SCHEMES[scheme]:
            theta = np.radians(angle_deg)
            z_i, z_j = y_ref[pi] / std_i, y_ref[pj] / std_j
            c_, s_ = np.cos(theta), np.sin(theta)
            z_i_new = c_ * z_i - s_ * z_j
            z_j_new = s_ * z_i + c_ * z_j
            dy_i = z_i_new * std_i - y_ref[pi]
            dy_j = z_j_new * std_j - y_ref[pj]

            dot = g + dy_i * sc[:, pi] + dy_j * sc[:, pj]
            n_t = n_ref + 2 * dy_i * y_ref[pi] + 2 * dy_j * y_ref[pj] + dy_i ** 2 + dy_j ** 2
            dists = np.sqrt(np.clip(basis.norm_sq + n_t - 2.0 * dot, 0.0, None))

            # Character similarity with PC1 projected out; the target's own
            # PC1 score moves only if the plane contains PC1.
            t0 = y_ref[0] + (dy_i if pi == 0 else 0.0) + (dy_j if pj == 0 else 0.0)
            similarity = feature_cosine(
                dot - sc[:, 0] * t0, basis.norm_sq - sc[:, 0] ** 2, n_t - t0 ** 2
            )

            rows.extend(_stage_ab_rows(
                dists, similarity, ref_idx, z_i_all, z_j_all, angle_all,
                float(np.hypot(z_i_new, z_j_new)), float(np.arctan2(z_j_new, z_i_new)),
                shortlist_size, top_k, basis.items, scheme, angle_deg,
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
    hue_components: an explicit 1-based (i, j) pair fixed across items, or
        "auto" to pick, per reference, the two components on which THAT
        item is most expressive (see planes.select_hue_plane).
    exclude_components, candidate_components: only used with "auto".
    shortlist_size: safety cap on the Stage A shortlist.
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

    basis = build_feature_basis(wide, n_components=n_components, standardize=standardize)
    ref_idx = basis.items.index(reference_item)

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

    plane = (resolved_components[0] - 1, resolved_components[1] - 1)

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
        f"(PCA explained variance: {basis.explained.sum():.1%})\n"
    )
    return result


def _stage_ab_rows(
    dists: np.ndarray,
    similarity: np.ndarray,
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
    Stage A (character shortlist) + Stage B (angle/radius hard-gated
    re-rank) for one scheme angle.

    Selection is two-stage because a single full-space nearest-neighbor
    search conflates "still feels like the reference" with "actually sits
    at the target angle": the target differs from the reference along two
    axes only, so the remaining dimensions dominate a naive distance.

    Stage A: items that are a statistically significant HIGH outlier of
        the catalog's similarity distribution to the rotated target
        (robust modified z-score, see
        similarity.high_similarity_outlier_indices), capped at
        `shortlist_size` as a safety ceiling. Because the target differs
        from the reference only inside the plane, a similar candidate is
        similar to the reference everywhere else too.
    Stage B: shortlist items are eligible only inside the angle window
        (ANGLE_TOL_RAD) and radius window (RADIUS_TOL_LOG) around the
        target. Among eligible items the coarse angle bucket keeps
        angularly tied candidates together, the tightest radius wins
        within a bucket, and the exact angle breaks the remaining ties.

    dists: (n_items,) feature-space distance to the rotated target,
        reported as `distance_to_target` only.
    similarity: (n_items,) cosine to the rotated target with PC1 removed.

    Returns a list of row dicts, empty if nothing is a similarity outlier
    or nothing clears both gates for this angle.
    """
    shortlist = high_similarity_outlier_indices(similarity, ref_idx, max_count=shortlist_size)
    if shortlist.size == 0:
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