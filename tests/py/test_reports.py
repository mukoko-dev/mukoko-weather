"""Tests for _reports.py — community weather reporting, cross-validation, upvoting, AI clarification."""

from __future__ import annotations

import hashlib
import os
from datetime import datetime, timezone, timedelta
from unittest.mock import patch, MagicMock

import pytest
from bson import ObjectId

from py._reports import (
    REPORT_TYPES,
    SEVERITY_LEVELS,
    SEVERITY_TTL,
    _hash_ip,
    _cross_validate,
    _fallback_questions,
    submit_report,
    list_reports,
    upvote_report,
    clarify_report,
    SubmitReportRequest,
    ClarifyRequest,
    UpvoteRequest,
)


# ---------------------------------------------------------------------------
# REPORT_TYPES
# ---------------------------------------------------------------------------


class TestReportTypes:
    def test_has_10_types(self):
        assert len(REPORT_TYPES) == 10

    def test_expected_types_present(self):
        expected = {
            "light-rain", "heavy-rain", "thunderstorm", "hail", "flooding",
            "strong-wind", "clear-skies", "fog", "dust", "frost",
        }
        assert REPORT_TYPES == expected


# ---------------------------------------------------------------------------
# SEVERITY_LEVELS
# ---------------------------------------------------------------------------


class TestSeverityLevels:
    def test_has_three_levels(self):
        assert len(SEVERITY_LEVELS) == 3

    def test_contains_expected_levels(self):
        assert "mild" in SEVERITY_LEVELS
        assert "moderate" in SEVERITY_LEVELS
        assert "severe" in SEVERITY_LEVELS


# ---------------------------------------------------------------------------
# SEVERITY_TTL
# ---------------------------------------------------------------------------


class TestSeverityTtl:
    def test_mild_24h(self):
        assert SEVERITY_TTL["mild"] == 86400  # 24h

    def test_moderate_48h(self):
        assert SEVERITY_TTL["moderate"] == 172800  # 48h

    def test_severe_72h(self):
        assert SEVERITY_TTL["severe"] == 259200  # 72h


# ---------------------------------------------------------------------------
# _hash_ip
# ---------------------------------------------------------------------------


class TestHashIp:
    def test_returns_16_char_hex(self):
        result = _hash_ip("192.168.1.1")
        assert len(result) == 16
        assert all(c in "0123456789abcdef" for c in result)

    def test_deterministic(self):
        assert _hash_ip("1.2.3.4") == _hash_ip("1.2.3.4")

    def test_different_ips_different_hashes(self):
        assert _hash_ip("1.2.3.4") != _hash_ip("5.6.7.8")

    def test_matches_sha256_prefix(self):
        ip = "10.0.0.1"
        expected = hashlib.sha256(ip.encode()).hexdigest()[:16]
        assert _hash_ip(ip) == expected


# ---------------------------------------------------------------------------
# _cross_validate
# ---------------------------------------------------------------------------


