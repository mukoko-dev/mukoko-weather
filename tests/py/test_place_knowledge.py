"""Tests for _place_knowledge.py — the stored per-place knowledge profile (#277).

Covers:
  * Köppen–Geiger from monthly normals (published climatologies)
  * USDA texture triangle, SoilGrids parsing and its breaker
  * Seasons: country calendar (seed vs AI), derived defaults, current/next
  * Astronomy: day length and the trend
  * Building: provenance on every fact group, refresh dates, the validator's
    required fields, no soil for bare spots, cache-only builds make no call
  * Storage: no write until the collection exists, never without a country,
    upsert by the place's _id
  * Reading: fresh stored doc served, stale doc rebuilt (or served while a
    background build runs for AI callers), spots reuse a neighbour cell
  * The AI prompt block: size, ~ markers, no crops without a calendar
  * The endpoint: input validation and 404
"""

from __future__ import annotations

import datetime as dt
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from py import _place_knowledge as pk


def _monthly(temps, precs):
    return [
        {"month": i + 1, "meanTempC": t, "meanHighC": t + 5, "meanLowC": t - 5,
         "precipMm": p, "rainyDays": round(p / 10)}
        for i, (t, p) in enumerate(zip(temps, precs))
    ]


LONDON = _monthly([5.2, 5.3, 7.6, 9.9, 13.3, 16.5, 18.7, 18.5, 15.7, 12.0, 8.0, 5.5],
                  [55, 41, 42, 44, 49, 45, 45, 50, 49, 69, 59, 55])
BANGKOK = _monthly([27, 28.3, 29.5, 30.5, 30, 29.5, 29, 28.8, 28.4, 28.1, 27.6, 26.4],
                   [13, 20, 42, 91, 248, 256, 242, 280, 350, 288, 62, 7])
HARARE = _monthly([21, 21, 20, 18.5, 16, 14, 13.5, 16, 19, 21.5, 21.5, 21],
                  [190, 170, 97, 40, 10, 3, 1, 3, 7, 30, 95, 180])
CAIRO = _monthly([14, 15.3, 18, 21.5, 25, 27.5, 28, 28, 26.5, 23.5, 19.5, 15.5],
                 [5, 4, 3, 1, 0, 0, 0, 0, 0, 1, 3, 5])
MOSCOW = _monthly([-6.5, -6.7, -1, 6, 13, 17, 19, 17, 11, 5, -1, -5],
                  [52, 41, 35, 37, 49, 80, 85, 82, 67, 64, 51, 51])
SINGAPORE = _monthly([26.5, 27.1, 27.5, 28, 28.3, 28.3, 27.9, 27.9, 27.6, 27.6, 27, 26.4],
                     [234, 115, 170, 154, 171, 130, 157, 172, 131, 159, 250, 274])
TUNDRA = _monthly([-28, -27, -25, -17, -6, 2, 7, 6, 0, -9, -19, -25],
                  [10, 10, 10, 10, 10, 15, 25, 25, 20, 15, 10, 10])


class TestKoppen:
    @pytest.mark.parametrize("monthly,lat,code", [
        (LONDON, 51.5, "Cfb"),
        (BANGKOK, 13.75, "Aw"),
        (HARARE, -17.83, "Cwb"),
        (CAIRO, 30.0, "BWh"),
        (MOSCOW, 55.75, "Dfb"),
        (SINGAPORE, 1.35, "Af"),
        (TUNDRA, 70.0, "ET"),
    ])
    def test_reference_climates(self, monthly, lat, code):
        assert pk.derive_koppen(monthly, lat) == code
        assert code in pk.KOPPEN_LABELS

    def test_needs_twelve_complete_months(self):
        assert pk.derive_koppen(LONDON[:11], 51.5) is None
        broken = [dict(m) for m in LONDON]
        broken[3]["precipMm"] = None
        assert pk.derive_koppen(broken, 51.5) is None
        assert pk.derive_koppen(None, 0) is None


