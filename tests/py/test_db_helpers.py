"""Tests for _db.py shared helpers — get_client_ip, check_rate_limit."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from py._db import (
    enforce_rate_limit,
    get_client_ip,
    check_rate_limit,
    filter_known_activities,
    ttl_filter,
    ttl_find_one,
    ttl_upsert,
    is_valid_coords,
)


# ---------------------------------------------------------------------------
# get_client_ip — Vercel reverse proxy IP extraction
# ---------------------------------------------------------------------------


class TestGetClientIp:
    def test_prefers_x_forwarded_for(self, mock_request):
        """x-forwarded-for (first entry) should be preferred over client.host."""
        req = mock_request(ip="10.0.0.1", forwarded_for="203.0.113.42, 10.0.0.1")
        assert get_client_ip(req) == "203.0.113.42"

    def test_single_forwarded_for(self, mock_request):
        req = mock_request(ip="10.0.0.1", forwarded_for="198.51.100.10")
        assert get_client_ip(req) == "198.51.100.10"

    def test_strips_whitespace_from_forwarded_for(self, mock_request):
        req = mock_request(ip="10.0.0.1", forwarded_for="  198.51.100.10 , 10.0.0.1")
        assert get_client_ip(req) == "198.51.100.10"

    def test_falls_back_to_x_real_ip(self, mock_request):
        """When x-forwarded-for is absent, use x-real-ip."""
        req = mock_request(ip="10.0.0.1", real_ip="203.0.113.42")
        assert get_client_ip(req) == "203.0.113.42"

    def test_strips_whitespace_from_real_ip(self, mock_request):
        req = mock_request(ip="10.0.0.1", real_ip="  203.0.113.42  ")
        assert get_client_ip(req) == "203.0.113.42"

    def test_x_forwarded_for_preferred_over_x_real_ip(self, mock_request):
        req = mock_request(
            ip="10.0.0.1",
            forwarded_for="198.51.100.10",
            real_ip="203.0.113.42",
        )
        assert get_client_ip(req) == "198.51.100.10"

    def test_falls_back_to_client_host(self, mock_request):
        """When no proxy headers, return request.client.host."""
        req = mock_request(ip="192.168.1.100")
        assert get_client_ip(req) == "192.168.1.100"

    def test_returns_none_when_no_client(self, mock_request):
        req = mock_request(ip=None)
        assert get_client_ip(req) is None


# ---------------------------------------------------------------------------
# check_rate_limit
# ---------------------------------------------------------------------------


class TestCheckRateLimit:
    @patch("py._db.rate_limits_collection")
    def test_allows_under_limit(self, mock_coll):
        mock_result = {"key": "chat:1.2.3.4", "count": 1, "expiresAt": None}
        mock_coll.return_value.find_one_and_update.return_value = mock_result

        result = check_rate_limit("1.2.3.4", "chat", 20, 3600)
        assert result["allowed"] is True
        assert result["remaining"] == 19

    @patch("py._db.rate_limits_collection")
    def test_denies_over_limit(self, mock_coll):
        mock_result = {"key": "chat:1.2.3.4", "count": 21, "expiresAt": None}
        mock_coll.return_value.find_one_and_update.return_value = mock_result

        result = check_rate_limit("1.2.3.4", "chat", 20, 3600)
        assert result["allowed"] is False
        assert result["remaining"] == 0

    @patch("py._db.rate_limits_collection")
    def test_exactly_at_limit_is_allowed(self, mock_coll):
        mock_result = {"key": "chat:1.2.3.4", "count": 20, "expiresAt": None}
        mock_coll.return_value.find_one_and_update.return_value = mock_result

        result = check_rate_limit("1.2.3.4", "chat", 20, 3600)
        assert result["allowed"] is True
        assert result["remaining"] == 0

    @patch("py._db.rate_limits_collection")
    def test_uses_action_ip_composite_key(self, mock_coll):
        mock_coll.return_value.find_one_and_update.return_value = {"count": 1}
        check_rate_limit("1.2.3.4", "chat", 20, 3600)

        call_args = mock_coll.return_value.find_one_and_update.call_args
        assert call_args[0][0] == {"key": "chat:1.2.3.4"}

    @patch("py._db.rate_limits_collection")
    def test_handles_none_result(self, mock_coll):
        mock_coll.return_value.find_one_and_update.return_value = None

        result = check_rate_limit("1.2.3.4", "chat", 20, 3600)
        assert result["allowed"] is True
        assert result["remaining"] == 19

    @patch("py._db.rate_limits_collection")
    def test_fails_open_when_write_raises(self, mock_coll):
        # The limiter's upsert is a DB write that runs BEFORE the real work.
        # When the cluster rejects writes (storage quota, credential
        # rotation), the limiter must fail OPEN — serving unmetered beats
        # 500ing every rate-limited endpoint at once.
        mock_coll.return_value.find_one_and_update.side_effect = Exception(
            "you are over your space quota"
        )

        result = check_rate_limit("1.2.3.4", "chat", 20, 3600)
        assert result["allowed"] is True

    @patch("py._db.rate_limits_collection")
    def test_fails_open_when_collection_accessor_raises(self, mock_coll):
        mock_coll.side_effect = Exception("connection refused")

        result = check_rate_limit("1.2.3.4", "chat", 20, 3600)
        assert result["allowed"] is True


# ---------------------------------------------------------------------------
# filter_known_activities — validates user-supplied activities against known
# ids (5-min cached DB lookup) before splicing them into any AI prompt
# ---------------------------------------------------------------------------


class TestFilterKnownActivities:
    def setup_method(self):
        # Reset the module-level cache so each test starts fresh.
        import py._db as db_mod
        db_mod._known_activities = None
        db_mod._known_activities_at = 0

    @patch("py._db.activities_collection")
    def test_drops_unknown_activities(self, mock_coll):
        mock_coll.return_value.find.return_value = [
            {"id": "soccer"}, {"id": "braai"}, {"id": None},
        ]
        result = filter_known_activities(["soccer", "<script>evil</script>", "braai"])
        assert result == ["soccer", "braai"]

    @patch("py._db.activities_collection")
    def test_empty_input_returns_empty(self, mock_coll):
        mock_coll.return_value.find.return_value = [{"id": "soccer"}]
        assert filter_known_activities([]) == []

    @patch("py._db.activities_collection")
    def test_all_unknown_returns_empty(self, mock_coll):
        mock_coll.return_value.find.return_value = [{"id": "soccer"}]
        assert filter_known_activities(["fake-1", "fake-2"]) == []

    def test_falls_back_when_db_unavailable(self):
        with patch("py._db.activities_collection", side_effect=RuntimeError("no db")):
            result = filter_known_activities(["mining", "not-a-real-activity"])
        assert result == ["mining"]

    @patch("py._db.activities_collection")
    def test_caches_result_across_calls(self, mock_coll):
        mock_coll.return_value.find.return_value = [{"id": "soccer"}]
        first = filter_known_activities(["soccer", "different"])
        mock_coll.return_value.find.return_value = [{"id": "different"}]
        second = filter_known_activities(["soccer", "different"])
        assert first == second == ["soccer"]


# ---------------------------------------------------------------------------
# require_internal_caller (issue #92)
# ---------------------------------------------------------------------------


class TestRequireInternalCaller:
    """Opt-in shared-secret gate for proxy-fronted AI routes."""

    def _req(self, header_value=None):
        req = MagicMock()
        req.headers.get.return_value = header_value
        return req

    def test_noop_when_secret_unset(self, monkeypatch):
        from py._db import require_internal_caller
        monkeypatch.delenv("MUKOKO_INTERNAL_SECRET", raising=False)
        # No env var → guard disabled, any caller passes (backwards compatible).
        require_internal_caller(self._req(None))
        require_internal_caller(None)

    def test_rejects_missing_header_when_secret_set(self, monkeypatch):
        from fastapi import HTTPException
        from py._db import require_internal_caller
        monkeypatch.setenv("MUKOKO_INTERNAL_SECRET", "s3cret")
        with pytest.raises(HTTPException) as exc:
            require_internal_caller(self._req(None))
        assert exc.value.status_code == 401

    def test_rejects_wrong_secret(self, monkeypatch):
        from fastapi import HTTPException
        from py._db import require_internal_caller
        monkeypatch.setenv("MUKOKO_INTERNAL_SECRET", "s3cret")
        with pytest.raises(HTTPException) as exc:
            require_internal_caller(self._req("wrong"))
        assert exc.value.status_code == 401

    def test_accepts_matching_secret(self, monkeypatch):
        from py._db import require_internal_caller
        monkeypatch.setenv("MUKOKO_INTERNAL_SECRET", "s3cret")
        require_internal_caller(self._req("s3cret"))  # no raise

    def test_rejects_none_request_when_secret_set(self, monkeypatch):
        from fastapi import HTTPException
        from py._db import require_internal_caller
        monkeypatch.setenv("MUKOKO_INTERNAL_SECRET", "s3cret")
        with pytest.raises(HTTPException):
            require_internal_caller(None)

    def test_all_proxy_fronted_ai_routes_call_the_guard(self):
        import inspect
        import py._ai, py._ai_followup, py._ai_prompts
        for mod in (py._ai, py._ai_followup, py._ai_prompts):
            assert "require_internal_caller(request)" in inspect.getsource(mod)


# ---------------------------------------------------------------------------
# get_activities_brief — shared cached activity briefs (labels + AI guidance)
# ---------------------------------------------------------------------------


class TestGetActivitiesBrief:
    def _reset_cache(self):
        import py._db as db_mod
        db_mod._activities_brief = []
        db_mod._activities_brief_at = 0

    @patch("py._db.activities_collection")
    def test_fetches_and_caches_briefs(self, mock_coll):
        from py._db import get_activities_brief
        self._reset_cache()
        docs = [{"id": "running", "label": "Running", "category": "sports",
                 "aiInstructions": "Best window from hourly forecast."}]
        mock_coll.return_value.find.return_value.sort.return_value = docs

        assert get_activities_brief() == docs
        # Second call served from cache — no second DB hit
        assert get_activities_brief() == docs
        assert mock_coll.return_value.find.call_count == 1

    @patch("py._db.activities_collection")
    def test_returns_stale_cache_on_db_error(self, mock_coll):
        from py._db import get_activities_brief
        import py._db as db_mod
        self._reset_cache()
        db_mod._activities_brief = [{"id": "running", "label": "Running"}]
        mock_coll.return_value.find.side_effect = Exception("db down")

        assert get_activities_brief() == [{"id": "running", "label": "Running"}]

    @patch("py._db.activities_collection")
    def test_includes_ai_instructions_in_projection(self, mock_coll):
        from py._db import get_activities_brief
        self._reset_cache()
        mock_coll.return_value.find.return_value.sort.return_value = []
        get_activities_brief()
        projection = mock_coll.return_value.find.call_args[0][1]
        assert projection.get("aiInstructions") == 1


# ---------------------------------------------------------------------------
# TTL cache helpers — ttl_filter / ttl_find_one / ttl_upsert
# ---------------------------------------------------------------------------



class TestTtlFilter:
    def test_unexpired_by_default(self):
        before = datetime.now(timezone.utc)
        f = ttl_filter({"_id": "k"})
        assert f["_id"] == "k"
        assert f["expiresAt"]["$gt"] >= before

    def test_allow_stale_drops_expiry_clause(self):
        assert ttl_filter({"_id": "k"}, allow_stale=True) == {"_id": "k"}

    def test_does_not_mutate_input(self):
        original = {"_id": "k"}
        ttl_filter(original)
        assert original == {"_id": "k"}


class TestTtlFindOne:
    def test_scopes_to_unexpired_docs(self):
        coll = MagicMock()
        coll.find_one.return_value = {"_id": "k"}
        assert ttl_find_one(coll, {"_id": "k"}) == {"_id": "k"}
        query, projection = coll.find_one.call_args.args
        assert query["_id"] == "k"
        assert "$gt" in query["expiresAt"]
        assert projection is None

    def test_allow_stale_has_no_expiry_clause(self):
        coll = MagicMock()
        ttl_find_one(coll, {"_id": "k"}, allow_stale=True)
        query, _ = coll.find_one.call_args.args
        assert query == {"_id": "k"}

    def test_passes_projection_through(self):
        coll = MagicMock()
        ttl_find_one(coll, {"_id": "k"}, projection={"tile": 1})
        assert coll.find_one.call_args.args[1] == {"tile": 1}

    def test_errors_propagate_to_caller(self):
        """Callers decide whether a cache failure is a miss (some must 503 on accessor errors)."""
        coll = MagicMock()
        coll.find_one.side_effect = RuntimeError("db down")
        with pytest.raises(RuntimeError):
            ttl_find_one(coll, {"_id": "k"})


class TestTtlUpsert:
    def test_upserts_by_filter_with_ttl_window(self):
        coll = MagicMock()
        ttl_upsert(coll, {"_id": "k"}, {"_id": "k", "v": 1}, ttl_seconds=3600)
        filt = coll.update_one.call_args.args[0]
        update = coll.update_one.call_args.args[1]
        assert coll.update_one.call_args.kwargs == {"upsert": True}
        assert filt == {"_id": "k"}
        doc = update["$set"]
        assert doc["_id"] == "k" and doc["v"] == 1
        assert (doc["expiresAt"] - doc["fetchedAt"]).total_seconds() == 3600

    def test_no_stamp_leaves_platform_fields_off(self):
        coll = MagicMock()
        ttl_upsert(coll, {"_id": "k"}, {"_id": "k"}, ttl_seconds=60)
        doc = coll.update_one.call_args.args[1]["$set"]
        assert "_schemaVersion" not in doc
        assert "bundu" not in doc

    def test_stamp_adds_platform_fields_with_country(self):
        coll = MagicMock()
        ttl_upsert(coll, {"_id": "k"}, {"_id": "k"}, ttl_seconds=60, stamp=True, country_code="KE")
        doc = coll.update_one.call_args.args[1]["$set"]
        assert doc["_id"] == "k"  # preserved, not replaced by a UUID
        assert doc["_schemaVersion"] == "v3.1"
        assert doc["bundu"]["countryCode"] == "KE"
        assert "createdAt" in doc and "updatedAt" in doc

    def test_stamp_defaults_to_zimbabwe(self):
        coll = MagicMock()
        ttl_upsert(coll, {"_id": "k"}, {"_id": "k"}, ttl_seconds=60, stamp=True)
        assert coll.update_one.call_args.args[1]["$set"]["bundu"]["countryCode"] == "ZW"

    def test_errors_propagate_to_caller(self):
        coll = MagicMock()
        coll.update_one.side_effect = RuntimeError("write failed")
        with pytest.raises(RuntimeError):
            ttl_upsert(coll, {"_id": "k"}, {"_id": "k"}, ttl_seconds=60)

# enforce_rate_limit — shared IP resolve + limiter + 429 for every endpoint
# ---------------------------------------------------------------------------


class TestEnforceRateLimit:
    def test_allowed_returns_resolved_ip(self, mock_request):
        req = mock_request(ip="10.0.0.1", forwarded_for="203.0.113.42")
        with patch("py._db.check_rate_limit", return_value={"allowed": True, "remaining": 4}) as limiter:
            ip = enforce_rate_limit(req, "chat", 5, 3600)
        assert ip == "203.0.113.42"
        limiter.assert_called_once_with("203.0.113.42", "chat", 5, 3600)

    def test_over_limit_raises_429_with_default_detail(self, mock_request):
        req = mock_request(ip="203.0.113.42")
        with patch("py._db.check_rate_limit", return_value={"allowed": False, "remaining": 0}):
            with pytest.raises(HTTPException) as exc_info:
                enforce_rate_limit(req, "chat", 5, 3600)
        assert exc_info.value.status_code == 429
        assert exc_info.value.detail == "Rate limit exceeded. Try again later."

    def test_over_limit_uses_custom_detail(self, mock_request):
        req = mock_request(ip="203.0.113.42")
        with patch("py._db.check_rate_limit", return_value={"allowed": False, "remaining": 0}):
            with pytest.raises(HTTPException) as exc_info:
                enforce_rate_limit(req, "report_clarify", 10, 3600, detail="Rate limit exceeded")
        assert exc_info.value.status_code == 429
        assert exc_info.value.detail == "Rate limit exceeded"

    def test_missing_ip_require_ip_raises_400(self, mock_request):
        req = mock_request(ip=None)
        with patch("py._db.check_rate_limit") as limiter:
            with pytest.raises(HTTPException) as exc_info:
                enforce_rate_limit(req, "chat", 5, 3600)
        assert exc_info.value.status_code == 400
        assert exc_info.value.detail == "Could not determine IP"
        limiter.assert_not_called()

    def test_missing_ip_request_none_require_ip_raises_400(self):
        with patch("py._db.check_rate_limit") as limiter:
            with pytest.raises(HTTPException) as exc_info:
                enforce_rate_limit(None, "chat", 5, 3600)
        assert exc_info.value.status_code == 400
        limiter.assert_not_called()

    def test_missing_ip_optional_uses_unknown_bucket(self, mock_request):
        req = mock_request(ip=None)
        with patch("py._db.check_rate_limit", return_value={"allowed": True, "remaining": 1}) as limiter:
            ip = enforce_rate_limit(req, "device-create", 20, 3600, require_ip=False)
        assert ip == "unknown"
        limiter.assert_called_once_with("unknown", "device-create", 20, 3600)

    def test_missing_ip_optional_request_none_uses_unknown_bucket(self):
        with patch("py._db.check_rate_limit", return_value={"allowed": True, "remaining": 1}) as limiter:
            ip = enforce_rate_limit(None, "ai-summary", 30, 3600, require_ip=False)
        assert ip == "unknown"
        limiter.assert_called_once_with("unknown", "ai-summary", 30, 3600)

    def test_optional_ip_over_limit_still_429(self, mock_request):
        req = mock_request(ip=None)
        with patch("py._db.check_rate_limit", return_value={"allowed": False, "remaining": 0}):
            with pytest.raises(HTTPException) as exc_info:
                enforce_rate_limit(req, "location-create", 5, 3600, require_ip=False)
        assert exc_info.value.status_code == 429


# ---------------------------------------------------------------------------
# is_valid_coords — WGS 84 bounds, NaN rejected
# ---------------------------------------------------------------------------


class TestIsValidCoords:
    @pytest.mark.parametrize(
        "lat, lon",
        [(0, 0), (90, 180), (-90, -180), (-17.83, 31.05), (51.51, -0.13)],
    )
    def test_valid(self, lat, lon):
        assert is_valid_coords(lat, lon) is True

    @pytest.mark.parametrize(
        "lat, lon",
        [(90.1, 0), (-90.1, 0), (0, 180.1), (0, -180.1), (float("nan"), 0), (0, float("nan"))],
    )
    def test_invalid(self, lat, lon):
        assert is_valid_coords(lat, lon) is False
