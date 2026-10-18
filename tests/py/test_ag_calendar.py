"""Tests for _ag_calendar.py — crop calendars behind AgricultureCalendarSource.

Covers:
  * The shipped GEOGLAM CM4EW v1.3 table: every country maps to ISO, and the
    five verification cities resolve to the right sub-national region
  * Point-in-region (ray casting with holes) and the nearest-region fallback
  * Season labels for numbered crops (named from the ReadMe, else by size)
  * Crop phase at read time, including windows that wrap the year end
  * The derived default (growing window from normals) names no crops
  * Grazing notes, source-chain fallbacks and a missing data file
"""

from __future__ import annotations

import datetime as dt
from pathlib import Path

import pytest

from py import _ag_calendar as ag


class TestGeoglamTable:
    def test_every_country_in_the_table_has_an_iso_code(self):
        import gzip
        import json

        data = json.loads(gzip.decompress(ag.DATA_FILE.read_bytes()))
        names = {r["country"] for r in data["regions"]}
        assert names <= set(ag.GEOGLAM_COUNTRY_ISO), names - set(ag.GEOGLAM_COUNTRY_ISO)
        assert data["license"] == "CC-BY-4.0"
        assert data["doi"] == "10.5281/zenodo.15850408"

    def test_iso_codes_are_unique_alpha2(self):
        codes = list(ag.GEOGLAM_COUNTRY_ISO.values())
        assert len(codes) == len(set(codes))
        assert all(len(c) == 2 and c.isupper() for c in codes)

    @pytest.mark.parametrize("lat,lon,country,region", [
        (-17.83, 31.05, "ZW", "Mashonaland East"),   # Harare
        (-1.29, 36.82, "KE", "Central"),             # Nairobi
        (6.52, 3.38, "NG", "South"),                 # Lagos
        (13.75, 100.50, "TH", "Central Plain"),      # Bangkok
    ])
    def test_cities_resolve_to_their_region(self, lat, lon, country, region):
        cal = ag.GEOGLAM.calendar_for(lat, lon, country)
        assert cal is not None
        assert cal.region == region
        assert cal.method == "seed"
        assert cal.licence == "CC-BY-4.0"
        assert cal.crops

    def test_country_outside_the_table_has_no_calendar(self):
        assert ag.GEOGLAM.calendar_for(51.51, -0.13, "GB") is None
        assert ag.GEOGLAM.calendar_for(51.51, -0.13, None) is None

    def test_point_far_from_every_region_of_its_country_has_no_calendar(self):
        # A Zimbabwe country code with a coordinate in the Atlantic.
        assert ag.GEOGLAM.calendar_for(-17.8, -20.0, "ZW") is None

    def test_zimbabwe_maize_plants_in_november(self):
        cal = ag.GEOGLAM.calendar_for(-17.83, 31.05, "ZW")
        maize = next(c for c in cal.crops if c.crop == "maize")
        planting = dt.date(2026, 1, 1) + dt.timedelta(days=maize.stages.planting - 1)
        assert planting.month == 11

    def test_kenya_maize_seasons_are_named(self):
        cal = ag.GEOGLAM.calendar_for(-1.29, 36.82, "KE")
        seasons = {c.season for c in cal.crops if c.crop == "maize"}
        assert seasons == {"Long rains", "Short rains"}

    def test_a_lone_season_is_not_named(self):
        cal = ag.GEOGLAM.calendar_for(-17.83, 31.05, "ZW")
        assert {c.season for c in cal.crops} == {None}

    def test_unnamed_numbered_crops_are_labelled_by_size(self):
        cal = ag.GEOGLAM.calendar_for(-1.29, 36.82, "KE")
        rice = sorted(c.season for c in cal.crops if c.crop == "rice")
        assert rice == ["Main season", "Season 2"]

    def test_missing_table_degrades_to_none(self, tmp_path):
        source = ag.GeoglamCalendarSource(tmp_path / "absent.json.gz")
        assert source.calendar_for(-17.83, 31.05, "ZW") is None
        assert source.countries() == set()


class TestGeometry:
    SQUARE = [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]

    def test_inside_and_outside(self):
        assert ag.point_in_rings(5, 5, self.SQUARE)
        assert not ag.point_in_rings(15, 5, self.SQUARE)

    def test_hole_is_outside(self):
        rings = self.SQUARE + [[[3, 3], [7, 3], [7, 7], [3, 7], [3, 3]]]
        assert not ag.point_in_rings(5, 5, rings)
        assert ag.point_in_rings(1, 1, rings)


class TestCropIds:
    @pytest.mark.parametrize("raw,crop_id,label", [
        ("Maize 1", "maize", "Maize"),
        ("Winter Wheat", "winter-wheat", "Winter wheat"),
        ("Teff", "teff", "Teff"),
    ])
    def test_ids(self, raw, crop_id, label):
        assert ag._crop_ids(raw) == (crop_id, label)


