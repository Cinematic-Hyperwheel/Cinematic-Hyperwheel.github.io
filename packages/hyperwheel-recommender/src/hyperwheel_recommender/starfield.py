"""
Plane starfield: every catalog item that shares the reference's tag-space
profile once this plane's own two axes are accounted for, regardless of
where it sits within the plane itself.

Where recommend.py/recommend_many_planes finds items near a ROTATED
TARGET within a hue plane (see /docs/math.md section 5-6c), this module
answers a different question: which items match the reference across
every criterion NOT explained by this plane's own two components, with
no rotation and no angle/radius constraint at all? This reuses exactly
the same character-similarity metric AND selection mechanism Stage A
already uses for scheme candidates (see recommend._base_distance_sq,
recommend._plane_projection_terms, recommend._near_outlier_indices).
_base_distance_sq itself operates on Q_scaled - the standardized TAG
(criterion) space PCA was fit on, not the reduced n_components PCA-score
space - so "everything else" here means every tag outside the 2D
subspace this plane's two axes pull back into within that tag space, not
"the other PCA components". Only the plane's own contribution to that
tag-space distance is projected out, via the same v_i/v_j pullback
directions and Gram-matrix terms recommend_many_planes computes for its
own rotation delta.
"""

from __future__ import annotations

import numpy as np

from .basis import TasteBasis
from .recommend import NEAR_OUTLIER_Z, _base_distance_sq, _near_outlier_indices, _plane_projection_terms

# Hard ceiling only, guarding against a degenerate distribution (e.g. a
# tight near-duplicate cluster in the catalog) returning an unreasonably
# large field. NEAR_OUTLIER_Z (see recommend.py) is what actually decides
# "close" for an ordinary reference; this should essentially never bind
# in practice.
MAX_NEIGHBORS = 500


def find_plane_neighbors(
    basis: TasteBasis,
    reference_item,
    planes: list[tuple[int, int]],
    near_outlier_z: float = NEAR_OUTLIER_Z,
    max_neighbors: int = MAX_NEIGHBORS,
) -> dict[tuple[int, int], np.ndarray]:
    """
    For each requested plane (1-based (i, j) component pair), every item
    that is a statistically significant near-outlier (see
    recommend._near_outlier_indices) on the reference's TAG-SPACE
    distance distribution (_base_distance_sq - standardized shape space
    across every criterion, not the reduced PCA-score space), after
    projecting out this plane's own contribution to that distance, ordered
    by ascending distance.

    The plane's own contribution is removed via orthogonal projection:
    for a difference vector d = Q_scaled[k] - Q_scaled[ref] (Q_scaled
    being the standardized, per-criterion shape vectors PCA was fit on -
    see basis.py) with dot products proj_i(k) = <d, v_i>,
    proj_j(k) = <d, v_j> against the plane's two pullback directions
    (_plane_projection_terms - PC_i and PC_j's own loadings, mapped back
    into criterion space), the squared norm of d's projection onto their
    span is [proj_i proj_j] . G^-1 . [proj_i proj_j]^T, G being their 2x2
    Gram matrix (vpp, vqq, vpq) - the standard formula for projecting
    onto a 2D subspace spanned by a non-orthonormal basis. Subtracting
    that projection from the full tag-space distance leaves exactly the
    part of the distance that this plane's two components don't account
    for - i.e. similarity across every OTHER criterion, not across the
    other PCA components.

    """
    if reference_item not in basis.items:
        raise ValueError(f"Item '{reference_item}' not found in the data.")

    ref_idx = basis.items.index(reference_item)
    base = _base_distance_sq(basis, ref_idx)

    result: dict[tuple[int, int], np.ndarray] = {}
    for plane in planes:
        if max(plane) > len(basis.pc_std):
            raise ValueError(
                f"plane={plane} requires at least {max(plane)} components "
                f"(basis has {len(basis.pc_std)})."
            )
        vpp, vqq, vpq, proj_i, proj_j = _plane_projection_terms(basis, ref_idx, plane)

        det = vpp * vqq - vpq * vpq
        if det <= 1e-12:
            # Degenerate plane (shouldn't happen for two distinct PCA
            # directions) - nothing meaningful to project out.
            proj_sq = np.zeros_like(proj_i)
        else:
            proj_sq = (vqq * proj_i ** 2 - 2.0 * vpq * proj_i * proj_j + vpp * proj_j ** 2) / det

        orth_dist = np.sqrt(np.clip(base - proj_sq, 0.0, None))
        result[plane] = _near_outlier_indices(
            orth_dist, ref_idx, z_threshold=near_outlier_z, max_count=max_neighbors
        )

    return result