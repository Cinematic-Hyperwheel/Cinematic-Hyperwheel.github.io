"""
Shared item-vs-item similarity metric, independent of the PCA basis.

    S(x, y) = mean(min(N(x_i), N(y_i)))

where N() independently normalizes a tag vector using its own 5th and
95th percentiles. Used by starfield.py (reference vs. whole catalog) and
by recommend.py's Stage A character shortlist (rotated target vs. whole
catalog).
"""

from __future__ import annotations

import numpy as np

# 90th percentile of all unique pairwise similarities across the
# ml-latest catalog (see tools/build_starfield_threshold.py, --percentile
# 95 on the shipped artifact).
SIMILARITY_THRESHOLD = 0.0362203829
# 90% = 0.1758004725
# 93% = 0.1801130772
# 95% = 0.1839639246


def normalize_item_tags(x: np.ndarray) -> np.ndarray:
    """
    Normalizes tag vector(s) along the last axis, each independently
    using its own 5th/95th percentile. Accepts a single item's vector
    (n_criteria,) or a batch (n_items, n_criteria).
    """
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