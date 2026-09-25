"""
packages/hyperwheel-recommender/src/hyperwheel_recommender/starfield.py

Plane starfield: every catalog item that shares the reference's
pronounced-attribute profile, regardless of where it sits within a given
hue plane.

Where recommend.py/recommend_many_planes finds items near a ROTATED
TARGET within one hue plane (see /docs/math.md section 5-6c), this
module answers a different question: which items resemble the reference
overall? Similarity here is measured with the same
"pronounced-attribute overlap" metric as recommend.py's Stage A
shortlist (see similarity.py) - a fuzzy-set overlap over raw [0,1] tag
values, not a distance in the standardized PCA shape space. That metric
is inherently whole-profile (min() has no linear decomposition to
project a single plane's contribution out of, the way the earlier
Euclidean-distance version of this module did), so a reference's
starfield is the same regardless of which plane it's requested for -
`planes` only shapes which keys the returned dict has, letting a caller
look up one field per plane the same way it looks up that plane's scheme
recommendations.
"""

from __future__ import annotations

import numpy as np

from .basis import TasteBasis
from .similarity import (
    SIMILARITY_OUTLIER_Z,
    high_similarity_outlier_indices,
    normalize_item_tags,
    similarity_to_target,
)

# Hard ceiling only, guarding against a degenerate distribution (e.g. a
# tight near-duplicate cluster in the catalog) returning an unreasonably
# large field. SIMILARITY_OUTLIER_Z is what actually decides "similar
# enough" for an ordinary reference; this should essentially never bind
# in practice.
MAX_NEIGHBORS = 1500


def find_plane_neighbors(
    basis: TasteBasis,
    reference_item,
    planes: list[tuple[int, int]],
    similarity_outlier_z: float = SIMILARITY_OUTLIER_Z,
    max_neighbors: int = MAX_NEIGHBORS,
) -> dict[tuple[int, int], np.ndarray]:
    """
    For each requested plane, every item that is a statistically
    significant outlier on the HIGH side of the reference's own
    similarity distribution across the catalog (see
    similarity.high_similarity_outlier_indices), ordered by descending
    similarity.

    Since the similarity metric is whole-profile rather than
    plane-relative, every entry in the returned dict holds the same
    neighbor array - `planes` only controls which keys are present.
    Plane indices are still validated against the basis for API
    consistency with the rest of the package (recommend.py, planes.py),
    even though they play no role in the computation itself.
    """
    if reference_item not in basis.items:
        raise ValueError(f"Item '{reference_item}' not found in the data.")

    for plane in planes:
        if max(plane) > len(basis.pc_std):
            raise ValueError(
                f"plane={plane} requires at least {max(plane)} components "
                f"(basis has {len(basis.pc_std)})."
            )

    ref_idx = basis.items.index(reference_item)

    # Raw [0,1] tag values, reconstructed from the basis (X = L + Q, see
    # basis.py) - avoids re-reading the source wide table the basis was
    # already built from.
    X = basis.L[:, None] + basis.Q
    normalized = normalize_item_tags(X)

    similarity = similarity_to_target(normalized, normalized[ref_idx])
    neighbors = high_similarity_outlier_indices(
        similarity, ref_idx, z_threshold=similarity_outlier_z, max_count=max_neighbors
    )

    return {plane: neighbors for plane in planes}