"""Tests for _status.py — system health checks and status endpoint."""

from __future__ import annotations

from unittest.mock import patch, MagicMock

import pytest

from py._status import (
    _check_mongodb,
    _check_tomorrow_io,
    _check_open_meteo,
    _check_ai_gateway,
    _check_weather_cache,
    _check_ai_cache,
    _reset_status_cache,
    system_status,
)


@pytest.fixture(autouse=True)
def _clear_status_cache():
    """Ensure the server-side status cache never leaks between tests."""
    _reset_status_cache()
    yield
    _reset_status_cache()


# ---------------------------------------------------------------------------
# _check_mongodb
# ---------------------------------------------------------------------------


class TestCheckMongodb:
    @patch("py._status.get_db")
    def test_operational_on_success(self, mock_db):
        mock_db.return_value.command.return_value = {"ok": 1}
        result = _check_mongodb()
        assert result["status"] == "operational"
        assert result["name"] == "MongoDB Atlas"
        assert "latencyMs" in result
        assert "Connected" in result["message"]

    @patch("py._status.get_db")
    def test_down_on_exception(self, mock_db):
        mock_db.return_value.command.side_effect = Exception("Connection refused")
        result = _check_mongodb()
        assert result["status"] == "down"
        assert "Connection refused" not in result["message"]
        assert "server logs" in result["message"]


# ---------------------------------------------------------------------------
# _check_tomorrow_io
# ---------------------------------------------------------------------------


class TestCheckTomorrowIo:
    @patch("py._status.get_http_client")
    @patch("py._status.get_api_key")
    def test_operational_on_200(self, mock_key, mock_client_cls):
        mock_key.return_value = "test-key"
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_client_cls.return_value.get.return_value = mock_resp

        result = _check_tomorrow_io()
        assert result["status"] == "operational"
        assert "Responding normally" in result["message"]

    @patch("py._status.get_api_key")
    def test_degraded_on_no_key(self, mock_key):
        mock_key.return_value = None
        result = _check_tomorrow_io()
        assert result["status"] == "degraded"
        assert "not configured" in result["message"]

    @patch("py._status.get_http_client")
    @patch("py._status.get_api_key")
    def test_degraded_on_429(self, mock_key, mock_client_cls):
        mock_key.return_value = "test-key"
        mock_resp = MagicMock()
        mock_resp.status_code = 429
        mock_client_cls.return_value.get.return_value = mock_resp

        result = _check_tomorrow_io()
        assert result["status"] == "degraded"
        assert "Rate limited" in result["message"]

    @patch("py._status.get_http_client")
    @patch("py._status.get_api_key")
    def test_down_on_non_200(self, mock_key, mock_client_cls):
        mock_key.return_value = "test-key"
        mock_resp = MagicMock()
        mock_resp.status_code = 500
        mock_resp.reason_phrase = "Internal Server Error"
        mock_client_cls.return_value.get.return_value = mock_resp

        result = _check_tomorrow_io()
        assert result["status"] == "down"
        assert "500" in result["message"]

    @patch("py._status.get_api_key")
    def test_down_on_exception(self, mock_key):
        mock_key.return_value = "test-key"
        with patch("py._status.get_http_client", side_effect=Exception("Network error")):
            result = _check_tomorrow_io()
        assert result["status"] == "down"
        assert "Network error" not in result["message"]
        assert "server logs" in result["message"]

    @patch("py._status.get_api_key")
    def test_degraded_on_db_unavailable_for_key(self, mock_key):
        mock_key.side_effect = Exception("MongoDB down")
        result = _check_tomorrow_io()
        assert result["status"] == "degraded"
        assert "MongoDB unavailable" in result["message"]


# ---------------------------------------------------------------------------
# _check_open_meteo
# ---------------------------------------------------------------------------


