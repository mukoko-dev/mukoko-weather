"""Tests for _enrichment.py — Tomorrow.io budget guard + enrichment (issue #246)."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

from py import _enrichment as enrichment
from py._enrichment import (
    DAILY_CAP,
    DAILY_CAP_NORMAL,
    ENRICHMENT_FIELDS,
    HOURLY_CAP,
    HOURLY_CAP_NORMAL,
    merge_insights,
    reserve_call,
)


class DuplicateKeyError(Exception):
    """Stand-in with the same class name pymongo raises."""


class FakeBudget:
    """In-memory collection with MongoDB's guarded-upsert semantics."""

    def __init__(self):
        self.docs: dict[str, dict] = {}

    def find_one_and_update(self, flt, update, upsert=False):
        _id = flt["_id"]
        doc = self.docs.get(_id)
        cap = flt.get("count", {}).get("$lt")
        if doc is not None and (cap is None or doc.get("count", 0) < cap):
            doc["count"] = doc.get("count", 0) + update["$inc"]["count"]
            return doc
        if doc is not None:
            raise DuplicateKeyError("E11000")  # filter missed → upsert hits existing _id
        self.docs[_id] = {"_id": _id, "count": update["$inc"]["count"], **update.get("$setOnInsert", {})}
        return None

    def update_one(self, flt, update, upsert=False):
        doc = self.docs.get(flt["_id"])
        if doc is None:
            if not upsert:
                return
            doc = self.docs[flt["_id"]] = {"_id": flt["_id"]}
        if "count" in flt and doc.get("count", 0) <= flt["count"].get("$gt", -1):
            return
        for k, v in update.get("$inc", {}).items():
            doc[k] = doc.get(k, 0) + v
        doc.update(update.get("$set", {}))

    def find(self, flt):
        return [d for k, d in self.docs.items() if k in flt["_id"]["$in"]]


@pytest.fixture(autouse=True)
def _clear_memos():
    enrichment._reset_memos()
    yield
    enrichment._reset_memos()


@pytest.fixture
def budget():
    fake = FakeBudget()
    with patch.object(enrichment, "_budget_collection", return_value=fake):
        yield fake


NOW = datetime(2026, 10, 10, 9, 30, tzinfo=timezone.utc)


class TestBudgetGuard:
    def test_caps_leave_headroom_under_free_tier(self):
        assert HOURLY_CAP < 25 and DAILY_CAP < 500
        assert HOURLY_CAP_NORMAL < HOURLY_CAP and DAILY_CAP_NORMAL < DAILY_CAP

    def test_normal_traffic_stops_at_normal_hourly_cap(self, budget):
        granted = [reserve_call(False, NOW) for _ in range(HOURLY_CAP_NORMAL + 5)]
        assert granted.count(True) == HOURLY_CAP_NORMAL

    def test_priority_uses_reserved_headroom(self, budget):
        for _ in range(HOURLY_CAP_NORMAL):
            assert reserve_call(False, NOW)
        assert reserve_call(False, NOW) is False
        granted = [reserve_call(True, NOW) for _ in range(20)]
        assert granted.count(True) == HOURLY_CAP - HOURLY_CAP_NORMAL
        assert budget.docs["tomorrow:hour:2026101009"]["count"] == HOURLY_CAP

    def test_new_hour_resets_hourly_bucket(self, budget):
        for _ in range(HOURLY_CAP_NORMAL):
            reserve_call(False, NOW)
        assert reserve_call(False, NOW.replace(hour=10)) is True

    def test_daily_cap_refunds_hour_slot(self, budget):
        budget.docs["tomorrow:day:20261010"] = {"_id": "tomorrow:day:20261010", "count": DAILY_CAP_NORMAL}
        assert reserve_call(False, NOW) is False
        # The hour slot taken before the day check failed is given back.
        assert budget.docs["tomorrow:hour:2026101009"]["count"] == 0
        assert reserve_call(True, NOW) is True  # priority still has daily headroom

    def test_db_error_fails_closed(self):
        broken = MagicMock()
        broken.find_one_and_update.side_effect = RuntimeError("cluster down")
        with patch.object(enrichment, "_budget_collection", return_value=broken):
            assert reserve_call(True, NOW) is False

    def test_budget_snapshot(self, budget):
        reserve_call(False, NOW)
        enrichment.record_skip(enrichment.SKIPPED_BUDGET, "harare", NOW)
        with patch.object(enrichment, "datetime") as dt:
            dt.now.return_value = NOW
            snap = enrichment.budget_snapshot(NOW)
        assert snap["hourUsed"] == 1 and snap["dayUsed"] == 1
        assert snap["skippedBudget"] == 1
        assert snap["lastSkipReason"] == "skipped-budget"