class TestCrossValidate:
    def test_empty_snapshot_returns_false(self):
        assert _cross_validate("light-rain", {}) is False

    def test_light_rain_with_precipitation(self):
        assert _cross_validate("light-rain", {"precipitation": 0.5}) is True

    def test_heavy_rain_with_precipitation(self):
        assert _cross_validate("heavy-rain", {"precipitation": 5.0}) is True

    def test_light_rain_with_wmo_code_61(self):
        """WMO code 61 (rain) should validate rain reports."""
        assert _cross_validate("light-rain", {"precipitation": 0, "weatherCode": 61}) is True

    def test_heavy_rain_with_wmo_code_65(self):
        assert _cross_validate("heavy-rain", {"precipitation": 0, "weatherCode": 65}) is True

    def test_rain_with_wmo_code_51(self):
        """WMO code 51 (drizzle) is in range 51-82."""
        assert _cross_validate("light-rain", {"precipitation": 0, "weatherCode": 51}) is True

    def test_rain_with_wmo_code_82(self):
        """WMO code 82 is at boundary of range 51-82."""
        assert _cross_validate("light-rain", {"precipitation": 0, "weatherCode": 82}) is True

    def test_thunderstorm_code_95(self):
        assert _cross_validate("thunderstorm", {"weatherCode": 95}) is True

    def test_thunderstorm_code_96(self):
        assert _cross_validate("thunderstorm", {"weatherCode": 96}) is True

    def test_thunderstorm_code_99(self):
        assert _cross_validate("thunderstorm", {"weatherCode": 99}) is True

    def test_thunderstorm_wrong_code(self):
        assert _cross_validate("thunderstorm", {"weatherCode": 0}) is False

    def test_strong_wind_over_20(self):
        assert _cross_validate("strong-wind", {"windSpeed": 25}) is True

    def test_strong_wind_under_20(self):
        assert _cross_validate("strong-wind", {"windSpeed": 15}) is False

    def test_strong_wind_exactly_20(self):
        """Exactly 20 is not > 20, should return False."""
        assert _cross_validate("strong-wind", {"windSpeed": 20}) is False

    def test_clear_skies_code_0_no_precip(self):
        assert _cross_validate("clear-skies", {"weatherCode": 0, "precipitation": 0}) is True

    def test_clear_skies_code_1_no_precip(self):
        assert _cross_validate("clear-skies", {"weatherCode": 1, "precipitation": 0}) is True

    def test_clear_skies_with_precip(self):
        assert _cross_validate("clear-skies", {"weatherCode": 0, "precipitation": 0.5}) is False

    def test_fog_code_45(self):
        assert _cross_validate("fog", {"weatherCode": 45}) is True

    def test_fog_code_48(self):
        assert _cross_validate("fog", {"weatherCode": 48}) is True

    def test_fog_wrong_code(self):
        assert _cross_validate("fog", {"weatherCode": 0}) is False

    def test_frost_temp_3(self):
        assert _cross_validate("frost", {"temperature": 3}) is True

    def test_frost_temp_below_3(self):
        assert _cross_validate("frost", {"temperature": -2}) is True

    def test_frost_temp_above_3(self):
        assert _cross_validate("frost", {"temperature": 10}) is False

    def test_hail_not_validated(self):
        """Hail doesn't have a cross-validation rule, should return False."""
        assert _cross_validate("hail", {"weatherCode": 95, "precipitation": 5}) is False

    def test_flooding_not_validated(self):
        """Flooding doesn't have a cross-validation rule, should return False."""
        assert _cross_validate("flooding", {"precipitation": 50}) is False

    def test_dust_not_validated(self):
        """Dust doesn't have a cross-validation rule, should return False."""
        assert _cross_validate("dust", {"weatherCode": 0}) is False

    def test_none_values_handled(self):
        """None values in snapshot should be handled via `or 0` defaults."""
        assert _cross_validate("strong-wind", {"windSpeed": None}) is False
        assert _cross_validate("frost", {"temperature": None}) is False


# ---------------------------------------------------------------------------
# _fallback_questions
# ---------------------------------------------------------------------------


class TestFallbackQuestions:
    def test_returns_two_questions_for_each_type(self):
        for report_type in REPORT_TYPES:
            questions = _fallback_questions(report_type)
            assert len(questions) == 2, f"Expected 2 questions for {report_type}, got {len(questions)}"

    def test_returns_default_for_unknown_type(self):
        questions = _fallback_questions("unknown-type")
        assert len(questions) == 2
        assert "How severe" in questions[0]

    def test_light_rain_questions(self):
        questions = _fallback_questions("light-rain")
        assert "drizzle" in questions[0].lower() or "rain" in questions[0].lower()

    def test_thunderstorm_questions(self):
        questions = _fallback_questions("thunderstorm")
        assert "lightning" in questions[0].lower() or "close" in questions[0].lower()

    def test_frost_questions(self):
        questions = _fallback_questions("frost")
        assert any("frost" in q.lower() for q in questions)


# ---------------------------------------------------------------------------
# submit_report endpoint
# ---------------------------------------------------------------------------


