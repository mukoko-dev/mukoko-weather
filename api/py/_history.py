"""
History endpoint: DB first, then pull only the missing dates (issue #268).

Returns historical weather for a place or any coordinate on Earth, with one
doc per local day. Days recorded by ``/api/py/weather`` on fresh provider
fetches come first. Past dates we don't hold are pulled on demand from the
external archive providers in ``_history_store`` (NASA POWER, then Open-Meteo,
by default) and stored insert-only, so the next request is served from the DB.
"""

from __future__ import annotations

import asyncio
from datetime import date as _date
from typing import Annotated, Optional

from fastapi import APIRouter, HTTPException, Query, Request

from ._db import check_rate_limit, get_client_ip
from ._history_store import (
    EARLIEST_DATE,
    MAX_RANGE_DAYS,
    attributions_for,
    backfill_range,
    local_today,
    merge_by_date,
    read_history_range,
    window_for_days,
)
from ._places_resolver import find_location
from ._weather_cache_key import weather_cache_key

router = APIRouter()


def history_slugs(location: str, loc: dict) -> list[str]:
    """Canonical slug first, then the platform hash slug older writes used."""
    slugs = [location]
    platform = loc.get("platformSlug")
    if platform and platform != location:
        slugs.append(platform)
    return slugs


def _parse_date(name: str, raw: str) -> str:
    try:
        return _date.fromisoformat(raw).isoformat()
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"{name} must be YYYY-MM-DD")


def resolve_range(
    days: Optional[int], start: Optional[str], end: Optional[str], *, lon: float
) -> tuple[str, str]:
    """Validate the requested window and return ``(start, end)``, inclusive.

    ``start``/``end`` win over ``days``. ``end`` defaults to today (local) and
    is clamped to it. The span is capped at ``MAX_RANGE_DAYS``.
    """
    today = local_today(lon)
    if start or end:
        if not start:
            raise HTTPException(status_code=400, detail="start is required when end is given")
        s = _parse_date("start", start)
        e = _parse_date("end", end) if end else today
        e = min(e, today)
        if s < EARLIEST_DATE:
            raise HTTPException(status_code=400, detail=f"start must be on or after {EARLIEST_DATE}")
        if s > e:
            raise HTTPException(status_code=400, detail="start must be on or before end (and not in the future)")
        span = (_date.fromisoformat(e) - _date.fromisoformat(s)).days + 1
        if span > MAX_RANGE_DAYS:
            raise HTTPException(status_code=400, detail=f"range must be at most {MAX_RANGE_DAYS} days")
        return s, e
    n = 30 if days is None else days
    if n < 1 or n > MAX_RANGE_DAYS:
        raise HTTPException(status_code=400, detail=f"days must be between 1 and {MAX_RANGE_DAYS}")
    return window_for_days(n, lon=lon)


@router.get("/api/py/history")
async def get_history(
    location: Annotated[Optional[str], Query(description="Place slug, e.g. harare")] = None,
    days: Annotated[Optional[int], Query(description=f"Last N local days, 1-{MAX_RANGE_DAYS} (default 30)")] = None,
    start: Annotated[Optional[str], Query(description="YYYY-MM-DD, inclusive; wins over days")] = None,
    end: Annotated[Optional[str], Query(description="YYYY-MM-DD, inclusive; defaults to today")] = None,
    lat: Annotated[Optional[float], Query(description="WGS 84 latitude: any coordinate on Earth")] = None,
    lon: Annotated[Optional[float], Query(description="WGS 84 longitude")] = None,
    request: Request = None,
):
    """
    GET /api/py/history?location=harare&days=30
    GET /api/py/history?location=harare&start=2020-01-01&end=2020-12-31
    GET /api/py/history?lat=51.5072&lon=-0.1276&days=365

    ``location`` is a place slug. ``lat``/``lon`` identify any coordinate on
    Earth: they are used when there's no slug, and as a fallback when the slug
    isn't a known place. A bare coordinate is stored under its 0.05° grid key.

    Returns ``{location, start, end, days, records, backfilled, sources, data}``.
    ``data`` is newest first with one doc per date. Each doc carries ``source``:
    ``"recorded"`` or an archive provider id. ``sources`` holds the attribution
    for every archive provider present in ``data``.
    """
    has_coords = lat is not None and lon is not None
    if not location and not has_coords:
        raise HTTPException(status_code=400, detail="Missing location parameter (or lat and lon)")
    if has_coords and not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise HTTPException(status_code=400, detail="Invalid coordinates")

    # Reject malformed ranges before any lookup (resolve_range re-checks them
    # against the place's local "today" once the coordinate is known).
    if days is not None and not 1 <= days <= MAX_RANGE_DAYS:
        raise HTTPException(status_code=400, detail=f"days must be between 1 and {MAX_RANGE_DAYS}")
    if start:
        _parse_date("start", start)
    if end:
        _parse_date("end", end)

    loc: Optional[dict] = None
    if location:
        # Resolved through places.placesGeo (Phase 0G).
        try:
            loc = find_location(location)
        except Exception:
            if not has_coords:
                raise HTTPException(status_code=503, detail="Location service unavailable")
            loc = None
        if not loc and not has_coords:
            raise HTTPException(status_code=404, detail="Unknown location")

    if loc:
        key = location
        slugs = history_slugs(location, loc)
        p_lat, p_lon = loc.get("lat"), loc.get("lon")
    else:
        key = weather_cache_key(lat, lon)
        slugs = [key]
        p_lat, p_lon = lat, lon

    lon_f = float(p_lon if p_lon is not None else 0.0)
    range_start, range_end = resolve_range(days, start, end, lon=lon_f)
    span_days = (_date.fromisoformat(range_end) - _date.fromisoformat(range_start)).days + 1

    try:
        history = await asyncio.to_thread(read_history_range, slugs, range_start, range_end)
    except Exception:
        raise HTTPException(status_code=502, detail="Failed to fetch weather history")

    # Fill gaps from the archive providers (best-effort; never fails the response).
    backfilled: list[dict] = []
    if p_lat is not None and p_lon is not None:
        # Sync httpx + pymongo work: run it off the event loop so a slow
        # archive response never stalls other requests on this instance.
        backfilled = await asyncio.to_thread(
            backfill_range,
            key,
            float(p_lat),
            lon_f,
            range_start,
            range_end,
            [d["date"] for d in history if isinstance(d.get("date"), str)],
            client_ip=get_client_ip(request) if request is not None else None,
            rate_limiter=check_rate_limit,
        )
    if backfilled:
        history = merge_by_date(history + backfilled, slugs)

    return {
        "location": key,
        "start": range_start,
        "end": range_end,
        "days": span_days,
        "records": len(history),
        "backfilled": len(backfilled),
        "sources": attributions_for(history),
        "data": history,
    }

