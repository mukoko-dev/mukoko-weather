"""
AI summary endpoint — migrated from /api/ai.

Generates weather briefings using Claude Haiku 3.5 with tiered
MongoDB caching (30/60/120 min by location importance).
"""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timezone, timedelta
from typing import Optional

import anthropic
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ._db import get_db, get_api_key
from ._circuit_breaker import anthropic_breaker, CircuitOpenError

logger = logging.getLogger(__name__)

router = APIRouter()

# ---------------------------------------------------------------------------
# Tiered TTL (matches TypeScript db.ts)
# ---------------------------------------------------------------------------

TIER_2_TAGS = {"farming", "mining", "education", "border"}

TTL_TIER_1 = 1800   # 30 min — cities with "city" tag
TTL_TIER_2 = 3600   # 60 min — locations with industry/education/border tags
TTL_TIER_3 = 7200   # 120 min — all other locations


def _get_ttl(slug: str, tags: list[str]) -> int:
    """Data-driven TTL — cities get shortest TTL, industry tags get medium."""
    if "city" in tags:
        return TTL_TIER_1
    if any(t in TIER_2_TAGS for t in tags):
        return TTL_TIER_2
    return TTL_TIER_3


# ---------------------------------------------------------------------------
# Module-level singleton client
# ---------------------------------------------------------------------------

_client: Optional[anthropic.Anthropic] = None
_client_key_last: Optional[str] = None

# Hardcoded fallback — only used if database prompt is unavailable
_FALLBACK_SYSTEM_PROMPT = """You are Shamwari Weather, the AI assistant for mukoko weather — an AI-powered weather intelligence platform. You provide actionable, contextual weather advice grounded in local geography, agriculture, industry, and culture.

Your personality:
- Warm, practical, community-minded (Ubuntu philosophy)
- You speak with authority about the location's climate and geography
- You use local knowledge: regional seasons, place names, farming practices, road conditions
- You prioritize safety and actionable advice

When providing advice:
1. Lead with the most critical/urgent information
2. Be specific about timing ("before 6pm", "after 8am")
3. Reference specific locations and routes by name
4. Connect weather to real-world impact (crops, roads, health)
5. Include a recommended action the person can take RIGHT NOW

Format guidelines:
- Use markdown formatting: **bold** for emphasis, bullet points for lists
- Keep responses concise (3-4 sentences for the summary)
- Always include at least one actionable recommendation
- Do not use emoji
- Do not use headings (no # or ##) — the section already has a heading"""

# Module-level prompt cache (5-min TTL)
import time as _time
_prompt_cache: dict[str, dict] = {}
_prompt_cache_at: float = 0
_PROMPT_CACHE_TTL = 300  # 5 minutes


def _get_prompt(prompt_key: str) -> dict | None:
    """Fetch a prompt template from MongoDB with module-level caching."""
    global _prompt_cache, _prompt_cache_at

    now = _time.time()
    if _prompt_cache and (now - _prompt_cache_at) < _PROMPT_CACHE_TTL:
        return _prompt_cache.get(prompt_key)

    try:
        from ._db import ai_prompts_collection
        docs = list(
            ai_prompts_collection()
            .find({"active": True}, {"_id": 0, "updatedAt": 0})
        )
        _prompt_cache = {d["promptKey"]: d for d in docs}
        _prompt_cache_at = now
        return _prompt_cache.get(prompt_key)
    except Exception:
        return _prompt_cache.get(prompt_key)


def _get_system_prompt() -> str:
    """Get the system prompt for weather summaries from the database."""
    doc = _get_prompt("system:summary")
    if doc and doc.get("template"):
        return doc["template"]
    return _FALLBACK_SYSTEM_PROMPT


def _get_user_prompt_template() -> str | None:
    """Get the user prompt template from the database."""
    doc = _get_prompt("user:summary_request")
    if doc and doc.get("template"):
        return doc["template"]
    return None


def _get_client() -> anthropic.Anthropic:
    global _client, _client_key_last

    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        key = get_api_key("anthropic")
    if not key:
        return None  # type: ignore[return-value]

    if _client is None or _client_key_last != key:
        _client = anthropic.Anthropic(api_key=key)
        _client_key_last = key

    return _client


