"""
AI-powered explore search — POST /api/py/explore/search.

Lightweight single-query endpoint (no conversation history) that uses
Claude with tools to find locations matching natural-language queries.
Falls back to text search if AI is unavailable.

System prompt is fetched from the database (system:explore_search).
"""

from __future__ import annotations

import os
import re
import time
from datetime import datetime, timezone
from typing import Optional

import anthropic
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ._db import (
    check_rate_limit,
    get_client_ip,
    get_api_key,
    locations_collection,
    weather_cache_collection,
    ai_prompts_collection,
)
from ._circuit_breaker import anthropic_breaker, CircuitOpenError

router = APIRouter()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SLUG_RE = re.compile(r"^[a-z0-9-]{1,80}$")
RATE_LIMIT_MAX = 15
RATE_LIMIT_WINDOW = 3600  # 1 hour
MAX_QUERY_LEN = 500
MAX_TOOL_ITERATIONS = 3

# ---------------------------------------------------------------------------
# Module-level caches
# ---------------------------------------------------------------------------

_client: Optional[anthropic.Anthropic] = None
_client_key_last: Optional[str] = None

# Prompt cache (5-min TTL)
_prompt_cache: dict[str, dict] = {}
_prompt_cache_at: float = 0
_PROMPT_CACHE_TTL = 300

# Location context cache (5-min TTL)
_location_context: Optional[list[dict]] = None
_location_context_at: float = 0
CONTEXT_TTL = 300


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


def _get_search_prompt() -> dict | None:
    """Fetch the explore search system prompt from MongoDB."""
    global _prompt_cache, _prompt_cache_at

    now = time.time()
    if _prompt_cache and (now - _prompt_cache_at) < _PROMPT_CACHE_TTL:
        return _prompt_cache.get("system:explore_search")

    try:
        docs = list(
            ai_prompts_collection()
            .find({"active": True}, {"_id": 0, "updatedAt": 0})
        )
        _prompt_cache = {d["promptKey"]: d for d in docs}
        _prompt_cache_at = now
        return _prompt_cache.get("system:explore_search")
    except Exception:
        return _prompt_cache.get("system:explore_search")


_FALLBACK_SYSTEM_PROMPT = """You are Shamwari Weather, helping users find locations based on weather conditions.

The user is searching for: "{query}"

Use your tools to find locations that match their criteria. Return a brief summary of your findings.

Rules:
- Search for relevant locations using the available tools
- Fetch weather for the top matches to verify they meet the criteria
- Be concise — summarize in 2-3 sentences
- Never use emoji
- If no locations match, suggest alternatives"""


def _build_search_system_prompt(query: str) -> str:
    """Build the search system prompt from database template."""
    prompt_doc = _get_search_prompt()
    template = (
        prompt_doc["template"]
        if prompt_doc and prompt_doc.get("template")
        else _FALLBACK_SYSTEM_PROMPT
    )
    return template.replace("{query}", query[:200])


def _get_location_context() -> list[dict]:
    """Load location context for tool use (cached 5 min)."""
    global _location_context, _location_context_at

    now = time.time()
    if _location_context and (now - _location_context_at) < CONTEXT_TTL:
        return _location_context

    try:
        _location_context = list(
            locations_collection()
            .find({}, {"_id": 0, "slug": 1, "name": 1, "province": 1, "tags": 1, "country": 1})
            .limit(200)
        )
        _location_context_at = now
        return _location_context
    except Exception:
        return _location_context or []


# ---------------------------------------------------------------------------
# Tool definitions
# ---------------------------------------------------------------------------

TOOLS = [
    {
        "name": "search_locations",
        "description": "Search for locations by name, tag, or province. Returns matching locations.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query (location name, province, or keyword)",
                },
                "tag": {
                    "type": "string",
                    "description": "Filter by tag (city, farming, mining, tourism, etc.)",
                },
            },
            "required": [],
        },
    },
    {
        "name": "get_weather",
        "description": "Get current weather for a specific location by slug.",
        "input_schema": {
            "type": "object",
            "properties": {
                "slug": {
                    "type": "string",
                    "description": "Location slug (e.g. 'harare', 'victoria-falls')",
                },
            },
            "required": ["slug"],
        },
    },
]


