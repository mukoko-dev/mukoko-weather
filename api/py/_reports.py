"""
User weather reporting endpoints — Waze-style community weather observations.

POST /api/py/reports          — Submit a weather report
GET  /api/py/reports          — List recent reports near a location
POST /api/py/reports/upvote   — Upvote a report

Reports are stored in the weather_reports collection with TTL-based
expiration. AI clarification uses the system:report_clarification prompt.
"""

from __future__ import annotations

import hashlib
import os
import time
from datetime import datetime, timezone, timedelta
from typing import Optional

import anthropic
from bson import ObjectId
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ._db import (
    check_rate_limit,
    get_client_ip,
    get_api_key,
    weather_reports_collection,
    weather_cache_collection,
    locations_collection,
    ai_prompts_collection,
)
from ._circuit_breaker import anthropic_breaker

router = APIRouter()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

REPORT_TYPES = {
    "light-rain", "heavy-rain", "thunderstorm", "hail", "flooding",
    "strong-wind", "clear-skies", "fog", "dust", "frost",
}

SEVERITY_LEVELS = {"mild", "moderate", "severe"}

SUBMIT_RATE_LIMIT = 5
SUBMIT_RATE_WINDOW = 3600  # 1 hour

# TTL by severity
SEVERITY_TTL = {
    "mild": 86400,      # 24h
    "moderate": 172800,  # 48h
    "severe": 259200,    # 72h
}

# ---------------------------------------------------------------------------
# Module-level caches
# ---------------------------------------------------------------------------

_client: Optional[anthropic.Anthropic] = None
_client_key_last: Optional[str] = None

# Prompt cache (5-min TTL)
_prompt_cache: dict[str, dict] = {}
_prompt_cache_at: float = 0
_PROMPT_CACHE_TTL = 300


def _get_client() -> Optional[anthropic.Anthropic]:
    global _client, _client_key_last

    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        key = get_api_key("anthropic")
    if not key:
        return None

    if _client is None or _client_key_last != key:
        _client = anthropic.Anthropic(api_key=key)
        _client_key_last = key

    return _client


def _get_clarification_prompt() -> dict | None:
    """Fetch the report clarification prompt from MongoDB."""
    global _prompt_cache, _prompt_cache_at

    now = time.time()
    if _prompt_cache and (now - _prompt_cache_at) < _PROMPT_CACHE_TTL:
        return _prompt_cache.get("system:report_clarification")

    try:
        docs = list(
            ai_prompts_collection()
            .find({"active": True}, {"_id": 0, "updatedAt": 0})
        )
        _prompt_cache = {d["promptKey"]: d for d in docs}
        _prompt_cache_at = now
        return _prompt_cache.get("system:report_clarification")
    except Exception:
        return _prompt_cache.get("system:report_clarification")


_FALLBACK_CLARIFICATION_PROMPT = """You are helping a user submit a weather report for {locationName}. They selected: {reportType}.

Ask 1-2 brief follow-up questions to clarify the severity and specifics of what they're experiencing. Use simple, conversational language.

Rules:
- Ask maximum 2 questions
- Use simple language accessible to all literacy levels
- Never use emoji
- Format as a numbered list
- Keep questions under 15 words each"""


