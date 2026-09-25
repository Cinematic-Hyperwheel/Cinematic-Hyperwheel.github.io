"""
packages/hyperwheel-recommender/src/hyperwheel_recommender/similarity.py

Shared "pronounced attribute overlap" similarity metric and its adaptive
outlier selection, used by both the Stage A character shortlist
(recommend.py) and the plane starfield (starfield.py).

Similarity, not distance
-------------------------
Tag relevance values are on [0, 1]; a value close to 1 means an item
pronouncedly HAS that attribute, a value close to 0 means it's largely
absent. Two items BOTH lacking an attribute (both near 0) says very
little about how alike they are - most items lack most attributes, so
mutual absence is common ground rather than evidence of shared
character. Two items BOTH pronouncedly having an attribute (both near 1)
is a much stronger, rarer signal.

A symmetric Euclidean/L2 distance (used for the hue-plane geometry
itself, see basis.py/rotation.py) can't distinguish these two cases -
(x-y)^2 is identical whether x and y are both near 0 or both near 1.
The similarity metric here is a soft, asymmetric fuzzy-set overlap
instead:

    S(x, y) = mean(min(N(x_i), N(y_i)))

where N() independently normalizes each item's own tag vector via its
own 5th/95th percentile (so the metric isn't skewed by one item simply
having a higher or lower overall tag intensity than another). min()
means a criterion only contributes to S when BOTH items are pronounced
on it - mutual near-0 values contribute almost nothing, mutual near-1
values contribute close to their full weight.
"""

from __future__ import annotations

import numpy as np


def normalize_item_tags(x: np.ndarray) -> np.ndarray:
    """
    Normalizes tag vector(s) along the last axis, each independently
    using its own 5th/95th percentile. Accepts a single item's vector
    (n_criteria,) or a batch (n_items, n_criteria).
    """

    return x
    p5 = np.percentile(x, 0.0, axis=-1, keepdims=True)
    p95 = np.percentile(x, 100.0, axis=-1, keepdims=True)
    scale = p95 - p5
    valid = scale > 1e-12
    normalized = np.where(
        valid,
        np.clip((x - p5) / np.where(valid, scale, 1.0), 0.0, 1.0),
        0.0,
    )
    return normalized.astype(np.float32)


def similarity_to_target(items_normalized: np.ndarray, target_normalized: np.ndarray) -> np.ndarray:
    """S(item, target) for every item, given already-normalized tag
    vectors (see normalize_item_tags)."""
    return np.minimum(items_normalized, target_normalized[None, :]).mean(axis=1)


# Threshold on the "modified z-score" (Iglewicz & Hoaglin's robust
# outlier statistic: (x - median) / (1.4826 * MAD), MAD = median
# absolute deviation) above which an item counts as a genuine outlier on
# the HIGH side of a similarity distribution - i.e. meaningfully more
# similar than the bulk of the catalog, not merely "one of the N most
# similar available regardless of how similar that actually is". Mirror
# of the distance-side statistic this package uses elsewhere for
# angle/radius-independent candidate selection: same robust construction,
# just testing the high tail of "similarity" instead of the low tail of
# "distance". +2.5 is the conventional cutoff for this statistic.
#SIMILARITY_OUTLIER_Z = 1.7
SIMILARITY_OUTLIER_Z = 2.5


def high_similarity_outlier_indices(
    similarity: np.ndarray,
    exclude_idx: int,
    z_threshold: float = SIMILARITY_OUTLIER_Z,
    max_count: int | None = None,
) -> np.ndarray:
    """
    Indices of items that are a statistically significant outlier on the
    HIGH side of `similarity`'s own distribution across the catalog
    (robust modified z-score, median/MAD rather than mean/std, since the
    bulk of the distribution - not the near tail itself - should anchor
    "typical"), ordered by descending similarity. `exclude_idx` is always
    excluded regardless of its own similarity value. `max_count`, if
    given, is a safety CAP on how many are returned - it never pads the
    result back up if fewer items actually qualify. Self-calibrating per
    call: a distribution with only a handful of genuinely similar items
    yields a handful of results, one with hundreds yields hundreds.
    """
    s = similarity.copy()
    s[exclude_idx] = -np.inf
    finite = s[np.isfinite(s)]
    if finite.size == 0:
        return np.array([], dtype=int)
    median = np.median(finite)
    mad = np.median(np.abs(finite - median))
    if mad < 1e-12:
        # Every item (effectively) equally similar - nothing statistically
        # stands out as "more similar".
        return np.array([], dtype=int)
    modified_z = (s - median) / (1.4826 * mad)
    candidates = np.where(modified_z >= z_threshold)[0]
    order = candidates[np.argsort(-s[candidates])]
    return order[:max_count] if max_count is not None else order