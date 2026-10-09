"""Tests for _ai_gateway.py (Cloudflare AI Gateway URL/headers, model
resolution, breaker-guarded call, response parsing) and the cached prompt
loader get_ai_prompt in _ai_prompts.py."""

from __future__ import annotations

import os
import re
from pathlib import Path
from unittest.mock import MagicMock, patch

import httpx
import pytest

import py._ai_gateway as gw
import py._ai_prompts as prompts
from py._ai_gateway import (
    AIResponse,
    DEFAULT_MODEL,
    ai_configured,
    call_ai,
    missing_ai_config,
    first_text,
    function_tools,
    gateway_headers,
    gateway_url,
    resolve_model,
    tool_result_message,
)
from py._ai_prompts import get_ai_prompt

ACCOUNT = "acct123"
FULL_ENV = {
    "CLOUDFLARE_ACCOUNT_ID": ACCOUNT,
    "CF_AI_API_TOKEN": "cf-ai-token",
}
# Legacy split: one token per header, no CF_AI_API_TOKEN.
SPLIT_ENV = {
    "CLOUDFLARE_ACCOUNT_ID": ACCOUNT,
    "AI_GATEWAY_TOKEN": "gw-token",
    "CF_WORKERS_AI_TOKEN": "wai-token",
}


@pytest.fixture(autouse=True)
def _reset_module_state():
    gw._client = None
    gw._warned_unconfigured = False
    prompts._prompt_doc_cache = {}
    prompts._prompt_doc_cache_at = 0
    yield
    gw._client = None
    gw._warned_unconfigured = False
    prompts._prompt_doc_cache = {}
    prompts._prompt_doc_cache_at = 0


def _http_response(status: int = 200, json_body: dict | None = None) -> httpx.Response:
    req = httpx.Request("POST", "https://gateway.example/compat/chat/completions")
    return httpx.Response(status, json=json_body or {}, request=req)


def _completion(content=None, tool_calls=None, finish="stop") -> dict:
    msg = {"role": "assistant", "content": content}
    if tool_calls is not None:
        msg["tool_calls"] = tool_calls
    return {"choices": [{"message": msg, "finish_reason": finish}]}


def _mock_http(response: httpx.Response | Exception) -> MagicMock:
    client = MagicMock()
    if isinstance(response, Exception):
        client.post.side_effect = response
    else:
        client.post.return_value = response
    return client


# ---------------------------------------------------------------------------
# gateway_url — base URL construction
# ---------------------------------------------------------------------------


class TestGatewayUrl:
    @patch.dict(os.environ, {"CLOUDFLARE_ACCOUNT_ID": ACCOUNT}, clear=True)
    def test_defaults_to_shamwari_gateway(self):
        assert gateway_url() == (
            f"https://gateway.ai.cloudflare.com/v1/{ACCOUNT}/shamwari/compat/chat/completions"
        )

    @patch.dict(os.environ, {"CLOUDFLARE_ACCOUNT_ID": ACCOUNT, "AI_GATEWAY_ID": "other"}, clear=True)
    def test_gateway_id_from_env(self):
        assert gateway_url() == (
            f"https://gateway.ai.cloudflare.com/v1/{ACCOUNT}/other/compat/chat/completions"
        )

    @patch.dict(os.environ, {"CLOUDFLARE_ACCOUNT_ID": ACCOUNT, "AI_GATEWAY_ID": "  "}, clear=True)
    def test_blank_gateway_id_falls_back_to_shamwari(self):
        assert "/shamwari/" in gateway_url()

    @patch.dict(
        os.environ,
        {"AI_GATEWAY_URL": "https://gw.example/v1/a/g/compat/", "CLOUDFLARE_ACCOUNT_ID": ACCOUNT},
        clear=True,
    )
    def test_url_override_wins(self):
        assert gateway_url() == "https://gw.example/v1/a/g/compat/chat/completions"

    @patch.dict(os.environ, {"AI_GATEWAY_URL": "https://gw.example/compat/chat/completions"}, clear=True)
    def test_url_override_already_complete(self):
        assert gateway_url() == "https://gw.example/compat/chat/completions"

    @patch.dict(os.environ, {}, clear=True)
    def test_none_when_unset(self):
        assert gateway_url() is None


