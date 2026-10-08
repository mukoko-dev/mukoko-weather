"""
Climate normals — the average daily high/low for a calendar day at a place.

Powers the "AVERAGES" card ("+5° above the average daily high"). Source is the
ERA5 reanalysis served by Open-Meteo's Historical Weather API (free, no key),
over the 1991–2020 climate period.

Build strategy:

* ERA5 is a ~0.25° grid, so coordinates are snapped to a 0.25° cell first.
  Every request inside a cell shares one table, and the cell is the cache key.
* One upstream request per cell covers the whole 30-year period (~11k daily
  rows, ~250 KB, ~1 s measured). The response is reduced to two 366-entry
  day-of-year tables: the mean daily maximum and mean daily minimum, each
  averaged over a ±7-day window that wraps the year end.
* The tables are cached in ``weather.climate_normals`` under the deterministic
  ``_id`` ``{lat:.2f}_{lon:.2f}`` (the snapped cell). Normals do not change, so
  the document has no TTL.

Day-of-year slots use a leap-year calendar: slot 59 is Feb 29, and every other
date keeps its month/day position in that calendar. Feb 29 therefore averages
only leap-year observations (plus its ±7-day neighbours), and non-leap years
never shift into the wrong slot.

Graceful degradation: every failure path returns HTTP 200 with
``available: false`` and a ``reason``. Only malformed input is a 400.
"""

from __future__ import annotations

import asyncio
import datetime as _dt
import math
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ._db import stamp_platform_fields, weather_db
from ._circuit_breaker import open_meteo_breaker

router = APIRouter()


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"

NORMALS_START = "1991-01-01"
NORMALS_END = "2020-12-31"
NORMALS_PERIOD = "1991–2020"
NORMALS_SOURCE = "ERA5 via Open-Meteo, 1991–2020"

#: ERA5 grid spacing. Coordinates are snapped to this before fetch and cache.
GRID_STEP_DEG = 0.25

#: Half-width of the day-of-year averaging window (±7 days → 15-day window).
HALF_WINDOW_DAYS = 7

#: Number of day-of-year slots in the leap-year calendar.
SLOTS = 366

#: Client-side budget for the one-off 30-year build. The breaker's own
#: per-request timeout (8 s) is too short for this payload, so the build runs
#: with its own httpx timeout and the breaker is driven with record_* calls.
NORMALS_HTTP_TIMEOUT_S = 20.0
NORMALS_BUILD_TIMEOUT_S = 22.0


# ---------------------------------------------------------------------------
# Response model
# ---------------------------------------------------------------------------


class NormalsResponse(BaseModel):
    """Average daily high/low for one calendar day at one place (°C)."""

    available: bool
    lat: float
    lon: float
    date: str
    normalHigh: Optional[float] = None
    normalLow: Optional[float] = None
    period: str = NORMALS_PERIOD
    source: str = NORMALS_SOURCE
    computedAt: Optional[str] = None
    reason: Optional[str] = None


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def snap_to_grid(value: float) -> float:
    """Snap a coordinate to the nearest ERA5 grid cell (0.25°, half-up)."""
    return math.floor(value / GRID_STEP_DEG + 0.5) * GRID_STEP_DEG


def cache_key(glat: float, glon: float) -> str:
    """Deterministic ``_id`` for a snapped cell: ``{lat:.2f}_{lon:.2f}``."""
    return f"{glat:.2f}_{glon:.2f}"


def day_slot(month: int, day: int) -> int:
    """
    Map a calendar month/day to a 0-based slot in the leap-year calendar.

    Jan 1 → 0, Feb 28 → 58, Feb 29 → 59, Mar 1 → 60 (in every year), Dec 31 → 365.
    """
    return _dt.date(2000, month, day).timetuple().tm_yday - 1


def _slot_for_iso(iso_date: str) -> int:
    d = _dt.date.fromisoformat(iso_date)
    return day_slot(d.month, d.day)


