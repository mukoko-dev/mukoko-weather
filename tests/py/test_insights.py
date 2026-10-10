"""Tests for _insights.py — insights derived from global-model data (issue #246)."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from py._insights import (
    INTERMEDIATE_DAILY,
    INTERMEDIATE_HOURLY,
    cloud_base_km,
    convective_proxy,
    current_hour_index,
    derive_insights,
    dew_point_c,
    growing_degree_days,
    heat_index_c,
    moon_phase,
    strip_intermediate,
    wmo_hazards,
)


class TestDewPoint:
    def test_saturated_air_dew_point_equals_temperature(self):
        assert dew_point_c(20.0, 100) == pytest.approx(20.0, abs=0.1)

    def test_reference_value(self):
        # 25 °C / 50 % RH → ~13.9 °C (standard psychrometric tables)
        assert dew_point_c(25.0, 50) == pytest.approx(13.9, abs=0.2)

    def test_missing_input(self):
        assert dew_point_c(None, 50) is None
        assert dew_point_c(20, None) is None


class TestHeatIndex:
    def test_below_threshold_is_air_temperature(self):
        assert heat_index_c(22.0, 80) == 22.0

    def test_hot_humid_exceeds_air_temperature(self):
        # 32 °C / 70 % RH → NOAA heat index ≈ 40.4 °C
        assert heat_index_c(32.0, 70) == pytest.approx(40.4, abs=0.6)

    def test_hot_dry_adjustment(self):
        assert heat_index_c(38.0, 10) < 38.0

    def test_missing(self):
        assert heat_index_c(None, 50) is None


class TestGrowingDegreeDays:
    def test_maize_standard(self):
        assert growing_degree_days(28, 14, 10, 30) == 11.0

    def test_cap_and_base_clamp(self):
        # max 35 capped to 30, min 5 floored to 10 → (30+10)/2 - 10 = 10
        assert growing_degree_days(35, 5, 10, 30) == 10.0

    def test_cold_day_is_zero(self):
        assert growing_degree_days(9, 2, 10, 30) == 0.0

    def test_missing(self):
        assert growing_degree_days(None, 10, 10, 30) is None


class TestWmoHazards:
    @pytest.mark.parametrize(
        "code,expected",
        [(0, (0, 0)), (61, (0, 1)), (95, (70, 1)), (96, (85, 1)), (99, (95, 1)), (73, (0, 2)), (66, (0, 3))],
    )
    def test_mapping(self, code, expected):
        assert wmo_hazards(code) == expected

    def test_none_is_clear(self):
        assert wmo_hazards(None) == (0, 0)


class TestConvectiveProxy:
    @pytest.mark.parametrize(
        "cape,li,score",
        [(3000, None, 60), (None, -7, 60), (1200, None, 40), (None, -4, 40), (600, 0, 20), (100, 2, 0), (None, None, 0)],
    )
    def test_thresholds(self, cape, li, score):
        assert convective_proxy(cape, li) == score


class TestMoonPhase:
    def test_reference_new_moon(self):
        assert moon_phase(datetime(2000, 1, 6, 18, 14, tzinfo=timezone.utc)) == 0

    def test_full_moon(self):
        # Full moon 2024-01-25 17:54 UTC
        assert moon_phase(datetime(2024, 1, 25, 18, 0, tzinfo=timezone.utc)) == 4

    def test_range(self):
        assert 0 <= moon_phase() <= 7


class TestCloudBase:
    def test_lcl(self):
        assert cloud_base_km(25, 15, 60) == 1.25

    def test_clear_sky_has_no_base(self):
        assert cloud_base_km(25, 15, 5) is None


class TestCurrentHourIndex:
    def test_prefix_match(self):
        hourly = {"time": ["2026-10-10T09:00", "2026-10-10T10:00", "2026-10-10T11:00"]}
        assert current_hour_index(hourly, "2026-10-10T10:15") == 1

    def test_fallback_zero(self):
        assert current_hour_index({"time": ["a"]}, None) == 0
        assert current_hour_index({"time": ["2026-10-10T09:00"]}, "2030-01-01T00:00") == 0


def _payload(**over):
    data = {
        "current": {
            "time": "2026-10-10T14:00",
            "temperature_2m": 32.0,
            "relative_humidity_2m": 60,
            "wind_speed_10m": 12.0,
            "wind_gusts_10m": 30.0,
            "weather_code": 2,
            "cloud_cover": 70,
            "uv_index": 9.1,
        },
        "hourly": {
            "time": [f"2026-10-10T{h:02d}:00" for h in range(12, 24)],
            "visibility": [24000] * 12,
            "weather_code": [2, 2, 2, 95, 2, 2, 2, 2, 2, 2, 2, 2],
            "precipitation_probability": [10, 10, 40, 60, 30, 10, 0, 0, 0, 0, 0, 0],
            "cape": [200, 400, 1500, 2600, 800, 0, 0, 0, 0, 0, 0, 0],
        },
        "daily": {
            "time": ["2026-10-10"],
            "temperature_2m_max": [33.0],
            "temperature_2m_min": [17.0],
            "et0_fao_evapotranspiration": [6.4],
        },
    }
    data.update(over)
    return data


class TestDeriveInsights:
    def test_every_rule_field_is_derived_without_tomorrow(self):
        ins = derive_insights(_payload(), now=datetime(2024, 1, 25, 18, tzinfo=timezone.utc))
        for key in (
            "windSpeed", "windGust", "visibility", "dewPoint", "heatStressIndex", "uvHealthConcern",
            "precipitationType", "thunderstormProbability", "gdd10To30", "gdd10To31", "gdd08To30",
            "gdd03To25", "evapotranspiration", "moonPhase", "cloudBase", "cloudCeiling",
        ):
            assert key in ins, key
        assert ins["moonPhase"] == 4
        assert ins["evapotranspiration"] == 6.4
        assert ins["uvHealthConcern"] == 9.1

    def test_visibility_is_km_not_metres(self):
        # Suitability thresholds are 1/2/3/5 km — metres would never trip them.
        ins = derive_insights(_payload())
        assert ins["visibility"] == 24.0

    def test_thunderstorm_takes_max_of_code_and_cape_in_window(self):
        ins = derive_insights(_payload())
        # Hour 3 in the window has WMO 95 (→70) and CAPE 2600 (→60): max wins.
        assert ins["thunderstormProbability"] == 70

    def test_convective_proxy_damped_without_rain_agreement(self):
        data = _payload()
        data["hourly"]["weather_code"] = [2] * 12
        data["hourly"]["precipitation_probability"] = [5] * 12
        assert derive_insights(data)["thunderstormProbability"] == 30  # 60 halved

    def test_gdd_from_daily_extremes(self):
        assert derive_insights(_payload())["gdd10To30"] == 13.5

    def test_ceiling_only_when_broken_cloud(self):
        data = _payload()
        data["current"]["cloud_cover"] = 30
        ins = derive_insights(data)
        assert ins["cloudBase"] is not None
        assert ins["cloudCeiling"] is None

    def test_prefers_model_dew_point(self):
        data = _payload()
        data["hourly"]["dew_point_2m"] = [11.0] * 12
        assert derive_insights(data)["dewPoint"] == 11.0

    def test_empty_payload_does_not_raise(self):
        ins = derive_insights({})
        assert ins["thunderstormProbability"] == 0
        assert "moonPhase" in ins


class TestStripIntermediate:
    def test_removes_only_intermediate_fields(self):
        data = _payload()
        data["hourly"]["lifted_index"] = [0] * 12
        data["hourly"]["dew_point_2m"] = [10] * 12
        out = strip_intermediate(data)
        for k in INTERMEDIATE_HOURLY:
            assert k not in out["hourly"]
        for k in INTERMEDIATE_DAILY:
            assert k not in out["daily"]
        assert out["hourly"]["visibility"] == data["hourly"]["visibility"]
        # Input not mutated.
        assert "cape" in data["hourly"]
