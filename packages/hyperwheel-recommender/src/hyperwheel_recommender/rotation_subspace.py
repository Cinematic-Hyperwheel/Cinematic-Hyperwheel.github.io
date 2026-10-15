"""
Varimax rotation of contiguous groups of principal axes.

PCA fixes the subspace spanned by a group of near-degenerate components
but not the axes inside it. Rotating the group orthogonally keeps U
orthonormal, so the exact cosine/starfield identities (docs/math.md,
sections 5-7) still hold, while every axis concentrates on fewer
features, which makes it easier to interpret.

Features, Phi and the item norms are untouched; only U, the scores, the
per-axis explained variance and pc_std of the rotated group change.
"""

from __future__ import annotations

import dataclasses
from collections.abc import Iterable

import numpy as np

from .basis import FeatureBasis

MAX_ITER = 200
TOL = 1e-8


def _varimax(L: np.ndarray) -> np.ndarray:
    """Orthogonal (k x k) rotation R maximizing the varimax criterion of L @ R, L being (p x k)."""
    p, k = L.shape
    R = np.eye(k)
    d_old = 0.0
    for _ in range(MAX_ITER):
        Lr = L @ R
        u, s, vt = np.linalg.svd(
            L.T @ (Lr ** 3 - Lr @ np.diag(np.sum(Lr ** 2, axis=0)) / p)
        )
        R = u @ vt
        d = float(np.sum(s))
        if d_old != 0.0 and d < d_old * (1 + TOL):
            break
        d_old = d
    return R


def rotate_subspace(basis: FeatureBasis, k_from: int, k_to: int) -> FeatureBasis:
    """
    Returns a basis in which components k_from..k_to (1-based, inclusive)
    are replaced by their varimax rotation. The rotated axes are re-sorted
    by the variance they carry; all other components are untouched. Each
    rotated axis gets its largest-magnitude weight positive, since the
    sign of a rotated axis is arbitrary.
    """
    a, b = k_from - 1, k_to
    L = basis.U[a:b].T.astype(np.float64)    # (n_features, k) loadings
    # Rotation is solved in float64 on the small loadings matrix, then cast
    # back: multiplying the (n_items x n_features) Phi by a float64 matrix
    # would upcast the whole feature matrix.
    Ur = (L @ _varimax(L)).T.astype(basis.U.dtype)

    scores = basis.Phi @ Ur.T
    # Variance share of a unit axis u is ||Phi u||^2 / total; the total is
    # the sum over the full spectrum, as in _solve_pca.
    total = float(np.sum(basis.singular_values ** 2))
    explained = np.sum(scores.astype(np.float64) ** 2, axis=0) / total

    order = np.argsort(-explained)
    Ur, scores, explained = Ur[order], scores[:, order], explained[order]
    sign = np.sign(Ur[np.arange(len(Ur)), np.argmax(np.abs(Ur), axis=1)])
    Ur, scores = Ur * sign[:, None], scores * sign

    U = basis.U.copy()
    sc = basis.scores.copy()
    ex = basis.explained.copy()
    U[a:b], sc[:, a:b], ex[a:b] = Ur, scores, explained
    std = sc.std(axis=0)
    pc_std = np.where(std < 1e-12, 1.0, std)
    return dataclasses.replace(basis, U=U, scores=sc, explained=ex, pc_std=pc_std)


def rotate_groups(basis: FeatureBasis, groups: Iterable[tuple[int, int]]) -> FeatureBasis:
    """
    Applies rotate_subspace to several disjoint (FROM, TO) groups
    (1-based, inclusive). PC1 is never rotated: it is the quality axis and
    is projected out of every similarity.
    """
    spans = sorted((int(lo), int(hi)) for lo, hi in groups)
    m = basis.U.shape[0]
    for lo, hi in spans:
        if not 2 <= lo < hi <= m:
            raise ValueError(
                f"A rotation group needs 2 <= FROM < TO <= {m} (PC1 is never rotated), got {(lo, hi)}."
            )
    for (_, hi), (lo2, _) in zip(spans, spans[1:]):
        if lo2 <= hi:
            raise ValueError(f"Rotation groups overlap: {spans}")
    for lo, hi in spans:
        basis = rotate_subspace(basis, lo, hi)
    return basis