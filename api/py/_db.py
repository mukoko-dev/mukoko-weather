"""
Shared MongoDB connection for all Python API endpoints.

Module-scoped client — reused across warm Vercel serverless invocations.
Uses the same MONGODB_URI and database as the Next.js app.
"""

from __future__ import annotations

import os
import time as _time
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import HTTPException, Request
from pymongo import MongoClient
from pymongo.database import Database

_client: Optional[MongoClient] = None


def get_db() -> Database:
    """Lazy-init MongoDB client. Reuses connection across warm Vercel instances."""
    global _client
    if _client is None:
        uri = os.environ.get("MONGODB_URI")
        if not uri:
            raise HTTPException(status_code=503, detail="Database unavailable")
        _client = MongoClient(uri, appName="mukoko-weather-py", maxIdleTimeMS=5000)
    return _client["mukoko-weather"]


# ---------------------------------------------------------------------------
# Collection accessors
# ---------------------------------------------------------------------------


def device_profiles_collection():
    return get_db()["device_profiles"]


def locations_collection():
    return get_db()["locations"]


def weather_cache_collection():
    return get_db()["weather_cache"]


def ai_summaries_collection():
    return get_db()["ai_summaries"]


def activities_collection():
    return get_db()["activities"]


def suitability_rules_collection():
    return get_db()["suitability_rules"]


def rate_limits_collection():
    return get_db()["rate_limits"]


def api_keys_collection():
    return get_db()["api_keys"]


def tags_collection():
    return get_db()["tags"]


def ai_prompts_collection():
    return get_db()["ai_prompts"]


def ai_suggested_rules_collection():
    return get_db()["ai_suggested_rules"]


def weather_reports_collection():
    return get_db()["weather_reports"]


def history_analysis_collection():
    return get_db()["history_analysis"]


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def get_api_key(provider: str) -> Optional[str]:
    """Fetch an API key from MongoDB."""
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
