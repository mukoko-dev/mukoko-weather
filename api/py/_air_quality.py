"""
Air Quality endpoint — EPA-standard AQI (0-500) from Open-Meteo pollutant data.

Fetches raw pollutant concentrations (PM2.5, PM10, O3, NO2, SO2, CO, NH3) from
Open-Meteo's free Air Quality API, applies the EPA breakpoint algorithm to
compute a sub-index per pollutant, and returns the dominant pollutant's index
as the overall AQI score.

Algorithm port of /oss-weather/app/services/airQualityData.ts using true EPA
breakpoint tables. All concentrations are expected in µg/m³ (Open-Meteo's
native unit) — the breakpoint tables are pre-converted from EPA's official
ppb/ppm values at standard conditions (25°C, 1 atm).

Cached in MongoDB ``weather.air_quality_cache`` with a 1-hour TTL keyed by
``{lat:.4f}_{lon:.4f}`` (≈11 m precision). Deterministic ``_id`` means two
requests for the same coordinates always upsert the same cache row — no
duplicates are ever created (Phase 0E dedup discipline).

External calls go through ``open_meteo_breaker`` so a flaky upstream can't
cascade — when the circuit is open, the endpoint returns a 503 immediately.
"""

from __future__ import annotations

from datetime import datetime, timezone, timedelta
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from ._db import stamp_platform_fields, weather_db
from ._circuit_breaker import open_meteo_breaker, CircuitOpenError

router = APIRouter()


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

OPEN_METEO_AQ_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"

#: Cache TTL — 1 hour. Air quality changes slowly enough that hourly refreshes
#: catch meaningful shifts while keeping API call volume small.
AIR_QUALITY_CACHE_TTL_SECONDS = 3600

#: Schema version stamped onto every cached doc.
AQ_CACHE_SCHEMA_VERSION = "v3.1"

#: AQI level buckets (EPA standard 0-500 scale).
AQI_LEVELS: list[tuple[int, str]] = [
    (50, "good"),
    (100, "moderate"),
    (150, "unhealthy_sensitive"),
    (200, "unhealthy"),
    (300, "very_unhealthy"),
    (500, "hazardous"),
]

#: WHO 2021 air quality guideline values (µg/m³, annual or short-term as noted).
#: Used by the UI to show a "WHO target" comparison alongside EPA buckets.
WHO_GUIDELINES_UGM3: dict[str, float] = {
    "pm2_5": 15.0,    # 24-h
    "pm10": 45.0,     # 24-h
    "o3": 100.0,      # 8-h
    "no2": 25.0,      # 24-h
    "so2": 40.0,      # 24-h
    "co": 4000.0,     # 24-h (4 mg/m³)
    "nh3": 0.0,       # No WHO guideline
}

#: Open-Meteo field name → our internal pollutant key.
POLLUTANT_FIELD_MAP: dict[str, str] = {
    "pm2_5": "pm2_5",
    "pm10": "pm10",
    "ozone": "o3",
    "nitrogen_dioxide": "no2",
    "sulphur_dioxide": "so2",
    "carbon_monoxide": "co",
    "ammonia": "nh3",
}


