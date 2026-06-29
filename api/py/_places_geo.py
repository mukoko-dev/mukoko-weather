"""Helpers for writing to ``places.placesGeo`` and integrating with Fundi.

Phase 0E (search-miss flow):

When a user adds a new location via ``/api/py/locations/add`` we
   1. keep the legacy write to ``weather.locations`` (back-compat)
   2. mirror the entry into the platform's ``places.placesGeo`` so the
      Nyuchi platform has a canonical admin/geographic record for it
   3. enqueue a Fundi Places seed request so the Fundi worker can later
      populate ``places.places`` with POIs (schools, businesses, etc.)
      in the surrounding radius.

Fundi runs as a separate service (MCP, not callable from Python), so the
integration is **queue based** — mukoko writes a request document to
``places.seedRequests`` and Fundi polls/consumes it. Mukoko fires and
forgets; there is no polling endpoint on this side.
"""

from __future__ import annotations

import logging
import re
import unicodedata
import uuid
from datetime import datetime, timezone
from typing import Optional

from ._db import places_db, places_geo_collection

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Name normalisation (used for placesGeo dedup)
# ---------------------------------------------------------------------------

#: Common street-type suffixes that should be stripped before comparing names.
#: Without this, "Windsor Avenue" and "Windsor" look like different places to
#: the dedup logic and would be inserted as two records for the same location.
_STREET_SUFFIXES: tuple[str, ...] = (
    "road", "rd",
    "avenue", "ave",
    "street", "st",
    "drive", "dr",
    "lane", "ln",
    "crescent", "cres",
    "close",
    "boulevard", "blvd",
    "way",
    "highway", "hwy",
)


def normalize_name(name: str) -> str:
    """Return a comparison-safe form of ``name``.

    The transformation is *lossy* — it collapses near-duplicates into the same
    string so the dedup query can find them:

      * lowercase, trim whitespace
      * strip diacritics ("São Paulo" -> "sao paulo")
      * strip a leading house number ("23 Windsor Ave" -> "windsor ave")
      * strip a trailing street-type suffix ("Windsor Avenue" -> "windsor")
    """
    if not name:
        return ""
    # ASCII fold (drops diacritics).
    folded = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    text = folded.strip().lower()
    # Drop a leading house number ("23 windsor ave" -> "windsor ave").
    text = re.sub(r"^\d+\s+", "", text)
    # Collapse runs of whitespace.
    text = re.sub(r"\s+", " ", text).strip()
    # Drop a trailing street suffix (longest match first).
    for suffix in sorted(_STREET_SUFFIXES, key=len, reverse=True):
        if text.endswith(" " + suffix):
            text = text[: -(len(suffix) + 1)].rstrip()
            break
    return text


# ---------------------------------------------------------------------------
# Country ID cache — placesGeo._id lookup by ISO 3166-1 alpha-2 code
# ---------------------------------------------------------------------------

#: Cached map of ISO 3166-1 alpha-2 -> placesGeo._id for ``geoType: "country"``.
#: Populated on first call to :func:`get_country_id` and reused thereafter.
COUNTRY_ID_BY_ISO: dict[str, str] = {}

_COUNTRY_CACHE_LOADED: bool = False


def _load_country_cache() -> None:
    """Populate COUNTRY_ID_BY_ISO from placesGeo countries (once per process)."""
    global _COUNTRY_CACHE_LOADED
    try:
        cursor = places_geo_collection().find(
            {"geoType": "country"},
            {"_id": 1, "isoCode": 1},
        )
        for doc in cursor:
            iso = (doc.get("isoCode") or "").upper()
            if iso and doc.get("_id"):
                COUNTRY_ID_BY_ISO[iso] = doc["_id"]
        _COUNTRY_CACHE_LOADED = True
    except Exception as exc:
        logger.warning("Failed to load placesGeo country cache: %s", exc)
        # Mark as loaded so we don't hammer the DB on every call when it's down.
        _COUNTRY_CACHE_LOADED = True


def get_country_id(iso_code: str) -> Optional[str]:
    """Return placesGeo._id for the given ISO 3166-1 alpha-2 code, or None.

    The cache is lazy-loaded on first call and held for the lifetime of the
    process (Vercel keeps warm functions around for ~5–15 minutes).
    """
    if not iso_code:
        return None
    iso = iso_code.strip().upper()
    if not _COUNTRY_CACHE_LOADED:
        _load_country_cache()
    return COUNTRY_ID_BY_ISO.get(iso)


# ---------------------------------------------------------------------------
# Slug helper
# ---------------------------------------------------------------------------


def _slugify(name: str) -> str:
    """ASCII slug — lowercase, alphanumeric + hyphens, no leading/trailing dash."""
    norm = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-z0-9]+", "-", norm.lower()).strip("-")
    return slug or "place"


