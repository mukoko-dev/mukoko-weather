"""
Place knowledge: what we know about a place that changes slowly, stored per
place in ``places.placeKnowledge`` and fed to every AI prompt
(mukoko-dev/mukoko-weather#277).

Owner decision (2026-10-11): this is place data, not weather data. One
document per place; its ``_id`` is the place's own id (``placesGeo`` or
``places``, named by ``placeCollection``). The canonical schema and its
``$jsonSchema`` validator live in nyuchi/data-infra (class ``PlaceKnowledge``);
the collection is created by the api-gateway script
``scripts/places_knowledge_validators.py``. Until it exists, this module
computes the profile on the fly and writes nothing.

What is stored (each group with a provenance entry):

* static facts: country, admin-1, elevation, hemisphere, IANA time zone
* ``climate``: twelve monthly normals (ERA5 1991–2020) and a Köppen–Geiger
  class derived from them (Beck et al. 2018 definitions)
* ``seasons``: the local season calendar with local names (``weather.seasons``
  seed; AI-generated rows and normals-derived defaults are marked unverified)
* ``agriculture``: crop planting/vegetative/harvest windows (GEOGLAM, CC BY
  4.0) or a derived growing window that names no crops, plus grazing notes
* ``soil``: SoilGrids 2.0 WRB class and texture (CC BY 4.0), best-effort

What is never stored, only computed at read time: the current and next
season, each crop's current phase, the moon phase, ENSO (a global value with
its own cache), day length and the sunrise/sunset trend.

Shared helper for every consumer (AI summary, follow-up, chat, history
analysis, the agriculture endpoints):

    get_location_profile(slug=..., lat=..., lon=..., allow_build=False)
    profile_prompt_block(profile)

``allow_build=False`` never waits on an upstream: it returns the stored
document (or a cache-only partial) and schedules a background build.
"""

from __future__ import annotations

import asyncio
import datetime as _dt
import logging
import math
import re
import threading
import time
from typing import Any, Optional
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from . import _ag_calendar as ag
from ._circuit_breaker import soilgrids_breaker
from ._db import SLUG_RE, enforce_rate_limit, get_db, places_db
from ._geohash import encode_geohash
from ._insights import moon_phase
from ._normals import NORMALS_PERIOD, NORMALS_SOURCE, get_monthly_normals

logger = logging.getLogger(__name__)

router = APIRouter()

COLLECTION = "placeKnowledge"
SCHEMA_VERSION = "v3.2"

#: Geohash length of ``regionCell`` (~4.9 km): nearby spots share region facts.
REGION_CELL_PRECISION = 5

#: A coordinate within this distance of a known place uses that place.
NEAREST_PLACE_KM = 3.0

#: Rebuild cadence per fact group (days).
REFRESH_DAYS = {"normals": 365, "soil": 365, "seasons": 30, "agriculture": 180}
#: When a group could not be built (upstream down), retry sooner.
RETRY_DAYS = 1
#: AI-generated seasons can be replaced by verified seed data at any time.
AI_SEASONS_REFRESH_DAYS = 7

#: How long the "collection exists" answer is trusted.
COLLECTION_CHECK_TTL_S = 300

SOILGRIDS_URL = "https://rest.isric.org/soilgrids/v2.0"
SOILGRIDS_TIMEOUT_S = 10.0

_MOON_NAMES = (
    "new moon", "waxing crescent", "first quarter", "waxing gibbous",
    "full moon", "waning gibbous", "last quarter", "waning crescent",
)

KOPPEN_LABELS: dict[str, str] = {
    "Af": "tropical rainforest", "Am": "tropical monsoon", "Aw": "tropical savanna",
    "BWh": "hot desert", "BWk": "cold desert", "BSh": "hot semi-arid", "BSk": "cold semi-arid",
    "Csa": "Mediterranean, hot summer", "Csb": "Mediterranean, warm summer",
    "Csc": "Mediterranean, cold summer",
    "Cwa": "humid subtropical, dry winter", "Cwb": "subtropical highland, dry winter",
    "Cwc": "subtropical highland, cold summer, dry winter",
    "Cfa": "humid subtropical", "Cfb": "temperate oceanic", "Cfc": "subpolar oceanic",
    "Dsa": "continental, hot dry summer", "Dsb": "continental, warm dry summer",
    "Dsc": "subarctic, dry summer", "Dsd": "subarctic, very cold winter, dry summer",
    "Dwa": "continental, hot summer, dry winter", "Dwb": "continental, warm summer, dry winter",
    "Dwc": "subarctic, dry winter", "Dwd": "subarctic, very cold winter, dry winter",
    "Dfa": "continental, hot summer", "Dfb": "continental, warm summer",
    "Dfc": "subarctic", "Dfd": "subarctic, very cold winter",
    "ET": "tundra", "EF": "ice cap",
}

_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


# ---------------------------------------------------------------------------
# Response models (schema.org: Place + additionalProperty)
# ---------------------------------------------------------------------------


class ProvenanceEntry(BaseModel):
    field: str
    source: str
    licence: Optional[str] = None
    attribution: Optional[str] = None
    url: Optional[str] = None
    method: str  # observed | modelled | derived | seed | ai
    retrievedAt: Optional[str] = None


class Koppen(BaseModel):
    code: str
    label: str
    method: str = "derived"


class MonthlyNormal(BaseModel):
    month: int
    meanTempC: Optional[float] = None
    meanHighC: Optional[float] = None
    meanLowC: Optional[float] = None
    precipMm: Optional[float] = None
    rainyDays: Optional[float] = None


class Normals(BaseModel):
    period: str = NORMALS_PERIOD
    cell: Optional[str] = None
    monthly: list[MonthlyNormal] = []


class Climate(BaseModel):
    koppen: Optional[Koppen] = None
    normals: Optional[Normals] = None


class SeasonDef(BaseModel):
    name: str
    localName: Optional[str] = None
    months: list[int]
    description: Optional[str] = None


class Seasons(BaseModel):
    calendar: list[SeasonDef] = []
    verified: bool = False
    source: str  # "seed" | "ai" | "derived"


class Agriculture(BaseModel):
    calendarRef: Optional[dict] = None  # {source, country, region}
    crops: list[ag.CropWindow] = []
    derived: Optional[ag.DerivedGrowingWindow] = None
    grazing: Optional[ag.GrazingNotes] = None


class Soil(BaseModel):
    wrbClass: Optional[str] = None
    wrbProbability: Optional[int] = None
    texture: Optional[str] = None
    clayPct: Optional[float] = None
    sandPct: Optional[float] = None
    siltPct: Optional[float] = None
    depth: Optional[str] = None


class SeasonNow(BaseModel):
    name: str
    localName: Optional[str] = None
    description: Optional[str] = None
    verified: bool
    source: str


class NextSeason(BaseModel):
    name: str
    localName: Optional[str] = None
    startsOn: str  # ISO date, the first day of its first month


class Astronomy(BaseModel):
    dayLengthHours: float
    dayLengthChangeMinutes7d: float
    trend: str  # lengthening | shortening | steady
    sunrise: Optional[str] = None  # local HH:MM
    sunset: Optional[str] = None


class MoonNow(BaseModel):
    phase: int  # 0 new … 4 full … 7 waning crescent
    name: str


class EnsoNow(BaseModel):
    phase: str
    strength: Optional[str] = None
    oni: Optional[float] = None
    season: Optional[str] = None
    source: str = "NOAA CPC ONI"


class CurrentContext(BaseModel):
    """Computed for ``date`` at read time. Never stored."""

    date: str
    month: int
    season: Optional[SeasonNow] = None
    nextSeason: Optional[NextSeason] = None
    normalsThisMonth: Optional[MonthlyNormal] = None
    cropPhases: list[ag.CropPhase] = []
    inDerivedGrowingWindow: Optional[bool] = None
    moon: MoonNow
    enso: Optional[EnsoNow] = None
    astronomy: Optional[Astronomy] = None


