"""
Agriculture endpoints — deterministic farm-weather data plus AI explanations.

``GET /api/py/agriculture?lat=&lon=[&location=][&country=][&crops=]``
    Public, anonymous. One batched Open-Meteo forecast request (soil moisture
    and soil temperature by depth, ET₀, vapour-pressure deficit, leaf wetness,
    rain, wind, temperature; the past 30 days plus 16 forecast days) behind
    ``open_meteo_breaker``. The raw payload is cached 1 h per 0.05° grid cell
    (``weather_cache_key``) in ``weather.agriculture_cache``; the analysis runs
    on every request because it is cheap and depends on the caller's crops.

    Everything here is deterministic: spray / plant / harvest / irrigate
    windows, rain totals, soil band, water balance (ET₀ against rain), growing
    degree days, frost and heat-stress risk and a daily series for charts.
    Season, crop calendars and climate normals come from the shared location
    profile (``get_location_profile``) — this module keeps no calendar store.
    Failures return ``available: false`` with a ``reason`` (HTTP 200), never
    a 500.

``POST /api/py/ai/agriculture``
    Signed-in only: reached through the auth-gated ``/api/ai/agriculture``
    Next.js proxy and guarded by ``require_internal_caller``. It recomputes the
    deterministic data server-side (never trusting client numbers) and asks
    the model, through ``call_ai``, to *explain* those numbers — one line for
    the snapshot card (``mode: "snapshot"``) or a longer agronomy briefing
    (``mode: "briefing"``). Prompts are database-driven
    (``system:agriculture_snapshot`` / ``system:agriculture_briefing``).
    Cached in ``weather.agriculture_ai`` keyed by grid cell + mode + the sorted
    farming activity ids, so text written for one crop set is never served to
    a visitor with another. Fallback text is cached for 60 s only.

Thresholds are agronomic rules of thumb (FAO-56, extension-service guidance),
tuned here in one place. Soil-moisture bands are approximate: real field
capacity depends on soil texture, which the models do not know.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from ._circuit_breaker import CircuitOpenError, open_meteo_breaker
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
from ._insights import growing_degree_days
from ._weather_cache_key import weather_cache_key

router = APIRouter()
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Upstream request
# ---------------------------------------------------------------------------

OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast"

SOIL_MOISTURE_FIELDS: tuple[str, ...] = (
    "soil_moisture_0_to_1cm",
    "soil_moisture_1_to_3cm",
    "soil_moisture_3_to_9cm",
    "soil_moisture_9_to_27cm",
    "soil_moisture_27_to_81cm",
)
#: The forecast API's soil-temperature levels (it publishes these four).
SOIL_TEMPERATURE_FIELDS: tuple[str, ...] = (
    "soil_temperature_0cm",
    "soil_temperature_6cm",
    "soil_temperature_18cm",
    "soil_temperature_54cm",
)
HOURLY_FIELDS: tuple[str, ...] = (
    *SOIL_MOISTURE_FIELDS,
    *SOIL_TEMPERATURE_FIELDS,
    "vapour_pressure_deficit",
    "leaf_wetness_probability",
    "precipitation",
    "precipitation_probability",
    "wind_speed_10m",
    "wind_gusts_10m",
    "relative_humidity_2m",
    "temperature_2m",
    "is_day",
)
DAILY_FIELDS: tuple[str, ...] = (
    "et0_fao_evapotranspiration",
    "precipitation_sum",
    "precipitation_probability_max",
    "temperature_2m_max",
    "temperature_2m_min",
    "wind_speed_10m_max",
    "wind_gusts_10m_max",
)
PAST_DAYS = 30
FORECAST_DAYS = 16
FORECAST_PARAMS: dict[str, Any] = {
    "hourly": ",".join(HOURLY_FIELDS),
    "daily": ",".join(DAILY_FIELDS),
    "past_days": PAST_DAYS,
    "forecast_days": FORECAST_DAYS,
    # Hourly only needs now → +16 days; daily keeps the past 30 days.
    "past_hours": 1,
    "forecast_hours": FORECAST_DAYS * 24,
    "timezone": "auto",
}

HTTP_TIMEOUT_S = 10.0
DATA_CACHE_TTL_S = 3600
AI_CACHE_TTL_S = 3600
AI_FALLBACK_TTL_S = 60

ATTRIBUTION = (
    "Soil, evapotranspiration and forecast data: Open-Meteo (ECMWF, NOAA, DWD and "
    "others; CC BY 4.0). Windows and risks are rules of thumb computed by mukoko "
    "weather, not agronomic prescriptions."
)


# ---------------------------------------------------------------------------
# Agronomic thresholds (one place to tune)
# ---------------------------------------------------------------------------

# Spraying: drift below 3 km/h (inversions) and above 15 km/h; rain within
# 2 h washes product off; hot dry air volatilises it.
SPRAY_WIND_MIN_KMH = 3.0
SPRAY_WIND_MAX_KMH = 15.0
SPRAY_GUST_MAX_KMH = 25.0
SPRAY_TEMP_MIN_C = 8.0
SPRAY_TEMP_MAX_C = 30.0
SPRAY_RH_MIN = 35.0
SPRAY_RAIN_FREE_HOURS = 2
SPRAY_RAIN_MM = 0.1
SPRAY_RAIN_PROB = 30.0
SPRAY_MIN_WINDOW_HOURS = 2
SPRAY_LOOKAHEAD_HOURS = 48

# Planting: soil warm enough to germinate (maize ~10 °C at seed depth) and
# moist enough, or an effective planting rain (25 mm across a few days).
PLANT_SOIL_TEMP_MIN_C = 12.0
PLANT_MOISTURE_MIN = 0.20
PLANT_RAIN_MM = 25.0
PLANT_WASHOUT_MM = 40.0

# Harvest / drying: dry days ahead.
HARVEST_DRY_DAYS = 3
HARVEST_RAIN_MM = 2.0
HARVEST_RAIN_PROB = 40.0

# Irrigation: deficit of ET₀ minus rain over the next 3 days.
IRRIGATE_DEFICIT_GO_MM = 10.0
IRRIGATE_DEFICIT_WATCH_MM = 4.0
IRRIGATE_DRY_TOPSOIL = 0.15

# Water balance over the next 7 days (rain − ET₀, mm).
BALANCE_DEFICIT_MM = -10.0
BALANCE_SURPLUS_MM = 10.0

# Volumetric soil water (m³/m³). Approximate — texture dependent.
MOISTURE_BANDS: tuple[tuple[float, str], ...] = (
    (0.38, "saturated"),
    (0.25, "moist"),
    (0.15, "adequate"),
    (0.0, "dry"),
)

FROST_HIGH_C = 2.0
FROST_POSSIBLE_C = 4.0
HEAT_HIGH_C = 35.0
HEAT_MODERATE_C = 32.0

GDD_BASE_C = 10.0
GDD_CAP_C = 30.0


# ---------------------------------------------------------------------------
# Location profile (owned by the location-profile work, consumed here)
# ---------------------------------------------------------------------------
#
# Seasons with local names, crop planting/growing/harvest calendars with the
# current phase, climate normals, Köppen zone, soil and ENSO are stored per
# location in ``weather.locationProfiles`` and served by a shared helper,
# ``get_location_profile(...)``. This module never keeps its own calendar or
# season store: it reads the profile through :func:`load_location_profile`
# and maps the parts it shows. Until the helper ships, the import fails and
# the response simply carries no calendar (the season falls back to the
# hemisphere default).

#: Farming activity ids that are crops (used to ask the profile for them).
CALENDAR_CROPS: tuple[str, ...] = (
    "crop-farming",
    "tobacco-farming",
    "cotton-farming",
    "horticulture",
    "gardening",
)
DEFAULT_CROP = "crop-farming"

_STAGES: tuple[str, ...] = ("nursery", "plant", "grow", "harvest")


def load_location_profile(
    lat: float, lon: float, *, slug: str = "", country: str = ""
) -> Optional[dict]:
    """The stored location profile, or None (helper missing, or any error).

    Interface expected from ``get_location_profile`` (all keys optional)::

        {
          "season": {"name", "localName", "description"},
          "crops": [{"id", "label", "phase", "calendar": {stage: [month, ...]}}],
          "normals": {"high", "low"},
          "koppen": "Cwb",
          "enso": {"phase", "oni"},
        }
    """
    try:
        from ._location_profile import get_location_profile  # type: ignore[import-not-found]
    except Exception:
        return None
    try:
        profile = get_location_profile(lat=lat, lon=lon, slug=slug or None, country=country or None)
    except Exception as exc:
        logger.info("agriculture: location profile unavailable (%s)", type(exc).__name__)
        return None
    if hasattr(profile, "model_dump"):
        profile = profile.model_dump(mode="json")
    return profile if isinstance(profile, dict) else None

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
# Small pure helpers
# ---------------------------------------------------------------------------


def _num(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _series(block: dict, name: str) -> list[Optional[float]]:
    return [_num(v) for v in (block.get(name) or [])]


def _at(seq: list, i: int) -> Any:
    return seq[i] if 0 <= i < len(seq) else None


def _sum(values: list[Optional[float]]) -> Optional[float]:
    clean = [v for v in values if v is not None]
    return round(sum(clean), 1) if clean else None


def _mean(values: list[Optional[float]], digits: int = 3) -> Optional[float]:
    clean = [v for v in values if v is not None]
    return round(sum(clean) / len(clean), digits) if clean else None


def moisture_band(value: Optional[float]) -> Optional[str]:
    if value is None:
        return None
    for floor, band in MOISTURE_BANDS:
        if value >= floor:
            return band
    return "dry"


def _hhmm(iso: str) -> str:
    return iso[11:16] if len(iso) >= 16 else iso


def _day_label(iso: str, today: str) -> str:
    """"today" / "tomorrow" / "Mon 13" for a local ISO date or datetime."""
    date = iso[:10]
    if date == today:
        return "today"
    try:
        d = datetime.strptime(date, "%Y-%m-%d")
        t = datetime.strptime(today, "%Y-%m-%d")
    except ValueError:
        return date
    if (d - t).days == 1:
        return "tomorrow"
    return d.strftime("%a %d").replace(" 0", " ")


# ---------------------------------------------------------------------------
# Hourly spraying
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Hour:
    time: str
    temp: Optional[float]
    rh: Optional[float]
    wind: Optional[float]
    gust: Optional[float]
    rain: Optional[float]
    rain_prob: Optional[float]
    is_day: bool
    leaf_wet: Optional[float]


def hours_from(hourly: dict) -> list[Hour]:
    times = [str(t) for t in (hourly.get("time") or [])]
    temp = _series(hourly, "temperature_2m")
    rh = _series(hourly, "relative_humidity_2m")
    wind = _series(hourly, "wind_speed_10m")
    gust = _series(hourly, "wind_gusts_10m")
    rain = _series(hourly, "precipitation")
    prob = _series(hourly, "precipitation_probability")
    day = _series(hourly, "is_day")
    wet = _series(hourly, "leaf_wetness_probability")
    return [
        Hour(
            time=t,
            temp=_at(temp, i),
            rh=_at(rh, i),
            wind=_at(wind, i),
            gust=_at(gust, i),
            rain=_at(rain, i),
            rain_prob=_at(prob, i),
            is_day=(_at(day, i) or 0) >= 1,
            leaf_wet=_at(wet, i),
        )
        for i, t in enumerate(times)
    ]


def _wet_hour(h: Hour) -> bool:
    return (h.rain is not None and h.rain >= SPRAY_RAIN_MM) or (
        h.rain_prob is not None and h.rain_prob >= SPRAY_RAIN_PROB
    )


def spray_hour_ok(hours: list[Hour], i: int) -> bool:
    """Daylight, steady light wind, mild and not too dry, rain-free for 2 h after."""
    h = hours[i]
    if not h.is_day or h.wind is None or h.temp is None:
        return False
    if not (SPRAY_WIND_MIN_KMH <= h.wind <= SPRAY_WIND_MAX_KMH):
        return False
    if h.gust is not None and h.gust > SPRAY_GUST_MAX_KMH:
        return False
    if not (SPRAY_TEMP_MIN_C <= h.temp <= SPRAY_TEMP_MAX_C):
        return False
    if h.rh is not None and h.rh < SPRAY_RH_MIN:
        return False
    for j in range(i, min(i + SPRAY_RAIN_FREE_HOURS + 1, len(hours))):
        if _wet_hour(hours[j]):
            return False
    return True


def spray_windows(hours: list[Hour], start: int, lookahead: int = SPRAY_LOOKAHEAD_HOURS) -> list[TimeWindow]:
    """Contiguous runs of sprayable hours (≥ 2 h) in the next ``lookahead`` hours."""
    out: list[TimeWindow] = []
    run_start: Optional[int] = None
    end = min(len(hours), start + lookahead)
    for i in range(start, end + 1):
        ok = i < end and spray_hour_ok(hours, i)
        if ok and run_start is None:
            run_start = i
        elif not ok and run_start is not None:
            length = i - run_start
            if length >= SPRAY_MIN_WINDOW_HOURS:
                out.append(TimeWindow(
                    start=hours[run_start].time,
                    # The window ends at the close of its last good hour.
                    end=_add_hour(hours[i - 1].time),
                    hours=length,
                ))
            run_start = None
    return out


def _add_hour(iso: str) -> str:
    try:
        return (datetime.strptime(iso[:16], "%Y-%m-%dT%H:%M") + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M")
    except ValueError:
        return iso


def spray_window(windows: list[TimeWindow], today: str, hours: list[Hour], start: int) -> FarmWindow:
    if windows:
        first = windows[0]
        when = _day_label(first.start, today)
        label = f"Spray {when} {_hhmm(first.start)}–{_hhmm(first.end)}"
        status: WindowStatus = "go" if first.start[:10] == today else "wait"
        detail = (
            f"Light, steady wind and no rain for at least {SPRAY_RAIN_FREE_HOURS} h after. "
            f"Next good window: {when}, {first.hours} h."
        )
        return FarmWindow(status=status, label=label, detail=detail, window=first)
    # Explain the main blocker over the daylight hours ahead.
    ahead = [h for h in hours[start:start + SPRAY_LOOKAHEAD_HOURS] if h.is_day]
    if any(_wet_hour(h) for h in ahead):
        reason = "rain is likely to wash product off"
    elif any(h.wind is not None and h.wind > SPRAY_WIND_MAX_KMH for h in ahead):
        reason = f"wind above {SPRAY_WIND_MAX_KMH:.0f} km/h will cause drift"
    elif any(h.temp is not None and h.temp > SPRAY_TEMP_MAX_C for h in ahead):
        reason = "heat will volatilise product"
    else:
        reason = "conditions stay outside the safe range"
    return FarmWindow(
        status="avoid",
        label="No spray window in 48 h",
        detail=f"Hold off: {reason}.",
    )


# ---------------------------------------------------------------------------
# Daily aggregation
# ---------------------------------------------------------------------------


def _hourly_by_date(hourly: dict, field_name: str) -> dict[str, list[Optional[float]]]:
    times = [str(t) for t in (hourly.get("time") or [])]
    values = _series(hourly, field_name)
    out: dict[str, list[Optional[float]]] = {}
    for i, t in enumerate(times):
        out.setdefault(t[:10], []).append(_at(values, i))
    return out


def build_daily(raw: dict, today: str, hours: list[Hour], start: int) -> list[AgriDay]:
    daily = raw.get("daily") or {}
    hourly = raw.get("hourly") or {}
    dates = [str(t) for t in (daily.get("time") or [])]
    rain = _series(daily, "precipitation_sum")
    prob = _series(daily, "precipitation_probability_max")
    et0 = _series(daily, "et0_fao_evapotranspiration")
    tmax = _series(daily, "temperature_2m_max")
    tmin = _series(daily, "temperature_2m_min")
    wmax = _series(daily, "wind_speed_10m_max")

    moisture = {f: _hourly_by_date(hourly, f) for f in SOIL_MOISTURE_FIELDS}
    soil_t = {f: _hourly_by_date(hourly, f) for f in SOIL_TEMPERATURE_FIELDS}
    vpd = _hourly_by_date(hourly, "vapour_pressure_deficit")
    wet = _hourly_by_date(hourly, "leaf_wetness_probability")

    spray_by_date: dict[str, int] = {}
    for i in range(start, len(hours)):
        if spray_hour_ok(hours, i):
            spray_by_date[hours[i].time[:10]] = spray_by_date.get(hours[i].time[:10], 0) + 1

    out: list[AgriDay] = []
    cumulative = 0.0
    for i, date in enumerate(dates):
        is_forecast = date >= today
        r, e = _at(rain, i), _at(et0, i)
        gdd = growing_degree_days(_at(tmax, i), _at(tmin, i), GDD_BASE_C, GDD_CAP_C)
        if gdd is not None:
            cumulative += gdd
        vpd_vals = [v for v in vpd.get(date, []) if v is not None]
        wet_vals = wet.get(date, [])
        hourly_seen = date in vpd or date in wet
        out.append(AgriDay(
            date=date,
            forecast=is_forecast,
            rainMm=r,
            rainProbability=_at(prob, i),
            et0Mm=e,
            balanceMm=round(r - e, 1) if r is not None and e is not None else None,
            tMax=_at(tmax, i),
            tMin=_at(tmin, i),
            windMaxKmh=_at(wmax, i),
            gdd=gdd,
            gddCumulative=round(cumulative, 1) if gdd is not None else None,
            soilMoisture0to1=_mean(moisture["soil_moisture_0_to_1cm"].get(date, [])),
            soilMoisture1to3=_mean(moisture["soil_moisture_1_to_3cm"].get(date, [])),
            soilMoisture3to9=_mean(moisture["soil_moisture_3_to_9cm"].get(date, [])),
            soilMoisture9to27=_mean(moisture["soil_moisture_9_to_27cm"].get(date, [])),
            soilMoisture27to81=_mean(moisture["soil_moisture_27_to_81cm"].get(date, [])),
            soilTemp0=_mean(soil_t["soil_temperature_0cm"].get(date, []), 1),
            soilTemp6=_mean(soil_t["soil_temperature_6cm"].get(date, []), 1),
            soilTemp18=_mean(soil_t["soil_temperature_18cm"].get(date, []), 1),
            soilTemp54=_mean(soil_t["soil_temperature_54cm"].get(date, []), 1),
            vpdMaxKpa=round(max(vpd_vals), 2) if vpd_vals else None,
            leafWetHours=sum(1 for v in wet_vals if v is not None and v >= 50) if hourly_seen else None,
            sprayHours=spray_by_date.get(date, 0) if hourly_seen else None,
        ))
    return out


# ---------------------------------------------------------------------------
# Summaries and windows
# ---------------------------------------------------------------------------


def _split(days: list[AgriDay], today: str) -> tuple[list[AgriDay], list[AgriDay]]:
    past = [d for d in days if d.date < today]
    ahead = [d for d in days if d.date >= today]
    return past, ahead


def rain_summary(days: list[AgriDay], hours: list[Hour], start: int, today: str) -> RainSummary:
    past, ahead = _split(days, today)
    next24 = _sum([h.rain for h in hours[start:start + 24]])
    next_rain = next((d.date for d in ahead if (d.rainMm or 0) >= 1.0), None)
    return RainSummary(
        next24hMm=next24,
        next7dMm=_sum([d.rainMm for d in ahead[:7]]),
        next16dMm=_sum([d.rainMm for d in ahead]),
        past7dMm=_sum([d.rainMm for d in past[-7:]]),
        past30dMm=_sum([d.rainMm for d in past[-30:]]),
        rainyDaysNext7=sum(1 for d in ahead[:7] if (d.rainMm or 0) >= 1.0),
        nextRainDate=next_rain,
    )


def soil_summary(hourly: dict, start: int) -> SoilSummary:
    def now(field_name: str) -> Optional[float]:
        values = _series(hourly, field_name)
        # The first non-null value from now on (soil fields thin out later).
        for v in values[start:start + 6]:
            if v is not None:
                return v
        return None

    top = _mean([now("soil_moisture_0_to_1cm"), now("soil_moisture_1_to_3cm"), now("soil_moisture_3_to_9cm")])
    root = _mean([now("soil_moisture_9_to_27cm"), now("soil_moisture_27_to_81cm")])
    return SoilSummary(
        moistureTopsoil=top,
        moistureRootZone=root,
        moistureBand=moisture_band(top),  # type: ignore[arg-type]
        temperatureSurface=now("soil_temperature_0cm"),
        temperatureSeedDepth=now("soil_temperature_6cm"),
        temperatureRootZone=now("soil_temperature_18cm"),
    )


def water_balance(days: list[AgriDay], today: str) -> WaterBalance:
    past, ahead = _split(days, today)
    et_next, rain_next = _sum([d.et0Mm for d in ahead[:7]]), _sum([d.rainMm for d in ahead[:7]])
    et_past, rain_past = _sum([d.et0Mm for d in past[-7:]]), _sum([d.rainMm for d in past[-7:]])
    bal_next = round(rain_next - et_next, 1) if et_next is not None and rain_next is not None else None
    bal_past = round(rain_past - et_past, 1) if et_past is not None and rain_past is not None else None
    status: Optional[str] = None
    if bal_next is not None:
        status = (
            "deficit" if bal_next < BALANCE_DEFICIT_MM
            else ("surplus" if bal_next > BALANCE_SURPLUS_MM else "balanced")
        )
    return WaterBalance(
        et0Next7dMm=et_next,
        rainNext7dMm=rain_next,
        balanceNext7dMm=bal_next,
        et0Past7dMm=et_past,
        rainPast7dMm=rain_past,
        balancePast7dMm=bal_past,
        status=status,  # type: ignore[arg-type]
    )


def gdd_summary(days: list[AgriDay], today: str) -> GDDSummary:
    past, ahead = _split(days, today)
    return GDDSummary(
        today=ahead[0].gdd if ahead else None,
        past30d=_sum([d.gdd for d in past[-30:]]),
        next7d=_sum([d.gdd for d in ahead[:7]]),
    )


def plant_window(soil: SoilSummary, days: list[AgriDay], today: str) -> FarmWindow:
    past, ahead = _split(days, today)
    temp = soil.temperatureSeedDepth
    moisture = soil.moistureTopsoil
    rain_around = (_sum([d.rainMm for d in past[-3:]]) or 0.0) + (_sum([d.rainMm for d in ahead[:3]]) or 0.0)
    washout = next((d for d in ahead[:2] if (d.rainMm or 0) >= PLANT_WASHOUT_MM), None)
    warm = temp is not None and temp >= PLANT_SOIL_TEMP_MIN_C
    moist = (moisture is not None and moisture >= PLANT_MOISTURE_MIN) or rain_around >= PLANT_RAIN_MM

    if temp is None and moisture is None:
        return FarmWindow(status="wait", label="Soil data unavailable", detail="Check soil by hand before planting.")
    if washout is not None:
        return FarmWindow(
            status="wait",
            label="Wait: heavy rain coming",
            detail=f"{washout.rainMm:.0f} mm expected {_day_label(washout.date, today)} could wash out seed.",
        )
    if warm and moist:
        return FarmWindow(
            status="go",
            label="Good planting conditions",
            detail=f"Soil at seed depth {temp:.0f} °C and moisture adequate.",
        )
    if temp is None and moist:
        return FarmWindow(
            status="wait",
            label="Moist soil, temperature unknown",
            detail="Moisture is adequate; check the soil is warm at seed depth before planting.",
        )
    if not warm and temp is not None:
        return FarmWindow(
            status="avoid",
            label="Soil too cold to plant",
            detail=f"Seed-depth soil is {temp:.0f} °C; wait for {PLANT_SOIL_TEMP_MIN_C:.0f} °C.",
        )
    nxt = next((d for d in ahead[:7] if (d.rainMm or 0) >= 10), None)
    when = f" Next useful rain: {_day_label(nxt.date, today)}." if nxt else ""
    return FarmWindow(
        status="wait",
        label="Wait for planting rains",
        detail=f"Topsoil is dry; dry planting risks poor emergence (about {PLANT_RAIN_MM:.0f} mm needed).{when}",
    )


def harvest_window(days: list[AgriDay], today: str) -> FarmWindow:
    _, ahead = _split(days, today)
    nxt = ahead[:HARVEST_DRY_DAYS]
    if not nxt:
        return FarmWindow(status="wait", label="Forecast unavailable", detail="No daily forecast to judge drying.")

    def dry(d: AgriDay) -> bool:
        return (d.rainMm or 0) < HARVEST_RAIN_MM and (d.rainProbability or 0) < HARVEST_RAIN_PROB

    dry_run = 0
    for d in nxt:
        if not dry(d):
            break
        dry_run += 1
    if dry_run >= HARVEST_DRY_DAYS:
        return FarmWindow(status="go", label=f"{HARVEST_DRY_DAYS} dry days ahead", detail="Good for harvesting and drying grain or curing.")
    if dry_run >= len(nxt):
        return FarmWindow(status="go", label="Dry days ahead", detail="Good for harvesting and drying.")
    if dry_run >= 1:
        wet = nxt[dry_run]
        return FarmWindow(
            status="wait",
            label=f"Dry until {_day_label(wet.date, today)}",
            detail="Harvest what you can and cover drying crops before the rain.",
        )
    return FarmWindow(status="avoid", label="Rain today", detail="Keep harvested crops covered; wait for a dry spell.")


def irrigate_window(soil: SoilSummary, days: list[AgriDay], today: str) -> FarmWindow:
    _, ahead = _split(days, today)
    et3 = _sum([d.et0Mm for d in ahead[:3]])
    rain3 = _sum([d.rainMm for d in ahead[:3]]) or 0.0
    if et3 is None:
        return FarmWindow(status="wait", label="ET₀ unavailable", detail="Water by soil feel until data returns.")
    deficit = round(et3 - rain3, 1)
    dry_top = soil.moistureTopsoil is not None and soil.moistureTopsoil < IRRIGATE_DRY_TOPSOIL
    if deficit >= IRRIGATE_DEFICIT_GO_MM or (dry_top and deficit > 0):
        return FarmWindow(
            status="go",
            label=f"Irrigate: {deficit:.0f} mm deficit",
            detail=f"Crops lose about {et3:.0f} mm over 3 days and rain adds {rain3:.0f} mm. Water early morning.",
        )
    if deficit >= IRRIGATE_DEFICIT_WATCH_MM:
        return FarmWindow(
            status="wait",
            label=f"Light deficit ({deficit:.0f} mm)",
            detail="Irrigate sensitive crops; field crops can wait a day.",
        )
    return FarmWindow(
        status="avoid",
        label="No irrigation needed",
        detail=f"Rain ({rain3:.0f} mm) covers crop water use over 3 days.",
    )


def frost_risk(days: list[AgriDay], today: str) -> Risk:
    _, ahead = _split(days, today)
    week = [d for d in ahead[:7] if d.tMin is not None]
    if not week:
        return Risk(level="none", detail="No temperature forecast.")
    coldest = min(week, key=lambda d: d.tMin)  # type: ignore[arg-type, return-value]
    high = [d for d in week if d.tMin <= FROST_HIGH_C]  # type: ignore[operator]
    possible = [d for d in week if d.tMin <= FROST_POSSIBLE_C]  # type: ignore[operator]
    if high:
        first = high[0]
        return Risk(level="high", days=[d.date for d in high], extremeC=coldest.tMin,
                    detail=f"Frost likely {_day_label(first.date, today)} (low {first.tMin:.0f} °C). Cover seedlings and irrigate the evening before.")
    if possible:
        first = possible[0]
        return Risk(level="moderate", days=[d.date for d in possible], extremeC=coldest.tMin,
                    detail=f"Ground frost possible in low-lying fields {_day_label(first.date, today)} (low {first.tMin:.0f} °C).")
    return Risk(level="none", extremeC=coldest.tMin, detail=f"No frost expected this week (lowest {coldest.tMin:.0f} °C).")


def heat_risk(days: list[AgriDay], today: str) -> Risk:
    _, ahead = _split(days, today)
    week = [d for d in ahead[:7] if d.tMax is not None]
    if not week:
        return Risk(level="none", detail="No temperature forecast.")
    hottest = max(week, key=lambda d: d.tMax)  # type: ignore[arg-type, return-value]
    high = [d for d in week if d.tMax >= HEAT_HIGH_C]  # type: ignore[operator]
    moderate = [d for d in week if d.tMax >= HEAT_MODERATE_C]  # type: ignore[operator]
    if high:
        first = high[0]
        return Risk(level="high", days=[d.date for d in high], extremeC=hottest.tMax,
                    detail=f"Crop heat stress {_day_label(first.date, today)} (high {first.tMax:.0f} °C). Irrigate early and shade livestock.")
    if moderate:
        first = moderate[0]
        return Risk(level="moderate", days=[d.date for d in moderate], extremeC=hottest.tMax,
                    detail=f"Hot spell from {_day_label(first.date, today)} (high {first.tMax:.0f} °C); watch flowering crops and water stock.")
    return Risk(level="none", extremeC=hottest.tMax, detail=f"No heat stress this week (highest {hottest.tMax:.0f} °C).")


def wind_summary(hours: list[Hour], start: int) -> WindSummary:
    h = _at(hours, start)
    if h is None:
        return WindSummary(detail="No wind data.")
    ok = spray_hour_ok(hours, start)
    if h.wind is None:
        detail = "No wind data."
    elif h.wind < SPRAY_WIND_MIN_KMH:
        detail = "Calm: risk of temperature inversion and drift."
    elif h.wind > SPRAY_WIND_MAX_KMH:
        detail = "Too windy to spray."
    else:
        detail = "Wind in the spraying range." if ok else "Wind is fine, but other conditions are not."
    return WindSummary(speedKmh=h.wind, gustKmh=h.gust, sprayable=ok, detail=detail)




def headline_for(windows: FarmWindows, risks: Risks) -> tuple[str, WindowStatus]:
    """One deterministic sentence for the day and an overall go/wait/avoid."""
    if risks.frost.level == "high":
        return "Frost risk this week: protect seedlings.", "avoid"
    if risks.heat.level == "high":
        return "Crop heat stress this week: irrigate early.", "wait"
    go = [k for k in ("spray", "plant", "harvest") if getattr(windows, k).status == "go"]
    if windows.irrigate.status == "go":
        go.append("irrigate")
    if go:
        jobs = ", ".join(go[:-1])
        jobs = f"{jobs} and {go[-1]}" if jobs else go[-1]
        return f"Good day to {jobs}.", "go"
    if any(getattr(windows, k).status == "wait" for k in ("spray", "plant", "harvest")):
        return "Mixed day: check the windows before field work.", "wait"
    return "Poor day for field work.", "avoid"


# ---------------------------------------------------------------------------
# Season + calendar (mapped from the location profile)
# ---------------------------------------------------------------------------


def normalise_crops(ids: list[str]) -> list[str]:
    """Calendar crops from the user's activities, in order; maize by default."""
    crops = [c for c in dict.fromkeys(ids) if c in CALENDAR_CROPS]
    return crops or [DEFAULT_CROP]


