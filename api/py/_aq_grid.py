"""
Grid maths for a regular n×n grid around a point.

The air quality grid route itself (``GET /api/py/airquality/grid``) now lives
in the Rust Workers (``GET /v1/air-quality/grid``, ``workers/forecast``,
``weather_core::aq_grid``). This module keeps only the geometry that
``_model_grid.py`` still shares; it goes with the model grid port (#333).
"""

from __future__ import annotations

import math

GRID_N_MIN = 5
GRID_N_MAX = 9

RADIUS_KM_MIN = 5.0
RADIUS_KM_MAX = 100.0

#: Spherical Earth (R = 6371 km): one degree of arc. Shared with the TS geometry
#: in src/lib/aq-grid.ts so a grid cell's metric side is identical on both ends.
_KM_PER_DEG = 111.195


# ---------------------------------------------------------------------------
# Grid maths (pure)
# ---------------------------------------------------------------------------


def normalise_n(n: int) -> int:
    """Clamp n to 5..9 and bump an even value up to the next odd (true centre)."""
    n = min(max(int(n), GRID_N_MIN), GRID_N_MAX)
    if n % 2 == 0:
        n += 1
    return n


def clamp_radius(radius_km: float) -> float:
    return min(max(float(radius_km), RADIUS_KM_MIN), RADIUS_KM_MAX)


def grid_cell_km(radius_km: float, n: int) -> float:
    """Spacing between adjacent grid points — also the side of each map cell."""
    return (2.0 * radius_km) / (n - 1)


def build_grid(
    lat: float,
    lon: float,
    radius_km: float,
    n: int,
    *,
    clamp: bool = True,
) -> list[tuple[float, float]]:
    """
    Return the n×n (lat, lon) grid, row-major from north-west to south-east.

    Offsets run linearly from -radius to +radius on both axes, so the centre
    point is exactly (lat, lon) and the outer points sit ``radius_km`` away
    (north/south via latitude, east/west via longitude corrected for the
    cosine of latitude so the spacing is metric in both directions).

    ``clamp=False`` lets a caller with its own radius bounds (the model grid)
    skip the AQ grid's 5–100 km clamp.
    """
    n = normalise_n(n)
    if clamp:
        radius_km = clamp_radius(radius_km)
    lat_rad = math.radians(max(-89.0, min(89.0, lat)))
    km_per_deg_lon = _KM_PER_DEG * math.cos(lat_rad)
    half = (n - 1) / 2.0
    step_km = radius_km / half if half else 0.0

    points: list[tuple[float, float]] = []
    for row in range(n):
        north_south_km = (half - row) * step_km  # + = north
        p_lat = lat + north_south_km / _KM_PER_DEG
        for col in range(n):
            east_west_km = (col - half) * step_km  # + = east
            p_lon = lon + east_west_km / km_per_deg_lon
            points.append((round(p_lat, 6), round(p_lon, 6)))
    return points
