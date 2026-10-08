"""Tests for _http.py — shared, process-wide httpx clients keyed by timeout."""

from __future__ import annotations

import threading
from unittest.mock import patch

import httpx

from py import _http
from py._http import get_http_client


class TestGetHttpClient:
    def test_returns_httpx_client_with_requested_timeout(self):
        client = get_http_client(7.5)
        assert isinstance(client, httpx.Client)
        assert client.timeout.connect == 7.5

    def test_same_timeout_returns_same_instance(self):
        assert get_http_client(6.25) is get_http_client(6.25)

    def test_different_timeouts_return_different_clients(self):
        assert get_http_client(3.5) is not get_http_client(4.5)
        assert get_http_client(3.5).timeout.connect == 3.5
        assert get_http_client(4.5).timeout.connect == 4.5

    def test_concurrent_first_calls_create_one_client(self):
        """Racing warm-up calls must not each build (and leak) a client."""
        timeout = 9.125  # unused elsewhere, so the cache starts cold for it
        with patch.dict(_http._clients, {}, clear=False):
            _http._clients.pop(timeout, None)
            results: list[httpx.Client] = []
            barrier = threading.Barrier(8)

            def worker():
                barrier.wait()
                results.append(get_http_client(timeout))

            threads = [threading.Thread(target=worker) for _ in range(8)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

        assert len(results) == 8
        assert all(c is results[0] for c in results)


class TestModuleTimeouts:
    """Each migrated module keeps its historical upstream timeout."""

    def test_locations_geocoding_timeout(self):
        from py import _locations

        with patch("py._locations.get_http_client") as get:
            _locations._get_http()
        get.assert_called_once_with(5.0)

    def test_overpass_timeout_constant(self):
        # conftest makes _overpass._get_http unreachable by default, so pin the
        # constant it passes to the shared client instead.
        from py import _overpass

        assert _overpass.HTTP_TIMEOUT_S == 6.0

    def test_tiles_upstream_timeout(self):
        from py import _tiles

        with patch("py._tiles.get_http_client") as get:
            _tiles._get_http()
        get.assert_called_once_with(8.0)

    def test_air_quality_timeout(self):
        from py import _air_quality

        with patch("py._air_quality.get_http_client") as get:
            get.return_value.get.return_value.json.return_value = {"current": {}}
            _air_quality._fetch_open_meteo_air_quality(-17.8, 31.0)
        get.assert_called_once_with(10.0)

    def test_status_probes_share_one_client_with_10s_timeout(self):
        from py import _status

        with patch("py._status.get_http_client") as get:
            get.return_value.get.return_value.status_code = 200
            get.return_value.get.return_value.json.return_value = {"current": {"temperature_2m": 25}}
            _status._check_open_meteo()
        get.assert_called_once_with(10.0)