class CropView(BaseModel):
    """One crop in the flat consumer view (the agriculture adapter's shape):
    ``id`` is a mukoko activity id, ``calendar`` maps a stage (plant, grow,
    harvest) to the months it covers."""

    id: str
    label: str
    season: Optional[str] = None
    phase: Optional[str] = None
    calendar: dict[str, list[int]] = {}
    source: str = ""


class LocationProfile(BaseModel):
    """A place's knowledge plus its current context (schema.org Place with
    additionalProperty facts). ``stored`` says whether it came from (or was
    written to) ``places.placeKnowledge``."""

    placeId: Optional[str] = None
    placeCollection: Optional[str] = None
    slug: Optional[str] = None
    name: Optional[str] = None
    lat: float
    lon: float
    countryCode: Optional[str] = None
    admin1: Optional[str] = None
    elevationMeters: Optional[float] = None
    hemisphere: str
    timeZone: Optional[str] = None
    regionCell: str
    climate: Climate = Field(default_factory=Climate)
    seasons: Optional[Seasons] = None
    agriculture: Optional[Agriculture] = None
    soil: Optional[Soil] = None
    provenance: list[ProvenanceEntry] = []
    refreshAfter: dict[str, str] = {}
    stored: bool = False
    builtAt: Optional[str] = None
    complete: bool = False
    current: Optional[CurrentContext] = None
    # Flat consumer view of ``current`` and the stored groups, filled by
    # :func:`apply_consumer_view`. This is the shape ``_agriculture.py``'s
    # ``load_location_profile`` reads: season {name, localName, description},
    # crops [{id, label, phase, calendar}], normals {high, low}, koppen
    # (code), enso {phase, oni}.
    season: Optional[SeasonNow] = None
    crops: list[CropView] = []
    normals: Optional[dict] = None
    koppen: Optional[str] = None
    enso: Optional[dict] = None


# ---------------------------------------------------------------------------
# Climate: Köppen–Geiger from monthly normals
# ---------------------------------------------------------------------------


#: Within this many degrees of the equator "summer" and "winter" half-years
#: are not meaningful, so the dry-summer test is skipped.
EQUATORIAL_BAND_DEG = 10.0


def derive_koppen(monthly: Optional[list[dict]], lat: float) -> Optional[str]:
    """Köppen–Geiger class from twelve monthly normals, with the definitions
    of Beck et al. (2018, Table 1; after Peel et al. 2007): 0 °C between C
    and D, and summer = Apr–Sep in the north, Oct–Mar in the south. When a
    climate meets both the dry-summer and dry-winter tests, the drier half
    wins. One deliberate exception: within ``EQUATORIAL_BAND_DEG`` of the
    equator the dry-summer test is not applied, because the north/south
    half-year split is arbitrary there (Nairobi, bimodal rains, would read
    as Mediterranean). ``None`` unless every month has a mean temperature and
    rainfall."""
    if not monthly or len(monthly) != 12:
        return None
    rows = sorted(monthly, key=lambda r: r["month"])
    t = [r.get("meanTempC") for r in rows]
    p = [r.get("precipMm") for r in rows]
    if any(v is None for v in t + p):
        return None
    t = [float(v) for v in t]
    p = [float(v) for v in p]
    summer = set(range(3, 9)) if lat >= 0 else {9, 10, 11, 0, 1, 2}  # 0-based
    winter = set(range(12)) - summer
    mat, map_ = sum(t) / 12, sum(p)
    t_cold, t_hot = min(t), max(t)
    t_mon10 = sum(1 for v in t if v > 10)
    p_dry = min(p)
    ps = sum(p[i] for i in summer)
    pw = sum(p[i] for i in winter)
    p_sdry, p_swet = min(p[i] for i in summer), max(p[i] for i in summer)
    p_wdry, p_wwet = min(p[i] for i in winter), max(p[i] for i in winter)

    if pw >= 0.7 * map_:
        p_th = 2 * mat
    elif ps >= 0.7 * map_:
        p_th = 2 * mat + 28
    else:
        p_th = 2 * mat + 14

    if t_hot < 10:
        return "EF" if t_hot < 0 else "ET"
    if map_ < 10 * p_th:
        return ("BW" if map_ < 5 * p_th else "BS") + ("h" if mat >= 18 else "k")
    if t_cold >= 18:
        if p_dry >= 60:
            return "Af"
        if p_dry >= 100 - map_ / 25:
            return "Am"
        return "Aw"

    dry_summer = p_sdry < 40 and p_sdry < p_wwet / 3
    # Near the equator the northern/southern half-year split is arbitrary: a
    # place like Nairobi (bimodal rains, Jan–Feb under 40 mm in ERA5) would
    # otherwise read as dry-summer. There, the dry-summer test is not applied.
    if abs(lat) < EQUATORIAL_BAND_DEG:
        dry_summer = False
    dry_winter = p_wdry < p_swet / 10
    if dry_summer and dry_winter:
        second = "s" if ps < pw else "w"
    elif dry_summer:
        second = "s"
    elif dry_winter:
        second = "w"
    else:
        second = "f"
    group = "C" if t_cold > 0 else "D"
    if t_hot >= 22:
        third = "a"
    elif t_mon10 >= 4:
        third = "b"
    elif group == "D" and t_cold < -38:
        third = "d"
    else:
        third = "c"
    return group + second + third


# ---------------------------------------------------------------------------
# Seasons
# ---------------------------------------------------------------------------


def _country_seasons(country: Optional[str]) -> Optional[Seasons]:
    """The country's season calendar from ``weather.seasons`` (seed or AI)."""
    if not country:
        return None
    try:
        docs = list(get_db()["seasons"].find({"countryCode": country.upper()}, {"_id": 0}))
    except Exception:  # noqa: BLE001
        return None
    if not docs:
        return None
    ai_made = any(d.get("source") == "ai" or d.get("verified") is False for d in docs)
    calendar = [
        SeasonDef(
            name=d.get("name", ""),
            localName=d.get("localName") or d.get("name"),
            months=[int(m) for m in d.get("months", []) if isinstance(m, int) and 1 <= m <= 12],
            description=d.get("description") or None,
        )
        for d in docs
        if d.get("name")
    ]
    calendar = [s for s in calendar if s.months]
    if not calendar:
        return None
    calendar.sort(key=lambda s: _season_start_month(s.months))
    return Seasons(calendar=calendar, verified=not ai_made, source="ai" if ai_made else "seed")


def _season_start_month(months: list[int]) -> int:
    """The first month of a (possibly year-wrapping) season."""
    ms = set(months)
    for m in sorted(ms):
        if ((m - 2) % 12) + 1 not in ms:
            return m
    return min(ms)


def _contiguous_runs(flags: list[bool]) -> list[list[int]]:
    """Runs of equal flags over a circular year, as 1-based month lists."""
    if all(flags) or not any(flags):
        return [list(range(1, 13))]
    start = next(i for i in range(12) if flags[i] != flags[i - 1])
    runs, current = [], [start + 1]
    for k in range(1, 12):
        i = (start + k) % 12
        if flags[i] == flags[(i - 1) % 12]:
            current.append(i + 1)
        else:
            runs.append(current)
            current = [i + 1]
    runs.append(current)
    return runs


def derived_seasons(lat: float, monthly: Optional[list[dict]]) -> Seasons:
    """A default calendar where no local one exists. Inside the tropics, wet
    and dry seasons from the normals (60 mm a month); elsewhere the
    meteorological seasons of the hemisphere. Always ``verified: False``."""
    if abs(lat) < ag.TROPICS_LAT and monthly and len(monthly) == 12:
        rows = sorted(monthly, key=lambda r: r["month"])
        wet = [(r.get("precipMm") or 0) >= ag.RAINY_MONTH_MM for r in rows]
        cal = []
        for run in _contiguous_runs(wet):
            is_wet = wet[run[0] - 1]
            cal.append(SeasonDef(
                name="Wet season" if is_wet else "Dry season",
                months=run,
                description=(
                    f"Normal rainfall {ag.RAINY_MONTH_MM:.0f} mm or more a month"
                    if is_wet else f"Normal rainfall under {ag.RAINY_MONTH_MM:.0f} mm a month"
                ),
            ))
        if len(cal) > 1 or cal[0].name == "Wet season":
            return Seasons(calendar=cal, verified=False, source="derived")
    north = lat >= 0
    quarters = [("Winter", [12, 1, 2]), ("Spring", [3, 4, 5]), ("Summer", [6, 7, 8]), ("Autumn", [9, 10, 11])]
    if not north:
        quarters = [("Summer", [12, 1, 2]), ("Autumn", [3, 4, 5]), ("Winter", [6, 7, 8]), ("Spring", [9, 10, 11])]
    return Seasons(
        calendar=[SeasonDef(name=n, months=m, description="Meteorological season") for n, m in quarters],
        verified=False,
        source="derived",
    )


