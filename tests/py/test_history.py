"""Tests for _history.py — historical weather data endpoint."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import patch, MagicMock

import pytest
from fastapi import HTTPException

from py._history import get_history


# ---------------------------------------------------------------------------
# Validation — missing / invalid parameters
# ---------------------------------------------------------------------------


class TestGetHistoryValidation:
    @pytest.mark.asyncio
    async def test_missing_location_raises_400(self):
        """Empty location string should raise a 400 error."""
        with pytest.raises(HTTPException) as exc_info:
            await get_history(location="", days=30)
        assert exc_info.value.status_code == 400
        assert "Missing location" in exc_info.value.detail

    @pytest.mark.asyncio
    async def test_days_below_minimum_raises_400(self):
        """days < 1 should raise a 400 error."""
        with pytest.raises(HTTPException) as exc_info:
            await get_history(location="harare", days=0)
        assert exc_info.value.status_code == 400
        assert "days must be between 1 and 365" in exc_info.value.detail

    @pytest.mark.asyncio
    async def test_days_negative_raises_400(self):
        """Negative days should raise a 400 error."""
        with pytest.raises(HTTPException) as exc_info:
            await get_history(location="harare", days=-5)
        assert exc_info.value.status_code == 400

    @pytest.mark.asyncio
    async def test_days_above_maximum_raises_400(self):
        """days > 365 should raise a 400 error."""
        with pytest.raises(HTTPException) as exc_info:
            await get_history(location="harare", days=366)
        assert exc_info.value.status_code == 400
        assert "days must be between 1 and 365" in exc_info.value.detail

    @pytest.mark.asyncio
    async def test_days_at_lower_boundary_accepted(self):
        """days == 1 should be accepted (within range)."""
        with patch("py._history.locations_collection") as mock_loc:
            mock_loc.return_value.find_one.return_value = {"slug": "harare"}
            with patch("py._history.get_db") as mock_db:
                mock_coll = MagicMock()
                mock_coll.find.return_value.sort.return_value = []
                mock_db.return_value.__getitem__ = MagicMock(return_value=mock_coll)

                result = await get_history(location="harare", days=1)
                assert result["days"] == 1

    @pytest.mark.asyncio
    async def test_days_at_upper_boundary_accepted(self):
        """days == 365 should be accepted (within range)."""
        with patch("py._history.locations_collection") as mock_loc:
            mock_loc.return_value.find_one.return_value = {"slug": "harare"}
            with patch("py._history.get_db") as mock_db:
                mock_coll = MagicMock()
                mock_coll.find.return_value.sort.return_value = []
                mock_db.return_value.__getitem__ = MagicMock(return_value=mock_coll)

                result = await get_history(location="harare", days=365)
                assert result["days"] == 365


# ---------------------------------------------------------------------------
# Location lookup
# ---------------------------------------------------------------------------


class TestGetHistoryLocationLookup:
    @pytest.mark.asyncio
    async def test_unknown_location_raises_404(self):
        """Non-existent location should return 404."""
        with patch("py._history.locations_collection") as mock_loc:
            mock_loc.return_value.find_one.return_value = None

            with pytest.raises(HTTPException) as exc_info:
                await get_history(location="nonexistent", days=30)
            assert exc_info.value.status_code == 404
            assert "Unknown location" in exc_info.value.detail

    @pytest.mark.asyncio
    async def test_location_service_unavailable_raises_503(self):
        """DB error during location lookup should return 503."""
        with patch("py._history.locations_collection") as mock_loc:
            mock_loc.return_value.find_one.side_effect = Exception("DB connection failed")

            with pytest.raises(HTTPException) as exc_info:
                await get_history(location="harare", days=30)
            assert exc_info.value.status_code == 503
            assert "Location service unavailable" in exc_info.value.detail


# ---------------------------------------------------------------------------
# Successful query — response shape and data handling
# ---------------------------------------------------------------------------


class TestGetHistorySuccess:
    @pytest.mark.asyncio
    async def test_successful_query_returns_correct_shape(self):
        """Response should contain location, days, records count, and data array."""
        with patch("py._history.locations_collection") as mock_loc:
            mock_loc.return_value.find_one.return_value = {"slug": "harare"}
            with patch("py._history.get_db") as mock_db:
                sample_records = [
                    {"locationSlug": "harare", "date": "2025-01-15", "current": {"temperature_2m": 28}},
                    {"locationSlug": "harare", "date": "2025-01-14", "current": {"temperature_2m": 26}},
                ]
                mock_coll = MagicMock()
                mock_coll.find.return_value.sort.return_value = sample_records
                mock_db.return_value.__getitem__ = MagicMock(return_value=mock_coll)

                result = await get_history(location="harare", days=30)

                assert result["location"] == "harare"
                assert result["days"] == 30
                assert result["records"] == 2
                assert result["data"] == sample_records

    @pytest.mark.asyncio
    async def test_datetime_serialization(self):
        """datetime objects in recordedAt should be converted to ISO strings."""
        dt = datetime(2025, 1, 15, 12, 0, 0, tzinfo=timezone.utc)
        with patch("py._history.locations_collection") as mock_loc:
            mock_loc.return_value.find_one.return_value = {"slug": "harare"}
            with patch("py._history.get_db") as mock_db:
                sample_records = [
                    {"locationSlug": "harare", "recordedAt": dt, "date": "2025-01-15"},
                ]
                mock_coll = MagicMock()
                mock_coll.find.return_value.sort.return_value = sample_records
                mock_db.return_value.__getitem__ = MagicMock(return_value=mock_coll)

                result = await get_history(location="harare", days=30)

                assert result["data"][0]["recordedAt"] == dt.isoformat()

    @pytest.mark.asyncio
    async def test_non_datetime_recordedAt_not_converted(self):
        """String recordedAt values should not be altered."""
        with patch("py._history.locations_collection") as mock_loc:
            mock_loc.return_value.find_one.return_value = {"slug": "harare"}
            with patch("py._history.get_db") as mock_db:
                sample_records = [
                    {"locationSlug": "harare", "recordedAt": "2025-01-15T12:00:00+00:00"},
                ]
                mock_coll = MagicMock()
                mock_coll.find.return_value.sort.return_value = sample_records
                mock_db.return_value.__getitem__ = MagicMock(return_value=mock_coll)

                result = await get_history(location="harare", days=30)

                assert result["data"][0]["recordedAt"] == "2025-01-15T12:00:00+00:00"

    @pytest.mark.asyncio
    async def test_results_sorted_descending(self):
        """History query should sort by recordedAt descending (-1)."""
        with patch("py._history.locations_collection") as mock_loc:
            mock_loc.return_value.find_one.return_value = {"slug": "harare"}
            with patch("py._history.get_db") as mock_db:
                mock_coll = MagicMock()
                mock_coll.find.return_value.sort.return_value = []
                mock_db.return_value.__getitem__ = MagicMock(return_value=mock_coll)

                await get_history(location="harare", days=30)

                # Verify sort was called with recordedAt descending
                mock_coll.find.return_value.sort.assert_called_once_with("recordedAt", -1)

    @pytest.mark.asyncio
    async def test_empty_history_returns_zero_records(self):
        """When no records exist, return empty data with records=0."""
        with patch("py._history.locations_collection") as mock_loc:
            mock_loc.return_value.find_one.return_value = {"slug": "harare"}
            with patch("py._history.get_db") as mock_db:
                mock_coll = MagicMock()
                mock_coll.find.return_value.sort.return_value = []
                mock_db.return_value.__getitem__ = MagicMock(return_value=mock_coll)

                result = await get_history(location="harare", days=30)

                assert result["records"] == 0
                assert result["data"] == []

    @pytest.mark.asyncio
    async def test_default_days_parameter(self):
        """Default days parameter should be 30."""
        with patch("py._history.locations_collection") as mock_loc:
            mock_loc.return_value.find_one.return_value = {"slug": "harare"}
            with patch("py._history.get_db") as mock_db:
                mock_coll = MagicMock()
                mock_coll.find.return_value.sort.return_value = []
                mock_db.return_value.__getitem__ = MagicMock(return_value=mock_coll)

                result = await get_history(location="harare")

                assert result["days"] == 30


# ---------------------------------------------------------------------------
# DB fetch errors
# ---------------------------------------------------------------------------


class TestGetHistoryDBErrors:
    @pytest.mark.asyncio
    async def test_db_fetch_error_raises_502(self):
        """Exception during weather_history query should return 502."""
        with patch("py._history.locations_collection") as mock_loc:
            mock_loc.return_value.find_one.return_value = {"slug": "harare"}
            with patch("py._history.get_db") as mock_db:
                mock_db.side_effect = Exception("Database timeout")

                with pytest.raises(HTTPException) as exc_info:
                    await get_history(location="harare", days=30)
                assert exc_info.value.status_code == 502
                assert "Failed to fetch weather history" in exc_info.value.detail

    @pytest.mark.asyncio
    async def test_db_find_error_raises_502(self):
        """Exception during find() call should return 502."""
        with patch("py._history.locations_collection") as mock_loc:
            mock_loc.return_value.find_one.return_value = {"slug": "harare"}
            with patch("py._history.get_db") as mock_db:
                mock_coll = MagicMock()
                mock_coll.find.side_effect = Exception("Query failed")
                mock_db.return_value.__getitem__ = MagicMock(return_value=mock_coll)

                with pytest.raises(HTTPException) as exc_info:
                    await get_history(location="harare", days=30)
                assert exc_info.value.status_code == 502
