"""Tests for _weather.py — weather proxy, normalization, caching, fallback chain."""

from __future__ import annotations

import time
from datetime import datetime, timezone, timedelta
from unittest.mock import patch, MagicMock

import pytest

from py._weather import (
    _tomorrow_code_to_wmo,
    _normalize_tomorrow,
    _create_fallback_weather,
    _get_cached_weather,
    _set_cached_weather,
    _record_weather_history,
    WEATHER_CACHE_TTL,
    get_weather,
)


# ---------------------------------------------------------------------------
# _tomorrow_code_to_wmo
# ---------------------------------------------------------------------------


class TestTomorrowCodeToWmo:
    def test_clear_sky(self):
        assert _tomorrow_code_to_wmo(0) == 0
        assert _tomorrow_code_to_wmo(1000) == 0

    def test_partly_cloudy(self):
        assert _tomorrow_code_to_wmo(1100) == 1
        assert _tomorrow_code_to_wmo(1101) == 2

    def test_overcast(self):
        assert _tomorrow_code_to_wmo(1001) == 3

    def test_fog_codes(self):
        assert _tomorrow_code_to_wmo(2000) == 45
        assert _tomorrow_code_to_wmo(2100) == 48

    def test_rain_codes(self):
        assert _tomorrow_code_to_wmo(4000) == 51  # drizzle
        assert _tomorrow_code_to_wmo(4001) == 61  # rain
        assert _tomorrow_code_to_wmo(4200) == 63  # heavy rain
        assert _tomorrow_code_to_wmo(4201) == 65  # intense rain

    def test_snow_codes(self):
        assert _tomorrow_code_to_wmo(5000) == 71
        assert _tomorrow_code_to_wmo(5001) == 73
        assert _tomorrow_code_to_wmo(5100) == 75
        assert _tomorrow_code_to_wmo(5101) == 77

    def test_freezing_rain(self):
        assert _tomorrow_code_to_wmo(6000) == 56
        assert _tomorrow_code_to_wmo(6001) == 66
        assert _tomorrow_code_to_wmo(6200) == 67
        assert _tomorrow_code_to_wmo(6201) == 67

    def test_ice_pellets(self):
        assert _tomorrow_code_to_wmo(7000) == 77
        assert _tomorrow_code_to_wmo(7101) == 85
        assert _tomorrow_code_to_wmo(7102) == 86

    def test_thunderstorm(self):
        assert _tomorrow_code_to_wmo(8000) == 95

    def test_unknown_code_returns_zero(self):
        assert _tomorrow_code_to_wmo(9999) == 0
        assert _tomorrow_code_to_wmo(-1) == 0
        assert _tomorrow_code_to_wmo(12345) == 0


# ---------------------------------------------------------------------------
# _normalize_tomorrow
# ---------------------------------------------------------------------------


