"""Configurable Open-Meteo base URLs (self-hosted Open-Meteo, infra/open-meteo).

The default must stay the public API with no key header; setting the env
moves every forecast and air-quality call with no other change.
"""

from __future__ import annotations

import logging
from unittest.mock import MagicMock, patch

import pytest

from py import _open_meteo as om

ENV = (
    "OPEN_METEO_BASE_URL",
    "OPEN_METEO_AQ_BASE_URL",
    "OPEN_METEO_API_KEY",
)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for var in ENV:
        monkeypatch.delenv(var, raising=False)
    om._warned.clear()
    yield
    om._warned.clear()


def _self_hosted(monkeypatch, key: str | None = "k-test"):
    monkeypatch.setenv("OPEN_METEO_BASE_URL", "https://om.example.com")
    monkeypatch.setenv("OPEN_METEO_AQ_BASE_URL", "https://aq.example.com/")
    if key is not None:
        monkeypatch.setenv("OPEN_METEO_API_KEY", key)


def _ok_client(payload: dict | None = None) -> MagicMock:
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = payload or {}
    client = MagicMock()
    client.get.return_value = resp
    return client


class TestDefaults:
    def test_public_urls_when_unset(self):
        assert om.forecast_url() == "https://api.open-meteo.com/v1/forecast"
        assert om.air_quality_url() == "https://air-quality-api.open-meteo.com/v1/air-quality"

    def test_no_headers_for_public_api(self):
        assert om.headers_for(om.forecast_url()) == {}
        assert om.headers_for(om.air_quality_url()) == {}

    def test_key_alone_never_goes_to_the_public_api(self, monkeypatch):
        monkeypatch.setenv("OPEN_METEO_API_KEY", "k-test")
        assert om.headers_for(om.forecast_url()) == {}
        assert om.headers_for(om.air_quality_url()) == {}

    def test_blank_values_are_unset(self, monkeypatch):
        monkeypatch.setenv("OPEN_METEO_BASE_URL", "   ")
        assert om.forecast_url() == om.PUBLIC_FORECAST_URL


class TestSelfHosted:
    def test_paths_appended_and_trailing_slash_dropped(self, monkeypatch):
        _self_hosted(monkeypatch)
        assert om.forecast_url() == "https://om.example.com/v1/forecast"
        assert om.air_quality_url() == "https://aq.example.com/v1/air-quality"

    def test_value_that_already_names_the_endpoint(self, monkeypatch):
        monkeypatch.setenv("OPEN_METEO_BASE_URL", "https://om.example.com/v1/forecast")
        assert om.forecast_url() == "https://om.example.com/v1/forecast"

    def test_path_prefix_kept(self, monkeypatch):
        monkeypatch.setenv("OPEN_METEO_BASE_URL", "https://edge.example.com/om")
        assert om.forecast_url() == "https://edge.example.com/om/v1/forecast"

    def test_forecast_and_aq_are_independent(self, monkeypatch):
        monkeypatch.setenv("OPEN_METEO_BASE_URL", "https://om.example.com")
        assert om.forecast_url() == "https://om.example.com/v1/forecast"
        assert om.air_quality_url() == om.PUBLIC_AIR_QUALITY_URL

    def test_key_header_default_name(self, monkeypatch):
        _self_hosted(monkeypatch)
        assert om.headers_for(om.forecast_url()) == {"X-Mukoko-OM-Key": "k-test"}
        assert om.headers_for(om.air_quality_url()) == {"X-Mukoko-OM-Key": "k-test"}

    def test_key_header_name_matches_the_gateway(self):
        from pathlib import Path

        caddyfile = (
            Path(__file__).resolve().parents[2] / "infra/open-meteo/gateway/Caddyfile"
        ).read_text()
        assert f"header {om.KEY_HEADER} " in caddyfile
        assert f"request_header -{om.KEY_HEADER}" in caddyfile

    def test_endpoint_helpers_return_url_and_headers(self, monkeypatch):
        _self_hosted(monkeypatch)
        assert om.forecast() == ("https://om.example.com/v1/forecast", {"X-Mukoko-OM-Key": "k-test"})
        assert om.air_quality() == ("https://aq.example.com/v1/air-quality", {"X-Mukoko-OM-Key": "k-test"})
        assert om.forecast_is_self_hosted() and om.air_quality_is_self_hosted()

    @pytest.mark.parametrize(
        "value",
        [
            "https://API.open-meteo.com",
            "https://customer-api.open-meteo.com",
            "https://open-meteo.com",
        ],
    )
    def test_key_never_sent_to_any_open_meteo_host(self, monkeypatch, value):
        monkeypatch.setenv("OPEN_METEO_BASE_URL", value)
        monkeypatch.setenv("OPEN_METEO_API_KEY", "k-test")
        url = om.forecast_url()
        assert url.lower().startswith(value.lower())
        assert om.is_self_hosted(url) is False
        assert om.headers_for(url) == {}

    def test_lookalike_host_is_self_hosted(self):
        assert om.is_self_hosted("https://open-meteo.com.evil.example/v1/forecast") is True
        assert om.is_self_hosted("https://notopen-meteo.com/v1/forecast") is True

    def test_self_hosted_without_key_sends_no_header(self, monkeypatch):
        _self_hosted(monkeypatch, key=None)
        assert om.headers_for(om.forecast_url()) == {}

    def test_http_allowed_for_localhost_only(self, monkeypatch):
        monkeypatch.setenv("OPEN_METEO_BASE_URL", "http://localhost:8081")
        assert om.forecast_url() == "http://localhost:8081/v1/forecast"


