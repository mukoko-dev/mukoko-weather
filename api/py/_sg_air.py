"""
Singapore official air quality — NEA readings via data.gov.sg.

The National Environment Agency (NEA) publishes the official Pollutant
Standards Index (PSI) and 1-hour PM2.5 readings for five regions (north, south,
east, west, central) through the data.gov.sg real-time API. No key is needed.

Why this exists alongside the modelled US AQI on ``/api/py/airquality``: during
haze events the model and the official monitors can disagree, and Singapore
residents read the NEA number. The display shows both.

Upstream payload shape (verified against the live API)::

    data.regionMetadata[].{name, labelLocation.{latitude, longitude}}
    data.items[0].timestamp
    data.items[0].readings.psi_twenty_four_hourly.{region: int}
    data.items[0].readings.pm25_one_hourly.{region: int}

The payload carries no ``national`` key. The endpoint uses a reported national
value when one is present and otherwise the highest regional value, and it
records which one it used in ``psiBasis`` / ``pm25Basis`` so the UI never
presents a derived figure as an official national reading.

Upstream calls go through ``nea_breaker``. Successful upstream responses are
cached in memory for 10 minutes. Any failure returns HTTP 200 with
``available: false`` so the display can keep its layout and say so, rather than
erroring.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from datetime import datetime, timezone
from typing import Any, Literal, Optional

import httpx
from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from ._circuit_breaker import CircuitOpenError, nea_breaker

logger = logging.getLogger("mukoko.sg_air")

router = APIRouter()

PSI_URL = "https://api-open.data.gov.sg/v2/real-time/api/psi"
PM25_URL = "https://api-open.data.gov.sg/v2/real-time/api/pm25"
SOURCE_ATTRIBUTION = "NEA via data.gov.sg"

#: In-memory cache for the upstream payloads (not the parsed response, which
#: depends on the requested coordinates).
CACHE_TTL_SECONDS = 600
REQUEST_TIMEOUT_SECONDS = 5.0

REGION_NAMES = ("north", "south", "east", "west", "central")

#: PSI bands, upper bound inclusive. Above the last bound is hazardous.
PSI_BANDS: list[tuple[int, str, str]] = [
    (50, "good", "Good"),
    (100, "moderate", "Moderate"),
    (200, "unhealthy", "Unhealthy"),
    (300, "very_unhealthy", "Very unhealthy"),
]
PSI_HAZARDOUS = ("hazardous", "Hazardous")

Basis = Literal["national", "highest_region"]


# ---------------------------------------------------------------------------
# Pydantic models (the OpenAPI contract)
# ---------------------------------------------------------------------------


class SgRegionReading(BaseModel):
    """One NEA region's readings. Values are None when NEA omits the region."""

    region: str = Field(description="north | south | east | west | central")
    psi24h: Optional[int] = Field(None, description="24-hour PSI (unitless index)")
    band: Optional[str] = Field(None, description="PSI band key")
    pm25OneHour: Optional[int] = Field(None, description="1-hour PM2.5, µg/m³")
    labelLatitude: Optional[float] = Field(None, description="WGS 84")
    labelLongitude: Optional[float] = Field(None, description="WGS 84")


class SgAirResponse(BaseModel):
    """Official NEA air quality for Singapore."""

    available: bool = Field(description="False when NEA could not be read")
    source: str = Field(default=SOURCE_ATTRIBUTION)
    observedAt: Optional[str] = Field(None, description="ISO 8601 observation time")
    fetchedAt: Optional[str] = Field(None, description="ISO 8601, when this server read NEA")
    psi24h: Optional[int] = Field(None, description="National (or highest-region) 24-hour PSI")
    psiBasis: Optional[Basis] = None
    band: Optional[str] = Field(None, description="PSI band key for psi24h")
    bandLabel: Optional[str] = Field(None, description="Human label for band")
    pm25OneHour: Optional[int] = Field(None, description="National (or highest-region) 1-hour PM2.5, µg/m³")
    pm25Basis: Optional[Basis] = None
    regions: list[SgRegionReading] = Field(default_factory=list)
    nearestRegion: Optional[str] = Field(
        None, description="Region whose label point is closest to the lat/lon query"
    )