def season_now(seasons: Optional[Seasons], today: _dt.date) -> tuple[Optional[SeasonNow], Optional[NextSeason]]:
    if not seasons or not seasons.calendar:
        return None, None
    month = today.month
    current = next((s for s in seasons.calendar if month in s.months), None)
    if current is None:
        return None, None
    now = SeasonNow(name=current.name, localName=current.localName, description=current.description,
                    verified=seasons.verified, source=seasons.source)
    nxt = None
    for k in range(1, 13):
        m = ((month - 1 + k) % 12) + 1
        if m in current.months:
            continue
        cand = next((s for s in seasons.calendar if m in s.months), None)
        if cand and cand.name != current.name:
            year = today.year + (1 if m <= month else 0)
            nxt = NextSeason(name=cand.name, localName=cand.localName,
                             startsOn=_dt.date(year, m, 1).isoformat())
            break
    return now, nxt


# ---------------------------------------------------------------------------
# Astronomy (computed; no network)
# ---------------------------------------------------------------------------


def _declination_rad(day: _dt.date) -> float:
    doy = day.timetuple().tm_yday
    return math.radians(23.44) * math.sin(2 * math.pi * (284 + doy) / 365)


def day_length_hours(lat: float, day: _dt.date) -> float:
    """Sunrise-to-sunset hours with standard refraction (−0.833°)."""
    phi = math.radians(max(-89.9, min(89.9, lat)))
    dec = _declination_rad(day)
    cos_h = (math.sin(math.radians(-0.833)) - math.sin(phi) * math.sin(dec)) / (math.cos(phi) * math.cos(dec))
    if cos_h <= -1:
        return 24.0
    if cos_h >= 1:
        return 0.0
    return round(2 * math.degrees(math.acos(cos_h)) / 15, 2)


def _equation_of_time_min(day: _dt.date) -> float:
    b = 2 * math.pi * (day.timetuple().tm_yday - 81) / 364
    return 9.87 * math.sin(2 * b) - 7.53 * math.cos(b) - 1.5 * math.sin(b)


def astronomy(lat: float, lon: float, day: _dt.date, utc_offset_s: Optional[int]) -> Astronomy:
    length = day_length_hours(lat, day)
    before = day_length_hours(lat, day - _dt.timedelta(days=7))
    change = round((length - before) * 60, 1)
    trend = "steady" if abs(change) < 1 else ("lengthening" if change > 0 else "shortening")
    sunrise = sunset = None
    if utc_offset_s is not None and 0 < length < 24:
        noon_utc_min = 720 - 4 * lon - _equation_of_time_min(day)
        half = length * 30
        offset_min = utc_offset_s / 60
        sunrise = _hhmm(noon_utc_min - half + offset_min)
        sunset = _hhmm(noon_utc_min + half + offset_min)
    return Astronomy(dayLengthHours=length, dayLengthChangeMinutes7d=change, trend=trend,
                     sunrise=sunrise, sunset=sunset)


def _hhmm(minutes: float) -> str:
    m = int(round(minutes)) % 1440
    return f"{m // 60:02d}:{m % 60:02d}"


def _utc_offset_seconds(tz: Optional[str], fallback: Optional[int], lon: float, when: _dt.datetime) -> int:
    if tz:
        try:
            off = when.astimezone(ZoneInfo(tz)).utcoffset()
            if off is not None:
                return int(off.total_seconds())
        except Exception:  # noqa: BLE001 — unknown zone or no tzdata
            pass
    if fallback is not None:
        return int(fallback)
    return int(round(lon / 15)) * 3600


# ---------------------------------------------------------------------------
# Soil (SoilGrids 2.0)
# ---------------------------------------------------------------------------


def texture_class(sand: float, silt: float, clay: float) -> str:
    """USDA soil-texture triangle (NRCS) from percentages."""
    s, si, c = sand, silt, clay
    if si + 1.5 * c < 15:
        return "sand"
    if si + 1.5 * c >= 15 and si + 2 * c < 30:
        return "loamy sand"
    if (7 <= c < 20 and s > 52 and si + 2 * c >= 30) or (c < 7 and si < 50 and si + 2 * c >= 30):
        return "sandy loam"
    if 7 <= c < 27 and 28 <= si < 50 and s <= 52:
        return "loam"
    if (si >= 50 and 12 <= c < 27) or (50 <= si < 80 and c < 12):
        return "silt loam"
    if si >= 80 and c < 12:
        return "silt"
    if 20 <= c < 35 and si < 28 and s > 45:
        return "sandy clay loam"
    if 27 <= c < 40 and 20 < s <= 45:
        return "clay loam"
    if 27 <= c < 40 and s <= 20:
        return "silty clay loam"
    if c >= 35 and s > 45:
        return "sandy clay"
    if c >= 40 and si >= 40:
        return "silty clay"
    return "clay"


_soil_http: Optional[httpx.Client] = None


def _get_soil_http() -> httpx.Client:
    global _soil_http
    if _soil_http is None:
        _soil_http = httpx.Client(timeout=SOILGRIDS_TIMEOUT_S)
    return _soil_http


#: Soil does not change on a human timescale. Until the collection exists
#: nothing is stored, so each build would call SoilGrids again; a bounded
#: in-process memo (per ~1 km cell, 6 h) keeps that to one call per cell.
SOIL_MEMO_TTL_S = 6 * 3600
SOIL_MEMO_MAX = 512
_soil_memo: dict[tuple[float, float], tuple[float, Optional[Soil]]] = {}


def fetch_soil_checked(lat: float, lon: float) -> tuple[Optional[Soil], bool]:
    """(soil, answered), memoised per cell. ``answered`` is True when SoilGrids
    gave a definitive answer, including "no data here" (an ocean or an
    unmapped point), so the caller can wait a year before asking again. A
    failure (timeout, 5xx, 429, open breaker) is ``(None, False)``, is not
    memoised and is retried tomorrow."""
    key = (round(lat, 2), round(lon, 2))
    hit = _soil_memo.get(key)
    if hit and time.monotonic() - hit[0] < SOIL_MEMO_TTL_S:
        return hit[1], True
    soil, answered = _fetch_soil_uncached(lat, lon)
    if answered:
        if len(_soil_memo) >= SOIL_MEMO_MAX:
            _soil_memo.clear()
        _soil_memo[key] = (time.monotonic(), soil)
    return soil, answered


def fetch_soil(lat: float, lon: float) -> Optional[Soil]:
    """Just the soil (``None`` for no data or a failure)."""
    return fetch_soil_checked(lat, lon)[0]


def _fetch_soil_uncached(lat: float, lon: float) -> tuple[Optional[Soil], bool]:
    if not soilgrids_breaker.is_allowed:
        return None, False
    try:
        http = _get_soil_http()
        cls = http.get(f"{SOILGRIDS_URL}/classification/query",
                       params={"lon": f"{lon:.4f}", "lat": f"{lat:.4f}", "number_classes": 1})
        cls.raise_for_status()
        c = cls.json()
        props = http.get(f"{SOILGRIDS_URL}/properties/query", params=[
            ("lon", f"{lon:.4f}"), ("lat", f"{lat:.4f}"),
            ("property", "clay"), ("property", "sand"), ("property", "silt"),
            ("depth", "0-5cm"), ("depth", "5-15cm"), ("depth", "15-30cm"), ("value", "mean"),
        ])
        props.raise_for_status()
        p = props.json()
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        if 400 <= status < 500 and status != 429:
            # Our request, or no data for this point: not the service's fault,
            # so it must not open the breaker (same rule as the archive
            # backfill). The answer is definitive.
            soilgrids_breaker.record_success()
            return None, True
        soilgrids_breaker.record_failure()
        logger.info("SoilGrids unavailable: HTTP %s", status)
        return None, False
    except Exception as exc:  # noqa: BLE001
        soilgrids_breaker.record_failure()
        logger.info("SoilGrids unavailable: %s", type(exc).__name__)
        return None, False
    soilgrids_breaker.record_success()
    try:
        return _parse_soil(c, p), True
    except (TypeError, ValueError, KeyError, AttributeError, IndexError, OverflowError) as exc:
        # A payload we cannot parse is an anomaly, not an answer: never a
        # failed profile (a null class probability for London used to raise
        # here), and retried tomorrow rather than waiting a year.
        logger.info("SoilGrids payload not understood: %s", type(exc).__name__)
        return None, False


