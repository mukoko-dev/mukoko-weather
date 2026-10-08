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
    nearest_station_observation,
    station_observation_to_current,
    _sanitize_models,
    _parse_minutely,
    _parse_models,
    _fetch_open_meteo_extras,
    DEFAULT_FORECAST_MODELS,
    KNOWN_FORECAST_MODELS,
    STATION_MAX_AGE_MINUTES,
    STATION_MAX_DISTANCE_KM,
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
        assert _tomorrow_code_to_wmo(2100) == 45  # Light Fog → Fog

    def test_rain_codes(self):
        # Canonical values per Tomorrow.io's documented labels (issue #101):
        # 4001 "Rain" is the moderate baseline; 4200 "Light Rain" is slight.
        assert _tomorrow_code_to_wmo(4000) == 51  # Drizzle → light drizzle
        assert _tomorrow_code_to_wmo(4001) == 63  # Rain → moderate rain
        assert _tomorrow_code_to_wmo(4200) == 61  # Light Rain → slight rain
        assert _tomorrow_code_to_wmo(4201) == 65  # Heavy Rain → heavy rain

    def test_snow_codes(self):
        assert _tomorrow_code_to_wmo(5000) == 73  # Snow → moderate snow
        assert _tomorrow_code_to_wmo(5001) == 71  # Flurries → slight snow
        assert _tomorrow_code_to_wmo(5100) == 71  # Light Snow → slight snow
        assert _tomorrow_code_to_wmo(5101) == 75  # Heavy Snow → heavy snow

    def test_freezing_rain(self):
        assert _tomorrow_code_to_wmo(6000) == 66  # Freezing Drizzle → light freezing rain
        assert _tomorrow_code_to_wmo(6001) == 67  # Freezing Rain → heavy freezing rain
        assert _tomorrow_code_to_wmo(6200) == 66  # Light Freezing Rain
        assert _tomorrow_code_to_wmo(6201) == 67  # Heavy Freezing Rain

    def test_ice_pellets(self):
        # All ice-pellet variants → 77 (snow grains) — the closest WMO code.
        assert _tomorrow_code_to_wmo(7000) == 77
        assert _tomorrow_code_to_wmo(7101) == 77
        assert _tomorrow_code_to_wmo(7102) == 77

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
        assert result["current"]["weather_code"] == 63  # 4001 "Rain" -> moderate
        assert result["hourly"]["weather_code"][0] == 63

    def test_canonical_shape_includes_is_day_and_units(self):
        """The normalization must emit the FULL WeatherData shape (issue #101):
        is_day (current + hourly), precipitation_probability, visibility, and
        current_units — fields the UI depends on (day/night icons, hourly
        cards) that the old Python normalization silently dropped."""
        raw = self._make_raw(hourly_count=2)
        result = _normalize_tomorrow(raw)
        assert result["current"]["is_day"] in (0, 1)
        assert len(result["hourly"]["is_day"]) == 2
        assert len(result["hourly"]["precipitation_probability"]) == 2
        assert len(result["hourly"]["visibility"]) == 2
        assert result["current_units"]["temperature_2m"] == "°C"

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
    def test_spring_november_southern(self, mock_dt):
        mock_dt.now.return_value = datetime(2025, 11, 15, tzinfo=timezone.utc)
        mock_dt.side_effect = lambda *args, **kwargs: datetime(*args, **kwargs)
        # Use elevation 1000 to avoid elevation adjustment
        result = _create_fallback_weather(-17.83, 31.05, 1000)
        # Nov is spring in southern hemisphere: temp=25, code=2
        assert result["current"]["temperature_2m"] == 25
        assert result["current"]["weather_code"] == 2

    @patch("py._weather.datetime")
    def test_summer_january_southern(self, mock_dt):
        mock_dt.now.return_value = datetime(2025, 1, 15, tzinfo=timezone.utc)
        mock_dt.side_effect = lambda *args, **kwargs: datetime(*args, **kwargs)
        result = _create_fallback_weather(-17.83, 31.05, 1000)
        # Jan is summer in southern hemisphere: temp=28, code=2
        assert result["current"]["temperature_2m"] == 28
        assert result["current"]["weather_code"] == 2

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
    def test_spring_september_southern(self, mock_dt):
        mock_dt.now.return_value = datetime(2025, 9, 15, tzinfo=timezone.utc)
        mock_dt.side_effect = lambda *args, **kwargs: datetime(*args, **kwargs)
        result = _create_fallback_weather(-17.83, 31.05, 1000)
        # Sep is spring in southern hemisphere: temp=25, code=2
        assert result["current"]["temperature_2m"] == 25
        assert result["current"]["weather_code"] == 2

    @patch("py._weather.datetime")
    def test_spring_october_southern(self, mock_dt):
        mock_dt.now.return_value = datetime(2025, 10, 15, tzinfo=timezone.utc)
        mock_dt.side_effect = lambda *args, **kwargs: datetime(*args, **kwargs)
        result = _create_fallback_weather(-17.83, 31.05, 1000)
        # Oct is spring in southern hemisphere: temp=25, code=2
        assert result["current"]["temperature_2m"] == 25
        assert result["current"]["weather_code"] == 2

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

    # --- Northern hemisphere tests ---

    @patch("py._weather.datetime")
    def test_summer_july_northern(self, mock_dt):
        """July is summer in northern hemisphere: ~28C, code 2."""
        mock_dt.now.return_value = datetime(2025, 7, 15, tzinfo=timezone.utc)
        mock_dt.side_effect = lambda *args, **kwargs: datetime(*args, **kwargs)
        result = _create_fallback_weather(51.5, -0.12, 50)  # London
        assert result["current"]["temperature_2m"] == 28
        assert result["current"]["weather_code"] == 2

    @patch("py._weather.datetime")
    def test_winter_january_northern(self, mock_dt):
        """January is winter in northern hemisphere: ~5C, code 0."""
        mock_dt.now.return_value = datetime(2025, 1, 15, tzinfo=timezone.utc)
        mock_dt.side_effect = lambda *args, **kwargs: datetime(*args, **kwargs)
        result = _create_fallback_weather(51.5, -0.12, 50)  # London
        assert result["current"]["temperature_2m"] == 5
        assert result["current"]["weather_code"] == 0

    @patch("py._weather.datetime")
    def test_spring_april_northern(self, mock_dt):
        """April is spring in northern hemisphere: ~18C, code 2."""
        mock_dt.now.return_value = datetime(2025, 4, 15, tzinfo=timezone.utc)
        mock_dt.side_effect = lambda *args, **kwargs: datetime(*args, **kwargs)
        result = _create_fallback_weather(48.8, 2.35, 35)  # Paris
        assert result["current"]["temperature_2m"] == 18
        assert result["current"]["weather_code"] == 2

    @patch("py._weather.datetime")
    def test_autumn_october_northern(self, mock_dt):
        """October is autumn in northern hemisphere: ~15C, code 2."""
        mock_dt.now.return_value = datetime(2025, 10, 15, tzinfo=timezone.utc)
        mock_dt.side_effect = lambda *args, **kwargs: datetime(*args, **kwargs)
        result = _create_fallback_weather(40.7, -74.0, 10)  # New York
        assert result["current"]["temperature_2m"] == 15
        assert result["current"]["weather_code"] == 2

    # --- Tropical override tests ---

    @patch("py._weather.datetime")
    def test_tropical_override_near_equator(self, mock_dt):
        """Locations within ±10° of equator always get 28C regardless of month."""
        mock_dt.now.return_value = datetime(2025, 1, 15, tzinfo=timezone.utc)
        mock_dt.side_effect = lambda *args, **kwargs: datetime(*args, **kwargs)
        result = _create_fallback_weather(1.3, 103.8, 15)  # Singapore (lat ~1.3)
        assert result["current"]["temperature_2m"] == 28
        assert result["current"]["weather_code"] == 2

    @patch("py._weather.datetime")
    def test_no_tropical_override_at_lat_14(self, mock_dt):
        """Locations at lat 14.7 should NOT get tropical override (threshold is ±10°)."""
        mock_dt.now.return_value = datetime(2025, 1, 15, tzinfo=timezone.utc)
        mock_dt.side_effect = lambda *args, **kwargs: datetime(*args, **kwargs)
        result = _create_fallback_weather(14.7, -17.5, 22)  # Dakar (lat 14.7N)
        # Jan is winter in northern hemisphere: 5C, not 28C (no tropical override)
        assert result["current"]["temperature_2m"] == 5
        assert result["current"]["weather_code"] == 0


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
    @patch("py._weather._record_weather_history")
    @patch("py._weather._set_cached_weather")
    @patch("py._weather._fetch_open_meteo")
    @patch("py._weather.open_meteo_breaker")
    @patch("py._weather._fetch_tomorrow")
    @patch("py._weather.get_api_key")
    @patch("py._weather.tomorrow_breaker")
    @patch("py._weather._get_cached_weather")
    @patch("py._weather._find_nearest_location")
    async def test_tomorrow_empty_current_falls_back_to_open_meteo(
        self, mock_nearest, mock_cache, mock_tmrw_breaker, mock_key,
        mock_fetch_tmrw, mock_om_breaker, mock_fetch_om, mock_set, mock_record,
    ):
        """_normalize_tomorrow always returns a non-empty dict (with
        hourly/daily/insights keys) even when Tomorrow.io's `timelines.hourly`
        came back empty — `current` itself is `{}` in that case. A plain
        truthiness check on the returned dict would never fall through to
        Open-Meteo; this must be treated as a Tomorrow.io failure instead."""
        mock_nearest.return_value = {"slug": "harare", "elevation": 1200}
        mock_cache.return_value = None
        mock_tmrw_breaker.is_allowed = True
        mock_key.return_value = "fake-key"
        mock_fetch_tmrw.return_value = {"current": {}, "hourly": {}, "daily": {}, "insights": None}
        mock_om_breaker.is_allowed = True
        mock_fetch_om.return_value = {"current": {"temperature_2m": 24}, "hourly": {}, "daily": {}, "insights": None}

        response = await get_weather(-17.83, 31.05)
        assert response.headers.get("x-weather-provider") == "open-meteo"
        mock_tmrw_breaker.record_failure.assert_called_once()
        mock_tmrw_breaker.record_success.assert_not_called()

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