class TestRecordSkip:
    def test_counts_by_reason(self, budget):
        enrichment.record_skip(enrichment.SKIPPED_ERROR, "harare", NOW)
        enrichment.record_skip(enrichment.SKIPPED_ERROR, "mutare", NOW)
        enrichment.record_skip(enrichment.SKIPPED_BUDGET, "bulawayo", NOW)
        stats = budget.docs["tomorrow:stats:20261010"]
        assert stats["skippedError"] == 2
        assert stats["skippedBudget"] == 1
        assert stats["lastSkipSlug"] == "bulawayo"


    def test_deduplicated_per_location_hour(self, budget):
        # A busy location adds one stats write per hour, not one per request.
        for _ in range(5):
            enrichment.record_skip(enrichment.SKIPPED_BUDGET, "harare", NOW)
        assert budget.docs["tomorrow:stats:20261010"]["skippedBudget"] == 1
        enrichment.record_skip(enrichment.SKIPPED_BUDGET, "harare", NOW.replace(hour=10))
        assert budget.docs["tomorrow:stats:20261010"]["skippedBudget"] == 2


class TestMerge:
    def test_only_enrichment_fields_override(self):
        base = {"windSpeed": 10, "dewPoint": 12, "thunderstormProbability": 0, "visibility": 20}
        extra = {"thunderstormProbability": 55, "heatStressIndex": 31}
        merged = merge_insights(base, extra)
        assert merged["thunderstormProbability"] == 55
        assert merged["heatStressIndex"] == 31
        assert merged["windSpeed"] == 10 and merged["dewPoint"] == 12 and merged["visibility"] == 20

    def test_none_enrichment_keeps_baseline(self):
        assert merge_insights({"a": 1}, None) == {"a": 1}
        assert merge_insights(None, None) == {}

    def test_wind_visibility_and_uv_are_never_enrichment_fields(self):
        # uvHealthConcern: Tomorrow.io's is a 0–4 category; the rules expect
        # the 0–11+ UV index (e.g. "gt 7"), so it must stay with the baseline.
        # evapotranspiration: Tomorrow.io's is an hourly average, the rules use mm/day.
        for k in ("windSpeed", "windGust", "visibility", "dewPoint", "uvHealthConcern", "evapotranspiration"):
            assert k not in ENRICHMENT_FIELDS