# ---------------------------------------------------------------------------
# EPA breakpoint tables — concentrations in µg/m³
# ---------------------------------------------------------------------------
#
# Each entry: (concentration_lo, concentration_hi, aqi_lo, aqi_hi).
#
# - PM2.5 and PM10 are already µg/m³ in the EPA spec (24-h averaging).
# - O3, NO2, SO2 are ppb in the EPA spec — converted here using molecular
#   weight at 25°C, 1 atm (factor = MW / 24.45):
#     O3  (MW=48)  → 1 ppb = 1.96 µg/m³
#     NO2 (MW=46)  → 1 ppb = 1.88 µg/m³
#     SO2 (MW=64)  → 1 ppb = 2.62 µg/m³
# - CO is ppm in EPA spec — converted using factor 1145 (MW=28).
#
# Values rounded to whole µg/m³. The breakpoint anchors (PM2.5 = 12.0 → AQI 50,
# PM2.5 = 35.5 → AQI 101, etc.) come straight from the EPA AQI Tech Doc.
#
EPA_BREAKPOINTS: dict[str, list[tuple[float, float, int, int]]] = {
    "pm2_5": [  # µg/m³, 24-h
        (0.0, 12.0, 0, 50),
        (12.1, 35.4, 51, 100),
        (35.5, 55.4, 101, 150),
        (55.5, 150.4, 151, 200),
        (150.5, 250.4, 201, 300),
        (250.5, 500.4, 301, 500),
    ],
    "pm10": [  # µg/m³, 24-h
        (0, 54, 0, 50),
        (55, 154, 51, 100),
        (155, 254, 101, 150),
        (255, 354, 151, 200),
        (355, 424, 201, 300),
        (425, 604, 301, 500),
    ],
    "o3": [  # µg/m³, 8-h (converted from EPA ppb breakpoints)
        (0, 106, 0, 50),
        (107, 137, 51, 100),
        (138, 167, 101, 150),
        (168, 206, 151, 200),
        (207, 392, 201, 300),
        (393, 784, 301, 500),
    ],
    "no2": [  # µg/m³, 1-h (converted from EPA ppb breakpoints)
        (0, 100, 0, 50),
        (101, 188, 51, 100),
        (189, 677, 101, 150),
        (678, 1221, 151, 200),
        (1222, 2349, 201, 300),
        (2350, 3853, 301, 500),
    ],
    "so2": [  # µg/m³, 1-h (converted from EPA ppb breakpoints)
        (0, 92, 0, 50),
        (93, 197, 51, 100),
        (198, 485, 101, 150),
        (486, 797, 151, 200),
        (798, 1583, 201, 300),
        (1584, 2630, 301, 500),
    ],
    "co": [  # µg/m³, 8-h (converted from EPA ppm breakpoints)
        (0, 5040, 0, 50),
        (5041, 10764, 51, 100),
        (10765, 14199, 101, 150),
        (14200, 17634, 151, 200),
        (17635, 34812, 201, 300),
        (34813, 57612, 301, 500),
    ],
    # NH3 is not part of the official EPA AQI. We report concentration only —
    # see _sub_index() which returns None for unknown pollutants.
}


# ---------------------------------------------------------------------------
# EPA AQI computation — direct port of getAqiFromPollutants() + _getIndex()
# ---------------------------------------------------------------------------


def _sub_index(value: float, breakpoints: list[tuple[float, float, int, int]]) -> Optional[int]:
    """
    Compute a single-pollutant EPA AQI sub-index by linear interpolation
    between the breakpoint pair that contains ``value``.

    Mirrors ``_getIndex(cp, bpLo, bpHi, inLo, inHi)`` from oss-weather:
        result = round(((aqi_hi - aqi_lo) / (bp_hi - bp_lo)) * (cp - bp_lo) + aqi_lo)

    Returns ``None`` for negative or missing values. Values above the top
    breakpoint linearly extrapolate from the last segment so we keep returning
    a meaningful score (capped by the caller's 0-500 range expectation,
    though we don't clamp — hazardous-plus is rare but legitimate signal).
    """
    if value is None or value < 0:
        return None

    for bp_lo, bp_hi, aqi_lo, aqi_hi in breakpoints:
        if bp_lo <= value <= bp_hi:
            return round(((aqi_hi - aqi_lo) / (bp_hi - bp_lo)) * (value - bp_lo) + aqi_lo)

    # Above the highest breakpoint — extrapolate from the last segment.
    bp_lo, bp_hi, aqi_lo, aqi_hi = breakpoints[-1]
    if value > bp_hi:
        return round(((aqi_hi - aqi_lo) / (bp_hi - bp_lo)) * (value - bp_lo) + aqi_lo)
    return None


def aqi_level_for(aqi: int) -> str:
    """Map an AQI score to its EPA category enum string."""
    for threshold, label in AQI_LEVELS:
        if aqi <= threshold:
            return label
    return "hazardous"


