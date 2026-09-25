# Hyperwheel: math and design rationale

## 1. Problem

Given a category of items, each described by values across N criteria
(0..1), with no inherent "better/worse" direction on the criteria
themselves (like the R,G,B channels — no channel is "better" than
another). Given a reference item, we want to suggest real items "in the
spirit of" classic color-wheel schemes (complementary, triadic, analogous,
etc.), preserving the reference's overall character while meaningfully
shifting its "hue".

## 2. Analogy with HSL

| HSL (color, 3 channels) | This approach (N criteria) |
|---|---|
| L = mean of R,G,B for one pixel | L = mean of criteria for one item |
| Hue = angle in a fixed 120°-apart basis (R,G,B) | Hue = direction in a data-driven plane (PCA) |
| S = saturation | S = degree to which the "shape" is pronounced (norm of deviation from the typical profile) |

Key difference from classic HSL: in HSL the hue basis is fixed by the
physiology of human vision (R,G,B are equally spaced on the wheel). For
arbitrary criteria, no such physical basis exists — it must be **extracted
from the data**, not postulated by column order.

## 3. Basis-building pipeline

For an item `c` (a vector of length N):

1. **L (lightness)** — the item's own mean across criteria:
   `L = mean(c)`

2. **Q (shape)** — deviation from its own mean:
   `Q = c - L`
   (the components of Q always sum to 0 — this is the hyperplane
   perpendicular to (1,...,1), the direct analog of the chromatic plane
   in HSL)

3. **M (category-typical profile)** — the mean of Q **across all items**
   in the category (critical!):
   `M = mean(Q over items)`
   Without this step, PCA picks up the shape structure common to all
   items as the "main difference", rather than the real variation between
   items.

4. **Standardization** — criteria are divided by their std (after
   subtracting M), so that criteria with a larger random spread don't
   dominate PCA purely due to scale rather than real correlation with
   other criteria.

5. **PCA / SVD** on the normalized shape vectors of all items → an
   orthonormal basis U (the real principal axes of variation in the
   category), together with the fraction of variance explained per
   component.

This basis (L, Q, M, standardization, U) is used exclusively for the
**geometry of rotation** — what a hue plane is, what a 180°/120°/30°
rotation means, where the reference and a rotated target sit relative to
each other. It is a symmetric, Euclidean vector-space construction, and
stays that way regardless of how "character preservation" is judged (see
section 5).

## 4. Choosing the hue plane

Not all components are equally suitable for rotation. In practice, some
components turn out to be a general-"quality" axis (a halo effect: good
items get praised on many criteria at once, bad items get criticized on
many criteria at once), rather than a taste/character axis. Rotating
along such an axis doesn't give a "different in spirit" item — it gives
an objectively better/worse one, which defeats the purpose.

**Solution**: the components used for rotation are chosen explicitly
(`--hue-components`), after manually inspecting them via `diagnose`
(criteria weights + the list of items at each pole — what the component
physically represents). Non-rotated components aren't ignored entirely —
they're kept close to the reference via the delta mechanism (section 5).

## 5. Rotation, reconstruction, and character similarity

For a chosen pair of components (i, j):

1. Whitening — normalize each axis by its actual std across items
   (otherwise, when the explained-variance share differs strongly between
   components, a 90-120° rotation pushes the target into a region where
   hardly any real items exist).
2. Rotate by the scheme's angle (180° complementary, ±120° triadic, ±30°
   analogous, etc.) in whitened coordinates.
3. **Delta, not rebuild**: only the change introduced by the rotation
   within the chosen plane is added to the reference vector; everything
   else (including non-rotated components) stays as in the reference.
   The delta is expressed in the plane's own two axis directions, pulled
   back into standardized shape space and re-standardized the same way
   `Q_scaled` is (see section 6c) — adding it to the reference's own
   `Q_scaled` and un-standardizing/un-centering the result reconstructs
   the rotated target's raw `[0, 1]` tag values.
4. The target vector almost never matches a real item exactly — the
   final step is a nearest-neighbor search for the closest real items to
   that target, described below.

### Judging "still feels like the reference"

The target differs from the reference in only two of hundreds of
dimensions, so whether a real item "still feels like" that target has to
be judged across every OTHER dimension — everything the rotation left
untouched.

