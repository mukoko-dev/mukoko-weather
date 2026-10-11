"""Contract tests: the profile helper against the real agriculture adapter.

`_agriculture.load_location_profile` imports `get_location_profile` from
`_location_profile` and maps its dict (season, crops, normals, koppen, enso).
These tests run the REAL adapter and mapping functions over a real profile so
the two modules cannot drift apart (#277, #265).
"""

from __future__ import annotations

import datetime as dt
from unittest.mock import patch

from py import _agriculture as agri
from py import _location_profile as lp
from py import _place_knowledge as pk
from tests.py.test_place_knowledge import PLACE, WHEN, _stored_doc


def _profile(place=PLACE, **overrides):
    with patch.object(pk, "resolve_place", return_value=place), \
         patch.object(pk, "read_knowledge", return_value=_stored_doc(**overrides)):
        return lp.get_location_profile(slug="harare", when=WHEN)


class TestSharedModule:
    def test_public_surface_is_the_implementation(self):
        assert lp.get_location_profile is pk.get_location_profile
        assert lp.profile_prompt_block is pk.profile_prompt_block
        assert set(lp.__all__) >= {"get_location_profile", "profile_prompt_block", "LocationProfile"}

    def test_default_never_builds_or_waits(self):
        with patch.object(pk, "resolve_place", return_value=PLACE), \
             patch.object(pk, "read_knowledge", return_value=None), \
             patch.object(pk, "build_and_store") as build_and_store, \
             patch.object(pk, "schedule_knowledge_build") as schedule:
            profile = lp.get_location_profile(slug="harare", when=WHEN)
        build_and_store.assert_not_called()
        schedule.assert_called_once()
        assert profile is not None


class TestAdapterShape:
    def test_flat_keys(self):
        dumped = _profile().model_dump(mode="json")
        assert dumped["koppen"] == "Cwb"
        assert dumped["normals"] == {"high": 26.5, "low": 16.5}  # October of the HARARE test normals (mean 21.5 ± 5)
        assert dumped["season"]["name"] == "Hot dry"
        assert dumped["season"]["localName"] == "Zhizha"
        crop = dumped["crops"][0]
        assert crop["id"] == "crop-farming"
        assert set(crop["calendar"]) == {"plant", "grow", "harvest"}
        assert all(isinstance(m, int) and 1 <= m <= 12 for ms in crop["calendar"].values() for m in ms)

    def test_zimbabwe_maize_stage_months(self):
        crop = _profile().crops[0]
        # GEOGLAM Mashonaland East maize: plant 1 Nov, vegetative 16 Dec,
        # harvest 1 Apr, end of season 16 May.
        assert crop.calendar["plant"] == [11, 12]
        assert crop.calendar["grow"] == [12, 1, 2, 3]
        assert crop.calendar["harvest"] == [4, 5]
        assert crop.label == "Maize"
        assert crop.phase == "off-season"  # 11 Oct is before planting

    def test_only_crop_farming_is_answered(self):
        ids = {c.id for c in _profile().crops}
        assert ids == {"crop-farming"}  # no invented calendars for tobacco, cotton, ...

    def test_stage_months_wrap_and_edges(self):
        assert pk.stage_months(305, 350) == [11, 12]
        assert pk.stage_months(350, 91) == [12, 1, 2, 3]
        assert pk.stage_months(91, 136) == [4, 5]
        assert pk.stage_months(1, 32) == [1]

    def test_no_calendar_means_no_crops(self):
        london = {**PLACE, "id": "pg-l", "lat": 51.51, "lon": -0.13, "country": "GB"}
        derived_only = {"calendarRef": None, "crops": [], "grazing": None,
                        "derived": {"months": [5, 6, 7, 8, 9, 10], "basis": "x", "method": "derived"}}
        profile = _profile(place=london, agriculture=derived_only)
        assert profile.crops == []

    def test_enso_is_flat_when_known(self):
        enso = pk.EnsoNow(phase="La Niña", strength="weak", oni=-0.7)
        with patch.object(pk, "_enso_now", return_value=enso):
            dumped = _profile().model_dump(mode="json")
        assert dumped["enso"] == {"phase": "La Niña", "oni": -0.7}


class TestRealAdapter:
    def test_load_location_profile_returns_the_dump(self):
        with patch.object(pk, "resolve_place", return_value=PLACE), \
             patch.object(pk, "read_knowledge", return_value=_stored_doc()):
            raw = agri.load_location_profile(-17.83, 31.05, slug="harare", country="ZW")
        assert isinstance(raw, dict)
        assert raw["koppen"] == "Cwb"

    def test_agriculture_maps_the_calendar(self):
        raw = _profile().model_dump(mode="json")
        cal = agri.calendar_from_profile(raw, ["crop-farming", "tobacco-farming"])
        assert [c.id for c in cal] == ["crop-farming"]
        assert cal[0].months["plant"] == [11, 12]
        assert cal[0].phase == "off-season"

    def test_agriculture_maps_season_and_context(self):
        raw = _profile().model_dump(mode="json")
        season = agri.season_for(raw, -17.83)
        assert (season.name, season.localName) == ("Hot dry", "Zhizha")
        ctx = agri.profile_context(raw)
        assert ctx.koppen == "Cwb" and ctx.normalHigh == 26.5 and ctx.normalLow == 16.5

    def test_agriculture_helper_probe_finds_the_module(self):
        assert agri._profile_helper_available() is True
