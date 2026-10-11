"""Tests for _history_store.py — the weather_history writer, reader, archive providers and backfill (#245, #268)."""

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
        assert query["date"] == {"$gte": "2026-09-11", "$lte": "2026-10-10"}
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




POWER_PAYLOAD = {
    "header": {"fill_value": -999.0, "sources": ["GEOSIT", "POWER"]},
    "properties": {
        "parameter": {
            "T2M_MAX": {"20261006": 26.3, "20261007": 28.8, "20261008": -999.0},
            "T2M_MIN": {"20261006": 13.5, "20261007": 15.8, "20261008": -999.0},
            "T2M": {"20261006": 19.5, "20261007": 21.8, "20261008": -999.0},
            "PRECTOTCORR": {"20261006": 12.0, "20261007": 0.0, "20261008": -999.0},
            "RH2M": {"20261006": 70.1, "20261007": 64.8, "20261008": -999.0},
            "WS10M": {"20261006": 4.0, "20261007": 2.0, "20261008": -999.0},
            "WS10M_MAX": {"20261006": 6.5, "20261007": 5.0, "20261008": -999.0},
            "WD10M": {"20261006": -94440.0, "20261007": 90.0, "20261008": -999.0},
            "PS": {"20261006": 86.15, "20261007": 86.07, "20261008": -999.0},
            "T2MDEW": {"20261006": 13.4, "20261007": 13.9, "20261008": -999.0},
            "CLOUD_AMT": {"20261006": -999.0, "20261007": 10.0, "20261008": -999.0},
        }
    },
}


def _resp(payload, status=200):
    return MagicMock(status_code=status, json=MagicMock(return_value=payload))


class FakeProvider:
    """A provider double: canned days per call, or an exception."""

    def __init__(self, pid="nasa-power", days=None, exc=None, max_span=3660, earliest="1940-01-01", allowed=True):
        self.info = hs.ProviderInfo(id=pid, name=pid, attribution=f"credit {pid}", url="https://x", licence="L")
        self.breaker = MagicMock(is_allowed=allowed)
        self.max_span_days = max_span
        self.earliest = earliest
        self.budget_per_hour = 10
        self.commercial = True
        self._days = days
        self._exc = exc
        self.calls: list[tuple[str, str]] = []

    def fetch_daily_range(self, lat, lon, start, end, *, variables=None, timeout=None):
        self.calls.append((start, end))
        if self._exc:
            raise self._exc
        source = self._days if self._days is not None else [
            {"date": d, "temperature_2m_max": 25.0, "temperature_2m_min": 12.0}
            for d in hs.date_span(start, end)
        ]
        return [d for d in source if start <= d["date"] <= end]


# ---------------------------------------------------------------------------
# Range helpers
# ---------------------------------------------------------------------------


class TestRangeHelpers:
    def test_missing_excludes_today_and_existing(self):
        out = hs.missing_past_dates(["2026-10-08"], 4, lon=31.05, now=NOW)
        assert out == ["2026-10-07", "2026-10-09"]

    def test_days_one_needs_nothing(self):
        assert hs.missing_past_dates([], 1, lon=31.05, now=NOW) == []

    def test_missing_dates_for_explicit_range_clamps_to_yesterday(self):
        out = hs.missing_dates([], "2026-10-08", "2026-12-31", lon=31.05, now=NOW)
        assert out == ["2026-10-08", "2026-10-09"]

    def test_missing_dates_respects_earliest(self):
        out = hs.missing_dates([], "1939-12-30", "1940-01-02", lon=0.0, now=NOW)
        assert out == ["1940-01-01", "1940-01-02"]

    def test_group_runs_merges_close_gaps(self):
        dates = ["2026-01-01", "2026-01-02", "2026-01-20", "2026-06-01"]
        assert hs.group_runs(dates, max_gap_days=31) == [("2026-01-01", "2026-01-20"), ("2026-06-01", "2026-06-01")]

    def test_split_span_newest_first(self):
        chunks = hs.split_span("2024-01-01", "2026-01-01", 366)
        assert chunks[0][1] == "2026-01-01"
        assert chunks[-1][0] == "2024-01-01"
        assert all(len(hs.date_span(a, b)) <= 366 for a, b in chunks)
        assert sum(len(hs.date_span(a, b)) for a, b in chunks) == len(hs.date_span("2024-01-01", "2026-01-01"))