def _new_slug(name: str) -> str:
    """Build a globally unique placesGeo slug: ``<name-slug>-<6-char hex>``."""
    return f"{_slugify(name)}-{uuid.uuid4().hex[:6]}"


# ---------------------------------------------------------------------------
# placesGeo dedup
# ---------------------------------------------------------------------------


def _names_match(candidate: str, target_normalised: str) -> bool:
    """True if ``candidate``'s normalised form equals or contains ``target_normalised``."""
    if not target_normalised:
        return True
    norm = normalize_name(candidate)
    if not norm:
        return False
    # Equality OR substring match in either direction — handles "Windsor" vs
    # "Windsor Heights" while still distinguishing "Windsor" from "Bulawayo".
    return norm == target_normalised or norm in target_normalised or target_normalised in norm


def find_nearby_placesgeo(
    lat: float,
    lon: float,
    max_distance_km: float = 5,
    name: Optional[str] = None,
    parent_place_id: Optional[str] = None,
) -> Optional[dict]:
    """Return any placesGeo entry within ``max_distance_km`` of (lat, lon).

    Filters:
      * ``name`` — fuzzy match using :func:`normalize_name` (strips diacritics,
        street-type suffixes, leading house numbers).
      * ``parent_place_id`` — country _id; two places with the same name in
        different countries are legitimately different (e.g. two
        "Springfield"s), so the dedup query must be scoped to a single
        country when a parent id is known.

    Tries the 2dsphere ``$nearSphere`` index first; if that fails (no index,
    no geo field on docs, etc.) falls back to a coarse bounding-box scan so
    dedup still works while indexes are being built.
    """
    coll = places_geo_collection()
    max_meters = max(0.0, max_distance_km) * 1000
    target_norm = normalize_name(name) if name else ""

    def _scan_candidates(query: dict) -> Optional[dict]:
        # We pull a handful and filter in Python so that name normalisation
        # (which can't run inside the DB) still applies. 10 is plenty —
        # the geospatial radius is small. Exceptions propagate so the caller
        # can fall back to bbox when the geo index is missing.
        cursor = coll.find(query).limit(10)
        for doc in cursor:
            if name and not _names_match(doc.get("name", ""), target_norm):
                continue
            return doc
        return None

    # Primary path — geospatial $nearSphere
    try:
        geo_query: dict = {
            "geo": {
                "$nearSphere": {
                    "$geometry": {"type": "Point", "coordinates": [lon, lat]},
                    "$maxDistance": max_meters,
                }
            }
        }
        if parent_place_id:
            geo_query["parentPlaceId"] = parent_place_id
        result = _scan_candidates(geo_query)
        # Whether or not a name was matched: a clean None means the geo path
        # returned a usable answer. Don't double-scan via bbox.
        return result
    except Exception as exc:
        logger.debug("placesGeo $nearSphere failed (%s); falling back to bbox", exc)

    # Fallback path — bounding box approximation (~1 deg lat ≈ 111 km)
    try:
        delta = max_distance_km / 111.0
        lat_min, lat_max = lat - delta, lat + delta
        import math
        cos_lat = max(0.01, math.cos(math.radians(lat)))
        lon_delta = delta / cos_lat
        lon_min, lon_max = lon - lon_delta, lon + lon_delta
        bbox_query: dict = {
            "geo.coordinates.0": {"$gte": lon_min, "$lte": lon_max},
            "geo.coordinates.1": {"$gte": lat_min, "$lte": lat_max},
        }
        if parent_place_id:
            bbox_query["parentPlaceId"] = parent_place_id
        return _scan_candidates(bbox_query)
    except Exception as exc:
        logger.debug("placesGeo bbox fallback failed: %s", exc)
        return None


# ---------------------------------------------------------------------------
# placesGeo insert
# ---------------------------------------------------------------------------


#: Dedup radius for placesGeo upserts. Cities/towns have wide footprints — OSM
#: may put two centroids for the same place a few km apart, so we use a
#: generous radius. The dedup is *also* gated on parent country + name match,
#: which keeps unrelated places with the same name in different countries
#: separate (e.g. two "Springfield"s).
PLACESGEO_DEDUP_RADIUS_KM: float = 5


