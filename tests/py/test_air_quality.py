"""
Tests for _air_quality.py — EPA AQI algorithm, cache behaviour, endpoint flow.

Covers:
  * EPA breakpoint correctness using reference table anchors
  * Dominant pollutant selection when multiple are elevated
  * AQI level bucketing across all 6 EPA categories
  * Cache hit / miss with deterministic _id keying
  * Circuit breaker integration (open → 503)
  * Edge cases: empty input, missing pollutants, all-clean air
"""

from __future__ import annotations

from datetime import datetime, timezone, timedelta
from unittest.mock import patch, MagicMock

import pytest

from py._air_quality import (
    EPA_BREAKPOINTS,
    AIR_QUALITY_CACHE_TTL_SECONDS,
    WHO_GUIDELINES_UGM3,
    _cache_key,
    _sub_index,
    aqi_level_for,
    compute_aqi,
    get_air_quality,
)
from py._circuit_breaker import _circuit_states


@pytest.fixture(autouse=True)
def _reset_circuit_breaker():
    """Ensure each test starts with a clean breaker state."""
    _circuit_states.clear()
    yield
    _circuit_states.clear()


# ---------------------------------------------------------------------------
# _sub_index — EPA linear interpolation
# ---------------------------------------------------------------------------


class TestSubIndex:
    """EPA sub-index interpolation correctness."""

    def test_pm25_exactly_at_good_top(self):
        # PM2.5 = 12.0 → AQI 50 (top of Good bucket)
        assert _sub_index(12.0, EPA_BREAKPOINTS["pm2_5"]) == 50

    def test_pm25_at_moderate_bottom(self):
        # PM2.5 = 12.1 → AQI 51 (bottom of Moderate)
        assert _sub_index(12.1, EPA_BREAKPOINTS["pm2_5"]) == 51

    def test_pm25_at_unhealthy_sensitive_bottom(self):
        # PM2.5 = 35.5 → AQI 101 (bottom of Unhealthy for Sensitive)
        assert _sub_index(35.5, EPA_BREAKPOINTS["pm2_5"]) == 101

    def test_pm25_at_unhealthy_bottom(self):
        # PM2.5 = 55.5 → AQI 151 (bottom of Unhealthy)
        assert _sub_index(55.5, EPA_BREAKPOINTS["pm2_5"]) == 151

    def test_pm25_at_hazardous_bottom(self):
        # PM2.5 = 250.5 → AQI 301 (bottom of Hazardous)
        assert _sub_index(250.5, EPA_BREAKPOINTS["pm2_5"]) == 301

    def test_pm25_midpoint_of_moderate(self):
        # Midway in the Moderate bucket gets a value between 51 and 100.
        # Bucket: 12.1–35.4 → 51–100. Midpoint ~23.75 → ~75
        result = _sub_index(24.0, EPA_BREAKPOINTS["pm2_5"])
        assert 60 <= result <= 90

    def test_pm10_top_of_good(self):
        # PM10 = 54 → AQI 50
        assert _sub_index(54, EPA_BREAKPOINTS["pm10"]) == 50

    def test_pm10_at_moderate_bottom(self):
        # PM10 = 55 → AQI 51
        assert _sub_index(55, EPA_BREAKPOINTS["pm10"]) == 51

    def test_value_above_top_breakpoint_extrapolates(self):
        # Past the highest breakpoint we still want a meaningful number.
        idx = _sub_index(1000, EPA_BREAKPOINTS["pm2_5"])
        assert idx is not None and idx > 500

    def test_negative_value_returns_none(self):
        assert _sub_index(-1, EPA_BREAKPOINTS["pm2_5"]) is None

    def test_none_value_returns_none(self):
        assert _sub_index(None, EPA_BREAKPOINTS["pm2_5"]) is None  # type: ignore[arg-type]

    def test_zero_returns_zero(self):
        assert _sub_index(0, EPA_BREAKPOINTS["pm2_5"]) == 0


# ---------------------------------------------------------------------------
# aqi_level_for — EPA category bucketing
# ---------------------------------------------------------------------------


class TestAqiLevelFor:
    def test_good(self):
        assert aqi_level_for(0) == "good"
        assert aqi_level_for(50) == "good"

    def test_moderate(self):
        assert aqi_level_for(51) == "moderate"
        assert aqi_level_for(100) == "moderate"

    def test_unhealthy_sensitive(self):
        assert aqi_level_for(101) == "unhealthy_sensitive"
        assert aqi_level_for(150) == "unhealthy_sensitive"

    def test_unhealthy(self):
        assert aqi_level_for(151) == "unhealthy"
        assert aqi_level_for(200) == "unhealthy"

    def test_very_unhealthy(self):
        assert aqi_level_for(201) == "very_unhealthy"
        assert aqi_level_for(300) == "very_unhealthy"

    def test_hazardous(self):
        assert aqi_level_for(301) == "hazardous"
        assert aqi_level_for(500) == "hazardous"
        assert aqi_level_for(750) == "hazardous"  # past 500 still hazardous


