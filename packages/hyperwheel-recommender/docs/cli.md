# CLI

## 1. Build — one-off, outside the web process

Turns the source CSV into a compact `.npz` artifact so a web service never has to re-parse hundreds of MB of CSV on every start.

bash

```bash
python3 -m hyperwheel-recommender build data.csv --out artifact.npz
```

|Argument|Default|Meaning|
|---|---|---|
|`csv_path`|—|Source CSV|
|`--out`|—|Where to save the `.npz` artifact|
|`--chunksize`|`500000`|Rows per chunk during the streaming read|

## 2. Diagnose — how many components matter, and what they mean

bash

```bash
python3 -m hyperwheel-recommender diagnose artifact.npz \
  --loadings-components 3 --loadings-top 10 --items-top 10
```

|Argument|Default|Meaning|
|---|---|---|
|`input_path`|—|CSV or `.npz` (from `build`)|
|`--max-components`|`10`|How many components to list in the variance table|
|`--loadings-components`|`2`|For how many first components to show criteria weights|
|`--loadings-top`|`10`|Criteria shown at each end of the axis|
|`--items-top`|`10`|Items shown at each pole of a component|
|`--no-standardize`|off|Disable z-scoring criteria before PCA (on by default)|

## 3. Recommend — real items matching a scheme

bash

```bash
# auto plane selection (default): picks, per reference item, the two
# components on which THAT item is most expressive
python3 -m hyperwheel-recommender recommend artifact.npz \
  --item 123 \
  --scheme complementary \
  --hue-components auto \
  --exclude-components 1 \
  --candidate-components 20 \
  --n-components 20 \
  --top-k 5 \
  --out result.csv

# ...or pin an explicit, fixed pair instead of auto-selection
python3 -m hyperwheel-recommender recommend artifact.npz \
  --item 123 --scheme complementary --hue-components 2,3
```

|Argument|Default|Meaning|
|---|---|---|
|`input_path`|—|CSV or `.npz` (from `build`)|
|`--item`|—|ID of the reference item (numeric)|
|`--scheme`|—|`complementary` / `triadic` / `analogous` / `split-complementary` / `tetradic`|
|`--n-components`|`20`|How many PCA components to compute|
|`--top-k`|`5`|How many recommendations per angle|
|`--out`|none|Save results to a CSV|
|`--hue-components`|`auto`|`auto`, or an explicit 1-based pair like `2,3`|
|`--exclude-components`|`1`|Components never eligible for `auto` selection (e.g. a known quality axis)|
|`--candidate-components`|`--n-components`|Caps how far into the tail `auto` selection may look|
|`--no-standardize`|off|Disable z-scoring criteria before PCA (on by default)|
|`--shortlist-size`|`50`|Safety cap on Stage-A's character shortlist (a statistically close match to the target, not just the closest available) that Stage B's angular re-rank picks `--top-k` from. Must be >= `--top-k`|

Every run prints its fully resolved arguments (including untouched defaults) to stderr before executing, so nothing is silently assumed.