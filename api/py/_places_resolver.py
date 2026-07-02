"""Canonical Python location resolver — Python mirror of ``src/lib/places.ts``.

Phase 0G: ``weather.locations`` is being dropped. Every Python read path that
previously queried ``locations_collection()`` now flows through this module,
which resolves a clean mukoko URL slug against ``places.placesGeo`` (admin
geography) and adapts the platform doc to the legacy ``LocationDoc`` shape
existing call sites expect.

Resolver chain (clean URL slug → placesGeo entry → adapted dict):

    /harare
      │
      ▼
    resolve_location_slug("harare")
      │
      ├─ 1. placesGeo.findOne({sourceProvenance.mukokoSlug: "harare"})
      ├─ 2. (TS-only — Python has no static LOCATIONS seed to lookup by)
      └─ 3. infer_name_from_slug("harare") → "Harare" → placesGeo by
            normalised name, preferring geoType: city > town > village
      │
      ▼
    adapt_placesgeo_to_location(doc, slug_hint="harare")
      │
      ▼
    { slug, name, country, province, lat, lon, elevation, tags, geo, _id }

Behaviour differences vs. TS (``src/lib/places.ts``):

  * Step 2 in TS uses the static ``LOCATIONS`` seed to recover the display
    name when the slug isn't stamped onto a placesGeo doc. Python doesn't
    have that seed in-tree (it lives in TS only), so this step is skipped.
    Step 3 (name inference) covers the vast majority of cases — e.g.
    ``harare`` → ``Harare``, ``nairobi-ke`` → ``Nairobi`` — and falls back
    cleanly to ``None`` for slugs that don't infer a sensible name.
  * Dedup discipline is identical: when multiple placesGeo entries share
    the same normalised name, prefer ``geoType: city > town > village``,
    then higher ``sourceProvenance.dataConfidence``. No auto-suffixed
    slugs, ever.
"""

from __future__ import annotations

import logging
import re
import time
import unicodedata
from typing import Optional

from ._db import places_geo_collection
from ._places_geo import normalize_name

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Slug → name helpers (mirrors TS ``inferNameFromSlug``)
# ---------------------------------------------------------------------------


def infer_name_from_slug(slug: str) -> str:
    """Infer a display name from a clean URL slug.

    Used as a fallback when the slug is not stamped onto a placesGeo doc.

    Examples:
      * ``"harare"`` → ``"Harare"``
      * ``"nairobi-ke"`` → ``"Nairobi"`` (strips trailing 2-letter country)
      * ``"victoria-falls"`` → ``"Victoria Falls"``
    """
    if not slug:
        return ""
    # Strip a trailing 2-letter country code (matches the `{city}-{country}` format).
    without_country = re.sub(r"-[a-z]{2}$", "", slug, flags=re.IGNORECASE)
    parts = [p for p in without_country.split("-") if p]
    return " ".join(part[:1].upper() + part[1:] for part in parts)


# ---------------------------------------------------------------------------
# Country ISO cache — parentPlaceId → ISO 3166-1 alpha-2
# ---------------------------------------------------------------------------

#: Resolved country ISO codes, keyed by ``placesGeo._id``.
_COUNTRY_ISO_BY_ID: dict[str, str] = {}
_country_cache_loaded_at: float = 0
_COUNTRY_CACHE_TTL_S = 60 * 60  # 1 hour


def _ensure_country_cache() -> None:
    """Populate the country-ISO cache from ``placesGeo`` countries."""
    global _country_cache_loaded_at
    now = time.time()
    if _COUNTRY_ISO_BY_ID and (now - _country_cache_loaded_at) < _COUNTRY_CACHE_TTL_S:
        return
    try:
        cursor = places_geo_collection().find(
            {"geoType": "country"},
            {"_id": 1, "isoCode": 1},
        )
        _COUNTRY_ISO_BY_ID.clear()
        for doc in cursor:
            iso = (doc.get("isoCode") or "").upper()
            doc_id = doc.get("_id")
            if doc_id and iso:
                _COUNTRY_ISO_BY_ID[doc_id] = iso
        _country_cache_loaded_at = now
    except Exception as exc:  # noqa: BLE001
        logger.debug("Failed to load country ISO cache: %s", exc)


def get_country_iso(parent_place_id: Optional[str]) -> Optional[str]:
    """Return the ISO 3166-1 alpha-2 code for a country placesGeo._id.

    Returns ``None`` if the parent isn't a country or isn't cached.
    """
    if not parent_place_id:
        return None
    _ensure_country_cache()
    return _COUNTRY_ISO_BY_ID.get(parent_place_id)


# ---------------------------------------------------------------------------
# Adapter: placesGeo doc → legacy LocationDoc shape
# ---------------------------------------------------------------------------

#: Preferred ordering when multiple placesGeo entries share the same name.
_GEO_TYPE_RANK = {"city": 0, "town": 1, "village": 2, "province": 3}


