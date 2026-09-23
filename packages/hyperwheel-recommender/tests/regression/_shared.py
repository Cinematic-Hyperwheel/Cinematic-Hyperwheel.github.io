"""
Helpers shared between the recommendation-presence and starfield-size
regression tests.
"""

from __future__ import annotations

from dataclasses import dataclass

from hyperwheel_recommender import TasteBasis, recommend_many_planes


@dataclass
class RecommendationLocation:
    scheme: str
    plane: tuple[int, int]
    angle_deg: float
    rank: int


def collect_recommended_items(
    basis: TasteBasis,
    reference_item: int,
    circles: list[tuple[int, int]],
    schemes: list[str],
    top_k: int,
    shortlist_size: int,
) -> dict[int, list[RecommendationLocation]]:
    """Every item (movieId) recommended for `reference_item` across all
    given schemes and circles, with the locations (scheme/plane/angle/
    rank) it showed up at - used both to check presence and, on
    failure, to give a readable diagnostic instead of a bare set
    difference."""
    locations: dict[int, list[RecommendationLocation]] = {}
    for scheme in schemes:
        # recommend_many_planes batches Stage A across every circle for
        # one reference + scheme in a single call (see docs/math.md,
        # section 6c), so this is at most len(schemes) calls per pair,
        # not len(schemes) x len(circles).
        by_plane = recommend_many_planes(
            basis, reference_item, scheme, planes=circles,
            top_k=top_k, shortlist_size=shortlist_size,
        )
        for plane, df in by_plane.items():
            for row in df.itertuples(index=False):
                locations.setdefault(int(row.item), []).append(
                    RecommendationLocation(
                        scheme=scheme, plane=plane,
                        angle_deg=row.angle_deg, rank=row.rank,
                    )
                )
    return locations