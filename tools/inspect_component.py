"""
Manual inspection of a single PCA component.

Unlike `diagnose` (linear correlation of raw tag relevance with the
score), this works in the actual feature space the PCA was fit on:

  spectrum   - eigenvalue gaps around the component (poorly separated
               neighbors make the axis an arbitrary mix);
  tags       - per-tag energy of the component, its effective number of
               tags, and each tag's partial response (including
               non-monotone shapes that a linear loading cannot show);
  poles      - items at both poles and in the intermediate zones, with
               the tags each item's score actually comes from, plus how
               similar the items of one pole are to each other in terms
               of those tags (low = several unrelated mechanisms);
  quadratic  - how much of the score is a quadratic function of earlier
               components (horseshoe artifact);
  stability  - split-half reproducibility of the axis (slow, optional).

Usage:
    python tools/inspect_component.py data/ml-latest/artifact.npz \\
        --component 33 --movies data/ml-latest/movies.csv \\
        --items 2571 5618 --stability
"""
from __future__ import annotations

import argparse
import csv
import itertools
from pathlib import Path
import sys

import numpy as np
from hyperwheel_recommender import (
    build_feature_basis,
    load_artifact,
    load_pca_cache,
    rotate_groups,
)
from hyperwheel_recommender.diagnose import tag_loadings
from hyperwheel_recommender.features import FEATURES_PER_TAG as F
from hyperwheel_recommender.features import feature_map

# Relevance quantiles at which each tag's partial response is sampled.
RESPONSE_QUANTILES = [0.05, 0.5, 0.95, 0.995]

# Number of items taken from each pole for clustering.
CLUSTER_POOL = 150


def tag_contributions(basis, blocks, idx) -> np.ndarray:
    """(len(idx), n_tags): per-tag share of each item's component score."""
    T = len(basis.criteria)
    return (basis.Phi[idx].reshape(len(idx), T, F) * blocks).sum(axis=2)


def spherical_kmeans(Xn: np.ndarray, k: int, rng: np.random.Generator, iters: int = 50) -> np.ndarray:
    centers = Xn[rng.choice(len(Xn), k, replace=False)]
    labels = np.zeros(len(Xn), dtype=int)
    for _ in range(iters):
        labels = np.argmax(Xn @ centers.T, axis=1)
        new = np.stack([
            Xn[labels == j].mean(axis=0) if (labels == j).any() else centers[j]
            for j in range(k)
        ])
        new /= np.linalg.norm(new, axis=1, keepdims=True) + 1e-12
        if np.allclose(new, centers):
            break
        centers = new
    return labels


def report_clusters(basis, blocks, k0: int, names, k: int, seed: int) -> None:
    """Splits each pole into groups of items whose score comes from the
    same tags; shows how much of the pole each group carries."""
    tags = [str(c) for c in basis.criteria]
    score = basis.scores[:, k0]
    order = np.argsort(score)
    rng = np.random.default_rng(seed)
    for label, idx in (("positive", order[::-1][:CLUSTER_POOL]), ("negative", order[:CLUSTER_POOL])):
        C = tag_contributions(basis, blocks, idx)
        Cn = C / (np.linalg.norm(C, axis=1, keepdims=True) + 1e-12)
        labels = spherical_kmeans(Cn, k, rng)
        total = np.abs(score[idx]).sum()
        print(f"\n== {label} pole: {k} clusters of top {CLUSTER_POOL} (share of pole score) ==")
        for j in sorted(range(k), key=lambda j: -np.abs(score[idx[labels == j]]).sum()):
            m = labels == j
            if not m.any():
                continue
            mean_c = C[m].mean(axis=0)
            dom = ", ".join(f"{tags[t]}({mean_c[t]:+.2f})" for t in np.argsort(-np.abs(mean_c))[:6])
            share = np.abs(score[idx[m]]).sum() / total
            print(f"  [{m.sum():3d} items, {share:4.0%}] {dom}")
            for i in idx[m][:3]:
                print(f"      {names(int(i))}")


