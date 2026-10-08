"""
The PCA basis and the set of "circles" (axis-pair visualizations) shown
for a given reference movie.

Circle selection
-----------------
Only PCA components with a human-curated entry in pc_config.json are
eligible to appear (see pc_config.py) - this bounds the tail-noise
problem (docs/math.md section 6a) by construction, and guarantees every
shown axis has a reviewed label/color for both poles, in every language.

Among those eligible components (excluding any flagged
excluded_from_hue, e.g. PC1 - a general "quality" axis, docs/math.md
section 4), EVERY possible axis pair (combination) is generated, and the
circles are ranked by descending radius in the whitened
plane, hypot(z_a, z_b). The top-ranked pair (the axes on which this
item is most expressive overall) becomes the MAIN circle; the rest follow in order of decreasing aggregate.

Unlike the old consecutive-pairing rule (ranked list split into
neighbouring pairs, ~n/2 circles, each axis used once), generating all
combinations makes every meaningful plane available - so a user can
pivot the main wheel onto any axis - at the cost of producing C(n,2)
circles instead of roughly n/2 (e.g. 9 curated axes -> 36 circles).
Ties are broken by stable sort over the ascending-pc combination order.
"""
from __future__ import annotations

import itertools
import math
import sys
from dataclasses import dataclass

import numpy as np

from hyperwheel_recommender import TasteBasis, build_taste_basis, load_input, load_pca_cache

from .config import ARTIFACT_PATH, N_COMPONENTS, PCA_CACHE_PATH, STANDARDIZE
from .pc_config import load_pc_config



@dataclass
class WheelEngine:
    id_to_idx: dict[int, int]
    scores: np.ndarray       # (n_items, n_components)
    pc_std: np.ndarray
    explained: np.ndarray
    pc_config: dict[int, dict]
    basis: TasteBasis        # prebuilt basis, reused by the recommend endpoint
    X: np.ndarray            # (n_items, n_criteria) raw criteria matrix

    def starfield_pairs(self) -> list[tuple[int, int]]:
        """Hue planes the reference gets circles for: every pair of
        curated axes. A neighbor may be pronounced on an axis where the
        reference is weak, so planes are not limited to the reference's
        own strong axes."""
        return list(itertools.combinations(self.curated_components, 2))

    def axis_payload(self, pc: int) -> dict:
        cfg = self.pc_config[pc]
        return {
            "pc": pc,
            "colors": cfg["colors"],
            "labels": cfg["labels"],
            "explained": round(float(self.explained[pc - 1]), 4),
        }

    def z_scores(self, indices, pcs: list[int]) -> list[list[float]]:
        """Whitened scores (score / pc_std) for the given item indices: one
        row per item, columns in `pcs` order (1-based component indices)."""
        cols = np.asarray(pcs, dtype=int) - 1
        rows = np.asarray(indices, dtype=int)
        z = self.scores[np.ix_(rows, cols)].astype(np.float64) / self.pc_std[cols]
        return np.round(z, 4).tolist()

    @property
    def curated_components(self) -> list[int]:
        """1-based PCA component indices with a pc_config.json entry
        that isn't excluded_from_hue - the axes eligible to form a
        circle (see circles_for)."""
        return sorted(
            pc for pc, cfg in self.pc_config.items()
            if not cfg.get("excluded_from_hue", False)
        )

    def circles_for(self, item_id: int) -> list[dict]:
        idx = self.id_to_idx.get(item_id)
        if idx is None:
            raise KeyError(item_id)

        candidates = self.curated_components
        if len(candidates) < 2:
            raise ValueError(
                "pc_config needs at least 2 non-excluded components to form a circle "
                f"(currently {len(candidates)}: {candidates})"
            )

        z = {pc: float(self.scores[idx, pc - 1] / self.pc_std[pc - 1]) for pc in candidates}

        # Every possible axis pair (combination), ranked by the item's
        # radius in the whitened plane. Sorting is stable, so equal radii keep
        # the ascending-pc insertion order of itertools.combinations over
        # `candidates` - deterministic ties.
        pairs = []
        for a, b in itertools.combinations(candidates, 2):
            pairs.append((math.hypot(z[a], z[b]), a, b))
        pairs.sort(key=lambda t: -t[0])

        circles = []
        for rank, (_, a, b) in enumerate(pairs):
            pc_x, pc_y = sorted((a, b))
            z_x, z_y = z[pc_x], z[pc_y]
            angle = math.degrees(math.atan2(z_y, z_x)) % 360
            radius = math.hypot(z_x, z_y)
            circles.append({
                "primary": rank == 0,
                "axis_x": self.axis_payload(pc_x),
                "axis_y": self.axis_payload(pc_y),
                "z_x": round(z_x, 4),
                "z_y": round(z_y, 4),
                "angle_deg": round(angle, 2),
                "radius": round(radius, 4),
            })
        return circles


def build_engine() -> WheelEngine:
    pc_config = load_pc_config()
    n_needed = max(N_COMPONENTS, max(pc_config))
    wide = load_input(str(ARTIFACT_PATH))
    # Skips the O(n_criteria^3) eigh call when a build-time cache exists
    # and matches this exact artifact/n_needed/STANDARDIZE combination
    # (see tools/build_basis_cache.py) - falls back to computing it here
    # on a cache miss (e.g. local dev without a baked cache).
    precomputed_pca = load_pca_cache(str(PCA_CACHE_PATH), wide, n_needed, STANDARDIZE)
    if precomputed_pca is not None:
        print(f"[info] PCA cache hit: {PCA_CACHE_PATH}", file=sys.stderr)
    else:
        # A present-but-rejected file means it was built for a different
        # artifact, n_components or standardize flag, or before a PCA code change.
        reason = "fingerprint mismatch" if PCA_CACHE_PATH.exists() else "file not found"
        print(
            f"[info] PCA cache miss ({reason}: {PCA_CACHE_PATH}) - computing the basis "
            f"fresh (n_components={n_needed}, standardize={STANDARDIZE}).",
            file=sys.stderr,
        )
    basis = build_taste_basis(
        wide, n_components=n_needed, standardize=STANDARDIZE, precomputed_pca=precomputed_pca,
    )

    # wide.index items are the raw "item" values from the CSV (see
    # data.py) - in this dataset that's the numeric MovieLens item_id,
    # stored as strings; cast back to int to match metadata.jsonl.
    id_to_idx = {int(item): i for i, item in enumerate(basis.items)}

    return WheelEngine(
        id_to_idx=id_to_idx,
        scores=basis.scores,
        pc_std=basis.pc_std,
        explained=basis.explained,
        pc_config=pc_config,
        basis=basis,
        X=wide.to_numpy(dtype=np.float32),
    )
