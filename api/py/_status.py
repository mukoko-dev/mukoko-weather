"""
Status endpoint — migrated from /api/status.

Live system health dashboard checks.
"""

from __future__ import annotations

import logging
import re
import time
from datetime import datetime, timezone

from fastapi import APIRouter

from ._db import get_db, get_api_key, ttl_filter
from ._http import get_http_client
from ._ai_gateway import DEFAULT_GATEWAY_ID, gateway_headers, gateway_url, missing_ai_config
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


#: Timeout for the live Open-Meteo probe (Tomorrow.io is no longer probed live).
PROBE_TIMEOUT_S = 10.0

#: Timeout for the AI liveness probe. Short: it never reaches the model.
AI_PROBE_TIMEOUT_S = 5.0

#: The AI probe body. The AI Worker refuses an empty ``messages`` array with
#: HTTP 400 ``invalid_request`` before any model call, so the probe costs no
#: tokens. It still crosses the whole path: DNS/TLS to the internal Worker,
#: its service-key check, the service binding to the AI Worker, and the AI
#: Worker's guardrails load (which runs before request validation).
AI_PROBE_BODY: dict = {"messages": []}

#: The exact refusal the AI Worker sends for :data:`AI_PROBE_BODY`
#: (``Rejected::NoMessages`` in workers/crates/weather-core/src/ai/completions.rs,
#: wrapped in the shared ``{"error", "error_description"}`` envelope). Only
#: this 400 proves the path is healthy. Any other 400 (a gateway guardrails
#: block, a changed contract, a proxy in between) means something refused
#: the probe for another reason.
AI_PROBE_EXPECTED_ERROR = "invalid_request"
AI_PROBE_EXPECTED_DESCRIPTION = "`messages` must be a non-empty array."