# ---------------------------------------------------------------------------
# gateway_headers — auth headers present or absent
# ---------------------------------------------------------------------------


class TestGatewayHeaders:
    @patch.dict(os.environ, FULL_ENV, clear=True)
    def test_primary_token_used_for_both_headers(self):
        h = gateway_headers()
        assert h["cf-aig-authorization"] == "Bearer cf-ai-token"
        assert h["Authorization"] == "Bearer cf-ai-token"
        assert h["Content-Type"] == "application/json"

    @patch.dict(os.environ, SPLIT_ENV, clear=True)
    def test_legacy_split_tokens_sent(self):
        h = gateway_headers()
        assert h["cf-aig-authorization"] == "Bearer gw-token"
        assert h["Authorization"] == "Bearer wai-token"

    @patch.dict(os.environ, {**FULL_ENV, "AI_GATEWAY_TOKEN": "gw-token"}, clear=True)
    def test_gateway_override_only_affects_gateway_header(self):
        h = gateway_headers()
        assert h["cf-aig-authorization"] == "Bearer gw-token"
        assert h["Authorization"] == "Bearer cf-ai-token"

    @patch.dict(os.environ, {**FULL_ENV, "CF_WORKERS_AI_TOKEN": "wai-token"}, clear=True)
    def test_provider_override_only_affects_provider_header(self):
        h = gateway_headers()
        assert h["cf-aig-authorization"] == "Bearer cf-ai-token"
        assert h["Authorization"] == "Bearer wai-token"

    @patch.dict(os.environ, {**FULL_ENV, "AI_GATEWAY_TOKEN": "  "}, clear=True)
    def test_blank_override_falls_back_to_primary(self):
        assert gateway_headers()["cf-aig-authorization"] == "Bearer cf-ai-token"

    @patch.dict(os.environ, {"CLOUDFLARE_ACCOUNT_ID": ACCOUNT}, clear=True)
    def test_no_auth_headers_when_tokens_unset(self):
        h = gateway_headers()
        assert "cf-aig-authorization" not in h
        assert "Authorization" not in h

    @patch.dict(os.environ, {"AI_GATEWAY_TOKEN": "gw-token"}, clear=True)
    def test_gateway_token_only(self):
        h = gateway_headers()
        assert h["cf-aig-authorization"] == "Bearer gw-token"
        assert "Authorization" not in h


# ---------------------------------------------------------------------------
# ai_configured — missing config degrades with a warning
# ---------------------------------------------------------------------------


class TestAiConfigured:
    @patch.dict(os.environ, FULL_ENV, clear=True)
    def test_true_with_primary_token_alone(self):
        assert ai_configured() is True
        assert missing_ai_config() == []

    @patch.dict(os.environ, SPLIT_ENV, clear=True)
    def test_true_with_legacy_split_tokens(self):
        assert ai_configured() is True

    @patch.dict(os.environ, {"CLOUDFLARE_ACCOUNT_ID": ACCOUNT, "AI_GATEWAY_TOKEN": "gw"}, clear=True)
    def test_false_when_provider_token_unresolved(self):
        assert ai_configured() is False
        assert missing_ai_config() == ["CF_AI_API_TOKEN (or CF_WORKERS_AI_TOKEN)"]

    @patch.dict(os.environ, {"CLOUDFLARE_ACCOUNT_ID": ACCOUNT}, clear=True)
    def test_degrades_when_no_token_set(self, caplog):
        with caplog.at_level("WARNING"):
            assert ai_configured() is False
            assert call_ai(max_tokens=10, messages=[{"role": "user", "content": "hi"}]) == (None, "no_client")
        assert "CF_AI_API_TOKEN" in caplog.text

    @pytest.mark.parametrize("missing", list(FULL_ENV))
    def test_false_and_warns_when_any_piece_missing(self, missing, caplog):
        env = {k: v for k, v in FULL_ENV.items() if k != missing}
        with patch.dict(os.environ, env, clear=True):
            with caplog.at_level("WARNING"):
                assert ai_configured() is False
        assert "AI gateway not configured" in caplog.text

    @patch.dict(os.environ, {}, clear=True)
    def test_warns_only_once(self, caplog):
        with caplog.at_level("WARNING"):
            ai_configured()
            ai_configured()
        assert caplog.text.count("AI gateway not configured") == 1


