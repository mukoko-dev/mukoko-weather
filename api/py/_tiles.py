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
     The ``now`` URL carries no time, so it is edge-cached only until the UTC
     hour rolls over (``s-maxage`` = seconds left in the hour); otherwise the
     edge would keep serving a stale "now" radar frame for a day. A future
     forecast hour is kept an hour (it changes with each model run); only a
     past hour takes the day-long cache.
  3. **Graceful degradation** — on a 429 (or any non-200) with no fresh cache we
     serve a stale cached tile if one exists, otherwise a 1×1 transparent PNG
     (HTTP 200) so the map simply shows no overlay for that tile instead of
     spamming the console with failures and killing the whole layer.
  4. **Shared quota memo** — the key is shared with insights enrichment
     (``_enrichment.py``). Once either sees a quota 429 (``X-RateLimit-
     Remaining-Hour``/``-Day`` at 0) the account is spent for the hour, so every
     later tile skips the upstream round trip (which took 2–6 s just to be
     told 429) and the newest cached tile or a transparent one is served at
     once. The in-process memo lasts the hour, but the edge and browser keep
     the fallback tile only ``QUOTA_EDGE_CACHE_MAX_S`` (5 min), so the overlay
     comes back soon after the quota resets. A per-second 429 is not a quota
     429 (remaining-count headers decide, see ``_enrichment.classify_429``); a
     429 with no header is remembered for about a minute. Enrichment's own
     budget caps do not stop the tiles.
  5. **Off the event loop, two pools** — the MongoDB lookups and the upstream
     fetch are blocking calls. Cache reads (fast) run on their own small pool
     and are answered before anything is queued for the upstream pool (slow,
     up to 8 s), so cache hits never wait behind Tomorrow.io calls and neither
     pool can starve the default executor. The quota memo is re-checked inside
     the upstream worker right before the HTTP call, so tiles queued before the
     first 429 landed do not each spend a round trip.
  6. **Circuit breaker** — the upstream call is guarded by ``tomorrow_breaker``
     (shared with enrichment): 5xx and transport failures count, 429s and 4xx
     do not. While it is open tiles come from cache or are transparent.

SSRF protections (pinned origin, layer whitelist, range-checked coords,
validated timestamp) are unchanged.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from . import _enrichment
from ._circuit_breaker import tomorrow_breaker
from ._db import get_api_key, map_tile_cache_collection, ttl_find_one, ttl_upsert
from ._http import get_http_client

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

#: Short cache for the transparent fallback + stale tiles after an upstream
#: error (not a quota 429), so the edge recovers quickly once Tomorrow.io does.
FALLBACK_CACHE_CONTROL = "public, max-age=60, s-maxage=60"

#: Edge cache for a future forecast hour: the image behind that hour changes
#: with each model run, so it is kept an hour, not a day.
FUTURE_TILE_CACHE_CONTROL = "public, max-age=1800, s-maxage=3600, stale-while-revalidate=300"

#: Ceiling on how long the edge/browser may keep the transparent or stale tile
#: served while the quota is spent. The in-process memo (which stops upstream
#: calls) lasts the hour; this keeps a fallback from outliving the quota reset
#: by much, or a previous-hour frame from standing in for "now" for long.
QUOTA_EDGE_CACHE_MAX_S = 300

#: Dedicated threads for the blocking tile work, so a burst of tiles waiting on
#: Tomorrow.io cannot fill the shared default executor that weather enrichment
#: and history backfill also use. Cache reads and upstream calls get separate
#: pools so a cache hit never queues behind a slow upstream call.
_CACHE_EXECUTOR = ThreadPoolExecutor(max_workers=4, thread_name_prefix="map-tile-cache")
_UPSTREAM_EXECUTOR = ThreadPoolExecutor(max_workers=8, thread_name_prefix="map-tile-upstream")

#: Floor for an hour-bounded edge cache, so a tile served in the last seconds
#: of an hour is still cacheable for a moment.
MIN_HOUR_BOUND_S = 60

#: A 1×1 fully transparent PNG. Returned (HTTP 200) when Tomorrow.io errors and
#: no cached tile exists, so the overlay renders "nothing here" instead of a
#: failed request.
_TRANSPARENT_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)

#: Tomorrow.io tile upstream timeout (seconds).
TILE_UPSTREAM_TIMEOUT_S = 8.0


def _get_http() -> httpx.Client:
    return get_http_client(TILE_UPSTREAM_TIMEOUT_S)


# ---------------------------------------------------------------------------
# Persistent tile cache (weather.map_tile_cache)
# ---------------------------------------------------------------------------