def _window(p, v, h, e, o):
    return ag.CropWindow(crop="maize", cropLabel="Maize", stages=ag.CropStages(
        planting=p, vegetative=v, harvest=h, endOfSeason=e, outOfSeason=o))


class TestCropPhase:
    # Zimbabwe-like maize: plant 1 Nov, vegetative 16 Dec, harvest 1 Apr,
    # end of season 16 May, out of season 16 Jun.
    ZW = _window(305, 350, 91, 136, 167)

    @pytest.mark.parametrize("day,phase,next_on", [
        (dt.date(2026, 10, 11), "outOfSeason", "2026-11-01"),
        (dt.date(2026, 11, 20), "planting", "2026-12-16"),
        (dt.date(2027, 1, 15), "vegetative", "2027-04-01"),
        (dt.date(2027, 4, 10), "harvest", "2027-05-16"),
        (dt.date(2027, 6, 1), "endOfSeason", "2027-06-16"),
    ])
    def test_wrapping_window(self, day, phase, next_on):
        result = ag.crop_phase(self.ZW, day)
        assert result.phase == phase
        assert result.nextPhaseOn == next_on

    def test_no_out_of_season_goes_from_end_back_to_planting(self):
        w = _window(60, 120, 180, 240, None)
        result = ag.crop_phase(w, dt.date(2026, 10, 1))
        assert result.phase == "endOfSeason"
        assert result.nextPhase == "planting"
        assert result.nextPhaseOn == "2027-03-01"

    def test_phase_starts_on_its_own_day(self):
        result = ag.crop_phase(self.ZW, dt.date(2026, 11, 1))
        assert result.phase == "planting"


def _monthly(temps, precs):
    return [{"month": i + 1, "meanTempC": t, "precipMm": p} for i, (t, p) in enumerate(zip(temps, precs))]


LONDON = _monthly([5.2, 5.3, 7.6, 9.9, 13.3, 16.5, 18.7, 18.5, 15.7, 12.0, 8.0, 5.5],
                  [55, 41, 42, 44, 49, 45, 45, 50, 49, 69, 59, 55])
HARARE = _monthly([21, 21, 20, 18.5, 16, 14, 13.5, 16, 19, 21.5, 21.5, 21],
                  [190, 170, 97, 40, 10, 3, 1, 3, 7, 30, 95, 180])


class TestDerived:
    def test_temperate_window_by_temperature(self):
        window = ag.derived_growing_window(51.5, LONDON)
        assert window.months == [5, 6, 7, 8, 9, 10]  # April is 9.9 °C
        assert "temperature" in window.basis
        assert window.method == "derived"

    def test_tropical_window_by_rain(self):
        window = ag.derived_growing_window(-17.8, HARARE)
        assert window.months == [1, 2, 3, 11, 12]
        assert "rainfall" in window.basis

    def test_no_normals_no_window(self):
        assert ag.derived_growing_window(10, None) is None

    def test_derived_source_names_no_crops(self):
        cal = ag.DerivedCalendarSource().calendar_for(51.5, -0.1, "GB", monthly_normals=LONDON)
        assert cal.method == "derived" and cal.crops == []
        assert cal.derived is not None

    def test_grazing_notes(self):
        notes = ag.grazing_notes(-17.8, HARARE)
        assert notes.dryMonths == [5, 6, 7, 8, 9]
        assert notes.method == "derived"
        assert "forage" in notes.note


class TestChain:
    def test_published_calendar_wins_and_carries_the_derived_window(self):
        cal = ag.calendar_for(-17.83, 31.05, "ZW", monthly_normals=HARARE)
        assert cal.method == "seed"
        assert cal.derived is not None and cal.derived.months

    def test_falls_back_to_derived(self):
        cal = ag.calendar_for(51.51, -0.13, "GB", monthly_normals=LONDON)
        assert cal.method == "derived"

    def test_nothing_without_a_calendar_or_normals(self):
        assert ag.calendar_for(51.51, -0.13, "GB") is None

    def test_a_failing_source_does_not_stop_the_chain(self):
        class Broken:
            name = "broken"

            def calendar_for(self, *a, **k):
                raise RuntimeError("boom")

        cal = ag.calendar_for(51.5, -0.1, "GB", monthly_normals=LONDON,
                              sources=(Broken(), ag.DerivedCalendarSource()))
        assert cal.method == "derived"

    def test_data_file_ships_beside_the_module(self):
        assert ag.DATA_FILE.parent == Path(ag.__file__).resolve().parent / "data"
        assert ag.DATA_FILE.is_file()
