"""
Shared AI plumbing for the Python backend — every model call goes to the
weather AI Worker; this backend holds no Cloudflare AI token.

``POST {WEATHER_SERVICE_URL}/internal/ai/chat/completions`` on
``mukoko-weather-internal`` (``Authorization: Bearer WEATHER_SERVICE_API_KEY``,
the same service key the Nyuchi API uses there). That Worker forwards the
call over a service binding to ``mukoko-weather-ai``, which runs it on a
Workers AI GLM model through the ``shamwari`` AI Gateway with the native
``env.AI`` binding — no token anywhere — with the Nyuchi guardrails first in
the system prompt. The wire format is OpenAI chat completions (``messages``,
``tools``, ``max_tokens``), so the tool loops in ``_chat.py`` and
``_explore_search.py`` work unchanged. The Worker returns the model's
``content`` only, never its reasoning, and adds reasoning headroom to the
token budget itself.

Configuration (names only, never values):

- ``WEATHER_AI_URL`` — optional full URL of the chat-completions route (or a
  base, to which ``/internal/ai/chat/completions`` is added). Wins over
  ``WEATHER_SERVICE_URL``.
- ``WEATHER_SERVICE_URL`` — the internal Worker's origin,
  ``https://weather-internal.mukoko.com``.
- ``WEATHER_SERVICE_API_KEY`` — the service key.

- :func:`gateway_url` — the chat-completions URL, built from env.
- :func:`gateway_headers` — request headers (``Authorization: Bearer``).
- :func:`resolve_model` — a ``@cf/`` model a DB prompt names, or None (the
  Worker's ``AI_MODEL`` then decides). Legacy ``claude-*`` ids give None.
- :func:`get_gateway_client` — module-level :class:`GatewayClient`, or None
  when the env is incomplete.
- :func:`call_ai` — one breaker-guarded chat-completions call. Returns
  ``(AIResponse, None)`` on success or ``(None, error_kind)`` on failure and
  records breaker success/failure itself, so callers never double-record.
- :func:`first_text` — the response's text ("" when none).
- :func:`function_tools` / :func:`tool_result_message` — OpenAI-style tool
  definitions and tool-result messages for the tool-use loops.

When the env is incomplete, a warning is logged and calls return
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

# The gateway the Worker routes through (reported by the status page only).
DEFAULT_GATEWAY_ID = "shamwari"
COMPLETIONS_PATH = "/internal/ai/chat/completions"
# Under _chat.py's 30 s per-call guard. GLM reasons first; the Worker asks
# for low reasoning effort to keep calls short.
REQUEST_TIMEOUT_S = 25.0

URL_ENV = "WEATHER_AI_URL"
SERVICE_URL_ENV = "WEATHER_SERVICE_URL"
KEY_ENV = "WEATHER_SERVICE_API_KEY"

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def gateway_url() -> Optional[str]:
    """Return the Worker's chat-completions URL, or None when unconfigured.

    ``WEATHER_AI_URL`` (a full URL ending in ``/chat/completions``, or a base)
    wins; otherwise ``WEATHER_SERVICE_URL`` + ``/internal/ai/chat/completions``.
    """
    override = _env(URL_ENV).rstrip("/")
    if override:
        if override.endswith("/chat/completions"):
            return override
        return f"{override}{COMPLETIONS_PATH}"
    base = _env(SERVICE_URL_ENV).rstrip("/")
    if not base:
        return None
    return f"{base}{COMPLETIONS_PATH}"


def service_key() -> str:
    """The service key for ``mukoko-weather-internal``."""
    return _env(KEY_ENV)


def gateway_headers() -> dict[str, str]:
    """Headers for a Worker request: the service key as a bearer token."""
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    key = service_key()
    if key:
        headers["Authorization"] = f"Bearer {key}"
    return headers


_warned_unconfigured = False


def missing_ai_config() -> list[str]:
    """Names (never values) of the AI Worker config that is missing."""
    missing = []
    if gateway_url() is None:
        missing.append(f"{SERVICE_URL_ENV} (or {URL_ENV})")
    if not service_key():
        missing.append(KEY_ENV)
    return missing


def ai_configured() -> bool:
    """True when the Worker URL and the service key are set.

    Logs one warning per process when they are not, so a missing config shows
    up in the logs while the endpoints quietly use their fallbacks.
    """
    global _warned_unconfigured
    missing = missing_ai_config()
    if missing:
        if not _warned_unconfigured:
            logger.warning(
                "AI Worker not configured (missing %s) — AI endpoints use fallbacks",
                ", ".join(missing),
            )
            _warned_unconfigured = True
        return False
    return True


def resolve_model(requested: Optional[str] = None) -> Optional[str]:
    """The model id to ask the Worker for, or None for the Worker's own.

    The Worker owns the model (its ``AI_MODEL`` var) and only accepts
    Workers AI ``@cf/`` ids. A DB prompt may still name one; a legacy
    ``claude-*`` id (or anything not ``@cf/``) gives None. The Unified API's
    ``workers-ai/`` provider prefix is dropped.
    """
    model = (requested or "").strip()
    if model.startswith("workers-ai/"):
        model = model[len("workers-ai/"):]
    return model if model.startswith("@cf/") else None


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
    """Any non-429 Worker/transport failure or malformed response."""


class GatewayRateLimitError(GatewayError):
    """HTTP 429 from the Worker (the gateway's or the model's rate limit)."""


class GatewayRequestError(GatewayError):
    """HTTP 400/413/422: this request was refused (bad shape, personal data,
    a guardrails block). The Worker is healthy, so the breaker is not told."""


class GatewayClient:
    """Thin chat-completions client for the weather AI Worker."""

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
            "max_tokens": max_tokens,
            "messages": ([{"role": "system", "content": system}] if system else []) + list(messages),
        }
        chosen = resolve_model(model)
        if chosen:
            payload["model"] = chosen
        if tools:
            payload["tools"] = tools
        try:
            resp = self._http.post(gateway_url(), headers=gateway_headers(), json=payload)  # type: ignore[arg-type]
        except httpx.HTTPError as exc:
            raise GatewayError(type(exc).__name__) from exc
        if resp.status_code == 429:
            raise GatewayRateLimitError("rate limited")
        if resp.status_code in (400, 413, 422):
            raise GatewayRequestError(f"HTTP {resp.status_code} {_error_code(resp)}")
        if resp.status_code >= 400:
            raise GatewayError(f"HTTP {resp.status_code}")
        try:
            return _parse_response(resp.json())
        except (ValueError, AttributeError, IndexError, TypeError) as exc:
            raise GatewayError("malformed response") from exc


def _error_code(resp: httpx.Response) -> str:
    """The Worker's error code (``personal_data_detected``…), never content."""
    try:
        code = resp.json().get("error")
    except (ValueError, AttributeError):
        return ""
    return code if isinstance(code, str) and code.replace("_", "").isalnum() else ""


