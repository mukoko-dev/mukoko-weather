"""
METAR and TAF aviation weather endpoints.

Fetches real-time METAR observations and TAF forecasts from the
Aviation Weather Center (AWC / NOAA) — free, no API key, global ICAO coverage.

Endpoints:
  GET /api/py/metar?icao=FVRG                 one station's METAR + TAF
  GET /api/py/aviation/nearest-metar?lat&lon  nearest airport that ACTUALLY has
                                              a recent METAR (one AWC request)

AWC JSON payload notes (verified against the live API, 2026-10):
  * ``obsTime`` is epoch seconds (an int), not ISO text.
  * ``visib`` is a STRING in statute miles: "6+", "10+", "1 1/2", "3".
  * ``altim`` is already hPa (1024), not inHg.
  * The category field is ``fltCat``; ``rawOb`` carries the remarks
    (NOSIG / TEMPO / BECMG) — there is no separate ``remarks`` field.
  * A station AWC no longer serves (e.g. the retired FVHA) simply does not
    appear in the response — that is an empty answer, not a failure.

Falls back to CheckWX if AWC fails and a CheckWX key is stored in MongoDB.

Caching (``metar_cache`` collection, one doc per station + kind):
  * real answers live 30 minutes (``METAR_CACHE_TTL``);
  * empty answers live 2 minutes (``METAR_EMPTY_CACHE_TTL``) so a station that
    just went quiet is re-checked soon, not for half an hour;
  * transport / payload failures are NEVER cached.
  * docs carry ``schema`` so a decode fix invalidates older cached answers.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Literal, Optional, TypeVar

import httpx
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ._airports import NearbyAirport, nearest_airports
from ._circuit_breaker import CircuitOpenError, aviation_breaker
from ._db import get_api_key, get_db

router = APIRouter()
logger = logging.getLogger(__name__)

T = TypeVar("T")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

AWC_METAR_URL = "https://aviationweather.gov/api/data/metar"
AWC_TAF_URL = "https://aviationweather.gov/api/data/taf"
AWC_HEADERS = {
    # AWC asks API clients to identify themselves; bare library UAs get throttled.
    "User-Agent": "mukoko-weather/1.0 (+https://weather.mukoko.com; support@mukoko.com)",
    "Accept": "application/json",
}

METAR_CACHE_TTL = 1800  # 30 minutes — real answers
METAR_EMPTY_CACHE_TTL = 120  # 2 minutes — "no report" answers
CACHE_SCHEMA = 2  # bump when the decoded shape changes

#: A nearest-report search only counts a METAR this recent as "reporting".
DEFAULT_RADIUS_KM = 150.0
DEFAULT_MAX_AGE_MIN = 180

ICAO_RE = re.compile(r"^[A-Z]{4}$")
_NUMERIC_RE = re.compile(r"^[+-]?\d+(\.\d+)?$")
_FRACTION_RE = re.compile(r"^(?:(\d+)\s+)?(\d+)/(\d+)$")

# wx string → human-readable label (partial, covers common codes)
_WX_LABELS: dict[str, str] = {
    "DZ": "Drizzle", "RA": "Rain", "SN": "Snow", "GR": "Hail",
    "GS": "Small Hail", "FG": "Fog", "BR": "Mist", "HZ": "Haze",
    "DU": "Dust", "SA": "Sand", "TS": "Thunderstorm", "SQ": "Squall",
    "FC": "Funnel Cloud", "SS": "Sandstorm", "DS": "Dust Storm",
    "UP": "Unknown Precip", "FZRA": "Freezing Rain", "FZDZ": "Freezing Drizzle",
    "RASN": "Rain/Snow", "SNRA": "Snow/Rain", "SHRA": "Rain Showers",
    "SHSN": "Snow Showers", "TSRA": "Thunderstorm Rain",
    "TSSN": "Thunderstorm Snow", "VCSH": "Showers Nearby", "VCTS": "TS Nearby",
}

_INTENSITY_PREFIX: dict[str, str] = {
    "-": "Light ", "+": "Heavy ", "VC": "Nearby ",
}

_VALID_CATEGORIES = ("VFR", "MVFR", "IFR", "LIFR")

# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class CloudLayer(BaseModel):
    cover: str   # FEW / SCT / BKN / OVC / CLR / SKC
    base_ft: Optional[int] = None


class MetarObs(BaseModel):
    time: str                    # ISO 8601 (UTC), "" when AWC gave no time
    temp: Optional[float] = None
    dewp: Optional[float] = None
    wind_dir: Optional[int] = None
    wind_speed: Optional[int] = None
    wind_variable: bool = False
    visibility: Optional[str] = None
    clouds: list[CloudLayer] = []
    weather: Optional[str] = None
    pressure_hpa: Optional[float] = None
    flight_category: str = "VFR"
    change: Optional[str] = None
    raw: str


class MetarResponse(BaseModel):
    icao: str
    metar: list[MetarObs]
    taf: Optional[str] = None
    source: str  # "awc" | "checkwx" | "unavailable"


class NearestCandidate(BaseModel):
    icao: str
    name: str
    distanceKm: float
    reported: bool                     # has a METAR within maxAgeMinutes
    observedAt: Optional[str] = None   # latest METAR time, any age
    ageMinutes: Optional[int] = None


class NearestMetarResponse(BaseModel):
    status: Literal["ok", "no_recent_report", "no_airports", "unavailable"]
    message: Optional[str] = None
    searchRadiusKm: float
    maxAgeMinutes: int
    # The chosen station (status == "ok" only).
    icao: Optional[str] = None
    name: Optional[str] = None
    distanceKm: Optional[float] = None
    observedAt: Optional[str] = None
    ageMinutes: Optional[int] = None
    metar: list[MetarObs] = []
    taf: Optional[str] = None
    source: str = "awc"
    # Every airport considered, nearest first, so the UI can offer a picker.
    candidates: list[NearestCandidate] = []


# ---------------------------------------------------------------------------
# MongoDB cache helpers
# ---------------------------------------------------------------------------


def _metar_cache_collection():
    return get_db()["metar_cache"]


def _cache_get(icao: str, kind: str) -> Optional[dict]:
    """Fresh cache doc for (station, kind) or None. Never raises."""
    try:
        return _metar_cache_collection().find_one({
            "icao": icao,
            "kind": kind,
            "schema": CACHE_SCHEMA,
            "expiresAt": {"$gt": datetime.now(timezone.utc)},
        })
    except Exception:
        return None


def _cache_put(icao: str, kind: str, data: dict, ttl: int) -> None:
    """Upsert a cache doc. Never raises — caching is best-effort."""
    try:
        now = datetime.now(timezone.utc)
        _metar_cache_collection().update_one(
            {"icao": icao, "kind": kind},
            {"$set": {
                "icao": icao,
                "kind": kind,
                "schema": CACHE_SCHEMA,
                "data": data,
                "fetchedAt": now,
                "expiresAt": now + timedelta(seconds=ttl),
            }},
            upsert=True,
        )
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Tolerant value helpers
# ---------------------------------------------------------------------------


def _num(value: Any) -> Optional[float]:
    """Coerce an AWC scalar (int, float or numeric string) to float, else None."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        s = value.strip()
        if _NUMERIC_RE.match(s):
            return float(s)
    return None