# ---------------------------------------------------------------------------
# StationKit — nearest_station_observation
# ---------------------------------------------------------------------------


class TestNearestStationObservation:
    """Geospatial query against `weather.observations` for ground-truth data."""

    def test_defaults_match_module_constants(self):
        """Function defaults must align with module-level StationKit constants."""
        assert STATION_MAX_DISTANCE_KM == 50
        assert STATION_MAX_AGE_MINUTES == 60

    @patch("py._weather.observations_collection")
    def test_returns_none_when_no_station_nearby(self, mock_coll):
        """Empty cursor → returns None (no nearby station)."""
        mock_cursor = MagicMock()
        mock_cursor.sort.return_value = mock_cursor
        mock_cursor.limit.return_value = iter([])  # list(iter([])) == []
        mock_coll.return_value.find.return_value = mock_cursor

        result = nearest_station_observation(-17.83, 31.05)
        assert result is None

    @patch("py._weather.observations_collection")
    def test_returns_latest_observation_when_one_nearby(self, mock_coll):
        """Cursor with one doc → returns the doc."""
        observed_at = datetime(2026, 6, 29, 12, 0, tzinfo=timezone.utc)
        doc = {
            "_id": "obs-1",
            "observedAt": observed_at,
            "qcStatus": "validated",
            "stationId": "nyuchi-africa-hq-harare",
            "location": {"type": "Point", "coordinates": [31.05, -17.83]},
            "metrics": {"airTemperatureCelsius": 22.4},
        }
        mock_cursor = MagicMock()
        mock_cursor.sort.return_value = mock_cursor
        mock_cursor.limit.return_value = iter([doc])
        mock_coll.return_value.find.return_value = mock_cursor

        result = nearest_station_observation(-17.83, 31.05)
        assert result is not None
        assert result["_id"] == "obs-1"
        assert result["stationId"] == "nyuchi-africa-hq-harare"
        assert result["metrics"]["airTemperatureCelsius"] == 22.4

    @patch("py._weather.observations_collection")
    def test_query_uses_near_sphere_with_max_distance_metres(self, mock_coll):
        """Geospatial filter is $nearSphere on `location` with $maxDistance in metres."""
        mock_cursor = MagicMock()
        mock_cursor.sort.return_value = mock_cursor
        mock_cursor.limit.return_value = iter([])
        mock_coll.return_value.find.return_value = mock_cursor

        nearest_station_observation(-17.83, 31.05, max_distance_km=25)

        call_args = mock_coll.return_value.find.call_args
        query = call_args[0][0]
        assert "location" in query
        near = query["location"]["$nearSphere"]
        assert near["$geometry"]["type"] == "Point"
        assert near["$geometry"]["coordinates"] == [31.05, -17.83]  # [lon, lat]
        assert near["$maxDistance"] == 25 * 1000.0
        assert query["qcStatus"] == "validated"
        assert "$gte" in query["observedAt"]

    @patch("py._weather.observations_collection")
    def test_sorts_by_observed_at_descending_and_limits_one(self, mock_coll):
        """The cursor is sorted observedAt desc and limited to 1."""
        mock_cursor = MagicMock()
        mock_cursor.sort.return_value = mock_cursor
        mock_cursor.limit.return_value = iter([])
        mock_coll.return_value.find.return_value = mock_cursor

        nearest_station_observation(-17.83, 31.05)

        mock_cursor.sort.assert_called_once_with([("observedAt", -1)])
        mock_cursor.limit.assert_called_once_with(1)

    @patch("py._weather.observations_collection")
    def test_returns_none_on_db_exception(self, mock_coll):
        """Missing 2dsphere index / DB error → returns None gracefully."""
        mock_coll.return_value.find.side_effect = Exception("no 2dsphere index")

        result = nearest_station_observation(-17.83, 31.05)
        assert result is None


