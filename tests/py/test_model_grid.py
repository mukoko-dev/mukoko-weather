"""
Tests for _model_grid.py — per-model forecast fields on an n×n grid.

httpx and MongoDB are mocked; Open-Meteo is never reached.
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from py import _model_grid
from py._aq_grid import build_grid
from py._circuit_breaker import _circuit_states, open_meteo_breaker
from py._model_grid import (
    FORECAST_HOURS,
    MAP_MODELS,
    STEP_HOURS,
    cache_key,
    canonical_model,
    clamp_model_radius,
    get_model_grid,
    has_any_value,
    open_meteo_params,
    parse_model_grid,
    snap_centre,
)


@pytest.fixture(autouse=True)
def _reset_breaker():
    _circuit_states.clear()
    yield
    _circuit_states.clear()


def _hourly(hours: int = FORECAST_HOURS + 1, temp: float = 20.0) -> dict:
    return {
        "time": [f"2026-10-11T{(7 + h) % 24:02d}:00" for h in range(hours)],
        "temperature_2m": [temp + h * 0.1 for h in range(hours)],
        "precipitation": [0.0] * hours,
        "wind_speed_10m": [10.0] * hours,
        "wind_direction_10m": [180.0] * hours,
    }


def _om_response(n_points: int, **kw) -> list[dict]:
    return [{"hourly": _hourly(**kw)} for _ in range(n_points)]


def _http_with(payload) -> MagicMock:
    resp = MagicMock()
    resp.json.return_value = payload
    resp.raise_for_status.return_value = None
    client = MagicMock()
    client.get.return_value = resp
    return client


def _cache_col(find_result=None) -> MagicMock:
    col = MagicMock()
    col.find_one.return_value = find_result
    return col


def _body(resp) -> dict:
    return json.loads(resp.body)


class TestModels:
    def test_map_models_are_the_blend_members(self):
        assert MAP_MODELS == (
            "ecmwf_ifs",
            "ecmwf_aifs025_single",
            "gfs_seamless",
            "icon_global",
            "gem_global",
            "meteofrance_arpege_world",
        )

    def test_canonical_model_maps_aliases_and_rejects_others(self):
        assert canonical_model("ecmwf_ifs04") == "ecmwf_ifs"
        assert canonical_model(" gfs_seamless ") == "gfs_seamless"
        assert canonical_model("best_match") is None
        assert canonical_model("x; drop") is None
        assert canonical_model(None) is None


class TestPureHelpers:
    def test_snap_centre_to_quarter_degree(self):
        assert snap_centre(-17.83) == -17.75
        assert snap_centre(31.05) == 31.0
        assert snap_centre(31.13) == 31.25

    def test_radius_clamp(self):
        assert clamp_model_radius(5) == 20.0
        assert clamp_model_radius(500) == 200.0
        assert clamp_model_radius(120) == 120.0

    def test_cache_key_is_deterministic(self):
        assert cache_key("gfs_seamless", -17.75, 31.0, 7, 120) == "gfs_seamless_-17.75_31.00_7_120"

    def test_params_batch_points_and_name_the_model(self):
        pts = build_grid(-17.75, 31.0, 120, 7, clamp=False)
        params = open_meteo_params(pts, "icon_global")
        assert len(params["latitude"].split(",")) == 49
        assert params["models"] == "icon_global"
        assert params["forecast_hours"] == str(FORECAST_HOURS + 1)
        assert "wind_speed_10m" in params["hourly"]
        assert "apikey" not in params

    def test_unclamped_grid_spans_the_requested_radius(self):
        pts = build_grid(0.0, 0.0, 120, 7, clamp=False)
        # Outer rows sit ±120 km north/south (≈1.079° of latitude).
        assert pts[0][0] == pytest.approx(120 / 111.195, rel=1e-4)
        # The AQ grid's clamp still applies by default.
        clamped = build_grid(0.0, 0.0, 120, 7)
        assert clamped[0][0] == pytest.approx(100 / 111.195, rel=1e-4)

    def test_parse_samples_every_third_hour(self):
        times, points = parse_model_grid(_om_response(2), [(0, 0), (0, 1)])
        assert len(times) == FORECAST_HOURS // STEP_HOURS + 1
        assert times[0] == "2026-10-11T07:00Z"
        assert times[1] == "2026-10-11T10:00Z"
        assert points[0]["temperature"][1] == pytest.approx(20.3)
        assert points[1]["lon"] == 1
        assert len(points[0]["windSpeed"]) == len(times)

    def test_parse_accepts_single_object(self):
        times, points = parse_model_grid({"hourly": _hourly()}, [(0, 0)])
        assert len(points) == 1

    def test_parse_rejects_length_mismatch_and_missing_times(self):
        with pytest.raises(ValueError):
            parse_model_grid(_om_response(1), [(0, 0), (0, 1)])
        with pytest.raises(ValueError):
            parse_model_grid([{"hourly": {}}], [(0, 0)])

    def test_parse_keeps_nulls_and_drops_non_finite(self):
        hourly = _hourly(hours=4)
        hourly["temperature_2m"] = [None, "x", float("nan"), 1]
        _, points = parse_model_grid([{"hourly": hourly}], [(0, 0)])
        assert points[0]["temperature"] == [None, 1.0]

    def test_has_any_value(self):
        assert has_any_value([{"temperature": [None, 2.0]}]) is True
        assert has_any_value([{"temperature": [None], "precipitation": [None], "windSpeed": []}]) is False


class TestEndpoint:
    @pytest.mark.asyncio
    async def test_miss_fetches_once_and_caches(self):
        col = _cache_col(None)
        client = _http_with(_om_response(49))
        with patch.object(_model_grid, "_collection", return_value=col), patch.object(
            _model_grid, "_get_http", return_value=client
        ):
            resp = await get_model_grid(lat=-17.83, lon=31.05, model="gfs_seamless", n=7, radiusKm=120)
        body = _body(resp)
        assert body["available"] is True
        assert body["model"] == "gfs_seamless"
        assert len(body["points"]) == 49
        assert resp.headers["X-Cache"] == "MISS"
        assert client.get.call_count == 1
        col.update_one.assert_called_once()
        assert col.update_one.call_args[0][0] == {"_id": "gfs_seamless_-17.75_31.00_7_120"}

    @pytest.mark.asyncio
    async def test_hit_never_calls_upstream(self):
        cached = {"cellKm": 40.0, "times": ["t"], "points": [{"lat": 0, "lon": 0}]}
        client = _http_with(_om_response(49))
        with patch.object(_model_grid, "_collection", return_value=_cache_col(cached)), patch.object(
            _model_grid, "_get_http", return_value=client
        ):
            resp = await get_model_grid(lat=-17.83, lon=31.05, model="ecmwf_ifs", n=7, radiusKm=120)
        assert _body(resp)["available"] is True
        assert resp.headers["X-Cache"] == "HIT"
        client.get.assert_not_called()

    @pytest.mark.asyncio
    async def test_unknown_model_is_unavailable_without_a_fetch(self):
        client = _http_with(_om_response(49))
        with patch.object(_model_grid, "_get_http", return_value=client):
            resp = await get_model_grid(lat=0, lon=0, model="best_match", n=7, radiusKm=120)
        body = _body(resp)
        assert body["available"] is False
        assert body["reason"] == "unknown_model"
        client.get.assert_not_called()

    @pytest.mark.asyncio
    async def test_upstream_error_degrades_and_is_not_cached(self):
        col = _cache_col(None)
        client = MagicMock()
        client.get.side_effect = RuntimeError("boom")
        with patch.object(_model_grid, "_collection", return_value=col), patch.object(
            _model_grid, "_get_http", return_value=client
        ):
            resp = await get_model_grid(lat=0, lon=0, model="icon_global", n=7, radiusKm=120)
        body = _body(resp)
        assert body["available"] is False
        assert body["reason"] == "upstream_error"
        col.update_one.assert_not_called()

    @pytest.mark.asyncio
    async def test_all_null_model_is_no_data_not_a_breaker_failure(self):
        hourly = _hourly()
        for key in ("temperature_2m", "precipitation", "wind_speed_10m"):
            hourly[key] = [None] * len(hourly["time"])
        col = _cache_col(None)
        client = _http_with([{"hourly": hourly}] * 49)
        with patch.object(_model_grid, "_collection", return_value=col), patch.object(
            _model_grid, "_get_http", return_value=client
        ):
            resp = await get_model_grid(lat=0, lon=0, model="gem_global", n=7, radiusKm=120)
        assert _body(resp)["reason"] == "no_data"
        assert open_meteo_breaker.is_allowed
        col.update_one.assert_not_called()

    @pytest.mark.asyncio
    async def test_open_breaker_short_circuits(self):
        for _ in range(10):
            open_meteo_breaker.record_failure()
        client = _http_with(_om_response(49))
        with patch.object(_model_grid, "_collection", return_value=_cache_col(None)), patch.object(
            _model_grid, "_get_http", return_value=client
        ):
            resp = await get_model_grid(lat=0, lon=0, model="ecmwf_ifs", n=7, radiusKm=120)
        assert _body(resp)["reason"] == "circuit_open"
        client.get.assert_not_called()

    @pytest.mark.asyncio
    async def test_cache_read_failure_is_a_miss(self):
        col = MagicMock()
        col.find_one.side_effect = RuntimeError("db down")
        client = _http_with(_om_response(49))
        with patch.object(_model_grid, "_collection", return_value=col), patch.object(
            _model_grid, "_get_http", return_value=client
        ):
            resp = await get_model_grid(lat=0, lon=0, model="ecmwf_ifs", n=7, radiusKm=120)
        assert _body(resp)["available"] is True


class TestDevicesAcceptMapModels:
    def test_every_map_model_is_a_valid_device_preference(self):
        from py._devices import VALID_FORECAST_MODELS

        for model in MAP_MODELS:
            assert model in VALID_FORECAST_MODELS
        # Legacy ids keep working for older devices.
        assert "ecmwf_ifs04" in VALID_FORECAST_MODELS
        assert "icon_seamless" in VALID_FORECAST_MODELS
