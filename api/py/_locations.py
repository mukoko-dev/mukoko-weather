"""
Location endpoints — migrated from /api/locations, /api/search, /api/geo.

Handles location CRUD, search (text + geospatial), and geo-lookup.
"""

from __future__ import annotations

import re
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ._db import (
    get_db,
    get_client_ip,
    locations_collection,
    check_rate_limit,
)

router = APIRouter()

SLUG_RE = re.compile(r"^[a-z0-9-]{1,80}$")
COUNTRY_PREFERENCE_MAX_KM = 50
_http_client: Optional[httpx.Client] = None


def _get_http() -> httpx.Client:
    global _http_client
    if _http_client is None:
        _http_client = httpx.Client(timeout=10.0)
    return _http_client


# ---------------------------------------------------------------------------
# /api/py/locations — List/filter locations
# ---------------------------------------------------------------------------


MAX_LOCATIONS_LIMIT = 200
DEFAULT_LOCATIONS_LIMIT = 50


@router.get("/api/py/locations")
async def list_locations(
    slug: str | None = None,
    tag: str | None = None,
    country: str | None = None,
    mode: str | None = None,
    limit: int = DEFAULT_LOCATIONS_LIMIT,
    skip: int = 0,
):
    """
    GET /api/py/locations
    GET /api/py/locations?slug=harare
    GET /api/py/locations?tag=farming
    GET /api/py/locations?tag=farming&limit=20&skip=0
    GET /api/py/locations?country=ZW&limit=30
    GET /api/py/locations?mode=tags
    GET /api/py/locations?mode=stats
    """
    limit = max(1, min(limit, MAX_LOCATIONS_LIMIT))
    skip = max(0, skip)

    try:
        coll = locations_collection()

        if slug:
            loc = coll.find_one({"slug": slug}, {"_id": 0})
            if not loc:
                raise HTTPException(status_code=404, detail="Location not found")
            return {"location": loc}

        if mode == "tags":
            pipeline = [
                {"$unwind": "$tags"},
                {"$group": {"_id": "$tags", "count": {"$sum": 1}}},
                {"$sort": {"count": -1}},
            ]
            tags = list(coll.aggregate(pipeline))
            return {"tags": {t["_id"]: t["count"] for t in tags}}

        if mode == "stats":
            total = coll.count_documents({})
            provinces = len(coll.distinct("province"))
            countries = len(coll.distinct("country"))
            return {
                "totalLocations": total,
                "totalProvinces": provinces,
                "totalCountries": countries,
            }

        # Build query filter
        query_filter: dict = {}
        if tag:
            query_filter["tags"] = tag
        if country:
            query_filter["country"] = country.upper()

        total = coll.count_documents(query_filter)
        locs = list(
            coll.find(query_filter, {"_id": 0})
            .sort("name", 1)
            .skip(skip)
            .limit(limit)
        )
        return {"locations": locs, "total": total, "limit": limit, "skip": skip}
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=503, detail="Location data unavailable")


# ---------------------------------------------------------------------------
# /api/py/search — Text + geospatial search
# ---------------------------------------------------------------------------


