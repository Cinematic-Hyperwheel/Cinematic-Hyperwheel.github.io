# Performance and memory efficiency

Measured on a 298 MB CSV, 10,000 items x 920 criteria.

| Stage | Before optimization | After | Change |
|---|---|---|---|
| Reading CSV + building the matrix | 353 MB peak (pandas `pivot`, object dtype) | 182 MB peak (streaming, chunked read straight into numpy) | ~1.9x |
| PCA | full SVD (n_items x n_criteria): 2.16s, +81 MB | eigh on the Gram matrix (n_criteria x n_criteria): 0.27s, +24 MB | ~8x faster |
| float64 → float32 on large intermediate arrays | — | −40% RSS during diagnose/recommend | — |
| **`diagnose`/`recommend` from a ready `.npz`** | — | **~245 MB peak, ~1.5-2s** | the target scenario for the serve stage |

Key architectural decision: **separating build and serve**. `build` runs
once (locally/in CI/as a background job) and streams the source CSV
without ever holding the long-format table in memory at once. The web
process (e.g. on Render's free tier, with limited RAM) never sees the
original CSV — only the compact `.npz` (298 MB → 23 MB compressed), which
loads in a fraction of a second.

The PCA basis object itself is not part of the `.npz` artifact - it is
rebuilt from the saved table on every process start via
`build_feature_basis`. Its `O(n_features^3)` eigendecomposition of the
Gram matrix can optionally be supplied from a separately baked cache (see
"PCA cache and threaded BLAS" below); the cache is keyed by a fingerprint
of the exact code (PCA, feature space, feature map), dataset and PCA
settings it was built from, so a stale cache is detected and falls back to
computing the basis fresh.

## Feature space cost

Items are mapped to `tags x (1 + N_HARMONICS)` features (3 harmonics: 4
features per tag), so the Gram matrix is 4x larger per side than the raw
tag table's and the eigendecomposition is the dominant build-time cost
(minutes under a throttled CPU; this is what the cache removes). At
request time everything is matrix arithmetic on cached scores: one
matrix-vector product per reference (`Phi @ Phi[ref]`) plus O(n_items x
n_planes) work for the starfield of all planes, with no per-tag loops.
The centered feature matrix stays resident (see "Memory" in
`apps/web/README.md`).

## PCA cache and threaded BLAS

The eigh call is `O(n_criteria^3)`. On a catalog with a sizeable number
of criteria, that dominates the cost of building the basis, and gets
considerably worse under a CPU quota well below one full core (e.g. a
free-tier host): multi-threaded BLAS/LAPACK backends (OpenBLAS, MKL)
typically busy-spin between threads while synchronizing rather than
yielding the CPU, which competes with itself for the small CPU slice
actually granted instead of yielding it back.

Measured on a 1128-tag artifact under a simulated 0.1 vCPU / 512 MB
constraint (Docker `--cpus=0.1 --memory=512m`, matching Render's free
tier, measured on the previous tag-space basis, to be updated):

| Configuration | `build_taste_basis` time |
|---|---|
| Default multi-threaded BLAS | 166s |
| `OPENBLAS_NUM_THREADS=1` (and the equivalent `OMP_`/`MKL_`/`NUMEXPR_` variables) | 8.3s |
| Above, plus a precomputed PCA cache (see `basis_cache.py`, `tools/build_basis_cache.py`) | 1.7s - the `eigh` call is skipped, leaving only the remaining `O(n_items x n_criteria)` steps (mean/center/standardize, and the `Q_scaled @ U.T` projection) |

`load_pca_cache`'s own fingerprint check (reading the cache file plus
verifying it matches the current artifact/parameters, see below) adds a
separate, small 0.3s on top of the row above - not part of
`build_taste_basis` itself, but part of the same cold-start path.

Two independent, complementary mitigations under a throttled CPU quota:
- pin BLAS to a single thread (see `.env.example`) - a 20x difference on
  its own in the measurement above;
- bake the eigendecomposition into a cache file at container build time
  (see `apps/web/README.md`, "Optional: precomputed PCA cache") -
  removes most of the remaining `eigh` cost on every cold start, not
  just once.

Combined with `load_artifact` (~4.2s in the same environment), the full
cold-start path (`load_artifact` -> `load_pca_cache` -> `build_taste_basis`)
comes to roughly 6.2s with both mitigations in place, down from 166s+
with neither.

An earlier version of the cache's fingerprint check hashed the entire
catalog matrix (tens of MB) with `hashlib`, which - being
single-threaded like the rest of Python's hashing - took 2.5s on its
own under this same throttled quota, eating most of what the cache was
meant to save. `compute_fingerprint` hashes a fixed-size strided sample
instead (see `basis_cache.py`), since the fingerprint is a defensive
mismatch check, not the primary correctness mechanism - bringing this
check down to 0.3s, the number reported above.

Peak RSS in the same measurement was ~420-490 MB, close to a 512 MB
limit - worth watching as the dataset grows, independently of the two
mitigations above.

SQLite wouldn't be a good fit for the analytics matrix itself: it's a
row-oriented relational store, and for a dense numeric matrix (thousands
of items x hundreds of criteria) it would be both slower and no lighter
on memory than a dense numpy array — marshaling Python↔SQL for ~9M
numeric cells costs more than reading a binary `.npz` directly. SQLite
remains a reasonable choice for metadata/name search if that need arises
later, but not for the numeric pipeline itself.