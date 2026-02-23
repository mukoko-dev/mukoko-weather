"""Tests for _db.py shared helpers — get_client_ip, check_rate_limit."""

from __future__ import annotations

from unittest.mock import patch

import pytest

from py._db import get_client_ip, check_rate_limit


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
