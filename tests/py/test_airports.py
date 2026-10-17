"""Tests for _airports.py — DB-backed nearest-airport $geoNear lookup + endpoint."""

from __future__ import annotations

import asyncio
from unittest.mock import patch, MagicMock

import pytest

from py._airports import (
    nearest_airports,
    get_nearest_airports,
    NearbyAirport,
    NearestAirportsResponse,
    MAX_COUNT,
    DEFAULT_MAX_DISTANCE_KM,
)


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class TestModels:
    def test_nearby_airport_shape(self):
        a = NearbyAirport(icao="FVHA", name="Harare", distanceKm=12.3)
        assert a.icao == "FVHA"
        assert a.name == "Harare"
        assert a.distanceKm == 12.3

    def test_response_shape(self):
        resp = NearestAirportsResponse(
            airports=[NearbyAirport(icao="FVHA", name="Harare", distanceKm=1.0)],
            source="db",
        )
        assert resp.source == "db"
        assert len(resp.airports) == 1


# ---------------------------------------------------------------------------
# nearest_airports — $geoNear query
# ---------------------------------------------------------------------------


class TestNearestAirports:
    def _mock_collection(self, docs: list[dict]) -> MagicMock:
        coll = MagicMock()
        coll.aggregate.return_value = iter(docs)
        return coll

    def test_maps_docs_to_airports_with_km_distance(self):
        docs = [
            {"_id": "FVHA", "icao": "FVHA", "name": "Harare", "distanceMeters": 12300.0},
            {"_id": "FVCP", "icao": "FVCP", "name": "Charles Prince", "distanceMeters": 20100.0},
        ]
        coll = self._mock_collection(docs)
        with patch("py._airports._airports_collection", return_value=coll):
            result = nearest_airports(-17.85, 31.05, count=5)
        assert [a.icao for a in result] == ["FVHA", "FVCP"]
        # metres → km, rounded to 1 dp
        assert result[0].distanceKm == 12.3
        assert result[1].distanceKm == 20.1

    def test_builds_geonear_pipeline_with_coords_and_radius(self):
        coll = self._mock_collection([])
        with patch("py._airports._airports_collection", return_value=coll):
            nearest_airports(-17.85, 31.05, count=3, max_distance_km=200)
        pipeline = coll.aggregate.call_args[0][0]
        geo = pipeline[0]["$geoNear"]
        # GeoJSON is [lon, lat]
        assert geo["near"]["coordinates"] == [31.05, -17.85]
        assert geo["maxDistance"] == 200 * 1000.0
        assert geo["spherical"] is True
        assert pipeline[1]["$limit"] == 3

    def test_falls_back_to_id_when_icao_field_missing(self):
        docs = [{"_id": "FVHA", "name": "Harare", "distanceMeters": 0.0}]
        coll = self._mock_collection(docs)
        with patch("py._airports._airports_collection", return_value=coll):
            result = nearest_airports(-17.85, 31.05)
        assert result[0].icao == "FVHA"

    def test_returns_empty_list_on_db_error(self):
        coll = MagicMock()
        coll.aggregate.side_effect = RuntimeError("no 2dsphere index")
        with patch("py._airports._airports_collection", return_value=coll):
            result = nearest_airports(-17.85, 31.05)
        assert result == []


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


class TestEndpoint:
    def test_source_db_when_results(self):
        airports = [NearbyAirport(icao="FVHA", name="Harare", distanceKm=1.0)]
        with patch("py._airports.nearest_airports", return_value=airports):
            resp = asyncio.run(get_nearest_airports(lat=-17.85, lon=31.05, count=5, maxDistanceKm=500))
        assert resp.source == "db"
        assert resp.airports[0].icao == "FVHA"

    def test_source_empty_when_no_results(self):
        with patch("py._airports.nearest_airports", return_value=[]):
            resp = asyncio.run(get_nearest_airports(lat=0.0, lon=0.0, count=5, maxDistanceKm=500))
        assert resp.source == "empty"
        assert resp.airports == []

    def test_none_max_distance_defaults(self):
        # maxDistanceKm=None should fall back to DEFAULT_MAX_DISTANCE_KM.
        captured = {}

        def _fake(lat, lon, count, max_distance_km):
            captured["max"] = max_distance_km
            return []

        with patch("py._airports.nearest_airports", side_effect=_fake):
            asyncio.run(get_nearest_airports(lat=0.0, lon=0.0, count=5, maxDistanceKm=None))
        assert captured["max"] == DEFAULT_MAX_DISTANCE_KM


class TestConstants:
    def test_max_count_is_reasonable(self):
        assert 1 < MAX_COUNT <= 50


# ---------------------------------------------------------------------------
# Fetch on demand: AWC station-info parsing + storage (#302)
# ---------------------------------------------------------------------------

from py._airports import (  # noqa: E402
    DISCOVERED_SOURCE,
    MAX_DISCOVERED_PER_REQUEST,
    haversine_km,
    nearest_of,
    parse_awc_stations,
    upsert_discovered_airports,
)

