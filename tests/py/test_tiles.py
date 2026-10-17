"""Tests for _tiles.py — Tomorrow.io weather overlay proxy, layer validation, SSRF protection.

Note: Mapbox base tile proxy has been removed. Base tiles are now served directly
from MapTiler CDN using the NEXT_PUBLIC_MAPTILER_API_KEY client-side variable.
"""

from __future__ import annotations

import base64
import asyncio
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from unittest.mock import patch, MagicMock

import pytest
from fastapi import HTTPException

from py import _enrichment
from py._circuit_breaker import tomorrow_breaker
from py._tiles import (
    QUOTA_EDGE_CACHE_MAX_S,
    FALLBACK_CACHE_CONTROL,
    FUTURE_TILE_CACHE_CONTROL,
    VALID_LAYERS,
    TIMESTAMP_RE,
    TILE_CACHE_CONTROL,
    MAP_TILE_CACHE_TTL_SECONDS,
    _TRANSPARENT_PNG,
    _cache_id,
    _quota_cache_control,
    _quota_exhausted,
    _seconds_left_in_hour,
    _tile_cache_control,
    _timestamp_bucket,
    proxy_map_tile,
)


#: The default wall clock for every test in this file: 07:20 UTC, i.e. well
#: inside an hour. Tile cache headers depend on the seconds left in the UTC
#: hour, so a test reading the real clock fails in the last minutes of every hour.
FROZEN = datetime(2026, 10, 11, 7, 20, 0, tzinfo=timezone.utc)

_clock = {"now": FROZEN}


class _FrozenDatetime(datetime):
    """``datetime`` whose ``now()`` reads the clock the ``frozen_clock`` fixture holds."""

    @classmethod
    def now(cls, tz=None):
        now = _clock["now"]
        return now.astimezone(tz) if tz is not None else now.replace(tzinfo=None)


@pytest.fixture(autouse=True)
def frozen_clock():
    """
    Freeze ``datetime.now`` for the tiles module, the enrichment module (which
    owns the quota memo the tiles read) and this test module, at ``FROZEN``.

    Autouse, so no test depends on the wall clock, the hour boundary or the
    seconds left in the hour. A test that needs another instant requests the
    fixture and calls it: ``frozen_clock(_at(56))``.
    """
    _clock["now"] = FROZEN
    with patch("py._tiles.datetime", _FrozenDatetime), \
            patch("py._enrichment.datetime", _FrozenDatetime), \
            patch(f"{__name__}.datetime", _FrozenDatetime):

        def set_now(when: datetime) -> None:
            _clock["now"] = when

        yield set_now
    _clock["now"] = FROZEN


@pytest.fixture(autouse=True)
def _clear_quota_memo(frozen_clock):
    """The 429 memo is module state shared with enrichment; isolate each test."""
    _enrichment._reset_memos()
    tomorrow_breaker.reset()
    yield
    _enrichment._reset_memos()
    tomorrow_breaker.reset()


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

        result = await proxy_map_tile(
            z=5, x=18, y=17, layer="temperature", timestamp="2026-01-01T12:00:00Z"
        )
        assert result.media_type == "image/png"
        assert result.body == b"\x89PNG\r\n\x1a\n"
        # A past hour is final and carries the strong CDN cache header.
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
        # A 429 means the shared quota is spent, not that the tile is missing.
        assert result.headers.get("x-map-tile") == "quota"

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
        # Key travels in the header, never the (logged) URL.
        assert "my-key" not in url
        assert "apikey" not in url
        assert call_args.kwargs["headers"] == {"apikey": "my-key"}


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

        with patch("py._tiles.map_tile_cache_collection", return_value=mock_collection):
            with patch("py._tiles.get_api_key") as mock_key:
                with patch("py._tiles._get_http") as mock_http:
                    result = await proxy_map_tile(z=5, x=18, y=17, layer="temperature")

        # Neither the API key nor the HTTP client should be touched on a hit.
        mock_key.assert_not_called()
        mock_http.assert_not_called()
        assert result.status_code == 200
        assert result.body == tile_bytes
        assert result.headers.get("x-cache") == "HIT"
        # "now" is edge-cached only until the hour rolls over.
        cc = result.headers.get("cache-control")
        assert "s-maxage=86400" not in cc
        assert "s-maxage=" in cc

    async def test_cache_miss_fetches_and_writes(self):
        """On a miss, Tomorrow.io is fetched and the tile is written to cache."""
        tile_bytes = b"\x89PNG-fresh"
        mock_collection = MagicMock()
        mock_collection.find_one.return_value = None  # miss

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.content = tile_bytes

        with patch("py._tiles.map_tile_cache_collection", return_value=mock_collection):
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

        with patch("py._tiles.map_tile_cache_collection", return_value=mock_collection):
            with patch("py._tiles.get_api_key", return_value="test-key"):
                with patch("py._tiles._get_http") as mock_http:
                    mock_http.return_value.get.return_value = mock_response
                    result = await proxy_map_tile(z=5, x=18, y=17, layer="temperature")

        assert result.status_code == 200
        assert result.body == tile_bytes


