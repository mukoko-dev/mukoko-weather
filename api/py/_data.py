"""
Data endpoints — migrated from /api/activities, /api/tags, /api/regions.

Serves activities, tags, and regions from MongoDB.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from ._db import (
    get_db,
    activities_collection,
    tags_collection,
)

router = APIRouter()


# ---------------------------------------------------------------------------
# /api/py/activities
# ---------------------------------------------------------------------------


@router.get("/api/py/activities")
async def get_activities(
    id: str | None = None,
    category: str | None = None,
    q: str | None = None,
    labels: str | None = None,
    mode: str | None = None,
):
    """
    GET /api/py/activities
    GET /api/py/activities?id=running
    GET /api/py/activities?category=farming
    GET /api/py/activities?q=cycling
    GET /api/py/activities?labels=running,cycling
    GET /api/py/activities?mode=categories
    """
    try:
        coll = activities_collection()
        db = get_db()

        # Categories mode
        if mode == "categories":
            categories = list(db["activity_categories"].find({}, {"_id": 0}))
            return {"categories": categories}

        # Single by ID
        if id:
            activity = coll.find_one({"id": id}, {"_id": 0})
            if not activity:
                raise HTTPException(status_code=404, detail="Activity not found")
            return {"activity": activity}

        # Label lookup
        if labels:
            ids = [s.strip() for s in labels.split(",") if s.strip()]
            docs = list(coll.find({"id": {"$in": ids}}, {"id": 1, "label": 1, "_id": 0}))
            result = {d["id"]: d["label"] for d in docs}
            return {"labels": result}

        # Text search
        if q:
            query_str = q.strip()[:200]
            try:
                docs = list(
                    coll.find(
                        {"$text": {"$search": query_str}},
                        {"_id": 0, "score": {"$meta": "textScore"}},
                    )
                    .sort([("score", {"$meta": "textScore"})])
                    .limit(20)
                )
                for d in docs:
                    d.pop("score", None)
            except Exception:
                # Fallback: regex search
                docs = list(
                    coll.find(
                        {"label": {"$regex": query_str, "$options": "i"}},
                        {"_id": 0},
                    ).limit(20)
                )
            return {"activities": docs, "total": len(docs)}

        # Filter by category
        if category:
            docs = list(coll.find({"category": category}, {"_id": 0}).sort("label", 1))
            return {"activities": docs, "total": len(docs)}

        # All activities
        docs = list(coll.find({}, {"_id": 0}).sort([("category", 1), ("label", 1)]))
        return {"activities": docs, "total": len(docs)}
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=503, detail="Activity data unavailable")


# ---------------------------------------------------------------------------
# /api/py/tags
# ---------------------------------------------------------------------------


@router.get("/api/py/tags")
async def get_tags(featured: bool = False):
    """
    GET /api/py/tags
    GET /api/py/tags?featured=true
    """
    try:
        coll = tags_collection()
        query: dict = {}
        if featured:
            query["featured"] = True

        tags = list(coll.find(query, {"_id": 0}).sort("slug", 1))
        return JSONResponse(
            content={"tags": tags},
            headers={"Cache-Control": "public, max-age=3600, stale-while-revalidate=86400"},
        )
    except Exception:
        raise HTTPException(status_code=500, detail="Failed to fetch tags")


# ---------------------------------------------------------------------------
# /api/py/regions
# ---------------------------------------------------------------------------


@router.get("/api/py/regions")
async def get_regions():
    """GET /api/py/regions — Active supported regions."""
    try:
        db = get_db()
        regions = list(db["regions"].find({"active": True}, {"_id": 0}))
        return JSONResponse(
            content={"regions": regions},
            headers={"Cache-Control": "public, max-age=3600, stale-while-revalidate=86400"},
        )
    except Exception:
        raise HTTPException(status_code=500, detail="Failed to fetch regions")
