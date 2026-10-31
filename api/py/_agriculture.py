"""
Agriculture AI explanation (``POST /api/py/ai/agriculture``).

The deterministic farm-weather data is no longer computed here: it is the Rust
Worker's ``GET /v1/agriculture`` (``workers/forecast/src/agriculture.rs``,
logic in ``weather_core::agriculture``, pinned to the old Python by
``tests/fixtures/agriculture-analysis.json``). This module asks the Worker for
that data (:func:`fetch_agriculture`) and keeps what the AI route needs until
it is ported with the rest of the AI batch (#333): the Pydantic response
models, the numbers-only brief for the prompt, the deterministic fallback text
and the AI cache.

``POST /api/py/ai/agriculture``
    Signed-in only: reached through the auth-gated ``/api/ai/agriculture``
    Next.js proxy and guarded by ``require_internal_caller``. It fetches the
    deterministic data server-side (never trusting client numbers) and asks
    the model, through ``call_ai``, to *explain* those numbers: one line for
    the snapshot card (``mode: "snapshot"``) or a longer agronomy briefing
    (``mode: "briefing"``). Prompts are database-driven
    (``system:agriculture_snapshot`` / ``system:agriculture_briefing``).
    Cached in ``weather.agriculture_ai`` keyed by grid cell + mode + the sorted
    farming activity ids, so text written for one crop set is never served to
    a visitor with another. Fallback text is cached for 60 s only.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ._db import (
    SLUG_RE,
    enforce_rate_limit,
    filter_known_activities,
    get_activities_brief,
    require_internal_caller,
    stamp_platform_fields,
    weather_db,
)
from ._http import get_http_client
from ._weather_cache_key import weather_cache_key

router = APIRouter()
logger = logging.getLogger(__name__)

HTTP_TIMEOUT_S = 10.0
AI_CACHE_TTL_S = 3600
AI_FALLBACK_TTL_S = 60

ATTRIBUTION = (
    "Soil, evapotranspiration and forecast data: Open-Meteo (ECMWF, NOAA, DWD and "
    "others; CC BY 4.0). Windows and risks are rules of thumb computed by mukoko "
    "weather, not agronomic prescriptions."
)

GDD_BASE_C = 10.0
GDD_CAP_C = 30.0

#: The public Worker origin (same default as ``src/lib/weather-api.ts``).
DEFAULT_WEATHER_API_URL = "https://weather-api.mukoko.com"

# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

WindowStatus = Literal["go", "wait", "avoid"]
RiskLevel = Literal["none", "moderate", "high"]
MoistureBand = Literal["dry", "adequate", "moist", "saturated"]
BalanceStatus = Literal["deficit", "balanced", "surplus"]


class TimeWindow(BaseModel):
    start: str
    end: str
    hours: int


class FarmWindow(BaseModel):
    """One farm job's go/wait/avoid call with the reason in plain words."""

    status: WindowStatus
    label: str
    detail: str
    window: Optional[TimeWindow] = None


class FarmWindows(BaseModel):
    spray: FarmWindow
    plant: FarmWindow
    harvest: FarmWindow
    irrigate: FarmWindow


class RainSummary(BaseModel):
    next24hMm: Optional[float] = None
    next7dMm: Optional[float] = None
    next16dMm: Optional[float] = None
    past7dMm: Optional[float] = None
    past30dMm: Optional[float] = None
    rainyDaysNext7: int = 0
    nextRainDate: Optional[str] = None


class SoilSummary(BaseModel):
    """Volumetric soil water (m³/m³) and soil temperature (°C) right now."""

    moistureTopsoil: Optional[float] = None
    moistureRootZone: Optional[float] = None
    moistureBand: Optional[MoistureBand] = None
    temperatureSurface: Optional[float] = None
    temperatureSeedDepth: Optional[float] = None
    temperatureRootZone: Optional[float] = None


class WaterBalance(BaseModel):
    """FAO-56 reference ET₀ against rain (mm). Positive balance = surplus."""

    et0Next7dMm: Optional[float] = None
    rainNext7dMm: Optional[float] = None
    balanceNext7dMm: Optional[float] = None
    et0Past7dMm: Optional[float] = None
    rainPast7dMm: Optional[float] = None
    balancePast7dMm: Optional[float] = None
    status: Optional[BalanceStatus] = None


