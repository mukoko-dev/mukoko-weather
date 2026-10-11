"""Tests for _history.py — historical weather data endpoint (DB first, #268)."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from py._history import (
    COORD_BACKFILL_RATE_LIMIT,
    COORD_MAX_RANGE_DAYS,
    get_history,
    history_slugs,
    resolve_range,
)
from py._history_store import MAX_RANGE_DAYS, local_today

HARARE = {"slug": "harare", "lat": -17.8292, "lon": 31.0522, "platformSlug": "harare-35c223"}


class _Started:
    """Patch the endpoint's collaborators for the duration of a with-block."""

    def __init__(self, loc=HARARE, read=None, backfill=None, find_exc=None):
        find = (
            patch("py._history.find_location", side_effect=find_exc)
            if find_exc
            else patch("py._history.find_location", return_value=loc)
        )
        self._ps = {
            "find_location": find,
            "read_history_range": patch("py._history.read_history_range", return_value=read if read is not None else []),
            "backfill_range": patch("py._history.backfill_range", return_value=backfill or []),
        }
        self.m: dict = {}

    def __enter__(self):
        self.m = {k: p.start() for k, p in self._ps.items()}
        return self.m

    def __exit__(self, *exc):
        for p in self._ps.values():
            p.stop()


def _days_between(start: str, end: str) -> int:
    return (date.fromisoformat(end) - date.fromisoformat(start)).days + 1


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


class TestGetHistoryValidation:
    @pytest.mark.asyncio
    async def test_missing_location_and_coords_raises_400(self):
        with pytest.raises(HTTPException) as exc_info:
            await get_history(location="", days=30)
        assert exc_info.value.status_code == 400
        assert "Missing location" in exc_info.value.detail

    @pytest.mark.asyncio
    @pytest.mark.parametrize("days", [0, -5, MAX_RANGE_DAYS + 1])
    async def test_days_out_of_range_raises_400(self, days):
        with pytest.raises(HTTPException) as exc_info:
            await get_history(location="harare", days=days)
        assert exc_info.value.status_code == 400
        assert f"days must be between 1 and {MAX_RANGE_DAYS}" in exc_info.value.detail

    @pytest.mark.asyncio
    @pytest.mark.parametrize("days", [1, 365, 730, MAX_RANGE_DAYS])
    async def test_days_boundaries_accepted(self, days):
        with _Started():
            result = await get_history(location="harare", days=days)
        assert result["days"] == days
        assert result["end"] == local_today(HARARE["lon"])

    @pytest.mark.asyncio
    async def test_default_days_parameter(self):
        with _Started():
            result = await get_history(location="harare")
        assert result["days"] == 30

    @pytest.mark.asyncio
    @pytest.mark.parametrize("bad", ["2020/01/01", "2020-02-30", "yesterday"])
    async def test_bad_start_is_400(self, bad):
        with pytest.raises(HTTPException) as exc_info:
            await get_history(location="harare", start=bad)
        assert exc_info.value.status_code == 400

    @pytest.mark.asyncio
    async def test_invalid_coordinates_are_400(self):
        with pytest.raises(HTTPException) as exc_info:
            await get_history(lat=95.0, lon=0.0)
        assert exc_info.value.status_code == 400


