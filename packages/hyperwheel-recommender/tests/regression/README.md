# Recommendation regression suite

Hand-curated (reference item, expected recommendation) pairs, checked
against the real recommendation pipeline on every run. This guards
against regressions in starfield selection and sizing that a purely
synthetic unit test wouldn't catch,
because it exercises the pipeline on the actual catalog and its real
statistical distribution.

## What's checked

- **`test_starfield_size.py`** - for every reference item that appears in
  the CSV, each plane's starfield pool (`find_plane_neighbors`) stays
  within `settings.STARFIELD_MAX_SIZE` items, with the safety cap in
  `find_plane_neighbors` itself raised out of the way so the underlying
  outlier selection is what's measured.
- **`test_starfield_regression.py`** - for every pair in
  `data/recommendation_pairs.csv`, the expected recommendation is present
  in the starfield pool of at least one of the circles' planes (character
  match to the reference with that plane projected out, see
  `/docs/math.md` section 7). The pair's `scheme` column is ignored, since
  the starfield has no notion of a scheme.

## Adding a pair

Add a row to `data/recommendation_pairs.csv`:

```csv
reference_item,expected_recommendation,scheme,notes
1704,2571,complementary,"noticed while reviewing PC2/PC3"
```

`reference_item` and `expected_recommendation` are movieIds (integers).
`scheme` is optional and not currently used by any test; it records the
scheme under which the pairing was observed. `notes` is free text for the
reviewer's own context; it isn't checked. Set it whenever you know which scheme the pairing
was observed under - it makes the check both faster (one scheme instead
of every scheme) and more precise. Leave it blank to fall back to
`default_schemes` (every scheme in `SCHEMES`). `notes` is free text for
the reviewer's own context; it isn't checked. A row whose
`reference_item` starts with `#` is skipped, so it can be used as an
inline comment.

## Running

These tests need a real, already-built artifact. By default they reuse
the same `HYPERWHEEL_DATA_DIR` / `HYPERWHEEL_ARTIFACT_PATH` the web app
itself is configured with (see `apps/web/backend/app/config.py`) - so if
those are already set for local development, no extra setup is needed:

```bash
pytest packages/hyperwheel-recommender/tests/regression -v
```

Otherwise, set one of them explicitly:

```bash
export HYPERWHEEL_ARTIFACT_PATH=data/ml-latest/artifact.npz
pytest packages/hyperwheel-recommender/tests/regression -v
```

If the resolved artifact path doesn't exist, every test in this folder
is skipped rather than failed.

## Configuration

All configuration lives in `settings.py`. The dataset/config paths reuse
the same env vars as `apps/web/backend/app/config.py`:

| Env var | Default | Meaning |
|---|---|---|
| `HYPERWHEEL_DATA_DIR` | `data/ml-latest` | Same var the app itself uses |
| `HYPERWHEEL_ARTIFACT_PATH` | `$HYPERWHEEL_DATA_DIR/artifact.npz` | Same var the app itself uses - the artifact tested against |
| `HYPERWHEEL_PC_CONFIG_PATH` | `apps/web/backend/app/pc_config.json` | Same var the app itself uses - where circle definitions come from (see `planes_config.py`) |
| `N_COMPONENTS` | 20 | Same var the app itself uses |
| `STANDARDIZE` | True | Same var the app itself uses |

Everything else (``STARFIELD_MAX_SIZE`, `GOLDEN_FILE`) is a plain constant in `settings.py`
- edit that file directly to change them.