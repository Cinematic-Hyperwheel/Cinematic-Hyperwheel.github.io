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
from hyperwheel_recommender import SCHEMES, recommend_many_planes, find_plane_neighbors

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


def _combined_order(circles_out: list[dict], z_weight: float = 0.3) -> list[dict]:
    """
    Reorders circles_out (already built, one entry per axis pair, each
    carrying its own `angles`) by a normalized weighted combination of two
    signals, each rescaled to [0, 1] so they're actually comparable:

    z_score (per circle): 1.0 for the circle /wheel ranked highest by
        aggregate z-score, 0.0 for the one it ranked lowest, linear in
        between. circles_out arrives already sorted by /wheel's
        z-score-descending order (see wheel.py, circles_for), so the
        incoming index directly gives this rank - no need to recompute it
        from a raw z-score field.
    count_score (per circle): total recommendations actually found across
        all scheme angles (sum of len(angle["items"])) for that circle,
        divided by the highest such count among the circles in THIS
        response. 1.0 = most recommendations found among these circles,
        0.0 = none. Circles starved by Stage B's angle/radius gates
        (recommend.py) score low here even when their z-score is high,
        and vice versa.

    combined = z_weight * z_score + (1 - z_weight) * count_score

    z_weight=0.3 was chosen by testing directly against the target
    behavior ("a circle with meaningfully more recommendations should
    overtake the current #1 by z-score") rather than assumed: with
    z_weight >= 0.35 a circle at z-rank 0 with only half the top
    recommendation count of another circle still won, which is the
    opposite of the intended behavior; 0.3 is the largest weight (in
    steps of 0.05) where it does not. See
    packages/hyperwheel-recommender tests / the accompanying analysis for
    the exact scenario this was checked against. An earlier version of
    this function used Reciprocal Rank Fusion (rank-based, not value-based)
    - it was discarded because at realistic circle counts (2-36, see
    apps/web/README.md "C(n,2) circles") RRF's harmonic rank decay barely
    separates adjacent ranks, so the z-rank-0 circle kept winning
    regardless of how few recommendations it had; this was only caught by
    actually re-running the scenario from the spec, not by inspection.

    Circles with zero recommendations are always placed after every
    circle with at least one, as a hard partition on top of the combined
    score - an empty circle is useless to show as primary or as a
    secondary overlay target no matter how "expressive" the reference
    item is on its axes, and a soft score alone doesn't guarantee that
    (a very high z-score, 0-item circle could otherwise still outscore a
    low-z, 1-item circle).

    The first element of the returned list becomes the new `primary` -
    primary is not a separately computed property; it is BY DEFINITION
    whichever circle ends up ranked first after this reorder. Every
    circle's `primary` field is rewritten accordingly.
    """
    n = len(circles_out)
    if n <= 1:
        for c in circles_out:
            c["primary"] = True
        return circles_out

    max_total = 0
    for rank_z, c in enumerate(circles_out):
        c["_rank_z"] = rank_z
        c["_total_items"] = sum(len(a["items"]) for a in c["angles"])
        max_total = max(max_total, c["_total_items"])
    max_total = max(1, max_total)  # guard: all-zero circles -> avoid /0, all get count_score 0

    for c in circles_out:
        z_score = 1.0 - c["_rank_z"] / (n - 1)
        count_score = c["_total_items"] / max_total
        c["_combined"] = z_weight * z_score + (1 - z_weight) * count_score

    ordered = sorted(
        circles_out,
        key=lambda c: (c["_total_items"] > 0, c["_combined"]),
        reverse=True,
    )

    for c in ordered:
        del c["_rank_z"]
        del c["_total_items"]
        del c["_combined"]

    for i, c in enumerate(ordered):
        c["primary"] = i == 0

    return ordered