def _number(value) -> Optional[float]:
    """A real number, or ``None`` (never a bool, a string or ``None``)."""
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _parse_soil(c: dict, p: dict) -> Optional[Soil]:
    soil = Soil(wrbClass=c.get("wrb_class_name") or None)
    probs = c.get("wrb_class_probability") or []
    if probs and isinstance(probs[0], list) and len(probs[0]) > 1:
        probability = _number(probs[0][1])
        if probability is not None and math.isfinite(probability):
            soil.wrbProbability = int(probability)
    fractions: dict[str, float] = {}
    weights = {"0-5cm": 5, "5-15cm": 10, "15-30cm": 15}
    for layer in (p.get("properties") or {}).get("layers") or []:
        # A non-numeric factor or value is skipped, so one bad layer never
        # discards a valid class or the other layers.
        factor = _number((layer.get("unit_measure") or {}).get("d_factor")) or 10.0
        total = wsum = 0.0
        for depth in layer.get("depths") or []:
            value = _number((depth.get("values") or {}).get("mean"))
            w = weights.get(depth.get("label"))
            if value is not None and w:
                total += value / factor * w
                wsum += w
        if wsum:
            fractions[layer.get("name")] = round(total / wsum, 1)
    if {"clay", "sand", "silt"} <= fractions.keys():
        soil.clayPct, soil.sandPct, soil.siltPct = fractions["clay"], fractions["sand"], fractions["silt"]
        soil.texture = texture_class(soil.sandPct, soil.siltPct, soil.clayPct)
        soil.depth = "0-30cm"
    if not soil.wrbClass and not soil.texture:
        return None
    return soil


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------

#: ``checked`` is ``None`` until the first check. It must not default to a
#: number: ``time.monotonic()`` counts from an arbitrary origin (host uptime
#: on Linux), so a fresh serverless instance can have a clock under the TTL
#: and a numeric "never" would read as a recent check.
_collection_state: dict = {"ready": False, "checked": None}


def _collection():
    return places_db()[COLLECTION]


def collection_ready() -> bool:
    """Whether ``places.placeKnowledge`` exists (cached for 5 minutes).

    The collection and its validator are created by the owner through the
    api-gateway script. Until then this module never writes."""
    now = time.monotonic()
    checked = _collection_state["checked"]
    if checked is not None and now - checked < COLLECTION_CHECK_TTL_S:
        return _collection_state["ready"]
    try:
        ready = COLLECTION in places_db().list_collection_names(filter={"name": COLLECTION})
    except Exception:  # noqa: BLE001
        ready = False
    _collection_state.update(ready=ready, checked=now)
    return ready


def read_knowledge(place_id: str) -> Optional[dict]:
    if not place_id or not collection_ready():
        return None
    try:
        return _collection().find_one({"_id": place_id})
    except Exception:  # noqa: BLE001
        return None


def _neighbour_knowledge(region_cell: str) -> Optional[dict]:
    if not collection_ready():
        return None
    try:
        return _collection().find_one({"regionCell": region_cell, "climate": {"$ne": None}})
    except Exception:  # noqa: BLE001
        return None


def store_knowledge(doc: dict) -> bool:
    """Upsert one knowledge document by ``_id``. Only for a real place with a
    country (the validator requires ``addressCountry``), and only once the
    collection exists. Never raises."""
    if not doc.get("_id") or not doc.get("addressCountry") or not collection_ready():
        return False
    now = _dt.datetime.now(_dt.timezone.utc)
    body = {k: v for k, v in doc.items() if k not in ("_id", "createdAt")}
    body["updatedAt"] = now
    try:
        _collection().update_one(
            {"_id": doc["_id"]},
            {"$set": body, "$setOnInsert": {"createdAt": now}},
            upsert=True,
        )
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("placeKnowledge write failed: %s", type(exc).__name__)
        return False


def is_stale(doc: dict, now: Optional[_dt.datetime] = None) -> bool:
    now = now or _dt.datetime.now(_dt.timezone.utc)
    refresh = doc.get("refreshAfter") or {}
    if not refresh:
        return True
    for value in refresh.values():
        if isinstance(value, _dt.datetime):
            if value.tzinfo is None:
                value = value.replace(tzinfo=_dt.timezone.utc)
            if value <= now:
                return True
    return False


# ---------------------------------------------------------------------------
# Building
# ---------------------------------------------------------------------------


def _prov(field: str, source: str, method: str, now: _dt.datetime, **extra) -> dict:
    entry = {"field": field, "source": source, "method": method, "retrievedAt": now.isoformat()}
    entry.update({k: v for k, v in extra.items() if v})
    return entry