# ---------------------------------------------------------------------------
# Providers
# ---------------------------------------------------------------------------


class TestNasaPower:
    def test_parse_converts_units_and_drops_fill_and_bad_direction(self):
        days = hs.parse_nasa_power(POWER_PAYLOAD)
        # 2026-10-08 is all fill values (POWER's lag) and is skipped
        assert [d["date"] for d in days] == ["2026-10-06", "2026-10-07"]
        d6, d7 = days
        assert d6["wind_speed_10m_mean"] == pytest.approx(14.4)  # 4 m/s -> km/h
        assert d6["surface_pressure_mean"] == pytest.approx(861.5)  # kPa -> hPa
        assert "wind_direction_10m_dominant" not in d6  # -94440 is not a direction
        assert d7["wind_direction_10m_dominant"] == 90.0
        assert "cloud_cover_mean" not in d6
        assert d6["weather_code"] == 63  # 12 mm of rain
        assert d7["weather_code"] == 0  # dry, 10 % cloud
        # Apparent temperature is derived (Steadman) so feels-like isn't blank
        assert d6["apparent_temperature_max"] == hs.apparent_temperature(26.3, 70.1, 14.4)
        assert d6["apparent_temperature_min"] is not None

    def test_fetch_request_shape(self):
        client = MagicMock()
        client.get.return_value = _resp(POWER_PAYLOAD)
        with patch("py._history_store._http", return_value=client):
            days = hs.NasaPowerProvider().fetch_daily_range(-17.83, 31.05, "2026-10-06", "2026-10-08")
        assert len(days) == 2
        url = client.get.call_args[0][0]
        params = client.get.call_args[1]["params"]
        assert url == hs.NASA_POWER_URL
        assert params["start"] == "20261006" and params["end"] == "20261008"
        assert "T2M_MAX" in params["parameters"] and "PRECTOTCORR" in params["parameters"]
        assert "api_key" not in params and "apikey" not in params  # keyless

    def test_normals_variables_request_only_temperatures(self):
        client = MagicMock()
        client.get.return_value = _resp(POWER_PAYLOAD)
        with patch("py._history_store._http", return_value=client):
            hs.NasaPowerProvider().fetch_daily_range(
                0, 0, "1991-01-01", "2020-12-31", variables=("temperature_2m_max", "temperature_2m_min"),
            )
        assert client.get.call_args[1]["params"]["parameters"] == "T2M_MAX,T2M_MIN"

    @pytest.mark.parametrize("status,transient", [(500, True), (429, True), (422, False)])
    def test_status_errors(self, status, transient):
        client = MagicMock()
        client.get.return_value = _resp({}, status=status)
        with patch("py._history_store._http", return_value=client):
            with pytest.raises(hs.ProviderError) as exc:
                hs.NasaPowerProvider().fetch_daily_range(0, 0, "2026-01-01", "2026-01-02")
        assert exc.value.transient is transient

    def test_transport_error_is_transient(self):
        client = MagicMock()
        client.get.side_effect = Exception("ReadTimeout")
        with patch("py._history_store._http", return_value=client):
            with pytest.raises(hs.ProviderError) as exc:
                hs.NasaPowerProvider().fetch_daily_range(0, 0, "2026-01-01", "2026-01-02")
        assert exc.value.transient is True

    def test_derive_weather_code(self):
        assert hs.derive_weather_code(None, None) is None
        assert hs.derive_weather_code(3.0, None) == 61
        assert hs.derive_weather_code(0.0, 90) == 3
        assert hs.derive_weather_code(0.1, None) is None  # dry, cloud unknown: don't guess
        assert hs.derive_weather_code(0.6, 10) == 0  # reanalysis drizzle under 1 mm is dry

    def test_apparent_temperature(self):
        assert hs.apparent_temperature(None, 50, 10) is None
        # Hot and humid feels hotter; cold and windy feels colder.
        assert hs.apparent_temperature(32, 80, 5) > 32
        assert hs.apparent_temperature(5, 50, 30) < 5


