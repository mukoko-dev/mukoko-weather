"""
Shared AI plumbing for the Python backend — every model call goes through the
Cloudflare AI Gateway named ``shamwari``.

The gateway's OpenAI-compatible Unified API (``/compat/chat/completions``)
fronts a GLM model hosted on Workers AI — no third-party provider key. Two
Cloudflare API tokens are involved:

- ``CF_WORKERS_AI_TOKEN`` — provider auth (*Workers AI: Read*), sent as
  ``Authorization: Bearer``.
- ``AI_GATEWAY_TOKEN`` — gateway auth (*AI Gateway: Run*), sent as
  ``cf-aig-authorization: Bearer``. Required because ``shamwari`` has
  authentication switched on.

- :func:`gateway_url` — the chat-completions URL, built from env.
- :func:`gateway_headers` — request headers (``cf-aig-authorization``).
- :func:`resolve_model` — honours a DB ``model`` override, migrating legacy
  non-GLM ids (``claude-*``) to the configured default.
- :func:`get_gateway_client` — module-level :class:`GatewayClient`, or None
  when the gateway env is incomplete.
- :func:`call_ai` — one breaker-guarded chat-completions call. Returns
  ``(AIResponse, None)`` on success or ``(None, error_kind)`` on failure and
  records breaker success/failure itself, so callers never double-record.
- :func:`first_text` — the response's text ("" when none).
- :func:`function_tools` / :func:`tool_result_message` — OpenAI-style tool
  definitions and tool-result messages for the tool-use loops.

When the gateway env is incomplete, a warning is logged and calls return
``"no_client"`` so every endpoint degrades to its existing fallback (basic
summary, text search, hardcoded questions) instead of breaking.

Callers keep their own fallback copy and HTTP status mapping; this module only
reports *what* went wrong.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Literal, Optional

import httpx

from ._circuit_breaker import ai_breaker

logger = logging.getLogger(__name__)

ErrorKind = Literal["no_client", "circuit_open", "rate_limited", "api_error"]

GATEWAY_HOST = "https://gateway.ai.cloudflare.com/v1"
DEFAULT_GATEWAY_ID = "shamwari"
# Strongest Workers AI GLM with function calling (needed by chat + explore).
DEFAULT_MODEL = "workers-ai/@cf/zai-org/glm-5.3"
REQUEST_TIMEOUT_S = 25.0

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


def gateway_url() -> Optional[str]:
    """Return the gateway chat-completions URL, or None when unconfigured.

    ``AI_GATEWAY_URL`` (the gateway base up to and including ``/compat``)
    overrides everything; otherwise the URL is built from
    ``CLOUDFLARE_ACCOUNT_ID`` and ``AI_GATEWAY_ID`` (default ``shamwari``).
    """
    override = (os.environ.get("AI_GATEWAY_URL") or "").strip().rstrip("/")
    if override:
        if override.endswith("/chat/completions"):
            return override
        return f"{override}/chat/completions"

    account = (os.environ.get("CLOUDFLARE_ACCOUNT_ID") or "").strip()
    if not account:
        return None
    gateway = (os.environ.get("AI_GATEWAY_ID") or "").strip() or DEFAULT_GATEWAY_ID
    return f"{GATEWAY_HOST}/{account}/{gateway}/compat/chat/completions"


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def gateway_headers() -> dict[str, str]:
    """Headers for a gateway request.

    ``Authorization`` carries the Workers AI provider token; ``cf-aig-authorization``
    carries the gateway token. Each is sent only when its env var is set.
    """
    headers = {"Content-Type": "application/json"}
    provider_token = _env("CF_WORKERS_AI_TOKEN")
    if provider_token:
        headers["Authorization"] = f"Bearer {provider_token}"
    gateway_token = _env("AI_GATEWAY_TOKEN")
    if gateway_token:
        headers["cf-aig-authorization"] = f"Bearer {gateway_token}"
    return headers


_warned_unconfigured = False


def ai_configured() -> bool:
    """True when the gateway URL and both tokens are set.

    Logs one warning per process when they are not, so a missing config shows
    up in the logs while the endpoints quietly use their fallbacks.
    """
    global _warned_unconfigured
    missing = []
    if gateway_url() is None:
        missing.append("CLOUDFLARE_ACCOUNT_ID (or AI_GATEWAY_URL)")
    for name in ("CF_WORKERS_AI_TOKEN", "AI_GATEWAY_TOKEN"):
        if not _env(name):
            missing.append(name)
    if missing:
        if not _warned_unconfigured:
            logger.warning(
                "AI gateway not configured (missing %s) — AI endpoints use fallbacks",
                ", ".join(missing),
            )
            _warned_unconfigured = True
        return False
    return True


def resolve_model(requested: Optional[str] = None) -> str:
    """Pick the model id for a call.

    ``AI_MODEL`` env replaces the built-in default. A DB-supplied id is
    honoured unless it is a legacy Anthropic id (``claude-*``), which is
    migrated to the default. A bare Workers AI id (``@cf/...``) gets the
    ``workers-ai/`` provider prefix the Unified API expects.
    """
    default = (os.environ.get("AI_MODEL") or "").strip() or DEFAULT_MODEL
    model = (requested or "").strip()
    if not model or model.lower().startswith("claude"):
        model = default
    if model.startswith("@cf/"):
        model = f"workers-ai/{model}"
    return model


# ---------------------------------------------------------------------------
# Response shape + tool helpers
# ---------------------------------------------------------------------------


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass
class AIResponse:
    text: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    finish_reason: Optional[str] = None
    # The raw assistant message, re-appended verbatim in tool-use loops.
    message: dict[str, Any] = field(default_factory=dict)


def function_tools(defs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Wrap ``{name, description, parameters}`` dicts as OpenAI function tools."""
    return [{"type": "function", "function": d} for d in defs]


