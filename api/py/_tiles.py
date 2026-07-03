"""
Map tile proxy — Tomorrow.io weather overlays.

Base map tiles are now served directly from MapTiler CDN using the
NEXT_PUBLIC_MAPTILER_API_KEY client-side variable (no proxy needed).
This proxy only handles Tomorrow.io weather overlay tiles to keep
the Tomorrow.io API key server-side.

Rate-limit survival (Tomorrow.io free tier is ~25 req/hour, 500/day, but a
single map view loads ~16 overlay tiles and every pan/zoom loads more):

  1. **Persistent MongoDB tile cache** — every proxied tile is cached in
     ``weather.map_tile_cache`` keyed by ``{layer}/{z}/{x}/{y}/{bucket}`` where
     ``bucket`` snaps the timestamp to the current hour (weather tiles refresh
     hourly). A cache hit serves the stored bytes without ever touching
     Tomorrow.io, so re-pans, nearby users, and repeat views are free. Docs
     carry an ``expiresAt`` field with a TTL index (~90 min) for auto-cleanup.
  2. **Aggressive CDN caching** — a strong ``Cache-Control`` header lets Vercel's
     edge serve identical tile URLs without re-invoking the function at all.
  3. **Graceful degradation** — on a 429 (or any non-200) with no fresh cache we
     serve a stale cached tile if one exists, otherwise a 1×1 transparent PNG
     (HTTP 200) so the map simply shows no overlay for that tile instead of
     spamming the console with failures and killing the whole layer.

SSRF protections (pinned origin, layer whitelist, range-checked coords,
validated timestamp) are unchanged.
"""

from __future__ import annotations

import base64
import logging
import re
from datetime import datetime, timezone, timedelta
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from ._db import get_api_key, stamp_platform_fields, weather_db

router = APIRouter()

logger = logging.getLogger("mukoko.tiles")

VALID_LAYERS = {
    "precipitationIntensity",
    "temperature",
    "windSpeed",
    "cloudCover",
    "humidity",
}

TOMORROW_TILE_ORIGIN = "https://api.tomorrow.io"
TIMESTAMP_RE = re.compile(r"^(?:now|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$")

#: Persistent tile-cache TTL — 90 minutes. Comfortably longer than the hourly
#: tile refresh so a bucket's tiles stay cached for its whole lifetime, short
#: enough that stale imagery is bounded.
MAP_TILE_CACHE_TTL_SECONDS = 5400

#: Strong CDN cache for real tiles — Vercel's edge serves identical tile URLs
#: without re-invoking the function; nearby/repeat viewers never hit the origin.
TILE_CACHE_CONTROL = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800"

#: Short cache for the transparent fallback + stale tiles so the edge recovers
#: quickly once Tomorrow.io's quota resets (rather than caching an empty tile
#: for a day).
FALLBACK_CACHE_CONTROL = "public, max-age=300"

#: A 1×1 fully transparent PNG. Returned (HTTP 200) when Tomorrow.io errors and
#: no cached tile exists, so the overlay renders "nothing here" instead of a
#: failed request.
_TRANSPARENT_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)

_http_client: Optional[httpx.Client] = None


def _get_http() -> httpx.Client:
    global _http_client
    if _http_client is None:
        _http_client = httpx.Client(timeout=8.0)
    return _http_client


# ---------------------------------------------------------------------------
# Persistent tile cache (weather.map_tile_cache)
# ---------------------------------------------------------------------------


def _map_tile_cache_collection():
    """``weather.map_tile_cache`` — TTL-expiring cache of proxied overlay tiles."""
    return weather_db()["map_tile_cache"]


def _timestamp_bucket(timestamp: str) -> str:
    """
    Snap a tile timestamp to a stable ~1h cache bucket.

    Tomorrow.io weather tiles update hourly, so ``"now"`` resolves to the
    current UTC hour — every request within the same hour shares one cache key
    and therefore one upstream fetch. An explicit ISO timestamp is already a
    fixed point in time, so it's used verbatim.
    """
    if timestamp == "now":
        return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:00:00Z")
    return timestamp


def _cache_id(layer: str, z: int, x: int, y: int, bucket: str) -> str:
    """Deterministic ``_id`` for a tile — repeat requests upsert one row."""
    return f"{layer}/{z}/{x}/{y}/{bucket}"


def _get_cached_tile(cache_id: str, *, allow_stale: bool = False) -> Optional[bytes]:
    """
    Read a cached tile's bytes, or ``None`` on miss / DB error.

    With ``allow_stale=False`` (default) only non-expired docs are returned.
    With ``allow_stale=True`` the ``expiresAt`` filter is dropped so a stale
    tile can still be served when the upstream is failing. Any DB error is
    swallowed — the caller falls through to Tomorrow.io / the transparent tile.
    """
    try:
        query: dict = {"_id": cache_id}
        if not allow_stale:
            query["expiresAt"] = {"$gt": datetime.now(timezone.utc)}
        doc = _map_tile_cache_collection().find_one(query)
        if not doc:
            return None
        tile_b64 = doc.get("tile")
        if not tile_b64:
            return None
        return base64.b64decode(tile_b64)
    except Exception:
        return None


