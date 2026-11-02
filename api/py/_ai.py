"""
Season helpers, the last of the Python AI summary module.

The weather summary itself (``POST /api/py/ai``) is gone: it runs on the Rust
AI Worker (``workers/ai``, ``weather_core::ai``), pinned to this module's
prompt, cache tiers and fallback text by ``tests/fixtures/ai-summary.json``,
which ``scripts/gen_ai_summary_fixtures.py`` produced from the original code.

What stays is what two modules not yet ported still import:

- ``_get_season`` (``_history_analyze.py``);
- ``_resolve_seasons_with_ai`` (``_locations.py``'s creation hook).

Delete this file with them (#333).
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone, timedelta

from ._db import get_db
from ._ai_gateway import call_ai, first_text

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Season lookup
# ---------------------------------------------------------------------------


_COUNTRY_CODE_RE = re.compile(r"^[A-Z]{2,3}$")


def _resolve_seasons_with_ai(
    country_code: str,
    lat: float = 0.0,
    lon: float = 0.0,
) -> list[dict] | None:
    """Use AI to generate season definitions for a country not in the seed data.

    Calls the AI model to produce a structured seasonal calendar, validates the
    response, and stores the result in MongoDB for future lookups. Returns the
    list of season docs on success, or None if AI is unavailable/invalid.
    """
    # Validate ISO 3166-1 alpha-2/alpha-3 format to prevent prompt injection
    if not _COUNTRY_CODE_RE.match(country_code.upper()):
        logger.warning("Invalid country code rejected: %r", country_code[:20])
        return None

    # --- AI gateway call (breaker bookkeeping lives in call_ai) ---
    response, err = call_ai(
        model=None,
        max_tokens=1024,
        messages=[{
            "role": "user",
            "content": (
                f"For country code {country_code} (representative coordinates "
                f"{lat:.1f}°, {lon:.1f}°), return the seasonal calendar as a JSON array.\n\n"
                "Each object must have:\n"
                '- "name": English season name (e.g. "Dry season", "Monsoon", "Summer")\n'
                '- "localName": Local language name (or English if unknown)\n'
                '- "months": Array of month numbers (1=Jan, 12=Dec) this season covers\n'
                '- "description": Brief typical weather for this season\n\n'
                "Rules:\n"
                "- Every month 1-12 must appear in exactly one season\n"
                "- Use culturally appropriate names for the region\n"
                "- Include local language names where known\n"
                "- Return ONLY the JSON array, no other text"
            ),
        }],
    )
    if err is not None:
        return None

    # --- Response parsing + validation (errors here are soft, not breaker) ---
    try:
        text = first_text(response).strip()
        # Extract JSON array from response
        if text.startswith("["):
            seasons_raw = json.loads(text)
        else:
            match = re.search(r"\[.*\]", text, re.DOTALL)
            if match:
                seasons_raw = json.loads(match.group())
            else:
                return None

        # Validate: every month 1-12 covered exactly once (no gaps, no overlaps)
        all_months: set[int] = set()
        total_month_count = 0
        hemisphere = "south" if lat < 0 else ("equatorial" if abs(lat) < 10 else "north")
        valid: list[dict] = []
        for s in seasons_raw:
            if not isinstance(s, dict):
                continue
            name = s.get("name", "")
            months = [m for m in s.get("months", []) if isinstance(m, int) and 1 <= m <= 12]
            if not name or not months:
                continue
            all_months.update(months)
            total_month_count += len(months)
            valid.append({
                "countryCode": country_code.upper(),
                "name": name[:100],
                "localName": s.get("localName", name)[:100],
                "months": months,
                "hemisphere": hemisphere,
                "description": s.get("description", "")[:500],
                "source": "ai",
            })

        # Reject if not all 12 months covered, or months overlap between seasons
        if len(all_months) != 12 or total_month_count != 12 or not valid:
            logger.warning("AI season resolution for %s: incomplete or overlapping month coverage", country_code)
            return None

        # Store in MongoDB for future lookups.
        # AI-generated seasons get verified=False and a 30-day TTL so they
        # expire and refresh automatically. Manually verified records
        # (verified=True) should omit expiresAt to persist permanently.
        expires_at = datetime.now(timezone.utc) + timedelta(days=30)
        try:
            db = get_db()
            for doc in valid:
                doc["verified"] = False
                doc["expiresAt"] = expires_at
                db["seasons"].update_one(
                    {"countryCode": doc["countryCode"], "name": doc["name"]},
                    {"$set": doc},
                    upsert=True,
                )
        except Exception:
            logger.warning("Failed to cache AI-generated seasons for %s", country_code)

        return valid

    except Exception:
        logger.warning("Season parsing/validation failed for %s", country_code)
        return None


def _hemisphere_fallback(lat: float) -> dict:
    """Last-resort hemisphere-based season when DB and AI are unavailable."""
    month = datetime.now(timezone.utc).month
    southern = lat < 0
    if southern:
        if month in (12, 1, 2):
            return {"name": "Summer", "localName": "Summer", "description": "Warm season with possible thunderstorms."}
        elif month in (3, 4, 5):
            return {"name": "Autumn", "localName": "Autumn", "description": "Cooling temperatures, harvest period."}
        elif month in (6, 7, 8):
            return {"name": "Winter", "localName": "Winter", "description": "Cool and dry with possible frost."}
        else:
            return {"name": "Spring", "localName": "Spring", "description": "Warming temperatures, early rains possible."}
    else:
        if month in (3, 4, 5):
            return {"name": "Spring", "localName": "Spring", "description": "Warming temperatures, new growth."}
        elif month in (6, 7, 8):
            return {"name": "Summer", "localName": "Summer", "description": "Warmest season with longer days."}
        elif month in (9, 10, 11):
            return {"name": "Autumn", "localName": "Autumn", "description": "Cooling temperatures, shorter days."}
        else:
            return {"name": "Winter", "localName": "Winter", "description": "Coldest season with shorter days."}


def _get_season(country: str = "", lat: float = 0.0, lon: float = 0.0) -> dict:
    """Look up the current season: DB → hemisphere fallback (+ background AI warm).

    Flow:
    1. Query MongoDB seasons collection by country code + current month
    2. If not found, return hemisphere fallback immediately and trigger
       background AI enrichment so the next request has DB data.

    AI resolution is never synchronous on the request path — it can add
    5-15s of latency which is unacceptable for the summary endpoint.
    """
    month = datetime.now(timezone.utc).month

    try:
        if country:
            db = get_db()
            doc = db["seasons"].find_one(
                {"countryCode": country.upper(), "months": month},
                {"_id": 0},
            )
            if doc:
                return {
                    "name": doc.get("name", ""),
                    "localName": doc.get("localName", doc.get("name", "")),
                    "description": doc.get("description", ""),
                }

            # Country not in DB — trigger background AI enrichment for next
            # request, return hemisphere fallback immediately for this one.
            _trigger_background_season_resolution(country, lat, lon)
    except Exception:
        pass

    return _hemisphere_fallback(lat)


# Countries currently being resolved in background threads — prevents
# duplicate AI calls when multiple requests arrive before DB is seeded.
_resolution_in_progress: set[str] = set()
_resolution_lock = __import__("threading").Lock()


def _trigger_background_season_resolution(
    country_code: str, lat: float, lon: float
) -> None:
    """Fire-and-forget AI season resolution in a background thread.

    Uses a module-level in-progress set (guarded by a lock to prevent
    TOCTOU races) to deduplicate concurrent AI calls for the same
    country. On Vercel serverless, daemon threads are best-effort — the
    process may terminate after the response. If it does, the next
    _get_season call for this country will re-trigger enrichment.
    """
    import threading

    key = country_code.upper()
    with _resolution_lock:
        if key in _resolution_in_progress:
            return
        _resolution_in_progress.add(key)

    logger.info("Starting background season resolution for %s (%.1f, %.1f)", key, lat, lon)

    def _run() -> None:
        try:
            _resolve_seasons_with_ai(country_code, lat, lon)
            logger.info("Background season resolution completed for %s", key)
        except Exception:
            logger.debug("Background season resolution skipped for %s", country_code)
        finally:
            with _resolution_lock:
                _resolution_in_progress.discard(key)

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
