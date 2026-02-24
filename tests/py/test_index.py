"""Tests for index.py — app setup, health check, error handlers, router mounting."""

from __future__ import annotations

import json
from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient

from py.index import app, _ALLOWED_ORIGINS, health, mongo_connection_error


# ---------------------------------------------------------------------------
# CORS origins
# ---------------------------------------------------------------------------


class TestAllowedOrigins:
    def test_contains_production_url(self):
        assert any(
            origin == "https://weather.mukoko.com" for origin in _ALLOWED_ORIGINS
        )

    def test_contains_localhost(self):
        assert "http://localhost:3000" in _ALLOWED_ORIGINS

    def test_no_wildcard(self):
        assert "*" not in _ALLOWED_ORIGINS


# ---------------------------------------------------------------------------
# Health endpoint
# ---------------------------------------------------------------------------


class TestHealthEndpoint:
    @patch("py.index.get_db")
    @pytest.mark.asyncio
    async def test_mongo_up_anthropic_available(self, mock_db):
        mock_db.return_value.command.return_value = {"ok": 1}

        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "sk-test-key"}):
            result = await health()

        assert result["status"] == "ok"
        assert result["database"] == "connected"
        assert result["anthropic"] == "available"
        assert result["service"] == "mukoko-weather-py"

    @patch("py.index.get_db")
    @pytest.mark.asyncio
    async def test_mongo_down(self, mock_db):
        mock_db.return_value.command.side_effect = Exception("Connection refused")

        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "sk-test-key"}, clear=False):
            result = await health()

        assert result["status"] == "degraded"
        assert result["database"] == "unavailable"

    @patch("py._db.get_api_key", return_value=None)
    @patch("py.index.get_db")
    @pytest.mark.asyncio
    async def test_anthropic_unavailable(self, mock_db, mock_key):
        mock_db.return_value.command.return_value = {"ok": 1}

        with patch.dict("os.environ", {}, clear=True):
            result = await health()

        assert result["status"] == "degraded"
        assert result["anthropic"] == "unavailable"
        assert result["database"] == "connected"

    @patch("py.index.get_db")
    @pytest.mark.asyncio
    async def test_both_degraded(self, mock_db):
        mock_db.return_value.command.side_effect = Exception("DB down")

        with patch.dict("os.environ", {}, clear=True):
            result = await health()

        assert result["status"] == "degraded"
        assert result["database"] == "unavailable"
        assert result["anthropic"] == "unavailable"

    @patch("py._db.get_api_key", return_value="sk-from-db")
    @patch("py.index.get_db")
    @pytest.mark.asyncio
    async def test_anthropic_from_db_key(self, mock_db, mock_key):
        """When env var is absent, health should check MongoDB for the key."""
        mock_db.return_value.command.return_value = {"ok": 1}

        with patch.dict("os.environ", {}, clear=True):
            result = await health()

        assert result["status"] == "ok"
        assert result["anthropic"] == "available"


# ---------------------------------------------------------------------------
# ConnectionFailure handler
# ---------------------------------------------------------------------------


class TestMongoConnectionError:
    @pytest.mark.asyncio
    async def test_returns_503(self):
        from pymongo.errors import ConnectionFailure
        exc = ConnectionFailure("Connection lost")
        mock_request = MagicMock()
        response = await mongo_connection_error(mock_request, exc)
        assert response.status_code == 503
        body = json.loads(response.body)
        assert body["detail"] == "Database temporarily unavailable"


# ---------------------------------------------------------------------------
# Router mounting — verify all 16 routers are included
# ---------------------------------------------------------------------------


class TestRouterMounting:
    """Verify all expected routers are mounted on the app."""

    def _get_route_paths(self) -> set[str]:
        """Extract all route paths from the app."""
        paths = set()
        for route in app.routes:
            if hasattr(route, "path"):
                paths.add(route.path)
        return paths

    def test_devices_router_mounted(self):
        paths = self._get_route_paths()
        assert "/api/py/devices" in paths

    def test_chat_router_mounted(self):
        paths = self._get_route_paths()
        assert "/api/py/chat" in paths

    def test_suitability_router_mounted(self):
        paths = self._get_route_paths()
        assert "/api/py/suitability" in paths

    def test_embeddings_router_mounted(self):
        paths = self._get_route_paths()
        assert "/api/py/embeddings/status" in paths

    def test_weather_router_mounted(self):
        paths = self._get_route_paths()
        assert "/api/py/weather" in paths

    def test_ai_router_mounted(self):
        paths = self._get_route_paths()
        assert "/api/py/ai" in paths

    def test_locations_router_mounted(self):
        paths = self._get_route_paths()
        assert "/api/py/locations" in paths

    def test_data_router_mounted(self):
        paths = self._get_route_paths()
        # Activities, tags, regions are on the data router
        assert "/api/py/activities" in paths
        assert "/api/py/tags" in paths
        assert "/api/py/regions" in paths

    def test_history_router_mounted(self):
        paths = self._get_route_paths()
        assert "/api/py/history" in paths

    def test_status_router_mounted(self):
        paths = self._get_route_paths()
        assert "/api/py/status" in paths

    def test_tiles_router_mounted(self):
        paths = self._get_route_paths()
        assert "/api/py/map-tiles" in paths

    def test_ai_prompts_router_mounted(self):
        paths = self._get_route_paths()
        assert "/api/py/ai/prompts" in paths
        assert "/api/py/ai/suggested-rules" in paths

    def test_ai_followup_router_mounted(self):
        paths = self._get_route_paths()
        assert "/api/py/ai/followup" in paths

    def test_history_analyze_router_mounted(self):
        paths = self._get_route_paths()
        assert "/api/py/history/analyze" in paths

    def test_explore_search_router_mounted(self):
        paths = self._get_route_paths()
        assert "/api/py/explore/search" in paths

    def test_reports_router_mounted(self):
        paths = self._get_route_paths()
        assert "/api/py/reports" in paths

    def test_health_endpoint_mounted(self):
        paths = self._get_route_paths()
        assert "/api/py/health" in paths
