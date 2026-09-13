<p align="center">
  <img src="brand/logo-lockup-on-dark.png" alt="Cinematic Hyperwheel" width="480">
</p>

# Cinematic-Hyperwheel

Experimental open-source project exploring **harmony beyond similarity** in movie recommendations.

Cinematic-Hyperwheel investigates whether principles behind harmonious color schemes — such as complementary, analogous, and triadic relationships — can be applied to a high-dimensional semantic representation of movies.

The project uses the **MovieLens Tag Genome** (currently sourced from the MovieLens Latest Dataset, `ml-latest`) to represent movies as points in a high-dimensional feature space, extracts the structure of that space using PCA, and applies controlled rotations in selected semantic planes to generate movies that are deliberately different from a reference while remaining structurally related to it.

---

## The idea

Traditional movie recommendation is largely based on **similarity**:

> "You liked this movie. Here is another movie that is similar to it."

Cinematic-Hyperwheel explores a different question:

> **"You liked this movie. What other movie could continue the experience while being genuinely different?"**

This distinction is important.

A viewer can highly appreciate two completely different movies without those movies being similar or otherwise related.

For example:

```text
Blade Runner       ★★★★★
Mimino             ★★★★★
```

A high rating for both films does not imply that they are "harmonious" with each other.

The project is interested in a different relationship:

```text
reference movie
       │
       │  deliberate change of direction
       ▼
different movie
       │
       └── preserves some structural relationship
           with the original experience
```

Informally:

> **different, but consonant**

or:

> **another point in cinematic space that resonates with the original point.**

---

## From color harmony to cinematic harmony

Color theory provides an interesting analogy.

Given a color, a color wheel can be used to select another color that is deliberately different while maintaining a particular geometric relationship with the original.

For example:

```text
        complementary

             ●
             │
             │
             │
             ●
          reference
```

The complementary color is not a similar color. It is almost the opposite direction on the color wheel.

Likewise, analogous and triadic schemes produce different colors while preserving specific angular relationships.

Cinematic-Hyperwheel asks:

> Can a similar operation be performed in the multidimensional space of movie characteristics?

The analogy is not intended to claim that movies literally have "colors". Instead, the project investigates whether **geometric relationships used to construct harmonious colors can be transferred to another domain.**



## Movie representation

The current experimental representation is based on the tag genome included in the **MovieLens Latest Dataset** (`ml-latest`, full).

Each movie is represented by its relevance to a common set of semantic tags.

Conceptually:

```
movie
  │
  ├── tag₁       → relevance
  ├── tag₂       → relevance
  ├── tag₃       → relevance
  │      ...
  └── tagₙ       → relevance
```

The relevance value is treated as a continuous feature value in `[0, 1]`.

A movie therefore becomes an N-dimensional vector:

```
movie = (x₁, x₂, ..., xₙ)
```

where each dimension corresponds to a semantic characteristic.

The tag genome shipped with `ml-latest` contains, per GroupLens' published
figures:

- ~14,000,000 tag-movie relevance scores
- ~1,100 unique tags
- movies covered by the genome are a subset of the full catalog (86,537
  movies in `movies.csv`) - exact counts depend on the specific `ml-latest`
  snapshot downloaded; see `docs/performance.md` for the numbers measured
  on the artifact actually in use, and `tools/filter_metadata_to_artifact.py`
  for how the searchable movie list is narrowed down to that subset.

This provides a common high-dimensional representation in which movies can be compared geometrically.

---

## Why not simply use the tag order as the geometry?

An early version of the project attempted to generalize the RGB → HSL transformation directly to an arbitrary number of channels.

That approach treated the channel order as part of the geometry:

```
tag₁ → tag₂ → tag₃ → ... → tagₙ
```

This is reasonable for RGB because the three channels have a physically meaningful relationship.

There is no equivalent physical ordering for arbitrary semantic movie tags.

For example:

```
romance
airplane
noir
aardman
...
```

There is no objective reason why one of these dimensions should be adjacent to another.

Changing the arbitrary ordering of the tags should not change the underlying cinematic representation.

Therefore the current model does **not** derive its geometry from tag ordering.

Instead:

> **The basis is extracted from the data itself.**

---

## From movie vectors to cinematic shape

For a movie represented by vector `c`:

### 1. Mean level

The mean of the movie's criteria is calculated:

```
L = mean(c)
```

This captures the overall level of the movie's tag profile.

It is analogous to the lightness component in HSL, although it is not semantically identical to color lightness.

---

### 2. Movie shape

The movie's individual profile is separated from its overall level:

```
Q = c - L
```

The components of `Q` always sum to zero:

```
sum(Q) = 0
```

Therefore `Q` lies in the subspace orthogonal to:

```
(1, 1, ..., 1)
```

This is analogous to separating the neutral component from the chromatic component in RGB.

---

### 3. Typical category profile

The shape of a movie is not meaningful only in isolation.

A category may have a characteristic profile shared by most of its movies.

Therefore the mean shape across the entire category is calculated:

```
M = mean(Q across all movies)
```

and removed:

```
Q' = Q - M
```

This step is important.

Without it, PCA can identify the structure shared by essentially all movies as the dominant direction, instead of identifying meaningful differences between movies.

---

## PCA: learning the cinematic coordinate system

After centering and standardization, PCA is applied to the movie shape vectors.

Conceptually:

```
Tag Genome
    │
    ▼
movie vectors
    │
    ▼
movie-level centering
    │
    ▼
category-profile centering
    │
    ▼
feature standardization
    │
    ▼
PCA / SVD
    │
    ▼
data-driven coordinate system
```

The resulting principal components describe the major directions of variation actually present in the category.

Unlike an arbitrary tag ordering, these directions are determined by the statistical structure of the data.

Each component can be inspected through:

- explained variance;
- feature weights;
- movies at the positive pole;
- movies at the negative pole.

This allows a component to be given a tentative semantic interpretation.

For example:

```
PC2

positive:
    noir
    crime
    detective
    urban

negative:
    comedy
    family
    romance
```

might suggest an interpretation such as:

> dark/noir ↔ light/family-oriented

The interpretation is empirical rather than predefined.

---

## Not every PCA component is a Hue axis

A principal component is not automatically suitable for cinematic rotation.

One important failure mode is a general **quality axis**.

For example, a component may represent a halo effect:

```
positive pole:
    many positively associated characteristics

negative pole:
    many negatively associated characteristics
```

Such an axis may primarily represent:

```
better ↔ worse
```

rather than:

```
one kind of movie ↔ another kind of movie
```

Rotating a reference movie along such an axis would tend to produce a better or worse version of the same type of movie.

That is not the goal.

Therefore Cinematic-Hyperwheel currently uses an explicit component selection mechanism:

```
--hue-components
```

The candidate components are first examined using diagnostic tools, including their feature weights and the movies located at their poles.

Only components that appear to represent meaningful differences in **character, style, or cinematic direction** are selected for rotation.

---

## Hue as a 2D semantic plane

The current model defines Hue not as a collection of hyperspherical angles, but as an angular position inside a selected two-dimensional PCA plane.

For selected components `i` and `j`:

```
             y
             ↑
             │
             │       ●
             │    /
             │  /
             │/
─────────────●────────────→ x
         reference
```

The coordinates in the selected plane can be represented in polar form:

```
r = distance from the origin
θ = angular position
```

The angular coordinate `θ` plays the role of Hue.

This is important because classical color schemes require a genuine circular coordinate:

```
analogous      → small angular displacement
triadic        → ±120°
complementary  → 180°
```

The selected PCA plane therefore provides the geometric equivalent of a color wheel.

---

## Whitening

PCA components generally have different amounts of variance.

For example:

```
PC2 → 50% of variance
PC3 → 7% of variance
```

A direct rotation of the raw coordinates would therefore treat unequal scales as though they were equivalent.

Before rotation, the selected coordinates are therefore whitened:

```
x' = x / σx
y' = y / σy
```

This transforms the local geometry from an ellipse-like scale into an approximately isotropic one.

The rotation can then be interpreted as an actual angular operation.

---

## Cinematic color schemes

Once a reference movie has been projected into the selected Hue plane, the system can apply an angular transformation.

For example:

### Analogous

```
θ' = θ ± 30°
```

A relatively small change of direction.

### Triadic

```
θ' = θ ± 120°
```

A substantially different direction with a fixed angular relationship.

### Complementary

```
θ' = θ + 180°
```

An opposite direction in the selected cinematic plane.

The important point is that these operations do **not** search for the nearest movie.

They deliberately move away from the reference along a chosen geometric direction.

---

## Delta reconstruction

The target movie is not reconstructed from scratch.

Instead, only the change introduced by the rotation is applied to the reference.

Conceptually:

```
reference
    │
    ▼
project into PCA space
    │
    ▼
rotate selected plane
    │
    ▼
calculate Δ
    │
    ▼
reference + Δ
    │
    ▼
target point
```

The non-rotated components remain unchanged.

This preserves as much of the original movie's structure as possible while changing its direction in the selected Hue plane.

The result is a target point in the continuous feature space.

It will generally not correspond exactly to an existing movie.

---

## Finding a real movie

The final step is therefore a nearest-neighbor search.

Given a target point `t`, the system searches the movie catalog for:

```
movie* = argmin distance(movie, t)
```

The result is a real movie whose feature representation is closest to the geometrically generated target.