class TestEnrich:
    @pytest.fixture(autouse=True)
    def _no_cache(self):
        with patch.object(enrichment, "get_cached_enrichment", return_value=None), patch.object(
            enrichment, "set_cached_enrichment"
        ) as setter, patch.object(enrichment, "record_skip") as skip:
            self.setter = setter
            self.skip = skip
            yield

    def test_cache_hit_spends_nothing(self):
        with patch.object(enrichment, "get_cached_enrichment", return_value={"moonPhase": 3}), patch.object(
            enrichment, "reserve_call"
        ) as reserve:
            assert enrichment.enrich("harare", -17.8, 31.0) == ({"moonPhase": 3}, "tomorrow")
            reserve.assert_not_called()

    @patch("py._enrichment.tomorrow_breaker")
    def test_open_breaker_is_skipped_error(self, breaker):
        breaker.is_allowed = False
        assert enrichment.enrich("harare", -17.8, 31.0) == (None, "skipped-error")
        self.skip.assert_called_once_with("skipped-error", "harare")

    @patch("py._db.get_api_key", return_value=None)
    @patch("py._enrichment.tomorrow_breaker")
    def test_no_key_is_none(self, breaker, _key):
        breaker.is_allowed = True
        assert enrichment.enrich("harare", -17.8, 31.0) == (None, "none")

    @patch("py._enrichment.reserve_call", return_value=False)
    @patch("py._db.get_api_key", return_value="k")
    @patch("py._enrichment.tomorrow_breaker")
    def test_budget_exhausted_is_skipped_budget_and_no_call(self, breaker, _key, _reserve):
        breaker.is_allowed = True
        with patch.object(enrichment, "fetch_tomorrow_insights") as fetch:
            assert enrichment.enrich("harare", -17.8, 31.0, priority=True) == (None, "skipped-budget")
            fetch.assert_not_called()
        _reserve.assert_called_once_with(priority=True)

    @patch("py._db.get_api_key", return_value="k")
    @patch("py._enrichment.tomorrow_breaker")
    def test_exhausted_budget_is_memoised_for_the_hour(self, breaker, _key):
        breaker.is_allowed = True
        with patch.object(enrichment, "reserve_call", return_value=False) as reserve:
            for _ in range(4):
                assert enrichment.enrich("harare", -17.8, 31.0) == (None, "skipped-budget")
        reserve.assert_called_once()  # later requests skip the reservation write

    @patch("py._enrichment.reserve_call", return_value=True)
    @patch("py._db.get_api_key", return_value="k")
    @patch("py._enrichment.tomorrow_breaker")
    def test_429_or_timeout_is_skipped_error(self, breaker, _key, _reserve):
        breaker.is_allowed = True
        with patch.object(enrichment, "fetch_tomorrow_insights", side_effect=TimeoutError()):
            assert enrichment.enrich("harare", -17.8, 31.0) == (None, "skipped-error")
        breaker.record_failure.assert_called_once()

    @patch("py._enrichment.reserve_call", return_value=True)
    @patch("py._db.get_api_key", return_value="k")
    @patch("py._enrichment.tomorrow_breaker")
    def test_success_caches_for_hours(self, breaker, _key, _reserve):
        breaker.is_allowed = True
        with patch.object(enrichment, "fetch_tomorrow_insights", return_value={"heatStressIndex": 30}):
            assert enrichment.enrich("harare", -17.8, 31.0) == ({"heatStressIndex": 30}, "tomorrow")
        self.setter.assert_called_once_with("harare", {"heatStressIndex": 30})
        breaker.record_success.assert_called_once()
        assert enrichment.ENRICHMENT_TTL_S >= 3600


class TestFetchTomorrowInsights:
    @patch("py._http.get_http_client")
    def test_429_raises_unavailable_with_status_only(self, client):
        client.return_value.get.return_value = MagicMock(status_code=429)
        with pytest.raises(enrichment.TomorrowUnavailable) as exc:
            enrichment.fetch_tomorrow_insights(-17.8, 31.0, "secret-key")
        assert str(exc.value) == "HTTP 429"
        assert "secret-key" not in str(exc.value)

    @patch("py._http.get_http_client")
    def test_timeout_raises_unavailable(self, client):
        client.return_value.get.side_effect = TimeoutError("read timed out")
        with pytest.raises(enrichment.TomorrowUnavailable) as exc:
            enrichment.fetch_tomorrow_insights(-17.8, 31.0, "k")
        assert str(exc.value) == "TimeoutError"

    @patch("py._http.get_http_client")
    def test_daily_only_and_filtered_fields(self, client):
        resp = MagicMock(status_code=200)
        resp.json.return_value = {
            "timelines": {
                "daily": [{"time": "2026-10-10", "values": {
                    "thunderstormProbability": 30, "heatIndexMax": 33, "windSpeedMax": 40, "moonPhase": 2,
                }}],
            }
        }
        client.return_value.get.return_value = resp
        out = enrichment.fetch_tomorrow_insights(-17.8, 31.0, "k")
        assert client.return_value.get.call_args.kwargs["params"]["timesteps"] == "1d"
        assert out == {"thunderstormProbability": 30, "heatStressIndex": 33, "moonPhase": 2}

    @patch("py._http.get_http_client")
    def test_uv_health_concern_category_is_dropped(self, client):
        resp = MagicMock(status_code=200)
        resp.json.return_value = {"timelines": {"daily": [{"values": {"uvHealthConcernMax": 4}}]}}
        client.return_value.get.return_value = resp
        assert enrichment.fetch_tomorrow_insights(-17.8, 31.0, "k") == {}