class TestTexture:
    @pytest.mark.parametrize("sand,silt,clay,expected", [
        (92, 5, 3, "sand"),
        (82, 12, 6, "loamy sand"),
        (65, 25, 10, "sandy loam"),
        (40, 40, 20, "loam"),
        (20, 65, 15, "silt loam"),
        (5, 88, 7, "silt"),
        (60, 15, 25, "sandy clay loam"),
        (32, 34, 34, "clay loam"),
        (10, 56, 34, "silty clay loam"),
        (50, 10, 40, "sandy clay"),
        (5, 45, 50, "silty clay"),
        (20, 20, 60, "clay"),
    ])
    def test_usda_triangle(self, sand, silt, clay, expected):
        assert pk.texture_class(sand, silt, clay) == expected


def _soil_client(cls_payload, props_payload):
    client = MagicMock()
    cls_resp, props_resp = MagicMock(), MagicMock()
    cls_resp.json.return_value = cls_payload
    props_resp.json.return_value = props_payload
    client.get.side_effect = [cls_resp, props_resp]
    return client


def _layer(name, values):
    depths = [{"label": lbl, "values": {"mean": v}} for lbl, v in zip(("0-5cm", "5-15cm", "15-30cm"), values)]
    return {"name": name, "unit_measure": {"d_factor": 10}, "depths": depths}


class TestSoil:
    def test_parses_class_and_texture(self):
        client = _soil_client(
            {"wrb_class_name": "Lixisols", "wrb_class_probability": [["Lixisols", 22]]},
            {"properties": {"layers": [_layer("clay", [200, 220, 260]), _layer("sand", [600, 580, 540]),
                                       _layer("silt", [200, 200, 200])]}},
        )
        with patch.object(pk, "_get_soil_http", return_value=client):
            soil = pk.fetch_soil(-17.83, 31.05)
        assert soil.wrbClass == "Lixisols" and soil.wrbProbability == 22
        assert soil.texture == "sandy clay loam"
        assert soil.depth == "0-30cm"

    def test_null_fractions_keep_the_class(self):
        client = _soil_client(
            {"wrb_class_name": "Cambisols", "wrb_class_probability": [["Cambisols", 18]]},
            {"properties": {"layers": [_layer("clay", [None, None, None])]}},
        )
        with patch.object(pk, "_get_soil_http", return_value=client):
            soil = pk.fetch_soil(51.5, -0.1)
        assert soil.wrbClass == "Cambisols" and soil.texture is None

    def test_failure_records_on_the_breaker(self):
        client = MagicMock()
        client.get.side_effect = RuntimeError("504")
        with patch.object(pk, "_get_soil_http", return_value=client), \
             patch.object(pk.soilgrids_breaker, "record_failure") as failed:
            assert pk.fetch_soil(0, 0) is None
        failed.assert_called_once()

    def test_open_breaker_makes_no_call(self):
        with patch.object(type(pk.soilgrids_breaker), "is_allowed", new=property(lambda self: False)), \
             patch.object(pk, "_get_soil_http") as http:
            assert pk.fetch_soil(0, 0) is None
        http.assert_not_called()


ZW_SEASONS = [
    {"countryCode": "ZW", "name": "Main rains", "localName": "Masika", "months": [11, 12, 1, 2, 3], "description": "Flooding"},
    {"countryCode": "ZW", "name": "Short rains", "localName": "Munakamwe", "months": [4], "description": "Harvest"},
    {"countryCode": "ZW", "name": "Cool dry", "localName": "Chirimo", "months": [5, 6, 7, 8], "description": "Frost"},
    {"countryCode": "ZW", "name": "Hot dry", "localName": "Zhizha", "months": [9, 10], "description": "Heat"},
]


def _seasons_db(docs):
    db = MagicMock()
    db.__getitem__.return_value.find.return_value = docs
    return db