# ---------------------------------------------------------------------------
# Cache-Control per timestamp + shared quota memo (#266)
# ---------------------------------------------------------------------------


def _at(minute: int, second: int = 0) -> datetime:
    return datetime(2026, 10, 11, 7, minute, second, tzinfo=timezone.utc)


class TestTileCacheControl:
    def test_past_hour_keeps_long_edge_cache(self):
        assert _tile_cache_control("2026-10-11T06:00:00Z", _at(5)) == TILE_CACHE_CONTROL

    def test_future_hour_is_kept_an_hour(self):
        # The image behind a future hour changes with each model run.
        cc = _tile_cache_control("2026-10-11T12:00:00Z", _at(5))
        assert cc == FUTURE_TILE_CACHE_CONTROL
        assert "s-maxage=3600" in cc and "86400" not in cc

    def test_current_hour_counts_as_future(self):
        assert _tile_cache_control("2026-10-11T07:00:00Z", _at(5)) == FUTURE_TILE_CACHE_CONTROL

    def test_now_is_bounded_by_the_hour(self):
        cc = _tile_cache_control("now", _at(45))
        assert "s-maxage=900" in cc  # 15 minutes left
        assert "max-age=600" in cc  # browser capped at 10 min
        assert "86400" not in cc and "604800" not in cc

    def test_now_late_in_hour_has_a_floor(self):
        assert "s-maxage=60" in _tile_cache_control("now", _at(59, 59))

    def test_seconds_left_in_hour(self):
        assert _seconds_left_in_hour(_at(0)) == 3600
        assert _seconds_left_in_hour(_at(30)) == 1800

    def test_quota_fallback_edge_cache_is_capped(self):
        # 20 minutes are left in the hour, but the edge keeps the transparent
        # tile only 5 minutes: the memo, not the CDN, carries the long window.
        cc = _quota_cache_control(_at(40))
        assert f"s-maxage={QUOTA_EDGE_CACHE_MAX_S}" in cc and "max-age=60" in cc
        assert QUOTA_EDGE_CACHE_MAX_S == 300

    def test_quota_fallback_never_outlives_the_hour(self):
        assert "s-maxage=120" in _quota_cache_control(_at(58))

    def test_quota_fallback_normal_case_is_the_cap(self):
        assert _quota_cache_control(_at(20)) == "public, max-age=60, s-maxage=300"

    def test_quota_fallback_last_minutes_use_the_seconds_left(self):
        # 4 minutes left: below the 5-minute cap, so the hour bound wins.
        assert _quota_cache_control(_at(56)) == "public, max-age=60, s-maxage=240"
        assert _quota_cache_control(_at(58, 30)) == "public, max-age=60, s-maxage=90"

    def test_quota_fallback_last_seconds_are_floored_at_a_minute(self):
        assert _quota_cache_control(_at(59, 30)) == "public, max-age=60, s-maxage=60"
        assert _quota_cache_control(_at(59, 59)) == "public, max-age=60, s-maxage=60"

    def test_error_fallback_is_short(self):
        assert "s-maxage=60" in FALLBACK_CACHE_CONTROL


