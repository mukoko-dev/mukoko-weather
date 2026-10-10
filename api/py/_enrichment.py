"""
Tomorrow.io as ENRICHMENT ONLY (issue #246).

Tomorrow.io no longer provides the forecast baseline. It contributes only its
proprietary ``insights`` fields (thunderstorm probability, heat index, UV
health concern, GDD, ET, cloud base/ceiling, moon phase, precipitation type),
merged onto the baseline's derived insights. It never blocks or replaces the
baseline: on a 429, timeout, open breaker or exhausted budget the baseline is
served as-is.

Free-tier limits: 500 calls/day, 25/hour, 3/second. The quota guard keeps us
well under that across all serverless instances using MongoDB counters:

=================  =======  =======
bucket             normal   priority
=================  =======  =======
per hour           12       20
per day            250      400
=================  =======  =======

``priority`` = seed / high-traffic locations and paying users. Normal traffic
stops at the lower cap so priority traffic always has headroom.

Enrichment is cached per location for :data:`ENRICHMENT_TTL_S` (3 h), so a
location costs at most 8 calls a day.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from ._circuit_breaker import tomorrow_breaker

logger = logging.getLogger(__name__)

ENRICHMENT_TTL_S = 3 * 3600
TOMORROW_TIMEOUT_S = 4.0

#: Hard caps (headroom under the free tier's 25/h and 500/day).
HOURLY_CAP = 20
DAILY_CAP = 400
#: Caps for non-priority traffic — the rest is reserved for priority callers.
HOURLY_CAP_NORMAL = 12
DAILY_CAP_NORMAL = 250

PROVIDER = "tomorrow"

#: Insights fields Tomorrow.io is allowed to override on the baseline.
#: Wind, visibility and dew point stay with the (fresher, hourly) baseline.
#: ``uvHealthConcern`` is deliberately NOT here: Tomorrow.io's
#: ``uvHealthConcernMax`` is a 0–4 category, while the suitability rules
#: compare the field against the 0–11+ UV index (e.g. ``gt 7``). Nor is
#: ``evapotranspiration``: Tomorrow.io's ``evapotranspirationAvg`` is an
#: hourly average (≈0.2 mm, seen live on the preview), while the rules and
#: the derived value use daily FAO ET₀ in mm/day (≈6 mm).
ENRICHMENT_FIELDS = (
    "thunderstormProbability",
    "heatStressIndex",
    "gdd10To30",
    "cloudBase",
    "cloudCeiling",
    "moonPhase",
    "precipitationType",
)

# X-Enrichment header values
ENRICHED = "tomorrow"
SKIPPED_BUDGET = "skipped-budget"
SKIPPED_ERROR = "skipped-error"
NONE = "none"


def _budget_collection():
    from ._db import weather_db

    return weather_db()["providerBudget"]


def _enrichment_collection():
    from ._db import weather_db

    return weather_db()["enrichmentCache"]


def _bucket_ids(now: datetime) -> tuple[str, str]:
    return (
        f"{PROVIDER}:hour:{now.strftime('%Y%m%d%H')}",
        f"{PROVIDER}:day:{now.strftime('%Y%m%d')}",
    )


def _reserve(bucket_id: str, cap: int, expires_at: datetime) -> bool:
    """Atomically take one slot in ``bucket_id`` if ``count < cap``.

    ``$inc`` with a ``count < cap`` filter and ``upsert=True``: when the
    bucket is full the filter misses, the upsert tries to insert a duplicate
    ``_id`` and MongoDB raises DuplicateKeyError — meaning "no slot".
    """
    try:
        _budget_collection().find_one_and_update(
            {"_id": bucket_id, "count": {"$lt": cap}},
            {"$inc": {"count": 1}, "$setOnInsert": {"expiresAt": expires_at}},
            upsert=True,
        )
        return True
    except Exception as e:  # DuplicateKeyError == bucket full
        if type(e).__name__ != "DuplicateKeyError":
            logger.warning("tomorrow budget reserve failed: %r", e)
        return False


def _refund(bucket_id: str) -> None:
    try:
        _budget_collection().update_one({"_id": bucket_id, "count": {"$gt": 0}}, {"$inc": {"count": -1}})
    except Exception:
        pass


def reserve_call(priority: bool = False, now: datetime | None = None) -> bool:
    """Reserve one Tomorrow.io call against the hour AND day budgets.

    Fails closed: any DB error means no reservation (we would rather skip an
    enrichment than blow the provider quota).
    """
    now = now or datetime.now(timezone.utc)
    hour_id, day_id = _bucket_ids(now)
    hour_cap = HOURLY_CAP if priority else HOURLY_CAP_NORMAL
    day_cap = DAILY_CAP if priority else DAILY_CAP_NORMAL
    if not _reserve(hour_id, hour_cap, now + timedelta(hours=2)):
        return False
    if not _reserve(day_id, day_cap, now + timedelta(days=2)):
        _refund(hour_id)
        return False
    return True


#: In-process memo of budget tiers known to be exhausted for the current
#: hour bucket — once a reservation fails, later requests in this warm
#: instance skip the reservation write entirely until the hour rolls over.
_exhausted: dict[bool, str] = {}
#: (slug, hour bucket, reason) skips already counted by this instance, so a
#: busy location adds one stats write + one log line per hour, not per request.
_skips_seen: set[tuple[str, str, str]] = set()


def _reset_memos() -> None:
    """Clear the in-process memos (used by tests)."""
    _exhausted.clear()
    _skips_seen.clear()


def record_skip(reason: str, slug: str, now: datetime | None = None) -> None:
    """Count an enrichment skip on the day's stats doc + log it.

    Deduplicated per (slug, hour, reason) within a warm instance, so the
    counters measure skipped locations-per-hour rather than raw requests.
    """
    now = now or datetime.now(timezone.utc)
    seen_key = (slug, now.strftime("%Y%m%d%H"), reason)
    if seen_key in _skips_seen:
        return
    if len(_skips_seen) > 5000:
        _skips_seen.clear()
    _skips_seen.add(seen_key)
    field = "skippedBudget" if reason == SKIPPED_BUDGET else "skippedError"
    try:
        _budget_collection().update_one(
            {"_id": f"{PROVIDER}:stats:{now.strftime('%Y%m%d')}"},
            {
                "$inc": {field: 1},
                "$set": {"lastSkipReason": reason, "lastSkipAt": now, "lastSkipSlug": slug},
                "$setOnInsert": {"expiresAt": now + timedelta(days=30)},
            },
            upsert=True,
        )
    except Exception:
        pass
    logger.warning("tomorrow enrichment skipped: reason=%s location=%s", reason, slug)


def budget_snapshot(now: datetime | None = None) -> dict:
    """Current usage for the status page (no provider call)."""
    now = now or datetime.now(timezone.utc)
    hour_id, day_id = _bucket_ids(now)
    stats_id = f"{PROVIDER}:stats:{now.strftime('%Y%m%d')}"
    docs = {d["_id"]: d for d in _budget_collection().find({"_id": {"$in": [hour_id, day_id, stats_id]}})}
    stats = docs.get(stats_id) or {}
    return {
        "hourUsed": (docs.get(hour_id) or {}).get("count", 0),
        "hourCap": HOURLY_CAP,
        "dayUsed": (docs.get(day_id) or {}).get("count", 0),
        "dayCap": DAILY_CAP,
        "skippedBudget": stats.get("skippedBudget", 0),
        "skippedError": stats.get("skippedError", 0),
        "lastSkipReason": stats.get("lastSkipReason"),
    }


def get_cached_enrichment(slug: str) -> dict | None:
    try:
        doc = _enrichment_collection().find_one(
            {"_id": slug, "expiresAt": {"$gt": datetime.now(timezone.utc)}},
            {"insights": 1},
        )
    except Exception:
        return None
    return (doc or {}).get("insights")


def set_cached_enrichment(slug: str, insights: dict) -> None:
    now = datetime.now(timezone.utc)
    try:
        _enrichment_collection().update_one(
            {"_id": slug},
            {
                "$set": {
                    "insights": insights,
                    "provider": PROVIDER,
                    "fetchedAt": now,
                    "expiresAt": now + timedelta(seconds=ENRICHMENT_TTL_S),
                }
            },
            upsert=True,
        )
    except Exception:
        pass


def fetch_tomorrow_insights(lat: float, lon: float, api_key: str) -> dict | None:
    """One Tomorrow.io daily-timestep call → its insights dict (or ``None``).

    Uses ``timesteps=1d`` only: the insights are read from today's daily
    values. Returns ``None`` on 429 / non-200 so the caller records a skip.
    """
    from ._http import get_http_client
    from ._weather import _normalize_tomorrow

    resp = get_http_client(TOMORROW_TIMEOUT_S).get(
        "https://api.tomorrow.io/v4/weather/forecast",
        params={"location": f"{lat},{lon}", "timesteps": "1d", "units": "metric"},
        headers={"apikey": api_key},  # header, never the query string
    )
    if resp.status_code != 200:
        return None
    raw = resp.json()
    insights = _normalize_tomorrow(raw).get("insights") or {}
    return {k: v for k, v in insights.items() if k in ENRICHMENT_FIELDS and v is not None} or None


def merge_insights(baseline: dict | None, enrichment: dict | None) -> dict:
    """Baseline-derived insights with Tomorrow.io's ENRICHMENT_FIELDS on top."""
    merged = dict(baseline or {})
    for key in ENRICHMENT_FIELDS:
        if enrichment and enrichment.get(key) is not None:
            merged[key] = enrichment[key]
    return merged


