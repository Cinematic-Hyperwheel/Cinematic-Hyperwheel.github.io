"""
Plane starfield: every catalog item that shares the reference's
character along one PCA axis at a time, with every other axis'
influence suppressed.

The same neighbor set is also the candidate pool the web client gates by
scheme angle/radius (see find_neighbors and apps/web/README.md).

Where recommend.py/recommend_many_planes finds items near a ROTATED
TARGET within one hue plane (see /docs/math.md section 5-6c), this
module answers a different question: which items resemble the reference
along a single axis' own character, regardless of any other axis?

A single whole-profile similarity search (PC1 always suppressed, see
similarity.py) requires a candidate to resemble the reference on every
axis at once, which can leave very few matches for a reference with a
genuinely distinctive profile on several axes. This module instead runs
one search per axis in `preserve_components`, each time suppressing
every OTHER basis axis' own criteria weights (on top of the PC1
suppression that always applies) via `similarity_to_target`'s
`suppress_loadings` - isolating that one axis' own contribution to
character similarity rather than requiring agreement on all of them at
once. The per-axis outlier sets are then unioned by item id, keeping
each item's best similarity score across the axes it qualified on, and
capped at MAX_NEIGHBORS.

Criteria variance not captured by any of the basis' components (the
long tail beyond however many components were computed - see
build_taste_basis' n_components) is never suppressed by this scheme,
since it has no loadings vector to suppress by; it always contributes
to every axis' search unchanged.

Since the underlying similarity metric is whole-profile (min()/
mismatch-penalty terms have no linear decomposition to project a single
plane's contribution out of), the resulting starfield is the same
regardless of which plane it's requested for - `planes` only shapes
which keys the returned dict has, letting a caller look up one field per
plane the same way it looks up that plane's scheme recommendations.
"""

from __future__ import annotations

import numpy as np

from .basis import TasteBasis
from .similarity import (
    SIMILARITY_OUTLIER_Z,
    high_similarity_outlier_indices,
    similarity_to_target,
)

# Hard ceiling only, guarding against a degenerate distribution (e.g. a
# tight near-duplicate cluster in the catalog, or an unusually large
# number of axes to isolate) returning an unreasonably large field.
# SIMILARITY_OUTLIER_Z is what actually decides "similar enough" for an
# ordinary reference on any one axis; this should essentially never bind
# in practice.
MAX_NEIGHBORS = 1500


def find_neighbors(
    basis: TasteBasis,
    reference_item,
    preserve_components: list[int],
    similarity_outlier_z: float = SIMILARITY_OUTLIER_Z,
    max_neighbors: int = MAX_NEIGHBORS,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Per-axis isolation search (see module docstring), unioned across axes.

    Returns (indices, similarities), both ordered by descending
    similarity; each item's similarity is its best score among the axes it
    qualified on. `preserve_components` is 1-based and typically every
    component except PC1 (see wheel.py's WheelEngine.non_pc1_components).
    """
    if reference_item not in basis.items:
        raise ValueError(f"Item '{reference_item}' not found in the data.")

    n_components = basis.U.shape[0]
    for component in preserve_components:
        if component > n_components:
            raise ValueError(
                f"preserve_components contains {component}, but the basis "
                f"only has {n_components} components."
            )

    ref_idx = basis.items.index(reference_item)

    # Raw [0,1] tag values, reconstructed from the basis (X = L + Q, see
    # basis.py). Shared across every axis' search below.
    X = basis.L[:, None] + basis.Q
    target = X[ref_idx]
    pc1_loadings = basis.U[0]

    # Union by item, not by (item, axis): an item qualifying via several
    # axes is counted once, with its best score.
    best_similarity: dict[int, float] = {}
    for component in preserve_components:
        # Every OTHER basis axis except PC1 (already always suppressed) and
        # except the axis this search preserves.
        other_indices = [j for j in range(1, n_components) if j != component - 1]
        other_loadings = basis.U[other_indices] if other_indices else None

        similarity = similarity_to_target(X, target, pc1_loadings, suppress_loadings=other_loadings)
        outliers = high_similarity_outlier_indices(similarity, ref_idx, z_threshold=similarity_outlier_z)
        for idx in outliers:
            score = float(similarity[idx])
            if score > best_similarity.get(idx, -np.inf):
                best_similarity[idx] = score

    ordered = sorted(best_similarity, key=lambda idx: -best_similarity[idx])[:max_neighbors]
    indices = np.array(ordered, dtype=int)
    similarities = np.array([best_similarity[idx] for idx in ordered], dtype=np.float32)
    return indices, similarities


def find_plane_neighbors(
    basis: TasteBasis,
    reference_item,
    planes: list[tuple[int, int]],
    preserve_components: list[int],
    similarity_outlier_z: float = SIMILARITY_OUTLIER_Z,
    max_neighbors: int = MAX_NEIGHBORS,
) -> dict[tuple[int, int], np.ndarray]:
    """
    find_neighbors keyed by plane. The neighbor set is plane-independent
    (see module docstring); `planes` only shapes the returned dict's keys
    and is validated against the basis for consistency with the rest of
    the package.
    """
    for plane in planes:
        if max(plane) > len(basis.pc_std):
            raise ValueError(
                f"plane={plane} requires at least {max(plane)} components "
                f"(basis has {len(basis.pc_std)})."
            )
    indices, _ = find_neighbors(
        basis, reference_item, preserve_components,
        similarity_outlier_z=similarity_outlier_z, max_neighbors=max_neighbors,
    )
    return {plane: indices for plane in planes}