class TestOpenMeteoArchive:
    def setup_method(self):
        hs._om_key_cache.clear()

    def teardown_method(self):
        hs._om_key_cache.clear()

    def test_free_host_without_key(self):
        client = MagicMock()
        client.get.return_value = _resp(ARCHIVE_PAYLOAD)
        with patch("py._history_store._http", return_value=client), patch("py._db.get_api_key", return_value=None):
            p = hs.OpenMeteoArchiveProvider()
            days = p.fetch_daily_range(-17.83, 31.05, "2026-10-07", "2026-10-09")
            assert p.commercial is False
        assert [d["date"] for d in days] == ["2026-10-07", "2026-10-08"]
        assert client.get.call_args[0][0] == hs.ARCHIVE_URL
        assert "apikey" not in client.get.call_args[1]["params"]

    def test_commercial_host_with_key(self):
        client = MagicMock()
        client.get.return_value = _resp(ARCHIVE_PAYLOAD)
        with patch("py._history_store._http", return_value=client), patch("py._db.get_api_key", return_value="k-123"):
            p = hs.OpenMeteoArchiveProvider()
            p.fetch_daily_range(-17.83, 31.05, "2026-10-07", "2026-10-09")
            assert p.commercial is True
        assert client.get.call_args[0][0] == hs.ARCHIVE_URL_COMMERCIAL
        assert client.get.call_args[1]["params"]["apikey"] == "k-123"

    def test_client_error_is_not_transient(self):
        client = MagicMock()
        client.get.return_value = _resp({}, status=400)
        with patch("py._history_store._http", return_value=client), patch("py._db.get_api_key", return_value=None):
            with pytest.raises(hs.ProviderError) as exc:
                hs.OpenMeteoArchiveProvider().fetch_daily_range(0, 0, "2026-01-01", "2026-01-02")
        assert exc.value.transient is False


class TestProviderChain:
    def test_default_order_is_nasa_power_then_open_meteo(self):
        assert [p.info.id for p in hs.provider_chain("")] == ["nasa-power", "open-meteo-archive"]

    def test_configured_order_and_unknown_ids_ignored(self):
        assert [p.info.id for p in hs.provider_chain("open-meteo-archive, bogus")] == ["open-meteo-archive"]

    def test_env_var(self, monkeypatch):
        monkeypatch.setenv("HISTORY_PROVIDERS", "nasa-power")
        assert [p.info.id for p in hs.provider_chain()] == ["nasa-power"]

    def test_attributions_per_source_present(self):
        docs = [{"source": "recorded"}, {"source": "nasa-power"}, {"source": "nasa-power"}, {"source": "open-meteo-archive"}, {}]
        out = hs.attributions_for(docs)
        assert [a["id"] for a in out] == ["nasa-power", "open-meteo-archive"]
        assert all(a["attribution"] and a["url"] and a["licence"] for a in out)


# ---------------------------------------------------------------------------
# Docs
# ---------------------------------------------------------------------------


class TestBuildDocs:
    def test_archive_shape_matches_dashboard_contract(self):
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

    def test_nasa_power_doc_tagged_with_its_source(self):
        day = hs.parse_nasa_power(POWER_PAYLOAD)[0]
        doc = hs.build_history_doc("cell:51.50_-0.15", day, source="nasa-power", now=NOW)
        assert doc["source"] == doc["provider"] == "nasa-power"
        assert doc["locationSlug"] == "cell:51.50_-0.15"
        assert doc["current"]["temperature_2m"] == 19.5
        assert doc["current"]["surface_pressure"] == pytest.approx(861.5)
        assert doc["daily"]["sunrise"] == [None]
        assert doc["insights"] == {"dewPoint": 13.4}


# ---------------------------------------------------------------------------
# Backfill
# ---------------------------------------------------------------------------