def _hash_ip(ip: str) -> str:
    """Hash an IP address for anonymous identification."""
    return hashlib.sha256(ip.encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Request/response models
# ---------------------------------------------------------------------------


class SubmitReportRequest(BaseModel):
    locationSlug: str
    reportType: str
    severity: str = "moderate"
    description: str = ""
    lat: Optional[float] = None
    lon: Optional[float] = None


class ClarifyRequest(BaseModel):
    locationSlug: str
    reportType: str


class UpvoteRequest(BaseModel):
    reportId: str


# ---------------------------------------------------------------------------
# POST /api/py/reports — Submit a weather report
# ---------------------------------------------------------------------------


@router.post("/api/py/reports")
async def submit_report(body: SubmitReportRequest, request: Request):
    """Submit a community weather report."""
    ip = get_client_ip(request)
    if not ip:
        raise HTTPException(status_code=400, detail="Could not determine IP")

    # Rate limiting
    rate = check_rate_limit(ip, "weather_report", SUBMIT_RATE_LIMIT, SUBMIT_RATE_WINDOW)
    if not rate["allowed"]:
        raise HTTPException(status_code=429, detail="Rate limit exceeded. Try again later.")

    # Validate description length server-side (client maxLength=300 can be bypassed)
    if body.description and len(body.description) > 300:
        raise HTTPException(status_code=400, detail="Description too long (max 300 characters)")

    # Validate report type
    if body.reportType not in REPORT_TYPES:
        raise HTTPException(status_code=400, detail=f"Invalid report type. Must be one of: {', '.join(sorted(REPORT_TYPES))}")

    # Validate severity
    severity = body.severity if body.severity in SEVERITY_LEVELS else "moderate"

    # Verify location exists
    loc = locations_collection().find_one(
        {"slug": body.locationSlug},
        {"_id": 0, "slug": 1, "name": 1, "lat": 1, "lon": 1},
    )
    if not loc:
        raise HTTPException(status_code=404, detail="Unknown location")

    # Get weather snapshot for cross-validation
    weather_snapshot = {}
    try:
        cached = weather_cache_collection().find_one(
            {"locationSlug": body.locationSlug},
            {"_id": 0, "data.current": 1},
        )
        if cached and cached.get("data", {}).get("current"):
            curr = cached["data"]["current"]
            weather_snapshot = {
                "temperature": curr.get("temperature_2m"),
                "weatherCode": curr.get("weather_code"),
                "precipitation": curr.get("precipitation"),
                "windSpeed": curr.get("wind_speed_10m"),
                "humidity": curr.get("relative_humidity_2m"),
            }
    except Exception:
        pass

    # Cross-validate report with API data
    verified = _cross_validate(body.reportType, weather_snapshot)

    now = datetime.now(timezone.utc)
    ttl = SEVERITY_TTL.get(severity, 172800)

    report = {
        "locationSlug": body.locationSlug,
        "locationName": loc.get("name", body.locationSlug),
        "lat": body.lat or loc.get("lat"),
        "lon": body.lon or loc.get("lon"),
        "reportType": body.reportType,
        "severity": severity,
        "description": body.description[:300] if body.description else "",
        "weatherSnapshot": weather_snapshot,
        "reportedBy": _hash_ip(ip),
        "reportedAt": now,
        "expiresAt": now + timedelta(seconds=ttl),
        "upvotes": 0,
        "upvotedBy": [],
        "verified": verified,
    }

    result = weather_reports_collection().insert_one(report)

    return {
        "id": str(result.inserted_id),
        "verified": verified,
        "expiresIn": ttl,
    }


def _cross_validate(report_type: str, snapshot: dict) -> bool:
    """Cross-reference user report with API weather data."""
    if not snapshot:
        return False

    precip = snapshot.get("precipitation", 0) or 0
    wind = snapshot.get("windSpeed", 0) or 0
    code = snapshot.get("weatherCode", 0) or 0
    temp = snapshot.get("temperature", 20) or 20

    if report_type in ("light-rain", "heavy-rain") and (precip > 0 or code in range(51, 83)):
        return True
    if report_type == "thunderstorm" and code in (95, 96, 99):
        return True
    if report_type == "strong-wind" and wind > 20:
        return True
    if report_type == "clear-skies" and code in (0, 1) and precip == 0:
        return True
    if report_type == "fog" and code in (45, 48):
        return True
    if report_type == "frost" and temp <= 3:
        return True

    return False


# ---------------------------------------------------------------------------
# GET /api/py/reports — List recent reports for a location
# ---------------------------------------------------------------------------


@router.get("/api/py/reports")
async def list_reports(location: str, hours: int = 24):
    """Get recent reports for a location (within TTL window)."""
    if not location:
        raise HTTPException(status_code=400, detail="Missing location parameter")

    hours = min(max(hours, 1), 72)

    try:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)

        reports = list(
            weather_reports_collection()
            .find(
                {
                    "locationSlug": location,
                    "reportedAt": {"$gte": cutoff},
                    "expiresAt": {"$gt": datetime.now(timezone.utc)},
                },
                {"_id": 1, "reportType": 1, "severity": 1, "description": 1,
                 "reportedAt": 1, "upvotes": 1, "verified": 1, "locationName": 1},
            )
            .sort("reportedAt", -1)
            .limit(20)
        )

        for r in reports:
            r["id"] = str(r.pop("_id"))
            if isinstance(r.get("reportedAt"), datetime):
                r["reportedAt"] = r["reportedAt"].isoformat()

        return {"reports": reports, "location": location}

    except Exception:
        raise HTTPException(status_code=502, detail="Failed to fetch reports")


# ---------------------------------------------------------------------------
# POST /api/py/reports/upvote — Upvote a report
# ---------------------------------------------------------------------------


