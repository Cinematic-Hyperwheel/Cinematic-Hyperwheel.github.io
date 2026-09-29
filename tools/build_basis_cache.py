"""
Bakes the expensive part of the PCA basis (see
hyperwheel_recommender.basis_cache) into a cache file at container BUILD
time, using the exact artifact and code that build produces an image
for. Intended to run as a build step (see render.yaml/Dockerfile) right
after the artifact and package code are already in place - never at
request time or on process start.

Usage:
    python tools/build_basis_cache.py \\
        --artifact data/ml-latest/artifact.npz \\
        --n-components 20 \\
        --out data/ml-latest/pca_cache.npz

--n-components must match the n_needed value apps/web/backend/app/wheel.py
actually builds the basis with (max(HYPERWHEEL_N_COMPONENTS, highest PC
index in pc_config.json)), not just the raw HYPERWHEEL_N_COMPONENTS env
var - otherwise the fingerprint check in load_pca_cache will (correctly)
reject the cache as a mismatch and fall back to a fresh eigh call.
"""
from __future__ import annotations

import argparse

from hyperwheel_recommender import load_artifact, save_pca_cache


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--artifact", required=True, help="artifact.npz to build the cache from")
    parser.add_argument("--n-components", type=int, required=True)
    parser.add_argument(
        "--no-standardize", action="store_true",
        help="Must match the standardize flag the app actually runs with",
    )
    parser.add_argument("--out", required=True, help="Where to save the PCA cache")
    args = parser.parse_args()

    wide = load_artifact(args.artifact)
    save_pca_cache(args.out, wide, args.n_components, standardize=not args.no_standardize)
    print(f"Saved PCA cache ({wide.shape[0]} items x {wide.shape[1]} criteria) -> {args.out}")


if __name__ == "__main__":
    main()