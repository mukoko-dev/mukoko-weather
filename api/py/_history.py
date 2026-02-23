"""
History endpoint — migrated from /api/history.

Returns historical weather recordings for a given location.
"""

from __future__ import annotations

from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, HTTPException

from ._db import get_db, locations_collection

router = APIRouter()


@router.get("/api/py/history")
async def get_history(location: str, days: int = 30):
    """
    GET /api/py/history?location=harare&days=30

    Returns historical weather recordings for a location.
    Data is recorded automatically by the weather endpoint on fresh fetches.
    """
    if not location:
        raise HTTPException(status_code=400, detail="Missing location parameter")

    if days < 1 or days > 365:
        raise HTTPException(status_code=400, detail="days must be between 1 and 365")

    # Verify location exists
    try:
        loc = locations_collection().find_one({"slug": location}, {"_id": 0, "slug": 1})
    except Exception:
        raise HTTPException(status_code=503, detail="Location service unavailable")

    if not loc:
        raise HTTPException(status_code=404, detail="Unknown location")

    try:
        db = get_db()
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)

        history = list(
            db["weather_history"]
            .find(
                {
                    "locationSlug": location,
                    "recordedAt": {"$gte": cutoff},
                },
                {"_id": 0},
            )
            .sort("recordedAt", -1)
        )

        # Serialize datetime objects
        for record in history:
            if "recordedAt" in record and isinstance(record["recordedAt"], datetime):
                record["recordedAt"] = record["recordedAt"].isoformat()

        return {
            "location": location,
            "days": days,
            "records": len(history),
            "data": history,
        }
    except Exception:
        raise HTTPException(status_code=502, detail="Failed to fetch weather history")