Thus the overall process is:

```
reference movie
       │
       ▼
high-dimensional representation
       │
       ▼
PCA coordinate system
       │
       ▼
selected Hue plane
       │
       ▼
whitening
       │
       ▼
color-scheme rotation
       │
       ▼
delta reconstruction
       │
       ▼
target point
       │
       ▼
nearest real movie
```

---

## Empirical analysis

A major part of the project is the empirical examination of the PCA space.

For each experimental movie category, the principal components are examined individually:

```
PC1
PC2
PC3
PC4
...
```

For each component, the analysis considers:

- explained variance;
- strongest positive feature weights;
- strongest negative feature weights;
- movies at both poles;
- possible semantic interpretation;
- suitability for Hue rotation.

The objective is not simply to select the components with the largest explained variance.

A component explaining 40% of the variance is not necessarily a better Hue axis than one explaining 8%.

The important question is:

> **What kind of difference does this component represent?**

This analysis is intentionally partly manual.

It is used both to validate the hypothesis and to understand what the learned cinematic space actually contains.

---

## Experimental recommendation schemes

For a selected reference movie, the system can generate recommendations using different angular transformations:

```
                         analogous
                         +30°
                           ●

                           │

complementary 180°  ●──────●──────●  reference

                           │

                           ●
                         -30°
                         analogous
```

The exact interpretation of each scheme is an experimental question.

The project investigates whether different angular relationships consistently produce recommendations that are:

1. different from the reference;
2. structurally related to the reference;
3. qualitatively distinguishable from ordinary similarity recommendations.

---

## Web application

