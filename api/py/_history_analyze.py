"""
AI history analysis endpoint — POST /api/py/history/analyze.

Aggregates historical weather data server-side into a compact statistical
summary (~800 tokens), then sends to Claude for analysis. Results are
cached in the history_analysis collection (location + days + data hash, 1h TTL).

System prompt is fetched from the database (system:history_analysis).
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from datetime import datetime, timezone, timedelta
from typing import Optional

import anthropic
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ._db import (
    check_rate_limit,
    get_client_ip,
    get_api_key,
    get_db,
    ai_prompts_collection,
    history_analysis_collection,
    locations_collection,
)
from ._circuit_breaker import anthropic_breaker, CircuitOpenError

router = APIRouter()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

RATE_LIMIT_MAX = 10
RATE_LIMIT_WINDOW = 3600  # 1 hour
CACHE_TTL = 3600  # 1 hour

# ---------------------------------------------------------------------------
# Module-level singleton client
# ---------------------------------------------------------------------------

_client: Optional[anthropic.Anthropic] = None
_client_key_last: Optional[str] = None

# Prompt cache (5-min TTL)
_prompt_cache: dict[str, dict] = {}
_prompt_cache_at: float = 0
_PROMPT_CACHE_TTL = 300


def _get_client() -> anthropic.Anthropic:
    global _client, _client_key_last

    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        key = get_api_key("anthropic")
    if not key:
        raise HTTPException(status_code=503, detail="AI service unavailable")

    if _client is None or _client_key_last != key:
        _client = anthropic.Anthropic(api_key=key)
        _client_key_last = key

    return _client


def _get_analysis_prompt() -> dict | None:
    """Fetch the history analysis system prompt from MongoDB."""
    global _prompt_cache, _prompt_cache_at

    now = time.time()
    if _prompt_cache and (now - _prompt_cache_at) < _PROMPT_CACHE_TTL:
        return _prompt_cache.get("system:history_analysis")

    try:
        docs = list(
            ai_prompts_collection()
            .find({"active": True}, {"_id": 0, "updatedAt": 0})
        )
        _prompt_cache = {d["promptKey"]: d for d in docs}
        _prompt_cache_at = now
        return _prompt_cache.get("system:history_analysis")
    except Exception:
        return _prompt_cache.get("system:history_analysis")


# Hardcoded fallback
_FALLBACK_SYSTEM_PROMPT = """You are Shamwari Weather, analyzing historical weather data for {locationName}.

You have been given a statistical summary of weather data over {days} days. Provide a clear, actionable analysis.

Structure your response:
1. **Trend Summary** — Key temperature and precipitation trends (1-2 sentences)
2. **Notable Patterns** — Any anomalies, clusters, or significant events (1-2 bullet points)
3. **Activity Recommendations** — How these patterns affect the user's activities (1-2 bullet points)
4. **Outlook** — What these trends suggest for the coming days (1 sentence)