def parse_visibility_sm(raw: Any) -> tuple[Optional[float], bool]:
    """
    AWC visibility → (statute miles, is_open_ended).

    Accepts the string forms AWC actually sends: "6+", "10", "1 1/2", "1/2",
    "3SM". ``is_open_ended`` is True for the "N+" form ("more than N").
    """
    if raw is None or isinstance(raw, bool):
        return None, False
    if isinstance(raw, (int, float)):
        return float(raw), False
    s = str(raw).strip().upper()
    if s.endswith("SM"):
        s = s[:-2].strip()
    plus = s.endswith("+")
    if plus:
        s = s[:-1].strip()
    fraction = _FRACTION_RE.match(s)
    if fraction:
        whole = int(fraction.group(1) or 0)
        num, den = int(fraction.group(2)), int(fraction.group(3))
        if den == 0:
            return None, False
        return whole + num / den, plus
    value = _num(s)
    return (value, plus) if value is not None else (None, False)


# ---------------------------------------------------------------------------
# METAR decoding helpers
# ---------------------------------------------------------------------------


def _decode_wx(wx_string: Optional[str]) -> Optional[str]:
    """Decode a METAR weather string like '-RA' → 'Light Rain'."""
    if not wx_string:
        return None
    result = []
    for token in wx_string.split():
        label = ""
        # Strip intensity/vicinity prefix
        prefix = ""
        for pfx, pfx_label in _INTENSITY_PREFIX.items():
            if token.startswith(pfx):
                prefix = pfx_label
                token = token[len(pfx):]
                break
        label = _WX_LABELS.get(token, token)
        result.append(f"{prefix}{label}".strip())
    return ", ".join(result) if result else wx_string


