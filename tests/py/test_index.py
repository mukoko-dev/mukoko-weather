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


class TestCorsPreflight:
    """The mobile client stamps X-Mukoko-Client and (when signed in) an
    Authorization header. A CORS preflight for those must succeed, or the
    browser blocks the request — see the mukoko-mobile fetch client."""

    def test_preflight_allows_mobile_client_headers(self):
        client = TestClient(app)
        resp = client.options(
            "/api/py/weather",
            headers={
                "Origin": "http://localhost:8081",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "x-mukoko-client, authorization",
            },
        )
        assert resp.status_code == 200
        allowed = resp.headers.get("access-control-allow-headers", "").lower()
        assert "x-mukoko-client" in allowed
        assert "authorization" in allowed


# ---------------------------------------------------------------------------
# Health endpoint
# ---------------------------------------------------------------------------


_GW_ENV = {"WEATHER_SERVICE_URL": "https://weather-internal.example", "WEATHER_SERVICE_API_KEY": "key"}


class TestHealthEndpoint:
    @patch("py.index.get_db")
    @pytest.mark.asyncio
    async def test_mongo_up_ai_available(self, mock_db):
        mock_db.return_value.command.return_value = {"ok": 1}

        with patch.dict("os.environ", _GW_ENV, clear=True):
            result = await health()

        assert result["status"] == "ok"
        assert result["database"] == "connected"
        assert result["ai"] == "available"
        assert result["service"] == "mukoko-weather-py"

    @patch("py.index.get_db")
    @pytest.mark.asyncio
    async def test_mongo_down(self, mock_db):
        mock_db.return_value.command.side_effect = Exception("Connection refused")

        with patch.dict("os.environ", _GW_ENV, clear=True):
            result = await health()

        assert result["status"] == "degraded"
        assert result["database"] == "unavailable"

    @patch("py.index.get_db")
    @pytest.mark.asyncio
    async def test_ai_unavailable_without_gateway_config(self, mock_db):
        mock_db.return_value.command.return_value = {"ok": 1}

        with patch.dict("os.environ", {}, clear=True):
            result = await health()

        assert result["status"] == "degraded"
        assert result["ai"] == "unavailable"
        assert result["database"] == "connected"

    @patch("py.index.get_db")
    @pytest.mark.asyncio
    async def test_both_degraded(self, mock_db):
        mock_db.return_value.command.side_effect = Exception("DB down")

        with patch.dict("os.environ", {}, clear=True):
            result = await health()

        assert result["status"] == "degraded"
        assert result["database"] == "unavailable"
        assert result["ai"] == "unavailable"


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
# Router mounting — verify every router still on the Python backend is included
# ---------------------------------------------------------------------------


class TestRouterMounting:
    """Verify all expected routers are mounted on the app."""

    def _get_route_paths(self) -> set[str]:
        """Extract all route paths from the app.

        FastAPI 0.130+ wraps included routers in _IncludedRouter objects that
        expose their sub-routes via .original_router.routes rather than .routes.
        """
        paths: set[str] = set()

        def collect(routes: list) -> None:
            for route in routes:
                if hasattr(route, "path"):
                    paths.add(route.path)
                # FastAPI 0.130+: _IncludedRouter wraps the original APIRouter
                if hasattr(route, "original_router") and route.original_router:
                    collect(route.original_router.routes)
                elif hasattr(route, "routes"):
                    collect(route.routes)

        collect(app.routes)
        return paths


    def test_chat_router_mounted(self):
        paths = self._get_route_paths()
        assert "/api/py/chat" in paths

    def test_embeddings_router_mounted(self):
        paths = self._get_route_paths()
        assert "/api/py/embeddings/status" in paths

    def test_weather_router_mounted(self):
        paths = self._get_route_paths()
        assert "/api/py/weather" in paths

    def test_the_summary_route_is_gone_it_runs_on_the_ai_worker(self):
        paths = self._get_route_paths()
        assert "/api/py/ai" not in paths


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
        # Only the follow-up questions are left; submit, list and upvote are
        # the Rust Worker's /v1/reports.
        paths = self._get_route_paths()
        assert "/api/py/reports/clarify" in paths
        assert "/api/py/reports" not in paths

    def test_agriculture_router_mounted(self):
        paths = self._get_route_paths()
        assert "/api/py/ai/agriculture" in paths

    def test_health_endpoint_mounted(self):
        paths = self._get_route_paths()
        assert "/api/py/health" in paths

