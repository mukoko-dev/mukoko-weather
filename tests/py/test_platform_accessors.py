"""
Tests for the Phase 0B multi-database accessors in ``api/py/_db.py``.

Covers:
  * Each platform DB accessor returns a Database object via the right name.
  * Each collection accessor returns a Collection from the correct DB.
  * ``stamp_platform_fields`` stamps _schemaVersion / bundu / createdAt /
    updatedAt and respects opts.
  * Legacy accessors keep working after the refactor.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

import py._db as db


# ---------------------------------------------------------------------------
# Shared mock client setup
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_client(monkeypatch):
    """Replace the module-level _client with a MagicMock for each test."""
    monkeypatch.setenv("MONGODB_URI", "mongodb://localhost:27017/ignored")
    fake = MagicMock()
    monkeypatch.setattr(db, "_client", fake)
    yield fake


# ---------------------------------------------------------------------------
# Multi-DB accessors
# ---------------------------------------------------------------------------


class TestPlatformDatabaseAccessors:
    """Each *_db() function targets the correct Nyuchi platform DB name."""

    @pytest.mark.parametrize(
        "fn,expected_name",
        [
            (db.weather_db, "weather"),
            (db.places_db, "places"),
            (db.identity_db, "identity"),
            (db.shamwari_db, "shamwari"),
            (db.device_db, "device"),
            (db.integrations_db, "integrations"),
        ],
    )
    def test_returns_correct_database(self, _reset_client, fn, expected_name):
        fn()
        _reset_client.get_database.assert_called_with(expected_name)

    def test_get_db_is_aliased_to_weather_db(self, _reset_client):
        """Backward-compat get_db() should return the `weather` database."""
        db.get_db()
        _reset_client.get_database.assert_called_with("weather")


# ---------------------------------------------------------------------------
# Collection accessors — verify each returns a Collection from the right DB
# ---------------------------------------------------------------------------


class TestCollectionAccessors:
    """Spot-check that each accessor reaches into the correct DB+name."""

    def test_weather_cache_uses_weather_db(self, _reset_client):
        weather_db_mock = MagicMock()
        _reset_client.get_database.return_value = weather_db_mock

        db.weather_cache_collection()

        _reset_client.get_database.assert_called_with("weather")
        weather_db_mock.__getitem__.assert_called_with("weather_cache")

    def test_stations_uses_weather_db(self, _reset_client):
        weather_db_mock = MagicMock()
        _reset_client.get_database.return_value = weather_db_mock

        db.stations_collection()

        _reset_client.get_database.assert_called_with("weather")
        weather_db_mock.__getitem__.assert_called_with("stations")

    def test_observations_uses_weather_db(self, _reset_client):
        weather_db_mock = MagicMock()
        _reset_client.get_database.return_value = weather_db_mock

        db.observations_collection()

        _reset_client.get_database.assert_called_with("weather")
        weather_db_mock.__getitem__.assert_called_with("observations")

    def test_alerts_uses_weather_db(self, _reset_client):
        weather_db_mock = MagicMock()
        _reset_client.get_database.return_value = weather_db_mock

        db.alerts_collection()

        _reset_client.get_database.assert_called_with("weather")
        weather_db_mock.__getitem__.assert_called_with("alerts")

    def test_community_reports_uses_weather_db_camelcase(self, _reset_client):
        weather_db_mock = MagicMock()
        _reset_client.get_database.return_value = weather_db_mock

        db.community_reports_collection()

        _reset_client.get_database.assert_called_with("weather")
        # Camel-cased per platform conventions
        weather_db_mock.__getitem__.assert_called_with("communityReports")

    def test_places_uses_places_db(self, _reset_client):
        places_db_mock = MagicMock()
        _reset_client.get_database.return_value = places_db_mock

        db.places_collection()

        _reset_client.get_database.assert_called_with("places")
        places_db_mock.__getitem__.assert_called_with("places")

    def test_places_geo_uses_places_db_camelcase(self, _reset_client):
        places_db_mock = MagicMock()
        _reset_client.get_database.return_value = places_db_mock

        db.places_geo_collection()

        _reset_client.get_database.assert_called_with("places")
        places_db_mock.__getitem__.assert_called_with("placesGeo")

    def test_persons_uses_identity_db(self, _reset_client):
        identity_db_mock = MagicMock()
        _reset_client.get_database.return_value = identity_db_mock

        db.persons_collection()

        _reset_client.get_database.assert_called_with("identity")
        identity_db_mock.__getitem__.assert_called_with("persons")

    def test_credentials_uses_identity_db(self, _reset_client):
        identity_db_mock = MagicMock()
        _reset_client.get_database.return_value = identity_db_mock

        db.credentials_collection()

        _reset_client.get_database.assert_called_with("identity")
        identity_db_mock.__getitem__.assert_called_with("credentials")

    def test_activity_log_uses_identity_db_camelcase(self, _reset_client):
        identity_db_mock = MagicMock()
        _reset_client.get_database.return_value = identity_db_mock

        db.activity_log_collection()

        _reset_client.get_database.assert_called_with("identity")
        identity_db_mock.__getitem__.assert_called_with("activityLog")

    def test_conversations_uses_shamwari_db(self, _reset_client):
        sham_mock = MagicMock()
        _reset_client.get_database.return_value = sham_mock

        db.conversations_collection()

        _reset_client.get_database.assert_called_with("shamwari")
        sham_mock.__getitem__.assert_called_with("conversations")

    def test_messages_uses_shamwari_db(self, _reset_client):
        sham_mock = MagicMock()
        _reset_client.get_database.return_value = sham_mock

        db.messages_collection()

        _reset_client.get_database.assert_called_with("shamwari")
        sham_mock.__getitem__.assert_called_with("messages")

    def test_guardrails_uses_shamwari_db(self, _reset_client):
        sham_mock = MagicMock()
        _reset_client.get_database.return_value = sham_mock

        db.guardrails_collection()

        _reset_client.get_database.assert_called_with("shamwari")
        sham_mock.__getitem__.assert_called_with("guardrails")

    def test_devices_uses_device_db(self, _reset_client):
        dev_mock = MagicMock()
        _reset_client.get_database.return_value = dev_mock

        db.devices_collection()

        _reset_client.get_database.assert_called_with("device")
        dev_mock.__getitem__.assert_called_with("devices")

    def test_device_profiles_now_lives_in_device_db(self, _reset_client):
        """Legacy device_profiles should now resolve to the platform `device` DB."""
        dev_mock = MagicMock()
        _reset_client.get_database.return_value = dev_mock

        db.device_profiles_collection()

        _reset_client.get_database.assert_called_with("device")
        dev_mock.__getitem__.assert_called_with("device_profiles")

    def test_provider_configurations_uses_integrations_db(self, _reset_client):
        intg_mock = MagicMock()
        _reset_client.get_database.return_value = intg_mock

        db.provider_configurations_collection()

        _reset_client.get_database.assert_called_with("integrations")
        intg_mock.__getitem__.assert_called_with("providerConfigurations")


# ---------------------------------------------------------------------------
# Legacy accessors keep working (now routed via `weather` DB)
# ---------------------------------------------------------------------------


class TestLegacyAccessorsRouteToWeatherDb:
    @pytest.mark.parametrize(
        "fn,expected_collection",
        [
            (db.locations_collection, "locations"),
            (db.weather_cache_collection, "weather_cache"),
            (db.ai_summaries_collection, "ai_summaries"),
            (db.activities_collection, "activities"),
            (db.suitability_rules_collection, "suitability_rules"),
            (db.rate_limits_collection, "rate_limits"),
            (db.api_keys_collection, "api_keys"),
            (db.tags_collection, "tags"),
            (db.ai_prompts_collection, "ai_prompts"),
            (db.ai_suggested_rules_collection, "ai_suggested_rules"),
            (db.weather_reports_collection, "weather_reports"),
            (db.history_analysis_collection, "history_analysis"),
            (db.metar_cache_collection, "metar_cache"),
        ],
    )
    def test_routes_to_weather_db(self, _reset_client, fn, expected_collection):
        weather_db_mock = MagicMock()
        _reset_client.get_database.return_value = weather_db_mock

        fn()

        _reset_client.get_database.assert_called_with("weather")
        weather_db_mock.__getitem__.assert_called_with(expected_collection)


# ---------------------------------------------------------------------------
# stamp_platform_fields
# ---------------------------------------------------------------------------


class TestStampPlatformFields:
    def test_adds_all_required_fields(self):
        result = db.stamp_platform_fields({})
        assert "_id" in result
        assert isinstance(result["_id"], str)
        assert len(result["_id"]) > 0
        assert result["_schemaVersion"] == "v3.1"
        assert isinstance(result["createdAt"], datetime)
        assert isinstance(result["updatedAt"], datetime)
        assert result["bundu"] == {"countryCode": "ZW"}

    def test_default_country_code_is_zw(self):
        result = db.stamp_platform_fields({})
        assert result["bundu"]["countryCode"] == "ZW"

    def test_respects_country_code_opt(self):
        result = db.stamp_platform_fields({}, country_code="KE")
        assert result["bundu"]["countryCode"] == "KE"

    def test_includes_province_slug_when_given(self):
        result = db.stamp_platform_fields(
            {}, country_code="ZW", province_slug="harare"
        )
        assert result["bundu"]["countryCode"] == "ZW"
        assert result["bundu"]["provinceSlug"] == "harare"

    def test_omits_province_slug_when_absent(self):
        result = db.stamp_platform_fields({})
        assert "provinceSlug" not in result["bundu"]

    def test_preserves_existing_id(self):
        result = db.stamp_platform_fields({"_id": "abc-123"})
        assert result["_id"] == "abc-123"

    def test_preserves_existing_schema_version(self):
        result = db.stamp_platform_fields({"_schemaVersion": "v3.2"})
        assert result["_schemaVersion"] == "v3.2"

    def test_preserves_existing_created_at(self):
        original = datetime(2024, 1, 1, tzinfo=timezone.utc)
        result = db.stamp_platform_fields({"createdAt": original})
        assert result["createdAt"] == original

    def test_always_updates_updated_at(self):
        original = datetime(2024, 1, 1, tzinfo=timezone.utc)
        result = db.stamp_platform_fields({"updatedAt": original})
        # updatedAt is always overwritten
        assert result["updatedAt"] != original
        assert result["updatedAt"].tzinfo == timezone.utc

    def test_preserves_existing_bundu_country_code(self):
        result = db.stamp_platform_fields(
            {"bundu": {"countryCode": "TZ"}}, country_code="ZW"
        )
        assert result["bundu"]["countryCode"] == "TZ"

    def test_preserves_existing_bundu_fields(self):
        result = db.stamp_platform_fields(
            {"bundu": {"verificationTier": 2, "trustSignals": ["caretaker"]}},
            country_code="ZW",
        )
        assert result["bundu"]["countryCode"] == "ZW"
        assert result["bundu"]["verificationTier"] == 2
        assert result["bundu"]["trustSignals"] == ["caretaker"]

    def test_returns_same_doc_mutated(self):
        doc: dict = {"name": "test"}
        result = db.stamp_platform_fields(doc)
        assert result is doc  # Same object, mutated
        assert doc["_schemaVersion"] == "v3.1"
        assert doc["name"] == "test"

    def test_generates_unique_ids(self):
        a = db.stamp_platform_fields({})
        b = db.stamp_platform_fields({})
        assert a["_id"] != b["_id"]

    def test_uses_utc_timestamps(self):
        result = db.stamp_platform_fields({})
        assert result["createdAt"].tzinfo == timezone.utc
        assert result["updatedAt"].tzinfo == timezone.utc
