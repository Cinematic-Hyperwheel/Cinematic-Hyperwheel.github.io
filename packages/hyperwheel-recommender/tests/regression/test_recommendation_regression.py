"""
Regression tests: for every hand-curated (reference, expected
recommendation) pair in data/recommendation_pairs.csv, checks that the
expected item still shows up among the recommendations for that
reference - in any configured circle (plane), and in the pair's own
scheme if given, else in any scheme from `default_schemes`.

Rank and plane are never pinned down: those are implementation details
that can legitimately shift between releases as long as a pairing the
maintainer has vetted by hand keeps surfacing somewhere on the wheel.
Add new pairs to the CSV as they're reviewed; see README.md in this
folder.
"""

from __future__ import annotations

from ._shared import collect_recommended_items


def test_expected_recommendation_present(golden_pair, basis, circles, default_schemes, top_k, shortlist_size):
    reference = golden_pair["reference_item"]
    expected = golden_pair["expected_recommendation"]
    schemes = [golden_pair["scheme"]] if golden_pair["scheme"] else default_schemes

    locations = collect_recommended_items(
        basis, reference, circles, schemes, top_k, shortlist_size,
    )

    if expected not in locations:
        found = ", ".join(sorted(locations)) or "(nothing recommended at all)"
        raise AssertionError(
            f"'{expected}' is no longer recommended for reference "
            f"'{reference}' in any of {len(circles)} circle(s) x "
            f"{len(schemes)} scheme(s) ({schemes}). Items actually "
            f"recommended: {found}"
        )