class GDDSummary(BaseModel):
    """Growing degree days, base 10 °C, cap 30 °C (maize/soybean method)."""

    base: float = GDD_BASE_C
    cap: float = GDD_CAP_C
    today: Optional[float] = None
    past30d: Optional[float] = None
    next7d: Optional[float] = None


class Risk(BaseModel):
    level: RiskLevel
    days: list[str] = []
    extremeC: Optional[float] = None
    detail: str


class Risks(BaseModel):
    frost: Risk
    heat: Risk


class WindSummary(BaseModel):
    speedKmh: Optional[float] = None
    gustKmh: Optional[float] = None
    sprayable: bool = False
    detail: str = ""


class AgriDay(BaseModel):
    """One location-local day for the charts. Soil fields: forecast days only."""

    date: str
    forecast: bool
    rainMm: Optional[float] = None
    rainProbability: Optional[float] = None
    et0Mm: Optional[float] = None
    balanceMm: Optional[float] = None
    tMax: Optional[float] = None
    tMin: Optional[float] = None
    windMaxKmh: Optional[float] = None
    gdd: Optional[float] = None
    gddCumulative: Optional[float] = None
    soilMoisture0to1: Optional[float] = None
    soilMoisture1to3: Optional[float] = None
    soilMoisture3to9: Optional[float] = None
    soilMoisture9to27: Optional[float] = None
    soilMoisture27to81: Optional[float] = None
    soilTemp0: Optional[float] = None
    soilTemp6: Optional[float] = None
    soilTemp18: Optional[float] = None
    soilTemp54: Optional[float] = None
    vpdMaxKpa: Optional[float] = None
    leafWetHours: Optional[int] = None
    sprayHours: Optional[int] = None


class SeasonModel(BaseModel):
    name: str
    localName: str
    description: str = ""


class CropCalendar(BaseModel):
    """One crop's typical calendar (from the location profile)."""

    id: str
    label: str
    phase: Optional[str] = None
    months: dict[str, list[int]] = {}


class ProfileContext(BaseModel):
    """Climate context from the location profile, when one is stored."""

    koppen: Optional[str] = None
    normalHigh: Optional[float] = None
    normalLow: Optional[float] = None
    ensoPhase: Optional[str] = None


class AgricultureResponse(BaseModel):
    available: bool
    reason: Optional[str] = None
    headline: Optional[str] = None
    verdict: Optional[WindowStatus] = None
    windows: Optional[FarmWindows] = None
    rain: Optional[RainSummary] = None
    soil: Optional[SoilSummary] = None
    waterBalance: Optional[WaterBalance] = None
    gdd: Optional[GDDSummary] = None
    risks: Optional[Risks] = None
    wind: Optional[WindSummary] = None
    sprayWindows: list[TimeWindow] = []
    daily: list[AgriDay] = []
    season: Optional[SeasonModel] = None
    calendar: list[CropCalendar] = []
    profile: Optional[ProfileContext] = None
    crops: list[str] = []
    timezone: Optional[str] = None
    utcOffsetSeconds: Optional[int] = None
    elevation: Optional[float] = None
    attribution: str = ATTRIBUTION
    fetchedAt: str



# ---------------------------------------------------------------------------
# The deterministic data (served by the Rust Worker)
# ---------------------------------------------------------------------------

_COUNTRY_RE = re.compile(r"^[A-Z]{2}$")


def _weather_api_base() -> str:
    """The Worker origin: ``NEXT_PUBLIC_WEATHER_API_URL`` when it is a bare
    https origin (or localhost http), else the public default."""
    raw = (os.environ.get("NEXT_PUBLIC_WEATHER_API_URL") or "").strip().rstrip("/")
    if raw.startswith("https://") and "?" not in raw and "#" not in raw and "@" not in raw:
        return raw
    return DEFAULT_WEATHER_API_URL


def _resolve_country(country: str, location: str) -> str:
    code = (country or "").strip().upper()
    return code if _COUNTRY_RE.match(code) else ""


def _clean_slug(slug: str) -> str:
    s = (slug or "").strip().lower()
    return s if SLUG_RE.match(s) else ""


def _fetch_agriculture_sync(lat: float, lon: float, country: str, crops: list[str], location: str) -> dict:
    params = {"lat": f"{lat}", "lon": f"{lon}"}
    if location:
        params["location"] = location
    if country:
        params["country"] = country
    if crops:
        params["crops"] = ",".join(crops)
    resp = get_http_client(HTTP_TIMEOUT_S).get(f"{_weather_api_base()}/v1/agriculture", params=params)
    resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, dict):
        raise ValueError("non-object body")
    return data


