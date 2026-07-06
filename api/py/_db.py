"""
Shared MongoDB connection for all Python API endpoints.

Module-scoped client — reused across warm Vercel serverless invocations.

Phase 0B: the Nyuchi Platform cluster hosts 27 databases. Mukoko-weather
consumes six of them — see ``docs/mongodb-schema-map.md``. The accessors below
expose each platform DB and the relevant collections. The legacy single-DB
``get_db()`` is retained but now points at the ``weather`` DB so existing
call sites keep working without change.

Every write into a platform collection MUST include ``_schemaVersion``,
``createdAt``, ``updatedAt`` and a ``bundu`` sub-document — strict validators
will reject malformed writes. Use ``stamp_platform_fields()`` to add these.
"""

from __future__ import annotations

import os
import time as _time
from datetime import datetime, timezone, timedelta
from typing import Optional
from uuid import uuid4

from fastapi import HTTPException, Request
from pymongo import MongoClient
from pymongo.database import Database

_client: Optional[MongoClient] = None


# ---------------------------------------------------------------------------
# Platform schema constants
# ---------------------------------------------------------------------------

#: Schema version stamped onto every new document we write. The platform-wide
#: validators accept ``v3.1`` and ``v3.2``; we use ``v3.1`` as the default.
PLATFORM_SCHEMA_VERSION = "v3.1"

#: Default country code used by the Bundu/Ubuntu sub-document when none is
#: supplied. Mukoko's home market is Zimbabwe.
DEFAULT_COUNTRY_CODE = "ZW"


# ---------------------------------------------------------------------------
# Client + database accessors
# ---------------------------------------------------------------------------


def _get_client() -> MongoClient:
    """Lazy-init MongoDB client. Reused across warm Vercel invocations."""
    global _client
    if _client is None:
        uri = os.environ.get("MONGODB_URI")
        if not uri:
            raise HTTPException(status_code=503, detail="Database unavailable")
        _client = MongoClient(uri, appName="mukoko-weather-py", maxIdleTimeMS=5000)
    return _client


def get_db() -> Database:
    """
    Backward-compat accessor.

    Pre-Phase-0B this returned the mukoko-only database. Now mukoko's primary
    home on the shared cluster is the ``weather`` database, so this is
    aliased to :func:`weather_db`. New code should call the explicit
    ``*_db()`` accessors below.
    """
    return weather_db()


def weather_db() -> Database:
    """Weather domain — cache, summaries, observations, stations, alerts, communityReports."""
    return _get_client().get_database("weather")


def places_db() -> Database:
    """Locations / geography — places, placesGeo, categories, routes, conditionReports."""
    return _get_client().get_database("places")


def identity_db() -> Database:
    """Users / auth — persons, credentials, activityLog."""
    return _get_client().get_database("identity")


def shamwari_db() -> Database:
    """AI / chatbot — conversations, messages, guardrails, knowledgeBase, preferences."""
    return _get_client().get_database("shamwari")


def device_db() -> Database:
    """Device registry — devices, commands, telemetry, deviceHistory."""
    return _get_client().get_database("device")


def integrations_db() -> Database:
    """Provider configs — providers, providerConfigurations, standards."""
    return _get_client().get_database("integrations")


# ---------------------------------------------------------------------------
# Collection accessors — legacy mukoko collections (now in `weather` DB)
#
# These return collections in the platform `weather` database. Existing call
# sites keep working untouched. New code should prefer the explicit DB+camelCase
# accessors further down (e.g. community_reports_collection over
# weather_reports_collection).
# ---------------------------------------------------------------------------


def device_profiles_collection():
    """Legacy mukoko device profile sync — now lives in the platform `device` DB."""
    return device_db()["device_profiles"]


def locations_collection():
    """Legacy mukoko locations — kept in `weather` DB until Phase 0D rewires to `places.places`."""
    return weather_db()["locations"]


def weather_cache_collection():
    return weather_db()["weather_cache"]


def ai_summaries_collection():
    return weather_db()["ai_summaries"]


def activities_collection():
    return weather_db()["activities"]


def suitability_rules_collection():
    return weather_db()["suitability_rules"]


def rate_limits_collection():
    return weather_db()["rate_limits"]


def api_keys_collection():
    """
    Legacy mukoko API key store. Phase 0D replaces reads from this collection
    with ``integrations.providerConfigurations``. Kept here so existing code
    keeps working in the meantime.
    """
    return weather_db()["api_keys"]


def tags_collection():
    return weather_db()["tags"]


