"""
Feature map under which the pronounced-attribute overlap becomes an
ordinary inner product.

Per tag, <phi(x), phi(y)> = x*y + MIN_WEIGHT * min(x, y) (truncated
series, per-tag error <= MIN_WEIGHT * 2 * sum_{k>K} lambda_k). The
original agreement/disagreement score x*y - p*|x-y| equals
x*y + 2p*min(x, y) - p*(x + y); the last term depends on one item
only and is removed by cosine normalization, so MIN_WEIGHT = 2 * p.
The Euclidean distance in this space is sqrt(sum((x-y)^2 + 2p|x-y|)).
"""

from __future__ import annotations

import numpy as np

# Weight of the min(x, y) term in the per-tag inner product
# <phi(x), phi(y)> = x*y + MIN_WEIGHT*min(x, y). Equals 2*p for a
# disagreement penalty p in the score x*y - p*|x - y|: larger values
# favor items that are pronounced on the same tags and penalize
# disagreement more.
MIN_WEIGHT = 0.3

# Number of sine harmonics in the truncated expansion of min(x, y);
# 3 captures ~93% of the kernel's trace. Each tag maps to
# 1 + N_HARMONICS features, so this also scales memory and the size of
# the PCA Gram matrix.
N_HARMONICS = 3

FEATURES_PER_TAG = 1 + N_HARMONICS


def feature_map(X: np.ndarray) -> np.ndarray:
    """(n_items, n_tags) raw relevance in [0, 1] -> (n_items,
    n_tags * FEATURES_PER_TAG), tag-major: each tag owns a contiguous
    block of FEATURES_PER_TAG columns."""
    X = np.clip(np.asarray(X, dtype=np.float32), 0.0, 1.0)
    n, t = X.shape
    out = np.empty((n, t, FEATURES_PER_TAG), dtype=np.float32)
    out[..., 0] = X
    for k in range(1, N_HARMONICS + 1):
        a = (k - 0.5) * np.pi
        out[..., k] = (np.sqrt(2.0 * MIN_WEIGHT) / a) * np.sin(a * X)
    return out.reshape(n, t * FEATURES_PER_TAG)


# one time check
# rng = np.random.default_rng(0)
# x, y = rng.random((2000, 5)), rng.random((2000, 5))
# approx = (feature_map(x) * feature_map(y)).sum(axis=1)
# exact = (x * y + MIN_WEIGHT * np.minimum(x, y)).sum(axis=1)
# print(np.abs(approx - exact).max())   # expect <~ 0.1 (5 tags x <=0.02)