async def fetch_agriculture(
    lat: float, lon: float, *, country: str, crops: list[str], location: str = ""
) -> "AgricultureResponse":
    """The Worker's deterministic farm data as an :class:`AgricultureResponse`.
    Any failure is ``available: false`` with ``reason: provider_error``."""
    now = datetime.now(timezone.utc).isoformat()
    try:
        data = await asyncio.to_thread(_fetch_agriculture_sync, lat, lon, country, crops, _clean_slug(location))
        return AgricultureResponse.model_validate(data)
    except Exception as exc:  # the AI route degrades to its fallback text
        logger.warning("agriculture: Worker unavailable (%s)", type(exc).__name__)
        return AgricultureResponse(available=False, reason="provider_error", fetchedAt=now)


# ---------------------------------------------------------------------------
# AI explanation (signed-in only)
# ---------------------------------------------------------------------------

AIMode = Literal["snapshot", "briefing"]
MAX_AI_CROPS = 5

#: Capability the billing work (nyuchi/api-gateway) will check before paid AI
#: features. Not enforced yet — see :func:`agri_ai_entitled`.
AGRI_CAPABILITY = "weather.agri_insights"

_FALLBACK_PROMPTS: dict[str, str] = {
    "snapshot": (
        "You are Shamwari Weather, a practical farm-weather adviser. Explain the "
        "deterministic farm data you are given in ONE sentence of at most 30 words: "
        "the single most useful thing a farmer at this place should do today and why. "
        "Use only the numbers provided; never invent data. No emoji, no headings, no markdown."
    ),
    "briefing": (
        "You are Shamwari Weather, an agronomy adviser grounded in local farming practice. "
        "Write a farm-weather briefing from the deterministic data you are given. Use "
        "markdown bullet points and **bold**, no headings, under 220 words. Cover: field "
        "work this week (spraying, planting, harvesting), water (soil moisture, ET0 against "
        "rain, irrigation), crop risks (frost, heat, disease when leaves stay wet), and one "
        "tip per crop the user grows, framed for this country and season. Use only the "
        "numbers provided; never invent data. No emoji."
    ),
}
_MAX_TOKENS = {"snapshot": 120, "briefing": 700}
_PROMPT_KEYS = {"snapshot": "system:agriculture_snapshot", "briefing": "system:agriculture_briefing"}


class AgriLocation(BaseModel):
    slug: str = Field(default="", max_length=80)
    name: str = Field(default="", max_length=120)
    country: str = Field(default="", max_length=3)
    elevation: Optional[float] = None
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


class AgriAIRequest(BaseModel):
    location: AgriLocation
    activities: list[str] = Field(default_factory=list, max_length=20)
    mode: AIMode = "snapshot"


class AgriAIResponse(BaseModel):
    text: str
    source: Literal["ai", "fallback"]
    cached: bool
    mode: AIMode
    generatedAt: str


def agri_ai_entitled(request: Optional[Request]) -> bool:
    """Entitlement hook for the paid agriculture AI (``AGRI_CAPABILITY``).

    The billing service in nyuchi/api-gateway is still being built, so every
    signed-in caller is allowed today. When it ships, check the caller's
    capability here (``X-Mukoko-User-Id`` is stamped by the auth proxy) and
    return False to serve the deterministic fallback instead of model text.
    """
    return True


def farming_activities(ids: list[str]) -> list[str]:
    """Known activity ids in the farming category, de-duplicated, capped."""
    known = filter_known_activities(ids)
    farming = {a.get("id") for a in get_activities_brief() if a.get("category") == "farming"}
    if farming:
        known = [a for a in known if a in farming]
    return list(dict.fromkeys(known))[:MAX_AI_CROPS]


def _place_id(loc: "AgriLocation") -> str:
    """Identity of the place the text names: its slug, else its normalised name."""
    slug = _clean_slug(loc.slug)
    if slug:
        return slug
    return re.sub(r"[^a-z0-9]+", "-", (loc.name or "").lower()).strip("-")[:80] or "-"


def ai_cache_key(loc: "AgriLocation", mode: str, activities: list[str]) -> str:
    """Cell + place + country + mode + sorted farming ids.

    The prompt names the place and its country, so two places in one cell
    (a town and a suburb, a page slug and a GPS spot) never share text.
    """
    country = (loc.country or "").strip().upper()[:3] or "-"
    base = f"{weather_cache_key(loc.lat, loc.lon)}:{_place_id(loc)}:{country}:{mode}"
    return f"{base}:{','.join(sorted(activities))}" if activities else base


