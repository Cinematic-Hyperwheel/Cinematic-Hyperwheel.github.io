"""
Cosine similarity in the feature space (see features.py) and adaptive
outlier selection, shared by the Stage A character shortlist
(recommend.py) and the plane starfield (starfield.py).

In this space the inner product is the pronounced-attribute overlap
(both items pronounced on a tag counts, shared absence barely does), and
cosine normalization removes the one-sided term of the original
agreement/disagreement score. PC1 is projected out by the callers
exactly, since the basis is orthonormal.
"""

from __future__ import annotations

import numpy as np

# Items near the category mean have tiny norms, which makes their cosine
# noisy; norms are floored at this quantile (per column for matrices).
NORM_FLOOR_QUANTILE = 0.05


def feature_cosine(dot: np.ndarray, norm_sq: np.ndarray, target_norm_sq) -> np.ndarray:
    """Cosine from precomputed inner products and squared norms.
    dot/norm_sq: (n_items,) or (n_items, n_planes); target_norm_sq:
    scalar or (n_planes,)."""
    floor = np.quantile(norm_sq, NORM_FLOOR_QUANTILE, axis=0)
    return dot / np.sqrt(np.maximum(norm_sq, floor) * np.maximum(target_norm_sq, 1e-12))


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