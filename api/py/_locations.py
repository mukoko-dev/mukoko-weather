"""
Location creation endpoints (the read routes are gone: #333).

``GET /api/py/locations``, ``GET /api/py/search`` and the find-only half of
``GET /api/py/geo`` are served by the Rust places Worker
(``https://weather-api.mukoko.com/v1/locations|search|geo``, source in
``workers/places``). What remains here is the community-location creation path:
``GET /api/py/geo?autoCreate=true`` and ``POST /api/py/locations/add``.
"""

from __future__ import annotations

import logging
import re
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

logger = logging.getLogger(__name__)

from ._http import get_http_client
from ._geohash import build_place_slug, build_smart_slug
from ._db import (
    get_db,
    enforce_rate_limit,
    places_geo_collection,
    is_valid_coords,
)
from ._places_resolver import (
    adapt_placesgeo_to_location,
    find_location,
)
from ._places_geo import (
    find_nearby_placesgeo,
    find_nearest_place,
    poi_type_from_place,
    find_placesgeo_by_osm_ref,
    upsert_placesgeo_city,
    get_country_id,
    POI_MATCH_RADIUS_KM,
)

router = APIRouter()

#: Nominatim / Open-Meteo geocoding timeout (seconds).
GEOCODE_TIMEOUT_S = 5.0

# City-states where state/province fields are meaningless (postal codes or same as country).
# For these, province is derived from district-level fields (city_district, suburb, etc.).
_CITY_STATES = {"SG", "MC", "VA", "GI", "SM", "AD", "LI", "MT", "BN", "DJ", "BH", "QA", "KW"}


def _get_http() -> httpx.Client:
    return get_http_client(GEOCODE_TIMEOUT_S)


# ---------------------------------------------------------------------------
# Geocoder helpers (used by the add-location search mode)
# ---------------------------------------------------------------------------

#: The geocoder is asked for this many times the wanted results, because area
#: hits (a country, a province) are dropped afterwards and must not eat a slot.
GEOCODE_OVERFETCH = 3
GEOCODE_MAX_COUNT = 100


def _geocode_fetch_count(wanted: int) -> int:
    return max(1, min(GEOCODE_MAX_COUNT, max(10, wanted * GEOCODE_OVERFETCH)))


#: GeoNames feature codes (Open-Meteo's geocoder reports them) for areas, not
#: places: countries and other political entities (``PCL*``), territories,
#: continents, oceans, seas and regions. Their coordinate is a centroid, so a
#: forecast there describes nowhere anyone is (searching "Thailand" offered a
#: page for 15.5°N 101°E). Search never offers them as places (#302).
_AREA_FEATURE_CODES = frozenset({
    "TERR", "CONT", "OCN", "SEA", "RGN", "RGNE", "PRSH",
    "ADM1", "ADM2", "ADM1H", "ADM2H",
})


def is_area_feature(feature_code: str | None) -> bool:
    """True for a geocoder hit that names an area, not a place.

    Besides countries (``PCL*``), this covers first- and second-order
    administrative divisions (``ADM1``, ``ADM2`` and their historical ``H``
    forms: "Phuket Province" is a centroid too) and parishes (``PRSH``).
    Lower orders (``ADM3``, ``ADM4``, ``ADMD``) are often real towns and stay.
    """
    code = (feature_code or "").strip().upper()
    return code.startswith("PCL") or code in _AREA_FEATURE_CODES


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
    """Name a coordinate: Overpass first, Nominatim as fallback.

    Overpass queries OSM directly, so it answers "what is actually at this
    point" instead of reconstructing it from a postal address, and its
    ``is_in`` lookup returns the enclosing admin boundaries (country, province)
    in the same round trip. See ``api/py/_overpass.py`` for why that replaces
    shipping our own GeoJSON boundary dataset.

    Nominatim still backs it up: Overpass returns nothing for genuinely empty
    coordinates and its public instances are routinely busy, and neither case
    should cost the user their location. A missing ``nominatimAddress`` on the
    Overpass path is expected — that field is Nominatim's structured-address
    view and has no Overpass equivalent; downstream consumers already treat it
    as optional.
    """
    from ._overpass import reverse_name as _overpass_reverse_name

    try:
        via_overpass = _overpass_reverse_name(lat, lon)
    except Exception:
        via_overpass = None

    # Only accept it when it actually produced a name — admin context alone is
    # thinner than what Nominatim would give us for the same point.
    if via_overpass and via_overpass.get("name"):
        result = dict(via_overpass)
        result["admin1"] = _normalize_admin1(
            {"state": result.get("admin1", "")},
            result.get("country", ""),
            result.get("countryName", ""),
        )
        return result

    return _reverse_geocode_nominatim(lat, lon, zoom=zoom)


