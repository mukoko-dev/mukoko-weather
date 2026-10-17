"""
Airports endpoint — DB-backed nearest-airport lookup for aviation METAR/TAF.

The `weather.airports` collection is seeded from the static ICAO catalog
(`src/lib/icao-codes.ts` → `syncAirports` in `src/lib/db.ts`) via
`POST /api/db-init`. Each doc carries a GeoJSON `location` Point and a
2dsphere index, so the N nearest airports to any lat/lon are found with a
MongoDB `$geoNear` aggregation (which also returns great-circle distance).

Design note — why a dedicated `weather.airports` collection (not
`places.placesGeo`): airports are fixed aviation reference data specific to the
METAR/TAF feature, not admin geography (`placesGeo`) or OSM POIs (`places`).
`placesGeo` carries a strict validator, hash-suffixed slugs, and a Python-only
5 km dedup upsert helper — all wrong for a fixed reference seed written
from the TypeScript db-init flow. A plain reference collection keyed by ICAO
code (its natural `_id`) with a 2dsphere index is the right fit, mirroring the
existing `metar_cache` / `air_quality_cache` reference collections.

Fetch on demand (mukoko-dev/mukoko-weather#302): the static catalog is only a
seed. When the nearest-METAR search finds fewer stored airports than it wants,
``_metar.discover_airports`` asks the Aviation Weather Center's
``stationinfo?bbox=`` endpoint (the same keyless host as the METAR feed) for
the METAR stations around the point, and :func:`upsert_discovered_airports`
stores them here with ``source: "awc-stationinfo"``. The next visitor near
that airport is served from the DB. ``syncAirports`` (db-init) prunes only
seed docs, so it never deletes a discovered airport.

Resilience: any DB error (missing 2dsphere index, unseeded collection, etc.)
returns an empty list rather than raising — the TypeScript client
(`fetchNearestAirports`) then falls back to its static haversine scan, so the
aviation UI never breaks.
"""

from __future__ import annotations

import math
import re
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ._db import get_db

router = APIRouter()

#: Hard cap on how many airports a single request may ask for.
MAX_COUNT = 20

#: Default search radius, in km, when the caller doesn't specify one.
DEFAULT_MAX_DISTANCE_KM = 500.0


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class NearbyAirport(BaseModel):
    icao: str
    name: str
    distanceKm: float


class NearestAirportsResponse(BaseModel):
    airports: list[NearbyAirport]
    source: str  # "db" when served from MongoDB, "empty" when nothing matched


# ---------------------------------------------------------------------------
# MongoDB accessor + query
# ---------------------------------------------------------------------------


def _airports_collection():
    return get_db()["airports"]


def nearest_airports(
    lat: float,
    lon: float,
    count: int = 5,
    max_distance_km: float = DEFAULT_MAX_DISTANCE_KM,
) -> list[NearbyAirport]:
    """
    Return up to ``count`` airports nearest to (lat, lon) within
    ``max_distance_km``, sorted closest-first, each with its great-circle
    distance in km.

    Uses a ``$geoNear`` aggregation over the 2dsphere-indexed
    ``weather.airports.location`` field. Returns an empty list on any DB error
    so the caller can fall back to a static lookup.
    """
    try:
        max_distance_m = float(max_distance_km) * 1000.0
        pipeline = [
            {
                "$geoNear": {
                    "near": {"type": "Point", "coordinates": [lon, lat]},
                    "distanceField": "distanceMeters",
                    "maxDistance": max_distance_m,
                    "spherical": True,
                }
            },
            {"$limit": int(count)},
        ]
        results: list[NearbyAirport] = []
        for doc in _airports_collection().aggregate(pipeline):
            icao = doc.get("icao") or doc.get("_id")
            if not icao:
                continue
            distance_m = doc.get("distanceMeters")
            distance_km = round(float(distance_m) / 1000.0, 1) if distance_m is not None else 0.0
            results.append(
                NearbyAirport(
                    icao=str(icao).upper(),
                    name=doc.get("name") or str(icao),
                    distanceKm=distance_km,
                )
            )
        return results
    except Exception as e:
        try:
            print(f"[airports] nearest_airports failed: {e}")
        except Exception:
            pass
        return []


# ---------------------------------------------------------------------------
# Fetch-on-demand storage
# ---------------------------------------------------------------------------

#: ``source`` of an airport stored from AWC station info (not the seed).
DISCOVERED_SOURCE = "awc-stationinfo"

#: Most stations one discovery may store (nearest first).
MAX_DISCOVERED_PER_REQUEST = 25

_ICAO_RE = re.compile(r"^[A-Z]{4}$")


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in km (WGS 84 mean radius)."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371.0088 * 2 * math.asin(min(1.0, math.sqrt(a)))


def _finite(value) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    f = float(value)
    return f if math.isfinite(f) else None


