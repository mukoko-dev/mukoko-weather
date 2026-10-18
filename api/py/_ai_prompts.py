"""
AI prompt loader for the Python AI callers.

The ``/api/py/ai/prompts`` and ``/api/py/ai/suggested-rules`` routes moved to
the Rust Workers (``/v1/ai/prompts`` and ``/v1/ai/suggested-rules``, served
from the seed files in ``workers/crates/weather-core/data/reference/``). What
stays here is ``get_ai_prompt``, which the AI modules still not ported use to
read a prompt template from MongoDB. It goes with them.
"""

from __future__ import annotations

import time

from ._db import ai_prompts_collection

CACHE_TTL = 300  # 5 minutes

# Snapshot of every active prompt doc, keyed by promptKey (shared by all
# AI-backed modules through get_ai_prompt).
_prompt_doc_cache: dict[str, dict] = {}
_prompt_doc_cache_at: float = 0


def get_ai_prompt(prompt_key: str) -> dict | None:
    """Return the active ``ai_prompts`` doc for ``prompt_key``, or None.

    One 5-minute module cache covers every prompt. On a DB error the last
    snapshot (possibly empty) is served, so callers fall back to their
    hardcoded prompt rather than failing the request.
    """
    global _prompt_doc_cache, _prompt_doc_cache_at

    now = time.time()
    if _prompt_doc_cache_at and (now - _prompt_doc_cache_at) < CACHE_TTL:
        return _prompt_doc_cache.get(prompt_key)

    try:
        docs = list(
            ai_prompts_collection()
            .find({"active": True}, {"_id": 0, "updatedAt": 0})
        )
        _prompt_doc_cache = {d["promptKey"]: d for d in docs}
        _prompt_doc_cache_at = now
    except Exception:
        pass
    return _prompt_doc_cache.get(prompt_key)