class TestSeasons:
    def test_country_calendar_is_seed_and_verified(self):
        with patch.object(pk, "get_db", return_value=_seasons_db(ZW_SEASONS)):
            seasons = pk._country_seasons("zw")
        assert seasons.source == "seed" and seasons.verified
        assert [s.name for s in seasons.calendar] == ["Short rains", "Cool dry", "Hot dry", "Main rains"]  # by start month

    def test_ai_rows_are_unverified(self):
        docs = [dict(d, source="ai", verified=False) for d in ZW_SEASONS]
        with patch.object(pk, "get_db", return_value=_seasons_db(docs)):
            seasons = pk._country_seasons("ZW")
        assert seasons.source == "ai" and not seasons.verified

    def test_unknown_country_or_db_error(self):
        with patch.object(pk, "get_db", return_value=_seasons_db([])):
            assert pk._country_seasons("GB") is None
        with patch.object(pk, "get_db", side_effect=RuntimeError("down")):
            assert pk._country_seasons("ZW") is None

    def test_current_and_next(self):
        with patch.object(pk, "get_db", return_value=_seasons_db(ZW_SEASONS)):
            seasons = pk._country_seasons("ZW")
        now, nxt = pk.season_now(seasons, dt.date(2026, 10, 11))
        assert (now.name, now.localName) == ("Hot dry", "Zhizha")
        assert (nxt.name, nxt.startsOn) == ("Main rains", "2026-11-01")

    def test_next_season_wraps_the_year(self):
        with patch.object(pk, "get_db", return_value=_seasons_db(ZW_SEASONS)):
            seasons = pk._country_seasons("ZW")
        now, nxt = pk.season_now(seasons, dt.date(2026, 12, 20))
        assert now.name == "Main rains"
        assert (nxt.name, nxt.startsOn) == ("Short rains", "2027-04-01")

    def test_derived_tropical_wet_and_dry(self):
        seasons = pk.derived_seasons(-17.8, HARARE)
        assert seasons.source == "derived" and not seasons.verified
        wet = next(s for s in seasons.calendar if s.name == "Wet season")
        assert wet.months == [11, 12, 1, 2, 3]

    def test_derived_temperate_meteorological(self):
        north = pk.derived_seasons(51.5, LONDON)
        assert {s.name: s.months for s in north.calendar}["Summer"] == [6, 7, 8]
        south = pk.derived_seasons(-34.6, None)
        assert {s.name: s.months for s in south.calendar}["Summer"] == [12, 1, 2]

    def test_always_wet_tropics_fall_back_to_one_wet_season(self):
        seasons = pk.derived_seasons(1.35, SINGAPORE)
        assert [s.name for s in seasons.calendar] == ["Wet season"]


class TestAstronomy:
    def test_equator_is_about_twelve_hours(self):
        assert 12.0 <= pk.day_length_hours(0.0, dt.date(2026, 3, 20)) <= 12.3

    def test_london_midsummer_and_midwinter(self):
        assert 16.3 <= pk.day_length_hours(51.5, dt.date(2026, 6, 21)) <= 16.8
        assert 7.7 <= pk.day_length_hours(51.5, dt.date(2026, 12, 21)) <= 8.1

    def test_polar_day_and_night(self):
        assert pk.day_length_hours(80, dt.date(2026, 6, 21)) == 24.0
        assert pk.day_length_hours(80, dt.date(2026, 12, 21)) == 0.0

    def test_trend_and_sun_times(self):
        a = pk.astronomy(51.5, -0.13, dt.date(2026, 10, 11), 3600)
        assert a.trend == "shortening" and a.dayLengthChangeMinutes7d < 0
        assert a.sunrise.startswith("07:") and a.sunset.startswith("18:")
        b = pk.astronomy(-17.83, 31.05, dt.date(2026, 10, 11), 7200)
        assert b.trend == "lengthening"


PLACE = {"id": "pg-harare", "collection": "placesGeo", "name": "Harare", "lat": -17.83, "lon": 31.05,
         "country": "ZW", "admin1": "Harare", "elevation": 1490, "slug": "harare"}