# ---------------------------------------------------------------------------
# compute_aqi — dominant pollutant selection
# ---------------------------------------------------------------------------


class TestComputeAqi:
    def test_all_clean_returns_good(self):
        result = compute_aqi({"pm2_5": 2.0, "pm10": 5.0, "o3": 10.0})
        assert result["level"] == "good"
        assert result["aqi"] <= 50

    def test_picks_max_sub_index(self):
        # PM2.5 at 35.5 → AQI 101, PM10 at 10 → AQI ~9
        # Dominant should be PM2.5 with overall AQI 101.
        result = compute_aqi({"pm2_5": 35.5, "pm10": 10})
        assert result["aqi"] == 101
        assert result["dominantPollutant"] == "pm2_5"
        assert result["level"] == "unhealthy_sensitive"

    def test_dominant_when_multiple_elevated(self):
        # Both PM10 and O3 elevated. PM10 = 200 (bucket 155-254, AQI 101-150)
        # gives AQI ~146. O3 = 220 µg/m³ (bucket 207-392, AQI 201-300) gives
        # higher → O3 should be dominant.
        result = compute_aqi({"pm10": 200, "o3": 220})
        assert result["dominantPollutant"] == "o3"
        assert result["aqi"] > 150

    def test_unknown_pollutant_ignored(self):
        result = compute_aqi({"unknownGas": 1000, "pm2_5": 5.0})
        # Should still pick up pm2_5, ignore the unknown.
        assert result["dominantPollutant"] == "pm2_5"

    def test_nh3_ignored_for_aqi_but_data_passes_through(self):
        # NH3 has no EPA breakpoints in our table — should not contribute to AQI
        # but the endpoint still ships nh3 concentration to the UI.
        result = compute_aqi({"nh3": 100, "pm2_5": 3.0})
        # PM2.5 = 3.0 → bucket 0-12, ratio 3/12 of 50 = ~12 AQI
        assert result["dominantPollutant"] == "pm2_5"

    def test_none_values_ignored(self):
        result = compute_aqi({"pm2_5": None, "pm10": 60.0})
        assert result["dominantPollutant"] == "pm10"

    def test_empty_input_returns_zero(self):
        result = compute_aqi({})
        assert result["aqi"] == 0
        assert result["level"] == "good"
        assert result["dominantPollutant"] is None

    def test_all_none_returns_zero(self):
        result = compute_aqi({"pm2_5": None, "pm10": None, "o3": None})
        assert result["aqi"] == 0
        assert result["dominantPollutant"] is None

    def test_sub_indexes_returned_per_pollutant(self):
        result = compute_aqi({"pm2_5": 12.0, "pm10": 54})
        assert result["subIndexes"]["pm2_5"] == 50
        assert result["subIndexes"]["pm10"] == 50


# ---------------------------------------------------------------------------
# _cache_key — deterministic, 4-decimal precision
# ---------------------------------------------------------------------------


class TestCacheKey:
    def test_format_is_four_decimals(self):
        assert _cache_key(-17.8252, 31.0335) == "-17.8252_31.0335"

    def test_truncates_to_four_decimals(self):
        # Two coords differing past 4dp ≈ 11m collapse to same key.
        assert _cache_key(-17.82521, 31.03351) == _cache_key(-17.82522, 31.03352)

    def test_zero_pads_when_needed(self):
        assert _cache_key(0, 0) == "0.0000_0.0000"

    def test_negative_coords(self):
        key = _cache_key(-90, -180)
        assert "-90.0000" in key
        assert "-180.0000" in key


