"""
History endpoint — migrated from /api/history.

Returns historical weather for a location: one doc per local day, recorded by
``/api/py/weather`` on fresh provider fetches, with missing past days filled
on demand from the Open-Meteo Historical/Archive API (see ``_history_store``).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from ._circuit_breaker import open_meteo_breaker
from ._db import check_rate_limit, get_client_ip
from ._history_store import backfill_history, merge_by_date, read_history
from ._places_resolver import find_location

router = APIRouter()


def _get_http_client():
    # Reuse the weather module's warm httpx client.
    from ._weather import _get_http_client as weather_http_client

    return weather_http_client()


def history_slugs(location: str, loc: dict) -> list[str]:
    """Canonical slug first, then the platform hash slug older writes used."""
    slugs = [location]
    platform = loc.get("platformSlug")
    if platform and platform != location:
        slugs.append(platform)
    return slugs


@router.get("/api/py/history")
async def get_history(location: str, days: int = 30, request: Request = None):
    """
    GET /api/py/history?location=harare&days=30

    Returns ``{location, days, records, backfilled, data}``. ``data`` is
    newest first, one doc per date; each doc carries ``source`` —
    ``"recorded"`` or ``"open-meteo-archive"``.
    """
    if not location:
        raise HTTPException(status_code=400, detail="Missing location parameter")

    if days < 1 or days > 365:
        raise HTTPException(status_code=400, detail="days must be between 1 and 365")

    # Verify location exists (Phase 0G: resolved via places.placesGeo)
    try:
        loc = find_location(location)
    except Exception:
        raise HTTPException(status_code=503, detail="Location service unavailable")

    if not loc:
        raise HTTPException(status_code=404, detail="Unknown location")

    slugs = history_slugs(location, loc)
    lon = float(loc.get("lon") or 0.0)

    try:
        history = read_history(slugs, days, lon=lon)
    except Exception:
        raise HTTPException(status_code=502, detail="Failed to fetch weather history")

    # Fill gaps from the archive (best-effort; never fails the response).
    backfilled: list[dict] = []
    lat = loc.get("lat")
    if lat is not None and loc.get("lon") is not None:
        backfilled = backfill_history(
            location,
            float(lat),
            lon,
            days,
            [d["date"] for d in history if isinstance(d.get("date"), str)],
            http_client=_get_http_client(),
            breaker=open_meteo_breaker,
            client_ip=get_client_ip(request) if request is not None else None,
            rate_limiter=check_rate_limit,
        )
    if backfilled:
        history = merge_by_date(history + backfilled, slugs)

    return {
        "location": location,
        "days": days,
        "records": len(history),
        "backfilled": len(backfilled),
        "data": history,
    }
