"""CLI: `python -m hyperwheel build|diagnose|recommend ...`"""

from __future__ import annotations

import argparse
import sys
import time

from .data import load_input, load_matrix, save_artifact
from .diagnose import diagnose
from .recommend import recommend
from .rotation import SCHEMES


def _print_effective_args(args: argparse.Namespace) -> None:
    """
    Prints every resolved argument for this run - including ones the user
    didn't pass, so their default is visible too. With this many flags,
    most having non-obvious defaults (e.g. --hue-components defaulting to
    'auto', --n-components to 20), silently running on an unstated default
    is easy to miss; this makes the actual configuration explicit on every
    run.
    """
    values = vars(args)
    width = max(len(k) for k in values if k != "command")
    print(f"[info] {args.command} — effective arguments:", file=sys.stderr)
    for key, value in values.items():
        if key == "command":
            continue
        print(f"  {key:<{width}} = {value!r}", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Hyperwheel item recommender (PCA-based color-wheel schemes for N criteria)"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_build = sub.add_parser(
        "build",
        help="One-off: turn a CSV into a compact .npz artifact - for the "
             "serve stage (a web service should not re-parse the source "
             "CSV on every start)",
    )
    p_build.add_argument("csv_path")
    p_build.add_argument("--tags-path", help="Tags CSV path", default=None)
    p_build.add_argument("--out", required=True, help="Where to save the .npz artifact")
    p_build.add_argument("--chunksize", type=int, default=500_000)

    p_diag = sub.add_parser("diagnose", help="How many PCA components are actually needed")
    p_diag.add_argument("input_path", help="CSV or .npz (from build)")
    p_diag.add_argument("--max-components", type=int, default=10)
    p_diag.add_argument(
        "--loadings-components", type=int, default=2,
        help="For how many first components to show criteria weights",
    )
    p_diag.add_argument(
        "--loadings-top", type=int, default=10,
        help="How many criteria to show at each end of the axis",
    )
    p_diag.add_argument(
        "--items-top", type=int, default=10,
        help="How many items to show at each pole of a component",
    )
    p_diag.add_argument(
        "--no-standardize", action="store_true",
        help="Disable z-scoring criteria before PCA (enabled by default - "
             "without it, criteria with a larger spread artificially dominate)",
    )

    p_rec = sub.add_parser("recommend", help="Find items matching a color-wheel scheme")
    p_rec.add_argument("input_path", help="CSV or .npz (from build)")
    p_rec.add_argument("--item", required=True, help="Name of the reference item", type=int)
    p_rec.add_argument(
        "--scheme", required=True, choices=list(SCHEMES),
        help="complementary / triadic / analogous / split-complementary / tetradic",
    )
    p_rec.add_argument("--n-components", type=int, default=20)
    p_rec.add_argument("--top-k", type=int, default=5)
    p_rec.add_argument("--out", default=None, help="Save the result to a CSV")
    p_rec.add_argument(
        "--hue-components", default="auto",
        help="Either 'auto' (default) to pick, per reference item, the two "
             "components on which THAT item is most expressive (recommended "
             "when the variance spectrum is diffuse - no clearly dominant "
             "pair), or an explicit 1-based pair 'i,j' fixed across all "
             "items, e.g. '2,3'.",
    )
    p_rec.add_argument(
        "--exclude-components", default="1",
        help="Comma-separated 1-based components never eligible for "
             "--hue-components auto, e.g. a known 'quality' axis. Default "
             "'1' (PC1). Ignored when --hue-components is an explicit pair.",
    )
    p_rec.add_argument(
        "--candidate-components", type=int, default=None,
        help="Only consider the first N components (1-based) as candidates "
             "for --hue-components auto. Defaults to --n-components. Caps "
             "how far into the long tail auto-selection is allowed to reach, "
             "to avoid picking a component that explains almost no variance "
             "overall just because one item happens to spike there.",
    )
    p_rec.add_argument(
        "--no-standardize", action="store_true",
        help="Disable z-scoring criteria before PCA (enabled by default)",
    )
    p_rec.add_argument(
        "--shortlist-size", type=int, default=50,
        help="Safety cap on Stage-A's character shortlist (items that are "
             "a statistically significant near-outlier on closeness to the "
             "target - not just the closest available regardless of how "
             "close that is) before Stage B's angular re-rank. Must be >= "
             "--top-k. See /docs/math.md, section 6b.",
    )

    args = parser.parse_args()
    _print_effective_args(args)

    if args.command == "build":
        t0 = time.time()
        wide = load_matrix(args.csv_path, genome_tags_csv_path=args.tags_path, chunksize=args.chunksize)
        save_artifact(wide, args.out)
        print(
            f"Done: {wide.shape[0]} items x {wide.shape[1]} criteria "
            f"-> {args.out} in {time.time() - t0:.1f}s"
        )
        return

    wide = load_input(args.input_path)

    if args.command == "diagnose":
        diagnose(
            wide,
            max_components=args.max_components,
            loadings_components=args.loadings_components,
            loadings_top=args.loadings_top,
            items_top=args.items_top,
            standardize=not args.no_standardize,
        )
    elif args.command == "recommend":
        if args.hue_components == "auto":
            hue_components = "auto"
        else:
            hue_components = tuple(int(x) for x in args.hue_components.split(","))
            if len(hue_components) != 2:
                parser.error("--hue-components must be 'auto' or exactly 2 numbers, e.g. '2,3'")
        exclude_components = tuple(int(x) for x in args.exclude_components.split(","))
        result = recommend(
            wide,
            reference_item=args.item,
            scheme=args.scheme,
            n_components=args.n_components,
            top_k=args.top_k,
            standardize=not args.no_standardize,
            hue_components=hue_components,
            exclude_components=exclude_components,
            candidate_components=args.candidate_components,
            shortlist_size=args.shortlist_size,
        )
        print(result.to_string(index=False))
        if args.out:
            result.to_csv(args.out, index=False)
            print(f"\nSaved to {args.out}")


if __name__ == "__main__":
    main()
