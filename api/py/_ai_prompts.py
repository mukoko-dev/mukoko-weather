"""
AI Prompts endpoint — serves database-driven AI configuration.

All AI-related configuration (system prompts, suggested prompt rules,
chat greetings, clarification templates) is stored in MongoDB and served
via this endpoint. This allows updating AI behaviour without code changes.
"""

from __future__ import annotations

import time
from typing import Optional

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ._db import ai_prompts_collection, ai_suggested_rules_collection

router = APIRouter()

# ---------------------------------------------------------------------------
# Module-level cache (persists across warm Vercel invocations)
# ---------------------------------------------------------------------------

_prompts_cache: Optional[list[dict]] = None
_prompts_cache_at: float = 0

_suggested_cache: Optional[list[dict]] = None
_suggested_cache_at: float = 0

CACHE_TTL = 300  # 5 minutes


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/api/py/ai/prompts")
async def get_prompts(key: str | None = None):
    """
    GET /api/py/ai/prompts          — all active prompts
    GET /api/py/ai/prompts?key=system:summary — single prompt by key
    """
    global _prompts_cache, _prompts_cache_at

    try:
        # Single prompt by key
        if key:
            doc = ai_prompts_collection().find_one(
                {"promptKey": key, "active": True},
                {"_id": 0, "updatedAt": 0},
            )
            if not doc:
                return JSONResponse(
                    content={"prompt": None},
                    headers={"Cache-Control": "public, max-age=60"},
                )
            return JSONResponse(
                content={"prompt": doc},
                headers={"Cache-Control": "public, max-age=300"},
            )

        # All active prompts (cached)
        now = time.time()
        if _prompts_cache and (now - _prompts_cache_at) < CACHE_TTL:
            return JSONResponse(
                content={"prompts": _prompts_cache},
                headers={"Cache-Control": "public, max-age=300"},
            )

        docs = list(
            ai_prompts_collection()
            .find({"active": True}, {"_id": 0, "updatedAt": 0})
            .sort("order", 1)
        )
        _prompts_cache = docs
        _prompts_cache_at = now

        return JSONResponse(
            content={"prompts": docs},
            headers={"Cache-Control": "public, max-age=300"},
        )
    except Exception:
        # Return empty on error — callers should fall back to hardcoded defaults
        return JSONResponse(
            content={"prompts": _prompts_cache or [], "error": "Database unavailable"},
            status_code=200,  # Don't fail the page — degrade gracefully
        )


@router.get("/api/py/ai/suggested-rules")
async def get_suggested_rules():
    """
    GET /api/py/ai/suggested-rules — all active suggested prompt rules

    Returns rules sorted by category priority (weather > activity > generic)
    then by order within each category.
    """
    global _suggested_cache, _suggested_cache_at

    try:
        now = time.time()
        if _suggested_cache and (now - _suggested_cache_at) < CACHE_TTL:
            return JSONResponse(
                content={"rules": _suggested_cache},
                headers={"Cache-Control": "public, max-age=300"},
            )

        docs = list(
            ai_suggested_rules_collection()
            .find({"active": True}, {"_id": 0, "updatedAt": 0})
            .sort([("order", 1)])
        )
        _suggested_cache = docs
        _suggested_cache_at = now

        return JSONResponse(
            content={"rules": docs},
            headers={"Cache-Control": "public, max-age=300"},
        )
    except Exception:
        return JSONResponse(
            content={"rules": _suggested_cache or [], "error": "Database unavailable"},
            status_code=200,
        )