def _rank_geo_type(geo_type: Optional[str]) -> int:
    if not geo_type:
        return 99
    return _GEO_TYPE_RANK.get(geo_type, 50)


def adapt_placesgeo_to_location(
    doc: dict,
    slug_hint: Optional[str] = None,
) -> Optional[dict]:
    """Convert a placesGeo document to the legacy ``LocationDoc`` shape.

    The output mirrors the shape callers expect from the old
    ``locations_collection`` queries:

        {
          "slug":      <clean mukoko slug>,
          "name":      <display name>,
          "province":  <admin1 / mukokoProvince / "">,
          "lat":       <decimal degrees>,
          "lon":       <decimal degrees>,
          "elevation": <metres, defaulting to 0>,
          "tags":      <list[str], defaulting to ["city"]>,
          "country":   <ISO alpha-2 uppercase, or None>,
          "geo":       <GeoJSON Point as stored on the placesGeo doc>,
          "_id":       <platform placeId>,
        }

    When ``slug_hint`` is provided (the slug the caller asked for), it is
    used verbatim. Otherwise the stamped ``sourceProvenance.mukokoSlug``
    is preferred, falling back to the placesGeo hash-suffixed slug.
    """
    if not doc:
        return None
    geo = doc.get("geo") or {}
    coords = geo.get("coordinates") or [0, 0]
    lon = coords[0] if len(coords) > 0 else 0
    lat = coords[1] if len(coords) > 1 else 0

    provenance = doc.get("sourceProvenance") or {}
    iso = (doc.get("isoCode") or get_country_iso(doc.get("parentPlaceId")) or "").upper()
    province = provenance.get("mukokoProvince") or ""
    elevation = provenance.get("mukokoElevation")
    if elevation is None:
        elevation = 0
    tags = provenance.get("mukokoTags") or ["city"]

    clean_slug = (
        slug_hint
        or provenance.get("mukokoSlug")
        or doc.get("slug")
        or ""
    )

    adapted: dict = {
        "slug": clean_slug,
        "name": doc.get("name", ""),
        "province": province,
        "lat": float(lat) if lat is not None else 0.0,
        "lon": float(lon) if lon is not None else 0.0,
        "elevation": elevation,
        "tags": list(tags),
        "_id": doc.get("_id"),
    }
    if iso:
        adapted["country"] = iso
    if doc.get("slug"):
        adapted["platformSlug"] = doc["slug"]
    if provenance.get("mukokoPoiType"):
        adapted["poiType"] = provenance["mukokoPoiType"]
    if provenance.get("mukokoNominatimAddress"):
        adapted["nominatimAddress"] = provenance["mukokoNominatimAddress"]
    if geo:
        adapted["geo"] = geo
    return adapted


# ---------------------------------------------------------------------------
# Resolver — clean URL slug → placesGeo doc | None
# ---------------------------------------------------------------------------