def enrich(slug: str, lat: float, lon: float, priority: bool = False) -> tuple[dict | None, str]:
    """Return ``(enrichment insights | None, X-Enrichment status)``.

    Order: cache → breaker → API key → budget → provider call. Never raises.
    """
    cached = get_cached_enrichment(slug)
    if cached:
        return cached, ENRICHED

    if not tomorrow_breaker.is_allowed:
        record_skip(SKIPPED_ERROR, slug)
        return None, SKIPPED_ERROR

    try:
        from ._db import get_api_key

        api_key = get_api_key(PROVIDER)
    except Exception:
        api_key = None
    if not api_key:
        return None, NONE

    hour_bucket = datetime.now(timezone.utc).strftime("%Y%m%d%H")
    if _exhausted.get(priority) == hour_bucket or not reserve_call(priority=priority):
        _exhausted[priority] = hour_bucket
        record_skip(SKIPPED_BUDGET, slug)
        return None, SKIPPED_BUDGET

    try:
        insights = fetch_tomorrow_insights(lat, lon, api_key)
    except Exception:
        insights = None
    if not insights:
        tomorrow_breaker.record_failure()
        record_skip(SKIPPED_ERROR, slug)
        return None, SKIPPED_ERROR

    tomorrow_breaker.record_success()
    set_cached_enrichment(slug, insights)
    return insights, ENRICHED