# ---------------------------------------------------------------------------
# StationKit — station_observation_to_current mapping
# ---------------------------------------------------------------------------


class TestStationObservationToCurrent:
    """Mapping from platform field names to mukoko's `current` block shape."""

    def test_maps_all_metric_fields(self):
        observed_at = datetime(2026, 6, 29, 14, 30, tzinfo=timezone.utc)
        obs = {
            "observedAt": observed_at,
            "metrics": {
                "airTemperatureCelsius": 21.8,
                "relativeHumidityPercent": 58,
                "atmosphericPressureMillibar": 1014,
                "windSpeedKph": 12,
                "windDirectionDegrees": 195,
                "precipitationMillimeters": 0.4,
                "uvIndex": 6,
                "solarRadiationWattsPerSquareMeter": 720,  # not in current shape, ignored
            },
        }

        current = station_observation_to_current(obs)
        assert current["temperature_2m"] == 21.8
        assert current["relative_humidity_2m"] == 58
        assert current["surface_pressure"] == 1014
        assert current["wind_speed_10m"] == 12
        assert current["wind_direction_10m"] == 195
        assert current["precipitation"] == 0.4
        assert current["uv_index"] == 6
        # Solar radiation has no slot in the current block — it should be omitted.
        assert "solarRadiationWattsPerSquareMeter" not in current

    def test_serialises_observed_at_to_isoformat(self):
        observed_at = datetime(2026, 6, 29, 14, 30, tzinfo=timezone.utc)
        obs = {"observedAt": observed_at, "metrics": {"airTemperatureCelsius": 20}}
        current = station_observation_to_current(obs)
        assert current["time"] == observed_at.isoformat()

    def test_passes_through_string_observed_at(self):
        obs = {"observedAt": "2026-06-29T14:30:00Z", "metrics": {}}
        current = station_observation_to_current(obs)
        assert current["time"] == "2026-06-29T14:30:00Z"

    def test_handles_missing_observed_at(self):
        """Falls back to "now" when observedAt is absent."""
        obs = {"metrics": {"airTemperatureCelsius": 20}}
        current = station_observation_to_current(obs)
        assert isinstance(current["time"], str) and len(current["time"]) > 0

    def test_missing_metrics_returns_none_values(self):
        """Fields that the station does not report come back as None — never fabricated."""
        obs = {"observedAt": datetime(2026, 6, 29, tzinfo=timezone.utc), "metrics": {}}
        current = station_observation_to_current(obs)
        assert current["temperature_2m"] is None
        assert current["relative_humidity_2m"] is None
        assert current["uv_index"] is None

    def test_handles_null_metrics_block(self):
        obs = {"observedAt": datetime(2026, 6, 29, tzinfo=timezone.utc), "metrics": None}
        current = station_observation_to_current(obs)
        # Should not crash; all measurement fields are None.
        assert current["temperature_2m"] is None