#: ``report["kind"]`` outcomes of ``_reverse_geocode_nominatim``. Only
#: ``upstream`` (5xx, transport errors, timeouts) is an outage; a 4xx
#: is our request and ``nothing_here`` is a healthy "no address" answer.
NOMINATIM_OK = "ok"
NOMINATIM_UPSTREAM = "upstream"
NOMINATIM_CLIENT_ERROR = "client_error"
NOMINATIM_NOTHING_HERE = "nothing_here"


def _reverse_geocode_nominatim(
    lat: float, lon: float, *, zoom: int = 14, report: dict | None = None,
) -> dict | None:
    """Reverse geocode using Nominatim.

    A body with an ``error`` (Nominatim's "Unable to geocode") or no
    ``address`` names nothing and returns None. When ``report`` is given it
    receives ``kind`` (``NOMINATIM_*``) so a caller can tell an outage (which
    belongs to a circuit breaker) from a 4xx or an empty answer (which does not).

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
            if report is not None:
                # 5xx is an outage; 4xx (incl. 429, our own rate) is not.
                report["kind"] = (
                    NOMINATIM_UPSTREAM if resp.status_code >= 500 else NOMINATIM_CLIENT_ERROR
                )
            return None

        data = resp.json()
        address = data.get("address") if isinstance(data, dict) else None
        if not isinstance(data, dict) or data.get("error") or not address:
            if report is not None:
                report["kind"] = NOMINATIM_NOTHING_HERE
            return None
        if report is not None:
            report["kind"] = NOMINATIM_OK

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
        # Transport error, timeout or an unparseable body.
        if report is not None and report.get("kind") != NOMINATIM_OK:
            report["kind"] = NOMINATIM_UPSTREAM
        return None


def _clean_elevation(value) -> float | None:
    """A geocoder elevation in metres, or None when it is missing or
    Open-Meteo's ``-9999`` "no data" placeholder (seen on London, Equatorial
    Guinea) (anything at or below -1000 m: the lowest
    land on Earth, the Dead Sea shore, is about -430 m)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value != value or value <= -1000:  # NaN or the placeholder
        return None
    return value


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
                "elevation": _clean_elevation(r.get("elevation")),
                "featureCode": r.get("feature_code", ""),
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


# Dedup radius — tight because location names are now specific (POIs, addresses,
# suburbs). Two different places 2km apart are legitimately different locations.
DEDUP_RADIUS_KM = 1


def _find_duplicate(
    lat: float,
    lon: float,
    radius_km: float = DEDUP_RADIUS_KM,
    name: str | None = None,
    country: str | None = None,
    osm_ref: str | None = None,
) -> dict | None:
    """Check whether this place is already on record.

    Phase 0G: queries ``places.placesGeo`` via the same dedup primitives the
    Phase 0E ``upsert_placesgeo_city`` helper uses, then adapts the result
    to the legacy LocationDoc shape so callers keep working unchanged.

    Order matters and mirrors ``upsert_placesgeo_city`` exactly, so the gate
    here and the upsert's own dedup can never disagree about what counts as
    the same place:

      1. ``osm_ref`` exact match — the map's identity for this feature.
      2. proximity + normalised name, with the ref veto (a nearby record
         carrying a different ref is a different feature).
      3. same name + country anywhere — catches same-named entries whose
         stored coordinates sit outside ``radius_km``. Skipped once we hold
         a ref, since a ref miss at step 1 already means the map considers
         this a feature we have not stored, and a bare name match would
         otherwise collapse two genuinely distinct same-named features.
    """
    try:
        parent_place_id = get_country_id(country) if country else None

        if osm_ref:
            by_ref = find_placesgeo_by_osm_ref(osm_ref)
            if by_ref:
                return adapt_placesgeo_to_location(by_ref)

        existing = find_nearby_placesgeo(
            lat=lat,
            lon=lon,
            max_distance_km=radius_km,
            name=name,
            parent_place_id=parent_place_id,
            osm_ref=osm_ref,
        )
        if existing:
            return adapt_placesgeo_to_location(existing)

        # Name + country fallback — catches same-named entries farther apart.
        if name and country and not osm_ref:
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

    Callers use only ``poiType`` (school/hospital/market/park) as
    supplementary context for the location page + AI summary — e.g. "near a
    school". They must NOT use ``name`` to replace the reverse-geocoded
    road/address: this lookup runs on passive GPS/coordinate detection, not
    a search-and-pick flow, so the user never chose this specific POI —
    presenting it as their location name is confusing when it's merely
    nearby. Wrapped so a POI-lookup failure never breaks location
    resolution: any error, missing index, or empty result falls through to
    ``None``.
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


