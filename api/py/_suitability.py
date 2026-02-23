"""
Suitability rules endpoint — migrated from /api/suitability.

Returns suitability rules from MongoDB for client-side activity
evaluation in ActivityInsights.
"""

from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from ._db import suitability_rules_collection

router = APIRouter()

KEY_RE = re.compile(r"^(activity|category):[a-z0-9-]+$")


@router.get("/api/py/suitability")
async def get_suitability(key: str | None = None):
    """
    GET /api/py/suitability
    GET /api/py/suitability?key=activity:drone-flying

    Returns all suitability rules or a single rule by key.
    Rules change only on deployment (via db-init), so edge-cache aggressively.
    """
    cache_headers = {"Cache-Control": "s-maxage=300, stale-while-revalidate=60"}

    try:
        if key:
            if not KEY_RE.match(key):
                raise HTTPException(status_code=400, detail="Invalid key format")

            rule = suitability_rules_collection().find_one(
                {"key": key}, {"_id": 0}
            )
            if not rule:
                raise HTTPException(status_code=404, detail="Rule not found")

            return JSONResponse(content={"rule": rule}, headers=cache_headers)

        rules = list(suitability_rules_collection().find({}, {"_id": 0}))
        return JSONResponse(content={"rules": rules}, headers=cache_headers)
    except HTTPException:
        raise
    except Exception:
        return JSONResponse(
            content={"rules": []},
            headers={"Cache-Control": "s-maxage=10, stale-while-revalidate=5"},
        )
