from __future__ import annotations

import math
import random
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from fastapi import Depends, Header
from pydantic import BaseModel, Field
from . import pow as pow_gate

from .config import ENABLE_API_DOCS, METADATA_PATH
from .search import MovieIndex, load_metadata
from .tmdb import fetch_backdrop_url, fetch_poster_url
from hyperwheel_recommender import SCHEMES, find_neighbors
from hyperwheel_recommender.recommend import ANGLE_TOL_RAD, RADIUS_TOL_LOG

from .wheel import build_engine

app = FastAPI(
    title="Cinematic Hyperwheel API",
    # Swagger/ReDoc/raw schema are opt-in only (see config.py) - this
    # isn't a public API product, and the supported surface is already
    # documented in apps/web/README.md.
    docs_url="/docs" if ENABLE_API_DOCS else None,
    redoc_url="/redoc" if ENABLE_API_DOCS else None,
    openapi_url="/openapi.json" if ENABLE_API_DOCS else None,
)

# Only relevant for local dev (Vite dev server on a different port). In
# production the frontend is served by this same app on the same origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Every current endpoint expects either no body or a small JSON object
# (in practice just POST /api/pow/solve, which - unlike every other
# endpoint - is deliberately reachable WITHOUT a proof-of-work ticket,
# since it's what issues one). Reject an oversized body up front, before
# it's read into memory, rather than relying solely on per-field
# validation (which only runs after the body has already been buffered
# and JSON-parsed).
_MAX_REQUEST_BODY_BYTES = 8 * 1024


