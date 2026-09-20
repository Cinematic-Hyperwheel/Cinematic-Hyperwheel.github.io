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

## 5. Rotation and reconstruction

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
4. The target vector almost never matches a real item exactly — the
   final step is a nearest-neighbor search for the closest real item to
   that target.

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
goal dominates the full-space distance almost by construction -
`target_vec` differs from the reference in only two of hundreds of
dimensions, so the remaining dimensions decide the ranking, and the
resulting top-k tends to land near-center with an arbitrary angle instead
of near the intended 180°/120°/etc.

The shared two-stage core (`_stage_ab_rows` in `recommend.py`, used by
both `recommend_on_basis` and `recommend_many_planes` - see section 6c)
resolves this in two stages instead of one:

- **Stage A** - the real items that are a statistically significant
  near-outlier on the low side of the catalog's own distance distribution
  to `target_vec` (robust modified z-score, median/MAD -
  `_near_outlier_indices` in `recommend.py`), measured in the
  STANDARDIZED SHAPE SPACE the PCA basis itself was fit on
  (`(Q - M) / scale`, section 3), not raw Euclidean distance in the
  original `[0,1]` criteria units, capped at `shortlist_size` as a safety
  ceiling rather than a fixed pool size (see below). This is what
  enforces character preservation (section 5) - delta is nonzero only
  inside the hue plane, so distance elsewhere is a genuine measure of
  shared character, but only once L (overall level) and per-criterion
  scale are normalized out the same way they are before PCA; a raw-units
  distance would instead let a shift in overall level, or a single
  high-variance criterion, dominate the ranking regardless of actual
  shape similarity. A fixed top-N pool alone can't tell "close" from
  "closest available": if fewer than N items are genuinely close, the
  rest are padding that can still slip through Stage B's angle/radius
  gate by coincidence and be reported as a match despite sharing little
  of the reference's character.
- **Stage B** - among that shortlist, rank by angular distance (in the
  whitened hue plane) to the exact target angle, and keep the closest
  `top_k`. This is what enforces the rotation actually being expressed,
  not just "some nearby item".
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

   The magnitude is a tuning choice: the median relative radius deviation across
   Stage-A shortlists is ~log(2); tighter values (e.g. `log(1.5)` or `log(1.1)`)
   keep well-typed references populated and make extreme-saturation references
   (where few/no items exist at the target radius) visibly short or empty.
   Do not set `RADIUS_TOL_LOG = log(1.0)` (=0): with a hard gate that means
   "radius must be exactly equal to target", i.e. nothing ever qualifies.

`distance_to_target` in the output is Stage A's own metric - standardized
shape-space distance, not reweighted by Stage B, and not a raw full-space
Euclidean distance in criteria units. A new `angular_error_deg` column reports Stage B's own
metric per returned item, so callers can see how good the angular match
actually was instead of inferring it indirectly from position on a chart.

`shortlist_size` is now a safety cap, not the selection mechanism itself
- Stage A's own near-outlier test (above) decides which items are
"close enough" to consider at all, so the cap only matters if that test
qualifies an unusually large number of items (a degenerate or very
homogeneous catalog) and mainly bounds Stage B's own cost in that case.
It no longer needs tuning to trade "too small" against "too large" the
way a fixed-size pool did; a generous cap (e.g. 800) is safe by default.

### 6c. Batched Stage A across many planes for the same reference

A single reference item may need recommendations on several different
hue planes at once - e.g. every candidate axis pair a caller wants to
compare (see `select_hue_plane`, section 6a, for how one such plane gets
chosen automatically; a caller wanting several planes at once is a
natural extension of the same idea). Recomputing Stage A's full
O(n_items x n_criteria) standardized-shape-space distance from scratch
for every (plane, angle) combination is wasteful: for a fixed reference,
a rotation confined to plane (i, j) only ever moves the target within
the 2D subspace spanned by principal axes U[i], U[j] - every other
coordinate of the target is identical to the reference.

