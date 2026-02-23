"""
Status endpoint — migrated from /api/status.

Live system health dashboard checks.
"""

from __future__ import annotations

import os
import time
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter

from ._db import get_db, get_api_key

router = APIRouter()


def _check_mongodb() -> dict:
    start = time.time()
    try:
        get_db().command("ping")
        return {
            "name": "MongoDB Atlas",
            "status": "operational",
            "latencyMs": round((time.time() - start) * 1000),
            "message": "Connected and responding",
        }
    except Exception as e:
        return {
            "name": "MongoDB Atlas",
            "status": "down",
            "latencyMs": round((time.time() - start) * 1000),
            "message": str(e)[:200],
        }


def _check_tomorrow_io() -> dict:
    start = time.time()
    try:
        try:
            api_key = get_api_key("tomorrow")
        except Exception as e:
            return {
                "name": "Tomorrow.io API",
                "status": "degraded",
                "latencyMs": round((time.time() - start) * 1000),
                "message": f"Cannot retrieve API key — MongoDB unavailable ({str(e)[:100]})",
            }

        if not api_key:
            return {
                "name": "Tomorrow.io API",
                "status": "degraded",
                "latencyMs": round((time.time() - start) * 1000),
                "message": "API key not configured in database — run POST /api/py/db-init with apiKeys.tomorrow to seed it. Using Open-Meteo fallback.",
            }

        with httpx.Client(timeout=10.0) as client:
            resp = client.get(
                "https://api.tomorrow.io/v4/weather/realtime",
                params={"location": "-17.83,31.05", "apikey": api_key},
            )

        if resp.status_code == 429:
            return {
                "name": "Tomorrow.io API",
                "status": "degraded",
                "latencyMs": round((time.time() - start) * 1000),
                "message": "Rate limited (429) — falling back to Open-Meteo",
            }

        if resp.status_code != 200:
            return {
                "name": "Tomorrow.io API",
                "status": "down",
                "latencyMs": round((time.time() - start) * 1000),
                "message": f"HTTP {resp.status_code}: {resp.reason_phrase}",
            }

        return {
            "name": "Tomorrow.io API",
            "status": "operational",
            "latencyMs": round((time.time() - start) * 1000),
            "message": "Responding normally",
        }
    except Exception as e:
        return {
            "name": "Tomorrow.io API",
            "status": "down",
            "latencyMs": round((time.time() - start) * 1000),
            "message": str(e)[:200],
        }


def _check_open_meteo() -> dict:
    start = time.time()
    try:
        with httpx.Client(timeout=10.0) as client:
            resp = client.get(
                "https://api.open-meteo.com/v1/forecast",
                params={"latitude": "-17.83", "longitude": "31.05", "current": "temperature_2m"},
            )

        if resp.status_code != 200:
            return {
                "name": "Open-Meteo API",
                "status": "down",
                "latencyMs": round((time.time() - start) * 1000),
                "message": f"HTTP {resp.status_code}: {resp.reason_phrase}",
            }

        data = resp.json()
        if data.get("current", {}).get("temperature_2m") is None:
            return {
                "name": "Open-Meteo API",
                "status": "degraded",
                "latencyMs": round((time.time() - start) * 1000),
                "message": "Response received but missing expected data",
            }

        return {
            "name": "Open-Meteo API",
            "status": "operational",
            "latencyMs": round((time.time() - start) * 1000),
            "message": "Responding normally",
        }
    except Exception as e:
        return {
            "name": "Open-Meteo API",
            "status": "down",
            "latencyMs": round((time.time() - start) * 1000),
            "message": str(e)[:200],
        }


def _check_anthropic() -> dict:
    start = time.time()
    api_key = os.environ.get("ANTHROPIC_API_KEY")

    if not api_key:
        try:
            api_key = get_api_key("anthropic")
        except Exception:
            pass

    if not api_key:
        return {
            "name": "Anthropic AI (Shamwari)",
            "status": "degraded",
            "latencyMs": round((time.time() - start) * 1000),
            "message": "API key not configured — basic summary fallback active",
        }

    try:
        with httpx.Client(timeout=15.0) as client:
            resp = client.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json={
                    "model": "claude-sonnet-4-20250514",
                    "max_tokens": 1,
                    "messages": [{"role": "user", "content": "ping"}],
                },
            )

        if resp.status_code == 401:
            return {
                "name": "Anthropic AI (Shamwari)",
                "status": "down",
                "latencyMs": round((time.time() - start) * 1000),
                "message": "Invalid API key",
            }

        if resp.status_code == 429:
            return {
                "name": "Anthropic AI (Shamwari)",
                "status": "degraded",
                "latencyMs": round((time.time() - start) * 1000),
                "message": "Rate limited — AI summaries may be delayed",
            }

        if 200 <= resp.status_code < 300:
            return {
                "name": "Anthropic AI (Shamwari)",
                "status": "operational",
                "latencyMs": round((time.time() - start) * 1000),
                "message": "Responding normally",
            }

        return {
            "name": "Anthropic AI (Shamwari)",
            "status": "degraded",
            "latencyMs": round((time.time() - start) * 1000),
            "message": f"HTTP {resp.status_code}",
        }
    except Exception as e:
        return {
            "name": "Anthropic AI (Shamwari)",
            "status": "down",
            "latencyMs": round((time.time() - start) * 1000),
            "message": str(e)[:200],
        }


def _check_weather_cache() -> dict:
    start = time.time()
    try:
        db = get_db()
        count = db["weather_cache"].count_documents(
            {"expiresAt": {"$gt": datetime.now(timezone.utc)}}
        )
        return {
            "name": "Weather Cache",
            "status": "operational" if count > 0 else "degraded",
            "latencyMs": round((time.time() - start) * 1000),
            "message": (
                f"{count} active cached location{'s' if count != 1 else ''}"
                if count > 0
                else "Cache is empty — next requests will fetch fresh data"
            ),
        }
    except Exception as e:
        return {
            "name": "Weather Cache",
            "status": "down",
            "latencyMs": round((time.time() - start) * 1000),
            "message": str(e)[:200],
        }


def _check_ai_cache() -> dict:
    start = time.time()
    try:
        db = get_db()
        count = db["ai_summaries"].count_documents(
            {"expiresAt": {"$gt": datetime.now(timezone.utc)}}
        )
        return {
            "name": "AI Summary Cache",
            "status": "operational" if count > 0 else "degraded",
            "latencyMs": round((time.time() - start) * 1000),
            "message": (
                f"{count} active cached summar{'ies' if count != 1 else 'y'}"
                if count > 0
                else "Cache is empty — next requests will generate fresh summaries"
            ),
        }
    except Exception as e:
        return {
            "name": "AI Summary Cache",
            "status": "down",
            "latencyMs": round((time.time() - start) * 1000),
            "message": str(e)[:200],
        }


@router.get("/api/py/status")
async def system_status():
    """GET /api/py/status — Live system health checks."""
    start = time.time()

    checks = [
        _check_mongodb(),
        _check_tomorrow_io(),
        _check_open_meteo(),
        _check_anthropic(),
        _check_weather_cache(),
        _check_ai_cache(),
    ]

    overall = "operational"
    if any(c["status"] == "down" for c in checks):
        overall = "degraded"
    elif any(c["status"] == "degraded" for c in checks):
        overall = "degraded"

    return {
        "status": overall,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "totalLatencyMs": round((time.time() - start) * 1000),
        "checks": checks,
    }
