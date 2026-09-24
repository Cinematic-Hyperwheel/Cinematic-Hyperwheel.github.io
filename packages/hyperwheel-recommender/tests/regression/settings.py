"""
Configuration for the recommendation regression suite.

The dataset location reuses the exact same env vars
apps/web/backend/app/config.py already defines, so this suite tests
against the same artifact the web app actually serves. Everything else
here is a plain, hardcoded constant - not exposed as env vars, since
nothing outside this suite needs to tune them.
"""

from __future__ import annotations

import os
from pathlib import Path

# regression/ -> tests/ -> hyperwheel-recommender/ -> packages/ -> repo root
REPO_ROOT = Path(__file__).resolve().parents[4]

# Same env var names and defaults as apps/web/backend/app/config.py.
DATA_DIR = Path(os.environ.get("HYPERWHEEL_DATA_DIR", REPO_ROOT / "data" / "ml-latest"))
ARTIFACT_PATH = Path(os.environ.get("HYPERWHEEL_ARTIFACT_PATH", DATA_DIR / "artifact.npz"))
N_COMPONENTS = int(os.environ.get("HYPERWHEEL_N_COMPONENTS", "20"))
STANDARDIZE = os.environ.get("HYPERWHEEL_NO_STANDARDIZE", "") == ""
PC_CONFIG_PATH = Path(os.environ.get(
    "HYPERWHEEL_PC_CONFIG_PATH",
    REPO_ROOT / "apps" / "web" / "backend" / "app" / "pc_config.json",
))

# Test-only constants below - not env-configurable.
TOP_K = 6 # see apps\web\backend\app\main.py def recommend
SHORTLIST_SIZE = 20_000 # see apps\web\backend\app\main.py def recommend
STARFIELD_MAX_SIZE = 1000
GOLDEN_FILE = Path(__file__).parent / "data" / "recommendation_pairs.csv"