class TestNormalizeTomorrow:
    def _make_raw(self, hourly_count: int = 1, daily_count: int = 1) -> dict:
        """Create a minimal Tomorrow.io raw response."""
        hourly = []
        for i in range(hourly_count):
            hourly.append({
                "time": f"2025-01-01T{i:02d}:00:00Z",
                "values": {
                    "temperature": 25 + i,
                    "humidity": 60,
                    "temperatureApparent": 24 + i,
                    "precipitationIntensity": 0.5,
                    "weatherCode": 1000,
                    "windSpeed": 10,
                    "windDirection": 180,
                    "windGust": 15,
                    "pressureSurfaceLevel": 1013,
                    "cloudCover": 30,
                    "uvIndex": 5,
                },
            })

        daily = []
        for i in range(daily_count):
            daily.append({
                "time": f"2025-01-0{i + 1}T00:00:00Z",
                "values": {
                    "temperatureMax": 30 + i,
                    "temperatureMin": 15,
                    "temperatureApparentMax": 29,
                    "temperatureApparentMin": 14,
                    "precipitationIntensityMax": 2,
                    "precipitationProbabilityMax": 40,
                    "weatherCodeMax": 1001,
                    "windSpeedMax": 20,
                    "windGustMax": 30,
                    "windDirectionAvg": 200,
                    "uvIndexMax": 8,
                    "sunriseTime": "06:00",
                    "sunsetTime": "18:00",
                    "heatIndexMax": 35,
                    "thunderstormProbability": 10,
                    "visibilityAvg": 15,
                    "dewPointAvg": 18,
                },
            })

        return {"timelines": {"hourly": hourly, "daily": daily}}

    def test_current_from_first_hourly(self):
        raw = self._make_raw(hourly_count=5)
        result = _normalize_tomorrow(raw)
        assert result["current"]["temperature_2m"] == 25
        assert result["current"]["time"] == "2025-01-01T00:00:00Z"

    def test_hourly_capped_at_24(self):
        raw = self._make_raw(hourly_count=48)
        result = _normalize_tomorrow(raw)
        assert len(result["hourly"]["time"]) == 24
        assert len(result["hourly"]["temperature_2m"]) == 24

    def test_daily_capped_at_7(self):
        raw = self._make_raw(daily_count=14)
        result = _normalize_tomorrow(raw)
        assert len(result["daily"]["time"]) == 7
        assert len(result["daily"]["temperature_2m_max"]) == 7

    def test_insights_extracted_from_first_daily(self):
        raw = self._make_raw(daily_count=3)
        result = _normalize_tomorrow(raw)
        insights = result["insights"]
        assert insights is not None
        assert insights["heatStressIndex"] == 35
        assert insights["thunderstormProbability"] == 10
        assert insights["visibility"] == 15
        assert insights["dewPoint"] == 18

    def test_none_values_filtered_from_insights(self):
        """Insight fields that are None in the API response should be removed."""
        raw = self._make_raw(daily_count=1)
        # Remove some insight fields
        raw["timelines"]["daily"][0]["values"]["heatIndexMax"] = None
        raw["timelines"]["daily"][0]["values"]["moonPhase"] = None
        result = _normalize_tomorrow(raw)
        insights = result["insights"]
        assert "heatStressIndex" not in insights
        assert "moonPhase" not in insights

    def test_empty_hourly_produces_empty_current(self):
        raw = {"timelines": {"hourly": [], "daily": []}}
        result = _normalize_tomorrow(raw)
        assert result["current"] == {}
        assert result["hourly"]["time"] == []

    def test_empty_daily_produces_none_insights(self):
        raw = {"timelines": {"hourly": [], "daily": []}}
        result = _normalize_tomorrow(raw)
        assert result["insights"] is None

    def test_result_has_required_keys(self):
        raw = self._make_raw()
        result = _normalize_tomorrow(raw)
        assert "current" in result
        assert "hourly" in result
        assert "daily" in result
        assert "insights" in result

    def test_weather_code_mapped_through_wmo(self):
        raw = self._make_raw(hourly_count=1)
        raw["timelines"]["hourly"][0]["values"]["weatherCode"] = 4001
        result = _normalize_tomorrow(raw)
        assert result["current"]["weather_code"] == 61  # 4001 -> 61
        assert result["hourly"]["weather_code"][0] == 61

    def test_missing_timelines_produces_empty_result(self):
        raw = {}
        result = _normalize_tomorrow(raw)
        assert result["current"] == {}
        assert result["hourly"]["time"] == []
        assert result["daily"]["time"] == []


# ---------------------------------------------------------------------------
# _create_fallback_weather
# ---------------------------------------------------------------------------


