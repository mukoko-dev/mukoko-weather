"""
Tests for _normals.py — climate normals (1991–2020) day-of-year tables.

Covers:
  * Grid snapping and the deterministic ``{lat:.2f}_{lon:.2f}`` cache _id
  * Leap-year calendar slots (Feb 29 = slot 59, Mar 1 = 60, Dec 31 = 365)
  * ±7-day circular window averaging, including the year-end wrap-around
  * Leap-day handling (Feb 29 averages only leap-year observations)
  * Endpoint flow: cache hit (no upstream), cache miss (fetch + upsert),
    upstream failure, timeout, breaker open, bad input
  * The archive request parameters (period, grid, timezone), with httpx mocked
"""

from __future__ import annotations

import calendar
import datetime as dt
import time
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from py._circuit_breaker import _circuit_states
from py import _normals
from py._normals import (
    NORMALS_PERIOD,
    NORMALS_SOURCE,
    SLOTS,
    cache_key,
    compute_normal_tables,
    day_slot,
    get_normals,
    snap_to_grid,
    _fetch_archive,
)


@pytest.fixture(autouse=True)
def _reset_circuit_breaker():
    _circuit_states.clear()
    yield
    _circuit_states.clear()


def _daily_series(hi_for, lo_for, start="1991-01-01", end="2020-12-31"):
    """Build an Open-Meteo-shaped daily block. ``hi_for``/``lo_for`` take a date."""
    d0 = dt.date.fromisoformat(start)
    d1 = dt.date.fromisoformat(end)
    times, highs, lows = [], [], []
    d = d0
    while d <= d1:
        times.append(d.isoformat())
        highs.append(hi_for(d))
        lows.append(lo_for(d))
        d += dt.timedelta(days=1)
    return {"time": times, "temperature_2m_max": highs, "temperature_2m_min": lows}


# ---------------------------------------------------------------------------
# Grid + cache key
# ---------------------------------------------------------------------------


class TestGridAndKey:
    def test_snaps_harare_to_quarter_degree_cell(self):
        assert snap_to_grid(-17.83) == -17.75
        assert snap_to_grid(31.05) == 31.0

    def test_snaps_singapore_to_quarter_degree_cell(self):
        assert snap_to_grid(1.35) == 1.25
        assert snap_to_grid(103.82) == 103.75

    def test_exact_grid_values_are_unchanged(self):
        assert snap_to_grid(-17.75) == -17.75
        assert snap_to_grid(0.0) == 0.0

    def test_cache_key_is_two_decimals(self):
        assert cache_key(-17.75, 31.0) == "-17.75_31.00"
        assert cache_key(1.25, 103.75) == "1.25_103.75"

    def test_nearby_points_share_one_cell_and_key(self):
        a = cache_key(snap_to_grid(-17.80), snap_to_grid(31.01))
        b = cache_key(snap_to_grid(-17.76), snap_to_grid(30.99))
        assert a == b == "-17.75_31.00"


# ---------------------------------------------------------------------------
# Day-of-year slots
# ---------------------------------------------------------------------------


class TestDaySlot:
    def test_first_and_last_slots(self):
        assert day_slot(1, 1) == 0
        assert day_slot(12, 31) == SLOTS - 1 == 365

    def test_feb_29_is_slot_59(self):
        assert day_slot(2, 28) == 58
        assert day_slot(2, 29) == 59

    def test_mar_1_is_slot_60_in_every_year(self):
        # Non-leap years must not shift into the Feb 29 slot.
        assert day_slot(3, 1) == 60

    def test_slots_are_strictly_increasing_across_the_year(self):
        slots = []
        d = dt.date(2001, 1, 1)  # non-leap
        while d.year == 2001:
            slots.append(day_slot(d.month, d.day))
            d += dt.timedelta(days=1)
        assert slots == sorted(slots)
        assert len(set(slots)) == 365  # no collisions in a non-leap year


# ---------------------------------------------------------------------------
# Table maths
# ---------------------------------------------------------------------------


