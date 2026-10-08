"""
Tests for _aq_grid.py — grid maths, single batched upstream request, cache
hit/miss, and failure / breaker degradation to ``available: false``.

httpx and MongoDB are mocked; the Open-Meteo API is never reached.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, PropertyMock, patch

import pytest
from fastapi.testclient import TestClient

from py import _aq_grid
from py._aq_grid import (
    AQ_GRID_CACHE_TTL_SECONDS,
    SOURCE_LABEL,
    _cache_key,
    _open_meteo_params,
    build_grid,
    get_air_quality_grid,
    grid_cell_km,
    normalise_n,
    parse_grid_response,
)
from py._circuit_breaker import _circuit_states, open_meteo_breaker


@pytest.fixture(autouse=True)
def _reset_breaker():
    _circuit_states.clear()
    yield
    _circuit_states.clear()


def _haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    r = 6371.0
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = (
        math.sin((la2 - la1) / 2) ** 2
        + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    )
    return 2 * r * math.asin(math.sqrt(h))


def _om_response(n_points: int, aqi: int = 80) -> list[dict]:
    return [
        {"current": {"us_aqi": aqi + i, "pm2_5": 10.0 + i}} for i in range(n_points)
    ]


def _http_with(payload) -> MagicMock:
    resp = MagicMock()
    resp.json.return_value = payload
    resp.raise_for_status.return_value = None
    client = MagicMock()
    client.get.return_value = resp
    return client


# ---------------------------------------------------------------------------
# Grid maths
# ---------------------------------------------------------------------------


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

    def test_cache_key_is_deterministic(self):
        assert _cache_key(1.35, 103.82, 7, 40.0) == "1.35_103.82_7_40"
        assert _cache_key(1.3512, 103.8249, 7, 40) == "1.35_103.82_7_40"


# ---------------------------------------------------------------------------
# Upstream request shape
# ---------------------------------------------------------------------------


class TestOpenMeteoRequest:
    def test_params_batch_all_points_in_one_comma_list(self):
        pts = build_grid(1.35, 103.82, 40, 7)
        params = _open_meteo_params(pts)
        assert params["current"] == "us_aqi,pm2_5"
        assert len(params["latitude"].split(",")) == 49
        assert len(params["longitude"].split(",")) == 49

    def test_fetch_issues_exactly_one_http_request(self):
        client = _http_with(_om_response(49))
        with patch.object(_aq_grid, "_get_http", return_value=client):
            readings = _aq_grid._fetch_grid(build_grid(1.35, 103.82, 40, 7))
        assert client.get.call_count == 1
        assert len(readings) == 49
        assert readings[0] == (80, 10.0)

    def test_parse_accepts_single_object_response(self):
        out = parse_grid_response({"current": {"us_aqi": 42.4, "pm2_5": 5.0}}, [(0, 0)])
        assert out == [(42, 5.0)]

    def test_parse_accepts_batched_list(self):
        out = parse_grid_response(_om_response(3), [(0, 0), (0, 1), (0, 2)])
        assert [a for a, _ in out] == [80, 81, 82]

    def test_parse_rejects_length_mismatch(self):
        with pytest.raises(ValueError):
            parse_grid_response(_om_response(2), [(0, 0), (0, 1), (0, 2)])

    def test_parse_tolerates_missing_values(self):
        out = parse_grid_response([{"current": {}}], [(0, 0)])
        assert out == [(None, None)]


# ---------------------------------------------------------------------------
# Endpoint behaviour
# ---------------------------------------------------------------------------


def _cache_col(find_result=None):
    col = MagicMock()
    col.find_one.return_value = find_result
    return col


class TestEndpoint:
    async def test_fetch_builds_response_and_caches(self):
        col = _cache_col(None)
        client = _http_with(_om_response(49, aqi=100))
        with patch.object(_aq_grid, "_get_http", return_value=client), patch.object(
            _aq_grid, "_cache_collection", return_value=col
        ):
            resp = await get_air_quality_grid(lat=1.35, lon=103.82, radiusKm=40, n=7)

        import json

        body = json.loads(resp.body)
        assert resp.headers["X-Cache"] == "MISS"
        assert body["available"] is True
        assert body["source"] == SOURCE_LABEL
        assert body["cellKm"] == pytest.approx(13.333, abs=1e-3)
        assert len(body["points"]) == 49
        assert body["center"]["lat"] == 1.35
        assert body["center"]["aqi"] == 100 + 24  # row-major centre index
        assert body["fetchedAt"]
        # One upstream call, one cache write under the deterministic _id.
        assert client.get.call_count == 1
        written = col.update_one.call_args
        assert written.args[0] == {"_id": "1.35_103.82_7_40"}
        assert written.kwargs.get("upsert") is True

    async def test_cache_hit_skips_upstream(self):
        now = datetime.now(timezone.utc)
        cached = {
            "_id": "1.35_103.82_7_40",
            "available": True,
            "center": {"lat": 1.35, "lon": 103.82, "aqi": 64},
            "cellKm": 13.333,
            "points": [{"lat": 1.35, "lon": 103.82, "aqi": 64, "pm2_5": 20.0}],
            "fetchedAt": now.replace(tzinfo=None),  # pymongo returns naive UTC
            "expiresAt": now + timedelta(seconds=AQ_GRID_CACHE_TTL_SECONDS),
        }
        client = _http_with(_om_response(49))
        with patch.object(_aq_grid, "_get_http", return_value=client), patch.object(
            _aq_grid, "_cache_collection", return_value=_cache_col(cached)
        ):
            resp = await get_air_quality_grid(lat=1.35, lon=103.82, radiusKm=40, n=7)

        import json

        body = json.loads(resp.body)
        assert resp.headers["X-Cache"] == "HIT"
        assert body["center"]["aqi"] == 64
        assert body["fetchedAt"].endswith("+00:00")
        client.get.assert_not_called()

    async def test_cache_query_only_matches_unexpired_docs(self):
        col = _cache_col(None)
        with patch.object(_aq_grid, "_cache_collection", return_value=col), patch.object(
            _aq_grid, "_get_http", return_value=_http_with(_om_response(49))
        ):
            await get_air_quality_grid(lat=1.35, lon=103.82, radiusKm=40, n=7)
        query = col.find_one.call_args.args[0]
        assert query["_id"] == "1.35_103.82_7_40"
        assert "$gt" in query["expiresAt"]

    async def test_upstream_failure_returns_available_false_not_500(self):
        client = MagicMock()
        client.get.side_effect = RuntimeError("upstream down")
        col = _cache_col(None)
        with patch.object(_aq_grid, "_get_http", return_value=client), patch.object(
            _aq_grid, "_cache_collection", return_value=col
        ):
            resp = await get_air_quality_grid(lat=1.35, lon=103.82, radiusKm=40, n=7)
        import json

        body = json.loads(resp.body)
        assert resp.status_code == 200
        assert body["available"] is False
        assert body["points"] == []
        assert body["center"] is None
        col.update_one.assert_not_called()  # failures are never cached

    async def test_open_breaker_short_circuits_without_upstream_call(self):
        client = _http_with(_om_response(49))
        with patch.object(
            type(open_meteo_breaker), "is_allowed", new_callable=PropertyMock, return_value=False
        ), patch.object(_aq_grid, "_get_http", return_value=client), patch.object(
            _aq_grid, "_cache_collection", return_value=_cache_col(None)
        ):
            resp = await get_air_quality_grid(lat=1.35, lon=103.82, radiusKm=40, n=7)
        import json

        assert json.loads(resp.body)["available"] is False
        client.get.assert_not_called()

    async def test_mongo_read_failure_still_serves_fresh_data(self):
        client = _http_with(_om_response(49))
        broken = MagicMock()
        broken.find_one.side_effect = RuntimeError("mongo down")
        broken.update_one.side_effect = RuntimeError("mongo down")
        with patch.object(_aq_grid, "_get_http", return_value=client), patch.object(
            _aq_grid, "_cache_collection", return_value=broken
        ):
            resp = await get_air_quality_grid(lat=1.35, lon=103.82, radiusKm=40, n=7)
        import json

        body = json.loads(resp.body)
        assert body["available"] is True
        assert len(body["points"]) == 49

    async def test_inputs_are_rounded_and_capped(self):
        col = _cache_col(None)
        client = _http_with(_om_response(25))
        with patch.object(_aq_grid, "_get_http", return_value=client), patch.object(
            _aq_grid, "_cache_collection", return_value=col
        ):
            await get_air_quality_grid(lat=1.3512, lon=103.8249, radiusKm=500, n=4)
        # n=4 → 5 (odd, in range); radius 500 → capped to 100, rounded key.
        assert col.update_one.call_args.args[0] == {"_id": "1.35_103.82_5_100"}
        assert len(client.get.call_args.kwargs["params"]["latitude"].split(",")) == 25


class TestRouteValidation:
    def test_out_of_range_latitude_is_rejected(self):
        from py.index import app

        resp = TestClient(app).get("/api/py/airquality/grid?lat=95&lon=10")
        assert resp.status_code == 422