def _compute_flight_category(clouds: list[CloudLayer], vis_str: Optional[str]) -> str:
    """Compute VFR/MVFR/IFR/LIFR from ceiling and visibility."""
    # Parse visibility in km
    vis_km: Optional[float] = None
    if vis_str:
        try:
            if vis_str.startswith(">"):
                vis_km = float(vis_str[1:].replace("km", "").strip())
            else:
                # vis_str is already in km (e.g. "4.8km", "9.9km")
                vis_km = float(vis_str.replace("km", "").strip())
        except ValueError:
            pass

    # Ceiling = lowest BKN or OVC layer
    ceiling_ft: Optional[int] = None
    for layer in clouds:
        if layer.cover in ("BKN", "OVC") and layer.base_ft is not None:
            if ceiling_ft is None or layer.base_ft < ceiling_ft:
                ceiling_ft = layer.base_ft

    lifr_ceiling = ceiling_ft is not None and ceiling_ft < 500
    lifr_vis = vis_km is not None and vis_km < 1.6
    ifr_ceiling = ceiling_ft is not None and ceiling_ft < 1000
    ifr_vis = vis_km is not None and vis_km < 4.8
    mvfr_ceiling = ceiling_ft is not None and ceiling_ft < 3000
    mvfr_vis = vis_km is not None and vis_km < 8.0

    if lifr_ceiling or lifr_vis:
        return "LIFR"
    if ifr_ceiling or ifr_vis:
        return "IFR"
    if mvfr_ceiling or mvfr_vis:
        return "MVFR"
    return "VFR"


def _format_visibility(visib: Any) -> Optional[str]:
    """
    AWC visibility (statute miles, string or number) → km display string.

    "6+" means more than 6 SM (~9.7 km) and renders as ">9.7km"; anything at
    or beyond 10 km renders as ">10km".
    """
    sm, plus = parse_visibility_sm(visib)
    if sm is None:
        return None
    km = sm * 1.60934
    if km >= 10:
        return ">10km"
    if plus:
        return f">{km:.1f}km"
    return f"{km:.1f}km"


def _obs_datetime(raw: dict) -> Optional[datetime]:
    """
    The observation time as an aware UTC datetime. Accepts AWC's epoch seconds
    (``obsTime``), ISO text, and falls back through ``reportTime`` /
    ``receiptTime``.
    """
    for key in ("obsTime", "reportTime", "receiptTime"):
        value = raw.get(key)
        if value in (None, ""):
            continue
        epoch = _num(value)
        if epoch is not None:
            return datetime.fromtimestamp(epoch, tz=timezone.utc)
        if isinstance(value, str):
            try:
                dt = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
            except ValueError:
                continue
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc)
    return None


def _altimeter_hpa(altim: Any) -> Optional[float]:
    """AWC reports hPa (1024). Legacy answers used inHg (30.2) — convert those."""
    value = _num(altim)
    if value is None:
        return None
    hpa = value if value > 50 else value * 33.8639
    return round(hpa, 1)


def _decode_awc_metar(obs: dict) -> MetarObs:
    """Decode a single AWC METAR JSON object to MetarObs. Tolerant of missing fields."""
    dt = _obs_datetime(obs)
    time_str = dt.isoformat() if dt else ""

    clouds: list[CloudLayer] = []
    for c in obs.get("clouds") or []:
        if not isinstance(c, dict):
            continue
        cover = str(c.get("cover") or "").upper()
        if not cover:
            continue
        base = _num(c.get("base"))
        clouds.append(CloudLayer(cover=cover, base_ft=int(base) if base is not None else None))

    vis_str = _format_visibility(obs.get("visib"))

    # Wind — direction may be the string "VRB" (variable).
    wdir_raw = obs.get("wdir")
    wind_variable = isinstance(wdir_raw, str) and wdir_raw.strip().upper() == "VRB"
    wdir = None if wind_variable else _num(wdir_raw)
    wspd = _num(obs.get("wspd"))

    # Change indicators live in the raw report text, not a separate field.
    text = f"{obs.get('rawOb') or ''} {obs.get('remarks') or ''}".upper()
    tokens = set(re.findall(r"[A-Z]+", text))
    change: Optional[str] = None
    if "NOSIG" in tokens:
        change = "No Significant Change"
    elif "BECMG" in tokens:
        change = "Becoming"
    elif "TEMPO" in tokens:
        change = "Temporary"

    raw_category = str(obs.get("fltCat") or obs.get("flightCategory") or "").upper()
    flight_cat = (
        raw_category
        if raw_category in _VALID_CATEGORIES
        else _compute_flight_category(clouds, vis_str)
    )

    return MetarObs(
        time=time_str,
        temp=_num(obs.get("temp")),
        dewp=_num(obs.get("dewp")),
        wind_dir=int(wdir) if wdir is not None else None,
        wind_speed=int(wspd) if wspd is not None else None,
        wind_variable=wind_variable,
        visibility=vis_str,
        clouds=clouds,
        weather=_decode_wx(obs.get("wxString")),
        pressure_hpa=_altimeter_hpa(obs.get("altim")),
        flight_category=flight_cat,
        change=change,
        raw=str(obs.get("rawOb") or ""),
    )