class TestComputeNormalTables:
    def test_table_has_366_entries(self):
        daily = _daily_series(lambda d: 20.0, lambda d: 10.0, start="2000-01-01", end="2000-12-31")
        hi, lo = compute_normal_tables(daily)
        assert len(hi) == SLOTS == len(lo)

    def test_constant_series_gives_constant_normals(self):
        daily = _daily_series(lambda d: 25.0, lambda d: 14.0)
        hi, lo = compute_normal_tables(daily)
        assert all(v == 25.0 for v in hi)
        assert all(v == 14.0 for v in lo)

    def test_window_wraps_year_end_for_jan_1(self):
        # Every day is 10 except Jan 1 (slot 0) = 30 and Dec 31 (slot 365) = 50.
        def hi(d):
            if (d.month, d.day) == (1, 1):
                return 30.0
            if (d.month, d.day) == (12, 31):
                return 50.0
            return 10.0

        daily = _daily_series(hi, lambda d: 0.0)
        max_table, _ = compute_normal_tables(daily)
        # Window for slot 0 = slots 359..365 (wrapped) + 0..7 = 15 slots:
        # six 10s, one 50, one 30, seven 10s  →  (60 + 50 + 30 + 70) / 15 = 14.
        assert max_table[0] == pytest.approx(14.0)

    def test_window_wraps_year_end_for_dec_31_neighbourhood(self):
        def hi(d):
            return 50.0 if (d.month, d.day) == (1, 1) else 10.0

        daily = _daily_series(hi, lambda d: 0.0)
        max_table, _ = compute_normal_tables(daily)
        # Slot 365 (Dec 31) window reaches slot 0 (Jan 1) through the wrap.
        # Window is 358..365 + 0..6 = 15 slots: 14 tens + one 50 → (140 + 50) / 15 = 12.666…
        assert max_table[365] == pytest.approx(round((140 + 50) / 15, 2))

    def test_window_is_fifteen_days_centred_on_slot(self):
        def hi(d):
            return 100.0 if (d.month, d.day) == (6, 15) else 0.0

        daily = _daily_series(hi, lambda d: 0.0)
        max_table, _ = compute_normal_tables(daily)
        target = day_slot(6, 15)
        # Slots within ±7 days see the spike; slot 8 days away does not.
        assert max_table[target] == pytest.approx(100.0 / 15, abs=0.01)
        assert max_table[target + 7] == pytest.approx(100.0 / 15, abs=0.01)
        assert max_table[target + 8] == 0.0

    def test_leap_day_averages_only_leap_year_observations(self):
        # Feb 29 is 100 (only in leap years), everything else is 10.
        def hi(d):
            return 100.0 if (d.month, d.day) == (2, 29) else 10.0

        daily = _daily_series(hi, lambda d: 0.0)
        max_table, _ = compute_normal_tables(daily)

        leap_years = [y for y in range(1991, 2021) if calendar.isleap(y)]
        n_leap = len(leap_years)
        assert n_leap == 8  # 1992, 96, 2000, 04, 08, 12, 16, 20
        # Feb 29 slot window: 1 slot of n_leap obs at 100, 14 slots of 30 obs at 10.
        expected = (n_leap * 100 + 14 * 30 * 10) / (n_leap + 14 * 30)
        assert max_table[day_slot(2, 29)] == pytest.approx(round(expected, 2))

    def test_feb_29_slot_does_not_pollute_non_leap_neighbours_mean_much(self):
        def hi(d):
            return 100.0 if (d.month, d.day) == (2, 29) else 10.0

        daily = _daily_series(hi, lambda d: 0.0)
        max_table, _ = compute_normal_tables(daily)
        # Mar 1 is in the window of the Feb 29 spike, so it is raised, but a
        # slot 8 days away from Feb 29 is untouched.
        assert max_table[day_slot(2, 29) + 8] == pytest.approx(10.0)

    def test_none_values_are_skipped(self):
        daily = _daily_series(lambda d: None if d.year == 1991 else 20.0, lambda d: 5.0)
        max_table, min_table = compute_normal_tables(daily)
        assert all(v == pytest.approx(20.0) for v in max_table if v is not None)
        assert all(v == pytest.approx(5.0) for v in min_table if v is not None)

    def test_empty_payload_gives_all_none(self):
        hi, lo = compute_normal_tables({"time": [], "temperature_2m_max": [], "temperature_2m_min": []})
        assert hi == [None] * SLOTS
        assert lo == [None] * SLOTS


# ---------------------------------------------------------------------------
# Upstream request shape (httpx mocked)
# ---------------------------------------------------------------------------


