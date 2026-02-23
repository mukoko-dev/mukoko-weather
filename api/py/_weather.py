"""
Weather proxy — migrated from /api/weather.

Fetches weather from Tomorrow.io (primary) or Open-Meteo (fallback),
caches in MongoDB with 15-min TTL, records history, and returns
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
    get_api_key,
    locations_collection,
    weather_cache_collection,
)
from ._circuit_breaker import tomorrow_breaker, open_meteo_breaker, CircuitOpenError

router = APIRouter()

# Module-level httpx client (reused across warm Vercel invocations)
_http_client: Optional[httpx.Client] = None

WEATHER_CACHE_TTL = 900  # 15 minutes


def _get_http_client() -> httpx.Client:
    global _http_client
    if _http_client is None:
        _http_client = httpx.Client(timeout=15.0)
    return _http_client


# ---------------------------------------------------------------------------
# Weather provider clients
# ---------------------------------------------------------------------------


def _fetch_tomorrow(lat: float, lon: float, api_key: str) -> dict | None:
    """Fetch weather from Tomorrow.io API."""
    client = _get_http_client()

    # Realtime + forecast in one call
    url = "https://api.tomorrow.io/v4/weather/forecast"
    params = {
        "location": f"{lat},{lon}",
        "apikey": api_key,
        "timesteps": "1h,1d",
        "units": "metric",
    }

    resp = client.get(url, params=params)

    if resp.status_code == 429:
        return None  # Rate limited — fall back to Open-Meteo

    if resp.status_code != 200:
        return None

    data = resp.json()
    return _normalize_tomorrow(data)


def _normalize_tomorrow(raw: dict) -> dict:
    """Normalize Tomorrow.io response to our WeatherData shape."""
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
        }

    # Hourly arrays
    hourly = {
        "time": [],
        "temperature_2m": [],
        "relative_humidity_2m": [],
        "apparent_temperature": [],
        "precipitation": [],
        "weather_code": [],
        "wind_speed_10m": [],
        "wind_direction_10m": [],
        "wind_gusts_10m": [],
        "surface_pressure": [],
        "cloud_cover": [],
        "uv_index": [],
    }

    for h in hourly_raw[:24]:
        v = h.get("values", {})
        hourly["time"].append(h.get("time", ""))
        hourly["temperature_2m"].append(v.get("temperature"))
        hourly["relative_humidity_2m"].append(v.get("humidity"))
        hourly["apparent_temperature"].append(v.get("temperatureApparent"))
        hourly["precipitation"].append(v.get("precipitationIntensity", 0))
        hourly["weather_code"].append(_tomorrow_code_to_wmo(v.get("weatherCode", 0)))
        hourly["wind_speed_10m"].append(v.get("windSpeed"))
        hourly["wind_direction_10m"].append(v.get("windDirection"))
        hourly["wind_gusts_10m"].append(v.get("windGust"))
        hourly["surface_pressure"].append(v.get("pressureSurfaceLevel"))
        hourly["cloud_cover"].append(v.get("cloudCover"))
        hourly["uv_index"].append(v.get("uvIndex"))

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
        "insights": insights if insights else None,
    }


def _tomorrow_code_to_wmo(code: int) -> int:
    """Map Tomorrow.io weather codes to WMO codes."""
    mapping = {
        0: 0, 1000: 0, 1100: 1, 1101: 2, 1102: 3,
        1001: 3, 2000: 45, 2100: 48, 4000: 51,
        4001: 61, 4200: 63, 4201: 65, 5000: 71,
        5001: 73, 5100: 75, 5101: 77, 6000: 56,
        6001: 66, 6200: 67, 6201: 67, 7000: 77,
        7101: 85, 7102: 86, 8000: 95,
    }
    return mapping.get(code, 0)


def _fetch_open_meteo(lat: float, lon: float) -> dict | None:
    """Fetch weather from Open-Meteo API (free fallback)."""
    client = _get_http_client()

    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": str(lat),
        "longitude": str(lon),
        "current": "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,surface_pressure,cloud_cover",
        "hourly": "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,surface_pressure,cloud_cover,uv_index",
        "daily": "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,sunrise,sunset,uv_index_max,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant",
        "timezone": "auto",
        "forecast_days": "7",
    }

    resp = client.get(url, params=params)
    if resp.status_code != 200:
        return None

    data = resp.json()

    # Synthesize basic insights from Open-Meteo current data
    current = data.get("current", {})
    insights = {}
    wind_speed = current.get("wind_speed_10m")
    if wind_speed is not None:
        insights["windSpeed"] = wind_speed
    wind_gust = current.get("wind_gusts_10m")
    if wind_gust is not None:
        insights["windGust"] = wind_gust

    result = {
        "current": current,
        "hourly": data.get("hourly", {}),
        "daily": data.get("daily", {}),
        "insights": insights if insights else None,
    }
    return result


def _create_fallback_weather(lat: float, lon: float, elevation: int) -> dict:
    """Generate seasonal estimate data when all providers fail."""
    month = datetime.now(timezone.utc).month

    # Zimbabwe seasonal estimates
    if month in (11, 12, 1, 2, 3):
        # Masika (rainy season)
        temp = 28
        code = 61
    elif month in (4, 5):
        # Munakamwe (post-rain)
        temp = 22
        code = 2
    elif month in (6, 7, 8):
        # Chirimo (dry/cold)
        temp = 18
        code = 0
    else:
        # Zhizha (hot/dry)
        temp = 32
        code = 0

    # Adjust for elevation
    elevation_adj = max(0, (elevation - 1000)) * 0.006
    temp = round(temp - elevation_adj, 1)

    now = datetime.now(timezone.utc).isoformat()
    times = [(datetime.now(timezone.utc) + timedelta(hours=i)).isoformat() for i in range(24)]
    daily_times = [(datetime.now(timezone.utc) + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(7)]

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
            "sunrise": ["06:00"] * 7,
            "sunset": ["18:00"] * 7,
        },
        "insights": None,
    }


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
    """Find the nearest location from MongoDB using 2dsphere index."""
    try:
        result = locations_collection().find_one(
            {
                "geo": {
                    "$near": {
                        "$geometry": {"type": "Point", "coordinates": [lon, lat]},
                    }
                }
            },
            {"_id": 0},
        )
        return result
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


@router.get("/api/py/weather")
async def get_weather(lat: float = -17.83, lon: float = 31.05):
    """
    GET /api/py/weather?lat=-17.83&lon=31.05

    Weather proxy with multi-provider fallback chain:
    1. MongoDB cache (15-min TTL)
    2. Tomorrow.io (primary, richer data)
    3. Open-Meteo (free fallback)
    4. Seasonal estimates (never fails)
    """
    if lat < -90 or lat > 90 or lon < -180 or lon > 180:
        raise HTTPException(status_code=400, detail="Invalid coordinates")

    # Resolve to nearest known location for cache key
    location_slug = f"{lat:.2f}_{lon:.2f}"
    elevation = 1200
    try:
        nearest = _find_nearest_location(lat, lon)
        if nearest:
            location_slug = nearest.get("slug", location_slug)
            elevation = nearest.get("elevation", elevation)
    except Exception:
        pass

    # 1. Try cache
    try:
        cached = _get_cached_weather(location_slug)
        if cached:
            return JSONResponse(
                content=cached.get("data", {}),
                headers={
                    "X-Cache": "HIT",
                    "X-Weather-Provider": cached.get("provider", "cache"),
                },
            )
    except Exception:
        pass

    # 2. Try Tomorrow.io (circuit breaker protected)
    data = None
    source = "open-meteo"

    if tomorrow_breaker.is_allowed:
        try:
            tomorrow_key = get_api_key("tomorrow")
            if tomorrow_key:
                data = _fetch_tomorrow(lat, lon, tomorrow_key)
                if data:
                    source = "tomorrow"
                    tomorrow_breaker.record_success()
                else:
                    tomorrow_breaker.record_failure()
        except Exception:
            tomorrow_breaker.record_failure()

    # 3. Try Open-Meteo (circuit breaker protected)
    if not data and open_meteo_breaker.is_allowed:
        try:
            data = _fetch_open_meteo(lat, lon)
            if data:
                source = "open-meteo"
                open_meteo_breaker.record_success()
            else:
                open_meteo_breaker.record_failure()
        except Exception:
            open_meteo_breaker.record_failure()

    # 4. Seasonal fallback
    if not data:
        data = _create_fallback_weather(lat, lon, elevation)
        source = "fallback"

    # Cache + record history (fire-and-forget)
    if source != "fallback":
        try:
            _set_cached_weather(location_slug, lat, lon, data, source)
            _record_weather_history(location_slug, data)
        except Exception:
            pass

    return JSONResponse(
        content=data,
        headers={
            "X-Cache": "MISS",
            "X-Weather-Provider": source,
        },
    )
