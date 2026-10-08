import numpy as np
from hyperwheel_recommender import SCHEMES
from hyperwheel_recommender.recommend import ANGLE_TOL_RAD, RADIUS_TOL_LOG
from hyperwheel_recommender.similarity import (
    high_similarity_outlier_indices, similarity_to_target,
)
from hyperwheel_recommender.starfield import plane_residual


def gate_counts(basis, ref_idx, plane, pool, scheme):
    """Pool items passing the angle/radius gate, per scheme angle."""
    i, j = plane[0] - 1, plane[1] - 1
    zi = basis.scores[:, i] / basis.pc_std[i]
    zj = basis.scores[:, j] / basis.pc_std[j]
    out = {}
    for a in SCHEMES[scheme]:
        t = np.radians(a)
        tx = np.cos(t) * zi[ref_idx] - np.sin(t) * zj[ref_idx]
        ty = np.sin(t) * zi[ref_idx] + np.cos(t) * zj[ref_idx]
        tr, ta = np.hypot(tx, ty), np.arctan2(ty, tx)
        d = np.abs(np.arctan2(zj[pool], zi[pool]) - ta) % (2 * np.pi)
        d = np.minimum(d, 2 * np.pi - d)
        r = np.abs(np.log(np.maximum(np.hypot(zi[pool], zj[pool]), 1e-6) / max(tr, 1e-6)))
        out[a] = int(((d <= ANGLE_TOL_RAD) & (r <= RADIUS_TOL_LOG)).sum())
    return out


def compare(basis, ref_idx, plane, scheme="triadic", z=2.3):
    X = basis.L[:, None] + basis.Q
    pc1 = basis.U[0]
    base = high_similarity_outlier_indices(
        similarity_to_target(X, X[ref_idx], pc1), ref_idx, z_threshold=z)
    R = plane_residual(basis, X, plane)
    proj = high_similarity_outlier_indices(
        similarity_to_target(R, R[ref_idx], pc1), ref_idx, z_threshold=z)
    jac = len(set(base) & set(proj)) / max(1, len(set(base) | set(proj)))
    print(f"plane={plane} base={len(base)} proj={len(proj)} jaccard={jac:.2f}")
    print("  base gate:", gate_counts(basis, ref_idx, plane, base, scheme))
    print("  proj gate:", gate_counts(basis, ref_idx, plane, proj, scheme))

from hyperwheel_recommender import build_taste_basis, load_input

wide = load_input("data/ml-latest/artifact.npz")
basis = build_taste_basis(wide, n_components=40, standardize=True)

ref_id = 2571  # The Matrix; items in the artifact are strings
ref_idx = basis.items.index(ref_id)

for plane in [(2, 3), (2, 4), (2, 5), (4, 8), (21, 33)]:
    compare(basis, ref_idx, plane, scheme="triadic", z=1.0)