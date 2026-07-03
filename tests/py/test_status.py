"""Tests for _status.py — system health checks and status endpoint."""

from __future__ import annotations

from unittest.mock import patch, MagicMock

import pytest

from py._status import (
    ANTHROPIC_MODEL,
    _check_mongodb,
    _check_tomorrow_io,
    _check_open_meteo,
    _check_anthropic,
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
        assert "Connection refused" in result["message"]


# ---------------------------------------------------------------------------
# _check_tomorrow_io
# ---------------------------------------------------------------------------


class TestCheckTomorrowIo:
    @patch("py._status.httpx.Client")
    @patch("py._status.get_api_key")
    def test_operational_on_200(self, mock_key, mock_client_cls):
        mock_key.return_value = "test-key"
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_client_cls.return_value.__enter__ = MagicMock(return_value=MagicMock())
        mock_client_cls.return_value.__enter__.return_value.get.return_value = mock_resp
        mock_client_cls.return_value.__exit__ = MagicMock(return_value=False)

        result = _check_tomorrow_io()
        assert result["status"] == "operational"
        assert "Responding normally" in result["message"]

    @patch("py._status.get_api_key")
    def test_degraded_on_no_key(self, mock_key):
        mock_key.return_value = None
        result = _check_tomorrow_io()
        assert result["status"] == "degraded"
        assert "not configured" in result["message"]

    @patch("py._status.httpx.Client")
    @patch("py._status.get_api_key")
    def test_degraded_on_429(self, mock_key, mock_client_cls):
        mock_key.return_value = "test-key"
        mock_resp = MagicMock()
        mock_resp.status_code = 429
        mock_client_cls.return_value.__enter__ = MagicMock(return_value=MagicMock())
        mock_client_cls.return_value.__enter__.return_value.get.return_value = mock_resp
        mock_client_cls.return_value.__exit__ = MagicMock(return_value=False)

        result = _check_tomorrow_io()
        assert result["status"] == "degraded"
        assert "Rate limited" in result["message"]

    @patch("py._status.httpx.Client")
    @patch("py._status.get_api_key")
    def test_down_on_non_200(self, mock_key, mock_client_cls):
        mock_key.return_value = "test-key"
        mock_resp = MagicMock()
        mock_resp.status_code = 500
        mock_resp.reason_phrase = "Internal Server Error"
        mock_client_cls.return_value.__enter__ = MagicMock(return_value=MagicMock())
        mock_client_cls.return_value.__enter__.return_value.get.return_value = mock_resp
        mock_client_cls.return_value.__exit__ = MagicMock(return_value=False)

        result = _check_tomorrow_io()
        assert result["status"] == "down"
        assert "500" in result["message"]

    @patch("py._status.get_api_key")
    def test_down_on_exception(self, mock_key):
        mock_key.return_value = "test-key"
        with patch("py._status.httpx.Client", side_effect=Exception("Network error")):
            result = _check_tomorrow_io()
        assert result["status"] == "down"
        assert "Network error" in result["message"]

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
    @patch("py._status.httpx.Client")
    def test_operational_on_200_with_data(self, mock_client_cls):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"current": {"temperature_2m": 25.0}}
        mock_client_cls.return_value.__enter__ = MagicMock(return_value=MagicMock())
        mock_client_cls.return_value.__enter__.return_value.get.return_value = mock_resp
        mock_client_cls.return_value.__exit__ = MagicMock(return_value=False)

        result = _check_open_meteo()
        assert result["status"] == "operational"
        assert "Responding normally" in result["message"]

    @patch("py._status.httpx.Client")
    def test_degraded_on_missing_data(self, mock_client_cls):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"current": {}}  # missing temperature_2m
        mock_client_cls.return_value.__enter__ = MagicMock(return_value=MagicMock())
        mock_client_cls.return_value.__enter__.return_value.get.return_value = mock_resp
        mock_client_cls.return_value.__exit__ = MagicMock(return_value=False)

        result = _check_open_meteo()
        assert result["status"] == "degraded"
        assert "missing expected data" in result["message"]

    @patch("py._status.httpx.Client")
    def test_down_on_non_200(self, mock_client_cls):
        mock_resp = MagicMock()
        mock_resp.status_code = 503
        mock_resp.reason_phrase = "Service Unavailable"
        mock_client_cls.return_value.__enter__ = MagicMock(return_value=MagicMock())
        mock_client_cls.return_value.__enter__.return_value.get.return_value = mock_resp
        mock_client_cls.return_value.__exit__ = MagicMock(return_value=False)

        result = _check_open_meteo()
        assert result["status"] == "down"
        assert "503" in result["message"]

    def test_down_on_exception(self):
        with patch("py._status.httpx.Client", side_effect=Exception("Connection timeout")):
            result = _check_open_meteo()
        assert result["status"] == "down"
        assert "Connection timeout" in result["message"]


