"""
Weather proxy — the single canonical forecast fetch / cache / history writer.

Baseline (issue #246): an Africa-weighted blend of global NWP models served
keyless by Open-Meteo (ECMWF IFS + AIFS, GFS, ICON, GEM, ARPEGE — see
``_model_blend.py``). Tomorrow.io is ENRICHMENT ONLY — its insights fields are
merged on top under a MongoDB-backed quota budget (``_enrichment.py``) and it
can never block or replace the baseline.

Caches the baseline in MongoDB with a 15-min TTL, records history and returns
normalized WeatherData.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone, timedelta
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from ._db import (
    observations_collection,
    weather_cache_collection,
)
from ._places_resolver import find_nearest_location
from ._circuit_breaker import open_meteo_breaker
from . import _enrichment as enrichment
from . import _model_blend as blend
from . import _verification as verification
from ._insights import (
    current_hour_index,
    derive_insights,
    strip_intermediate,
)

router = APIRouter()

# Module-level httpx client (reused across warm Vercel invocations)
_http_client: Optional[httpx.Client] = None

WEATHER_CACHE_TTL = 900  # 15 minutes

# StationKit defaults: prefer a recent QC-validated observation from a Nyuchi
# weather station within this radius/age over any commercial-API current data.
STATION_MAX_DISTANCE_KM = 50
STATION_MAX_AGE_MINUTES = 60


def _get_http_client() -> httpx.Client:
    global _http_client
    if _http_client is None:
        _http_client = httpx.Client(timeout=15.0)
    return _http_client


# ---------------------------------------------------------------------------
# Weather provider clients
# ---------------------------------------------------------------------------


def _compute_is_day(time_str: str, daily_raw: list[dict]) -> int:
    """Determine if an hour is daytime from the daily sunrise/sunset data.

    Mirrors the day/night computation the UI's Open-Meteo path gets natively
    (``is_day``); Tomorrow.io has no such field so it's derived here. Falls
    back to a 6am–6pm heuristic when timestamps are missing/unparseable.
    """
    try:
        t = datetime.fromisoformat(time_str.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return 1

    for day in daily_raw:
        v = day.get("values", {})
        try:
            sunrise = datetime.fromisoformat(str(v.get("sunriseTime", "")).replace("Z", "+00:00"))
            sunset = datetime.fromisoformat(str(v.get("sunsetTime", "")).replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            continue
        if sunrise <= t <= sunset:
            return 1
        # Same day (within 24h of sunrise) but outside daylight → night.
        if abs((t - sunrise).total_seconds()) < 24 * 3600:
            return 0

    return 1 if 6 <= t.hour < 18 else 0


#: Units for the ``current`` block — Tomorrow.io metric units, matching what
#: Open-Meteo reports for the same fields so consumers see one shape.
_CURRENT_UNITS = {
    "temperature_2m": "°C",
    "relative_humidity_2m": "%",
    "apparent_temperature": "°C",
    "precipitation": "mm",
    "wind_speed_10m": "km/h",
    "wind_gusts_10m": "km/h",
    "uv_index": "",
    "surface_pressure": "hPa",
    "cloud_cover": "%",
}


def _normalize_tomorrow(raw: dict) -> dict:
    """Normalize Tomorrow.io response to our WeatherData shape.

    This is the CANONICAL Tomorrow.io normalization — the TypeScript copy was
    removed (issue #101) because the two produced incompatible cache documents
    (missing ``is_day``/``current_units``/``precipitation_probability`` here,
    diverging WMO code values there).
    """
    timelines = raw.get("timelines", {})
    hourly_raw = timelines.get("hourly", [])
    daily_raw = timelines.get("daily", [])

    # Current from first hourly
    current = {}
    if hourly_raw:
        first = hourly_raw[0].get("values", {})
        current = {
            "time": hourly_raw[0].get("time", ""),
            "temperature_2m": first.get("temperature"),
            "relative_humidity_2m": first.get("humidity"),
            "apparent_temperature": first.get("temperatureApparent"),
            "precipitation": first.get("precipitationIntensity", 0),
            "weather_code": _tomorrow_code_to_wmo(first.get("weatherCode", 0)),
            "wind_speed_10m": first.get("windSpeed"),
            "wind_direction_10m": first.get("windDirection"),
            "wind_gusts_10m": first.get("windGust"),
            "surface_pressure": first.get("pressureSurfaceLevel"),
            "cloud_cover": first.get("cloudCover"),
            "uv_index": first.get("uvIndex"),
            "is_day": _compute_is_day(hourly_raw[0].get("time", ""), daily_raw),
        }

    # Hourly arrays
    hourly = {
        "time": [],
        "temperature_2m": [],
        "relative_humidity_2m": [],
        "apparent_temperature": [],
        "precipitation": [],
        "precipitation_probability": [],
        "weather_code": [],
        "wind_speed_10m": [],
        "wind_direction_10m": [],
        "wind_gusts_10m": [],
        "surface_pressure": [],
        "cloud_cover": [],
        "uv_index": [],
        "visibility": [],
        "is_day": [],
    }

    for h in hourly_raw[:24]:
        v = h.get("values", {})
        hourly["time"].append(h.get("time", ""))
        hourly["temperature_2m"].append(v.get("temperature"))
        hourly["relative_humidity_2m"].append(v.get("humidity"))
        hourly["apparent_temperature"].append(v.get("temperatureApparent"))
        hourly["precipitation"].append(v.get("precipitationIntensity", 0))
        hourly["precipitation_probability"].append(v.get("precipitationProbability", 0))
        hourly["weather_code"].append(_tomorrow_code_to_wmo(v.get("weatherCode", 0)))
        hourly["wind_speed_10m"].append(v.get("windSpeed"))
        hourly["wind_direction_10m"].append(v.get("windDirection"))
        hourly["wind_gusts_10m"].append(v.get("windGust"))
        hourly["surface_pressure"].append(v.get("pressureSurfaceLevel"))
        hourly["cloud_cover"].append(v.get("cloudCover"))
        hourly["uv_index"].append(v.get("uvIndex"))
        # Tomorrow.io reports visibility in km; the shared shape uses meters
        # (Open-Meteo convention).
        vis = v.get("visibility")
        hourly["visibility"].append(vis * 1000 if vis is not None else None)
        hourly["is_day"].append(_compute_is_day(h.get("time", ""), daily_raw))

    # Daily arrays
    daily = {
        "time": [],
        "weather_code": [],
        "temperature_2m_max": [],
        "temperature_2m_min": [],
        "apparent_temperature_max": [],
        "apparent_temperature_min": [],
        "precipitation_sum": [],
        "precipitation_probability_max": [],
        "wind_speed_10m_max": [],
        "wind_gusts_10m_max": [],
        "wind_direction_10m_dominant": [],
        "uv_index_max": [],
        "sunrise": [],
        "sunset": [],
    }

    # Extract insights from first daily
    insights = {}
    for d in daily_raw[:7]:
        v = d.get("values", {})
        daily["time"].append(d.get("time", ""))
        daily["weather_code"].append(_tomorrow_code_to_wmo(v.get("weatherCodeMax", 0)))
        daily["temperature_2m_max"].append(v.get("temperatureMax"))
        daily["temperature_2m_min"].append(v.get("temperatureMin"))
        daily["apparent_temperature_max"].append(v.get("temperatureApparentMax"))
        daily["apparent_temperature_min"].append(v.get("temperatureApparentMin"))
        daily["precipitation_sum"].append(v.get("precipitationIntensityMax", 0))
        daily["precipitation_probability_max"].append(v.get("precipitationProbabilityMax", 0))
        daily["wind_speed_10m_max"].append(v.get("windSpeedMax"))
        daily["wind_gusts_10m_max"].append(v.get("windGustMax"))
        daily["wind_direction_10m_dominant"].append(v.get("windDirectionAvg"))
        daily["uv_index_max"].append(v.get("uvIndexMax"))
        daily["sunrise"].append(v.get("sunriseTime", ""))
        daily["sunset"].append(v.get("sunsetTime", ""))

    if daily_raw:
        v0 = daily_raw[0].get("values", {})
        insights = {
            "heatStressIndex": v0.get("heatIndexMax"),
            "thunderstormProbability": v0.get("thunderstormProbability"),
            "uvHealthConcern": v0.get("uvHealthConcernMax"),
            "visibility": v0.get("visibilityAvg"),
            "windSpeed": v0.get("windSpeedMax"),
            "windGust": v0.get("windGustMax"),
            "dewPoint": v0.get("dewPointAvg"),
            "gdd10To30": v0.get("gdd10To30"),
            "evapotranspiration": v0.get("evapotranspirationAvg"),
            "moonPhase": v0.get("moonPhase"),
            "cloudBase": v0.get("cloudBaseAvg"),
            "cloudCeiling": v0.get("cloudCeilingAvg"),
            "precipitationType": v0.get("precipitationTypeMax"),
        }
        # Remove None values
        insights = {k: v for k, v in insights.items() if v is not None}

    return {
        "current": current,
        "hourly": hourly,
        "daily": daily,
        "current_units": dict(_CURRENT_UNITS),
        "insights": insights if insights else None,
    }


def _tomorrow_code_to_wmo(code: int) -> int:
    """Map Tomorrow.io weather codes to WMO 4677 codes.

    The SINGLE canonical mapping (issue #101) — a diverging TypeScript copy
    (e.g. 4200 "Light Rain" mapped to 63/moderate there vs 61/slight here)
    meant a location's condition/icon depended on which writer last populated
    the cache. Values follow Tomorrow.io's documented labels: 4001 "Rain" →
    63 (moderate), 4200 "Light Rain" → 61 (slight), 5000 "Snow" → 73
    (moderate), 5100 "Light Snow" → 71 (slight), ice pellets → 77.
    """
    mapping = {
        1000: 0,   # Clear, Sunny → Clear sky
        1100: 1,   # Mostly Clear → Mainly clear
        1101: 2,   # Partly Cloudy → Partly cloudy
        1102: 3,   # Mostly Cloudy → Overcast
        1001: 3,   # Cloudy → Overcast
        2000: 45,  # Fog → Fog
        2100: 45,  # Light Fog → Fog
        4000: 51,  # Drizzle → Light drizzle
        4001: 63,  # Rain → Moderate rain
        4200: 61,  # Light Rain → Slight rain
        4201: 65,  # Heavy Rain → Heavy rain
        5000: 73,  # Snow → Moderate snow
        5001: 71,  # Flurries → Slight snow
        5100: 71,  # Light Snow → Slight snow
        5101: 75,  # Heavy Snow → Heavy snow
        6000: 66,  # Freezing Drizzle → Light freezing rain
        6001: 67,  # Freezing Rain → Heavy freezing rain
        6200: 66,  # Light Freezing Rain → Light freezing rain
        6201: 67,  # Heavy Freezing Rain → Heavy freezing rain
        7000: 77,  # Ice Pellets → Snow grains
        7101: 77,  # Heavy Ice Pellets → Snow grains
        7102: 77,  # Light Ice Pellets → Snow grains
        8000: 95,  # Thunderstorm → Thunderstorm
    }
    return mapping.get(code, 0)


# ---------------------------------------------------------------------------
# Open-Meteo multi-model + minutely nowcast (Windy-style)
# ---------------------------------------------------------------------------

# Default comparison models — the blend's core members (issue #246). Open-Meteo
# returns model-suffixed hourly fields (e.g. `temperature_2m_ecmwf_ifs`) when
# `models` lists several, falling back to unsuffixed keys for a single model.
DEFAULT_FORECAST_MODELS = [blend.ECMWF_IFS, blend.ECMWF_AIFS, blend.GFS, blend.ICON]

# Allowlist of models we forward to Open-Meteo — guards against a caller
# injecting arbitrary strings into the upstream request via `?models=`. Every
# id was checked live against Open-Meteo on 2026-10-10. `ecmwf_ifs04` is dead
# upstream and is accepted only as an alias (see `blend.MODEL_ALIASES`).
KNOWN_FORECAST_MODELS = {
    "best_match",
    blend.ECMWF_IFS,
    blend.ECMWF_IFS025,
    blend.ECMWF_AIFS,
    blend.GFS,
    blend.ICON,
    "icon_seamless",
    blend.GEM,
    blend.ARPEGE,
    "meteofrance_seamless",
}


def _canonical_model(m: str | None) -> str:
    m = (m or "").strip()
    return blend.MODEL_ALIASES.get(m, m)


def _sanitize_models(models: list[str] | None) -> list[str]:
    """Filter a requested model list down to the known allowlist.

    Legacy ids are mapped through :data:`blend.MODEL_ALIASES`. Falls back to
    :data:`DEFAULT_FORECAST_MODELS` when nothing valid is given. ``best_match``
    is dropped from the upstream comparison request (it is the unsuffixed
    baseline Open-Meteo always returns).
    """
    cleaned: list[str] = []
    for m in models or []:
        m = _canonical_model(m)
        if m in KNOWN_FORECAST_MODELS and m != "best_match" and m not in cleaned:
            cleaned.append(m)
    return cleaned or list(DEFAULT_FORECAST_MODELS)


def _sanitize_baseline_model(model: str | None) -> str | None:
    """The user's single-model baseline choice, or ``None`` for the blend.

    ``best_match`` (the stored default preference) and anything unknown mean
    the Africa-weighted blend.
    """
    m = _canonical_model(model)
    if not m or m == "best_match" or m not in KNOWN_FORECAST_MODELS:
        return None
    return m


def _utc_offset(data: dict) -> int | None:
    """Location's UTC offset in whole seconds, as Open-Meteo reports it.

    Open-Meteo returns ``utc_offset_seconds`` for ``timezone=auto`` requests.
    Returns ``None`` when absent or not numeric so the caller can omit it.
    """
    value = data.get("utc_offset_seconds")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(value)


def _estimate_utc_offset(lon: float) -> int:
    """Solar-meridian UTC offset estimate (15° per hour, quarter-hour steps).

    Last resort only — used when no provider supplied ``utc_offset_seconds``
    (Tomorrow.io carries none, the seasonal fallback has no provider at all,
    and the keyless Open-Meteo extras call may also have failed). Mirrors
    ``longitudeOffsetSeconds`` in ``src/lib/location-time.ts``.
    """
    try:
        lon_f = float(lon)
    except (TypeError, ValueError):
        return 0
    if lon_f != lon_f or lon_f in (float("inf"), float("-inf")):
        return 0
    return int(round(lon_f / 15 * 4)) * 900


def _ensure_utc_offset(data: dict, lon: float) -> dict:
    """Guarantee ``utc_offset_seconds`` on a weather payload.

    Every consumer reads "the current hour" and hour labels in the LOCATION's
    time zone (anyone, anywhere in the world can open any place), so the
    offset must always be present. A provider value wins; otherwise a
    longitude estimate is stamped with ``utc_offset_estimated: True``.
    Returns a shallow copy when it has to add the field, so a cached object
    is never mutated.
    """
    if _utc_offset(data) is not None:
        return data
    out = dict(data)
    out["utc_offset_seconds"] = _estimate_utc_offset(lon)
    out["utc_offset_estimated"] = True
    return out


def _parse_minutely(data: dict) -> dict | None:
    """Extract the next-hour precipitation nowcast from an Open-Meteo payload.

    Returns ``{"time": [...], "precipitation": [...]}`` (next 60 min in 15-min
    steps) or ``None`` when no minutely data is present.
    """
    minutely = data.get("minutely_15") or {}
    times = minutely.get("time") or []
    precip = minutely.get("precipitation") or []
    if not times:
        return None
    return {
        "time": list(times[:4]),
        "precipitation": [p if p is not None else 0 for p in precip[:4]],
    }


def _parse_models(data: dict, models: list[str]) -> tuple[list[dict], list[str]]:
    """Build per-model hourly temperature/precip series from Open-Meteo hourly.

    Open-Meteo returns model-suffixed hourly keys (``temperature_2m_gfs_seamless``)
    when ``models`` is requested, falling back to the unsuffixed ``temperature_2m``
    (best_match) key. A model is considered available when it has at least one
    non-null temperature reading.
    """
    hourly = data.get("hourly") or {}
    base_temp = hourly.get("temperature_2m") or []
    base_precip = hourly.get("precipitation") or []

    series: list[dict] = []
    available: list[str] = []
    for model in models:
        temp = hourly.get(f"temperature_2m_{model}")
        precip = hourly.get(f"precipitation_{model}")
        if temp is None:
            temp = base_temp
        if precip is None:
            precip = base_precip
        if any(v is not None for v in temp):
            series.append({
                "model": model,
                "temperature_2m": list(temp[:24]),
                "precipitation": list((precip or [])[:24]),
            })
            available.append(model)
    return series, available


def _fetch_open_meteo_extras(lat: float, lon: float, models: list[str] | None = None) -> dict | None:
    """Fetch the ADDITIONAL Windy-style data from Open-Meteo (free, keyless).

    Returns a dict with ``minutely`` (next-hour 15-min precip nowcast),
    ``models`` (per-model hourly temperature/precip series), ``models_available``
    and ``models_time`` (the shared Open-Meteo hourly time axis). Best-effort —
    returns ``None`` on any failure so the caller degrades gracefully.
    """
    resolved_models = _sanitize_models(models)
    client = _get_http_client()

    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": str(lat),
        "longitude": str(lon),
        "hourly": "temperature_2m,precipitation",
        "models": ",".join(resolved_models),
        "minutely_15": "precipitation",
        "forecast_minutely_15": "4",
        "timezone": "auto",
        "forecast_days": "2",
    }

    resp = client.get(url, params=params)
    if resp.status_code != 200:
        return None

    data = resp.json()
    minutely = _parse_minutely(data)
    series, available = _parse_models(data, resolved_models)
    hourly = data.get("hourly") or {}

    result = {
        "minutely": minutely,
        "models": series,
        "models_available": available,
        "models_time": list((hourly.get("time") or [])[:24]),
    }
    if (offset := _utc_offset(data)) is not None:
        result["utc_offset_seconds"] = offset
    return result


def _finalize_baseline(payload: dict) -> dict:
    """Derive insights from a baseline payload, then strip intermediate fields.

    The intermediate fields (CAPE, lifted index, dew point, ET₀) exist only to
    derive insights; removing them keeps the cached WeatherData shape exactly
    what the UI and history writer have always seen (issue #101).
    """
    out = dict(payload)
    if not out.get("current_units"):
        out["current_units"] = dict(_CURRENT_UNITS)
    out["insights"] = derive_insights(payload) or None
    return strip_intermediate(out)


def _open_meteo_forecast(lat: float, lon: float, models: list[str] | None) -> dict | None:
    """One Open-Meteo forecast call. ``None`` on a non-200."""
    client = _get_http_client()
    params = {
        "latitude": str(lat),
        "longitude": str(lon),
        "current": blend.CURRENT_VARS,
        "hourly": blend.HOURLY_VARS,
        "daily": blend.DAILY_VARS,
        "minutely_15": "precipitation",
        "forecast_minutely_15": "4",
        "timezone": "auto",
        "forecast_days": "7",
    }
    if models:
        params["models"] = ",".join(models)
    resp = client.get("https://api.open-meteo.com/v1/forecast", params=params)
    if resp.status_code != 200:
        return None
    return resp.json()


def _fetch_blend(
    lat: float,
    lon: float,
    region: str,
    weights: dict[str, float],
    comparison: list[str] | None = None,
) -> tuple[dict, dict, dict[str, float]] | None:
    """Fetch every blend member in ONE call and blend them.

    Returns ``(payload, raw, weights_used)`` — ``payload`` is the canonical
    WeatherData (insights derived, intermediates stripped) already carrying
    the comparison series + minutely nowcast from the same response, so the
    old separate per-request "extras" call is no longer needed. ``None`` when
    the call fails or fewer than two members returned data.
    """
    members = blend.order_members(weights)
    extra = [m for m in (comparison or []) if m not in members]
    raw = _open_meteo_forecast(lat, lon, members + extra)
    if not raw:
        return None

    # Members that came back empty (e.g. an upstream outage of one model)
    # drop out and the remaining weights renormalise.
    present = blend.members_with_data(raw, members)
    if len(present) < 2:
        return None
    used = {m: weights[m] for m in present}
    payload = blend.blend_payload(raw, used)
    payload = _finalize_baseline(payload)

    series_models = present + [m for m in extra if m in blend.members_with_data(raw, extra)]
    series, available = _parse_models(raw, series_models)
    payload["minutely"] = blend.parse_minutely_any(raw, members)
    payload["models"] = series
    payload["models_available"] = available
    payload["models_time"] = list(((raw.get("hourly") or {}).get("time") or [])[:24])
    return payload, raw, used


def _fetch_single_model(lat: float, lon: float, model: str) -> dict | None:
    """Baseline from ONE user-selected model, nulls filled from best_match.

    Requests ``models=<model>,best_match`` in one call; the selected model
    gets all the weight and best_match only fills variables the model does not
    publish (e.g. ECMWF has no UV index).
    """
    raw = _open_meteo_forecast(lat, lon, [model, "best_match"])
    if not raw or not blend.members_with_data(raw, [model]):
        return None
    payload = blend.blend_payload(raw, {model: 1.0})
    filler = blend.blend_payload(raw, {"best_match": 1.0})
    for section in ("hourly", "daily"):
        base = payload.get(section) or {}
        fill = filler.get(section) or {}
        for var, arr in base.items():
            other = fill.get(var) or []
            payload[section][var] = [
                v if v is not None or i >= len(other) else other[i] for i, v in enumerate(arr)
            ]
    hourly = payload.get("hourly") or {}
    idx = current_hour_index(hourly, payload["current"].get("time"))
    for var, value in list(payload["current"].items()):
        arr = hourly.get(var) or []
        if value is None and idx < len(arr):
            payload["current"][var] = arr[idx]
    payload = _finalize_baseline(payload)
    payload["minutely"] = blend.parse_minutely_any(raw, [model, "best_match"])
    return payload


def _fetch_open_meteo(lat: float, lon: float) -> dict | None:
    """Open-Meteo ``best_match`` — the alternate single-request baseline.

    Used when the blend fails (too few members / upstream error). Requests
    current ``uv_index,is_day`` and hourly ``visibility,is_day`` (plus the
    intermediate insight fields) and returns the canonical shape.
    """
    data = _open_meteo_forecast(lat, lon, None)
    if not data:
        return None

    result = {
        "current": {k: v for k, v in (data.get("current") or {}).items() if k != "interval"},
        "hourly": data.get("hourly", {}),
        "daily": data.get("daily", {}),
        "current_units": data.get("current_units", dict(_CURRENT_UNITS)),
    }
    result = _finalize_baseline(result)
    result["minutely"] = _parse_minutely(data)
    if (offset := _utc_offset(data)) is not None:
        result["utc_offset_seconds"] = offset
    return result


def _create_fallback_weather(lat: float, lon: float, elevation: int) -> dict:
    """Generate seasonal estimate data when all providers fail.

    Uses hemisphere-aware seasonal estimates instead of country-specific ones.
    """
    month = datetime.now(timezone.utc).month
    southern = lat < 0

    # Hemisphere-aware seasonal estimates
    if southern:
        if month in (12, 1, 2):  # Summer
            temp, code = 28, 2
        elif month in (3, 4, 5):  # Autumn
            temp, code = 22, 2
        elif month in (6, 7, 8):  # Winter
            temp, code = 18, 0
        else:  # Spring
            temp, code = 25, 2
    else:
        if month in (3, 4, 5):  # Spring
            temp, code = 18, 2
        elif month in (6, 7, 8):  # Summer
            temp, code = 28, 2
        elif month in (9, 10, 11):  # Autumn
            temp, code = 15, 2
        else:  # Winter
            temp, code = 5, 0

    # Tropical adjustment: locations within ±10° of equator have minimal seasonal
    # variation. Uses code=2 (partly cloudy) year-round — a known simplification
    # that doesn't distinguish wet/dry or monsoon seasons (e.g., Lagos, Colombo).
    # This only fires as a last resort when all weather providers fail.
    if abs(lat) < 10:
        temp = 28
        code = 2

    # Adjust for elevation
    elevation_adj = max(0, (elevation - 1000)) * 0.006
    temp = round(temp - elevation_adj, 1)

    # No provider answered, so estimate the location's UTC offset from
    # longitude. Times stay zoned instants (``+00:00``, unambiguous); day/night
    # and the calendar dates are read on the LOCATION's wall clock, never the
    # server's UTC.
    offset = _estimate_utc_offset(lon)
    now_dt = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    now = now_dt.isoformat()
    times = [(now_dt + timedelta(hours=i)).isoformat() for i in range(24)]
    local_now = now_dt + timedelta(seconds=offset)
    daily_times = [(local_now + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(7)]

    def _local_hour(i: int) -> int:
        return (local_now + timedelta(hours=i)).hour

    return {
        "current": {
            "time": now,
            "temperature_2m": temp,
            "relative_humidity_2m": 60,
            "apparent_temperature": temp - 1,
            "precipitation": 0,
            "weather_code": code,
            "wind_speed_10m": 8,
            "wind_direction_10m": 180,
            "wind_gusts_10m": 15,
            "surface_pressure": 1013,
            "cloud_cover": 30,
            "uv_index": 5,
            "is_day": 1 if 6 <= local_now.hour < 18 else 0,
        },
        "hourly": {
            "time": times,
            "temperature_2m": [temp] * 24,
            "relative_humidity_2m": [60] * 24,
            "apparent_temperature": [temp - 1] * 24,
            "precipitation": [0] * 24,
            "weather_code": [code] * 24,
            "wind_speed_10m": [8] * 24,
            "wind_direction_10m": [180] * 24,
            "wind_gusts_10m": [15] * 24,
            "surface_pressure": [1013] * 24,
            "cloud_cover": [30] * 24,
            "uv_index": [5] * 24,
            "is_day": [1 if 6 <= _local_hour(i) < 18 else 0 for i in range(24)],
        },
        "daily": {
            "time": daily_times,
            "weather_code": [code] * 7,
            "temperature_2m_max": [temp + 5] * 7,
            "temperature_2m_min": [temp - 8] * 7,
            "apparent_temperature_max": [temp + 4] * 7,
            "apparent_temperature_min": [temp - 9] * 7,
            "precipitation_sum": [0] * 7,
            "precipitation_probability_max": [0] * 7,
            "wind_speed_10m_max": [15] * 7,
            "wind_gusts_10m_max": [25] * 7,
            "wind_direction_10m_dominant": [180] * 7,
            "uv_index_max": [7] * 7,
            # Naive local wall-clock strings, same shape as Open-Meteo's.
            "sunrise": [f"{d}T06:00" for d in daily_times],
            "sunset": [f"{d}T18:00" for d in daily_times],
        },
        "current_units": dict(_CURRENT_UNITS),
        "insights": None,
        "utc_offset_seconds": offset,
        "utc_offset_estimated": True,
    }


# ---------------------------------------------------------------------------
# Nyuchi StationKit — ground-truth observation reader (priority 0)
# ---------------------------------------------------------------------------


def nearest_station_observation(
    lat: float,
    lon: float,
    max_distance_km: float = STATION_MAX_DISTANCE_KM,
    max_age_minutes: int = STATION_MAX_AGE_MINUTES,
) -> dict | None:
    """
    Find the most recent QC-validated observation from any active StationKit
    station within ``max_distance_km`` of (lat, lon), no older than
    ``max_age_minutes``.

    Returns ``None`` when no station matches or the underlying geospatial
    query fails (e.g. missing 2dsphere index) — the caller falls through to
    the commercial-API chain.

    Uses MongoDB ``$nearSphere`` on ``observations.location`` (a 2dsphere
    GeoJSON Point), filters by ``qcStatus == "validated"`` and a recent
    ``observedAt``, and returns the freshest match.
    """
    try:
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=max_age_minutes)
        max_distance_m = float(max_distance_km) * 1000.0
        query = {
            "location": {
                "$nearSphere": {
                    "$geometry": {
                        "type": "Point",
                        "coordinates": [lon, lat],
                    },
                    "$maxDistance": max_distance_m,
                }
            },
            "qcStatus": "validated",
            "observedAt": {"$gte": cutoff},
        }
        cursor = (
            observations_collection()
            .find(query)
            .sort([("observedAt", -1)])
            .limit(1)
        )
        docs = list(cursor)
        return docs[0] if docs else None
    except Exception as e:
        # 2dsphere index missing or any other DB error — fall through gracefully.
        try:
            print(f"[stationkit] nearest_station_observation failed: {e}")
        except Exception:
            pass
        return None


def station_observation_to_current(obs: dict) -> dict:
    """
    Map a platform ``weather.observations`` document to the ``current``
    block shape used by the rest of mukoko (Tomorrow.io / Open-Meteo style:
    ``temperature_2m``, ``relative_humidity_2m``, etc.).

    Only fields the station provides are populated — others are left out so
    the UI shows "no data" rather than a fabricated zero. The platform field
    names live under ``metrics`` (see ``docs/mongodb-schema-map.md``).
    """
    metrics = obs.get("metrics") or {}
    observed_at = obs.get("observedAt")
    if isinstance(observed_at, datetime):
        time_str = observed_at.isoformat()
    elif observed_at is None:
        time_str = datetime.now(timezone.utc).isoformat()
    else:
        time_str = str(observed_at)

    current: dict = {
        "time": time_str,
        "temperature_2m": metrics.get("airTemperatureCelsius"),
        "relative_humidity_2m": metrics.get("relativeHumidityPercent"),
        "surface_pressure": metrics.get("atmosphericPressureMillibar"),
        "wind_speed_10m": metrics.get("windSpeedKph"),
        "wind_direction_10m": metrics.get("windDirectionDegrees"),
        "precipitation": metrics.get("precipitationMillimeters"),
        "uv_index": metrics.get("uvIndex"),
    }
    return current


# ---------------------------------------------------------------------------
# Cache operations
# ---------------------------------------------------------------------------


def _get_cached_weather(slug: str) -> dict | None:
    """Get cached weather from MongoDB."""
    doc = weather_cache_collection().find_one(
        {"locationSlug": slug, "expiresAt": {"$gt": datetime.now(timezone.utc)}},
        {"_id": 0, "data": 1, "provider": 1},
    )
    if doc:
        return doc
    return None


def _set_cached_weather(slug: str, lat: float, lon: float, data: dict, provider: str):
    """Store weather in MongoDB cache with 15-min TTL."""
    now = datetime.now(timezone.utc)
    weather_cache_collection().update_one(
        {"locationSlug": slug},
        {
            "$set": {
                "data": data,
                "provider": provider,
                "lat": lat,
                "lon": lon,
                "fetchedAt": now,
                "expiresAt": now + timedelta(seconds=WEATHER_CACHE_TTL),
            },
        },
        upsert=True,
    )


def _record_weather_history(slug: str, data: dict):
    """Record weather data point in history collection."""
    from ._db import get_db

    current = data.get("current", {})
    daily = data.get("daily", {})

    record = {
        "locationSlug": slug,
        "recordedAt": datetime.now(timezone.utc),
        "current": current,
    }

    # Add first day of daily forecast
    if daily and daily.get("time"):
        record["daily"] = {
            "date": daily["time"][0] if daily["time"] else None,
            "weatherCode": daily.get("weather_code", [None])[0],
            "tempMax": daily.get("temperature_2m_max", [None])[0],
            "tempMin": daily.get("temperature_2m_min", [None])[0],
            "apparentTempMax": daily.get("apparent_temperature_max", [None])[0],
            "apparentTempMin": daily.get("apparent_temperature_min", [None])[0],
            "precipSum": daily.get("precipitation_sum", [None])[0],
            "precipProbMax": daily.get("precipitation_probability_max", [None])[0],
            "windSpeedMax": daily.get("wind_speed_10m_max", [None])[0],
            "windGustMax": daily.get("wind_gusts_10m_max", [None])[0],
            "windDirDominant": daily.get("wind_direction_10m_dominant", [None])[0],
            "uvIndexMax": daily.get("uv_index_max", [None])[0],
            "sunrise": daily.get("sunrise", [None])[0],
            "sunset": daily.get("sunset", [None])[0],
        }

    if data.get("insights"):
        record["insights"] = data["insights"]

    get_db()["weather_history"].insert_one(record)


def _find_nearest_location(lat: float, lon: float) -> dict | None:
    """Find the nearest location via places.placesGeo (Phase 0G).

    Delegates to :func:`api.py._places_resolver.find_nearest_location` which
    uses ``$nearSphere`` on the platform 2dsphere index. Returns the adapted
    legacy LocationDoc shape so the caller's existing ``slug`` / ``elevation``
    field reads keep working.
    """
    try:
        # Wide radius — this fn is used for cache-key derivation, so we want a
        # best-effort match anywhere on the globe rather than a tight 50 km cap.
        return find_nearest_location(lat, lon, max_km=20_000)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


def _is_priority(request: Request | None, slug: str, is_coordinate_key: bool) -> bool:
    """Whether this request may use the reserved Tomorrow.io budget.

    Priority = curated seed / high-traffic locations (legacy catalog slugs —
    community "smart" slugs contain ``--``) or a caller marked as paying via
    ``X-Mukoko-Priority: 1``. The header is only honoured when
    ``MUKOKO_INTERNAL_SECRET`` is configured AND the request carries it, so
    an anonymous direct caller cannot claim priority. (No paid plan exists
    yet — P0-1 in #238 — so the header is a hook.)
    """
    if request is not None and request.headers.get("x-mukoko-priority") == "1":
        import os

        secret = os.environ.get("MUKOKO_INTERNAL_SECRET", "")
        if secret:
            import hmac

            if hmac.compare_digest(request.headers.get("x-mukoko-internal") or "", secret):
                return True
    return not is_coordinate_key and "--" not in slug


def _attach_comparison(data: dict, lat: float, lon: float, requested: list[str] | None) -> dict:
    """Make sure every requested comparison model has a series.

    The blended baseline already carries its members' series. Only when the
    caller asks for a model that is not there (or the baseline came from a
    path without series) is the keyless extras call made — best-effort,
    circuit-breaker gated, never fails the response.
    """
    wanted = _sanitize_models(requested) if requested else None
    have = set(data.get("models_available") or [])
    if data.get("models") and (wanted is None or set(wanted) <= have):
        if wanted:
            data = dict(data)
            data["models"] = [s for s in data["models"] if s.get("model") in wanted]
            data["models_available"] = [m for m in data["models_available"] if m in wanted]
        return data
    if not open_meteo_breaker.is_allowed:
        return data
    try:
        extras = _fetch_open_meteo_extras(lat, lon, requested)
    except Exception:
        # Multi-model/minutely is a non-critical enhancement.
        return data
    if not extras:
        return data
    data = dict(data)
    if data.get("minutely") is None:
        data["minutely"] = extras.get("minutely")
    data["models"] = extras.get("models", [])
    data["models_available"] = extras.get("models_available", [])
    data["models_time"] = extras.get("models_time", [])
    # The seasonal fallback carries no UTC offset; the keyless extras call
    # resolves it for the same point.
    if data.get("utc_offset_seconds") is None and extras.get("utc_offset_seconds") is not None:
        data["utc_offset_seconds"] = extras["utc_offset_seconds"]
    return data


@router.get("/api/py/weather")
async def get_weather(
    lat: float = -17.83,
    lon: float = 31.05,
    models: str | None = None,
    model: str | None = None,
    request: Request = None,  # type: ignore[assignment]  # injected by FastAPI
):
    """
    GET /api/py/weather?lat=-17.83&lon=31.05[&model=ecmwf_ifs][&models=gfs_seamless,icon_global]

    Provider chain (issue #246 — global models are the baseline, Tomorrow.io
    only enriches):

    * **Priority 0** — Nyuchi StationKit observation (within 50 km, last 60 min),
      overlaid onto the ``current`` block only.
    * **1** — MongoDB cache (15-min TTL; one row per location, plus one per
      location × user-selected model).
    * **2** — Open-Meteo **Africa-weighted blend** (ECMWF IFS + AIFS heaviest,
      then GFS, ICON, GEM, ARPEGE — weights per region in ``_model_blend``),
      or the single model named by ``?model=`` (the user's
      ``selectedForecastModel``; ``best_match`` means the blend).
    * **3** — Open-Meteo ``best_match`` (alternate single request).
    * **4** — Seasonal estimate (never fails).

    Insights are always derived from the baseline (``_insights``); Tomorrow.io
    enrichment is merged on top when the quota budget allows and it answers
    in time — it never blocks or replaces the baseline.

    ``?models=`` picks the comparison series (``models`` / ``models_available``
    / ``models_time``); the blend members are returned by default.

    Response headers:
      * ``X-Cache`` — ``HIT`` | ``MISS``
      * ``X-Weather-Provider`` — the baseline: ``open-meteo:blend`` |
        ``open-meteo:<model>`` | ``open-meteo:best_match`` | ``fallback``
      * ``X-Weather-Blend`` — region + normalised weights (blend only)
      * ``X-Enrichment`` — ``tomorrow`` | ``skipped-budget`` |
        ``skipped-error`` | ``none``
      * ``X-Current-Source`` — origin of the ``current`` block
        (``stationkit`` | the baseline provider | ``fallback``)
    """
    if lat < -90 or lat > 90 or lon < -180 or lon > 180:
        raise HTTPException(status_code=400, detail="Invalid coordinates")

    requested_models = [m for m in (models or "").split(",") if m.strip()] or None
    baseline_model = _sanitize_baseline_model(model)

    # Resolve to nearest known location for cache key
    location_slug = f"{lat:.2f}_{lon:.2f}"
    is_coordinate_key = True
    elevation = 1200
    try:
        nearest = _find_nearest_location(lat, lon)
        if nearest and nearest.get("slug"):
            location_slug = nearest["slug"]
            is_coordinate_key = False
            elevation = nearest.get("elevation", elevation)
    except Exception:
        pass
    cache_key = location_slug if baseline_model is None else f"{location_slug}::{baseline_model}"

    # 0. Look for a nearby StationKit observation. Cheap (single MongoDB query)
    # and graceful — returns None on any error.
    station_current: dict | None = None
    station_obs = nearest_station_observation(lat, lon)
    if station_obs:
        try:
            station_current = station_observation_to_current(station_obs)
        except Exception:
            station_current = None

    region = blend.region_for(lat, lon)
    blend_header: str | None = None

    # 1. Try cache
    data: dict | None = None
    source: str | None = None
    cache_status = "MISS"
    try:
        cached = _get_cached_weather(cache_key)
        if cached:
            data = cached.get("data", {})
            source = cached.get("provider", "cache")
            cache_status = "HIT"
            # Rows written before derived insights existed get them now
            # (cached values win where both exist).
            if data.get("current"):
                data = dict(data)
                data["insights"] = {**derive_insights(data), **(data.get("insights") or {})}
    except Exception:
        pass

    # 2-4. Fetch fresh forecast data if no cache hit
    if data is None:
        raw_for_verification: tuple | None = None

        # 2. Global-model baseline (circuit breaker protected)
        if open_meteo_breaker.is_allowed:
            try:
                if baseline_model:
                    data = _fetch_single_model(lat, lon, baseline_model)
                    if data:
                        source = f"open-meteo:{baseline_model}"
                else:
                    weights = blend.weights_for(region)
                    result = _fetch_blend(lat, lon, region, weights, _sanitize_models(requested_models) if requested_models else None)
                    if result:
                        data, raw, used = result
                        source = "open-meteo:blend"
                        blend_header = blend.format_weights(region, used)
                        raw_for_verification = (raw, used)
                if data:
                    open_meteo_breaker.record_success()
                else:
                    open_meteo_breaker.record_failure()
            except Exception:
                data = None
                open_meteo_breaker.record_failure()

        # 3. Alternate: Open-Meteo best_match in a single request
        if not data and open_meteo_breaker.is_allowed:
            try:
                data = _fetch_open_meteo(lat, lon)
                if data:
                    source = "open-meteo:best_match"
                    open_meteo_breaker.record_success()
                else:
                    open_meteo_breaker.record_failure()
            except Exception:
                open_meteo_breaker.record_failure()

        # 4. Seasonal fallback (never fails)
        if not data:
            data = _create_fallback_weather(lat, lon, elevation)
            source = "fallback"

        # Cache the baseline (skip the seasonal fallback so we keep retrying
        # upstream). This is the ONLY weather_cache writer (issue #101).
        if source and source != "fallback":
            try:
                _set_cached_weather(cache_key, lat, lon, data, source)
            except Exception:
                pass

        # Verification capture — default blend only, at most once per 6 h.
        if raw_for_verification:
            try:
                raw, used = raw_for_verification
                idx = current_hour_index(data.get("hourly") or {}, (data.get("current") or {}).get("time"))
                verification.capture(
                    verification.build_verification_doc(
                        location_slug, lat, lon, region, used, raw, data.get("hourly") or {}, idx
                    )
                )
            except Exception:
                pass

    # Tomorrow.io ENRICHMENT — insights only, budgeted, never blocking. Not
    # attempted for the seasonal fallback (nothing real to enrich).
    enrichment_status = enrichment.NONE
    if source != "fallback":
        try:
            extra, enrichment_status = enrichment.enrich(
                location_slug, lat, lon, priority=_is_priority(request, location_slug, is_coordinate_key)
            )
        except Exception:
            extra, enrichment_status = None, enrichment.SKIPPED_ERROR
        if extra:
            data = dict(data)
            data["insights"] = enrichment.merge_insights(data.get("insights"), extra)

    # History — recorded on fresh fetches of the default baseline only, so the
    # series is one consistent source (merged insights included).
    if cache_status == "MISS" and source and source != "fallback" and baseline_model is None:
        try:
            _record_weather_history(location_slug, data)
        except Exception:
            pass

    # Blend StationKit observation into the response: overlay the station's
    # sensor fields onto the forecast `current` (keeping forecast-only fields
    # like is_day/uv_index that the hardware doesn't measure), keep hourly/
    # daily from the model baseline. Shallow-copy first so we don't mutate
    # any cached object held by callers / the cache layer.
    current_source = source or "fallback"
    if station_current:
        data = dict(data) if data else {}
        data["current"] = {**(data.get("current") or {}), **station_current}
        current_source = "stationkit"

    # Comparison series + minutely nowcast (usually already in the blend).
    data = _attach_comparison(data or {}, lat, lon, requested_models)

    # The offset must ALWAYS be present — see _ensure_utc_offset.
    data = _ensure_utc_offset(data or {}, lon)

    headers = {
        "X-Cache": cache_status,
        "X-Weather-Provider": source or "fallback",
        "X-Enrichment": enrichment_status,
        "X-Current-Source": current_source,
    }
    if blend_header:
        headers["X-Weather-Blend"] = blend_header
    return JSONResponse(content=data, headers=headers)