A plain symmetric distance (e.g. Euclidean, in the standardized shape
space PCA itself was fit on) is one way to measure that, but it has a
blind spot: tag relevance values are on `[0, 1]`, where a value near 1
means an item pronouncedly HAS that attribute and a value near 0 means
it's largely absent. Two items both lacking an attribute (both near 0)
says very little — most items lack most attributes, so mutual absence is
common ground, not evidence of shared character. Two items both
pronouncedly having an attribute (both near 1) is a much rarer, stronger
signal. A symmetric distance treats both cases identically — `(x-y)^2` is
the same whether x and y are both near 0 or both near 1 — so it can't
tell "these two share no notable traits" apart from "these two share
several pronounced traits".

Character similarity between an item and the rotated target is instead
measured with a fuzzy-set overlap metric (see `similarity.py`), applied
to raw `[0, 1]` tag values:

```
S(x, y) = mean(min(N(x_i), N(y_i)))
```


where `N()` independently normalizes each item's own tag vector using
its own 5th/95th percentile (so the metric isn't skewed by one item
simply running "hotter" or "colder" overall than another). `min()` means
a criterion only contributes to `S` when BOTH items are pronounced on
it — mutual near-0 values contribute almost nothing, mutual near-1
values contribute close to their full weight. This is what "preserving
the reference's overall character" means in this codebase: matching the
rotated target's own pronounced attributes, not merely sitting close to
it in an undifferentiated symmetric sense. See section 6b for how this
feeds the actual candidate selection.

## 6. Known limitations / open questions

- Rotation currently works strictly within one 2D plane. For >2
  significant axes, two extensions were identified:
  - **Adaptive per-reference plane selection (implemented, section 6a
    below)**: instead of one globally-fixed pair, pick the two components
    on which each specific reference item is most expressive.
  - **Complementary via full-dimensional inversion (not yet implemented)**:
    a 180° rotation in any 2D plane containing the reference vector itself
    is equivalent to **inverting** that vector (y → −y) — well-defined in
    **any** dimensionality, not just 2D. Complementary could use the full
    "taste" vector (all components except excluded quality axes), using
    100% of the real taste variation instead of just one plane.
- Choosing which components represent "quality" (to exclude from
  rotation) is currently manual, based on visually reviewing `diagnose`.
  Automatically detecting such axes (e.g. by correlating a component with
  an independent rating, if one exists in the data) could remove this
  manual step.
- The PCA basis is fit on the whole category at once; if criteria become
  genuinely unequal in the future (not just in scale, but in physical
  meaning/weight), a separate weighting scheme will be needed — see the
  discussion at the start of work on this approach.

### 6a. Adaptive per-reference hue-plane selection

On real data the variance spectrum can be strongly diffuse - no dominant
pair beyond a "quality" axis (PC1), just a long thin tail (e.g. PC2=6.3%,
PC3=5.3%, ..., PC100=0.1%, cumulative ~73% only after 255 components).
Fixing one global (i, j) pair for every reference item has a real cost in
this regime: a given item's distinguishing character might live almost
entirely in, say, PC8 and PC12, while a globally-fixed PC2/PC3 stays
close to the category-typical value for that specific item - rotating it
would barely change anything, or would rotate axes that say nothing about
what actually makes this item distinctive.

`hue_components="auto"` (the CLI default) instead computes, for the given
reference, its **z-score** along every candidate component:

```
z_k = score_k / pc_std_k
```


i.e. how many typical standard deviations this item sits from the
category norm on axis k - and picks the two axes with the largest |z_k|.
Using the raw score instead of the z-score would systematically favor
components with a larger population variance (PC2/PC3 again) regardless
of whether this particular item stands out there; the z-score corrects
for that (verified empirically: raw-score and z-score ranking disagree on
which components rank highest for the same reference item).

Two safeguards:
- `exclude_components` (default: PC1 only) - components that must never
  be selected, e.g. a known "quality" axis.
- `candidate_components` - caps how far into the long tail the selection
  is allowed to look. Without a cap, a component explaining almost no
  variance overall (e.g. PC200 at 0.1%) could still get picked just
  because one item happens to spike there by chance, essentially fitting
  to noise rather than a real taste dimension.

Verified on synthetic data reproducing the diffuse spectrum: different
reference items reliably resolve to different, non-overlapping component
pairs (e.g. PC8/PC12, PC3/PC5, PC6/PC17, PC9/PC18 across four different
references in one test run).

