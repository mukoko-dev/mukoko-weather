"""
mukoko weather — Python API service (full backend migration).

All data handling, AI operations, database operations, and rule evaluation
run in Python. Next.js serves as the app/presentation layer only.

Runs as Vercel Python serverless functions. All /api/py/* requests are
routed here via vercel.json rewrites.
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pymongo.errors import ConnectionFailure

from ._devices import router as devices_router
from ._chat import router as chat_router
from ._suitability import router as suitability_router
from ._embeddings import router as embeddings_router
from ._weather import router as weather_router
from ._ai import router as ai_router
from ._locations import router as locations_router
from ._data import router as data_router
from ._history import router as history_router
from ._status import router as status_router
from ._tiles import router as tiles_router
from ._ai_prompts import router as ai_prompts_router
from ._ai_followup import router as ai_followup_router
from ._history_analyze import router as history_analyze_router
from ._explore_search import router as explore_search_router
from ._reports import router as reports_router
from ._db import get_db

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(
    title="mukoko weather — Python API",
    version="3.0.0",
    docs_url=None,
    redoc_url=None,
)

_ALLOWED_ORIGINS = [
    "https://weather.mukoko.com",
    "http://localhost:3000",  # local dev
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_methods=["GET", "POST", "PATCH", "OPTIONS"],
    allow_headers=["Content-Type"],
)

# ---------------------------------------------------------------------------
# Mount routers
# ---------------------------------------------------------------------------

app.include_router(devices_router)
app.include_router(chat_router)
app.include_router(suitability_router)
app.include_router(embeddings_router)
app.include_router(weather_router)
app.include_router(ai_router)
app.include_router(locations_router)
app.include_router(data_router)
app.include_router(history_router)
app.include_router(status_router)
app.include_router(tiles_router)
app.include_router(ai_prompts_router)
app.include_router(ai_followup_router)
app.include_router(history_analyze_router)
app.include_router(explore_search_router)
app.include_router(reports_router)


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------


@app.get("/api/py/health")
async def health():
    """Health check — verifies MongoDB + Anthropic availability."""
    import os

    mongo_ok = False
    anthropic_ok = False

    try:
        get_db().command("ping")
        mongo_ok = True
    except Exception:
        pass

    anthropic_key = os.environ.get("ANTHROPIC_API_KEY")
    if not anthropic_key:
        # Try MongoDB-stored key
        from ._db import get_api_key
        anthropic_key = get_api_key("anthropic") if mongo_ok else None

    anthropic_ok = bool(anthropic_key)

    status = "ok" if mongo_ok and anthropic_ok else "degraded"
    return {
        "status": status,
        "service": "mukoko-weather-py",
        "version": "3.0.0",
        "database": "connected" if mongo_ok else "unavailable",
        "anthropic": "available" if anthropic_ok else "unavailable",
    }


# ---------------------------------------------------------------------------
# Error handlers
# ---------------------------------------------------------------------------


@app.exception_handler(ConnectionFailure)
async def mongo_connection_error(request: Request, exc: ConnectionFailure):
    return JSONResponse(
        status_code=503,
        content={"detail": "Database temporarily unavailable"},
    )