def ai_prompts_collection():
    return weather_db()["ai_prompts"]


def ai_suggested_rules_collection():
    return weather_db()["ai_suggested_rules"]


def weather_reports_collection():
    """Legacy snake_case alias. New code: prefer :func:`community_reports_collection`."""
    return weather_db()["weather_reports"]


def history_analysis_collection():
    return weather_db()["history_analysis"]


def metar_cache_collection():
    return weather_db()["metar_cache"]


# ---------------------------------------------------------------------------
# Platform collection accessors — new (camelCase, schema-validated)
# ---------------------------------------------------------------------------

# weather domain
def stations_collection():
    """StationKit hardware registry — weather.stations."""
    return weather_db()["stations"]


def observations_collection():
    """QC-validated station observations — weather.observations."""
    return weather_db()["observations"]


def station_observations_collection():
    """Raw station payloads — weather.stationObservations."""
    return weather_db()["stationObservations"]


def alerts_collection():
    """CAP-format severe weather alerts — weather.alerts."""
    return weather_db()["alerts"]


def community_reports_collection():
    """Community weather reports (Waze-style) — weather.communityReports (camelCase)."""
    return weather_db()["communityReports"]


def air_quality_cache_collection():
    """Air quality cache (1-h TTL, _id keyed by {lat:.4f}_{lon:.4f}) — weather.air_quality_cache."""
    return weather_db()["air_quality_cache"]


# places domain
def places_collection():
    """Places — landmarks, businesses, parks, etc. (schema.org-aligned)."""
    return places_db()["places"]


def places_geo_collection():
    """Administrative geography (countries, provinces, cities) — places.placesGeo."""
    return places_db()["placesGeo"]


def categories_collection():
    return places_db()["categories"]


def routes_collection():
    return places_db()["routes"]


def condition_reports_collection():
    """Per-place community condition reports — places.conditionReports."""
    return places_db()["conditionReports"]


# identity domain
def persons_collection():
    """Canonical user records (OIDC-compliant) — identity.persons."""
    return identity_db()["persons"]


def credentials_collection():
    """Per-person credentials (passkey, WorkOS, OAuth, etc.) — identity.credentials."""
    return identity_db()["credentials"]


def activity_log_collection():
    """Auth audit trail (signup, signin, MFA, etc.) — identity.activityLog (camelCase)."""
    return identity_db()["activityLog"]


# shamwari domain
def conversations_collection():
    """Per-user chat sessions — shamwari.conversations."""
    return shamwari_db()["conversations"]


def messages_collection():
    """Chat messages (Anthropic content-block format) — shamwari.messages."""
    return shamwari_db()["messages"]


def guardrails_collection():
    """Cross-app guardrails — shamwari.guardrails."""
    return shamwari_db()["guardrails"]


def knowledge_base_collection():
    """Vector-embedded knowledge resources (RAG) — shamwari.knowledgeBase."""
    return shamwari_db()["knowledgeBase"]


def preferences_collection():
    """Per-person Shamwari preferences — shamwari.preferences."""
    return shamwari_db()["preferences"]


# device domain
def devices_collection():
    """Every device on the platform — device.devices."""
    return device_db()["devices"]


def commands_collection():
    return device_db()["commands"]


def telemetry_collection():
    return device_db()["telemetry"]


def device_history_collection():
    """Device state transition audit log — device.deviceHistory (camelCase)."""
    return device_db()["deviceHistory"]


# integrations domain
def providers_collection():
    """External provider catalog (WorkOS, Tomorrow.io, etc.) — integrations.providers."""
    return integrations_db()["providers"]


def provider_configurations_collection():
    """Per-env/per-country provider configs — integrations.providerConfigurations."""
    return integrations_db()["providerConfigurations"]


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def stamp_platform_fields(
    doc: dict,
    country_code: str = DEFAULT_COUNTRY_CODE,
    province_slug: Optional[str] = None,
) -> dict:
    """
    Add the platform-required fields to ``doc`` in place and return it.

    Stamps:
      * ``_id``            — UUID string (only if missing)
      * ``_schemaVersion`` — ``"v3.1"`` (only if missing)
      * ``createdAt``      — UTC now (only if missing)
      * ``updatedAt``      — UTC now (always overwritten)
      * ``bundu``          — sub-doc with ``countryCode`` (and ``provinceSlug`` if given)

    Existing values are preserved — this is safe to call on a partially-built
    document. Strict validators reject writes that lack these fields, so call
    this on every insert into a platform collection.
    """
    now = datetime.now(timezone.utc)
    doc.setdefault("_id", str(uuid4()))
    doc.setdefault("_schemaVersion", PLATFORM_SCHEMA_VERSION)
    doc.setdefault("createdAt", now)
    doc["updatedAt"] = now

    bundu = doc.setdefault("bundu", {})
    bundu.setdefault("countryCode", country_code)
    if province_slug:
        bundu.setdefault("provinceSlug", province_slug)
    return doc