class TestFetchArchive:
    def test_requests_full_period_for_snapped_cell(self):
        resp = MagicMock()
        resp.json.return_value = {"daily": {"time": ["1991-01-01"], "temperature_2m_max": [1.0],
                                            "temperature_2m_min": [0.0]}}
        client = MagicMock()
        client.get.return_value = resp
        with patch("py._normals._get_http", return_value=client):
            daily = _fetch_archive(-17.75, 31.0)

        assert daily["time"] == ["1991-01-01"]
        args, kwargs = client.get.call_args
        assert args[0] == "https://archive-api.open-meteo.com/v1/archive"
        params = kwargs["params"]
        assert params["start_date"] == "1991-01-01"
        assert params["end_date"] == "2020-12-31"
        assert params["daily"] == "temperature_2m_max,temperature_2m_min"
        assert params["timezone"] == "auto"
        assert params["latitude"] == "-17.75"

    def test_missing_daily_block_raises(self):
        resp = MagicMock()
        resp.json.return_value = {"error": True}
        client = MagicMock()
        client.get.return_value = resp
        with patch("py._normals._get_http", return_value=client):
            with pytest.raises(ValueError):
                _fetch_archive(0.0, 0.0)


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


def _tables(hi=30.0, lo=18.0):
    return [hi] * SLOTS, [lo] * SLOTS


