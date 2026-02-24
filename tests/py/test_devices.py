"""Tests for _devices.py — device profile CRUD, validation helpers."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import patch, MagicMock

import pytest
from fastapi import HTTPException

from py._devices import (
    VALID_THEMES,
    MAX_ACTIVITIES,
    MAX_SAVED_LOCATIONS,
    SLUG_RE,
    _validate_theme,
    _validate_slug,
    _validate_activities,
    _validate_saved_locations,
    _doc_to_response,
    create_device,
    get_device,
    update_preferences,
    CreateDeviceRequest,
    UpdatePreferencesRequest,
    Preferences,
)
from pymongo.errors import DuplicateKeyError


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------


class TestConstants:
    def test_valid_themes_contains_expected(self):
        assert "light" in VALID_THEMES
        assert "dark" in VALID_THEMES
        assert "system" in VALID_THEMES

    def test_valid_themes_has_exactly_three(self):
        assert len(VALID_THEMES) == 3

    def test_slug_regex_accepts_valid(self):
        assert SLUG_RE.match("harare")
        assert SLUG_RE.match("victoria-falls")
        assert SLUG_RE.match("a" * 80)

    def test_slug_regex_rejects_invalid(self):
        assert SLUG_RE.match("Harare") is None
        assert SLUG_RE.match("has space") is None
        assert SLUG_RE.match("a" * 81) is None
        assert SLUG_RE.match("") is None


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------


class TestValidateTheme:
    def test_valid_themes_pass(self):
        for theme in ("light", "dark", "system"):
            assert _validate_theme(theme) == theme

    def test_invalid_theme_raises_400(self):
        with pytest.raises(HTTPException) as exc_info:
            _validate_theme("invalid")
        assert exc_info.value.status_code == 400
        assert "Invalid theme" in exc_info.value.detail

    def test_empty_string_raises_400(self):
        with pytest.raises(HTTPException):
            _validate_theme("")


class TestValidateSlug:
    def test_valid_slugs_pass(self):
        assert _validate_slug("harare") == "harare"
        assert _validate_slug("victoria-falls") == "victoria-falls"
        assert _validate_slug("a1b2") == "a1b2"

    def test_invalid_slug_raises_400(self):
        with pytest.raises(HTTPException) as exc_info:
            _validate_slug("INVALID")
        assert exc_info.value.status_code == 400
        assert "Invalid location slug" in exc_info.value.detail

    def test_empty_slug_raises_400(self):
        with pytest.raises(HTTPException):
            _validate_slug("")

    def test_slug_with_spaces_raises_400(self):
        with pytest.raises(HTTPException):
            _validate_slug("has space")

    def test_slug_too_long_raises_400(self):
        with pytest.raises(HTTPException):
            _validate_slug("a" * 81)


class TestValidateActivities:
    def test_under_max_passes(self):
        activities = ["running", "cycling"]
        assert _validate_activities(activities) == activities

    def test_empty_list_passes(self):
        assert _validate_activities([]) == []

    def test_at_max_passes(self):
        activities = [f"act-{i}" for i in range(MAX_ACTIVITIES)]
        assert _validate_activities(activities) == activities

    def test_over_max_raises_400(self):
        activities = [f"act-{i}" for i in range(MAX_ACTIVITIES + 1)]
        with pytest.raises(HTTPException) as exc_info:
            _validate_activities(activities)
        assert exc_info.value.status_code == 400
        assert "Too many activities" in exc_info.value.detail


class TestValidateSavedLocations:
    def test_empty_list_passes(self):
        assert _validate_saved_locations([]) == []

    def test_valid_slugs_pass(self):
        locs = ["harare", "bulawayo", "singapore-sg"]
        assert _validate_saved_locations(locs) == locs

    def test_at_max_passes(self):
        locs = [f"loc-{i}" for i in range(MAX_SAVED_LOCATIONS)]
        assert _validate_saved_locations(locs) == locs

    def test_over_max_raises_400(self):
        locs = [f"loc-{i}" for i in range(MAX_SAVED_LOCATIONS + 1)]
        with pytest.raises(HTTPException) as exc_info:
            _validate_saved_locations(locs)
        assert exc_info.value.status_code == 400
        assert "Too many saved locations" in exc_info.value.detail

    def test_invalid_slug_raises_400(self):
        with pytest.raises(HTTPException) as exc_info:
            _validate_saved_locations(["INVALID SLUG"])
        assert exc_info.value.status_code == 400
        assert "Invalid location slug" in exc_info.value.detail


# ---------------------------------------------------------------------------
# _doc_to_response
# ---------------------------------------------------------------------------


class TestDocToResponse:
    def test_converts_full_document(self):
        now = datetime.now(timezone.utc)
        doc = {
            "deviceId": "abc-123",
            "preferences": {
                "theme": "dark",
                "selectedLocation": "bulawayo",
                "selectedActivities": ["running"],
                "hasOnboarded": True,
            },
            "createdAt": now,
            "updatedAt": now,
        }
        resp = _doc_to_response(doc)
        assert resp.deviceId == "abc-123"
        assert resp.preferences.theme == "dark"
        assert resp.preferences.selectedLocation == "bulawayo"
        assert resp.preferences.selectedActivities == ["running"]
        assert resp.preferences.hasOnboarded is True
        assert resp.createdAt == now.isoformat()
        assert resp.updatedAt == now.isoformat()

    def test_defaults_missing_preferences(self):
        doc = {
            "deviceId": "def-456",
            "preferences": {},
            "createdAt": datetime.now(timezone.utc),
            "updatedAt": datetime.now(timezone.utc),
        }
        resp = _doc_to_response(doc)
        assert resp.preferences.theme == "system"
        assert resp.preferences.selectedLocation == "harare"
        assert resp.preferences.selectedActivities == []
        assert resp.preferences.hasOnboarded is False

    def test_handles_missing_timestamps(self):
        doc = {
            "deviceId": "ghi-789",
            "preferences": {"theme": "light"},
        }
        resp = _doc_to_response(doc)
        assert resp.deviceId == "ghi-789"
        # Should have ISO format timestamps (from datetime.now fallback)
        assert "T" in resp.createdAt
        assert "T" in resp.updatedAt


# ---------------------------------------------------------------------------
# create_device endpoint
# ---------------------------------------------------------------------------


class TestCreateDevice:
    @pytest.fixture(autouse=True)
    def _reset_indexes(self):
        """Reset the _indexes_ensured flag between tests."""
        import py._devices as mod
        mod._indexes_ensured = False
        yield
        mod._indexes_ensured = False

    @patch("py._devices.device_profiles_collection")
    @pytest.mark.asyncio
    async def test_generates_uuid_if_none_provided(self, mock_coll):
        mock_coll.return_value.insert_one.return_value = None
        mock_coll.return_value.create_index.return_value = None

        body = CreateDeviceRequest(preferences=Preferences())
        result = await create_device(body)
        assert result.deviceId  # Should be a non-empty string (UUID)
        assert len(result.deviceId) == 36  # UUID format

    @patch("py._devices.device_profiles_collection")
    @pytest.mark.asyncio
    async def test_uses_provided_device_id(self, mock_coll):
        mock_coll.return_value.insert_one.return_value = None
        mock_coll.return_value.create_index.return_value = None

        body = CreateDeviceRequest(
            deviceId="my-custom-id",
            preferences=Preferences(theme="dark", selectedLocation="bulawayo"),
        )
        result = await create_device(body)
        assert result.deviceId == "my-custom-id"
        assert result.preferences.theme == "dark"
        assert result.preferences.selectedLocation == "bulawayo"

    @patch("py._devices.device_profiles_collection")
    @pytest.mark.asyncio
    async def test_validates_theme_on_create(self, mock_coll):
        mock_coll.return_value.create_index.return_value = None
        body = CreateDeviceRequest(
            preferences=Preferences(theme="invalid"),
        )
        with pytest.raises(HTTPException) as exc_info:
            await create_device(body)
        assert exc_info.value.status_code == 400

    @patch("py._devices.device_profiles_collection")
    @pytest.mark.asyncio
    async def test_validates_slug_on_create(self, mock_coll):
        mock_coll.return_value.create_index.return_value = None
        body = CreateDeviceRequest(
            preferences=Preferences(selectedLocation="INVALID SLUG"),
        )
        with pytest.raises(HTTPException) as exc_info:
            await create_device(body)
        assert exc_info.value.status_code == 400

    @patch("py._devices.device_profiles_collection")
    @pytest.mark.asyncio
    async def test_validates_activities_on_create(self, mock_coll):
        mock_coll.return_value.create_index.return_value = None
        body = CreateDeviceRequest(
            preferences=Preferences(
                selectedActivities=[f"act-{i}" for i in range(MAX_ACTIVITIES + 1)]
            ),
        )
        with pytest.raises(HTTPException) as exc_info:
            await create_device(body)
        assert exc_info.value.status_code == 400

    @patch("py._devices.device_profiles_collection")
    @pytest.mark.asyncio
    async def test_handles_duplicate_key_returns_existing(self, mock_coll):
        mock_coll.return_value.create_index.return_value = None
        mock_coll.return_value.insert_one.side_effect = DuplicateKeyError("dup")

        now = datetime.now(timezone.utc)
        mock_coll.return_value.find_one.return_value = {
            "deviceId": "dup-id",
            "preferences": {"theme": "dark"},
            "createdAt": now,
            "updatedAt": now,
        }

        body = CreateDeviceRequest(deviceId="dup-id")
        result = await create_device(body)
        assert result.deviceId == "dup-id"
        assert result.preferences.theme == "dark"

    @patch("py._devices.device_profiles_collection")
    @pytest.mark.asyncio
    async def test_handles_duplicate_key_no_existing_raises_409(self, mock_coll):
        mock_coll.return_value.create_index.return_value = None
        mock_coll.return_value.insert_one.side_effect = DuplicateKeyError("dup")
        mock_coll.return_value.find_one.return_value = None

        body = CreateDeviceRequest(deviceId="dup-id")
        with pytest.raises(HTTPException) as exc_info:
            await create_device(body)
        assert exc_info.value.status_code == 409


# ---------------------------------------------------------------------------
# get_device endpoint
# ---------------------------------------------------------------------------


class TestGetDevice:
    @patch("py._devices.device_profiles_collection")
    @pytest.mark.asyncio
    async def test_returns_device(self, mock_coll):
        now = datetime.now(timezone.utc)
        mock_coll.return_value.find_one.return_value = {
            "deviceId": "abc-123",
            "preferences": {"theme": "light", "selectedLocation": "harare"},
            "createdAt": now,
            "updatedAt": now,
        }
        result = await get_device("abc-123")
        assert result.deviceId == "abc-123"
        assert result.preferences.theme == "light"

    @patch("py._devices.device_profiles_collection")
    @pytest.mark.asyncio
    async def test_returns_404_if_not_found(self, mock_coll):
        mock_coll.return_value.find_one.return_value = None
        with pytest.raises(HTTPException) as exc_info:
            await get_device("nonexistent")
        assert exc_info.value.status_code == 404


# ---------------------------------------------------------------------------
# update_preferences endpoint
# ---------------------------------------------------------------------------


class TestUpdatePreferences:
    @patch("py._devices.device_profiles_collection")
    @pytest.mark.asyncio
    async def test_partial_theme_update(self, mock_coll):
        now = datetime.now(timezone.utc)
        mock_coll.return_value.find_one_and_update.return_value = {
            "deviceId": "abc-123",
            "preferences": {"theme": "dark", "selectedLocation": "harare"},
            "createdAt": now,
            "updatedAt": now,
        }
        body = UpdatePreferencesRequest(theme="dark")
        result = await update_preferences("abc-123", body)
        assert result.preferences.theme == "dark"

    @patch("py._devices.device_profiles_collection")
    @pytest.mark.asyncio
    async def test_partial_location_update(self, mock_coll):
        now = datetime.now(timezone.utc)
        mock_coll.return_value.find_one_and_update.return_value = {
            "deviceId": "abc-123",
            "preferences": {"theme": "system", "selectedLocation": "bulawayo"},
            "createdAt": now,
            "updatedAt": now,
        }
        body = UpdatePreferencesRequest(selectedLocation="bulawayo")
        result = await update_preferences("abc-123", body)
        assert result.preferences.selectedLocation == "bulawayo"

    @patch("py._devices.device_profiles_collection")
    @pytest.mark.asyncio
    async def test_partial_activities_update(self, mock_coll):
        now = datetime.now(timezone.utc)
        mock_coll.return_value.find_one_and_update.return_value = {
            "deviceId": "abc-123",
            "preferences": {
                "theme": "system",
                "selectedLocation": "harare",
                "selectedActivities": ["running", "cycling"],
            },
            "createdAt": now,
            "updatedAt": now,
        }
        body = UpdatePreferencesRequest(selectedActivities=["running", "cycling"])
        result = await update_preferences("abc-123", body)
        assert result.preferences.selectedActivities == ["running", "cycling"]

    @patch("py._devices.device_profiles_collection")
    @pytest.mark.asyncio
    async def test_partial_onboarded_update(self, mock_coll):
        now = datetime.now(timezone.utc)
        mock_coll.return_value.find_one_and_update.return_value = {
            "deviceId": "abc-123",
            "preferences": {"theme": "system", "hasOnboarded": True},
            "createdAt": now,
            "updatedAt": now,
        }
        body = UpdatePreferencesRequest(hasOnboarded=True)
        result = await update_preferences("abc-123", body)
        assert result.preferences.hasOnboarded is True

    @pytest.mark.asyncio
    async def test_no_fields_raises_400(self):
        body = UpdatePreferencesRequest()
        with pytest.raises(HTTPException) as exc_info:
            await update_preferences("abc-123", body)
        assert exc_info.value.status_code == 400
        assert "No fields to update" in exc_info.value.detail

    @patch("py._devices.device_profiles_collection")
    @pytest.mark.asyncio
    async def test_device_not_found_raises_404(self, mock_coll):
        mock_coll.return_value.find_one_and_update.return_value = None
        body = UpdatePreferencesRequest(theme="dark")
        with pytest.raises(HTTPException) as exc_info:
            await update_preferences("nonexistent", body)
        assert exc_info.value.status_code == 404

    @patch("py._devices.device_profiles_collection")
    @pytest.mark.asyncio
    async def test_invalid_theme_raises_400(self, mock_coll):
        body = UpdatePreferencesRequest(theme="invalid")
        with pytest.raises(HTTPException) as exc_info:
            await update_preferences("abc-123", body)
        assert exc_info.value.status_code == 400

    @patch("py._devices.device_profiles_collection")
    @pytest.mark.asyncio
    async def test_invalid_slug_raises_400(self, mock_coll):
        body = UpdatePreferencesRequest(selectedLocation="INVALID")
        with pytest.raises(HTTPException) as exc_info:
            await update_preferences("abc-123", body)
        assert exc_info.value.status_code == 400

    @patch("py._devices.device_profiles_collection")
    @pytest.mark.asyncio
    async def test_too_many_activities_raises_400(self, mock_coll):
        body = UpdatePreferencesRequest(
            selectedActivities=[f"act-{i}" for i in range(MAX_ACTIVITIES + 1)]
        )
        with pytest.raises(HTTPException) as exc_info:
            await update_preferences("abc-123", body)
        assert exc_info.value.status_code == 400

    @patch("py._devices.device_profiles_collection")
    @pytest.mark.asyncio
    async def test_saved_locations_update(self, mock_coll):
        now = datetime.now(timezone.utc)
        mock_coll.return_value.find_one_and_update.return_value = {
            "deviceId": "abc-123",
            "preferences": {
                "theme": "system",
                "selectedLocation": "harare",
                "savedLocations": ["bulawayo", "mutare"],
                "selectedActivities": [],
            },
            "createdAt": now,
            "updatedAt": now,
        }
        body = UpdatePreferencesRequest(savedLocations=["bulawayo", "mutare"])
        result = await update_preferences("abc-123", body)
        assert result.preferences.savedLocations == ["bulawayo", "mutare"]

    @patch("py._devices.device_profiles_collection")
    @pytest.mark.asyncio
    async def test_too_many_saved_locations_raises_400(self, mock_coll):
        body = UpdatePreferencesRequest(
            savedLocations=[f"loc-{i}" for i in range(MAX_SAVED_LOCATIONS + 1)]
        )
        with pytest.raises(HTTPException) as exc_info:
            await update_preferences("abc-123", body)
        assert exc_info.value.status_code == 400