NORMALS = {"cell": "-17.75_31.00", "period": "1991–2020", "source": "ERA5 via Open-Meteo, 1991–2020",
           "monthly": HARARE, "timeZone": "Africa/Harare", "utcOffsetSeconds": 7200, "elevation": 1478.0}


def _build(place=PLACE, normals=NORMALS, soil=None, seasons=ZW_SEASONS, allow_fetch=True):
    with patch.object(pk, "get_monthly_normals", return_value=normals) as gm, \
         patch.object(pk, "fetch_soil", return_value=soil) as fs, \
         patch.object(pk, "get_db", return_value=_seasons_db(seasons)):
        doc = pk.build_knowledge(place, allow_fetch=allow_fetch, now=dt.datetime(2026, 10, 11, tzinfo=dt.timezone.utc))
    return doc, gm, fs


REQUIRED = ("_id", "_schemaVersion", "placeCollection", "geo", "addressCountry", "hemisphere", "provenance")


class TestBuild:
    def test_full_document_matches_the_validator(self):
        doc, _, _ = _build(soil=pk.Soil(wrbClass="Lixisols"))
        stored = pk._storable(doc)
        for key in REQUIRED:
            assert stored.get(key) is not None, key
        assert stored["_schemaVersion"] == "v3.2"
        assert stored["placeCollection"] in ("placesGeo", "places")
        assert stored["geo"] == {"type": "Point", "coordinates": [31.05, -17.83]}
        assert stored["hemisphere"] == "south"
        assert len(stored["regionCell"]) == 5
        assert stored["climate"]["koppen"]["code"] == "Cwb"
        assert stored["timeZone"] == "Africa/Harare"
        assert not any(k.startswith("_") and k not in ("_id", "_schemaVersion") for k in stored)

    def test_every_fact_group_has_provenance(self):
        doc, _, _ = _build(soil=pk.Soil(wrbClass="Lixisols"))
        fields = " ".join(p["field"] for p in doc["provenance"])
        for group in ("climate.normals", "climate.koppen", "seasons", "agriculture.crops", "soil",
                      "addressCountry", "timeZone"):
            assert group in fields, group
        crops = next(p for p in doc["provenance"] if p["field"] == "agriculture.crops")
        assert crops["licence"] == "CC-BY-4.0" and "zenodo" in crops["url"]
        koppen = next(p for p in doc["provenance"] if p["field"] == "climate.koppen")
        assert koppen["method"] == "derived"

    def test_refresh_dates(self):
        doc, _, _ = _build(soil=pk.Soil(wrbClass="Lixisols"))
        start = dt.datetime(2026, 10, 11, tzinfo=dt.timezone.utc)
        assert doc["refreshAfter"]["normals"] == start + dt.timedelta(days=365)
        assert doc["refreshAfter"]["seasons"] == start + dt.timedelta(days=30)

    def test_failed_groups_retry_tomorrow(self):
        doc, _, _ = _build(normals=None, soil=None)
        start = dt.datetime(2026, 10, 11, tzinfo=dt.timezone.utc)
        assert doc["refreshAfter"]["normals"] == start + dt.timedelta(days=1)
        assert doc["refreshAfter"]["soil"] == start + dt.timedelta(days=1)
        assert doc["climate"] is None

    def test_ai_seasons_refresh_daily(self):
        doc, _, _ = _build(seasons=[dict(d, source="ai", verified=False) for d in ZW_SEASONS])
        assert doc["seasons"]["source"] == "ai"
        start = dt.datetime(2026, 10, 11, tzinfo=dt.timezone.utc)
        assert doc["refreshAfter"]["seasons"] == start + dt.timedelta(days=1)

    def test_cache_only_build_makes_no_upstream_call(self):
        _, gm, fs = _build(allow_fetch=False)
        assert gm.call_args.kwargs["allow_fetch"] is False
        fs.assert_not_called()

    def test_a_spot_never_fetches_soil(self):
        _, _, fs = _build(place={**PLACE, "id": None})
        fs.assert_not_called()

    def test_no_calendar_country_gets_a_derived_window_only(self):
        london = {**PLACE, "id": "pg-london", "lat": 51.51, "lon": -0.13, "country": "GB", "admin1": "England"}
        doc, _, _ = _build(place=london, normals={**NORMALS, "monthly": LONDON, "timeZone": "Europe/London"},
                           seasons=[])
        assert doc["agriculture"]["crops"] == []
        assert doc["agriculture"]["calendarRef"] is None
        assert doc["agriculture"]["derived"]["method"] == "derived"
        assert doc["seasons"]["source"] == "derived"
        assert doc["climate"]["koppen"]["code"] == "Cfb"


