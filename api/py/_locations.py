"""
Location endpoints — migrated from /api/locations, /api/search, /api/geo.

Handles location CRUD, search (text + geospatial), and geo-lookup.
"""

from __future__ import annotations

import asyncio
import difflib
import logging
import math
import re
import threading
import time
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

from ._http import get_http_client
from ._circuit_breaker import nominatim_breaker, open_meteo_breaker
from ._geohash import build_place_slug, build_smart_slug, normalise_osm_ref, slugify_name
from ._db import (
    get_db,
    check_rate_limit,
    enforce_rate_limit,
    places_geo_collection,
    is_valid_coords,
    SLUG_RE,
)
from ._seed_locations import nearest_seed, seed_in_country, seed_matching
from ._places_resolver import (
    adapt_placesgeo_to_location,
    count_all_locations,
    find_all_locations,
    find_location,
    find_locations_by_tag,
    find_locations_in_country,
    find_nearest_location,
    find_nearest_locations,
    is_synthesized_spot,
    search_locations_by_name,
)
from ._places_geo import (
    find_nearby_placesgeo,
    find_nearest_place,
    poi_type_from_place,
    find_placesgeo_by_osm_ref,
    upsert_placesgeo_city,
    get_country_id,
    normalize_name,
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
            # A spot slug with no record behind it is a coordinate, not a
            # catalogue place: say so, so callers never treat it as one.
            if is_synthesized_spot(loc):
                loc["synthesized"] = True
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


#: Below this many catalogue matches, /api/py/search adds geocoded candidates.
GEOCODE_TOP_UP_BELOW = 3

#: The geocoder is asked for this many times the wanted results, because area
#: hits (a country, a province) are dropped afterwards and must not eat a slot.
GEOCODE_OVERFETCH = 3
GEOCODE_MAX_COUNT = 100


def _geocode_fetch_count(wanted: int) -> int:
    return max(1, min(GEOCODE_MAX_COUNT, max(10, wanted * GEOCODE_OVERFETCH)))


#: A geocoded candidate within this distance of a catalogue match with the
#: same name is the same place, and is dropped from the top-up.
_GEOCODE_DUPLICATE_KM = 25.0


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


def _country_hit_codes(geocoded: list[dict]) -> list[str]:
    """ISO codes of the countries a geocoder answer named (``PCL*`` hits)."""
    codes: list[str] = []
    for g in geocoded:
        code = str(g.get("featureCode") or "").upper()
        cc = str(g.get("country") or "").upper()
        if code.startswith("PCL") and re.match(r"^[A-Z]{2}$", cc) and cc not in codes:
            codes.append(cc)
    return codes


def _geocoded_candidate(g: dict) -> dict:
    """Shape an Open-Meteo geocoding hit as a search result.

    The slug must render without a record behind it: the candidate is not in
    placesGeo, so a ``{name}-{country}`` slug (``london-gb``) 404s, which was
    every search hit outside the seeded geography. A spot slug carries its
    own coordinate, so the page renders anywhere and saving it works too.
    """
    return {
        "slug": (
            build_smart_slug(g["name"], g["lat"], g["lon"])
            or _generate_slug(g["name"], g.get("country", ""))
        ),
        "name": g["name"],
        "province": g.get("admin1", ""),
        "lat": g["lat"],
        "lon": g["lon"],
        "elevation": _clean_elevation(g.get("elevation")),
        "tags": [],
        "country": g.get("country", ""),
        "source": "geocoded",
    }


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in km (WGS 84 mean radius)."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371.0088 * 2 * math.asin(min(1.0, math.sqrt(a)))


#: Longest query the search endpoint accepts. Longer input is not a place
#: name, and the geocoder top-up would forward it to a third party.
MAX_SEARCH_QUERY_LENGTH = 100

#: Per-IP budget for the geocoder top-up (a third-party request per miss).
#: Cache hits are free. Over budget, search still answers from the
#: catalogue — the top-up is skipped, the request never fails.
GEOCODE_TOP_UP_RATE_LIMIT = 120
GEOCODE_TOP_UP_RATE_WINDOW_S = 3600

#: Per-instance cache of geocoder answers, keyed by normalised query + count.
GEOCODE_CACHE_TTL_S = 3600
GEOCODE_CACHE_MAX = 512
_geocode_cache: dict[tuple[str, int], tuple[float, list[dict]]] = {}


def _normalise_query(q: str) -> str:
    return " ".join((q or "").lower().split())


def _cached_forward_geocode(q: str, count: int, request: Request | None) -> list[dict]:
    """Forward-geocode ``q`` through the per-instance cache and the per-IP
    ``search-geocode`` budget. Returns [] when over budget (never raises)."""
    key = (_normalise_query(q), count)
    now = time.monotonic()
    hit = _geocode_cache.get(key)
    if hit and hit[0] > now:
        return hit[1]
    try:
        enforce_rate_limit(
            request, "search-geocode",
            GEOCODE_TOP_UP_RATE_LIMIT, GEOCODE_TOP_UP_RATE_WINDOW_S,
            require_ip=False,
        )
    except HTTPException:
        return []
    geocoded = _forward_geocode(q, count)
    if len(_geocode_cache) >= GEOCODE_CACHE_MAX:
        # Drop expired entries first, then the oldest insert.
        for k in [k for k, (exp, _) in _geocode_cache.items() if exp <= now]:
            _geocode_cache.pop(k, None)
        if len(_geocode_cache) >= GEOCODE_CACHE_MAX:
            _geocode_cache.pop(next(iter(_geocode_cache)), None)
    _geocode_cache[key] = (now + GEOCODE_CACHE_TTL_S, geocoded)
    return geocoded


def _duplicates_any(candidate: dict, existing: list[dict]) -> bool:
    name = normalize_name(candidate.get("name", ""))
    for e in existing:
        if normalize_name(e.get("name", "")) != name:
            continue
        try:
            km = haversine_km(
                float(candidate["lat"]), float(candidate["lon"]),
                float(e.get("lat")), float(e.get("lon")),
            )
        except (TypeError, ValueError, KeyError):
            continue
        if km <= _GEOCODE_DUPLICATE_KM:
            return True
    return False


# ---------------------------------------------------------------------------
# /api/py/search?mode=resolve — a bare place name in a URL (/koh-samui)
# ---------------------------------------------------------------------------

#: A URL naming a place we hold no record of (``/koh-samui``) is resolved
#: here to the best geocoder hit, which the proxy then redirects to as a spot
#: slug. It reuses the search top-up's upstream (Open-Meteo geocoding), its
#: breaker gate and its answer shape; only the budgets are its own, and
#: tighter, because bots probe URLs far more than people type searches.
#: Nothing is stored: the answer is a coordinate and a name.
RESOLVE_GEOCODE_COUNT = 10
RESOLVE_PER_IP = 15
#: Service-wide ceiling per hour on uncached resolves (the proxy is the
#: caller, so its per-IP bucket is its own egress IP; the proxy also meters
#: per visitor). Open-Meteo's free geocoder is for light, non-commercial use.
RESOLVE_GLOBAL = 300
RESOLVE_WINDOW_S = 3600
RESOLVE_CACHE_TTL_S = 6 * 3600
#: A miss is kept briefly: an empty answer can also be a geocoder hiccup.
RESOLVE_MISS_TTL_S = 600
RESOLVE_CACHE_MAX = 512
#: The best hit must resemble the name that was typed. The geocoder matches
#: loosely, and ``/admin`` must not become a village called Adamu.
RESOLVE_MIN_SIMILARITY = 0.6
RESOLVE_MIN_LENGTH = 3
RESOLVE_MAX_LENGTH = 60
_RESOLVE_QUERY_RE = re.compile(r"^[a-z0-9][a-z0-9 '\-]*$")

_resolve_cache: dict[str, tuple[float, str, Optional[dict]]] = {}
_resolve_lock = threading.Lock()


def _name_similarity(a: str, b: str) -> float:
    """0..1 similarity of two names after slugifying (case, accents, spacing)."""
    sa, sb = slugify_name(a), slugify_name(b)
    if not sa or not sb:
        return 0.0
    return difflib.SequenceMatcher(None, sa, sb).ratio()


def _remember_resolve(key: str, status: str, location: Optional[dict], ttl: float) -> None:
    now = time.monotonic()
    with _resolve_lock:
        if len(_resolve_cache) >= RESOLVE_CACHE_MAX:
            for k in [k for k, v in list(_resolve_cache.items()) if v[0] <= now]:
                _resolve_cache.pop(k, None)
            if len(_resolve_cache) >= RESOLVE_CACHE_MAX:
                try:
                    _resolve_cache.pop(next(iter(_resolve_cache)), None)
                except StopIteration:
                    pass
        _resolve_cache[key] = (now + ttl, status, location)


def resolve_bare_name(q: str, request: Request | None) -> dict:
    """Best place for a bare name, as ``{"status", "location"}``.

    ``status`` is ``ok`` (``location`` is a search-result shaped dict),
    ``no_match`` (a definitive "nothing by that name"), ``over_budget`` or
    ``unavailable`` (breaker open). Only ``ok`` and ``no_match`` are cached.
    Never raises; synchronous (it runs on a worker thread).
    """
    name = _normalise_query(q).replace("-", " ")
    if (
        not name
        or not (RESOLVE_MIN_LENGTH <= len(name) <= RESOLVE_MAX_LENGTH)
        or not _RESOLVE_QUERY_RE.match(name.replace(" ", ""))
        or name.replace(" ", "").isdigit()
    ):
        return {"status": "no_match", "location": None}
    key = name
    now = time.monotonic()
    with _resolve_lock:
        hit = _resolve_cache.get(key)
    if hit and hit[0] > now:
        return {"status": hit[1], "location": dict(hit[2]) if hit[2] else None}
    if not open_meteo_breaker.is_allowed:
        return {"status": "unavailable", "location": None}
    try:
        enforce_rate_limit(
            request, "slug-geocode", RESOLVE_PER_IP, RESOLVE_WINDOW_S,
            require_ip=False,
        )
        if not check_rate_limit(
            "all", "slug-geocode-global", RESOLVE_GLOBAL, RESOLVE_WINDOW_S,
        )["allowed"]:
            return {"status": "over_budget", "location": None}
    except HTTPException:
        return {"status": "over_budget", "location": None}

    geocoded = _forward_geocode(name, RESOLVE_GEOCODE_COUNT)
    usable = [
        g for g in geocoded
        if g.get("name") and _name_similarity(name, g["name"]) >= RESOLVE_MIN_SIMILARITY
        and is_valid_coords(g.get("lat", 0), g.get("lon", 0))
    ]
    # A place beats an area (a province or country centroid), but an area is
    # still better than nothing: any name on the map renders weather.
    usable.sort(key=lambda g: is_area_feature(g.get("featureCode")))
    if not usable:
        _remember_resolve(key, "no_match", None, RESOLVE_MISS_TTL_S)
        return {"status": "no_match", "location": None}
    best = usable[0]
    cand = _geocoded_candidate(best)
    if is_area_feature(best.get("featureCode")):
        cand["area"] = True
    else:
        # A shipped seed city is the same place: its canonical slug.
        seed = seed_matching(cand["name"], cand["lat"], cand["lon"], max_km=_GEOCODE_DUPLICATE_KM)
        if seed:
            cand = seed
    _remember_resolve(key, "ok", cand, RESOLVE_CACHE_TTL_S)
    return {"status": "ok", "location": dict(cand)}


@router.get("/api/py/search")
async def search_locations(
    q: str = "",
    tag: str | None = None,
    lat: str | None = None,
    lon: str | None = None,
    mode: str | None = None,
    limit: int = 20,
    skip: int = 0,
    request: Request = None,
):
    """
    GET /api/py/search?q=harare
    GET /api/py/search?tag=farming
    GET /api/py/search?lat=-17.83&lon=31.05
    GET /api/py/search?mode=tags
    GET /api/py/search?q=koh-samui&mode=resolve   (one best place, for URLs)
    """
    limit = max(1, min(limit, 50))
    skip = max(0, skip)
    q = (q or "").strip()
    if len(q) > MAX_SEARCH_QUERY_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"q too long (max {MAX_SEARCH_QUERY_LENGTH} characters)",
        )

    try:
        # Bare place name from a URL (/koh-samui): the best geocoder hit, for
        # the proxy to redirect to. Off the event loop (sync httpx). Always 200.
        if mode == "resolve":
            if not q:
                raise HTTPException(status_code=400, detail="Provide q (the place name)")
            answer = await asyncio.to_thread(resolve_bare_name, q, request)
            found = answer["location"]
            return {
                "locations": [found] if found else [],
                "total": 1 if found else 0,
                "source": "geocoded" if found else "none",
                "resolve": answer["status"],
            }

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

        # Geospatial nearest — canonical proximity query in _places_resolver.
        # 100km radius: wider than the 50km default since search-by-coords is
        # an explicit discovery action, not an accuracy-sensitive geo lookup.
        if lat and lon:
            results = find_nearest_locations(float(lat), float(lon), limit=limit, max_km=100)
            for r in results:
                r.pop("_id", None)
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
            results = search_locations_by_name(q, limit=limit, skip=skip, tag=tag)

        # Top up a thin (or empty) catalogue answer with Open-Meteo geocoding
        # for address-level discovery anywhere on Earth (like Apple/Google
        # Weather). The platform geography is still mostly African, so a
        # search for "Victoria" must not stop at the one we hold when the
        # visitor means Victoria, BC. These candidates are not in our DB yet.
        if (
            q and not tag and skip == 0
            and len(results) < GEOCODE_TOP_UP_BELOW
            # Same upstream as the forecast: skip while its breaker is open.
            # Failures are not recorded here — a geocoding hiccup must never
            # open the breaker that gates the forecast.
            and open_meteo_breaker.is_allowed
        ):
            # Off the event loop: this runs on most quick-search keystrokes
            # outside the stored geography, and httpx here is synchronous.
            # Cached per instance and budgeted per IP (``search-geocode``):
            # each miss is a request to a third-party geocoder.
            geocoded = await asyncio.to_thread(
                _cached_forward_geocode, q, _geocode_fetch_count(limit), request,
            )
            extra: list[dict] = []
            # A country is not a place: offer the places we hold in it
            # (cities first) instead of its centroid.
            for cc in _country_hit_codes(geocoded):
                in_country = await asyncio.to_thread(
                    find_locations_in_country, cc, limit=limit,
                )
                if not in_country:
                    # placesGeo holds no places for this country (it mostly
                    # covers Africa): the static seed catalogue does.
                    in_country = seed_in_country(cc, limit=limit)
                in_country.sort(key=lambda loc: "city" not in (loc.get("tags") or []))
                for loc in in_country:
                    loc.pop("_id", None)
                    if not any(r.get("slug") == loc.get("slug") for r in results + extra):
                        extra.append(loc)
            places = [g for g in geocoded if not is_area_feature(g.get("featureCode"))]
            for c in (_geocoded_candidate(g) for g in places):
                # A shipped seed city is the same place: offer its canonical
                # slug (phuket-th), not a spot beside it.
                seed = seed_matching(c["name"], c["lat"], c["lon"], max_km=_GEOCODE_DUPLICATE_KM)
                if seed:
                    c = seed
                # Against the catalogue AND the candidates already kept: the
                # geocoder can return one town twice (two admin entries).
                if any(r.get("slug") == c.get("slug") for r in results + extra):
                    continue
                if not _duplicates_any(c, results + extra):
                    extra.append(c)
            extra = extra[: max(0, limit - len(results))]
            if any(e.get("source") == "geocoded" for e in extra):
                source = "geocoded" if not results else "mixed"
            results = results + extra

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


