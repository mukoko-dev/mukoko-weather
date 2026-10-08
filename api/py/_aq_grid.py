"""
Air quality grid endpoint — US AQI on a regular n×n grid around a point.

``GET /api/py/airquality/grid?lat=&lon=&radiusKm=40&n=7`` returns the current
US AQI (and PM2.5) for an n×n grid of points centred on ``lat/lon`` and
spanning ±``radiusKm``. It powers the Apple-Weather-style "AIR QUALITY MAP"
card: the client paints each grid point as a coloured cell over a map.

All n² points are fetched in ONE Open-Meteo Air Quality request — the API
accepts comma-separated ``latitude`` / ``longitude`` lists and returns a JSON
array in the same order. Results are cached 30 min in
``weather.air_quality_grid_cache`` keyed by a deterministic ``_id``
(``{lat:.2f}_{lon:.2f}_{n}_{radius}``). Only successful fetches are cached, so
an outage never pins an empty grid for 30 minutes.

External calls go through ``open_meteo_breaker``. Any upstream failure or open
circuit returns HTTP 200 with ``available: false`` — the card simply renders
nothing, rather than surfacing a 5xx to the page.
"""

from __future__ import annotations

import asyncio
import math
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ._db import stamp_platform_fields, weather_db
from ._circuit_breaker import open_meteo_breaker, CircuitOpenError

router = APIRouter()


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

OPEN_METEO_AQ_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"

#: Cache TTL — 30 min. Grid readings move slowly; the request fans out to n²
#: points, so caching is the main protection for the upstream quota.
AQ_GRID_CACHE_TTL_SECONDS = 30 * 60

#: Grid bounds. n is capped to 5..9 and forced odd so there is a true centre.
GRID_N_MIN = 5
GRID_N_MAX = 9
GRID_N_DEFAULT = 7

#: Radius bounds in km (the grid spans ±radius around the centre).
RADIUS_KM_MIN = 5.0
RADIUS_KM_MAX = 100.0
RADIUS_KM_DEFAULT = 40.0

#: Schema version stamped onto cached docs.
AQ_GRID_SCHEMA_VERSION = "v3.1"

SOURCE_LABEL = "Open-Meteo Air Quality (CAMS)"

#: Spherical Earth (R = 6371 km): one degree of arc. Shared with the TS geometry
#: in src/lib/aq-grid.ts so a grid cell's metric side is identical on both ends.
_KM_PER_DEG = 111.195


# ---------------------------------------------------------------------------
# Response models (OpenAPI contract)
# ---------------------------------------------------------------------------


class AqGridCenter(BaseModel):
    lat: float
    lon: float
    aqi: Optional[int] = None


class AqGridPoint(BaseModel):
    lat: float
    lon: float
    aqi: Optional[int] = None
    pm2_5: Optional[float] = None


class AirQualityGridResponse(BaseModel):
    available: bool
    center: Optional[AqGridCenter] = None
    cellKm: float
    points: list[AqGridPoint] = []
    fetchedAt: Optional[str] = None
    source: str = SOURCE_LABEL


# ---------------------------------------------------------------------------
# Grid maths (pure)
# ---------------------------------------------------------------------------


def normalise_n(n: int) -> int:
    """Clamp n to 5..9 and bump an even value up to the next odd (true centre)."""
    n = min(max(int(n), GRID_N_MIN), GRID_N_MAX)
    if n % 2 == 0:
        n += 1
    return n


def clamp_radius(radius_km: float) -> float:
    return min(max(float(radius_km), RADIUS_KM_MIN), RADIUS_KM_MAX)


def grid_cell_km(radius_km: float, n: int) -> float:
    """Spacing between adjacent grid points — also the side of each map cell."""
    return (2.0 * radius_km) / (n - 1)


def build_grid(lat: float, lon: float, radius_km: float, n: int) -> list[tuple[float, float]]:
    """
    Return the n×n (lat, lon) grid, row-major from north-west to south-east.

    Offsets run linearly from -radius to +radius on both axes, so the centre
    point is exactly (lat, lon) and the outer points sit ``radius_km`` away
    (north/south via latitude, east/west via longitude corrected for the
    cosine of latitude so the spacing is metric in both directions).
    """
    n = normalise_n(n)
    radius_km = clamp_radius(radius_km)
    lat_rad = math.radians(max(-89.0, min(89.0, lat)))
    km_per_deg_lon = _KM_PER_DEG * math.cos(lat_rad)
    half = (n - 1) / 2.0
    step_km = radius_km / half if half else 0.0

    points: list[tuple[float, float]] = []
    for row in range(n):
        north_south_km = (half - row) * step_km  # + = north
        p_lat = lat + north_south_km / _KM_PER_DEG
        for col in range(n):
            east_west_km = (col - half) * step_km  # + = east
            p_lon = lon + east_west_km / km_per_deg_lon
            points.append((round(p_lat, 6), round(p_lon, 6)))
    return points


def _open_meteo_params(points: list[tuple[float, float]]) -> dict[str, str]:
    """One batched request: comma-separated latitude/longitude lists."""
    return {
        "latitude": ",".join(f"{p[0]:.4f}" for p in points),
        "longitude": ",".join(f"{p[1]:.4f}" for p in points),
        "current": "us_aqi,pm2_5",
    }


def _parse_current(entry: dict) -> tuple[Optional[int], Optional[float]]:
    current = entry.get("current") or {}
    aqi_raw = current.get("us_aqi")
    pm_raw = current.get("pm2_5")
    try:
        aqi = int(round(float(aqi_raw))) if aqi_raw is not None else None
    except (TypeError, ValueError):
        aqi = None
    try:
        pm = float(pm_raw) if pm_raw is not None else None
    except (TypeError, ValueError):
        pm = None
    return aqi, pm


