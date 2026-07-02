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