Writing the delta as `dy_i * v_i + dy_j * v_j` (v_i, v_j being the two
axis directions pulled back into criteria space and re-standardized the
same way Q_scaled is), the squared standardized shape-space distance to
any candidate k decomposes as:

```
dist(k)^2 = base(k)
- 2dy_iproj_i(k) - 2dy_jproj_j(k)
+ dy_i^2*||v_i||^2 + dy_j^2*||v_j||^2 + 2dy_idy_j*(v_i . v_j)
```

- `base(k) = ||Q_scaled[k] - Q_scaled[ref]||^2` does not depend on the
  plane or the rotation angle at all - the same for every plane and
  every scheme angle for a given reference, so it's computed exactly
  ONCE per reference (the one unavoidable O(n_items x n_criteria) pass).
- `proj_i(k)`, `proj_j(k)`: O(n_items) per plane, reusing cached PCA scores.
- `||v_i||^2`, `||v_j||^2`, `v_i . v_j`: O(n_criteria) per plane,
  independent of catalog size.

This is an exact algebraic identity of the Stage A distance described in
section 6b - not an approximation - verified by direct comparison against
the original full-reconstruction implementation (rebuild target_vec,
recompute L/M, fresh O(n_items x n_criteria) norm) on synthetic data:
identical item order and `distance_to_target` (to floating-point
rounding) across every plane and scheme tested.

`recommend_many_planes` (recommend.py) implements this for an arbitrary
list of planes; `recommend_on_basis` is a thin single-plane wrapper
around it, so both share exactly one Stage A/B implementation
(`_stage_ab_rows`).

## 7. Plane starfield (orthogonal-distance neighbors)

Sections 5-6c find items near a rotated TARGET within one hue plane -
useful for the scheme's own clusters, but silent about everything else
in the catalog. A different, complementary question: for a given plane
(i, j), which items match the reference across every criterion NOT
explained by this plane's own two axes, regardless of where they land
within the plane itself?

This reuses Stage A's own character-similarity metric rather than a new
one: the full standardized TAG-space distance (`_base_distance_sq`,
`||Q_scaled[k] - Q_scaled[ref]||^2` - Q_scaled being the standardized,
per-criterion shape vectors PCA itself was fit on, section 3, NOT the
reduced n_components PCA-score space), with the plane's own contribution
subtracted via orthogonal projection.

For a difference vector d = Q_scaled[k] - Q_scaled[ref], its dot products
with the plane's two pullback directions v_i, v_j (`_plane_projection_terms` -
PC_i's and PC_j's own loadings, mapped back into criterion space; already
computed for the rotation delta in section 6c) are exactly proj_i(k),
proj_j(k). The squared norm of d's projection onto span{v_i, v_j} follows
the standard formula for a non-orthonormal 2D basis:

```
proj_sq(k) = [proj_i(k) proj_j(k)] . G^-1 . [proj_i(k) proj_j(k)]^T
G = [[vpp, vpq], [vpq, vqq]]
orth_dist(k) = sqrt(base(k) - proj_sq(k))
```

`orth_dist(k)` is therefore the reference distance measured across every
criterion this plane's two axes don't already account for - the same
metric Stage A already uses to judge "still feels like the reference"
for scheme candidates, just with this specific plane's contribution
removed instead of a rotation delta added. Note this operates entirely
in the original tag/criterion space (hundreds of dimensions), not in the
reduced n_components PCA-score space - the other PCA components never
appear as separate axes here; they only matter insofar as they're part
of the same tag-space geometry.

Candidates are selected via the same near-outlier test Stage A uses for
scheme candidates (`_near_outlier_indices`, section 6b) - the
`shortlist_size`-worth closest items alone can't tell "close" from
"closest available"; the shared test decides "close enough" from the
distribution itself. Unlike the scheme case, there is no Stage B
angle/radius gate afterward - nothing here constrains where in the plane
a candidate sits, so plotted on that plane's disc these items scatter
across the whole radius/angle range instead of clustering at scheme
target angles.