def get_api_key(provider: str) -> Optional[str]:
    """Fetch an API key from MongoDB (legacy `api_keys` collection)."""
    doc = api_keys_collection().find_one({"provider": provider})
    return doc["key"] if doc else None


def get_client_ip(request: Request) -> str | None:
    """
    Extract the real client IP, accounting for Vercel's reverse proxy.

    In Vercel's serverless environment, request.client.host returns the
    edge proxy IP — all users would share a single rate-limit bucket.
    Instead, read x-forwarded-for (first entry) or x-real-ip.
    """
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    real_ip = request.headers.get("x-real-ip")
    if real_ip:
        return real_ip.strip()
    return request.client.host if request.client else None


# ---------------------------------------------------------------------------
# Tag cache — shared across chat, explore, etc.
# ---------------------------------------------------------------------------

_known_tags: Optional[set[str]] = None
_known_tags_at: float = 0
_TAGS_CACHE_TTL = 300  # 5 minutes


def get_known_tags() -> set[str]:
    """
    Fetch the set of valid tag slugs from MongoDB (cached 5 min).
    Falls back to a minimal hardcoded set if the database is unavailable.
    """
    global _known_tags, _known_tags_at

    now = _time.time()
    if _known_tags is not None and (now - _known_tags_at) < _TAGS_CACHE_TTL:
        return _known_tags

    try:
        docs = list(tags_collection().find({}, {"slug": 1, "_id": 0}))
        _known_tags = {d["slug"] for d in docs if d.get("slug")}
        _known_tags_at = now
        return _known_tags
    except Exception:
        if _known_tags is not None:
            return _known_tags
        # Minimal fallback — matches the seed tags
        return {
            "city", "farming", "mining", "tourism", "education",
            "border", "travel", "national-park",
        }


_known_activities: Optional[set[str]] = None
_known_activities_at: float = 0
_ACTIVITIES_CACHE_TTL = 300  # 5 minutes


def filter_known_activities(activities: list[str]) -> list[str]:
    """
    Filter a client-supplied activities list down to known activity ids
    (cached 5 min from MongoDB) before it's spliced into any AI system
    prompt.

    Unlike `message`/`history` (length-capped) and location slugs
    (SLUG_RE-validated), each string in a request's `activities` list was
    previously joined into prompts with no validation — a caller could pass
    an arbitrary (unbounded-length) string that lands directly in a prompt
    as if it were a legitimate activity, more trusted than a user turn.
    Unknown entries are silently dropped rather than rejected: legitimate
    callers only ever send ids from the app's own activity picker
    (src/lib/activities.ts), so this never affects normal use. Falls back
    to a minimal hardcoded set if the database is unavailable, mirroring
    get_known_tags().
    """
    global _known_activities, _known_activities_at

    now = _time.time()
    if _known_activities is None or (now - _known_activities_at) >= _ACTIVITIES_CACHE_TTL:
        try:
            docs = list(activities_collection().find({}, {"id": 1, "_id": 0}))
            _known_activities = {d["id"] for d in docs if d.get("id")}
            _known_activities_at = now
        except Exception:
            if _known_activities is None:
                # Minimal fallback — matches a subset of the seed activities
                _known_activities = {
                    "crop-farming", "livestock", "mining", "construction",
                    "driving", "safari", "soccer", "braai",
                }

    return [a for a in activities if a in _known_activities]


def check_rate_limit(ip: str, action: str, max_requests: int, window_seconds: int) -> dict:
    """
    MongoDB-backed rate limiter using atomic findOneAndUpdate.
    Returns { "allowed": bool, "remaining": int }.
    """
    key = f"{action}:{ip}"
    now = datetime.now(timezone.utc)
    expires = now + timedelta(seconds=window_seconds)

    result = rate_limits_collection().find_one_and_update(
        {"key": key},
        {
            "$inc": {"count": 1},
            "$setOnInsert": {"expiresAt": expires},
        },
        upsert=True,
        return_document=True,
    )

    count = result.get("count", 1) if result else 1
    allowed = count <= max_requests
    return {"allowed": allowed, "remaining": max(0, max_requests - count)}
