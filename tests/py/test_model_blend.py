"""Tests for _model_blend.py — Africa-weighted multi-model baseline (issue #246)."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from py import _model_blend as blend
from py._model_blend import (
    BLEND_WEIGHTS,
    BLENDABLE_MODELS,
    blend_payload,
    blend_section,
    format_weights,
    members_with_data,
    order_members,
    parse_minutely_any,
    region_for,
    weights_for,
)


@pytest.fixture(autouse=True)
def _clear_cache():
    blend._reset_config_cache()
    yield
    blend._reset_config_cache()


class TestRegions:
    @pytest.mark.parametrize(
        "lat,lon,region",
        [
            (-17.83, 31.05, "southern-africa"),  # Harare
            (-26.2, 28.05, "southern-africa"),  # Johannesburg
            (-18.9, 47.5, "southern-africa"),  # Antananarivo
            (-1.29, 36.82, "east-africa"),  # Nairobi
            (9.0, 38.75, "east-africa"),  # Addis Ababa
            (6.52, 3.38, "west-africa-sahel"),  # Lagos
            (14.7, -17.45, "west-africa-sahel"),  # Dakar
            (-4.32, 15.31, "central-africa"),  # Kinshasa
            (30.04, 31.24, "north-africa"),  # Cairo
            (1.35, 103.8, "default"),  # Singapore
        ],
    )
    def test_region_for(self, lat, lon, region):
        assert region_for(lat, lon) == region


class TestWeights:
    def test_ecmwf_heavy_everywhere(self):
        for region, w in BLEND_WEIGHTS.items():
            ecmwf = w[blend.ECMWF_IFS] + w[blend.ECMWF_AIFS]
            assert ecmwf >= 0.5, region
            assert order_members(w)[0] == blend.ECMWF_IFS
            assert sum(w.values()) == pytest.approx(1.0)
            assert set(w) <= BLENDABLE_MODELS

    def test_db_override_wins_and_is_sanitised(self):
        coll = MagicMock()
        coll.find_one.return_value = {"weights": {"gfs_seamless": 0.7, "ecmwf_ifs": 0.3, "evil": 5, "icon_global": -1}}
        db = MagicMock()
        db.__getitem__.return_value = coll
        with patch("py._db.weather_db", return_value=db):
            w = weights_for("east-africa")
        assert w == {"gfs_seamless": 0.7, "ecmwf_ifs": 0.3}

    def test_db_failure_falls_back_to_constant(self):
        with patch("py._db.weather_db", side_effect=Exception("down")):
            assert weights_for("southern-africa") == BLEND_WEIGHTS["southern-africa"]

    def test_unknown_region_uses_default(self):
        with patch("py._db.weather_db", side_effect=Exception("down")):
            assert weights_for("atlantis") == BLEND_WEIGHTS["default"]

    def test_format_weights_normalises(self):
        assert format_weights("x", {"a": 3, "b": 1}) == "x; a=0.75,b=0.25"


W = {"ecmwf_ifs": 0.6, "gfs_seamless": 0.4}


class TestBlendSection:
    def test_weighted_mean(self):
        sec = {"time": ["t0"], "temperature_2m_ecmwf_ifs": [20.0], "temperature_2m_gfs_seamless": [25.0]}
        assert blend_section(sec, ["temperature_2m"], W)["temperature_2m"] == [22.0]

    def test_missing_member_renormalises(self):
        # UV only from GFS (ECMWF publishes none) → the GFS value, not 40 % of it.
        sec = {"time": ["t0"], "uv_index_ecmwf_ifs": [None], "uv_index_gfs_seamless": [8.0]}
        assert blend_section(sec, ["uv_index"], W)["uv_index"] == [8.0]

    def test_all_missing_is_none(self):
        sec = {"time": ["t0"]}
        assert blend_section(sec, ["visibility"], W)["visibility"] == [None]

    def test_circular_mean_for_direction(self):
        sec = {"time": ["t0"], "wind_direction_10m_ecmwf_ifs": [350], "wind_direction_10m_gfs_seamless": [10]}
        out = blend_section(sec, ["wind_direction_10m"], {"ecmwf_ifs": 0.5, "gfs_seamless": 0.5})
        assert out["wind_direction_10m"][0] in (0, 360)

    def test_weather_code_vote_and_tie_break(self):
        sec = {"time": ["t0", "t1"], "weather_code_ecmwf_ifs": [61, 3], "weather_code_gfs_seamless": [3, 95]}
        assert blend_section(sec, ["weather_code"], W)["weather_code"][0] == 61
        tie = blend_section(sec, ["weather_code"], {"ecmwf_ifs": 0.5, "gfs_seamless": 0.5})
        assert tie["weather_code"][1] == 95  # more severe wins a tie

    def test_precip_probability_ensemble_plus_agreement(self):
        sec = {
            "time": ["t0"],
            "precipitation_probability_ecmwf_ifs": [40],
            "precipitation_probability_gfs_seamless": [60],
            "precipitation_ecmwf_ifs": [0.5],
            "precipitation_gfs_seamless": [0.0],
        }
        # ensemble = 48; agreement = 0.6 → 60; 0.5*48 + 0.5*60 = 54
        assert blend_section(sec, ["precipitation_probability"], W)["precipitation_probability"] == [54]

    def test_precip_probability_agreement_only(self):
        sec = {"time": ["t0"], "precipitation_ecmwf_ifs": [1.0], "precipitation_gfs_seamless": [0.0]}
        assert blend_section(sec, ["precipitation_probability"], W)["precipitation_probability"] == [60]

    def test_first_non_null_fields(self):
        sec = {"time": ["d0"], "sunrise_ecmwf_ifs": [None], "sunrise_gfs_seamless": ["2026-10-10T05:30"]}
        assert blend_section(sec, ["sunrise"], W)["sunrise"] == ["2026-10-10T05:30"]

    def test_single_mode_reads_unsuffixed(self):
        sec = {"time": ["t0"], "temperature_2m": [21.3]}
        assert blend_section(sec, ["temperature_2m"], {"x": 1.0}, single=True)["temperature_2m"] == [21.3]


class TestBlendPayload:
    def _raw(self):
        return {
            "utc_offset_seconds": 7200,
            "current": {"time": "2026-10-10T10:15", "interval": 900, "temperature_2m": 24.7, "uv_index": None},
            "current_units": {"temperature_2m": "°C"},
            "hourly": {
                "time": ["2026-10-10T09:00", "2026-10-10T10:00"],
                "temperature_2m_ecmwf_ifs": [23.0, 24.0],
                "temperature_2m_gfs_seamless": [25.0, 26.0],
                "uv_index_ecmwf_ifs": [None, None],
                "uv_index_gfs_seamless": [5.0, 7.0],
            },
            "daily": {
                "time": ["2026-10-10"],
                "temperature_2m_max_ecmwf_ifs": [27.0],
                "temperature_2m_max_gfs_seamless": [30.0],
                "precipitation_sum_ecmwf_ifs": [2.0],
                "precipitation_sum_gfs_seamless": [0.0],
            },
        }

    def test_canonical_shape(self):
        out = blend_payload(self._raw(), W)
        assert set(out) == {"current", "hourly", "daily", "current_units", "utc_offset_seconds"}
        assert out["hourly"]["temperature_2m"] == [23.8, 24.8]
        assert out["daily"]["temperature_2m_max"] == [28.2]
        # daily agreement threshold is 1 mm
        assert out["daily"]["precipitation_probability_max"] == [60]

    def test_current_nulls_filled_from_blended_hour(self):
        out = blend_payload(self._raw(), W)
        assert out["current"]["temperature_2m"] == 24.7  # top member's 15-min value kept
        assert out["current"]["uv_index"] == 7.0  # filled from blended 10:00 hour
        assert "interval" not in out["current"]

    def test_members_with_data(self):
        raw = {"hourly": {"temperature_2m_ecmwf_ifs": [None], "temperature_2m_gfs_seamless": [1.0]}}
        assert members_with_data(raw, ["ecmwf_ifs", "gfs_seamless", "icon_global"]) == ["gfs_seamless"]

    def test_minutely_any(self):
        raw = {"minutely_15": {"time": ["a", "b", "c", "d", "e"], "precipitation_ecmwf_ifs": [0, 0.2, None, 1, 2]}}
        assert parse_minutely_any(raw, ["ecmwf_ifs"]) == {"time": ["a", "b", "c", "d"], "precipitation": [0, 0.2, 0, 1]}
        assert parse_minutely_any({}, ["x"]) is None


class TestFetchBlend:
    """_weather._fetch_blend glues the request + blend + insights together."""

    def _client(self, payload):
        resp = MagicMock(status_code=200)
        resp.json.return_value = payload
        client = MagicMock()
        client.get.return_value = resp
        return client

    def test_one_call_lists_top_member_first_and_strips_intermediates(self):
        from py._weather import _fetch_blend

        raw = {
            "current": {"time": "2026-10-10T10:00", "temperature_2m": 24},
            "hourly": {
                "time": ["2026-10-10T10:00"],
                "temperature_2m_ecmwf_ifs": [24.0],
                "temperature_2m_gfs_seamless": [26.0],
                "cape_gfs_seamless": [1500],
                "precipitation_ecmwf_ifs": [0.0],
                "precipitation_gfs_seamless": [0.0],
            },
            "daily": {"time": ["2026-10-10"]},
        }
        client = self._client(raw)
        with patch("py._weather._get_http_client", return_value=client):
            payload, got_raw, used = _fetch_blend(-17.83, 31.05, "southern-africa", dict(W))
        params = client.get.call_args.kwargs["params"]
        assert params["models"].split(",")[0] == "ecmwf_ifs"
        assert "cape" not in payload["hourly"]
        assert payload["insights"]["thunderstormProbability"] >= 20
        assert payload["models_available"] == ["ecmwf_ifs", "gfs_seamless"]
        assert used == W

    def test_too_few_members_returns_none(self):
        from py._weather import _fetch_blend

        raw = {"hourly": {"time": ["t"], "temperature_2m_ecmwf_ifs": [24.0]}}
        with patch("py._weather._get_http_client", return_value=self._client(raw)):
            assert _fetch_blend(-17.83, 31.05, "southern-africa", dict(W)) is None

    def test_single_model_fills_nulls_from_best_match(self):
        from py._weather import _fetch_single_model

        raw = {
            "current": {"time": "2026-10-10T10:00", "temperature_2m": 24, "uv_index": None},
            "hourly": {
                "time": ["2026-10-10T10:00"],
                "temperature_2m_ecmwf_ifs": [24.0],
                "temperature_2m_best_match": [25.0],
                "uv_index_ecmwf_ifs": [None],
                "uv_index_best_match": [6.5],
            },
            "daily": {"time": ["2026-10-10"]},
        }
        client = self._client(raw)
        with patch("py._weather._get_http_client", return_value=client):
            out = _fetch_single_model(-17.83, 31.05, "ecmwf_ifs")
        assert client.get.call_args.kwargs["params"]["models"] == "ecmwf_ifs,best_match"
        assert out["hourly"]["temperature_2m"] == [24.0]  # the chosen model, not the filler
        assert out["hourly"]["uv_index"] == [6.5]
        assert out["current"]["uv_index"] == 6.5