# ---------------------------------------------------------------------------
# StationKit — endpoint blending
# ---------------------------------------------------------------------------


class TestStationKitEndpointBlending:
    """The /api/py/weather endpoint replaces `current` with station data when present."""

    @pytest.mark.asyncio
    @patch("py._weather._record_weather_history")
    @patch("py._weather._set_cached_weather")
    @patch("py._weather._get_cached_weather")
    @patch("py._weather.nearest_station_observation")
    @patch("py._weather._find_nearest_location")
    async def test_station_hit_with_cache_uses_stationkit_current(
        self, mock_nearest, mock_station, mock_cache, mock_set, mock_record
    ):
        """Station hit + cache hit: current replaced, forecast preserved, header tagged."""
        mock_nearest.return_value = {"slug": "harare", "elevation": 1490}
        mock_station.return_value = {
            "observedAt": datetime(2026, 6, 29, 14, 0, tzinfo=timezone.utc),
            "metrics": {
                "airTemperatureCelsius": 19.2,
                "relativeHumidityPercent": 65,
            },
        }
        mock_cache.return_value = {
            "data": {
                "current": {"temperature_2m": 25.0},  # from Tomorrow.io (will be replaced)
                "hourly": {"time": ["2026-06-29T14:00:00Z"], "temperature_2m": [25.0]},
                "daily": {"time": ["2026-06-29"], "temperature_2m_max": [27.0]},
            },
            "provider": "tomorrow",
        }

        response = await get_weather(-17.83, 31.05)

        assert response.headers.get("x-cache") == "HIT"
        assert response.headers.get("x-weather-provider") == "tomorrow"
        assert response.headers.get("x-current-source") == "stationkit"

    @pytest.mark.asyncio
    @patch("py._weather._record_weather_history")
    @patch("py._weather._set_cached_weather")
    @patch("py._weather._fetch_tomorrow")
    @patch("py._weather.get_api_key")
    @patch("py._weather.tomorrow_breaker")
    @patch("py._weather._get_cached_weather")
    @patch("py._weather.nearest_station_observation")
    @patch("py._weather._find_nearest_location")
    async def test_station_hit_blends_into_fresh_tomorrow_data(
        self, mock_nearest, mock_station, mock_cache, mock_breaker, mock_key,
        mock_fetch, mock_set, mock_record,
    ):
        """Station hit + Tomorrow.io fetch: hourly/daily kept, current overlaid."""
        mock_nearest.return_value = {"slug": "harare", "elevation": 1490}
        mock_station.return_value = {
            "observedAt": datetime(2026, 6, 29, 14, 0, tzinfo=timezone.utc),
            "metrics": {"airTemperatureCelsius": 19.5},
        }
        mock_cache.return_value = None
        mock_breaker.is_allowed = True
        mock_key.return_value = "fake-tomorrow-key"
        mock_fetch.return_value = {
            "current": {"temperature_2m": 24.0},
            "hourly": {"time": ["t1"], "temperature_2m": [24.0]},
            "daily": {"time": ["d1"], "temperature_2m_max": [26.0]},
            "insights": None,
        }

        response = await get_weather(-17.83, 31.05)

        assert response.headers.get("x-cache") == "MISS"
        assert response.headers.get("x-weather-provider") == "tomorrow"
        assert response.headers.get("x-current-source") == "stationkit"

    @pytest.mark.asyncio
    @patch("py._weather._record_weather_history")
    @patch("py._weather._set_cached_weather")
    @patch("py._weather._fetch_tomorrow")
    @patch("py._weather.get_api_key")
    @patch("py._weather.tomorrow_breaker")
    @patch("py._weather._get_cached_weather")
    @patch("py._weather.nearest_station_observation")
    @patch("py._weather._find_nearest_location")
    async def test_no_station_uses_provider_for_current_source(
        self, mock_nearest, mock_station, mock_cache, mock_breaker, mock_key,
        mock_fetch, mock_set, mock_record,
    ):
        """No station within range → X-Current-Source matches the provider that filled `current`."""
        mock_nearest.return_value = {"slug": "harare", "elevation": 1490}
        mock_station.return_value = None
        mock_cache.return_value = None
        mock_breaker.is_allowed = True
        mock_key.return_value = "fake-tomorrow-key"
        mock_fetch.return_value = {"current": {"temperature_2m": 24.0}, "hourly": {}, "daily": {}, "insights": None}

        response = await get_weather(-17.83, 31.05)

        assert response.headers.get("x-current-source") == "tomorrow"
        assert response.headers.get("x-weather-provider") == "tomorrow"

    @pytest.mark.asyncio
    @patch("py._weather._record_weather_history")
    @patch("py._weather._set_cached_weather")
    @patch("py._weather._fetch_open_meteo")
    @patch("py._weather.open_meteo_breaker")
    @patch("py._weather._fetch_tomorrow")
    @patch("py._weather.get_api_key")
    @patch("py._weather.tomorrow_breaker")
    @patch("py._weather._get_cached_weather")
    @patch("py._weather.nearest_station_observation")
    @patch("py._weather._find_nearest_location")
    async def test_open_meteo_fallback_sets_current_source_open_meteo(
        self, mock_nearest, mock_station, mock_cache, mock_tmrw_breaker, mock_key,
        mock_fetch_tmrw, mock_om_breaker, mock_fetch_om, mock_set, mock_record,
    ):
        """No station, Tomorrow.io fails, Open-Meteo wins → X-Current-Source: open-meteo."""
        mock_nearest.return_value = {"slug": "harare", "elevation": 1490}
        mock_station.return_value = None
        mock_cache.return_value = None
        mock_tmrw_breaker.is_allowed = True
        mock_key.return_value = "fake-tomorrow-key"
        mock_fetch_tmrw.return_value = None
        mock_om_breaker.is_allowed = True
        mock_fetch_om.return_value = {"current": {"temperature_2m": 23.0}, "hourly": {}, "daily": {}, "insights": None}

        response = await get_weather(-17.83, 31.05)

        assert response.headers.get("x-current-source") == "open-meteo"
        assert response.headers.get("x-weather-provider") == "open-meteo"

    @pytest.mark.asyncio
    @patch("py._weather._create_fallback_weather")
    @patch("py._weather._fetch_open_meteo")
    @patch("py._weather.open_meteo_breaker")
    @patch("py._weather._fetch_tomorrow")
    @patch("py._weather.get_api_key")
    @patch("py._weather.tomorrow_breaker")
    @patch("py._weather._get_cached_weather")
    @patch("py._weather.nearest_station_observation")
    @patch("py._weather._find_nearest_location")
    async def test_fallback_sets_current_source_fallback(
        self, mock_nearest, mock_station, mock_cache, mock_tmrw_breaker, mock_key,
        mock_fetch_tmrw, mock_om_breaker, mock_fetch_om, mock_fallback,
    ):
        """No station and every provider down → X-Current-Source: fallback."""
        mock_nearest.return_value = {"slug": "harare", "elevation": 1490}
        mock_station.return_value = None
        mock_cache.return_value = None
        mock_tmrw_breaker.is_allowed = False
        mock_om_breaker.is_allowed = False
        mock_fallback.return_value = {
            "current": {"temperature_2m": 18},
            "hourly": {},
            "daily": {},
            "insights": None,
        }

        response = await get_weather(-17.83, 31.05)
        assert response.headers.get("x-current-source") == "fallback"
        assert response.headers.get("x-weather-provider") == "fallback"

    @pytest.mark.asyncio
    @patch("py._weather._create_fallback_weather")
    @patch("py._weather._fetch_open_meteo")
    @patch("py._weather.open_meteo_breaker")
    @patch("py._weather._fetch_tomorrow")
    @patch("py._weather.get_api_key")
    @patch("py._weather.tomorrow_breaker")
    @patch("py._weather._get_cached_weather")
    @patch("py._weather.nearest_station_observation")
    @patch("py._weather._find_nearest_location")
    async def test_station_overrides_fallback_current(
        self, mock_nearest, mock_station, mock_cache, mock_tmrw_breaker, mock_key,
        mock_fetch_tmrw, mock_om_breaker, mock_fetch_om, mock_fallback,
    ):
        """Even when every commercial provider fails, a nearby station still wins for `current`."""
        mock_nearest.return_value = {"slug": "harare", "elevation": 1490}
        mock_station.return_value = {
            "observedAt": datetime(2026, 6, 29, 14, 0, tzinfo=timezone.utc),
            "metrics": {"airTemperatureCelsius": 21.0},
        }
        mock_cache.return_value = None
        mock_tmrw_breaker.is_allowed = False
        mock_om_breaker.is_allowed = False
        mock_fallback.return_value = {
            "current": {"temperature_2m": 18},
            "hourly": {},
            "daily": {},
            "insights": None,
        }

        response = await get_weather(-17.83, 31.05)
        assert response.headers.get("x-weather-provider") == "fallback"
        assert response.headers.get("x-current-source") == "stationkit"

    @pytest.mark.asyncio
    @patch("py._weather._record_weather_history")
    @patch("py._weather._set_cached_weather")
    @patch("py._weather._get_cached_weather")
    @patch("py._weather.nearest_station_observation")
    @patch("py._weather._find_nearest_location")
    async def test_cache_hit_does_not_mutate_cached_doc(
        self, mock_nearest, mock_station, mock_cache, mock_set, mock_record
    ):
        """Blending must not mutate the dict returned by the cache layer (shallow-copy)."""
        mock_nearest.return_value = {"slug": "harare", "elevation": 1490}
        mock_station.return_value = {
            "observedAt": datetime(2026, 6, 29, 14, 0, tzinfo=timezone.utc),
            "metrics": {"airTemperatureCelsius": 19.2},
        }
        cached_current = {"temperature_2m": 25.0}
        cached_data = {"current": cached_current, "hourly": {}, "daily": {}}
        mock_cache.return_value = {"data": cached_data, "provider": "tomorrow"}

        await get_weather(-17.83, 31.05)

        # Cached doc's current must still be the original Tomorrow.io value.
        assert cached_data["current"] is cached_current
        assert cached_data["current"]["temperature_2m"] == 25.0


