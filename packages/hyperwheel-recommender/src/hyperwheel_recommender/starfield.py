"""
Plane starfield: every catalog item whose overall tag profile is similar
to the reference item, using the same similarity metric as
tools/calculate_item_distance.py and tools/build_starfield_threshold.py.

Where recommend.py/recommend_many_planes finds items near a ROTATED
TARGET within one hue plane (see /docs/math.md section 5-6c), this module
answers a different question: which items resemble the reference overall,
independent of any hue plane? The similarity metric operates directly on
each item's raw [0,1] tag values, not on the PCA basis, so the result is
identical for every requested plane - `planes` only shapes which keys the
returned dict has, so a caller that shows one field per plane can look up
its starfield the same way it looks up that plane's scheme
recommendations.
"""

from __future__ import annotations

import numpy as np

from .basis import TasteBasis
from .similarity import SIMILARITY_THRESHOLD, normalize_item_tags

# Hard ceiling only, guarding against a degenerate distribution (e.g. a
# tight near-duplicate cluster in the catalog) returning an unreasonably
# large field.
MAX_NEIGHBORS = 1500


def find_plane_neighbors(
    basis: TasteBasis,
    reference_item,
    planes: list[tuple[int, int]],
    similarity_threshold: float = SIMILARITY_THRESHOLD,
    max_neighbors: int = MAX_NEIGHBORS,
) -> dict[tuple[int, int], np.ndarray]:
    """
    For each requested plane, every item whose similarity to the
    reference (see module docstring) is at least `similarity_threshold`,
    ordered by descending similarity.

    Since the similarity metric doesn't depend on any plane, every entry
    in the returned dict holds the same neighbor array - `planes` only
    controls which keys are present. Plane indices are still validated
    against the basis for API consistency with the rest of the package
    (recommend.py, planes.py), even though they play no role in the
    computation itself.
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
    X = basis.Q + basis.L[:, None]
    normalized = normalize_item_tags(X)

    ref_normalized = normalized[ref_idx]
    similarity = np.multiply(normalized, ref_normalized[None, :]).mean(axis=1)
    similarity[ref_idx] = -np.inf  # never recommend the reference to itself

    order = np.argsort(similarity)[::-1]
    order = order[similarity[order] >= similarity_threshold]
    neighbors = order[:max_neighbors]

    return {plane: neighbors for plane in planes}