class TestCreateFallbackWeather:
    @patch("py._weather.datetime")
    def test_rainy_season_november(self, mock_dt):
        mock_dt.now.return_value = datetime(2025, 11, 15, tzinfo=timezone.utc)
        mock_dt.side_effect = lambda *args, **kwargs: datetime(*args, **kwargs)
        # Use elevation 1000 to avoid elevation adjustment
        result = _create_fallback_weather(-17.83, 31.05, 1000)
        # Nov is rainy season: temp=28, code=61
        assert result["current"]["temperature_2m"] == 28
        assert result["current"]["weather_code"] == 61

    @patch("py._weather.datetime")
    def test_rainy_season_january(self, mock_dt):
        mock_dt.now.return_value = datetime(2025, 1, 15, tzinfo=timezone.utc)
        mock_dt.side_effect = lambda *args, **kwargs: datetime(*args, **kwargs)
        result = _create_fallback_weather(-17.83, 31.05, 1000)
        assert result["current"]["temperature_2m"] == 28
        assert result["current"]["weather_code"] == 61

    @patch("py._weather.datetime")
    def test_post_rain_april(self, mock_dt):
        mock_dt.now.return_value = datetime(2025, 4, 15, tzinfo=timezone.utc)
        mock_dt.side_effect = lambda *args, **kwargs: datetime(*args, **kwargs)
        result = _create_fallback_weather(-17.83, 31.05, 1000)
        assert result["current"]["temperature_2m"] == 22
        assert result["current"]["weather_code"] == 2

    @patch("py._weather.datetime")
    def test_dry_cold_june(self, mock_dt):
        mock_dt.now.return_value = datetime(2025, 6, 15, tzinfo=timezone.utc)
        mock_dt.side_effect = lambda *args, **kwargs: datetime(*args, **kwargs)
        result = _create_fallback_weather(-17.83, 31.05, 1000)
        assert result["current"]["temperature_2m"] == 18
        assert result["current"]["weather_code"] == 0

    @patch("py._weather.datetime")
    def test_dry_cold_august(self, mock_dt):
        mock_dt.now.return_value = datetime(2025, 8, 15, tzinfo=timezone.utc)
        mock_dt.side_effect = lambda *args, **kwargs: datetime(*args, **kwargs)
        result = _create_fallback_weather(-17.83, 31.05, 1000)
        assert result["current"]["temperature_2m"] == 18
        assert result["current"]["weather_code"] == 0

    @patch("py._weather.datetime")
    def test_hot_dry_september(self, mock_dt):
        mock_dt.now.return_value = datetime(2025, 9, 15, tzinfo=timezone.utc)
        mock_dt.side_effect = lambda *args, **kwargs: datetime(*args, **kwargs)
        result = _create_fallback_weather(-17.83, 31.05, 1000)
        assert result["current"]["temperature_2m"] == 32
        assert result["current"]["weather_code"] == 0

    @patch("py._weather.datetime")
    def test_hot_dry_october(self, mock_dt):
        mock_dt.now.return_value = datetime(2025, 10, 15, tzinfo=timezone.utc)
        mock_dt.side_effect = lambda *args, **kwargs: datetime(*args, **kwargs)
        result = _create_fallback_weather(-17.83, 31.05, 1000)
        assert result["current"]["temperature_2m"] == 32
        assert result["current"]["weather_code"] == 0

    @patch("py._weather.datetime")
    def test_elevation_adjustment(self, mock_dt):
        """Temperatures decrease by 0.006 per meter above 1000m."""
        mock_dt.now.return_value = datetime(2025, 6, 15, tzinfo=timezone.utc)
        mock_dt.side_effect = lambda *args, **kwargs: datetime(*args, **kwargs)
        # At 2000m: adj = (2000-1000) * 0.006 = 6.0
        result = _create_fallback_weather(-17.83, 31.05, 2000)
        assert result["current"]["temperature_2m"] == 12.0  # 18 - 6.0

    @patch("py._weather.datetime")
    def test_low_elevation_no_adjustment(self, mock_dt):
        """Elevation below 1000m should not adjust temperature."""
        mock_dt.now.return_value = datetime(2025, 6, 15, tzinfo=timezone.utc)
        mock_dt.side_effect = lambda *args, **kwargs: datetime(*args, **kwargs)
        result = _create_fallback_weather(-17.83, 31.05, 500)
        assert result["current"]["temperature_2m"] == 18  # No adjustment

    @patch("py._weather.datetime")
    def test_structure_has_all_keys(self, mock_dt):
        mock_dt.now.return_value = datetime(2025, 7, 15, tzinfo=timezone.utc)
        mock_dt.side_effect = lambda *args, **kwargs: datetime(*args, **kwargs)
        result = _create_fallback_weather(-17.83, 31.05, 1200)
        assert "current" in result
        assert "hourly" in result
        assert "daily" in result
        assert "insights" in result
        assert result["insights"] is None

    @patch("py._weather.datetime")
    def test_hourly_has_24_entries(self, mock_dt):
        mock_dt.now.return_value = datetime(2025, 7, 15, tzinfo=timezone.utc)
        mock_dt.side_effect = lambda *args, **kwargs: datetime(*args, **kwargs)
        result = _create_fallback_weather(-17.83, 31.05, 1200)
        assert len(result["hourly"]["time"]) == 24
        assert len(result["hourly"]["temperature_2m"]) == 24

    @patch("py._weather.datetime")
    def test_daily_has_7_entries(self, mock_dt):
        mock_dt.now.return_value = datetime(2025, 7, 15, tzinfo=timezone.utc)
        mock_dt.side_effect = lambda *args, **kwargs: datetime(*args, **kwargs)
        result = _create_fallback_weather(-17.83, 31.05, 1200)
        assert len(result["daily"]["time"]) == 7
        assert len(result["daily"]["temperature_2m_max"]) == 7


