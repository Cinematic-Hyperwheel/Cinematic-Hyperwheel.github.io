"""
Plane starfield: for each hue plane (a pair of PCA axes), every catalog
item that matches the reference everywhere EXCEPT along the plane, so
that rotating within the plane can reach it (the client gates the pool
by angle and radius, see recommend.py's Stage B).

Character match is the cosine in the feature space (features.py) with
PC1 and the plane's two axes projected out of both the item and the
reference. The basis is orthonormal, so the projection is exact and only
removes the score products on those axes; all planes are evaluated at
once as one (n_items x n_planes) matrix. Per plane, items that are high
robust outliers of the cosine distribution are kept. The per-plane sets
are unioned by item id into one shared pool; each item records the
planes it qualified on, and a circle should only use items that
qualified on its own plane.
"""

from __future__ import annotations

import numpy as np

from .basis import FeatureBasis
from .similarity import feature_cosine

# Robust z-score threshold on the per-plane cosine distribution.
PLANE_OUTLIER_Z = 2.7

# Per-plane ceiling only, guarding against a degenerate distribution.
MAX_NEIGHBORS = 1500

# Score-covariance coefficients below this are treated as zero when
# finding the axes a plane's two scores leak into.
LEAK_EPS = 1e-4


def _plane_cosine_terms(
    basis: FeatureBasis, ref: int, planes: list[tuple[int, int]]
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Per-plane inner products and squared norms with PC1 and everything
    that the plane's two scores linearly predict removed.

    PCA scores are uncorrelated, so removing U_a and U_b is enough to
    decouple an item from its plane coordinates. After a varimax rotation
    the scores inside a group are correlated, and the other axes of the
    group still carry information about (s_a, s_b): items similar to the
    reference there also land near it in the plane. The remedy is to
    regress Phi on (s_a, s_b) and compare the residuals. With U
    orthonormal this is done entirely in score space:

        M   = C_ab^-1 C[[a, b], :]        (2 x K, C = score covariance)
        r_k = s'_k - M^T s_k,ab           (s' = scores with PC1 zeroed)

    The part of Phi outside the K kept components is uncorrelated with
    the kept scores and enters unchanged. Without rotation M is a pair of
    unit rows and the result equals plain projection of U_a, U_b.

    Returns (dot, nrm, ref_nrm): (n, P), (n, P), (P,).
    """
    sc = basis.scores
    n = sc.shape[0]
    sc64 = sc.astype(np.float64)
    cov = sc64.T @ sc64 / n                   # scores are centered: Phi is

    s_p = sc64.copy()
    s_p[:, 0] = 0.0                           # PC1 never counts toward similarity

    # Plane-independent parts: Phi outside the K kept components, and the
    # PC1-free score products with the reference.
    g = basis.Phi @ basis.Phi[ref]
    tail_dot = g - sc64 @ sc64[ref]
    tail_nrm = np.maximum(basis.norm_sq - np.einsum("ij,ij->i", sc64, sc64), 0.0)
    base = s_p @ s_p[ref]
    s_p_nrm = np.einsum("ij,ij->i", s_p, s_p)

    P = len(planes)
    dot = np.empty((n, P), dtype=np.float32)
    nrm = np.empty((n, P), dtype=np.float32)
    for p, (a, b) in enumerate(planes):
        ab = [a - 1, b - 1]
        M = np.linalg.solve(cov[np.ix_(ab, ab)], cov[ab, :])   # (2, K)
        M[:, 0] = 0.0
        J = np.flatnonzero(np.abs(M).max(axis=0) > LEAK_EPS)   # the plane's own axes + their rotation group
        Ms = M[:, J]
        mm = Ms @ Ms.T                                         # (2, 2)

        s_ab = sc64[:, ab]                                     # (n, 2)
        pk = s_p[:, J] @ Ms.T                                  # (n, 2): s'_k . m_a, s'_k . m_b
        w = pk[ref] - mm @ s_ab[ref]                           # M r_ref

        dot[:, p] = tail_dot + base - pk @ s_ab[ref] - s_ab @ w
        nrm[:, p] = tail_nrm + np.maximum(
            s_p_nrm - 2.0 * np.einsum("ki,ki->k", s_ab, pk)
            + np.einsum("ki,ij,kj->k", s_ab, mm, s_ab),
            0.0,
        )
    return dot, nrm, nrm[ref]


def find_neighbors(
    basis: FeatureBasis,
    reference_item,
    planes: list[tuple[int, int]],
    outlier_z: float = PLANE_OUTLIER_Z,
    max_neighbors: int = MAX_NEIGHBORS,
) -> tuple[np.ndarray, np.ndarray, list[list[int]]]:
    """
    Per-plane search, unioned across planes. `planes` holds 1-based
    (i, j) component pairs (PC1 excluded - it is always projected out).

    Returns (indices, similarities, matched), ordered by descending
    similarity; each item's similarity is its best cosine among the
    planes it qualified on, and `matched[k]` lists the indices into
    `planes` on which item `indices[k]` qualified.
    """
    if reference_item not in basis.items:
        raise ValueError(f"Item '{reference_item}' not found in the data.")
    m = basis.U.shape[0]
    for a, b in planes:
        if a == b or not (2 <= a <= m and 2 <= b <= m):
            raise ValueError(
                f"plane=({a}, {b}) is not a pair of distinct non-PC1 components within 2..{m}."
            )

    ref = basis.items.index(reference_item)
    n = len(basis.items)

    ref = basis.items.index(reference_item)
    n = len(basis.items)

    dot_p, nrm_p, ref_nrm = _plane_cosine_terms(basis, ref, planes)
    cos = feature_cosine(dot_p, nrm_p, ref_nrm)

    # Robust z per plane, median/MAD over the catalog without the reference.
    others = np.arange(n) != ref
    med = np.median(cos[others], axis=0)
    mad = np.median(np.abs(cos[others] - med), axis=0)
    z = (cos - med) / (1.4826 * np.maximum(mad, 1e-12))
    z[ref, :] = -np.inf
    hit = z >= outlier_z

    best: dict[int, float] = {}
    matched: dict[int, list[int]] = {}
    for p in range(len(planes)):
        idx = np.flatnonzero(hit[:, p])
        if idx.size > max_neighbors:
            idx = idx[np.argsort(-cos[idx, p])[:max_neighbors]]
        for i in idx:
            i = int(i)
            matched.setdefault(i, []).append(p)
            best[i] = max(best.get(i, -np.inf), float(cos[i, p]))

    ordered = sorted(best, key=lambda i: -best[i])
    return (
        np.array(ordered, dtype=int),
        np.array([best[i] for i in ordered], dtype=np.float32),
        [matched[i] for i in ordered],
    )


def find_plane_neighbors(
    basis: FeatureBasis,
    reference_item,
    planes: list[tuple[int, int]],
    outlier_z: float = PLANE_OUTLIER_Z,
    max_neighbors: int = MAX_NEIGHBORS,
) -> dict[tuple[int, int], np.ndarray]:
    """find_neighbors regrouped by plane: each plane maps to the item
    indices that qualified on that plane."""
    indices, _, matched = find_neighbors(
        basis, reference_item, planes, outlier_z=outlier_z, max_neighbors=max_neighbors,
    )
    by_plane: dict[tuple[int, int], list[int]] = {plane: [] for plane in planes}
    for idx, plane_ids in zip(indices, matched):
        for p in plane_ids:
            by_plane[planes[p]].append(int(idx))
    return {plane: np.array(v, dtype=int) for plane, v in by_plane.items()}