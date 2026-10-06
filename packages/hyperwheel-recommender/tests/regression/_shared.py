"""
Helpers shared between the regression tests.
"""

from __future__ import annotations

from hyperwheel_recommender import TasteBasis, find_plane_neighbors


def collect_starfield_items(
    basis: TasteBasis,
    reference_item: int,
    circles: list[tuple[int, int]],
    drop_components: list[int],
) -> set[int]:
    """Every item (movieId) in `reference_item`'s plane starfield (see
    find_plane_neighbors) - identical across every plane in `circles`
    (the starfield is scheme- and plane-independent, see /docs/math.md
    section 7), so only the first plane's result needs reading."""
    by_plane = find_plane_neighbors(basis, reference_item, circles, drop_components, max_neighbors=100000)
    first_plane = circles[0]
    return {int(basis.items[idx]) for idx in by_plane[first_plane]}