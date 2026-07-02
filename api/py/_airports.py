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
5 km dedup upsert helper — all wrong for a fixed 72-row reference seed written
from the TypeScript db-init flow. A plain reference collection keyed by ICAO
code (its natural `_id`) with a 2dsphere index is the right fit, mirroring the
existing `metar_cache` / `air_quality_cache` reference collections.

Resilience: any DB error (missing 2dsphere index, unseeded collection, etc.)
returns an empty list rather than raising — the TypeScript client
(`fetchNearestAirports`) then falls back to its static haversine scan, so the
aviation UI never breaks.
"""

from __future__ import annotations

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