@app.middleware("http")
async def _limit_request_body_size(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            oversized = int(content_length) > _MAX_REQUEST_BODY_BYTES
        except ValueError:
            oversized = True  # malformed header - fail closed
        if oversized:
            return JSONResponse(status_code=413, content={"detail": "Request body too large"})
    return await call_next(request)

_records = load_metadata(METADATA_PATH)
_records_by_id = {r.item_id: r for r in _records}
_index = MovieIndex(_records)
_engine = build_engine()
_titles = {r.item_id: r.title for r in _records}

class PowSolveRequest(BaseModel):
    # Bounds are generous relative to the real shapes produced by pow.py
    # (challenge is "scope:ts:salt:signature" - well under 128 chars;
    # nonce is a short hex/decimal string the client found by brute
    # force) - just enough to stop a client from forcing a large
    # string into hashlib.sha256() on this endpoint, which is reachable
    # without a proof-of-work ticket by design.
    challenge: str = Field(..., max_length=256)
    nonce: str = Field(..., max_length=128)

@app.get("/api/pow/challenge")
def pow_challenge(scope: str = Query(...)):
    try:
        return pow_gate.issue_challenge(scope)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/pow/solve")
def pow_solve(body: PowSolveRequest):
    result = pow_gate.redeem_challenge(body.challenge, body.nonce)
    if result is None:
        raise HTTPException(status_code=400, detail="Invalid, expired, or already-used proof")
    return result


def require_pow(scope: str):
    """FastAPI dependency factory: rejects the request unless it carries a
    ticket (see pow.py) with at least one remaining use in `scope`."""
    def _dependency(x_pow_ticket: str | None = Header(default=None, alias="X-Pow-Ticket")):
        if not pow_gate.consume_ticket(x_pow_ticket, scope):
            raise HTTPException(
                status_code=429,
                detail="Proof-of-work required: fetch /api/pow/challenge and solve it first",
            )
    return _dependency

_MAX_SEARCH_LIMIT = 25


@app.get("/api/search", dependencies=[Depends(require_pow("light"))])
def search(q: str = Query(..., min_length=1, max_length=200), limit: int = 8):
    return {"results": _index.search(q, limit=min(limit, _MAX_SEARCH_LIMIT))}

@app.get("/api/movie/random", dependencies=[Depends(require_pow("light"))])
def get_random_movie():
    item_id = random.choice(list(_records_by_id.keys()))
    record = _records_by_id.get(item_id)

    if record is None:
        raise HTTPException(status_code=404, detail="Item not found")
    
    return {
        "item_id": record.item_id,
        "title": record.title,
        "genres": record.genres,
        "imdb_id": record.imdb_id,
        "tmdb_id": record.tmdb_id,
    }


@app.get("/api/movie/{item_id}", dependencies=[Depends(require_pow("light"))])
def movie_metadata(item_id: int):
    """Basic metadata (title, genres, external ids) for one movie - used
    to resolve a reference item passed via URL (e.g. /567) or clicked
    from the Recommendations panel, where only an item_id is available.
    imdb_id/tmdb_id are None when movies.csv wasn't built with --links
    (see tools/filter_metadata_to_artifact.py) or this movie had no
    matching row in links.csv - the frontend falls back to a title
    search in that case (see utils/imdb.ts, utils/tmdb.ts)."""
    record = _records_by_id.get(item_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Item not found")
    return {
        "item_id": record.item_id,
        "title": record.title,
        "genres": record.genres,
        "imdb_id": record.imdb_id,
        "tmdb_id": record.tmdb_id,
    }


@app.get("/api/movie/{item_id}/backdrop", dependencies=[Depends(require_pow("light"))])
async def movie_backdrop(item_id: int):
    """Backdrop image URL for the hero background (see
    frontend/src/components/HeroBackdrop.tsx), resolved from TMDB via
    the movie's tmdb_id. backdrop_url is null - never a 404 for this
    specific reason - when the movie has no tmdb_id, TMDB isn't
    configured, or the lookup failed; a missing backdrop is not an
    error, the UI just shows none (see tmdb.py)."""
    record = _records_by_id.get(item_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Item not found")
    backdrop_url = await fetch_backdrop_url(record.tmdb_id) if record.tmdb_id else None
    return {"item_id": item_id, "backdrop_url": backdrop_url}


@app.get("/api/movie/{item_id}/poster", dependencies=[Depends(require_pow("light"))])
async def movie_poster(item_id: int):
    """Small poster image URL for the Recommendations panel's hover/tap
    info card (see frontend/src/components/RecommendationsPanel.tsx),
    resolved from TMDB via the movie's tmdb_id. Same graceful-
    degradation shape as /backdrop: poster_url is null - never a 404 for
    this specific reason - when the movie has no tmdb_id, TMDB isn't
    configured, or the lookup failed; the frontend just renders the card
    without an image in that case."""
    record = _records_by_id.get(item_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Item not found")
    poster_url = await fetch_poster_url(record.tmdb_id) if record.tmdb_id else None
    return {"item_id": item_id, "poster_url": poster_url}


@app.get("/api/movie/{item_id}/wheel", dependencies=[Depends(require_pow("light"))])
def wheel(item_id: int):
    try:
        circles = _engine.circles_for(item_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Item not found in the PCA basis")
    return {"item_id": item_id, "circles": circles}



@app.get("/api/movie/{item_id}/recommend", dependencies=[Depends(require_pow("heavy"))])
def recommend(item_id: int):
    """Scheme-independent neighbor pool for one reference movie.

    Returns the catalog items that share the reference's character along
    at least one PCA axis (find_neighbors, /docs/math.md section 7),
    ordered by descending similarity, with each item's whitened
    coordinates on every curated component. The client derives circles
    from these components, applies the scheme's angles and the angle/radius
    gate itself (frontend/src/utils/schemeGate.ts), so switching schemes
    needs no further request.

    `z` arrays (per item, and `reference`) are parallel to `pcs`; `axes`
    carries each component's colors/labels. `schemes` maps scheme name to
    its angles in degrees, and `gate` holds the tolerances Stage B applies
    (see recommend.py): the client mirrors that gate rather than
    redefining the constants.
    """
    ridx = _engine.id_to_idx.get(item_id)
    if ridx is None:
        raise HTTPException(status_code=404, detail="Item not found in the PCA basis")

    pcs = _engine.curated_components
    try:
        indices, similarities = find_neighbors(
            _engine.basis,
            reference_item=item_id,
            preserve_components=_engine.non_pc1_components,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    items = []
    for idx, sim, z in zip(indices, similarities, _engine.z_scores(indices, pcs)):
        iid = int(_engine.basis.items[idx])
        record = _records_by_id.get(iid)
        items.append({
            "item_id": iid,
            "title": _titles.get(iid, str(iid)),
            "genres": record.genres if record else [],
            "imdb_id": record.imdb_id if record else None,
            "tmdb_id": record.tmdb_id if record else None,
            "similarity": round(float(sim), 4),
            "z": z,
        })

    return {
        "item_id": item_id,
        "pcs": pcs,
        "axes": [_engine.axis_payload(pc) for pc in pcs],
        "reference": _engine.z_scores([ridx], pcs)[0],
        "schemes": SCHEMES,
        "gate": {
            "angle_tol_rad": float(ANGLE_TOL_RAD),
            "radius_tol_log": float(RADIUS_TOL_LOG),
        },
        "items": items,
    }


# Serve the built frontend (apps/web/frontend/dist) if present, so the
# whole app is a single Render web service on one origin.
_FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _FRONTEND_DIST.exists():
    # Client-side deep link: GET /<item_id> (e.g. /567) should load the
    # SPA, which then reads the id from window.location and selects that
    # movie as the reference (see App.tsx). This route only matches a
    # bare numeric path segment, so it never shadows /api/... routes or
    # hashed asset paths served by the StaticFiles mount below.
    @app.get("/{item_id:int}")
    def spa_item_route(item_id: int):
        return FileResponse(_FRONTEND_DIST / "index.html")
    
    app.mount("/", StaticFiles(directory=str(_FRONTEND_DIST), html=True), name="frontend")
