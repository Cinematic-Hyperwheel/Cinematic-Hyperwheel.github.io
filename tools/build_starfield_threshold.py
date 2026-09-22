"""
Build a global similarity threshold from pairwise movie similarities.

For each movie, its tag values are normalized independently using its own
5th and 95th percentiles:

    N(x_i) = clip(
        (x_i - P5(x)) / (P95(x) - P5(x)),
        0,
        1
    )

Pairwise similarity is then:

    S(x, y) = mean(min(N(x_i), N(y_i)))

The resulting similarity is in [0, 1].

The threshold is the requested percentile of all unique unordered
movie-pair similarities.

Usage:
    python tools/build_starfield_threshold.py \
        --artifact data/ml-latest/artifact.npz \
        --percentile 50 \
        --out data/ml-latest/starfield_threshold.txt
"""

from __future__ import annotations

import argparse
import sys
import time

import numpy as np

from hyperwheel_recommender import load_artifact


def _normalize_movies(x: np.ndarray) -> np.ndarray:
    """
    Normalize every movie independently using its own 5th and 95th
    percentiles.
    """
    p5 = np.percentile(x, 5.0, axis=1)
    p95 = np.percentile(x, 95.0, axis=1)

    scale = p95 - p5

    normalized = np.zeros_like(x, dtype=np.float32)

    valid = scale > 1e-12

    normalized[valid] = (
        x[valid] - p5[valid, None]
    ) / scale[valid, None]

    np.clip(
        normalized,
        0.0,
        1.0,
        out=normalized,
    )

    return normalized


def _pair_similarities(
    x: np.ndarray,
    block_size: int,
    criterion_block_size: int,
) -> np.ndarray:
    """
    Calculate all unique unordered pairwise similarities.

    Each pair uses:

        mean(min(x_i, y_i))

    across all normalized criteria.

    The computation is blocked over both movies and criteria to keep
    temporary memory bounded.
    """
    n_items, n_criteria = x.shape

    total_pairs = n_items * (n_items - 1) // 2
    similarities = np.empty(
        total_pairs,
        dtype=np.float32,
    )

    offset = 0

    for i0 in range(0, n_items, block_size):
        i1 = min(i0 + block_size, n_items)
        a = x[i0:i1]

        for j0 in range(i0, n_items, block_size):
            j1 = min(j0 + block_size, n_items)
            b = x[j0:j1]

            block_sum = np.zeros(
                (i1 - i0, j1 - j0),
                dtype=np.float32,
            )

            for c0 in range(0, n_criteria, criterion_block_size):
                c1 = min(c0 + criterion_block_size, n_criteria)

                block_sum += np.minimum(
                    a[:, None, c0:c1],
                    b[None, :, c0:c1],
                ).sum(
                    axis=2,
                    dtype=np.float32,
                )

            block_similarity = (
                block_sum / n_criteria
            )

            if i0 == j0:
                rows, cols = np.triu_indices(
                    i1 - i0,
                    k=1,
                )
                values = block_similarity[rows, cols]
            else:
                values = block_similarity.ravel()

            end = offset + values.size
            similarities[offset:end] = values
            offset = end

    return similarities


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--artifact",
        required=True,
        help="Path to the recommender artifact (.npz).",
    )
    parser.add_argument(
        "--percentile",
        type=float,
        default=50.0,
        help="Global similarity percentile to use as the threshold.",
    )
    parser.add_argument(
        "--block-size",
        type=int,
        default=256,
        help="Number of movies per pair block.",
    )
    parser.add_argument(
        "--criterion-block-size",
        type=int,
        default=128,
        help="Number of criteria processed at once.",
    )
    parser.add_argument(
        "--out",
        required=True,
        help="Output file containing the single similarity threshold.",
    )

    args = parser.parse_args()

    if not 0.0 <= args.percentile <= 100.0:
        parser.error("--percentile must be between 0 and 100.")

    if args.block_size <= 0:
        parser.error("--block-size must be > 0.")

    if args.criterion_block_size <= 0:
        parser.error("--criterion-block-size must be > 0.")

    t0 = time.time()

    wide = load_artifact(args.artifact)

    # Original normalized tag values.
    x = wide.to_numpy(dtype=np.float32)

    n_items, n_criteria = x.shape

    print(
        f"items: {n_items}",
        file=sys.stderr,
    )
    print(
        f"criteria: {n_criteria}",
        file=sys.stderr,
    )
    print(
        "normalization: per-movie P5/P95",
        file=sys.stderr,
    )
    print(
        "similarity: mean(min(N(x), N(y)))",
        file=sys.stderr,
    )

    normalized = _normalize_movies(x)

    similarities = _pair_similarities(
        normalized,
        block_size=args.block_size,
        criterion_block_size=args.criterion_block_size,
    )

    threshold = float(
        np.percentile(
            similarities,
            args.percentile,
        )
    )

    with open(args.out, "w", encoding="utf-8") as f:
        f.write(f"{threshold:.10f}\n")

    print(
        f"pairs: {len(similarities)}",
        file=sys.stderr,
    )
    print(
        f"percentile: {args.percentile:g}%",
        file=sys.stderr,
    )
    print(
        f"threshold: {threshold:.10f}",
        file=sys.stderr,
    )
    print(
        f"elapsed: {time.time() - t0:.1f}s",
        file=sys.stderr,
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())