def report_rotation(basis, k0: int, k1: int, names, top: int = 20) -> None:
    """Rotates the (k0, k1) pair of near-degenerate components and shows
    the angle at which the item scores are most clustered (max excess
    kurtosis), with the poles of both rotated axes."""
    z = basis.scores[:, [k0, k1]] / basis.pc_std[[k0, k1]]

    def kurt(v: np.ndarray) -> float:
        v = (v - v.mean()) / (v.std() + 1e-12)
        return float((v ** 4).mean() - 3)

    best = max(
        range(0, 180, 5),
        key=lambda d: sum(kurt(z @ r) for r in _rotation_axes(d)),
    )
    print(f"\n== Rotation of PC{k0 + 1}/PC{k1 + 1} (max kurtosis at {best} deg) ==")
    for n, axis in enumerate(_rotation_axes(best)):
        s = z @ axis
        order = np.argsort(s)
        print(f"  rotated axis {n + 1}, excess kurtosis {kurt(s):.1f}")
        for lab, idx in (("+", order[::-1][:top]), ("-", order[:top])):
            for i in idx:
                print(f"    {lab} z={s[i]:+5.2f} {names(int(i))}")


def _rotation_axes(deg: float) -> list[np.ndarray]:
    t = np.radians(deg)
    return [np.array([np.cos(t), np.sin(t)]), np.array([-np.sin(t), np.cos(t)])]


def load_titles(path: str | None) -> dict[int, str]:
    if not path:
        return {}
    with open(path, "r", encoding="utf-8", newline="") as f:
        return {int(r["movieId"]): r["title"] for r in csv.DictReader(f) if r.get("movieId")}


def report_spectrum(basis, k0: int) -> None:
    ex = basis.explained
    tol = 2 * np.sqrt(2 / len(basis.items))  # North's rule of thumb
    print(f"\n== Spectrum (relative gap below ~{tol:.1%} => axis mixed with its neighbor) ==")
    for j in range(max(0, k0 - 3), min(len(ex) - 1, k0 + 4)):
        gap = 1 - ex[j + 1] / ex[j]
        flag = "  <- mixed" if gap < tol else ""
        print(f"  PC{j + 1:<3} {ex[j]:7.3%}  gap to PC{j + 2}: {gap:6.1%}{flag}")


def report_tags(wide, basis, k0: int, top: int) -> np.ndarray:
    T = len(basis.criteria)
    blocks = basis.U[k0].reshape(T, F)
    energy = (blocks ** 2).sum(axis=1)  # sums to 1: U is orthonormal
    print(f"\n== Tags (effective number of tags: {1 / np.sum(energy ** 2):.1f} of {T}) ==")

    r = tag_loadings(wide, basis.scores, k0)
    mu, scale = basis.mu.reshape(T, F), basis.scale.reshape(T, F)
    X = wide.to_numpy(dtype=np.float32)
    header = "/".join(f"q{q:g}" for q in RESPONSE_QUANTILES)
    print(f"  {'tag':<28}{'energy':>8}{'r':>7}   response at {header}")
    for t in np.argsort(-energy)[:top]:
        xs = np.quantile(X[:, t], RESPONSE_QUANTILES).astype(np.float32)
        resp = ((feature_map(xs.reshape(-1, 1)) - mu[t]) / scale[t]) @ blocks[t]
        d = np.diff(resp)
        shape = "non-monotone" if (d > 0).any() and (d < 0).any() else ""
        vals = " ".join(f"{v:+.2f}" for v in resp)
        print(f"  {str(basis.criteria[t]):<28}{energy[t]:8.1%}{r[t]:+7.2f}   {vals}  {shape}")
    return blocks