# ---------------------------------------------------------------------------
# resolve_model — honour DB ids, migrate legacy Anthropic ids
# ---------------------------------------------------------------------------


class TestResolveModel:
    @patch.dict(os.environ, {}, clear=True)
    def test_default_is_workers_ai_glm(self):
        assert resolve_model() == DEFAULT_MODEL
        assert DEFAULT_MODEL.startswith("workers-ai/@cf/zai-org/glm")

    @patch.dict(os.environ, {}, clear=True)
    def test_legacy_claude_id_migrated(self):
        assert resolve_model("claude-haiku-4-5-20251001") == DEFAULT_MODEL

    @patch.dict(os.environ, {}, clear=True)
    def test_db_glm_id_honoured(self):
        assert resolve_model("workers-ai/@cf/zai-org/glm-4.7-flash") == "workers-ai/@cf/zai-org/glm-4.7-flash"

    @patch.dict(os.environ, {}, clear=True)
    def test_bare_cf_id_gets_provider_prefix(self):
        assert resolve_model("@cf/zai-org/glm-5.2") == "workers-ai/@cf/zai-org/glm-5.2"

    @patch.dict(os.environ, {"AI_MODEL": "workers-ai/@cf/zai-org/glm-5.3-flash"}, clear=True)
    def test_env_overrides_default(self):
        assert resolve_model(None) == "workers-ai/@cf/zai-org/glm-5.3-flash"
        assert resolve_model("claude-x") == "workers-ai/@cf/zai-org/glm-5.3-flash"


# ---------------------------------------------------------------------------
# call_ai — breaker-guarded gateway call
# ---------------------------------------------------------------------------


@patch("py._ai_gateway.ai_breaker")
class TestCallAi:
    @patch.dict(os.environ, {}, clear=True)
    def test_unconfigured_returns_no_client_and_leaves_breaker_alone(self, breaker):
        with patch("py._ai_gateway.httpx.Client") as get_http:
            resp, err = call_ai(max_tokens=10, messages=[])
        assert (resp, err) == (None, "no_client")
        get_http.assert_not_called()
        breaker.record_failure.assert_not_called()
        breaker.record_success.assert_not_called()

    @patch.dict(os.environ, FULL_ENV, clear=True)
    def test_open_circuit_skips_call(self, breaker):
        breaker.is_allowed = False
        with patch("py._ai_gateway.httpx.Client") as get_http:
            resp, err = call_ai(max_tokens=10, messages=[])
        assert (resp, err) == (None, "circuit_open")
        get_http.return_value.post.assert_not_called()

    @patch.dict(os.environ, FULL_ENV, clear=True)
    def test_success_posts_to_gateway_and_parses(self, breaker):
        breaker.is_allowed = True
        client = _mock_http(_http_response(200, _completion("Hello")))
        with patch("py._ai_gateway.httpx.Client", return_value=client):
            resp, err = call_ai(
                model="claude-haiku-4-5-20251001", max_tokens=50, system="SYS",
                messages=[{"role": "user", "content": "hi"}],
            )
        assert err is None
        assert isinstance(resp, AIResponse) and resp.text == "Hello"
        breaker.record_success.assert_called_once()
        url = client.post.call_args.args[0]
        kwargs = client.post.call_args.kwargs
        assert url == f"https://gateway.ai.cloudflare.com/v1/{ACCOUNT}/shamwari/compat/chat/completions"
        assert kwargs["headers"]["cf-aig-authorization"] == "Bearer cf-ai-token"
        assert kwargs["headers"]["Authorization"] == "Bearer cf-ai-token"
        payload = kwargs["json"]
        assert payload["model"] == DEFAULT_MODEL
        assert payload["max_tokens"] == 50
        assert payload["messages"][0] == {"role": "system", "content": "SYS"}
        assert payload["messages"][1] == {"role": "user", "content": "hi"}
        assert "tools" not in payload

    @patch.dict(os.environ, FULL_ENV, clear=True)
    def test_tools_sent_and_tool_calls_parsed(self, breaker):
        breaker.is_allowed = True
        body = _completion(None, tool_calls=[{
            "id": "call_1", "type": "function",
            "function": {"name": "get_weather", "arguments": '{"location_slug": "harare"}'},
        }], finish="tool_calls")
        client = _mock_http(_http_response(200, body))
        tools = function_tools([{"name": "get_weather", "description": "d", "parameters": {"type": "object"}}])
        with patch("py._ai_gateway.httpx.Client", return_value=client):
            resp, err = call_ai(max_tokens=50, messages=[], tools=tools)
        assert err is None
        assert client.post.call_args.kwargs["json"]["tools"] == tools
        assert resp.tool_calls[0].id == "call_1"
        assert resp.tool_calls[0].name == "get_weather"
        assert resp.tool_calls[0].arguments == {"location_slug": "harare"}
        assert resp.message["tool_calls"][0]["id"] == "call_1"
        assert resp.text == ""

    @patch.dict(os.environ, FULL_ENV, clear=True)
    def test_malformed_tool_arguments_become_empty_dict(self, breaker):
        breaker.is_allowed = True
        body = _completion(None, tool_calls=[{"id": "c", "function": {"name": "x", "arguments": "{bad"}}])
        with patch("py._ai_gateway.httpx.Client", return_value=_mock_http(_http_response(200, body))):
            resp, _ = call_ai(max_tokens=5, messages=[])
        assert resp.tool_calls[0].arguments == {}

    @patch.dict(os.environ, FULL_ENV, clear=True)
    def test_429_maps_to_rate_limited(self, breaker):
        breaker.is_allowed = True
        with patch("py._ai_gateway.httpx.Client", return_value=_mock_http(_http_response(429))):
            assert call_ai(max_tokens=5, messages=[]) == (None, "rate_limited")
        breaker.record_failure.assert_called_once()

    @patch.dict(os.environ, FULL_ENV, clear=True)
    def test_http_error_maps_to_api_error(self, breaker):
        breaker.is_allowed = True
        with patch("py._ai_gateway.httpx.Client", return_value=_mock_http(_http_response(401))):
            assert call_ai(max_tokens=5, messages=[]) == (None, "api_error")
        breaker.record_failure.assert_called_once()
        breaker.record_success.assert_not_called()

    @patch.dict(os.environ, FULL_ENV, clear=True)
    def test_transport_error_trips_breaker(self, breaker):
        breaker.is_allowed = True
        with patch("py._ai_gateway.httpx.Client", return_value=_mock_http(httpx.ConnectTimeout("t"))):
            assert call_ai(max_tokens=5, messages=[]) == (None, "api_error")
        breaker.record_failure.assert_called_once()