@pytest.mark.asyncio
class TestEndpoint:
    async def test_cache_hit_serves_without_upstream(self):
        max_t, min_t = _tables(hi=28.4, lo=17.2)
        coll = MagicMock()
        coll.find_one.return_value = {
            "_id": "-17.75_31.00",
            "maxByDay": max_t,
            "minByDay": min_t,
            "computedAt": dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc),
        }
        with patch("py._normals._normals_collection", return_value=coll), \
             patch("py._normals._fetch_archive") as fetch:
            res = await get_normals(lat=-17.83, lon=31.05, date="2026-10-08")

        fetch.assert_not_called()
        coll.find_one.assert_called_once_with({"_id": "-17.75_31.00"})
        assert res.available is True
        assert res.normalHigh == 28.4
        assert res.normalLow == 17.2
        assert res.period == NORMALS_PERIOD == "1991–2020"
        assert res.source == NORMALS_SOURCE
        assert res.computedAt == "2026-01-01T00:00:00+00:00"
        assert res.date == "2026-10-08"

    async def test_cache_miss_fetches_once_and_upserts_by_rounded_id(self):
        coll = MagicMock()
        coll.find_one.return_value = None
        daily = _daily_series(lambda d: 26.0, lambda d: 15.0, start="1991-01-01", end="2020-12-31")
        with patch("py._normals._normals_collection", return_value=coll), \
             patch("py._normals._fetch_archive", return_value=daily) as fetch:
            res = await get_normals(lat=1.35, lon=103.82, date="2026-03-01")

        fetch.assert_called_once_with(1.25, 103.75)
        assert res.available is True
        assert res.normalHigh == 26.0
        assert res.normalLow == 15.0
        args = coll.update_one.call_args
        assert args.args[0] == {"_id": "1.25_103.75"}
        assert args.kwargs["upsert"] is True
        stored = args.args[1]["$set"]
        assert stored["_id"] == "1.25_103.75"
        assert len(stored["maxByDay"]) == SLOTS
        assert stored["period"] == NORMALS_PERIOD
        assert "expiresAt" not in stored  # normals never expire

    async def test_cache_read_failure_still_builds(self):
        coll = MagicMock()
        coll.find_one.side_effect = RuntimeError("db down")
        daily = _daily_series(lambda d: 22.0, lambda d: 12.0)
        with patch("py._normals._normals_collection", return_value=coll), \
             patch("py._normals._fetch_archive", return_value=daily):
            res = await get_normals(lat=-17.83, lon=31.05, date="2026-06-01")
        assert res.available is True

    async def test_cache_write_failure_does_not_fail_response(self):
        coll = MagicMock()
        coll.find_one.return_value = None
        coll.update_one.side_effect = RuntimeError("write refused")
        daily = _daily_series(lambda d: 22.0, lambda d: 12.0)
        with patch("py._normals._normals_collection", return_value=coll), \
             patch("py._normals._fetch_archive", return_value=daily):
            res = await get_normals(lat=-17.83, lon=31.05, date="2026-06-01")
        assert res.available is True
        assert res.normalHigh == 22.0

    async def test_upstream_failure_is_available_false_not_500(self):
        coll = MagicMock()
        coll.find_one.return_value = None
        with patch("py._normals._normals_collection", return_value=coll), \
             patch("py._normals._fetch_archive", side_effect=RuntimeError("502 from upstream")):
            res = await get_normals(lat=-17.83, lon=31.05, date="2026-06-01")
        assert res.available is False
        assert res.reason == "upstream_error"
        assert res.normalHigh is None
        coll.update_one.assert_not_called()

    async def test_upstream_failure_is_recorded_on_breaker(self):
        from py._circuit_breaker import open_meteo_breaker
        coll = MagicMock()
        coll.find_one.return_value = None
        with patch("py._normals._normals_collection", return_value=coll), \
             patch("py._normals._fetch_archive", side_effect=RuntimeError("boom")), \
             patch.object(open_meteo_breaker, "record_failure") as rec:
            await get_normals(lat=-17.83, lon=31.05, date="2026-06-01")
        rec.assert_called_once()

    async def test_build_timeout_is_available_false(self):
        coll = MagicMock()
        coll.find_one.return_value = None

        def slow(glat, glon):
            time.sleep(0.5)
            return {}

        with patch("py._normals._normals_collection", return_value=coll), \
             patch("py._normals._fetch_archive", side_effect=slow), \
             patch.object(_normals, "NORMALS_BUILD_TIMEOUT_S", 0.05):
            res = await get_normals(lat=-17.83, lon=31.05, date="2026-06-01")
        assert res.available is False
        assert res.reason == "timeout"

    async def test_breaker_open_skips_upstream(self):
        from py._circuit_breaker import open_meteo_breaker
        for _ in range(10):
            open_meteo_breaker.record_failure()
        assert open_meteo_breaker.is_allowed is False

        coll = MagicMock()
        coll.find_one.return_value = None
        with patch("py._normals._normals_collection", return_value=coll), \
             patch("py._normals._fetch_archive") as fetch:
            res = await get_normals(lat=-17.83, lon=31.05, date="2026-06-01")
        fetch.assert_not_called()
        assert res.available is False
        assert res.reason == "circuit_open"

    async def test_breaker_open_still_serves_cache(self):
        from py._circuit_breaker import open_meteo_breaker
        for _ in range(10):
            open_meteo_breaker.record_failure()
        max_t, min_t = _tables()
        coll = MagicMock()
        coll.find_one.return_value = {"_id": "-17.75_31.00", "maxByDay": max_t, "minByDay": min_t}
        with patch("py._normals._normals_collection", return_value=coll):
            res = await get_normals(lat=-17.83, lon=31.05, date="2026-06-01")
        assert res.available is True

    async def test_default_date_is_today_utc(self):
        coll = MagicMock()
        coll.find_one.return_value = {"_id": "x", "maxByDay": _tables()[0], "minByDay": _tables()[1]}
        with patch("py._normals._normals_collection", return_value=coll):
            res = await get_normals(lat=0.0, lon=0.0, date=None)
        assert res.date == dt.datetime.now(dt.timezone.utc).date().isoformat()

    async def test_bad_date_is_400(self):
        with pytest.raises(HTTPException) as exc:
            await get_normals(lat=0.0, lon=0.0, date="08/10/2026")
        assert exc.value.status_code == 400

    async def test_impossible_date_is_400(self):
        with pytest.raises(HTTPException) as exc:
            await get_normals(lat=0.0, lon=0.0, date="2026-02-30")
        assert exc.value.status_code == 400

    async def test_invalid_coordinates_are_400(self):
        with pytest.raises(HTTPException) as exc:
            await get_normals(lat=91.0, lon=0.0, date="2026-01-01")
        assert exc.value.status_code == 400

    async def test_leap_day_request_resolves_to_slot_59(self):
        max_t = [float(i) for i in range(SLOTS)]
        min_t = [float(i) for i in range(SLOTS)]
        coll = MagicMock()
        coll.find_one.return_value = {"_id": "x", "maxByDay": max_t, "minByDay": min_t}
        with patch("py._normals._normals_collection", return_value=coll):
            res = await get_normals(lat=0.0, lon=0.0, date="2028-02-29")
        assert res.normalHigh == 59.0
        assert res.normalLow == 59.0
