"""Coordinate-grid key (issue #252): a 0.05 degree cell, ``cell:-17.85_31.05``.

``weather.weather_cache`` is gone (its only writer was ``/api/py/weather``; the
forecast Worker caches in KV), so this is no longer a Mongo row key. What still
uses it is :mod:`_agriculture`, which keys its AI-text cache on the cell, so
text written for one place is never served to another. The twin is
``weather_core::geo::cell_key`` (the Worker keys history and the agriculture
data on it); both are pinned to ``tests/fixtures/weather-cache-keys.json``.

Keying on WHERE a forecast is for, not on the nearest known place (searched up
to 20,000 km), is what stops one city being served another's: Frankfurt's
weather used to sit under Bizerte and Bangladesh's under a Singapore record.

Grid: 0.05 degrees (~5.6 km north-south; narrower east-west away from the
equator). A request is at most ~3.9 km from the centre of its cell, finer than
the forecast models behind the providers (Open-Meteo's global models run at
~9-25 km), so two requests that share a cell get practically the same
forecast, yet a town's page slugs, GPS fixes and client refreshes all share
one key.

The key is built from integer cell indices, never from formatted floats, so
Python and Rust produce the same string bit for bit. The ``cell:`` prefix keeps
these keys disjoint from every legacy key (place slugs and the old raw
``{lat:.2f}_{lon:.2f}`` fallback).
"""

from __future__ import annotations

import math

#: Grid size in degrees. Change it here AND in workers/crates/weather-core/src/geo.rs.
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
    """Return the ``cell:`` key for a coordinate."""
    lat_idx = max(-_LAT_MAX_IDX, min(_LAT_MAX_IDX, _cell_index(float(lat))))
    lon_idx = _cell_index(float(lon))
    if lon_idx >= _LON_MAX_IDX:  # +180 and -180 are the same meridian
        lon_idx -= 2 * _LON_MAX_IDX
    elif lon_idx < -_LON_MAX_IDX:
        lon_idx += 2 * _LON_MAX_IDX
    return f"{KEY_PREFIX}{_fmt(lat_idx)}_{_fmt(lon_idx)}"