# ---------------------------------------------------------------------------
# WEATHER_CACHE_TTL
# ---------------------------------------------------------------------------


class TestWeatherCacheTtl:
    def test_cache_ttl_is_900(self):
        assert WEATHER_CACHE_TTL == 900


# ---------------------------------------------------------------------------
# _get_cached_weather
# ---------------------------------------------------------------------------


class TestGetCachedWeather:
    @patch("py._weather.weather_cache_collection")
    def test_returns_cached_doc(self, mock_coll):
        mock_coll.return_value.find_one.return_value = {
            "data": {"current": {"temperature_2m": 25}},
            "provider": "tomorrow",
        }
        result = _get_cached_weather("harare")
        assert result is not None
        assert result["provider"] == "tomorrow"

    @patch("py._weather.weather_cache_collection")
    def test_returns_none_when_not_cached(self, mock_coll):
        mock_coll.return_value.find_one.return_value = None
        result = _get_cached_weather("harare")
        assert result is None

    @patch("py._weather.weather_cache_collection")
    def test_queries_with_expiry_filter(self, mock_coll):
        mock_coll.return_value.find_one.return_value = None
        _get_cached_weather("harare")
        call_args = mock_coll.return_value.find_one.call_args
        query = call_args[0][0]
        assert query["locationSlug"] == "harare"
        assert "$gt" in query["expiresAt"]


# ---------------------------------------------------------------------------
# _set_cached_weather
# ---------------------------------------------------------------------------


class TestSetCachedWeather:
    @patch("py._weather.weather_cache_collection")
    def test_calls_update_one_with_upsert(self, mock_coll):
        data = {"current": {"temperature_2m": 25}}
        _set_cached_weather("harare", -17.83, 31.05, data, "tomorrow")
        mock_coll.return_value.update_one.assert_called_once()

        call_args = mock_coll.return_value.update_one.call_args
        assert call_args[0][0] == {"locationSlug": "harare"}
        update_doc = call_args[0][1]["$set"]
        assert update_doc["data"] == data
        assert update_doc["provider"] == "tomorrow"
        assert update_doc["lat"] == -17.83
        assert update_doc["lon"] == 31.05
        assert call_args[1]["upsert"] is True

    @patch("py._weather.weather_cache_collection")
    def test_sets_expiry_in_future(self, mock_coll):
        _set_cached_weather("harare", -17.83, 31.05, {}, "tomorrow")
        call_args = mock_coll.return_value.update_one.call_args
        update_doc = call_args[0][1]["$set"]
        fetched = update_doc["fetchedAt"]
        expires = update_doc["expiresAt"]
        assert expires > fetched
        diff = (expires - fetched).total_seconds()
        assert diff == WEATHER_CACHE_TTL


