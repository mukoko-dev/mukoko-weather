"""
Community weather reports — the AI follow-up questions only.

``POST /api/py/reports`` (submit), ``GET /api/py/reports`` (list) and
``POST /api/py/reports/upvote`` are gone: they are the Rust Worker's
``/v1/reports`` and ``/v1/reports/upvote`` (``workers/places/src/reports.rs``,
rules in ``weather_core::community``, MongoDB through the bridge).

What stays is ``POST /api/py/reports/clarify``, the model's one-or-two
follow-up questions in the report wizard, until the AI batch ports it to the AI
Worker (#333). The Rust rules for it are already in ``weather_core::community``
(``clarify_prompt``, ``parse_questions``, ``fallback_questions``). It uses the
``system:report_clarification`` prompt.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ._db import enforce_rate_limit
from ._ai_prompts import get_ai_prompt
from ._ai_gateway import call_ai, first_text
from ._places_resolver import find_location

router = APIRouter()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

REPORT_TYPES = {
    "light-rain", "heavy-rain", "thunderstorm", "hail", "flooding",
    "strong-wind", "clear-skies", "cloudy", "fog", "mist", "haze", "dust", "frost",
}

_FALLBACK_CLARIFICATION_PROMPT = """You are helping a user submit a weather report for {locationName}. They selected: {reportType}.

Ask 1-2 brief follow-up questions to clarify the severity and specifics of what they're experiencing. Use simple, conversational language.

Rules:
- Ask maximum 2 questions
- Use simple language accessible to all literacy levels
- Never use emoji
- Format as a numbered list
- Keep questions under 15 words each"""


# ---------------------------------------------------------------------------
# Request model
# ---------------------------------------------------------------------------


class ClarifyRequest(BaseModel):
    locationSlug: str
    reportType: str


# ---------------------------------------------------------------------------
# POST /api/py/reports/clarify — AI-assisted report clarification
# ---------------------------------------------------------------------------


@router.post("/api/py/reports/clarify")
async def clarify_report(body: ClarifyRequest, request: Request):
    """Get AI-generated follow-up questions for a weather report."""
    if body.reportType not in REPORT_TYPES:
        raise HTTPException(status_code=400, detail="Invalid report type")

    # Rate limit
    enforce_rate_limit(request, "report_clarify", 10, 3600, detail="Rate limit exceeded")

    # Get location name (Phase 0G: places.placesGeo via canonical resolver)
    loc = find_location(body.locationSlug)
    location_name = loc.get("name") if loc else body.locationSlug

    # Build prompt from database
    prompt_doc = get_ai_prompt("system:report_clarification")
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

    model = (prompt_doc or {}).get("model")
    max_tokens = (prompt_doc or {}).get("maxTokens", 150)

    # No key, open circuit or any AI error: hardcoded fallback questions
    response, err = call_ai(
        model=model,
        max_tokens=max_tokens,
        system=system_prompt,
        messages=[{"role": "user", "content": f"I'm reporting: {body.reportType}"}],
    )
    if err is not None:
        return {"questions": _fallback_questions(body.reportType)}

    questions_text = first_text(response)

    # Parse numbered questions
    questions = [
        line.strip().lstrip("0123456789.").strip()
        for line in questions_text.strip().split("\n")
        if line.strip() and line.strip()[0].isdigit()
    ]

    return {"questions": questions[:2] if questions else _fallback_questions(body.reportType)}


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
        "cloudy": ["Is it fully overcast or partly cloudy?", "Any sign of rain coming?"],
        "fog": ["How far can you see ahead?", "Is the fog getting thicker or thinner?"],
        "mist": ["How far can you see ahead?", "Is it affecting your visibility while driving?"],
        "haze": ["Does the air look dusty, smoky, or just hazy?", "How far can you see ahead?"],
        "dust": ["Can you taste the dust in the air?", "How far can you see?"],
        "frost": ["Is the frost visible on surfaces?", "Are your car windows frosted over?"],
    }
    return fallbacks.get(report_type, ["How severe would you rate it?", "Is it affecting your plans?"])
