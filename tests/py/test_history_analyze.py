"""Tests for _history_analyze.py — AI history analysis endpoint and stats aggregation."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import patch, MagicMock, PropertyMock

import anthropic
import pytest
from fastapi import HTTPException

from py._history_analyze import (
    _aggregate_stats,
    _build_analysis_system_prompt,
    _FALLBACK_SYSTEM_PROMPT,
    analyze_history,
    AnalyzeRequest,
    RATE_LIMIT_MAX,
)


# ---------------------------------------------------------------------------
# _aggregate_stats — server-side data aggregation
# ---------------------------------------------------------------------------


class TestAggregateStats:
    def test_empty_records_returns_no_data(self):
        """Empty record list should return a 'No data available' message."""
        result = _aggregate_stats([])
        assert result == "No data available for the selected period."

    def test_extracts_temperature_highs_from_daily(self):
        """Should extract temperature highs from daily.temperature_2m_max."""
        records = [
            {
                "date": "2025-01-15",
                "current": {},
                "daily": {"temperature_2m_max": [30.5], "temperature_2m_min": [18.0]},
            },
            {
                "date": "2025-01-16",
                "current": {},
                "daily": {"temperature_2m_max": [28.0], "temperature_2m_min": [16.0]},
            },
        ]
        result = _aggregate_stats(records)
        assert "avg high 29.2" in result  # (30.5 + 28.0) / 2
        assert "avg low 17.0" in result   # (18.0 + 16.0) / 2

    def test_falls_back_to_current_temperature_when_daily_missing(self):
        """When daily high is missing, should use current.temperature_2m."""
        records = [
            {
                "date": "2025-01-15",
                "current": {"temperature_2m": 25.0},
                "daily": {},
            },
        ]
        result = _aggregate_stats(records)
        assert "avg high 25.0" in result

    def test_falls_back_when_daily_max_is_none(self):
        """When daily.temperature_2m_max is [None], fall back to current."""
        records = [
            {
                "date": "2025-01-15",
                "current": {"temperature_2m": 22.0},
                "daily": {"temperature_2m_max": [None]},
            },
        ]
        result = _aggregate_stats(records)
        assert "avg high 22.0" in result

    def test_calculates_precipitation_totals_and_rainy_days(self):
        """Should calculate total precipitation and count rainy days (>0.1mm)."""
        records = [
            {"date": "2025-01-15", "current": {}, "daily": {"precipitation_sum": [5.0]}},
            {"date": "2025-01-16", "current": {}, "daily": {"precipitation_sum": [0.0]}},
            {"date": "2025-01-17", "current": {}, "daily": {"precipitation_sum": [12.0]}},
            {"date": "2025-01-18", "current": {}, "daily": {"precipitation_sum": [0.05]}},
        ]
        result = _aggregate_stats(records)
        assert "total 17.1mm" in result  # 5.0 + 0.0 + 12.0 + 0.05 = 17.05 rounds to 17.1
        assert "2 rainy days" in result   # only 5.0 and 12.0 are > 0.1

    def test_detects_warming_trend(self):
        """Should detect warming trend when >= 8 data points with >1 degree difference."""
        records = [
            {"date": f"2025-01-{i:02d}", "current": {}, "daily": {"temperature_2m_max": [20 + i]}}
            for i in range(1, 13)  # 12 points, clear warming trend
        ]
        result = _aggregate_stats(records)
        assert "warming" in result

    def test_detects_cooling_trend(self):
        """Should detect cooling trend with negative temperature difference."""
        records = [
            {"date": f"2025-01-{i:02d}", "current": {}, "daily": {"temperature_2m_max": [35 - i]}}
            for i in range(1, 13)  # 12 points, clear cooling trend
        ]
        result = _aggregate_stats(records)
        assert "cooling" in result

    def test_no_trend_with_few_data_points(self):
        """Should not include trend when < 8 data points."""
        records = [
            {"date": f"2025-01-{i:02d}", "current": {}, "daily": {"temperature_2m_max": [20 + i * 2]}}
            for i in range(1, 6)  # only 5 points
        ]
        result = _aggregate_stats(records)
        assert "trend" not in result.lower()

    def test_no_trend_with_small_difference(self):
        """Should not include trend when temperature difference <= 1 degree."""
        records = [
            {"date": f"2025-01-{i:02d}", "current": {}, "daily": {"temperature_2m_max": [25.0 + i * 0.1]}}
            for i in range(1, 13)  # 12 points but very small change
        ]
        result = _aggregate_stats(records)
        assert "warming" not in result and "cooling" not in result

    def test_includes_weather_code_frequency(self):
        """Should include most common weather conditions."""
        records = [
            {"date": "2025-01-15", "current": {"weather_code": 0}, "daily": {}},
            {"date": "2025-01-16", "current": {"weather_code": 0}, "daily": {}},
            {"date": "2025-01-17", "current": {"weather_code": 3}, "daily": {}},
            {"date": "2025-01-18", "current": {"weather_code": 61}, "daily": {}},
        ]
        result = _aggregate_stats(records)
        assert "Clear (2d)" in result
        assert "Most common conditions" in result

    def test_includes_insights_heat_stress(self):
        """Should include heat stress data when insights are available."""
        records = [
            {
                "date": "2025-01-15",
                "current": {},
                "daily": {},
                "insights": {"heatStressIndex": 32},
            },
            {
                "date": "2025-01-16",
                "current": {},
                "daily": {},
                "insights": {"heatStressIndex": 25},
            },
        ]
        result = _aggregate_stats(records)
        assert "Heat stress" in result
        assert "1 high-stress days" in result  # only 32 >= 28

    def test_includes_insights_thunderstorm_probability(self):
        """Should include thunderstorm risk data when insights are available."""
        records = [
            {
                "date": "2025-01-15",
                "current": {},
                "daily": {},
                "insights": {"thunderstormProbability": 50},
            },
            {
                "date": "2025-01-16",
                "current": {},
                "daily": {},
                "insights": {"thunderstormProbability": 10},
            },
        ]
        result = _aggregate_stats(records)
        assert "Thunderstorm risk" in result
        assert "1 high-risk days" in result  # only 50 > 30

    def test_includes_insights_gdd(self):
        """Should include growing degree days when insights are available."""
        records = [
            {
                "date": "2025-01-15",
                "current": {},
                "daily": {},
                "insights": {"gdd10To30": 15.5},
            },
            {
                "date": "2025-01-16",
                "current": {},
                "daily": {},
                "insights": {"gdd10To30": 12.0},
            },
        ]
        result = _aggregate_stats(records)
        assert "Growing degree days" in result
        assert "total 27.5" in result  # 15.5 + 12.0

    def test_date_range_reported(self):
        """Should include the date range and data point count."""
        records = [
            {"date": "2025-01-01", "current": {}, "daily": {}},
            {"date": "2025-01-15", "current": {}, "daily": {}},
        ]
        result = _aggregate_stats(records)
        assert "2025-01-01 to 2025-01-15" in result
        assert "2 data points" in result

    def test_includes_humidity_wind_uv_pressure_cloud(self):
        """Should include all atmospheric metrics when available in current."""
        records = [
            {
                "date": "2025-01-15",
                "current": {
                    "relative_humidity_2m": 65,
                    "wind_speed_10m": 15,
                    "wind_gusts_10m": 30,
                    "surface_pressure": 1015,
                    "cloud_cover": 40,
                },
                "daily": {"uv_index_max": [8]},
            },
        ]
        result = _aggregate_stats(records)
        assert "Humidity:" in result
        assert "Wind:" in result
        assert "UV index:" in result
        assert "Pressure:" in result
        assert "Cloud cover:" in result

    def test_uv_falls_back_to_current(self):
        """Should fall back to current.uv_index when daily.uv_index_max is missing."""
        records = [
            {
                "date": "2025-01-15",
                "current": {"uv_index": 6},
                "daily": {},
            },
        ]
        result = _aggregate_stats(records)
        assert "UV index:" in result
        assert "avg 6.0" in result

    def test_feels_like_temperature_included(self):
        """Should include feels-like temperature when available."""
        records = [
            {
                "date": "2025-01-15",
                "current": {},
                "daily": {
                    "apparent_temperature_max": [33.0],
                    "apparent_temperature_min": [20.0],
                },
            },
        ]
        result = _aggregate_stats(records)
        assert "Feels like:" in result


# ---------------------------------------------------------------------------
# _build_analysis_system_prompt
# ---------------------------------------------------------------------------


class TestBuildAnalysisSystemPrompt:
    @patch("py._history_analyze._get_analysis_prompt")
    def test_uses_db_template_when_available(self, mock_get_prompt):
        """Should use template from database when available."""
        mock_get_prompt.return_value = {
            "template": "Custom analysis for {locationName} over {days} days."
        }
        result = _build_analysis_system_prompt("Harare", 30)
        assert result == "Custom analysis for Harare over 30 days."

    @patch("py._history_analyze._get_analysis_prompt")
    def test_falls_back_to_hardcoded_prompt(self, mock_get_prompt):
        """Should use fallback prompt when database template is unavailable."""
        mock_get_prompt.return_value = None
        result = _build_analysis_system_prompt("Harare", 30)
        assert "Shamwari Weather" in result
        assert "Harare" in result
        assert "30" in result

    @patch("py._history_analyze._get_analysis_prompt")
    def test_falls_back_when_template_is_empty(self, mock_get_prompt):
        """Should use fallback when template field is empty."""
        mock_get_prompt.return_value = {"template": ""}
        result = _build_analysis_system_prompt("Harare", 30)
        assert "Shamwari Weather" in result

    @patch("py._history_analyze._get_analysis_prompt")
    def test_replaces_location_and_days_placeholders(self, mock_get_prompt):
        """Should replace both {locationName} and {days} placeholders."""
        mock_get_prompt.return_value = {
            "template": "Analyze {locationName} data for the last {days} days."
        }
        result = _build_analysis_system_prompt("Victoria Falls", 90)
        assert "Victoria Falls" in result
        assert "90" in result
        assert "{locationName}" not in result
        assert "{days}" not in result


# ---------------------------------------------------------------------------
# analyze_history endpoint
# ---------------------------------------------------------------------------


class TestAnalyzeHistoryEndpoint:
    def _make_request(self, ip="203.0.113.42"):
        """Create a mock FastAPI Request."""
        req = MagicMock()
        req.headers = {}
        if ip:
            req.client = MagicMock()
            req.client.host = ip
        else:
            req.client = None
        return req

    @pytest.mark.asyncio
    async def test_missing_location_raises_400(self):
        """Empty location should raise 400."""
        body = AnalyzeRequest(location="   ", days=30)
        request = self._make_request()

        with pytest.raises(HTTPException) as exc_info:
            await analyze_history(body, request)
        assert exc_info.value.status_code == 400

    @pytest.mark.asyncio
    @patch("py._history_analyze.get_client_ip", return_value=None)
    async def test_no_ip_raises_400(self, _mock_ip):
        """When IP cannot be determined, should raise 400."""
        body = AnalyzeRequest(location="harare", days=30)
        request = self._make_request(ip=None)

        with pytest.raises(HTTPException) as exc_info:
            await analyze_history(body, request)
        assert exc_info.value.status_code == 400
        assert "Could not determine IP" in exc_info.value.detail

    @pytest.mark.asyncio
    @patch("py._history_analyze.check_rate_limit")
    @patch("py._history_analyze.get_client_ip", return_value="1.2.3.4")
    async def test_rate_limit_exceeded_raises_429(self, _mock_ip, mock_rate):
        """Should raise 429 when rate limit is exceeded."""
        mock_rate.return_value = {"allowed": False, "remaining": 0}
        body = AnalyzeRequest(location="harare", days=30)
        request = self._make_request()

        with pytest.raises(HTTPException) as exc_info:
            await analyze_history(body, request)
        assert exc_info.value.status_code == 429
        assert "Rate limit exceeded" in exc_info.value.detail

    @pytest.mark.asyncio
    @patch("py._history_analyze.locations_collection")
    @patch("py._history_analyze.check_rate_limit", return_value={"allowed": True, "remaining": 9})
    @patch("py._history_analyze.get_client_ip", return_value="1.2.3.4")
    async def test_unknown_location_raises_404(self, _mock_ip, _mock_rate, mock_loc):
        """Non-existent location should return 404."""
        mock_loc.return_value.find_one.return_value = None
        body = AnalyzeRequest(location="nonexistent", days=30)
        request = self._make_request()

        with pytest.raises(HTTPException) as exc_info:
            await analyze_history(body, request)
        assert exc_info.value.status_code == 404
        assert "Unknown location" in exc_info.value.detail

    @pytest.mark.asyncio
    @patch("py._history_analyze.get_db")
    @patch("py._history_analyze.locations_collection")
    @patch("py._history_analyze.check_rate_limit", return_value={"allowed": True, "remaining": 9})
    @patch("py._history_analyze.get_client_ip", return_value="1.2.3.4")
    async def test_no_history_data_raises_404(self, _mock_ip, _mock_rate, mock_loc, mock_db):
        """When no history records exist, should raise 404."""
        mock_loc.return_value.find_one.return_value = {"slug": "harare", "name": "Harare"}

        mock_coll = MagicMock()
        mock_coll.find.return_value.sort.return_value = []
        mock_db.return_value.__getitem__ = MagicMock(return_value=mock_coll)

        body = AnalyzeRequest(location="harare", days=30)
        request = self._make_request()

        with pytest.raises(HTTPException) as exc_info:
            await analyze_history(body, request)
        assert exc_info.value.status_code == 404
        assert "No history data" in exc_info.value.detail

    @pytest.mark.asyncio
    @patch("py._history_analyze.history_analysis_collection")
    @patch("py._history_analyze.get_db")
    @patch("py._history_analyze.locations_collection")
    @patch("py._history_analyze.check_rate_limit", return_value={"allowed": True, "remaining": 9})
    @patch("py._history_analyze.get_client_ip", return_value="1.2.3.4")
    async def test_cache_hit_returns_cached_analysis(
        self, _mock_ip, _mock_rate, mock_loc, mock_db, mock_cache_coll
    ):
        """Should return cached analysis when available."""
        mock_loc.return_value.find_one.return_value = {"slug": "harare", "name": "Harare"}

        history_records = [
            {"date": "2025-01-15", "current": {"temperature_2m": 28}, "daily": {}},
        ]
        mock_history_coll = MagicMock()
        mock_history_coll.find.return_value.sort.return_value = history_records
        mock_db.return_value.__getitem__ = MagicMock(return_value=mock_history_coll)

        mock_cache_coll.return_value.find_one.return_value = {
            "analysis": "Cached analysis text",
            "stats": "Cached stats",
        }

        body = AnalyzeRequest(location="harare", days=30)
        request = self._make_request()

        result = await analyze_history(body, request)
        assert result["analysis"] == "Cached analysis text"
        assert result["cached"] is True
        assert result["dataPoints"] == 1

    @pytest.mark.asyncio
    @patch("py._history_analyze.anthropic_breaker")
    @patch("py._history_analyze._get_client")
    @patch("py._history_analyze._get_analysis_prompt", return_value=None)
    @patch("py._history_analyze._build_analysis_system_prompt", return_value="system prompt")
    @patch("py._history_analyze.history_analysis_collection")
    @patch("py._history_analyze.get_db")
    @patch("py._history_analyze.locations_collection")
    @patch("py._history_analyze.check_rate_limit", return_value={"allowed": True, "remaining": 9})
    @patch("py._history_analyze.get_client_ip", return_value="1.2.3.4")
    async def test_circuit_breaker_open_returns_stats_only(
        self, _mock_ip, _mock_rate, mock_loc, mock_db,
        mock_cache_coll, _mock_prompt_build, _mock_prompt_get,
        mock_client, mock_breaker,
    ):
        """When circuit breaker is open, should return stats-only response."""
        mock_loc.return_value.find_one.return_value = {
            "slug": "harare", "name": "Harare", "country": "ZW",
        }

        history_records = [
            {"date": "2025-01-15", "current": {"temperature_2m": 28}, "daily": {}},
        ]
        mock_history_coll = MagicMock()
        mock_history_coll.find.return_value.sort.return_value = history_records
        mock_db.return_value.__getitem__ = MagicMock(return_value=mock_history_coll)

        # Cache miss
        mock_cache_coll.return_value.find_one.return_value = None

        # Circuit breaker is open
        type(mock_breaker).is_allowed = PropertyMock(return_value=False)

        body = AnalyzeRequest(location="harare", days=30)
        request = self._make_request()

        with patch("py._ai._get_season", return_value={"name": "Hot", "shona": "Zhizha", "description": "Hot season"}):
            result = await analyze_history(body, request)

        assert result["error"] is True
        assert "temporarily unavailable" in result["analysis"]
        assert result["stats"] != ""
        assert result["cached"] is False

    @pytest.mark.asyncio
    @patch("py._history_analyze.anthropic_breaker")
    @patch("py._history_analyze._get_client")
    @patch("py._history_analyze._get_analysis_prompt", return_value=None)
    @patch("py._history_analyze.history_analysis_collection")
    @patch("py._history_analyze.get_db")
    @patch("py._history_analyze.locations_collection")
    @patch("py._history_analyze.check_rate_limit", return_value={"allowed": True, "remaining": 9})
    @patch("py._history_analyze.get_client_ip", return_value="1.2.3.4")
    async def test_successful_ai_call_returns_analysis(
        self, _mock_ip, _mock_rate, mock_loc, mock_db,
        mock_cache_coll, _mock_prompt_get, mock_client, mock_breaker,
    ):
        """Successful AI call should return analysis and stats."""
        mock_loc.return_value.find_one.return_value = {
            "slug": "harare", "name": "Harare", "country": "ZW",
        }

        history_records = [
            {"date": "2025-01-15", "current": {"temperature_2m": 28}, "daily": {}},
        ]
        mock_history_coll = MagicMock()
        mock_history_coll.find.return_value.sort.return_value = history_records
        mock_db.return_value.__getitem__ = MagicMock(return_value=mock_history_coll)

        # Cache miss
        mock_cache_coll.return_value.find_one.return_value = None

        # Circuit breaker is closed
        type(mock_breaker).is_allowed = PropertyMock(return_value=True)

        # Mock Claude response
        text_block = MagicMock()
        text_block.type = "text"
        text_block.text = "The weather has been warming over the past 30 days."
        mock_response = MagicMock()
        mock_response.content = [text_block]
        mock_client.return_value.messages.create.return_value = mock_response

        body = AnalyzeRequest(location="harare", days=30)
        request = self._make_request()

        with patch("py._ai._get_season", return_value={"name": "Hot", "shona": "Zhizha", "description": "Hot season"}):
            result = await analyze_history(body, request)

        assert result["analysis"] == "The weather has been warming over the past 30 days."
        assert result["cached"] is False
        assert result["dataPoints"] == 1
        assert "error" not in result
        mock_breaker.record_success.assert_called_once()

    @pytest.mark.asyncio
    @patch("py._history_analyze.anthropic_breaker")
    @patch("py._history_analyze._get_client")
    @patch("py._history_analyze._get_analysis_prompt", return_value=None)
    @patch("py._history_analyze.history_analysis_collection")
    @patch("py._history_analyze.get_db")
    @patch("py._history_analyze.locations_collection")
    @patch("py._history_analyze.check_rate_limit", return_value={"allowed": True, "remaining": 9})
    @patch("py._history_analyze.get_client_ip", return_value="1.2.3.4")
    async def test_ai_rate_limit_error_raises_429(
        self, _mock_ip, _mock_rate, mock_loc, mock_db,
        mock_cache_coll, _mock_prompt_get, mock_client, mock_breaker,
    ):
        """Anthropic rate limit error should raise 429."""
        mock_loc.return_value.find_one.return_value = {
            "slug": "harare", "name": "Harare", "country": "ZW",
        }

        history_records = [
            {"date": "2025-01-15", "current": {"temperature_2m": 28}, "daily": {}},
        ]
        mock_history_coll = MagicMock()
        mock_history_coll.find.return_value.sort.return_value = history_records
        mock_db.return_value.__getitem__ = MagicMock(return_value=mock_history_coll)

        mock_cache_coll.return_value.find_one.return_value = None
        type(mock_breaker).is_allowed = PropertyMock(return_value=True)

        mock_client.return_value.messages.create.side_effect = anthropic.RateLimitError("rate limited")

        body = AnalyzeRequest(location="harare", days=30)
        request = self._make_request()

        with patch("py._ai._get_season", return_value={"name": "Hot", "shona": "Zhizha", "description": "Hot season"}):
            with pytest.raises(HTTPException) as exc_info:
                await analyze_history(body, request)
        assert exc_info.value.status_code == 429
        mock_breaker.record_failure.assert_called_once()

    @pytest.mark.asyncio
    @patch("py._history_analyze.anthropic_breaker")
    @patch("py._history_analyze._get_client")
    @patch("py._history_analyze._get_analysis_prompt", return_value=None)
    @patch("py._history_analyze.history_analysis_collection")
    @patch("py._history_analyze.get_db")
    @patch("py._history_analyze.locations_collection")
    @patch("py._history_analyze.check_rate_limit", return_value={"allowed": True, "remaining": 9})
    @patch("py._history_analyze.get_client_ip", return_value="1.2.3.4")
    async def test_ai_api_error_returns_graceful_fallback(
        self, _mock_ip, _mock_rate, mock_loc, mock_db,
        mock_cache_coll, _mock_prompt_get, mock_client, mock_breaker,
    ):
        """Anthropic APIError should return stats-only graceful fallback, not raise."""
        mock_loc.return_value.find_one.return_value = {
            "slug": "harare", "name": "Harare", "country": "ZW",
        }

        history_records = [
            {"date": "2025-01-15", "current": {"temperature_2m": 28}, "daily": {}},
        ]
        mock_history_coll = MagicMock()
        mock_history_coll.find.return_value.sort.return_value = history_records
        mock_db.return_value.__getitem__ = MagicMock(return_value=mock_history_coll)

        mock_cache_coll.return_value.find_one.return_value = None
        type(mock_breaker).is_allowed = PropertyMock(return_value=True)

        mock_client.return_value.messages.create.side_effect = anthropic.APIError("API error")

        body = AnalyzeRequest(location="harare", days=30)
        request = self._make_request()

        with patch("py._ai._get_season", return_value={"name": "Hot", "shona": "Zhizha", "description": "Hot season"}):
            result = await analyze_history(body, request)

        assert result["error"] is True
        assert "temporarily unavailable" in result["analysis"]
        assert result["stats"] != ""
        mock_breaker.record_failure.assert_called_once()

    @pytest.mark.asyncio
    @patch("py._history_analyze.anthropic_breaker")
    @patch("py._history_analyze._get_client")
    @patch("py._history_analyze._get_analysis_prompt", return_value=None)
    @patch("py._history_analyze.history_analysis_collection")
    @patch("py._history_analyze.get_db")
    @patch("py._history_analyze.locations_collection")
    @patch("py._history_analyze.check_rate_limit", return_value={"allowed": True, "remaining": 9})
    @patch("py._history_analyze.get_client_ip", return_value="1.2.3.4")
    async def test_activities_included_in_user_prompt(
        self, _mock_ip, _mock_rate, mock_loc, mock_db,
        mock_cache_coll, _mock_prompt_get, mock_client, mock_breaker,
    ):
        """User activities should be included in the AI prompt when provided."""
        mock_loc.return_value.find_one.return_value = {
            "slug": "harare", "name": "Harare", "country": "ZW",
        }

        history_records = [
            {"date": "2025-01-15", "current": {"temperature_2m": 28}, "daily": {}},
        ]
        mock_history_coll = MagicMock()
        mock_history_coll.find.return_value.sort.return_value = history_records
        mock_db.return_value.__getitem__ = MagicMock(return_value=mock_history_coll)

        mock_cache_coll.return_value.find_one.return_value = None
        type(mock_breaker).is_allowed = PropertyMock(return_value=True)

        text_block = MagicMock()
        text_block.type = "text"
        text_block.text = "Analysis text"
        mock_response = MagicMock()
        mock_response.content = [text_block]
        mock_client.return_value.messages.create.return_value = mock_response

        body = AnalyzeRequest(location="harare", days=30, activities=["farming", "running"])
        request = self._make_request()

        with patch("py._ai._get_season", return_value={"name": "Hot", "shona": "Zhizha", "description": "Hot season"}):
            await analyze_history(body, request)

        # Check that the user message content includes activities
        call_args = mock_client.return_value.messages.create.call_args
        messages = call_args.kwargs.get("messages") or call_args[1].get("messages")
        user_message = messages[0]["content"]
        assert "farming" in user_message
        assert "running" in user_message

    @pytest.mark.asyncio
    @patch("py._history_analyze.anthropic_breaker")
    @patch("py._history_analyze._get_client")
    @patch("py._history_analyze._get_analysis_prompt", return_value=None)
    @patch("py._history_analyze.history_analysis_collection")
    @patch("py._history_analyze.get_db")
    @patch("py._history_analyze.locations_collection")
    @patch("py._history_analyze.check_rate_limit", return_value={"allowed": True, "remaining": 9})
    @patch("py._history_analyze.get_client_ip", return_value="1.2.3.4")
    async def test_no_activities_omits_activities_note(
        self, _mock_ip, _mock_rate, mock_loc, mock_db,
        mock_cache_coll, _mock_prompt_get, mock_client, mock_breaker,
    ):
        """When no activities provided, the activities note should be empty."""
        mock_loc.return_value.find_one.return_value = {
            "slug": "harare", "name": "Harare", "country": "ZW",
        }

        history_records = [
            {"date": "2025-01-15", "current": {"temperature_2m": 28}, "daily": {}},
        ]
        mock_history_coll = MagicMock()
        mock_history_coll.find.return_value.sort.return_value = history_records
        mock_db.return_value.__getitem__ = MagicMock(return_value=mock_history_coll)

        mock_cache_coll.return_value.find_one.return_value = None
        type(mock_breaker).is_allowed = PropertyMock(return_value=True)

        text_block = MagicMock()
        text_block.type = "text"
        text_block.text = "Analysis text"
        mock_response = MagicMock()
        mock_response.content = [text_block]
        mock_client.return_value.messages.create.return_value = mock_response

        body = AnalyzeRequest(location="harare", days=30, activities=[])
        request = self._make_request()

        with patch("py._ai._get_season", return_value={"name": "Hot", "shona": "Zhizha", "description": "Hot season"}):
            await analyze_history(body, request)

        call_args = mock_client.return_value.messages.create.call_args
        messages = call_args.kwargs.get("messages") or call_args[1].get("messages")
        user_message = messages[0]["content"]
        assert "User activities" not in user_message


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------


class TestConstants:
    def test_rate_limit_max(self):
        """RATE_LIMIT_MAX should be 10."""
        assert RATE_LIMIT_MAX == 10
