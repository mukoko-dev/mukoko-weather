"""Tests for _anthropic.py (shared Claude client, breaker-guarded call, text
extraction) and the cached prompt loader get_ai_prompt in _ai_prompts.py."""

from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

import py._anthropic as anth
import py._ai_prompts as prompts
from py._anthropic import call_claude, first_text, get_anthropic_client
from py._ai_prompts import get_ai_prompt

# The conftest anthropic stub defines real exception classes; reuse them.
RateLimitError = anth.anthropic.RateLimitError
APIError = anth.anthropic.APIError


@pytest.fixture(autouse=True)
def _reset_module_state():
    anth._client = None
    prompts._prompt_doc_cache = {}
    prompts._prompt_doc_cache_at = 0
    yield
    anth._client = None
    prompts._prompt_doc_cache = {}
    prompts._prompt_doc_cache_at = 0


def _text(text: str) -> MagicMock:
    block = MagicMock()
    block.type = "text"
    block.text = text
    return block


def _response(*blocks) -> MagicMock:
    resp = MagicMock()
    resp.content = list(blocks)
    return resp


# ---------------------------------------------------------------------------
# get_anthropic_client — singleton, rotation, required flag
# ---------------------------------------------------------------------------


class TestGetAnthropicClient:
    @patch("py._anthropic.get_api_key", return_value=None)
    @patch.dict(os.environ, {}, clear=True)
    def test_returns_none_when_no_key_anywhere(self, _mock_key):
        assert get_anthropic_client() is None

    @patch("py._anthropic.get_api_key", return_value=None)
    @patch.dict(os.environ, {}, clear=True)
    def test_required_raises_503_when_no_key(self, _mock_key):
        with pytest.raises(HTTPException) as exc:
            get_anthropic_client(required=True)
        assert exc.value.status_code == 503
        assert exc.value.detail == "AI service unavailable"

    @patch("py._anthropic.anthropic.Anthropic")
    @patch("py._anthropic.get_api_key")
    @patch.dict(os.environ, {"ANTHROPIC_API_KEY": "env-key"}, clear=True)
    def test_env_key_creates_client_without_db_lookup(self, mock_key, mock_cls):
        mock_cls.return_value = MagicMock()
        client = get_anthropic_client()
        assert client is mock_cls.return_value
        mock_cls.assert_called_once_with(api_key="env-key")
        mock_key.assert_not_called()

    @patch("py._anthropic.anthropic.Anthropic")
    @patch("py._anthropic.get_api_key", return_value="db-key")
    @patch.dict(os.environ, {}, clear=True)
    def test_falls_back_to_db_key(self, _mock_key, mock_cls):
        get_anthropic_client()
        mock_cls.assert_called_once_with(api_key="db-key")

    @patch("py._anthropic.anthropic.Anthropic")
    @patch("py._anthropic.get_api_key")
    @patch.dict(os.environ, {"ANTHROPIC_API_KEY": "same-key"}, clear=True)
    def test_reuses_singleton_for_same_key(self, _mock_key, mock_cls):
        # The real client exposes the key it was built with; the singleton
        # check compares against it.
        mock_cls.return_value.api_key = "same-key"
        first = get_anthropic_client()
        second = get_anthropic_client()
        assert first is second
        assert mock_cls.call_count == 1

    @patch("py._anthropic.anthropic.Anthropic", side_effect=lambda api_key: MagicMock(name=api_key))
    @patch("py._anthropic.get_api_key", return_value=None)
    def test_rebuilds_when_key_rotates(self, _mock_key, mock_cls):
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "key-1"}, clear=True):
            first = get_anthropic_client()
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "key-2"}, clear=True):
            second = get_anthropic_client()
        assert first is not second
        assert mock_cls.call_count == 2
        mock_cls.assert_called_with(api_key="key-2")

    @patch("py._anthropic.anthropic.Anthropic")
    @patch("py._anthropic.get_api_key", return_value=None)
    def test_no_key_digest_kept_at_module_level(self, _mock_key, _mock_cls):
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "secret-value"}, clear=True):
            get_anthropic_client()
        assert not hasattr(anth, "_client_key_hash")