def build_knowledge(place: dict, *, allow_fetch: bool = True,
                    now: Optional[_dt.datetime] = None) -> dict:
    """The stored-shape knowledge document for ``place``.

    ``place``: ``{id, collection, name, lat, lon, country, admin1, elevation}``
    (``id`` may be ``None`` for a bare coordinate). With ``allow_fetch=False``
    only caches are read (no upstream call)."""
    now = now or _dt.datetime.now(_dt.timezone.utc)
    lat, lon = float(place["lat"]), float(place["lon"])
    country = (place.get("country") or "").upper() or None
    region_cell = encode_geohash(lat, lon, REGION_CELL_PRECISION)
    provenance: list[dict] = []
    refresh: dict[str, _dt.datetime] = {}

    def due(group: str, ok: bool, days: Optional[int] = None) -> None:
        refresh[group] = now + _dt.timedelta(days=(days or REFRESH_DAYS[group]) if ok else RETRY_DAYS)

    # Climate normals (cache first; one archive request per 0.25° cell).
    normals = None
    try:
        normals = get_monthly_normals(lat, lon, allow_fetch=allow_fetch)
    except Exception:  # noqa: BLE001
        normals = None
    monthly = (normals or {}).get("monthly")
    climate: Optional[dict] = None
    if monthly:
        code = derive_koppen(monthly, lat)
        climate = {
            "normals": {"period": normals.get("period", NORMALS_PERIOD), "cell": normals.get("cell"),
                        "monthly": monthly},
            "koppen": {"code": code, "label": KOPPEN_LABELS.get(code, code), "method": "derived"} if code else None,
        }
        provenance.append(_prov(
            "climate.normals", normals.get("source", NORMALS_SOURCE), "modelled", now,
            licence="CC-BY-4.0",
            attribution="Copernicus Climate Change Service ERA5 reanalysis, via Open-Meteo",
            url="https://open-meteo.com/en/docs/historical-weather-api",
        ))
        if code:
            provenance.append(_prov(
                "climate.koppen", "Köppen–Geiger rules applied to the ERA5 normals of the 0.25° cell",
                "derived", now,
                attribution="Classification definitions: Beck et al. (2018), Scientific Data 5, 180214",
                url="https://doi.org/10.1038/sdata.2018.214",
            ))
    due("normals", bool(monthly))

    # Static facts.
    tz = (normals or {}).get("timeZone")
    elevation = place.get("elevation")
    elevation_src = "place record"
    if not elevation and (normals or {}).get("elevation") is not None:
        elevation, elevation_src = normals["elevation"], "Open-Meteo elevation (Copernicus DEM, 90 m) at the cell centre"
    provenance.append(_prov("addressCountry,addressRegion", f"places.{place.get('collection') or 'placesGeo'}",
                            "observed", now))
    if elevation:
        provenance.append(_prov("elevationMeters", elevation_src,
                                "observed" if elevation_src == "place record" else "modelled", now))
    if tz:
        provenance.append(_prov("timeZone", "Open-Meteo time-zone lookup (IANA tz database)", "observed", now))

    # Seasons.
    seasons = _country_seasons(country) or derived_seasons(lat, monthly)
    season_source = {
        "seed": ("mukoko season calendar (weather.seasons, seed-seasons.ts)", "seed"),
        "ai": ("AI-generated season calendar (unverified)", "ai"),
        "derived": ("Derived from hemisphere and ERA5 normals", "derived"),
    }[seasons.source]
    provenance.append(_prov("seasons", season_source[0], season_source[1], now))
    if seasons.source == "ai":
        due("seasons", True, AI_SEASONS_REFRESH_DAYS)
    else:
        # A derived calendar without normals is the bare hemisphere default:
        # retry soon, when the normals may be available.
        due("seasons", seasons.source == "seed" or bool(monthly))

    # Agriculture.
    cal = ag.calendar_for(lat, lon, country, place.get("admin1"), monthly)
    grazing = ag.grazing_notes(lat, monthly)
    agriculture: Optional[dict] = None
    if cal or grazing:
        agriculture = {
            "calendarRef": ({"source": cal.source, "country": cal.country, "region": cal.region}
                            if cal and cal.method == "seed" else None),
            "crops": [w.model_dump() for w in cal.crops] if cal else [],
            "derived": cal.derived.model_dump() if cal and cal.derived else None,
            "grazing": grazing.model_dump() if grazing else None,
        }
        if cal and cal.method == "seed":
            provenance.append(_prov("agriculture.crops", cal.source, "seed", now, licence=cal.licence,
                                    attribution=cal.attribution, url=cal.url))
        if agriculture["derived"] or grazing:
            provenance.append(_prov("agriculture.derived,agriculture.grazing",
                                    "Derived from ERA5 1991–2020 normals", "derived", now))
    due("agriculture", bool(cal))

    # Soil (best-effort; only for a real place, never on a cache-only build).
    try:
        soil, soil_answered = (
            fetch_soil_checked(lat, lon) if allow_fetch and place.get("id") else (None, False)
        )
    except Exception as exc:  # noqa: BLE001 — soil is best effort, never the whole profile
        logger.warning("soil lookup failed: %s", type(exc).__name__, exc_info=True)
        soil, soil_answered = None, False
    if soil:
        provenance.append(_prov("soil", "ISRIC SoilGrids 2.0", "modelled", now, licence="CC-BY-4.0",
                                attribution="Poggio et al. (2021), SOIL 7, 217–240, doi:10.5194/soil-7-217-2021",
                                url="https://soilgrids.org"))
    due("soil", soil_answered)

    return {
        "_id": place.get("id"),
        "_schemaVersion": SCHEMA_VERSION,
        "placeCollection": place.get("collection") or "placesGeo",
        "name": place.get("name"),
        "geo": {"type": "Point", "coordinates": [lon, lat]},
        "regionCell": region_cell,
        "addressCountry": country,
        "addressRegion": place.get("admin1") or None,
        "elevationMeters": float(elevation) if elevation else None,
        "hemisphere": "north" if lat >= 0 else "south",
        "timeZone": tz,
        "climate": climate,
        "seasons": seasons.model_dump(),
        "agriculture": agriculture,
        "soil": soil.model_dump() if soil else None,
        "landCover": None,
        "provenance": provenance,
        "refreshAfter": refresh,
        "_utcOffsetSeconds": (normals or {}).get("utcOffsetSeconds"),
    }


def merge_previous(doc: dict, previous: Optional[dict]) -> dict:
    """Keep what the last build knew when this one could not learn it.

    A rebuild that hits a transient failure (SoilGrids down, the archive
    rate limited) must not erase a group that was built a year ago and is
    only refreshed yearly. For soil, climate and time zone, a missing new
    value keeps the stored one, with its provenance entries; the group's
    ``refreshAfter`` stays the short retry date so the rebuild is tried
    again soon."""
    if not previous:
        return doc
    kept: list[str] = []
    # Decided before the loop below restores ``climate`` itself.
    normals_failed = doc.get("climate") is None and previous.get("climate") is not None
    for group, prefix in (("soil", "soil"), ("climate", "climate")):
        if doc.get(group) is None and previous.get(group) is not None:
            doc[group] = previous[group]
            kept.append(prefix)
    if doc.get("timeZone") is None and previous.get("timeZone"):
        doc["timeZone"] = previous["timeZone"]
        kept.append("timeZone")
    if normals_failed:
        # The normals failed, and the groups derived from them are degraded:
        # keep the stored ones rather than a hemisphere default and no crop
        # window. (A published calendar needs no normals, so only a derived
        # one is replaced.)
        if (doc.get("seasons") or {}).get("source") == "derived" and previous.get("seasons"):
            doc["seasons"] = previous["seasons"]
            kept.append("seasons")
        new_ag, old_ag = doc.get("agriculture") or {}, previous.get("agriculture") or {}
        if old_ag and not new_ag.get("derived") and old_ag.get("derived"):
            doc["agriculture"] = {**new_ag, "derived": old_ag["derived"],
                                  "grazing": new_ag.get("grazing") or old_ag.get("grazing"),
                                  "crops": new_ag.get("crops") or old_ag.get("crops") or [],
                                  "calendarRef": new_ag.get("calendarRef") or old_ag.get("calendarRef")}
            kept.append("agriculture")
        if doc.get("elevationMeters") is None and previous.get("elevationMeters") is not None:
            doc["elevationMeters"] = previous["elevationMeters"]
            kept.append("elevationMeters")
    if kept:
        have = {p.get("field") for p in doc["provenance"]}
        doc["provenance"] = doc["provenance"] + [
            p for p in previous.get("provenance") or []
            if p.get("field", "").startswith(tuple(kept)) and p.get("field") not in have
        ]
    return doc


def _storable(doc: dict) -> dict:
    return {k: v for k, v in doc.items() if not k.startswith("_") or k in ("_id", "_schemaVersion")}


# ---------------------------------------------------------------------------
# Background builds (creation hooks and lazy first loads)
# ---------------------------------------------------------------------------

_in_progress: set[str] = set()
_in_progress_lock = threading.Lock()


def build_and_store(place: dict) -> Optional[dict]:
    """Build with upstream fetches and store. Deduped across instances with
    the ``weather.creation_locks`` pattern; returns the document (with
    ``_stored`` set) or ``None`` when another instance holds the build."""
    from ._places_geo import _acquire_create_lock, _release_create_lock  # noqa: PLC0415 — avoid an import cycle

    place_id = place.get("id")
    lock_id = f"placeknowledge:{place_id}" if place_id else None
    if lock_id and not _acquire_create_lock(lock_id):
        return None
    try:
        doc = merge_previous(build_knowledge(place, allow_fetch=True),
                             read_knowledge(place_id) if place_id else None)
        # A profile built on a client-supplied country hint is computed, not stored.
        doc["_stored"] = bool(place_id) and not place.get("country_hint") and store_knowledge(_storable(doc))
        return doc
    finally:
        if lock_id:
            _release_create_lock(lock_id)


def schedule_knowledge_build(place: dict) -> bool:
    """Fire-and-forget build on a daemon thread. Never blocks or raises.

    On Vercel the thread is best-effort (the instance may freeze after the
    response); a lost build is redone on the place's next load."""
    place_id = place.get("id")
    if not place_id or not collection_ready():
        return False
    with _in_progress_lock:
        if place_id in _in_progress:
            return False
        _in_progress.add(place_id)

    def _run() -> None:
        try:
            build_and_store(place)
        except Exception as exc:  # noqa: BLE001
            logger.warning("placeKnowledge background build failed: %s", type(exc).__name__)
        finally:
            with _in_progress_lock:
                _in_progress.discard(place_id)

    threading.Thread(target=_run, daemon=True).start()
    return True


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------


