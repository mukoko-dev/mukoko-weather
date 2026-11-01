"""Small placesGeo helpers still shared by the Python place-knowledge builder.

The community-location creation path that lived here (``upsert_placesgeo_city``,
the dedup and OSM-ref joins, the Fundi seed queue, the POI lookup) was removed
with ``POST /api/py/locations/add`` and ``GET /api/py/geo?autoCreate=true``
(#333): place creation belongs to the Nyuchi API, never to a weather write.

What remains is read-only or generic:

* ``normalize_name`` (used by the resolver's slug inference),
* the placesGeo country-id cache (``get_country_id``),
* the cross-instance ``weather.creation_locks`` lock that the place-knowledge
  background build uses (``_acquire_create_lock`` / ``_release_create_lock``).

All of it goes with ``_place_knowledge.py`` and ``_places_resolver.py`` when the
Python AI modules that import them are deleted.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from datetime import datetime, timezone, timedelta
from typing import Optional

from pymongo.errors import DuplicateKeyError

from ._db import places_geo_collection, weather_db

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