def _create_location_from_coords(lat: float, lon: float, *, source: str) -> dict:
    """Shared location-creation sequence for coordinates.

    The single implementation behind both GET /api/py/geo?autoCreate=true and
    POST /api/py/locations/add's coordinates mode: reverse-geocode (zoom 18) →
    POI context → duplicate gate → slug/elevation/province resolution →
    placesGeo upsert → AI season enrichment. The two route handlers only
    differ in response shape and ``source`` tag, so any change to the create
    flow lands in both paths by construction.

    Returns one of:
      * ``{"status": "created", "location": {...}, "placesGeoId": ...,
        "placesGeoSlug": ...}``
      * ``{"status": "duplicate", "existing": {...}}`` — an adapted location
        doc (always slug-bearing) for the already-existing place.

    Raises ``HTTPException(422)`` when reverse geocoding can't name the spot
    and ``HTTPException(409)`` when a slug collision can't be resolved.
    """
    geocoded = _reverse_geocode(lat, lon, zoom=18)
    if not geocoded:
        raise HTTPException(status_code=422, detail="Could not determine location name")

    # POI context — nearby named POI (≤250 m) as metadata only. These are
    # passive coordinates, not a search-and-pick flow, so a nearby POI's name
    # must never replace the reverse-geocoded road/address — only its
    # `poiType` (school/hospital/market/park) is surfaced as context.
    poi_match = _match_nearby_poi(lat, lon)
    poi_type = poi_match.get("poiType") if poi_match else None

    # Tight duplicate gate (1km + same-name, country-scoped). A match without
    # a slug is NOT returned as a duplicate — creation proceeds and the
    # placesGeo upsert below patches the mukoko slug onto that existing doc,
    # which is what makes it resolvable in the first place.
    osm_ref = geocoded.get("osmRef")
    duplicate = _find_duplicate(
        lat, lon, DEDUP_RADIUS_KM,
        name=geocoded["name"], country=geocoded["country"],
        osm_ref=osm_ref,
    )
    if duplicate and duplicate.get("slug"):
        return {"status": "duplicate", "existing": duplicate}

    elevation = geocoded.get("elevation", 0) or 0
    if not elevation:
        elevation = _get_elevation(lat, lon)

    # Identity comes from the map when the map knows this feature.
    #
    #   place  `{name}--osm-w890123`  a named OSM feature. Stable across visits
    #          and across GPS jitter, and DISTINCT from its neighbours — which
    #          is what lets a person save Canberra Residences and Visionaire
    #          separately even though they are metres apart.
    #   spot   `{name}--{geohash}`    a bare coordinate, for somewhere the map
    #          has nothing on (a paddock, a farm boundary).
    #
    # Coordinate-derived identity cannot do the first job: a cell coarse enough
    # to absorb GPS jitter also merges neighbouring places, and one fine enough
    # to separate them changes on every fix. See src/lib/place-ref.ts.
    slug = (
        (build_place_slug(geocoded["name"], osm_ref) if osm_ref else "")
        or build_smart_slug(geocoded["name"], lat, lon)
        or _generate_slug(geocoded["name"], geocoded["country"])
    )
    try:
        slug = _resolve_slug_collision(slug, geocoded)
    except SlugCollisionError as exc:
        # Same place — surface the existing record instead of creating a
        # numeric-suffixed duplicate (Phase 0G: resolved via placesGeo).
        existing = find_location(exc.existing_slug)
        if existing:
            return {"status": "duplicate", "existing": existing}
        # Existing record disappeared between checks — extremely unlikely.
        raise HTTPException(status_code=409, detail="Slug collision could not be resolved")

    province = geocoded.get("admin1") or geocoded.get("countryName", "")
    province_slug = _generate_province_slug(province, geocoded["country"])
    tags = _infer_tags(geocoded)

    # Phase 0G: write only to placesGeo — the canonical store; the resolver
    # bridges clean URL slugs back to it. The upsert dedups with the SAME
    # radius as the duplicate gate above (dedup_radius_km=DEDUP_RADIUS_KM) so
    # the two checks can't disagree — a wider internal radius used to alias a
    # new fine-grained place onto a different same-named doc a few km away.
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
            dedup_radius_km=DEDUP_RADIUS_KM,
            mukoko_slug=slug,
            mukoko_tags=tags,
            mukoko_nominatim_address=geocoded.get("nominatimAddress"),
            mukoko_poi_type=poi_type,
            osm_ref=osm_ref,
        )
        places_geo_id = placesgeo_doc.get("_id")
        places_geo_slug = placesgeo_doc.get("slug")
        if not placesgeo_doc.get("wasExisting"):
            # Log only the opaque UUID — the reverse-geocoded name at zoom 18
            # can be a user's street address, which must not land in logs.
            logger.info("Created placesGeo entry %s (%s)", places_geo_id, source)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Platform placesGeo write failed (%s): %s", source, exc)

    new_loc = {
        "slug": slug,
        "name": geocoded["name"],
        "province": province,
        "lat": geocoded["lat"],
        "lon": geocoded["lon"],
        "elevation": round(elevation),
        "tags": tags,
        "country": geocoded["country"],
        "source": source,
        "provinceSlug": province_slug,
        "geo": {"type": "Point", "coordinates": [geocoded["lon"], geocoded["lat"]]},
        "nominatimAddress": geocoded.get("nominatimAddress", {}),
    }
    if poi_type:
        new_loc["poiType"] = poi_type

    # Enrich: resolve seasons for this country if not already known
    _enrich_location_with_ai(geocoded["country"], lat, lon)

    return {
        "status": "created",
        "location": new_loc,
        "placesGeoId": places_geo_id,
        "placesGeoSlug": places_geo_slug,
    }


