"""
Status endpoint — migrated from /api/status.

Live system health dashboard checks.
"""

from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timezone

from fastapi import APIRouter

from ._db import get_db, get_api_key, ttl_filter
from ._http import get_http_client
from ._ai_gateway import DEFAULT_GATEWAY_ID, missing_ai_config, resolve_model
from ._circuit_breaker import ai_breaker

router = APIRouter()

logger = logging.getLogger(__name__)

# The status payload is public, so raw exception text (connection strings,
# hostnames, driver internals) must never reach it. The detail is logged
# server-side and the client sees a fixed message.
_CHECK_FAILED_MESSAGE = "Check failed — details are in the server logs"


def _failure_message(check: str, exc: Exception) -> str:
    """Log a failed check's exception and return the public-safe message."""
    logger.warning("Status check %s failed: %r", check, exc)
    return _CHECK_FAILED_MESSAGE


#: Timeout for the live upstream probes (Tomorrow.io, Open-Meteo).
PROBE_TIMEOUT_S = 10.0


def _result(name: str, status: str, start: float, message: str) -> dict:
    """One health-check row. ``latencyMs`` is measured from ``start`` to now."""
    return {
        "name": name,
        "status": status,
        "latencyMs": round((time.time() - start) * 1000),
        "message": message,
    }


# Server-side cache for the assembled status payload. The dashboard polls this
# endpoint (and multiple tabs multiply that), so without a short TTL every poll
# fans out to live MongoDB / Tomorrow.io / Open-Meteo checks — which burns the
# shared Tomorrow.io free-tier quota (25/hr) and can 429 real weather serving.
_STATUS_CACHE_TTL_S = 60.0
_status_cache: dict = {"data": None, "ts": 0.0}


def _reset_status_cache() -> None:
    """Clear the cached status payload (used by tests)."""
    _status_cache["data"] = None
    _status_cache["ts"] = 0.0


def _check_mongodb() -> dict:
    start = time.time()
    try:
        get_db().command("ping")
        return _result("MongoDB Atlas", "operational", start, "Connected and responding")
    except Exception as e:
        return _result("MongoDB Atlas", "down", start, _failure_message("MongoDB Atlas", e))


def _check_tomorrow_io() -> dict:
    name = "Tomorrow.io API"
    start = time.time()
    try:
        try:
            api_key = get_api_key("tomorrow")
        except Exception as e:
            _failure_message("Tomorrow.io API key lookup", e)
            return _result(name, "degraded", start, "Cannot retrieve API key — MongoDB unavailable")

        if not api_key:
            return _result(
                name,
                "degraded",
                start,
                "API key not configured in database — run POST /api/py/db-init with apiKeys.tomorrow to seed it. Using Open-Meteo fallback.",
            )

        resp = get_http_client(PROBE_TIMEOUT_S).get(
            "https://api.tomorrow.io/v4/weather/realtime",
            params={"location": "-17.83,31.05"},
            headers={"apikey": api_key},  # header, not query: URLs get logged
        )

        if resp.status_code == 429:
            return _result(name, "degraded", start, "Rate limited (429) — falling back to Open-Meteo")

        if resp.status_code != 200:
            return _result(name, "down", start, f"HTTP {resp.status_code}: {resp.reason_phrase}")

        return _result(name, "operational", start, "Responding normally")
    except Exception as e:
        return _result(name, "down", start, _failure_message(name, e))


def _check_open_meteo() -> dict:
    name = "Open-Meteo API"
    start = time.time()
    try:
        resp = get_http_client(PROBE_TIMEOUT_S).get(
            "https://api.open-meteo.com/v1/forecast",
            params={"latitude": "-17.83", "longitude": "31.05", "current": "temperature_2m"},
        )

        if resp.status_code != 200:
            return _result(name, "down", start, f"HTTP {resp.status_code}: {resp.reason_phrase}")

        data = resp.json()
        if data.get("current", {}).get("temperature_2m") is None:
            return _result(name, "degraded", start, "Response received but missing expected data")

        return _result(name, "operational", start, "Responding normally")
    except Exception as e:
        return _result(name, "down", start, _failure_message(name, e))


def _check_ai_gateway() -> dict:
    """Check the AI gateway WITHOUT spending tokens.

    A live chat-completions ping bills a request every time the status page is
    polled (and anonymous users could burn credits at will). Instead we verify
    the gateway config is present, report the gateway + model the app is
    configured to run, and surface an open circuit breaker.
    """
    name = "Shamwari AI (Cloudflare AI Gateway)"
    start = time.time()

    missing = missing_ai_config()
    if missing:
        # Env var NAMES only — never values.
        return _result(
            name,
            "degraded",
            start,
            f"AI gateway not configured (missing {', '.join(missing)}) — basic summary fallback active",
        )

    gateway = (os.environ.get("AI_GATEWAY_ID") or "").strip() or DEFAULT_GATEWAY_ID
    if not ai_breaker.is_allowed:
        return _result(name, "degraded", start, f"Circuit open — gateway {gateway} recovering, fallbacks active")

    return _result(name, "operational", start, f"Gateway {gateway} configured (model: {resolve_model()})")


def _count_active(collection: str, noun: tuple[str, str], empty_message: str, name: str) -> dict:
    """Shared body for the cache-population checks (count of unexpired docs)."""
    start = time.time()
    try:
        count = get_db()[collection].count_documents(ttl_filter({}))
        singular, plural = noun
        return _result(
            name,
            "operational" if count > 0 else "degraded",
            start,
            f"{count} active cached {singular if count == 1 else plural}" if count > 0 else empty_message,
        )
    except Exception as e:
        return _result(name, "down", start, _failure_message(name, e))


def _check_weather_cache() -> dict:
    return _count_active(
        "weather_cache",
        ("location", "locations"),
        "Cache is empty — next requests will fetch fresh data",
        "Weather Cache",
    )


def _check_ai_cache() -> dict:
    return _count_active(
        "ai_summaries",
        ("summary", "summaries"),
        "Cache is empty — next requests will generate fresh summaries",
        "AI Summary Cache",
    )


@router.get("/api/py/status")
async def system_status():
    """GET /api/py/status — Live system health checks.

    Result is cached server-side for ~60s so rapid/multi-tab polling doesn't
    multiply upstream calls (protects the shared Tomorrow.io free-tier quota).
    """
    now = time.time()
    cached = _status_cache["data"]
    if cached is not None and (now - _status_cache["ts"]) < _STATUS_CACHE_TTL_S:
        return cached

    start = time.time()

    checks = [
        _check_mongodb(),
        _check_tomorrow_io(),
        _check_open_meteo(),
        _check_ai_gateway(),
        _check_weather_cache(),
        _check_ai_cache(),
    ]

    overall = "operational"
    if any(c["status"] == "down" for c in checks):
        overall = "degraded"
    elif any(c["status"] == "degraded" for c in checks):
        overall = "degraded"

    result = {
        "status": overall,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "totalLatencyMs": round((time.time() - start) * 1000),
        "checks": checks,
    }

    _status_cache["data"] = result
    _status_cache["ts"] = time.time()
    return result
