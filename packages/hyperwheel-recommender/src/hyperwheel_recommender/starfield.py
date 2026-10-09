"""
Plane starfield: for each hue plane (a pair of PCA axes), every catalog
item that matches the reference everywhere EXCEPT along the plane, so
that rotating within the plane can reach it (the client gates the pool
by angle and radius, see recommend.py's Stage B).

Character match is the cosine in the feature space (features.py) with
PC1 and the plane's two axes projected out of both the item and the
reference. The basis is orthonormal, so the projection is exact and only
removes the score products on those axes; all planes are evaluated at
once as one (n_items x n_planes) matrix. Per plane, items that are high
robust outliers of the cosine distribution are kept. The per-plane sets
are unioned by item id into one shared pool; each item records the
planes it qualified on, and a circle should only use items that
qualified on its own plane.
"""

from __future__ import annotations

import numpy as np

from .basis import FeatureBasis
from .similarity import feature_cosine

# Robust z-score threshold on the per-plane cosine distribution.
PLANE_OUTLIER_Z = 2.7

# Per-plane ceiling only, guarding against a degenerate distribution.
MAX_NEIGHBORS = 1500


def find_neighbors(
    basis: FeatureBasis,
    reference_item,
    planes: list[tuple[int, int]],
    outlier_z: float = PLANE_OUTLIER_Z,
    max_neighbors: int = MAX_NEIGHBORS,
) -> tuple[np.ndarray, np.ndarray, list[list[int]]]:
    """
    Per-plane search, unioned across planes. `planes` holds 1-based
    (i, j) component pairs (PC1 excluded - it is always projected out).

    Returns (indices, similarities, matched), ordered by descending
    similarity; each item's similarity is its best cosine among the
    planes it qualified on, and `matched[k]` lists the indices into
    `planes` on which item `indices[k]` qualified.
    """
    if reference_item not in basis.items:
        raise ValueError(f"Item '{reference_item}' not found in the data.")
    m = basis.U.shape[0]
    for a, b in planes:
        if a == b or not (2 <= a <= m and 2 <= b <= m):
            raise ValueError(
                f"plane=({a}, {b}) is not a pair of distinct non-PC1 components within 2..{m}."
            )

    ref = basis.items.index(reference_item)
    n = len(basis.items)
    sc = basis.scores

    dot = basis.Phi @ basis.Phi[ref] - sc[:, 0] * sc[ref, 0]
    nrm = basis.norm_sq - sc[:, 0] ** 2
    ia = np.array([p[0] - 1 for p in planes])
    ib = np.array([p[1] - 1 for p in planes])
    dot_p = dot[:, None] - sc[:, ia] * sc[ref, ia] - sc[:, ib] * sc[ref, ib]
    nrm_p = nrm[:, None] - sc[:, ia] ** 2 - sc[:, ib] ** 2
    ref_nrm = nrm[ref] - sc[ref, ia] ** 2 - sc[ref, ib] ** 2
    cos = feature_cosine(dot_p, nrm_p, ref_nrm)

    # Robust z per plane, median/MAD over the catalog without the reference.
    others = np.arange(n) != ref
    med = np.median(cos[others], axis=0)
    mad = np.median(np.abs(cos[others] - med), axis=0)
    z = (cos - med) / (1.4826 * np.maximum(mad, 1e-12))
    z[ref, :] = -np.inf
    hit = z >= outlier_z

    best: dict[int, float] = {}
    matched: dict[int, list[int]] = {}
    for p in range(len(planes)):
        idx = np.flatnonzero(hit[:, p])
        if idx.size > max_neighbors:
            idx = idx[np.argsort(-cos[idx, p])[:max_neighbors]]
        for i in idx:
            i = int(i)
            matched.setdefault(i, []).append(p)
            best[i] = max(best.get(i, -np.inf), float(cos[i, p]))

    ordered = sorted(best, key=lambda i: -best[i])
    return (
        np.array(ordered, dtype=int),
        np.array([best[i] for i in ordered], dtype=np.float32),
        [matched[i] for i in ordered],
    )


def find_plane_neighbors(
    basis: FeatureBasis,
    reference_item,
    planes: list[tuple[int, int]],
    outlier_z: float = PLANE_OUTLIER_Z,
    max_neighbors: int = MAX_NEIGHBORS,
) -> dict[tuple[int, int], np.ndarray]:
    """find_neighbors regrouped by plane: each plane maps to the item
    indices that qualified on that plane."""
    indices, _, matched = find_neighbors(
        basis, reference_item, planes, outlier_z=outlier_z, max_neighbors=max_neighbors,
    )
    by_plane: dict[tuple[int, int], list[int]] = {plane: [] for plane in planes}
    for idx, plane_ids in zip(indices, matched):
        for p in plane_ids:
            by_plane[planes[p]].append(int(idx))
    return {plane: np.array(v, dtype=int) for plane, v in by_plane.items()}