def _place_from_location(loc: dict, slug: Optional[str] = None) -> dict:
    return {
        "id": loc.get("_id"),
        "collection": "placesGeo",
        "slug": slug or loc.get("slug"),
        "name": loc.get("name"),
        "lat": loc.get("lat"),
        "lon": loc.get("lon"),
        "country": loc.get("country"),
        "admin1": loc.get("province") or None,
        "elevation": loc.get("elevation") or None,
    }


_SLUG_COUNTRY_RE = re.compile(r"-([a-z]{2})$")


def country_from_slug(slug: Optional[str]) -> Optional[str]:
    """The ISO code in a ``{city}-{cc}`` slug (the convention for global and
    community locations), accepted only when it is a country we know: one with
    a placesGeo country document or a published crop calendar."""
    m = _SLUG_COUNTRY_RE.search((slug or "").lower())
    if not m:
        return None
    iso = m.group(1).upper()
    try:
        from ._places_geo import get_country_id  # noqa: PLC0415 — import cycle

        known = bool(get_country_id(iso))
    except Exception:  # noqa: BLE001
        known = False
    return iso if known or iso in ag.GEOGLAM_COUNTRY_ISO.values() else None


def _apply_country_hint(place: dict, country: Optional[str], slug: Optional[str]) -> None:
    """Fill a missing country from the request's ``country`` or the slug's
    ``-cc`` suffix. Such a value is a HINT: it is good enough to compute a
    profile for this response, but it is client-supplied, so a profile built
    on it is never stored (``country_hint``)."""
    if place.get("country"):
        return
    hint = country or country_from_slug(slug)
    if hint:
        place["country"] = hint
        place["country_hint"] = True


def resolve_place(*, slug: Optional[str], lat: Optional[float], lon: Optional[float],
                  country: Optional[str] = None, admin1: Optional[str] = None,
                  name: Optional[str] = None) -> Optional[dict]:
    """The place a request is about: a known placesGeo place by slug, else
    the known place within 3 km of the coordinate, else a bare spot."""
    from ._places_resolver import (  # noqa: PLC0415
        find_location,
        find_nearest_location,
        is_synthesized_spot,
    )

    if slug and SLUG_RE.match(slug):
        try:
            loc = find_location(slug)
        except Exception:  # noqa: BLE001
            loc = None
        if is_synthesized_spot(loc):
            # A spot slug with no record is a coordinate, never a placesGeo
            # place: fall through to the nearest-place / bare-spot path with
            # the slug's own coordinate and name.
            if lat is None or lon is None:
                lat, lon = loc.get("lat"), loc.get("lon")
            name = name or loc.get("name")
        elif loc and loc.get("_id"):
            place = _place_from_location(loc, slug)
            _apply_country_hint(place, country, slug)
            place["admin1"] = place["admin1"] or admin1
            return place
    if lat is None or lon is None:
        return None
    try:
        near = find_nearest_location(lat, lon, max_km=NEAREST_PLACE_KM)
    except Exception:  # noqa: BLE001
        near = None
    if near and near.get("_id"):
        place = _place_from_location(near)
        _apply_country_hint(place, country, slug)
        return place
    spot = {"id": None, "collection": None, "slug": slug, "name": name, "lat": lat, "lon": lon,
            "country": None, "admin1": admin1, "elevation": None}
    _apply_country_hint(spot, country, slug)
    return spot


def _iso(value: Any) -> Optional[str]:
    if isinstance(value, _dt.datetime):
        return value.isoformat()
    return value if isinstance(value, str) else None


_enso_warm = {"at": 0.0, "running": False}
_enso_warm_lock = threading.Lock()
ENSO_WARM_MIN_INTERVAL_S = 300.0


def _warm_enso_in_background() -> None:
    """Fill the global ENSO cache without making the caller wait: a profile
    read that finds it cold (the agriculture endpoints never warm it) starts
    one fetch on a daemon thread, at most once every 5 minutes, so the next
    read carries ENSO."""
    now = time.monotonic()
    with _enso_warm_lock:
        if _enso_warm["running"] or (_enso_warm["at"] and now - _enso_warm["at"] < ENSO_WARM_MIN_INTERVAL_S):
            return
        _enso_warm.update(running=True, at=now)

    def _run() -> None:
        try:
            from ._enso import get_enso  # noqa: PLC0415

            asyncio.run(asyncio.wait_for(get_enso(), timeout=6))
        except Exception:  # noqa: BLE001
            pass
        finally:
            with _enso_warm_lock:
                _enso_warm["running"] = False

    try:
        threading.Thread(target=_run, daemon=True).start()
    except Exception:  # noqa: BLE001 — e.g. a thread limit: allow a later retry
        with _enso_warm_lock:
            _enso_warm["running"] = False


def _enso_now() -> Optional[EnsoNow]:
    try:
        from ._enso import _cached  # noqa: PLC0415

        cached = _cached()
    except Exception:  # noqa: BLE001
        return None
    if cached is None:
        _warm_enso_in_background()
        return None
    if not cached.available or not cached.phase:
        return None
    return EnsoNow(phase=cached.phase, strength=cached.strength, oni=cached.oni,
                   season=f"{cached.season} {cached.year}" if cached.season else None)


def compute_current(profile: LocationProfile, when: _dt.datetime,
                    utc_offset_fallback: Optional[int] = None) -> CurrentContext:
    offset = _utc_offset_seconds(profile.timeZone, utc_offset_fallback, profile.lon, when)
    local = (when + _dt.timedelta(seconds=offset)).date()
    season, nxt = season_now(profile.seasons, local)
    normals_now = None
    if profile.climate.normals and profile.climate.normals.monthly:
        normals_now = next((m for m in profile.climate.normals.monthly if m.month == local.month), None)
    phases = [ag.crop_phase(w, local) for w in (profile.agriculture.crops if profile.agriculture else [])]
    in_window = None
    if profile.agriculture and profile.agriculture.derived:
        in_window = local.month in profile.agriculture.derived.months
    m = moon_phase(when)
    return CurrentContext(
        date=local.isoformat(),
        month=local.month,
        season=season,
        nextSeason=nxt,
        normalsThisMonth=normals_now,
        cropPhases=phases,
        inDerivedGrowingWindow=in_window,
        moon=MoonNow(phase=m, name=_MOON_NAMES[m]),
        enso=_enso_now(),
        astronomy=astronomy(profile.lat, profile.lon, local, offset),
    )


#: The mukoko activity id a published staple-crop calendar answers for.
CROP_ACTIVITY_ID = "crop-farming"

#: Staples in the order a calendar entry is preferred for ``crop-farming``
#: (maize first: the activity is "maize/mielie & crops").
_STAPLE_ORDER = ("maize", "rice", "sorghum", "millet", "winter-wheat", "spring-wheat", "beans", "teff")

_PHASE_WORDS = {
    "planting": "planting", "vegetative": "growing", "harvest": "harvest",
    "endOfSeason": "post-harvest", "outOfSeason": "off-season",
}


def _doy_month(doy: int) -> int:
    return (_dt.date(2001, 1, 1) + _dt.timedelta(days=doy - 1)).month


def stage_months(start: int, end: int) -> list[int]:
    """Months covered from day-of-year ``start`` up to (not including) ``end``,
    wrapping the year end."""
    first = _doy_month(start)
    last = _doy_month(((end - 2) % 365) + 1)
    months = [first]
    while months[-1] != last and len(months) < 12:
        months.append(months[-1] % 12 + 1)
    return months


