"""
Hyperwheel Recommender — item recommender based on generalized color-wheel schemes.

Idea: each item is described by values across many criteria (with no
inherent "better/worse" direction — like the R,G,B channels of a color).
For an item, we compute:
  L (lightness) - its own average intensity across criteria;
  hue vector     - the direction of its "taste profile" in a low-dimensional
                    plane that PCA discovers from the whole item catalog
                    (rather than from an arbitrary criteria ordering);
  S (saturation) - how pronounced that profile is (norm of the deviation
                    from the category's typical profile).

Full mathematical rationale: /docs/math.md

Library usage:
    from hyperwheel_recommender import load_matrix, build_taste_basis, recommend, diagnose

CLI usage:
    python -m hyperwheel_recommender build data.csv --out artifact.npz
    python -m hyperwheel_recommender diagnose artifact.npz
    python -m hyperwheel_recommender recommend artifact.npz --item "..." --scheme complementary
"""

from .basis import TasteBasis, build_taste_basis
from .data import load_artifact, load_input, load_matrix, save_artifact
from .diagnose import diagnose
from .planes import select_hue_plane
from .recommend import recommend, recommend_on_basis, recommend_many_planes
from .rotation import SCHEMES, rotate_whitened
from .starfield import find_plane_neighbors

__all__ = [
    "load_matrix",
    "load_artifact",
    "load_input",
    "save_artifact",
    "TasteBasis",
    "build_taste_basis",
    "SCHEMES",
    "rotate_whitened",
    "select_hue_plane",
    "recommend",
    "recommend_on_basis",
    "recommend_many_planes",
    "find_plane_neighbors",
    "diagnose",
]
