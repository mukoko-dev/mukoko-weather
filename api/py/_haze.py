"""
Haze endpoint — location-aware haze panel data (smoke, dust, urban smog, mist).

``GET /api/py/haze?lat=&lon=`` answers "is there haze here, what kind, how bad,
when is it worst, and is this the local burning/dust season?" for any point on
Earth. It is a heuristic classifier over free, keyless data:

* **Open-Meteo Air Quality** — PM2.5, PM10, dust, aerosol optical depth (AOD),
  US AQI; current + hourly (today and tomorrow).
* **Open-Meteo Forecast** — visibility and relative humidity (current).
* **Official sources** (optional, never blocking) — ``OFFICIAL_SOURCES`` adapters.
  Singapore NEA PSI is wired; Malaysia APIMS and Indonesia ISPU are named stubs.

Classification (all thresholds are design constants, not statistics — tune them
here, in one place):

* **Level** comes from the PM2.5 mean over the ±12 h window around now, using the
  EPA 24-h PM2.5 category floors (12.1 / 35.5 / 55.5 / 150.5 µg/m³). Visibility
  can only *raise* a particle-based level, and only when particles support it
  (PM2.5 at least ``light``, or dust ≥ 10 µg/m³) — rain or fog alone never makes
  haze. Visibility bands with RH < 90 %: < 2 km heavy, < 5 km moderate, < 10 km light.
* **Mist** (not haze): RH ≥ 90 %, visibility < 10 km and PM2.5 mean < 35.5 µg/m³.
* **Type** (when haze): dust if coarse particles dominate (dust ≥ 15 µg/m³ and
  ≥ 30 % of PM10, or PM2.5/PM10 < 0.4 with PM10 ≥ 50); otherwise fine particles
  are smoke when AOD ≥ 0.6 (or a fire season is active and AOD ≥ 0.3 / unknown),
  and smog otherwise.

Seasons come from ``HAZE_SEASONS`` — a small static table of regions and month
windows that wrap the year end (e.g. Nov–Mar). Seasons describe *when* haze is
typical; they never override what the readings say.

Results are cached 30 min in ``weather.haze_cache`` keyed by ``{lat:.2f}_{lon:.2f}``.
Failures return ``available: false`` (HTTP 200), never a 500. Open-Meteo calls go
through ``open_meteo_breaker``.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Literal, Optional

import httpx
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ._circuit_breaker import CircuitOpenError, open_meteo_breaker
from ._db import stamp_platform_fields, weather_db

router = APIRouter()
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

OPEN_METEO_AQ_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"
OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
AQ_PARAMS: dict[str, Any] = {
    "current": "pm2_5,pm10,dust,aerosol_optical_depth,us_aqi",
    "hourly": "pm2_5,dust,aerosol_optical_depth,us_aqi",
    "forecast_days": 2,
    "timezone": "auto",
}
FORECAST_PARAMS: dict[str, Any] = {
    "current": "relative_humidity_2m,visibility",
    "hourly": "visibility,relative_humidity_2m",
    "forecast_days": 2,
    "timezone": "auto",
}

HTTP_TIMEOUT_S = 8.0
OFFICIAL_TIMEOUT_S = 4.0
HAZE_CACHE_TTL_SECONDS = 1800
ATTRIBUTION = (
    "Air quality and visibility: Open-Meteo (CAMS aerosol model, free, no key). "
    "Heuristic classification by mukoko weather; not an official alert."
)

LEVELS: tuple[str, ...] = ("none", "light", "moderate", "heavy", "hazardous")
LEVEL_RANK: dict[str, int] = {name: i for i, name in enumerate(LEVELS)}
HazeLevel = Literal["none", "light", "moderate", "heavy", "hazardous"]
HazeType = Literal["clear", "smoke", "dust", "smog", "mist"]

# PM2.5 floors (µg/m³, 24-h) — EPA AQI category boundaries.
PM25_FLOORS: list[tuple[float, str]] = [
    (150.5, "hazardous"),
    (55.5, "heavy"),
    (35.5, "moderate"),
    (12.1, "light"),
]

# Visibility bands (km), applied only when RH < MIST_RH_PERCENT.
VIS_BANDS_KM: list[tuple[float, str]] = [(2.0, "heavy"), (5.0, "moderate"), (10.0, "light")]

MIST_RH_PERCENT = 90.0
MIST_VIS_KM = 10.0
MIST_MAX_PM25 = 35.5               # mist only when particles are not the cause
DUST_SIGNIFICANT_UGM3 = 10.0      # dust that can carry visibility on its own
DUST_MIN_UGM3 = 15.0              # dust needed to call a haze "dust"
DUST_SHARE_MIN = 0.3              # dust / PM10
COARSE_FINE_RATIO = 0.4           # PM2.5 / PM10 below this = coarse-dominated
COARSE_PM10_MIN = 50.0
AOD_SMOKE_HIGH = 0.6
AOD_SMOKE_SEASON = 0.3
MEAN_WINDOW_HOURS = 12            # ±12 h around now ≈ 24 h window

PSI_URL = "https://api-open.data.gov.sg/v2/real-time/api/psi"

MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


# ---------------------------------------------------------------------------
# Typical haze seasons
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class HazeSeason:
    key: str
    name: str
    haze_type: str  # smoke | dust | smog
    lat_min: float
    lat_max: float
    lon_min: float
    lon_max: float
    start_month: int
    end_month: int  # may be < start_month (wraps the year end)


#: Regional burning / dust / smog seasons. Boxes are deliberately loose; the
#: first active match wins, otherwise the first geographic match is reported.
HAZE_SEASONS: list[HazeSeason] = [
    HazeSeason("sea_haze", "Southeast Asian haze season", "smoke", -11, 10, 94, 125, 6, 10),
    HazeSeason("south_asia_winter_smog", "South Asian winter smog", "smog", 20, 33, 67, 92, 10, 2),
    HazeSeason("northern_china_winter_smog", "Northern China winter smog", "smog", 30, 42, 105, 122, 11, 2),
    HazeSeason("southern_africa_burning", "Southern African burning season", "smoke", -27, -8, 12, 42, 6, 10),
    HazeSeason("harmattan", "Harmattan dust season", "dust", 4, 20, -18, 16, 11, 3),
    HazeSeason("gulf_dust", "Gulf dust season", "dust", 15, 32, 34, 60, 5, 8),
    HazeSeason("east_asia_spring_dust", "East Asian spring dust season", "dust", 36, 50, 100, 125, 3, 5),
    HazeSeason("amazon_fire", "Amazon fire season", "smoke", -18, 5, -74, -50, 8, 10),
    HazeSeason("australia_bushfire", "Australian bushfire season", "smoke", -44, -10, 112, 154, 11, 3),
    HazeSeason("western_na_fire", "Western North American fire season", "smoke", 32, 60, -125, -104, 7, 10),
    HazeSeason("siberia_fire", "Siberian fire season", "smoke", 50, 70, 60, 140, 4, 9),
]


def _month_in_window(month: int, start: int, end: int) -> bool:
    if start <= end:
        return start <= month <= end
    return month >= start or month <= end


def _window_months(start: int, end: int) -> list[int]:
    if start <= end:
        return list(range(start, end + 1))
    return list(range(start, 13)) + list(range(1, end + 1))


def active_season(lat: float, lon: float, month: int) -> Optional["SeasonInfo"]:
    """Return the haze season covering (lat, lon), preferring one active in ``month``."""
    matches = [
        s for s in HAZE_SEASONS
        if s.lat_min <= lat <= s.lat_max and s.lon_min <= lon <= s.lon_max
    ]
    if not matches:
        return None
    chosen = next(
        (s for s in matches if _month_in_window(month, s.start_month, s.end_month)),
        matches[0],
    )
    return SeasonInfo(
        name=chosen.name,
        active=_month_in_window(month, chosen.start_month, chosen.end_month),
        typical_months=_window_months(chosen.start_month, chosen.end_month),
        typical_type=chosen.haze_type,
    )


@dataclass(frozen=True)
class SeasonInfo:
    name: str
    active: bool
    typical_months: list[int]
    typical_type: str


# ---------------------------------------------------------------------------
# Official sources — adapters (never block the response)
# ---------------------------------------------------------------------------


def psi_band(value: float) -> str:
    """NEA PSI band: 0–50 Good, 51–100 Moderate, 101–200 Unhealthy, 201–300 Very unhealthy, >300 Hazardous."""
    if value <= 50:
        return "Good"
    if value <= 100:
        return "Moderate"
    if value <= 200:
        return "Unhealthy"
    if value <= 300:
        return "Very unhealthy"
    return "Hazardous"


def parse_sg_psi(payload: Any) -> Optional[dict]:
    """
    Parse data.gov.sg real-time PSI (v2). The payload has no ``national`` key —
    the headline is the highest regional 24-h PSI.
    """
    try:
        item = payload["data"]["items"][0]
        readings = item["readings"]["psi_twenty_four_hourly"]
    except (KeyError, IndexError, TypeError):
        return None
    if not isinstance(readings, dict):
        return None
    regions = {
        k: v for k, v in readings.items()
        if k != "national" and isinstance(v, (int, float)) and not isinstance(v, bool)
    }
    if not regions:
        return None
    region, value = max(regions.items(), key=lambda kv: kv[1])
    return {
        "source": "NEA Singapore",
        "metric": "PSI",
        "value": int(value),
        "band": psi_band(value),
        "region": region.capitalize(),
        "observedAt": item.get("timestamp") or item.get("updatedTimestamp"),
    }


async def _fetch_sg_psi(lat: float, lon: float) -> Optional[dict]:
    payload = await _http_get_json(PSI_URL, timeout=OFFICIAL_TIMEOUT_S)
    return parse_sg_psi(payload)


def _in_box(lat: float, lon: float, lat_min: float, lat_max: float, lon_min: float, lon_max: float) -> bool:
    return lat_min <= lat <= lat_max and lon_min <= lon <= lon_max


@dataclass(frozen=True)
class OfficialSource:
    id: str
    name: str
    applies: Callable[[float, float], bool]
    fetch: Optional[Callable[[float, float], Any]]  # async; None = stub, not wired

    @property
    def wired(self) -> bool:
        return self.fetch is not None


OFFICIAL_SOURCES: list[OfficialSource] = [
    OfficialSource(
        id="sg-nea-psi",
        name="Singapore NEA PSI",
        applies=lambda lat, lon: _in_box(lat, lon, 1.15, 1.48, 103.59, 104.10),
        fetch=_fetch_sg_psi,
    ),
    # Stubs — listed so they can be wired by adding a fetch coroutine.
    OfficialSource(
        id="my-apims",
        name="Malaysia APIMS (not wired)",
        applies=lambda lat, lon: _in_box(lat, lon, 0.8, 7.5, 99.6, 119.3),
        fetch=None,
    ),
    OfficialSource(
        id="id-ispu",
        name="Indonesia ISPU (not wired)",
        applies=lambda lat, lon: _in_box(lat, lon, -11.0, 6.0, 95.0, 141.0),
        fetch=None,
    ),
]


async def fetch_official(lat: float, lon: float) -> Optional[dict]:
    """First wired official source covering the point, or None. Never raises."""
    for source in OFFICIAL_SOURCES:
        if not source.wired or not source.applies(lat, lon):
            continue
        try:
            return await asyncio.wait_for(source.fetch(lat, lon), timeout=OFFICIAL_TIMEOUT_S)
        except Exception:
            return None
    return None


# ---------------------------------------------------------------------------
# Pydantic response models
# ---------------------------------------------------------------------------


class HazeSeasonModel(BaseModel):
    name: str
    active: bool
    typicalMonths: list[int]
    typicalType: str


class HazeOfficialModel(BaseModel):
    source: str
    metric: str
    value: int
    band: str
    region: str
    observedAt: Optional[str] = None


class HazeResponse(BaseModel):
    available: bool
    reason: Optional[str] = None
    level: Optional[HazeLevel] = None
    type: Optional[HazeType] = None
    headline: Optional[str] = None
    advice: list[str] = []
    visibilityKm: Optional[float] = None
    pm25: Optional[float] = None
    pm25Mean: Optional[float] = None
    dust: Optional[float] = None
    aod: Optional[float] = None
    usAqi: Optional[int] = None
    relativeHumidity: Optional[float] = None
    peakTime: Optional[str] = None
    season: Optional[HazeSeasonModel] = None
    official: Optional[HazeOfficialModel] = None
    attribution: str = ATTRIBUTION
    fetchedAt: str


# ---------------------------------------------------------------------------
# Pure classification
# ---------------------------------------------------------------------------


def pm_level(pm25_mean: Optional[float]) -> str:
    if pm25_mean is None:
        return "none"
    for floor, level in PM25_FLOORS:
        if pm25_mean >= floor:
            return level
    return "none"


def vis_level(vis_km: Optional[float], rh: Optional[float]) -> str:
    if vis_km is None or (rh is not None and rh >= MIST_RH_PERCENT):
        return "none"
    for ceiling, level in VIS_BANDS_KM:
        if vis_km < ceiling:
            return level
    return "none"


def classify_level(
    pm25_mean: Optional[float],
    vis_km: Optional[float],
    rh: Optional[float],
    dust: Optional[float],
) -> str:
    """Particle-based level, optionally raised by visibility when particles support it."""
    pm = pm_level(pm25_mean)
    supported = LEVEL_RANK[pm] >= LEVEL_RANK["light"] or (
        dust is not None and dust >= DUST_SIGNIFICANT_UGM3
    )
    vis = vis_level(vis_km, rh) if supported else "none"
    return max((pm, vis), key=LEVEL_RANK.__getitem__)


def is_mist(
    pm25_mean: Optional[float],
    vis_km: Optional[float],
    rh: Optional[float],
) -> bool:
    return (
        rh is not None
        and rh >= MIST_RH_PERCENT
        and vis_km is not None
        and vis_km < MIST_VIS_KM
        and (pm25_mean is None or pm25_mean < MIST_MAX_PM25)
    )


def classify_type(
    level: str,
    *,
    pm25_mean: Optional[float],
    pm25: Optional[float],
    pm10: Optional[float],
    dust: Optional[float],
    aod: Optional[float],
    rh: Optional[float],
    vis_km: Optional[float],
    fire_season_active: bool,
) -> str:
    if is_mist(pm25_mean, vis_km, rh):
        return "mist"
    if level == "none":
        return "clear"

    dust_value = dust or 0.0
    dust_share = dust_value / pm10 if pm10 else 0.0
    fine_ratio = pm25 / pm10 if (pm25 is not None and pm10) else None
    coarse = fine_ratio is not None and fine_ratio < COARSE_FINE_RATIO

    if (dust_value >= DUST_MIN_UGM3 and dust_share >= DUST_SHARE_MIN) or (
        coarse and pm10 is not None and pm10 >= COARSE_PM10_MIN
    ):
        return "dust"

    if aod is not None and aod >= AOD_SMOKE_HIGH:
        return "smoke"
    if fire_season_active and (aod is None or aod >= AOD_SMOKE_SEASON):
        return "smoke"
    return "smog"


_HEADLINE_NOUN = {"smoke": "smoke haze", "dust": "dust haze", "smog": "smog"}
_LEVEL_WORD = {"light": "Light", "moderate": "Moderate", "heavy": "Heavy", "hazardous": "Hazardous"}


def headline_for(level: str, htype: str) -> str:
    if htype == "clear":
        return "Clear air"
    if htype == "mist":
        return "Mist, not pollution"
    return f"{_LEVEL_WORD.get(level, level.capitalize())} {_HEADLINE_NOUN[htype]}"


def advice_for(level: str, htype: str, peak_time: Optional[str]) -> list[str]:
    if htype == "clear":
        return ["Air looks clear. No haze precautions needed."]
    if htype == "mist":
        return [
            "This is mist or fog from humidity, not pollution. Drive with headlights on "
            "and reduce speed until it lifts.",
        ]

    items: list[str] = []
    if htype == "dust":
        items.append(
            "Keep windows closed and wear eye protection outdoors; rinse eyes if irritated."
            if LEVEL_RANK[level] >= LEVEL_RANK["moderate"]
            else "Keep windows closed and wear sunglasses outdoors."
        )
        items.append("Drive with headlights on and reduce speed; visibility can drop suddenly.")
    else:
        if level == "light":
            items.append("Sensitive groups should cut back on prolonged outdoor exertion.")
        elif level == "moderate":
            items.append("Limit outdoor exertion; wear an N95 or KN95 mask for long time outside.")
        else:
            items.append(
                "Stay indoors with windows closed and run an air purifier if you have one; "
                "wear an N95 or KN95 mask if you must go out."
            )
        if htype == "smog" and LEVEL_RANK[level] >= LEVEL_RANK["moderate"]:
            items.append("Avoid busy roads at peak traffic hours.")

    if peak_time and len(peak_time) >= 16:
        items.append(
            f"Air is worst around {peak_time[11:16]}; plan outdoor work and travel for another time."
        )
    if LEVEL_RANK[level] >= LEVEL_RANK["moderate"]:
        items.append(
            "Children, older adults, and people with asthma or heart or lung conditions "
            "should take extra care."
        )
    return items[:3]


def _mean(values: list[Optional[float]]) -> Optional[float]:
    clean = [v for v in values if v is not None]
    return sum(clean) / len(clean) if clean else None


def _num(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _index_of_hour(times: list[str], now_iso: str) -> int:
    key = now_iso[:13]
    for i, t in enumerate(times):
        if t[:13] == key:
            return i
    return 0


def _series(hourly: dict, field_name: str) -> list[Optional[float]]:
    raw = hourly.get(field_name) or []
    return [_num(v) for v in raw]


def _peak_time(times: list[str], series: list[Optional[float]], idx: int) -> Optional[str]:
    best_i: Optional[int] = None
    for j in range(idx, min(idx + 24, len(series), len(times))):
        v = series[j]
        if v is not None and (best_i is None or v > series[best_i]):  # type: ignore[operator]
            best_i = j
    return times[best_i] if best_i is not None else None


def analyse(
    aq: dict,
    fc: dict,
    lat: float,
    lon: float,
    *,
    month: int,
    official: Optional[dict] = None,
    fetched_at: Optional[datetime] = None,
) -> HazeResponse:
    """Pure: raw Open-Meteo payloads (+ optional official reading) → HazeResponse."""
    fetched = (fetched_at or datetime.now(timezone.utc)).isoformat()
    unavailable = HazeResponse(available=False, reason="insufficient_data", fetchedAt=fetched)

    cur = aq.get("current") or {}
    hourly = aq.get("hourly") or {}
    times = [str(t) for t in (hourly.get("time") or [])]
    idx = _index_of_hour(times, str(cur.get("time") or ""))

    pm_series = _series(hourly, "pm2_5")
    dust_series = _series(hourly, "dust")
    pm25 = _num(cur.get("pm2_5"))
    pm10 = _num(cur.get("pm10"))
    dust = _num(cur.get("dust"))
    aod = _num(cur.get("aerosol_optical_depth"))
    us_aqi = _num(cur.get("us_aqi"))

    window = pm_series[max(0, idx - MEAN_WINDOW_HOURS): idx + MEAN_WINDOW_HOURS]
    pm25_mean = _mean(window)
    if pm25_mean is None:
        pm25_mean = pm25

    fc_cur = fc.get("current") or {}
    rh = _num(fc_cur.get("relative_humidity_2m"))
    vis_m = _num(fc_cur.get("visibility"))
    vis_km = vis_m / 1000.0 if vis_m is not None else None

    if pm25_mean is None and vis_km is None:
        return unavailable

    season = active_season(lat, lon, month)
    fire_active = bool(season and season.active and season.typical_type == "smoke")

    level = classify_level(pm25_mean, vis_km, rh, dust)
    htype = classify_type(
        level,
        pm25_mean=pm25_mean,
        pm25=pm25,
        pm10=pm10,
        dust=dust,
        aod=aod,
        rh=rh,
        vis_km=vis_km,
        fire_season_active=fire_active,
    )

    peak = None
    if level != "none" or htype == "mist":
        peak = _peak_time(times, dust_series if htype == "dust" else pm_series, idx)

    return HazeResponse(
        available=True,
        level=level,  # type: ignore[arg-type]
        type=htype,  # type: ignore[arg-type]
        headline=headline_for(level, htype),
        advice=advice_for(level, htype, peak),
        visibilityKm=round(vis_km, 1) if vis_km is not None else None,
        pm25=round(pm25, 1) if pm25 is not None else None,
        pm25Mean=round(pm25_mean, 1) if pm25_mean is not None else None,
        dust=round(dust, 1) if dust is not None else None,
        aod=round(aod, 2) if aod is not None else None,
        usAqi=int(round(us_aqi)) if us_aqi is not None else None,
        relativeHumidity=rh,
        peakTime=peak,
        season=HazeSeasonModel(
            name=season.name,
            active=season.active,
            typicalMonths=season.typical_months,
            typicalType=season.typical_type,
        ) if season else None,
        official=HazeOfficialModel(**official) if official else None,
        fetchedAt=fetched,
    )


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


async def _http_get_json(url: str, params: Optional[dict] = None, timeout: float = HTTP_TIMEOUT_S) -> Any:
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        return resp.json()


async def _fetch_open_meteo(lat: float, lon: float) -> tuple[dict, dict]:
    """Both Open-Meteo calls through ``open_meteo_breaker``. Raises on failure."""
    if not open_meteo_breaker.is_allowed:
        raise CircuitOpenError(open_meteo_breaker.provider)
    aq_params = {"latitude": lat, "longitude": lon, **AQ_PARAMS}
    fc_params = {"latitude": lat, "longitude": lon, **FORECAST_PARAMS}
    # Sequential on purpose: Open-Meteo's free tier answers bursts of parallel
    # requests from one client with 429, and each 429 counts against the breaker.
    aq = await open_meteo_breaker.execute(lambda: _http_get_json(OPEN_METEO_AQ_URL, aq_params))
    fc = await open_meteo_breaker.execute(lambda: _http_get_json(OPEN_METEO_FORECAST_URL, fc_params))
    return aq, fc


async def build_haze(lat: float, lon: float) -> HazeResponse:
    """Fetch + classify (no cache). Official source runs alongside and never blocks."""
    now = datetime.now(timezone.utc)
    results = await asyncio.gather(
        _fetch_open_meteo(lat, lon),
        fetch_official(lat, lon),
        return_exceptions=True,
    )
    snapshot, official = results
    if isinstance(snapshot, CircuitOpenError):
        return HazeResponse(available=False, reason="provider_unavailable", fetchedAt=now.isoformat())
    if isinstance(snapshot, BaseException):
        logger.warning("haze: open-meteo fetch failed (%s)", type(snapshot).__name__)
        return HazeResponse(available=False, reason="provider_error", fetchedAt=now.isoformat())
    if isinstance(official, BaseException):
        official = None
    aq, fc = snapshot
    return analyse(aq, fc, lat, lon, month=now.month, official=official, fetched_at=now)


def _cache_key(lat: float, lon: float) -> str:
    return f"{lat:.2f}_{lon:.2f}"


def _haze_cache_collection():
    """``weather.haze_cache`` — 30-min TTL, deterministic ``_id``."""
    return weather_db()["haze_cache"]


def _get_cached(lat: float, lon: float) -> Optional[dict]:
    try:
        doc = _haze_cache_collection().find_one(
            {"_id": _cache_key(lat, lon), "expiresAt": {"$gt": datetime.now(timezone.utc)}}
        )
    except Exception:
        return None
    return doc.get("payload") if doc else None


def _set_cached(lat: float, lon: float, payload: dict) -> None:
    now = datetime.now(timezone.utc)
    doc = {
        "_id": _cache_key(lat, lon),
        "lat": lat,
        "lon": lon,
        "payload": payload,
        "fetchedAt": now,
        "expiresAt": now + timedelta(seconds=HAZE_CACHE_TTL_SECONDS),
    }
    stamp_platform_fields(doc)
    try:
        _haze_cache_collection().update_one({"_id": doc["_id"]}, {"$set": doc}, upsert=True)
    except Exception:
        # Cache write failure must not break the response.
        pass


@router.get("/api/py/haze", response_model=HazeResponse)
async def get_haze(
    lat: float = Query(ge=-90, le=90),
    lon: float = Query(ge=-180, le=180),
):
    """
    GET /api/py/haze?lat=&lon=

    Location-aware haze panel data. Always HTTP 200 for valid coordinates;
    ``available: false`` with a ``reason`` when the data cannot be classified.
    """
    cached = _get_cached(lat, lon)
    if cached is not None:
        return JSONResponse(content=cached, headers={"X-Cache": "HIT"})

    result = await build_haze(lat, lon)
    body = result.model_dump(mode="json")
    if result.available:
        _set_cached(lat, lon, body)
    return JSONResponse(content=body, headers={"X-Cache": "MISS"})