# ---------------------------------------------------------------------------
# /api/py/geo find-only fallback — name the spot on demand (#302)
# ---------------------------------------------------------------------------

#: Find-only answers are snapped to this grid (~1.1 km) before naming: the
#: answer stands for "around here", one cell shares one upstream lookup, and
#: an exact position never leaves the request.
FIND_ONLY_SNAP_DEG = 0.01

#: Per-IP and service-wide budgets for the find-only reverse geocode. Over
#: either, the endpoint answers 404 as it did before (never a 429).
FIND_ONLY_GEOCODE_PER_IP = 30
FIND_ONLY_GEOCODE_GLOBAL = 900  # ≈ one request per 4 s, inside OSM's policy
FIND_ONLY_GEOCODE_WINDOW_S = 3600

#: Per-instance cache of find-only names, keyed by the snapped cell. Misses
#: (no name) are kept for a shorter time than hits.
FIND_ONLY_CACHE_TTL_S = 6 * 3600
FIND_ONLY_MISS_TTL_S = 600
FIND_ONLY_CACHE_MAX = 1024
_find_only_cache: dict[tuple[float, float], tuple[float, Optional[dict]]] = {}
#: ``_find_only_spot`` runs on worker threads (``asyncio.to_thread``), so the
#: cache is read and mutated under a lock.
_find_only_lock = threading.Lock()

