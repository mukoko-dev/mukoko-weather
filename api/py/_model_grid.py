"""
Model forecast grid — one global model's forecast fields on an n×n grid.

``GET /api/py/model-grid?lat=&lon=&model=ecmwf_ifs`` returns temperature,
precipitation and wind for the next 72 hours (3-hourly) at every point of an
n×n grid centred on ``lat/lon``. The full-screen map paints each point as a
coloured cell and plays the steps forward, so a user can watch one model's
forecast (ECMWF IFS, AIFS, GFS, ICON, GEM or ARPEGE) evolve — the per-model
layer the blend (``_model_blend.py``) hides.

Data path: ONE batched Open-Meteo request per (cell, model) — comma-separated
coordinate lists, exactly like ``_aq_grid.py`` — through ``open_meteo_breaker``.
Results are cached 3 h in ``weather.model_grid_cache`` (``_id`` =
``{model}_{lat:.2f}_{lon:.2f}_{n}_{radius}``, centre snapped to 0.25° so nearby
pages share one fetch). Global models run every 6 h, so 3 h bounds staleness.

Licence: the model data is open (ECMWF CC BY 4.0, NOAA public domain, DWD
CC BY 4.0, ECCC open licence, Météo-France Licence Ouverte), but Open-Meteo's
free API is for non-commercial use. The map keeps this layer behind the
``model_map_layers`` feature flag until the owner picks a commercial path
(Open-Meteo plan, self-hosted Open-Meteo, or direct ingestion) — see issue #272.

Failures return HTTP 200 with ``available: false`` and are never cached.
"""

from __future__ import annotations

import asyncio
import math
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import _model_blend as blend
from . import _open_meteo as om
from ._aq_grid import build_grid, grid_cell_km
from ._circuit_breaker import open_meteo_breaker
from ._db import check_rate_limit, get_client_ip, ttl_find_one, ttl_upsert, weather_db

router = APIRouter()

#: The blend members, in the order the map lists them.
MAP_MODELS: tuple[str, ...] = (
    blend.ECMWF_IFS,
    blend.ECMWF_AIFS,
    blend.GFS,
    blend.ICON,
    blend.GEM,
    blend.ARPEGE,
)

MODEL_GRID_CACHE_TTL_SECONDS = 3 * 60 * 60

#: Hours of forecast and the step between frames (Now, +3h, … +72h).
FORECAST_HOURS = 72
STEP_HOURS = 3

#: Fixed grid: 7×7 over ±120 km → 40 km cells (coarser than the models
#: themselves, but 49 points is already 49 Open-Meteo "calls" per fetch). Not
#: caller-configurable, so the cache key space is only model × 0.25° cell.
GRID_N = 7
RADIUS_KM = 120.0

#: Upstream fetches (cache misses) per IP per hour. Hits are free.
MISS_RATE_LIMIT = 30
MISS_RATE_WINDOW_S = 3600

#: Centre snap — 0.25° (≈28 km) so neighbouring pages share one cache row.
CENTRE_SNAP_DEG = 0.25

HOURLY_VARS = "temperature_2m,precipitation,wind_speed_10m,wind_direction_10m"

#: Inside open_meteo_breaker's 8 s budget.
UPSTREAM_TIMEOUT_S = 7.5


class ModelGridPoint(BaseModel):
    lat: float
    lon: float
    temperature: list[Optional[float]] = []
    precipitation: list[Optional[float]] = []
    windSpeed: list[Optional[float]] = []
    windDirection: list[Optional[float]] = []


class ModelGridResponse(BaseModel):
    available: bool
    model: str
    cellKm: float
    times: list[str] = []
    points: list[ModelGridPoint] = []
    fetchedAt: Optional[str] = None
    reason: Optional[str] = None


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def canonical_model(model: str | None) -> Optional[str]:
    """A blend member id (legacy aliases mapped), else None."""
    m = blend.MODEL_ALIASES.get((model or "").strip(), (model or "").strip())
    return m if m in MAP_MODELS else None


def snap_centre(value: float) -> float:
    return round(round(value / CENTRE_SNAP_DEG) * CENTRE_SNAP_DEG, 2)