class TestStorage:
    def test_no_write_until_the_collection_exists(self):
        with patch.object(pk, "collection_ready", return_value=False), \
             patch.object(pk, "_collection") as coll:
            assert pk.store_knowledge({"_id": "x", "addressCountry": "ZW"}) is False
        coll.assert_not_called()

    def test_never_without_an_id_or_country(self):
        with patch.object(pk, "collection_ready", return_value=True), \
             patch.object(pk, "_collection") as coll:
            assert pk.store_knowledge({"_id": None, "addressCountry": "ZW"}) is False
            assert pk.store_knowledge({"_id": "x", "addressCountry": None}) is False
        coll.assert_not_called()

    def test_upserts_by_the_place_id(self):
        coll = MagicMock()
        with patch.object(pk, "collection_ready", return_value=True), \
             patch.object(pk, "_collection", return_value=coll):
            assert pk.store_knowledge({"_id": "pg-1", "addressCountry": "ZW", "name": "X"}) is True
        query, update = coll.update_one.call_args.args
        assert query == {"_id": "pg-1"}
        assert "createdAt" in update["$setOnInsert"] and "updatedAt" in update["$set"]
        assert "_id" not in update["$set"]
        assert coll.update_one.call_args.kwargs["upsert"] is True

    def test_write_failure_is_swallowed(self):
        coll = MagicMock()
        coll.update_one.side_effect = RuntimeError("validation failed")
        with patch.object(pk, "collection_ready", return_value=True), \
             patch.object(pk, "_collection", return_value=coll):
            assert pk.store_knowledge({"_id": "pg-1", "addressCountry": "ZW"}) is False

    def test_collection_check_is_cached(self):
        db = MagicMock()
        db.list_collection_names.return_value = ["placeKnowledge"]
        pk._collection_state.update(ready=False, checked=0.0)
        with patch.object(pk, "places_db", return_value=db):
            assert pk.collection_ready() is True
            assert pk.collection_ready() is True
        assert db.list_collection_names.call_count == 1

    def test_staleness(self):
        now = dt.datetime(2026, 10, 11, tzinfo=dt.timezone.utc)
        assert pk.is_stale({}, now)
        assert pk.is_stale({"refreshAfter": {"soil": now - dt.timedelta(seconds=1)}}, now)
        assert not pk.is_stale({"refreshAfter": {"soil": now + dt.timedelta(days=1)}}, now)


WHEN = dt.datetime(2026, 10, 11, 9, tzinfo=dt.timezone.utc)


def _stored_doc(**overrides):
    doc, _, _ = _build(soil=pk.Soil(wrbClass="Lixisols"))
    doc = pk._storable(doc)
    doc["updatedAt"] = WHEN
    doc.update(overrides)
    return doc