class TestHelpers:
    def test_first_text(self):
        assert first_text(AIResponse(text="hi")) == "hi"
        assert first_text(AIResponse(text="")) == ""
        assert first_text(None) == ""

    def test_function_tools_wraps(self):
        assert function_tools([{"name": "a"}]) == [{"type": "function", "function": {"name": "a"}}]

    def test_tool_result_message(self):
        assert tool_result_message("c1", "{}") == {"role": "tool", "tool_call_id": "c1", "content": "{}"}


# ---------------------------------------------------------------------------
# Every AI endpoint goes through the helper
# ---------------------------------------------------------------------------

API_DIR = Path(__file__).resolve().parent.parent.parent / "api" / "py"
AI_MODULES = ["_ai.py", "_ai_followup.py", "_chat.py", "_explore_search.py", "_reports.py", "_history_analyze.py"]


class TestEveryEndpointUsesHelper:
    @pytest.mark.parametrize("module", AI_MODULES)
    def test_module_imports_call_ai(self, module):
        src = (API_DIR / module).read_text()
        assert re.search(r"from \._ai_gateway import [^\n]*\bcall_ai\b", src), module

    def test_no_other_module_talks_to_a_model_provider(self):
        offenders = []
        for path in API_DIR.glob("*.py"):
            if path.name == "_ai_gateway.py":
                continue
            src = path.read_text()
            if re.search(r"gateway\.ai\.cloudflare\.com|chat/completions|^import anthropic|^from anthropic|^import openai", src, re.M):
                offenders.append(path.name)
        assert offenders == []

    def test_requirements_drop_anthropic(self):
        reqs = (API_DIR.parent.parent / "requirements.txt").read_text()
        assert "anthropic" not in reqs


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