class TestCheckOpenMeteo:
    @patch("py._status.get_http_client")
    def test_operational_on_200_with_data(self, mock_client_cls):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"current": {"temperature_2m": 25.0}}
        mock_client_cls.return_value.get.return_value = mock_resp

        result = _check_open_meteo()
        assert result["status"] == "operational"
        assert "Responding normally" in result["message"]

    @patch("py._status.get_http_client")
    def test_degraded_on_missing_data(self, mock_client_cls):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"current": {}}  # missing temperature_2m
        mock_client_cls.return_value.get.return_value = mock_resp

        result = _check_open_meteo()
        assert result["status"] == "degraded"
        assert "missing expected data" in result["message"]

    @patch("py._status.get_http_client")
    def test_down_on_non_200(self, mock_client_cls):
        mock_resp = MagicMock()
        mock_resp.status_code = 503
        mock_resp.reason_phrase = "Service Unavailable"
        mock_client_cls.return_value.get.return_value = mock_resp

        result = _check_open_meteo()
        assert result["status"] == "down"
        assert "503" in result["message"]

    def test_down_on_exception(self):
        with patch("py._status.get_http_client", side_effect=Exception("Connection timeout")):
            result = _check_open_meteo()
        assert result["status"] == "down"
        assert "Connection timeout" not in result["message"]
        assert "server logs" in result["message"]


# ---------------------------------------------------------------------------
# _check_ai_gateway
# ---------------------------------------------------------------------------

_GW_ENV = {
    "CLOUDFLARE_ACCOUNT_ID": "acct",
    "CF_AI_API_TOKEN": "tok",
}


class TestCheckAiGateway:
    """Config-presence check only — it must NOT spend tokens."""

    def test_operational_when_configured(self):
        with patch.dict("os.environ", _GW_ENV, clear=True):
            with patch("py._status.ai_breaker") as breaker:
                breaker.is_allowed = True
                result = _check_ai_gateway()
        assert result["status"] == "operational"
        assert result["name"] == "Shamwari AI (Cloudflare AI Gateway)"
        assert "shamwari" in result["message"]
        assert "glm" in result["message"]

    def test_degraded_when_unconfigured(self):
        with patch.dict("os.environ", {}, clear=True):
            result = _check_ai_gateway()
        assert result["status"] == "degraded"
        assert "not configured" in result["message"]
        assert "CF_AI_API_TOKEN" in result["message"]

    def test_reports_names_never_values(self):
        env = {"CLOUDFLARE_ACCOUNT_ID": "acct", "AI_GATEWAY_TOKEN": "secret-gw-value"}
        with patch.dict("os.environ", env, clear=True):
            result = _check_ai_gateway()
        assert result["status"] == "degraded"
        assert "CF_WORKERS_AI_TOKEN" in result["message"]
        assert "secret-gw-value" not in result["message"]

    def test_legacy_split_tokens_still_operational(self):
        env = {"CLOUDFLARE_ACCOUNT_ID": "acct", "AI_GATEWAY_TOKEN": "gw", "CF_WORKERS_AI_TOKEN": "wai"}
        with patch.dict("os.environ", env, clear=True):
            with patch("py._status.ai_breaker") as breaker:
                breaker.is_allowed = True
                result = _check_ai_gateway()
        assert result["status"] == "operational"

    def test_degraded_when_circuit_open(self):
        with patch.dict("os.environ", _GW_ENV, clear=True):
            with patch("py._status.ai_breaker") as breaker:
                breaker.is_allowed = False
                result = _check_ai_gateway()
        assert result["status"] == "degraded"
        assert "Circuit open" in result["message"]

    def test_does_not_spend_tokens(self):
        with patch.dict("os.environ", _GW_ENV, clear=True):
            with patch("py._status.get_http_client") as mock_client_cls, \
                 patch("py._ai_gateway.httpx.Client") as mock_gw_http:
                _check_ai_gateway()
        mock_client_cls.assert_not_called()
        mock_gw_http.assert_not_called()


# ---------------------------------------------------------------------------
# _check_weather_cache
# ---------------------------------------------------------------------------


