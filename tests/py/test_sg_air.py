"""
Tests for _sg_air.py — official Singapore NEA PSI / PM2.5 via data.gov.sg.

Covers:
  * PSI band boundaries (upper bounds inclusive)
  * Parsing a payload shaped like the live API (no ``national`` key)
  * Reported-national vs highest-region headline basis
  * Nearest-region selection from label coordinates
  * PM2.5 failure tolerated; PSI failure surfaced
  * Endpoint: failure, malformed payload, breaker open -> HTTP 200 + available false
  * In-memory cache

The network is never touched: ``_get_json`` and ``_fetch_upstream`` are patched.
"""

from __future__ import annotations

import copy
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from py import _sg_air
from py._circuit_breaker import nea_breaker
from py._sg_air import (
    PM25_URL,
    PSI_URL,
    SOURCE_ATTRIBUTION,
    get_sg_air,
    parse_sg_air,
    psi_band,
)

# Shaped like the live data.gov.sg responses (captured 2026-10-08).
PSI_PAYLOAD = {
    "code": 0,
    "data": {
        "regionMetadata": [
            {"name": "north", "labelLocation": {"latitude": 1.41803, "longitude": 103.82}},
            {"name": "south", "labelLocation": {"latitude": 1.29587, "longitude": 103.82}},
            {"name": "east", "labelLocation": {"latitude": 1.35735, "longitude": 103.94}},
            {"name": "west", "labelLocation": {"latitude": 1.35735, "longitude": 103.7}},
            {"name": "central", "labelLocation": {"latitude": 1.35735, "longitude": 103.82}},
        ],
        "items": [
            {
                "date": "2026-10-08",
                "updatedTimestamp": "2026-10-08T22:45:45+08:00",
                "timestamp": "2026-10-08T22:00:00+08:00",
                "readings": {
                    "psi_twenty_four_hourly": {
                        "north": 99,
                        "south": 107,
                        "west": 140,
                        "east": 108,
                        "central": 139,
                    },
                },
            }
        ],
    },
    "errorMsg": "",
}

PM25_PAYLOAD = {
    "code": 0,
    "data": {
        "regionMetadata": [],
        "items": [
            {
                "timestamp": "2026-10-08T22:00:00+08:00",
                "readings": {
                    "pm25_one_hourly": {
                        "north": 80,
                        "south": 130,
                        "west": 158,
                        "east": 119,
                        "central": 139,
                    },
                },
            }
        ],
    },
    "errorMsg": "",
}


@pytest.fixture(autouse=True)
def _reset_sg_air_state():
    """Each test starts with an empty upstream cache and a closed breaker."""
    _sg_air._upstream_cache.update({"at": 0.0, "value": None})
    nea_breaker.reset()
    yield
    _sg_air._upstream_cache.update({"at": 0.0, "value": None})
    nea_breaker.reset()


# ---------------------------------------------------------------------------
# PSI bands
# ---------------------------------------------------------------------------


class TestPsiBand:
    @pytest.mark.parametrize(
        "value, expected",
        [
            (0, "good"),
            (50, "good"),
            (51, "moderate"),
            (100, "moderate"),
            (101, "unhealthy"),
            (200, "unhealthy"),
            (201, "very_unhealthy"),
            (300, "very_unhealthy"),
            (301, "hazardous"),
            (1000, "hazardous"),
        ],
    )
    def test_upper_bounds_are_inclusive(self, value, expected):
        assert psi_band(value)[0] == expected

    def test_labels_match_bands(self):
        assert psi_band(40) == ("good", "Good")
        assert psi_band(140) == ("unhealthy", "Unhealthy")
        assert psi_band(250) == ("very_unhealthy", "Very unhealthy")
        assert psi_band(350) == ("hazardous", "Hazardous")

    def test_non_finite_is_rejected(self):
        with pytest.raises(ValueError):
            psi_band(float("nan"))


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


