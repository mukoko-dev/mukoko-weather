"""Overpass-backed naming for bare coordinates.

Why this exists
---------------
Naming a coordinate used to go through Nominatim's ``/reverse``, which returns a
postal-address view of a point. ``_extract_location_name`` then tried to
reconstruct "what is actually here" out of address fields — a POI name if the
address happened to carry one, else a suburb, else a road, else a city. It is an
approximation of a question Nominatim was not built to answer.

Overpass answers it directly. It queries OSM itself, so we can ask for named
features within a radius *and* the administrative areas containing the point in
a single round trip:

* ``nwr(around:R,lat,lon)[name]`` — every named node/way/relation nearby, with
  its raw OSM tags, so we can rank a school above the street it sits on.
* ``is_in(lat,lon)`` — the areas enclosing the point, which is where country
  (``ISO3166-1``) and province (``admin_level=4``) come from. This is the
  "GeoJSON admin boundary" lookup, except OSM already holds the polygons and
  does the point-in-polygon server-side, so there is no boundary dataset to
  ship, version or keep current.

Where it runs
-------------
Creation only — never the render path. Overpass is a shared community resource:
queries take seconds and are rate-limited by the instance, so putting it in
front of a page render would trade a 404 for a timeout. Smart slugs already make
the render path self-sufficient (see ``src/lib/smart-slug.ts``); this module
produces the good name that gets *stored*, so the next visitor's enrichment
lookup finds it locally.

Nominatim remains the fallback. Overpass returning nothing is normal for genuinely
empty coordinates (open ocean, deep rural), and an instance being busy is routine,
so callers degrade rather than fail.
"""

from __future__ import annotations

from typing import Optional

import httpx

# Public Overpass instance. Both mirrors accept the same QL.
OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# How far to look for a named feature. Matches the POI-match radius used
# elsewhere in the app (250 m) — this is "what am I standing on", not
# "what city is this".
DEFAULT_RADIUS_M = 250

# Overpass server-side timeout (seconds) and our own client timeout. The client
# timeout is deliberately the larger of the two so the server's own timeout
# response wins, giving us a parseable answer instead of a torn connection.
#
# Both are kept short on purpose: this runs in front of Nominatim on a path a
# user is waiting on (GPS "use my location"). A small `around` query normally
# answers in 1-3 s, so anything slower is an overloaded instance and we would
# rather fall back immediately than make the visitor wait.
OVERPASS_TIMEOUT_S = 5
HTTP_TIMEOUT_S = 6.0

_http_client: httpx.Client | None = None


def _get_http() -> httpx.Client:
    global _http_client
    if _http_client is None:
        _http_client = httpx.Client(timeout=HTTP_TIMEOUT_S)
    return _http_client


# ---------------------------------------------------------------------------
# Feature ranking
# ---------------------------------------------------------------------------

# OSM tag keys that denote a real, nameable feature, best first. A school beats
# the residential street it fronts; a street beats the suburb polygon over it.
_FEATURE_KEYS: tuple[str, ...] = (
    "amenity",
    "healthcare",
    "aeroway",
    "tourism",
    "leisure",
    "shop",
    "office",
    "man_made",
    "historic",
    "natural",
    "landuse",
    "building",
    "highway",
)

# `place=*` values, most specific first. Used when nothing more concrete is near.
_PLACE_RANK: tuple[str, ...] = (
    "house",
    "farm",
    "isolated_dwelling",
    "hamlet",
    "neighbourhood",
    "quarter",
    "suburb",
    "village",
    "town",
    "borough",
    "city",
)


def _feature_score(tags: dict) -> int:
    """Rank a named OSM feature. Lower is more specific, so it wins.

    Anything unrecognised sorts last but is still usable — an unfamiliar tag
    combination with a name is better than no name at all.
    """
    for i, key in enumerate(_FEATURE_KEYS):
        if tags.get(key):
            return i

    place = tags.get("place")
    if place:
        # Place values sort after concrete features but keep their own ordering.
        offset = len(_FEATURE_KEYS)
        return offset + (_PLACE_RANK.index(place) if place in _PLACE_RANK else len(_PLACE_RANK))

    return 999


def _feature_type(tags: dict) -> str | None:
    """A single human-facing type for a feature ("school", "hospital", "park").

    Mirrors the `poiType` surfaced by the TypeScript POI helpers, so the value
    stored here renders the same way regardless of which path created it.
    """
    for key in _FEATURE_KEYS:
        value = tags.get(key)
        if value and value != "yes":
            return str(value)
    place = tags.get("place")
    return str(place) if place else None


# OSM element type -> the single letter used in a place ref. Matches the
# `n`/`w`/`r` convention OSM itself uses in permalinks and editor URLs.
_OSM_TYPE_LETTER = {"node": "n", "way": "w", "relation": "r"}