#: A seed place this close to the point is "the same city": find-only answers
#: with it, so one city has one URL (``phuket-th``, not a spot beside it).
FIND_ONLY_SEED_KM = 50.0


def _snap(value: float) -> float:
    return round(round(value / FIND_ONLY_SNAP_DEG) * FIND_ONLY_SNAP_DEG, 2)


def _find_only_spot(lat: float, lon: float, request: Request | None) -> Optional[dict]:
    """A named spot near (lat, lon) when no stored place is near, or None.

    The find-only path must answer for any coordinate on Earth (the owner
    rule: what is not stored is fetched), but it must stay cheap and must not
    create records from a coarse IP position. So it names the snapped cell
    with one city-level (zoom 10) Nominatim reverse geocode and returns a
    spot (``{name}--{geohash}``), which renders from its slug alone. Nothing
    is written: a GPS caller is told ``synthesized: true`` and escalates to
    ``autoCreate=true``, which stores the exact place.

    Bounded by a per-instance cell cache, a per-IP and a service-wide budget
    and ``nominatim_breaker``. Never raises.
    """
    cell = (_snap(lat), _snap(lon))
    now = time.monotonic()
    with _find_only_lock:
        hit = _find_only_cache.get(cell)
    if hit and hit[0] > now:
        return dict(hit[1]) if hit[1] else None
    if not nominatim_breaker.is_allowed:
        return None
    try:
        enforce_rate_limit(
            request, "geo-find-geocode",
            FIND_ONLY_GEOCODE_PER_IP, FIND_ONLY_GEOCODE_WINDOW_S,
            require_ip=False,
        )
        if not check_rate_limit(
            "all", "geo-find-geocode-global",
            FIND_ONLY_GEOCODE_GLOBAL, FIND_ONLY_GEOCODE_WINDOW_S,
        )["allowed"]:
            return None
    except HTTPException:
        return None

    report: dict = {}
    named = _reverse_geocode_nominatim(cell[0], cell[1], zoom=10, report=report)
    kind = report.get("kind")
    if kind == NOMINATIM_UPSTREAM:
        # Only an outage (5xx, transport error, timeout) opens the breaker;
        # a 4xx (including our own 429) or a "nothing here" answer does not.
        nominatim_breaker.record_failure()
    elif kind in (NOMINATIM_OK, NOMINATIM_NOTHING_HERE):
        nominatim_breaker.record_success()
    if named is None:
        _remember_find_only(cell, None, FIND_ONLY_MISS_TTL_S)
        return None
    name = (named.get("name") or "").strip()
    if name.lower() == "unknown":
        name = ""  # the extractor's last-resort placeholder, not a place name
    slug = build_smart_slug(name, cell[0], cell[1]) if name else ""
    if not slug:
        _remember_find_only(cell, None, FIND_ONLY_MISS_TTL_S)
        return None
    spot = {
        "slug": slug,
        "name": name,
        "province": named.get("admin1") or "",
        "country": named.get("country") or "",
        "lat": cell[0],
        "lon": cell[1],
        # Nothing measured it: None (never a fake 0 m), flagged approximate.
        # The forecast carries the model's own terrain height.
        "elevation": None,
        "elevationApproximate": True,
        "tags": [],
        "source": "geolocation",
        "synthesized": True,
    }
    _remember_find_only(cell, spot, FIND_ONLY_CACHE_TTL_S)
    return dict(spot)


