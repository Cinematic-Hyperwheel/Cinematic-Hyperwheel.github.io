"""
Loads the set of hue-plane pairs ('circles') that the recommendation
regression suite checks - the same PC-component pairs a reference item's
wheel actually shows, so "the expected item is recommended" matches what
a user would see.

Read from the web app's own pc_config.json (settings.PC_CONFIG_PATH).
That file describes each PC axis individually - 1-based component index
-> {excluded_from_hue, colors, labels, ...}. Circles are every unordered
pair of components NOT marked excluded_from_hue (e.g. PC1, the
quality/halo axis, is never part of a circle - see docs/math.md,
section 4).
"""

from __future__ import annotations

import itertools
import json

from . import settings


def _included_components(data: dict) -> list[int]:
    """1-based component indices present in pc_config.json that are NOT
    marked excluded_from_hue (e.g. the quality/halo axis, PC1), in
    ascending order."""
    included = []
    for key, entry in data.items():
        try:
            component = int(key)
        except (TypeError, ValueError):
            continue
        if isinstance(entry, dict) and entry.get("excluded_from_hue"):
            continue
        included.append(component)
    return sorted(included)


def load_circles(max_component: int | None = None) -> list[tuple[int, int]]:
    """Returns the 1-based (i, j) plane pairs to check - every unordered
    pair of non-excluded components from pc_config.json.

    max_component, if given, filters out any pair that needs more
    components than the basis actually has (guards against a stale
    circles config after N_COMPONENTS is lowered for these tests).
    """
    config_path = settings.PC_CONFIG_PATH
    if not config_path.exists():
        raise FileNotFoundError(
            f"No circles config found at {config_path}. Set "
            f"HYPERWHEEL_PC_CONFIG_PATH to the app's pc_config.json."
        )
    data = json.loads(config_path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(
            f"{config_path} is not a JSON object keyed by component "
            f"index - unexpected pc_config.json shape."
        )
    components = _included_components(data)
    pairs = list(itertools.combinations(components, 2))
    if not pairs:
        raise ValueError(
            f"Fewer than 2 non-excluded components found in {config_path} - "
            f"no circles to form."
        )

    if max_component is not None:
        pairs = [p for p in pairs if max(p) <= max_component]
    if not pairs:
        raise ValueError("No usable circle definitions after filtering by max_component.")

    return pairs