# ---------------------------------------------------------------------------
# Tool execution
# ---------------------------------------------------------------------------


def _exec_search(args: dict) -> str:
    """Execute search_locations tool."""
    import json

    query = args.get("query", "")
    tag = args.get("tag", "")
    locations = _get_location_context()

    results = []
    q = query.lower().strip()
    t = tag.lower().strip() if tag else ""

    for loc in locations:
        name = loc.get("name", "").lower()
        province = loc.get("province", "").lower()
        tags = loc.get("tags", [])

        match = False
        if q and (q in name or q in province):
            match = True
        if t and t in tags:
            match = True
        if not q and not t:
            match = True

        if match:
            results.append({
                "slug": loc["slug"],
                "name": loc["name"],
                "province": loc.get("province", ""),
                "country": loc.get("country", "ZW"),
                "tags": tags,
            })

    return json.dumps(results[:20])


def _exec_weather(args: dict) -> str:
    """Execute get_weather tool."""
    import json

    slug = args.get("slug", "")
    if not SLUG_RE.match(slug):
        return json.dumps({"error": "Invalid location slug"})

    try:
        cached = weather_cache_collection().find_one(
            {"locationSlug": slug},
            {"_id": 0, "data": 1, "provider": 1},
        )
        if cached and cached.get("data"):
            data = cached["data"]
            current = data.get("current", {})
            return json.dumps({
                "slug": slug,
                "temperature": current.get("temperature_2m"),
                "humidity": current.get("relative_humidity_2m"),
                "windSpeed": current.get("wind_speed_10m"),
                "weatherCode": current.get("weather_code"),
                "precipitation": current.get("precipitation"),
                "uvIndex": current.get("uv_index"),
                "cloudCover": current.get("cloud_cover"),
                "provider": cached.get("provider", "unknown"),
            })
        return json.dumps({"error": f"No weather data for {slug}"})
    except Exception:
        return json.dumps({"error": "Weather data unavailable"})


def _exec_tool(name: str, args: dict) -> str:
    """Route tool call to handler."""
    if name == "search_locations":
        return _exec_search(args)
    elif name == "get_weather":
        return _exec_weather(args)
    return '{"error": "Unknown tool"}'


# ---------------------------------------------------------------------------
# Text search fallback (no AI)
# ---------------------------------------------------------------------------


def _text_search_fallback(query: str) -> dict:
    """Simple text search when AI is unavailable."""
    locations = _get_location_context()
    q = query.lower().strip()

    results = []
    for loc in locations:
        name = loc.get("name", "").lower()
        province = loc.get("province", "").lower()
        tags = loc.get("tags", [])

        if q in name or q in province or q in " ".join(tags):
            # Try to get cached weather
            weather_info = {}
            try:
                cached = weather_cache_collection().find_one(
                    {"locationSlug": loc["slug"]},
                    {"_id": 0, "data.current.temperature_2m": 1, "data.current.weather_code": 1},
                )
                if cached and cached.get("data", {}).get("current"):
                    curr = cached["data"]["current"]
                    weather_info = {
                        "temperature": curr.get("temperature_2m"),
                        "weatherCode": curr.get("weather_code"),
                    }
            except Exception:
                pass

            results.append({
                "slug": loc["slug"],
                "name": loc["name"],
                "province": loc.get("province", ""),
                "country": loc.get("country", "ZW"),
                "tags": tags,
                **weather_info,
            })

    return {
        "locations": results[:10],
        "summary": f"Found {len(results)} locations matching \"{query}\"." if results else f"No locations found matching \"{query}\". Try a different search term.",
    }


# ---------------------------------------------------------------------------
# Request/response models
# ---------------------------------------------------------------------------


class ExploreSearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=500)


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


@router.post("/api/py/explore/search")
async def explore_search(body: ExploreSearchRequest, request: Request):
    """
    POST /api/py/explore/search

    AI-powered natural language location search.
    Falls back to text search if AI is unavailable.
    """
    query = body.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Query is required")

    # Rate limiting — extract real IP behind Vercel's reverse proxy
    ip = get_client_ip(request)
    if not ip:
        raise HTTPException(status_code=400, detail="Could not determine IP")

    rate = check_rate_limit(ip, "explore_search", RATE_LIMIT_MAX, RATE_LIMIT_WINDOW)
    if not rate["allowed"]:
        raise HTTPException(status_code=429, detail="Rate limit exceeded. Try again later.")

    # Circuit breaker check — fall back to text search if Anthropic is down
    if not anthropic_breaker.is_allowed:
        return _text_search_fallback(query)

    # Try AI-powered search
    try:
        client = _get_client()
    except HTTPException:
        return _text_search_fallback(query)

    # Build location list for system prompt context
    locations = _get_location_context()
    loc_list = ", ".join(f"{l['name']} ({l['slug']})" for l in locations[:50])

    system_prompt = _build_search_system_prompt(query)
    system_prompt += f"\n\nAvailable locations include: {loc_list}"

    prompt_doc = _get_search_prompt()
    model = (prompt_doc or {}).get("model", "claude-haiku-4-5-20251001")
    max_tokens = (prompt_doc or {}).get("maxTokens", 400)

    try:
        messages = [{"role": "user", "content": query}]
        collected_locations: list[dict] = []

        # Tool-use loop
        for _ in range(MAX_TOOL_ITERATIONS):
            response = client.messages.create(
                model=model,
                max_tokens=max_tokens,
                system=system_prompt,
                tools=TOOLS,
                messages=messages,
            )
            anthropic_breaker.record_success()

            # Process response blocks
            tool_uses = []
            text_content = ""

            for block in response.content:
                if block.type == "text":
                    text_content += block.text
                elif block.type == "tool_use":
                    tool_uses.append(block)

            if not tool_uses:
                # Done — no more tool calls
                break

            # Execute tools and build results
            messages.append({"role": "assistant", "content": response.content})
            tool_results = []

            for tool_use in tool_uses:
                result = _exec_tool(tool_use.name, tool_use.input)
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tool_use.id,
                    "content": result,
                })

                # Collect location results for the response
                if tool_use.name == "search_locations":
                    import json
                    try:
                        parsed = json.loads(result)
                        if isinstance(parsed, list):
                            for loc in parsed:
                                if loc.get("slug") and not any(
                                    cl["slug"] == loc["slug"] for cl in collected_locations
                                ):
                                    collected_locations.append(loc)
                    except Exception:
                        pass

                elif tool_use.name == "get_weather":
                    import json
                    try:
                        parsed = json.loads(result)
                        slug = parsed.get("slug", "")
                        if slug and not parsed.get("error"):
                            # Merge weather into collected location
                            for cl in collected_locations:
                                if cl["slug"] == slug:
                                    cl["temperature"] = parsed.get("temperature")
                                    cl["weatherCode"] = parsed.get("weatherCode")
                                    cl["humidity"] = parsed.get("humidity")
                                    cl["windSpeed"] = parsed.get("windSpeed")
                                    break
                    except Exception:
                        pass

            messages.append({"role": "user", "content": tool_results})

        return {
            "locations": collected_locations[:10],
            "summary": text_content or f"Found {len(collected_locations)} locations matching your search.",
        }

    except anthropic.RateLimitError:
        anthropic_breaker.record_failure()
        return _text_search_fallback(query)
    except anthropic.APIError:
        anthropic_breaker.record_failure()
        return _text_search_fallback(query)
    except Exception:
        anthropic_breaker.record_failure()
        return _text_search_fallback(query)
