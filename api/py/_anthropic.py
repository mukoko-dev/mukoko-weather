"""
Shared Anthropic plumbing for the Python backend.

Every Claude-backed endpoint goes through here so the client singleton, the
circuit-breaker bookkeeping and the error taxonomy live in exactly one place:

- :func:`get_anthropic_client` — module-level client, rebuilt when the API key
  changes (compared by SHA-256 hash, never kept raw in a second global).
- :func:`call_claude` — one breaker-guarded ``messages.create`` call. Returns
  ``(response, None)`` on success or ``(None, error_kind)`` on failure and
  records breaker success/failure itself, so callers never double-record.
- :func:`first_text` — the first text block of a response ("" when none).

Callers keep their own fallback copy and HTTP status mapping; this module only
reports *what* went wrong.
"""

from __future__ import annotations

import hashlib
import logging
import os
from typing import Any, Literal, Optional

import anthropic
from fastapi import HTTPException

from ._circuit_breaker import anthropic_breaker
from ._db import get_api_key

logger = logging.getLogger(__name__)

ErrorKind = Literal["no_client", "circuit_open", "rate_limited", "api_error"]

# ---------------------------------------------------------------------------
# Module-level singleton client (persists across warm Vercel invocations)
# ---------------------------------------------------------------------------

_client: Optional[anthropic.Anthropic] = None
_client_key_hash: Optional[str] = None


def get_anthropic_client(required: bool = False) -> Optional[anthropic.Anthropic]:
    """Return the shared Anthropic client, or None when no key is configured.

    The key comes from ``ANTHROPIC_API_KEY`` and falls back to the ``api_keys``
    collection. With ``required=True`` a missing key raises HTTPException(503)
    instead of returning None.
    """
    global _client, _client_key_hash

    key = os.environ.get("ANTHROPIC_API_KEY") or get_api_key("anthropic")
    if not key:
        if required:
            raise HTTPException(status_code=503, detail="AI service unavailable")
        return None

    key_hash = hashlib.sha256(key.encode()).hexdigest()
    if _client is None or _client_key_hash != key_hash:
        _client = anthropic.Anthropic(api_key=key)
        _client_key_hash = key_hash

    return _client


# ---------------------------------------------------------------------------
# Breaker-guarded call
# ---------------------------------------------------------------------------


def call_claude(
    *,
    model: str,
    max_tokens: int,
    system: Optional[str] = None,
    messages: list[dict[str, Any]],
    tools: Optional[list[dict[str, Any]]] = None,
) -> tuple[Any | None, ErrorKind | None]:
    """Call Claude once, guarded by ``anthropic_breaker``.

    Returns ``(response, None)`` on success. On failure returns
    ``(None, kind)``:

    - ``"no_client"`` — no API key configured (breaker untouched)
    - ``"circuit_open"`` — breaker is open, Claude was not called (untouched)
    - ``"rate_limited"`` — Anthropic 429 (breaker failure recorded)
    - ``"api_error"`` — any other Anthropic error, or an unexpected exception
      (breaker failure recorded)
    """
    client = get_anthropic_client()
    if client is None:
        return None, "no_client"
    if not anthropic_breaker.is_allowed:
        return None, "circuit_open"

    kwargs: dict[str, Any] = {"model": model, "max_tokens": max_tokens, "messages": messages}
    if system is not None:
        kwargs["system"] = system
    if tools is not None:
        kwargs["tools"] = tools

    try:
        response = client.messages.create(**kwargs)
    except anthropic.RateLimitError:
        anthropic_breaker.record_failure()
        return None, "rate_limited"
    except anthropic.APIError:
        anthropic_breaker.record_failure()
        return None, "api_error"
    except Exception as exc:  # noqa: BLE001 — breaker must still see the failure
        logger.warning("Unexpected Claude call failure: %s", type(exc).__name__)
        anthropic_breaker.record_failure()
        return None, "api_error"

    anthropic_breaker.record_success()
    return response, None


def first_text(response: Any) -> str:
    """Return the first text block of a Claude response, or "" if there is none."""
    block = next((b for b in response.content if b.type == "text"), None)
    return block.text if block is not None else ""