#: What Tomorrow.io sends with a 429 when the hourly quota is spent.
QUOTA_HEADERS = {"x-ratelimit-remaining-hour": "0", "x-ratelimit-remaining-day": "120"}


def _resp(status: int, content: bytes = b"", headers: dict | None = None) -> MagicMock:
    r = MagicMock()
    r.status_code = status
    r.content = content
    # A real header map, never a MagicMock: an auto-mock would hide whether the
    # code really reads the headers.
    r.headers = {} if headers is None else headers
    return r


@pytest.mark.asyncio
class TestQuotaMemo:
    async def test_429_marks_quota_for_tiles_and_enrichment(self):
        with patch("py._tiles._get_cached_tile", return_value=None), \
                patch("py._tiles.get_api_key", return_value="k"), \
                patch("py._tiles._get_http") as http:
            http.return_value.get.return_value = _resp(429, headers=QUOTA_HEADERS)
            result = await proxy_map_tile(z=5, x=18, y=17, layer="precipitationIntensity")
        assert result.body == _TRANSPARENT_PNG
        assert result.headers.get("x-map-tile") == "quota"
        assert "s-maxage=" in result.headers["cache-control"]
        assert _quota_exhausted()
        assert _enrichment.rate_limited_this_hour()
        # Enrichment's own memo now skips its Tomorrow.io call for the hour.
        hour = datetime.now(timezone.utc).strftime("%Y%m%d%H")
        assert _enrichment._exhausted[True] == hour
        assert _enrichment._exhausted[False] == hour

    async def test_exhausted_quota_skips_upstream(self):
        with patch("py._tiles._get_cached_tile", return_value=None), \
                patch("py._tiles.get_api_key", return_value="k"), \
                patch("py._tiles._get_http") as http:
            http.return_value.get.return_value = _resp(429, headers=QUOTA_HEADERS)
            await proxy_map_tile(z=5, x=18, y=17, layer="precipitationIntensity")
            await proxy_map_tile(z=5, x=19, y=17, layer="precipitationIntensity")
            await proxy_map_tile(z=5, x=20, y=17, layer="precipitationIntensity")
        assert http.return_value.get.call_count == 1

    async def test_enrichment_429_also_stops_tiles(self):
        _enrichment.mark_rate_limited()
        with patch("py._tiles._get_cached_tile", return_value=None), \
                patch("py._tiles.get_api_key", return_value="k") as key, \
                patch("py._tiles._get_http") as http:
            result = await proxy_map_tile(z=5, x=18, y=17, layer="temperature")
        http.assert_not_called()
        key.assert_not_called()
        assert result.headers.get("x-map-tile") == "quota"

    async def test_budget_cap_alone_does_not_stop_tiles(self):
        """Enrichment's own budget tiers are not the account quota."""
        hour = datetime.now(timezone.utc).strftime("%Y%m%d%H")
        _enrichment._exhausted[True] = _enrichment._exhausted[False] = hour
        with patch("py._tiles._get_cached_tile", return_value=None), \
                patch("py._tiles._set_cached_tile"), \
                patch("py._tiles.get_api_key", return_value="k"), \
                patch("py._tiles._get_http") as http:
            http.return_value.get.return_value = _resp(200, b"\x89PNG-fresh")
            result = await proxy_map_tile(z=5, x=18, y=17, layer="temperature")
        assert result.body == b"\x89PNG-fresh"

    async def test_per_second_429_is_not_the_quota(self):
        r = _resp(429, headers={"x-ratelimit-remaining-hour": "20", "x-ratelimit-remaining-day": "400"})
        with patch("py._tiles._get_cached_tile", return_value=None), \
                patch("py._tiles.get_api_key", return_value="k"), \
                patch("py._tiles._get_http") as http:
            http.return_value.get.return_value = r
            result = await proxy_map_tile(z=5, x=18, y=17, layer="temperature")
        assert not _quota_exhausted()
        assert result.headers.get("x-map-tile") == "empty"
        assert result.headers["cache-control"] == FALLBACK_CACHE_CONTROL

    async def test_quota_429_by_headers(self):
        r = _resp(429, headers=QUOTA_HEADERS)
        with patch("py._tiles._get_cached_tile", return_value=None), \
                patch("py._tiles.get_api_key", return_value="k"), \
                patch("py._tiles._get_http") as http:
            http.return_value.get.return_value = r
            await proxy_map_tile(z=5, x=18, y=17, layer="temperature")
        assert _quota_exhausted()

    async def test_quota_now_tile_falls_back_to_previous_hour(self):
        _enrichment.mark_rate_limited(FROZEN)
        prev = _timestamp_bucket("now", FROZEN - timedelta(hours=1))
        assert prev == "2026-10-11T06:00:00Z"
        seen = []

        def fake(cache_id, *, allow_stale=False):
            seen.append(cache_id)
            return b"\x89PNG-prev" if cache_id.endswith(prev) and allow_stale else None

        with patch("py._tiles._get_cached_tile", side_effect=fake):
            result = await proxy_map_tile(z=5, x=18, y=17, layer="temperature")
        assert result.body == b"\x89PNG-prev"
        assert result.headers.get("x-map-tile") == "quota-stale"
        assert seen[-1].endswith(prev)
        # A previous-hour frame must not stand in for "now" at the edge for long.
        assert result.headers["cache-control"] == f"public, max-age=60, s-maxage={QUOTA_EDGE_CACHE_MAX_S}"

    async def test_tile_429_does_not_touch_enrichment_skip_stats(self):
        """record_skip would overwrite lastErrorDetail/lastSkipSlug and inflate skippedBudget."""
        with patch("py._tiles._get_cached_tile", return_value=None), \
                patch("py._tiles.get_api_key", return_value="k"), \
                patch("py._enrichment.record_skip") as skip, \
                patch("py._tiles._get_http") as http:
            http.return_value.get.return_value = _resp(429, headers=QUOTA_HEADERS)
            await proxy_map_tile(z=5, x=18, y=17, layer="temperature")
        skip.assert_not_called()

    async def test_header_less_429_is_remembered_only_briefly(self):
        """A real empty header map: cannot tell quota from a burst, so ~60 s, not the hour."""
        with patch("py._tiles._get_cached_tile", return_value=None), \
                patch("py._tiles.get_api_key", return_value="k"), \
                patch("py._tiles._get_http") as http:
            http.return_value.get.return_value = _resp(429, headers={})
            result = await proxy_map_tile(z=5, x=18, y=17, layer="temperature")
        assert result.headers.get("x-map-tile") == "quota"
        assert _quota_exhausted()
        assert _enrichment._rate_limited_hour == {}  # not the hour memo
        assert _enrichment._exhausted == {}  # enrichment's tiers untouched
        later = datetime.now(timezone.utc) + timedelta(seconds=_enrichment.UNCLEAR_429_MEMO_S + 5)
        assert not _quota_exhausted(later)

    async def test_header_less_429_retries_upstream_after_the_pause(self):
        with patch("py._tiles._get_cached_tile", return_value=None), \
                patch("py._tiles._set_cached_tile"), \
                patch("py._tiles.get_api_key", return_value="k"), \
                patch("py._tiles._get_http") as http:
            http.return_value.get.side_effect = [_resp(429, headers={}), _resp(200, b"\x89PNG-fresh")]
            await proxy_map_tile(z=5, x=18, y=17, layer="temperature")
            # Still inside the pause: no second call.
            await proxy_map_tile(z=5, x=19, y=17, layer="temperature")
            assert http.return_value.get.call_count == 1
            _enrichment._rate_limited_until["tomorrow"] = datetime.now(timezone.utc) - timedelta(seconds=1)
            result = await proxy_map_tile(z=5, x=20, y=17, layer="temperature")
        assert result.body == b"\x89PNG-fresh"

    async def test_unreadable_header_values_count_as_no_header(self):
        r = _resp(429, headers={"x-ratelimit-remaining-hour": "n/a"})
        with patch("py._tiles._get_cached_tile", return_value=None), \
                patch("py._tiles.get_api_key", return_value="k"), \
                patch("py._tiles._get_http") as http:
            http.return_value.get.return_value = r
            await proxy_map_tile(z=5, x=18, y=17, layer="temperature")
        assert _enrichment._rate_limited_hour == {}
        assert _quota_exhausted()

    async def test_memo_from_previous_hour_is_ignored(self):
        _enrichment._rate_limited_hour["tomorrow"] = "2000010100"
        with patch("py._tiles._get_cached_tile", return_value=None), \
                patch("py._tiles._set_cached_tile"), \
                patch("py._tiles.get_api_key", return_value="k"), \
                patch("py._tiles._get_http") as http:
            http.return_value.get.return_value = _resp(200, b"\x89PNG-fresh")
            result = await proxy_map_tile(z=5, x=18, y=17, layer="temperature")
        assert result.body == b"\x89PNG-fresh"

    async def test_quota_serves_stale_tile_when_cached(self):
        _enrichment.mark_rate_limited()

        def fake(cache_id, *, allow_stale=False):
            return b"\x89PNG-stale" if allow_stale else None

        with patch("py._tiles._get_cached_tile", side_effect=fake):
            result = await proxy_map_tile(z=5, x=18, y=17, layer="temperature")
        assert result.body == b"\x89PNG-stale"
        assert result.headers.get("x-cache") == "STALE"
        # Normal case (07:20, 40 min left): the 5-minute cap applies.
        assert result.headers["cache-control"] == "public, max-age=60, s-maxage=300"
        assert QUOTA_EDGE_CACHE_MAX_S == 300

    @pytest.mark.parametrize(
        ("minute", "second", "s_maxage"),
        [
            (55, 0, 300),  # exactly the cap: 300 s left
            (56, 0, 240),  # last minutes: the seconds left, below the cap
            (58, 30, 90),
            (59, 30, 60),  # 30 s left: floored at MIN_HOUR_BOUND_S
            (59, 59, 60),
        ],
    )
    async def test_quota_stale_tile_never_outlives_the_hour(self, frozen_clock, minute, second, s_maxage):
        frozen_clock(_at(minute, second))
        _enrichment.mark_rate_limited()

        def fake(cache_id, *, allow_stale=False):
            return b"\x89PNG-stale" if allow_stale else None

        with patch("py._tiles._get_cached_tile", side_effect=fake):
            result = await proxy_map_tile(z=5, x=18, y=17, layer="temperature")
        assert result.headers.get("x-cache") == "STALE"
        assert result.headers["cache-control"] == f"public, max-age=60, s-maxage={s_maxage}"

    async def test_cache_hit_still_served_while_quota_spent(self):
        _enrichment.mark_rate_limited()
        with patch("py._tiles._get_cached_tile", return_value=b"\x89PNG-hit"):
            result = await proxy_map_tile(z=5, x=18, y=17, layer="temperature")
        assert result.headers.get("x-cache") == "HIT"

    async def test_non_429_error_does_not_mark_quota(self):
        with patch("py._tiles._get_cached_tile", return_value=None), \
                patch("py._tiles.get_api_key", return_value="k"), \
                patch("py._tiles._get_http") as http:
            http.return_value.get.return_value = _resp(503)
            result = await proxy_map_tile(z=5, x=18, y=17, layer="temperature")
        assert not _quota_exhausted()
        assert result.headers.get("x-map-tile") == "empty"
        assert result.headers["cache-control"] == FALLBACK_CACHE_CONTROL