class TestRejectedValues:
    @pytest.mark.parametrize(
        "value",
        [
            "http://om.example.com",  # plain http off localhost
            "ftp://om.example.com",
            "om.example.com",  # no scheme
            "https://user:pass@om.example.com",  # credentials in the URL
            "https://om.example.com/?apikey=x",  # query string
            "https://",
        ],
    )
    def test_falls_back_to_public(self, monkeypatch, value):
        monkeypatch.setenv("OPEN_METEO_BASE_URL", value)
        monkeypatch.setenv("OPEN_METEO_API_KEY", "k-test")
        url = om.forecast_url()
        assert url == om.PUBLIC_FORECAST_URL
        # And the key does not follow the traffic to the public API.
        assert om.headers_for(url) == {}

    def test_warning_never_logs_the_value(self, monkeypatch, caplog):
        monkeypatch.setenv("OPEN_METEO_BASE_URL", "https://user:s3cret@om.example.com")
        with caplog.at_level(logging.WARNING):
            om.forecast_url()
            om.forecast_url()
        text = caplog.text
        assert "OPEN_METEO_BASE_URL" in text
        assert "s3cret" not in text
        assert text.count("OPEN_METEO_BASE_URL") == 1  # warned once


class TestCallSites:
    """Every forecast/AQ caller follows the env, with the key header."""

    def test_weather_baseline_call(self, monkeypatch):
        from py import _weather

        _self_hosted(monkeypatch)
        client = _ok_client({"current": {}})
        with patch("py._weather._get_http_client", return_value=client):
            _weather._open_meteo_forecast(-17.83, 31.05, ["ecmwf_ifs"])
        args, kwargs = client.get.call_args
        assert args[0] == "https://om.example.com/v1/forecast"
        assert kwargs["headers"] == {"X-Mukoko-OM-Key": "k-test"}

    def test_weather_baseline_call_default_is_public(self):
        from py import _weather

        client = _ok_client({"current": {}})
        with patch("py._weather._get_http_client", return_value=client):
            _weather._open_meteo_forecast(-17.83, 31.05, None)
        args, kwargs = client.get.call_args
        assert args[0] == om.PUBLIC_FORECAST_URL
        assert kwargs["headers"] == {}

    def test_weather_extras_call(self, monkeypatch):
        from py import _weather

        _self_hosted(monkeypatch)
        client = _ok_client({"hourly": {"time": []}})
        with patch("py._weather._get_http_client", return_value=client):
            _weather._fetch_open_meteo_extras(-17.83, 31.05)
        args, kwargs = client.get.call_args
        assert args[0] == "https://om.example.com/v1/forecast"
        assert kwargs["headers"] == {"X-Mukoko-OM-Key": "k-test"}

    def test_air_quality_call(self, monkeypatch):
        from py import _air_quality

        _self_hosted(monkeypatch)
        client = _ok_client({"current": {"pm2_5": 5.0}})
        with patch("py._air_quality.get_http_client", return_value=client):
            _air_quality._fetch_open_meteo_air_quality(-17.83, 31.05)
        args, kwargs = client.get.call_args
        assert args[0] == "https://aq.example.com/v1/air-quality"
        assert kwargs["headers"] == {"X-Mukoko-OM-Key": "k-test"}

    def test_air_quality_grid_call(self, monkeypatch):
        from py import _aq_grid

        _self_hosted(monkeypatch)
        client = _ok_client()
        with (
            patch("py._aq_grid._get_http", return_value=client),
            patch("py._aq_grid.parse_grid_response", return_value=[]),
        ):
            _aq_grid._fetch_grid([(0.0, 0.0)])
        args, kwargs = client.get.call_args
        assert args[0] == "https://aq.example.com/v1/air-quality"
        assert kwargs["headers"] == {"X-Mukoko-OM-Key": "k-test"}

    def test_model_grid_call(self, monkeypatch):
        from py import _model_grid

        _self_hosted(monkeypatch)
        client = _ok_client()
        with (
            patch.object(_model_grid, "_get_http", return_value=client),
            patch.object(_model_grid, "parse_model_grid", return_value=([], [])),
        ):
            _model_grid._fetch([(0.0, 0.0)], "ecmwf_ifs")
        args, kwargs = client.get.call_args
        assert args[0] == "https://om.example.com/v1/forecast"
        assert kwargs["headers"] == {"X-Mukoko-OM-Key": "k-test"}

    def test_status_probe_names_the_instance_not_the_url(self, monkeypatch):
        from py import _status

        _self_hosted(monkeypatch)
        client = _ok_client({"current": {"temperature_2m": 21.0}})
        with patch("py._status.get_http_client", return_value=client):
            result = _status._check_open_meteo()
        args, kwargs = client.get.call_args
        assert args[0] == "https://om.example.com/v1/forecast"
        assert kwargs["headers"] == {"X-Mukoko-OM-Key": "k-test"}
        assert "self-hosted" in result["name"]
        assert "om.example.com" not in str(result)

    def test_status_probe_name_unchanged_by_default(self):
        from py import _status

        client = _ok_client({"current": {"temperature_2m": 21.0}})
        with patch("py._status.get_http_client", return_value=client):
            result = _status._check_open_meteo()
        assert result["name"] == "Open-Meteo API"

    def test_status_adds_aq_row_only_when_self_hosted(self, monkeypatch):
        from py import _status

        def names():
            stub = {"name": "x", "status": "operational"}
            with (
                patch.multiple(
                    _status,
                    _check_mongodb=lambda: stub,
                    _check_tomorrow_io=lambda: stub,
                    _check_open_meteo=lambda: stub,
                    _check_ai_gateway=lambda: stub,
                    _check_weather_cache=lambda: stub,
                    _check_ai_cache=lambda: stub,
                    _check_open_meteo_air_quality=lambda: {"name": "aq", "status": "operational"},
                ),
                patch.dict(_status._status_cache, {"data": None, "ts": 0}),
            ):
                import asyncio

                return [c["name"] for c in asyncio.run(_status.system_status())["checks"]]

        assert "aq" not in names()
        monkeypatch.setenv("OPEN_METEO_AQ_BASE_URL", "https://aq.example.com")
        assert "aq" in names()

    def test_aq_status_probe(self, monkeypatch):
        from py import _status

        _self_hosted(monkeypatch)
        client = _ok_client({"current": {"pm2_5": 4.0}})
        with patch("py._status.get_http_client", return_value=client):
            result = _status._check_open_meteo_air_quality()
        args, kwargs = client.get.call_args
        assert args[0] == "https://aq.example.com/v1/air-quality"
        assert kwargs["headers"] == {"X-Mukoko-OM-Key": "k-test"}
        assert result["status"] == "operational"

    def test_archive_stays_on_the_public_api(self, monkeypatch):
        """History/normals are out of scope for the self-hosted instance."""
        from py import _history_store

        _self_hosted(monkeypatch)
        assert _history_store.ARCHIVE_URL.startswith("https://archive-api.open-meteo.com/")



