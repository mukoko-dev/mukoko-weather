"""Tests for _db.py shared helpers — get_client_ip, check_rate_limit."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from py._db import (
    get_client_ip,
    check_rate_limit,
    filter_known_activities,
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
