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
import time
import unicodedata
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional

from pymongo.errors import DuplicateKeyError

from ._db import places_collection, places_db, places_geo_collection, weather_db

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
# places.places — nearest POI matching (location refinement)
# ---------------------------------------------------------------------------

#: Tight radius for POI-nearest matching. POIs are point features (a school, a
#: shop, a clinic); we only prefer one when the user is essentially standing on
#: it. Intentionally small (≤250 m) — this is NOT a coarse city snap.
POI_MATCH_RADIUS_KM: float = 0.25


def poi_type_from_place(doc: Optional[dict]) -> Optional[str]:
    """Return a single human-facing POI type from a ``places.places`` doc.

    Prefers the first ``placeType`` entry, then the first
    ``additionalCategories`` entry. Returns ``None`` when neither carries a
    usable string.
    """
    if not doc:
        return None
    place_type = doc.get("placeType")
    if isinstance(place_type, str) and place_type.strip():
        return place_type.strip()
    if isinstance(place_type, list):
        for entry in place_type:
            if isinstance(entry, str) and entry.strip():
                return entry.strip()
    extra = doc.get("additionalCategories")
    if isinstance(extra, list):
        for entry in extra:
            if isinstance(entry, str) and entry.strip():
                return entry.strip()
    return None


def find_nearest_place(
    lat: float,
    lon: float,
    max_distance_km: float = POI_MATCH_RADIUS_KM,
) -> Optional[dict]:
    """Return the nearest ``places.places`` POI within ``max_distance_km``.

    Uses the 2dsphere ``$nearSphere`` index on ``places.places.geo`` (assumed
    present; guarded below). Returns ``None`` if nothing is in range, the index
    is missing, or any error occurs — POI matching must NEVER break location
    resolution, so every failure path falls back to ``None`` and the caller
    keeps its reverse-geocode result.
    """
    max_meters = max(0.0, max_distance_km) * 1000
    try:
        result = places_collection().find_one({
            "geo": {
                "$nearSphere": {
                    "$geometry": {"type": "Point", "coordinates": [lon, lat]},
                    "$maxDistance": max_meters,
                }
            }
        })
    except Exception as exc:  # noqa: BLE001
        logger.debug("places.places $nearSphere failed: %s", exc)
        return None
    # Real POI docs are plain dicts; guard against non-dict mocks/None.
    return result if isinstance(result, dict) else None


# ---------------------------------------------------------------------------
# placesGeo insert
# ---------------------------------------------------------------------------


#: Default dedup radius for placesGeo upserts. Cities/towns have wide
#: footprints — OSM may put two centroids for the same place a few km apart,
#: so the default is generous. Callers creating FINE-GRAINED entries (roads,
#: POIs, suburbs from zoom-18 reverse geocoding) must pass a tighter
#: ``dedup_radius_km`` matching their own duplicate gate — otherwise two
#: distinct same-named places a few km apart (e.g. "Westgate" suburb vs
#: "Westgate Mall") alias onto one document. The dedup is *also* gated on
#: parent country + name match, which keeps unrelated places with the same
#: name in different countries separate (e.g. two "Springfield"s).
PLACESGEO_DEDUP_RADIUS_KM: float = 5


# ---------------------------------------------------------------------------
# Cross-instance creation lock (TOCTOU guard)
# ---------------------------------------------------------------------------

#: How long a creation lock may be held before another instance may steal it.
#: Creation (dedup read + insert) takes well under a second; 30s only matters
#: when a holder crashed mid-create.
CREATE_LOCK_TTL_S = 30


def _acquire_create_lock(lock_id: str) -> bool:
    """Best-effort cross-instance lock via ``_id`` uniqueness.

    ``insert_one`` on a fixed ``_id`` is atomic on the primary, so exactly one
    concurrent caller wins — no index setup or transactions needed. Returns
    ``True`` when the lock was acquired (or the lock infrastructure is down,
    in which case creation proceeds unlocked — a rare duplicate beats failing
    the user's request). Returns ``False`` when another instance holds a
    fresh lock for the same place.
    """
    now = datetime.now(timezone.utc)
    try:
        coll = weather_db()["creation_locks"]
        coll.insert_one({"_id": lock_id, "createdAt": now})
        return True
    except DuplicateKeyError:
        # Steal locks whose holder crashed mid-create.
        try:
            stale_cutoff = now - timedelta(seconds=CREATE_LOCK_TTL_S)
            removed = coll.delete_one({"_id": lock_id, "createdAt": {"$lt": stale_cutoff}})
            if removed.deleted_count:
                coll.insert_one({"_id": lock_id, "createdAt": now})
                return True
        except Exception:  # noqa: BLE001
            pass
        return False
    except Exception as exc:  # noqa: BLE001
        logger.debug("creation lock unavailable (%s); proceeding unlocked", exc)
        return True