# ---------------------------------------------------------------------------
# _check_anthropic
# ---------------------------------------------------------------------------


class TestCheckAnthropic:
    """The check is now key/model-presence only — it must NOT spend tokens."""

    def test_operational_with_env_key(self):
        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "sk-test"}):
            result = _check_anthropic()
        assert result["status"] == "operational"
        assert result["name"] == "Anthropic AI (Shamwari)"
        # Reports the model the app actually runs (Haiku), not Sonnet.
        assert ANTHROPIC_MODEL in result["message"]
        assert "claude-haiku-4-5-20251001" in result["message"]

    def test_degraded_on_no_key(self):
        with patch.dict("os.environ", {}, clear=True):
            with patch("py._status.get_api_key", return_value=None):
                result = _check_anthropic()
        assert result["status"] == "degraded"
        assert "not configured" in result["message"]

    def test_uses_db_key_when_env_absent(self):
        with patch.dict("os.environ", {}, clear=True):
            with patch("py._status.get_api_key", return_value="sk-from-db"):
                result = _check_anthropic()
        assert result["status"] == "operational"
        assert ANTHROPIC_MODEL in result["message"]

    def test_degraded_when_db_key_lookup_raises(self):
        with patch.dict("os.environ", {}, clear=True):
            with patch("py._status.get_api_key", side_effect=Exception("DB down")):
                result = _check_anthropic()
        assert result["status"] == "degraded"
        assert "not configured" in result["message"]

    def test_does_not_spend_tokens(self):
        """No live Anthropic request should ever be made (no token spend)."""
        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "sk-test"}):
            with patch("py._status.httpx.Client") as mock_client_cls:
                result = _check_anthropic()
        mock_client_cls.assert_not_called()
        assert result["status"] == "operational"

    def test_model_matches_configured_model(self):
        # Guards against the Sonnet/Haiku mismatch regressing.
        assert ANTHROPIC_MODEL == "claude-haiku-4-5-20251001"


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
        assert "DB error" in result["message"]

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
    @patch("py._status._check_anthropic")
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
    @patch("py._status._check_anthropic")
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
    @patch("py._status._check_anthropic")
    @patch("py._status._check_open_meteo")
    @patch("py._status._check_tomorrow_io")
    @patch("py._status._check_mongodb")
    @pytest.mark.asyncio
    async def test_degraded_if_any_degraded(
        self, mock_mongo, mock_tomorrow, mock_meteo, mock_anthro, mock_weather, mock_ai
    ):
        mock_anthro.return_value = {"name": "Anthropic", "status": "degraded", "latencyMs": 1, "message": "rate limited"}
        for m in [mock_mongo, mock_tomorrow, mock_meteo, mock_weather, mock_ai]:
            m.return_value = {"name": "test", "status": "operational", "latencyMs": 1, "message": "ok"}

        result = await system_status()
        assert result["status"] == "degraded"

    @patch("py._status._check_ai_cache")
    @patch("py._status._check_weather_cache")
    @patch("py._status._check_anthropic")
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
