# Cinematic Hyperwheel — web UI (stage 1)

Reference deployment: **One More Like This, Please** ([omltp.com](https://omltp.com)).

Reference-movie search (literal, title-only) plus a visualization of the
movie as one or more points on PCA-component planes ("circles"), each
labeled by a human-curated config.

## Data

MovieLens Latest Dataset (`ml-latest`, full) - see the root
[readme.md](../../readme.md#data) for the dataset link, required
citations, and the GroupLens Usage License terms (acknowledgement,
no-commercial-use-without-permission, etc.) that apply to anyone
standing up their own instance.

Expected under `/data/ml-latest/` by default (overridable via env vars):

- `movies.csv` (`movieId,title,genres`, as downloaded) - **must be
  filtered down first** to only the movies that have Tag Genome data,
  via `tools/filter_metadata_to_artifact.py` (see below); pointing
  `HYPERWHEEL_METADATA_PATH` at the raw, unfiltered `movies.csv` works
  but wastes search time on ~86k movies where the ~13k with genome data
  would do, and surfaces movies that will 404 on `/wheel`. Optionally
  also carries `imdbId`/`tmdbId` columns (see "External ids" below) if
  the filtering step was run with `--links`.
- `artifact.npz` — pre-built once, by hand, via the engine's CLI:

  ```bash
  python -m hyperwheel_recommender build data/ml-latest/genome-scores.csv \
    --tags-path data/ml-latest/genome-tags.csv \
    --out data/ml-latest/artifact.npz
  ```

  then filter the catalog against it:

  ```bash
  python tools/filter_metadata_to_artifact.py \
    --movies data/ml-latest/movies.original.csv \
    --artifact data/ml-latest/artifact.npz \
    --out data/ml-latest/movies.csv

  export HYPERWHEEL_METADATA_PATH=data/ml-latest/movies.csv
  ```

Paths are overridable via `HYPERWHEEL_DATA_DIR`, `HYPERWHEEL_METADATA_PATH`,
`HYPERWHEEL_ARTIFACT_PATH`, `HYPERWHEEL_PCA_CACHE_PATH` (see below).

### Optional: precomputed PCA cache

Building the PCA basis from `artifact.npz` includes the eigendecomposition
of the feature-space Gram matrix (docs/math.md, section 3), O(n_features^3)
that the backend
otherwise runs fresh on every process start. For a catalog with a
sizeable number of criteria (thousands of tags), or when the host's CPU
is throttled (e.g. a free-tier deployment - see `/docs/performance.md`),
this can dominate startup time.

`tools/build_basis_cache.py` precomputes this step once and saves the
result to a small `.npz` file, tagged with a fingerprint of the exact
code, dataset and PCA settings used - a mismatch (different artifact,
`--n-components`, a code change to the PCA algorithm or to the feature map)
is detected
automatically and falls back to computing the basis fresh, so a stale
cache is never silently trusted:

```bash
python tools/build_basis_cache.py \
  --artifact data/ml-latest/artifact.npz \
  --n-components 20 \
  --out data/ml-latest/pca_cache.npz
```

`--n-components` must match the value the backend actually builds the
basis with - `max(HYPERWHEEL_N_COMPONENTS, highest PC index in
pc_config.json)`, not just the raw `HYPERWHEEL_N_COMPONENTS` env var
(see `wheel.py`'s `build_engine()`).

Entirely optional: without it (or on a mismatch), the backend computes
the basis the same way it always did. Point `HYPERWHEEL_PCA_CACHE_PATH`
at the file if it isn't under `HYPERWHEEL_DATA_DIR` (the default).

For Docker Compose, since `HYPERWHEEL_DATA_HOST_PATH` is a host
directory mounted into the container, running the command above once
against that same host directory (before or after starting the
container) is enough - the cache persists across container restarts
just like the artifact itself.

### External ids (`imdbId`/`tmdbId`)

`tools/filter_metadata_to_artifact.py` optionally accepts `--links
data/ml-latest/links.csv` (`movieId,imdbId,tmdbId`, as downloaded) and
merges those two columns into the filtered `movies.csv` on `movieId`
(1:1 - see the script's docstring for why this is a merge rather than a
separate file). When present, the backend uses them to build direct
IMDb/TMDB links in the Recommendations panel instead of falling back to
a title search - see `imdb_id`/`tmdb_id` in the API section below and
`frontend/src/utils/imdb.ts` / `frontend/src/utils/tmdb.ts`. Entirely
optional: without `--links`, everything works exactly as before, just
without direct links (title search is used for both IMDb and TMDB).

## Local development
 
Optional: copy `/.env.example` to
`/.env` and set `TMDB_API_KEY` there to enable the hero
backdrop locally (see "Hero backdrop (TMDB)" below) - not required for
anything else to work.

```bash
# backend
pip install -e packages/hyperwheel-recommender
pip install -r apps/web/backend/requirements.txt
cd apps/web/backend && uvicorn app.main:app --reload --port 8000

# frontend (separate terminal)
cd apps/web/frontend
npm install
npm run dev   # http://localhost:5173, proxies /api to :8000
```

### Memory

The feature-space basis keeps the centered feature matrix in memory (items
x tags x `1 + N_HARMONICS` float32 values, roughly 300 MB for the full
catalog at 3 harmonics). Lower `N_HARMONICS` in
`packages/hyperwheel-recommender/src/hyperwheel_recommender/features.py`
to trade accuracy of the min-kernel expansion for memory; the PCA cache
fingerprint covers `features.py`, so a change requires rebuilding it.

## Hero backdrop (TMDB)

A full-bleed backdrop image behind the app, resolved per selected movie
via [TMDB](https://www.themoviedb.org/) and shown with a soft crossfade
(`frontend/src/components/HeroBackdrop.tsx`). Purely decorative -
without a TMDB key configured, the app works exactly the same, just
without the backdrop.

Requires a TMDB API key
([themoviedb.org/settings/api](https://www.themoviedb.org/settings/api)),
set via `TMDB_API_KEY` (see `.env.example` above). Optional:
`TMDB_BACKDROP_SIZE` (default `w1280`) - see TMDB's
[image basics](https://developer.themoviedb.org/docs/image-basics) for
available sizes.

Without a key, `GET /api/movie/{item_id}/backdrop` always returns
`{ "backdrop_url": null }` - not an error, the frontend just shows no
backdrop (see `apps/web/backend/app/tmdb.py`). Resolved URLs are cached
in-process per `tmdb_id`; failed lookups are not cached, so a fixed key
or a resolved outage takes effect on the next request without a
restart.

### Attribution

Per TMDB's API terms, this project displays the required notice ("This
product uses the TMDB API but is not endorsed or certified by TMDB.")
in the app's About modal, under Credits & data sources. See
[TMDB's attribution requirements](https://www.themoviedb.org/about/logos-attribution)
before extending this (e.g. adding the official logo, which has its own
usage rules).

## Production build / deploying to Render

A single free Web Service: FastAPI serves the built frontend static
files from the same origin (see `render.yaml` at the repo root). The
reference deployment is served at [omltp.com](https://omltp.com). Build:

```bash
pip install -r apps/web/backend/requirements.txt
pip install -e packages/hyperwheel-recommender
cd apps/web/frontend && npm install && npm run build
```

Start: `cd apps/web/backend && uvicorn app.main:app --host 0.0.0.0 --port $PORT`

Set `POW_SECRET` (see "Proof-of-work request gating" above) as an env var on
the deploy platform for a stable production deployment.

## Proof-of-work request gating

Every `/api/*` endpoint requires a proof-of-work ticket, obtained by solving
a short hashcash-style puzzle (`apps/web/backend/app/pow.py`): the server
issues a signed, short-lived challenge, the browser finds a nonce such that
`SHA-256(challenge:nonce)` has enough leading zero bits, and redeems it for a
ticket good for a batch of subsequent calls. The cost of finding a valid
nonce scales with the puzzle's difficulty and does not depend on IP address,
cookies, or any other client-supplied identity - unlike a per-IP request
counter, it can't be diluted by spreading requests across many addresses,
and it never needs a captcha, login, or any client-visible interaction:
solving runs in a Web Worker (`frontend/src/pow/worker.ts`) in the
background while the app stays fully responsive.

Two difficulty tiers (`SCOPES` in `pow.py`):

- `light` - cheap, frequently-called endpoints (search-as-you-type, wheel
  lookup, movie metadata, backdrop/poster, random pick).
- `heavy` - /recommend, the one endpoint that runs the per-axis starfield
  search over the full catalog (see
  packages/hyperwheel-recommender/docs/math.md section 7).

A solved ticket is sent back as the `X-Pow-Ticket` header
(`frontend/src/pow/powFetch.ts` attaches it automatically to every API
call); a request without a valid, non-exhausted ticket for the endpoint's
scope gets `429 Too Many Requests`. The client treats that as a signal to
mint (solve) a fresh ticket and retries once automatically - invisible to
the user under normal use.

`POW_SECRET` signs issued challenges - set it explicitly for any deployment
running more than one backend worker/process, or one that should keep
outstanding challenges valid across a restart; without it the app falls
back to a random per-process secret (see `.env.example`), which is fine for
local development but means a restart or a multi-worker deployment
invalidates/desyncs challenges issued right before it.

`POST /api/pow/solve` is necessarily reachable without a ticket (it's
what issues one), so it's additionally hardened on its own: every
request body over 8 KB is rejected before it's read, and the
`challenge`/`nonce` fields each have a fixed max length - both meant to
stop an oversized body from being hashed/buffered in memory on an
endpoint that isn't behind the proof-of-work gate itself.

## API

Interactive docs (Swagger UI at `/docs`, ReDoc at `/redoc`, the raw
schema at `/openapi.json`) are disabled by default, since this isn't a
public API product - the endpoints below are the documented surface.
Set `HYPERWHEEL_ENABLE_API_DOCS=true/1/yes/on` (see `.env.example`) to turn them on
for local development.

All endpoints below require a proof-of-work ticket (`X-Pow-Ticket` header) -
see "Proof-of-work request gating" above; the frontend's `api.ts` attaches
this automatically via `powFetch`, so this only matters for a direct/manual
API call.

- `GET /api/pow/challenge?scope=light|heavy` — issues a signed, short-lived
  puzzle (`{ challenge, difficulty }`) for the given scope.
- `POST /api/pow/solve` — redeems a solved puzzle (`{ challenge, nonce }`)
  for a ticket (`{ ticket, calls_remaining }`) good for several subsequent
  calls in that scope.
- `GET /api/search?q=...&limit=8` — literal (non-fuzzy) search over the
  movie **title only**; `genres` are returned for display but are not
  matched against. Titles are matched with the leading article reordered
  to the front (`"Matrix, The (1999)"` -> `"The Matrix (1999)"`),
  lowercased, depunctuated, and with common stopwords (the/a/an) stripped
  before matching. Results are ranked into tiers rather than by a
  continuous fuzzy score: exact prefix, then word-boundary phrase match,
  then plain substring, then a word-order-agnostic fallback (every query
  token present as a substring, in any order) - see
  `apps/web/backend/app/search.py` for the full tiering rationale. No
  typo tolerance: unlike the previous rapidfuzz-based version, a
  misspelled query will not match. `q` is capped at 200 characters and
  `limit` at 25 results (both enforced server-side regardless of what's
  passed). Results do not include `imdb_id`/`tmdb_id` (see
  `/api/movie/{item_id}` for those).
- `GET /api/movie/{item_id}/recommend` — scheme-independent neighbor pool
  for one reference movie. For every pair of curated components (a hue
  plane) the catalog items that match the reference once that plane is
  projected out are selected (`find_neighbors`, `docs/math.md` section 7);
  the pool is their union. Response shape: `{ item_id, pcs, axes,
  reference, planes, schemes, gate, items }`:
  - `pcs` — curated 1-based component indices; `axes` carries each one's
    colors/labels, `items[].z` is parallel to `pcs`.
  - `reference` — the reference's whitened coordinates on every basis
    component, indexed by component number (`reference[pc - 1]`).
  - `planes` — the hue planes (component pairs) the pool was built for;
    each item's `planes` holds the indices into it on which the item
    qualified.
  - `schemes` maps scheme name to its angles, and `gate` holds the Stage B
    tolerances (`angle_tol_rad`, `radius_tol_log`) defined in
    `recommend.py`.
  - items are ordered by descending `similarity` (cosine in the feature
    space).

  Circles, per-angle recommendations (angle/radius gate, top 6 per angle)
  and the background star field are derived client-side
  (`frontend/src/utils/schemeGate.ts`), so changing the scheme needs no
  request.
- `GET /api/movie/{item_id}/wheel` — `{ item_id, circles: [...] }`, one
  entry per circle (see below), each with `axis_x`/`axis_y` (pc index,
  colors, labels per language, explained variance), `z_x`/`z_y`, `angle_deg`,
  `radius`, and `primary` (true for the main circle).
- `GET /api/movie/{item_id}` — basic metadata (`title`, `genres`,
  `imdb_id`, `tmdb_id`) for a single movie. Used to resolve a reference
  item passed via URL or clicked from the Recommendations panel, where
  only an `item_id` is available.
- `GET /api/movie/{item_id}/backdrop` — resolves a backdrop image URL
  for the hero background via TMDB, from the movie's `tmdb_id`. `null`
  - never a 404 - when the movie has no `tmdb_id`, TMDB isn't
  configured, or the lookup failed.
- `GET /api/movie/{item_id}/poster` — resolves a small poster image URL
  via TMDB, from the movie's `tmdb_id` - used by the Recommendations
  panel's hover/tap info card (see below). Same graceful-degradation
  shape as `/backdrop`: `null` - never a 404 - when the movie has no
  `tmdb_id`, TMDB isn't configured, or the lookup failed.
- `GET /api/movie/random` — a single movie, uniformly picked at random
  from the same searchable catalog `/api/search` and `/api/movie/{item_id}`
  draw from. Same response shape as `/api/movie/{item_id}`. Backs the
  "surprise me" button in the search box
  (`frontend/src/components/SearchBar.tsx`).

## Linking directly to a reference movie

Visiting `/{item_id}` (e.g. `https://omltp.com/567` in production, or
`http://localhost:5173/567` in dev) loads that movie as the reference
on page load, the same as picking it via search. Selecting a movie -
via search, or by clicking a title in the Recommendations panel - keeps
the URL in sync (`window.history.pushState`), so the current reference
is always shareable and survives a page reload.

## PCA component config (`pc_config.json`)

`apps/web/backend/app/pc_config.json` is hand-curated, one component at a
time: run `diagnose`, read a component's criteria weights and the real
items at each pole (docs/math.md section 4), then decide what it represents,
then add an entry:

```json
"7": {
  "excluded_from_hue": false,
  "colors": { "negative": "#hex", "positive": "#hex" },
  "labels": {
    "en": { "axis": "...", "negative": "...", "positive": "..." },
    "ru": { "axis": "...", "negative": "...", "positive": "..." }
  }
}
```

`excluded_from_hue: true` marks a component that should never be used for
rotation/display (e.g. PC1, a general "quality/halo" axis — see
docs/math.md section 4) but can still be documented for reference.

Only components listed here are eligible to appear as a circle — this
bounds candidate selection to reviewed, non-noise axes, and guarantees
every circle has a label/color for every supported language. A prefilled
example for PC1–PC3 ships in the repo; extend it as more components get
reviewed.

Components are defined in the feature space (`docs/math.md`, section 3);
whenever the feature map, its parameters or the number of harmonics
change, the axes change too and every entry must be re-reviewed with
`diagnose`.

## The wheel(s)

For a selected movie, the pool is computed for every pair of curated axes,
but circles are built only for planes on which the reference is
pronounced on both axes (`|z| >= AXIS_Z_MIN`; with none, the plane with the
largest reference radius is used). Circles are ranked as described below
under "Recommendations per circle"; the first is the **main circle**, the
rest fill the **secondary circles**, shown smaller in a column on the
right.

Each disc's fill is a decorative "mood" gradient built from that circle's
axis colors, not a literal encoding of the values — the source of truth
is the point's position on the disc; the underlying z-scores, angle, and
vector length remain available in the API response, but are no longer
shown as on-page text.
On both the main and the secondary wheels the four pole labels are drawn
curving along a single ring around the disc (outside its coloured gradient,
on the page background), sized per label so the text is never clipped. On the
smaller secondary circles the labels are shortened to the first "/" segment
("Wilderness / travel ..." -> "Wilderness") so they fit the tiny disc; hovering
a circle still shows the full labels as a tooltip.

### Recommendations per circle

Each circle's recommendations are computed on the client from the
neighbor pool returned by `/recommend`, using only the items that
qualified on that circle's plane. For every scheme angle, the reference
is rotated in the plane's whitened coordinates, and pool items within the
angle and radius tolerances of the rotated target are kept and ordered by
angle bucket, radius mismatch, exact angle and finally similarity (the
same Stage B gate as `recommend.py`, whose tolerances the server
supplies). Every item that passes the gate is a match; the top 6 per
angle are listed in the Recommendations panel and the small wheels. The
big wheel plots all matches, and its poster-grid legend shows them as a
horizontally scrolling row per angle, six tiles per page (arrow buttons,
or native scroll/swipe). The legend's list layout keeps the top 6.

An item matched on several circles is kept only on the circle where the
reference radius is larger (within it, at the angle where the item is
closest to the rotated target); on the other circles it can still appear
as a star field point. A circle left without matches is omitted.

Circles are ordered by the number of matches at their weakest scheme
angle (largest first), then by their total number of matches across all
angles, then by the reference's radius, largest first; the first is the
main circle. Match counts are capped at 6 (the number of recommendations
shown per angle) before comparing, so matches beyond what is displayed
give no advantage: circles that fill every angle are ordered by radius.

The left-hand "Recommendations" panel lists every circle that has at
least one match; each row links out to IMDb and TMDB (direct title-page
links when the dataset has a matching `imdb_id`/`tmdb_id`, a title search
otherwise - see "External ids" above).

### Plane starfield

Besides the scheme's clustered recommendations, each circle carries a
star field: its own plane's pool items that are not matches. The pool is
built by judging character similarity (cosine in the feature space, PC1
removed) with the plane's two axes projected out, so it contains movies
that match the reference everywhere except along the plane - the movies a
rotation within that plane can reach (see
`packages/hyperwheel-recommender/docs/math.md` section 7). Scheme clusters
sit at specific target angles, while starfield items scatter across the
disc. Rendered only on the main wheel as small, muted points; hovering
one shows its title with the same highlight treatment as a scheme point,
without opening the recommendation info card or cross-lighting the
Recommendations list (starfield items have no list row).

### Hover/tap info card

Hovering a recommendation row (desktop) or tapping it (touch/mobile)
opens a small info card next to it: a mini poster resolved from TMDB
(`/api/movie/{item_id}/poster`, fetched lazily and cached client-side
per `item_id` - see `RecommendationsPanel.tsx`), the title, genres, and
the same IMDb/TMDB links as the row itself. Without a TMDB key
configured (or when TMDB has no poster for that title), the card still
opens - it just doesn't show an image, the same graceful-degradation
pattern already used for the hero backdrop and the row's own IMDb/TMDB
fallback links.

On narrow viewports the card renders as a bottom sheet (full width,
pinned to the bottom of the screen, with a close button and a
tap-to-dismiss backdrop) instead of a small popover next to the row, so
it stays comfortable to read and to dismiss with a thumb.

## Diagnostic overlay

Technical readouts for inspecting the model on the page: per-circle axes
(PC numbers), reference z-scores, radius and angle, match counts per
scheme angle, matches displaced by another circle during cross-plane
deduplication, a global ordinal on every recommendation, per-item
similarity and qualifying planes in the info card, and a HUD with pool
size, gate tolerances and timings.

Toggle with `?debug=1` / `?debug=0` (persisted in `localStorage`, since
in-app navigation drops the query string) or `Alt+Shift+D`. Overlays are
absolutely positioned and never take pointer events or affect layout.

## Localization

The frontend uses `react-i18next`. Currently English (default) and
Russian, with a language switcher in the top-right corner; language
choice is auto-detected from the browser and persisted in
`localStorage`. Wheel axis labels are localized through `pc_config.json`
itself (a `labels` entry per language, per component) rather than the
UI's translation files, since they're curated content, not UI chrome.

To add a new UI language:
1. add `frontend/src/i18n/locales/<code>.json` with the same keys as `en.json`
2. register it in the `resources` map in `frontend/src/i18n/index.ts`
3. add `{ code: "<code>", label: "..." }` to `LANGUAGES` in `frontend/src/components/LanguageSwitcher.tsx`
4. add a `"<code>"` entry under `labels` for each component in `pc_config.json`

## About modal links (source / author)

The two optional links in the About modal's top section
(`frontend/src/components/AboutModal.tsx`) are set via frontend env
vars, resolved at **build time** (Vite bakes `VITE_`-prefixed vars into
the static bundle - unlike the backend's `TMDB_API_KEY`, there's no
server involved to read these per-request, so changing a value needs a
rebuild, not just a restart):

VITE_GITHUB_URL=https://github.com/<your-org>/cinematic-hyperwheel
VITE_AUTHOR_URL=https://your-link-of-choice

Set in `apps/web/frontend/.env` for local dev (Vite loads this
automatically - see `.env.example`), or as build-time env vars on your
deploy platform. `VITE_AUTHOR_URL` isn't tied to any specific
platform - point it at a personal site, any social profile, etc. Each
button only renders when its URL is set; leaving one (or both) unset
simply omits it.

## Privacy notes (for operators)

A factual summary of what data flows through the code as shipped -
useful as a starting point if you're deploying your own instance and
need to write your own privacy notice for it. This is not itself a
privacy policy.

- **No accounts, no first-party data collection.** There is no login;
  the app does not store search queries, selections, or any other
  per-user data server-side beyond the lifetime of a single request.
- **Interface language** is stored in the browser's `localStorage` by
  `i18next-browser-languagedetector` and never leaves the client.
- **TMDB metadata lookups** (`/backdrop`, `/poster`) happen server-side
  (see `tmdb.py`), so the TMDB API key never reaches the browser - TMDB
  sees the deploying server's IP for these lookups, not the end user's.
- **TMDB images themselves** (the resolved backdrop/poster URLs) are
  loaded directly by the browser from `image.tmdb.org` - TMDB's CDN
  does see the end user's IP for those specific requests, the same way
  it would for any page embedding a third-party image.
- **IMDb/TMDB links** in the UI navigate directly to those sites; their
  own privacy policies apply once a user clicks through.
- **Proof-of-work tickets** (`pow.py`) are opaque, ephemeral, in-memory
  identifiers tied to a solved puzzle, not to any user identity - they
  are never persisted and carry no personal data.
- **No analytics, ads, or tracking cookies** are included in the
  shipped code.
- Whatever platform you deploy on (Render, your own server, etc.) will
  likely log standard request metadata (IP, timestamps, user agent) as
  part of normal operation - that's a property of the hosting platform,
  not of this application, and isn't covered above.

## Next (stage 2, not in this build)

- richer recommendation UI over the scheme-based overlays now implemented
  (currently: scheme selector, per-circle independent top-5 lists overlaid
  on each wheel with a hover popup, and a text list for the main circle
  only in the left panel)
