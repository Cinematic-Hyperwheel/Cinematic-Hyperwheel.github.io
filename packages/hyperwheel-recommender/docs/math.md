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
| Hue = angle in a fixed 120°-apart basis (R,G,B) | Hue = direction in a data-driven plane (PCA) |
| S = saturation | S = how pronounced the item is on that plane (whitened radius) |
| L = mean of R,G,B | No counterpart: the overall level of an item is carried by PC1 (see section 3) and is projected out when judging character |

Key difference from classic HSL: in HSL the hue basis is fixed by the
physiology of human vision (R,G,B are equally spaced on the wheel). For
arbitrary criteria, no such physical basis exists — it must be **extracted
from the data**, not postulated by column order.

## 3. Basis-building pipeline

For an item `c` (a vector of length N):
## 3. Basis-building pipeline

### 3.1 The similarity this space is built around

Criteria are tag relevances `x` in `[0, 1]`. A value near 1 means an item
pronouncedly HAS the attribute, near 0 that it is largely absent. Two
items both lacking an attribute is common ground, not evidence of shared
character; two items both pronouncedly having it is a rare, strong
signal. The agreement score per criterion is therefore

```
s(x, y) = x*y - p*|x - y|          p = 0.15, i.e. MIN_WEIGHT / 2
        = x*y + 2p*min(x, y) - p*(x + y)
```

The first two terms are positive-definite kernels, i.e. genuine inner
products; the last depends on one item only. The geometry of the model is
built so that this score is an ordinary inner product, and closeness in it
respects the "both pronounced" principle by construction.

### 3.2 Feature map

Per tag, `min(x, y)` has the explicit expansion (Karhunen-Loève series of
Brownian motion on [0, 1])

```
min(x, y) = sum_k lambda_k * psi_k(x) * psi_k(y)
psi_k(x) = sqrt(2) * sin(a_k x),   a_k = (k - 1/2) * pi,   lambda_k = 1 / a_k^2
```

truncated to `N_HARMONICS` terms (3 harmonics cover ~93% of the kernel's
trace). With `w = 2p = MIN_WEIGHT`, the per-tag map

```
phi(x) = [ x, sqrt(2w)/a_1 * sin(a_1 x), ..., sqrt(2w)/a_K * sin(a_K x) ]
```

satisfies `<phi(x), phi(y)> = x*y + w*min(x, y)` (up to the truncation
error). The Euclidean distance between two mapped items is
`sqrt(sum((x - y)^2 + 2p*|x - y|))`: the disagreement penalty is part of
the metric itself. `features.py` implements the map.

### 3.3 Basis

1. **Feature matrix** `Phi` — every item mapped through `phi` (tag-major:
   each tag owns `1 + N_HARMONICS` consecutive columns).
2. **Centering** — the category-typical profile `mu = mean(Phi)` is
   removed. Without this, PCA picks up the profile common to all items as
   the "main difference". There is no per-item mean removal: the item's
   overall level stays in the data and is captured by PC1.
3. **Per-tag standardization** — each tag's block of columns is divided by
   the block's own standard deviation, so rare tags are not drowned out.
   The block's internal structure (the min-kernel shape) is left intact.
4. **PCA** — eigendecomposition of the Gram matrix `Phi^T Phi`
   (n_features x n_features, independent of the number of items), giving an
   orthonormal basis `U` and the share of variance per component. Item
   coordinates are `scores = Phi @ U.T`; `pc_std` is the spread of items
   along each component, used for whitening.

The basis is used for the **geometry of rotation** (what a hue plane is,
what a 180°/120°/30° rotation means, where the reference and a rotated
target sit) and, because `U` is orthonormal, for exact algebraic
shortcuts when judging character similarity (sections 5-7).

### 3.4 PC1

PC1 typically captures overall pronouncedness / reception: items with many
strongly expressed tags versus few. It is not a taste axis (section 4).
Whenever character similarity is judged, PC1 is projected out of both
items exactly (a subtraction of one score product, see section 5), and it
is never a hue axis.

### 3.5 Interpreting components

`U` lives in the feature space, so a component has several weights per
tag. For `diagnose`, a tag's loading on a component is the correlation of
the tag's relevance with the component score; the items at each pole are
listed alongside.

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

1. **Whitening** — normalize each axis by its std across items (otherwise,
   when the explained-variance share differs strongly between components, a
   90-120° rotation pushes the target into a region with hardly any real
   items).
2. **Rotate** the reference's whitened coordinates by the scheme's angle
   (180° complementary, ±120° triadic, ±30° analogous, ...).
3. **Delta, not rebuild**: the target is the reference's own feature vector
   shifted only inside the plane,

```
   Phi_t = Phi_ref + dy_i * U_i + dy_j * U_j
```

   where `dy` is the change of the reference's score on each axis caused
   by the rotation. Everything outside the plane is identical to the
   reference.
4. The target almost never matches a real item exactly; real items are
   selected by character similarity to it (below) and then by angle and
   radius in the plane (section 6b).

### Judging "still feels like the reference"

The target differs from the reference in two of many dimensions, so
whether an item still feels like it is judged across everything the
rotation left untouched. Character similarity is the **cosine** in the
feature space, with PC1 projected out:

```
cos(a, b) = <a', b'> / (||a'|| * ||b'||),    a' = a - score_1(a) * U_1
```

The inner product is the pronounced-attribute overlap of section 3.1; the
cosine normalization removes its one-sided `-p*(x + y)` term (an item with
many extra pronounced tags has a larger norm and a smaller cosine, which
is the disagreement penalty). Because `U` is orthonormal, projecting PC1
(or any further axes) out of a cosine needs no pass over the features:

```
<a', b'> = <a, b> - sum_removed score(a) * score(b)
||a'||^2 = ||a||^2 - sum_removed score(a)^2
```

Items close to the category mean have tiny norms and noisy cosines; norms
are floored at a low quantile of their distribution (`similarity.py`).

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

A single full-space nearest-neighbor search on the target conflates two
goals: "still feels like the reference" and "actually sits at the target
angle". The target differs from the reference in only two of many
dimensions, so the remaining dimensions dominate a naive distance and the
top-k lands near the center with an arbitrary angle.

The shared two-stage core (`_stage_ab_rows` in `recommend.py`) separates
them:

- **Stage A** — the items that are a statistically significant HIGH
  outlier of the catalog's cosine similarity to the rotated target (robust
  modified z-score, median/MAD, `similarity.high_similarity_outlier_indices`),
  capped at `shortlist_size` as a safety ceiling rather than a fixed pool
  size. The statistic self-calibrates per (reference, plane, angle): a
  dense region yields a larger shortlist, a sparse one a smaller one, and
  a flat distribution (MAD ≈ 0) yields none - an expected outcome, not a
  bug.
- **Stage B** — among the shortlist, a hard sector gate: an item is
  eligible only if its angular error is within `ANGLE_TOL_RAD` of the
  target AND its radius is within `RADIUS_TOL_LOG` (`|log(cand_r /
  target_r)|`, a symmetric ratio, since radius has no fixed absolute
  scale). Among eligible items, the coarse angle bucket (width
  `ANGLE_TOL_RAD`) keeps angularly tied candidates together, the tightest
  radius wins within a bucket, and the exact angle breaks the rest.

`distance_to_target` in the output is the Euclidean distance in the
feature space to the rotated target; it is reported for inspection only
and is not what Stage A selects on.

The sector can legitimately be empty: for a reference that is extremely
pronounced on a plane, few catalog items share its radius, and none may
sit on the far side. Such angles are reported empty rather than filled
with an unsuitable item.

### 6c. Batched Stage A across many planes for the same reference

A reference may need recommendations on several planes at once. For a
fixed reference, a rotation confined to plane (i, j) only moves the target
inside the 2D subspace spanned by `U_i`, `U_j`. Since `U` is orthonormal,
for every item `k`:

```
<Phi_k, Phi_t> = g_k + dy_i * s_ki + dy_j * s_kj
||Phi_t||^2    = n_ref + 2*dy_i*y_ri + 2*dy_j*y_rj + dy_i^2 + dy_j^2
||Phi_k - Phi_t||^2 = n_k + ||Phi_t||^2 - 2 * <Phi_k, Phi_t>
```

with `g_k = <Phi_k, Phi_ref>` (one matrix-vector product per reference,
shared by every plane and angle), `s` the item scores, `y_r` the
reference's scores and `n` squared feature norms (cached in the basis).
Per (plane, angle) the cost is O(n_items) vector arithmetic. These are
exact identities, not approximations. The cosine used by Stage A follows
the same way, with PC1's score product subtracted (section 5).

`recommend_many_planes` implements this for an arbitrary list of planes;
`recommend_on_basis` is a thin single-plane wrapper, so both share one
Stage A/B implementation.

## 7. Plane starfield (per-plane projection neighbors)

Sections 5-6c find items near a ROTATED TARGET inside one hue plane. A
rotation can only reach items that already match the reference outside the
plane, yet such items are not "near the reference" in the full space: they
differ from it along the plane itself. In sky terms, the neighbor we want
is a star that looks adjacent to the reference when viewed along the
plane, but is physically far from it - a search around the reference in the
full space would never find it.

For every hue plane (a pair of PCA axes) the starfield therefore judges
character with the plane projected out:

```
cos_plane(k) = cosine of (Phi_k, Phi_ref) with PC1, U_i and U_j removed
```

computed exactly by the orthonormal-basis identities of section 5. All
planes are evaluated as one `(n_items x n_planes)` matrix, with no pass
over the feature matrix per plane. Per plane, items whose cosine is a high
robust outlier (median/MAD over the catalog, threshold `PLANE_OUTLIER_Z`)
are kept, capped per plane at `MAX_NEIGHBORS`. The per-plane sets are
unioned by item id into one shared pool; each item records the indices of
the planes on which it qualified, so a circle can use exactly the items
that qualified on its own plane.

### Which planes

The pool is computed for EVERY pair of curated axes: a neighbor may be
pronounced on an axis where the reference is weak, and restricting the
search to the reference's own strong axes would miss it.

Circles are shown only for planes on which the reference itself is
pronounced on both axes (`|z| >= 2` in whitened units, `AXIS_Z_MIN` in
`frontend/src/utils/schemeGate.ts`). If none qualifies, the plane with the
largest reference radius is used, so a typical reference still gets a
circle. A circle draws only the pool items that qualified on its plane.

### Reading the result

- The pool is scheme-independent; the client applies the scheme's angles
  and the Stage B gate (angle and radius windows, supplied by the server)
  to it, so switching the scheme needs no request.
- An item matched on several circles is kept only on the one where the
  reference radius is larger; within it, at the angle where the item sits
  closest to the rotated target.
- Items of a circle's pool that are not matches become that circle's
  background star field.
- A plane contributes only through the share of variance its two axes
  carry: for tail axes (a fraction of a percent each) the projection
  changes almost nothing, and a plane's pool then differs little from the
  unprojected one.