# ---------------------------------------------------------------------------
# call_claude — breaker-guarded call and error kinds
# ---------------------------------------------------------------------------


KWARGS = dict(model="claude-test", max_tokens=10, messages=[{"role": "user", "content": "hi"}])


class TestCallClaude:
    @patch("py._anthropic.anthropic_breaker")
    @patch("py._anthropic.get_anthropic_client", return_value=None)
    def test_no_client_returns_no_client_and_leaves_breaker_alone(self, _c, breaker):
        breaker.is_allowed = True
        assert call_claude(**KWARGS) == (None, "no_client")
        breaker.record_success.assert_not_called()
        breaker.record_failure.assert_not_called()

    @patch("py._anthropic.anthropic_breaker")
    @patch("py._anthropic.get_anthropic_client")
    def test_open_circuit_skips_call(self, mock_get, breaker):
        breaker.is_allowed = False
        client = MagicMock()
        mock_get.return_value = client
        assert call_claude(**KWARGS) == (None, "circuit_open")
        client.messages.create.assert_not_called()
        breaker.record_success.assert_not_called()
        breaker.record_failure.assert_not_called()

    @patch("py._anthropic.anthropic_breaker")
    @patch("py._anthropic.get_anthropic_client")
    def test_success_records_success_and_returns_response(self, mock_get, breaker):
        breaker.is_allowed = True
        client = MagicMock()
        resp = _response(_text("ok"))
        client.messages.create.return_value = resp
        mock_get.return_value = client

        assert call_claude(**KWARGS) == (resp, None)
        breaker.record_success.assert_called_once()
        breaker.record_failure.assert_not_called()

    @patch("py._anthropic.anthropic_breaker")
    @patch("py._anthropic.get_anthropic_client")
    def test_rate_limit_maps_to_rate_limited(self, mock_get, breaker):
        breaker.is_allowed = True
        client = MagicMock()
        client.messages.create.side_effect = RateLimitError("slow down")
        mock_get.return_value = client

        assert call_claude(**KWARGS) == (None, "rate_limited")
        breaker.record_failure.assert_called_once()
        breaker.record_success.assert_not_called()

    @patch("py._anthropic.anthropic_breaker")
    @patch("py._anthropic.get_anthropic_client")
    def test_api_error_maps_to_api_error(self, mock_get, breaker):
        breaker.is_allowed = True
        client = MagicMock()
        client.messages.create.side_effect = APIError("boom")
        mock_get.return_value = client

        assert call_claude(**KWARGS) == (None, "api_error")
        breaker.record_failure.assert_called_once()

    @patch("py._anthropic.anthropic_breaker")
    @patch("py._anthropic.get_anthropic_client")
    def test_unexpected_exception_still_trips_breaker(self, mock_get, breaker):
        breaker.is_allowed = True
        client = MagicMock()
        client.messages.create.side_effect = ValueError("not an SDK error")
        mock_get.return_value = client

        assert call_claude(**KWARGS) == (None, "api_error")
        breaker.record_failure.assert_called_once()

    @patch("py._anthropic.anthropic_breaker")
    @patch("py._anthropic.get_anthropic_client")
    def test_optional_system_and_tools_only_sent_when_given(self, mock_get, breaker):
        breaker.is_allowed = True
        client = MagicMock()
        mock_get.return_value = client

        call_claude(**KWARGS)
        kwargs = client.messages.create.call_args.kwargs
        assert "system" not in kwargs and "tools" not in kwargs

        tools = [{"name": "t"}]
        call_claude(**KWARGS, system="sys", tools=tools)
        kwargs = client.messages.create.call_args.kwargs
        assert kwargs["system"] == "sys"
        assert kwargs["tools"] == tools
        assert kwargs["model"] == "claude-test"
        assert kwargs["max_tokens"] == 10


# ---------------------------------------------------------------------------
# first_text
# ---------------------------------------------------------------------------