def _months(value: Any) -> list[int]:
    if not isinstance(value, list):
        return []
    return [m for m in value if isinstance(m, int) and not isinstance(m, bool) and 1 <= m <= 12]


def calendar_from_profile(profile: Optional[dict], crops: list[str]) -> list[CropCalendar]:
    """The user's crops from the profile, in the user's order (others dropped)."""
    entries = (profile or {}).get("crops") or []
    by_id = {e.get("id"): e for e in entries if isinstance(e, dict) and e.get("id")}
    out: list[CropCalendar] = []
    for crop in crops:
        e = by_id.get(crop)
        if not e:
            continue
        cal = e.get("calendar") if isinstance(e.get("calendar"), dict) else {}
        out.append(CropCalendar(
            id=crop,
            label=str(e.get("label") or crop),
            phase=str(e["phase"]) if e.get("phase") else None,
            months={st: _months(cal.get(st)) for st in _STAGES if _months(cal.get(st))},
        ))
    return out


def season_for(profile: Optional[dict], lat: float) -> SeasonModel:
    s = (profile or {}).get("season")
    if isinstance(s, dict) and s.get("name"):
        return SeasonModel(
            name=str(s["name"]),
            localName=str(s.get("localName") or s["name"]),
            description=str(s.get("description") or ""),
        )
    from ._ai import _hemisphere_fallback  # local import: keeps module import light

    fb = _hemisphere_fallback(lat)
    return SeasonModel(name=fb["name"], localName=fb["localName"], description=fb["description"])