class TestParse:
    def test_parses_live_shaped_payload(self):
        out = parse_sg_air(PSI_PAYLOAD, PM25_PAYLOAD, fetched_at="2026-10-08T14:50:00+00:00")
        assert out.available is True
        assert out.source == SOURCE_ATTRIBUTION
        assert out.observedAt == "2026-10-08T22:00:00+08:00"
        assert out.fetchedAt == "2026-10-08T14:50:00+00:00"
        assert len(out.regions) == 5

    def test_no_national_key_uses_highest_region_and_says_so(self):
        out = parse_sg_air(PSI_PAYLOAD, PM25_PAYLOAD)
        assert out.psi24h == 140
        assert out.psiBasis == "highest_region"
        assert out.band == "unhealthy"
        assert out.bandLabel == "Unhealthy"
        assert out.pm25OneHour == 158
        assert out.pm25Basis == "highest_region"

    def test_reported_national_value_wins(self):
        payload = copy.deepcopy(PSI_PAYLOAD)
        payload["data"]["items"][0]["readings"]["psi_twenty_four_hourly"]["national"] = 120
        out = parse_sg_air(payload, PM25_PAYLOAD)
        assert out.psi24h == 120
        assert out.psiBasis == "national"

    def test_region_values_and_coordinates(self):
        out = parse_sg_air(PSI_PAYLOAD, PM25_PAYLOAD)
        west = next(r for r in out.regions if r.region == "west")
        assert west.psi24h == 140
        assert west.band == "unhealthy"
        assert west.pm25OneHour == 158
        assert west.labelLongitude == pytest.approx(103.7)

    def test_missing_pm25_payload_keeps_psi(self):
        out = parse_sg_air(PSI_PAYLOAD, None)
        assert out.available is True
        assert out.psi24h == 140
        assert out.pm25OneHour is None
        assert out.pm25Basis is None
        assert all(r.pm25OneHour is None for r in out.regions)

    def test_error_code_raises(self):
        bad = {"code": 1, "data": {}, "errorMsg": "nope"}
        with pytest.raises(ValueError):
            parse_sg_air(bad, None)

    def test_empty_items_raises(self):
        bad = copy.deepcopy(PSI_PAYLOAD)
        bad["data"]["items"] = []
        with pytest.raises(ValueError):
            parse_sg_air(bad, None)

    def test_no_readings_raises(self):
        bad = copy.deepcopy(PSI_PAYLOAD)
        bad["data"]["items"][0]["readings"]["psi_twenty_four_hourly"] = {}
        with pytest.raises(ValueError):
            parse_sg_air(bad, None)


# ---------------------------------------------------------------------------
# Nearest region
# ---------------------------------------------------------------------------


class TestNearestRegion:
    def test_city_centre_is_central(self):
        out = parse_sg_air(PSI_PAYLOAD, PM25_PAYLOAD, lat=1.3521, lon=103.8198)
        assert out.nearestRegion == "central"

    def test_southern_point_is_south(self):
        out = parse_sg_air(PSI_PAYLOAD, PM25_PAYLOAD, lat=1.30, lon=103.85)
        assert out.nearestRegion == "south"

    def test_western_point_is_west(self):
        out = parse_sg_air(PSI_PAYLOAD, PM25_PAYLOAD, lat=1.35, lon=103.66)
        assert out.nearestRegion == "west"

    def test_no_coordinates_means_no_nearest(self):
        out = parse_sg_air(PSI_PAYLOAD, PM25_PAYLOAD)
        assert out.nearestRegion is None


# ---------------------------------------------------------------------------
# Upstream fetch
# ---------------------------------------------------------------------------


def _fake_get_json(psi=PSI_PAYLOAD, pm25=PM25_PAYLOAD, pm25_error=None):
    async def fake(client, url):
        if url == PSI_URL:
            return copy.deepcopy(psi)
        if url == PM25_URL:
            if pm25_error is not None:
                raise pm25_error
            return copy.deepcopy(pm25)
        raise AssertionError(f"unexpected URL {url}")

    return fake


