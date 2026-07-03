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
    places_geo_collection,
    check_rate_limit,
)
from ._places_resolver import (
    adapt_placesgeo_to_location,
    count_all_locations,
    find_all_locations,
    find_location,
    find_locations_by_tag,
    find_locations_in_country,
    find_nearest_location,
)
from ._places_geo import (
    find_nearby_placesgeo,
    find_nearest_place,
    poi_type_from_place,
    upsert_placesgeo_city,
    get_country_id,
    POI_MATCH_RADIUS_KM,
)

router = APIRouter()

SLUG_RE = re.compile(r"^[a-z0-9-]{1,80}$")
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
        # Phase 0G: every read flows through places.placesGeo via the
        # canonical resolver. Response shape preserved for backward compat.
        if slug:
            loc = find_location(slug)
            if not loc:
                raise HTTPException(status_code=404, detail="Location not found")
            # Strip internal _id so the response shape matches the legacy
            # `_id: 0` projection callers were getting before.
            loc.pop("_id", None)
            return {"location": loc}

        if mode == "tags":
            pipeline = [
                {"$match": {"sourceProvenance.mukokoTags": {"$exists": True}}},
                {"$unwind": "$sourceProvenance.mukokoTags"},
                {"$group": {"_id": "$sourceProvenance.mukokoTags", "count": {"$sum": 1}}},
                {"$sort": {"count": -1}},
            ]
            tags_agg = list(places_geo_collection().aggregate(pipeline))
            return {"tags": {t["_id"]: t["count"] for t in tags_agg}}

        if mode == "stats":
            total = count_all_locations()
            coll = places_geo_collection()
            try:
                provinces = len(coll.distinct(
                    "sourceProvenance.mukokoProvince",
                    {"sourceProvenance.mukokoProvince": {"$ne": None}},
                ))
            except Exception:
                provinces = 0
            try:
                countries = len(coll.distinct("isoCode", {"isoCode": {"$ne": None}}))
            except Exception:
                countries = 0
            return {
                "totalLocations": total,
                "totalProvinces": provinces,
                "totalCountries": countries,
            }

        # List / filter mode (Phase 0G: all routes delegate to the resolver).
        if country:
            locs = find_locations_in_country(country, limit=limit)
            paged = locs[skip:skip + limit]
            for loc in paged:
                loc.pop("_id", None)
            return {"locations": paged, "total": len(locs), "limit": limit, "skip": skip}

        if tag:
            locs = find_locations_by_tag(tag, limit=limit + skip)
            paged = locs[skip:skip + limit]
            for loc in paged:
                loc.pop("_id", None)
            return {"locations": paged, "total": len(locs), "limit": limit, "skip": skip}

        locs = find_all_locations(limit=limit, skip=skip)
        for loc in locs:
            loc.pop("_id", None)
        total = count_all_locations()
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

    try:
        # Tag counts mode — aggregated from placesGeo mukokoTags (Phase 0G).
        if mode == "tags":
            pipeline = [
                {"$match": {"sourceProvenance.mukokoTags": {"$exists": True}}},
                {"$unwind": "$sourceProvenance.mukokoTags"},
                {"$group": {"_id": "$sourceProvenance.mukokoTags", "count": {"$sum": 1}}},
                {"$sort": {"count": -1}},
            ]
            tags_agg = list(places_geo_collection().aggregate(pipeline))
            return {"tags": {t["_id"]: t["count"] for t in tags_agg}}

        # Geospatial nearest (Phase 0G: placesGeo via $nearSphere).
        if lat and lon:
            lat_f = float(lat)
            lon_f = float(lon)
            try:
                docs = list(
                    places_geo_collection().find({
                        "geoType": {"$in": ["city", "town", "village"]},
                        "geo": {
                            "$nearSphere": {
                                "$geometry": {"type": "Point", "coordinates": [lon_f, lat_f]},
                                "$maxDistance": 100000,  # 100km
                            }
                        },
                    }).limit(limit)
                )
            except Exception:
                docs = []
            results = []
            for doc in docs:
                adapted = adapt_placesgeo_to_location(doc)
                if not adapted:
                    continue
                adapted.pop("_id", None)
                results.append(adapted)
            return {"locations": results, "total": len(results), "source": "mongodb"}

        # Text search
        if not q and not tag:
            raise HTTPException(status_code=400, detail="Provide q (search query) or tag (filter)")

        # Phase 0G: name regex against placesGeo for text search; tag-only
        # uses mukokoTags. Atlas Search will be reimplemented against
        # placesGeo in a follow-up.
        results: list[dict] = []
        source = "mongodb"

        if tag and not q:
            adapted = find_locations_by_tag(tag, limit=limit + skip)
            results = adapted[skip:skip + limit]
            for r in results:
                r.pop("_id", None)
        elif q:
            q_clean = q.strip()[:200]
            regex = {"$regex": re.escape(q_clean), "$options": "i"}
            query_filter = {
                "geoType": {"$in": ["city", "town", "village"]},
                "$or": [
                    {"name": regex},
                    {"slug": regex},
                    {"sourceProvenance.mukokoSlug": regex},
                ],
            }
            if tag:
                query_filter["sourceProvenance.mukokoTags"] = tag
            try:
                docs = list(
                    places_geo_collection().find(query_filter)
                    .sort([("name", 1)])
                    .skip(skip)
                    .limit(limit)
                    .max_time_ms(3000)
                )
            except Exception:
                docs = []
            for doc in docs:
                adapted = adapt_placesgeo_to_location(doc)
                if not adapted:
                    continue
                adapted.pop("_id", None)
                results.append(adapted)

        # If text search returned no results, fall back to Open-Meteo
        # geocoding API for address-level discovery (like Apple/Google Weather).
        # These are geocoded candidates — not yet in our DB.
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

        return {"locations": results, "total": len(results), "source": source}
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