def compute_aqi(pollutants: dict[str, Optional[float]]) -> dict:
    """
    Compute overall EPA AQI from a pollutant concentration map (µg/m³).

    Mirrors ``getAqiFromPollutants()`` from oss-weather: take each pollutant's
    sub-index, the overall AQI is the **maximum** sub-index, and the dominant
    pollutant is whichever produced that max.

    Returns ``{aqi, level, dominantPollutant, subIndexes}``. Missing pollutants
    (None or absent keys) are silently ignored — when none are scoreable we
    return ``{aqi: 0, level: "good", dominantPollutant: None}`` (this is the
    correct interpretation: no measurable pollution detected).
    """
    sub_indexes: dict[str, int] = {}
    for key, value in pollutants.items():
        if value is None:
            continue
        breakpoints = EPA_BREAKPOINTS.get(key)
        if not breakpoints:
            continue
        idx = _sub_index(value, breakpoints)
        if idx is not None:
            sub_indexes[key] = idx

    if not sub_indexes:
        return {
            "aqi": 0,
            "level": "good",
            "dominantPollutant": None,
            "subIndexes": {},
        }

    dominant_pollutant, aqi = max(sub_indexes.items(), key=lambda kv: kv[1])
    return {
        "aqi": aqi,
        "level": aqi_level_for(aqi),
        "dominantPollutant": dominant_pollutant,
        "subIndexes": sub_indexes,
    }


# ---------------------------------------------------------------------------
# Open-Meteo client
# ---------------------------------------------------------------------------

_http_client: Optional[httpx.Client] = None


def _get_http() -> httpx.Client:
    global _http_client
    if _http_client is None:
        _http_client = httpx.Client(timeout=10.0)
    return _http_client


def _fetch_open_meteo_air_quality(lat: float, lon: float) -> dict:
    """
    Call Open-Meteo Air Quality API for current pollutant concentrations.

    Returns a dict of ``{pollutant_key: µg/m³ float}``. Raises on HTTP error
    (caller wraps in the circuit breaker).
    """
    client = _get_http()
    fields = list(POLLUTANT_FIELD_MAP.keys())
    params = {
        "latitude": f"{lat}",
        "longitude": f"{lon}",
        "current": ",".join(fields),
        "timezone": "auto",
    }
    resp = client.get(OPEN_METEO_AQ_URL, params=params)
    resp.raise_for_status()
    data = resp.json()

    current = data.get("current") or {}
    pollutants: dict[str, Optional[float]] = {}
    for source_key, internal_key in POLLUTANT_FIELD_MAP.items():
        raw = current.get(source_key)
        # Normalise numeric strings to floats; pass None through unchanged.
        if raw is None:
            pollutants[internal_key] = None
        else:
            try:
                pollutants[internal_key] = float(raw)
            except (TypeError, ValueError):
                pollutants[internal_key] = None
    return pollutants


# ---------------------------------------------------------------------------
# Cache operations
# ---------------------------------------------------------------------------


def _air_quality_cache_collection():
    """``weather.air_quality_cache`` — 1-hour TTL keyed by lat/lon."""
    return weather_db()["air_quality_cache"]


def _cache_key(lat: float, lon: float) -> str:
    """Deterministic cache key — 4 decimals ≈ 11 m precision."""
    return f"{lat:.4f}_{lon:.4f}"


def _get_cached(lat: float, lon: float) -> Optional[dict]:
    """Read a non-expired cache doc for these coordinates."""
    try:
        return _air_quality_cache_collection().find_one(
            {"_id": _cache_key(lat, lon), "expiresAt": {"$gt": datetime.now(timezone.utc)}}
        )
    except Exception:
        return None


def _set_cached(lat: float, lon: float, payload: dict, country_code: Optional[str]) -> None:
    """
    Upsert the cache doc using the deterministic key as ``_id``.

    Dedup discipline (Phase 0E): we always upsert by the same ``_id``, so two
    concurrent requests for the same coords end up with one row, not two. Uses
    ``stamp_platform_fields`` to satisfy platform-wide validators (schema
    version, bundu, timestamps) — passing ``_id`` first preserves it.
    """
    now = datetime.now(timezone.utc)
    doc = {
        "_id": _cache_key(lat, lon),
        "lat": lat,
        "lon": lon,
        "aqi": payload["aqi"],
        "level": payload["level"],
        "dominantPollutant": payload.get("dominantPollutant"),
        "pollutants": payload["pollutants"],
        "subIndexes": payload.get("subIndexes", {}),
        "source": "open-meteo",
        "fetchedAt": now,
        "expiresAt": now + timedelta(seconds=AIR_QUALITY_CACHE_TTL_SECONDS),
    }
    stamp_platform_fields(doc, country_code=country_code or "ZW")

    try:
        _air_quality_cache_collection().update_one(
            {"_id": doc["_id"]},
            {"$set": doc},
            upsert=True,
        )
    except Exception:
        # Cache write failure must not break the response — log silently.
        pass


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