class TestCheckWeatherCache:
    @patch("py._status.get_db")
    def test_operational_when_count_positive(self, mock_db):
        mock_db.return_value.__getitem__.return_value.count_documents.return_value = 42
        result = _check_weather_cache()
        assert result["status"] == "operational"
        assert "42" in result["message"]

    @patch("py._status.get_db")
    def test_degraded_when_empty(self, mock_db):
        mock_db.return_value.__getitem__.return_value.count_documents.return_value = 0
        result = _check_weather_cache()
        assert result["status"] == "degraded"
        assert "empty" in result["message"]

    @patch("py._status.get_db")
    def test_down_on_error(self, mock_db):
        mock_db.return_value.__getitem__.return_value.count_documents.side_effect = (
            Exception("DB error")
        )
        result = _check_weather_cache()
        assert result["status"] == "down"
        assert "DB error" not in result["message"]
        assert "server logs" in result["message"]

    @patch("py._status.get_db")
    def test_singular_cache_message(self, mock_db):
        mock_db.return_value.__getitem__.return_value.count_documents.return_value = 1
        result = _check_weather_cache()
        assert result["status"] == "operational"
        assert "1 active cached location" in result["message"]
        # Should NOT have the plural "s"
        assert "locations" not in result["message"]


# ---------------------------------------------------------------------------
# _check_ai_cache
# ---------------------------------------------------------------------------


class TestCheckAiCache:
    @patch("py._status.get_db")
    def test_operational_when_count_positive(self, mock_db):
        mock_db.return_value.__getitem__.return_value.count_documents.return_value = 10
        result = _check_ai_cache()
        assert result["status"] == "operational"
        assert "10" in result["message"]

    @patch("py._status.get_db")
    def test_degraded_when_empty(self, mock_db):
        mock_db.return_value.__getitem__.return_value.count_documents.return_value = 0
        result = _check_ai_cache()
        assert result["status"] == "degraded"
        assert "empty" in result["message"]

    @patch("py._status.get_db")
    def test_down_on_error(self, mock_db):
        mock_db.return_value.__getitem__.return_value.count_documents.side_effect = (
            Exception("DB error")
        )
        result = _check_ai_cache()
        assert result["status"] == "down"

    @patch("py._status.get_db")
    def test_singular_summary_message(self, mock_db):
        mock_db.return_value.__getitem__.return_value.count_documents.return_value = 1
        result = _check_ai_cache()
        assert result["status"] == "operational"
        assert "1 active cached summary" in result["message"]
        # Should NOT have "ies" plural
        assert "summaries" not in result["message"]


# ---------------------------------------------------------------------------
# system_status endpoint (overall)
# ---------------------------------------------------------------------------


