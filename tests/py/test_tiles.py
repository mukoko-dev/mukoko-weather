"""Tests for _tiles.py — Tomorrow.io weather overlay proxy, layer validation, SSRF protection.

Note: Mapbox base tile proxy has been removed. Base tiles are now served directly
from MapTiler CDN using the NEXT_PUBLIC_MAPTILER_API_KEY client-side variable.
"""

from __future__ import annotations

import base64
from datetime import datetime, timezone
from unittest.mock import patch, MagicMock

import pytest
from fastapi import HTTPException

from py._tiles import (
    VALID_LAYERS,
    TIMESTAMP_RE,
    TILE_CACHE_CONTROL,
    MAP_TILE_CACHE_TTL_SECONDS,
    _TRANSPARENT_PNG,
    _cache_id,
    _timestamp_bucket,
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
# proxy_map_tile endpoint (Tomorrow.io weather overlays)
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
        with patch("py._tiles.get_api_key", return_value=None):
            with pytest.raises(HTTPException) as exc_info:
                await proxy_map_tile(z=1, x=0, y=0, layer="temperature")
            assert exc_info.value.status_code == 503

        with patch("py._tiles.get_api_key", return_value=None):
            with pytest.raises(HTTPException) as exc_info:
                await proxy_map_tile(z=12, x=0, y=0, layer="temperature")
            assert exc_info.value.status_code == 503

    @pytest.mark.asyncio
    async def test_tile_coords_out_of_range_raises_400(self):
        with pytest.raises(HTTPException) as exc_info:
            await proxy_map_tile(z=1, x=2, y=0, layer="temperature")
        assert exc_info.value.status_code == 400
        assert "Tile coordinates" in exc_info.value.detail

    @pytest.mark.asyncio
    async def test_negative_tile_coords_raises_400(self):
        with pytest.raises(HTTPException) as exc_info:
            await proxy_map_tile(z=5, x=-1, y=0, layer="temperature")
        assert exc_info.value.status_code == 400
        assert "Tile coordinates" in exc_info.value.detail

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

    @patch("py._tiles._get_cached_tile", return_value=None)
    @patch("py._tiles._set_cached_tile")
    @patch("py._tiles._get_http")
    @patch("py._tiles.get_api_key")
    @pytest.mark.asyncio
    async def test_successful_proxy_returns_png(self, mock_key, mock_http, mock_set, mock_get):
        mock_key.return_value = "test-api-key"
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.content = b"\x89PNG\r\n\x1a\n"
        mock_http.return_value.get.return_value = mock_response

        result = await proxy_map_tile(z=5, x=18, y=17, layer="temperature")
        assert result.media_type == "image/png"
        assert result.body == b"\x89PNG\r\n\x1a\n"
        # Fresh tiles carry the strong CDN cache header, not the old max-age=300.
        assert "s-maxage=86400" in result.headers.get("cache-control", "")
        assert "stale-while-revalidate" in result.headers.get("cache-control", "")
        assert result.headers.get("x-map-layer") == "temperature"
        assert result.headers.get("x-cache") == "MISS"
        # The fetched tile is persisted to the cache.
        mock_set.assert_called_once()

    @patch("py._tiles._get_cached_tile", return_value=None)
    @patch("py._tiles._get_http")
    @patch("py._tiles.get_api_key")
    @pytest.mark.asyncio
    async def test_rate_limited_returns_transparent_tile(self, mock_key, mock_http, mock_get):
        """429 with no cache → transparent 1×1 PNG (HTTP 200), not a 429."""
        mock_key.return_value = "test-api-key"
        mock_response = MagicMock()
        mock_response.status_code = 429
        mock_http.return_value.get.return_value = mock_response

        result = await proxy_map_tile(z=5, x=18, y=17, layer="temperature")
        assert result.status_code == 200
        assert result.media_type == "image/png"
        assert result.body == _TRANSPARENT_PNG
        assert result.headers.get("x-map-tile") == "empty"

    @patch("py._tiles._get_cached_tile", return_value=None)
    @patch("py._tiles._get_http")
    @patch("py._tiles.get_api_key")
    @pytest.mark.asyncio
    async def test_non_200_status_returns_transparent_tile(self, mock_key, mock_http, mock_get):
        """Any non-200 with no cache → transparent tile (HTTP 200)."""
        mock_key.return_value = "test-api-key"
        mock_response = MagicMock()
        mock_response.status_code = 500
        mock_http.return_value.get.return_value = mock_response

        result = await proxy_map_tile(z=5, x=18, y=17, layer="temperature")
        assert result.status_code == 200
        assert result.body == _TRANSPARENT_PNG

    @patch("py._tiles._get_http")
    @patch("py._tiles.get_api_key")
    @pytest.mark.asyncio
    async def test_exception_returns_transparent_tile(self, mock_key, mock_http):
        """A network exception with no cache → transparent tile (HTTP 200)."""
        mock_key.return_value = "test-api-key"
        mock_http.return_value.get.side_effect = Exception("Network error")

        with patch("py._tiles._get_cached_tile", return_value=None):
            result = await proxy_map_tile(z=5, x=18, y=17, layer="temperature")
        assert result.status_code == 200
        assert result.body == _TRANSPARENT_PNG

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


# ---------------------------------------------------------------------------
# Cache key helpers
# ---------------------------------------------------------------------------


class TestCacheHelpers:
    def test_timestamp_bucket_now_snaps_to_current_hour(self):
        bucket = _timestamp_bucket("now")
        expected = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:00:00Z")
        assert bucket == expected
        # Bucket is minute/second agnostic — always ...T HH:00:00Z.
        assert bucket.endswith(":00:00Z")

    def test_timestamp_bucket_explicit_is_verbatim(self):
        ts = "2026-01-15T12:00:00Z"
        assert _timestamp_bucket(ts) == ts

    def test_cache_id_is_deterministic(self):
        a = _cache_id("temperature", 5, 18, 17, "2026-01-15T12:00:00Z")
        b = _cache_id("temperature", 5, 18, 17, "2026-01-15T12:00:00Z")
        assert a == b
        assert a == "temperature/5/18/17/2026-01-15T12:00:00Z"

    def test_cache_id_varies_by_layer_and_coords(self):
        base = _cache_id("temperature", 5, 18, 17, "b")
        assert _cache_id("windSpeed", 5, 18, 17, "b") != base
        assert _cache_id("temperature", 6, 18, 17, "b") != base
        assert _cache_id("temperature", 5, 19, 17, "b") != base


# ---------------------------------------------------------------------------
# Persistent tile cache — hit / miss / stale
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestTileCache:
    async def test_cache_hit_serves_without_upstream_call(self):
        """A fresh cached tile is served without ever hitting Tomorrow.io."""
        tile_bytes = b"\x89PNG-cached"
        mock_collection = MagicMock()
        mock_collection.find_one.return_value = {
            "_id": "temperature/5/18/17/bucket",
            "tile": base64.b64encode(tile_bytes).decode("ascii"),
            "expiresAt": datetime.now(timezone.utc),
        }

        with patch("py._tiles._map_tile_cache_collection", return_value=mock_collection):
            with patch("py._tiles.get_api_key") as mock_key:
                with patch("py._tiles._get_http") as mock_http:
                    result = await proxy_map_tile(z=5, x=18, y=17, layer="temperature")

        # Neither the API key nor the HTTP client should be touched on a hit.
        mock_key.assert_not_called()
        mock_http.assert_not_called()
        assert result.status_code == 200
        assert result.body == tile_bytes
        assert result.headers.get("x-cache") == "HIT"
        assert TILE_CACHE_CONTROL == result.headers.get("cache-control")

    async def test_cache_miss_fetches_and_writes(self):
        """On a miss, Tomorrow.io is fetched and the tile is written to cache."""
        tile_bytes = b"\x89PNG-fresh"
        mock_collection = MagicMock()
        mock_collection.find_one.return_value = None  # miss

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.content = tile_bytes

        with patch("py._tiles._map_tile_cache_collection", return_value=mock_collection):
            with patch("py._tiles.get_api_key", return_value="test-key"):
                with patch("py._tiles._get_http") as mock_http:
                    mock_http.return_value.get.return_value = mock_response
                    result = await proxy_map_tile(z=5, x=18, y=17, layer="temperature")

        assert result.headers.get("x-cache") == "MISS"
        assert result.body == tile_bytes
        # Upsert persisted the tile under the deterministic _id.
        assert mock_collection.update_one.called
        args = mock_collection.update_one.call_args
        assert args.kwargs["upsert"] is True
        # Filter and the stored doc share the same deterministic _id.
        assert args.args[0]["_id"] == "temperature/5/18/17/" + _timestamp_bucket("now")
        assert args.args[1]["$set"]["_id"] == args.args[0]["_id"]
        assert args.args[1]["$set"]["expiresAt"] > args.args[1]["$set"]["fetchedAt"]

    async def test_rate_limit_serves_stale_when_available(self):
        """429 with a stale cached tile → serve the stale tile, not transparent."""
        stale_bytes = b"\x89PNG-stale"

        def fake_get_cached(cache_id, *, allow_stale=False):
            # Fresh lookup misses; stale lookup hits.
            return stale_bytes if allow_stale else None

        mock_response = MagicMock()
        mock_response.status_code = 429

        with patch("py._tiles._get_cached_tile", side_effect=fake_get_cached):
            with patch("py._tiles.get_api_key", return_value="test-key"):
                with patch("py._tiles._get_http") as mock_http:
                    mock_http.return_value.get.return_value = mock_response
                    result = await proxy_map_tile(z=5, x=18, y=17, layer="temperature")

        assert result.status_code == 200
        assert result.body == stale_bytes
        assert result.headers.get("x-cache") == "STALE"

    async def test_cache_write_failure_does_not_break_response(self):
        """A DB write error on cache-set must not fail the tile response."""
        tile_bytes = b"\x89PNG-fresh"
        mock_collection = MagicMock()
        mock_collection.find_one.return_value = None
        mock_collection.update_one.side_effect = Exception("db down")

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.content = tile_bytes

        with patch("py._tiles._map_tile_cache_collection", return_value=mock_collection):
            with patch("py._tiles.get_api_key", return_value="test-key"):
                with patch("py._tiles._get_http") as mock_http:
                    mock_http.return_value.get.return_value = mock_response
                    result = await proxy_map_tile(z=5, x=18, y=17, layer="temperature")

        assert result.status_code == 200
        assert result.body == tile_bytes