class TestSubmitReport:
    def _make_request(self, ip="203.0.113.42"):
        req = MagicMock()
        req.headers = {}
        if ip:
            req.client = MagicMock()
            req.client.host = ip
        else:
            req.client = None
        return req

    @pytest.mark.asyncio
    @patch("py._reports.get_client_ip")
    async def test_no_ip_raises_400(self, mock_ip):
        mock_ip.return_value = None
        body = SubmitReportRequest(locationSlug="harare", reportType="light-rain")
        with pytest.raises(Exception) as exc_info:
            await submit_report(body, self._make_request(ip=None))
        assert exc_info.value.status_code == 400

    @pytest.mark.asyncio
    @patch("py._reports.check_rate_limit")
    @patch("py._reports.get_client_ip")
    async def test_rate_limit_exceeded(self, mock_ip, mock_rate):
        mock_ip.return_value = "1.2.3.4"
        mock_rate.return_value = {"allowed": False, "remaining": 0}
        body = SubmitReportRequest(locationSlug="harare", reportType="light-rain")
        with pytest.raises(Exception) as exc_info:
            await submit_report(body, self._make_request())
        assert exc_info.value.status_code == 429

    @pytest.mark.asyncio
    @patch("py._reports.check_rate_limit")
    @patch("py._reports.get_client_ip")
    async def test_description_too_long(self, mock_ip, mock_rate):
        mock_ip.return_value = "1.2.3.4"
        mock_rate.return_value = {"allowed": True, "remaining": 4}
        body = SubmitReportRequest(
            locationSlug="harare",
            reportType="light-rain",
            description="x" * 301,
        )
        with pytest.raises(Exception) as exc_info:
            await submit_report(body, self._make_request())
        assert exc_info.value.status_code == 400
        assert "Description too long" in str(exc_info.value.detail)

    @pytest.mark.asyncio
    @patch("py._reports.check_rate_limit")
    @patch("py._reports.get_client_ip")
    async def test_invalid_report_type(self, mock_ip, mock_rate):
        mock_ip.return_value = "1.2.3.4"
        mock_rate.return_value = {"allowed": True, "remaining": 4}
        body = SubmitReportRequest(
            locationSlug="harare",
            reportType="invalid-type",
        )
        with pytest.raises(Exception) as exc_info:
            await submit_report(body, self._make_request())
        assert exc_info.value.status_code == 400
        assert "Invalid report type" in str(exc_info.value.detail)

    @pytest.mark.asyncio
    @patch("py._reports.check_rate_limit")
    @patch("py._reports.get_client_ip")
    @patch("py._reports.locations_collection")
    async def test_invalid_severity_defaults_to_moderate(self, mock_loc, mock_ip, mock_rate):
        """Unknown severity should default to moderate."""
        mock_ip.return_value = "1.2.3.4"
        mock_rate.return_value = {"allowed": True, "remaining": 4}
        mock_loc.return_value.find_one.return_value = {
            "slug": "harare", "name": "Harare", "lat": -17.83, "lon": 31.05,
        }

        with patch("py._reports.weather_cache_collection") as mock_cache, \
             patch("py._reports.weather_reports_collection") as mock_reports:
            mock_cache.return_value.find_one.return_value = None
            mock_reports.return_value.insert_one.return_value = MagicMock(
                inserted_id=ObjectId("507f1f77bcf86cd799439011")
            )

            body = SubmitReportRequest(
                locationSlug="harare",
                reportType="light-rain",
                severity="unknown-level",
            )
            result = await submit_report(body, self._make_request())
            # TTL should match moderate (not error)
            assert result["expiresIn"] == SEVERITY_TTL["moderate"]

    @pytest.mark.asyncio
    @patch("py._reports.check_rate_limit")
    @patch("py._reports.get_client_ip")
    @patch("py._reports.locations_collection")
    async def test_location_not_found(self, mock_loc, mock_ip, mock_rate):
        mock_ip.return_value = "1.2.3.4"
        mock_rate.return_value = {"allowed": True, "remaining": 4}
        mock_loc.return_value.find_one.return_value = None

        body = SubmitReportRequest(locationSlug="nonexistent", reportType="light-rain")
        with pytest.raises(Exception) as exc_info:
            await submit_report(body, self._make_request())
        assert exc_info.value.status_code == 404

    @pytest.mark.asyncio
    @patch("py._reports._cross_validate")
    @patch("py._reports.weather_cache_collection")
    @patch("py._reports.weather_reports_collection")
    @patch("py._reports.locations_collection")
    @patch("py._reports.check_rate_limit")
    @patch("py._reports.get_client_ip")
    async def test_successful_submission(self, mock_ip, mock_rate, mock_loc,
                                          mock_reports, mock_cache, mock_validate):
        mock_ip.return_value = "1.2.3.4"
        mock_rate.return_value = {"allowed": True, "remaining": 4}
        mock_loc.return_value.find_one.return_value = {
            "slug": "harare", "name": "Harare", "lat": -17.83, "lon": 31.05,
        }
        mock_cache.return_value.find_one.return_value = {
            "data": {"current": {"temperature_2m": 25, "weather_code": 0, "precipitation": 0,
                                  "wind_speed_10m": 10, "relative_humidity_2m": 60}},
        }
        mock_validate.return_value = True
        mock_reports.return_value.insert_one.return_value = MagicMock(
            inserted_id=ObjectId("507f1f77bcf86cd799439011")
        )

        body = SubmitReportRequest(
            locationSlug="harare",
            reportType="light-rain",
            severity="mild",
            description="Light drizzle started.",
        )
        result = await submit_report(body, MagicMock(
            headers={}, client=MagicMock(host="1.2.3.4")
        ))
        assert result["verified"] is True
        assert result["expiresIn"] == SEVERITY_TTL["mild"]
        assert result["id"] == "507f1f77bcf86cd799439011"

    @pytest.mark.asyncio
    @patch("py._reports.weather_cache_collection")
    @patch("py._reports.weather_reports_collection")
    @patch("py._reports.locations_collection")
    @patch("py._reports.check_rate_limit")
    @patch("py._reports.get_client_ip")
    async def test_weather_snapshot_captured(self, mock_ip, mock_rate, mock_loc,
                                              mock_reports, mock_cache):
        mock_ip.return_value = "1.2.3.4"
        mock_rate.return_value = {"allowed": True, "remaining": 4}
        mock_loc.return_value.find_one.return_value = {
            "slug": "harare", "name": "Harare", "lat": -17.83, "lon": 31.05,
        }
        mock_cache.return_value.find_one.return_value = {
            "data": {"current": {
                "temperature_2m": 25, "weather_code": 0, "precipitation": 0.5,
                "wind_speed_10m": 12, "relative_humidity_2m": 65,
            }},
        }
        mock_reports.return_value.insert_one.return_value = MagicMock(
            inserted_id=ObjectId("507f1f77bcf86cd799439011")
        )

        body = SubmitReportRequest(locationSlug="harare", reportType="clear-skies")
        await submit_report(body, MagicMock(headers={}, client=MagicMock(host="1.2.3.4")))

        # Verify the inserted report has weather snapshot
        insert_call = mock_reports.return_value.insert_one.call_args[0][0]
        assert insert_call["weatherSnapshot"]["temperature"] == 25
        assert insert_call["weatherSnapshot"]["windSpeed"] == 12