def parse_grid_response(
    data: object, points: list[tuple[float, float]]
) -> list[tuple[Optional[int], Optional[float]]]:
    """
    Normalise Open-Meteo's batched response to one (aqi, pm2_5) per point.

    A single-coordinate request returns an object, a batch returns a list —
    both are accepted. Any length mismatch is an upstream contract violation
    and raises, so the breaker records a failure.
    """
    entries = data if isinstance(data, list) else [data]
    if len(entries) != len(points):
        raise ValueError(
            f"expected {len(points)} grid entries, got {len(entries)}"
        )
    return [_parse_current(e if isinstance(e, dict) else {}) for e in entries]


# ---------------------------------------------------------------------------
# Upstream fetch
# ---------------------------------------------------------------------------

_http_client: Optional[httpx.Client] = None


def _get_http() -> httpx.Client:
    global _http_client
    if _http_client is None:
        _http_client = httpx.Client(timeout=10.0)
    return _http_client


def _fetch_grid(points: list[tuple[float, float]]) -> list[tuple[Optional[int], Optional[float]]]:
    """Blocking single batched call. Raises on HTTP / contract errors."""
    resp = _get_http().get(OPEN_METEO_AQ_URL, params=_open_meteo_params(points))
    resp.raise_for_status()
    return parse_grid_response(resp.json(), points)


async def _run_sync(fn):
    """Run the blocking httpx call off the event loop so the breaker can time it out."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, fn)


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------


def _cache_collection():
    return weather_db()["air_quality_grid_cache"]


def _cache_key(lat: float, lon: float, n: int, radius_km: float) -> str:
    return f"{lat:.2f}_{lon:.2f}_{n}_{int(round(radius_km))}"


def _iso(value: object) -> Optional[str]:
    """Mongo returns naive datetimes for UTC values — re-attach the zone."""
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    return None


def _get_cached(key: str) -> Optional[dict]:
    try:
        return _cache_collection().find_one(
            {"_id": key, "expiresAt": {"$gt": datetime.now(timezone.utc)}}
        )
    except Exception:
        # Cache is an optimisation — a read failure must never fail the request.
        return None


def _set_cached(key: str, payload: dict, country_code: str = "ZW") -> None:
    now = datetime.now(timezone.utc)
    doc = {
        "_id": key,
        **payload,
        "fetchedAt": now,
        "expiresAt": now + timedelta(seconds=AQ_GRID_CACHE_TTL_SECONDS),
    }
    stamp_platform_fields(doc, country_code=country_code)
    try:
        _cache_collection().update_one({"_id": key}, {"$set": doc}, upsert=True)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


def _unavailable(cell_km: float) -> JSONResponse:
    body = AirQualityGridResponse(available=False, cellKm=round(cell_km, 3))
    return JSONResponse(content=body.model_dump(), headers={"X-Cache": "MISS"})


@router.get("/api/py/airquality/grid", response_model=AirQualityGridResponse)
async def get_air_quality_grid(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    radiusKm: float = Query(RADIUS_KM_DEFAULT),
    n: int = Query(GRID_N_DEFAULT),
):
    """
    GET /api/py/airquality/grid?lat=&lon=&radiusKm=40&n=7

    Current US AQI for an n×n grid centred on (lat, lon). Inputs are rounded
    (coordinates to 2 dp, matching the cache key), n is clamped to 5..9 and
    made odd, and radiusKm is clamped to 5..100 km.
    """
    lat_r = round(lat, 2)
    lon_r = round(lon, 2)
    n_c = normalise_n(n)
    radius = clamp_radius(radiusKm)
    cell_km = grid_cell_km(radius, n_c)

    key = _cache_key(lat_r, lon_r, n_c, radius)
    cached = _get_cached(key)
    if cached:
        body = AirQualityGridResponse(
            available=True,
            center=cached["center"],
            cellKm=cached["cellKm"],
            points=cached["points"],
            fetchedAt=_iso(cached.get("fetchedAt")),
            source=SOURCE_LABEL,
        )
        return JSONResponse(content=body.model_dump(), headers={"X-Cache": "HIT"})

    if not open_meteo_breaker.is_allowed:
        return _unavailable(cell_km)

    coords = build_grid(lat_r, lon_r, radius, n_c)
    try:
        readings = await open_meteo_breaker.execute(
            lambda: _run_sync(lambda: _fetch_grid(coords))
        )
    except CircuitOpenError:
        return _unavailable(cell_km)
    except Exception:
        # Upstream timeout, HTTP error or contract mismatch — degrade, don't 5xx.
        return _unavailable(cell_km)

    points = [
        {"lat": p[0], "lon": p[1], "aqi": r[0], "pm2_5": r[1]}
        for p, r in zip(coords, readings)
    ]
    centre_index = (n_c * n_c) // 2  # row-major middle of an odd grid
    centre_aqi = points[centre_index]["aqi"]
    now = datetime.now(timezone.utc)
    payload = {
        "available": True,
        "center": {"lat": lat_r, "lon": lon_r, "aqi": centre_aqi},
        "cellKm": round(cell_km, 3),
        "points": points,
        "source": SOURCE_LABEL,
    }
    _set_cached(key, payload)

    body = AirQualityGridResponse(
        available=True,
        center=payload["center"],
        cellKm=payload["cellKm"],
        points=points,
        fetchedAt=now.isoformat(),
        source=SOURCE_LABEL,
    )
    return JSONResponse(content=body.model_dump(), headers={"X-Cache": "MISS"})