# ---------------------------------------------------------------------------
# _record_weather_history
# ---------------------------------------------------------------------------


class TestRecordWeatherHistory:
    @patch("py._db.get_db")
    def test_records_current_data(self, mock_db):
        mock_history = MagicMock()
        mock_db.return_value.__getitem__ = MagicMock(return_value=mock_history)

        data = {
            "current": {"temperature_2m": 25, "weather_code": 0},
            "daily": {"time": [], "weather_code": []},
        }
        _record_weather_history("harare", data)
        mock_history.insert_one.assert_called_once()
        record = mock_history.insert_one.call_args[0][0]
        assert record["locationSlug"] == "harare"
        assert record["current"] == data["current"]

    @patch("py._db.get_db")
    def test_includes_daily_when_present(self, mock_db):
        mock_history = MagicMock()
        mock_db.return_value.__getitem__ = MagicMock(return_value=mock_history)

        data = {
            "current": {"temperature_2m": 25},
            "daily": {
                "time": ["2025-01-01"],
                "weather_code": [0],
                "temperature_2m_max": [30],
                "temperature_2m_min": [15],
                "apparent_temperature_max": [29],
                "apparent_temperature_min": [14],
                "precipitation_sum": [0],
                "precipitation_probability_max": [10],
                "wind_speed_10m_max": [15],
                "wind_gusts_10m_max": [25],
                "wind_direction_10m_dominant": [180],
                "uv_index_max": [7],
                "sunrise": ["06:00"],
                "sunset": ["18:00"],
            },
        }
        _record_weather_history("harare", data)
        record = mock_history.insert_one.call_args[0][0]
        assert "daily" in record
        assert record["daily"]["date"] == "2025-01-01"
        assert record["daily"]["tempMax"] == 30

    @patch("py._db.get_db")
    def test_includes_insights_when_present(self, mock_db):
        mock_history = MagicMock()
        mock_db.return_value.__getitem__ = MagicMock(return_value=mock_history)

        data = {
            "current": {"temperature_2m": 25},
            "daily": {"time": [], "weather_code": []},
            "insights": {"heatStressIndex": 35},
        }
        _record_weather_history("harare", data)
        record = mock_history.insert_one.call_args[0][0]
        assert record["insights"] == {"heatStressIndex": 35}

    @patch("py._db.get_db")
    def test_omits_insights_when_not_present(self, mock_db):
        mock_history = MagicMock()
        mock_db.return_value.__getitem__ = MagicMock(return_value=mock_history)

        data = {
            "current": {"temperature_2m": 25},
            "daily": {"time": [], "weather_code": []},
        }
        _record_weather_history("harare", data)
        record = mock_history.insert_one.call_args[0][0]
        assert "insights" not in record


# ---------------------------------------------------------------------------
# get_weather endpoint
# ---------------------------------------------------------------------------