def report_items(wide, basis, blocks, k0, names, args) -> None:
    T = len(basis.criteria)
    score = basis.scores[:, k0]
    z = score / basis.pc_std[k0]
    tags = [str(c) for c in basis.criteria]
    X = wide.to_numpy(dtype=np.float32)

    def contrib(i: int) -> np.ndarray:
        # Per-tag share of the item's score; sums to score[i].
        return (basis.Phi[i].reshape(T, F) * blocks).sum(axis=1)

    def line(i: int) -> str:
        c = contrib(i)
        top = np.argsort(-np.abs(c))[:4]
        # x is the raw relevance: a contribution reflects how unusual x is
        # for that tag across the catalog, not how high x is in absolute terms.
        why = ", ".join(f"{tags[t]}({c[t]:+.2f}, x={X[i, t]:.2f})" for t in top)
        return f"  z={z[i]:+5.2f}  {names(i):<55.55} {why}"

    order = np.argsort(score)
    for label, idx in (("positive pole", order[::-1][:args.top_n]), ("negative pole", order[:args.top_n])):
        print(f"\n== {label} ==")
        for i in idx:
            print(line(int(i)))

        pool = order[::-1][:100] if label.startswith("pos") else order[:100]
        C = np.stack([contrib(int(i)) for i in pool])
        Cn = C / (np.linalg.norm(C, axis=1, keepdims=True) + 1e-12)
        n = len(pool)
        coherence = (Cn @ Cn.T).sum() - n
        print(f"  pole coherence (mean pairwise cosine of tag contributions, top {n}): "
              f"{coherence / (n * (n - 1)):.2f}")
        mean_c = C.mean(axis=0)
        agg = ", ".join(f"{tags[t]}({mean_c[t]:+.2f})" for t in np.argsort(-np.abs(mean_c))[:10])
        print(f"  dominant tags over the pole: {agg}")

    rng = np.random.default_rng(args.seed)
    for lo, hi in ((0.8, 1.5), (-1.5, -0.8)):
        zone = np.flatnonzero((z >= lo) & (z <= hi))
        print(f"\n== intermediate zone z in [{lo}, {hi}] ({len(zone)} items, random sample) ==")
        for i in rng.choice(zone, size=min(args.mid_n, len(zone)), replace=False):
            print(line(int(i)))

    if args.items:
        print("\n== requested items ==")
        idx_of = {int(it): i for i, it in enumerate(basis.items)}
        for item_id in args.items:
            i = idx_of.get(item_id)
            if i is None:
                print(f"  {item_id}: not in the basis")
                continue
            print(line(i))
            c = contrib(i)
            neg = np.argsort(c)[:args.top_n]
            pos = np.argsort(-c)[:args.top_n]
            print(f"    sum of positive contributions {c[c > 0].sum():+.2f}, negative {c[c < 0].sum():+.2f}")
            print("    top positive: " + ", ".join(f"{tags[t]}({c[t]:+.2f}, x={X[i, t]:.2f})" for t in pos))
            print("    top negative: " + ", ".join(f"{tags[t]}({c[t]:+.2f}, x={X[i, t]:.2f})" for t in neg))
            raw = np.argsort(-X[i])[:10]
            print("    top raw relevance: " + ", ".join(f"{tags[t]} {X[i, t]:.2f}" for t in raw))


def report_quadratic(basis, k0: int) -> None:
    cols = list(range(1, min(10, k0)))  # PC2.. up to PC10, PC1 is never a hue axis
    if not cols:
        return
    z = basis.scores / basis.pc_std
    terms = [z[:, c] for c in cols] + [z[:, a] * z[:, b] for a, b in itertools.combinations_with_replacement(cols, 2)]
    A = np.column_stack([np.ones(len(z))] + terms)
    y = z[:, k0]
    coef, *_ = np.linalg.lstsq(A, y, rcond=None)
    r2 = 1 - np.sum((y - A @ coef) ** 2) / np.sum((y - y.mean()) ** 2)
    print(f"\n== Quadratic check ==\n  R^2 of PC{k0 + 1} explained by quadratic terms of PC{cols[0] + 1}..PC{cols[-1] + 1}: {r2:.3f}")