def _release_create_lock(lock_id: str) -> None:
    try:
        weather_db()["creation_locks"].delete_one({"_id": lock_id})
    except Exception:  # noqa: BLE001
        pass


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
    dedup_radius_km: float = PLACESGEO_DEDUP_RADIUS_KM,
    mukoko_slug: Optional[str] = None,
    mukoko_tags: Optional[list[str]] = None,
    mukoko_nominatim_address: Optional[dict] = None,
    mukoko_poi_type: Optional[str] = None,
) -> dict:
    """Insert a new ``places.placesGeo`` document, or return the existing one.

    Behaviour:
      1. **Always dedup first.** Calls :func:`find_nearby_placesgeo` with a
         ``dedup_radius_km`` radius (default 5 km — pass the caller's own
         duplicate-gate radius so the two checks can't disagree), a
         normalised-name match, and country-scoped ``parentPlaceId`` filter.
         The dedup read + insert run under a short cross-instance creation
         lock keyed by country + normalised name, so two near-simultaneous
         requests for the same brand-new place can't both slip past the
         dedup read and double-insert (TOCTOU).
      2. If a match is found, the existing document is returned with an
         added ``wasExisting: True`` marker. NO insert is performed and NO
         suffixed/alternate slug is generated — that would create the kind
         of duplicate-record corruption Phase 0E is meant to prevent.

         When ``mukoko_slug`` is provided and the existing doc lacks one,
         the existing doc is **patched** in place to stamp the slug. This
         lets pre-existing platform-seeded entries become discoverable by
         the mukoko clean-slug resolver without creating a duplicate.
      3. Otherwise, a new doc is built and inserted. The platform validator
         does NOT include a ``bundu`` field on placesGeo, so the document
         is constructed manually instead of via ``stamp_platform_fields``.

    Phase 0F: ``mukoko_slug``, ``mukoko_tags``, and
    ``mukoko_nominatim_address`` are now stored under ``sourceProvenance``
    so the TypeScript ``resolveLocationSlug`` helper can find user-added
    placesGeo entries by their clean mukoko URL slug without a name lookup.
    """
    parent_place_id = get_country_id(country_iso) if country_iso else None

    # TOCTOU guard — serialize creation of the same place across instances so
    # two near-simultaneous requests can't both pass the dedup read below and
    # double-insert. The lock key is country + normalised name: over-broad
    # (two same-named places far apart briefly serialize), never under-broad.
    lock_id = f"placesgeo:{(country_iso or '').upper()}:{normalize_name(name)}"
    got_lock = _acquire_create_lock(lock_id)
    if not got_lock:
        # Another instance is creating this place right now — give its insert
        # a moment to land so the dedup read below finds it.
        time.sleep(0.3)

    try:
        return _dedup_or_insert(
            name=name,
            lat=lat,
            lon=lon,
            country_iso=country_iso,
            province=province,
            elevation=elevation,
            geo_type=geo_type,
            data_origin=data_origin,
            data_confidence=data_confidence,
            dedup_radius_km=dedup_radius_km,
            mukoko_slug=mukoko_slug,
            mukoko_tags=mukoko_tags,
            mukoko_nominatim_address=mukoko_nominatim_address,
            mukoko_poi_type=mukoko_poi_type,
            parent_place_id=parent_place_id,
        )
    finally:
        if got_lock:
            _release_create_lock(lock_id)


def _dedup_or_insert(
    *,
    name: str,
    lat: float,
    lon: float,
    country_iso: str,
    province: Optional[str],
    elevation: Optional[float],
    geo_type: str,
    data_origin: str,
    data_confidence: float,
    dedup_radius_km: float,
    mukoko_slug: Optional[str],
    mukoko_tags: Optional[list[str]],
    mukoko_nominatim_address: Optional[dict],
    mukoko_poi_type: Optional[str],
    parent_place_id: Optional[str],
) -> dict:
    """The dedup-read + insert body of :func:`upsert_placesgeo_city`.

    Runs under the creation lock acquired by the caller.
    """
    # Dedup gate — no auto-suffixing, ever.
    existing = find_nearby_placesgeo(
        lat=lat,
        lon=lon,
        max_distance_km=dedup_radius_km,
        name=name,
        parent_place_id=parent_place_id,
    )
    if existing is not None:
        existing = dict(existing)
        # Phase 0F: stamp the mukoko slug onto a pre-existing platform doc
        # if it's missing. This is critical for platform-seeded city entries
        # (e.g. Phase 0C-1 mukoko_seed cities) so the clean-slug resolver
        # picks them up without duplicating.
        if mukoko_slug:
            existing_prov = existing.get("sourceProvenance") or {}
            if not existing_prov.get("mukokoSlug"):
                patch: dict = {
                    "updatedAt": datetime.now(timezone.utc),
                    "sourceProvenance.mukokoSlug": mukoko_slug,
                }
                if mukoko_tags and not existing_prov.get("mukokoTags"):
                    patch["sourceProvenance.mukokoTags"] = list(mukoko_tags)
                if province and not existing_prov.get("mukokoProvince"):
                    patch["sourceProvenance.mukokoProvince"] = province
                if elevation is not None and not existing_prov.get("mukokoElevation"):
                    patch["sourceProvenance.mukokoElevation"] = elevation
                if mukoko_nominatim_address and not existing_prov.get("mukokoNominatimAddress"):
                    patch["sourceProvenance.mukokoNominatimAddress"] = mukoko_nominatim_address
                if mukoko_poi_type and not existing_prov.get("mukokoPoiType"):
                    patch["sourceProvenance.mukokoPoiType"] = mukoko_poi_type
                try:
                    places_geo_collection().update_one(
                        {"_id": existing["_id"]},
                        {"$set": patch},
                    )
                    existing.setdefault("sourceProvenance", {}).update(
                        {k.split(".", 1)[1]: v for k, v in patch.items() if k.startswith("sourceProvenance.")}
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Failed to stamp mukokoSlug on existing placesGeo: %s", exc)
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
    if mukoko_slug:
        source_provenance["mukokoSlug"] = mukoko_slug
    if mukoko_tags:
        source_provenance["mukokoTags"] = list(mukoko_tags)
    if mukoko_nominatim_address:
        source_provenance["mukokoNominatimAddress"] = mukoko_nominatim_address
    if mukoko_poi_type:
        source_provenance["mukokoPoiType"] = mukoko_poi_type

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