class TestRead:
    def test_fresh_stored_doc_is_served(self):
        with patch.object(pk, "resolve_place", return_value=PLACE), \
             patch.object(pk, "read_knowledge", return_value=_stored_doc()), \
             patch.object(pk, "build_knowledge") as build:
            profile = pk.get_location_profile(slug="harare", when=WHEN)
        build.assert_not_called()
        assert profile.stored and profile.placeId == "pg-harare"
        assert profile.current.season is None or profile.current.date == "2026-10-11"
        assert profile.current.cropPhases

    def test_stale_doc_served_to_ai_while_it_rebuilds(self):
        stale = _stored_doc(refreshAfter={"soil": WHEN - dt.timedelta(days=1)})
        with patch.object(pk, "resolve_place", return_value=PLACE), \
             patch.object(pk, "read_knowledge", return_value=stale), \
             patch.object(pk, "schedule_knowledge_build") as sched, \
             patch.object(pk, "build_knowledge") as build:
            profile = pk.get_location_profile(slug="harare", allow_build=False, when=WHEN)
        sched.assert_called_once()
        build.assert_not_called()
        assert profile.stored

    def test_missing_doc_for_ai_is_cache_only(self):
        doc, _, _ = _build(allow_fetch=False)
        with patch.object(pk, "resolve_place", return_value=PLACE), \
             patch.object(pk, "read_knowledge", return_value=None), \
             patch.object(pk, "build_and_store") as bas, \
             patch.object(pk, "build_knowledge", return_value=doc) as build, \
             patch.object(pk, "schedule_knowledge_build") as sched:
            profile = pk.get_location_profile(slug="harare", allow_build=False, when=WHEN)
        bas.assert_not_called()
        assert build.call_args.kwargs["allow_fetch"] is False
        sched.assert_called_once()
        assert not profile.stored

    def test_endpoint_build_stores(self):
        doc, _, _ = _build()
        doc["_stored"] = True
        with patch.object(pk, "resolve_place", return_value=PLACE), \
             patch.object(pk, "read_knowledge", return_value=None), \
             patch.object(pk, "build_and_store", return_value=doc):
            profile = pk.get_location_profile(slug="harare", allow_build=True, when=WHEN)
        assert profile.stored and profile.climate.koppen.code == "Cwb"
        assert profile.current.normalsThisMonth.month == 10
        assert profile.current.astronomy.sunrise is not None

    def test_spot_reuses_a_neighbour_cell(self):
        spot = {**PLACE, "id": None, "collection": None}
        doc, _, _ = _build(place=spot, normals=None)
        neighbour = _stored_doc()
        with patch.object(pk, "resolve_place", return_value=spot), \
             patch.object(pk, "build_and_store", return_value=doc), \
             patch.object(pk, "_neighbour_knowledge", return_value=neighbour):
            profile = pk.get_location_profile(lat=-17.83, lon=31.05, allow_build=True, when=WHEN)
        assert profile.placeId is None and not profile.stored
        assert profile.climate.koppen.code == "Cwb"
        assert any("(nearby place)" in p.field for p in profile.provenance)

    def test_nothing_to_resolve(self):
        with patch.object(pk, "resolve_place", return_value=None):
            assert pk.get_location_profile(slug="nowhere") is None

    def test_never_raises(self):
        with patch.object(pk, "resolve_place", side_effect=RuntimeError("boom")):
            assert pk.get_location_profile(slug="harare") is None

    def test_local_date_uses_the_place_time_zone(self):
        late = dt.datetime(2026, 10, 11, 23, 30, tzinfo=dt.timezone.utc)  # 01:30 on the 12th in Harare
        with patch.object(pk, "resolve_place", return_value=PLACE), \
             patch.object(pk, "read_knowledge", return_value=_stored_doc()):
            profile = pk.get_location_profile(slug="harare", when=late)
        assert profile.current.date == "2026-10-12"


class TestResolvePlace:
    def test_slug_resolves_through_placesgeo(self):
        loc = {"_id": "pg-1", "slug": "harare", "name": "Harare", "lat": -17.83, "lon": 31.05,
               "country": "ZW", "province": "Harare", "elevation": 1490}
        with patch("py._places_resolver.find_location", return_value=loc):
            place = pk.resolve_place(slug="harare", lat=None, lon=None)
        assert place["id"] == "pg-1" and place["collection"] == "placesGeo"
        assert place["admin1"] == "Harare"

    def test_unknown_slug_with_a_coordinate_becomes_a_spot(self):
        with patch("py._places_resolver.find_location", return_value=None), \
             patch("py._places_resolver.find_nearest_location", return_value=None):
            place = pk.resolve_place(slug="west-paddock--ksy4dd7", lat=-17.9, lon=31.1, country="ZW")
        assert place["id"] is None and place["country"] == "ZW"

    def test_bad_slug_is_ignored(self):
        with patch("py._places_resolver.find_location") as fl:
            assert pk.resolve_place(slug="DROP TABLE", lat=None, lon=None) is None
        fl.assert_not_called()