def profile_context(profile: Optional[dict]) -> Optional[ProfileContext]:
    if not profile:
        return None
    normals = profile.get("normals") if isinstance(profile.get("normals"), dict) else {}
    enso = profile.get("enso") if isinstance(profile.get("enso"), dict) else {}
    ctx = ProfileContext(
        koppen=str(profile["koppen"]) if profile.get("koppen") else None,
        normalHigh=_num(normals.get("high")),
        normalLow=_num(normals.get("low")),
        ensoPhase=str(enso["phase"]) if enso.get("phase") else None,
    )
    return ctx if any(v is not None for v in ctx.model_dump().values()) else None


# ---------------------------------------------------------------------------
# Analysis (pure)
# ---------------------------------------------------------------------------


def _local_now(raw: dict, now: datetime) -> datetime:
    offset = raw.get("utc_offset_seconds")
    off = int(offset) if isinstance(offset, (int, float)) and not isinstance(offset, bool) else 0
    return now.astimezone(timezone.utc).replace(tzinfo=None) + timedelta(seconds=off)


def _start_index(hours: list[Hour], local_now: datetime) -> int:
    key = local_now.strftime("%Y-%m-%dT%H")
    for i, h in enumerate(hours):
        if h.time[:13] >= key:
            return i
    return 0