class TestFirstText:
    def test_returns_first_text_block(self):
        assert first_text(_response(_text("hello"), _text("second"))) == "hello"

    def test_skips_non_text_blocks(self):
        tool_use = MagicMock()
        tool_use.type = "tool_use"
        assert first_text(_response(tool_use, _text("after tool"))) == "after tool"

    def test_empty_when_no_text_block(self):
        tool_use = MagicMock()
        tool_use.type = "tool_use"
        assert first_text(_response(tool_use)) == ""
        assert first_text(_response()) == ""


# ---------------------------------------------------------------------------
# get_ai_prompt — shared 5-minute prompt cache
# ---------------------------------------------------------------------------


def _coll_with(docs):
    coll = MagicMock()
    coll.find.return_value = list(docs)
    return coll


class TestGetAiPrompt:
    @patch("py._ai_prompts.ai_prompts_collection")
    def test_returns_doc_by_key(self, mock_coll_fn):
        mock_coll_fn.return_value = _coll_with([
            {"promptKey": "system:chat", "template": "chat"},
            {"promptKey": "system:summary", "template": "summary"},
        ])
        assert get_ai_prompt("system:chat") == {"promptKey": "system:chat", "template": "chat"}
        assert get_ai_prompt("missing:key") is None

    @patch("py._ai_prompts.ai_prompts_collection")
    def test_queries_only_active_prompts(self, mock_coll_fn):
        coll = _coll_with([])
        mock_coll_fn.return_value = coll
        get_ai_prompt("system:chat")
        coll.find.assert_called_once_with({"active": True}, {"_id": 0, "updatedAt": 0})

    @patch("py._ai_prompts.time")
    @patch("py._ai_prompts.ai_prompts_collection")
    def test_serves_cache_within_ttl_and_refetches_after(self, mock_coll_fn, mock_time):
        coll = _coll_with([{"promptKey": "system:chat", "template": "v1"}])
        mock_coll_fn.return_value = coll

        mock_time.time.return_value = 1000.0
        assert get_ai_prompt("system:chat")["template"] == "v1"

        # Inside the 5-minute window: no DB round trip.
        mock_time.time.return_value = 1000.0 + prompts.CACHE_TTL - 1
        coll.find.return_value = [{"promptKey": "system:chat", "template": "v2"}]
        assert get_ai_prompt("system:chat")["template"] == "v1"
        assert coll.find.call_count == 1

        # Past the TTL: refetched.
        mock_time.time.return_value = 1000.0 + prompts.CACHE_TTL + 1
        assert get_ai_prompt("system:chat")["template"] == "v2"
        assert coll.find.call_count == 2

    @patch("py._ai_prompts.time")
    @patch("py._ai_prompts.ai_prompts_collection")
    def test_empty_snapshot_is_still_cached(self, mock_coll_fn, mock_time):
        coll = _coll_with([])
        mock_coll_fn.return_value = coll
        mock_time.time.return_value = 500.0
        assert get_ai_prompt("system:chat") is None
        mock_time.time.return_value = 501.0
        assert get_ai_prompt("system:chat") is None
        assert coll.find.call_count == 1

    @patch("py._ai_prompts.time")
    @patch("py._ai_prompts.ai_prompts_collection")
    def test_db_error_serves_last_snapshot(self, mock_coll_fn, mock_time):
        mock_time.time.return_value = 1000.0
        mock_coll_fn.return_value = _coll_with([{"promptKey": "system:chat", "template": "cached"}])
        assert get_ai_prompt("system:chat")["template"] == "cached"

        # TTL expired and the DB is now down: stale snapshot is served.
        mock_time.time.return_value = 1000.0 + prompts.CACHE_TTL + 1
        broken = MagicMock()
        broken.find.side_effect = RuntimeError("db down")
        mock_coll_fn.return_value = broken
        assert get_ai_prompt("system:chat")["template"] == "cached"

    @patch("py._ai_prompts.ai_prompts_collection")
    def test_db_error_with_no_snapshot_returns_none(self, mock_coll_fn):
        broken = MagicMock()
        broken.find.side_effect = RuntimeError("db down")
        mock_coll_fn.return_value = broken
        assert get_ai_prompt("system:chat") is None
