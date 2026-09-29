# tools/bench_similarity_freetier.py
"""
Standalone benchmark of the serve-stage startup path (load_artifact ->
PCA cache -> build_taste_basis) and of recommend_many_planes, meant to be
run inside a CPU/RAM-throttled container (see
tools/render_free_tier_emulation/Dockerfile) so the numbers are
comparable to the actual deployment target rather than the host machine.

Usage:
    python bench_similarity_freetier.py ARTIFACT REFERENCE_ITEM \\
        [--n-components 20] [--cache PCA_CACHE]

--n-components must equal the value the web app builds its basis with
(max(HYPERWHEEL_N_COMPONENTS, highest PC index in pc_config.json)),
otherwise the cache fingerprint check rejects the cache. Without
--cache the basis is computed fresh, as on a cache miss.
"""
from __future__ import annotations

import argparse
import resource
import sys
import time

from hyperwheel_recommender import build_taste_basis, load_artifact, load_pca_cache
from hyperwheel_recommender.recommend import recommend_many_planes


def peak_rss_mb() -> float:
    # ru_maxrss is in KB on Linux (the container's kernel).
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("artifact")
    parser.add_argument("reference_item", type=int)
    parser.add_argument("--n-components", type=int, default=20)
    parser.add_argument("--cache", default=None, help="pca_cache.npz built by tools/build_basis_cache.py")
    args = parser.parse_args()

    t0 = time.perf_counter()
    wide = load_artifact(args.artifact)
    print(f"load_artifact:     {time.perf_counter() - t0:.1f}s, RSS={peak_rss_mb():.1f} MB", file=sys.stderr)

    precomputed = None
    if args.cache:
        t0 = time.perf_counter()
        precomputed = load_pca_cache(args.cache, wide, args.n_components, True)
        print(
            f"load_pca_cache:    {time.perf_counter() - t0:.1f}s, "
            f"{'HIT' if precomputed is not None else 'MISS (falling back to fresh eigh)'}",
            file=sys.stderr,
        )

    t0 = time.perf_counter()
    basis = build_taste_basis(wide, n_components=args.n_components, precomputed_pca=precomputed)
    print(f"build_taste_basis: {time.perf_counter() - t0:.1f}s, RSS={peak_rss_mb():.1f} MB", file=sys.stderr)

    def recommend_once() -> None:
        recommend_many_planes(
            basis, args.reference_item, "complementary",
            planes=[(2, 3)], top_k=5, shortlist_size=50,
        )

    t0 = time.perf_counter()
    recommend_once()
    first_call = time.perf_counter() - t0   # includes numba JIT compile, if any

    t0 = time.perf_counter()
    for _ in range(5):
        recommend_once()
    warm_avg = (time.perf_counter() - t0) / 5

    print(f"first call (cold, incl. any JIT):  {first_call:.3f}s")
    print(f"warm call average (5 runs):         {warm_avg:.3f}s")
    print(f"peak RSS:                            {peak_rss_mb():.1f} MB")


if __name__ == "__main__":
    main()