Rules:
- Be specific with numbers and dates
- Connect patterns to real-world impact
- Never use emoji
- Keep the total response under 200 words
- If user activities are provided, tailor recommendations to them"""


def _build_analysis_system_prompt(location_name: str, days: int) -> str:
    """Build the analysis system prompt from database template."""
    prompt_doc = _get_analysis_prompt()
    template = (
        prompt_doc["template"]
        if prompt_doc and prompt_doc.get("template")
        else _FALLBACK_SYSTEM_PROMPT
    )

    return (
        template
        .replace("{locationName}", location_name)
        .replace("{days}", str(days))
    )


# ---------------------------------------------------------------------------
# Stats aggregation — done server-side to reduce token cost
# ---------------------------------------------------------------------------


def _aggregate_stats(records: list[dict]) -> str:
    """Aggregate raw history records into a compact textual summary (~800 tokens)."""
    if not records:
        return "No data available for the selected period."

    # Extract arrays
    temps_high = []
    temps_low = []
    feels_high = []
    feels_low = []
    precip = []
    humidity = []
    wind = []
    gusts = []
    uv = []
    pressure = []
    cloud = []
    dates_with_rain = []
    weather_codes: dict[int, int] = {}
    dates = []

    for r in records:
        current = r.get("current", {})
        daily = r.get("daily", {})
        date = r.get("date", "")
        dates.append(date)

        # Temperature
        t_max = (daily.get("temperature_2m_max") or [None])[0]
        t_min = (daily.get("temperature_2m_min") or [None])[0]
        if t_max is not None:
            temps_high.append(t_max)
        elif current.get("temperature_2m") is not None:
            temps_high.append(current["temperature_2m"])
        if t_min is not None:
            temps_low.append(t_min)

        # Feels like
        fl_max = (daily.get("apparent_temperature_max") or [None])[0]
        fl_min = (daily.get("apparent_temperature_min") or [None])[0]
        if fl_max is not None:
            feels_high.append(fl_max)
        if fl_min is not None:
            feels_low.append(fl_min)

        # Precipitation
        p_sum = (daily.get("precipitation_sum") or [None])[0]
        if p_sum is not None:
            precip.append(p_sum)
            if p_sum > 0.1:
                dates_with_rain.append(date)

        # Humidity, wind, UV, pressure, cloud from current
        if current.get("relative_humidity_2m") is not None:
            humidity.append(current["relative_humidity_2m"])
        if current.get("wind_speed_10m") is not None:
            wind.append(current["wind_speed_10m"])
        if current.get("wind_gusts_10m") is not None:
            gusts.append(current["wind_gusts_10m"])
        uv_max = (daily.get("uv_index_max") or [None])[0]
        if uv_max is not None:
            uv.append(uv_max)
        elif current.get("uv_index") is not None:
            uv.append(current["uv_index"])
        if current.get("surface_pressure") is not None:
            pressure.append(current["surface_pressure"])
        if current.get("cloud_cover") is not None:
            cloud.append(current["cloud_cover"])

        # Weather codes
        code = current.get("weather_code", 0)
        weather_codes[code] = weather_codes.get(code, 0) + 1

    # Build summary
    def _avg(arr: list) -> float:
        return round(sum(arr) / len(arr), 1) if arr else 0

    def _rng(arr: list) -> str:
        return f"{round(min(arr), 1)}-{round(max(arr), 1)}" if arr else "N/A"

    # Temperature trend (first vs last 25%)
    trend_note = ""
    if len(temps_high) >= 8:
        quarter = len(temps_high) // 4
        first_avg = _avg(temps_high[:quarter])
        last_avg = _avg(temps_high[-quarter:])
        diff = round(last_avg - first_avg, 1)
        if abs(diff) > 1:
            direction = "warming" if diff > 0 else "cooling"
            trend_note = f"Temperature trend: {direction} ({diff:+.1f}°C from start to end)"

    date_range = f"{dates[0]} to {dates[-1]}" if dates else "unknown"

    lines = [
        f"Period: {date_range} ({len(records)} data points)",
    ]

    if temps_high:
        lines.append(f"Temperature: avg high {_avg(temps_high)}°C (range {_rng(temps_high)}), avg low {_avg(temps_low)}°C (range {_rng(temps_low)})")
    if feels_high:
        lines.append(f"Feels like: high {_avg(feels_high)}°C, low {_avg(feels_low)}°C")
    if trend_note:
        lines.append(trend_note)
    if precip:
        lines.append(f"Precipitation: total {round(sum(precip), 1)}mm, {len(dates_with_rain)} rainy days out of {len(precip)}")
    if humidity:
        lines.append(f"Humidity: avg {_avg(humidity)}% (range {_rng(humidity)})")
    if wind:
        lines.append(f"Wind: avg {_avg(wind)} km/h, max gusts {round(max(gusts), 1) if gusts else 'N/A'} km/h")
    if uv:
        lines.append(f"UV index: avg {_avg(uv)}, max {round(max(uv), 1)}")
    if pressure:
        lines.append(f"Pressure: avg {_avg(pressure)} hPa (range {_rng(pressure)})")
    if cloud:
        lines.append(f"Cloud cover: avg {_avg(cloud)}%")

    # Top weather conditions
    if weather_codes:
        top = sorted(weather_codes.items(), key=lambda x: x[1], reverse=True)[:3]
        code_names = {
            0: "Clear", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
            45: "Fog", 48: "Fog", 51: "Light drizzle", 53: "Moderate drizzle",
            55: "Dense drizzle", 61: "Slight rain", 63: "Moderate rain",
            65: "Heavy rain", 71: "Slight snow", 73: "Moderate snow",
            75: "Heavy snow", 80: "Slight showers", 81: "Moderate showers",
            82: "Violent showers", 95: "Thunderstorm", 96: "Thunderstorm+hail",
            99: "Thunderstorm+heavy hail",
        }
        conds = [f"{code_names.get(c, f'Code {c}')} ({n}d)" for c, n in top]
        lines.append(f"Most common conditions: {', '.join(conds)}")

    # Insights data if available
    insights_lines = []
    for r in records:
        ins = r.get("insights")
        if ins and isinstance(ins, dict):
            insights_lines.append(ins)

    if insights_lines:
        heat_stresses = [i["heatStressIndex"] for i in insights_lines if i.get("heatStressIndex") is not None]
        thunderstorms = [i["thunderstormProbability"] for i in insights_lines if i.get("thunderstormProbability") is not None]
        gdds = [i["gdd10To30"] for i in insights_lines if i.get("gdd10To30") is not None]

        if heat_stresses:
            high_heat = len([h for h in heat_stresses if h >= 28])
            lines.append(f"Heat stress: avg {_avg(heat_stresses)}, {high_heat} high-stress days")
        if thunderstorms:
            storm_days = len([t for t in thunderstorms if t > 30])
            lines.append(f"Thunderstorm risk: avg {_avg(thunderstorms)}%, {storm_days} high-risk days")
        if gdds:
            lines.append(f"Growing degree days (maize): avg {_avg(gdds)}, total {round(sum(gdds), 1)}")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Request/response models
# ---------------------------------------------------------------------------


class AnalyzeRequest(BaseModel):
    location: str
    days: int = Field(ge=7, le=365, default=30)
    activities: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


@router.post("/api/py/history/analyze")
async def analyze_history(body: AnalyzeRequest, request: Request):
    """
    POST /api/py/history/analyze

    Aggregates historical weather data server-side, then sends a compact
    summary to Claude for analysis. Cached for 1 hour.
    """
    location_slug = body.location.strip().lower()
    if not location_slug:
        raise HTTPException(status_code=400, detail="Missing location")

    # Rate limiting — extract real IP behind Vercel's reverse proxy
    ip = get_client_ip(request)
    if not ip:
        raise HTTPException(status_code=400, detail="Could not determine IP")

    rate = check_rate_limit(ip, "history_analyze", RATE_LIMIT_MAX, RATE_LIMIT_WINDOW)
    if not rate["allowed"]:
        raise HTTPException(status_code=429, detail="Rate limit exceeded. Try again later.")

    # Verify location exists and get metadata
    loc = locations_collection().find_one(
        {"slug": location_slug},
        {"_id": 0, "slug": 1, "name": 1, "elevation": 1, "country": 1},
    )
    if not loc:
        raise HTTPException(status_code=404, detail="Unknown location")

    location_name = loc.get("name", location_slug)
    elevation = loc.get("elevation", 0)
    country = loc.get("country", "ZW")

    # Fetch history from MongoDB
    db = get_db()
    cutoff = datetime.now(timezone.utc) - timedelta(days=body.days)

    history = list(
        db["weather_history"]
        .find(
            {"locationSlug": location_slug, "recordedAt": {"$gte": cutoff}},
            {"_id": 0},
        )
        .sort("recordedAt", 1)
    )

    if not history:
        raise HTTPException(status_code=404, detail="No history data available for this period")

    # Compute a hash of the data for cache keying
    data_hash = hashlib.md5(
        json.dumps(
            [{"d": r.get("date", ""), "t": r.get("current", {}).get("temperature_2m")} for r in history],
            default=str,
        ).encode()
    ).hexdigest()[:12]

    # Check cache
    cache_key = f"{location_slug}:{body.days}:{data_hash}"
    try:
        cached = history_analysis_collection().find_one(
            {"cacheKey": cache_key, "expiresAt": {"$gt": datetime.now(timezone.utc)}},
            {"_id": 0},
        )
        if cached and cached.get("analysis"):
            return {
                "analysis": cached["analysis"],
                "stats": cached.get("stats", ""),
                "cached": True,
                "dataPoints": len(history),
            }
    except Exception:
        pass

    # Aggregate stats server-side
    stats_summary = _aggregate_stats(history)

    # Get season
    from ._ai import _get_season
    season = _get_season(country)

    # Build user prompt with stats
    activities_note = (
        f"\nUser activities: {', '.join(body.activities[:5])}. Focus recommendations on these."
        if body.activities
        else ""
    )

    user_content = f"""Analyze this weather history for {location_name} (elevation: {elevation}m).