The project also includes a web application intended as a practical interface for the experimental model.
A reference instance is deployed at [omltp.com](https://omltp.com) under the name "One More Like This" -
see `apps/web/README.md` for setup and architecture.

The basic interaction is:

```
Select a reference movie
          │
          ▼
Select a harmony scheme
          │
          ▼
Generate recommendations
          │
          ▼
Explore the resulting collection
```

The web application is not intended to replace the mathematical experiments.

Its purpose is to make the model tangible and allow the generated recommendations to be explored as actual movie collections.

---

## Research questions

The project currently investigates several related questions:

### RQ1

Can a high-dimensional semantic representation of movies provide a meaningful geometric space for recommendation?

### RQ2

Can PCA components of such a space be interpreted as meaningful cinematic dimensions?

### RQ3

Can suitable PCA planes be used as data-driven analogues of a color wheel?

### RQ4

Does angular rotation in such a plane produce recommendations that are meaningfully different from the reference?

### RQ5

Can different color-inspired angular schemes produce qualitatively different types of recommendations?

### RQ6

Do these recommendations exhibit the intended property of **harmony beyond similarity**?

---

## Current limitations

The project is experimental and several questions remain open.

### Manual Hue-component selection

The selection of suitable PCA components currently requires manual interpretation.

Automatic identification of quality-related components may be possible using independent ratings or other external signals.

### Category dependence

The PCA basis is learned from a particular movie category.

Changing the category or dataset can therefore change the resulting coordinate system.

This may be a limitation, or it may be an important property of the model.

### Two-dimensional rotation

The current implementation rotates exactly one pair of PCA components.

If cinematic taste requires several independent dimensions simultaneously, a more general multi-plane rotation scheme may be necessary.

### Nearest-neighbor discretization

The geometric target is continuous, but the movie catalog is discrete.

The final recommendation therefore depends on the distribution of actual movies around the generated target.

### Harmony is still a hypothesis

The mathematical transformation can be defined precisely.

Whether the resulting movies are actually perceived by humans as "harmonious" or "resonant" with the reference is an empirical question.

This project therefore treats **harmony beyond similarity as a hypothesis to be tested**, not as an established property of the model.

---

## Project status

The project is currently in the experimental research and prototype stage.

The repository contains:

- the mathematical implementation;
- Tag Genome data preparation utilities;
- experimental channel sets;
- PCA and diagnostic experiments;
- tests;
- documentation of the mathematical model;
- the web application prototype.

The project is being developed with reproducibility and experimentation in mind.

---

## Repository structure

```
Cinematic-Hyperwheel/
│
├── packages/
│   └── hyperwheel-recommender/   ← reusable research / recommendation engine
│       ├── docs/               ← packlage documentation
│       ├── src/
│       └── tests/
│
├── apps/                       
│   └── web/                    ← recommendation web app (reference instance: omltp.com)
│       ├── backend/
│       ├── frontend/
│       └── tests/
│
├── tools/                      ← data / development utilities
│
├── experiments/                ← research experiments
│
├── data/                       ← local datasets
│
└── docs/                       ← project documentation
```

The exact structure may evolve as the research progresses.

---

## Data

### MovieLens Latest Dataset (`ml-latest`, full)

Cinematic-Hyperwheel uses the **MovieLens Latest Dataset** (`ml-latest`,
full version) released by the GroupLens Research Group at the University
of Minnesota.

Of the six files GroupLens ships in `ml-latest`
(`genome-scores.csv`, `genome-tags.csv`, `links.csv`, `movies.csv`,
`ratings.csv`, `tags.csv`), this project uses exactly three:

* `movies.csv` (`movieId,title,genres`) - the movie catalog behind
  search and the movie card. Filtered down to the subset that has tag
  genome data before being used by the web app (see
  `tools/filter_metadata_to_artifact.py`).
* `genome-scores.csv` (`movieId,tagId,relevance`) and `genome-tags.csv`
  (`tagId,tag`) - together, the tag genome: relevance values for each
  (movie, tag) pair on a continuous `[0, 1]` scale. This is the input to
  the PCA basis (see `hyperwheel_recommender build`).

`ratings.csv`, `tags.csv`, and `links.csv` are **not used** by this
project.

* **Dataset:** [MovieLens Latest Datasets — GroupLens](https://grouplens.org/datasets/movielens/latest/)
* **Download and usage terms:** [ml-latest README](https://files.grouplens.org/datasets/movielens/ml-latest-README.html)
* **Required citations** (per the `ml-latest` README's Usage License -
  see the full terms there, summarized in the License section below):
    [Harper and Konstan, 2015] F. Maxwell Harper and Joseph A. Konstan. 2015. The MovieLens Datasets: History and Context. ACM Transactions on Interactive Intelligent Systems (TiiS) 5, 4: 19:1–19:19. https://doi.org/10.1145/2827872
    [Vig et al., 2012] Vig, J., Sen, S., and Riedl, J. (2012). The tag genome: Encoding community knowledge to support novel interaction. ACM Trans. Interact. Intell. Syst., 2(3):13:1–13:44. https://doi.org/10.1145/2362394.2362395

The dataset is used in accordance with the usage terms specified by
GroupLens (see License below for the specific conditions). The dataset
itself is not redistributed with this repository; users should obtain it 
directly from the official GroupLens source.

### TMDB API

The web application (`apps/web`) optionally also uses
[TMDB](https://www.themoviedb.org/) for a decorative movie backdrop -
see `apps/web/README.md` for setup and attribution. TMDB is not used
by the recommendation engine itself.

---

## Disclaimer

### Recommendations are algorithmic, not editorial

The movies this project surfaces as "recommendations" are not editorial
or curatorial picks. Each one is the output of a purely geometric,
mathematical procedure - a rotation within a PCA-derived plane followed
by a nearest-neighbor search (see [Cinematic color schemes](#cinematic-color-schemes)
and [Finding a real movie](#finding-a-real-movie) above) - reflecting
proximity in a data-driven vector space, not a judgment about a movie's
quality, nor a claim that the author has seen, endorses, or is actually
recommending that anyone watch it.

Schemes with a large angular offset from the reference - triadic and
tetradic in particular - deliberately move far from the reference's own
profile and can surface movies that share little with it beyond an
abstract geometric relationship; results can be surprising. Complementary,
which rotates a full 180°, can be especially jarring, since it targets
the opposite end of a semantic axis on purpose. Use these schemes with
that in mind.

This project exists for entertainment and experimentation. It is not
intended, and should not be relied upon, as guidance for what to watch.

### No warranty, no liability

This software, and any output it produces, is provided "AS IS", without
warranty of any kind, express or implied, including but not limited to
warranties of merchantability, fitness for a particular purpose,
accuracy, or non-infringement. Use of this project, any instance of it,
and any content it surfaces is entirely at your own risk.

To the maximum extent permitted by applicable law, the author(s) and
contributors disclaim all liability for any direct, indirect,
incidental, special, consequential, or other damages arising from or
related to the use of, or inability to use, this project or any content
it suggests. This section supplements, and does not limit, the warranty
disclaimer already included in the AGPL-3.0-or-later license below.

---

## License

The Cinematic-Hyperwheel source code is licensed under the
**GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)**.

See [LICENSE.md](LICENSE.md) for the full license text.

This license applies to the source code developed as part of this
repository. Third-party datasets, libraries, models, and other external
materials are **not covered by this license** and remain subject to their
respective licenses and terms of use.

In particular, the MovieLens Latest Dataset (`ml-latest`) used in the
experiments is provided by the GroupLens Research Group and is subject
to its own Usage License (full text:
[ml-latest README](https://files.grouplens.org/datasets/movielens/ml-latest-README.html#usage-license)).

See [Data](#Data) for information about datasets and other
external resources used by the project.