def _limiter(allowed=True):
    return MagicMock(return_value={"allowed": allowed})


class TestBackfillRange:
    @patch("py._history_store.get_db")
    def test_fetches_only_missing_and_inserts_only(self, mock_db):
        coll = _coll(mock_db)
        p = FakeProvider()
        docs = hs.backfill_range(
            "harare", -17.83, 31.05, "2026-10-06", "2026-10-10", ["2026-10-08"],
            providers=[p], now=NOW,
        )
        assert p.calls == [("2026-10-06", "2026-10-09")]  # one span; today excluded
        p.breaker.record_success.assert_called_once()
        assert [d["date"] for d in docs] == ["2026-10-09", "2026-10-07", "2026-10-06"]  # stored day skipped
        assert all(d["source"] == "nasa-power" for d in docs)
        assert len(coll.bulk_write.call_args[0][0]) == 3
        assert coll.bulk_write.call_args[1] == {"ordered": False}

    def test_upsert_uses_set_on_insert_only(self):
        captured = {}

        def fake_update_one(flt, upd, upsert):
            captured.update(flt=flt, upd=upd, upsert=upsert)
            return ("op", flt, upd)

        with patch("pymongo.UpdateOne", side_effect=fake_update_one), patch("py._history_store.get_db") as mock_db:
            _coll(mock_db)
            hs._upsert_archive_docs([{"locationSlug": "harare", "date": "2026-10-07", "source": "nasa-power"}])
        assert captured["flt"] == {"locationSlug": "harare", "date": "2026-10-07"}
        assert set(captured["upd"]) == {"$setOnInsert"}  # a stored day is never overwritten
        assert "locationSlug" not in captured["upd"]["$setOnInsert"]
        assert captured["upsert"] is True

    def test_nothing_missing_makes_no_request(self):
        p = FakeProvider()
        existing = ["2026-10-07", "2026-10-08", "2026-10-09"]
        assert hs.backfill_range("harare", 0, 31.05, "2026-10-07", "2026-10-10", existing, providers=[p], now=NOW) == []
        assert p.calls == []

    @patch("py._history_store.get_db")
    def test_fallback_fills_what_primary_lacks(self, mock_db):
        _coll(mock_db)
        # POWER lags: it has nothing for the last two days.
        primary = FakeProvider("nasa-power", days=[
            {"date": "2026-10-06", "temperature_2m_max": 25.0, "temperature_2m_min": 12.0},
            {"date": "2026-10-07", "temperature_2m_max": 25.0, "temperature_2m_min": 12.0},
        ])
        fallback = FakeProvider("open-meteo-archive")
        docs = hs.backfill_range("harare", 0, 31.05, "2026-10-06", "2026-10-10", [], providers=[primary, fallback], now=NOW)
        by_date = {d["date"]: d["source"] for d in docs}
        assert by_date == {
            "2026-10-06": "nasa-power", "2026-10-07": "nasa-power",
            "2026-10-08": "open-meteo-archive", "2026-10-09": "open-meteo-archive",
        }
        assert fallback.calls == [("2026-10-08", "2026-10-09")]

    @patch("py._history_store.get_db")
    def test_primary_outage_falls_through_and_trips_its_breaker(self, mock_db):
        _coll(mock_db)
        primary = FakeProvider("nasa-power", exc=hs.ProviderError("boom"))
        fallback = FakeProvider("open-meteo-archive")
        docs = hs.backfill_range("harare", 0, 31.05, "2026-10-06", "2026-10-10", [], providers=[primary, fallback], now=NOW)
        primary.breaker.record_failure.assert_called_once()
        assert {d["source"] for d in docs} == {"open-meteo-archive"}
        assert len(docs) == 4

    def test_client_error_does_not_trip_breaker(self):
        primary = FakeProvider("nasa-power", exc=hs.ProviderError("422", status=422, transient=False))
        with patch("py._history_store.get_db") as mock_db:
            _coll(mock_db)
            hs.backfill_range("harare", 0, 31.05, "2026-10-06", "2026-10-10", [], providers=[primary], now=NOW)
        primary.breaker.record_failure.assert_not_called()

    def test_all_providers_down_returns_empty_never_raises(self):
        a = FakeProvider("nasa-power", exc=hs.ProviderError("x"))
        b = FakeProvider("open-meteo-archive", allowed=False)
        assert hs.backfill_range("harare", 0, 31.05, "2026-10-06", "2026-10-10", [], providers=[a, b], now=NOW) == []
        assert b.calls == []

    def test_open_breaker_skips(self):
        p = FakeProvider(allowed=False)
        assert hs.backfill_range("harare", 0, 31.05, "2026-10-06", "2026-10-10", [], providers=[p], now=NOW) == []
        assert p.calls == []

    def test_rate_limited_ip_skips(self):
        p = FakeProvider()
        limiter = _limiter(False)
        out = hs.backfill_range(
            "harare", 0, 31.05, "2026-10-06", "2026-10-10", [], providers=[p],
            client_ip="1.2.3.4", rate_limiter=limiter, now=NOW,
        )
        assert out == []
        assert p.calls == []
        limiter.assert_called_once_with("1.2.3.4", "history-backfill", hs.BACKFILL_RATE_LIMIT, hs.BACKFILL_RATE_WINDOW_S)

    @patch("py._history_store.get_db")
    def test_per_provider_budget_exhausted_falls_through(self, mock_db):
        _coll(mock_db)
        primary, fallback = FakeProvider("nasa-power"), FakeProvider("open-meteo-archive")

        def limiter(ip, action, limit, window):
            if action == "history-backfill":
                return {"allowed": True}
            return {"allowed": action != "history-provider:nasa-power"}

        docs = hs.backfill_range(
            "harare", 0, 31.05, "2026-10-06", "2026-10-10", [], providers=[primary, fallback],
            client_ip="1.2.3.4", rate_limiter=limiter, now=NOW,
        )
        assert primary.calls == []
        assert {d["source"] for d in docs} == {"open-meteo-archive"}

    def test_budget_is_global_per_provider(self):
        limiter = _limiter(True)
        p = FakeProvider("nasa-power")
        assert hs._budget_allows(p, limiter)
        limiter.assert_called_once_with("global", "history-provider:nasa-power", 10, hs.PROVIDER_BUDGET_WINDOW_S)

    @patch("py._history_store.get_db")
    def test_cooldown_blocks_same_range_but_not_wider(self, mock_db):
        _coll(mock_db)
        p = FakeProvider(days=[])  # archive has nothing yet (lag)
        hs.backfill_range("harare", 0, 31.05, "2026-10-06", "2026-10-10", [], providers=[p], now=NOW)
        hs.backfill_range("harare", 0, 31.05, "2026-10-07", "2026-10-10", [], providers=[p], now=NOW)
        assert len(p.calls) == 1
        # A wider window (user picked 30 days) is a new attempt.
        hs.backfill_range("harare", 0, 31.05, "2026-09-11", "2026-10-10", [], providers=[p], now=NOW)
        assert len(p.calls) == 2

    def test_failed_fetch_sets_no_cooldown(self):
        p = FakeProvider(exc=hs.ProviderError("timeout"))
        with patch("py._history_store.get_db") as mock_db:
            _coll(mock_db)
            hs.backfill_range("harare", 0, 31.05, "2026-10-06", "2026-10-10", [], providers=[p], now=NOW)
            hs.backfill_range("harare", 0, 31.05, "2026-10-06", "2026-10-10", [], providers=[p], now=NOW)
        assert len(p.calls) == 2

    @patch("py._history_store.get_db")
    def test_failed_persist_sets_no_cooldown_but_returns_days(self, mock_db):
        coll = _coll(mock_db)
        coll.bulk_write.side_effect = Exception("over quota")
        p = FakeProvider()
        first = hs.backfill_range("harare", 0, 31.05, "2026-10-06", "2026-10-10", [], providers=[p], now=NOW)
        hs.backfill_range("harare", 0, 31.05, "2026-10-06", "2026-10-10", [], providers=[p], now=NOW)
        assert len(first) == 4
        assert len(p.calls) == 2

    @patch("py._history_store.get_db")
    def test_long_range_chunked_by_provider_span(self, mock_db):
        _coll(mock_db)
        p = FakeProvider("open-meteo-archive", max_span=366)
        docs = hs.backfill_range("harare", 0, 31.05, "2024-10-11", "2026-10-10", [], providers=[p], now=NOW)
        assert len(p.calls) == 2
        assert p.calls[0][1] == "2026-10-09"  # newest chunk first
        assert len(docs) == len(hs.date_span("2024-10-11", "2026-10-09"))

    @patch("py._history_store.get_db")
    def test_fetch_cap_per_call_then_resumes(self, mock_db):
        _coll(mock_db)
        p = FakeProvider("open-meteo-archive", max_span=30)
        first = hs.backfill_range("harare", 0, 31.05, "2026-01-01", "2026-10-10", [], providers=[p], now=NOW)
        assert len(p.calls) == hs.MAX_FETCHES_PER_CALL
        # Not complete, so no cooldown: the next view continues with what's left.
        have = [d["date"] for d in first]
        hs.backfill_range("harare", 0, 31.05, "2026-01-01", "2026-10-10", have, providers=[p], now=NOW)
        assert len(p.calls) > hs.MAX_FETCHES_PER_CALL
        assert all(c[1] < min(have) for c in p.calls[hs.MAX_FETCHES_PER_CALL:])

    @patch("py._history_store.get_db")
    def test_time_budget_stops_new_fetches(self, mock_db):
        _coll(mock_db)
        p = FakeProvider("open-meteo-archive", max_span=30)
        ticks = iter([0.0] + [hs.BACKFILL_TIME_BUDGET_S + 1] * 50)
        hs.backfill_range(
            "harare", 0, 31.05, "2026-01-01", "2026-10-10", [], providers=[p], now=NOW,
            clock=lambda: next(ticks),
        )
        assert p.calls == []

    @patch("py._history_store.get_db")
    def test_dates_before_provider_coverage_go_to_next(self, mock_db):
        _coll(mock_db)
        power = FakeProvider("nasa-power", earliest="1981-01-01")
        om = FakeProvider("open-meteo-archive")
        docs = hs.backfill_range("harare", 0, 31.05, "1979-12-30", "1980-01-02", [], providers=[power, om], now=NOW)
        assert power.calls == []
        assert {d["source"] for d in docs} == {"open-meteo-archive"}

    def test_backfill_history_wrapper_uses_last_n_days(self):
        p = FakeProvider(days=[])
        with patch("py._history_store.get_db") as mock_db:
            _coll(mock_db)
            hs.backfill_history("harare", 0, 31.05, 4, ["2026-10-08"], providers=[p], now=NOW)
        assert p.calls == [("2026-10-07", "2026-10-09")]

    def test_offset_estimate_matches_weather_endpoint(self):
        from py._weather import _estimate_utc_offset

        for lon in (31.05, 77.2, 87.6, -75.0, 103.8):
            assert hs.estimate_utc_offset_seconds(lon) == _estimate_utc_offset(lon)


class TestNormalsSeries:
    def test_first_provider_that_answers_wins(self):
        a = FakeProvider("nasa-power", exc=hs.ProviderError("down"))
        b = FakeProvider("open-meteo-archive")
        daily, provider, reason = hs.fetch_normals_series(0, 0, "2020-01-01", "2020-01-03", providers=[a, b])
        assert provider is b and reason is None
        assert daily["time"] == ["2020-01-01", "2020-01-02", "2020-01-03"]
        a.breaker.record_failure.assert_called_once()

    def test_all_closed_is_circuit_open(self):
        a = FakeProvider(allowed=False)
        assert hs.fetch_normals_series(0, 0, "2020-01-01", "2020-01-03", providers=[a]) == (None, None, "circuit_open")

    def test_empty_is_no_data(self):
        a = FakeProvider(days=[])
        assert hs.fetch_normals_series(0, 0, "2020-01-01", "2020-01-03", providers=[a])[2] == "no_data"
