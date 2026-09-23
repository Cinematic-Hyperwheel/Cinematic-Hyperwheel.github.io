"""
Shared fixtures for the recommendation regression suite.

This suite runs against a real, already-built artifact (see
`hyperwheel_recommender build`) rather than synthetic data, so it can
catch behavioural regressions in the actual recommendation pipeline
(Stage A/B selection, plane rotation, starfield sizing) on real items.
Configuration lives in settings.py; every test here is skipped unless
the resolved artifact path (settings.ARTIFACT_PATH) actually exists.
"""

from __future__ import annotations

import csv

import pytest

from hyperwheel_recommender import SCHEMES, TasteBasis, build_taste_basis, load_input

from . import planes_config, settings


@pytest.fixture(scope="session")
def artifact_path() -> str:
    if not settings.ARTIFACT_PATH.exists():
        pytest.skip(
            f"No artifact at {settings.ARTIFACT_PATH} - the recommendation "
            f"regression suite needs a real, already-built artifact to run "
            f"against. Set HYPERWHEEL_ARTIFACT_PATH or HYPERWHEEL_DATA_DIR."
        )
    return str(settings.ARTIFACT_PATH)


@pytest.fixture(scope="session")
def wide(artifact_path: str):
    return load_input(artifact_path)


@pytest.fixture(scope="session")
def basis(wide) -> TasteBasis:
    return build_taste_basis(wide, n_components=settings.N_COMPONENTS, standardize=settings.STANDARDIZE)


@pytest.fixture(scope="session")
def circles(basis: TasteBasis) -> list[tuple[int, int]]:
    """The hue-plane pairs ('circles') checked by these tests - every
    recommendation circle a reference item can actually show on the
    wheel, so 'present in some circle' matches what a user would see."""
    return planes_config.load_circles(max_component=basis.U.shape[0])


@pytest.fixture(scope="session")
def default_schemes() -> list[str]:
    """Fallback scheme list for golden pairs that don't set their own
    `scheme` column."""
    return list(SCHEMES)


@pytest.fixture(scope="session")
def top_k() -> int:
    return settings.TOP_K


@pytest.fixture(scope="session")
def shortlist_size() -> int:
    return settings.SHORTLIST_SIZE


@pytest.fixture(scope="session")
def starfield_max_size() -> int:
    return settings.STARFIELD_MAX_SIZE


def load_golden_pairs() -> list[dict]:
    """Reads the reference/expected-recommendation pairs maintained by
    hand for regression tracking. A blank reference_item, or one
    starting with '#', is treated as a comment row. reference_item and
    expected_recommendation are parsed as int, matching movieId's type
    throughout the pipeline (see cli.py's --item, type=int). `scheme`,
    if given, restricts the check to that single scheme (fast -
    recommend_many_planes is called once per pair instead of once per
    configured scheme); left blank, the pair falls back to
    `default_schemes`."""
    path = settings.GOLDEN_FILE
    if not path.exists():
        return []
    rows: list[dict] = []
    with path.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            ref_raw = (row.get("reference_item") or "").strip()
            if not ref_raw or ref_raw.startswith("#"):
                continue
            expected_raw = (row.get("expected_recommendation") or "").strip()
            if not expected_raw:
                raise ValueError(
                    f"{path}: row for reference_item={ref_raw!r} has no "
                    f"expected_recommendation value."
                )
            try:
                reference_item = int(ref_raw)
                expected_recommendation = int(expected_raw)
            except ValueError as exc:
                raise ValueError(
                    f"{path}: reference_item and expected_recommendation "
                    f"must be integers (movieId) - got "
                    f"reference_item={ref_raw!r}, "
                    f"expected_recommendation={expected_raw!r}."
                ) from exc
            scheme = (row.get("scheme") or "").strip()
            if scheme and scheme not in SCHEMES:
                raise ValueError(
                    f"{path}: row for reference_item={ref_raw!r} has unknown "
                    f"scheme {scheme!r}. Available: {list(SCHEMES)}"
                )
            rows.append({
                "reference_item": reference_item,
                "expected_recommendation": expected_recommendation,
                "scheme": scheme,
                "notes": (row.get("notes") or "").strip(),
            })
    return rows


def pytest_generate_tests(metafunc: pytest.Metafunc) -> None:
    if "golden_pair" in metafunc.fixturenames:
        pairs = load_golden_pairs()
        if not pairs:
            metafunc.parametrize(
                "golden_pair",
                [pytest.param(None, marks=pytest.mark.skip(
                    reason="no golden pairs configured in data/recommendation_pairs.csv"
                ))],
                ids=["no-golden-pairs-configured"],
            )
        else:
            metafunc.parametrize(
                "golden_pair", pairs,
                ids=[f"{p['notes']} [{p['reference_item']}->{p['expected_recommendation']}]" for p in pairs],
            )

    if "starfield_case" in metafunc.fixturenames:
        references = sorted({p["reference_item"] for p in load_golden_pairs()})
        if not references:
            metafunc.parametrize(
                "starfield_case",
                [pytest.param(None, marks=pytest.mark.skip(
                    reason="no golden pairs configured in data/recommendation_pairs.csv"
                ))],
                ids=["no-golden-pairs-configured"],
            )
        else:
            metafunc.parametrize("starfield_case", references, ids=[str(r) for r in references])