def _timestamp_bucket(timestamp: str, now: Optional[datetime] = None) -> str:
    """
    Snap a tile timestamp to a stable ~1h cache bucket.

    Tomorrow.io weather tiles update hourly, so ``"now"`` resolves to the
    current UTC hour — every request within the same hour shares one cache key
    and therefore one upstream fetch. An explicit ISO timestamp is already a
    fixed point in time, so it's used verbatim.
    """
    if timestamp == "now":
        return (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:00:00Z")
    return timestamp


def _seconds_left_in_hour(now: Optional[datetime] = None) -> int:
    """Seconds until the next UTC hour (at least ``MIN_HOUR_BOUND_S``)."""
    now = now or datetime.now(timezone.utc)
    left = 3600 - (now.minute * 60 + now.second)
    return max(MIN_HOUR_BOUND_S, left)


def _tile_cache_control(timestamp: str, now: Optional[datetime] = None) -> str:
    """
    ``Cache-Control`` for a real tile.

    ``now`` means "whatever the current hour is": the URL never changes, so the
    edge may keep it only until the hour rolls over. A future hour's image
    changes with each model run, so it is kept an hour. A past hour is final
    and takes the long edge cache.
    """
    now = now or datetime.now(timezone.utc)
    if timestamp != "now":
        try:
            when = datetime.strptime(timestamp, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        except ValueError:
            return FUTURE_TILE_CACHE_CONTROL
        return TILE_CACHE_CONTROL if when < now.replace(minute=0, second=0, microsecond=0) else FUTURE_TILE_CACHE_CONTROL
    left = _seconds_left_in_hour(now)
    return f"public, max-age={min(left, 600)}, s-maxage={left}, stale-while-revalidate=60"


def _quota_cache_control(now: Optional[datetime] = None) -> str:
    """
    Fallback tiles while the quota is spent: edge-cached for at most
    ``QUOTA_EDGE_CACHE_MAX_S`` (and never past the hour). The long window stays
    with the in-process memo, which is what stops the upstream calls.
    """
    left = min(_seconds_left_in_hour(now), QUOTA_EDGE_CACHE_MAX_S)
    return f"public, max-age=60, s-maxage={left}"


def _quota_exhausted(now: Optional[datetime] = None) -> bool:
    """True once Tomorrow.io has answered a quota 429 (here or in enrichment) this hour."""
    return _enrichment.rate_limited_this_hour(now)


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
        doc = ttl_find_one(map_tile_cache_collection(), {"_id": cache_id}, allow_stale=allow_stale)
        tile_b64 = doc.get("tile") if doc else None
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
    fields = {
        "_id": cache_id,
        "layer": layer,
        "tile": base64.b64encode(tile_bytes).decode("ascii"),
    }
    try:
        ttl_upsert(
            map_tile_cache_collection(),
            {"_id": cache_id},
            fields,
            MAP_TILE_CACHE_TTL_SECONDS,
            stamp=True,
        )
    except Exception:
        pass


def _tile_response(
    content: bytes,
    layer: str,
    cache_status: str,
    timestamp: str = "now",
    now: Optional[datetime] = None,
) -> Response:
    """A real (or cached) PNG tile with strong CDN caching."""
    return Response(
        content=content,
        media_type="image/png",
        headers={
            "Cache-Control": _tile_cache_control(timestamp, now),
            "X-Map-Layer": layer,
            "X-Cache": cache_status,
        },
    )


def _stale_tile_response(content: bytes, layer: str, cache_control: str = FALLBACK_CACHE_CONTROL) -> Response:
    """A stale cached PNG tile served during an upstream outage (short cache)."""
    return Response(
        content=content,
        media_type="image/png",
        headers={
            "Cache-Control": cache_control,
            "X-Map-Layer": layer,
            "X-Cache": "STALE",
        },
    )


def _transparent_tile_response(
    cache_control: str = FALLBACK_CACHE_CONTROL, reason: str = "empty"
) -> Response:
    """
    A 1×1 transparent PNG (HTTP 200) served when Tomorrow.io errors and there's
    no cached tile — the map shows no overlay for this tile instead of erroring.
    ``X-Map-Tile`` is ``empty`` after an upstream error and ``quota`` while the
    account quota is spent.
    """
    return Response(
        content=_TRANSPARENT_PNG,
        media_type="image/png",
        headers={
            "Cache-Control": cache_control,
            "X-Cache": "MISS",
            "X-Map-Tile": reason,
        },
    )


def _quota_fallback(
    layer: str, z: int, x: int, y: int, timestamp: str, now: datetime
) -> Response:
    """
    While the quota is spent: the newest cached tile we have, else transparent,
    both cached until the hour resets. For ``now`` that is usually the previous
    hour's frame (this hour's would have been a fresh hit).
    """
    cc = _quota_cache_control(now)
    buckets = [_timestamp_bucket(timestamp, now)]
    if timestamp == "now":
        buckets.append(_timestamp_bucket("now", now - timedelta(hours=1)))
    for bucket in buckets:
        stale = _get_cached_tile(_cache_id(layer, z, x, y, bucket), allow_stale=True)
        if stale is not None:
            resp = _stale_tile_response(stale, layer, cc)
            resp.headers["X-Map-Tile"] = "quota-stale"
            return resp
    return _transparent_tile_response(cc, "quota")


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

    loop = asyncio.get_running_loop()
    # One clock reading for the bucket and the cache headers, so a request
    # straddling the hour cannot pair last hour's tile with a fresh hour of
    # edge cache.
    now = datetime.now(timezone.utc)
    cache_id = _cache_id(layer, z, x, y, _timestamp_bucket(timestamp, now))

    # 1. A fresh cached tile is answered from the cache pool, before anything
    #    is queued for the (slow) upstream pool — no upstream call, no waiting
    #    behind Tomorrow.io round trips.
    cached = await loop.run_in_executor(_CACHE_EXECUTOR, _get_cached_tile, cache_id)
    if cached is not None:
        return _tile_response(cached, layer, "HIT", timestamp, now)

    # 2. Quota already spent (a 429 here or in enrichment) or the breaker is
    #    open: asking again only costs a 2–8 s round trip. Cached tile or
    #    transparent.
    if _quota_exhausted(now):
        return await loop.run_in_executor(
            _CACHE_EXECUTOR, _quota_fallback, layer, z, x, y, timestamp, now
        )
    if not tomorrow_breaker.is_allowed:
        return await loop.run_in_executor(_CACHE_EXECUTOR, _error_fallback, cache_id)

    return await loop.run_in_executor(
        _UPSTREAM_EXECUTOR, _fetch_upstream, z, x, y, layer, timestamp, now, cache_id
    )


def _error_fallback(cache_id: str) -> Response:
    """After an upstream failure: a stale cached tile if any, else transparent."""
    stale = _get_cached_tile(cache_id, allow_stale=True)
    if stale is not None:
        return _stale_tile_response(stale, cache_id.split("/", 1)[0])
    return _transparent_tile_response()


def _fetch_upstream(
    z: int, x: int, y: int, layer: str, timestamp: str, now: datetime, cache_id: str
) -> Response:
    """
    The upstream half of the proxy (blocking HTTP), run in a worker thread of
    the upstream pool by :func:`proxy_map_tile`. Arguments are already validated
    and the cache already missed.
    """
    # Re-check the memo here: on a cold instance a burst passes the check in
    # ``proxy_map_tile`` together, then queues for the pool; once the first
    # worker has seen the quota 429 the rest must not each pay a round trip.
    if _quota_exhausted():
        return _quota_fallback(layer, z, x, y, timestamp, now)

    try:
        api_key = get_api_key("tomorrow")
        if not api_key:
            logger.warning(
                "Tomorrow.io tile request rejected: no 'tomorrow' API key in "
                "api_keys collection. Seed it via POST /api/db-init with "
                "apiKeys.tomorrow so weather overlays can render."
            )
            raise HTTPException(status_code=503, detail="Map service unavailable")

        tile_url = f"{TOMORROW_TILE_ORIGIN}/v4/map/tile/{z}/{x}/{y}/{layer}/{timestamp}.png"

        # Key in the `apikey` header, never the URL — request URLs get logged.
        client = _get_http()
        resp = client.get(tile_url, headers={"apikey": api_key})

        # 3. 429. The shared rule (``_enrichment.classify_429``): a remaining
        #    count at 0 means the quota is spent for the hour; headers showing
        #    quota left mean a per-second burst (nothing remembered); no header
        #    at all is remembered for about a minute. Not a provider failure,
        #    so the breaker is untouched. The tile path does not call
        #    ``record_skip``: that would overwrite enrichment's last-error
        #    detail and inflate its skippedBudget counter.
        if resp.status_code == 429:
            quota = _enrichment.classify_429(resp.headers)
            logger.warning(
                "Tomorrow.io tile rate limited (429, %s) for layer=%s z=%s",
                {True: "quota", False: "burst", None: "unclear"}[quota], layer, z,
            )
            if quota is False:
                return _error_fallback(cache_id)
            if quota is True:
                _enrichment.mark_rate_limited(now)
            else:
                _enrichment.mark_rate_limited(now, ttl_s=_enrichment.UNCLEAR_429_MEMO_S)
            return _quota_fallback(layer, z, x, y, timestamp, now)

        # 4. Any other upstream error — degrade gracefully: a stale cached tile
        #    if we have one, else a transparent tile, briefly cached. Only
        #    server-side failures count against the breaker.
        if resp.status_code != 200:
            logger.warning(
                "Tomorrow.io tile upstream error: status=%s layer=%s z/x/y=%s/%s/%s",
                resp.status_code, layer, z, x, y,
            )
            if resp.status_code >= 500:
                tomorrow_breaker.record_failure()
            return _error_fallback(cache_id)

        # 5. Fresh tile — persist to cache and return with strong CDN caching.
        tomorrow_breaker.record_success()
        _set_cached_tile(cache_id, layer, resp.content)
        return _tile_response(resp.content, layer, "MISS", timestamp, now)
    except HTTPException:
        raise
    except Exception:
        logger.exception("Tomorrow.io tile proxy failed for layer=%s z/x/y=%s/%s/%s", layer, z, x, y)
        # Network/unexpected failure — counts against the breaker; serve a
        # stale tile if we have one so the overlay survives a transient blip.
        tomorrow_breaker.record_failure()
        return _error_fallback(cache_id)