def analyse(
    raw: dict,
    lat: float,
    lon: float,
    *,
    crops: list[str],
    profile: Optional[dict] = None,
    now: Optional[datetime] = None,
) -> AgricultureResponse:
    """Raw Open-Meteo payload → AgricultureResponse. No I/O."""
    now = now or datetime.now(timezone.utc)
    fetched = now.isoformat()
    hourly = raw.get("hourly") or {}
    hours = hours_from(hourly)
    daily = raw.get("daily") or {}
    if not hours or not daily.get("time"):
        return AgricultureResponse(available=False, reason="insufficient_data", fetchedAt=fetched)

    local_now = _local_now(raw, now)
    today = local_now.strftime("%Y-%m-%d")
    start = _start_index(hours, local_now)

    days = build_daily(raw, today, hours, start)
    windows_list = spray_windows(hours, start)
    soil = soil_summary(hourly, start)
    windows = FarmWindows(
        spray=spray_window(windows_list, today, hours, start),
        plant=plant_window(soil, days, today),
        harvest=harvest_window(days, today),
        irrigate=irrigate_window(soil, days, today),
    )
    risks = Risks(frost=frost_risk(days, today), heat=heat_risk(days, today))
    headline, verdict = headline_for(windows, risks)
    crops = normalise_crops(crops)
    elevation = _num(raw.get("elevation"))
    offset = raw.get("utc_offset_seconds")

    return AgricultureResponse(
        available=True,
        headline=headline,
        verdict=verdict,
        windows=windows,
        rain=rain_summary(days, hours, start, today),
        soil=soil,
        waterBalance=water_balance(days, today),
        gdd=gdd_summary(days, today),
        risks=risks,
        wind=wind_summary(hours, start),
        sprayWindows=windows_list,
        daily=days,
        season=season_for(profile, lat),
        calendar=calendar_from_profile(profile, crops),
        profile=profile_context(profile),
        crops=crops,
        timezone=raw.get("timezone"),
        utcOffsetSeconds=int(offset) if isinstance(offset, (int, float)) and not isinstance(offset, bool) else None,
        elevation=elevation,
        fetchedAt=fetched,
    )


