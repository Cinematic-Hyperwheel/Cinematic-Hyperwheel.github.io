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


def compute_fingerprint(wide: pd.DataFrame, n_components: int, standardize: bool) -> str:
    """
    Identifies the exact (code, dataset, parameters) combination an
    eigendecomposition cache was built from:
      - the source of _solve_pca itself, so any change to the PCA
        algorithm invalidates old caches automatically, without relying
        on a manually bumped version number;
      - the wide table's shape, items and criteria, plus a strided
        sample of its values (not the full matrix - see below), so a
        cache from one artifact is never silently reused for a
        different one;
      - n_components and standardize, since both affect the result.

    Hashing the full matrix here was tried first and rejected: at
    catalog scale (thousands of items x thousands of criteria) that's
    tens of MB, and hashlib runs single-threaded - under a throttled CPU
    quota this fingerprint check alone took multiple seconds, eating
    most of the time the cache was meant to save (see
    docs/performance.md). Since this fingerprint is a defensive check
    against a mismatched cache, not the primary correctness mechanism
    (see module docstring), a strided sample is enough to catch the
    kinds of mismatch this cache is actually at risk of - a different
    artifact entirely, or different n_components/standardize - at a
    small, size-independent cost.
    """
    X = wide.to_numpy(dtype=np.float32)
    # Every 97th element (97 is prime, so it doesn't alias with common
    # regular structure like a fixed criteria stride) - a fixed-size
    # sample regardless of catalog size, not full coverage.
    sample = X.reshape(-1)[::97]

    hasher = hashlib.sha256()
    hasher.update(inspect.getsource(basis_module._solve_pca).encode("utf-8"))
    hasher.update(f"shape={X.shape}|dtype={X.dtype}".encode("utf-8"))
    hasher.update("|".join(map(str, wide.index)).encode("utf-8"))
    hasher.update("|".join(map(str, wide.columns)).encode("utf-8"))
    hasher.update(sample.tobytes())
    hasher.update(f"|n_components={n_components}|standardize={standardize}".encode("utf-8"))
    return hasher.hexdigest()


def _standardized_shape_space(wide: pd.DataFrame, standardize: bool) -> np.ndarray:
    """Reproduces the Q_scaled matrix build_taste_basis feeds into
    _solve_pca, so save_pca_cache runs the exact same eigh input without
    importing build_taste_basis's other, unrelated bookkeeping."""
    X = wide.to_numpy(dtype=np.float32)
    L = X.mean(axis=1)
    Q = X - L[:, None]
    M = Q.mean(axis=0)
    Qc = Q - M[None, :]
    if standardize:
        scale = Qc.std(axis=0)
        scale = np.where(scale < 1e-12, 1.0, scale)
    else:
        scale = np.ones(Qc.shape[1])
    return Qc / scale


def save_pca_cache(path: str, wide: pd.DataFrame, n_components: int, standardize: bool) -> None:
    """Runs the expensive eigh step once and saves its result, tagged
    with a fingerprint of the exact code/data/parameters used. Call this
    at image build time (see tools/build_basis_cache.py) - never at
    request time or on process start."""
    Q_scaled = _standardized_shape_space(wide, standardize)
    U, explained, S = basis_module._solve_pca(Q_scaled, n_components)
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