def decode_awc_metars(raw_list: list) -> list[MetarObs]:
    """
    Decode one station's AWC observations, newest first. A malformed record is
    logged and skipped rather than failing the whole station.
    """
    epoch_floor = datetime.min.replace(tzinfo=timezone.utc)
    decoded: list[tuple[datetime, MetarObs]] = []
    for raw in raw_list:
        if not isinstance(raw, dict):
            continue
        try:
            decoded.append((_obs_datetime(raw) or epoch_floor, _decode_awc_metar(raw)))
        except Exception as e:  # defensive: one bad record must not sink the rest
            logger.warning("skipping malformed AWC METAR: %s", e)
    decoded.sort(key=lambda pair: pair[0], reverse=True)
    return [obs for _, obs in decoded]


# ---------------------------------------------------------------------------
# AWC fetch helpers
# ---------------------------------------------------------------------------

_http_client: Optional[httpx.Client] = None


def _get_http() -> httpx.Client:
    global _http_client
    if _http_client is None:
        _http_client = httpx.Client(timeout=10.0, headers=AWC_HEADERS)
    return _http_client


def _awc_get(url: str, params: dict) -> list:
    """
    GET an AWC JSON endpoint. Returns the list payload ([] when AWC has nothing,
    including its 204 No Content). Raises on transport errors and on any payload
    that is not a list, so a failure is never mistaken for "no report".
    """
    resp = _get_http().get(url, params=params)
    if resp.status_code == 204:
        return []
    resp.raise_for_status()
    if not resp.text.strip():
        return []
    data = resp.json()
    if not isinstance(data, list):
        raise ValueError(f"unexpected AWC payload from {url}")
    return data


def _group_by_station(data: list) -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = {}
    for obs in data:
        if not isinstance(obs, dict):
            continue
        station = str(obs.get("icaoId") or obs.get("stationId") or "").upper()
        if station:
            grouped.setdefault(station, []).append(obs)
    return grouped


def fetch_awc_metars(icaos: list[str]) -> dict[str, list[MetarObs]]:
    """
    METARs (last 12 h) for many stations in ONE AWC request. Every requested
    station appears in the result — an empty list means AWC had no report.
    """
    data = _awc_get(AWC_METAR_URL, {"ids": ",".join(icaos), "format": "json", "hours": "12"})
    grouped = _group_by_station(data)
    return {icao: decode_awc_metars(grouped.get(icao, [])) for icao in icaos}


def _fetch_awc_taf(icao: str) -> Optional[str]:
    """Raw TAF for one station, or None when AWC has none. Raises on failure."""
    data = _awc_get(AWC_TAF_URL, {"ids": icao, "format": "json"})
    for item in data:
        if isinstance(item, dict) and str(item.get("icaoId", "")).upper() == icao and item.get("rawTAF"):
            return str(item["rawTAF"])
    first = data[0] if data else None
    if isinstance(first, dict) and first.get("rawTAF"):
        return str(first["rawTAF"])
    return None


async def _awc_call(fn: Callable[[], T]) -> T:
    """Run a blocking AWC call behind the aviationweather.gov circuit breaker."""
    if not aviation_breaker.is_allowed:
        raise CircuitOpenError("aviationweather-gov")
    try:
        result = await asyncio.to_thread(fn)
    except Exception:
        aviation_breaker.record_failure()
        raise
    aviation_breaker.record_success()
    return result


