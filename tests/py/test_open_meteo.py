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
    "OPEN_METEO_API_KEY_HEADER",
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

    def test_source_label_public(self):
        assert om.source_label(om.forecast_url()) == "public"

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

    def test_key_header_custom_name(self, monkeypatch):
        _self_hosted(monkeypatch)
        monkeypatch.setenv("OPEN_METEO_API_KEY_HEADER", "X-Weather-Key")
        assert om.headers_for(om.forecast_url()) == {"X-Weather-Key": "k-test"}

    def test_invalid_header_name_falls_back_to_default(self, monkeypatch):
        _self_hosted(monkeypatch)
        monkeypatch.setenv("OPEN_METEO_API_KEY_HEADER", "bad header:\r\n")
        assert om.headers_for(om.forecast_url()) == {"X-Mukoko-OM-Key": "k-test"}

    def test_self_hosted_without_key_sends_no_header(self, monkeypatch):
        _self_hosted(monkeypatch, key=None)
        assert om.headers_for(om.forecast_url()) == {}

    def test_source_label_self_hosted(self, monkeypatch):
        _self_hosted(monkeypatch)
        assert om.source_label(om.forecast_url()) == "self-hosted"

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

    def test_archive_stays_on_the_public_api(self, monkeypatch):
        """History/normals are out of scope for the self-hosted instance."""
        from py import _history_store, _normals

        _self_hosted(monkeypatch)
        assert _history_store.ARCHIVE_URL.startswith("https://archive-api.open-meteo.com/")
        assert _normals.ARCHIVE_URL.startswith("https://archive-api.open-meteo.com/")
