"""
Helpers shared between the regression tests.
"""

from __future__ import annotations

from hyperwheel_recommender import FeatureBasis, find_plane_neighbors

from . import planes_config


def collect_starfield_items(basis, reference_item, circles) -> set[int]:
    """Every item (movieId) in any plane's starfield of `reference_item`."""
    by_plane = find_plane_neighbors(
        basis, reference_item, circles, max_neighbors=100000,
        ignore_components=planes_config.load_similarity_ignored(basis.U.shape[0]),
    )
    return {int(basis.items[idx]) for idxs in by_plane.values() for idx in idxs}