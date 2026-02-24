"""Tests for _ai_followup.py — inline follow-up chat endpoint."""

from __future__ import annotations

from unittest.mock import patch, MagicMock, PropertyMock

import anthropic
import pytest
from fastapi import HTTPException

from py._ai_followup import (
    _build_followup_system_prompt,
    _FALLBACK_SYSTEM_PROMPT,
    followup_chat,
    FollowupRequest,
    FollowupMessage,
    MAX_HISTORY,
    MAX_MESSAGE_LEN,
    MAX_MESSAGES_PER_CONVERSATION,
    RATE_LIMIT_MAX,
)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------


class TestConstants:
    def test_max_history(self):
        assert MAX_HISTORY == 10

    def test_max_message_len(self):
        assert MAX_MESSAGE_LEN == 2000

    def test_max_messages_per_conversation(self):
        assert MAX_MESSAGES_PER_CONVERSATION == 5

    def test_rate_limit_max(self):
        assert RATE_LIMIT_MAX == 30


# ---------------------------------------------------------------------------
# _build_followup_system_prompt
# ---------------------------------------------------------------------------


class TestBuildFollowupSystemPrompt:
    @patch("py._ai_followup._get_followup_prompt")
    def test_uses_db_template_when_available(self, mock_get_prompt):
        """Should use template from database when available."""
        mock_get_prompt.return_value = {
            "template": "Custom prompt for {locationName} ({locationSlug}). Summary: {weatherSummary}. Activities: {activities}. Season: {season}."
        }
        result = _build_followup_system_prompt(
            "Harare", "harare", "Warm and sunny today.", ["running"], "Zhizha"
        )
        assert "Custom prompt for Harare" in result
        assert "(harare)" in result
        assert "Warm and sunny today." in result
        assert "running" in result
        assert "Zhizha" in result

    @patch("py._ai_followup._get_followup_prompt")
    def test_falls_back_to_hardcoded_prompt(self, mock_get_prompt):
        """Should use fallback prompt when database template is unavailable."""
        mock_get_prompt.return_value = None
        result = _build_followup_system_prompt(
            "Harare", "harare", "Warm today.", [], "Zhizha"
        )
        assert "Shamwari Weather" in result
        assert "Harare" in result

    @patch("py._ai_followup._get_followup_prompt")
    def test_falls_back_when_template_is_empty(self, mock_get_prompt):
        """Should use fallback when template field is empty string."""
        mock_get_prompt.return_value = {"template": ""}
        result = _build_followup_system_prompt(
            "Harare", "harare", "Warm today.", [], "Zhizha"
        )
        assert "Shamwari Weather" in result

    @patch("py._ai_followup._get_followup_prompt")
    def test_replaces_all_placeholders(self, mock_get_prompt):
        """Should replace all five placeholders."""
        mock_get_prompt.return_value = {
            "template": "{locationName}|{locationSlug}|{weatherSummary}|{activities}|{season}"
        }
        result = _build_followup_system_prompt(
            "Victoria Falls", "victoria-falls", "Misty conditions near the falls.", ["tourism", "hiking"], "Chirimo"
        )
        assert result == "Victoria Falls|victoria-falls|Misty conditions near the falls.|tourism, hiking|Chirimo"

    @patch("py._ai_followup._get_followup_prompt")
    def test_truncates_weather_summary_to_500_chars(self, mock_get_prompt):
        """weatherSummary should be truncated to 500 characters."""
        mock_get_prompt.return_value = {
            "template": "Summary: {weatherSummary}"
        }
        long_summary = "A" * 1000
        result = _build_followup_system_prompt(
            "Harare", "harare", long_summary, [], "Zhizha"
        )
        # The replaced summary should be at most 500 chars
        assert len(result) == len("Summary: ") + 500
        assert result == "Summary: " + "A" * 500

    @patch("py._ai_followup._get_followup_prompt")
    def test_uses_none_selected_when_no_activities(self, mock_get_prompt):
        """Should use 'none selected' when activities list is empty."""
        mock_get_prompt.return_value = {
            "template": "Activities: {activities}"
        }
        result = _build_followup_system_prompt(
            "Harare", "harare", "Warm today.", [], "Zhizha"
        )
        assert result == "Activities: none selected"

    @patch("py._ai_followup._get_followup_prompt")
    def test_limits_activities_to_five(self, mock_get_prompt):
        """Should only include the first 5 activities."""
        mock_get_prompt.return_value = {
            "template": "Activities: {activities}"
        }
        activities = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"]
        result = _build_followup_system_prompt(
            "Harare", "harare", "Warm today.", activities, "Zhizha"
        )
        assert "a5" in result
        assert "a6" not in result

    @patch("py._ai_followup._get_followup_prompt")
    def test_handles_none_season(self, mock_get_prompt):
        """Should use 'unknown' when season is None/empty."""
        mock_get_prompt.return_value = {
            "template": "Season: {season}"
        }
        result = _build_followup_system_prompt(
            "Harare", "harare", "Warm today.", [], ""
        )
        assert result == "Season: unknown"


