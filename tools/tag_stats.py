"""
Tag mass statistics for the tag-genome artifact.

For every tag: how many items express it pronouncedly, how heavy its tail
is, and the weight its block gets after per-tag scaling with a given
STANDARDIZE_POWER (block variance ** (1 - power)). Also lists the most
correlated tags, to spot families of near-duplicates.

Usage:
    python tools/tag_stats.py data/ml-latest/artifact.npz --power 0.5
"""
from __future__ import annotations

import argparse

import numpy as np

from hyperwheel_recommender import load_artifact

# Relevance above which an item is considered to pronouncedly have a tag.
PRONOUNCED = 0.5
# Tags with fewer pronounced items than this are reported as "sparse".
SPARSE_ITEMS = 50
# Pairs of tags correlated above this are reported as one family.
FAMILY_CORR = 0.8


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("artifact")
    p.add_argument("--power", type=float, default=0.5)
    p.add_argument("--top", type=int, default=30)
    args = p.parse_args()

    wide = load_artifact(args.artifact)
    X = wide.to_numpy(dtype=np.float32)
    tags = [str(c) for c in wide.columns]

    n_pron = (X > PRONOUNCED).sum(axis=0)
    q999 = np.quantile(X, 0.999, axis=0)
    var = X.var(axis=0)
    # Relative weight of the tag's block after scaling by std ** power.
    weight = var ** (1 - args.power)
    weight = weight / weight.mean()

    sparse = n_pron < SPARSE_ITEMS
    print(f"tags: {len(tags)}, sparse (< {SPARSE_ITEMS} items above {PRONOUNCED}): {int(sparse.sum())}")
    print(f"weight share of sparse tags at power 1.0: {sparse.mean():.1%}")
    w_p = var ** (1 - args.power)
    print(f"weight share of sparse tags at power {args.power}: {w_p[sparse].sum() / w_p.sum():.1%}")

    print(f"\n== lowest q99.9 (tags that never fire) ==")
    print(f"  {'tag':<30}{'items>0.5':>10}{'q99.9':>8}{'weight':>8}")
    for t in np.argsort(q999)[:args.top]:
        print(f"  {tags[t]:<30}{n_pron[t]:>10}{q999[t]:>8.2f}{weight[t]:>8.2f}")

    print(f"\n== sparse tags with the highest weight ==")
    cand = np.flatnonzero(sparse)
    for t in cand[np.argsort(-weight[cand])][:args.top]:
        print(f"  {tags[t]:<30}{n_pron[t]:>10}{q999[t]:>8.2f}{weight[t]:>8.2f}")

    print(f"\n== tag families (correlation > {FAMILY_CORR}) among sparse tags ==")
    idx = cand
    C = np.corrcoef(X[:, idx].T)
    seen: set[int] = set()
    for a in range(len(idx)):
        if a in seen:
            continue
        fam = [b for b in np.flatnonzero(C[a] > FAMILY_CORR)]
        if len(fam) > 1:
            seen.update(fam)
            print("  " + ", ".join(tags[idx[b]] for b in fam))


if __name__ == "__main__":
    main()