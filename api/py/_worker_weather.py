"""
The Rust API Worker's weather, for the Python code that still wants a place's
current conditions (the Shamwari chat and the explore search tools).

They used to read ``weather.weather_cache``, whose only writer was
``/api/py/weather`` (deleted: the app and the Workers serve weather from
``GET /v1/weather`` and keep it in KV). So they ask the same Worker route the
app asks, with the same cache, and nothing here caches or writes.

The origin is ``NEXT_PUBLIC_WEATHER_API_URL`` when it is a bare https origin,
else the public default (the same rule as ``src/lib/weather-api.ts``).
"""

from __future__ import annotations

import os
from typing import Optional

from ._http import get_http_client

#: The public Worker origin (same default as ``src/lib/weather-api.ts``).
DEFAULT_WEATHER_API_URL = "https://weather-api.mukoko.com"

#: Upstream timeout for one weather read. The tools run inside a model turn, so
#: a slow Worker must not hold it long.
WEATHER_TIMEOUT_S = 4.0


def weather_api_base() -> str:
    """The Worker origin: ``NEXT_PUBLIC_WEATHER_API_URL`` when it is a bare
    https origin, else the public default."""
    raw = (os.environ.get("NEXT_PUBLIC_WEATHER_API_URL") or "").strip().rstrip("/")
    if raw.startswith("https://") and "?" not in raw and "#" not in raw and "@" not in raw:
        return raw
    return DEFAULT_WEATHER_API_URL


def fetch_weather(lat: object, lon: object) -> Optional[tuple[dict, str]]:
    """``(WeatherData, provider)`` for a point from the Worker's ``/v1/weather``,
    or ``None`` when the coordinate is unusable or the Worker has nothing.

    ``provider`` is the ``X-Weather-Provider`` header (``open-meteo:blend``,
    ``open-meteo:best_match``, ``fallback``, ...), ``"unknown"`` when absent.
    Synchronous (the callers already run in worker threads); raises on a
    transport error or a non-2xx answer, so each caller keeps its own
    fallback.
    """
    try:
        lat_f, lon_f = float(lat), float(lon)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if lat_f != lat_f or lon_f != lon_f:
        return None
    resp = get_http_client(WEATHER_TIMEOUT_S).get(
        f"{weather_api_base()}/v1/weather",
        params={"lat": f"{lat_f}", "lon": f"{lon_f}"},
    )
    resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, dict) or not isinstance(data.get("current"), dict):
        return None
    return data, resp.headers.get("X-Weather-Provider") or "unknown"