# ---------------------------------------------------------------------------
# Fetch + cache
# ---------------------------------------------------------------------------


class OpenMeteoUpstreamError(Exception):
    """Open-Meteo answered with an HTTP error or an unusable body."""

    def __init__(self, message: str, status: Optional[int] = None):
        super().__init__(message)
        self.status = status

    @property
    def counts_against_breaker(self) -> bool:
        """Only upstream trouble (5xx, 429) opens the shared breaker.

        A 4xx is our own request being refused; letting it open
        ``open_meteo_breaker`` would also cut off the forecast, AQ and haze
        for every user (same rule as ``_history_store``).
        """
        return self.status is not None and (self.status >= 500 or self.status == 429)


def _fetch_sync(lat: float, lon: float) -> dict:
    params = {"latitude": lat, "longitude": lon, **FORECAST_PARAMS}
    resp = get_http_client(HTTP_TIMEOUT_S).get(OPEN_METEO_FORECAST_URL, params=params)
    if resp.status_code >= 400:
        raise OpenMeteoUpstreamError(f"HTTP {resp.status_code}", status=resp.status_code)
    data = resp.json()
    if not isinstance(data, dict):
        raise OpenMeteoUpstreamError("non-object body")
    return data


async def fetch_raw(lat: float, lon: float) -> dict:
    """One Open-Meteo request through ``open_meteo_breaker``. Raises on failure."""
    if not open_meteo_breaker.is_allowed:
        raise CircuitOpenError(open_meteo_breaker.provider)
    try:
        data = await asyncio.wait_for(asyncio.to_thread(_fetch_sync, lat, lon), timeout=HTTP_TIMEOUT_S + 1)
    except OpenMeteoUpstreamError as exc:
        if exc.counts_against_breaker:
            open_meteo_breaker.record_failure()
        raise
    except Exception:
        # Timeouts and transport errors are upstream trouble.
        open_meteo_breaker.record_failure()
        raise
    open_meteo_breaker.record_success()
    return data