def upsert_placesgeo_city(
    name: str,
    lat: float,
    lon: float,
    country_iso: str,
    province: Optional[str] = None,
    elevation: Optional[float] = None,
    *,
    geo_type: str = "town",
    data_origin: str = "mukoko_user",
    data_confidence: float = 0.6,
) -> dict:
    """Insert a new ``places.placesGeo`` document, or return the existing one.

    Behaviour:
      1. **Always dedup first.** Calls :func:`find_nearby_placesgeo` with a
         5 km radius, normalised-name match, and country-scoped
         ``parentPlaceId`` filter.
      2. If a match is found, the existing document is returned with an
         added ``wasExisting: True`` marker. NO insert is performed and NO
         suffixed/alternate slug is generated — that would create the kind
         of duplicate-record corruption Phase 0E is meant to prevent.
      3. Otherwise, a new doc is built and inserted. The platform validator
         does NOT include a ``bundu`` field on placesGeo, so the document
         is constructed manually instead of via ``stamp_platform_fields``.
    """
    parent_place_id = get_country_id(country_iso) if country_iso else None

    # Dedup gate — no auto-suffixing, ever.
    existing = find_nearby_placesgeo(
        lat=lat,
        lon=lon,
        max_distance_km=PLACESGEO_DEDUP_RADIUS_KM,
        name=name,
        parent_place_id=parent_place_id,
    )
    if existing is not None:
        # Caller checks the ``wasExisting`` flag to know not to log a fresh insert.
        existing = dict(existing)
        existing["wasExisting"] = True
        return existing

    now = datetime.now(timezone.utc)
    source_provenance: dict = {
        "dataOrigin": data_origin,
        "dataConfidence": data_confidence,
    }
    if province:
        source_provenance["mukokoProvince"] = province
    if elevation is not None:
        source_provenance["mukokoElevation"] = elevation

    doc: dict = {
        "_id": str(uuid.uuid4()),
        "_schemaVersion": "v3.2",
        "name": name,
        "slug": _new_slug(name),
        "geoType": geo_type,
        "geo": {"type": "Point", "coordinates": [lon, lat]},
        "sourceProvenance": source_provenance,
        "createdAt": now,
        "updatedAt": now,
    }
    if parent_place_id:
        doc["parentPlaceId"] = parent_place_id
    if country_iso:
        # Helpful denormalised field even though it isn't required by the validator.
        doc["isoCode"] = country_iso.upper()

    places_geo_collection().insert_one(doc)
    return doc


# ---------------------------------------------------------------------------
# Fundi seed request queue
# ---------------------------------------------------------------------------


#: Dedup radius for the Fundi seed-request queue. If an in-flight request
#: covers the same point within this distance, we surface its ``_id`` rather
#: than enqueuing another. Fundi de-dupes internally too, but we shouldn't
#: even queue twice.
FUNDI_QUEUE_DEDUP_RADIUS_KM: float = 1


def _find_existing_seed_request(
    lat: float,
    lon: float,
    radius_km: float = FUNDI_QUEUE_DEDUP_RADIUS_KM,
) -> Optional[dict]:
    """Return the first queued/processing seedRequest within ``radius_km`` of (lat, lon)."""
    coll = places_db()["seedRequests"]
    # Bounding-box scan — the queue is short-lived and validatorless; a
    # 2dsphere index isn't guaranteed on this collection yet.
    delta = radius_km / 111.0
    import math
    cos_lat = max(0.01, math.cos(math.radians(lat)))
    lon_delta = delta / cos_lat
    query: dict = {
        "status": {"$in": ["queued", "processing"]},
        "region.center.0": {"$gte": lon - lon_delta, "$lte": lon + lon_delta},
        "region.center.1": {"$gte": lat - delta, "$lte": lat + delta},
    }
    try:
        return coll.find_one(query)
    except Exception as exc:
        logger.debug("Fundi queue dedup scan failed: %s", exc)
        return None


def enqueue_fundi_seed(
    lat: float,
    lon: float,
    *,
    radius_meters: int = 5000,
    requested_by_person_id: Optional[str] = None,
    query: Optional[str] = None,
) -> str:
    """Write a request document to ``places.seedRequests`` (or return an existing one).

    Behaviour:
      * If a queued/processing request exists within 1 km of (lat, lon),
        its ``_id`` is returned — no new document is inserted.
      * Otherwise a fresh request document is written and its ``_id`` is
        returned.

    The Fundi worker polls this collection and processes ``status: "queued"``
    entries. Mukoko fires and forgets — no polling on this side.
    """
    existing = _find_existing_seed_request(lat, lon)
    if existing is not None:
        return existing["_id"]

    now = datetime.now(timezone.utc)
    request_id = str(uuid.uuid4())
    doc: dict = {
        "_id": request_id,
        "_schemaVersion": "v3.1",
        "status": "queued",
        "region": {
            "kind": "point_radius",
            "center": [lon, lat],
            "radiusMeters": int(radius_meters),
        },
        "source": {
            "kind": "search_miss",
            "surface": "mukoko-weather",
            "query": query,
            "requestedByPersonId": requested_by_person_id,
        },
        "categories": "all",
        "createdAt": now,
        "updatedAt": now,
        "startedAt": None,
        "finishedAt": None,
        "error": None,
        "placesCreated": None,
        "placesGeoCreated": None,
    }
    places_db()["seedRequests"].insert_one(doc)
    return request_id
