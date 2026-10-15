"""
Human-curated interpretation of individual PCA components.

Produced once, by hand, by running `diagnose` and reading each
component's criteria weights + the real items at each pole (docs/math.md
section 4), then deciding what the axis represents and how to label/color
it for the wheel UI, in every supported language.

Only components with an entry here are eligible to be shown as a circle.
This does double duty:
  - it bounds candidate_components for hue-plane selection - no risk of
    landing on an unreviewed, possibly-noise tail component
    (docs/math.md section 6a);
  - it guarantees every circle we render has a reviewed label/color for
    both poles, in every language the UI supports.

Component indices refer to the basis AFTER the optional varimax rotation
of the groups listed under "rotation_groups" (see wheel.py,
docs/math.md section 3.6): inside a rotated group the axes are no longer
eigenvectors and are ordered by the variance they carry. Labels are only
valid for the exact rotation recorded in the same file, so both live
together; changing the groups (or anything else that changes the axes)
requires re-reviewing every affected entry.

Expected shape (see pc_config.json for a filled example):
{
  "rotation_groups": [[<first 1-based PC>, <last 1-based PC>], ...],  # optional
  "<1-based PC index as string>": {
    "excluded_from_hue": bool,       # e.g. true for a known "quality" axis
    "colors": {"negative": "#hex", "positive": "#hex"},
    "labels": {
      "<lang code>": {"axis": str, "negative": str, "positive": str},
      ...
    }
  },
  ...
}
"""
from __future__ import annotations

import json

from .config import N_COMPONENTS, PC_CONFIG_PATH

ROTATION_KEY = "rotation_groups"


def _load_raw() -> dict:
    with open(PC_CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def load_pc_config() -> dict[int, dict]:
    return {int(k): v for k, v in _load_raw().items() if k != ROTATION_KEY}


def load_rotation_groups() -> list[tuple[int, int]]:
    """Disjoint (FROM, TO) component groups (1-based, inclusive) to
    varimax-rotate; empty when the config defines none."""
    return [(int(lo), int(hi)) for lo, hi in _load_raw().get(ROTATION_KEY, [])]


def required_components(pc_config: dict[int, dict], rotation_groups: list[tuple[int, int]]) -> int:
    """Number of components the basis must be built with: enough for the
    configured default, every curated entry and every rotated group. Also
    the --n-components the PCA cache has to be built with."""
    return max(N_COMPONENTS, max(pc_config), *(hi for _, hi in rotation_groups))