def osm_ref(element: dict) -> Optional[str]:
    """Build a stable place reference from an OSM element, e.g. ``"n1234567"``.

    This is the identity of a *place*, and it comes from the map rather than
    from us. Two things follow, and both are the point:

    * The same feature keeps the same ref across visits, GPS jitter, and any
      later improvement to its name — so a revisit joins the existing record
      instead of forking a new one.
    * Two features metres apart have *different* refs. Canberra Plaza and
      Canberra MRT are neighbours on the map and stay separate places here,
      which no coordinate-derived identity can express: a precision coarse
      enough to absorb GPS jitter necessarily merges them, and one fine enough
      to separate them changes on every fix.

    Returns ``None`` for an element with no usable type/id.
    """
    letter = _OSM_TYPE_LETTER.get(str(element.get("type", "")))
    element_id = element.get("id")
    if not letter or element_id is None:
        return None
    return f"{letter}{element_id}"


def _build_query(lat: float, lon: float, radius_m: int) -> str:
    """Overpass QL for nearby named features plus containing admin areas."""
    return (
        f"[out:json][timeout:{OVERPASS_TIMEOUT_S}];\n"
        f"nwr(around:{radius_m},{lat},{lon})[name];\n"
        f"out tags center 40;\n"
        f"is_in({lat},{lon});\n"
        f"out tags;\n"
    )


def _extract_admin(areas: list[dict]) -> tuple[str, str, str]:
    """Pull (country_code, country_name, province) from `is_in` areas.

    Country comes from an ISO 3166-1 alpha-2 tag rather than admin_level, since
    the level denoting a country varies by mapping tradition. Province is
    admin_level 4 — the first-order subdivision almost everywhere. City-states
    legitimately have no level 4, and that is fine: the caller's normalisation
    already handles a missing province.
    """
    country_code = ""
    country_name = ""
    province = ""
    best_level = 10**6

    for area in areas:
        tags = area.get("tags") or {}
        iso = tags.get("ISO3166-1:alpha2") or tags.get("ISO3166-1")
        if iso and len(str(iso)) == 2 and not country_code:
            country_code = str(iso).upper()
            country_name = tags.get("name:en") or tags.get("name") or country_name

        level_raw = tags.get("admin_level")
        try:
            level = int(level_raw) if level_raw is not None else None
        except (TypeError, ValueError):
            level = None

        if level == 2 and not country_name:
            country_name = tags.get("name:en") or tags.get("name") or ""

        # Prefer the outermost subdivision at or below level 4.
        if level is not None and 3 <= level <= 6 and level < best_level:
            name = tags.get("name:en") or tags.get("name")
            if name:
                province = str(name)
                best_level = level

    return country_code, country_name, province


def reverse_name(
    lat: float,
    lon: float,
    *,
    radius_m: int = DEFAULT_RADIUS_M,
) -> dict | None:
    """Name a coordinate from OSM via Overpass.

    Returns ``{name, poiType, country, countryName, admin1, lat, lon,
    elevation}`` — deliberately the same shape ``_reverse_geocode`` returns, so
    it is a drop-in primary with Nominatim as fallback.

    Returns ``None`` on any failure or when nothing nearby carries a name, which
    is the signal for the caller to fall back rather than an error.
    """
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None

    try:
        resp = _get_http().post(
            OVERPASS_URL,
            content=_build_query(lat, lon, radius_m),
            headers={
                "Content-Type": "text/plain",
                "User-Agent": "mukoko-weather/2.0 (support@mukoko.com)",
            },
        )
        if resp.status_code != 200:
            return None
        payload = resp.json()
    except Exception:
        return None

    elements = payload.get("elements") or []
    if not elements:
        return None

    # `is_in` results come back as areas; everything else is a nearby feature.
    areas = [e for e in elements if e.get("type") == "area"]
    features = [
        e for e in elements
        if e.get("type") != "area" and (e.get("tags") or {}).get("name")
    ]

    country_code, country_name, province = _extract_admin(areas)

    if not features:
        # Admin context without a nearby feature is still worth returning — the
        # caller gets a correct country/province and can name from its own
        # sources. Without either, there is nothing to report.
        if not (country_code or province):
            return None
        # `name` is the province at best, NEVER the country. A province is a
        # defensible last-resort name for an unmapped point ("Matabeleland
        # North"); a country name is not — it would label a spot in a Harare
        # suburb "Zimbabwe". Leaving it empty is the signal for the caller to
        # name the point from another source and keep this admin context.
        return {
            "name": province,
            # No nearby feature means no map identity to borrow.
            "osmRef": None,
            "poiType": None,
            "country": country_code,
            "countryName": country_name,
            "admin1": province,
            "lat": lat,
            "lon": lon,
            "elevation": 0,
        }

    features.sort(key=lambda e: _feature_score(e.get("tags") or {}))
    best = features[0]
    tags = best.get("tags") or {}

    return {
        "name": tags.get("name:en") or tags.get("name") or "",
        # The map's own id for this feature — the place's identity.
        "osmRef": osm_ref(best),
        "poiType": _feature_type(tags),
        "country": country_code,
        "countryName": country_name,
        "admin1": province,
        "lat": lat,
        "lon": lon,
        "elevation": 0,
    }
