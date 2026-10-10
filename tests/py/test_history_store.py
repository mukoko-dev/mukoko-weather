"""Tests for _history_store.py — the weather_history writer, reader and backfill."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

from py import _history_store as hs

NOW = datetime(2026, 10, 10, 8, 0, tzinfo=timezone.utc)  # 10:00 in Harare


@pytest.fixture(autouse=True)
def _reset_cooldowns():
    hs._backfill_attempts.clear()
    yield
    hs._backfill_attempts.clear()


def _coll(mock_db):
    coll = MagicMock()
    mock_db.return_value.__getitem__ = MagicMock(return_value=coll)
    return coll


# ---------------------------------------------------------------------------
# Local date
# ---------------------------------------------------------------------------


class TestLocalDate:
    def test_positive_offset_rolls_to_next_day(self):
        late = datetime(2026, 10, 9, 23, 0, tzinfo=timezone.utc)
        assert hs.local_date(7200, late) == "2026-10-10"

    def test_negative_offset_stays_on_previous_day(self):
        early = datetime(2026, 10, 10, 2, 0, tzinfo=timezone.utc)
        assert hs.local_date(-5 * 3600, early) == "2026-10-09"

    def test_estimate_offset_from_longitude(self):
        assert hs.estimate_utc_offset_seconds(31.05) == 7200
        assert hs.estimate_utc_offset_seconds(-75) == -5 * 3600


# ---------------------------------------------------------------------------
# Writer
# ---------------------------------------------------------------------------


class TestRecordWeatherHistory:
    @patch("py._history_store.get_db")
    def test_key_matches_unique_index_and_date_always_set(self, mock_db):
        """#245 regression: the key must be exactly the unique index fields,
        with a non-null date. insert_one without `date` collided on
        (slug, null) and every write after the first was lost."""
        coll = _coll(mock_db)
        ok = hs.record_weather_history(
            "harare", {"current": {"temperature_2m": 25}, "daily": {}},
            provider="open-meteo", utc_offset_seconds=7200, now=NOW,
        )
        assert ok
        coll.insert_one.assert_not_called()
        key = coll.update_one.call_args[0][0]
        assert key == {"locationSlug": "harare", "date": "2026-10-10"}
        update = coll.update_one.call_args[0][1]
        assert update["$set"]["daily"]["time"] == ["2026-10-10"]
        assert update["$setOnInsert"]["createdAt"] == NOW

    @patch("py._history_store.get_db")
    def test_duplicate_key_race_retries_once(self, mock_db):
        coll = _coll(mock_db)

        class DuplicateKeyError(Exception):
            pass

        coll.update_one.side_effect = [DuplicateKeyError("race"), None]
        assert hs.record_weather_history(
            "harare", {"current": {"t": 1}}, provider="x", utc_offset_seconds=0, now=NOW,
        )
        assert coll.update_one.call_count == 2

    @patch("py._history_store.get_db")
    def test_other_errors_logged_and_reported(self, mock_db, caplog):
        coll = _coll(mock_db)
        coll.update_one.side_effect = Exception("over quota")
        with caplog.at_level("WARNING"):
            ok = hs.record_weather_history(
                "harare", {"current": {"t": 1}}, provider="x", utc_offset_seconds=0, now=NOW,
            )
        assert ok is False
        assert "weather_history upsert failed" in caplog.text

    @patch("py._history_store.get_db")
    def test_skips_payload_without_current(self, mock_db):
        coll = _coll(mock_db)
        assert not hs.record_weather_history("harare", {"current": {}}, provider="x", utc_offset_seconds=0)
        coll.update_one.assert_not_called()


# ---------------------------------------------------------------------------
# Reader / merge
# ---------------------------------------------------------------------------


class TestReadHistory:
    @patch("py._history_store.get_db")
    def test_queries_by_date_window_and_all_slugs(self, mock_db):
        coll = _coll(mock_db)
        coll.find.return_value.sort.return_value = []
        hs.read_history(["harare", "harare-35c223"], 30, lon=31.05, now=NOW)
        query = coll.find.call_args[0][0]
        assert query["locationSlug"] == {"$in": ["harare", "harare-35c223"]}
        # 30 local days inclusive of today (2026-10-10)
        assert query["date"] == {"$gte": "2026-09-11"}
        coll.find.return_value.sort.assert_called_once_with("date", -1)

    def test_merge_prefers_recorded_then_canonical_slug(self):
        docs = [
            {"locationSlug": "harare-35c223", "date": "2026-10-08", "source": "recorded", "v": "alias"},
            {"locationSlug": "harare", "date": "2026-10-08", "source": "recorded", "v": "canonical"},
            {"locationSlug": "harare", "date": "2026-10-07", "source": "open-meteo-archive", "v": "archive"},
            {"locationSlug": "harare-35c223", "date": "2026-10-07", "source": "recorded", "v": "recorded"},
            {"locationSlug": "harare", "v": "legacy-no-date"},
        ]
        out = hs.merge_by_date(docs, ["harare", "harare-35c223"])
        assert [(d["date"], d["v"]) for d in out] == [
            ("2026-10-08", "canonical"),
            ("2026-10-07", "recorded"),
        ]
        assert all(d["locationSlug"] == "harare" for d in out)

    def test_legacy_docs_without_source_count_as_recorded(self):
        docs = [
            {"locationSlug": "harare", "date": "2026-10-07", "source": "open-meteo-archive", "v": "a"},
            {"locationSlug": "harare", "date": "2026-10-07", "v": "legacy"},
        ]
        assert hs.merge_by_date(docs, ["harare"])[0]["v"] == "legacy"


# ---------------------------------------------------------------------------
# Backfill
# ---------------------------------------------------------------------------

ARCHIVE_PAYLOAD = {
    "utc_offset_seconds": 7200,
    "daily": {
        "time": ["2026-10-07", "2026-10-08", "2026-10-09"],
        "weather_code": [51, 51, 3],
        "temperature_2m_max": [26.6, 25.6, None],  # newest day not yet in ERA5
        "temperature_2m_min": [16.0, 16.4, None],
        "temperature_2m_mean": [20.7, 20.5, None],
        "apparent_temperature_max": [28.4, 27.0, None],
        "apparent_temperature_min": [16.0, 16.9, None],
        "apparent_temperature_mean": [21.4, 20.8, None],
        "precipitation_sum": [0.3, 0.4, None],
        "sunrise": ["2026-10-07T05:32", "2026-10-08T05:32", "2026-10-09T05:31"],
        "sunset": ["2026-10-07T17:54", "2026-10-08T17:54", "2026-10-09T17:54"],
        "wind_speed_10m_max": [12.4, 13.0, None],
        "wind_gusts_10m_max": [25.9, 34.2, None],
        "wind_direction_10m_dominant": [72, 70, None],
        "wind_speed_10m_mean": [7.1, 7.4, None],
        "relative_humidity_2m_mean": [69, 71, None],
        "cloud_cover_mean": [45, 46, None],
        "surface_pressure_mean": [858.2, 858.4, None],
        "dew_point_2m_mean": [14.1, 14.6, None],
        "et0_fao_evapotranspiration": [5.1, 5.0, None],
    },
}


def _http(payload=ARCHIVE_PAYLOAD, status=200):
    client = MagicMock()
    client.get.return_value = MagicMock(status_code=status, json=MagicMock(return_value=payload))
    return client


def _breaker(allowed=True):
    return MagicMock(is_allowed=allowed)


class TestMissingPastDates:
    def test_excludes_today_and_existing(self):
        out = hs.missing_past_dates(["2026-10-08"], 4, lon=31.05, now=NOW)
        assert out == ["2026-10-07", "2026-10-09"]

    def test_days_one_needs_nothing(self):
        assert hs.missing_past_dates([], 1, lon=31.05, now=NOW) == []


class TestBuildArchiveDocs:
    def test_shape_matches_dashboard_contract(self):
        docs = hs.build_archive_docs("harare", ARCHIVE_PAYLOAD, ["2026-10-07", "2026-10-08", "2026-10-09"], now=NOW)
        # Null ERA5 day skipped
        assert [d["date"] for d in docs] == ["2026-10-07", "2026-10-08"]
        d = docs[0]
        assert d["source"] == "open-meteo-archive"
        assert d["daily"]["temperature_2m_max"] == [26.6]
        assert d["daily"]["sunrise"] == ["2026-10-07T05:32"]
        assert d["current"]["relative_humidity_2m"] == 69
        assert d["current"]["surface_pressure"] == 858.2
        assert d["current"]["weather_code"] == 51
        assert d["current"]["uv_index"] is None
        assert d["insights"] == {"dewPoint": 14.1, "evapotranspiration": 5.1}

    def test_only_wanted_dates(self):
        docs = hs.build_archive_docs("harare", ARCHIVE_PAYLOAD, ["2026-10-08"], now=NOW)
        assert [d["date"] for d in docs] == ["2026-10-08"]


class TestBackfillHistory:
    @patch("py._history_store.get_db")
    def test_single_request_for_missing_span_and_set_on_insert(self, mock_db):
        coll = _coll(mock_db)
        http, breaker = _http(), _breaker()
        docs = hs.backfill_history(
            "harare", -17.83, 31.05, 4, ["2026-10-08"],
            http_client=http, breaker=breaker, now=NOW,
        )
        http.get.assert_called_once()
        params = http.get.call_args[1]["params"]
        assert params["start_date"] == "2026-10-07"
        assert params["end_date"] == "2026-10-09"
        assert http.get.call_args[0][0] == hs.ARCHIVE_URL
        breaker.record_success.assert_called_once()
        # 2026-10-08 already existed; 2026-10-09 is null in ERA5
        assert [d["date"] for d in docs] == ["2026-10-07"]
        ops = coll.bulk_write.call_args[0][0]
        assert len(ops) == 1
        # Never overwrites a recorded day: insert-only update
        assert coll.bulk_write.call_args[1] == {"ordered": False}

    def test_upsert_uses_set_on_insert_only(self):
        captured = {}

        def fake_update_one(flt, upd, upsert):
            captured.update(flt=flt, upd=upd, upsert=upsert)
            return ("op", flt, upd)

        with patch("pymongo.UpdateOne", side_effect=fake_update_one), patch("py._history_store.get_db") as mock_db:
            _coll(mock_db)
            hs._upsert_archive_docs([{"locationSlug": "harare", "date": "2026-10-07", "source": "open-meteo-archive"}])
        assert captured["flt"] == {"locationSlug": "harare", "date": "2026-10-07"}
        assert set(captured["upd"]) == {"$setOnInsert"}
        assert "locationSlug" not in captured["upd"]["$setOnInsert"]
        assert captured["upsert"] is True

    def test_nothing_missing_makes_no_request(self):
        http = _http()
        existing = ["2026-10-07", "2026-10-08", "2026-10-09"]
        assert hs.backfill_history("harare", -17.83, 31.05, 4, existing, http_client=http, breaker=_breaker(), now=NOW) == []
        http.get.assert_not_called()

    def test_open_breaker_skips(self):
        http = _http()
        assert hs.backfill_history("harare", -17.83, 31.05, 4, [], http_client=http, breaker=_breaker(False), now=NOW) == []
        http.get.assert_not_called()

    def test_rate_limited_ip_skips(self):
        http = _http()
        limiter = MagicMock(return_value={"allowed": False})
        out = hs.backfill_history(
            "harare", -17.83, 31.05, 4, [], http_client=http, breaker=_breaker(),
            client_ip="1.2.3.4", rate_limiter=limiter, now=NOW,
        )
        assert out == []
        http.get.assert_not_called()
        limiter.assert_called_once_with("1.2.3.4", "history-backfill", hs.BACKFILL_RATE_LIMIT, hs.BACKFILL_RATE_WINDOW_S)

    @patch("py._history_store.get_db")
    def test_cooldown_blocks_same_range_but_not_wider(self, mock_db):
        _coll(mock_db)
        http = _http()
        hs.backfill_history("harare", -17.83, 31.05, 4, [], http_client=http, breaker=_breaker(), now=NOW)
        hs.backfill_history("harare", -17.83, 31.05, 4, [], http_client=http, breaker=_breaker(), now=NOW)
        assert http.get.call_count == 1
        # A wider window (user picked 30 days) is a new attempt.
        hs.backfill_history("harare", -17.83, 31.05, 30, [], http_client=http, breaker=_breaker(), now=NOW)
        assert http.get.call_count == 2

    def test_http_error_records_failure_and_never_raises(self):
        http = MagicMock()
        http.get.side_effect = Exception("timeout")
        breaker = _breaker()
        assert hs.backfill_history("harare", -17.83, 31.05, 4, [], http_client=http, breaker=breaker, now=NOW) == []
        breaker.record_failure.assert_called_once()

    def test_non_200_records_failure(self):
        breaker = _breaker()
        assert hs.backfill_history("harare", -17.83, 31.05, 4, [], http_client=_http(status=429), breaker=breaker, now=NOW) == []
        breaker.record_failure.assert_called_once()

    @patch("py._history_store.get_db")
    def test_span_capped_to_one_request(self, mock_db):
        _coll(mock_db)
        http = _http({"daily": {"time": []}})
        hs.backfill_history("harare", -17.83, 31.05, 365, [], http_client=http, breaker=_breaker(), now=NOW)
        assert http.get.call_count == 1
        params = http.get.call_args[1]["params"]
        assert params["start_date"] == "2025-10-11"
        assert params["end_date"] == "2026-10-09"


class TestBackfillPersistFailure:
    @patch("py._history_store.get_db")
    def test_fetched_days_returned_even_if_save_fails(self, mock_db):
        coll = _coll(mock_db)
        coll.bulk_write.side_effect = Exception("over quota")
        docs = hs.backfill_history(
            "harare", -17.83, 31.05, 4, [], http_client=_http(), breaker=_breaker(), now=NOW,
        )
        assert [d["date"] for d in docs] == ["2026-10-07", "2026-10-08"]
