"""Diagnostics: how many components are needed and what they physically mean."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .basis import build_feature_basis
from .rotation_subspace import rotate_groups

# An axis counts as reproducible when its counterpart in the other half of
# the data matches it at least this well (|cosine|).
STABLE_COS = 0.9
# Below STABLE_COS the axis still belongs to a reproducible subspace when
# this share of its energy lies within +-STABILITY_WINDOW components of the
# other half.
SUBSPACE_SHARE = 0.9
STABILITY_WINDOW = 5


@dataclass
class SplitHalfStability:
    match_cos: np.ndarray     # |cos| with the one-to-one matched axis of the other half
    best_cos: np.ndarray      # |cos| with the best-matching axis of the other half (no exclusivity)
    best_idx: np.ndarray      # 0-based index of that axis (most frequent over splits)
    window_share: np.ndarray  # energy share within +-window components of the other half
    lost_dims: np.ndarray     # dimensions of the span of the first c axes not reproduced


def tag_loadings(wide: pd.DataFrame, scores: np.ndarray, k: int) -> np.ndarray:
    """Signed loading per tag: correlation of the tag's relevance with
    the k-th (0-based) component score. U itself lives in the feature
    space (several columns per tag), so per-tag weights are read off the
    scores instead."""
    X = wide.to_numpy(dtype=np.float32)
    Xc = X - X.mean(axis=0)
    sk = scores[:, k] - scores[:, k].mean()
    return (Xc.T @ sk) / (np.linalg.norm(Xc, axis=0) * np.linalg.norm(sk) + 1e-12)


def cut_lost_dims(U_a: np.ndarray, U_b: np.ndarray, max_cut: int) -> np.ndarray:
    """
    lost[c - 1] = c - ||U_a[:c] @ U_b[:c].T||_F^2: how many dimensions of
    the span of the first c axes of half A are missing from the span of the
    first c axes of half B. The value is cumulative, so look at its growth
    per component: a group can be closed after c where it stays small. It
    is invariant to rotations of groups that end at or before c.
    """
    M2 = (U_a[:max_cut] @ U_b[:max_cut].T) ** 2
    overlap = np.cumsum(np.cumsum(M2, axis=0), axis=1).diagonal()
    return np.arange(1, max_cut + 1) - overlap


def _greedy_match(cos: np.ndarray) -> np.ndarray:
    """Per-row |cos| of a one-to-one assignment of rows to columns, taking
    the strongest remaining pair first. Rotated axes of a group are ordered
    by their variance, which is nearly equal inside a group, so axes must be
    paired by similarity rather than by index."""
    c = cos.copy()
    out = np.zeros(c.shape[0])
    for _ in range(min(c.shape)):
        i, j = np.unravel_index(np.argmax(c), c.shape)
        out[i] = c[i, j]
        c[i, :] = -1.0
        c[:, j] = -1.0
    return out


def split_half_stability(
    wide: pd.DataFrame,
    n_components: int,
    standardize: bool = True,
    n_splits: int = 1,
    window: int = STABILITY_WINDOW,
    seed: int = 0,
    rotate: Sequence[tuple[int, int]] | None = None,
) -> SplitHalfStability:
    """
    Fits the basis on two disjoint random halves of the items and compares
    every axis of one half with the axes of the other, averaged over
    `n_splits` random splits. If `rotate` is given, the same varimax groups
    are applied to both halves before comparing.

    An unrotated axis is compared with the axis of the same index; axes of
    a rotated group are matched one-to-one within that group (see
    _greedy_match). Each half is fitted with `window` extra components so
    the comparison window of the last reported axes is not truncated. Signs
    are arbitrary in PCA, hence absolute cosines. Every fit runs a full
    eigendecomposition (halves differ from the cached one), so cost grows
    with n_splits.
    """
    rng = np.random.default_rng(seed)
    n = len(wide)
    half = n // 2
    k_all = n_components + window
    groups = [(lo - 1, hi) for lo, hi in sorted(rotate or ())]  # 0-based, hi exclusive

    match = np.zeros(n_components)
    best = np.zeros(n_components)
    share = np.zeros(n_components)
    lost = np.zeros(n_components)
    best_idx = np.zeros((n_splits, n_components), dtype=int)

    for s in range(n_splits):
        perm = rng.permutation(n)
        a = build_feature_basis(wide.iloc[perm[:half]], k_all, standardize)
        b = build_feature_basis(wide.iloc[perm[half:2 * half]], k_all, standardize)
        if rotate:
            a, b = rotate_groups(a, rotate), rotate_groups(b, rotate)
        cos = np.abs(a.U[:n_components] @ b.U.T)  # (n_components, k_all)

        m = np.diag(cos[:, :n_components]).copy()
        for lo, hi in groups:
            m[lo:hi] = _greedy_match(cos[lo:hi, lo:hi])
        match += m
        best += cos.max(axis=1)
        best_idx[s] = cos.argmax(axis=1)
        lost += cut_lost_dims(a.U, b.U, n_components)
        for k in range(n_components):
            share[k] += np.sum(cos[k, max(0, k - window):k + window + 1] ** 2)

    return SplitHalfStability(
        match_cos=match / n_splits,
        best_cos=best / n_splits,
        best_idx=np.array([np.bincount(best_idx[:, k]).argmax() for k in range(n_components)]),
        window_share=share / n_splits,
        lost_dims=lost / n_splits,
    )


def _stability_verdict(match_cos: float, window_share: float) -> str:
    if match_cos >= STABLE_COS:
        return "axis"
    if window_share >= SUBSPACE_SHARE:
        return "subspace"
    return "unstable"


def print_stability(
    explained: np.ndarray,
    st: SplitHalfStability,
    rotate: Sequence[tuple[int, int]] | None = None,
) -> None:
    print(f"\n{'='*60}")
    print("Split-half stability (two disjoint halves of the items):")
    print(
        f"  match    - |cos| with the counterpart in the other half: same index for\n"
        f"             unrotated axes, one-to-one matched inside a rotated group\n"
        f"  axis     - match >= {STABLE_COS}\n"
        f"  subspace - axis is arbitrary, but its subspace is stable "
        f"(window share >= {SUBSPACE_SHARE})\n"
        f"  unstable - not reproduced\n"
        f"  lost     - dimensions of the span of PC1..PCc missing in the other half\n"
        f"             (cumulative; read its growth per component, and only at group\n"
        f"             ends and outside groups - inside a rotated group it is not\n"
        f"             rotation-invariant)"
    )
    # Gaps between two axes of one rotated group carry no meaning: the
    # group is re-sorted by variance and its axes are no longer eigenvectors.
    inside = set()
    for lo, hi in rotate or ():
        inside.update(range(lo - 1, hi - 1))

    print(f"\n{'component':>10} | {'explained':>9} | {'gap':>6} | {'match':>5} | "
          f"{'best':>9} | {'window':>6} | {'lost':>5} | verdict")
    print("-" * 74)
    n = len(st.match_cos)
    for k in range(n):
        if k + 1 >= len(explained):
            gap = "     -"
        elif k in inside:
            gap = "     ~"
        else:
            gap = f"{1 - explained[k + 1] / explained[k]:6.1%}"
        best = f"PC{st.best_idx[k] + 1}:{st.best_cos[k]:.2f}"
        print(
            f"{k + 1:>10} | {explained[k]:>9.2%} | {gap} | {st.match_cos[k]:>5.2f} | "
            f"{best:>9} | {st.window_share[k]:>6.2f} | {st.lost_dims[k]:>5.2f} | "
            f"{_stability_verdict(st.match_cos[k], st.window_share[k])}"
        )
    first_bad = next((k for k in range(n) if st.match_cos[k] < STABLE_COS), None)
    if first_bad is not None:
        print(f"\nFirst component that is not a reproducible axis: PC{first_bad + 1}")


def _item_label(item, titles: dict[int, str] | None) -> str:
    """'<id> <title>' when a title is known, else just the id. Item ids
    are compared as ints, since the artifact may store them as strings."""
    if titles is None:
        return str(item)
    try:
        title = titles.get(int(item))
    except (TypeError, ValueError):
        title = None
    return f"{item} {title}" if title else str(item)

def diagnose(
    wide: pd.DataFrame,
    max_components: int = 10,
    loadings_components: int = 2,
    loadings_top: int = 10,
    items_top: int = 10,
    standardize: bool = True,
    titles: dict[int, str] | None = None,
    stability_splits: int = 0,
    rotate: Sequence[tuple[int, int]] | None = None,
) -> None:
    """Prints how many components are needed for reasonable variance
    coverage, and which criteria most strongly shape the first components
    (loadings) - to understand what these axes physically represent.

    rotate: disjoint (FROM, TO) component groups (1-based, inclusive) to
    varimax-rotate before reporting; see rotation_subspace.py."""
    basis = build_feature_basis(wide, n_components=max_components, standardize=standardize)
    if rotate:
        basis = rotate_groups(basis, rotate)

    rotation_note = ""
    if rotate:
        rotation_note = ", varimax " + ", ".join(f"PC{a}..PC{b}" for a, b in sorted(rotate))
    print(f"(standardize={'on' if standardize else 'off'}{rotation_note})")

    explained_full = basis.explained  # per component, reflects the rotation

    print(f"\nItems: {wide.shape[0]}, criteria: {wide.shape[1]}\n")
    print(f"{'component':>10} | {'explained var':>14} | {'cumulative':>10}")
    print("-" * 40)
    cum = 0.0
    for i, v in enumerate(explained_full[:max_components], start=1):
        cum += v
        print(f"{i:>10} | {v:>13.1%} | {cum:>9.1%}")

    print(
        "\nRule of thumb: if 2 components already give reasonable coverage "
        "(e.g. >70-80%), a simple 2D hue plane is fine. If you need "
        "noticeably more, the schemes (complementary/triadic/...) will "
        "ignore part of the real differences between items; see "
        "--n-components in recommend."
    )

    # --- Loadings: what the first components physically represent ---
    n_show = min(loadings_components, basis.U.shape[0])
    criteria = np.array(basis.criteria)
    print(f"\n{'='*60}")
    print("Loadings (correlation of each criterion with the component score):")
    print(
        "Each component is a see-saw axis: the positive end (+) is one "
        "group of criteria, the negative end (-) is the opposite group. "
        "These two groups are exactly what gets contrasted against each "
        "other in the 'complementary' scheme."
    )
    for k in range(n_show):
        loadings = tag_loadings(wide, basis.scores, k)
        order = np.argsort(loadings)  # ascending
        neg_idx = order[:loadings_top]
        pos_idx = order[::-1][:loadings_top]

        print(f"\n--- PC{k+1} (explained variance: {explained_full[k]:.1%}) ---")
        print(f"  [+] {'criterion':<30} loading")
        for idx in pos_idx:
            print(f"      {criteria[idx]:<30} {loadings[idx]:+.3f}")
        print(f"  [-] {'criterion':<30} loading")
        for idx in neg_idx:
            print(f"      {criteria[idx]:<30} {loadings[idx]:+.3f}")

    # --- Items at the poles: often easier to read than criteria weights ---
    items_arr = np.array(basis.items)
    print(f"\n{'='*60}")
    print("Real items at the poles of the first components:")
    for k in range(n_show):
        item_scores = basis.scores[:, k]
        order = np.argsort(item_scores)
        neg_idx = order[:items_top]
        pos_idx = order[::-1][:items_top]

        print(f"\n--- PC{k+1} ---")
        print(f"  [+] items with the highest PC{k+1}:")
        for idx in pos_idx:
            print(f"      {_item_label(items_arr[idx], titles):<70} {item_scores[idx]:+.3f}")
        print(f"  [-] items with the lowest PC{k+1}:")
        for idx in neg_idx:
            print(f"      {_item_label(items_arr[idx], titles):<70} {item_scores[idx]:+.3f}")

    if stability_splits > 0:
        st = split_half_stability(
            wide, max_components, standardize=standardize,
            n_splits=stability_splits, rotate=rotate,
        )
        print_stability(basis.explained, st, rotate)