class TestSystemStatus:
    @patch("py._status._check_ai_cache")
    @patch("py._status._check_weather_cache")
    @patch("py._status._check_ai_gateway")
    @patch("py._status._check_open_meteo")
    @patch("py._status._check_tomorrow_io")
    @patch("py._status._check_mongodb")
    @pytest.mark.asyncio
    async def test_all_operational(
        self, mock_mongo, mock_tomorrow, mock_meteo, mock_anthro, mock_weather, mock_ai
    ):
        for m in [mock_mongo, mock_tomorrow, mock_meteo, mock_anthro, mock_weather, mock_ai]:
            m.return_value = {"name": "test", "status": "operational", "latencyMs": 1, "message": "ok"}

        result = await system_status()
        assert result["status"] == "operational"
        assert len(result["checks"]) == 6
        assert "timestamp" in result
        assert "totalLatencyMs" in result

    @patch("py._status._check_ai_cache")
    @patch("py._status._check_weather_cache")
    @patch("py._status._check_ai_gateway")
    @patch("py._status._check_open_meteo")
    @patch("py._status._check_tomorrow_io")
    @patch("py._status._check_mongodb")
    @pytest.mark.asyncio
    async def test_degraded_if_any_down(
        self, mock_mongo, mock_tomorrow, mock_meteo, mock_anthro, mock_weather, mock_ai
    ):
        mock_mongo.return_value = {"name": "MongoDB", "status": "down", "latencyMs": 1, "message": "err"}
        for m in [mock_tomorrow, mock_meteo, mock_anthro, mock_weather, mock_ai]:
            m.return_value = {"name": "test", "status": "operational", "latencyMs": 1, "message": "ok"}

        result = await system_status()
        assert result["status"] == "degraded"

    @patch("py._status._check_ai_cache")
    @patch("py._status._check_weather_cache")
    @patch("py._status._check_ai_gateway")
    @patch("py._status._check_open_meteo")
    @patch("py._status._check_tomorrow_io")
    @patch("py._status._check_mongodb")
    @pytest.mark.asyncio
    async def test_degraded_if_any_degraded(
        self, mock_mongo, mock_tomorrow, mock_meteo, mock_anthro, mock_weather, mock_ai
    ):
        mock_anthro.return_value = {"name": "Shamwari AI", "status": "degraded", "latencyMs": 1, "message": "rate limited"}
        for m in [mock_mongo, mock_tomorrow, mock_meteo, mock_weather, mock_ai]:
            m.return_value = {"name": "test", "status": "operational", "latencyMs": 1, "message": "ok"}

        result = await system_status()
        assert result["status"] == "degraded"

    @patch("py._status._check_ai_cache")
    @patch("py._status._check_weather_cache")
    @patch("py._status._check_ai_gateway")
    @patch("py._status._check_open_meteo")
    @patch("py._status._check_tomorrow_io")
    @patch("py._status._check_mongodb")
    @pytest.mark.asyncio
    async def test_result_is_cached_between_calls(
        self, mock_mongo, mock_tomorrow, mock_meteo, mock_anthro, mock_weather, mock_ai
    ):
        for m in [mock_mongo, mock_tomorrow, mock_meteo, mock_anthro, mock_weather, mock_ai]:
            m.return_value = {"name": "test", "status": "operational", "latencyMs": 1, "message": "ok"}

        first = await system_status()
        # A rapid second poll must be served from cache — no extra upstream calls.
        second = await system_status()

        assert second is first
        # Each check ran exactly once despite two endpoint calls.
        for m in [mock_mongo, mock_tomorrow, mock_meteo, mock_anthro, mock_weather, mock_ai]:
            assert m.call_count == 1


# ---------------------------------------------------------------------------
# _result / cache-count message shape
# ---------------------------------------------------------------------------


class TestResultHelper:
    def test_row_shape(self):
        from py._status import _result

        row = _result("Thing", "operational", 0.0, "ok")
        assert set(row) == {"name", "status", "latencyMs", "message"}
        assert row["name"] == "Thing"
        assert row["status"] == "operational"
        assert row["message"] == "ok"
        assert isinstance(row["latencyMs"], int)


class TestCacheCountMessages:
    @patch("py._status.get_db")
    def test_singular_location(self, mock_db):
        mock_db.return_value.__getitem__.return_value.count_documents.return_value = 1
        assert _check_weather_cache()["message"] == "1 active cached location"

    @patch("py._status.get_db")
    def test_plural_locations(self, mock_db):
        mock_db.return_value.__getitem__.return_value.count_documents.return_value = 3
        assert _check_weather_cache()["message"] == "3 active cached locations"

    @patch("py._status.get_db")
    def test_summary_singular_and_plural(self, mock_db):
        from py._status import _check_ai_cache

        coll = mock_db.return_value.__getitem__.return_value
        coll.count_documents.return_value = 1
        assert _check_ai_cache()["message"] == "1 active cached summary"
        coll.count_documents.return_value = 2
        assert _check_ai_cache()["message"] == "2 active cached summaries"

    @patch("py._status.get_db")
    def test_empty_is_degraded(self, mock_db):
        mock_db.return_value.__getitem__.return_value.count_documents.return_value = 0
        result = _check_weather_cache()
        assert result["status"] == "degraded"
        assert result["message"].startswith("Cache is empty")
