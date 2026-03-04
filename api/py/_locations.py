"""
Location endpoints — migrated from /api/locations, /api/search, /api/geo.

Handles location CRUD, search (text + geospatial), and geo-lookup.
"""

from __future__ import annotations

import logging
import re
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

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

# City-states where state/province fields are meaningless (postal codes or same as country).
# For these, province is derived from district-level fields (city_district, suburb, etc.).
_CITY_STATES = {"SG", "MC", "VA", "GI", "SM", "AD", "LI", "MT", "BN", "DJ", "BH", "QA", "KW"}


def _get_http() -> httpx.Client:
    global _http_client
    if _http_client is None:
        _http_client = httpx.Client(timeout=5.0)
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

        # If text search returned no results, fall back to Open-Meteo
        # geocoding API for address-level discovery (like Apple/Google Weather).
        # These are geocoded candidates — not yet in our DB.
        source = "mongodb"
        if q and not tag and not results:
            geocoded = _forward_geocode(q, count=limit)
            results = [
                {
                    "slug": _generate_slug(g["name"], g.get("country", "")),
                    "name": g["name"],
                    "province": g.get("admin1", ""),
                    "lat": g["lat"],
                    "lon": g["lon"],
                    "elevation": g.get("elevation", 0),
                    "tags": [],
                    "country": g.get("country", ""),
                    "source": "geocoded",
                }
                for g in geocoded
            ]
            source = "geocoded"

        total = coll.count_documents(query_filter) if skip == 0 and source == "mongodb" else len(results)
        return {"locations": results, "total": total, "source": source}
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=503, detail="Search unavailable")


# ---------------------------------------------------------------------------
# /api/py/geo — Nearest location lookup
# ---------------------------------------------------------------------------


def _extract_location_name(data: dict, address: dict, country_code: str) -> str:
    """Extract the most specific location name from Nominatim response.

    Prefers POIs, suburbs, neighborhoods over generic city names.
    Real-world addresses and landmarks produce names like
    "Singapore American School", "Meikles Hotel", "525 Canberra Drive".
    """
    city = address.get("city") or address.get("town") or ""
    country_name = address.get("country", "")

    # Most specific: Nominatim's own name for this exact point (POI, building, etc.)
    poi_name = data.get("name", "")
    if poi_name and poi_name not in (city, country_name):
        return poi_name

    # Next: suburb or neighbourhood — e.g., "Woodlands", "Strathaven"
    suburb = address.get("suburb") or address.get("neighbourhood") or ""
    if suburb and suburb not in (city, country_name):
        return suburb

    # Next: road name — e.g., "Orchard Road", "525 Canberra Drive"
    road = address.get("road", "")
    if road:
        return road

    # Fallback: city/town/village level
    return (
        city
        or address.get("village")
        or address.get("county")
        or data.get("name", "Unknown")
    )


def _normalize_admin1(address: dict, country_code: str, country_name: str) -> str:
    """Extract a meaningful province/district from Nominatim address.

    For city-states: uses district/suburb-level fields (e.g., "Woodlands" for SG).
    For normal countries: uses state/province with numeric rejection.
    """
    # City-states: state is meaningless (postal code or same as country).
    # Use sub-national divisions as "province".
    if country_code.upper() in _CITY_STATES:
        return (
            address.get("city_district")
            or address.get("suburb")
            or address.get("state_district")
            or address.get("county")
            or country_name
        )

    raw = address.get("state") or address.get("province") or ""
    stripped = raw.strip()

    # Validate: reject purely numeric, ≤2 chars, or digit-heavy strings
    if stripped and not stripped.isdigit() and len(stripped) > 2:
        digit_ratio = sum(c.isdigit() for c in stripped) / len(stripped)
        if digit_ratio < 0.5:
            return stripped

    # Fallback chain for invalid admin1
    return (
        address.get("state_district")
        or address.get("city_district")
        or address.get("region")
        or address.get("county")
        or country_name
    )


def _build_nominatim_address(address: dict, country_code: str, display_name: str) -> dict:
    """Build structured address dict from Nominatim address fields.

    Stores formal address components separately for contextual display
    in breadcrumbs, cards, and info panels.
    """
    return {
        k: v for k, v in {
            "road": address.get("road"),
            "suburb": address.get("suburb"),
            "cityDistrict": address.get("city_district"),
            "city": address.get("city"),
            "state": address.get("state"),
            "stateDistrict": address.get("state_district"),
            "county": address.get("county"),
            "postcode": address.get("postcode"),
            "country": address.get("country"),
            "countryCode": country_code,
            "displayName": display_name,
        }.items() if v
    }


def _reverse_geocode(lat: float, lon: float, *, zoom: int = 14) -> dict | None:
    """Reverse geocode using Nominatim.

    Args:
        zoom: Nominatim zoom level (10=city, 14=suburb, 18=building/POI).
              Defaults to 14 (suburb level) as a privacy-safe default.
              Use zoom=18 only for explicit named search queries where
              POI-level specificity is expected. GPS auto-creation uses
              the default to avoid storing exact home addresses.
    """
    client = _get_http()
    try:
        resp = client.get(
            "https://nominatim.openstreetmap.org/reverse",
            params={
                "lat": str(lat),
                "lon": str(lon),
                "format": "jsonv2",
                "zoom": zoom,
                "accept-language": "en",
            },
            headers={"User-Agent": "mukoko-weather/2.0 (support@mukoko.com)"},
        )
        if resp.status_code != 200:
            return None

        data = resp.json()
        address = data.get("address", {})

        country_code = address.get("country_code", "").upper()
        country_name = address.get("country", "")

        name = _extract_location_name(data, address, country_code)
        admin1 = _normalize_admin1(address, country_code, country_name)
        nominatim_address = _build_nominatim_address(
            address, country_code, data.get("display_name", ""),
        )

        return {
            "name": name,
            "country": country_code,
            "countryName": country_name,
            "admin1": admin1,
            "nominatimAddress": nominatim_address,
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


def _generate_slug(name: str, country: str = "") -> str:
    """Generate a URL-safe slug from a location name.

    All locations get country-code suffix (e.g., "harare-zw", "nairobi-ke").
    """
    import unicodedata
    slug = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-z0-9]+", "-", slug.lower()).strip("-")
    if country:
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