# ---------------------------------------------------------------------------
# Circuit breaker, pool separation, cold-instance race
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestBreakerAndPools:
    async def test_5xx_counts_against_the_breaker(self):
        with patch("py._tiles._get_cached_tile", return_value=None), \
                patch("py._tiles.get_api_key", return_value="k"), \
                patch("py._tiles._get_http") as http:
            http.return_value.get.return_value = _resp(503)
            for x in range(3):
                await proxy_map_tile(z=5, x=x, y=17, layer="temperature")
        assert not tomorrow_breaker.is_allowed

    async def test_open_breaker_skips_upstream_and_serves_stale_or_transparent(self):
        for _ in range(3):
            tomorrow_breaker.record_failure()
        assert not tomorrow_breaker.is_allowed
        with patch("py._tiles._get_cached_tile", return_value=None), \
                patch("py._tiles.get_api_key") as key, \
                patch("py._tiles._get_http") as http:
            result = await proxy_map_tile(z=5, x=18, y=17, layer="temperature")
        http.assert_not_called()
        key.assert_not_called()
        assert result.body == _TRANSPARENT_PNG
        assert result.headers["cache-control"] == FALLBACK_CACHE_CONTROL

    async def test_open_breaker_still_serves_a_cache_hit(self):
        for _ in range(3):
            tomorrow_breaker.record_failure()
        with patch("py._tiles._get_cached_tile", return_value=b"\x89PNG-hit"):
            result = await proxy_map_tile(z=5, x=18, y=17, layer="temperature")
        assert result.headers.get("x-cache") == "HIT"

    async def test_429_and_4xx_do_not_count_against_the_breaker(self):
        with patch("py._tiles._get_cached_tile", return_value=None), \
                patch("py._tiles.get_api_key", return_value="k"), \
                patch("py._tiles._get_http") as http:
            for status in (404, 400, 403, 404, 400):
                http.return_value.get.return_value = _resp(status)
                await proxy_map_tile(z=5, x=18, y=17, layer="temperature")
            http.return_value.get.return_value = _resp(429, headers={"x-ratelimit-remaining-hour": "20"})
            for x in range(5):
                await proxy_map_tile(z=5, x=x, y=17, layer="temperature")
        assert tomorrow_breaker.is_allowed

    async def test_transport_error_counts_against_the_breaker(self):
        with patch("py._tiles._get_cached_tile", return_value=None), \
                patch("py._tiles.get_api_key", return_value="k"), \
                patch("py._tiles._get_http") as http:
            http.return_value.get.side_effect = Exception("boom")
            for x in range(3):
                await proxy_map_tile(z=5, x=x, y=17, layer="temperature")
        assert not tomorrow_breaker.is_allowed

    async def test_cache_hit_never_touches_the_upstream_pool(self):
        class Boom:
            def submit(self, *a, **k):
                raise AssertionError("cache hit queued on the upstream pool")

        with patch("py._tiles._UPSTREAM_EXECUTOR", Boom()), \
                patch("py._tiles._get_cached_tile", return_value=b"\x89PNG-hit"):
            result = await proxy_map_tile(z=5, x=18, y=17, layer="temperature")
        assert result.headers.get("x-cache") == "HIT"

    async def test_cache_hit_is_not_blocked_by_a_full_upstream_pool(self):
        """Every upstream worker busy on a slow Tomorrow.io call; a hit is still instant."""
        release = threading.Event()
        started = threading.Event()
        pool = ThreadPoolExecutor(max_workers=1)

        def slow_get(*a, **k):
            started.set()
            release.wait(5)
            return _resp(200, b"\x89PNG-slow")

        def cached(cache_id, *, allow_stale=False):
            return b"\x89PNG-hit" if cache_id.startswith("windSpeed/") else None

        try:
            with patch("py._tiles._UPSTREAM_EXECUTOR", pool), \
                    patch("py._tiles._get_cached_tile", side_effect=cached), \
                    patch("py._tiles._set_cached_tile"), \
                    patch("py._tiles.get_api_key", return_value="k"), \
                    patch("py._tiles._get_http") as http:
                http.return_value.get.side_effect = slow_get
                slow = asyncio.ensure_future(proxy_map_tile(z=5, x=1, y=1, layer="temperature"))
                await asyncio.get_running_loop().run_in_executor(None, started.wait, 5)
                hit = await asyncio.wait_for(
                    proxy_map_tile(z=5, x=2, y=2, layer="windSpeed"), timeout=2
                )
                assert hit.headers.get("x-cache") == "HIT"
                release.set()
                assert (await slow).body == b"\x89PNG-slow"
        finally:
            release.set()
            pool.shutdown(wait=True)