# ---------------------------------------------------------------------------
# Season lookup
# ---------------------------------------------------------------------------


_COUNTRY_CODE_RE = re.compile(r"^[A-Z]{2,3}$")


def _resolve_seasons_with_ai(
    country_code: str,
    lat: float = 0.0,
    lon: float = 0.0,
) -> list[dict] | None:
    """Use AI to generate season definitions for a country not in the seed data.

    Calls Claude Haiku to produce a structured seasonal calendar, validates the
    response, and stores the result in MongoDB for future lookups. Returns the
    list of season docs on success, or None if AI is unavailable/invalid.
    """
    # Validate ISO 3166-1 alpha-2/alpha-3 format to prevent prompt injection
    if not _COUNTRY_CODE_RE.match(country_code.upper()):
        logger.warning("Invalid country code rejected: %r", country_code[:20])
        return None

    client = _get_client()
    if not client or not anthropic_breaker.is_allowed:
        return None

    # --- Anthropic API call (circuit breaker scoped here only) ---
    try:
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=1024,
            messages=[{
                "role": "user",
                "content": (
                    f"For country code {country_code} (representative coordinates "
                    f"{lat:.1f}°, {lon:.1f}°), return the seasonal calendar as a JSON array.\n\n"
                    "Each object must have:\n"
                    '- "name": English season name (e.g. "Dry season", "Monsoon", "Summer")\n'
                    '- "localName": Local language name (or English if unknown)\n'
                    '- "months": Array of month numbers (1=Jan, 12=Dec) this season covers\n'
                    '- "description": Brief typical weather for this season\n\n'
                    "Rules:\n"
                    "- Every month 1-12 must appear in exactly one season\n"
                    "- Use culturally appropriate names for the region\n"
                    "- Include local language names where known\n"
                    "- Return ONLY the JSON array, no other text"
                ),
            }],
        )
        anthropic_breaker.record_success()
    except Exception:
        # Only trip breaker on actual Anthropic API failures — not JSON
        # parse errors, dict key errors, or MongoDB write failures.
        anthropic_breaker.record_failure()
        return None

    # --- Response parsing + validation (errors here are soft, not breaker) ---
    try:
        text = response.content[0].text.strip()
        # Extract JSON array from response
        if text.startswith("["):
            seasons_raw = json.loads(text)
        else:
            match = re.search(r"\[.*\]", text, re.DOTALL)
            if match:
                seasons_raw = json.loads(match.group())
            else:
                return None

        # Validate: every month 1-12 covered exactly once (no gaps, no overlaps)
        all_months: set[int] = set()
        total_month_count = 0
        hemisphere = "south" if lat < 0 else ("equatorial" if abs(lat) < 10 else "north")
        valid: list[dict] = []
        for s in seasons_raw:
            if not isinstance(s, dict):
                continue
            name = s.get("name", "")
            months = [m for m in s.get("months", []) if isinstance(m, int) and 1 <= m <= 12]
            if not name or not months:
                continue
            all_months.update(months)
            total_month_count += len(months)
            valid.append({
                "countryCode": country_code.upper(),
                "name": name[:100],
                "localName": s.get("localName", name)[:100],
                "months": months,
                "hemisphere": hemisphere,
                "description": s.get("description", "")[:500],
                "source": "ai",
            })

        # Reject if not all 12 months covered, or months overlap between seasons
        if len(all_months) != 12 or total_month_count != 12 or not valid:
            logger.warning("AI season resolution for %s: incomplete or overlapping month coverage", country_code)
            return None

        # Store in MongoDB for future lookups.
        # AI-generated seasons get verified=False and a 30-day TTL so they
        # expire and refresh automatically. Manually verified records
        # (verified=True) should omit expiresAt to persist permanently.
        expires_at = datetime.now(timezone.utc) + timedelta(days=30)
        try:
            db = get_db()
            for doc in valid:
                doc["verified"] = False
                doc["expiresAt"] = expires_at
                db["seasons"].update_one(
                    {"countryCode": doc["countryCode"], "name": doc["name"]},
                    {"$set": doc},
                    upsert=True,
                )
        except Exception:
            logger.warning("Failed to cache AI-generated seasons for %s", country_code)

        return valid

    except Exception:
        logger.warning("Season parsing/validation failed for %s", country_code)
        return None


