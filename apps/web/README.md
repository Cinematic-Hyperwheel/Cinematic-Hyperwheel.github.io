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
`HYPERWHEEL_ARTIFACT_PATH`.

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
- `heavy` - `/recommend`, the one endpoint that runs a full-catalog Stage
  A/B pass per circle (see
  `packages/hyperwheel-recommender/docs/math.md` section 6c) - a higher
  difficulty and a smaller per-ticket call budget than `light`.

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
- `GET /api/movie/{item_id}/recommend?scheme=...` — color-wheel
  recommendations (complementary/triadic/analogous/split-complementary/tetradic),
  computed **independently for each circle** shown on `/wheel` for this
  item. A single `recommend_many_planes` call resolves every circle's own
  axis pair at once (see `docs/math.md` section 6c) — Stage A (character
  shortlist in standardized shape space) and Stage B (angle+radius
  re-rank within that shortlist, see `docs/math.md` section 6b) both run
  fresh per circle; only the one-time reference-relative distance term is
  now shared across circles instead of recomputed per circle. Because PCA
  components are orthogonal, a movie well-rotated on one circle's axes
  says nothing about its position on another circle's axes — so **each
  circle generally returns a different set of top-5 movies**, not the
  same 5 movies re-projected onto different axes (that was the earlier,
  less accurate approach).
  Response shape: `{ item_id, scheme, circles: [...] }`, one entry per
  circle (same `axis_x`/`axis_y`/`primary` as `/wheel`), each carrying
  its own `reference` coordinate and, per scheme angle, its own top-5
  matches (`rank`, `title`, `genres`, `imdb_id`, `tmdb_id`, `z_x`/`z_y`, `angle_deg`,
  `distance_to_target`, `angular_error_deg`, `radius_ratio`). `imdb_id`/
  `tmdb_id` are `null` when the dataset has no matching `links.csv` row
  for that movie, or `movies.csv` wasn't built with `--links` at all
  (see "External ids" above).
  Each circle also carries `starfield`: every catalog item that is a
  statistically significant near-outlier on the reference's distance
  distribution across every TAG/criterion not already accounted for by
  that circle's own axis pair (a tag-space comparison, not a comparison
  against the OTHER PCA components - see `find_plane_neighbors` and
  `docs/math.md` section 7), with duplicates of that circle's own scheme
  recommendations excluded. This count varies per movie and per circle -
  a distinctive reference may have very few (or zero) plane neighbors on
  some axes and many on others; there is no fixed target size. Unlike
  the scheme clusters, these have no angle/radius restriction and
  scatter across the whole plane - the frontend renders them as small
  background points on the main wheel only, not in the Recommendations
  list.
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

## The wheel(s)

For a selected movie, the backend builds **every possible axis pair**
(combination) from the non-excluded components in `pc_config.json` and
ranks them by that item's aggregate z-score across the two axes
(|z_a| + |z_b|, descending). The top-ranked pair - the axes on which the
item is most expressive overall - is the **main circle**; the remaining
pairs fill the **secondary circles**, shown smaller in a column on the
right, in descending order of prominence. Generating all combinations
(C(n,2) circles, e.g. 9 curated axes -> 36) means any axis can participate
in the main circle and can later be swapped by the user to pivot the main
plane, unlike the previous straight ranked partition that used each axis
exactly once.

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

Unlike the wheel's own point (a single fixed coordinate per circle),
recommendations are re-derived per circle rather than shared across them.
Earlier versions ran the color-wheel search once, on the main circle's
plane only, and projected the resulting 5 movies onto every other
circle's axes for display — cheap, but the projected points landed
essentially at random on secondary circles, since a movie's position on
one PCA plane is uninformative about its position on another orthogonal
plane. A later version fixed the accuracy problem by calling
`recommend_on_basis` once per circle with that circle's own axis pair,
but at C(n,2) circles (e.g. 9 curated axes → 36) that meant redoing the
one expensive full-catalog distance computation once per circle. The
current backend instead calls `recommend_many_planes` once per request
with every circle's axis pair at once (see
`packages/hyperwheel-recommender/docs/math.md` section 6c): the
expensive part of Stage A is shared across all circles algebraically,
and each circle still gets its own independently optimized Stage A/B
result — same accuracy as the per-circle-call version, without paying
for the shared part C(n,2) times.

The left-hand "Recommendations" panel intentionally stays tied to the
**main circle only** (its titles list is not repeated per secondary
circle); the secondary circles still show their own, independently
computed points as overlays with a hover tooltip, they just aren't
duplicated as text in the side panel. Each row also links out to that
movie's IMDb and TMDB pages (direct title-page links when the dataset
has a matching `imdb_id`/`tmdb_id`, falling back to a title search on
the respective site otherwise - see "External ids" above).

### Plane starfield

Besides the scheme's own clustered recommendations, each circle's
response also carries a `starfield`: every catalog item that matches the
reference across every criterion this circle's own PCA axis pair doesn't
already account for (see
`packages/hyperwheel-recommender/docs/math.md` section 7 - this compares
against the underlying tags, not against the other PCA components),
regardless of where it lands within the plane itself. Where the scheme
clusters sit at specific target angles, starfield items scatter across
the whole disc - a background field of movies that share the reference's
character everywhere else. Rendered only on the main wheel, as small,
muted, non-clustered points; hovering one shows its title with the same
highlight treatment as a scheme point, without opening the recommendation
info card or cross-lighting the Recommendations list (starfield items
have no corresponding list row).

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
