"""Decision vectors shared with the Rust places Worker.

``tests/fixtures/places-contract.json`` is loaded by this file and by
``workers/crates/weather-core/src/place_search.rs``. Python is the reference
until it is deleted (mukoko-weather#148): if a vector changes, change both.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from py import _locations as loc
from py._seed_locations import nearest_seed, seed_matching

FIXTURE = json.loads(
    (Path(__file__).resolve().parents[1] / "fixtures" / "places-contract.json").read_text(encoding="utf-8")
)


@pytest.mark.parametrize("case", FIXTURE["area_features"], ids=lambda c: repr(c["code"]))
def test_area_features(case):
    assert loc.is_area_feature(case["code"]) is case["area"]


@pytest.mark.parametrize("case", FIXTURE["geocode_fetch_count"], ids=lambda c: str(c["wanted"]))
def test_geocode_fetch_count(case):
    assert loc._geocode_fetch_count(case["wanted"]) == case["count"]


@pytest.mark.parametrize("case", FIXTURE["seed_matching"], ids=lambda c: c["name"])
def test_seed_matching(case):
    got = seed_matching(case["name"], case["lat"], case["lon"], max_km=25.0)
    assert (got["slug"] if got else None) == case["slug"]


@pytest.mark.parametrize("case", FIXTURE["nearest_seed"], ids=lambda c: f"{c['lat']},{c['lon']}")
def test_nearest_seed(case):
    got = nearest_seed(case["lat"], case["lon"], max_km=case["max_km"])
    assert (got["slug"] if got else None) == case["slug"]


# `resolve_bare_name` arrives with mukoko-weather#318; until it is on this
# branch these vectors are asserted by the Rust side only.
@pytest.mark.skipif(not hasattr(loc, "_name_similarity"), reason="needs #318 (mode=resolve)")
@pytest.mark.parametrize("case", FIXTURE["similarity"], ids=lambda c: f"{c['a']}|{c['b']}")
def test_similarity(case):
    assert loc._name_similarity(case["a"], case["b"]) == pytest.approx(case["ratio"])
