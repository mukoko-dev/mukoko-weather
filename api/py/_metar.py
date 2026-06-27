"""
METAR and TAF aviation weather endpoint.

Fetches real-time METAR observations and TAF forecasts from the
Aviation Weather Center (AWC / NOAA) — free, no API key, global ICAO coverage.

Falls back to CheckWX if AWC fails and a CheckWX key is stored in MongoDB.

Caches results in MongoDB `metar_cache` collection with 30-minute TTL.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone, timedelta
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ._db import get_api_key, get_db

router = APIRouter()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

AWC_METAR_URL = "https://aviationweather.gov/api/data/metar"
AWC_TAF_URL = "https://aviationweather.gov/api/data/taf"
METAR_CACHE_TTL = 1800  # 30 minutes

ICAO_RE = re.compile(r"^[A-Z]{4}$")

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

# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class CloudLayer(BaseModel):
    cover: str   # FEW / SCT / BKN / OVC / CLR / SKC
    base_ft: Optional[int] = None


class MetarObs(BaseModel):
    time: str                    # ISO 8601
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
    source: str


# ---------------------------------------------------------------------------
# MongoDB cache helpers
# ---------------------------------------------------------------------------


def _metar_cache_collection():
    return get_db()["metar_cache"]


def _get_cached(icao: str) -> Optional[dict]:
    doc = _metar_cache_collection().find_one(
        {"icao": icao, "expiresAt": {"$gt": datetime.now(timezone.utc)}}
    )
    return doc


def _set_cached(icao: str, data: dict) -> None:
    now = datetime.now(timezone.utc)
    _metar_cache_collection().update_one(
        {"icao": icao},
        {"$set": {
            "icao": icao,
            "data": data,
            "fetchedAt": now,
            "expiresAt": now + timedelta(seconds=METAR_CACHE_TTL),
        }},
        upsert=True,
    )


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


def _format_visibility(visib: Optional[float]) -> Optional[str]:
    """Convert AWC visibility (statute miles) to km string."""
    if visib is None:
        return None
    km = visib * 1.60934
    if km >= 10:
        return ">10km"
    return f"{km:.1f}km"


def _decode_awc_metar(obs: dict) -> MetarObs:
    """Decode a single AWC METAR JSON object to MetarObs."""
    # Observation time
    obs_time = obs.get("obsTime") or obs.get("receiptTime") or ""
    try:
        dt = datetime.fromisoformat(obs_time.replace("Z", "+00:00"))
        time_str = dt.isoformat()
    except Exception:
        time_str = obs_time

    # Clouds
    raw_clouds = obs.get("clouds") or []
    clouds: list[CloudLayer] = []
    for c in raw_clouds:
        cover = c.get("cover", "")
        base = c.get("base")  # already in feet from AWC
        if cover:
            clouds.append(CloudLayer(cover=cover, base_ft=int(base) if base is not None else None))

    # Visibility (AWC returns statute miles)
    visib = obs.get("visib")
    vis_str = _format_visibility(visib)

    # Wind
    wdir = obs.get("wdir")
    wspd = obs.get("wspd")
    wind_variable = str(wdir).upper() == "VRB" if wdir else False
    wind_dir = None if wind_variable else (int(wdir) if wdir is not None else None)

    # Remarks — extract change indicators
    remarks = obs.get("remarks") or ""
    change: Optional[str] = None
    if "NOSIG" in remarks:
        change = "No Significant Change"
    elif "BECMG" in remarks:
        change = "Becoming"
    elif "TEMPO" in remarks:
        change = "Temporary"

    # Pressure: AWC gives altimeter in inHg, convert to hPa
    altim = obs.get("altim")
    pressure_hpa = round(float(altim) * 33.8639, 1) if altim else None

    flight_cat = obs.get("flightCategory") or _compute_flight_category(clouds, vis_str)
    # Normalise AWC's category names just in case
    if flight_cat not in ("VFR", "MVFR", "IFR", "LIFR"):
        flight_cat = _compute_flight_category(clouds, vis_str)

    return MetarObs(
        time=time_str,
        temp=obs.get("temp"),
        dewp=obs.get("dewp"),
        wind_dir=wind_dir,
        wind_speed=int(wspd) if wspd is not None else None,
        wind_variable=wind_variable,
        visibility=vis_str,
        clouds=clouds,
        weather=_decode_wx(obs.get("wxString")),
        pressure_hpa=pressure_hpa,
        flight_category=flight_cat,
        change=change,
        raw=obs.get("rawOb") or "",
    )


# ---------------------------------------------------------------------------
# AWC fetch helpers
# ---------------------------------------------------------------------------

_http_client: Optional[httpx.Client] = None


def _get_http() -> httpx.Client:
    global _http_client
    if _http_client is None:
        _http_client = httpx.Client(timeout=10.0)
    return _http_client


def _fetch_awc_metar(icao: str) -> list[MetarObs]:
    client = _get_http()
    resp = client.get(AWC_METAR_URL, params={"ids": icao, "format": "json", "hours": "12"})
    resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, list):
        return []
    return [_decode_awc_metar(obs) for obs in data]


def _fetch_awc_taf(icao: str) -> Optional[str]:
    client = _get_http()
    resp = client.get(AWC_TAF_URL, params={"ids": icao, "format": "json"})
    if resp.status_code != 200:
        return None
    data = resp.json()
    if not isinstance(data, list) or not data:
        return None
    return data[0].get("rawTAF")


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
# Endpoint
# ---------------------------------------------------------------------------


@router.get("/api/py/metar", response_model=MetarResponse)
async def get_metar(icao: str):
    """
    GET /api/py/metar?icao=FVHA

    Returns METAR observations (last 12h) and TAF for a given ICAO airport code.
    Data sourced from Aviation Weather Center (AWC/NOAA). Cached 30 minutes.
    """
    icao = icao.upper().strip()
    if not ICAO_RE.match(icao):
        raise HTTPException(status_code=400, detail="Invalid ICAO code — must be 4 uppercase letters")

    # Cache hit
    try:
        cached = _get_cached(icao)
        if cached:
            return MetarResponse(**cached["data"])
    except Exception:
        pass

    # Try AWC (primary)
    source = "awc"
    metar_obs: list[MetarObs] = []
    taf: Optional[str] = None

    try:
        metar_obs = _fetch_awc_metar(icao)
        taf = _fetch_awc_taf(icao)
    except Exception:
        # Fallback to CheckWX if key available
        checkwx_key = None
        try:
            checkwx_key = get_api_key("checkwx")
        except Exception:
            pass

        if checkwx_key:
            try:
                metar_obs = _fetch_checkwx_metar(icao, checkwx_key)
                source = "checkwx"
            except Exception:
                pass

    result = MetarResponse(icao=icao, metar=metar_obs, taf=taf, source=source)

    # Cache the result (even empty — prevents hammering for inactive stations)
    try:
        _set_cached(icao, result.model_dump())
    except Exception:
        pass

    return result