class TestBestMatchGuard:
    """A self-hosted best_match full of nulls is never served as weather."""

    NULLS = {"current": {"temperature_2m": None}, "hourly": {"temperature_2m": [None, None]}, "daily": {}}
    REAL = {"current": {"temperature_2m": 24}, "hourly": {"temperature_2m": [24.0]}, "daily": {}}

    async def _call(self, payload):
        from py import _weather

        with (
            patch("py._weather._find_nearest_location", return_value={"slug": "harare", "elevation": 1200}),
            patch("py._weather._get_cached_weather", return_value=None),
            patch("py._weather.open_meteo_breaker") as breaker,
            patch("py._weather._fetch_blend", return_value=None),
            patch("py._weather._fetch_open_meteo", return_value=payload),
            patch("py._weather._fetch_single_model", return_value=None),
            patch("py._weather._fetch_open_meteo_extras", return_value=None),
            patch("py._weather.enrichment.enrich", return_value=(None, "none")),
            patch("py._weather._set_cached_weather") as cache_set,
            patch("py._weather._record_weather_history") as history,
        ):
            breaker.is_allowed = True
            response = await _weather.get_weather(-17.83, 31.05)
        return response, breaker, cache_set, history

    def test_has_forecast_values(self):
        from py import _weather

        assert _weather._has_forecast_values({"hourly": {"temperature_2m": [None, 12.0]}})
        assert not _weather._has_forecast_values({"hourly": {"temperature_2m": [None, None]}})
        assert not _weather._has_forecast_values({})

    @pytest.mark.asyncio
    async def test_null_best_match_falls_to_seasonal_when_self_hosted(self, monkeypatch):
        _self_hosted(monkeypatch)
        response, breaker, _, history = await self._call(self.NULLS)
        assert response.headers.get("x-weather-provider") == "fallback"
        breaker.record_failure.assert_not_called()  # missing domain, not an outage
        history.assert_not_called()  # never recorded as real weather

    @pytest.mark.asyncio
    async def test_real_best_match_served_when_self_hosted(self, monkeypatch):
        _self_hosted(monkeypatch)
        response, breaker, _, _ = await self._call(self.REAL)
        assert response.headers.get("x-weather-provider") == "open-meteo:best_match"
        breaker.record_success.assert_called()

    @pytest.mark.asyncio
    async def test_public_api_behaviour_unchanged(self):
        response, _, _, _ = await self._call(self.NULLS)
        assert response.headers.get("x-weather-provider") == "open-meteo:best_match"