@router.get("/api/py/search")
async def search_locations(
    q: str = "",
    tag: str | None = None,
    lat: str | None = None,
    lon: str | None = None,
    mode: str | None = None,
    limit: int = 20,
    skip: int = 0,
):
    """
    GET /api/py/search?q=harare
    GET /api/py/search?tag=farming
    GET /api/py/search?lat=-17.83&lon=31.05
    GET /api/py/search?mode=tags
    """
    limit = min(limit, 50)
    coll = locations_collection()

    try:
        # Tag counts mode
        if mode == "tags":
            pipeline = [
                {"$unwind": "$tags"},
                {"$group": {"_id": "$tags", "count": {"$sum": 1}}},
                {"$sort": {"count": -1}},
            ]
            tags = list(coll.aggregate(pipeline))
            return {"tags": {t["_id"]: t["count"] for t in tags}}

        # Geospatial nearest
        if lat and lon:
            lat_f = float(lat)
            lon_f = float(lon)
            results = list(
                coll.find(
                    {
                        "geo": {
                            "$near": {
                                "$geometry": {"type": "Point", "coordinates": [lon_f, lat_f]},
                                "$maxDistance": 100000,  # 100km
                            }
                        }
                    },
                    {"_id": 0},
                ).limit(limit)
            )
            return {"locations": results, "total": len(results), "source": "mongodb"}

        # Text search
        if not q and not tag:
            raise HTTPException(status_code=400, detail="Provide q (search query) or tag (filter)")

        query_filter: dict = {}
        if q:
            query_filter["$text"] = {"$search": q.strip()[:200]}
        if tag:
            query_filter["tags"] = tag

        projection = {"_id": 0}
        if q:
            projection["score"] = {"$meta": "textScore"}

        cursor = coll.find(query_filter, projection)
        if q:
            cursor = cursor.sort([("score", {"$meta": "textScore"})])
        else:
            cursor = cursor.sort([("name", 1)])

        results = list(cursor.skip(skip).limit(limit))
        # Remove score from output
        for r in results:
            r.pop("score", None)

        total = coll.count_documents(query_filter) if skip == 0 else len(results)
        return {"locations": results, "total": total, "source": "mongodb"}
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=503, detail="Search unavailable")


# ---------------------------------------------------------------------------
# /api/py/geo — Nearest location lookup
# ---------------------------------------------------------------------------


def _reverse_geocode(lat: float, lon: float) -> dict | None:
    """Reverse geocode using Nominatim."""
    client = _get_http()
    try:
        resp = client.get(
            "https://nominatim.openstreetmap.org/reverse",
            params={
                "lat": str(lat),
                "lon": str(lon),
                "format": "jsonv2",
                "zoom": 10,
                "accept-language": "en",
            },
            headers={"User-Agent": "mukoko-weather/2.0 (support@mukoko.com)"},
        )
        if resp.status_code != 200:
            return None

        data = resp.json()
        address = data.get("address", {})

        name = (
            address.get("city")
            or address.get("town")
            or address.get("village")
            or address.get("suburb")
            or address.get("county")
            or data.get("name", "Unknown")
        )

        country_code = address.get("country_code", "zw").upper()
        country_name = address.get("country", "Zimbabwe")
        admin1 = address.get("state", address.get("province", ""))

        return {
            "name": name,
            "country": country_code,
            "countryName": country_name,
            "admin1": admin1,
            "lat": float(data.get("lat", lat)),
            "lon": float(data.get("lon", lon)),
            "elevation": 0,
        }
    except Exception:
        return None


def _forward_geocode(query: str, count: int = 5) -> list[dict]:
    """Forward geocode using Open-Meteo geocoding API."""
    client = _get_http()
    try:
        resp = client.get(
            "https://geocoding-api.open-meteo.com/v1/search",
            params={"name": query, "count": str(count), "language": "en"},
        )
        if resp.status_code != 200:
            return []

        data = resp.json()
        results = data.get("results", [])
        return [
            {
                "name": r.get("name", ""),
                "country": r.get("country_code", "").upper(),
                "countryName": r.get("country", ""),
                "admin1": r.get("admin1", ""),
                "lat": r.get("latitude", 0),
                "lon": r.get("longitude", 0),
                "elevation": r.get("elevation", 0),
            }
            for r in results
        ]
    except Exception:
        return []


def _get_elevation(lat: float, lon: float) -> int:
    """Get elevation from Open-Meteo."""
    client = _get_http()
    try:
        resp = client.get(
            "https://api.open-meteo.com/v1/elevation",
            params={"latitude": str(lat), "longitude": str(lon)},
        )
        if resp.status_code == 200:
            data = resp.json()
            elevations = data.get("elevation", [0])
            return int(elevations[0]) if elevations else 0
    except Exception:
        pass
    return 0