# ---------------------------------------------------------------------------
# followup_chat endpoint — validation
# ---------------------------------------------------------------------------


class TestFollowupChatValidation:
    def _make_request(self, ip="203.0.113.42"):
        """Create a mock FastAPI Request."""
        req = MagicMock()
        req.headers = {}
        if ip:
            req.client = MagicMock()
            req.client.host = ip
        else:
            req.client = None
        return req

    @pytest.mark.asyncio
    async def test_empty_message_raises_400(self):
        """Empty message should raise 400."""
        body = FollowupRequest(
            message="   ",
            locationName="Harare",
            locationSlug="harare",
        )
        request = self._make_request()

        with pytest.raises(HTTPException) as exc_info:
            await followup_chat(body, request)
        assert exc_info.value.status_code == 400
        assert "Message is required" in exc_info.value.detail

    @pytest.mark.asyncio
    async def test_message_too_long_raises_400(self):
        """Message exceeding MAX_MESSAGE_LEN should raise 400."""
        body = FollowupRequest(
            message="X" * (MAX_MESSAGE_LEN + 1),
            locationName="Harare",
            locationSlug="harare",
        )
        request = self._make_request()

        with pytest.raises(HTTPException) as exc_info:
            await followup_chat(body, request)
        assert exc_info.value.status_code == 400
        assert "Message too long" in exc_info.value.detail

    @pytest.mark.asyncio
    @patch("py._ai_followup.get_client_ip", return_value=None)
    async def test_no_ip_raises_400(self, _mock_ip):
        """When IP cannot be determined, should raise 400."""
        body = FollowupRequest(
            message="What about tomorrow?",
            locationName="Harare",
            locationSlug="harare",
        )
        request = self._make_request(ip=None)

        with pytest.raises(HTTPException) as exc_info:
            await followup_chat(body, request)
        assert exc_info.value.status_code == 400
        assert "Could not determine IP" in exc_info.value.detail

    @pytest.mark.asyncio
    @patch("py._ai_followup.check_rate_limit")
    @patch("py._ai_followup.get_client_ip", return_value="1.2.3.4")
    async def test_rate_limit_exceeded_raises_429(self, _mock_ip, mock_rate):
        """Should raise 429 when rate limit is exceeded."""
        mock_rate.return_value = {"allowed": False, "remaining": 0}
        body = FollowupRequest(
            message="What about tomorrow?",
            locationName="Harare",
            locationSlug="harare",
        )
        request = self._make_request()

        with pytest.raises(HTTPException) as exc_info:
            await followup_chat(body, request)
        assert exc_info.value.status_code == 429
        assert "Rate limit exceeded" in exc_info.value.detail


# ---------------------------------------------------------------------------
# followup_chat endpoint — circuit breaker and AI interaction
# ---------------------------------------------------------------------------