def compute_normal_tables(daily: dict) -> tuple[list[Optional[float]], list[Optional[float]]]:
    """
    Reduce an Open-Meteo daily payload to two 366-entry day-of-year tables.

    ``daily`` holds parallel lists ``time`` (ISO dates), ``temperature_2m_max``
    and ``temperature_2m_min``. Returns ``(max_table, min_table)``. Each slot is
    the mean over a ±HALF_WINDOW_DAYS circular window, using every observation
    in that window across all years. ``None`` values are skipped. A slot with no
    observations in its window is ``None``.
    """
    times = daily.get("time") or []
    highs = daily.get("temperature_2m_max") or []
    lows = daily.get("temperature_2m_min") or []

    sum_hi = [0.0] * SLOTS
    sum_lo = [0.0] * SLOTS
    cnt_hi = [0] * SLOTS
    cnt_lo = [0] * SLOTS

    for i, iso in enumerate(times):
        slot = _slot_for_iso(iso)
        hi = highs[i] if i < len(highs) else None
        lo = lows[i] if i < len(lows) else None
        if hi is not None:
            sum_hi[slot] += float(hi)
            cnt_hi[slot] += 1
        if lo is not None:
            sum_lo[slot] += float(lo)
            cnt_lo[slot] += 1

    max_table: list[Optional[float]] = []
    min_table: list[Optional[float]] = []
    for s in range(SLOTS):
        hi_sum = lo_sum = 0.0
        hi_n = lo_n = 0
        for k in range(-HALF_WINDOW_DAYS, HALF_WINDOW_DAYS + 1):
            idx = (s + k) % SLOTS
            hi_sum += sum_hi[idx]
            hi_n += cnt_hi[idx]
            lo_sum += sum_lo[idx]
            lo_n += cnt_lo[idx]
        max_table.append(round(hi_sum / hi_n, 2) if hi_n else None)
        min_table.append(round(lo_sum / lo_n, 2) if lo_n else None)
    return max_table, min_table


def _parse_target_date(raw: Optional[str]) -> str:
    """Validate ``YYYY-MM-DD`` (defaults to today UTC). Raises HTTP 400 otherwise."""
    if raw is None or raw == "":
        return _dt.datetime.now(_dt.timezone.utc).date().isoformat()
    try:
        return _dt.date.fromisoformat(raw).isoformat()
    except ValueError:
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")


# ---------------------------------------------------------------------------
# Upstream + cache
# ---------------------------------------------------------------------------

_http_client: Optional[httpx.Client] = None


def _get_http() -> httpx.Client:
    global _http_client
    if _http_client is None:
        _http_client = httpx.Client(timeout=NORMALS_HTTP_TIMEOUT_S)
    return _http_client


def _fetch_archive(glat: float, glon: float) -> dict:
    """
    Fetch the 1991–2020 daily max/min for a snapped cell. Returns the ``daily``
    block. Raises on HTTP error (the caller records the failure).
    """
    params = {
        "latitude": f"{glat}",
        "longitude": f"{glon}",
        "start_date": NORMALS_START,
        "end_date": NORMALS_END,
        "daily": "temperature_2m_max,temperature_2m_min",
        "timezone": "auto",
    }
    resp = _get_http().get(ARCHIVE_URL, params=params)
    resp.raise_for_status()
    data = resp.json()
    daily = data.get("daily")
    if not isinstance(daily, dict) or not daily.get("time"):
        raise ValueError("archive response has no daily block")
    return daily


def _normals_collection():
    """``weather.climate_normals`` — no TTL; normals are fixed for the period."""
    return weather_db()["climate_normals"]


def _get_cached_tables(key: str) -> Optional[dict]:
    try:
        doc = _normals_collection().find_one({"_id": key})
    except Exception:
        return None
    if not doc or not doc.get("maxByDay") or not doc.get("minByDay"):
        return None
    return doc


