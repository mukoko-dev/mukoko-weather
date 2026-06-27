"""Tests for _metar.py — METAR decoding, flight category, caching, endpoint."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import patch, MagicMock

import pytest

from py._metar import (
    _decode_wx,
    _compute_flight_category,
    _format_visibility,
    _decode_awc_metar,
    CloudLayer,
    MetarObs,
    METAR_CACHE_TTL,
)


# ---------------------------------------------------------------------------
# _decode_wx
# ---------------------------------------------------------------------------


class TestDecodeWx:
    def test_simple_rain(self):
        assert _decode_wx("RA") == "Rain"

    def test_light_rain(self):
        result = _decode_wx("-RA")
        assert "Light" in result
        assert "Rain" in result

    def test_heavy_rain(self):
        result = _decode_wx("+RA")
        assert "Heavy" in result

    def test_thunderstorm(self):
        assert _decode_wx("TS") == "Thunderstorm"

    def test_fog(self):
        assert _decode_wx("FG") == "Fog"

    def test_none_returns_none(self):
        assert _decode_wx(None) is None

    def test_empty_returns_none(self):
        assert _decode_wx("") is None

    def test_unknown_code_passthrough(self):
        result = _decode_wx("XX")
        assert "XX" in result


# ---------------------------------------------------------------------------
# _format_visibility
# ---------------------------------------------------------------------------


class TestFormatVisibility:
    def test_high_vis_returns_gt10km(self):
        assert _format_visibility(9.0) == ">10km"   # ~14.5 km
        assert _format_visibility(6.25) == ">10km"  # ~10.06 km

    def test_low_vis_returns_km(self):
        result = _format_visibility(3.0)  # ~4.8 km
        assert "km" in result
        assert result != ">10km"

    def test_none_returns_none(self):
        assert _format_visibility(None) is None


# ---------------------------------------------------------------------------
# _compute_flight_category
# ---------------------------------------------------------------------------


class TestComputeFlightCategory:
    def _make_clouds(self, layers):
        return [CloudLayer(cover=c, base_ft=b) for c, b in layers]

    def test_vfr_clear(self):
        cat = _compute_flight_category([], ">10km")
        assert cat == "VFR"

    def test_vfr_few_clouds_high(self):
        clouds = self._make_clouds([("FEW", 5000)])
        cat = _compute_flight_category(clouds, ">10km")
        assert cat == "VFR"

    def test_mvfr_broken_ceiling_2500ft(self):
        clouds = self._make_clouds([("BKN", 2500)])
        cat = _compute_flight_category(clouds, ">10km")
        assert cat == "MVFR"

    def test_ifr_broken_ceiling_800ft(self):
        clouds = self._make_clouds([("BKN", 800)])
        cat = _compute_flight_category(clouds, ">10km")
        assert cat == "IFR"

    def test_lifr_ceiling_below_500ft(self):
        clouds = self._make_clouds([("OVC", 300)])
        cat = _compute_flight_category(clouds, ">10km")
        assert cat == "LIFR"

    def test_ifr_low_visibility(self):
        # 3.0km: > 1.6km (not LIFR) and < 4.8km → IFR
        cat = _compute_flight_category([], "3.0km")
        assert cat == "IFR", f"Expected IFR, got {cat}"

    def test_lifr_very_low_visibility(self):
        cat = _compute_flight_category([], "1.0km")
        assert cat == "LIFR"

    def test_few_and_sct_ignored_for_ceiling(self):
        # FEW and SCT don't count as ceiling
        clouds = self._make_clouds([("FEW", 500), ("SCT", 600)])
        cat = _compute_flight_category(clouds, ">10km")
        assert cat == "VFR"

    def test_lowest_bkn_used_for_ceiling(self):
        clouds = self._make_clouds([("BKN", 3500), ("BKN", 800)])
        cat = _compute_flight_category(clouds, ">10km")
        assert cat == "IFR"  # lowest BKN is 800ft


# ---------------------------------------------------------------------------
# _decode_awc_metar
# ---------------------------------------------------------------------------


class TestDecodeAwcMetar:
    def _sample_obs(self, **overrides):
        base = {
            "rawOb": "FVHA 270800Z 04004KT 9999 BKN018 16/11 Q1029",
            "obsTime": "2026-06-27T08:00:00Z",
            "temp": 16.0,
            "dewp": 11.0,
            "wdir": 40,
            "wspd": 4,
            "visib": 6.21,  # ~10km
            "altim": 30.39,  # ~1029 hPa
            "clouds": [{"cover": "BKN", "base": 1800}],
            "wxString": None,
            "remarks": "NOSIG",
            "flightCategory": "MVFR",
        }
        base.update(overrides)
        return base

    def test_basic_decode(self):
        obs = _decode_awc_metar(self._sample_obs())
        assert obs.temp == 16.0
        assert obs.dewp == 11.0
        assert obs.wind_dir == 40
        assert obs.wind_speed == 4
        assert obs.flight_category == "MVFR"
        assert obs.raw == "FVHA 270800Z 04004KT 9999 BKN018 16/11 Q1029"

    def test_cloud_layers_decoded(self):
        obs = _decode_awc_metar(self._sample_obs())
        assert len(obs.clouds) == 1
        assert obs.clouds[0].cover == "BKN"
        assert obs.clouds[0].base_ft == 1800

    def test_nosig_in_remarks(self):
        obs = _decode_awc_metar(self._sample_obs(remarks="NOSIG"))
        assert obs.change == "No Significant Change"

    def test_variable_wind(self):
        obs = _decode_awc_metar(self._sample_obs(wdir="VRB", wspd=2))
        assert obs.wind_variable is True
        assert obs.wind_dir is None
        assert obs.wind_speed == 2

    def test_pressure_conversion(self):
        # 30.39 inHg ≈ 1029 hPa
        obs = _decode_awc_metar(self._sample_obs(altim=30.39))
        assert obs.pressure_hpa is not None
        assert 1028 < obs.pressure_hpa < 1030

    def test_time_parsing(self):
        obs = _decode_awc_metar(self._sample_obs(obsTime="2026-06-27T08:00:00Z"))
        assert "2026" in obs.time

    def test_fallback_flight_category_computed(self):
        # If flightCategory not in valid set, compute it
        obs = _decode_awc_metar(self._sample_obs(flightCategory="UNKNOWN"))
        assert obs.flight_category in ("VFR", "MVFR", "IFR", "LIFR")


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------


class TestConstants:
    def test_cache_ttl_is_30_minutes(self):
        assert METAR_CACHE_TTL == 1800

    def test_metar_obs_model_fields(self):
        obs = MetarObs(
            time="2026-06-27T08:00:00+00:00",
            flight_category="VFR",
            raw="FVHA 270800Z VFR",
        )
        assert obs.flight_category == "VFR"
        assert obs.wind_variable is False
        assert obs.clouds == []