class TestResolveRange:
    def test_start_end_explicit(self):
        assert resolve_range(None, "2020-01-01", "2020-12-31", lon=31.05) == ("2020-01-01", "2020-12-31")

    def test_end_defaults_to_today_and_is_clamped(self):
        today = local_today(31.05)
        assert resolve_range(None, "2026-01-01", None, lon=31.05)[1] == today
        future = (date.fromisoformat(today) + timedelta(days=30)).isoformat()
        assert resolve_range(None, "2026-01-01", future, lon=31.05)[1] == today

    def test_start_end_win_over_days(self):
        assert resolve_range(7, "2020-01-01", "2020-01-31", lon=0.0) == ("2020-01-01", "2020-01-31")

    def test_end_without_start_is_400(self):
        with pytest.raises(HTTPException):
            resolve_range(None, None, "2020-01-01", lon=0.0)

    def test_start_after_end_is_400(self):
        with pytest.raises(HTTPException):
            resolve_range(None, "2020-02-01", "2020-01-01", lon=0.0)

    def test_before_earliest_is_400(self):
        with pytest.raises(HTTPException):
            resolve_range(None, "1939-12-31", "1940-01-31", lon=0.0)

    def test_span_over_cap_is_400(self):
        with pytest.raises(HTTPException) as exc:
            resolve_range(None, "2000-01-01", "2015-01-01", lon=0.0)
        assert str(MAX_RANGE_DAYS) in exc.value.detail

    def test_multi_year_span_accepted(self):
        s, e = resolve_range(None, "2015-01-01", "2019-12-31", lon=0.0)
        assert _days_between(s, e) == 1826


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

    @pytest.mark.asyncio
    async def test_unknown_slug_with_coords_falls_back_to_grid_key(self):
        """London isn't in the catalogue, but its coordinate still has history."""
        with _Started(loc=None) as m:
            result = await get_history(location="london-gb", lat=51.5072, lon=-0.1276, days=7)
        assert result["location"] == "cell:51.50_-0.15"
        args, _ = m["read_history_range"].call_args
        assert args[0] == ["cell:51.50_-0.15"]
        b_args, _ = m["backfill_range"].call_args
        assert b_args[0] == "cell:51.50_-0.15"
        assert b_args[1] == pytest.approx(51.5072)

    @pytest.mark.asyncio
    async def test_lookup_error_with_coords_is_503_not_grid_fallback(self):
        """A placesGeo blip must not silently swap Harare's recorded days for
        a duplicate archive set under the grid key."""
        with _Started(find_exc=Exception("DB down")) as m:
            with pytest.raises(HTTPException) as exc:
                await get_history(location="harare", lat=-17.83, lon=31.05, days=7)
        assert exc.value.status_code == 503
        m["backfill_range"].assert_not_called()

    @pytest.mark.asyncio
    async def test_coords_are_clamped_to_a_year_with_tighter_ip_limit(self):
        with _Started() as m:
            result = await get_history(lat=35.6762, lon=139.6503, days=1825)
        assert result["clamped"] is True
        assert result["days"] == COORD_MAX_RANGE_DAYS
        kwargs = m["backfill_range"].call_args.kwargs
        assert kwargs["ip_bucket"] == "history-backfill-coords"
        assert kwargs["ip_limit"] == COORD_BACKFILL_RATE_LIMIT

    @pytest.mark.asyncio
    async def test_places_keep_the_full_range(self):
        with _Started() as m:
            result = await get_history(location="harare", lat=-17.83, lon=31.05, days=1825)
        assert result["clamped"] is False
        assert result["days"] == 1825
        assert m["backfill_range"].call_args.kwargs["ip_bucket"] == "history-backfill"

    @pytest.mark.asyncio
    async def test_coords_only(self):
        with _Started() as m:
            result = await get_history(lat=35.6762, lon=139.6503, days=30)
        m["find_location"].assert_not_called()
        assert result["location"] == "cell:35.70_139.65"
        assert result["end"] == local_today(139.6503)

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
            {"locationSlug": "harare", "date": "2026-10-08", "source": "nasa-power", "current": {}},
        ]
        with _Started(read=recs) as m:
            result = await get_history(location="harare", days=30)
        assert result["location"] == "harare"
        assert result["records"] == 2
        assert result["backfilled"] == 0
        assert result["data"] == recs
        assert [s["id"] for s in result["sources"]] == ["nasa-power"]
        assert "NASA" in result["sources"][0]["attribution"]
        # Reads the canonical slug AND the platform alias older writes used,
        # for exactly the requested window.
        args, _ = m["read_history_range"].call_args
        assert args[0] == ["harare", "harare-35c223"]
        assert _days_between(args[1], args[2]) == 30

    @pytest.mark.asyncio
    async def test_start_end_passed_through(self):
        with _Started() as m:
            result = await get_history(location="harare", start="2019-01-01", end="2021-12-31")
        args, _ = m["read_history_range"].call_args
        assert args[1:] == ("2019-01-01", "2021-12-31")
        b_args, _ = m["backfill_range"].call_args
        assert b_args[3:5] == ("2019-01-01", "2021-12-31")
        assert result["days"] == 1096

    @pytest.mark.asyncio
    async def test_backfill_receives_existing_dates_and_location(self):
        recs = [{"locationSlug": "harare", "date": "2026-10-09", "current": {}}]
        with _Started(read=recs) as m:
            await get_history(location="harare", days=30)
        args, kwargs = m["backfill_range"].call_args
        assert args[0] == "harare"
        assert args[1] == pytest.approx(-17.8292)
        assert args[2] == pytest.approx(31.0522)
        assert args[5] == ["2026-10-09"]
        assert kwargs["rate_limiter"] is not None

    @pytest.mark.asyncio
    async def test_backfilled_days_merged_newest_first(self):
        recs = [{"locationSlug": "harare", "date": "2026-10-09", "source": "recorded", "current": {}}]
        when = datetime(2026, 10, 10, tzinfo=timezone.utc)
        filled = [
            {"locationSlug": "harare", "date": "2026-10-07", "source": "nasa-power", "current": {}, "recordedAt": when},
            {"locationSlug": "harare", "date": "2026-10-08", "source": "open-meteo-archive", "current": {}, "recordedAt": when},
        ]
        with _Started(read=recs, backfill=filled):
            result = await get_history(location="harare", days=30)
        assert [d["date"] for d in result["data"]] == ["2026-10-09", "2026-10-08", "2026-10-07"]
        assert result["backfilled"] == 2
        assert result["records"] == 3
        assert {s["id"] for s in result["sources"]} == {"nasa-power", "open-meteo-archive"}
        assert isinstance(result["data"][1]["recordedAt"], str)  # JSON-safe

    @pytest.mark.asyncio
    async def test_no_coordinates_skips_backfill(self):
        with _Started(loc={"slug": "harare"}) as m:
            await get_history(location="harare", days=30)
        m["backfill_range"].assert_not_called()

    @pytest.mark.asyncio
    async def test_read_error_raises_502(self):
        with _Started() as m:
            m["read_history_range"].side_effect = Exception("timeout")
            with pytest.raises(HTTPException) as exc_info:
                await get_history(location="harare", days=30)
        assert exc_info.value.status_code == 502
        assert "Failed to fetch weather history" in exc_info.value.detail
