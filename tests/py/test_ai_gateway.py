"""Tests for _ai_gateway.py (the weather AI Worker client: URL/headers, model
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
    ai_configured,
    call_ai,
    missing_ai_config,
    first_text,
    function_tools,
    gateway_headers,
    gateway_url,
    tool_result_message,
)
from py._ai_prompts import get_ai_prompt

SERVICE = "https://weather-internal.example"
KEY = "svc-key-value"
FULL_ENV = {"WEATHER_SERVICE_URL": SERVICE, "WEATHER_SERVICE_API_KEY": KEY}
COMPLETIONS_URL = f"{SERVICE}/internal/ai/chat/completions"


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
    req = httpx.Request("POST", COMPLETIONS_URL)
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
# gateway_url — the Worker's chat-completions URL
# ---------------------------------------------------------------------------


class TestGatewayUrl:
    @patch.dict(os.environ, {"WEATHER_SERVICE_URL": SERVICE}, clear=True)
    def test_built_from_service_url(self):
        assert gateway_url() == COMPLETIONS_URL

    @patch.dict(os.environ, {"WEATHER_SERVICE_URL": SERVICE + "/"}, clear=True)
    def test_trailing_slash_ignored(self):
        assert gateway_url() == COMPLETIONS_URL

    @patch.dict(os.environ, {"WEATHER_SERVICE_URL": SERVICE, "WEATHER_AI_URL": "https://ai.example"}, clear=True)
    def test_ai_url_base_wins(self):
        assert gateway_url() == "https://ai.example/internal/ai/chat/completions"

    @patch.dict(os.environ, {"WEATHER_AI_URL": "https://ai.example/x/chat/completions"}, clear=True)
    def test_ai_url_already_complete(self):
        assert gateway_url() == "https://ai.example/x/chat/completions"

    @patch.dict(os.environ, {}, clear=True)
    def test_none_when_unset(self):
        assert gateway_url() is None

    @patch.dict(
        os.environ,
        {"CLOUDFLARE_ACCOUNT_ID": "acct", "CF_AI_API_TOKEN": "t", "AI_GATEWAY_URL": "https://gateway.ai.cloudflare.com/v1/x"},
        clear=True,
    )
    def test_old_gateway_env_is_ignored(self):
        # The backend no longer calls Cloudflare AI directly at all.
        assert gateway_url() is None
        assert ai_configured() is False


# ---------------------------------------------------------------------------
# gateway_headers — the service key, nothing Cloudflare
# ---------------------------------------------------------------------------


class TestGatewayHeaders:
    @patch.dict(os.environ, FULL_ENV, clear=True)
    def test_service_key_is_the_bearer(self):
        h = gateway_headers()
        assert h["Authorization"] == f"Bearer {KEY}"
        assert h["Content-Type"] == "application/json"
        assert "cf-aig-authorization" not in h

    @patch.dict(os.environ, {"WEATHER_SERVICE_URL": SERVICE}, clear=True)
    def test_no_auth_header_without_key(self):
        assert "Authorization" not in gateway_headers()


# ---------------------------------------------------------------------------
# ai_configured / missing_ai_config
# ---------------------------------------------------------------------------


class TestAiConfigured:
    @patch.dict(os.environ, FULL_ENV, clear=True)
    def test_true_with_url_and_key(self):
        assert ai_configured() is True
        assert missing_ai_config() == []

    @patch.dict(os.environ, {"WEATHER_AI_URL": "https://ai.example", "WEATHER_SERVICE_API_KEY": KEY}, clear=True)
    def test_true_with_ai_url_and_key(self):
        assert ai_configured() is True

    @pytest.mark.parametrize("missing", ["WEATHER_SERVICE_URL", "WEATHER_SERVICE_API_KEY"])
    def test_false_and_warns_when_any_piece_missing(self, missing, caplog):
        env = {k: v for k, v in FULL_ENV.items() if k != missing}
        with patch.dict(os.environ, env, clear=True):
            assert ai_configured() is False
            assert any(missing in m for m in missing_ai_config())
        assert "AI Worker not configured" in caplog.text
        assert KEY not in caplog.text

    @patch.dict(os.environ, {}, clear=True)
    def test_warns_only_once(self, caplog):
        ai_configured()
        ai_configured()
        assert caplog.text.count("AI Worker not configured") == 1


# ---------------------------------------------------------------------------
# call_ai — breaker-guarded call
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
    def test_success_posts_to_the_worker_and_parses(self, breaker):
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
        assert url == COMPLETIONS_URL
        assert kwargs["headers"]["Authorization"] == f"Bearer {KEY}"
        assert "cf-aig-authorization" not in kwargs["headers"]
        payload = kwargs["json"]
        assert "model" not in payload, "the Worker picks the model"
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
    def test_db_model_is_not_forwarded(self, breaker):
        # The Worker's AI_MODEL decides; a DB prompt's model can't override it.
        breaker.is_allowed = True
        client = _mock_http(_http_response(200, _completion("ok")))
        with patch("py._ai_gateway.httpx.Client", return_value=client):
            call_ai(model="@cf/zai-org/glm-5.3", max_tokens=5, messages=[{"role": "user", "content": "x"}])
        assert "model" not in client.post.call_args.kwargs["json"]

    @pytest.mark.parametrize("status", [400, 413, 422])
    @patch.dict(os.environ, FULL_ENV, clear=True)
    def test_refused_request_is_api_error_without_tripping_breaker(self, breaker, status):
        # e.g. 422 personal_data_detected: the Worker is fine, the input is not.
        breaker.is_allowed = True
        body = {"error": "personal_data_detected", "error_description": "remove personal details"}
        with patch("py._ai_gateway.httpx.Client", return_value=_mock_http(_http_response(status, body))):
            assert call_ai(max_tokens=5, messages=[]) == (None, "api_error")
        breaker.record_failure.assert_not_called()
        breaker.record_success.assert_not_called()

    @pytest.mark.parametrize("status", [401, 502, 503])
    @patch.dict(os.environ, FULL_ENV, clear=True)
    def test_worker_down_or_misconfigured_trips_breaker(self, breaker, status):
        breaker.is_allowed = True
        with patch("py._ai_gateway.httpx.Client", return_value=_mock_http(_http_response(status))):
            assert call_ai(max_tokens=5, messages=[]) == (None, "api_error")
        breaker.record_failure.assert_called_once()

    @patch.dict(os.environ, FULL_ENV, clear=True)
    def test_tool_loop_round_trip(self, breaker):
        """A tool call comes back, its result goes in, the answer comes out."""
        breaker.is_allowed = True
        first = _completion(None, tool_calls=[{
            "id": "call_0", "type": "function",
            "function": {"name": "get_weather", "arguments": '{"location_slug": "harare"}'},
        }], finish="tool_calls")
        second = _completion("Harare: **dry and warm**.")
        client = MagicMock()
        client.post.side_effect = [_http_response(200, first), _http_response(200, second)]
        tools = function_tools([{"name": "get_weather", "description": "d", "parameters": {"type": "object"}}])
        messages = [{"role": "user", "content": "Weather in Harare?"}]
        with patch("py._ai_gateway.httpx.Client", return_value=client):
            resp, err = call_ai(max_tokens=50, system="SYS", messages=messages, tools=tools)
            assert err is None and resp.tool_calls[0].name == "get_weather"
            messages = messages + [resp.message, tool_result_message(resp.tool_calls[0].id, '{"temp": 28}')]
            resp, err = call_ai(max_tokens=50, system="SYS", messages=messages, tools=tools)
        assert err is None and resp.text == "Harare: **dry and warm**."
        sent = client.post.call_args_list[1].kwargs["json"]["messages"]
        assert [m["role"] for m in sent] == ["system", "user", "assistant", "tool"]
        assert sent[2]["tool_calls"][0]["id"] == "call_0"
        assert sent[3] == {"role": "tool", "tool_call_id": "call_0", "content": '{"temp": 28}'}

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

    def test_backend_holds_no_cloudflare_ai_token_or_host(self):
        """AI goes through the weather Worker; api/py names no CF AI host or token."""
        forbidden = re.compile(
            r"gateway\.ai\.cloudflare\.com|api\.cloudflare\.com/client/v4/accounts/\S*/ai\b|/ai/run\b|"
            r"\bCF_AI_API_TOKEN\b|\bAI_GATEWAY_TOKEN\b|\bCF_WORKERS_AI_TOKEN\b|\bAI_GATEWAY_URL\b"
        )
        offenders = [p.name for p in API_DIR.glob("*.py") if forbidden.search(p.read_text())]
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
