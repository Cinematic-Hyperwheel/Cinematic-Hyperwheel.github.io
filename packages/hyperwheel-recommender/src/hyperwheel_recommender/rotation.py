"""
Color-wheel schemes (complementary/triadic/...) and hue-vector rotation.

Growth point: an inversion (y -> -y) is planned for complementary in the
full dimensionality instead of a single plane, and an adaptive
(per-reference) plane for triadic/analogous — see /docs/math.md, section 7.
"""

from __future__ import annotations

import numpy as np

# Angles are offsets from the reference, so a scheme's name counts the
# reference too: triadic = reference + two targets at +-120 degrees.
SCHEMES: dict[str, list[float]] = {
    "complementary": [180.0],
    "triadic": [120.0, -120.0],
    "analogous": [30.0, -30.0],
    "wide-analogous": [60.0, -60.0],
    "split-complementary": [150.0, -150.0],
    "square": [90.0, 180.0, -90.0],
    "monochromatic": [0.0],
}


def rotate_whitened(
    y: np.ndarray, pc_std: np.ndarray, theta_rad: float, plane: tuple[int, int] = (0, 1)
) -> np.ndarray:
    """
    Rotation in 'whitened' coordinates for the chosen pair of components
    (plane), normalized by the actual spread of items along each of them.
    Without this, if one component explains far more variance than the
    other, the rotation pushes the target into a direction where hardly
    any real items exist. Whitening makes the angle comparable in terms of
    'typical prevalence' along both axes, rather than by raw vector length.

    plane: indices (i, j) of the components that form the hue plane - e.g.
    (1, 2) to NOT rotate PC1 (if it turns out to be a "quality" axis rather
    than "taste"), and work only with PC2/PC3. Any other components are
    left untouched.
    """
    y = y.copy()
    i, j = plane
    z_i, z_j = y[i] / pc_std[i], y[j] / pc_std[j]
    c_, s_ = np.cos(theta_rad), np.sin(theta_rad)
    z_i_new = c_ * z_i - s_ * z_j
    z_j_new = s_ * z_i + c_ * z_j
    y[i] = z_i_new * pc_std[i]
    y[j] = z_j_new * pc_std[j]
    return y