def _is_expected_probe_refusal(resp) -> bool:
    """True only for the Worker's own empty-``messages`` refusal."""
    try:
        body = resp.json()
    except Exception:
        return False
    return (
        isinstance(body, dict)
        and body.get("error") == AI_PROBE_EXPECTED_ERROR
        and body.get("error_description") == AI_PROBE_EXPECTED_DESCRIPTION
    )


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
# fans out to live MongoDB / Open-Meteo / AI checks. (Tomorrow.io is no longer
# probed live at all — that probe used to burn its 25/hr free-tier quota.)
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
    """Tomorrow.io — ENRICHMENT only (issue #246), never a live probe.

    The forecast baseline comes from global models via Open-Meteo, so this
    row is tagged ``role: "enrichment"`` and never degrades the overall
    status. It deliberately makes NO call to Tomorrow.io: the old live probe
    itself spent the 25/h free-tier quota. Health is read from the API-key
    config, the circuit breaker and the MongoDB budget counters instead.
    """
    from ._circuit_breaker import tomorrow_breaker
    from . import _enrichment as enrichment

    name = "Tomorrow.io (insights enrichment)"
    start = time.time()

    def row(status: str, message: str) -> dict:
        r = _result(name, status, start, message)
        r["role"] = "enrichment"
        return r

    try:
        api_key = get_api_key("tomorrow")
    except Exception as e:
        _failure_message("Tomorrow.io API key lookup", e)
        return row("degraded", "Enrichment degraded — cannot read API key (MongoDB unavailable); derived insights in use")

    if not api_key:
        return row(
            "degraded",
            "Enrichment off — no API key configured (seed apiKeys.tomorrow via db-init). Baseline + derived insights unaffected.",
        )

    if not tomorrow_breaker.is_allowed:
        return row(
            "degraded",
            "Enrichment degraded — circuit open after rate limiting (429) or errors; baseline unaffected",
        )

    try:
        b = enrichment.budget_snapshot()
    except Exception as e:
        _failure_message("Tomorrow.io budget read", e)
        return row("degraded", "Enrichment degraded — budget counters unavailable")

    usage = f"{b['hourUsed']}/{b['hourCap']} this hour, {b['dayUsed']}/{b['dayCap']} today"
    if b["dayUsed"] >= b["dayCap"] or b["hourUsed"] >= b["hourCap"]:
        return row("degraded", f"Enrichment degraded — call budget exhausted ({usage}); baseline unaffected")
    skipped = b.get("skippedBudget", 0) + b.get("skippedError", 0)
    note = f"; {skipped} enrichments skipped today" if skipped else ""
    return row("operational", f"Enrichment active — {usage}{note}")


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
    """Probe the AI path end to end WITHOUT spending tokens.

    Sends :data:`AI_PROBE_BODY` to the chat-completions route. A healthy path
    answers 400 ``invalid_request`` from the AI Worker's own validation, which
    proves the internal Worker accepts our key, the service binding reaches
    the AI Worker and its guardrails loaded. No model runs, so polling the
    status page cannot bill anything. The model itself is covered by
    ``ai_breaker``, which real calls trip on failure.

    The probe never records into the breaker: a status poll must not flip
    the circuit that real traffic depends on.
    """
    name = "Shamwari AI (weather AI Worker)"
    start = time.time()

    missing = missing_ai_config()
    if missing:
        # Env var NAMES only — never values.
        return _result(
            name,
            "degraded",
            start,
            f"AI Worker not configured (missing {', '.join(missing)}) — basic summary fallback active",
        )

    gateway = DEFAULT_GATEWAY_ID
    try:
        resp = get_http_client(AI_PROBE_TIMEOUT_S).post(
            gateway_url(),  # type: ignore[arg-type] — set when config is complete
            headers=gateway_headers(),
            json=AI_PROBE_BODY,
        )
    except Exception as e:
        return _result(name, "down", start, _failure_message(name, e))

    code = resp.status_code
    if code == 401:
        return _result(name, "down", start, "AI Worker rejected the service key (HTTP 401) — fallbacks active")
    if code == 429:
        return _result(name, "degraded", start, "AI Worker rate limited (HTTP 429) — fallbacks active")
    if code == 400 and not _is_expected_probe_refusal(resp):
        # Error CODE only (a fixed token like "invalid_request"), never the
        # body text, which could echo request content.
        try:
            raw = resp.json()
            err = raw.get("error") if isinstance(raw, dict) else None
        except Exception:
            err = None
        label = err if isinstance(err, str) and re.fullmatch(r"[a-z0-9_]{1,40}", err) else "unexpected body"
        return _result(
            name,
            "degraded",
            start,
            f"AI Worker refused the probe for another reason (HTTP 400, {label}) — fallbacks may be active",
        )
    if 200 <= code < 300:
        # The Worker never accepts an empty `messages` array, so a success
        # means something other than its validation answered (a wrong
        # WEATHER_AI_URL, a proxy, a changed contract that may have run the
        # model). That proves nothing about the AI path.
        return _result(
            name,
            "degraded",
            start,
            f"AI Worker accepted the empty probe (HTTP {code}) — the AI URL may not point at the Worker",
        )
    if code != 400:
        return _result(name, "down", start, f"AI Worker unavailable (HTTP {code}) — fallbacks active")

    if not ai_breaker.is_allowed:
        return _result(name, "degraded", start, f"Circuit open — gateway {gateway} recovering, fallbacks active")

    return _result(name, "operational", start, f"AI Worker reachable (gateway {gateway}, model set by the Worker)")


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
    multiply upstream calls. Tomorrow.io is enrichment-only: its row carries
    ``role: "enrichment"``, is summarised in the top-level ``enrichment``
    field and never degrades the overall ``status``.
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

    # Enrichment-only providers (Tomorrow.io) never degrade the overall status:
    # the baseline forecast does not depend on them.
    core = [c for c in checks if c.get("role") != "enrichment"]
    overall = "operational"
    if any(c["status"] in ("down", "degraded") for c in core):
        overall = "degraded"
    enrichment_rows = [c for c in checks if c.get("role") == "enrichment"]
    enrichment_status = (
        "degraded" if any(c["status"] != "operational" for c in enrichment_rows) else "operational"
    )

    result = {
        "status": overall,
        "enrichment": enrichment_status,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "totalLatencyMs": round((time.time() - start) * 1000),
        "checks": checks,
    }

    _status_cache["data"] = result
    _status_cache["ts"] = time.time()
    return result
