"""
Regression test: the natural (uncapped) size of the plane starfield -
items sharing the reference's character once a given plane's own two
axes are projected out (see starfield.find_plane_neighbors) - stays
within a sane display size for every circle. `find_plane_neighbors`
already applies its own MAX_NEIGHBORS safety cap (1500 by default); this
test instead measures the underlying near-outlier selection itself, with
that cap raised out of the way, so a regression in the outlier threshold
is caught before it would be masked by the cap.
"""

from __future__ import annotations

from hyperwheel_recommender import find_plane_neighbors

# Large enough to never itself become the limiting factor - this test is
# about the natural near-outlier count, not about find_plane_neighbors's
# own safety cap.
_UNCAPPED = 100_000


def test_starfield_within_size_limit(starfield_case, basis, circles, starfield_max_size):
    reference = starfield_case
    by_plane = find_plane_neighbors(basis, reference, circles, max_neighbors=_UNCAPPED)

    oversized = {
        plane: len(neighbors)
        for plane, neighbors in by_plane.items()
        if len(neighbors) > starfield_max_size
    }
    assert not oversized, (
        f"Starfield for reference '{reference}' exceeds {starfield_max_size} "
        f"item(s) on circle(s): {oversized}"
    )