# ---------------------------------------------------------------------------
# Multi-model — _sanitize_models
# ---------------------------------------------------------------------------


class TestSanitizeModels:
    def test_none_falls_back_to_defaults(self):
        assert _sanitize_models(None) == DEFAULT_FORECAST_MODELS

    def test_empty_falls_back_to_defaults(self):
        assert _sanitize_models([]) == DEFAULT_FORECAST_MODELS

    def test_keeps_only_known_models(self):
        result = _sanitize_models(["ecmwf_ifs04", "not_a_model", "gfs_seamless"])
        assert result == ["ecmwf_ifs04", "gfs_seamless"]

    def test_drops_best_match_from_upstream_request(self):
        # best_match is the unsuffixed baseline — never forwarded as a model.
        result = _sanitize_models(["best_match", "icon_seamless"])
        assert "best_match" not in result
        assert result == ["icon_seamless"]

    def test_best_match_only_falls_back_to_defaults(self):
        assert _sanitize_models(["best_match"]) == DEFAULT_FORECAST_MODELS

    def test_deduplicates(self):
        result = _sanitize_models(["gfs_seamless", "gfs_seamless"])
        assert result == ["gfs_seamless"]

    def test_strips_whitespace(self):
        result = _sanitize_models([" ecmwf_ifs04 ", "meteofrance_seamless"])
        assert result == ["ecmwf_ifs04", "meteofrance_seamless"]

    def test_all_known_models_present(self):
        assert KNOWN_FORECAST_MODELS == {
            "best_match", "gfs_seamless", "ecmwf_ifs04",
            "icon_seamless", "meteofrance_seamless",
        }


