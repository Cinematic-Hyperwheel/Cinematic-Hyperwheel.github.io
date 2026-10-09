"""
Per-reference adaptive hue-plane selection.

With a diffuse variance spectrum (no single dominant pair of components -
e.g. PC1=14.8%, PC2=6.3%, PC3=5.3%, then a long thin tail), fixing one
global (i, j) pair for every reference item has a real cost: for a given
item, its distinguishing character might live almost entirely in, say,
PC7 and PC12, while PC2/PC3 are close to the category-typical value for
that particular item. Rotating a globally-fixed PC2/PC3 plane would then
barely change the item at all, or worse, rotate axes that say nothing
about what actually makes this item distinctive.

select_hue_plane() instead looks at THIS reference's own z-score along
each candidate component (score / pc_std - how many typical standard
deviations this item sits from the category norm on that axis, NOT the
raw score) and picks the two axes where the item itself is most
expressive. Using the raw score instead of the z-score would bias the
choice toward components with naturally larger population variance
(PC2/PC3 again) regardless of whether THIS item stands out there - the
z-score corrects for that.
"""

from __future__ import annotations

import numpy as np

from .basis import FeatureBasis


def select_hue_plane(
    basis: FeatureBasis,
    ref_idx: int,
    exclude_components: tuple[int, ...] = (1,),
    candidate_components: int | None = None,
) -> tuple[int, int]:
    """
    Returns a 1-based (i, j) pair of components to use as the hue plane for
    this specific reference item.

    exclude_components: 1-based component indices never eligible for
        selection (e.g. (1,) to always exclude a known "quality" axis).
    candidate_components: only consider the first N components (1-based)
        as candidates. Without a cap, components far down the tail - which
        explain very little variance overall and can carry a single
        idiosyncratic criterion's noise - could get selected just because
        one item happens to spike there by chance. Defaults to all
        components available in the basis if not given; callers working
        with long tails (see /docs/math.md, section 6a) should set this
        explicitly, e.g. to the point where cumulative variance stops
        being meaningful.
    """
    n_components = basis.U.shape[0]
    if candidate_components is None:
        candidate_components = n_components
    candidate_components = min(candidate_components, n_components)

    excluded = {c - 1 for c in exclude_components}
    candidates = [i for i in range(candidate_components) if i not in excluded]
    if len(candidates) < 2:
        raise ValueError(
            f"Not enough candidate components to select a plane "
            f"(candidates={len(candidates)}, need >= 2). Increase "
            f"candidate_components or reduce exclude_components."
        )

    z = basis.scores[ref_idx] / basis.pc_std   # this item's standing relative to typical spread, per component
    ranked = sorted(candidates, key=lambda i: -abs(z[i]))
    i, j = sorted(ranked[:2])
    return (i + 1, j + 1)   # back to 1-based
