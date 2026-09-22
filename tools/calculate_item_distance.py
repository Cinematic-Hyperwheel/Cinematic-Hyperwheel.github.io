"""
Calculate similarity and full character distance between two items.

Similarity:

    S(x, y) = mean(min(N(x_i), N(y_i)))

where N() independently normalizes each movie's tag vector using its
own 5th and 95th percentiles:

    N(x_i) = clip(
        (x_i - P5(x)) / (P95(x) - P5(x)),
        0,
        1
    )

This makes the similarity score independent of the absolute overall
intensity of a movie's tag profile.

Full distance:

    Euclidean distance in the complete Q_scaled space used by
    recommend() / recommend_many_planes() Stage A.

Usage:
    python tools/calculate_item_distance.py \
        --artifact data/ml-latest/artifact.npz \
        --item1 1 \
        --item2 2
"""

from __future__ import annotations

import argparse
import sys

import numpy as np

from hyperwheel_recommender import build_taste_basis, load_artifact
from hyperwheel_recommender.recommend import _base_distance_sq


def _normalize_movie_tags(values: np.ndarray) -> np.ndarray:
    """
    Normalize one movie's tag vector using its own 5th and 95th
    percentiles.

    Values below P5 are mapped to 0, values above P95 are mapped to 1,
    and intermediate values are linearly scaled into [0, 1].
    """
    p5, p95 = np.percentile(values, [5.0, 95.0])

    if p95 <= p5:
        return np.zeros_like(values, dtype=np.float32)

    normalized = (values - p5) / (p95 - p5)
    return np.clip(normalized, 0.0, 1.0).astype(np.float32)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Calculate similarity and full character distance between two items."
    )
    parser.add_argument(
        "--artifact",
        required=True,
        help="Path to the recommender artifact (.npz).",
    )
    parser.add_argument(
        "--item1",
        required=True,
        type=int,
        help="First movie ID.",
    )
    parser.add_argument(
        "--item2",
        required=True,
        type=int,
        help="Second movie ID.",
    )
    parser.add_argument(
        "--no-standardize",
        action="store_true",
        help="Disable criterion standardization for full_distance, matching recommend().",
    )
    args = parser.parse_args()

    wide = load_artifact(args.artifact)

    if args.item1 not in wide.index:
        print(f"Item not found: {args.item1}", file=sys.stderr)
        return 1

    if args.item2 not in wide.index:
        print(f"Item not found: {args.item2}", file=sys.stderr)
        return 1

    idx1 = wide.index.get_loc(args.item1)
    idx2 = wide.index.get_loc(args.item2)

    # Original normalized tag values in [0, 1].
    x1 = wide.iloc[idx1].to_numpy(dtype=np.float32)
    x2 = wide.iloc[idx2].to_numpy(dtype=np.float32)

    # Normalize each movie independently.
    nx1 = _normalize_movie_tags(x1)
    nx2 = _normalize_movie_tags(x2)

    # Mean fuzzy-set overlap:
    #
    #     S(x, y) = mean(min(N(x_i), N(y_i)))
    #
    # The result is always in [0, 1].
    similarity = float(np.mean(np.minimum(nx1, nx2)))

    # Build the same basis used by recommend() so full_distance remains
    # exactly the complete Q_scaled-space distance used by Stage A.
    basis = build_taste_basis(
        wide,
        n_components=wide.shape[1],
        standardize=not args.no_standardize,
    )

    base_distance_sq = _base_distance_sq(basis, idx1)
    full_distance = float(np.sqrt(base_distance_sq[idx2]))

    print(f"item1: {args.item1}")
    print(f"item2: {args.item2}")
    print(f"similarity: {similarity:.10f}")
    print(f"full_distance: {full_distance:.10f}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())