def _data_cache():
    return weather_db()["agriculture_cache"]


def _get_cached_raw(key: str) -> Optional[dict]:
    try:
        doc = _data_cache().find_one({"_id": key, "expiresAt": {"$gt": datetime.now(timezone.utc)}})
    except Exception:
        return None
    return doc.get("payload") if doc else None


def _set_cached_raw(key: str, lat: float, lon: float, payload: dict) -> None:
    now = datetime.now(timezone.utc)
    doc = {
        "_id": key,
        "lat": lat,
        "lon": lon,
        "payload": payload,
        "fetchedAt": now,
        "expiresAt": now + timedelta(seconds=DATA_CACHE_TTL_S),
    }
    stamp_platform_fields(doc)
    try:
        _data_cache().update_one({"_id": key}, {"$set": doc}, upsert=True)
    except Exception:
        pass  # a cache write failure never breaks the response


async def get_raw(lat: float, lon: float) -> tuple[Optional[dict], str, Optional[str]]:
    """(payload, cache status, failure reason)."""
    key = weather_cache_key(lat, lon)
    cached = _get_cached_raw(key)
    if cached is not None:
        return cached, "HIT", None
    try:
        raw = await fetch_raw(lat, lon)
    except CircuitOpenError:
        return None, "MISS", "provider_unavailable"
    except Exception as exc:
        logger.warning("agriculture: open-meteo fetch failed (%s)", type(exc).__name__)
        return None, "MISS", "provider_error"
    _set_cached_raw(key, lat, lon, raw)
    return raw, "MISS", None


