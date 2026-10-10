"""Coordinate-grid key for ``weather.weather_cache`` rows (issue #252).

The forecast cache is keyed by WHERE the forecast is for, not by which known
place happens to be nearest. Keying on the nearest place (searched up to
20,000 km) let Frankfurt's weather sit under Bizerte and Bangladesh's under a
Singapore record, so one city could be served another city's forecast.

Grid: 0.05 degrees (~5.6 km north-south; narrower east-west away from the
equator). A request is at most ~3.9 km from the centre of its cell, which is
finer than the forecast models behind the providers (Open-Meteo's global
models run at ~9-25 km, Tomorrow.io's at a few km), so two requests that
share a cell would get practically the same forecast anyway. It is still
coarse enough that a town's page slugs, GPS fixes and the client refresh all
share one provider fetch (Tomorrow.io free tier: 500 calls/day).

The key is built from integer cell indices, never from formatted floats, so
the TypeScript mirror (``src/lib/weather-cache-key.ts``) produces the same
string bit for bit. Both are pinned to ``tests/fixtures/weather-cache-keys.json``.
The ``cell:`` prefix keeps new keys disjoint from every legacy key (place
slugs and the old raw ``{lat:.2f}_{lon:.2f}`` fallback), so a legacy row can
never be read under a new key; legacy rows just expire through the TTL.
"""

from __future__ import annotations

import math

#: Grid size in degrees. Change it here AND in src/lib/weather-cache-key.ts.
GRID_DEG = 0.05
_CELLS_PER_DEG = 20  # 1 / GRID_DEG, kept integral so both languages agree
_LAT_MAX_IDX = 90 * _CELLS_PER_DEG
_LON_MAX_IDX = 180 * _CELLS_PER_DEG

KEY_PREFIX = "cell:"


def _cell_index(value: float) -> int:
    # floor(x + 0.5): round-half-up, identical to Math.floor in JS (Python's
    # round() is half-to-even and would disagree on exact ties).
    return math.floor(value * _CELLS_PER_DEG + 0.5)


def _fmt(idx: int) -> str:
    hundredths = idx * 5  # one cell = 0.05 degrees = 5 hundredths
    sign = "-" if hundredths < 0 else ""
    a = abs(hundredths)
    return f"{sign}{a // 100}.{a % 100:02d}"


def weather_cache_key(lat: float, lon: float) -> str:
    """Return the ``weather_cache.locationSlug`` value for a coordinate."""
    lat_idx = max(-_LAT_MAX_IDX, min(_LAT_MAX_IDX, _cell_index(float(lat))))
    lon_idx = _cell_index(float(lon))
    if lon_idx >= _LON_MAX_IDX:  # +180 and -180 are the same meridian
        lon_idx -= 2 * _LON_MAX_IDX
    elif lon_idx < -_LON_MAX_IDX:
        lon_idx += 2 * _LON_MAX_IDX
    return f"{KEY_PREFIX}{_fmt(lat_idx)}_{_fmt(lon_idx)}"


def weather_cache_key_for(loc: dict | None) -> str | None:
    """Cache key for a resolved location dict (``lat``/``lon``), or ``None``.

    For readers that start from a place slug (reports, chat, explore): resolve
    the place first, then read the row for ITS coordinates. Never look a row
    up by the place slug itself.
    """
    if not loc:
        return None
    try:
        return weather_cache_key(float(loc["lat"]), float(loc["lon"]))
    except (KeyError, TypeError, ValueError):
        return None
