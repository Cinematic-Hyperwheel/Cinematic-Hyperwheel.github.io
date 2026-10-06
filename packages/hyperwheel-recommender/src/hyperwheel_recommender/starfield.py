"""
Plane starfield: every catalog item that shares the reference's
character once one PCA axis at a time is dropped from the comparison,
unioned over all such axes.

The same neighbor set can serve as a scheme-independent candidate pool,
to be gated by scheme angle and radius afterwards (recommend.py's
Stage B).

Where recommend.py/recommend_many_planes finds items near a ROTATED
TARGET within one hue plane (see /docs/math.md section 5-6c), this
module answers a different question: which items resemble the reference
everywhere except along a given axis?

A single whole-profile similarity search (PC1 always suppressed, see
similarity.py) requires a candidate to resemble the reference on every
axis at once, which can leave very few matches for a reference with a
genuinely distinctive profile on several axes. This module instead runs
one search per axis in `drop_components`, each time suppressing that
axis' own criteria weights (on top of the PC1 suppression that always
applies) via `similarity_to_target`'s `suppress_loadings`. A candidate
may therefore differ from the reference along the dropped axis, which is
what lets such items surface as neighbors. The per-axis outlier sets are
then unioned by item id, keeping each item's best similarity score
across the axes it qualified on, and capped at MAX_NEIGHBORS.

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
# number of axes to drop) returning an unreasonably large field.
# SIMILARITY_OUTLIER_Z is what actually decides "similar enough" for an
# ordinary reference on any one axis; this should essentially never bind
# in practice.
MAX_NEIGHBORS = 1500


def find_neighbors(
    basis: TasteBasis,
    reference_item,
    drop_components: list[int],
    similarity_outlier_z: float = SIMILARITY_OUTLIER_Z,
    max_neighbors: int = MAX_NEIGHBORS,
) -> tuple[np.ndarray, np.ndarray, list[list[int]]]:
    """
    Per-axis drop search (see module docstring), unioned across axes.

    Returns (indices, similarities, dropped), all ordered by descending
    similarity; each item's similarity is its best score among the axes
    it qualified on, and `dropped[k]` lists (ascending, 1-based) every
    axis whose drop made item `indices[k]` qualify. `drop_components` is
    1-based and typically every component except PC1.
    """
    if reference_item not in basis.items:
        raise ValueError(f"Item '{reference_item}' not found in the data.")

    n_components = basis.U.shape[0]
    for component in drop_components:
        if component < 1 or component > n_components:
            raise ValueError(
                f"drop_components contains {component}, but the basis "
                f"has components 1..{n_components}."
            )

    ref_idx = basis.items.index(reference_item)

    # Raw [0,1] tag values, reconstructed from the basis (X = L + Q, see
    # basis.py). Shared across every axis' search below.
    X = basis.L[:, None] + basis.Q
    target = X[ref_idx]
    pc1_loadings = basis.U[0]

    # Union by item, not by (item, axis): an item qualifying via several
    # axes is counted once, with its best score and every axis it
    # qualified on.
    best_similarity: dict[int, float] = {}
    dropped_by_item: dict[int, list[int]] = {}
    for component in sorted(set(drop_components)):
        similarity = similarity_to_target(
            X, target, pc1_loadings, suppress_loadings=basis.U[component - 1]
        )
        outliers = high_similarity_outlier_indices(similarity, ref_idx, z_threshold=similarity_outlier_z)
        for idx in outliers:
            idx = int(idx)
            dropped_by_item.setdefault(idx, []).append(component)
            score = float(similarity[idx])
            if score > best_similarity.get(idx, -np.inf):
                best_similarity[idx] = score

    ordered = sorted(best_similarity, key=lambda idx: -best_similarity[idx])[:max_neighbors]
    indices = np.array(ordered, dtype=int)
    similarities = np.array([best_similarity[idx] for idx in ordered], dtype=np.float32)
    dropped = [dropped_by_item[idx] for idx in ordered]
    return indices, similarities, dropped


def find_plane_neighbors(
    basis: TasteBasis,
    reference_item,
    planes: list[tuple[int, int]],
    drop_components: list[int],
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
    indices, _, _ = find_neighbors(
        basis, reference_item, drop_components,
        similarity_outlier_z=similarity_outlier_z, max_neighbors=max_neighbors,
    )
    return {plane: indices for plane in planes}