class TestFollowupChatAI:
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
    @patch("py._ai_followup.anthropic_breaker")
    @patch("py._ai_followup._get_client")
    @patch("py._ai_followup._get_followup_prompt", return_value=None)
    @patch("py._ai_followup.check_rate_limit", return_value={"allowed": True, "remaining": 29})
    @patch("py._ai_followup.get_client_ip", return_value="1.2.3.4")
    async def test_circuit_breaker_open_returns_error_response(
        self, _mock_ip, _mock_rate, _mock_prompt, mock_client, mock_breaker,
    ):
        """When circuit breaker is open, should return error response with message."""
        type(mock_breaker).is_allowed = PropertyMock(return_value=False)

        body = FollowupRequest(
            message="What about tomorrow?",
            locationName="Harare",
            locationSlug="harare",
        )
        request = self._make_request()

        result = await followup_chat(body, request)
        assert result["error"] is True
        assert "temporarily unavailable" in result["response"]

    @pytest.mark.asyncio
    @patch("py._ai_followup.anthropic_breaker")
    @patch("py._ai_followup._get_client")
    @patch("py._ai_followup._get_followup_prompt", return_value=None)
    @patch("py._ai_followup.check_rate_limit", return_value={"allowed": True, "remaining": 29})
    @patch("py._ai_followup.get_client_ip", return_value="1.2.3.4")
    async def test_successful_ai_call_returns_response(
        self, _mock_ip, _mock_rate, _mock_prompt, mock_client, mock_breaker,
    ):
        """Successful AI call should return the response text."""
        type(mock_breaker).is_allowed = PropertyMock(return_value=True)

        text_block = MagicMock()
        text_block.type = "text"
        text_block.text = "Tomorrow will be slightly cooler."
        mock_response = MagicMock()
        mock_response.content = [text_block]
        mock_client.return_value.messages.create.return_value = mock_response

        body = FollowupRequest(
            message="What about tomorrow?",
            locationName="Harare",
            locationSlug="harare",
        )
        request = self._make_request()

        result = await followup_chat(body, request)
        assert result["response"] == "Tomorrow will be slightly cooler."
        assert "error" not in result
        mock_breaker.record_success.assert_called_once()

    @pytest.mark.asyncio
    @patch("py._ai_followup.anthropic_breaker")
    @patch("py._ai_followup._get_client")
    @patch("py._ai_followup._get_followup_prompt", return_value=None)
    @patch("py._ai_followup.check_rate_limit", return_value={"allowed": True, "remaining": 29})
    @patch("py._ai_followup.get_client_ip", return_value="1.2.3.4")
    async def test_weather_summary_pre_seeded_as_first_assistant_message(
        self, _mock_ip, _mock_rate, _mock_prompt, mock_client, mock_breaker,
    ):
        """Weather summary should be the first assistant message in the conversation."""
        type(mock_breaker).is_allowed = PropertyMock(return_value=True)

        text_block = MagicMock()
        text_block.type = "text"
        text_block.text = "Response"
        mock_response = MagicMock()
        mock_response.content = [text_block]
        mock_client.return_value.messages.create.return_value = mock_response

        body = FollowupRequest(
            message="What about rain?",
            locationName="Harare",
            locationSlug="harare",
            weatherSummary="It is warm and sunny in Harare today with 25 degrees.",
        )
        request = self._make_request()

        await followup_chat(body, request)

        call_args = mock_client.return_value.messages.create.call_args
        messages = call_args.kwargs.get("messages") or call_args[1].get("messages")
        # First message should be the assistant with weather summary
        assert messages[0]["role"] == "assistant"
        assert messages[0]["content"] == "It is warm and sunny in Harare today with 25 degrees."
        # Last message should be the user's new message
        assert messages[-1]["role"] == "user"
        assert messages[-1]["content"] == "What about rain?"

    @pytest.mark.asyncio
    @patch("py._ai_followup.anthropic_breaker")
    @patch("py._ai_followup._get_client")
    @patch("py._ai_followup._get_followup_prompt", return_value=None)
    @patch("py._ai_followup.check_rate_limit", return_value={"allowed": True, "remaining": 29})
    @patch("py._ai_followup.get_client_ip", return_value="1.2.3.4")
    async def test_no_summary_omits_assistant_preseed(
        self, _mock_ip, _mock_rate, _mock_prompt, mock_client, mock_breaker,
    ):
        """When no weather summary provided, should not add an assistant message."""
        type(mock_breaker).is_allowed = PropertyMock(return_value=True)

        text_block = MagicMock()
        text_block.type = "text"
        text_block.text = "Response"
        mock_response = MagicMock()
        mock_response.content = [text_block]
        mock_client.return_value.messages.create.return_value = mock_response

        body = FollowupRequest(
            message="What about rain?",
            locationName="Harare",
            locationSlug="harare",
            weatherSummary="",
        )
        request = self._make_request()

        await followup_chat(body, request)

        call_args = mock_client.return_value.messages.create.call_args
        messages = call_args.kwargs.get("messages") or call_args[1].get("messages")
        # Only the user message should be present
        assert len(messages) == 1
        assert messages[0]["role"] == "user"

    @pytest.mark.asyncio
    @patch("py._ai_followup.anthropic_breaker")
    @patch("py._ai_followup._get_client")
    @patch("py._ai_followup._get_followup_prompt", return_value=None)
    @patch("py._ai_followup.check_rate_limit", return_value={"allowed": True, "remaining": 29})
    @patch("py._ai_followup.get_client_ip", return_value="1.2.3.4")
    async def test_history_truncated_to_max_history(
        self, _mock_ip, _mock_rate, _mock_prompt, mock_client, mock_breaker,
    ):
        """History should be truncated to MAX_HISTORY entries."""
        type(mock_breaker).is_allowed = PropertyMock(return_value=True)

        text_block = MagicMock()
        text_block.type = "text"
        text_block.text = "Response"
        mock_response = MagicMock()
        mock_response.content = [text_block]
        mock_client.return_value.messages.create.return_value = mock_response

        # Create 15 history messages (exceeds MAX_HISTORY=10)
        history = [
            FollowupMessage(role="user" if i % 2 == 0 else "assistant", content=f"Message {i}")
            for i in range(15)
        ]

        body = FollowupRequest(
            message="Final question?",
            locationName="Harare",
            locationSlug="harare",
            weatherSummary="Sunny today.",
            history=history,
        )
        request = self._make_request()

        await followup_chat(body, request)

        call_args = mock_client.return_value.messages.create.call_args
        messages = call_args.kwargs.get("messages") or call_args[1].get("messages")
        # 1 (weatherSummary) + MAX_HISTORY (10) + 1 (new message) = 12
        assert len(messages) == 1 + MAX_HISTORY + 1

    @pytest.mark.asyncio
    @patch("py._ai_followup.anthropic_breaker")
    @patch("py._ai_followup._get_client")
    @patch("py._ai_followup._get_followup_prompt", return_value=None)
    @patch("py._ai_followup.check_rate_limit", return_value={"allowed": True, "remaining": 29})
    @patch("py._ai_followup.get_client_ip", return_value="1.2.3.4")
    async def test_message_content_truncated_to_max_len(
        self, _mock_ip, _mock_rate, _mock_prompt, mock_client, mock_breaker,
    ):
        """History message content exceeding MAX_MESSAGE_LEN should be truncated."""
        type(mock_breaker).is_allowed = PropertyMock(return_value=True)

        text_block = MagicMock()
        text_block.type = "text"
        text_block.text = "Response"
        mock_response = MagicMock()
        mock_response.content = [text_block]
        mock_client.return_value.messages.create.return_value = mock_response

        long_content = "B" * 5000
        history = [
            FollowupMessage(role="user", content=long_content),
        ]

        body = FollowupRequest(
            message="Short message",
            locationName="Harare",
            locationSlug="harare",
            history=history,
        )
        request = self._make_request()

        await followup_chat(body, request)

        call_args = mock_client.return_value.messages.create.call_args
        messages = call_args.kwargs.get("messages") or call_args[1].get("messages")
        # Find the history message (not the new user message which is last)
        history_msg = messages[0]  # No weatherSummary, so history is first
        assert len(history_msg["content"]) == MAX_MESSAGE_LEN

    @pytest.mark.asyncio
    @patch("py._ai_followup.anthropic_breaker")
    @patch("py._ai_followup._get_client")
    @patch("py._ai_followup._get_followup_prompt", return_value=None)
    @patch("py._ai_followup.check_rate_limit", return_value={"allowed": True, "remaining": 29})
    @patch("py._ai_followup.get_client_ip", return_value="1.2.3.4")
    async def test_ai_rate_limit_error_raises_429(
        self, _mock_ip, _mock_rate, _mock_prompt, mock_client, mock_breaker,
    ):
        """Anthropic rate limit error should raise 429."""
        type(mock_breaker).is_allowed = PropertyMock(return_value=True)
        mock_client.return_value.messages.create.side_effect = anthropic.RateLimitError("rate limited")

        body = FollowupRequest(
            message="What about tomorrow?",
            locationName="Harare",
            locationSlug="harare",
        )
        request = self._make_request()

        with pytest.raises(HTTPException) as exc_info:
            await followup_chat(body, request)
        assert exc_info.value.status_code == 429
        assert "AI service rate limited" in exc_info.value.detail
        mock_breaker.record_failure.assert_called_once()

    @pytest.mark.asyncio
    @patch("py._ai_followup.anthropic_breaker")
    @patch("py._ai_followup._get_client")
    @patch("py._ai_followup._get_followup_prompt", return_value=None)
    @patch("py._ai_followup.check_rate_limit", return_value={"allowed": True, "remaining": 29})
    @patch("py._ai_followup.get_client_ip", return_value="1.2.3.4")
    async def test_ai_api_error_returns_graceful_fallback(
        self, _mock_ip, _mock_rate, _mock_prompt, mock_client, mock_breaker,
    ):
        """Anthropic APIError should return graceful fallback, not raise."""
        type(mock_breaker).is_allowed = PropertyMock(return_value=True)
        mock_client.return_value.messages.create.side_effect = anthropic.APIError("server error")

        body = FollowupRequest(
            message="What about tomorrow?",
            locationName="Harare",
            locationSlug="harare",
        )
        request = self._make_request()

        result = await followup_chat(body, request)
        assert result["error"] is True
        assert "trouble connecting" in result["response"]
        mock_breaker.record_failure.assert_called_once()

    @pytest.mark.asyncio
    @patch("py._ai_followup.anthropic_breaker")
    @patch("py._ai_followup._get_client")
    @patch("py._ai_followup._get_followup_prompt", return_value=None)
    @patch("py._ai_followup.check_rate_limit", return_value={"allowed": True, "remaining": 29})
    @patch("py._ai_followup.get_client_ip", return_value="1.2.3.4")
    async def test_message_at_exact_max_len_is_accepted(
        self, _mock_ip, _mock_rate, _mock_prompt, mock_client, mock_breaker,
    ):
        """Message at exactly MAX_MESSAGE_LEN should be accepted."""
        type(mock_breaker).is_allowed = PropertyMock(return_value=True)

        text_block = MagicMock()
        text_block.type = "text"
        text_block.text = "Response"
        mock_response = MagicMock()
        mock_response.content = [text_block]
        mock_client.return_value.messages.create.return_value = mock_response

        body = FollowupRequest(
            message="X" * MAX_MESSAGE_LEN,
            locationName="Harare",
            locationSlug="harare",
        )
        request = self._make_request()

        result = await followup_chat(body, request)
        assert result["response"] == "Response"

    @pytest.mark.asyncio
    @patch("py._ai_followup.anthropic_breaker")
    @patch("py._ai_followup._get_client")
    @patch("py._ai_followup._get_followup_prompt", return_value=None)
    @patch("py._ai_followup.check_rate_limit", return_value={"allowed": True, "remaining": 29})
    @patch("py._ai_followup.get_client_ip", return_value="1.2.3.4")
    async def test_history_messages_preserved_in_order(
        self, _mock_ip, _mock_rate, _mock_prompt, mock_client, mock_breaker,
    ):
        """History messages should appear in the sent messages in order."""
        type(mock_breaker).is_allowed = PropertyMock(return_value=True)

        text_block = MagicMock()
        text_block.type = "text"
        text_block.text = "Response"
        mock_response = MagicMock()
        mock_response.content = [text_block]
        mock_client.return_value.messages.create.return_value = mock_response

        history = [
            FollowupMessage(role="user", content="First question"),
            FollowupMessage(role="assistant", content="First answer"),
            FollowupMessage(role="user", content="Second question"),
        ]

        body = FollowupRequest(
            message="Third question",
            locationName="Harare",
            locationSlug="harare",
            weatherSummary="Sunny today.",
            history=history,
        )
        request = self._make_request()

        await followup_chat(body, request)

        call_args = mock_client.return_value.messages.create.call_args
        messages = call_args.kwargs.get("messages") or call_args[1].get("messages")

        # Expected: assistant (summary), user (first), assistant (first answer),
        # user (second), user (third)
        assert messages[0] == {"role": "assistant", "content": "Sunny today."}
        assert messages[1] == {"role": "user", "content": "First question"}
        assert messages[2] == {"role": "assistant", "content": "First answer"}
        assert messages[3] == {"role": "user", "content": "Second question"}
        assert messages[4] == {"role": "user", "content": "Third question"}
