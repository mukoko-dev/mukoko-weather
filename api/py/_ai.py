"""
AI summary endpoint — migrated from /api/ai.

Generates weather briefings using a GLM model (Workers AI, via the shamwari AI Gateway) with tiered
MongoDB caching (30/60/120 min by location importance).
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ._db import (
    SLUG_RE,
    enforce_rate_limit,
    filter_known_activities,
    get_activities_brief,
    get_db,
    get_known_tags,
    require_internal_caller,
)
from ._ai_gateway import call_ai, first_text
from ._ai_prompts import get_ai_prompt

logger = logging.getLogger(__name__)

router = APIRouter()

# ---------------------------------------------------------------------------
# Tiered TTL (matches TypeScript db.ts)
# ---------------------------------------------------------------------------

TIER_2_TAGS = {"farming", "mining", "education", "border"}

TTL_TIER_1 = 1800   # 30 min — cities with "city" tag
TTL_TIER_2 = 3600   # 60 min — locations with industry/education/border tags
TTL_TIER_3 = 7200   # 120 min — all other locations

# Fallback summaries (no API key, open circuit breaker, or AI gateway error) get a
# much shorter TTL than a real AI-generated insight. Without this, a single
# transient AI gateway failure gets cached with the SAME tiered TTL as a genuine
# summary — up to 2 hours of every user seeing the generic fallback text per
# location, long after the underlying failure (or the breaker itself) recovered.
TTL_FALLBACK = 60  # 1 min


def _get_ttl(slug: str, tags: list[str]) -> int:
    """Data-driven TTL — cities get shortest TTL, industry tags get medium."""
    if "city" in tags:
        return TTL_TIER_1
    if any(t in TIER_2_TAGS for t in tags):
        return TTL_TIER_2
    return TTL_TIER_3


# ---------------------------------------------------------------------------
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

def _get_system_prompt() -> str:
    """Get the system prompt for weather summaries from the database."""
    doc = get_ai_prompt("system:summary")
    if doc and doc.get("template"):
        return doc["template"]
    return _FALLBACK_SYSTEM_PROMPT


def _get_user_prompt_template() -> str | None:
    """Get the user prompt template from the database."""
    doc = get_ai_prompt("user:summary_request")
    if doc and doc.get("template"):
        return doc["template"]
    return None


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

    Calls the AI model to produce a structured seasonal calendar, validates the
    response, and stores the result in MongoDB for future lookups. Returns the
    list of season docs on success, or None if AI is unavailable/invalid.
    """
    # Validate ISO 3166-1 alpha-2/alpha-3 format to prevent prompt injection
    if not _COUNTRY_CODE_RE.match(country_code.upper()):
        logger.warning("Invalid country code rejected: %r", country_code[:20])
        return None

    # --- AI gateway call (breaker bookkeeping lives in call_ai) ---
    response, err = call_ai(
        model=None,
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
    if err is not None:
        return None

    # --- Response parsing + validation (errors here are soft, not breaker) ---
    try:
        text = first_text(response).strip()
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
# duplicate AI calls when multiple requests arrive before DB is seeded.
_resolution_in_progress: set[str] = set()
_resolution_lock = __import__("threading").Lock()


def _trigger_background_season_resolution(
    country_code: str, lat: float, lon: float
) -> None:
    """Fire-and-forget AI season resolution in a background thread.

    Uses a module-level in-progress set (guarded by a lock to prevent
    TOCTOU races) to deduplicate concurrent AI calls for the same
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
        # Docs written before this field existed are assumed "ai" (the only
        # kind previously cached with the full tiered TTL).
        "source": doc.get("source", "ai"),
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
    source: str = "ai",
):
    db = get_db()
    # Fallback text (no client, open breaker, or AI gateway error) gets a short
    # TTL regardless of location tier — see TTL_FALLBACK for why.
    ttl = TTL_FALLBACK if source == "fallback" else _get_ttl(slug, tags)
    now = datetime.now(timezone.utc)

    db["ai_summaries"].update_one(
        {"locationSlug": slug},
        {
            "$set": {
                "insight": insight,
                "generatedAt": now,
                "weatherSnapshot": weather_snapshot,
                "expiresAt": now + timedelta(seconds=ttl),
                "source": source,
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
    # The page's own slug. Keys the shared ai_summaries row; without it the
    # key was derived from the display name, so "phuket-th" cached under
    # "phuket" and two same-named places shared one summary.
    slug: str = ""
    # The location's tags (city, farming, ...). Pick the cache TTL tier and
    # ground the prompt. Validated against the known-tag allowlist.
    tags: list[str] = Field(default_factory=list, max_length=20)


def _summary_cache_key(location: LocationInfo) -> str:
    """Cache key for a location: its slug when valid, else the legacy
    name-derived key (older clients that don't send a slug)."""
    slug = (location.slug or "").strip().lower()
    if SLUG_RE.match(slug):
        return slug
    return location.name.lower().replace(" ", "-")


def _location_tags(location: LocationInfo) -> list[str]:
    """Client-supplied tags filtered to the known-tag allowlist, in order,
    de-duplicated. Unknown entries are dropped, never spliced into a prompt."""
    known = get_known_tags()
    seen: list[str] = []
    for tag in location.tags:
        t = tag.strip().lower() if isinstance(tag, str) else ""
        if t in known and t not in seen:
            seen.append(t)
    return seen


class AISummaryRequest(BaseModel):
    weatherData: dict
    location: LocationInfo
    activities: list[str] = Field(default_factory=list)


def _fallback_insight(location: LocationInfo, weather_data: dict, season: dict) -> str:
    """Deterministic summary used whenever the AI model is unavailable."""
    temp = weather_data.get("current", {}).get("temperature_2m")
    humidity = weather_data.get("current", {}).get("relative_humidity_2m")
    return (
        f"Current conditions in {location.name}: "
        f"{round(temp) if temp is not None else 'N/A'}°C with "
        f"{humidity if humidity is not None else 'N/A'}% humidity. "
        f"We are in the {season['localName']} season ({season['name']}). "
        f"{season['description']}. Stay informed and plan your day accordingly."
    )


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


@router.post("/api/py/ai")
async def generate_summary(body: AISummaryRequest, request: Request = None):
    """
    POST /api/py/ai

    Generate an AI weather briefing for a location.
    Cached in MongoDB with tiered TTL (30/60/120 min).
    """
    # The UI reaches this via the auth-gated /api/ai/* proxy; when
    # MUKOKO_INTERNAL_SECRET is configured, direct unauthenticated calls
    # through the blanket /api/py/* rewrite are rejected (issue #92).
    require_internal_caller(request)

    weather_data = body.weatherData
    location = body.location
    # Validate against known activity ids before it's spliced into the
    # system prompt below (activities_line / tip).
    user_activities = filter_known_activities(body.activities)

    if not weather_data or not location:
        raise HTTPException(status_code=400, detail="Missing weather data or location")

    # This route is reachable directly (not just via the authenticated
    # /api/ai/* Next.js proxy — see vercel.json's blanket /api/py/(.*) rewrite),
    # and every request here is an unauthenticated cache write into the same
    # ai_summaries doc real visitors to the location page read. Rate-limit it
    # like every other write/AI endpoint to bound abuse.
    enforce_rate_limit(request, "ai-summary", 30, 3600, require_ip=False)

    current_temp = weather_data.get("current", {}).get("temperature_2m", 0) or 0
    current_code = weather_data.get("current", {}).get("weather_code", 0) or 0
    location_slug = _summary_cache_key(location)

    # Tags for the tiered TTL and the prompt come from the request now:
    # weather.locations (where this used to look them up) was dropped in
    # Phase 0F, so the lookup always returned [] and every place got tier 3.
    location_tags = _location_tags(location)

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

    # Resolve the user's activities to their labels + database-driven AI
    # guidance. The guidance tells the model what weather factors matter for
    # each activity and what regional framing to use, so activity advice is
    # grounded instead of generic filler.
    briefs = {a.get("id"): a for a in get_activities_brief()}
    selected = [briefs.get(a) or {"id": a, "label": a} for a in user_activities[:3]]
    activity_labels = [s.get("label") or s.get("id", "") for s in selected]
    guidance_lines = [
        f"- {s.get('label') or s.get('id')}: {s['aiInstructions']}"
        for s in selected
        if s.get("aiInstructions")
    ]
    activities_line = f"The user's activities: {', '.join(activity_labels)}. Tailor advice to these activities." if activity_labels else ""
    guidance_block = (
        "\nActivity guidance (follow strictly, adapted to this location's country and season):\n"
        + "\n".join(guidance_lines)
        if guidance_lines
        else ""
    )
    activities_tip = (
        f"One specific tip for the user's activities ({', '.join(activity_labels)})"
        if activity_labels
        else "One industry/context-specific tip relevant to this area (e.g. farming advice for farming areas, safety for mining areas, travel conditions for border/travel areas, outdoor guidance for tourism/national parks)"
    )

    # Country + coordinates ground the model in the actual place — advice
    # must reference this country's crops, seasons, transport and culture,
    # never generic global filler.
    country_part = f", {location.country}" if location.country else ""

    user_content = f"""Generate a weather briefing for {location.name}{country_part} (lat {location.lat}, lon {location.lon}; elevation: {location.elevation}m).
The country and specific location matter: ground every recommendation in this place — its crops, seasons, transport routes and daily life — not generic global advice.
{tags_line}
{activities_line}{guidance_block}

Current conditions: {current_data}
3-day forecast summary: max temps {max_temps}, min temps {min_temps}, weather codes {codes}{insights_prompt}
Season: {season['localName']} ({season['name']})

Provide:
1. A 2-sentence general summary
2. {activities_tip}"""

    # Use database-driven prompt (with fallback)
    system_prompt = _get_system_prompt()
    prompt_doc = get_ai_prompt("system:summary")
    model = (prompt_doc or {}).get("model")
    max_tokens = (prompt_doc or {}).get("maxTokens", 400)

    # Circuit open, rate limited or any API error all degrade to the fallback
    # summary; call_ai has already recorded the breaker outcome.
    summary_source = "ai"
    message, err = call_ai(
        model=model,
        max_tokens=max_tokens,
        system=system_prompt,
        messages=[{"role": "user", "content": user_content}],
    )
    if err == "no_client":
        # No API key configured — deterministic fallback, cached with the
        # short fallback TTL and returned in the no-key response shape.
        insight = _fallback_insight(location, weather_data, season)
        try:
            _set_cached_summary(
                location_slug, insight,
                {"temperature": current_temp, "weatherCode": current_code},
                location_tags,
                source="fallback",
            )
        except Exception:
            pass
        return {"insight": insight, "cached": False}
    if err is not None:
        summary_source = "fallback"
        insight = _fallback_insight(location, weather_data, season)
    else:
        insight = first_text(message) or "No insight available."

    # Cache the summary — fallback text gets a short TTL (TTL_FALLBACK) so a
    # transient failure doesn't lock users out of real AI summaries for the
    # full tiered TTL window. Best-effort: the insight above is already
    # generated (model tokens spent), so a failed cache write (storage
    # quota, transient outage) must never turn a good response into a 500 —
    # same serve-first discipline as the weather endpoint's cache writes.
    try:
        _set_cached_summary(
            location_slug, insight,
            {"temperature": current_temp, "weatherCode": current_code},
            location_tags,
            source=summary_source,
        )
    except Exception:
        pass

    return {"insight": insight, "cached": False, "generatedAt": datetime.now(timezone.utc).isoformat()}