def _profile(**doc_overrides):
    with patch.object(pk, "resolve_place", return_value=PLACE), \
         patch.object(pk, "read_knowledge", return_value=_stored_doc(**doc_overrides)):
        return pk.get_location_profile(slug="harare", when=WHEN)


class TestPromptBlock:
    def test_small_and_grounded(self):
        block = pk.profile_prompt_block(_profile())
        assert len(block) <= pk.PROMPT_BLOCK_MAX_CHARS
        assert "ZW" in block and "1490 m" in block
        assert "Cwb" in block and "~Climate zone" in block  # derived → marked
        assert "Oct normals (ERA5 1991–2020)" in block
        assert "Crop calendar (GEOGLAM, Mashonaland East)" in block
        assert "maize" in block
        assert "moon" in block

    def test_verified_season_is_not_marked(self):
        block = pk.profile_prompt_block(_profile())
        assert "- Season: Hot dry (Zhizha); next Main rains (Masika) from 1 Nov" in block

    def test_unverified_season_is_marked(self):
        seasons = pk.derived_seasons(-17.8, HARARE).model_dump()
        block = pk.profile_prompt_block(_profile(seasons=seasons))
        assert "- ~Season:" in block

    def test_no_crops_named_without_a_calendar(self):
        derived_only = {"calendarRef": None, "crops": [],
                        "derived": {"months": [5, 6, 7, 8, 9, 10], "basis": "months with a mean of 10 °C or more",
                                    "method": "derived"}, "grazing": None}
        block = pk.profile_prompt_block(_profile(agriculture=derived_only))
        assert "Crop calendar" not in block
        assert "~Likely growing window May–Oct" in block
        assert "No local crop calendar on file" in block

    def test_empty_without_a_profile(self):
        assert pk.profile_prompt_block(None) == ""

    def test_with_profile_adds_the_rule(self):
        assert pk.with_profile("") == ""
        out = pk.with_profile("Place profile: x")
        assert pk.PROFILE_GROUNDING_RULE in out

    @pytest.mark.asyncio
    async def test_async_helper_never_raises(self):
        with patch.object(pk, "get_location_profile", side_effect=RuntimeError("boom")):
            assert await pk.profile_block_for(slug="harare") == ""


@pytest.mark.asyncio
class TestEndpoint:
    async def test_needs_a_slug_or_coordinates(self):
        with pytest.raises(HTTPException) as exc:
            await pk.location_profile(slug=None, lat=1.0, lon=None, country=None)
        assert exc.value.status_code == 400

    async def test_rejects_a_bad_slug(self):
        with pytest.raises(HTTPException) as exc:
            await pk.location_profile(slug="Bad Slug!", lat=None, lon=None, country=None)
        assert exc.value.status_code == 400

    async def test_404_when_nothing_resolves(self):
        with patch.object(pk, "get_location_profile", return_value=None), \
             patch("py._enso.get_enso", side_effect=RuntimeError("offline")):
            with pytest.raises(HTTPException) as exc:
                await pk.location_profile(slug="nowhere", lat=None, lon=None, country=None)
        assert exc.value.status_code == 404

    async def test_returns_the_profile(self):
        profile = _profile()
        with patch.object(pk, "get_location_profile", return_value=profile) as glp, \
             patch("py._enso.get_enso", side_effect=RuntimeError("offline")):
            res = await pk.location_profile(slug="harare", lat=None, lon=None, country="zw")
        assert res.placeId == "pg-harare"
        assert glp.call_args.kwargs["country"] == "ZW"
        assert glp.call_args.kwargs["allow_build"] is True
