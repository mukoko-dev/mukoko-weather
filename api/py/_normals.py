"""
Climate normals — the average daily high/low for a calendar day at a place.

Powers the "AVERAGES" card ("+5° above the average daily high") over the
1991–2020 climate period. The data comes from the same archive provider chain
as ``/api/py/history`` (``_history_store.provider_chain``; issue #268): NASA
POWER first (free and open for commercial use), then Open-Meteo's ERA5 archive.

Build strategy:

* Coordinates are snapped to a 0.25° cell first (the ERA5 grid; NASA POWER is
  coarser, ~0.5°).
  Every request inside a cell shares one table, and the cell is the cache key.
* One upstream request per cell covers the whole 30-year period (~11k daily
  rows, ~250 KB, ~1 s measured). The response is reduced to two 366-entry
  day-of-year tables: the mean daily maximum and mean daily minimum, each
  averaged over a ±7-day window that wraps the year end.
* The tables are cached in ``weather.climate_normals`` under the deterministic
  ``_id`` ``{lat:.2f}_{lon:.2f}`` (the snapped cell), together with the
  provider that built them (``source``, ``provider``). Normals do not change,
  so the document has no TTL.
* The same request also carries the daily mean temperature and precipitation,
  reduced to twelve monthly normals (mean, high, low, rainfall, rainy days
  ≥ 1 mm) for the place-knowledge profile (``_place_knowledge.py``). When the
  answering provider reports them (Open-Meteo does, NASA POWER does not), the
  cell's IANA time zone and model elevation are stored too. Documents cached
  before the monthly table existed are rebuilt once, on the first profile
  build that needs them (:func:`get_monthly_normals`).

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

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ._db import check_rate_limit, stamp_platform_fields, weather_db
from ._history_store import PROVIDERS, fetch_normals_series, provider_info

router = APIRouter()


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

NORMALS_START = "1991-01-01"
NORMALS_END = "2020-12-31"
NORMALS_PERIOD = "1991–2020"
#: Label for cached tables built before #268 (Open-Meteo ERA5, no provider field).
NORMALS_SOURCE = "ERA5 via Open-Meteo, 1991–2020"
LEGACY_PROVIDER = "open-meteo-archive"

#: ERA5 grid spacing. Coordinates are snapped to this before fetch and cache.
GRID_STEP_DEG = 0.25

#: Half-width of the day-of-year averaging window (±7 days → 15-day window).
HALF_WINDOW_DAYS = 7

#: Number of day-of-year slots in the leap-year calendar.
SLOTS = 366

#: Daily variables requested from the provider chain. The mean and
#: precipitation feed the monthly normals; the max/min feed the day-of-year
#: tables.
DAILY_VARS = (
    "temperature_2m_max",
    "temperature_2m_min",
    "temperature_2m_mean",
    "precipitation_sum",
)

#: A day with at least this much rain counts as a rainy day (WMO convention).
RAINY_DAY_MM = 1.0

#: A (year, month) needs this many days with data to enter the monthly normal.
MIN_DAYS_PER_MONTH = 25

#: Client-side budget for the one-off 30-year build. The breakers' own
#: per-request timeouts are too short for this payload, so the build runs with
#: its own httpx timeout and the breakers are driven with record_* calls.
NORMALS_HTTP_TIMEOUT_S = 20.0
NORMALS_BUILD_TIMEOUT_S = 45.0


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
    #: Archive provider id that built the tables (``nasa-power``, ``open-meteo-archive``).
    provider: Optional[str] = None
    #: Required credit for that provider, and where it points.
    attribution: Optional[str] = None
    attributionUrl: Optional[str] = None
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


def _mean(values: list[float]) -> Optional[float]:
    return round(sum(values) / len(values), 1) if values else None


def compute_monthly_normals(daily: dict) -> list[dict]:
    """
    Reduce an Open-Meteo daily payload to twelve monthly normals.

    For each calendar month: the mean of the yearly means of the daily mean,
    high and low temperatures, and the mean yearly monthly rainfall total and
    rainy-day count (≥ ``RAINY_DAY_MM``). A (year, month) with fewer than
    ``MIN_DAYS_PER_MONTH`` days of data is left out. The daily mean falls back
    to (max + min) / 2 when the payload has no ``temperature_2m_mean``.
    Returns twelve dicts (January first); a month with no data has ``None``
    values.
    """
    times = daily.get("time") or []
    highs = daily.get("temperature_2m_max") or []
    lows = daily.get("temperature_2m_min") or []
    means = daily.get("temperature_2m_mean") or []
    precs = daily.get("precipitation_sum") or []

    def at(arr, i):
        return arr[i] if i < len(arr) else None

    buckets: dict[tuple[int, int], dict] = {}
    for i, iso in enumerate(times):
        try:
            d = _dt.date.fromisoformat(iso[:10])
        except (TypeError, ValueError):
            continue
        b = buckets.setdefault((d.year, d.month), {"t": [], "hi": [], "lo": [], "p": [], "days": 0})
        hi, lo, mean, pr = at(highs, i), at(lows, i), at(means, i), at(precs, i)
        if mean is None and hi is not None and lo is not None:
            mean = (float(hi) + float(lo)) / 2
        if mean is None and pr is None:
            continue
        b["days"] += 1
        if mean is not None:
            b["t"].append(float(mean))
        if hi is not None:
            b["hi"].append(float(hi))
        if lo is not None:
            b["lo"].append(float(lo))
        if pr is not None:
            b["p"].append(float(pr))

    per_month: dict[int, dict[str, list[float]]] = {
        m: {"t": [], "hi": [], "lo": [], "p": [], "rd": []} for m in range(1, 13)
    }
    for (_, month), b in buckets.items():
        if b["days"] < MIN_DAYS_PER_MONTH:
            continue
        acc = per_month[month]
        if b["t"]:
            acc["t"].append(sum(b["t"]) / len(b["t"]))
        if b["hi"]:
            acc["hi"].append(sum(b["hi"]) / len(b["hi"]))
        if b["lo"]:
            acc["lo"].append(sum(b["lo"]) / len(b["lo"]))
        if len(b["p"]) >= MIN_DAYS_PER_MONTH:
            acc["p"].append(sum(b["p"]))
            acc["rd"].append(sum(1 for v in b["p"] if v >= RAINY_DAY_MM))

    return [
        {
            "month": m,
            "meanTempC": _mean(per_month[m]["t"]),
            "meanHighC": _mean(per_month[m]["hi"]),
            "meanLowC": _mean(per_month[m]["lo"]),
            "precipMm": _mean(per_month[m]["p"]),
            "rainyDays": _mean(per_month[m]["rd"]),
        }
        for m in range(1, 13)
    ]


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

def _fetch_archive(glat: float, glon: float) -> tuple[dict, str]:
    """
    Fetch the 1991–2020 daily max/min for a snapped cell from the provider
    chain. Returns ``(daily, provider_id)``. Raises ``NormalsUnavailable`` with
    a reason when no provider can supply it (breakers are recorded inside).
    """
    daily, provider, reason = fetch_normals_series(
        glat, glon, NORMALS_START, NORMALS_END,
        variables=DAILY_VARS,
        rate_limiter=check_rate_limit,
        timeout=NORMALS_HTTP_TIMEOUT_S,
    )
    if daily is None or provider is None:
        raise NormalsUnavailable(reason or "upstream_error")
    return daily, provider.info.id


class NormalsUnavailable(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def source_label(provider_id: Optional[str]) -> str:
    """Human-readable source line, e.g. ``NASA POWER, 1991–2020``."""
    provider = PROVIDERS.get(provider_id or "")
    if provider is None or provider_id == LEGACY_PROVIDER:
        return NORMALS_SOURCE
    return f"{provider.info.name}, {NORMALS_PERIOD}"


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


def _set_cached_tables(
    key: str, glat: float, glon: float, max_table, min_table,
    provider_id: Optional[str] = None,
    monthly: Optional[list[dict]] = None, meta: Optional[dict] = None,
) -> Optional[str]:
    """Upsert the table doc by its deterministic ``_id``. Returns ``computedAt``."""
    now = _dt.datetime.now(_dt.timezone.utc)
    doc = {
        "_id": key,
        "lat": glat,
        "lon": glon,
        "period": NORMALS_PERIOD,
        "source": source_label(provider_id),
        "provider": provider_id or LEGACY_PROVIDER,
        "maxByDay": max_table,
        "minByDay": min_table,
        "computedAt": now,
    }
    if monthly:
        doc["monthly"] = monthly
    meta = meta or {}
    if meta.get("timezone"):
        doc["timeZone"] = meta["timezone"]
    if meta.get("utc_offset_seconds") is not None:
        doc["utcOffsetSeconds"] = meta["utc_offset_seconds"]
    if meta.get("elevation") is not None:
        doc["elevation"] = meta["elevation"]
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
    1991–2020. Lookup order:

    1. MongoDB ``weather.climate_normals`` by snapped cell (instant on hit)
    2. The archive provider chain (NASA POWER, then Open-Meteo ERA5), one
       30-year request per cell, each guarded by its own breaker and budget,
       then cached

    Returns HTTP 200 with ``available: false`` and a ``reason``
    (``circuit_open``, ``upstream_error``, ``timeout``, ``no_data``) when
    normals cannot be produced. Only malformed input returns 400.
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
                        cached_at, cached.get("provider") or LEGACY_PROVIDER)

    loop = asyncio.get_running_loop()
    try:
        daily, provider_id = await asyncio.wait_for(
            loop.run_in_executor(None, lambda: _fetch_archive(glat, glon)),
            timeout=NORMALS_BUILD_TIMEOUT_S,
        )
    except asyncio.TimeoutError:
        return _unavailable(lat, lon, date_iso, "timeout")
    except NormalsUnavailable as exc:
        return _unavailable(lat, lon, date_iso, exc.reason)
    except Exception:
        return _unavailable(lat, lon, date_iso, "upstream_error")

    max_table, min_table = compute_normal_tables(daily)
    computed_at = _set_cached_tables(
        key, glat, glon, max_table, min_table, provider_id,
        compute_monthly_normals(daily), daily.get("_meta"),
    )
    return _respond(lat, lon, date_iso, slot, max_table, min_table, computed_at, provider_id)


def _respond(lat, lon, date_iso, slot, max_table, min_table, computed_at,
             provider_id: Optional[str] = None) -> NormalsResponse:
    hi = max_table[slot] if slot < len(max_table) else None
    lo = min_table[slot] if slot < len(min_table) else None
    if hi is None or lo is None:
        return _unavailable(lat, lon, date_iso, "no_data")
    info = provider_info(provider_id or "")
    return NormalsResponse(
        available=True,
        lat=lat,
        lon=lon,
        date=date_iso,
        normalHigh=round(float(hi), 1),
        normalLow=round(float(lo), 1),
        source=source_label(provider_id),
        provider=provider_id,
        attribution=(info or {}).get("attribution"),
        attributionUrl=(info or {}).get("url"),
        computedAt=computed_at,
    )


# ---------------------------------------------------------------------------
# Monthly normals for the place-knowledge profile (synchronous)
# ---------------------------------------------------------------------------


def _monthly_payload(key: str, doc: dict) -> Optional[dict]:
    monthly = doc.get("monthly")
    if not monthly or len(monthly) != 12:
        return None
    return {
        "cell": key,
        "period": doc.get("period", NORMALS_PERIOD),
        "source": doc.get("source") or source_label(doc.get("provider")),
        "provider": doc.get("provider") or LEGACY_PROVIDER,
        "monthly": monthly,
        "timeZone": doc.get("timeZone"),
        "utcOffsetSeconds": doc.get("utcOffsetSeconds"),
        "elevation": doc.get("elevation"),
    }


def get_monthly_normals(lat: float, lon: float, *, allow_fetch: bool = True) -> Optional[dict]:
    """
    Twelve monthly normals for the 0.25° cell holding (lat, lon), with the
    cell's time zone and model elevation. Used by the place-knowledge builder,
    which runs off the request path.

    Cache first (``weather.climate_normals``). A cached document from before
    the monthly table existed is rebuilt with one archive request, which also
    refreshes its day-of-year tables. With ``allow_fetch=False`` only the
    cache is read. Returns ``None`` when nothing can be produced (open
    breaker, upstream failure); never raises.
    """
    glat, glon = snap_to_grid(lat), snap_to_grid(lon)
    key = cache_key(glat, glon)
    cached = _get_cached_tables(key)
    if cached:
        payload = _monthly_payload(key, cached)
        if payload:
            return payload
    if not allow_fetch:
        return None
    try:
        daily, provider_id = _fetch_archive(glat, glon)
    except Exception:
        # NormalsUnavailable already recorded the breakers; anything else is
        # an unexpected failure the caller treats the same way.
        return None
    max_table, min_table = compute_normal_tables(daily)
    monthly = compute_monthly_normals(daily)
    meta = daily.get("_meta") or {}
    _set_cached_tables(key, glat, glon, max_table, min_table, provider_id, monthly, meta)
    return _monthly_payload(key, {
        "monthly": monthly,
        "provider": provider_id,
        "timeZone": meta.get("timezone"),
        "utcOffsetSeconds": meta.get("utc_offset_seconds"),
        "elevation": meta.get("elevation"),
    })