class TestFetchUpstream:
    async def test_pm25_failure_is_tolerated(self):
        with patch.object(
            _sg_air, "_get_json", side_effect=_fake_get_json(pm25_error=httpx.ConnectError("down"))
        ):
            psi, pm25 = await _sg_air._fetch_upstream()
        assert psi == PSI_PAYLOAD
        assert pm25 is None

    async def test_psi_failure_is_raised(self):
        async def boom(client, url):
            raise httpx.ConnectError("down")

        with patch.object(_sg_air, "_get_json", side_effect=boom):
            with pytest.raises(httpx.ConnectError):
                await _sg_air._fetch_upstream()


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


class TestEndpoint:
    async def test_success_returns_parsed_reading(self):
        with patch.object(
            _sg_air, "_fetch_upstream", AsyncMock(return_value=(PSI_PAYLOAD, PM25_PAYLOAD))
        ):
            out = await get_sg_air(lat=1.3521, lon=103.8198)
        assert out.available is True
        assert out.psi24h == 140
        assert out.nearestRegion == "central"
        assert out.fetchedAt is not None

    async def test_upstream_failure_is_available_false_not_error(self):
        with patch.object(
            _sg_air, "_fetch_upstream", AsyncMock(side_effect=httpx.ConnectError("down"))
        ):
            out = await get_sg_air(lat=None, lon=None)
        assert out.available is False
        assert out.psi24h is None
        assert out.regions == []

    async def test_timeout_is_available_false(self):
        with patch.object(
            _sg_air, "_fetch_upstream", AsyncMock(side_effect=TimeoutError("slow"))
        ):
            out = await get_sg_air(lat=None, lon=None)
        assert out.available is False

    async def test_malformed_payload_is_available_false(self):
        broken = {"code": 0, "data": {"items": [{"readings": {}}]}}
        with patch.object(
            _sg_air, "_fetch_upstream", AsyncMock(return_value=(broken, None))
        ):
            out = await get_sg_air(lat=None, lon=None)
        assert out.available is False

    async def test_breaker_open_is_available_false_without_calling_upstream(self):
        for _ in range(3):
            nea_breaker.record_failure()
        assert nea_breaker.is_allowed is False

        fetch = AsyncMock(return_value=(PSI_PAYLOAD, PM25_PAYLOAD))
        with patch.object(_sg_air, "_fetch_upstream", fetch):
            out = await get_sg_air(lat=None, lon=None)
        assert out.available is False
        fetch.assert_not_called()

    async def test_successful_upstream_is_cached_for_ten_minutes(self):
        fetch = AsyncMock(return_value=(PSI_PAYLOAD, PM25_PAYLOAD))
        with patch.object(_sg_air, "_fetch_upstream", fetch):
            first = await get_sg_air(lat=None, lon=None)
            second = await get_sg_air(lat=None, lon=None)
        assert first.available and second.available
        assert fetch.await_count == 1

    async def test_failures_are_not_cached(self):
        fetch = AsyncMock(side_effect=httpx.ConnectError("down"))
        with patch.object(_sg_air, "_fetch_upstream", fetch):
            await get_sg_air(lat=None, lon=None)
            await get_sg_air(lat=None, lon=None)
        assert fetch.await_count == 2

    async def test_cache_expires_after_ttl(self):
        fetch = AsyncMock(return_value=(PSI_PAYLOAD, PM25_PAYLOAD))
        with patch.object(_sg_air, "_fetch_upstream", fetch):
            await get_sg_air(lat=None, lon=None)
            _sg_air._upstream_cache["at"] -= _sg_air.CACHE_TTL_SECONDS + 1
            await get_sg_air(lat=None, lon=None)
        assert fetch.await_count == 2