class TestGetWeatherEndpoint:
    @pytest.mark.asyncio
    async def test_invalid_latitude_raises_400(self):
        with pytest.raises(Exception) as exc_info:
            await get_weather(lat=-91, lon=31.05)
        assert "400" in str(exc_info.value.status_code)

    @pytest.mark.asyncio
    async def test_invalid_longitude_raises_400(self):
        with pytest.raises(Exception) as exc_info:
            await get_weather(lat=-17, lon=181)
        assert "400" in str(exc_info.value.status_code)

    @pytest.mark.asyncio
    async def test_invalid_negative_longitude_raises_400(self):
        with pytest.raises(Exception) as exc_info:
            await get_weather(lat=-17, lon=-181)
        assert "400" in str(exc_info.value.status_code)

    @pytest.mark.asyncio
    @patch("py._weather._record_weather_history")
    @patch("py._weather._set_cached_weather")
    @patch("py._weather._get_cached_weather")
    @patch("py._weather._find_nearest_location")
    async def test_cache_hit_returns_hit_header(self, mock_nearest, mock_get_cache, mock_set_cache, mock_record):
        """Cache hit should return X-Cache: HIT."""
        mock_nearest.return_value = {"slug": "harare", "elevation": 1200}
        mock_get_cache.return_value = {
            "data": {"current": {"temperature_2m": 25}},
            "provider": "tomorrow",
        }

        response = await get_weather(-17.83, 31.05)
        assert response.headers.get("x-cache") == "HIT"
        assert response.headers.get("x-weather-provider") == "tomorrow"

    @pytest.mark.asyncio
    @patch("py._weather._record_weather_history")
    @patch("py._weather._set_cached_weather")
    @patch("py._weather._fetch_tomorrow")
    @patch("py._weather.get_api_key")
    @patch("py._weather.tomorrow_breaker")
    @patch("py._weather._get_cached_weather")
    @patch("py._weather._find_nearest_location")
    async def test_tomorrow_success(self, mock_nearest, mock_cache, mock_breaker, mock_key, mock_fetch, mock_set, mock_record):
        """When cache misses and Tomorrow.io succeeds."""
        mock_nearest.return_value = {"slug": "harare", "elevation": 1200}
        mock_cache.return_value = None
        mock_breaker.is_allowed = True
        mock_key.return_value = "fake-key"
        mock_fetch.return_value = {"current": {"temperature_2m": 26}, "hourly": {}, "daily": {}, "insights": None}

        response = await get_weather(-17.83, 31.05)
        assert response.headers.get("x-cache") == "MISS"
        assert response.headers.get("x-weather-provider") == "tomorrow"
        mock_breaker.record_success.assert_called_once()

    @pytest.mark.asyncio
    @patch("py._weather._record_weather_history")
    @patch("py._weather._set_cached_weather")
    @patch("py._weather._fetch_open_meteo")
    @patch("py._weather.open_meteo_breaker")
    @patch("py._weather._fetch_tomorrow")
    @patch("py._weather.get_api_key")
    @patch("py._weather.tomorrow_breaker")
    @patch("py._weather._get_cached_weather")
    @patch("py._weather._find_nearest_location")
    async def test_open_meteo_fallback(self, mock_nearest, mock_cache, mock_tmrw_breaker, mock_key,
                                        mock_fetch_tmrw, mock_om_breaker, mock_fetch_om, mock_set, mock_record):
        """When Tomorrow.io fails, falls back to Open-Meteo."""
        mock_nearest.return_value = {"slug": "harare", "elevation": 1200}
        mock_cache.return_value = None
        mock_tmrw_breaker.is_allowed = True
        mock_key.return_value = "fake-key"
        mock_fetch_tmrw.return_value = None  # Tomorrow fails
        mock_om_breaker.is_allowed = True
        mock_fetch_om.return_value = {"current": {"temperature_2m": 24}, "hourly": {}, "daily": {}, "insights": None}

        response = await get_weather(-17.83, 31.05)
        assert response.headers.get("x-weather-provider") == "open-meteo"

    @pytest.mark.asyncio
    @patch("py._weather._create_fallback_weather")
    @patch("py._weather._fetch_open_meteo")
    @patch("py._weather.open_meteo_breaker")
    @patch("py._weather._fetch_tomorrow")
    @patch("py._weather.get_api_key")
    @patch("py._weather.tomorrow_breaker")
    @patch("py._weather._get_cached_weather")
    @patch("py._weather._find_nearest_location")
    async def test_seasonal_fallback(self, mock_nearest, mock_cache, mock_tmrw_breaker, mock_key,
                                      mock_fetch_tmrw, mock_om_breaker, mock_fetch_om, mock_fallback):
        """When all providers fail, use seasonal estimates."""
        mock_nearest.return_value = {"slug": "harare", "elevation": 1200}
        mock_cache.return_value = None
        mock_tmrw_breaker.is_allowed = True
        mock_key.return_value = "fake-key"
        mock_fetch_tmrw.return_value = None
        mock_om_breaker.is_allowed = True
        mock_fetch_om.return_value = None
        mock_fallback.return_value = {
            "current": {"temperature_2m": 20},
            "hourly": {},
            "daily": {},
            "insights": None,
        }

        response = await get_weather(-17.83, 31.05)
        assert response.headers.get("x-weather-provider") == "fallback"
        mock_fallback.assert_called_once()

    @pytest.mark.asyncio
    @patch("py._weather._create_fallback_weather")
    @patch("py._weather._fetch_open_meteo")
    @patch("py._weather.open_meteo_breaker")
    @patch("py._weather.get_api_key")
    @patch("py._weather.tomorrow_breaker")
    @patch("py._weather._get_cached_weather")
    @patch("py._weather._find_nearest_location")
    async def test_circuit_breaker_integration_tomorrow_closed(self, mock_nearest, mock_cache,
                                                                mock_tmrw_breaker, mock_key,
                                                                mock_om_breaker, mock_fetch_om, mock_fallback):
        """When Tomorrow.io circuit is open, skip directly to Open-Meteo."""
        mock_nearest.return_value = {"slug": "harare", "elevation": 1200}
        mock_cache.return_value = None
        mock_tmrw_breaker.is_allowed = False  # Circuit open
        mock_om_breaker.is_allowed = True
        mock_fetch_om.return_value = {"current": {"temperature_2m": 24}, "hourly": {}, "daily": {}, "insights": None}

        response = await get_weather(-17.83, 31.05)
        assert response.headers.get("x-weather-provider") == "open-meteo"

    @pytest.mark.asyncio
    @patch("py._weather._record_weather_history")
    @patch("py._weather._set_cached_weather")
    @patch("py._weather._fetch_tomorrow")
    @patch("py._weather.get_api_key")
    @patch("py._weather.tomorrow_breaker")
    @patch("py._weather._get_cached_weather")
    @patch("py._weather._find_nearest_location")
    async def test_does_not_cache_fallback_data(self, mock_nearest, mock_cache, mock_tmrw_breaker,
                                                 mock_key, mock_fetch_tmrw, mock_set, mock_record):
        """Seasonal fallback data should not be cached."""
        mock_nearest.return_value = {"slug": "harare", "elevation": 1200}
        mock_cache.return_value = None
        mock_tmrw_breaker.is_allowed = False

        with patch("py._weather.open_meteo_breaker") as mock_om:
            mock_om.is_allowed = False

            await get_weather(-17.83, 31.05)
            mock_set.assert_not_called()
            mock_record.assert_not_called()

    @pytest.mark.asyncio
    @patch("py._weather._find_nearest_location")
    @patch("py._weather._get_cached_weather")
    async def test_nearest_location_exception_handled(self, mock_cache, mock_nearest):
        """Exception in nearest location lookup should not crash the endpoint."""
        mock_nearest.side_effect = Exception("DB down")
        mock_cache.return_value = None

        with patch("py._weather.tomorrow_breaker") as mock_tb:
            mock_tb.is_allowed = False
            with patch("py._weather.open_meteo_breaker") as mock_ob:
                mock_ob.is_allowed = False

                response = await get_weather(-17.83, 31.05)
                assert response.headers.get("x-weather-provider") == "fallback"