@app.get("/api/movie/{item_id}/recommend", dependencies=[Depends(require_pow("heavy"))])
def recommend(item_id: int, scheme: str = Query("complementary")):
    """Color-wheel recommendations, computed INDEPENDENTLY per circle.

    Each circle gets its own recommend_on_basis() call using its own
    plane - Stage A (character shortlist) and Stage B (angle+radius
    re-rank) are both run fresh for each circle's own axes, rather than
    projecting one main-circle result onto the other planes. Because PCA
    components are orthogonal, a good rotation on PC2/PC3 says nothing
    about position on PC5/PC6 - projecting a single result was giving
    secondary circles scattered, unoptimized points. This means each
    circle's top-k items are generally a DIFFERENT set of movies, not the
    same 5 movies viewed from different axes.

    Each returned item also carries imdb_id/tmdb_id (same source as
    /api/movie/{item_id} - see MovieRecord in search.py), so the frontend
    can link straight to IMDb/TMDB instead of a title search wherever the
    dataset has a match.

    Final ordering (and therefore which circle is `primary`) is NOT the
    same as /wheel's plain z-score order: after every circle's own
    recommendations are computed, _combined_order() blends that z-score
    order with how many recommendations each circle actually turned up
    for this scheme (see its docstring) - a circle with a high z-score
    but a nearly-empty result set (common with narrow ANGLE_TOL_RAD /
    RADIUS_TOL_LOG gates, see recommend.py) is demoted below a circle
    that is less "expressive" structurally but produced a full, usable
    set of recommendations for this specific scheme.

    Each circle also carries `starfield`: every catalog item that
    matches the reference across every TAG/criterion not already
    accounted for by that circle's own PCA axis pair (see
    find_plane_neighbors, /docs/math.md section 7 - this is a tag-space
    comparison, not a comparison against the other PCA components),
    excluding items already listed above as scheme recommendations.
    Unlike the scheme clusters, these aren't gated by angle/radius at
    all - they scatter across the whole disc and are meant to be
    rendered as small background points rather than the scheme's own
    overlay dots.
    """
    if scheme not in SCHEMES:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown scheme '{scheme}'. Available: {sorted(SCHEMES)}",
        )
    try:
        wheel_circles = _engine.circles_for(item_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Item not found in the PCA basis")

    ridx = _engine.id_to_idx.get(item_id)

    def z(idx: int, pc: int) -> float:
        return float(_engine.scores[idx, pc - 1] / _engine.pc_std[pc - 1])

    planes = [(wc["axis_x"]["pc"], wc["axis_y"]["pc"]) for wc in wheel_circles]

    try:
        results = recommend_many_planes(
            _engine.basis,
            reference_item=item_id,
            scheme=scheme,
            planes=planes,
            top_k=6,
            shortlist_size=20000,   # safety cap on Stage A's near-outlier
                                    # shortlist (docs/math.md section 6b) -
                                    # not an exact pool size to fill
                                    # 800 is ~5% of all
                                    # 20000 is deliberately larger that the dataset size
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # Every catalog item that shares the reference's position on every
    # PCA component OUTSIDE each circle's own axis pair (see
    # find_plane_neighbors, /docs/math.md section 7) - a scheme-
    # independent field of "similar everywhere else" movies, shown as
    # small background points scattered across that circle's disc
    # rather than clustered at the scheme's target angles.
    try:
        neighbor_indices = find_plane_neighbors(_engine.basis, reference_item=item_id, planes=planes)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    circles_out = []

    for wc in wheel_circles:
        pc_x, pc_y = wc["axis_x"]["pc"], wc["axis_y"]["pc"]
        df = results[(pc_x, pc_y)]

        angles = []
        for angle_deg in SCHEMES[scheme]:
            rows = df[df["angle_deg"] == angle_deg].sort_values("rank")
            items = []
            for r in rows.to_dict("records"):
                iid = int(r["item"])
                idx = _engine.id_to_idx.get(iid)
                if idx is None:
                    continue
                zx, zy = z(idx, pc_x), z(idx, pc_y)
                record = _records_by_id.get(iid)
                items.append({
                    "item_id": iid,
                    "title": _titles.get(iid, str(iid)),
                    "genres": record.genres if record else [],
                    "imdb_id": record.imdb_id if record else None,
                    "tmdb_id": record.tmdb_id if record else None,
                    "rank": r["rank"],
                    "distance_to_target": r["distance_to_target"],
                    "angular_error_deg": r.get("angular_error_deg"),
                    "radius_ratio": r.get("radius_ratio"),
                    "z_x": round(zx, 4),
                    "z_y": round(zy, 4),
                    "angle_deg": round((math.degrees(math.atan2(zy, zx)) % 360), 2),
                })
            angles.append({"angle_deg": angle_deg, "items": items})

        used_ids = {item["item_id"] for a in angles for item in a["items"]}
        starfield = []
        for idx in neighbor_indices[(pc_x, pc_y)]:
            iid = int(_engine.basis.items[idx])
            if iid == item_id or iid in used_ids:
                continue
            record = _records_by_id.get(iid)
            zx, zy = z(idx, pc_x), z(idx, pc_y)
            starfield.append({
                "item_id": iid,
                "title": _titles.get(iid, str(iid)),
                "genres": record.genres if record else [],
                "imdb_id": record.imdb_id if record else None,
                "tmdb_id": record.tmdb_id if record else None,
                "z_x": round(zx, 4),
                "z_y": round(zy, 4),
                "angle_deg": round((math.degrees(math.atan2(zy, zx)) % 360), 2),
            })

        reference = None
        if ridx is not None:
            zx, zy = z(ridx, pc_x), z(ridx, pc_y)
            reference = {
                "z_x": round(zx, 4),
                "z_y": round(zy, 4),
                "angle_deg": round((math.degrees(math.atan2(zy, zx)) % 360), 2),
                "radius": round(float(math.hypot(zx, zy)), 4),
            }

        circles_out.append({
            "primary": wc["primary"],
            "axis_x": wc["axis_x"],
            "axis_y": wc["axis_y"],
            "reference": reference,
            "angles": angles,
            "starfield": starfield,
        })

    circles_out = _combined_order(circles_out)

    return {"item_id": item_id, "scheme": scheme, "circles": circles_out}


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