def crop_views(agriculture: Optional[Agriculture], phases: list[ag.CropPhase]) -> list[CropView]:
    """The calendar crops in the adapter's shape. Only the ``crop-farming``
    activity is answered, with the best published staple (maize first, its
    largest season); no other activity gets an invented calendar."""
    crops = list(agriculture.crops) if agriculture else []
    if not crops:
        return []

    def rank(w: ag.CropWindow) -> int:
        return _STAPLE_ORDER.index(w.crop) if w.crop in _STAPLE_ORDER else len(_STAPLE_ORDER)

    window = min(crops, key=rank)  # min is stable: the first (largest) season wins a tie
    st = window.stages
    cal = {"plant": stage_months(st.planting, st.vegetative),
           "grow": stage_months(st.vegetative, st.harvest),
           "harvest": stage_months(st.harvest, st.endOfSeason)}
    phase = next((p for p in phases if p.crop == window.crop and p.season == window.season), None)
    label = window.cropLabel + (f" ({window.season})" if window.season else "")
    return [CropView(
        id=CROP_ACTIVITY_ID, label=label, season=window.season,
        phase=_PHASE_WORDS.get(phase.phase) if phase else None,
        calendar=cal, source=ag.GEOGLAM_SOURCE,
    )]


def apply_consumer_view(profile: LocationProfile) -> LocationProfile:
    """Fill the flat consumer fields from the stored groups and ``current``."""
    cur = profile.current
    if cur is None:
        return profile
    profile.season = cur.season
    profile.crops = crop_views(profile.agriculture, cur.cropPhases)
    n = cur.normalsThisMonth
    if n and (n.meanHighC is not None or n.meanLowC is not None):
        profile.normals = {"high": n.meanHighC, "low": n.meanLowC}
    profile.koppen = profile.climate.koppen.code if profile.climate.koppen else None
    if cur.enso:
        profile.enso = {"phase": cur.enso.phase, "oni": cur.enso.oni}
    return profile


def _to_profile(doc: dict, place: dict, *, stored: bool) -> LocationProfile:
    coords = (doc.get("geo") or {}).get("coordinates") or [place["lon"], place["lat"]]
    refresh = {k: _iso(v) for k, v in (doc.get("refreshAfter") or {}).items() if _iso(v)}
    return LocationProfile(
        placeId=doc.get("_id"),
        placeCollection=doc.get("placeCollection") if doc.get("_id") else None,
        slug=place.get("slug"),
        name=doc.get("name") or place.get("name"),
        lat=float(coords[1]),
        lon=float(coords[0]),
        countryCode=doc.get("addressCountry"),
        admin1=doc.get("addressRegion"),
        elevationMeters=doc.get("elevationMeters"),
        hemisphere=doc.get("hemisphere") or ("north" if place["lat"] >= 0 else "south"),
        timeZone=doc.get("timeZone"),
        regionCell=doc.get("regionCell") or encode_geohash(place["lat"], place["lon"], REGION_CELL_PRECISION),
        climate=Climate(**(doc.get("climate") or {})),
        seasons=Seasons(**doc["seasons"]) if doc.get("seasons") else None,
        agriculture=Agriculture(**doc["agriculture"]) if doc.get("agriculture") else None,
        soil=Soil(**doc["soil"]) if doc.get("soil") else None,
        provenance=[ProvenanceEntry(**p) for p in doc.get("provenance") or []],
        refreshAfter=refresh,
        stored=stored,
        builtAt=_iso(doc.get("updatedAt")) or _iso(_dt.datetime.now(_dt.timezone.utc)),
        complete=bool(doc.get("climate")),
    )


def get_location_profile(
    *,
    slug: Optional[str] = None,
    lat: Optional[float] = None,
    lon: Optional[float] = None,
    country: Optional[str] = None,
    admin1: Optional[str] = None,
    name: Optional[str] = None,
    allow_build: bool = False,
    schedule_build: bool = True,
    when: Optional[_dt.datetime] = None,
) -> Optional[LocationProfile]:
    """The place's knowledge plus its current context, or ``None`` when the
    request names no place and no coordinate.

    * Stored and fresh → served as is.
    * Missing or stale, ``allow_build=False`` (the default: AI prompts, the
      agriculture endpoints) → a cache-only build (no upstream call), with a
      full build scheduled in the background. A stale stored document is
      served while it rebuilds. This never waits on an upstream.
    * Missing or stale, ``allow_build=True`` (the profile endpoint, the
      backfill script) → built now (upstream calls, seconds on a cold cell)
      and stored when the collection exists.
    * A bare coordinate is never stored; it reuses a neighbour's climate and
      soil (same 5-character geohash cell) when one is stored.

    ``schedule_build=False`` also suppresses that background build (the
    profile endpoint uses it for its cheap first look, so a caller cannot
    start builds before the rate limit applies).

    Never raises."""
    when = when or _dt.datetime.now(_dt.timezone.utc)
    try:
        place = resolve_place(slug=slug, lat=lat, lon=lon, country=country, admin1=admin1, name=name)
        if place is None or place.get("lat") is None or place.get("lon") is None:
            return None
        stored_doc = read_knowledge(place["id"]) if place.get("id") else None
        utc_fallback = None
        if stored_doc and not is_stale(stored_doc, when):
            profile = _to_profile(stored_doc, place, stored=True)
        elif stored_doc and not allow_build:
            if schedule_build:
                schedule_knowledge_build(place)
            profile = _to_profile(stored_doc, place, stored=True)
        else:
            doc = build_and_store(place) if allow_build else None
            if doc is None and stored_doc and allow_build:
                # Another instance is rebuilding this place right now: serve
                # what is stored rather than a degraded cache-only build.
                profile = _to_profile(stored_doc, place, stored=True)
                profile.current = compute_current(profile, when, None)
                return apply_consumer_view(profile)
            if doc is None:
                doc = build_knowledge(place, allow_fetch=False, now=when)
                if not allow_build and schedule_build:
                    schedule_knowledge_build(place)
            if not place.get("id") and not doc.get("climate"):
                neighbour = _neighbour_knowledge(doc["regionCell"])
                if neighbour:
                    doc["climate"] = neighbour.get("climate")
                    doc["soil"] = doc.get("soil") or neighbour.get("soil")
                    doc["timeZone"] = doc.get("timeZone") or neighbour.get("timeZone")
                    doc["provenance"] = doc["provenance"] + [
                        {**p, "field": f"{p['field']} (nearby place)"}
                        for p in neighbour.get("provenance") or []
                        if p.get("field", "").startswith(("climate", "soil"))
                    ]
            utc_fallback = doc.get("_utcOffsetSeconds")
            profile = _to_profile(doc, place, stored=bool(doc.get("_stored")))
        profile.current = compute_current(profile, when, utc_fallback)
        return apply_consumer_view(profile)
    except Exception as exc:  # noqa: BLE001 — a profile is context, never a failure
        # The traceback goes to the logs (secret redaction applies), so a
        # swallowed failure can still be found.
        logger.warning("location profile failed: %s", type(exc).__name__, exc_info=True)
        return None


# ---------------------------------------------------------------------------
# AI prompt block
# ---------------------------------------------------------------------------

#: The block must stay under ~250 tokens; ~4 characters a token.
PROMPT_BLOCK_MAX_CHARS = 1000


def _month_runs(months: list[int]) -> list[list[int]]:
    """Contiguous runs of months over a circular year, e.g. [3,4,5,10,11,12]
    → [[3,4,5],[10,11,12]] and [11,12,1,2,3] → [[11,12,1,2,3]]."""
    present = set(months)
    if not present:
        return []
    if len(present) == 12:
        return [list(range(1, 13))]
    starts = [m for m in sorted(present) if ((m - 2) % 12) + 1 not in present]
    runs = []
    for start in starts:
        run, m = [start], start
        while (m % 12) + 1 in present:
            m = (m % 12) + 1
            run.append(m)
        runs.append(run)
    return runs


def _month_list(months: list[int]) -> str:
    """"May–Oct", or "Mar–May, Oct–Dec" for a window with a gap: a dry gap
    between two rainy seasons is never reported as growing season."""
    parts = []
    for run in _month_runs(months):
        a, b = _MONTHS[run[0] - 1], _MONTHS[run[-1] - 1]
        parts.append(a if len(run) == 1 else f"{a}–{b}")
    return ", ".join(parts)


def _short_date(iso: str) -> str:
    d = _dt.date.fromisoformat(iso)
    return f"{d.day} {_MONTHS[d.month - 1]}"


