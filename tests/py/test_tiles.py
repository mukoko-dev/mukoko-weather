"""Tests for _tiles.py — map tile proxy, layer validation, SSRF protection."""

from __future__ import annotations

from unittest.mock import patch, MagicMock

import pytest
from fastapi import HTTPException

from py._tiles import (
    VALID_LAYERS,
    TIMESTAMP_RE,
    proxy_map_tile,
)


# ---------------------------------------------------------------------------
# VALID_LAYERS
# ---------------------------------------------------------------------------


class TestValidLayers:
    def test_contains_expected_layers(self):
        expected = {"precipitationIntensity", "temperature", "windSpeed", "cloudCover", "humidity"}
        assert VALID_LAYERS == expected

    def test_has_five_layers(self):
        assert len(VALID_LAYERS) == 5


# ---------------------------------------------------------------------------
# TIMESTAMP_RE
# ---------------------------------------------------------------------------


class TestTimestampRegex:
    def test_now_is_valid(self):
        assert TIMESTAMP_RE.match("now")

    def test_iso_format_valid(self):
        assert TIMESTAMP_RE.match("2024-01-15T12:00:00Z")
        assert TIMESTAMP_RE.match("2025-12-31T23:59:59Z")

    def test_rejects_invalid_formats(self):
        assert TIMESTAMP_RE.match("yesterday") is None
        assert TIMESTAMP_RE.match("2024-01-15") is None  # no time
        assert TIMESTAMP_RE.match("2024-01-15T12:00:00") is None  # no Z
        assert TIMESTAMP_RE.match("2024/01/15T12:00:00Z") is None  # wrong date sep
        assert TIMESTAMP_RE.match("") is None
        assert TIMESTAMP_RE.match("now ") is None  # trailing space


# ---------------------------------------------------------------------------
# proxy_map_tile endpoint
# ---------------------------------------------------------------------------


class TestProxyMapTile:
    @pytest.mark.asyncio
    async def test_invalid_layer_raises_400(self):
        with pytest.raises(HTTPException) as exc_info:
            await proxy_map_tile(z=5, x=18, y=17, layer="invalidLayer")
        assert exc_info.value.status_code == 400
        assert "Invalid layer" in exc_info.value.detail

    @pytest.mark.asyncio
    async def test_zoom_too_low_raises_400(self):
        with pytest.raises(HTTPException) as exc_info:
            await proxy_map_tile(z=0, x=0, y=0, layer="temperature")
        assert exc_info.value.status_code == 400
        assert "Zoom out of range" in exc_info.value.detail

    @pytest.mark.asyncio
    async def test_zoom_too_high_raises_400(self):
        with pytest.raises(HTTPException) as exc_info:
            await proxy_map_tile(z=13, x=0, y=0, layer="temperature")
        assert exc_info.value.status_code == 400
        assert "Zoom out of range" in exc_info.value.detail

    @pytest.mark.asyncio
    async def test_valid_zoom_boundaries(self):
        """Zoom 1 and 12 should be valid (not raise for zoom)."""
        # These will fail on no API key, not on zoom
        with patch("py._tiles.get_api_key", return_value=None):
            with pytest.raises(HTTPException) as exc_info:
                await proxy_map_tile(z=1, x=0, y=0, layer="temperature")
            assert exc_info.value.status_code == 503  # no API key, not zoom error

        with patch("py._tiles.get_api_key", return_value=None):
            with pytest.raises(HTTPException) as exc_info:
                await proxy_map_tile(z=12, x=0, y=0, layer="temperature")
            assert exc_info.value.status_code == 503

    @pytest.mark.asyncio
    async def test_invalid_timestamp_raises_400(self):
        with pytest.raises(HTTPException) as exc_info:
            await proxy_map_tile(z=5, x=18, y=17, layer="temperature", timestamp="invalid")
        assert exc_info.value.status_code == 400
        assert "Invalid timestamp" in exc_info.value.detail

    @patch("py._tiles.get_api_key")
    @pytest.mark.asyncio
    async def test_no_api_key_raises_503(self, mock_key):
        mock_key.return_value = None
        with pytest.raises(HTTPException) as exc_info:
            await proxy_map_tile(z=5, x=18, y=17, layer="temperature")
        assert exc_info.value.status_code == 503
        assert "Map service unavailable" in exc_info.value.detail

    @patch("py._tiles._get_http")
    @patch("py._tiles.get_api_key")
    @pytest.mark.asyncio
    async def test_successful_proxy_returns_png(self, mock_key, mock_http):
        mock_key.return_value = "test-api-key"
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.content = b"\x89PNG\r\n\x1a\n"  # PNG header
        mock_http.return_value.get.return_value = mock_response

        result = await proxy_map_tile(z=5, x=18, y=17, layer="temperature")
        assert result.media_type == "image/png"
        assert result.body == b"\x89PNG\r\n\x1a\n"
        assert "max-age=300" in result.headers.get("cache-control", "")
        assert result.headers.get("x-map-layer") == "temperature"

    @patch("py._tiles._get_http")
    @patch("py._tiles.get_api_key")
    @pytest.mark.asyncio
    async def test_rate_limited_proxied(self, mock_key, mock_http):
        mock_key.return_value = "test-api-key"
        mock_response = MagicMock()
        mock_response.status_code = 429
        mock_http.return_value.get.return_value = mock_response

        result = await proxy_map_tile(z=5, x=18, y=17, layer="temperature")
        assert result.status_code == 429

    @patch("py._tiles._get_http")
    @patch("py._tiles.get_api_key")
    @pytest.mark.asyncio
    async def test_non_200_status_proxied(self, mock_key, mock_http):
        mock_key.return_value = "test-api-key"
        mock_response = MagicMock()
        mock_response.status_code = 500
        mock_http.return_value.get.return_value = mock_response

        result = await proxy_map_tile(z=5, x=18, y=17, layer="temperature")
        assert result.status_code == 500

    @patch("py._tiles._get_http")
    @patch("py._tiles.get_api_key")
    @pytest.mark.asyncio
    async def test_exception_returns_502(self, mock_key, mock_http):
        mock_key.return_value = "test-api-key"
        mock_http.return_value.get.side_effect = Exception("Network error")

        result = await proxy_map_tile(z=5, x=18, y=17, layer="temperature")
        assert result.status_code == 502

    @patch("py._tiles._get_http")
    @patch("py._tiles.get_api_key")
    @pytest.mark.asyncio
    async def test_constructs_correct_url(self, mock_key, mock_http):
        mock_key.return_value = "my-key"
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.content = b"png"
        mock_http.return_value.get.return_value = mock_response

        await proxy_map_tile(z=5, x=18, y=17, layer="windSpeed", timestamp="now")

        call_args = mock_http.return_value.get.call_args
        url = call_args[0][0]
        assert url.startswith("https://api.tomorrow.io/")
        assert "/5/18/17/windSpeed/now.png" in url
        assert "apikey=my-key" in url