# Real AWC stationinfo rows (bbox around Phuket, captured 2026-10-17).
PHUKET_STATIONINFO = [
    {"id": "VTSB", "icaoId": "VTSB", "iataId": "URT", "site": "Surat Thani Intl",
     "lat": 9.133, "lon": 99.152, "elev": 10, "country": "TH", "siteType": ["METAR", "TAF"]},
    {"id": "VTSG", "icaoId": "VTSG", "iataId": "KBV", "site": "Krabi Arpt",
     "lat": 8.099, "lon": 98.986, "elev": 32, "country": "TH", "siteType": ["METAR", "TAF"]},
    {"id": "VTSP", "icaoId": "VTSP", "iataId": "HKT", "site": "Phuket Intl",
     "lat": 8.105, "lon": 98.308, "elev": 12, "country": "TH", "siteType": ["METAR", "TAF"]},
]


class TestParseAwcStations:
    def test_keeps_real_metar_stations(self):
        stations = parse_awc_stations(PHUKET_STATIONINFO)
        assert [s["icao"] for s in stations] == ["VTSB", "VTSG", "VTSP"]
        vtsp = stations[2]
        assert vtsp == {
            "icao": "VTSP", "name": "Phuket Intl", "lat": 8.105, "lon": 98.308,
            "country": "TH", "iata": "HKT",
        }

    def test_rejects_invalid_rows(self):
        rows = [
            {"icaoId": "K0V1", "site": "digit id", "lat": 1, "lon": 1, "siteType": ["METAR"]},
            {"icaoId": "ABC", "site": "short", "lat": 1, "lon": 1, "siteType": ["METAR"]},
            {"icaoId": "ABCD", "site": "no metar", "lat": 1, "lon": 1, "siteType": ["TAF"]},
            {"icaoId": "ABCE", "site": "bad lat", "lat": 95, "lon": 1, "siteType": ["METAR"]},
            {"icaoId": "ABCF", "site": "nan", "lat": float("nan"), "lon": 1, "siteType": ["METAR"]},
            {"icaoId": "ABCG", "site": "str coords", "lat": "1", "lon": 1, "siteType": ["METAR"]},
            "not a dict",
        ]
        assert parse_awc_stations(rows) == []

    def test_dedupes_and_normalises(self):
        rows = [
            {"icaoId": "vtsp", "site": "", "lat": 8.1, "lon": 98.3, "country": "x", "siteType": ["METAR"]},
            {"icaoId": "VTSP", "site": "dup", "lat": 8.1, "lon": 98.3, "siteType": ["METAR"]},
        ]
        stations = parse_awc_stations(rows)
        assert len(stations) == 1
        assert stations[0]["name"] == "VTSP"  # empty site falls back to the code
        assert stations[0]["country"] is None
        assert stations[0]["iata"] is None

    def test_non_list_payload_is_empty(self):
        assert parse_awc_stations({"error": "x"}) == []


class TestNearestOf:
    def test_ranks_by_distance_within_radius(self):
        stations = parse_awc_stations(PHUKET_STATIONINFO)
        result = nearest_of(stations, 7.89059, 98.3981, count=5, max_distance_km=150)
        assert [a.icao for a in result] == ["VTSP", "VTSG"]
        assert 20 < result[0].distanceKm < 30

    def test_haversine_known_distance(self):
        # Harare → Bulawayo is ~365 km.
        assert 355 < haversine_km(-17.83, 31.05, -20.15, 28.58) < 375


class TestUpsertDiscoveredAirports:
    def test_insert_only_with_provenance_and_geojson(self):
        coll = MagicMock()
        coll.update_one.return_value = MagicMock(upserted_id="VTSP")
        stations = parse_awc_stations(PHUKET_STATIONINFO)
        with patch("py._airports._airports_collection", return_value=coll):
            written = upsert_discovered_airports(stations, 7.89, 98.40)
        assert written == 3
        first_filter, first_update = coll.update_one.call_args_list[0].args
        # Nearest first.
        assert first_filter == {"_id": "VTSP"}
        doc = first_update["$setOnInsert"]
        assert set(first_update) == {"$setOnInsert"}  # never overwrites a seed doc
        assert doc["source"] == DISCOVERED_SOURCE
        assert doc["location"] == {"type": "Point", "coordinates": [98.308, 8.105]}
        assert doc["iata"] == "HKT" and doc["country"] == "TH"
        assert coll.update_one.call_args_list[0].kwargs == {"upsert": True}

    def test_existing_docs_are_not_counted(self):
        coll = MagicMock()
        coll.update_one.return_value = MagicMock(upserted_id=None)
        with patch("py._airports._airports_collection", return_value=coll):
            assert upsert_discovered_airports(parse_awc_stations(PHUKET_STATIONINFO), 8, 98) == 0

    def test_bounded_per_request(self):
        rows = [
            {"icaoId": f"V{chr(65 + i // 26)}{chr(65 + i % 26)}A", "site": "x",
             "lat": 8 + i * 0.01, "lon": 98.0, "siteType": ["METAR"]}
            for i in range(MAX_DISCOVERED_PER_REQUEST + 10)
        ]
        coll = MagicMock()
        coll.update_one.return_value = MagicMock(upserted_id="x")
        with patch("py._airports._airports_collection", return_value=coll):
            written = upsert_discovered_airports(parse_awc_stations(rows), 8, 98)
        assert written == MAX_DISCOVERED_PER_REQUEST

    def test_db_error_never_raises(self):
        with patch("py._airports._airports_collection", side_effect=RuntimeError("down")):
            assert upsert_discovered_airports(parse_awc_stations(PHUKET_STATIONINFO), 8, 98) == 0

    def test_empty_is_noop(self):
        assert upsert_discovered_airports([], 0, 0) == 0