@router.get("/api/py/geo")
async def geo_lookup(
    lat: float,
    lon: float,
    autoCreate: bool = False,
    request: Request = None,
):
    """
    GET /api/py/geo?lat=-17.83&lon=31.05&autoCreate=true

    Auto-create a community location via reverse geocoding. The find-only
    half (``autoCreate`` absent) moved to the Rust places Worker, which
    answers it for any coordinate on Earth:
    ``GET https://weather-api.mukoko.com/v1/geo?lat=&lon=``.
    """
    try:
        if not autoCreate:
            raise HTTPException(
                status_code=404,
                detail=(
                    "Find-only geo lookup moved to "
                    "https://weather-api.mukoko.com/v1/geo"
                ),
            )

        # Rate limit: the expensive path (reverse geocode + elevation lookup +
        # DB write), same cost as POST /api/py/locations/add's coordinates mode.
        enforce_rate_limit(request, "location-create", 5, 3600, require_ip=False)

        # There is deliberately NO distance-based nearest-snap for GPS.
        # Explicit "use my current location" (autoCreate=true) must resolve to
        # the user's EXACT reverse-geocoded place: a road, shop, address, or
        # suburb, never snap to a distant city. This mirrors how top weather
        # apps behave: they show where you actually are, not the nearest city.
        #
        # The full reverse-geocode, dedupe and create sequence is shared with
        # POST /api/py/locations/add via _create_location_from_coords; this
        # handler only maps the result to the geo-lookup response shape.
        result = _create_location_from_coords(lat, lon, source="geolocation")
        if result["status"] == "duplicate":
            existing = result["existing"]
            existing.pop("_id", None)
            return {
                "nearest": existing,
                "redirectTo": f"/{existing['slug']}",
                "isNew": False,
            }
        new_loc = result["location"]
        return {
            "nearest": new_loc,
            "redirectTo": f"/{new_loc['slug']}",
            "isNew": True,
        }
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
    background thread so the HTTP response is not blocked by the AI model
    call (~5-15s). If AI is unavailable, season data will be resolved on
    the next weather request via _get_season().
    """
    import threading

    # Deliberately log no request-derived values: everything here (country,
    # coords, name) traces back to the user's GPS position, which must not
    # land in logs (CodeQL: clear-text logging of private data).
    logger.info("Starting AI location enrichment")

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

            # Over-fetch: area hits are dropped below and must not eat a slot.
            results = [
                r for r in _forward_geocode(query, count=_geocode_fetch_count(5))
                if not is_area_feature(r.get("featureCode"))
            ][:5]

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
                        "elevation": _clean_elevation(r.get("elevation")),
                    }
                    for r in results
                ],
            }

        # Mode 2: Coordinates
        lat = float(body.get("lat", 0))
        lon = float(body.get("lon", 0))

        if not is_valid_coords(lat, lon):
            raise HTTPException(status_code=400, detail="Invalid coordinates")

        # Rate limit — extract real IP behind Vercel's reverse proxy
        enforce_rate_limit(request, "location-create", 5, 3600, require_ip=False)

        # Reverse-geocode → dedupe → create — shared with GET /api/py/geo's
        # autoCreate path via _create_location_from_coords; this handler only
        # maps the result to the add-location response shape.
        result = _create_location_from_coords(lat, lon, source="community")
        if result["status"] == "duplicate":
            existing = result["existing"]
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
                    f"{existing.get('name', existing['slug'])}"
                ),
            }

        new_loc = result["location"]
        location_payload = {
            "slug": new_loc["slug"],
            "name": new_loc["name"],
            "province": new_loc["province"],
            "country": new_loc["country"],
            "lat": new_loc["lat"],
            "lon": new_loc["lon"],
            "elevation": new_loc["elevation"],
        }
        if new_loc.get("poiType"):
            location_payload["poiType"] = new_loc["poiType"]

        return {
            "mode": "created",
            "location": location_payload,
            "placesGeoId": result["placesGeoId"],
            "placesGeoSlug": result["placesGeoSlug"],
        }
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=500, detail="Failed to add location")
