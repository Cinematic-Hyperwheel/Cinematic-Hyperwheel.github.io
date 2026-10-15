"""
Compares STANDARDIZE_POWER values on a few reference items.

For every power, builds the basis in memory and reports, per item, the
component on which it is most expressive (largest |z|, PC1 excluded),
plus the variance explained by the first components. Items from one
family (e.g. Ghibli films) should concentrate on few axes if the family
is a coherent direction.

Usage:
    python tools/compare_standardize_power.py data/ml-latest/artifact.npz \\
        --items 5618 7099 3000 5796 6350 --powers 1.0 0.5 0.25
"""
from __future__ import annotations

import argparse

import numpy as np

from hyperwheel_recommender import basis as basis_module
from hyperwheel_recommender import build_feature_basis, load_artifact


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("artifact")
    p.add_argument("--items", type=int, nargs="+", required=True, help="movieIds to track")
    p.add_argument("--powers", type=float, nargs="+", default=[1.0, 0.5, 0.25])
    p.add_argument("--n-components", type=int, default=60)
    args = p.parse_args()

    wide = load_artifact(args.artifact)
    original = basis_module.STANDARDIZE_POWER
    try:
        for power in args.powers:
            # basis.py imports the constant by name, so it is overridden there.
            basis_module.STANDARDIZE_POWER = power
            b = build_feature_basis(wide, args.n_components, standardize=True)
            z = b.scores / b.pc_std
            idx_of = {int(it): i for i, it in enumerate(b.items)}
            print(f"\n== power {power} == explained: first 10 {b.explained[:10].sum():.1%}, "
                  f"first 30 {b.explained[:30].sum():.1%}, first {len(b.explained)} {b.explained.sum():.1%}")
            for item in args.items:
                i = idx_of.get(item)
                if i is None:
                    print(f"  {item}: not in the basis")
                    continue
                top = np.argsort(-np.abs(z[i, 1:]))[:3] + 1  # PC1 is never a hue axis
                desc = ", ".join(f"PC{k + 1}({z[i, k]:+.1f})" for k in top)
                print(f"  {item:<8} {desc}")
    finally:
        basis_module.STANDARDIZE_POWER = original


if __name__ == "__main__":
    main()