def _hemisphere_fallback(lat: float) -> dict:
    """Last-resort hemisphere-based season when DB and AI are unavailable."""
    month = datetime.now(timezone.utc).month
    southern = lat < 0
    if southern:
        if month in (12, 1, 2):
            return {"name": "Summer", "localName": "Summer", "description": "Warm season with possible thunderstorms."}
        elif month in (3, 4, 5):
            return {"name": "Autumn", "localName": "Autumn", "description": "Cooling temperatures, harvest period."}
        elif month in (6, 7, 8):
            return {"name": "Winter", "localName": "Winter", "description": "Cool and dry with possible frost."}
        else:
            return {"name": "Spring", "localName": "Spring", "description": "Warming temperatures, early rains possible."}
    else:
        if month in (3, 4, 5):
            return {"name": "Spring", "localName": "Spring", "description": "Warming temperatures, new growth."}
        elif month in (6, 7, 8):
            return {"name": "Summer", "localName": "Summer", "description": "Warmest season with longer days."}
        elif month in (9, 10, 11):
            return {"name": "Autumn", "localName": "Autumn", "description": "Cooling temperatures, shorter days."}
        else:
            return {"name": "Winter", "localName": "Winter", "description": "Coldest season with shorter days."}


def _get_season(country: str = "", lat: float = 0.0, lon: float = 0.0) -> dict:
    """Look up the current season: DB → hemisphere fallback (+ background AI warm).

    Flow:
    1. Query MongoDB seasons collection by country code + current month
    2. If not found, return hemisphere fallback immediately and trigger
       background AI enrichment so the next request has DB data.

    AI resolution is never synchronous on the request path — it can add
    5-15s of latency which is unacceptable for the summary endpoint.
    """
    month = datetime.now(timezone.utc).month

    try:
        if country:
            db = get_db()
            doc = db["seasons"].find_one(
                {"countryCode": country.upper(), "months": month},
                {"_id": 0},
            )
            if doc:
                return {
                    "name": doc.get("name", ""),
                    "localName": doc.get("localName", doc.get("name", "")),
                    "description": doc.get("description", ""),
                }

            # Country not in DB — trigger background AI enrichment for next
            # request, return hemisphere fallback immediately for this one.
            _trigger_background_season_resolution(country, lat, lon)
    except Exception:
        pass

    return _hemisphere_fallback(lat)


# Countries currently being resolved in background threads — prevents
# duplicate Claude calls when multiple requests arrive before DB is seeded.
_resolution_in_progress: set[str] = set()
_resolution_lock = __import__("threading").Lock()


def _trigger_background_season_resolution(
    country_code: str, lat: float, lon: float
) -> None:
    """Fire-and-forget AI season resolution in a background thread.

    Uses a module-level in-progress set (guarded by a lock to prevent
    TOCTOU races) to deduplicate concurrent Claude calls for the same
    country. On Vercel serverless, daemon threads are best-effort — the
    process may terminate after the response. If it does, the next
    _get_season call for this country will re-trigger enrichment.
    """
    import threading

    key = country_code.upper()
    with _resolution_lock:
        if key in _resolution_in_progress:
            return
        _resolution_in_progress.add(key)

    logger.info("Starting background season resolution for %s (%.1f, %.1f)", key, lat, lon)

    def _run() -> None:
        try:
            _resolve_seasons_with_ai(country_code, lat, lon)
            logger.info("Background season resolution completed for %s", key)
        except Exception:
            logger.debug("Background season resolution skipped for %s", country_code)
        finally:
            with _resolution_lock:
                _resolution_in_progress.discard(key)

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()


# ---------------------------------------------------------------------------
# Cache operations
# ---------------------------------------------------------------------------