class SlugCollisionError(Exception):
    """Raised when every disambiguation path is exhausted for a slug.

    When suburb- and road-enrichment both still collide with an existing
    record, the new location is almost certainly the *same* place — we must
    NEVER manufacture a fresh slug with a numeric suffix. The caller
    catches this exception and returns the existing record as a duplicate.
    """

    def __init__(self, existing_slug: str):
        super().__init__(f"Slug collision unresolvable; existing slug: {existing_slug}")
        self.existing_slug = existing_slug


def _resolve_slug_collision(slug: str, geocoded: dict) -> str:
    """Try suburb/road enriched slugs; raise SlugCollisionError if all fail.

    NEVER returns a numeric-suffixed slug. If both enrichment paths still
    collide, the caller should treat this as a duplicate and surface the
    existing record instead of creating a new one.

    Phase 0G: collision lookup uses ``places.placesGeo`` against the
    ``sourceProvenance.mukokoSlug`` stamped field, since that's the slug
    namespace mukoko-weather owns. Hash-suffixed platform slugs are not
    in scope — those are guaranteed unique by ``upsert_placesgeo_city``.
    """
    coll = places_geo_collection()
    if not coll.find_one({"sourceProvenance.mukokoSlug": slug}):
        return slug

    address = geocoded.get("nominatimAddress", {})
    location_name = geocoded.get("name", "").lower()
    # Try suburb-enriched slug
    suburb = address.get("suburb") or address.get("cityDistrict") or ""
    if suburb and suburb.lower() != location_name:
        enriched = _generate_slug(suburb, geocoded.get("country", ""))
        if not coll.find_one({"sourceProvenance.mukokoSlug": enriched}):
            return enriched
    # Try road-enriched slug
    road = address.get("road") or ""
    if road and road.lower() != location_name:
        enriched = _generate_slug(road, geocoded.get("country", ""))
        if not coll.find_one({"sourceProvenance.mukokoSlug": enriched}):
            return enriched
    # All enrichment paths exhausted — this is the same place. Never auto-suffix.
    raise SlugCollisionError(existing_slug=slug)


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
    """Check for existing locations within radius_km OR with same name+country.

    Phase 0G: queries ``places.placesGeo`` via the same dedup primitives the
    Phase 0E ``upsert_placesgeo_city`` helper uses, then adapts the result
    to the legacy LocationDoc shape so callers keep working unchanged.
    """
    try:
        parent_place_id = get_country_id(country) if country else None
        existing = find_nearby_placesgeo(
            lat=lat,
            lon=lon,
            max_distance_km=radius_km,
            name=name,
            parent_place_id=parent_place_id,
        )
        if existing:
            return adapt_placesgeo_to_location(existing)

        # Name + country fallback — catches same-named entries farther apart.
        if name and country:
            try:
                doc = places_geo_collection().find_one({
                    "name": {"$regex": f"^{re.escape(name)}$", "$options": "i"},
                    "isoCode": country.upper(),
                })
                if doc:
                    return adapt_placesgeo_to_location(doc)
            except Exception:
                pass

        return None
    except Exception:
        return None