def tool_result_message(call_id: str, content: str) -> dict[str, Any]:
    """The message that returns a tool's output to the model."""
    return {"role": "tool", "tool_call_id": call_id, "content": content}


def _parse_response(data: dict[str, Any]) -> AIResponse:
    choice = (data.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    calls: list[ToolCall] = []
    for raw in message.get("tool_calls") or []:
        fn = raw.get("function") or {}
        args = fn.get("arguments") or {}
        if isinstance(args, str):
            try:
                args = json.loads(args) if args.strip() else {}
            except json.JSONDecodeError:
                args = {}
        calls.append(ToolCall(id=raw.get("id", ""), name=fn.get("name", ""), arguments=args or {}))
    return AIResponse(
        text=message.get("content") or "",
        tool_calls=calls,
        finish_reason=choice.get("finish_reason"),
        message={k: v for k, v in message.items() if k in ("role", "content", "tool_calls")},
    )


# ---------------------------------------------------------------------------
# Gateway client (module-level singleton, persists across warm invocations)
# ---------------------------------------------------------------------------


class GatewayError(Exception):
    """Any non-429 gateway/transport failure or malformed response."""


class GatewayRateLimitError(GatewayError):
    """HTTP 429 from the gateway (its rate limit or the model's)."""


class GatewayClient:
    """Thin chat-completions client for the AI Gateway's Unified API."""

    def __init__(self) -> None:
        self._http = httpx.Client(timeout=REQUEST_TIMEOUT_S)

    def create(
        self,
        *,
        model: Optional[str] = None,
        max_tokens: int,
        messages: list[dict[str, Any]],
        system: Optional[str] = None,
        tools: Optional[list[dict[str, Any]]] = None,
    ) -> AIResponse:
        payload: dict[str, Any] = {
            "model": resolve_model(model),
            "max_tokens": max_tokens,
            "messages": ([{"role": "system", "content": system}] if system else []) + list(messages),
        }
        if tools:
            payload["tools"] = tools
        try:
            resp = self._http.post(gateway_url(), headers=gateway_headers(), json=payload)  # type: ignore[arg-type]
        except httpx.HTTPError as exc:
            raise GatewayError(type(exc).__name__) from exc
        if resp.status_code == 429:
            raise GatewayRateLimitError("rate limited")
        if resp.status_code >= 400:
            raise GatewayError(f"HTTP {resp.status_code}")
        try:
            return _parse_response(resp.json())
        except (ValueError, AttributeError, IndexError, TypeError) as exc:
            raise GatewayError("malformed response") from exc


_client: Optional[GatewayClient] = None


def get_gateway_client() -> Optional[GatewayClient]:
    """Return the shared client, or None when the gateway is not configured."""
    global _client
    if not ai_configured():
        return None
    if _client is None:
        _client = GatewayClient()
    return _client


# ---------------------------------------------------------------------------
# Breaker-guarded call
# ---------------------------------------------------------------------------


def call_ai(
    *,
    model: Optional[str] = None,
    max_tokens: int,
    system: Optional[str] = None,
    messages: list[dict[str, Any]],
    tools: Optional[list[dict[str, Any]]] = None,
) -> tuple[AIResponse | None, ErrorKind | None]:
    """Call the model once through the gateway, guarded by ``ai_breaker``.

    Returns ``(response, None)`` on success. On failure returns
    ``(None, kind)``:

    - ``"no_client"`` — gateway not configured (breaker untouched)
    - ``"circuit_open"`` — breaker is open, the model was not called (untouched)
    - ``"rate_limited"`` — HTTP 429 from the gateway (breaker failure recorded)
    - ``"api_error"`` — any other HTTP/transport error, malformed response or
      unexpected exception (breaker failure recorded)
    """
    client = get_gateway_client()
    if client is None:
        return None, "no_client"
    if not ai_breaker.is_allowed:
        return None, "circuit_open"

    kwargs: dict[str, Any] = {"model": model, "max_tokens": max_tokens, "messages": messages}
    if system is not None:
        kwargs["system"] = system
    if tools is not None:
        kwargs["tools"] = tools

    try:
        response = client.create(**kwargs)
    except GatewayRateLimitError:
        ai_breaker.record_failure()
        return None, "rate_limited"
    except GatewayError as exc:
        logger.warning("AI gateway call failed: %s", exc)
        ai_breaker.record_failure()
        return None, "api_error"
    except Exception as exc:  # noqa: BLE001 — breaker must still see the failure
        logger.warning("Unexpected AI gateway failure: %s", type(exc).__name__)
        ai_breaker.record_failure()
        return None, "api_error"

    ai_breaker.record_success()
    return response, None


def first_text(response: Any) -> str:
    """Return the response text, or "" if there is none."""
    return (getattr(response, "text", "") or "") if response is not None else ""