def _get_cached_summary(slug: str) -> dict | None:
    db = get_db()
    doc = db["ai_summaries"].find_one(
        {"locationSlug": slug, "expiresAt": {"$gt": datetime.now(timezone.utc)}},
    )
    if not doc:
        return None

    return {
        "insight": doc.get("insight", ""),
        "generatedAt": doc.get("generatedAt", datetime.now(timezone.utc)),
        "weatherSnapshot": doc.get("weatherSnapshot", {}),
    }


def _is_stale(cached: dict, current_temp: float, current_code: int) -> bool:
    """Check if the cached summary is stale (weather changed significantly)."""
    snapshot = cached.get("weatherSnapshot", {})
    cached_temp = snapshot.get("temperature", 0)
    cached_code = snapshot.get("weatherCode", 0)

    # Re-generate if temperature changed > 5 degrees or weather code changed
    if abs(current_temp - cached_temp) > 5:
        return True
    if current_code != cached_code:
        return True
    return False


def _set_cached_summary(
    slug: str,
    insight: str,
    weather_snapshot: dict,
    tags: list[str],
):
    db = get_db()
    ttl = _get_ttl(slug, tags)
    now = datetime.now(timezone.utc)

    db["ai_summaries"].update_one(
        {"locationSlug": slug},
        {
            "$set": {
                "insight": insight,
                "generatedAt": now,
                "weatherSnapshot": weather_snapshot,
                "expiresAt": now + timedelta(seconds=ttl),
            },
        },
        upsert=True,
    )


# ---------------------------------------------------------------------------
# Request/response models
# ---------------------------------------------------------------------------


class LocationInfo(BaseModel):
    name: str
    elevation: int = 1200
    lat: float = 0.0
    lon: float = 0.0
    country: str = ""


class AISummaryRequest(BaseModel):
    weatherData: dict
    location: LocationInfo
    activities: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