async def _metar_for_stations(icaos: list[str]) -> dict[str, list[MetarObs]]:
    """
    METARs for each station: per-station cache first, then ONE batched AWC
    request for whatever is missing. Raises if AWC fails for the batch.
    """
    result: dict[str, list[MetarObs]] = {}
    missing: list[str] = []
    for icao in icaos:
        doc = await asyncio.to_thread(_cache_get, icao, "metar")
        if doc is not None:
            result[icao] = [MetarObs(**o) for o in doc["data"]["metar"]]
        else:
            missing.append(icao)
    if missing:
        fetched = await _awc_call(lambda: fetch_awc_metars(missing))
        for icao in missing:
            obs = fetched.get(icao, [])
            ttl = METAR_CACHE_TTL if obs else METAR_EMPTY_CACHE_TTL
            await asyncio.to_thread(
                _cache_put, icao, "metar", {"metar": [o.model_dump() for o in obs]}, ttl,
            )
            result[icao] = obs
    return result


async def _taf_for(icao: str) -> Optional[str]:
    """Cached TAF for a station. A failed AWC call returns None and is NOT cached."""
    doc = await asyncio.to_thread(_cache_get, icao, "taf")
    if doc is not None:
        return doc["data"].get("taf")
    try:
        taf = await _awc_call(lambda: _fetch_awc_taf(icao))
    except Exception:
        return None
    ttl = METAR_CACHE_TTL if taf else METAR_EMPTY_CACHE_TTL
    await asyncio.to_thread(_cache_put, icao, "taf", {"taf": taf}, ttl)
    return taf


# ---------------------------------------------------------------------------
# CheckWX fallback (if AWC fails and key is stored)
# ---------------------------------------------------------------------------


def _fetch_checkwx_metar(icao: str, key: str) -> list[MetarObs]:
    """Minimal CheckWX fetch — returns decoded MetarObs list."""
    client = _get_http()
    resp = client.get(
        f"https://api.checkwx.com/metar/{icao}/decoded",
        headers={"X-API-Key": key},
    )
    resp.raise_for_status()
    body = resp.json()
    results = body.get("data", [])
    obs_list: list[MetarObs] = []
    for obs in results:
        clouds_raw = obs.get("clouds", {}).get("layers", []) or []
        clouds = [
            CloudLayer(
                cover=c.get("code", ""),
                base_ft=c.get("feet"),
            )
            for c in clouds_raw
        ]
        vis = obs.get("visibility", {})
        vis_km: Optional[str] = None
        vis_meters = vis.get("meters_float")
        if vis_meters is not None:
            vis_km = ">10km" if vis_meters >= 9999 else f"{vis_meters/1000:.1f}km"

        wind = obs.get("wind", {})
        wind_variable = wind.get("degrees") is None

        obs_list.append(MetarObs(
            time=obs.get("observed", ""),
            temp=obs.get("temperature", {}).get("celsius"),
            dewp=obs.get("dewpoint", {}).get("celsius"),
            wind_dir=wind.get("degrees"),
            wind_speed=wind.get("speed_kts"),
            wind_variable=wind_variable,
            visibility=vis_km,
            clouds=clouds,
            weather=obs.get("conditions", [{}])[0].get("text") if obs.get("conditions") else None,
            pressure_hpa=obs.get("barometer", {}).get("hpa"),
            flight_category=obs.get("flight_category", "VFR"),
            raw=obs.get("raw_text", ""),
        ))
    return obs_list


# ---------------------------------------------------------------------------
# Single-station report
# ---------------------------------------------------------------------------


async def station_report(icao: str) -> MetarResponse:
    """METAR + TAF for one station, with CheckWX as the fallback source."""
    metar_doc = await asyncio.to_thread(_cache_get, icao, "metar")
    if metar_doc is not None:
        metar_obs = [MetarObs(**o) for o in metar_doc["data"]["metar"]]
        taf = await _taf_for(icao)
        return MetarResponse(icao=icao, metar=metar_obs, taf=taf, source="awc")

    try:
        metar_obs = (await _metar_for_stations([icao]))[icao]
    except Exception:
        checkwx_key = None
        try:
            checkwx_key = get_api_key("checkwx")
        except Exception:
            pass
        if checkwx_key:
            try:
                obs = await asyncio.to_thread(_fetch_checkwx_metar, icao, checkwx_key)
                return MetarResponse(icao=icao, metar=obs, taf=None, source="checkwx")
            except Exception:
                pass
        # Nothing answered: say so, and do not cache the failure.
        return MetarResponse(icao=icao, metar=[], taf=None, source="unavailable")

    taf = await _taf_for(icao)
    return MetarResponse(icao=icao, metar=metar_obs, taf=taf, source="awc")


# ---------------------------------------------------------------------------
# Nearest airport with a recent report
# ---------------------------------------------------------------------------