def resolve_location_slug(slug: str) -> Optional[dict]:
    """Canonical lookup for mukoko-weather URL slugs (e.g. ``/harare``).

    Strategy (mirrors ``resolveLocationSlug`` in ``src/lib/places.ts``):

      1. placesGeo by ``sourceProvenance.mukokoSlug`` (exact match).
      2. (skipped in Python — no in-tree LOCATIONS seed)
      3. Infer the display name from the slug and query placesGeo by
         normalised name, preferring ``geoType: city > town > village``.

    Returns the raw placesGeo doc (or ``None``). Callers that want the
    legacy LocationDoc shape should pipe the result through
    :func:`adapt_placesgeo_to_location`, or call :func:`find_location`
    which does both.
    """
    if not slug:
        return None
    try:
        coll = places_geo_collection()
    except Exception as exc:  # noqa: BLE001
        logger.debug("placesGeo collection unavailable: %s", exc)
        return None

    # 1) Exact match on stamped mukokoSlug.
    try:
        stamped = coll.find_one({"sourceProvenance.mukokoSlug": slug})
        if stamped:
            return stamped
    except Exception as exc:  # noqa: BLE001
        logger.debug("placesGeo mukokoSlug lookup failed: %s", exc)

    # 3) Name inference fallback.
    candidate_name = infer_name_from_slug(slug)
    if not candidate_name:
        return None
    normalised = normalize_name(candidate_name)
    if not normalised:
        return None

    escaped = re.escape(candidate_name)
    try:
        # Case-insensitive regex on `name`; we filter further by normalised
        # comparison in Python to handle diacritics/whitespace variations.
        candidates = list(
            coll.find({"name": {"$regex": f"^{escaped}$", "$options": "i"}}).limit(20)
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("placesGeo name lookup failed: %s", exc)
        return None

    matches = [
        c for c in candidates
        if c.get("geoType") != "country"
        and normalize_name(c.get("name", "")) == normalised
    ]
    if not matches:
        return None

    matches.sort(
        key=lambda c: (
            _rank_geo_type(c.get("geoType")),
            -((c.get("sourceProvenance") or {}).get("dataConfidence") or 0),
        )
    )
    return matches[0]


# ---------------------------------------------------------------------------
# High-level helpers — call sites should prefer these.
# ---------------------------------------------------------------------------


def find_location(slug: str) -> Optional[dict]:
    """Resolve and adapt in one call — clean slug → legacy LocationDoc dict."""
    doc = resolve_location_slug(slug)
    if not doc:
        return None
    return adapt_placesgeo_to_location(doc, slug_hint=slug)


def find_locations_by_tag(tag: str, *, limit: int = 200) -> list[dict]:
    """Return locations whose ``sourceProvenance.mukokoTags`` contains ``tag``.

    Note: only placesGeo entries with mukoko-stamped tags surface here.
    Seed locations that haven't been stamped won't appear — by design,
    the tag taxonomy is curated, and surfaces driven by the static seed
    catalog stay on the TypeScript side.
    """
    if not tag:
        return []
    try:
        cursor = (
            places_geo_collection()
            .find({"sourceProvenance.mukokoTags": tag})
            .limit(max(1, min(limit, 500)))
        )
        adapted: list[dict] = []
        for doc in cursor:
            adapted_doc = adapt_placesgeo_to_location(doc)
            if adapted_doc:
                adapted.append(adapted_doc)
        return adapted
    except Exception as exc:  # noqa: BLE001
        logger.debug("placesGeo tag query failed: %s", exc)
        return []


def find_all_locations(*, limit: int = 200, skip: int = 0) -> list[dict]:
    """Return mukoko-discoverable placesGeo entries (cities/towns/villages).

    Filters out countries and provinces — only consumer-facing entries.
    Pagination via ``limit`` / ``skip``. Sorted by name for stable output.
    """
    limit = max(1, min(limit, 500))
    skip = max(0, skip)
    try:
        cursor = (
            places_geo_collection()
            .find({"geoType": {"$in": ["city", "town", "village"]}})
            .sort("name", 1)
            .skip(skip)
            .limit(limit)
        )
        adapted: list[dict] = []
        for doc in cursor:
            adapted_doc = adapt_placesgeo_to_location(doc)
            if adapted_doc:
                adapted.append(adapted_doc)
        return adapted
    except Exception as exc:  # noqa: BLE001
        logger.debug("placesGeo list query failed: %s", exc)
        return []


def count_all_locations() -> int:
    """Estimated count of mukoko-discoverable placesGeo entries."""
    try:
        return places_geo_collection().count_documents(
            {"geoType": {"$in": ["city", "town", "village"]}}
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("placesGeo count failed: %s", exc)
        return 0


def find_locations_in_country(iso: str, *, limit: int = 200) -> list[dict]:
    """Return placesGeo entries whose parent country matches ``iso``.

    Resolves the country's ``placesGeo._id`` via the cached ISO map, then
    queries for child docs with that parent id. Returns ``[]`` if the
    country isn't registered.
    """
    if not iso:
        return []
    iso_upper = iso.strip().upper()
    # Reverse the cache lookup — get id by iso
    _ensure_country_cache()
    parent_id: Optional[str] = None
    for pid, country_iso in _COUNTRY_ISO_BY_ID.items():
        if country_iso == iso_upper:
            parent_id = pid
            break
    if not parent_id:
        return []
    try:
        cursor = (
            places_geo_collection()
            .find({
                "parentPlaceId": parent_id,
                "geoType": {"$in": ["city", "town", "village"]},
            })
            .sort("name", 1)
            .limit(max(1, min(limit, 500)))
        )
        adapted: list[dict] = []
        for doc in cursor:
            adapted_doc = adapt_placesgeo_to_location(doc)
            if adapted_doc:
                adapted.append(adapted_doc)
        return adapted
    except Exception as exc:  # noqa: BLE001
        logger.debug("placesGeo country query failed: %s", exc)
        return []


def find_nearest_location(
    lat: float,
    lon: float,
    *,
    max_km: float = 50,
) -> Optional[dict]:
    """Return the nearest mukoko-discoverable placesGeo entry to (lat, lon).

    Uses ``$nearSphere`` on the 2dsphere index. Returns ``None`` if
    nothing is within ``max_km`` or the index is unavailable.
    """
    try:
        doc = places_geo_collection().find_one({
            "geoType": {"$in": ["city", "town", "village"]},
            "geo": {
                "$nearSphere": {
                    "$geometry": {"type": "Point", "coordinates": [lon, lat]},
                    "$maxDistance": max(0.0, max_km) * 1000,
                }
            },
        })
        if not doc:
            return None
        return adapt_placesgeo_to_location(doc)
    except Exception as exc:  # noqa: BLE001
        logger.debug("placesGeo nearest query failed: %s", exc)
        return None