@router.post("/api/py/ai")
async def generate_summary(body: AISummaryRequest):
    """
    POST /api/py/ai

    Generate an AI weather briefing for a location.
    Cached in MongoDB with tiered TTL (30/60/120 min).
    """
    weather_data = body.weatherData
    location = body.location
    user_activities = body.activities

    if not weather_data or not location:
        raise HTTPException(status_code=400, detail="Missing weather data or location")

    current_temp = weather_data.get("current", {}).get("temperature_2m", 0) or 0
    current_code = weather_data.get("current", {}).get("weather_code", 0) or 0
    location_slug = location.name.lower().replace(" ", "-")

    # Get location tags for tiered TTL
    try:
        db = get_db()
        loc_doc = db["locations"].find_one({"slug": location_slug}, {"tags": 1, "_id": 0})
        location_tags = loc_doc.get("tags", []) if loc_doc else []
    except Exception:
        location_tags = []

    # Check cache
    cached = _get_cached_summary(location_slug)
    if cached and not _is_stale(cached, current_temp, current_code):
        generated_at = cached["generatedAt"]
        if isinstance(generated_at, datetime):
            generated_at = generated_at.isoformat()
        return {
            "insight": cached["insight"],
            "cached": True,
            "generatedAt": generated_at,
        }

    # Get season
    country = location.country if location.country and len(location.country) == 2 else ""
    season = _get_season(country, lat=location.lat, lon=location.lon)

    # Try AI generation
    client = _get_client()
    if not client:
        # Fallback summary
        temp = weather_data.get("current", {}).get("temperature_2m")
        humidity = weather_data.get("current", {}).get("relative_humidity_2m")
        insight = (
            f"Current conditions in {location.name}: "
            f"{round(temp) if temp is not None else 'N/A'}\u00B0C with "
            f"{humidity if humidity is not None else 'N/A'}% humidity. "
            f"We are in the {season['localName']} season ({season['name']}). "
            f"{season['description']}. Stay informed and plan your day accordingly."
        )

        _set_cached_summary(
            location_slug, insight,
            {"temperature": current_temp, "weatherCode": current_code},
            location_tags,
        )
        return {"insight": insight, "cached": False}

    # Build insights section
    insights = weather_data.get("daily", {}).get("insights") or weather_data.get("insights")
    insights_prompt = ""
    if insights and isinstance(insights, dict):
        parts = []
        field_map = {
            "heatStressIndex": "Heat stress index",
            "thunderstormProbability": "Thunderstorm probability",
            "uvHealthConcern": "UV health concern",
            "visibility": "Visibility",
            "dewPoint": "Dew point",
            "gdd10To30": "Maize/Soy GDD",
            "evapotranspiration": "Evapotranspiration",
            "moonPhase": "Moon phase",
        }
        for field, label in field_map.items():
            val = insights.get(field)
            if val is not None:
                parts.append(f"{label}: {val}")
        if parts:
            insights_prompt = f"\nWeather insights (from Tomorrow.io): {', '.join(parts)}"

    # Build user prompt
    import json
    current_data = json.dumps(weather_data.get("current", {}), default=str)
    max_temps = json.dumps(weather_data.get("daily", {}).get("temperature_2m_max", []), default=str)
    min_temps = json.dumps(weather_data.get("daily", {}).get("temperature_2m_min", []), default=str)
    codes = json.dumps(weather_data.get("daily", {}).get("weather_code", []), default=str)

    tags_line = f"This area is relevant to: {', '.join(location_tags)}." if location_tags else ""
    activities_line = f"The user's activities: {', '.join(user_activities[:3])}. Tailor advice to these activities." if user_activities else ""
    activities_tip = (
        f"One specific tip for the user's activities ({', '.join(user_activities[:3])})"
        if user_activities
        else "One industry/context-specific tip relevant to this area (e.g. farming advice for farming areas, safety for mining areas, travel conditions for border/travel areas, outdoor guidance for tourism/national parks)"
    )

    user_content = f"""Generate a weather briefing for {location.name} (elevation: {location.elevation}m).
{tags_line}
{activities_line}

Current conditions: {current_data}
3-day forecast summary: max temps {max_temps}, min temps {min_temps}, weather codes {codes}{insights_prompt}
Season: {season['localName']} ({season['name']})

Provide:
1. A 2-sentence general summary
2. {activities_tip}"""

    # Use database-driven prompt (with fallback)
    system_prompt = _get_system_prompt()
    prompt_doc = _get_prompt("system:summary")
    model = (prompt_doc or {}).get("model", "claude-haiku-4-5-20251001")
    max_tokens = (prompt_doc or {}).get("maxTokens", 400)

    if not anthropic_breaker.is_allowed:
        # Circuit is open — skip AI and use fallback
        temp = weather_data.get("current", {}).get("temperature_2m")
        humidity = weather_data.get("current", {}).get("relative_humidity_2m")
        insight = (
            f"Current conditions in {location.name}: "
            f"{round(temp) if temp is not None else 'N/A'}\u00B0C with "
            f"{humidity if humidity is not None else 'N/A'}% humidity. "
            f"We are in the {season['localName']} season ({season['name']}). "
            f"{season['description']}. Stay informed and plan your day accordingly."
        )
    else:
        try:
            message = client.messages.create(
                model=model,
                max_tokens=max_tokens,
                system=system_prompt,
                messages=[{"role": "user", "content": user_content}],
            )
            anthropic_breaker.record_success()

            text_block = next((b for b in message.content if b.type == "text"), None)
            insight = text_block.text if text_block else "No insight available."
        except Exception:
            anthropic_breaker.record_failure()
            # Fallback on any AI error
            temp = weather_data.get("current", {}).get("temperature_2m")
            humidity = weather_data.get("current", {}).get("relative_humidity_2m")
            insight = (
                f"Current conditions in {location.name}: "
                f"{round(temp) if temp is not None else 'N/A'}\u00B0C with "
                f"{humidity if humidity is not None else 'N/A'}% humidity. "
                f"We are in the {season['localName']} season ({season['name']}). "
                f"{season['description']}. Stay informed and plan your day accordingly."
            )

    # Cache the summary
    _set_cached_summary(
        location_slug, insight,
        {"temperature": current_temp, "weatherCode": current_code},
        location_tags,
    )

    return {"insight": insight, "cached": False, "generatedAt": datetime.now(timezone.utc).isoformat()}
