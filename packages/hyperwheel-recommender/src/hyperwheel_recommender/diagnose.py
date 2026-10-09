"""Diagnostics: how many components are needed and what they physically mean."""

from __future__ import annotations

import numpy as np
import pandas as pd

from .basis import build_feature_basis


def tag_loadings(wide: pd.DataFrame, scores: np.ndarray, k: int) -> np.ndarray:
    """Signed loading per tag: correlation of the tag's relevance with
    the k-th (0-based) component score. U itself lives in the feature
    space (several columns per tag), so per-tag weights are read off the
    scores instead."""
    X = wide.to_numpy(dtype=np.float32)
    Xc = X - X.mean(axis=0)
    sk = scores[:, k] - scores[:, k].mean()
    return (Xc.T @ sk) / (np.linalg.norm(Xc, axis=0) * np.linalg.norm(sk) + 1e-12)


def diagnose(
    wide: pd.DataFrame,
    max_components: int = 10,
    loadings_components: int = 2,
    loadings_top: int = 10,
    items_top: int = 10,
    standardize: bool = True,
) -> None:
    """Prints how many components are needed for reasonable variance
    coverage, and which criteria most strongly shape the first components
    (loadings) - to understand what these axes physically represent."""
    basis = build_feature_basis(wide, n_components=max_components, standardize=standardize)
    print(f"(standardize={'on' if standardize else 'off'})")
    total_var = np.sum(basis.singular_values ** 2)
    explained_full = (basis.singular_values ** 2) / total_var if total_var > 0 else basis.singular_values * 0

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
            print(f"      {items_arr[idx]:<30} {item_scores[idx]:+.3f}")
        print(f"  [-] items with the lowest PC{k+1}:")
        for idx in neg_idx:
            print(f"      {items_arr[idx]:<30} {item_scores[idx]:+.3f}")