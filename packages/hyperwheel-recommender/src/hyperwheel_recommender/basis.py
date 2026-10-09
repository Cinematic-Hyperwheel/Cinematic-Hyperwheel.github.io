"""
Feature-space basis: items are mapped through features.feature_map,
centered by the category mean, optionally scaled per tag, and PCA is fit
on the result. The inner product in this space is the pronounced-attribute
overlap (see features.py).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .features import FEATURES_PER_TAG, feature_map


@dataclass
class FeatureBasis:
    items: list[str]
    criteria: list[str]
    Phi: np.ndarray          # (n_items, d) centered, per-tag scaled features
    mu: np.ndarray           # (d,) category mean of the raw features
    scale: np.ndarray        # (d,) per-feature scale, shared within a tag block
    U: np.ndarray            # (n_components, d) orthonormal basis
    explained: np.ndarray    # (n_components,) fraction of variance explained
    singular_values: np.ndarray  # full spectrum (for diagnose)
    scores: np.ndarray       # (n_items, n_components) = Phi @ U.T
    pc_std: np.ndarray       # (n_components,) spread of items along each component
    norm_sq: np.ndarray      # (n_items,) = ||Phi[i]||^2


def _solve_pca(Q_scaled: np.ndarray, n_components: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    PCA via eigh on the Gram matrix (n_features x n_features) instead of an
    SVD of the full (n_items x n_features) matrix: the basis only needs the
    small matrix, and the SVD would materialize an unused left factor.
    Isolated so basis_cache.py can supply a precomputed result.

    Returns (U, explained, singular_values):
      U: (n_components, n_features) orthonormal basis
      explained: (n_components,) fraction of variance explained
      singular_values: full spectrum, for diagnose
    """
    C = Q_scaled.T @ Q_scaled
    eigvals, eigvecs = np.linalg.eigh(C)         # ascending order
    order = np.argsort(eigvals)[::-1]
    eigvals_sorted = np.clip(eigvals[order], 0, None)  # guard against small negatives from floating-point error
    S = np.sqrt(eigvals_sorted)
    Vt = eigvecs[:, order].T

    total_var = np.sum(S ** 2)
    explained_full = (S ** 2) / total_var if total_var > 0 else S * 0

    n_components = min(n_components, Vt.shape[0])
    return Vt[:n_components], explained_full[:n_components], S


def _feature_space(wide: pd.DataFrame, standardize: bool) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Centered (and optionally per-tag scaled) feature matrix with its
    mean and scale. Shared by build_feature_basis and basis_cache so both
    fit PCA on exactly the same matrix."""
    X = wide.to_numpy(dtype=np.float32)
    n, t = X.shape
    Phi = feature_map(X)
    mu = Phi.mean(axis=0)
    Phi -= mu

    if standardize:
        # Each tag's feature block gets unit total variance so rare tags
        # are not drowned out; the block's internal shape (the min-kernel
        # structure) is left intact.
        P = Phi.reshape(n, t, FEATURES_PER_TAG)
        block_var = np.einsum("ntf,ntf->t", P, P) / n
        scale = np.repeat(np.sqrt(np.maximum(block_var, 1e-12)), FEATURES_PER_TAG).astype(np.float32)
        Phi /= scale
    else:
        scale = np.ones(Phi.shape[1], dtype=np.float32)
    return Phi, mu, scale


def build_feature_basis(
    wide: pd.DataFrame,
    n_components: int,
    standardize: bool = True,
    precomputed_pca: tuple[np.ndarray, np.ndarray, np.ndarray] | None = None,
) -> FeatureBasis:
    """
    precomputed_pca: optional (U, explained, singular_values) from a prior
    _solve_pca call on the same feature space (see basis_cache.py) - skips
    the eigh call. The caller guarantees it matches this wide table,
    n_components and standardize flag; basis_cache's fingerprint enforces
    that in practice.
    """
    Phi, mu, scale = _feature_space(wide, standardize)

    if precomputed_pca is not None:
        U, explained, S = precomputed_pca
        n_components = min(n_components, U.shape[0])
        U, explained = U[:n_components], explained[:n_components]
    else:
        U, explained, S = _solve_pca(Phi, n_components)

    scores = Phi @ U.T
    pc_std = scores.std(axis=0)
    pc_std = np.where(pc_std < 1e-12, 1.0, pc_std)
    return FeatureBasis(
        items=list(wide.index), criteria=list(wide.columns), Phi=Phi, mu=mu, scale=scale,
        U=U, explained=explained, singular_values=S, scores=scores, pc_std=pc_std,
        norm_sq=np.einsum("ij,ij->i", Phi, Phi),
    )