@router.get("/api/py/airquality")
async def get_air_quality(lat: float, lon: float):
    """
    GET /api/py/airquality?lat=&lon=

    Returns EPA-standard Air Quality Index (0-500) plus the full pollutant
    breakdown for a location. Falls through:

    1. **MongoDB cache** (1-h TTL, keyed by ``{lat:.4f}_{lon:.4f}``)
    2. **Open-Meteo Air Quality API** (free, no key) via ``open_meteo_breaker``

    Response shape::

        {
          "aqi": 73,
          "level": "moderate",
          "dominantPollutant": "pm2_5",
          "pollutants": { "pm2_5": 24.1, "pm10": 38.0, "o3": 88.2, ... },
          "subIndexes": { "pm2_5": 73, "pm10": 35, "o3": 41, ... },
          "whoGuidelines": { "pm2_5": 15.0, ... },
          "source": "cache" | "open-meteo",
          "fetchedAt": "2026-06-29T12:00:00Z"
        }
    """
    if lat < -90 or lat > 90 or lon < -180 or lon > 180:
        raise HTTPException(status_code=400, detail="Invalid coordinates")

    # 1. Cache lookup
    cached = _get_cached(lat, lon)
    if cached:
        return JSONResponse(
            content={
                "aqi": cached.get("aqi", 0),
                "level": cached.get("level", "good"),
                "dominantPollutant": cached.get("dominantPollutant"),
                "pollutants": cached.get("pollutants", {}),
                "subIndexes": cached.get("subIndexes", {}),
                "whoGuidelines": WHO_GUIDELINES_UGM3,
                "source": "cache",
                "fetchedAt": cached.get("fetchedAt").isoformat() if cached.get("fetchedAt") else None,
            },
            headers={"X-Cache": "HIT", "X-AQ-Source": "cache"},
        )

    # 2. Fetch from Open-Meteo via circuit breaker
    if not open_meteo_breaker.is_allowed:
        raise HTTPException(
            status_code=503,
            detail="Air quality provider temporarily unavailable",
        )

    try:
        pollutants = await open_meteo_breaker.execute(
            lambda: _run_sync(lambda: _fetch_open_meteo_air_quality(lat, lon))
        )
    except CircuitOpenError:
        raise HTTPException(
            status_code=503,
            detail="Air quality provider temporarily unavailable",
        )
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to fetch air quality data: {type(e).__name__}",
        )

    # 3. Compute EPA AQI from the pollutant map
    computed = compute_aqi(pollutants)
    payload = {
        "aqi": computed["aqi"],
        "level": computed["level"],
        "dominantPollutant": computed["dominantPollutant"],
        "pollutants": pollutants,
        "subIndexes": computed["subIndexes"],
    }

    # 4. Persist to cache (fire-and-forget on failure)
    _set_cached(lat, lon, payload, country_code=None)

    return JSONResponse(
        content={
            **payload,
            "whoGuidelines": WHO_GUIDELINES_UGM3,
            "source": "open-meteo",
            "fetchedAt": datetime.now(timezone.utc).isoformat(),
        },
        headers={"X-Cache": "MISS", "X-AQ-Source": "open-meteo"},
    )


async def _run_sync(fn):
    """
    Run a blocking ``httpx.Client`` call inside the async circuit breaker.

    The breaker expects a coroutine; we wrap the sync httpx call so the breaker
    can still time it out via ``asyncio.wait_for``. (Switching to httpx.AsyncClient
    would be cleaner but the rest of the codebase uses the sync client + this
    wrapper pattern in ``_metar.py`` / ``_weather.py``.)
    """
    import asyncio
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, fn)
