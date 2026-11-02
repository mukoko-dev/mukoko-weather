"""Tests for _worker_weather.py — the Rust API Worker's weather for the Python AI tools."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from py import _worker_weather as ww


def _response(body, headers=None, status=200):
    resp = MagicMock()
    resp.json.return_value = body
    resp.headers = headers or {}
    if status >= 400:
        resp.raise_for_status.side_effect = RuntimeError(f"HTTP {status}")
    return resp


class TestOrigin:
    def test_defaults_and_accepts_only_a_bare_https_origin(self, monkeypatch):
        monkeypatch.delenv("NEXT_PUBLIC_WEATHER_API_URL", raising=False)
        assert ww.weather_api_base() == "https://weather-api.mukoko.com"
        monkeypatch.setenv("NEXT_PUBLIC_WEATHER_API_URL", "https://x.example.com/")
        assert ww.weather_api_base() == "https://x.example.com"
        for bad in (
            "http://evil.example.com",
            "https://u:p@x.example.com",
            "https://x.example.com?a=1",
            "https://x.example.com#f",
            "",
        ):
            monkeypatch.setenv("NEXT_PUBLIC_WEATHER_API_URL", bad)
            assert ww.weather_api_base() == "https://weather-api.mukoko.com", bad


class TestFetchWeather:
    @patch("py._worker_weather.get_http_client")
    def test_returns_the_payload_and_provider(self, get, monkeypatch):
        monkeypatch.delenv("NEXT_PUBLIC_WEATHER_API_URL", raising=False)
        client = get.return_value
        client.get.return_value = _response(
            {"current": {"temperature_2m": 24.1}}, {"X-Weather-Provider": "open-meteo:blend"}
        )
        data, provider = ww.fetch_weather(-17.83, 31.05)
        assert data["current"]["temperature_2m"] == 24.1
        assert provider == "open-meteo:blend"
        get.assert_called_once_with(ww.WEATHER_TIMEOUT_S)
        url = client.get.call_args[0][0]
        assert url == "https://weather-api.mukoko.com/v1/weather"
        assert client.get.call_args[1]["params"] == {"lat": "-17.83", "lon": "31.05"}

    @patch("py._worker_weather.get_http_client")
    def test_a_missing_provider_header_is_unknown(self, get):
        get.return_value.get.return_value = _response({"current": {}})
        assert ww.fetch_weather(1, 2)[1] == "unknown"

    @patch("py._worker_weather.get_http_client")
    def test_an_answer_without_current_is_none(self, get):
        get.return_value.get.return_value = _response({"hourly": {}})
        assert ww.fetch_weather(1, 2) is None
        get.return_value.get.return_value = _response([1, 2])
        assert ww.fetch_weather(1, 2) is None

    @pytest.mark.parametrize("lat,lon", [(None, 1), (1, None), ("x", 1), (float("nan"), 1), (1, float("nan"))])
    @patch("py._worker_weather.get_http_client")
    def test_an_unusable_coordinate_never_asks(self, get, lat, lon):
        assert ww.fetch_weather(lat, lon) is None
        get.assert_not_called()

    @patch("py._worker_weather.get_http_client")
    def test_a_failed_answer_raises_so_the_caller_keeps_its_fallback(self, get):
        get.return_value.get.return_value = _response({}, status=503)
        with pytest.raises(RuntimeError):
            ww.fetch_weather(1, 2)