def _ai_cache():
    return weather_db()["agriculture_ai"]


def _get_cached_ai(key: str) -> Optional[dict]:
    try:
        return _ai_cache().find_one({"_id": key, "expiresAt": {"$gt": datetime.now(timezone.utc)}})
    except Exception:
        return None


def _set_cached_ai(key: str, text: str, source: str) -> None:
    now = datetime.now(timezone.utc)
    ttl = AI_FALLBACK_TTL_S if source == "fallback" else AI_CACHE_TTL_S
    doc = {"_id": key, "text": text, "source": source, "generatedAt": now, "expiresAt": now + timedelta(seconds=ttl)}
    stamp_platform_fields(doc)
    try:
        _ai_cache().update_one({"_id": key}, {"$set": doc}, upsert=True)
    except Exception:
        pass


def _fmt(value: Optional[float], unit: str = "", digits: int = 0) -> str:
    if value is None:
        return "n/a"
    return f"{value:.{digits}f}{unit}"


def data_brief(data: AgricultureResponse) -> str:
    """Compact, numbers-only description of the deterministic data for the prompt."""
    w, r, s, wb, g, rk = data.windows, data.rain, data.soil, data.waterBalance, data.gdd, data.risks
    lines = [f"Verdict: {data.headline}"]
    if w:
        for name in ("spray", "plant", "harvest", "irrigate"):
            fw: FarmWindow = getattr(w, name)
            lines.append(f"{name.capitalize()}: {fw.status} — {fw.label}. {fw.detail}")
    if r:
        lines.append(
            f"Rain: next 24h {_fmt(r.next24hMm, ' mm', 1)}, next 7 days {_fmt(r.next7dMm, ' mm', 1)} "
            f"({r.rainyDaysNext7} rainy days), past 30 days {_fmt(r.past30dMm, ' mm', 1)}."
        )
    if s:
        lines.append(
            f"Soil: topsoil moisture {_fmt(s.moistureTopsoil, ' m3/m3', 2)} ({s.moistureBand or 'n/a'}), "
            f"root zone {_fmt(s.moistureRootZone, ' m3/m3', 2)}, seed-depth temperature {_fmt(s.temperatureSeedDepth, ' C', 1)}."
        )
    if wb:
        lines.append(
            f"Water balance next 7 days: ET0 {_fmt(wb.et0Next7dMm, ' mm')} vs rain {_fmt(wb.rainNext7dMm, ' mm')} "
            f"= {_fmt(wb.balanceNext7dMm, ' mm')} ({wb.status or 'n/a'})."
        )
    if g:
        lines.append(f"GDD (base 10): past 30 days {_fmt(g.past30d)}, next 7 days {_fmt(g.next7d)}.")
    if rk:
        lines.append(f"Frost: {rk.frost.level} — {rk.frost.detail} Heat: {rk.heat.level} — {rk.heat.detail}")
    for c in data.calendar:
        lines.append(f"Crop calendar: {c.label} is in its {c.phase or 'unknown'} phase.")
    if data.profile:
        p = data.profile
        lines.append(
            f"Climate: Koppen {p.koppen or 'n/a'}, normal high/low for this time of year "
            f"{_fmt(p.normalHigh, ' C')}/{_fmt(p.normalLow, ' C')}, ENSO {p.ensoPhase or 'n/a'}."
        )
    wet = [d.leafWetHours for d in data.daily if d.forecast and d.leafWetHours is not None][:3]
    if wet:
        lines.append(f"Leaf-wet hours next 3 days: {', '.join(str(x) for x in wet)}.")
    return "\n".join(lines)


def _system_prompt(mode: str) -> tuple[str, int]:
    from ._ai_prompts import get_ai_prompt

    doc = get_ai_prompt(_PROMPT_KEYS[mode]) or {}
    template = doc.get("template") or _FALLBACK_PROMPTS[mode]
    max_tokens = doc.get("maxTokens") or _MAX_TOKENS[mode]
    return template, int(max_tokens)


