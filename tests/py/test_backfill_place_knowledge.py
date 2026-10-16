"""scripts/backfill_place_knowledge.py: plan by default, build only with
--apply and only once places.placeKnowledge exists (#277)."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

from py import _place_knowledge as pk

SPEC = importlib.util.spec_from_file_location(
    "backfill_place_knowledge", Path(__file__).resolve().parents[2] / "scripts" / "backfill_place_knowledge.py")
bf = importlib.util.module_from_spec(SPEC)
sys.modules["backfill_place_knowledge"] = bf
SPEC.loader.exec_module(bf)


def _doc(i, country="ZW"):
    d = {"_id": f"pg-{i}", "name": f"Town {i}", "geoType": "town",
         "geo": {"type": "Point", "coordinates": [31.0 + i, -17.0]},
         "sourceProvenance": {"mukokoProvince": "Harare", "mukokoElevation": 1400}}
    if country:
        d["isoCode"] = country
    return d


def _coll(docs):
    coll = MagicMock()
    coll.find.return_value = docs
    return coll


def test_candidates_shape_and_filter():
    coll = _coll([_doc(1), {"_id": "bad", "geo": {}}])
    with patch.object(bf, "places_geo_collection", return_value=coll), \
         patch.object(bf, "get_country_id", return_value="zw-parent"):
        places = list(bf.candidates("zw"))
    assert places == [{"id": "pg-1", "collection": "placesGeo", "name": "Town 1", "lat": -17.0,
                       "lon": 32.0, "country": "ZW", "admin1": "Harare", "elevation": 1400}]
    # Platform-seeded places have no isoCode: their country is the parent document.
    assert coll.find.call_args.args[0]["$or"] == [{"isoCode": "ZW"}, {"parentPlaceId": "zw-parent"}]


def test_country_comes_from_the_parent_place_when_isocode_is_missing():
    seeded = _doc(7, country=None)
    seeded["parentPlaceId"] = "zw-parent"
    with patch.object(bf, "places_geo_collection", return_value=_coll([seeded])), \
         patch.object(bf, "get_country_iso", return_value="zw") as iso:
        places = list(bf.candidates())
    iso.assert_called_once_with("zw-parent")
    assert places[0]["country"] == "ZW"


def test_plan_builds_nothing():
    with patch.object(bf, "places_geo_collection", return_value=_coll([_doc(1), _doc(2)])), \
         patch.object(pk, "collection_ready", return_value=True), \
         patch.object(pk, "read_knowledge", return_value=None), \
         patch.object(pk, "build_and_store") as build:
        summary = bf.run(apply=False, limit=10, country=None, sleep_s=0)
    build.assert_not_called()
    assert summary["seen"] == 2 and summary["to_build"] == 2 and summary["built"] == 0


def test_apply_before_the_collection_exists_writes_nothing():
    with patch.object(bf, "places_geo_collection", return_value=_coll([_doc(1)])), \
         patch.object(pk, "collection_ready", return_value=False), \
         patch.object(pk, "build_and_store") as build:
        summary = bf.run(apply=True, limit=10, country=None, sleep_s=0)
    build.assert_not_called()
    assert summary["collection_ready"] is False and summary["built"] == 0


def test_apply_respects_limit_and_skips_fresh_and_countryless():
    docs = [_doc(1), _doc(2), _doc(3), _doc(4, country=None)]

    def read(place_id):
        return {"refreshAfter": {"soil": "x"}} if place_id == "pg-1" else None

    with patch.object(bf, "places_geo_collection", return_value=_coll(docs)), \
         patch.object(pk, "collection_ready", return_value=True), \
         patch.object(pk, "read_knowledge", side_effect=read), \
         patch.object(pk, "is_stale", return_value=False), \
         patch.object(pk, "build_and_store", return_value={"_stored": True}) as build:
        summary = bf.run(apply=True, limit=1, country=None, sleep_s=0)
    assert build.call_count == 1  # pg-1 is fresh, pg-2 is built, pg-3 is over the limit
    assert summary["built"] == 1 and summary["to_build"] == 2 and summary["skipped_no_country"] == 1