# ---------------------------------------------------------------------------
# Multi-model — _parse_minutely
# ---------------------------------------------------------------------------


class TestParseMinutely:
    def test_returns_none_when_absent(self):
        assert _parse_minutely({}) is None
        assert _parse_minutely({"minutely_15": {}}) is None

    def test_returns_none_when_no_times(self):
        assert _parse_minutely({"minutely_15": {"precipitation": []}}) is None

    def test_extracts_time_and_precip(self):
        data = {"minutely_15": {
            "time": ["2025-01-01T00:00", "2025-01-01T00:15", "2025-01-01T00:30", "2025-01-01T00:45"],
            "precipitation": [0.0, 0.2, 0.5, 0.1],
        }}
        result = _parse_minutely(data)
        assert result == {
            "time": ["2025-01-01T00:00", "2025-01-01T00:15", "2025-01-01T00:30", "2025-01-01T00:45"],
            "precipitation": [0.0, 0.2, 0.5, 0.1],
        }

    def test_caps_at_four_steps(self):
        data = {"minutely_15": {
            "time": [f"t{i}" for i in range(8)],
            "precipitation": [float(i) for i in range(8)],
        }}
        result = _parse_minutely(data)
        assert len(result["time"]) == 4
        assert len(result["precipitation"]) == 4

    def test_null_precip_coerced_to_zero(self):
        data = {"minutely_15": {"time": ["t0", "t1"], "precipitation": [None, 0.3]}}
        result = _parse_minutely(data)
        assert result["precipitation"] == [0, 0.3]


# ---------------------------------------------------------------------------
# Multi-model — _parse_models
# ---------------------------------------------------------------------------


class TestParseModels:
    def test_suffixed_keys_per_model(self):
        data = {"hourly": {
            "time": ["t0", "t1"],
            "temperature_2m_gfs_seamless": [20.0, 21.0],
            "precipitation_gfs_seamless": [0.0, 0.5],
            "temperature_2m_ecmwf_ifs04": [19.0, 20.5],
            "precipitation_ecmwf_ifs04": [0.1, 0.2],
        }}
        series, available = _parse_models(data, ["gfs_seamless", "ecmwf_ifs04"])
        assert available == ["gfs_seamless", "ecmwf_ifs04"]
        assert series[0]["model"] == "gfs_seamless"
        assert series[0]["temperature_2m"] == [20.0, 21.0]
        assert series[1]["temperature_2m"] == [19.0, 20.5]

    def test_falls_back_to_unsuffixed_best_match(self):
        data = {"hourly": {
            "time": ["t0"],
            "temperature_2m": [18.0],
            "precipitation": [0.0],
        }}
        series, available = _parse_models(data, ["gfs_seamless"])
        # No suffixed key → uses unsuffixed baseline
        assert available == ["gfs_seamless"]
        assert series[0]["temperature_2m"] == [18.0]

    def test_model_with_all_null_temps_excluded(self):
        data = {"hourly": {
            "time": ["t0", "t1"],
            "temperature_2m_icon_seamless": [None, None],
        }}
        series, available = _parse_models(data, ["icon_seamless"])
        assert available == []
        assert series == []

    def test_caps_at_24(self):
        data = {"hourly": {
            "time": [f"t{i}" for i in range(48)],
            "temperature_2m_gfs_seamless": [float(i) for i in range(48)],
            "precipitation_gfs_seamless": [0.0] * 48,
        }}
        series, _ = _parse_models(data, ["gfs_seamless"])
        assert len(series[0]["temperature_2m"]) == 24
        assert len(series[0]["precipitation"]) == 24


