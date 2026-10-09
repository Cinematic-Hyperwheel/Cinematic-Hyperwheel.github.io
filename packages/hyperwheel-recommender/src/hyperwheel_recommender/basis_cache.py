"""
Build-time cache for the expensive part of build_taste_basis: the
O(n_criteria^3) eigh call on the standardized Gram matrix (see
basis._solve_pca). Everything else in build_taste_basis is a cheap
O(n_items x n_criteria) pass and is always recomputed fresh from the
input wide table - only the eigendecomposition itself is worth caching.

Cache lifetime is tied to a single container image build, not to a
running process: the cache file is produced once, during the image
build (see tools/build_basis_cache.py), from the exact code and dataset
that build produces an image for, and is then baked into that image as
a read-only file. A code or dataset change requires a new image build,
which regenerates the cache as part of that same build - so the cache
and the code that reads it always come from the same build, with no
separate invalidation step needed.

The fingerprint below is a defensive check against a stale or mismatched
cache file being loaded (e.g. one baked for a different artifact or
n_components), not the primary correctness mechanism.
"""

from __future__ import annotations

import hashlib
import inspect
from pathlib import Path

import numpy as np
import pandas as pd

from . import basis as basis_module
from . import features as features_module


def compute_fingerprint(wide: pd.DataFrame, n_components: int, standardize: bool) -> str:
    """
    Identifies the exact (code, dataset, parameters) combination an
    eigendecomposition cache was built from:
      - the source of _solve_pca, _feature_space and the feature map, so
        any change to the PCA or to the feature space invalidates old
        caches without a manually bumped version;
      - the wide table's shape, items and criteria, plus a strided sample
        of its values (a full hash was too slow under a throttled CPU);
      - n_components and standardize.
    """
    X = wide.to_numpy(dtype=np.float32)
    sample = X.reshape(-1)[::97]   # 97 is prime: no aliasing with regular structure

    hasher = hashlib.sha256()
    hasher.update(inspect.getsource(basis_module._solve_pca).encode("utf-8"))
    hasher.update(inspect.getsource(basis_module._feature_space).encode("utf-8"))
    hasher.update(inspect.getsource(features_module).encode("utf-8"))
    hasher.update(f"shape={X.shape}|dtype={X.dtype}".encode("utf-8"))
    hasher.update("|".join(map(str, wide.index)).encode("utf-8"))
    hasher.update("|".join(map(str, wide.columns)).encode("utf-8"))
    hasher.update(sample.tobytes())
    hasher.update(f"|n_components={n_components}|standardize={standardize}".encode("utf-8"))
    return hasher.hexdigest()


def save_pca_cache(path: str, wide: pd.DataFrame, n_components: int, standardize: bool) -> None:
    """Runs the expensive eigh step once and saves its result, tagged
    with a fingerprint of the exact code/data/parameters used. Call this
    at image build time - never at request time or on process start."""
    Phi, _, _ = basis_module._feature_space(wide, standardize)
    U, explained, S = basis_module._solve_pca(Phi, n_components)
    fingerprint = compute_fingerprint(wide, n_components, standardize)

    np.savez_compressed(
        path, U=U, explained=explained, singular_values=S,
        fingerprint=np.array(fingerprint),
    )


def load_pca_cache(
    path: str, wide: pd.DataFrame, n_components: int, standardize: bool,
) -> tuple[np.ndarray, np.ndarray, np.ndarray] | None:
    """
    Returns the cached (U, explained, singular_values) if `path` exists
    and its fingerprint matches the given wide table/parameters, else
    None. Callers must fall back to a fresh eigh on None - e.g. local
    development without a baked cache, or a mismatch that should never
    happen in a correctly built image but must never be silently
    trusted if it does.
    """
    if not Path(path).exists():
        return None
    with np.load(path, allow_pickle=False) as data:
        if data["fingerprint"].item() != compute_fingerprint(wide, n_components, standardize):
            return None
        return data["U"], data["explained"], data["singular_values"]