### 6b. Two-stage selection: character shortlist + angular re-rank

A single full-space nearest-neighbor search on `target_vec` conflates two
different goals: "still feels like the reference" and "actually sits at
the target angle". When the hue plane explains only a modest share of
total variance (e.g. PC2+PC3 at ~11.6% combined, see section 6), the first
goal dominates a naive full-space distance almost by construction -
`target_vec` differs from the reference in only two of hundreds of
dimensions, so the remaining dimensions decide the ranking, and the
resulting top-k tends to land near-center with an arbitrary angle instead
of near the intended 180°/120°/etc.

The shared two-stage core (`_stage_ab_rows` in `recommend.py`, used by
both `recommend_on_basis` and `recommend_many_planes` - see section 6c)
resolves this in two stages instead of one:

- **Stage A** - the real items that are a statistically significant
  outlier on the HIGH side of the catalog's own similarity distribution
  to the rotated target (robust modified z-score, median/MAD -
  `similarity.high_similarity_outlier_indices`), capped at
  `shortlist_size` as a safety ceiling rather than a fixed pool size (see
  below). Similarity is the pronounced-attribute overlap metric
  introduced in section 5 (`similarity.py`:
  `S(x, y) = mean(min(N(x_i), N(y_i)))`), computed between each catalog
  item's raw `[0, 1]` tag vector and the rotated target's own
  reconstructed raw tag vector (delta reconstruction, section 5/6c) -
  NOT a distance in the standardized PCA shape space. Because the delta
  is nonzero only inside the hue plane, a candidate similar to the
  target under this metric is, by construction, similar to the reference
  on every criterion outside the plane too - this is what enforces
  character preservation (section 5) while still allowing the plane's
  own two axes to differ. A fixed top-N pool alone can't tell "similar"
  from "most similar available": if fewer than N items are genuinely
  similar, the rest are padding that can still slip through Stage B's
  angle/radius gate by coincidence and be reported as a match despite
  sharing little of the target's character. The statistic is
  self-calibrating per (reference, plane, angle) call: a target sitting
  in a dense, typical region of tag space yields a larger shortlist, one
  sitting in a sparse or unusual region yields a smaller one, or none at
  all if the catalog's similarity distribution to that target is too
  flat to produce a statistically meaningful outlier (MAD ≈ 0) - an
  expected consequence of self-calibration, not a bug: some rotated
  targets simply have no catalog item that stands out as meaningfully
  more similar than the rest.
- **Stage B** - among that shortlist, rank by angular distance (in the
  whitened hue plane) to the exact target angle, and keep the closest
  `top_k`. This is what enforces the rotation actually being expressed,
  not just "some similar item".
   Stage B now applies a HARD radius gate. `RADIUS_TOL_LOG` is a dimensionless,
   symmetric ratio `|log(cand_r / target_r)|` (radius has no fixed absolute scale - it
   varies per reference and per plane - so only relative deviation is meaningful). A
   Stage-A shortlist candidate is eligible for Stage B only if its radius sits within
   this window (e.g. `RADIUS_TOL_LOG = log(1.5)` ~ +/-50%; a tighter value like
   `log(1.1)` ~ +/-10% is stricter, a tunable product gate).

   Angle is now HARD-gated too: a candidate is eligible only if its angular error
   is within `ANGLE_TOL_RAD` of the target as well as its radius being within the
   radius window (a genuine "sector" = angle + radius). Among candidates passing
   both gates, the coarse angle bucket (width `ANGLE_TOL_RAD`) keeps angularly
   "tied" candidates together and lets the tightest radius win within a bucket, with
   the exact angle as the final tie-break. Because both gross outliers are already
   excluded, these buckets only order good sector-matching candidates.

   The tolerance magnitudes are a tuning choice, evaluated against the target
   behavior; tighter radius/angle windows keep well-typed references populated and
   make extreme-saturation references (where few/no items exist near the target
   angle/radius) visibly short or empty.

`distance_to_target` in the output is the standardized PCA shape-space
distance to the rotated target (computed via the same algebraic shortcut
as section 6c) - reported for reference/debugging alongside the
similarity-based ranking, but it is no longer what Stage A selects on.