@pytest.mark.asyncio
class TestColdInstanceRace:
    async def test_queued_tiles_recheck_the_memo_before_the_http_call(self):
        """
        Cold instance: a burst passes the quota check together and queues for the
        upstream pool. Once the first worker sees the quota 429, the rest must
        not each pay a round trip. One upstream worker makes the queue explicit.
        """
        pool = ThreadPoolExecutor(max_workers=1)
        calls = []

        def get(url, headers=None):
            calls.append(url)
            time.sleep(0.05)
            return _resp(429, headers=QUOTA_HEADERS)

        try:
            with patch("py._tiles._UPSTREAM_EXECUTOR", pool), \
                    patch("py._tiles._get_cached_tile", return_value=None), \
                    patch("py._tiles.get_api_key", return_value="k"), \
                    patch("py._tiles._get_http") as http:
                http.return_value.get.side_effect = get
                results = await asyncio.gather(
                    *[proxy_map_tile(z=6, x=x, y=20, layer="precipitationIntensity") for x in range(8)]
                )
        finally:
            pool.shutdown(wait=True)
        assert len(calls) == 1
        assert all(r.body == _TRANSPARENT_PNG for r in results)
        assert all(r.headers.get("x-map-tile") == "quota" for r in results)

    async def test_worker_skips_upstream_when_memo_landed_after_the_entry_check(self):
        from py._tiles import _fetch_upstream

        _enrichment.mark_rate_limited()
        with patch("py._tiles._get_cached_tile", return_value=None), \
                patch("py._tiles.get_api_key") as key, \
                patch("py._tiles._get_http") as http:
            resp = _fetch_upstream(5, 1, 1, "temperature", "now", datetime.now(timezone.utc), "temperature/5/1/1/x")
        http.assert_not_called()
        key.assert_not_called()
        assert resp.headers.get("x-map-tile") == "quota"


# ---------------------------------------------------------------------------
# Enrichment sharing the same 429 rule
# ---------------------------------------------------------------------------


class TestClassify429:
    @pytest.mark.parametrize(
        "headers, expected",
        [
            ({"x-ratelimit-remaining-hour": "0"}, True),
            ({"x-ratelimit-remaining-day": "0"}, True),
            ({"x-ratelimit-remaining-hour": "5", "x-ratelimit-remaining-day": "0"}, True),
            ({"x-ratelimit-remaining-hour": "5", "x-ratelimit-remaining-day": "100"}, False),
            ({}, None),
            ({"x-ratelimit-remaining-hour": "x"}, None),
            (None, None),
        ],
    )
    def test_rule(self, headers, expected):
        assert _enrichment.classify_429(headers) is expected