# ---------------------------------------------------------------------------
# list_reports endpoint
# ---------------------------------------------------------------------------


class TestListReports:
    @pytest.mark.asyncio
    async def test_missing_location_raises_400(self):
        with pytest.raises(Exception) as exc_info:
            await list_reports(location="", hours=24)
        assert exc_info.value.status_code == 400

    @pytest.mark.asyncio
    @patch("py._reports.weather_reports_collection")
    async def test_hours_clamped_minimum(self, mock_coll):
        mock_find = MagicMock()
        mock_find.sort.return_value.limit.return_value = []
        mock_coll.return_value.find.return_value = mock_find

        result = await list_reports(location="harare", hours=-5)
        assert result["location"] == "harare"
        # Should still succeed (clamped to 1)

    @pytest.mark.asyncio
    @patch("py._reports.weather_reports_collection")
    async def test_hours_clamped_maximum(self, mock_coll):
        mock_find = MagicMock()
        mock_find.sort.return_value.limit.return_value = []
        mock_coll.return_value.find.return_value = mock_find

        result = await list_reports(location="harare", hours=100)
        assert result["location"] == "harare"
        # Should still succeed (clamped to 72)

    @pytest.mark.asyncio
    @patch("py._reports.weather_reports_collection")
    async def test_datetime_serialization(self, mock_coll):
        """datetime objects should be converted to ISO strings."""
        now = datetime.now(timezone.utc)
        mock_find = MagicMock()
        mock_find.sort.return_value.limit.return_value = [
            {
                "_id": ObjectId("507f1f77bcf86cd799439011"),
                "reportType": "light-rain",
                "severity": "mild",
                "description": "Light drizzle",
                "reportedAt": now,
                "upvotes": 0,
                "verified": True,
                "locationName": "Harare",
            }
        ]
        mock_coll.return_value.find.return_value = mock_find

        result = await list_reports(location="harare", hours=24)
        assert len(result["reports"]) == 1
        assert result["reports"][0]["id"] == "507f1f77bcf86cd799439011"
        assert result["reports"][0]["reportedAt"] == now.isoformat()
        assert "_id" not in result["reports"][0]

    @pytest.mark.asyncio
    @patch("py._reports.weather_reports_collection")
    async def test_string_reported_at_left_as_is(self, mock_coll):
        """Non-datetime reportedAt values should be left unchanged."""
        mock_find = MagicMock()
        mock_find.sort.return_value.limit.return_value = [
            {
                "_id": ObjectId("507f1f77bcf86cd799439011"),
                "reportType": "fog",
                "severity": "moderate",
                "description": "Thick fog",
                "reportedAt": "2025-01-15T10:00:00Z",
                "upvotes": 3,
                "verified": False,
                "locationName": "Marondera",
            }
        ]
        mock_coll.return_value.find.return_value = mock_find

        result = await list_reports(location="marondera", hours=24)
        assert result["reports"][0]["reportedAt"] == "2025-01-15T10:00:00Z"