def _unavailable(fetched_at: Optional[str] = None) -> SgAirResponse:
    return SgAirResponse(available=False, fetchedAt=fetched_at)


# ---------------------------------------------------------------------------
# Pure logic (unit-tested without the network)
# ---------------------------------------------------------------------------


def psi_band(value: float) -> tuple[str, str]:
    """Map a 24-hour PSI to (band key, label). Upper bounds are inclusive."""
    if not math.isfinite(value):
        raise ValueError("PSI must be finite")
    for upper, key, label in PSI_BANDS:
        if value <= upper:
            return key, label
    return PSI_HAZARDOUS


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def nearest_region(regions: list[SgRegionReading], lat: float, lon: float) -> Optional[str]:
    """Closest region by distance to its NEA label point, or None if no points."""
    candidates = [
        r for r in regions
        if r.labelLatitude is not None and r.labelLongitude is not None
    ]
    if not candidates:
        return None
    best = min(
        candidates,
        key=lambda r: haversine_km(lat, lon, r.labelLatitude, r.labelLongitude),
    )
    return best.region


def _first_item(payload: dict[str, Any]) -> dict[str, Any]:
    if payload.get("code", 0) != 0:
        raise ValueError(f"NEA error code {payload.get('code')}")
    items = payload["data"]["items"]
    if not items:
        raise ValueError("NEA returned no items")
    return items[0]


def _clean_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    number = float(value)
    if not math.isfinite(number):
        return None
    return int(round(number))


def _region_values(readings: dict[str, Any]) -> dict[str, int]:
    out: dict[str, int] = {}
    for name in REGION_NAMES:
        v = _clean_int(readings.get(name))
        if v is not None:
            out[name] = v
    return out


def _headline(readings: dict[str, Any], regional: dict[str, int]) -> tuple[Optional[int], Optional[Basis]]:
    """National value if NEA reports one, else the highest regional value."""
    national = _clean_int(readings.get("national"))
    if national is not None:
        return national, "national"
    if regional:
        return max(regional.values()), "highest_region"
    return None, None


def _label_points(psi_payload: dict[str, Any]) -> dict[str, tuple[float, float]]:
    points: dict[str, tuple[float, float]] = {}
    for meta in psi_payload["data"].get("regionMetadata", []) or []:
        label = meta.get("labelLocation") or {}
        lat, lon = label.get("latitude"), label.get("longitude")
        if lat is None or lon is None:
            continue
        points[meta["name"]] = (float(lat), float(lon))
    return points