def _set_cached_tile(cache_id: str, layer: str, tile_bytes: bytes) -> None:
    """
    Upsert a tile into the cache using the deterministic ``_id``.

    Dedup discipline (Phase 0E): the same ``_id`` is always upserted, so two
    concurrent requests for the same tile end up with one row, not two. Cache
    write failures never break the response — they're swallowed silently.
    """
    now = datetime.now(timezone.utc)
    doc = {
        "_id": cache_id,
        "layer": layer,
        "tile": base64.b64encode(tile_bytes).decode("ascii"),
        "fetchedAt": now,
        "expiresAt": now + timedelta(seconds=MAP_TILE_CACHE_TTL_SECONDS),
    }
    stamp_platform_fields(doc)
    try:
        _map_tile_cache_collection().update_one(
            {"_id": cache_id}, {"$set": doc}, upsert=True
        )
    except Exception:
        pass


def _tile_response(content: bytes, layer: str, cache_status: str) -> Response:
    """A real (or cached) PNG tile with strong CDN caching."""
    return Response(
        content=content,
        media_type="image/png",
        headers={
            "Cache-Control": TILE_CACHE_CONTROL,
            "X-Map-Layer": layer,
            "X-Cache": cache_status,
        },
    )


def _stale_tile_response(content: bytes, layer: str) -> Response:
    """A stale cached PNG tile served during an upstream outage (short cache)."""
    return Response(
        content=content,
        media_type="image/png",
        headers={
            "Cache-Control": FALLBACK_CACHE_CONTROL,
            "X-Map-Layer": layer,
            "X-Cache": "STALE",
        },
    )


def _transparent_tile_response() -> Response:
    """
    A 1×1 transparent PNG (HTTP 200) served when Tomorrow.io errors and there's
    no cached tile — the map shows no overlay for this tile instead of erroring.
    """
    return Response(
        content=_TRANSPARENT_PNG,
        media_type="image/png",
        headers={
            "Cache-Control": FALLBACK_CACHE_CONTROL,
            "X-Cache": "MISS",
            "X-Map-Tile": "empty",
        },
    )


@router.get("/api/py/map-tiles")
async def proxy_map_tile(
    z: int,
    x: int,
    y: int,
    layer: str,
    timestamp: str = "now",
):
    """
    GET /api/py/map-tiles?z=5&x=18&y=17&layer=precipitationIntensity

    Proxy weather overlay tiles from Tomorrow.io, keeping the API key server-side.
    SSRF protection: pinned origin, whitelist layers, range-checked coords.

    Serves from the persistent MongoDB tile cache on a hit (no upstream call);
    on a miss fetches from Tomorrow.io, caches the result, and returns it. When
    Tomorrow.io rate-limits (429) or errors, serves a stale cached tile if one
    exists, otherwise a transparent 1×1 PNG so the layer degrades gracefully.
    """
    if layer not in VALID_LAYERS:
        raise HTTPException(status_code=400, detail="Invalid layer")

    if z < 1 or z > 12:
        raise HTTPException(status_code=400, detail="Zoom out of range")

    max_tile = (1 << z) - 1  # 2^z - 1
    if x < 0 or x > max_tile or y < 0 or y > max_tile:
        raise HTTPException(status_code=400, detail="Tile coordinates out of range")

    if not TIMESTAMP_RE.match(timestamp):
        raise HTTPException(status_code=400, detail="Invalid timestamp")

    bucket = _timestamp_bucket(timestamp)
    cache_id = _cache_id(layer, z, x, y, bucket)

    # 1. Serve from persistent cache if we have a fresh tile — no upstream call.
    cached = _get_cached_tile(cache_id)
    if cached is not None:
        return _tile_response(cached, layer, "HIT")

    try:
        api_key = get_api_key("tomorrow")
        if not api_key:
            logger.warning(
                "Tomorrow.io tile request rejected: no 'tomorrow' API key in "
                "api_keys collection. Seed it via POST /api/db-init with "
                "apiKeys.tomorrow so weather overlays can render."
            )
            raise HTTPException(status_code=503, detail="Map service unavailable")

        tile_url = f"{TOMORROW_TILE_ORIGIN}/v4/map/tile/{z}/{x}/{y}/{layer}/{timestamp}.png?apikey={api_key}"

        client = _get_http()
        resp = client.get(tile_url)

        # 2. Upstream error (429 rate limit or anything non-200) — degrade
        #    gracefully: serve a stale cached tile if we have one, else a
        #    transparent tile so the console isn't flooded and the layer survives.
        if resp.status_code != 200:
            if resp.status_code == 429:
                logger.warning(
                    "Tomorrow.io tile rate limited (429) for layer=%s z=%s", layer, z
                )
            else:
                logger.warning(
                    "Tomorrow.io tile upstream error: status=%s layer=%s z/x/y=%s/%s/%s",
                    resp.status_code, layer, z, x, y,
                )
            stale = _get_cached_tile(cache_id, allow_stale=True)
            if stale is not None:
                return _stale_tile_response(stale, layer)
            return _transparent_tile_response()

        # 3. Fresh tile — persist to cache and return with strong CDN caching.
        _set_cached_tile(cache_id, layer, resp.content)
        return _tile_response(resp.content, layer, "MISS")
    except HTTPException:
        raise
    except Exception:
        logger.exception("Tomorrow.io tile proxy failed for layer=%s z/x/y=%s/%s/%s", layer, z, x, y)
        # Network/unexpected failure — serve a stale tile if we have one so the
        # overlay survives a transient blip, otherwise a transparent tile.
        stale = _get_cached_tile(cache_id, allow_stale=True)
        if stale is not None:
            return _stale_tile_response(stale, layer)
        return _transparent_tile_response()