#: A clear-sky day as the free /v4/weather/forecast endpoint returns it: the
#: daily values carry none of thunderstormProbability / heatIndexMax / gdd /
#: moonPhase / precipitationTypeMax, and cloudBaseAvg / cloudCeilingAvg are
#: null without cloud. This is what production saw on v0.7.0.
CLEAR_SKY_DAILY = {
    "timelines": {
        "daily": [{
            "time": "2026-10-10T04:00:00Z",
            "values": {
                "cloudBaseAvg": None, "cloudCeilingAvg": None, "cloudCoverAvg": 4,
                "evapotranspirationAvg": 0.218, "uvHealthConcernMax": 3, "uvIndexMax": 10,
                "temperatureMax": 28.1, "temperatureMin": 16.4, "windSpeedMax": 5.2,
                "visibilityAvg": 24.1, "weatherCodeMax": 1000, "moonriseTime": "2026-10-10T03:51:00Z",
            },
        }],
    }
}


class TestClearSkyIsNotAFailure:
    """Regression: a 200 with nothing to merge tripped the breaker in prod."""

    @patch("py._http.get_http_client")
    def test_fetch_returns_empty_dict_on_200_without_enrichable_fields(self, client):
        resp = MagicMock(status_code=200)
        resp.json.return_value = CLEAR_SKY_DAILY
        client.return_value.get.return_value = resp
        assert enrichment.fetch_tomorrow_insights(-17.83, 31.05, "k") == {}

    @patch("py._enrichment.reserve_call", return_value=True)
    @patch("py._db.get_api_key", return_value="k")
    @patch("py._enrichment.tomorrow_breaker")
    @patch("py._http.get_http_client")
    def test_enrich_reports_tomorrow_records_success_and_caches(self, client, breaker, _key, _reserve):
        breaker.is_allowed = True
        resp = MagicMock(status_code=200)
        resp.json.return_value = CLEAR_SKY_DAILY
        client.return_value.get.return_value = resp
        with patch.object(enrichment, "get_cached_enrichment", return_value=None), patch.object(
            enrichment, "set_cached_enrichment"
        ) as setter, patch.object(enrichment, "record_skip") as skip:
            assert enrichment.enrich("cell:-17.85_31.05", -17.83, 31.05) == (None, "tomorrow")
        breaker.record_failure.assert_not_called()
        breaker.record_success.assert_called_once()
        setter.assert_called_once_with("cell:-17.85_31.05", {})
        skip.assert_not_called()

    def test_cached_empty_answer_is_a_hit_and_spends_nothing(self):
        with patch.object(enrichment, "get_cached_enrichment", return_value={}), patch.object(
            enrichment, "reserve_call"
        ) as reserve:
            assert enrichment.enrich("cell:x", 0, 0) == (None, "tomorrow")
        reserve.assert_not_called()

    def test_get_cached_enrichment_distinguishes_miss_from_empty(self):
        coll = MagicMock()
        with patch.object(enrichment, "_enrichment_collection", return_value=coll):
            coll.find_one.return_value = None
            assert enrichment.get_cached_enrichment("a") is None
            coll.find_one.return_value = {"_id": "a", "insights": {}}
            assert enrichment.get_cached_enrichment("a") == {}
            coll.find_one.return_value = {"_id": "a", "insights": {"cloudBase": 1.2}}
            assert enrichment.get_cached_enrichment("a") == {"cloudBase": 1.2}