@router.post("/api/py/reports/upvote")
async def upvote_report(body: UpvoteRequest, request: Request):
    """Upvote a report (IP-based dedup — one vote per IP per report)."""
    ip = get_client_ip(request)
    if not ip:
        raise HTTPException(status_code=400, detail="Could not determine IP")

    ip_hash = _hash_ip(ip)

    try:
        oid = ObjectId(body.reportId)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid report ID")

    # Atomic update — only add upvote if this IP hasn't voted yet
    result = weather_reports_collection().update_one(
        {"_id": oid, "upvotedBy": {"$ne": ip_hash}},
        {
            "$inc": {"upvotes": 1},
            "$push": {"upvotedBy": ip_hash},
        },
    )

    if result.modified_count == 0:
        return {"upvoted": False, "reason": "Already upvoted or report not found"}

    return {"upvoted": True}


# ---------------------------------------------------------------------------
# POST /api/py/reports/clarify — AI-assisted report clarification
# ---------------------------------------------------------------------------


@router.post("/api/py/reports/clarify")
async def clarify_report(body: ClarifyRequest, request: Request):
    """Get AI-generated follow-up questions for a weather report."""
    ip = get_client_ip(request)
    if not ip:
        raise HTTPException(status_code=400, detail="Could not determine IP")

    if body.reportType not in REPORT_TYPES:
        raise HTTPException(status_code=400, detail="Invalid report type")

    # Rate limit
    rate = check_rate_limit(ip, "report_clarify", 10, 3600)
    if not rate["allowed"]:
        raise HTTPException(status_code=429, detail="Rate limit exceeded")

    # Get location name
    loc = locations_collection().find_one(
        {"slug": body.locationSlug},
        {"_id": 0, "name": 1},
    )
    location_name = loc["name"] if loc else body.locationSlug

    client = _get_client()
    if not client or not anthropic_breaker.is_allowed:
        # Fallback questions (AI unavailable or circuit open)
        return {
            "questions": _fallback_questions(body.reportType),
        }

    # Build prompt from database
    prompt_doc = _get_clarification_prompt()
    template = (
        prompt_doc["template"]
        if prompt_doc and prompt_doc.get("template")
        else _FALLBACK_CLARIFICATION_PROMPT
    )

    system_prompt = (
        template
        .replace("{locationName}", location_name)
        .replace("{reportType}", body.reportType)
    )

    model = (prompt_doc or {}).get("model", "claude-haiku-4-5-20251001")
    max_tokens = (prompt_doc or {}).get("maxTokens", 150)

    try:
        response = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=system_prompt,
            messages=[{"role": "user", "content": f"I'm reporting: {body.reportType}"}],
        )
        anthropic_breaker.record_success()

        text_block = next((b for b in response.content if b.type == "text"), None)
        questions_text = text_block.text if text_block else ""

        # Parse numbered questions
        questions = [
            line.strip().lstrip("0123456789.").strip()
            for line in questions_text.strip().split("\n")
            if line.strip() and line.strip()[0].isdigit()
        ]

        return {"questions": questions[:2] if questions else _fallback_questions(body.reportType)}

    except Exception:
        anthropic_breaker.record_failure()
        return {"questions": _fallback_questions(body.reportType)}


def _fallback_questions(report_type: str) -> list[str]:
    """Hardcoded fallback questions when AI is unavailable."""
    fallbacks = {
        "light-rain": ["Is it a drizzle or steady light rain?", "Can you see across the street clearly?"],
        "heavy-rain": ["Can you hear the rain hitting the roof loudly?", "Is water pooling on the ground?"],
        "thunderstorm": ["How close are the lightning flashes?", "Is there hail or just rain?"],
        "hail": ["How large are the hailstones — pea, marble, or larger?", "Is the hail causing damage?"],
        "flooding": ["How deep is the water on the road?", "Are vehicles able to pass?"],
        "strong-wind": ["Are tree branches bending or breaking?", "Is it hard to walk against the wind?"],
        "clear-skies": ["Is the sun fully visible?", "Are there any clouds at all?"],
        "fog": ["How far can you see ahead?", "Is the fog getting thicker or thinner?"],
        "dust": ["Can you taste the dust in the air?", "How far can you see?"],
        "frost": ["Is the frost visible on surfaces?", "Are your car windows frosted over?"],
    }
    return fallbacks.get(report_type, ["How severe would you rate it?", "Is it affecting your plans?"])