def _generate_slug(name: str, country: str = "ZW") -> str:
    """Generate a URL-safe slug from a location name."""
    import unicodedata
    slug = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-z0-9]+", "-", slug.lower()).strip("-")
    if country and country.upper() != "ZW":
        slug = f"{slug}-{country.lower()}"
    return slug[:80]


def _generate_province_slug(province: str, country: str) -> str:
    """Generate a slug for a province."""
    import unicodedata
    slug = unicodedata.normalize("NFKD", province).encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-z0-9]+", "-", slug.lower()).strip("-")
    return f"{slug}-{country.lower()}"[:80]


def _infer_tags(geocoded: dict) -> list[str]:
    """Infer tags from geocoded location data."""
    tags = []
    name_lower = geocoded.get("name", "").lower()
    admin_lower = geocoded.get("admin1", "").lower()

    # City detection
    if any(word in name_lower for word in ["city", "town", "urban"]):
        tags.append("city")
    elif geocoded.get("population", 0) and geocoded["population"] > 50000:
        tags.append("city")

    # Default tag
    if not tags:
        tags.append("city")

    return tags


def _is_in_supported_region(lat: float, lon: float) -> bool:
    """Check if coordinates are within a supported region from MongoDB."""
    try:
        db = get_db()
        region = db["regions"].find_one({
            "active": True,
            "bounds.south": {"$lte": lat + 1},
            "bounds.north": {"$gte": lat - 1},
            "bounds.west": {"$lte": lon + 1},
            "bounds.east": {"$gte": lon - 1},
        })
        return region is not None
    except Exception:
        # Fallback: accept Zimbabwe + broad Africa + ASEAN
        if -23 <= lat <= 38 and -18 <= lon <= 52:
            return True  # Africa
        if -11 <= lat <= 28 and 92 <= lon <= 142:
            return True  # ASEAN
        return False


DEDUP_RADIUS_ZW_KM = 5
DEDUP_RADIUS_DEFAULT_KM = 10


def _dedup_radius(country: str | None) -> float:
    """Zimbabwe locations use a tighter 5km radius; others use 10km."""
    if country and country.upper() == "ZW":
        return DEDUP_RADIUS_ZW_KM
    return DEDUP_RADIUS_DEFAULT_KM


def _find_duplicate(lat: float, lon: float, radius_km: float = DEDUP_RADIUS_DEFAULT_KM) -> dict | None:
    """Check for existing locations within radius_km."""
    try:
        result = locations_collection().find_one(
            {
                "geo": {
                    "$near": {
                        "$geometry": {"type": "Point", "coordinates": [lon, lat]},
                        "$maxDistance": radius_km * 1000,
                    }
                }
            },
            {"_id": 0},
        )
        return result
    except Exception:
        return None


