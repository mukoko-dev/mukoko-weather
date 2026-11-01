"""Tests for _history_store.py — the weather_history writer and reader.

The archive backfill and ``GET /api/py/history`` are gone (the Rust Worker's
``/v1/history`` does both).
"""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

from py import _history_store as hs

NOW = datetime(2026, 10, 10, 8, 0, tzinfo=timezone.utc)  # 10:00 in Harare


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
# Which keys a place's days are stored under
# ---------------------------------------------------------------------------

HARARE = {"slug": "harare", "lat": -17.8292, "lon": 31.0522, "platformSlug": "harare-35c223"}


class TestHistorySlugs:
    def test_the_platform_alias_follows_the_canonical_slug(self):
        assert hs.history_slugs("harare", HARARE) == ["harare", "harare-35c223"]

    def test_without_an_alias_there_is_one_key(self):
        assert hs.history_slugs("harare", {"slug": "harare"}) == ["harare"]

    def test_a_synthesized_spot_is_keyed_by_its_cell_not_its_name(self):
        spot = {"slug": "west-paddock--kqwy4dd7", "_id": "geo:kqwy4dd"}
        assert hs.history_slugs("west-paddock--kqwy4dd7", spot) == ["geo:kqwy4dd"]