def valid_grid(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """
    Keep the grid inside WGS 84: latitudes clipped to ±89.9 (a grid centred
    near a pole would otherwise step past it) and longitudes wrapped into
    [-180, 180) across the antimeridian. Open-Meteo rejects anything else with
    a 400, which is our bug, not an upstream failure.
    """
    out = []
    for lat, lon in points:
        lat = max(-89.9, min(89.9, lat))
        lon = ((lon + 180.0) % 360.0) - 180.0
        out.append((round(lat, 6), round(lon, 6)))
    return out


def cache_key(model: str, lat: float, lon: float, n: int, radius_km: float) -> str:
    return f"{model}_{lat:.2f}_{lon:.2f}_{n}_{int(round(radius_km))}"


def open_meteo_params(points: list[tuple[float, float]], model: str) -> dict[str, str]:
    return {
        "latitude": ",".join(f"{p[0]:.4f}" for p in points),
        "longitude": ",".join(f"{p[1]:.4f}" for p in points),
        "hourly": HOURLY_VARS,
        "models": model,
        "forecast_hours": str(FORECAST_HOURS + 1),
        "timezone": "GMT",
        "wind_speed_unit": "kmh",
    }


def _num(value: object) -> Optional[float]:
    try:
        f = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return round(f, 1) if math.isfinite(f) else None


def _sample(series: object, length: int) -> list[Optional[float]]:
    """Every STEP_HOURS-th value of an hourly series, padded with None."""
    values = series if isinstance(series, list) else []
    out: list[Optional[float]] = []
    for i in range(0, length, STEP_HOURS):
        out.append(_num(values[i]) if i < len(values) else None)
    return out


def parse_model_grid(
    data: object, points: list[tuple[float, float]]
) -> tuple[list[str], list[dict]]:
    """
    Normalise a batched Open-Meteo response to (times, points).

    Times are the 3-hourly UTC instants (``YYYY-MM-DDTHH:00Z``) of the first
    entry. A length mismatch is a contract violation and raises so the breaker
    records it. A point whose series are all null is kept (the client leaves
    that cell blank) — Open-Meteo returns nulls where a model has no data.
    """
    entries = data if isinstance(data, list) else [data]
    if len(entries) != len(points):
        raise ValueError(f"expected {len(points)} grid entries, got {len(entries)}")

    first_hourly = (entries[0] or {}).get("hourly") if isinstance(entries[0], dict) else None
    raw_times = (first_hourly or {}).get("time") or []
    if not raw_times:
        raise ValueError("no hourly times in model grid response")
    length = min(len(raw_times), FORECAST_HOURS + 1)
    times = [f"{t}Z" for t in raw_times[0:length:STEP_HOURS]]

    out: list[dict] = []
    for (lat, lon), entry in zip(points, entries):
        hourly = (entry or {}).get("hourly") if isinstance(entry, dict) else None
        hourly = hourly or {}
        out.append(
            {
                "lat": lat,
                "lon": lon,
                "temperature": _sample(hourly.get("temperature_2m"), length),
                "precipitation": _sample(hourly.get("precipitation"), length),
                "windSpeed": _sample(hourly.get("wind_speed_10m"), length),
                "windDirection": _sample(hourly.get("wind_direction_10m"), length),
            }
        )
    return times, out


def has_any_value(points: list[dict]) -> bool:
    return any(
        v is not None
        for p in points
        for key in ("temperature", "precipitation", "windSpeed")
        for v in p.get(key, [])
    )


# ---------------------------------------------------------------------------
# Upstream + cache
# ---------------------------------------------------------------------------

_http_client: Optional[httpx.Client] = None


def _get_http() -> httpx.Client:
    global _http_client
    if _http_client is None:
        _http_client = httpx.Client(timeout=UPSTREAM_TIMEOUT_S)
    return _http_client


class UpstreamError(Exception):
    """Open-Meteo itself failed (5xx, 429, transport, bad body) — counts against the breaker."""


class RequestRejected(Exception):
    """Open-Meteo rejected our request (4xx other than 429) — our bug, not an outage."""


def _fetch(points: list[tuple[float, float]], model: str) -> tuple[list[str], list[dict]]:
    try:
        url, headers = om.forecast()
        resp = _get_http().get(url, params=open_meteo_params(points, model), headers=headers)
    except httpx.HTTPError as exc:
        raise UpstreamError(type(exc).__name__) from exc
    if resp.status_code == 429 or resp.status_code >= 500:
        raise UpstreamError(f"HTTP {resp.status_code}")
    if resp.status_code != 200:
        raise RequestRejected(f"HTTP {resp.status_code}")
    try:
        return parse_model_grid(resp.json(), points)
    except ValueError as exc:
        raise UpstreamError(str(exc)) from exc


def _collection():
    return weather_db()["model_grid_cache"]


def _get_cached(key: str) -> Optional[dict]:
    try:
        return ttl_find_one(_collection(), {"_id": key})
    except Exception:
        return None


def _set_cached(key: str, payload: dict) -> None:
    try:
        ttl_upsert(
            _collection(),
            {"_id": key},
            {"_id": key, **payload},
            MODEL_GRID_CACHE_TTL_SECONDS,
            stamp=True,
        )
    except Exception:
        pass


def _iso(value: object) -> Optional[str]:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    return None


def _unavailable(model: str, cell_km: float, reason: str) -> JSONResponse:
    body = ModelGridResponse(
        available=False, model=model, cellKm=round(cell_km, 3), reason=reason
    )
    return JSONResponse(content=body.model_dump(), headers={"X-Cache": "MISS"})


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


@router.get("/api/py/model-grid", response_model=ModelGridResponse)
async def get_model_grid(
    request: Request,
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    model: str = Query(blend.ECMWF_IFS),
):
    """
    GET /api/py/model-grid?lat=&lon=&model=ecmwf_ifs

    One model's 3-hourly temperature (°C), precipitation (mm/h) and 10 m wind
    (km/h, degrees) for 72 h on a fixed 7×7 grid over ±120 km. ``model`` must
    be a blend member (``ecmwf_ifs``, ``ecmwf_aifs025_single``,
    ``gfs_seamless``, ``icon_global``, ``gem_global``,
    ``meteofrance_arpege_world``); anything else gets ``available: false,
    reason: "unknown_model"``. Cache misses are rate-limited per IP
    (``rate_limited``); only an Open-Meteo outage counts against
    ``open_meteo_breaker`` — a rejected request (4xx) does not, since that
    breaker also gates the forecast baseline.
    """
    cell_km = grid_cell_km(RADIUS_KM, GRID_N)

    canon = canonical_model(model)
    if canon is None:
        return _unavailable((model or "")[:40], cell_km, "unknown_model")

    lat_c = snap_centre(lat)
    lon_c = snap_centre(lon)
    key = cache_key(canon, lat_c, lon_c, GRID_N, RADIUS_KM)

    cached = _get_cached(key)
    if cached:
        body = ModelGridResponse(
            available=True,
            model=canon,
            cellKm=cached["cellKm"],
            times=cached["times"],
            points=cached["points"],
            fetchedAt=_iso(cached.get("fetchedAt")),
        )
        return JSONResponse(content=body.model_dump(), headers={"X-Cache": "HIT"})

    if not open_meteo_breaker.is_allowed:
        return _unavailable(canon, cell_km, "circuit_open")

    client_ip = get_client_ip(request) or "unknown"
    if not check_rate_limit(client_ip, "model-grid", MISS_RATE_LIMIT, MISS_RATE_WINDOW_S).get(
        "allowed", True
    ):
        return _unavailable(canon, cell_km, "rate_limited")

    coords = valid_grid(build_grid(lat_c, lon_c, RADIUS_KM, GRID_N, clamp=False))
    try:
        times, points = await asyncio.wait_for(
            asyncio.to_thread(_fetch, coords, canon),
            timeout=open_meteo_breaker.config.timeout_s,
        )
    except RequestRejected:
        return _unavailable(canon, cell_km, "upstream_error")
    except (UpstreamError, asyncio.TimeoutError, TimeoutError):
        open_meteo_breaker.record_failure()
        return _unavailable(canon, cell_km, "upstream_error")
    except Exception:
        return _unavailable(canon, cell_km, "upstream_error")
    open_meteo_breaker.record_success()

    if not has_any_value(points):
        # The model has no data here (all nulls) — not an upstream failure.
        return _unavailable(canon, cell_km, "no_data")

    payload = {"model": canon, "cellKm": round(cell_km, 3), "times": times, "points": points}
    _set_cached(key, payload)

    body = ModelGridResponse(
        available=True,
        model=canon,
        cellKm=payload["cellKm"],
        times=times,
        points=points,
        fetchedAt=datetime.now(timezone.utc).isoformat(),
    )
    return JSONResponse(content=body.model_dump(), headers={"X-Cache": "MISS"})