_COUNTRY_RE = re.compile(r"^[A-Z]{2}$")


def _resolve_country(country: str, location: str) -> str:
    code = (country or "").strip().upper()
    if _COUNTRY_RE.match(code):
        return code
    slug = (location or "").strip().lower()
    if slug and SLUG_RE.match(slug):
        try:
            from ._places_resolver import find_location

            loc = find_location(slug) or {}
            iso = str(loc.get("country") or "").upper()
            if _COUNTRY_RE.match(iso):
                return iso
        except Exception:
            pass
    return ""


def _clean_slug(slug: str) -> str:
    s = (slug or "").strip().lower()
    return s if SLUG_RE.match(s) else ""


def _parse_crops(crops: str) -> list[str]:
    ids = [c.strip().lower() for c in (crops or "").split(",") if c.strip()][:20]
    return filter_known_activities(ids) if ids else []


#: Per-instance memo of profiles (they change far slower than the forecast).
PROFILE_MEMO_TTL_S = 3600
_profile_memo: dict[str, tuple[float, Optional[dict]]] = {}


def _profile_helper_available() -> bool:
    try:
        from ._location_profile import get_location_profile  # type: ignore[import-not-found]  # noqa: F401
    except Exception:
        return False
    return True


def profile_for(lat: float, lon: float, *, country: str, location: str) -> Optional[dict]:
    """The location profile, memoised per cell + place. Blocking; run in a thread.

    The country is only resolved (a placesGeo read) when the profile helper
    exists, since nothing else needs it.
    """
    if not _profile_helper_available():
        return None
    slug = _clean_slug(location)
    code = _resolve_country(country, slug)
    key = f"{weather_cache_key(lat, lon)}|{slug}|{code}"
    now = time.monotonic()
    hit = _profile_memo.get(key)
    if hit and now - hit[0] < PROFILE_MEMO_TTL_S:
        return hit[1]
    profile = load_location_profile(lat, lon, slug=slug, country=code)
    if len(_profile_memo) > 2048:
        _profile_memo.clear()
    _profile_memo[key] = (now, profile)
    return profile


