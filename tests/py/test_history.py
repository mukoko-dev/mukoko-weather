"""Tests for _history.py — historical weather data endpoint."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import patch, MagicMock

import pytest
from fastapi import HTTPException

from py._history import get_history, history_slugs

HARARE = {"slug": "harare", "lat": -17.8292, "lon": 31.0522, "platformSlug": "harare-35c223"}


class _Started:
    """Patch the endpoint's collaborators for the duration of a with-block."""

    def __init__(self, loc=HARARE, read=None, backfill=None):
        self._ps = {
            "find_location": patch("py._history.find_location", return_value=loc),
            "read_history": patch("py._history.read_history", return_value=read if read is not None else []),
            "backfill_history": patch("py._history.backfill_history", return_value=backfill or []),
            "_get_http_client": patch("py._history._get_http_client", return_value=MagicMock()),
        }
        self.m: dict = {}

    def __enter__(self):
        self.m = {k: p.start() for k, p in self._ps.items()}
        return self.m

    def __exit__(self, *exc):
        for p in self._ps.values():
            p.stop()


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


class TestGetHistoryValidation:
    @pytest.mark.asyncio
    async def test_missing_location_raises_400(self):
        with pytest.raises(HTTPException) as exc_info:
            await get_history(location="", days=30)
        assert exc_info.value.status_code == 400
        assert "Missing location" in exc_info.value.detail

    @pytest.mark.asyncio
    @pytest.mark.parametrize("days", [0, -5, 366])
    async def test_days_out_of_range_raises_400(self, days):
        with pytest.raises(HTTPException) as exc_info:
            await get_history(location="harare", days=days)
        assert exc_info.value.status_code == 400
        assert "days must be between 1 and 365" in exc_info.value.detail

    @pytest.mark.asyncio
    @pytest.mark.parametrize("days", [1, 365])
    async def test_days_boundaries_accepted(self, days):
        with _Started():
            result = await get_history(location="harare", days=days)
        assert result["days"] == days

    @pytest.mark.asyncio
    async def test_default_days_parameter(self):
        with _Started():
            result = await get_history(location="harare")
        assert result["days"] == 30


# ---------------------------------------------------------------------------
# Location lookup
# ---------------------------------------------------------------------------


class TestGetHistoryLocationLookup:
    @pytest.mark.asyncio
    async def test_unknown_location_raises_404(self):
        with _Started(loc=None):
            with pytest.raises(HTTPException) as exc_info:
                await get_history(location="nonexistent", days=30)
        assert exc_info.value.status_code == 404
        assert "Unknown location" in exc_info.value.detail

    @pytest.mark.asyncio
    async def test_location_service_unavailable_raises_503(self):
        with patch("py._history.find_location", side_effect=Exception("DB down")):
            with pytest.raises(HTTPException) as exc_info:
                await get_history(location="harare", days=30)
        assert exc_info.value.status_code == 503

    def test_history_slugs_include_platform_alias(self):
        assert history_slugs("harare", HARARE) == ["harare", "harare-35c223"]

    def test_history_slugs_without_alias(self):
        assert history_slugs("harare", {"slug": "harare"}) == ["harare"]


# ---------------------------------------------------------------------------
# Success + backfill wiring
# ---------------------------------------------------------------------------


class TestGetHistorySuccess:
    @pytest.mark.asyncio
    async def test_response_shape(self):
        recs = [
            {"locationSlug": "harare", "date": "2026-10-09", "source": "recorded", "current": {}},
            {"locationSlug": "harare", "date": "2026-10-08", "source": "recorded", "current": {}},
        ]
        with _Started(read=recs) as m:
            result = await get_history(location="harare", days=30)
        assert result["location"] == "harare"
        assert result["records"] == 2
        assert result["backfilled"] == 0
        assert result["data"] == recs
        # Reads the canonical slug AND the platform alias older writes used.
        args, _ = m["read_history"].call_args
        assert args[0] == ["harare", "harare-35c223"]
        assert args[1] == 30

    @pytest.mark.asyncio
    async def test_backfill_receives_existing_dates_and_location(self):
        recs = [{"locationSlug": "harare", "date": "2026-10-09", "current": {}}]
        with _Started(read=recs) as m:
            await get_history(location="harare", days=30)
        args, kwargs = m["backfill_history"].call_args
        assert args[0] == "harare"
        assert args[1] == pytest.approx(-17.8292)
        assert args[2] == pytest.approx(31.0522)
        assert args[3] == 30
        assert args[4] == ["2026-10-09"]
        assert kwargs["rate_limiter"] is not None
        assert kwargs["breaker"] is not None

    @pytest.mark.asyncio
    async def test_backfilled_days_merged_newest_first(self):
        recs = [{"locationSlug": "harare", "date": "2026-10-09", "source": "recorded", "current": {}}]
        when = datetime(2026, 10, 10, tzinfo=timezone.utc)
        filled = [
            {"locationSlug": "harare", "date": "2026-10-07", "source": "open-meteo-archive", "current": {}, "recordedAt": when},
            {"locationSlug": "harare", "date": "2026-10-08", "source": "open-meteo-archive", "current": {}, "recordedAt": when},
        ]
        with _Started(read=recs, backfill=filled):
            result = await get_history(location="harare", days=30)
        assert [d["date"] for d in result["data"]] == ["2026-10-09", "2026-10-08", "2026-10-07"]
        assert result["backfilled"] == 2
        assert result["records"] == 3
        assert isinstance(result["data"][1]["recordedAt"], str)  # JSON-safe

    @pytest.mark.asyncio
    async def test_no_coordinates_skips_backfill(self):
        with _Started(loc={"slug": "harare"}) as m:
            await get_history(location="harare", days=30)
        m["backfill_history"].assert_not_called()

    @pytest.mark.asyncio
    async def test_read_error_raises_502(self):
        with _Started() as m:
            m["read_history"].side_effect = Exception("timeout")
            with pytest.raises(HTTPException) as exc_info:
                await get_history(location="harare", days=30)
        assert exc_info.value.status_code == 502
        assert "Failed to fetch weather history" in exc_info.value.detail