def parse_awc_stations(raw: list) -> list[dict]:
    """Validated METAR stations from an AWC ``stationinfo`` payload.

    A station is kept only when its ICAO id is four letters (the same rule as
    ``/api/py/metar``), its coordinates are finite WGS 84 values, and AWC says
    it issues METARs (``siteType`` contains ``"METAR"``): a station without a
    METAR feed is no use to the aviation card. Duplicates keep the first row.
    """
    seen: set[str] = set()
    stations: list[dict] = []
    for row in raw if isinstance(raw, list) else []:
        if not isinstance(row, dict):
            continue
        icao = str(row.get("icaoId") or "").strip().upper()
        if not _ICAO_RE.match(icao) or icao in seen:
            continue
        site_type = row.get("siteType")
        if not isinstance(site_type, list) or "METAR" not in site_type:
            continue
        lat, lon = _finite(row.get("lat")), _finite(row.get("lon"))
        if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        name = str(row.get("site") or "").strip()[:120] or icao
        country = str(row.get("country") or "").strip().upper()
        iata = str(row.get("iataId") or "").strip().upper()
        seen.add(icao)
        stations.append({
            "icao": icao,
            "name": name,
            "lat": lat,
            "lon": lon,
            "country": country if re.match(r"^[A-Z]{2}$", country) else None,
            "iata": iata if re.match(r"^[A-Z0-9]{3}$", iata) else None,
        })
    return stations


def nearest_of(
    stations: list[dict], lat: float, lon: float, *, count: int, max_distance_km: float,
) -> list[NearbyAirport]:
    """The ``count`` stations nearest (lat, lon) within ``max_distance_km``,
    computed in memory (used when the DB cannot answer after a discovery)."""
    ranked = sorted(
        ((haversine_km(lat, lon, s["lat"], s["lon"]), s) for s in stations),
        key=lambda pair: pair[0],
    )
    return [
        NearbyAirport(icao=s["icao"], name=s["name"], distanceKm=round(d, 1))
        for d, s in ranked
        if d <= max_distance_km
    ][: max(0, count)]


def upsert_discovered_airports(stations: list[dict], lat: float, lon: float) -> int:
    """Store discovered stations in ``weather.airports``; returns how many
    were written (0 on a DB error — never raises).

    Insert-only (``$setOnInsert``): a seeded airport keeps its curated name
    and coordinates, and a second discovery of the same station is a no-op.
    At most :data:`MAX_DISCOVERED_PER_REQUEST` stations, nearest first.
    """
    if not stations:
        return 0
    ranked = sorted(stations, key=lambda s: haversine_km(lat, lon, s["lat"], s["lon"]))
    ranked = ranked[:MAX_DISCOVERED_PER_REQUEST]
    now = datetime.now(timezone.utc)
    written = 0
    try:
        coll = _airports_collection()
        for s in ranked:
            doc = {
                "icao": s["icao"],
                "name": s["name"],
                "lat": s["lat"],
                "lon": s["lon"],
                "location": {"type": "Point", "coordinates": [s["lon"], s["lat"]]},
                "source": DISCOVERED_SOURCE,
                "createdAt": now,
                "updatedAt": now,
            }
            if s.get("country"):
                doc["country"] = s["country"]
            if s.get("iata"):
                doc["iata"] = s["iata"]
            result = coll.update_one({"_id": s["icao"]}, {"$setOnInsert": doc}, upsert=True)
            if getattr(result, "upserted_id", None) is not None:
                written += 1
    except Exception as e:  # noqa: BLE001 — storage is best-effort
        try:
            print(f"[airports] upsert_discovered_airports failed: {type(e).__name__}")
        except Exception:
            pass
    return written


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


@router.get("/api/py/airports/nearest", response_model=NearestAirportsResponse)
async def get_nearest_airports(
    lat: float = Query(..., ge=-90.0, le=90.0),
    lon: float = Query(..., ge=-180.0, le=180.0),
    count: int = Query(5, ge=1, le=MAX_COUNT),
    maxDistanceKm: Optional[float] = Query(DEFAULT_MAX_DISTANCE_KM, gt=0.0, le=20000.0),
):
    """
    GET /api/py/airports/nearest?lat=-17.85&lon=31.05&count=5

    Returns the N nearest ICAO airports (from the seeded `weather.airports`
    collection) to the given coordinates, each with icao + name + distanceKm,
    sorted closest-first. On any DB error returns an empty list (the client
    falls back to its static haversine scan).
    """
    distance = maxDistanceKm if maxDistanceKm is not None else DEFAULT_MAX_DISTANCE_KM
    airports = nearest_airports(lat, lon, count=count, max_distance_km=distance)
    return NearestAirportsResponse(
        airports=airports,
        source="db" if airports else "empty",
    )