_client: Optional[GatewayClient] = None


def get_gateway_client() -> Optional[GatewayClient]:
    """Return the shared client, or None when the AI Worker is not configured."""
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
    """Call the model once through the AI Worker, guarded by ``ai_breaker``.

    Returns ``(response, None)`` on success. On failure returns
    ``(None, kind)``:

    - ``"no_client"`` — AI Worker not configured (breaker untouched)
    - ``"circuit_open"`` — breaker is open, the model was not called (untouched)
    - ``"rate_limited"`` — HTTP 429 (breaker failure recorded)
    - ``"api_error"`` — the request was refused (400/413/422: breaker
      untouched, the Worker is healthy), or any other HTTP/transport error,
      malformed response or unexpected exception (breaker failure recorded)
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
    except GatewayRequestError as exc:
        logger.info("AI Worker refused the request: %s", exc)
        return None, "api_error"
    except GatewayError as exc:
        logger.warning("AI Worker call failed: %s", exc)
        ai_breaker.record_failure()
        return None, "api_error"
    except Exception as exc:  # noqa: BLE001 — breaker must still see the failure
        logger.warning("Unexpected AI Worker failure: %s", type(exc).__name__)
        ai_breaker.record_failure()
        return None, "api_error"

    ai_breaker.record_success()
    return response, None


def first_text(response: Any) -> str:
    """Return the response text, or "" if there is none."""
    return (getattr(response, "text", "") or "") if response is not None else ""
