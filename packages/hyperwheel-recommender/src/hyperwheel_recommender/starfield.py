"""
Plane starfield: for each hue plane (a pair of PCA axes), every catalog
item that shares the reference's character once that plane is projected
out of the comparison - i.e. items "next to the reference in the sky"
when viewed along the plane's own two axes.

Where recommend.py/recommend_many_planes finds items near a ROTATED
TARGET within one hue plane (see /docs/math.md section 5-6c), this
module finds items that match the reference everywhere EXCEPT along the
plane, so that rotating within the plane can then reach them (the client
gates them by angle and radius, see recommend.py's Stage B).

For each plane the contribution of its two components is subtracted from
every catalog item and from the reference (see plane_residual), and the
whole-profile similarity of the residuals (similarity.py, PC1 always
down-weighted) is tested for statistically significant high outliers.
The per-plane outlier sets are unioned by item id into one shared pool;
each item records which planes it qualified on, and a circle should only
use items that qualified on its own plane.

The residual is computed in raw [0, 1] tag space and clipped back into
that range, so it is an approximation of the plane's removal, which is
sufficient for outlier selection.
"""

from __future__ import annotations

import numpy as np

from .basis import TasteBasis
from .similarity import (
    SIMILARITY_OUTLIER_Z,
    high_similarity_outlier_indices,
    similarity_to_target,
)

# Per-plane ceiling only, guarding against a degenerate distribution
# (e.g. a tight near-duplicate cluster in the catalog). SIMILARITY_OUTLIER_Z
# is what actually decides "similar enough"; this should essentially
# never bind in practice.
MAX_NEIGHBORS = 5000


def plane_residual(basis: TasteBasis, X: np.ndarray, plane: tuple[int, int]) -> np.ndarray:
    """
    Raw tag values with the contribution of the plane's two components
    removed. Scores live in the standardized shape space, so the
    components' directions are mapped back through `scale` before being
    subtracted from the raw values.
    """
    cols = [c - 1 for c in plane]
    contrib = basis.scores[:, cols] @ (basis.U[cols] * basis.scale)
    residual = np.clip(X - contrib, 0.0, 1.0)
    return np.ascontiguousarray(residual, dtype=np.float32)


# Modified z-score threshold for "closer to the reference than the bulk
# of the catalog" on the plane-excluded distance. The distance
# distribution is bounded below, so its near tail is thinner than the
# similarity metric's; tune independently of SIMILARITY_OUTLIER_Z.
PLANE_OUTLIER_Z = 1.7


def find_neighbors(
    basis: TasteBasis,
    reference_item,
    planes: list[tuple[int, int]],
    outlier_z: float = PLANE_OUTLIER_Z,
    max_neighbors: int = MAX_NEIGHBORS,
) -> tuple[np.ndarray, np.ndarray, list[list[int]]]:
    """
    Per-plane projection search, unioned across planes. `planes` holds
    1-based (i, j) component pairs.

    The distance to the reference with PC1 and the plane's two axes
    removed is exact and cheap: the basis is orthonormal, so it is the
    full standardized-shape-space distance minus the squared score
    differences on those axes. All planes are evaluated at once as one
    (n_items x n_planes) matrix.

    Returns (indices, similarities, matched), ordered by descending
    similarity (negative distance); `matched[k]` lists the indices into
    `planes` on which item `indices[k]` is a high outlier.
    `max_neighbors` caps each plane's own outlier set.
    """
    if reference_item not in basis.items:
        raise ValueError(f"Item '{reference_item}' not found in the data.")

    n_components = basis.U.shape[0]
    for a, b in planes:
        if a == b or not (2 <= a <= n_components and 2 <= b <= n_components):
            raise ValueError(
                f"plane=({a}, {b}) is not a pair of distinct non-PC1 "
                f"components within 2..{n_components}."
            )

    ref = basis.items.index(reference_item)
    n = len(basis.items)

    base = np.clip(
        basis.Q_norm_sq + basis.Q_norm_sq[ref] - 2.0 * (basis.Q_scaled @ basis.Q_scaled[ref]),
        0.0, None,
    )
    ds2 = (basis.scores - basis.scores[ref]) ** 2            # (n, n_components)
    rest = base - ds2[:, 0]                                  # PC1 always removed
    ia = np.array([p[0] - 1 for p in planes])
    ib = np.array([p[1] - 1 for p in planes])
    d2 = rest[:, None] - ds2[:, ia] - ds2[:, ib]             # (n, n_planes)
    s = -np.sqrt(np.clip(d2, 0.0, None))

    # Robust z per plane, median/MAD over the catalog without the reference.
    others = np.arange(n) != ref
    med = np.median(s[others], axis=0)
    mad = np.median(np.abs(s[others] - med), axis=0)
    z = (s - med) / (1.4826 * np.maximum(mad, 1e-12))
    z[ref, :] = -np.inf
    hit = z >= outlier_z

    best_similarity: dict[int, float] = {}
    matched: dict[int, list[int]] = {}
    for p in range(len(planes)):
        idx = np.flatnonzero(hit[:, p])
        if idx.size > max_neighbors:
            idx = idx[np.argsort(-s[idx, p])[:max_neighbors]]
        for i in idx:
            i = int(i)
            matched.setdefault(i, []).append(p)
            best_similarity[i] = max(best_similarity.get(i, -np.inf), float(s[i, p]))

    ordered = sorted(best_similarity, key=lambda i: -best_similarity[i])
    indices = np.array(ordered, dtype=int)
    similarities = np.array([best_similarity[i] for i in ordered], dtype=np.float32)
    return indices, similarities, [matched[i] for i in ordered]


def find_plane_neighbors(
    basis: TasteBasis,
    reference_item,
    planes: list[tuple[int, int]],
    similarity_outlier_z: float = SIMILARITY_OUTLIER_Z,
    max_neighbors: int = MAX_NEIGHBORS,
) -> dict[tuple[int, int], np.ndarray]:
    """find_neighbors regrouped by plane: each plane maps to the item
    indices that qualified on that plane."""
    indices, _, matched = find_neighbors(
        basis, reference_item, planes,
        outlier_z=similarity_outlier_z, max_neighbors=max_neighbors,
    )
    by_plane: dict[tuple[int, int], list[int]] = {plane: [] for plane in planes}
    for idx, plane_ids in zip(indices, matched):
        for p in plane_ids:
            by_plane[planes[p]].append(int(idx))
    return {plane: np.array(v, dtype=int) for plane, v in by_plane.items()}