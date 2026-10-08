import numpy as np
from hyperwheel_recommender import SCHEMES, build_taste_basis, load_input
from hyperwheel_recommender.recommend import ANGLE_TOL_RAD, RADIUS_TOL_LOG
from hyperwheel_recommender.similarity import (
    high_similarity_outlier_indices, similarity_to_target,
)
from hyperwheel_recommender.starfield import plane_residual

def sector_diag(basis, ref_idx, plane, pool, scheme="triadic"):
    i, j = plane[0] - 1, plane[1] - 1
    zi = basis.scores[:, i] / basis.pc_std[i]
    zj = basis.scores[:, j] / basis.pc_std[j]
    catalog = np.setdiff1d(np.arange(len(zi)), [ref_idx])
    print(f"plane={plane} ref radius={np.hypot(zi[ref_idx], zj[ref_idx]):.2f}")
    for a in SCHEMES[scheme]:
        t = np.radians(a)
        tx = np.cos(t) * zi[ref_idx] - np.sin(t) * zj[ref_idx]
        ty = np.sin(t) * zi[ref_idx] + np.cos(t) * zj[ref_idx]
        tr, ta = np.hypot(tx, ty), np.arctan2(ty, tx)
        for name, idx in (("catalog", catalog), ("pool", np.asarray(pool))):
            d = np.abs(np.arctan2(zj[idx], zi[idx]) - ta) % (2 * np.pi)
            d = np.minimum(d, 2 * np.pi - d)
            r = np.abs(np.log(np.maximum(np.hypot(zi[idx], zj[idx]), 1e-6) / max(tr, 1e-6)))
            ang, rad = d <= ANGLE_TOL_RAD, r <= RADIUS_TOL_LOG
            print(f"  {a:+.0f}° {name:7s} n={len(idx):5d} angle_ok={ang.sum():5d} "
                  f"radius_ok={rad.sum():5d} both={(ang & rad).sum():4d}")

wide = load_input("data/ml-latest/artifact.npz")
basis = build_taste_basis(wide, n_components=40, standardize=True)
ref_idx = basis.items.index(2571)   # use the same reference as in compare()

X = basis.L[:, None] + basis.Q
pc1 = basis.U[0]

for plane in [(21, 33), (2, 3)]:
    R = plane_residual(basis, X, plane)
    pool = high_similarity_outlier_indices(
        similarity_to_target(R, R[ref_idx], pc1), ref_idx, z_threshold=1.0)
    sector_diag(basis, ref_idx, plane, pool)