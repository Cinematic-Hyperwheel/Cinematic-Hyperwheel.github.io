"""
Building the hue basis: double centering (L, M) + PCA.

See /docs/math.md, section 3, for the full mathematical rationale.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd


@dataclass
class TasteBasis:
    items: list[str]
    criteria: list[str]
    L: np.ndarray             # (n_items,) each item's own mean across criteria
    Q: np.ndarray              # (n_items, n_criteria) shape vectors (row-centered)
    Q_scaled: np.ndarray   # (n_items, n_criteria) = (Q - M) / scale — the
                            # exact standardized shape space PCA was fit on;
                            # kept so Stage A (recommend.py) can measure
                            # "character" distance in the same space,
                            # instead of raw, scale-dominated units.
    M: np.ndarray               # (n_criteria,) typical shape profile across the whole
                                 # category (mean of Q over items) - removed before PCA,
                                 # otherwise the first component picks up the shape
                                 # common to all items instead of real differences
                                 # between items
    U: np.ndarray               # (n_components, n_criteria) orthonormal basis (in scaled space)
    explained: np.ndarray       # (n_components,) fraction of variance explained
    singular_values: np.ndarray  # full spectrum (for diagnose)
    scale: np.ndarray           # (n_criteria,) std of each criterion (1.0 if standardize=False)
    pc_std: np.ndarray          # (n_components,) actual spread of items along each component -
                                 # needed for whitening before rotation (see rotation.rotate_whitened)
    scores: np.ndarray          # (n_items, n_components) each item's coordinate along each component

    # inv_scale, s, Q_norm_sq - cached for recommend.recommend_many_planes's algebraic Stage A
    # shortcut (see /docs/math.md section 6c). Computed once here at
    # basis-build time (same O(n_items x n_criteria) cost that a single
    # Stage A pass already had), instead of once per (plane, angle) in
    # the old per-circle loop.
    inv_scale: np.ndarray   # (n_criteria,) = 1/scale
    s: np.ndarray            # (n_items,) = Q_scaled @ inv_scale — per-item
                              # scalar that lets recommend_many_planes
                              # reconstruct the effect of L/M-recentering a
                              # rotated target for ANY single hue plane,
                              # without rebuilding target_vec or touching
                              # the (n_items x n_criteria) matrix per plane.
    Q_norm_sq: np.ndarray    # (n_items,) = ||Q_scaled[i]||^2, cached once so
                              # the reference-relative "base" distance term
                              # in recommend_many_planes is one dot product,
                              # not a fresh full-matrix norm per plane.




def _solve_pca(Q_scaled: np.ndarray, n_components: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    PCA via eigh on the Gram matrix (n_criteria x n_criteria), rather than
    SVD of the full (n_items x n_criteria) matrix. When n_items >>
    n_criteria (the typical case: thousands of items, hundreds of
    criteria), SVD still computes and materializes the left matrix U of
    size (n_items x n_criteria), which is then discarded - this is both
    slower (~8x on 10000x920) and requires extra memory just to hold it.
    The Gram matrix C = Q^T @ Q is small (n_criteria x n_criteria)
    regardless of the number of items - that's all the basis actually
    needs.

    This is the O(n_criteria^3) cost of build_taste_basis - isolated
    into its own function so basis_cache.py can supply a precomputed
    result instead of paying this cost on every call.

    Returns (U, explained, singular_values):
      U: (n_components, n_criteria) orthonormal basis
      explained: (n_components,) fraction of variance explained
      singular_values: full spectrum (length n_criteria), for diagnose
    """
    C = Q_scaled.T @ Q_scaled
    eigvals, eigvecs = np.linalg.eigh(C)         # ascending order
    order = np.argsort(eigvals)[::-1]
    eigvals_sorted = np.clip(eigvals[order], 0, None)  # guard against small negatives from floating-point error
    S = np.sqrt(eigvals_sorted)                   # equivalent to singular values
    Vt = eigvecs[:, order].T                        # (n_criteria, n_criteria)

    total_var = np.sum(S ** 2)
    explained_full = (S ** 2) / total_var if total_var > 0 else S * 0

    n_components = min(n_components, Vt.shape[0])
    return Vt[:n_components], explained_full[:n_components], S
def build_taste_basis(
    wide: pd.DataFrame,
    n_components: int,
    standardize: bool = True,
    precomputed_pca: tuple[np.ndarray, np.ndarray, np.ndarray] | None = None,
) -> TasteBasis:
    """
    precomputed_pca: optional (U, explained, singular_values) from a
    prior _solve_pca call on the exact same standardized shape space
    (see basis_cache.py) - skips the O(n_criteria^3) eigh call below.
    The caller is responsible for ensuring it actually matches this
    wide table, n_components and standardize flag; basis_cache's
    fingerprint check is what enforces that in practice.
    """
    # float32, not float64 (was dtype=float) - on large catalogs (thousands
    # of items x hundreds of criteria) float64 on every intermediate array
    # (X, Q, Qc, Q_scaled) doubles peak RSS with no meaningful accuracy
    # benefit for PCA on data in the [0,1] range.
    X = wide.to_numpy(dtype=np.float32)
    items = list(wide.index)
    criteria = list(wide.columns)

    L = X.mean(axis=1)
    Q = X - L[:, None]                      # each row sums to 0 (own mean removed)

    # Double centering: besides each item's own mean (L), we also need to
    # remove the category-wide typical shape (M) - otherwise PCA will treat
    # the shape common to all items as the "main difference" instead of
    # real variation between items.
    M = Q.mean(axis=0)
    Qc = Q - M[None, :]

    if standardize:
        # Without this, criteria with a larger random spread would
        # dominate the components purely because of scale, not because of
        # real correlation with other criteria.
        scale = Qc.std(axis=0)
        scale = np.where(scale < 1e-12, 1.0, scale)
    else:
        scale = np.ones(Qc.shape[1])

    Q_scaled = Qc / scale

    if precomputed_pca is not None:
        # Skips the O(n_criteria^3) eigh call - see basis_cache.py. The
        # caller is responsible for ensuring the cache matches this
        # exact wide table, n_components and standardize flag
        # (basis_cache.compute_fingerprint checks this).
        U, explained, S = precomputed_pca
        n_components = min(n_components, U.shape[0])
        U, explained = U[:n_components], explained[:n_components]
    else:
        U, explained, S = _solve_pca(Q_scaled, n_components)

    scores = Q_scaled @ U.T                 # (n_items, n_components)
    pc_std = scores.std(axis=0)
    pc_std = np.where(pc_std < 1e-12, 1.0, pc_std)

    inv_scale = 1.0 / scale
    s = Q_scaled @ inv_scale
    Q_norm_sq = np.einsum("ij,ij->i", Q_scaled, Q_scaled)

    return TasteBasis(
        items=items, criteria=criteria, L=L, Q=Q, M=M, U=U,
        Q_scaled=Q_scaled,
        pc_std=pc_std, scores=scores,
        explained=explained, singular_values=S, scale=scale,
        inv_scale=inv_scale, s=s, Q_norm_sq=Q_norm_sq,
    )