class TestEnrichThroughRealFetch:
    """enrich() driven through fetch_tomorrow_insights with a fake HTTP client."""

    @pytest.fixture(autouse=True)
    def _stubs(self):
        with patch.object(enrichment, "get_cached_enrichment", return_value=None), patch.object(
            enrichment, "set_cached_enrichment"
        ) as setter, patch.object(enrichment, "reserve_call", return_value=True), patch(
            "py._db.get_api_key", return_value="super-secret"
        ), patch.object(enrichment, "_budget_collection") as coll:
            self.setter = setter
            self.coll = coll
            yield

    def _stats_set(self):
        return self.coll.return_value.update_one.call_args.args[1]["$set"]

    @patch("py._enrichment.tomorrow_breaker")
    @patch("py._http.get_http_client")
    def test_429_is_a_budget_skip_not_a_breaker_failure(self, client, breaker):
        breaker.is_allowed = True
        client.return_value.get.return_value = MagicMock(status_code=429)
        assert enrichment.enrich("cell:a", 0, 0) == (None, "skipped-budget")
        breaker.record_failure.assert_not_called()
        assert self._stats_set()["lastErrorDetail"] == "HTTP 429"
        # The rest of the hour skips the call (and its reservation) entirely.
        assert enrichment.enrich("cell:b", 0, 0) == (None, "skipped-budget")
        assert client.return_value.get.call_count == 1

    @patch("py._enrichment.tomorrow_breaker")
    @patch("py._http.get_http_client")
    def test_401_trips_breaker_and_records_reason_without_key(self, client, breaker):
        breaker.is_allowed = True
        client.return_value.get.return_value = MagicMock(status_code=401)
        assert enrichment.enrich("cell:a", 0, 0) == (None, "skipped-error")
        breaker.record_failure.assert_called_once()
        assert self._stats_set()["lastErrorDetail"] == "HTTP 401"
        assert "super-secret" not in str(self.coll.return_value.update_one.call_args)

    @patch("py._enrichment.tomorrow_breaker")
    @patch("py._http.get_http_client")
    def test_real_httpx_timeout_is_a_breaker_failure(self, client, breaker):
        import httpx

        breaker.is_allowed = True
        client.return_value.get.side_effect = httpx.ReadTimeout("timed out")
        assert enrichment.enrich("cell:a", 0, 0) == (None, "skipped-error")
        breaker.record_failure.assert_called_once()
        assert self._stats_set()["lastErrorDetail"] == "ReadTimeout"

    @pytest.mark.parametrize("body", [None, [], {}, {"timelines": None}, {"timelines": {"daily": []}}])
    @patch("py._enrichment.tomorrow_breaker")
    @patch("py._http.get_http_client")
    def test_200_without_daily_timeline_is_not_cached_as_healthy(self, client, breaker, body):
        breaker.is_allowed = True
        resp = MagicMock(status_code=200)
        resp.json.return_value = body
        client.return_value.get.return_value = resp
        assert enrichment.enrich("cell:a", 0, 0) == (None, "skipped-error")
        breaker.record_failure.assert_called_once()
        breaker.record_success.assert_not_called()
        self.setter.assert_not_called()


class TestEmptyAnswerTtl:
    def test_empty_answer_uses_the_shorter_ttl(self):
        coll = MagicMock()
        with patch.object(enrichment, "_enrichment_collection", return_value=coll):
            enrichment.set_cached_enrichment("a", {})
            empty = coll.update_one.call_args.args[1]["$set"]
            enrichment.set_cached_enrichment("a", {"cloudBase": 1.0})
            full = coll.update_one.call_args.args[1]["$set"]
        assert enrichment.EMPTY_ENRICHMENT_TTL_S < enrichment.ENRICHMENT_TTL_S
        span = lambda d: (d["expiresAt"] - d["fetchedAt"]).total_seconds()  # noqa: E731
        assert span(empty) == enrichment.EMPTY_ENRICHMENT_TTL_S
        assert span(full) == enrichment.ENRICHMENT_TTL_S