def parse_sg_air(
    psi_payload: dict[str, Any],
    pm25_payload: Optional[dict[str, Any]],
    *,
    lat: Optional[float] = None,
    lon: Optional[float] = None,
    fetched_at: Optional[str] = None,
) -> SgAirResponse:
    """
    Build the response from raw NEA payloads. Raises ValueError/KeyError/TypeError
    on a malformed payload; the endpoint turns that into ``available: false``.
    """
    psi_item = _first_item(psi_payload)
    psi_readings = psi_item["readings"]["psi_twenty_four_hourly"]
    pm25_readings: dict[str, Any] = {}
    if pm25_payload is not None:
        try:
            pm25_readings = _first_item(pm25_payload)["readings"]["pm25_one_hourly"]
        except (KeyError, IndexError, TypeError, ValueError):
            pm25_readings = {}

    psi_regional = _region_values(psi_readings)
    if not psi_regional and _clean_int(psi_readings.get("national")) is None:
        raise ValueError("NEA PSI payload has no readings")
    pm25_regional = _region_values(pm25_readings)
    points = _label_points(psi_payload)

    regions: list[SgRegionReading] = []
    for name in REGION_NAMES:
        if name not in psi_regional and name not in pm25_regional:
            continue
        psi_v = psi_regional.get(name)
        point = points.get(name)
        regions.append(
            SgRegionReading(
                region=name,
                psi24h=psi_v,
                band=psi_band(psi_v)[0] if psi_v is not None else None,
                pm25OneHour=pm25_regional.get(name),
                labelLatitude=point[0] if point else None,
                labelLongitude=point[1] if point else None,
            )
        )

    psi24h, psi_basis = _headline(psi_readings, psi_regional)
    pm25, pm25_basis = _headline(pm25_readings, pm25_regional)
    band_key, band_label = (psi_band(psi24h) if psi24h is not None else (None, None))

    nearest = None
    if lat is not None and lon is not None:
        nearest = nearest_region(regions, lat, lon)

    return SgAirResponse(
        available=True,
        observedAt=psi_item.get("timestamp"),
        fetchedAt=fetched_at,
        psi24h=psi24h,
        psiBasis=psi_basis,
        band=band_key,
        bandLabel=band_label,
        pm25OneHour=pm25,
        pm25Basis=pm25_basis,
        regions=regions,
        nearestRegion=nearest,
    )


# ---------------------------------------------------------------------------
# Upstream fetch + cache
# ---------------------------------------------------------------------------

_upstream_cache: dict[str, Any] = {"at": 0.0, "value": None}


async def _get_json(client: httpx.AsyncClient, url: str) -> dict[str, Any]:
    res = await client.get(url)
    res.raise_for_status()
    return res.json()


async def _fetch_upstream() -> tuple[dict[str, Any], Optional[dict[str, Any]]]:
    """Fetch PSI (required) and PM2.5 (optional) concurrently."""
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
        psi, pm25 = await asyncio.gather(
            _get_json(client, PSI_URL),
            _get_json(client, PM25_URL),
            return_exceptions=True,
        )
    if isinstance(psi, BaseException):
        raise psi
    if isinstance(pm25, BaseException):
        logger.warning("NEA PM2.5 fetch failed: %s", type(pm25).__name__)
        pm25 = None
    return psi, pm25


async def _load_upstream() -> tuple[dict[str, Any], Optional[dict[str, Any]], str]:
    now = time.monotonic()
    cached = _upstream_cache["value"]
    if cached is not None and now - _upstream_cache["at"] < CACHE_TTL_SECONDS:
        return cached
    # execute() raises CircuitOpenError while the breaker is open.
    psi, pm25 = await nea_breaker.execute(_fetch_upstream)
    fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    value = (psi, pm25, fetched_at)
    _upstream_cache["at"] = now
    _upstream_cache["value"] = value
    return value


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


@router.get("/api/py/sg-air", response_model=SgAirResponse)
async def get_sg_air(
    lat: Optional[float] = Query(None, ge=-90, le=90),
    lon: Optional[float] = Query(None, ge=-180, le=180),
) -> SgAirResponse:
    """
    GET /api/py/sg-air?lat=&lon=

    Official NEA PSI (24h) and PM2.5 (1h) for Singapore, with per-region
    values. Pass ``lat``/``lon`` to get ``nearestRegion``. Always HTTP 200:
    when NEA is unreachable, the breaker is open, or the payload is malformed,
    the body is ``{"available": false, ...}``.
    """
    try:
        psi, pm25, fetched_at = await _load_upstream()
    except CircuitOpenError:
        return _unavailable()
    except Exception as e:  # network, timeout, bad JSON, HTTP status
        logger.warning("NEA PSI unavailable: %s", type(e).__name__)
        return _unavailable()

    try:
        return parse_sg_air(psi, pm25, lat=lat, lon=lon, fetched_at=fetched_at)
    except (KeyError, IndexError, TypeError, ValueError) as e:
        logger.warning("NEA PSI payload unreadable: %s", type(e).__name__)
        return _unavailable(fetched_at)
