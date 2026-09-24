"""
Central config for the web backend. All paths are overridable via env
vars (needed on Render, where the working directory differs from local
dev), with sensible defaults matching the layout described by the repo
owner: everything under /data/ml-latest at the repo root.
"""
from __future__ import annotations

import os
from pathlib import Path
from dotenv import load_dotenv

# apps/web/backend/app/config.py -> repo root is 4 levels up
REPO_ROOT = Path(__file__).resolve().parents[4]

# Repo root .env - shared with the frontend (see vite.config.ts's
# envDir) and with Docker Compose (see docker-compose.yml), so there's
# one canonical .env location for the whole project instead of each
# tool defaulting to a different directory. No-op if the file doesn't
# exist, which is the normal case on Render/in Docker, where env vars
# are set directly by the platform/compose instead.
load_dotenv(REPO_ROOT / ".env")

def _env_path(name: str, default: Path) -> Path:
    """Path from an env var. Relative values are anchored at the repo
    root rather than the process CWD (which differs between a local
    uvicorn launch, Docker and Render); unset or empty falls back to
    `default`."""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    path = Path(raw).expanduser()
    return path if path.is_absolute() else REPO_ROOT / path

DATA_DIR = _env_path("HYPERWHEEL_DATA_DIR", REPO_ROOT / "data" / "ml-latest")
# movies.csv (movieId,title,genres) - the ml-latest catalog file, expected
# to already be filtered down to movies with Tag Genome data (see
# tools/filter_metadata_to_artifact.py); METADATA_PATH is kept as the env
# var / constant name for backward compatibility with existing deploys.
METADATA_PATH = _env_path("HYPERWHEEL_METADATA_PATH", DATA_DIR / "movies.csv")
ARTIFACT_PATH = _env_path("HYPERWHEEL_ARTIFACT_PATH", DATA_DIR / "artifact.npz")

N_COMPONENTS = int(os.environ.get("HYPERWHEEL_N_COMPONENTS", "20"))
STANDARDIZE = os.environ.get("HYPERWHEEL_NO_STANDARDIZE", "") == ""

# Human-curated per-component labels/colors (see pc_config.py) - lives
# next to the app code, not under DATA_DIR, since it's authored content
# rather than raw/derived data.
PC_CONFIG_PATH = _env_path(
    "HYPERWHEEL_PC_CONFIG_PATH", Path(__file__).resolve().parent / "pc_config.json"
)

# TMDB (The Movie Database) API - currently used only to resolve a
# movie's backdrop image for the hero background (see tmdb.py and
# /api/movie/{item_id}/backdrop in main.py). Get a free v3 API key at
# https://www.themoviedb.org/settings/api. Entirely optional: without
# it, the backdrop feature just degrades to "no backdrop" (see
# tmdb.py's fetch_backdrop_url) - same graceful-degradation pattern as
# the missing imdb_id/tmdb_id case in search.py.
TMDB_API_KEY = os.environ.get("TMDB_API_KEY")
# w1280 balances quality against payload size for a full-bleed page
# background; TMDB also offers w780/w1920/original if this needs tuning.
TMDB_BACKDROP_SIZE = os.environ.get("TMDB_BACKDROP_SIZE", "w1280")
# w185 is a small poster suited to the Recommendations panel's hover/tap
# info card (see RecommendationsPanel.tsx) - large enough to read on a
# phone screen, small enough to load instantly on hover. TMDB also
# offers w92/w154/w342/w500/w780/original if this needs tuning.
TMDB_POSTER_SIZE = os.environ.get("TMDB_POSTER_SIZE", "w185")

# Interactive API docs (Swagger UI at /docs, ReDoc at /redoc, raw schema
# at /openapi.json). Off by default: this isn't a public API product -
# the supported surface is documented in apps/web/README.md - so there's
# no reason to expose the schema/try-it-out UI to the internet. Set to
# "true"/"1"/"yes" to turn it on for local development; unset, empty, or
# any other value (including "false") keeps it off.
ENABLE_API_DOCS = os.environ.get("HYPERWHEEL_ENABLE_API_DOCS", "").strip().lower() in ("1", "true", "yes", "on")