def _match_nearby_poi(lat: float, lon: float) -> dict | None:
    """Best-effort nearest-POI lookup against ``places.places``.

    Returns ``{"name": str, "poiType": str | None}`` when a *named* POI exists
    within ``POI_MATCH_RADIUS_KM`` (≤250 m) of (lat, lon), else ``None``.

    A very close named POI (a school, hospital, market, park) gives a richer,
    more consistent location name than a raw reverse-geocode. This is
    intentionally tight — it is NOT a coarse distance-snap to far-away places.
    Wrapped so a POI-lookup failure never breaks location resolution: any
    error, missing index, or empty result falls through to ``None`` and the
    caller keeps its reverse-geocoded name.
    """
    try:
        poi = find_nearest_place(lat, lon, POI_MATCH_RADIUS_KM)
    except Exception:  # noqa: BLE001
        return None
    if not poi:
        return None
    name = (poi.get("name") or "").strip()
    if not name:
        return None
    return {"name": name, "poiType": poi_type_from_place(poi)}


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
        # There is deliberately NO distance-based nearest-snap for GPS.
        # Explicit "use my current location" (autoCreate=true) must resolve to
        # the user's EXACT reverse-geocoded place — a road, shop, address, or
        # suburb — never snap to a distant city. This mirrors how top weather
        # apps behave: they show where you actually are, not the nearest city.
        #
        # Find-only path (autoCreate=false, e.g. IP-geo lookups): best-effort
        # return the nearest EXISTING placesGeo entry, capped to a radius that
        # roughly matches IP-geolocation accuracy. IP-based lat/lon (e.g.
        # Vercel's x-vercel-ip-latitude/longitude) is a coarse ISP/datacenter
        # estimate that can be off by tens to a couple hundred km — but with no
        # cap at all, `$nearSphere` will always return SOME seed location, even
        # one on another continent, which then gets presented to the user as
        # "Taking you to {city}…". Cap it so a genuinely distant nearest match
        # falls through to the 404 below (told to retry with autoCreate=true /
        # the city chooser) instead of silently mislabeling the user's location.
        if not autoCreate:
            nearest = find_nearest_location(lat, lon, max_km=150)
            if nearest and nearest.get("slug"):
                nearest.pop("_id", None)
                return {
                    "nearest": nearest,
                    "redirectTo": f"/{nearest['slug']}",
                    "isNew": False,
                }

        # Auto-create if requested — only NOW do we call external APIs
        if autoCreate:
            geocoded = _reverse_geocode(lat, lon, zoom=18)
            if not geocoded:
                raise HTTPException(
                    status_code=422,
                    detail="Could not determine location name",
                )

            # ── POI refinement — prefer a very-close named POI (≤250 m) ──────
            # If the user is essentially standing on a named POI (school,
            # hospital, market, park), use its name/type instead of the raw
            # reverse-geocode — richer and consistent with the platform's POI
            # catalog. Best-effort; falls back to the reverse-geocode on miss.
            poi_match = _match_nearby_poi(lat, lon)
            poi_type = poi_match.get("poiType") if poi_match else None
            if poi_match:
                geocoded["name"] = poi_match["name"]

            # ── Tight duplicate check against placesGeo (Phase 0G) ───────────
            # ONLY a 1km same-name dedup. Anything wider would snap a specific
            # road/shop/address to a same-named entry up to that distance away,
            # re-introducing the coarse-snap bug this fix removes. Distinct
            # nearby places each resolve to their own fine-grained entry; only
            # the exact same spot (within 1km, same name) collapses to one.
            duplicate = _find_duplicate(
                lat, lon, DEDUP_RADIUS_KM,
                name=geocoded["name"], country=geocoded["country"],
            )
            if duplicate and duplicate.get("slug"):
                duplicate.pop("_id", None)
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

            try:
                slug = _resolve_slug_collision(slug, geocoded)
            except SlugCollisionError as exc:
                # Same place — surface the existing record instead of creating
                # a numeric-suffixed duplicate (Phase 0G: queried via placesGeo).
                existing = find_location(exc.existing_slug)
                if existing:
                    existing.pop("_id", None)
                    return {
                        "nearest": existing,
                        "redirectTo": f"/{existing['slug']}",
                        "isNew": False,
                    }
                # Existing record disappeared between checks — extremely unlikely.
                raise HTTPException(
                    status_code=409,
                    detail="Slug collision could not be resolved",
                )

            tags = _infer_tags(geocoded)

            # Phase 0G: write only to placesGeo. The legacy weather.locations
            # collection is being dropped; placesGeo is the canonical store
            # and the resolver bridges clean URL slugs back to it.
            try:
                placesgeo_doc = upsert_placesgeo_city(
                    name=geocoded["name"],
                    lat=lat,
                    lon=lon,
                    country_iso=geocoded["country"],
                    province=province,
                    elevation=elevation,
                    geo_type="city" if "city" in tags else "town",
                    mukoko_slug=slug,
                    mukoko_tags=tags,
                    mukoko_nominatim_address=geocoded.get("nominatimAddress"),
                    mukoko_poi_type=poi_type,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "Platform placesGeo write failed (geo autoCreate): %s", exc,
                )
                placesgeo_doc = None

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
            if poi_type:
                new_loc["poiType"] = poi_type

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

        # POI refinement — prefer a very-close named POI (≤250 m) over the raw
        # reverse-geocode (best-effort; falls back to the reverse-geocode name).
        poi_match = _match_nearby_poi(lat, lon)
        poi_type = poi_match.get("poiType") if poi_match else None
        if poi_match:
            geocoded["name"] = poi_match["name"]

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

        try:
            slug = _resolve_slug_collision(slug, geocoded)
        except SlugCollisionError as exc:
            # All enrichment paths collide — same place. Return the existing
            # record as a duplicate instead of creating a numeric-suffixed copy.
            # Phase 0G: existing record resolved via places.placesGeo.
            existing = find_location(exc.existing_slug)
            if existing:
                return {
                    "mode": "duplicate",
                    "existing": {
                        "slug": existing["slug"],
                        "name": existing.get("name", ""),
                        "province": existing.get("province", ""),
                        "country": existing.get("country", ""),
                    },
                    "message": (
                        f"A location already exists nearby: "
                        f"{existing.get('name', exc.existing_slug)}"
                    ),
                }
            raise HTTPException(
                status_code=409,
                detail="Slug collision could not be resolved",
            )

        province = geocoded.get("admin1") or geocoded.get("countryName", "")
        province_slug = _generate_province_slug(province, geocoded["country"])

        tags = _infer_tags(geocoded)

        # ── Platform integration — placesGeo write (Phase 0G) ────────────────
        # Phase 0G: ``weather.locations``, ``weather.countries``, and
        # ``weather.provinces`` are being dropped. ``places.placesGeo`` is
        # now the canonical store — every read flows through the resolver
        # and writes happen here exclusively. The Phase 0E helper performs
        # its own 5 km parent-scoped dedup, returns the existing doc with
        # ``wasExisting: True`` when it finds one, and patches mukokoSlug /
        # mukokoTags / nominatimAddress onto pre-existing entries so the TS
        # resolver can find them by clean URL slug.
        #
        # Fundi POI enrichment (``enqueue_fundi_seed``) stays disabled —
        # see Phase 0F note above. Re-enable behind a flag like
        # ``MUKOKO_ENRICH_POIS_VIA_FUNDI`` when the POI surface is wired up.
        places_geo_id: Optional[str] = None
        places_geo_slug: Optional[str] = None
        try:
            placesgeo_doc = upsert_placesgeo_city(
                name=geocoded["name"],
                lat=lat,
                lon=lon,
                country_iso=geocoded["country"],
                province=province,
                elevation=elevation,
                geo_type="city" if "city" in tags else "town",
                mukoko_slug=slug,
                mukoko_tags=tags,
                mukoko_nominatim_address=geocoded.get("nominatimAddress"),
                mukoko_poi_type=poi_type,
            )
            places_geo_id = placesgeo_doc.get("_id")
            places_geo_slug = placesgeo_doc.get("slug")
            if not placesgeo_doc.get("wasExisting"):
                logger.info(
                    "Created placesGeo entry %s for %s",
                    places_geo_id, geocoded["name"],
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "Platform placesGeo write failed: %s", exc,
            )

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

        # Enrich: resolve seasons for this country if not already known
        _enrich_location_with_ai(geocoded["country"], lat, lon)

        location_payload = {
            "slug": new_loc["slug"],
            "name": new_loc["name"],
            "province": new_loc["province"],
            "country": new_loc.get("country", geocoded["country"]),
            "lat": new_loc["lat"],
            "lon": new_loc["lon"],
            "elevation": new_loc["elevation"],
        }
        if poi_type:
            location_payload["poiType"] = poi_type

        return {
            "mode": "created",
            "location": location_payload,
            "placesGeoId": places_geo_id,
            "placesGeoSlug": places_geo_slug,
        }
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=500, detail="Failed to add location")