def _set_cached_tables(key: str, glat: float, glon: float, max_table, min_table) -> Optional[str]:
    """Upsert the table doc by its deterministic ``_id``. Returns ``computedAt``."""
    now = _dt.datetime.now(_dt.timezone.utc)
    doc = {
        "_id": key,
        "lat": glat,
        "lon": glon,
        "period": NORMALS_PERIOD,
        "source": NORMALS_SOURCE,
        "maxByDay": max_table,
        "minByDay": min_table,
        "computedAt": now,
    }
    stamp_platform_fields(doc)
    try:
        _normals_collection().update_one({"_id": key}, {"$set": doc}, upsert=True)
    except Exception:
        # A failed cache write must not fail the response.
        pass
    return now.isoformat()


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


def _unavailable(lat: float, lon: float, date_iso: str, reason: str) -> NormalsResponse:
    return NormalsResponse(available=False, lat=lat, lon=lon, date=date_iso, reason=reason)


@router.get("/api/py/normals", response_model=NormalsResponse)
async def get_normals(
    lat: float,
    lon: float,
    date: Optional[str] = Query(default=None, description="YYYY-MM-DD; defaults to today UTC"),
):
    """
    GET /api/py/normals?lat=&lon=&date=YYYY-MM-DD

    Average daily high and low (°C) for that calendar day at that place,
    1991–2020 (ERA5 via Open-Meteo). Lookup order:

    1. MongoDB ``weather.climate_normals`` by snapped cell (instant on hit)
    2. Open-Meteo Historical Weather API via ``open_meteo_breaker``, one
       30-year request per cell, then cached

    Returns HTTP 200 with ``available: false`` and a ``reason``
    (``circuit_open``, ``upstream_error``, ``timeout``) when normals cannot be
    produced. Only malformed input returns 400.
    """
    if lat < -90 or lat > 90 or lon < -180 or lon > 180:
        raise HTTPException(status_code=400, detail="Invalid coordinates")
    date_iso = _parse_target_date(date)
    slot = _slot_for_iso(date_iso)

    glat, glon = snap_to_grid(lat), snap_to_grid(lon)
    key = cache_key(glat, glon)

    cached = _get_cached_tables(key)
    if cached:
        cached_at = cached.get("computedAt")
        if isinstance(cached_at, _dt.datetime):
            cached_at = cached_at.isoformat()
        return _respond(lat, lon, date_iso, slot, cached["maxByDay"], cached["minByDay"],
                        cached_at)

    if not open_meteo_breaker.is_allowed:
        return _unavailable(lat, lon, date_iso, "circuit_open")

    loop = asyncio.get_running_loop()
    try:
        daily = await asyncio.wait_for(
            loop.run_in_executor(None, lambda: _fetch_archive(glat, glon)),
            timeout=NORMALS_BUILD_TIMEOUT_S,
        )
    except asyncio.TimeoutError:
        open_meteo_breaker.record_failure()
        return _unavailable(lat, lon, date_iso, "timeout")
    except Exception:
        open_meteo_breaker.record_failure()
        return _unavailable(lat, lon, date_iso, "upstream_error")

    open_meteo_breaker.record_success()
    max_table, min_table = compute_normal_tables(daily)
    computed_at = _set_cached_tables(key, glat, glon, max_table, min_table)
    return _respond(lat, lon, date_iso, slot, max_table, min_table, computed_at)


def _respond(lat, lon, date_iso, slot, max_table, min_table, computed_at) -> NormalsResponse:
    hi = max_table[slot] if slot < len(max_table) else None
    lo = min_table[slot] if slot < len(min_table) else None
    if hi is None or lo is None:
        return _unavailable(lat, lon, date_iso, "no_data")
    return NormalsResponse(
        available=True,
        lat=lat,
        lon=lon,
        date=date_iso,
        normalHigh=round(float(hi), 1),
        normalLow=round(float(lo), 1),
        computedAt=computed_at,
    )