def fallback_text(data: AgricultureResponse, mode: str) -> str:
    """Deterministic text when the model is unavailable or not entitled."""
    if not data.available or not data.windows:
        return "Farm data is unavailable right now. Check back shortly."
    first = data.headline or ""
    if mode == "snapshot":
        return f"{first} {data.windows.spray.label}; {data.windows.irrigate.label.lower()}."
    w = data.windows
    return "\n".join([
        f"**{first}**",
        f"- **Spraying:** {w.spray.label}. {w.spray.detail}",
        f"- **Planting:** {w.plant.label}. {w.plant.detail}",
        f"- **Harvest:** {w.harvest.label}. {w.harvest.detail}",
        f"- **Irrigation:** {w.irrigate.label}. {w.irrigate.detail}",
    ] + ([f"- **Frost:** {data.risks.frost.detail}", f"- **Heat:** {data.risks.heat.detail}"] if data.risks else []))


@router.post("/api/py/ai/agriculture", response_model=AgriAIResponse)
async def agriculture_ai(body: AgriAIRequest, request: Request = None):
    """
    POST /api/py/ai/agriculture

    AI explanation of the deterministic agriculture data. Reached through the
    auth-gated ``/api/ai/agriculture`` proxy only.
    """
    from ._ai_gateway import call_ai, first_text

    require_internal_caller(request)

    loc = body.location
    mode = body.mode
    activities = farming_activities(body.activities)
    now = datetime.now(timezone.utc).isoformat()

    if not agri_ai_entitled(request):
        # Not entitled: deterministic text only. Never read or write the AI
        # cache here, so model text is never served to an unentitled caller.
        data = await fetch_agriculture(loc.lat, loc.lon, country=loc.country, crops=activities, location=loc.slug)
        return AgriAIResponse(text=fallback_text(data, mode), source="fallback", cached=False, mode=mode, generatedAt=now)

    key = ai_cache_key(loc, mode, activities)
    cached = _get_cached_ai(key)
    if not cached:
        # Only a request that may spend a model call is metered: a cache hit
        # is a cheap read, and metering it let page remounts exhaust the limit.
        enforce_rate_limit(request, "ai-agriculture", 30, 3600, require_ip=False)
    if cached:
        generated = cached.get("generatedAt")
        return AgriAIResponse(
            text=cached.get("text", ""),
            source=cached.get("source", "ai"),
            cached=True,
            mode=mode,
            generatedAt=generated.isoformat() if isinstance(generated, datetime) else str(generated or ""),
        )

    country = _resolve_country(loc.country, "")
    data = await fetch_agriculture(loc.lat, loc.lon, country=country, crops=activities, location=loc.slug)

    if not data.available:
        text = fallback_text(data, mode)
        _set_cached_ai(key, text, "fallback")
        return AgriAIResponse(text=text, source="fallback", cached=False, mode=mode, generatedAt=now)

    briefs = {a.get("id"): a for a in get_activities_brief()}
    crop_lines = []
    for a in activities:
        b = briefs.get(a) or {"label": a}
        guidance = f" Guidance: {b['aiInstructions']}" if b.get("aiInstructions") else ""
        crop_lines.append(f"- {b.get('label') or a}{guidance}")
    crops_block = "\n".join(crop_lines) if crop_lines else "- Not specified (assume the main staple crop of this area)."
    season = data.season
    place = loc.name or "this location"
    country_part = f", {country}" if country else ""
    elevation = loc.elevation if loc.elevation is not None else data.elevation
    parts = [
        f"Place: {place}{country_part} (lat {loc.lat:.2f}, lon {loc.lon:.2f}; elevation {_fmt(elevation, ' m')}).",
    ]
    if season:
        parts.append(f"Season: {season.localName} ({season.name}) — {season.description}")
    parts += [
        f"The user's farming:\n{crops_block}",
        "",
        f"Deterministic farm data (computed from the forecast; explain it, do not change it):\n{data_brief(data)}",
        "",
        "Ground the advice in this place, its country and season, and the user's crops — never generic global advice.",
    ]
    user_content = "\n".join(parts)

    system, max_tokens = _system_prompt(mode)
    response, err = await asyncio.to_thread(
        lambda: call_ai(
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user_content}],
        )
    )
    if err == "rate_limited":
        # Say "try again later" honestly rather than caching fallback text.
        raise HTTPException(status_code=429, detail="AI is busy. Try again shortly.")
    text = first_text(response).strip() if err is None else ""
    source: Literal["ai", "fallback"] = "ai" if text else "fallback"
    if not text:
        text = fallback_text(data, mode)
    _set_cached_ai(key, text, source)
    return AgriAIResponse(text=text, source=source, cached=False, mode=mode, generatedAt=now)