def _is_valid_coordinates(lat: float, lon: float) -> bool:
    """Check if coordinates are valid WGS 84 values.

    The app is fully global — any valid latitude/longitude is accepted.
    """
    return -90 <= lat <= 90 and -180 <= lon <= 180


# Dedup radius — tight because location names are now specific (POIs, addresses,
# suburbs). Two different places 2km apart are legitimately different locations.
DEDUP_RADIUS_KM = 1



def _find_duplicate(
    lat: float,
    lon: float,
    radius_km: float = DEDUP_RADIUS_KM,
    name: str | None = None,
    country: str | None = None,
) -> dict | None:
    """Check for existing locations within radius_km OR with same name+country."""
    try:
        # Geospatial proximity check
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
        if result:
            return result

        # Name + country check — catches same-named locations farther apart
        if name and country:
            result = locations_collection().find_one(
                {"name": name, "country": country.upper()},
                {"_id": 0},
            )
            if result:
                return result

        return None
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
        # Fast path: check MongoDB for nearby locations FIRST (sub-100ms)
        # before making any external API calls. Most geo requests will match
        # an existing location and return instantly.
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

        # If we have nearby results, return immediately — no geocoding needed
        if results:
            nearest = results[0]
            return {
                "nearest": nearest,
                "redirectTo": f"/{nearest['slug']}",
                "isNew": False,
            }

        # If no local match, try uncapped distance
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
            if uncapped:
                return {
                    "nearest": uncapped,
                    "redirectTo": f"/{uncapped['slug']}",
                    "isNew": False,
                }
        except Exception:
            pass

        # Auto-create if requested — only NOW do we call external APIs
        if autoCreate:
            geocoded = _reverse_geocode(lat, lon)
            if not geocoded:
                raise HTTPException(
                    status_code=422,
                    detail="Could not determine location name",
                )

            # Duplicate check (1km radius + name/country match)
            dedup_km = DEDUP_RADIUS_KM
            duplicate = _find_duplicate(
                lat, lon, dedup_km,
                name=geocoded["name"], country=geocoded["country"],
            )
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
                "nominatimAddress": geocoded.get("nominatimAddress", {}),
            }
            locations_collection().insert_one(new_loc)
            new_loc.pop("_id", None)

            # Enrich: resolve seasons for this country if not already known
            _enrich_location_with_ai(geocoded["country"], lat, lon)

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


def _enrich_location_with_ai(country_code: str, lat: float, lon: float) -> None:
    """Trigger AI season resolution for a country if not already in DB.

    Called after creating a community/geolocation location. Runs in a
    background thread so the HTTP response is not blocked by the Claude API
    call (~5-15s). If AI is unavailable, season data will be resolved on
    the next weather request via _get_season().
    """
    import threading

    logger.info("Starting AI location enrichment for %s (%.1f, %.1f)", country_code, lat, lon)

    def _run() -> None:
        try:
            db = get_db()
            existing = db["seasons"].find_one({"countryCode": country_code.upper()})
            if existing:
                return  # Already have season data for this country

            from ._ai import _resolve_seasons_with_ai
            _resolve_seasons_with_ai(country_code, lat, lon)
        except Exception:
            logger.debug("AI location enrichment skipped for %s", country_code)

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()


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
                    for r in results
                ],
            }

        # Mode 2: Coordinates
        lat = float(body.get("lat", 0))
        lon = float(body.get("lon", 0))

        if not _is_valid_coordinates(lat, lon):
            raise HTTPException(status_code=400, detail="Invalid coordinates")

        # Rate limit — extract real IP behind Vercel's reverse proxy
        ip = get_client_ip(request) or "unknown"
        rate = check_rate_limit(ip, "location-create", 5, 3600)
        if not rate["allowed"]:
            raise HTTPException(status_code=429, detail="Rate limit exceeded. Try again later.")

        # Reverse geocode with POI-level zoom — user explicitly chose coords
        geocoded = _reverse_geocode(lat, lon, zoom=18)
        if not geocoded:
            raise HTTPException(status_code=422, detail="Could not determine location name")

        # Duplicate check (1km radius + name/country match)
        duplicate = _find_duplicate(
            lat, lon, DEDUP_RADIUS_KM,
            name=geocoded["name"], country=geocoded["country"],
        )
        if duplicate:
            return {
                "mode": "duplicate",
                "existing": {
                    "slug": duplicate["slug"],
                    "name": duplicate["name"],
                    "province": duplicate.get("province", ""),
                    "country": duplicate.get("country", ""),
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
            "nominatimAddress": geocoded.get("nominatimAddress", {}),
        }
        locations_collection().insert_one(new_loc)
        new_loc.pop("_id", None)

        # Enrich: resolve seasons for this country if not already known
        _enrich_location_with_ai(geocoded["country"], lat, lon)

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