def _remember_find_only(cell: tuple[float, float], spot: Optional[dict], ttl: float) -> None:
    now = time.monotonic()
    with _find_only_lock:
        if len(_find_only_cache) >= FIND_ONLY_CACHE_MAX:
            for k in [k for k, (exp, _) in list(_find_only_cache.items()) if exp <= now]:
                _find_only_cache.pop(k, None)
            if len(_find_only_cache) >= FIND_ONLY_CACHE_MAX:
                try:
                    _find_only_cache.pop(next(iter(_find_only_cache)), None)
                except StopIteration:
                    pass
        _find_only_cache[cell] = (now + ttl, spot)


@router.get("/api/py/geo")
async def geo_lookup(
    lat: float,
    lon: float,
    autoCreate: bool = False,
    request: Request = None,
):
    """
    GET /api/py/geo?lat=-17.83&lon=31.05&autoCreate=true

    Find nearest location or auto-create one via reverse geocoding.
    """
    try:
        # Rate limit auto-create only — it's the expensive path (reverse
        # geocode + elevation lookup + DB write), same cost as
        # POST /api/py/locations/add's coordinates mode, which this mirrors.
        # The find-only path stays unlimited since it's a cheap read.
        if autoCreate:
            enforce_rate_limit(request, "location-create", 5, 3600, require_ip=False)

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
            # Nothing stored within 150 km (most of the world outside the
            # platform geography). A shipped seed city nearby is the same
            # city, so one city has one URL (Phuket is /phuket-th).
            seed = nearest_seed(lat, lon, max_km=FIND_ONLY_SEED_KM) if is_valid_coords(lat, lon) else None
            if seed:
                return {
                    "nearest": seed,
                    "redirectTo": f"/{seed['slug']}",
                    "isNew": False,
                }
            # Otherwise name the spot on demand instead of a 404.
            if is_valid_coords(lat, lon):
                spot = await asyncio.to_thread(_find_only_spot, lat, lon, request)
                if spot:
                    return {
                        "nearest": spot,
                        "redirectTo": f"/{spot['slug']}",
                        "isNew": False,
                        "synthesized": True,
                    }

        # Auto-create if requested — only NOW do we call external APIs.
        # The full reverse-geocode → dedupe → create sequence is shared with
        # POST /api/py/locations/add via _create_location_from_coords; this
        # handler only maps the result to the geo-lookup response shape.
        if autoCreate:
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