# ---------------------------------------------------------------------------
# upvote_report endpoint
# ---------------------------------------------------------------------------


class TestUpvoteReport:
    def _make_request(self, ip="203.0.113.42"):
        req = MagicMock()
        req.headers = {}
        if ip:
            req.client = MagicMock()
            req.client.host = ip
        else:
            req.client = None
        return req

    @pytest.mark.asyncio
    @patch("py._reports.get_client_ip")
    async def test_no_ip_raises_400(self, mock_ip):
        mock_ip.return_value = None
        body = UpvoteRequest(reportId="507f1f77bcf86cd799439011")
        with pytest.raises(Exception) as exc_info:
            await upvote_report(body, self._make_request(ip=None))
        assert exc_info.value.status_code == 400

    @pytest.mark.asyncio
    @patch("py._reports.get_client_ip")
    async def test_invalid_object_id(self, mock_ip):
        mock_ip.return_value = "1.2.3.4"
        body = UpvoteRequest(reportId="not-a-valid-id")
        with pytest.raises(Exception) as exc_info:
            await upvote_report(body, self._make_request())
        assert exc_info.value.status_code == 400
        assert "Invalid report ID" in str(exc_info.value.detail)

    @pytest.mark.asyncio
    @patch("py._reports.weather_reports_collection")
    @patch("py._reports.get_client_ip")
    async def test_already_upvoted_returns_false(self, mock_ip, mock_coll):
        """IP that already voted should get upvoted: False."""
        mock_ip.return_value = "1.2.3.4"
        mock_coll.return_value.update_one.return_value = MagicMock(modified_count=0)

        body = UpvoteRequest(reportId="507f1f77bcf86cd799439011")
        result = await upvote_report(body, self._make_request())
        assert result["upvoted"] is False
        assert "Already upvoted" in result["reason"]

    @pytest.mark.asyncio
    @patch("py._reports.weather_reports_collection")
    @patch("py._reports.get_client_ip")
    async def test_successful_upvote(self, mock_ip, mock_coll):
        mock_ip.return_value = "1.2.3.4"
        mock_coll.return_value.update_one.return_value = MagicMock(modified_count=1)

        body = UpvoteRequest(reportId="507f1f77bcf86cd799439011")
        result = await upvote_report(body, self._make_request())
        assert result["upvoted"] is True


# ---------------------------------------------------------------------------
# clarify_report endpoint
# ---------------------------------------------------------------------------