def _age_minutes(observed: Optional[datetime], now: datetime) -> Optional[int]:
    if observed is None:
        return None
    return int((now - observed).total_seconds() // 60)


async def find_nearest_report(
    lat: float,
    lon: float,
    count: int = 5,
    radius_km: float = DEFAULT_RADIUS_KM,
    max_age_min: int = DEFAULT_MAX_AGE_MIN,
) -> NearestMetarResponse:
    """
    The nearest airport (within ``radius_km``) that has a METAR no older than
    ``max_age_min``. Candidates come from the DB-backed airport catalogue; their
    METARs come from one batched AWC request (cache-first).
    """
    base = {"searchRadiusKm": radius_km, "maxAgeMinutes": max_age_min}

    candidates: list[NearbyAirport] = await asyncio.to_thread(
        nearest_airports, lat, lon, count, radius_km,
    )
    if not candidates:
        return NearestMetarResponse(
            status="no_airports",
            message=f"No airport with a METAR feed within {radius_km:g} km of this location.",
            **base,
        )

    icaos = [c.icao for c in candidates]
    try:
        reports = await _metar_for_stations(icaos)
    except Exception:
        return NearestMetarResponse(
            status="unavailable",
            message="Aviation data temporarily unavailable.",
            candidates=[
                NearestCandidate(icao=c.icao, name=c.name, distanceKm=c.distanceKm, reported=False)
                for c in candidates
            ],
            **base,
        )

    now = datetime.now(timezone.utc)
    rows: list[NearestCandidate] = []
    chosen: Optional[tuple[NearbyAirport, MetarObs, Optional[int]]] = None
    for c in candidates:
        obs_list = reports.get(c.icao, [])
        latest = obs_list[0] if obs_list else None
        observed_dt = _obs_datetime({"obsTime": latest.time}) if latest and latest.time else None
        age = _age_minutes(observed_dt, now)
        reported = age is not None and -5 <= age <= max_age_min
        rows.append(NearestCandidate(
            icao=c.icao,
            name=c.name,
            distanceKm=c.distanceKm,
            reported=reported,
            observedAt=latest.time if latest and latest.time else None,
            ageMinutes=age,
        ))
        if reported and chosen is None:
            chosen = (c, latest, age)

    if chosen is None:
        return NearestMetarResponse(
            status="no_recent_report",
            message=(
                f"No airport within {radius_km:g} km has reported in the last "
                f"{max_age_min // 60} hours."
            ),
            candidates=rows,
            **base,
        )

    airport, latest, age = chosen
    taf = await _taf_for(airport.icao)
    return NearestMetarResponse(
        status="ok",
        icao=airport.icao,
        name=airport.name,
        distanceKm=airport.distanceKm,
        observedAt=latest.time or None,
        ageMinutes=age,
        metar=reports[airport.icao],
        taf=taf,
        source="awc",
        candidates=rows,
        **base,
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/api/py/metar", response_model=MetarResponse)
async def get_metar(icao: str):
    """
    GET /api/py/metar?icao=FVRG

    Returns METAR observations (last 12h) and TAF for a given ICAO airport code.
    Data sourced from Aviation Weather Center (AWC/NOAA). Cached 30 minutes
    (2 minutes when the station had no report).
    """
    icao = icao.upper().strip()
    if not ICAO_RE.match(icao):
        raise HTTPException(status_code=400, detail="Invalid ICAO code — must be 4 uppercase letters")
    return await station_report(icao)


@router.get("/api/py/aviation/nearest-metar", response_model=NearestMetarResponse)
async def get_nearest_metar(
    lat: float = Query(..., ge=-90.0, le=90.0),
    lon: float = Query(..., ge=-180.0, le=180.0),
    count: int = Query(5, ge=1, le=10),
    radiusKm: float = Query(DEFAULT_RADIUS_KM, gt=0.0, le=500.0),
    maxAgeMinutes: int = Query(DEFAULT_MAX_AGE_MIN, ge=30, le=720),
):
    """
    GET /api/py/aviation/nearest-metar?lat=-17.85&lon=31.05

    The nearest airport within ``radiusKm`` that has a METAR no older than
    ``maxAgeMinutes``, with its METAR + TAF. ``status`` is one of ``ok``,
    ``no_recent_report``, ``no_airports`` or ``unavailable``; ``candidates``
    lists every airport considered so the UI can offer a picker.
    """
    return await find_nearest_report(
        lat, lon, count=count, radius_km=radiusKm, max_age_min=maxAgeMinutes,
    )