Season: {season['shona']} ({season['name']}) — {season['description']}
{activities_note}

Statistical summary:
{stats_summary}"""

    # Build system prompt from database
    system_prompt = _build_analysis_system_prompt(location_name, body.days)

    # Get model config
    prompt_doc = _get_analysis_prompt()
    model = (prompt_doc or {}).get("model", "claude-haiku-4-5-20251001")
    max_tokens = (prompt_doc or {}).get("maxTokens", 500)

    client = _get_client()

    if not anthropic_breaker.is_allowed:
        return {
            "analysis": "AI analysis is temporarily unavailable while the service recovers. The statistical summary is available above.",
            "stats": stats_summary,
            "cached": False,
            "error": True,
            "dataPoints": len(history),
        }

    try:
        response = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=system_prompt,
            messages=[{"role": "user", "content": user_content}],
        )
        anthropic_breaker.record_success()

        text_block = next((b for b in response.content if b.type == "text"), None)
        analysis = text_block.text if text_block else "Unable to generate analysis."

    except anthropic.RateLimitError:
        anthropic_breaker.record_failure()
        raise HTTPException(status_code=429, detail="AI service rate limited. Try again later.")
    except anthropic.APIError:
        anthropic_breaker.record_failure()
        return {
            "analysis": "AI analysis is temporarily unavailable. The statistical summary is available above.",
            "stats": stats_summary,
            "cached": False,
            "error": True,
            "dataPoints": len(history),
        }

    # Cache the analysis
    try:
        history_analysis_collection().update_one(
            {"cacheKey": cache_key},
            {
                "$set": {
                    "cacheKey": cache_key,
                    "locationSlug": location_slug,
                    "days": body.days,
                    "analysis": analysis,
                    "stats": stats_summary,
                    "expiresAt": datetime.now(timezone.utc) + timedelta(seconds=CACHE_TTL),
                    "analyzedAt": datetime.now(timezone.utc),
                },
            },
            upsert=True,
        )
    except Exception:
        pass  # Non-critical — caching failure shouldn't break the response

    return {
        "analysis": analysis,
        "stats": stats_summary,
        "cached": False,
        "dataPoints": len(history),
    }