def profile_prompt_block(profile: Optional[LocationProfile]) -> str:
    """A compact, factual block for an AI prompt (under ~250 tokens).

    Lines marked ``~`` are derived or unverified estimates; the block says
    so, and the prompt rule is that the model must present them as
    approximate, never as fact. Returns ``""`` without a profile."""
    if not profile or not profile.current:
        return ""
    cur = profile.current
    lines = ["Place profile (stored facts about this place; lines marked ~ are derived estimates — "
             "present them as approximate, never as fact):"]
    where = ", ".join(x for x in (profile.admin1, profile.countryCode) if x)
    facts = [where] if where else []
    if profile.elevationMeters:
        facts.append(f"{round(profile.elevationMeters)} m")
    facts.append(f"{profile.hemisphere}ern hemisphere")
    if profile.timeZone:
        facts.append(profile.timeZone)
    lines.append("- " + "; ".join(facts))
    if profile.climate.koppen:
        k = profile.climate.koppen
        lines.append(f"- ~Climate zone {k.code} ({k.label})")
    n = cur.normalsThisMonth
    if n and (n.meanHighC is not None or n.meanLowC is not None):
        temps = ", ".join(
            f"{label} {round(v)}°C"
            for label, v in (("high", n.meanHighC), ("low", n.meanLowC)) if v is not None
        )
        rain = f", rain {round(n.precipMm)} mm on {round(n.rainyDays or 0)} days" if n.precipMm is not None else ""
        lines.append(f"- {_MONTHS[cur.month - 1]} normals (ERA5 1991–2020): {temps}{rain}")
    if cur.season:
        mark = "" if cur.season.verified else "~"
        local = f" ({cur.season.localName})" if cur.season.localName and cur.season.localName != cur.season.name else ""
        nxt = ""
        if cur.nextSeason:
            nloc = (f" ({cur.nextSeason.localName})"
                    if cur.nextSeason.localName and cur.nextSeason.localName != cur.nextSeason.name else "")
            nxt = f"; next {cur.nextSeason.name}{nloc} from {_short_date(cur.nextSeason.startsOn)}"
        lines.append(f"- {mark}Season: {cur.season.name}{local}{nxt}")
    if cur.cropPhases:
        parts = []
        for ph in cur.cropPhases[:4]:
            season = f" ({ph.season})" if ph.season else ""
            parts.append(f"{ph.cropLabel.lower()}{season} {ph.phaseLabel.lower()}, "
                         f"{ph.nextPhaseLabel.lower()} from {_short_date(ph.nextPhaseOn)}")
        region = profile.agriculture.calendarRef.get("region") if profile.agriculture and profile.agriculture.calendarRef else None
        lines.append(f"- Crop calendar (GEOGLAM{', ' + region if region else ''}): " + "; ".join(parts))
    elif profile.agriculture and profile.agriculture.derived and profile.agriculture.derived.months:
        d = profile.agriculture.derived
        state = "inside" if cur.inDerivedGrowingWindow else "outside"
        lines.append(f"- ~Likely growing window {_month_list(d.months)} ({d.basis}); now {state} it. "
                     "No local crop calendar on file.")
    if profile.agriculture and profile.agriculture.grazing and profile.agriculture.grazing.note:
        lines.append(f"- ~Grazing: {profile.agriculture.grazing.note}")
    if profile.soil and (profile.soil.wrbClass or profile.soil.texture):
        lines.append("- Soil (SoilGrids model): " + ", ".join(
            x for x in (profile.soil.wrbClass, profile.soil.texture) if x))
    ctx = [f"moon {cur.moon.name}"]
    if cur.enso:
        ctx.insert(0, f"ENSO {cur.enso.phase}{' (' + cur.enso.strength + ')' if cur.enso.strength else ''}")
    if cur.astronomy:
        ctx.append(f"day length {cur.astronomy.dayLengthHours:.1f} h, {cur.astronomy.trend}")
    lines.append("- " + "; ".join(ctx))
    block = "\n".join(lines)
    if len(block) > PROMPT_BLOCK_MAX_CHARS:
        block = block[: PROMPT_BLOCK_MAX_CHARS - 1].rsplit("\n", 1)[0]
    return block


#: The rule every prompt that carries a profile block adds beside it.
PROFILE_GROUNDING_RULE = (
    "Use the place profile to ground timing and local practice (season, crop stage, climate). "
    "Lines marked ~ are derived estimates: say \"typically\" or \"around\", never state them as fact. "
    "If the profile has no crop calendar, do not name local crops."
)

#: An AI prompt never waits longer than this for its profile block.
PROMPT_PROFILE_TIMEOUT_S = 4.0


def profile_block_sync(**kwargs) -> str:
    """``profile_prompt_block`` for a place, cache-only (never waits on an
    upstream; schedules a background build). ``""`` on any problem."""
    try:
        return profile_prompt_block(get_location_profile(allow_build=False, **kwargs))
    except Exception:  # noqa: BLE001
        return ""


async def _warm_enso() -> None:
    """Fill the global ENSO cache (12 h, one NOAA file) so every prompt on
    every instance carries the same ENSO line, not only the instances that
    happened to serve the profile endpoint. Bounded, and a miss is fine."""
    try:
        from ._enso import get_enso  # noqa: PLC0415

        await asyncio.wait_for(get_enso(), timeout=2)
    except Exception:  # noqa: BLE001
        pass


async def profile_block_for(**kwargs) -> str:
    """Async form of :func:`profile_block_sync`, bounded by
    ``PROMPT_PROFILE_TIMEOUT_S`` and run off the event loop."""
    await _warm_enso()
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(profile_block_sync, **kwargs), timeout=PROMPT_PROFILE_TIMEOUT_S,
        )
    except Exception:  # noqa: BLE001
        return ""


def with_profile(block: str) -> str:
    """The block plus its grounding rule, ready to splice into a prompt."""
    return f"\n{block}\n{PROFILE_GROUNDING_RULE}\n" if block else ""


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


#: A request that can start a build (a 30-year archive request and soil
#: calls) is rate-limited like the other upstream-heavy routes. Reads of a
#: stored profile are cheap, are not counted, and the client caches for 30
#: minutes.
PROFILE_RATE_LIMIT = 120
PROFILE_RATE_WINDOW_S = 3600


@router.get("/api/py/locations/profile", response_model=LocationProfile)
async def location_profile(
    request: Request,
    slug: Optional[str] = Query(default=None, max_length=120),
    lat: Optional[float] = Query(default=None, ge=-90, le=90),
    lon: Optional[float] = Query(default=None, ge=-180, le=180),
    country: Optional[str] = Query(default=None, pattern=r"^[A-Za-z]{2}$"),
):
    """
    GET /api/py/locations/profile?slug=<slug>  |  ?lat=&lon=[&country=]

    The place's stored knowledge (seasons, crop calendar, climate normals and
    zone, soil, static facts, provenance) plus its current context (season,
    crop phases, moon, ENSO, day length). Built on first request and stored
    in ``places.placeKnowledge`` once that collection exists. 404 when
    nothing can be resolved; 400 without a slug or a coordinate pair.
    """
    if slug is not None and not SLUG_RE.match(slug):
        raise HTTPException(status_code=400, detail="Invalid slug")
    if not slug and (lat is None or lon is None):
        raise HTTPException(status_code=400, detail="Provide slug, or lat and lon")
    await _warm_enso()
    iso = country.upper() if country else None
    # A stored profile is a cheap read and is not counted. Only a request that
    # would start a build (nothing stored yet) is rate-limited. The limiter is
    # a blocking database call, so it runs off the event loop.
    profile = await asyncio.to_thread(
        get_location_profile, slug=slug, lat=lat, lon=lon, country=iso, allow_build=False,
        schedule_build=False,
    )
    if profile is None or not profile.stored:
        await asyncio.to_thread(
            enforce_rate_limit, request, "place-profile", PROFILE_RATE_LIMIT, PROFILE_RATE_WINDOW_S,
            require_ip=False,
        )
        profile = await asyncio.to_thread(
            get_location_profile, slug=slug, lat=lat, lon=lon, country=iso, allow_build=True,
        )
    if profile is None:
        raise HTTPException(status_code=404, detail="Location not found")
    return profile