def report_stability(wide, k0: int, n_components: int, standardize: bool, seed: int, rotate=None) -> None:
    perm = np.random.default_rng(seed).permutation(len(wide))
    half = len(wide) // 2
    a = build_feature_basis(wide.iloc[perm[:half]], n_components, standardize)
    b = build_feature_basis(wide.iloc[perm[half:]], n_components, standardize)
    if rotate:
        a, b = rotate_groups(a, rotate), rotate_groups(b, rotate)
    cos = np.abs(a.U[k0] @ b.U.T)
    lo, hi = max(0, k0 - 5), min(len(cos), k0 + 6)
    window = float(np.sum(cos[lo:hi] ** 2))
    print(f"\n== Split-half stability ==")
    print(f"  best match in the other half: PC{int(np.argmax(cos)) + 1}, |cos|={cos.max():.2f}")
    print(f"  same index PC{k0 + 1}: |cos|={cos[k0]:.2f}")
    print(f"  share of the axis inside PC{lo + 1}..PC{hi} of the other half: {window:.2f}")
    print("  (|cos| << 1 but a share near 1 => the subspace is stable, the axis inside it is arbitrary)")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("artifact")
    p.add_argument("--component", type=int, required=True, help="1-based PC index")
    p.add_argument("--movies", default=None, help="movies.csv, for titles")
    p.add_argument("--n-components", type=int, default=50)
    p.add_argument("--cache", default=None, help="Optional pca_cache.npz")
    p.add_argument("--no-standardize", action="store_true")
    p.add_argument("--items", type=int, nargs="*", default=[], help="movieIds to explain")
    p.add_argument("--top-tags", type=int, default=25)
    p.add_argument("--top-n", type=int, default=15)
    p.add_argument("--mid-n", type=int, default=10)
    p.add_argument("--stability", action="store_true", help="Split-half check (recomputes PCA twice)")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--clusters", type=int, default=0, help="Cluster each pole into K groups by tag contributions")
    p.add_argument("--rotate-with", type=int, default=None, help="1-based PC to rotate the component with (see report_rotation)")
    p.add_argument(
        "--rotate", nargs=2, type=int, metavar=("FROM", "TO"), action="append", default=None,
        help="Varimax-rotate the group FROM..TO (1-based, inclusive); repeat for several. "
             "Pass the same groups as rotation_groups in pc_config.json, otherwise the "
             "component differs from the one the web app serves.",
    )

    args = p.parse_args()

    standardize = not args.no_standardize
    wide = load_artifact(args.artifact)
    pre = load_pca_cache(args.cache, wide, args.n_components, standardize) if args.cache else None

    if pre is not None:
        print(f"[info] PCA cache hit: {args.cache}", file=sys.stderr)
    else:
        # A present-but-rejected file means it was built for a different
        # artifact, n_components or standardize flag, or before a PCA code change.
        reason = "fingerprint mismatch" if Path(args.cache).exists() else "file not found"
        print(f"[info] PCA cache miss ({reason}: {args.cache})", file=sys.stderr)

    basis = build_feature_basis(wide, args.n_components, standardize, precomputed_pca=pre)
    rotate = [tuple(g) for g in args.rotate] if args.rotate else None
    if rotate:
        basis = rotate_groups(basis, rotate)

    k0 = args.component - 1
    if not 0 <= k0 < basis.U.shape[0]:
        raise SystemExit(f"--component must be within 1..{basis.U.shape[0]}")

    titles = load_titles(args.movies)
    ids = [int(i) for i in basis.items]
    names = lambda i: f"{ids[i]} {titles.get(ids[i], '?')}"

    report_spectrum(basis, k0)
    blocks = report_tags(wide, basis, k0, args.top_tags)
    report_items(wide, basis, blocks, k0, names, args)
    report_quadratic(basis, k0)
    if args.stability:
        report_stability(wide, k0, args.n_components, standardize, args.seed, rotate)

    if args.clusters:
        report_clusters(basis, blocks, k0, names, args.clusters, args.seed)
    if args.rotate_with:
        report_rotation(basis, k0, args.rotate_with - 1, names)

if __name__ == "__main__":
    main()