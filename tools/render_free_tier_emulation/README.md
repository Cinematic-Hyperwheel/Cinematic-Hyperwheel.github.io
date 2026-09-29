# Render free-tier emulation

Reproduces Render's free web service constraints locally (0.1 vCPU,
512 MB RAM, no persistent disk) using Docker's own cgroup limits, so
startup/CPU/memory changes to the recommendation engine can be measured
against the actual deployment target instead of guessed at on a full
local machine.

## Why

Render's free tier throttles the container to a fraction of one core.
Threaded BLAS/LAPACK (used by `build_taste_basis`'s `eigh` call)
busy-spins between threads while synchronizing by default - fine with
real dedicated cores, but under a throttled quota the spinning threads
compete with each other for the small CPU slice actually granted. This
turned a sub-second `eigh` call into 166s in one measured case - a
difference only visible under a real CPU quota, not on an unconstrained
dev machine. See `/docs/performance.md` for the full writeup and
measured numbers.

## Files

- `Dockerfile` - installs the `hyperwheel-recommender` package into a
  plain `python:3.11-slim` image. No data and no volume by design: this
  matches the free tier's lack of a persistent disk, so a benchmark run
  here starts from the same "clean slate" a real cold start would.
- `../bench_similarity_freetier.py` - times `load_artifact` ->
  `load_pca_cache` (if `--cache` is given) -> `build_taste_basis` ->
  `recommend_many_planes`, and reports peak RSS. Run this inside the
  throttled container, not on the host - see below.

## Build

From the repo root:

```powershell
docker build -f tools/render_free_tier_emulation/Dockerfile -t hyperwheel-freetier .
```

Rebuild whenever `packages/hyperwheel-recommender` changes - the image
bakes in a specific checkout of the package, it doesn't mount it live.

## Optional: build the PCA cache

Precomputes the expensive part of `build_taste_basis` (see
`apps/web/README.md`, "Optional: precomputed PCA cache") against your
own artifact. Not throttled - this step is meant to run once, the way
it would as a build step on Render:

```powershell
docker run --rm `
  -v "${PWD}/data:/app/data" `
  -v "${PWD}/tools/build_basis_cache.py:/app/build_basis_cache.py:ro" `
  hyperwheel-freetier `
  python /app/build_basis_cache.py --artifact /app/data/ml-latest/artifact.npz --n-components 20 --out /app/data/ml-latest/pca_cache.npz
```

`--n-components` must match what the web app actually builds the basis
with (`max(HYPERWHEEL_N_COMPONENTS, highest PC index in
pc_config.json)`) - otherwise the cache's fingerprint check rejects it
as a mismatch. Re-run this after any change to `packages/hyperwheel-recommender`
that touches PCA (the fingerprint hashes `_solve_pca`'s own source, so a
stale cache is detected automatically) or after replacing the artifact.

## Run the benchmark

```powershell
docker run --rm --memory=512m --memory-swap=512m --cpus=0.1 `
  -e OPENBLAS_NUM_THREADS=1 -e OMP_NUM_THREADS=1 -e MKL_NUM_THREADS=1 -e NUMEXPR_NUM_THREADS=1 `
  -v "${PWD}/data:/app/data:ro" `
  -v "${PWD}/tools/bench_similarity_freetier.py:/app/bench.py:ro" `
  hyperwheel-freetier `
  python /app/bench.py /app/data/ml-latest/artifact.npz 2571 --cache /app/data/ml-latest/pca_cache.npz
```

Flags that matter for accurate numbers:
- `--memory=512m --memory-swap=512m` - the second flag disables swap;
  without it Docker allows swapping past the memory limit, hiding an
  OOM that would actually kill the process on Render.
- `--cpus=0.1` - a real CFS CPU quota (10% of one core), not a hint;
  this is what makes threaded-BLAS contention reproducible at all.
- `--cache` - omit it to measure the no-cache path (a fresh `eigh` on
  every run) instead.
- the four `-e OPENBLAS_NUM_THREADS=1` etc. - omit them to measure the
  default multi-threaded-BLAS path (expect roughly 20x slower on the
  `build_taste_basis` line - see `/docs/performance.md`).

2571 above is an example reference movieId - use any id present in your
artifact.

Replace `${PWD}` with `%cd%` and drop the backtick line continuations if
running from `cmd` instead of PowerShell.