class TestClarifyReport:
    def _make_request(self, ip="203.0.113.42"):
        req = MagicMock()
        req.headers = {}
        if ip:
            req.client = MagicMock()
            req.client.host = ip
        else:
            req.client = None
        return req

    @pytest.mark.asyncio
    @patch("py._reports.get_client_ip")
    async def test_no_ip_raises_400(self, mock_ip):
        mock_ip.return_value = None
        body = ClarifyRequest(locationSlug="harare", reportType="light-rain")
        with pytest.raises(Exception) as exc_info:
            await clarify_report(body, self._make_request(ip=None))
        assert exc_info.value.status_code == 400

    @pytest.mark.asyncio
    @patch("py._reports.get_client_ip")
    async def test_invalid_report_type(self, mock_ip):
        mock_ip.return_value = "1.2.3.4"
        body = ClarifyRequest(locationSlug="harare", reportType="invalid-type")
        with pytest.raises(Exception) as exc_info:
            await clarify_report(body, self._make_request())
        assert exc_info.value.status_code == 400
        assert "Invalid report type" in str(exc_info.value.detail)

    @pytest.mark.asyncio
    @patch("py._reports.check_rate_limit")
    @patch("py._reports.get_client_ip")
    async def test_rate_limit_exceeded(self, mock_ip, mock_rate):
        mock_ip.return_value = "1.2.3.4"
        mock_rate.return_value = {"allowed": False, "remaining": 0}
        body = ClarifyRequest(locationSlug="harare", reportType="light-rain")
        with pytest.raises(Exception) as exc_info:
            await clarify_report(body, self._make_request())
        assert exc_info.value.status_code == 429

    @pytest.mark.asyncio
    @patch("py._reports._get_client")
    @patch("py._reports.locations_collection")
    @patch("py._reports.check_rate_limit")
    @patch("py._reports.get_client_ip")
    async def test_ai_unavailable_returns_fallback(self, mock_ip, mock_rate, mock_loc, mock_client):
        mock_ip.return_value = "1.2.3.4"
        mock_rate.return_value = {"allowed": True, "remaining": 9}
        mock_loc.return_value.find_one.return_value = {"name": "Harare"}
        mock_client.return_value = None  # No AI client

        body = ClarifyRequest(locationSlug="harare", reportType="thunderstorm")
        result = await clarify_report(body, self._make_request())
        assert "questions" in result
        assert len(result["questions"]) == 2
        # Should be the fallback questions for thunderstorm
        assert any("lightning" in q.lower() or "hail" in q.lower() for q in result["questions"])

    @pytest.mark.asyncio
    @patch("py._reports.anthropic_breaker")
    @patch("py._reports._get_client")
    @patch("py._reports.locations_collection")
    @patch("py._reports.check_rate_limit")
    @patch("py._reports.get_client_ip")
    async def test_circuit_open_returns_fallback(self, mock_ip, mock_rate, mock_loc,
                                                  mock_client, mock_breaker):
        mock_ip.return_value = "1.2.3.4"
        mock_rate.return_value = {"allowed": True, "remaining": 9}
        mock_loc.return_value.find_one.return_value = {"name": "Harare"}
        mock_client.return_value = MagicMock()
        mock_breaker.is_allowed = False  # Circuit open

        body = ClarifyRequest(locationSlug="harare", reportType="fog")
        result = await clarify_report(body, self._make_request())
        assert "questions" in result
        assert len(result["questions"]) == 2

    @pytest.mark.asyncio
    @patch("py._reports._get_clarification_prompt")
    @patch("py._reports.anthropic_breaker")
    @patch("py._reports._get_client")
    @patch("py._reports.locations_collection")
    @patch("py._reports.check_rate_limit")
    @patch("py._reports.get_client_ip")
    async def test_ai_available_returns_parsed_questions(self, mock_ip, mock_rate, mock_loc,
                                                          mock_client, mock_breaker, mock_prompt):
        mock_ip.return_value = "1.2.3.4"
        mock_rate.return_value = {"allowed": True, "remaining": 9}
        mock_loc.return_value.find_one.return_value = {"name": "Harare"}
        mock_breaker.is_allowed = True
        mock_prompt.return_value = None  # Use fallback prompt template

        # Mock Claude response with numbered questions
        text_block = MagicMock()
        text_block.type = "text"
        text_block.text = "1. How far can you see ahead?\n2. Is it getting thicker?"
        mock_message = MagicMock()
        mock_message.content = [text_block]
        mock_ai_client = MagicMock()
        mock_ai_client.messages.create.return_value = mock_message
        mock_client.return_value = mock_ai_client

        body = ClarifyRequest(locationSlug="harare", reportType="fog")
        result = await clarify_report(body, self._make_request())
        assert len(result["questions"]) == 2
        assert "How far can you see ahead?" in result["questions"][0]
        mock_breaker.record_success.assert_called_once()

    @pytest.mark.asyncio
    @patch("py._reports._get_clarification_prompt")
    @patch("py._reports.anthropic_breaker")
    @patch("py._reports._get_client")
    @patch("py._reports.locations_collection")
    @patch("py._reports.check_rate_limit")
    @patch("py._reports.get_client_ip")
    async def test_ai_error_falls_back(self, mock_ip, mock_rate, mock_loc,
                                        mock_client, mock_breaker, mock_prompt):
        """AI exception should fall back to hardcoded questions."""
        mock_ip.return_value = "1.2.3.4"
        mock_rate.return_value = {"allowed": True, "remaining": 9}
        mock_loc.return_value.find_one.return_value = {"name": "Harare"}
        mock_breaker.is_allowed = True
        mock_prompt.return_value = None

        mock_ai_client = MagicMock()
        mock_ai_client.messages.create.side_effect = Exception("API Error")
        mock_client.return_value = mock_ai_client

        body = ClarifyRequest(locationSlug="harare", reportType="frost")
        result = await clarify_report(body, self._make_request())
        assert "questions" in result
        assert len(result["questions"]) == 2
        mock_breaker.record_failure.assert_called_once()

    @pytest.mark.asyncio
    @patch("py._reports._get_clarification_prompt")
    @patch("py._reports.anthropic_breaker")
    @patch("py._reports._get_client")
    @patch("py._reports.locations_collection")
    @patch("py._reports.check_rate_limit")
    @patch("py._reports.get_client_ip")
    async def test_ai_returns_no_numbered_lines_falls_back(self, mock_ip, mock_rate, mock_loc,
                                                            mock_client, mock_breaker, mock_prompt):
        """If AI response has no numbered lines, fall back to hardcoded questions."""
        mock_ip.return_value = "1.2.3.4"
        mock_rate.return_value = {"allowed": True, "remaining": 9}
        mock_loc.return_value.find_one.return_value = {"name": "Harare"}
        mock_breaker.is_allowed = True
        mock_prompt.return_value = None

        text_block = MagicMock()
        text_block.type = "text"
        text_block.text = "No numbered questions here."
        mock_message = MagicMock()
        mock_message.content = [text_block]
        mock_ai_client = MagicMock()
        mock_ai_client.messages.create.return_value = mock_message
        mock_client.return_value = mock_ai_client

        body = ClarifyRequest(locationSlug="harare", reportType="dust")
        result = await clarify_report(body, self._make_request())
        assert len(result["questions"]) == 2
        # Should be the fallback dust questions
        assert any("dust" in q.lower() or "far" in q.lower() for q in result["questions"])

    @pytest.mark.asyncio
    @patch("py._reports._get_clarification_prompt")
    @patch("py._reports.anthropic_breaker")
    @patch("py._reports._get_client")
    @patch("py._reports.locations_collection")
    @patch("py._reports.check_rate_limit")
    @patch("py._reports.get_client_ip")
    async def test_ai_returns_more_than_2_questions_capped(self, mock_ip, mock_rate, mock_loc,
                                                            mock_client, mock_breaker, mock_prompt):
        """AI may return more than 2 questions; should be capped at 2."""
        mock_ip.return_value = "1.2.3.4"
        mock_rate.return_value = {"allowed": True, "remaining": 9}
        mock_loc.return_value.find_one.return_value = {"name": "Harare"}
        mock_breaker.is_allowed = True
        mock_prompt.return_value = None

        text_block = MagicMock()
        text_block.type = "text"
        text_block.text = "1. First question?\n2. Second question?\n3. Third question?"
        mock_message = MagicMock()
        mock_message.content = [text_block]
        mock_ai_client = MagicMock()
        mock_ai_client.messages.create.return_value = mock_message
        mock_client.return_value = mock_ai_client

        body = ClarifyRequest(locationSlug="harare", reportType="heavy-rain")
        result = await clarify_report(body, self._make_request())
        assert len(result["questions"]) == 2