async def build_agriculture(
    lat: float, lon: float, *, country: str, crops: list[str], location: str = ""
) -> tuple[AgricultureResponse, str]:
    raw, cache_status, reason = await get_raw(lat, lon)
    now = datetime.now(timezone.utc)
    if raw is None:
        return AgricultureResponse(available=False, reason=reason, fetchedAt=now.isoformat()), cache_status
    try:
        profile = await asyncio.to_thread(profile_for, lat, lon, country=country, location=location)
        result = analyse(raw, lat, lon, crops=crops, profile=profile, now=now)
    except Exception as exc:  # analysis bugs must degrade, not 500
        logger.warning("agriculture: analysis failed (%s)", type(exc).__name__)
        result = AgricultureResponse(available=False, reason="analysis_error", fetchedAt=now.isoformat())
    return result, cache_status


@router.get("/api/py/agriculture", response_model=AgricultureResponse)
async def get_agriculture(
    lat: float = Query(ge=-90, le=90),
    lon: float = Query(ge=-180, le=180),
    location: str = Query(default="", max_length=80),
    country: str = Query(default="", max_length=3),
    crops: str = Query(default="", max_length=400),
):
    """
    GET /api/py/agriculture?lat=&lon=[&location=][&country=][&crops=]

    Deterministic farm-weather data. Always HTTP 200 for valid coordinates;
    ``available: false`` with a ``reason`` when the data cannot be built.
    """
    result, cache_status = await build_agriculture(
        lat,
        lon,
        country=country,
        crops=_parse_crops(crops),
        location=location,
    )
    return JSONResponse(content=result.model_dump(mode="json"), headers={"X-Cache": cache_status})


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
    enforce_rate_limit(request, "ai-agriculture", 30, 3600, require_ip=False)

    loc = body.location
    mode = body.mode
    activities = farming_activities(body.activities)
    now = datetime.now(timezone.utc).isoformat()

    if not agri_ai_entitled(request):
        # Not entitled: deterministic text only. Never read or write the AI
        # cache here, so model text is never served to an unentitled caller.
        data, _ = await build_agriculture(loc.lat, loc.lon, country=loc.country, crops=activities, location=loc.slug)
        return AgriAIResponse(text=fallback_text(data, mode), source="fallback", cached=False, mode=mode, generatedAt=now)

    key = ai_cache_key(loc, mode, activities)
    cached = _get_cached_ai(key)
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
    data, _ = await build_agriculture(loc.lat, loc.lon, country=country, crops=activities, location=loc.slug)

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
