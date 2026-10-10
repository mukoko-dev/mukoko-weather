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

What the free ``/v4/weather/forecast`` endpoint actually returns in
``timelines.daily[].values`` (Tomorrow.io docs, checked 2026-10-10): of our
:data:`ENRICHMENT_FIELDS` only ``cloudBaseAvg`` / ``cloudCeilingAvg``, and
those are null under a clear sky. There is no thunderstorm probability, heat
index, GDD, moon phase or precipitation type on this endpoint. So a 200 with
nothing to merge is NORMAL and must never count as a provider failure: it is
cached (so the 3 h TTL still bounds quota) and reported as ``tomorrow``.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from ._circuit_breaker import tomorrow_breaker

logger = logging.getLogger(__name__)

ENRICHMENT_TTL_S = 3 * 3600
#: Shorter TTL for an answer with nothing to merge (clear sky → no cloud
#: base): still bounds quota, but a cell that clouds over picks up its cloud
#: base/ceiling within the hour.
EMPTY_ENRICHMENT_TTL_S = 3600
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


def record_skip(reason: str, slug: str, now: datetime | None = None, detail: str | None = None) -> None:
    """Count an enrichment skip on the day's stats doc + log it.

    Deduplicated per (slug, hour, reason) within a warm instance, so the
    counters measure skipped locations-per-hour rather than raw requests.
    ``detail`` is a secret-free provider reason (``HTTP 401``,
    ``ReadTimeout``…), persisted as ``lastErrorDetail`` and logged once.
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
                "$set": {
                    "lastSkipReason": reason,
                    "lastSkipAt": now,
                    "lastSkipSlug": slug,
                    **({"lastErrorDetail": detail} if detail else {}),
                },
                "$setOnInsert": {"expiresAt": now + timedelta(days=30)},
            },
            upsert=True,
        )
    except Exception:
        pass
    logger.warning(
        "tomorrow enrichment skipped: reason=%s location=%s%s",
        reason,
        slug,
        f" detail={detail}" if detail else "",
    )


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
        "lastErrorDetail": stats.get("lastErrorDetail"),
    }


def get_cached_enrichment(slug: str) -> dict | None:
    """Cached enrichment for ``slug``.

    ``None`` = no fresh cache row. ``{}`` = Tomorrow.io answered but had
    nothing to add (a cache HIT — do not call it again until the TTL ends).
    """
    try:
        doc = _enrichment_collection().find_one(
            {"_id": slug, "expiresAt": {"$gt": datetime.now(timezone.utc)}},
            {"insights": 1},
        )
    except Exception:
        return None
    if not doc:
        return None
    insights = doc.get("insights")
    return insights if isinstance(insights, dict) else {}


def set_cached_enrichment(slug: str, insights: dict) -> None:
    now = datetime.now(timezone.utc)
    ttl = ENRICHMENT_TTL_S if insights else EMPTY_ENRICHMENT_TTL_S
    try:
        _enrichment_collection().update_one(
            {"_id": slug},
            {
                "$set": {
                    "insights": insights,
                    "provider": PROVIDER,
                    "fetchedAt": now,
                    "expiresAt": now + timedelta(seconds=ttl),
                }
            },
            upsert=True,
        )
    except Exception:
        pass


class TomorrowUnavailable(Exception):
    """Tomorrow.io did not answer usefully (non-200, timeout, bad JSON).

    Carries a short, secret-free reason for the log line. ``rate_limited``
    marks a 429: quota exhaustion, not provider ill-health.
    """

    def __init__(self, reason: str, rate_limited: bool = False):
        super().__init__(reason)
        self.rate_limited = rate_limited


def fetch_tomorrow_insights(lat: float, lon: float, api_key: str) -> dict:
    """One Tomorrow.io daily-timestep call → its insights dict.

    Uses ``timesteps=1d`` only: the insights are read from today's daily
    values. Returns ``{}`` when Tomorrow.io answered (HTTP 200) but carried no
    field we merge — a normal outcome, see the module docstring. Raises
    :class:`TomorrowUnavailable` on a non-200, a timeout or an unreadable body,
    which is the only case that counts against the breaker.
    """
    from ._http import get_http_client
    from ._weather import _normalize_tomorrow

    try:
        resp = get_http_client(TOMORROW_TIMEOUT_S).get(
            "https://api.tomorrow.io/v4/weather/forecast",
            params={"location": f"{lat},{lon}", "timesteps": "1d", "units": "metric"},
            headers={"apikey": api_key},  # header, never the query string
        )
    except Exception as e:  # timeout / transport
        raise TomorrowUnavailable(type(e).__name__) from e
    if resp.status_code != 200:
        raise TomorrowUnavailable(f"HTTP {resp.status_code}", rate_limited=resp.status_code == 429)
    try:
        raw = resp.json()
    except Exception as e:
        raise TomorrowUnavailable("unreadable JSON") from e
    # Only a body with a daily timeline counts as a healthy answer — a
    # degraded/partial 200 must not be cached as "nothing to add".
    timelines = raw.get("timelines") if isinstance(raw, dict) else None
    daily = timelines.get("daily") if isinstance(timelines, dict) else None
    if not isinstance(daily, list) or not daily:
        raise TomorrowUnavailable("no daily timeline")
    try:
        insights = _normalize_tomorrow(raw).get("insights") or {}
    except Exception as e:
        raise TomorrowUnavailable("unexpected body") from e
    return {k: v for k, v in insights.items() if k in ENRICHMENT_FIELDS and v is not None}


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
    if cached is not None:
        return cached or None, ENRICHED

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
    except Exception as e:
        detail = str(e) if isinstance(e, TomorrowUnavailable) else type(e).__name__
        if getattr(e, "rate_limited", False):
            # 429 = the account quota is spent (the key is shared with the
            # map-tile proxy). Not provider ill-health: don't trip the
            # breaker, stop calling for the rest of this hour instead.
            _exhausted[True] = _exhausted[False] = hour_bucket
            record_skip(SKIPPED_BUDGET, slug, detail=detail)
            return None, SKIPPED_BUDGET
        # A real provider failure counts against the breaker. The reason
        # (status code / exception class) is recorded; the key never is.
        tomorrow_breaker.record_failure()
        record_skip(SKIPPED_ERROR, slug, detail=detail)
        return None, SKIPPED_ERROR

    # HTTP 200 — healthy, even when there is nothing to merge (clear sky has
    # no cloud base). Cache the empty answer too, so the TTL bounds quota.
    tomorrow_breaker.record_success()
    set_cached_enrichment(slug, insights)
    return insights or None, ENRICHED