`shortlist_size` is a safety cap, not the selection mechanism itself -
Stage A's own similarity-outlier test (above) decides which items are
"similar enough" to consider at all, so the cap only matters if that test
qualifies an unusually large number of items and mainly bounds Stage B's
own cost in that case.

### 6c. Batched Stage A across many planes for the same reference

A single reference item may need recommendations on several different
hue planes at once - e.g. every candidate axis pair a caller wants to
compare (see `select_hue_plane`, section 6a, for how one such plane gets
chosen automatically; a caller wanting several planes at once is a
natural extension of the same idea). Recomputing the standardized-shape-
space `distance_to_target` reporting column from scratch for every
(plane, angle) combination is wasteful: for a fixed reference, a rotation
confined to plane (i, j) only ever moves the target within the 2D
subspace spanned by principal axes U[i], U[j] - every other coordinate of
the target is identical to the reference.

Writing the delta as `dy_i * v_i + dy_j * v_j` (v_i, v_j being the two
axis directions pulled back into criteria space and re-standardized the
same way Q_scaled is), the squared standardized shape-space distance to
any candidate k decomposes as:

```
dist(k)^2 = base(k)

2dy_iproj_i(k) - 2dy_jproj_j(k)
dy_i^2*||v_i||^2 + dy_j^2*||v_j||^2 + 2dy_idy_j*(v_i . v_j)
```


- `base(k) = ||Q_scaled[k] - Q_scaled[ref]||^2` does not depend on the
  plane or the rotation angle at all - the same for every plane and
  every scheme angle for a given reference, so it's computed exactly
  ONCE per reference (the one unavoidable O(n_items x n_criteria) pass).
- `proj_i(k)`, `proj_j(k)`: O(n_items) per plane, reusing cached PCA scores.
- `||v_i||^2`, `||v_j||^2`, `v_i . v_j`: O(n_criteria) per plane,
  independent of catalog size.

This is an exact algebraic identity of the full-reconstruction
`distance_to_target` - not an approximation - verified by direct
comparison against a full-reconstruction implementation (rebuild
target_vec, recompute L/M, fresh O(n_items x n_criteria) norm) on
synthetic data: identical `distance_to_target` (to floating-point
rounding) across every plane and scheme tested. This column is reporting
only (section 6b); Stage A's actual candidate selection uses the
similarity metric instead, computed from the SAME delta (`dy_i, dy_j`
against the same pullback directions `v_i, v_j`), reconstructing the
rotated target's raw `[0, 1]` tag values via
`target_raw = L[ref] + (Q_scaled[ref] + dy_i*v_i + dy_j*v_j) * scale + M`
(section 5's delta reconstruction, expressed algebraically instead of by
rebuilding the full vector through the standardization pipeline).

`recommend_many_planes` (recommend.py) implements this for an arbitrary
list of planes; `recommend_on_basis` is a thin single-plane wrapper
around it, so both share exactly one Stage A/B implementation
(`_stage_ab_rows`).

## 7. Plane starfield (whole-profile similarity neighbors)

Sections 5-6c find items near a rotated TARGET within one hue plane -
useful for the scheme's own clusters, but silent about everything else
in the catalog. A different, complementary question: regardless of any
hue plane, which items resemble the reference overall?

This reuses the exact same pronounced-attribute similarity metric Stage A
uses for scheme candidates (section 5/6b, `similarity.py`), applied
directly to raw `[0, 1]` tag values - reference vs. every catalog item,
with no rotation involved at all. Candidates are selected the same way
Stage A selects its shortlist: items that are a statistically significant
outlier on the HIGH side of the reference's own similarity distribution
across the catalog (`similarity.high_similarity_outlier_indices`,
section 6b) - self-calibrating per reference, same as Stage A.

Because the similarity metric is whole-profile (`min()` has no linear
decomposition the way a Euclidean distance does, so there is no way to
algebraically "project out" a single plane's contribution from it), a
reference's starfield is identical regardless of which plane it's
requested for - `find_plane_neighbors`'s `planes` argument only shapes
which keys the returned dict has, letting a caller look up one field per
plane the same way it looks up that plane's scheme recommendations.

Unlike the scheme case, there is no Stage B angle/radius gate afterward -
nothing here constrains where in any particular plane a candidate sits,
so plotted on any one plane's disc these items scatter across the whole
radius/angle range instead of clustering at scheme target angles.