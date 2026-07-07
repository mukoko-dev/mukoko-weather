"""Tests for _stations.py — registration, WU/Ecowitt ingest, manual readings, QC."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from py._stations import (
    _hash_key,
    _qc_filter,
    _find_station,
    f_to_c,
    mph_to_kph,
    inhg_to_hpa,
    inch_to_mm,
    register_station,
    manual_reading,
    StationRegisterRequest,
    ManualReadingRequest,
    QC_RANGES,
)


# ---------------------------------------------------------------------------
# Unit conversions
# ---------------------------------------------------------------------------


class TestConversions:
    def test_fahrenheit_to_celsius(self):
        assert f_to_c(32) == 0
        assert round(f_to_c(95), 1) == 35.0
        assert f_to_c(None) is None

    def test_mph_to_kph(self):
        assert round(mph_to_kph(10), 2) == 16.09
        assert mph_to_kph(None) is None

    def test_inhg_to_hpa(self):
        assert round(inhg_to_hpa(29.92), 0) == 1013
        assert inhg_to_hpa(None) is None

    def test_inches_to_mm(self):
        assert inch_to_mm(1) == 25.4
        assert inch_to_mm(None) is None


# ---------------------------------------------------------------------------
# QC range filter
# ---------------------------------------------------------------------------


class TestQcFilter:
    def test_keeps_plausible_values(self):
        out = _qc_filter({"airTemperatureCelsius": 25.5, "relativeHumidityPercent": 60})
        assert out == {"airTemperatureCelsius": 25.5, "relativeHumidityPercent": 60.0}

    def test_rejects_out_of_range(self):
        out = _qc_filter({"airTemperatureCelsius": 95, "relativeHumidityPercent": 130})
        assert out == {}

    def test_drops_unknown_fields_and_nones(self):
        out = _qc_filter({"hackField": 1, "airTemperatureCelsius": None})
        assert out == {}

    def test_every_range_has_sane_bounds(self):
        for field, (lo, hi) in QC_RANGES.items():
            assert lo < hi, field


# ---------------------------------------------------------------------------
# Station auth
# ---------------------------------------------------------------------------


class TestFindStation:
    @patch("py._stations.stations_collection")
    def test_matches_hashed_key(self, mock_coll):
        mock_coll.return_value.find_one.return_value = {
            "stationId": "mws-abcd1234",
            "ingestKeySalt": "aa" * 16,
            "ingestKeyHash": _hash_key("secret", "aa" * 16),
        }
        assert _find_station("mws-abcd1234", "secret") is not None

    @patch("py._stations.stations_collection")
    def test_rejects_wrong_key(self, mock_coll):
        mock_coll.return_value.find_one.return_value = {
            "stationId": "mws-abcd1234",
            "ingestKeySalt": "aa" * 16,
            "ingestKeyHash": _hash_key("secret", "aa" * 16),
        }
        assert _find_station("mws-abcd1234", "wrong") is None

    @patch("py._stations.stations_collection")
    def test_rejects_doc_missing_salt_or_hash(self, mock_coll):
        mock_coll.return_value.find_one.return_value = {"stationId": "mws-abcd1234"}
        assert _find_station("mws-abcd1234", "secret") is None

    def test_rejects_malformed_station_id(self):
        assert _find_station("not-a-station", "key") is None
        assert _find_station("", "") is None

    @patch("py._stations.stations_collection")
    def test_returns_none_on_db_error(self, mock_coll):
        mock_coll.return_value.find_one.side_effect = Exception("db down")
        assert _find_station("mws-abcd1234", "secret") is None


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------


def _make_request():
    from fastapi import Request
    req = MagicMock(spec=Request)
    req.headers = {"x-forwarded-for": "1.2.3.4"}
    req.client = MagicMock()
    req.client.host = "1.2.3.4"
    return req


class TestRegister:
    @pytest.mark.asyncio
    @patch("py._stations.check_rate_limit", return_value={"allowed": True, "remaining": 2})
    @patch("py._stations.stations_collection")
    @patch("py._stations.get_client_ip", return_value="1.2.3.4")
    async def test_registers_and_returns_key_once(self, _ip, mock_coll, _rate):
        req = _make_request()
        result = await register_station(
            StationRegisterRequest(name="School Station", lat=-17.8, lon=31.0, stationType="manual"),
            request=req,
        )
        assert result["stationId"].startswith("mws-")
        assert len(result["ingestKey"]) >= 24
        inserted = mock_coll.return_value.insert_one.call_args[0][0]
        # Only the salted PBKDF2 hash is persisted — never the raw key
        assert inserted["ingestKeyHash"] == _hash_key(result["ingestKey"], inserted["ingestKeySalt"])
        assert result["ingestKey"] not in str({k: v for k, v in inserted.items() if k != "ingestKeyHash"})
        # GeoJSON point for the 2dsphere blend query
        assert inserted["location"] == {"type": "Point", "coordinates": [31.0, -17.8]}
        # Platform stamps present
        assert inserted["_schemaVersion"]
        assert inserted["bundu"]["countryCode"] == "ZW"

    @pytest.mark.asyncio
    @patch("py._stations.check_rate_limit", return_value={"allowed": False, "remaining": 0})
    @patch("py._stations.get_client_ip", return_value="1.2.3.4")
    async def test_rate_limited(self, _ip, _rate):
        with pytest.raises(HTTPException) as exc:
            await register_station(
                StationRegisterRequest(name="Spam", lat=0, lon=0), request=_make_request()
            )
        assert exc.value.status_code == 429


# ---------------------------------------------------------------------------
# Manual readings
# ---------------------------------------------------------------------------


def _station_doc():
    return {
        "stationId": "mws-abcd1234",
        "ingestKeySalt": "aa" * 16,
        "ingestKeyHash": _hash_key("secret", "aa" * 16),
        "location": {"type": "Point", "coordinates": [31.0, -17.8]},
        "bundu": {"countryCode": "ZW"},
    }


class TestManualReading:
    @pytest.mark.asyncio
    @patch("py._stations.check_rate_limit", return_value={"allowed": True, "remaining": 11})
    @patch("py._stations.observations_collection")
    @patch("py._stations.station_observations_collection")
    @patch("py._stations.stations_collection")
    @patch("py._stations.get_client_ip", return_value="1.2.3.4")
    async def test_valid_reading_becomes_validated_observation(
        self, _ip, mock_stations, _mock_raw, mock_obs, _rate
    ):
        mock_stations.return_value.find_one.return_value = _station_doc()
        result = await manual_reading(
            ManualReadingRequest(stationId="mws-abcd1234", key="secret", temperatureC=21.5, rainfallMm=12),
            request=_make_request(),
        )
        import json

        body = json.loads(result.body)
        assert body["qcStatus"] == "validated"
        assert body["accepted"] == 2
        obs = mock_obs.return_value.insert_one.call_args[0][0]
        assert obs["qcStatus"] == "validated"
        assert obs["sourceType"] == "manual"
        assert obs["metrics"]["airTemperatureCelsius"] == 21.5
        assert obs["location"]["type"] == "Point"

    @pytest.mark.asyncio
    @patch("py._stations.check_rate_limit", return_value={"allowed": True, "remaining": 11})
    @patch("py._stations.stations_collection")
    @patch("py._stations.get_client_ip", return_value="1.2.3.4")
    async def test_wrong_key_is_401(self, _ip, mock_stations, _rate):
        mock_stations.return_value.find_one.return_value = _station_doc()
        with pytest.raises(HTTPException) as exc:
            await manual_reading(
                ManualReadingRequest(stationId="mws-abcd1234", key="nope", temperatureC=20),
                request=_make_request(),
            )
        assert exc.value.status_code == 401

    @pytest.mark.asyncio
    @patch("py._stations.check_rate_limit", return_value={"allowed": True, "remaining": 11})
    @patch("py._stations.stations_collection")
    @patch("py._stations.get_client_ip", return_value="1.2.3.4")
    async def test_empty_reading_is_400(self, _ip, mock_stations, _rate):
        mock_stations.return_value.find_one.return_value = _station_doc()
        with pytest.raises(HTTPException) as exc:
            await manual_reading(
                ManualReadingRequest(stationId="mws-abcd1234", key="secret"),
                request=_make_request(),
            )
        assert exc.value.status_code == 400

    def test_pydantic_rejects_impossible_values(self):
        with pytest.raises(Exception):
            ManualReadingRequest(stationId="mws-abcd1234", key="k", temperatureC=99)