# ---------------------------------------------------------------------------
# Multi-model — _fetch_open_meteo_extras
# ---------------------------------------------------------------------------


class TestFetchOpenMeteoExtras:
    def _mock_client(self, status_code: int, payload: dict) -> MagicMock:
        resp = MagicMock()
        resp.status_code = status_code
        resp.json.return_value = payload
        client = MagicMock()
        client.get.return_value = resp
        return client

    @patch("py._weather._get_http_client")
    def test_returns_none_on_non_200(self, mock_client_fn):
        mock_client_fn.return_value = self._mock_client(500, {})
        assert _fetch_open_meteo_extras(-17.83, 31.05) is None

    @patch("py._weather._get_http_client")
    def test_returns_minutely_and_models(self, mock_client_fn):
        payload = {
            "hourly": {
                "time": ["t0", "t1"],
                "temperature_2m_gfs_seamless": [20.0, 21.0],
                "precipitation_gfs_seamless": [0.0, 0.2],
                "temperature_2m_ecmwf_ifs04": [19.5, 20.0],
                "precipitation_ecmwf_ifs04": [0.1, 0.0],
                "temperature_2m_icon_seamless": [18.0, 18.5],
                "precipitation_icon_seamless": [0.0, 0.0],
            },
            "minutely_15": {
                "time": ["m0", "m1", "m2", "m3"],
                "precipitation": [0.0, 0.1, 0.4, 0.2],
            },
        }
        mock_client_fn.return_value = self._mock_client(200, payload)
        result = _fetch_open_meteo_extras(-17.83, 31.05)
        assert result is not None
        assert result["minutely"]["precipitation"] == [0.0, 0.1, 0.4, 0.2]
        assert result["models_available"] == DEFAULT_FORECAST_MODELS
        assert result["models_time"] == ["t0", "t1"]
        assert len(result["models"]) == 3

    @patch("py._weather._get_http_client")
    def test_requests_minutely_and_models_params(self, mock_client_fn):
        client = self._mock_client(200, {"hourly": {"time": []}, "minutely_15": {}})
        mock_client_fn.return_value = client
        _fetch_open_meteo_extras(-17.83, 31.05, ["ecmwf_ifs04"])
        _, kwargs = client.get.call_args
        params = kwargs["params"]
        assert params["minutely_15"] == "precipitation"
        assert params["forecast_minutely_15"] == "4"
        assert params["models"] == "ecmwf_ifs04"


# ---------------------------------------------------------------------------
# Multi-model — endpoint integration
# ---------------------------------------------------------------------------


