"""
Shared "pronounced attribute overlap" similarity metric and its adaptive
outlier selection, used by both the Stage A character shortlist
(recommend.py) and the plane starfield (starfield.py).

Similarity, not distance
-------------------------
Tag relevance values are on [0, 1]; a value close to 1 means an item
pronouncedly HAS that attribute, a value close to 0 means it's largely
absent. A symmetric Euclidean/L2 distance (used for the hue-plane
geometry itself, see basis.py/rotation.py) treats "both near 0" and
"both near 1" identically, so it can't tell "these two share no notable
traits" apart from "these two share several pronounced traits".

The metric here rewards agreement and penalizes disagreement per
criterion, on raw [0, 1] tag values:

    contribution(x_i, y_i) = x_i * y_i - MISMATCH_PENALTY * |x_i - y_i|

criteria are then combined as a PC1-aware weighted average (see
_pc1_aware_weights), so an item's overall "quality" signal doesn't
dominate the comparison the way a genuine taste criterion does.
"""

from __future__ import annotations

import numpy as np
from numba import njit, prange

# Strength of the penalty for differences in tag activation.
# 0 = no penalty; 0.5 = moderate; 1 = penalty equal in magnitude
# to a same-strength match reward; values > 1 increasingly favor agreement.
MISMATCH_PENALTY = 0.15

# Minimum weight retained by criteria strongly aligned with the PC1
# (overall quality/halo) axis. 0 = fully suppress PC1-driven criteria;
# 1 = no PC1 downweighting.
PC1_WEIGHT_FLOOR = 0.05


def _axis_weight_factor(loadings: np.ndarray, floor: float) -> np.ndarray:
    """
    Per-criterion downweighting factor for a single PCA axis: criteria
    strongly aligned with `loadings` (large absolute component weight)
    are pulled toward `floor`. floor=0 fully removes a criterion's
    influence once it's maximally aligned with the axis; a floor close
    to 1 barely downweights it.
    """
    strength = np.abs(loadings)

    max_strength = np.max(strength)
    if max_strength > 1e-12:
        strength = strength / max_strength
    return (1.0 - (1.0 - floor) * strength).astype(np.float32)


def _pc1_aware_weights(pc1_loadings: np.ndarray) -> np.ndarray:
    """Per-criterion weight suppressing criteria aligned with PC1 (the
    overall quality/halo axis) toward PC1_WEIGHT_FLOOR, so a shared
    "everything is good/bad" signal doesn't dominate character
    similarity the way a genuine taste criterion does."""
    return _axis_weight_factor(pc1_loadings, PC1_WEIGHT_FLOOR)


@njit(parallel=True, fastmath=True, cache=True)
def _weighted_similarity_sum(
    items: np.ndarray,
    target: np.ndarray,
    weights: np.ndarray,
    mismatch_penalty: float,
) -> np.ndarray:
    """
    Per-item weighted "agreement - penalty * disagreement" sum against a
    single target (not yet divided by weights.sum() - see
    similarity_to_target), computed in one pass over `items` with no
    full-matrix temporary array.

    A plain NumPy formulation needs a full (n_items, n_criteria)
    temporary for |items - target| (abs has no linear decomposition
    into a matrix product, unlike the agreement term), plus separate
    reductions for the two weighted sums - two full memory passes over
    the catalog matrix per call. This kernel instead accumulates both
    terms per item within a single criteria loop, so each row of
    `items` is read from memory exactly once. Rows are independent, so
    the outer loop is parallelized across items - n_items is in the
    tens of thousands, n_criteria only in the thousands, so this is the
    axis worth splitting on.
    """
    n_items, n_criteria = items.shape
    out = np.empty(n_items, dtype=np.float32)
    for i in prange(n_items):
        agreement = 0.0
        disagreement = 0.0
        for c in range(n_criteria):
            v = items[i, c]
            t = target[c]
            w = weights[c]
            agreement += v * t * w
            disagreement += abs(v - t) * w
        out[i] = agreement - mismatch_penalty * disagreement
    return out


def similarity_to_target(
    items: np.ndarray,
    target: np.ndarray,
    pc1_loadings: np.ndarray,
    suppress_loadings: np.ndarray | None = None,
) -> np.ndarray:
    """
    PC1-aware pronounced-attribute overlap similarity between every
    catalog item and a single target, both on raw [0, 1] tag values.

    suppress_loadings: optional loadings of one or more additional PCA
    axes to fully suppress (floor 0) on top of the PC1 downweighting
    above - a (n_criteria,) vector for a single axis, or a
    (n_axes, n_criteria) array for several at once. Each axis
    contributes its own multiplicative factor, so a criterion strongly
    aligned with ANY of them ends up strongly suppressed. Used by the
    plane starfield's per-axis isolation search (see starfield.py) to
    isolate a single axis' own contribution to character similarity by
    suppressing every other axis at once.
    """
    weights = _pc1_aware_weights(pc1_loadings)
    if suppress_loadings is not None:
        for axis_loadings in np.atleast_2d(suppress_loadings):
            weights = weights * _axis_weight_factor(axis_loadings, floor=0.0)
    # target is a small (n_criteria,) vector - this cast is essentially
    # free even when it copies, and keeps the numba kernel compiled
    # against one stable float32 signature.
    target = np.asarray(target, dtype=np.float32)
    weighted_sum = _weighted_similarity_sum(items, target, weights, MISMATCH_PENALTY)
    return weighted_sum / weights.sum()


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
SIMILARITY_OUTLIER_Z = 2.3


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