@router.get("/api/py/geo")
async def geo_lookup(
    lat: float,
    lon: float,
    autoCreate: bool = False,
):
    """
    GET /api/py/geo?lat=-17.83&lon=31.05&autoCreate=true

    Find nearest location or auto-create one via reverse geocoding.
    """
    try:
        # Find nearest locations + reverse geocode in parallel (sequential in sync code)
        geocoded = _reverse_geocode(lat, lon)

        # Find nearby locations
        try:
            results = list(
                locations_collection().find(
                    {
                        "geo": {
                            "$near": {
                                "$geometry": {"type": "Point", "coordinates": [lon, lat]},
                                "$maxDistance": COUNTRY_PREFERENCE_MAX_KM * 1000,
                            }
                        }
                    },
                    {"_id": 0},
                ).limit(5)
            )
        except Exception:
            results = []

        # Pick best match (prefer same country)
        user_country = geocoded.get("country") if geocoded else None
        nearest = None
        if results:
            if user_country:
                uc = user_country.upper()
                same_country = next(
                    (r for r in results if (r.get("country", "ZW")).upper() == uc),
                    None,
                )
                nearest = same_country or results[0]
            else:
                nearest = results[0]

        # If no local match, try uncapped
        if not nearest:
            try:
                uncapped = locations_collection().find_one(
                    {
                        "geo": {
                            "$near": {
                                "$geometry": {"type": "Point", "coordinates": [lon, lat]},
                            }
                        }
                    },
                    {"_id": 0},
                )
                nearest = uncapped
            except Exception:
                pass

        if nearest:
            return {
                "nearest": nearest,
                "redirectTo": f"/{nearest['slug']}",
                "isNew": False,
            }

        # No nearby location — check supported region
        if not _is_in_supported_region(lat, lon):
            raise HTTPException(
                status_code=404,
                detail="Location is outside supported regions",
            )

        # Auto-create if requested
        if autoCreate:
            if not geocoded:
                raise HTTPException(
                    status_code=422,
                    detail="Could not determine location name",
                )

            # Duplicate check (5km for Zimbabwe, 10km elsewhere)
            dedup_km = _dedup_radius(geocoded.get("country"))
            duplicate = _find_duplicate(lat, lon, dedup_km)
            if duplicate:
                return {
                    "nearest": duplicate,
                    "redirectTo": f"/{duplicate['slug']}",
                    "isNew": False,
                }

            elevation = geocoded.get("elevation", 0) or 0
            if not elevation:
                elevation = _get_elevation(lat, lon)

            slug = _generate_slug(geocoded["name"], geocoded["country"])
            province = geocoded.get("admin1") or geocoded.get("countryName", "")
            province_slug = _generate_province_slug(province, geocoded["country"])

            # Upsert country and province
            db = get_db()
            db["countries"].update_one(
                {"code": geocoded["country"]},
                {
                    "$setOnInsert": {
                        "code": geocoded["country"],
                        "name": geocoded["countryName"],
                        "region": "Unknown",
                        "supported": True,
                    },
                },
                upsert=True,
            )
            db["provinces"].update_one(
                {"slug": province_slug},
                {
                    "$setOnInsert": {
                        "slug": province_slug,
                        "name": province,
                        "countryCode": geocoded["country"],
                    },
                },
                upsert=True,
            )

            # Handle slug collisions
            existing = locations_collection().find_one({"slug": slug})
            if existing:
                suffix = 2
                while locations_collection().find_one({"slug": f"{slug}-{suffix}"}):
                    suffix += 1
                slug = f"{slug}-{suffix}"

            tags = _infer_tags(geocoded)

            new_loc = {
                "slug": slug,
                "name": geocoded["name"],
                "province": province,
                "lat": geocoded["lat"],
                "lon": geocoded["lon"],
                "elevation": round(elevation),
                "tags": tags,
                "country": geocoded["country"],
                "source": "geolocation",
                "provinceSlug": province_slug,
                "geo": {"type": "Point", "coordinates": [geocoded["lon"], geocoded["lat"]]},
            }
            locations_collection().insert_one(new_loc)
            new_loc.pop("_id", None)

            return {
                "nearest": new_loc,
                "redirectTo": f"/{slug}",
                "isNew": True,
            }

        raise HTTPException(
            status_code=404,
            detail="No nearby location found. Use autoCreate=true to add one.",
        )
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=503, detail="Location service unavailable")


# ---------------------------------------------------------------------------
# /api/py/locations/add — Add locations via search or coordinates
# ---------------------------------------------------------------------------


class AddLocationByCoords(BaseModel):
    lat: float
    lon: float


class AddLocationBySearch(BaseModel):
    query: str


