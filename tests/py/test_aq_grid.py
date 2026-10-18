"""Grid maths shared with the model grid. The air quality grid route is
tested in Rust (``weather_core::aq_grid``)."""

from __future__ import annotations

import math

import pytest

from py._aq_grid import build_grid, grid_cell_km, normalise_n


def _haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    r = 6371.0
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp = p2 - p1
    dl = math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


class TestNormaliseN:
    @pytest.mark.parametrize(
        "given,expected",
        [(7, 7), (5, 5), (9, 9), (4, 5), (6, 7), (8, 9), (2, 5), (11, 9), (0, 5)],
    )
    def test_clamps_and_forces_odd(self, given, expected):
        assert normalise_n(given) == expected
        assert normalise_n(given) % 2 == 1


class TestBuildGrid:
    def test_produces_n_squared_points(self):
        assert len(build_grid(1.35, 103.82, 40, 7)) == 49
        assert len(build_grid(1.35, 103.82, 40, 5)) == 25

    def test_centre_point_is_the_requested_coordinate(self):
        pts = build_grid(1.35, 103.82, 40, 7)
        assert pts[len(pts) // 2] == pytest.approx((1.35, 103.82), abs=1e-6)

    def test_spacing_is_uniform_in_metres(self):
        pts = build_grid(-17.83, 31.05, 40, 7)
        step = grid_cell_km(40, 7)
        # Adjacent points along one row are one cell apart (≈ metric, lon corrected).
        for col in range(6):
            d = _haversine_km(pts[3 * 7 + col], pts[3 * 7 + col + 1])
            assert d == pytest.approx(step, rel=0.01)

    def test_outer_points_sit_radius_away_from_centre(self):
        lat, lon = -17.83, 31.05
        pts = build_grid(lat, lon, 40, 7)
        north = pts[0]  # row 0 is north-west
        south = pts[-1]
        assert _haversine_km((lat, lon), (north[0], lon)) == pytest.approx(40, rel=0.01)
        assert _haversine_km((lat, lon), (south[0], lon)) == pytest.approx(40, rel=0.01)
        assert _haversine_km((lat, lon), (lat, north[1])) == pytest.approx(40, rel=0.02)

    def test_grid_is_row_major_north_to_south(self):
        pts = build_grid(1.35, 103.82, 40, 5)
        assert pts[0][0] > pts[5][0] > pts[10][0]  # latitude decreases per row
        assert pts[0][1] < pts[1][1]  # longitude increases per column

    def test_cell_km_is_spacing(self):
        assert grid_cell_km(40, 7) == pytest.approx(80 / 6)
        assert grid_cell_km(20, 5) == pytest.approx(10.0)
