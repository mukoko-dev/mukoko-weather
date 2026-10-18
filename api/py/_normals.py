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
* The same request also carries the daily mean temperature and precipitation,
  reduced to twelve monthly normals (mean, high, low, rainfall, rainy days
  ≥ 1 mm) for the place-knowledge profile (``_place_knowledge.py``), plus the
  cell's IANA time zone and model elevation. Documents cached before the
  monthly table existed are rebuilt once, on the first profile build that
  needs them (:func:`get_monthly_normals`).

Day-of-year slots use a leap-year calendar: slot 59 is Feb 29, and every other
date keeps its month/day position in that calendar. Feb 29 therefore averages
only leap-year observations (plus its ±7-day neighbours), and non-leap years
never shift into the wrong slot.

The route itself (``GET /api/py/normals``) now lives in the Rust Workers
(``GET /v1/normals``, ``workers/forecast/src/normals.rs``,
``weather_core::normals``). This module stays only because the place-knowledge
builder reads the monthly normals through :func:`get_monthly_normals`; it goes
with that port (#333).
"""

from __future__ import annotations

import datetime as _dt
import math
from typing import Optional

import httpx
from ._db import stamp_platform_fields, weather_db
from ._circuit_breaker import open_meteo_breaker

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

#: Daily variables requested from the archive. The mean and precipitation
#: feed the monthly normals; the max/min feed the day-of-year tables.
DAILY_VARS = "temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum"

#: A day with at least this much rain counts as a rainy day (WMO convention).
RAINY_DAY_MM = 1.0

#: A (year, month) needs this many days with data to enter the monthly normal.
MIN_DAYS_PER_MONTH = 25

#: Client-side budget for the one-off 30-year build. The breaker's own
#: per-request timeout (8 s) is too short for this payload, so the build runs
#: with its own httpx timeout and the breaker is driven with record_* calls.
NORMALS_HTTP_TIMEOUT_S = 20.0
NORMALS_BUILD_TIMEOUT_S = 22.0


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
    Fetch the 1991–2020 daily series for a snapped cell. Returns the ``daily``
    block, with the response's ``timezone``, ``utc_offset_seconds`` and
    ``elevation`` under ``daily["_meta"]``. Raises on HTTP error (the caller
    records the failure).
    """
    params = {
        "latitude": f"{glat}",
        "longitude": f"{glon}",
        "start_date": NORMALS_START,
        "end_date": NORMALS_END,
        "daily": DAILY_VARS,
        "timezone": "auto",
    }
    resp = _get_http().get(ARCHIVE_URL, params=params)
    resp.raise_for_status()
    data = resp.json()
    daily = data.get("daily")
    if not isinstance(daily, dict) or not daily.get("time"):
        raise ValueError("archive response has no daily block")
    daily["_meta"] = {
        "timezone": data.get("timezone"),
        "utc_offset_seconds": data.get("utc_offset_seconds"),
        "elevation": data.get("elevation"),
    }
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


def _set_cached_tables(
    key: str, glat: float, glon: float, max_table, min_table,
    monthly: Optional[list[dict]] = None, meta: Optional[dict] = None,
) -> Optional[str]:
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
# Monthly normals for the place-knowledge profile (synchronous)
# ---------------------------------------------------------------------------


def _monthly_payload(key: str, doc: dict) -> Optional[dict]:
    monthly = doc.get("monthly")
    if not monthly or len(monthly) != 12:
        return None
    return {
        "cell": key,
        "period": doc.get("period", NORMALS_PERIOD),
        "source": doc.get("source", NORMALS_SOURCE),
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
    if not allow_fetch or not open_meteo_breaker.is_allowed:
        return None
    try:
        daily = _fetch_archive(glat, glon)
    except Exception:
        open_meteo_breaker.record_failure()
        return None
    open_meteo_breaker.record_success()
    max_table, min_table = compute_normal_tables(daily)
    monthly = compute_monthly_normals(daily)
    meta = daily.get("_meta") or {}
    _set_cached_tables(key, glat, glon, max_table, min_table, monthly, meta)
    return _monthly_payload(key, {
        "monthly": monthly,
        "timeZone": meta.get("timezone"),
        "utcOffsetSeconds": meta.get("utc_offset_seconds"),
        "elevation": meta.get("elevation"),
    })
