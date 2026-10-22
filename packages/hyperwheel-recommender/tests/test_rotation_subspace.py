"""Varimax rotation must keep the exact-identity machinery valid."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from hyperwheel_recommender import build_feature_basis, rotate_groups


@pytest.fixture(scope="module")
def basis():
    rng = np.random.default_rng(0)
    wide = pd.DataFrame(
        rng.random((300, 12)),
        index=pd.Index([str(i) for i in range(300)], name="item"),
        columns=pd.Index([f"tag{i}" for i in range(12)], name="criteria"),
    )
    return build_feature_basis(wide, n_components=12)


def test_rotation_keeps_basis_orthonormal(basis):
    rotated = rotate_groups(basis, [(3, 6), (8, 11)])
    assert np.allclose(rotated.U @ rotated.U.T, np.eye(rotated.U.shape[0]), atol=1e-5)


def test_rotation_keeps_scores_consistent(basis):
    rotated = rotate_groups(basis, [(3, 6)])
    assert np.allclose(rotated.scores, rotated.Phi @ rotated.U.T, atol=1e-4)


def test_rotation_preserves_group_variance_and_leaves_rest(basis):
    rotated = rotate_groups(basis, [(3, 6)])
    assert rotated.explained[2:6].sum() == pytest.approx(basis.explained[2:6].sum(), rel=1e-4)
    assert np.array_equal(rotated.U[:2], basis.U[:2])
    assert np.array_equal(rotated.U[6:], basis.U[6:])


def test_invalid_groups_are_rejected(basis):
    with pytest.raises(ValueError):
        rotate_groups(basis, [(1, 4)])          # PC1 is never rotated
    with pytest.raises(ValueError):
        rotate_groups(basis, [(3, 6), (5, 8)])  # overlap