# ---------------------------------------------------------------------------
# Cache hit/miss endpoint flow
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestEndpointCacheFlow:
    async def test_cache_hit_returns_cached_payload(self):
        """When a fresh cache doc exists, the endpoint serves it without
        calling Open-Meteo."""
        cached_doc = {
            "_id": "-17.8252_31.0335",
            "aqi": 73,
            "level": "moderate",
            "dominantPollutant": "pm2_5",
            "pollutants": {"pm2_5": 24.1, "pm10": 38.0},
            "subIndexes": {"pm2_5": 73, "pm10": 35},
            "fetchedAt": datetime.now(timezone.utc),
            "expiresAt": datetime.now(timezone.utc) + timedelta(minutes=30),
        }

        mock_collection = MagicMock()
        mock_collection.find_one.return_value = cached_doc

        with patch(
            "py._air_quality._air_quality_cache_collection",
            return_value=mock_collection,
        ):
            with patch("py._air_quality._fetch_open_meteo_air_quality") as fetch_mock:
                response = await get_air_quality(lat=-17.8252, lon=31.0335)

        # Open-Meteo should NOT be hit on a cache hit
        fetch_mock.assert_not_called()
        body = response.body.decode("utf-8")
        assert "73" in body
        assert "moderate" in body
        assert response.headers["X-Cache"] == "HIT"

    async def test_cache_miss_fetches_and_writes(self):
        """On miss, fetches from Open-Meteo, computes AQI, and persists."""
        mock_collection = MagicMock()
        mock_collection.find_one.return_value = None  # cache miss

        with patch(
            "py._air_quality._air_quality_cache_collection",
            return_value=mock_collection,
        ):
            with patch(
                "py._air_quality._fetch_open_meteo_air_quality",
                return_value={
                    "pm2_5": 12.0, "pm10": 30.0, "o3": 80.0,
                    "no2": 40.0, "so2": 10.0, "co": 500.0, "nh3": 5.0,
                },
            ):
                response = await get_air_quality(lat=-17.8252, lon=31.0335)

        assert response.headers["X-Cache"] == "MISS"
        # Upsert should have been called with the deterministic _id
        assert mock_collection.update_one.called
        args = mock_collection.update_one.call_args
        assert args.kwargs["upsert"] is True
        assert args.args[0]["_id"] == "-17.8252_31.0335"

    async def test_deterministic_id_prevents_duplicates(self):
        """Two writes for the same coords use the same upsert _id."""
        mock_collection = MagicMock()
        mock_collection.find_one.return_value = None

        with patch(
            "py._air_quality._air_quality_cache_collection",
            return_value=mock_collection,
        ):
            with patch(
                "py._air_quality._fetch_open_meteo_air_quality",
                return_value={"pm2_5": 5.0},
            ):
                await get_air_quality(lat=-17.8252, lon=31.0335)
                await get_air_quality(lat=-17.8252, lon=31.0335)

        # Both calls should have upserted with the SAME _id
        first_id = mock_collection.update_one.call_args_list[0].args[0]["_id"]
        second_id = mock_collection.update_one.call_args_list[1].args[0]["_id"]
        assert first_id == second_id


# ---------------------------------------------------------------------------
# Circuit breaker integration
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestCircuitBreaker:
    async def test_open_circuit_returns_503(self):
        """When open_meteo_breaker is open, the endpoint short-circuits with 503."""
        # Force the breaker open
        from py._air_quality import open_meteo_breaker
        for _ in range(10):
            open_meteo_breaker.record_failure()
        assert open_meteo_breaker.is_allowed is False

        from fastapi import HTTPException
        mock_collection = MagicMock()
        mock_collection.find_one.return_value = None

        with patch(
            "py._air_quality._air_quality_cache_collection",
            return_value=mock_collection,
        ):
            with pytest.raises(HTTPException) as exc:
                await get_air_quality(lat=0, lon=0)
        assert exc.value.status_code == 503


# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestValidation:
    async def test_invalid_lat_rejected(self):
        from fastapi import HTTPException
        with pytest.raises(HTTPException) as exc:
            await get_air_quality(lat=999, lon=0)
        assert exc.value.status_code == 400

    async def test_invalid_lon_rejected(self):
        from fastapi import HTTPException
        with pytest.raises(HTTPException) as exc:
            await get_air_quality(lat=0, lon=-500)
        assert exc.value.status_code == 400

    async def test_boundary_lat_accepted(self):
        """Valid extremes (-90, 180) shouldn't be rejected as out of range."""
        mock_collection = MagicMock()
        mock_collection.find_one.return_value = None
        with patch(
            "py._air_quality._air_quality_cache_collection",
            return_value=mock_collection,
        ):
            with patch(
                "py._air_quality._fetch_open_meteo_air_quality",
                return_value={"pm2_5": 5.0},
            ):
                # No HTTPException should be raised for valid extremes.
                response = await get_air_quality(lat=-90, lon=180)
                assert response is not None


# ---------------------------------------------------------------------------
# Constants / WHO guidelines
# ---------------------------------------------------------------------------


class TestConstants:
    def test_cache_ttl_is_one_hour(self):
        assert AIR_QUALITY_CACHE_TTL_SECONDS == 3600

    def test_who_guidelines_present_for_main_pollutants(self):
        for key in ("pm2_5", "pm10", "o3", "no2", "so2", "co"):
            assert key in WHO_GUIDELINES_UGM3
            assert WHO_GUIDELINES_UGM3[key] > 0

    def test_epa_breakpoints_cover_all_six_pollutants(self):
        for key in ("pm2_5", "pm10", "o3", "no2", "so2", "co"):
            assert key in EPA_BREAKPOINTS
            assert len(EPA_BREAKPOINTS[key]) >= 5  # at least the EPA 5 buckets

    def test_breakpoint_anchors_match_epa_reference(self):
        """Spot-check that PM2.5 breakpoint anchors line up with EPA Tech Doc."""
        pm25 = EPA_BREAKPOINTS["pm2_5"]
        # (lo, hi, aqi_lo, aqi_hi)
        assert pm25[0] == (0.0, 12.0, 0, 50)            # Good
        assert pm25[1] == (12.1, 35.4, 51, 100)         # Moderate
        assert pm25[2] == (35.5, 55.4, 101, 150)        # Unhealthy for Sensitive
        assert pm25[3] == (55.5, 150.4, 151, 200)       # Unhealthy
        assert pm25[5] == (250.5, 500.4, 301, 500)      # Hazardous