@router.post("/api/py/locations/add")
async def add_location(request: Request):
    """
    POST /api/py/locations/add

    Two modes:
    1. Search: { query } → forward geocode → return candidates
    2. Coordinates: { lat, lon } → reverse geocode + dedupe + create
    """
    body = await request.json()

    try:
        # Mode 1: Search
        if "query" in body and isinstance(body["query"], str):
            query = body["query"].strip()
            if not query:
                raise HTTPException(status_code=400, detail="Empty query")

            results = _forward_geocode(query, count=5)

            # Filter to supported regions
            supported = [r for r in results if _is_in_supported_region(r["lat"], r["lon"])]

            return {
                "mode": "candidates",
                "results": [
                    {
                        "name": r["name"],
                        "country": r["country"],
                        "countryName": r["countryName"],
                        "admin1": r["admin1"],
                        "lat": r["lat"],
                        "lon": r["lon"],
                        "elevation": r.get("elevation", 0),
                    }
                    for r in supported
                ],
            }

        # Mode 2: Coordinates
        lat = float(body.get("lat", 0))
        lon = float(body.get("lon", 0))

        if lat < -90 or lat > 90 or lon < -180 or lon > 180:
            raise HTTPException(status_code=400, detail="Invalid coordinates")

        if not _is_in_supported_region(lat, lon):
            raise HTTPException(status_code=400, detail="Coordinates are outside supported regions.")

        # Rate limit — extract real IP behind Vercel's reverse proxy
        ip = get_client_ip(request) or "unknown"
        rate = check_rate_limit(ip, "location-create", 5, 3600)
        if not rate["allowed"]:
            raise HTTPException(status_code=429, detail="Rate limit exceeded. Try again later.")

        # Reverse geocode first so we know the country for dedup radius
        geocoded = _reverse_geocode(lat, lon)
        if not geocoded:
            raise HTTPException(status_code=422, detail="Could not determine location name")

        # Duplicate check (5km for Zimbabwe, 10km elsewhere)
        dedup_km = _dedup_radius(geocoded.get("country"))
        duplicate = _find_duplicate(lat, lon, dedup_km)
        if duplicate:
            return {
                "mode": "duplicate",
                "existing": {
                    "slug": duplicate["slug"],
                    "name": duplicate["name"],
                    "province": duplicate.get("province", ""),
                    "country": duplicate.get("country", "ZW"),
                },
                "message": f"A location already exists nearby: {duplicate['name']}",
            }

        elevation = geocoded.get("elevation", 0) or 0
        if not elevation:
            elevation = _get_elevation(lat, lon)

        slug = _generate_slug(geocoded["name"], geocoded["country"])

        # Slug collision handling
        existing = locations_collection().find_one({"slug": slug})
        if existing:
            suffix = 2
            while locations_collection().find_one({"slug": f"{slug}-{suffix}"}):
                suffix += 1
            slug = f"{slug}-{suffix}"

        province = geocoded.get("admin1") or geocoded.get("countryName", "")
        province_slug = _generate_province_slug(province, geocoded["country"])

        # Upsert country/province
        db = get_db()
        db["countries"].update_one(
            {"code": geocoded["country"]},
            {"$setOnInsert": {"code": geocoded["country"], "name": geocoded["countryName"], "region": "Unknown", "supported": True}},
            upsert=True,
        )
        db["provinces"].update_one(
            {"slug": province_slug},
            {"$setOnInsert": {"slug": province_slug, "name": province, "countryCode": geocoded["country"]}},
            upsert=True,
        )

        tags = _infer_tags(geocoded)

        new_loc = {
            "slug": slug,
            "name": geocoded["name"],
            "province": province,
            "lat": geocoded["lat"],
            "lon": geocoded["lon"],
            "elevation": round(elevation),
            "tags": tags,
            "country": geocoded["country"],
            "source": "community",
            "provinceSlug": province_slug,
            "geo": {"type": "Point", "coordinates": [geocoded["lon"], geocoded["lat"]]},
        }
        locations_collection().insert_one(new_loc)
        new_loc.pop("_id", None)

        return {
            "mode": "created",
            "location": {
                "slug": new_loc["slug"],
                "name": new_loc["name"],
                "province": new_loc["province"],
                "country": new_loc.get("country", geocoded["country"]),
                "lat": new_loc["lat"],
                "lon": new_loc["lon"],
                "elevation": new_loc["elevation"],
            },
        }
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=500, detail="Failed to add location")