class TestEndpointMultiModel:
    @pytest.mark.asyncio
    @patch("py._weather._fetch_open_meteo_extras")
    @patch("py._weather.open_meteo_breaker")
    @patch("py._weather._record_weather_history")
    @patch("py._weather._set_cached_weather")
    @patch("py._weather._get_cached_weather")
    @patch("py._weather.nearest_station_observation")
    @patch("py._weather._find_nearest_location")
    async def test_merges_extras_into_response(
        self, mock_nearest, mock_station, mock_cache, mock_set, mock_record,
        mock_breaker, mock_extras,
    ):
        """minutely + models are merged onto the base response."""
        mock_nearest.return_value = {"slug": "harare", "elevation": 1490}
        mock_station.return_value = None
        mock_cache.return_value = {
            "data": {"current": {"temperature_2m": 25.0}, "hourly": {}, "daily": {}},
            "provider": "tomorrow",
        }
        mock_breaker.is_allowed = True
        mock_extras.return_value = {
            "minutely": {"time": ["m0"], "precipitation": [0.3]},
            "models": [{"model": "gfs_seamless", "temperature_2m": [20.0], "precipitation": [0.0]}],
            "models_available": ["gfs_seamless"],
            "models_time": ["t0"],
        }

        response = await get_weather(-17.83, 31.05)
        import json
        body = json.loads(bytes(response.body))
        assert body["minutely"] == {"time": ["m0"], "precipitation": [0.3]}
        assert body["models_available"] == ["gfs_seamless"]
        assert body["models"][0]["model"] == "gfs_seamless"

    @pytest.mark.asyncio
    @patch("py._weather._fetch_open_meteo_extras")
    @patch("py._weather.open_meteo_breaker")
    @patch("py._weather._record_weather_history")
    @patch("py._weather._set_cached_weather")
    @patch("py._weather._get_cached_weather")
    @patch("py._weather.nearest_station_observation")
    @patch("py._weather._find_nearest_location")
    async def test_models_query_forwarded_to_extras(
        self, mock_nearest, mock_station, mock_cache, mock_set, mock_record,
        mock_breaker, mock_extras,
    ):
        """The ?models= query is parsed and passed to the extras fetch."""
        mock_nearest.return_value = {"slug": "harare", "elevation": 1490}
        mock_station.return_value = None
        mock_cache.return_value = {"data": {"current": {}, "hourly": {}, "daily": {}}, "provider": "tomorrow"}
        mock_breaker.is_allowed = True
        mock_extras.return_value = None

        await get_weather(-17.83, 31.05, models="gfs_seamless,ecmwf_ifs04")
        args, _ = mock_extras.call_args
        assert args[2] == ["gfs_seamless", "ecmwf_ifs04"]

    @pytest.mark.asyncio
    @patch("py._weather._fetch_open_meteo_extras")
    @patch("py._weather.open_meteo_breaker")
    @patch("py._weather._record_weather_history")
    @patch("py._weather._set_cached_weather")
    @patch("py._weather._get_cached_weather")
    @patch("py._weather.nearest_station_observation")
    @patch("py._weather._find_nearest_location")
    async def test_extras_failure_does_not_break_response(
        self, mock_nearest, mock_station, mock_cache, mock_set, mock_record,
        mock_breaker, mock_extras,
    ):
        """An exception in the extras fetch must not fail the whole response."""
        mock_nearest.return_value = {"slug": "harare", "elevation": 1490}
        mock_station.return_value = None
        mock_cache.return_value = {"data": {"current": {"temperature_2m": 25.0}}, "provider": "tomorrow"}
        mock_breaker.is_allowed = True
        mock_extras.side_effect = Exception("open-meteo down")

        response = await get_weather(-17.83, 31.05)
        assert response.headers.get("x-weather-provider") == "tomorrow"

    @pytest.mark.asyncio
    @patch("py._weather._fetch_open_meteo_extras")
    @patch("py._weather.open_meteo_breaker")
    @patch("py._weather._record_weather_history")
    @patch("py._weather._set_cached_weather")
    @patch("py._weather._get_cached_weather")
    @patch("py._weather.nearest_station_observation")
    @patch("py._weather._find_nearest_location")
    async def test_extras_skipped_when_breaker_open(
        self, mock_nearest, mock_station, mock_cache, mock_set, mock_record,
        mock_breaker, mock_extras,
    ):
        """When the Open-Meteo circuit is open, the extras fetch is not attempted."""
        mock_nearest.return_value = {"slug": "harare", "elevation": 1490}
        mock_station.return_value = None
        mock_cache.return_value = {"data": {"current": {}}, "provider": "tomorrow"}
        mock_breaker.is_allowed = False

        await get_weather(-17.83, 31.05)
        mock_extras.assert_not_called()

    @pytest.mark.asyncio
    @patch("py._weather._fetch_open_meteo_extras")
    @patch("py._weather.open_meteo_breaker")
    @patch("py._weather._record_weather_history")
    @patch("py._weather._set_cached_weather")
    @patch("py._weather._get_cached_weather")
    @patch("py._weather.nearest_station_observation")
    @patch("py._weather._find_nearest_location")
    async def test_extras_merge_does_not_mutate_cached_doc(
        self, mock_nearest, mock_station, mock_cache, mock_set, mock_record,
        mock_breaker, mock_extras,
    ):
        """Merging extras must not mutate the dict returned by the cache layer."""
        mock_nearest.return_value = {"slug": "harare", "elevation": 1490}
        mock_station.return_value = None
        cached_data = {"current": {"temperature_2m": 25.0}, "hourly": {}, "daily": {}}
        mock_cache.return_value = {"data": cached_data, "provider": "tomorrow"}
        mock_breaker.is_allowed = True
        mock_extras.return_value = {
            "minutely": {"time": ["m0"], "precipitation": [0.3]},
            "models": [],
            "models_available": [],
            "models_time": [],
        }

        await get_weather(-17.83, 31.05)
        assert "minutely" not in cached_data


# ---------------------------------------------------------------------------
# Single canonical fetch/cache path (issue #101)
# ---------------------------------------------------------------------------


class TestCanonicalWeatherShape:
    """The Python endpoint is the ONLY weather_cache/weather_history writer —
    its output must carry every field the UI consumes."""

    def test_open_meteo_requests_is_day_and_uv_index(self):
        import inspect
        from py._weather import _fetch_open_meteo
        src = inspect.getsource(_fetch_open_meteo)
        assert "uv_index,is_day" in src          # current params
        assert "visibility,is_day" in src        # hourly params

    def test_fallback_weather_includes_is_day_and_units(self):
        from py._weather import _create_fallback_weather
        data = _create_fallback_weather(-17.83, 31.05, 1200)
        assert data["current"]["is_day"] in (0, 1)
        assert data["current"]["uv_index"] is not None
        assert len(data["hourly"]["is_day"]) == 24
        assert data["current_units"]["temperature_2m"] == "°C"

    def test_compute_is_day_uses_sunrise_sunset(self):
        from py._weather import _compute_is_day
        daily = [{"values": {
            "sunriseTime": "2026-07-06T06:00:00Z",
            "sunsetTime": "2026-07-06T18:00:00Z",
        }}]
        assert _compute_is_day("2026-07-06T12:00:00Z", daily) == 1
        assert _compute_is_day("2026-07-06T22:00:00Z", daily) == 0

    def test_compute_is_day_heuristic_without_daily(self):
        from py._weather import _compute_is_day
        assert _compute_is_day("2026-07-06T12:00:00Z", []) == 1
        assert _compute_is_day("2026-07-06T02:00:00Z", []) == 0

    def test_station_blend_preserves_forecast_only_fields(self):
        """StationKit hardware doesn't measure is_day/uv_index — the blend
        must overlay station sensor fields onto the forecast current, not
        replace it wholesale (which used to drop is_day → night icon bug)."""
        import inspect
        import py._weather as w
        src = inspect.getsource(w)
        assert '{**(data.get("current") or {}), **station_current}' in src
