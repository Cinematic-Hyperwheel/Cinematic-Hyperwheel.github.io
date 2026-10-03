"""
Regression test: for every hand-curated (reference item, expected
recommendation) pair in data/recommendation_pairs.csv, checks that the
second item still shows up in the reference's plane starfield - a
character match to the reference along at least one basis axis, with
every other axis suppressed (see /docs/math.md section 7).

The pairs file's `scheme` column is ignored: the starfield has no notion
of a scheme.
"""

from __future__ import annotations

from ._shared import collect_starfield_items


def test_expected_recommendation_present_in_starfield(golden_pair, basis, circles, preserve_components):
    reference = golden_pair["reference_item"]
    expected = golden_pair["expected_recommendation"]

    starfield = collect_starfield_items(basis, reference, circles, preserve_components)

    if expected not in starfield:
        raise AssertionError(
            f"'{expected}' is no longer in the plane starfield for reference "
            f"'{reference}' ({len(starfield)} item(s) currently in the starfield)."
        )