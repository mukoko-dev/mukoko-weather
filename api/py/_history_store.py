"""
Weather history store — the single writer/reader for ``weather.weather_history``.

One document per ``(locationSlug, date)`` where ``date`` is the location-local
calendar day (``YYYY-MM-DD``). db-init creates a UNIQUE index on
``{locationSlug: 1, date: -1}``, so:

* every write is an UPSERT keyed on ``(locationSlug, date)`` — never a bare
  ``insert_one``. (Issue #245: the Python writer used ``insert_one`` without a
  ``date`` field, so every doc indexed as ``(slug, null)``; the second insert
  per slug raised DuplicateKeyError and was silently swallowed. History
  stopped growing the day #112 retired the TS writer.)
* ``date`` is always present.

Two provenances share the collection, marked by ``source``:

* ``"recorded"`` — a fresh provider fetch from ``/api/py/weather`` (today's
  ``current`` snapshot + day-0 ``daily`` forecast). Recorded data wins on its
  day: it ``$set``s the doc.
* ``"open-meteo-archive"`` — a past day filled from the Open-Meteo
  Historical/Archive API (ERA5 / best-match reanalysis). Inserted with
  ``$setOnInsert`` only, so it never overwrites a recorded day.

Document shape mirrors the TS ``WeatherHistoryDoc`` the HistoryDashboard and
``_history_analyze`` read: ``current`` (WeatherData current fields),
``daily`` (WeatherData daily arrays, sliced to the one day), ``insights``.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Iterable, Optional

from ._db import get_db

logger = logging.getLogger(__name__)

COLLECTION = "weather_history"

SOURCE_RECORDED = "recorded"
SOURCE_ARCHIVE = "open-meteo-archive"

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
ARCHIVE_TIMEOUT_S = 8.0
#: Max days a single archive request may span (one HTTP call per request).
ARCHIVE_MAX_SPAN_DAYS = 366
#: Don't re-attempt the same (or a narrower) backfill for a location within
#: this window — the archive has a ~2-day lag, so yesterday can legitimately
#: come back empty, and we must not hammer the API on every page view.
BACKFILL_COOLDOWN_S = 3600
#: Per-IP cap on backfill attempts (the endpoint is reachable directly).
BACKFILL_RATE_LIMIT = 30
BACKFILL_RATE_WINDOW_S = 3600

ARCHIVE_DAILY_VARS = (
    "weather_code",
    "temperature_2m_max",
    "temperature_2m_min",
    "temperature_2m_mean",
    "apparent_temperature_max",
    "apparent_temperature_min",
    "apparent_temperature_mean",
    "precipitation_sum",
    "sunrise",
    "sunset",
    "wind_speed_10m_max",
    "wind_gusts_10m_max",
    "wind_direction_10m_dominant",
    "wind_speed_10m_mean",
    "relative_humidity_2m_mean",
    "cloud_cover_mean",
    "surface_pressure_mean",
    "dew_point_2m_mean",
    "et0_fao_evapotranspiration",
)

# (slug) -> (attempted_at_monotonic, earliest_date_attempted)
_backfill_attempts: dict[str, tuple[float, str]] = {}


def _collection():
    return get_db()[COLLECTION]


def estimate_utc_offset_seconds(lon: float) -> int:
    """Longitude-based UTC offset — the SAME estimator ``/api/py/weather``
    uses when a provider gives no offset, so the writer and reader agree on
    "today" whenever neither has the real one.

    Where the writer DID have the provider's real offset (e.g. India +5:30,
    western China +8) the reader's estimate can be up to a day out at the
    window edges. That only moves one boundary day in or out of the window;
    it never loses a doc, because the reader has no upper bound and dates
    are unique per location.
    """
    try:
        from ._weather import _estimate_utc_offset

        return int(_estimate_utc_offset(float(lon)))
    except Exception:  # noqa: BLE001
        try:
            return int(round(float(lon) / 15.0)) * 3600
        except (TypeError, ValueError):
            return 0


def local_date(utc_offset_seconds: Optional[int], now: Optional[datetime] = None) -> str:
    """Location-local calendar date (``YYYY-MM-DD``) for ``now``."""
    now = now or datetime.now(timezone.utc)
    offset = int(utc_offset_seconds or 0)
    return (now + timedelta(seconds=offset)).date().isoformat()


def _first(values):
    if isinstance(values, list):
        return values[0] if values else None
    return None


# ---------------------------------------------------------------------------
# Writer — fresh provider fetch
# ---------------------------------------------------------------------------


def build_recorded_doc(
    slug: str,
    data: dict,
    *,
    provider: str,
    utc_offset_seconds: Optional[int],
    now: Optional[datetime] = None,
) -> dict:
    """Build the ``$set`` fields for a recorded day (excludes the key fields)."""
    now = now or datetime.now(timezone.utc)
    date = local_date(utc_offset_seconds, now)

    daily_src = data.get("daily") or {}
    # Day 0 of the forecast, kept as one-element arrays so readers can keep
    # using the WeatherData `daily.<field>[0]` convention.
    daily = {
        key: [_first(values)]
        for key, values in daily_src.items()
        if isinstance(values, list) and values
    }
    daily["time"] = [date]

    fields: dict = {
        "source": SOURCE_RECORDED,
        "provider": provider,
        "current": data.get("current") or {},
        "daily": daily,
        "recordedAt": now,
    }
    if data.get("insights"):
        fields["insights"] = data["insights"]
    return {"date": date, "fields": fields}


def record_weather_history(
    slug: str,
    data: dict,
    *,
    provider: str,
    utc_offset_seconds: Optional[int],
    now: Optional[datetime] = None,
) -> bool:
    """Upsert today's recorded doc for ``slug``. Idempotent per local day.

    Returns True on success. Never raises — failures are LOGGED (the old
    writer's swallowed DuplicateKeyError is how this outage went unnoticed).
    """
    if not slug or not data or not data.get("current"):
        return False
    built = build_recorded_doc(
        slug, data, provider=provider, utc_offset_seconds=utc_offset_seconds, now=now
    )
    key = {"locationSlug": slug, "date": built["date"]}
    update = {
        "$set": built["fields"],
        "$setOnInsert": {"createdAt": built["fields"]["recordedAt"]},
    }
    coll = _collection()
    for attempt in range(2):
        try:
            coll.update_one(key, update, upsert=True)
            return True
        except Exception as exc:  # noqa: BLE001
            # Two concurrent upserts for a brand-new (slug, date) can race on
            # the unique index; the loser's retry becomes a plain update.
            if attempt == 0 and type(exc).__name__ == "DuplicateKeyError":
                continue
            logger.warning(
                "weather_history upsert failed for %s %s: %s",
                slug, built["date"], exc,
            )
            return False
    return False


# ---------------------------------------------------------------------------
# Reader
# ---------------------------------------------------------------------------


def _serialize(doc: dict) -> dict:
    for key, value in list(doc.items()):
        if isinstance(value, datetime):
            doc[key] = value.isoformat()
    return doc


def _source_rank(doc: dict) -> int:
    return 0 if doc.get("source", SOURCE_RECORDED) == SOURCE_RECORDED else 1


def read_history(
    slugs: Iterable[str],
    days: int,
    *,
    lon: float = 0.0,
    now: Optional[datetime] = None,
) -> list[dict]:
    """Docs for the last ``days`` local days, newest first, one per date.

    ``slugs`` is the canonical slug first, then aliases (e.g. the platform
    hash slug historic writes used). On a date present under several slugs or
    sources, recorded beats archive and the canonical slug beats an alias.
    Legacy docs without ``date`` are excluded by the date-range filter.
    """
    slug_list = [s for s in dict.fromkeys(slugs) if s]
    if not slug_list:
        return []
    today = local_date(estimate_utc_offset_seconds(lon), now)
    cutoff = (
        datetime.fromisoformat(today) - timedelta(days=max(1, days) - 1)
    ).date().isoformat()

    docs = list(
        _collection()
        .find(
            {"locationSlug": {"$in": slug_list}, "date": {"$gte": cutoff}},
            {"_id": 0, "createdAt": 0},
        )
        .sort("date", -1)
    )
    return merge_by_date(docs, slug_list)


def merge_by_date(docs: Iterable[dict], slug_order: list[str]) -> list[dict]:
    """One doc per date (recorded > archive, canonical slug > alias), newest first."""
    order = {s: i for i, s in enumerate(slug_order)}
    best: dict[str, dict] = {}
    for doc in docs:
        date = doc.get("date")
        if not isinstance(date, str):
            continue
        rank = (_source_rank(doc), order.get(doc.get("locationSlug"), len(order)))
        current = best.get(date)
        if current is None or rank < current[0]:
            best[date] = (rank, doc)
    merged = [_serialize(dict(entry[1])) for entry in best.values()]
    # Present every doc under the canonical slug the caller asked for.
    if slug_order:
        for doc in merged:
            doc["locationSlug"] = slug_order[0]
    merged.sort(key=lambda d: d["date"], reverse=True)
    return merged


# ---------------------------------------------------------------------------
# Backfill — Open-Meteo Historical/Archive API
# ---------------------------------------------------------------------------


def missing_past_dates(existing: Iterable[str], days: int, *, lon: float, now: Optional[datetime] = None) -> list[str]:
    """Past local dates in the window (today excluded) with no doc, oldest first."""
    today = datetime.fromisoformat(local_date(estimate_utc_offset_seconds(lon), now)).date()
    have = set(existing)
    span = min(max(1, days), ARCHIVE_MAX_SPAN_DAYS)
    out = []
    for back in range(span - 1, 0, -1):
        d = (today - timedelta(days=back)).isoformat()
        if d not in have:
            out.append(d)
    return out


def _cooldown_blocks(slug: str, earliest: str) -> bool:
    prev = _backfill_attempts.get(slug)
    if not prev:
        return False
    attempted_at, prev_earliest = prev
    if time.monotonic() - attempted_at > BACKFILL_COOLDOWN_S:
        return False
    # A previous attempt already covered this range (or a wider one).
    return prev_earliest <= earliest


def build_archive_docs(slug: str, payload: dict, wanted: Iterable[str], *, now: Optional[datetime] = None) -> list[dict]:
    """Turn an archive API payload into history docs for the ``wanted`` dates."""
    now = now or datetime.now(timezone.utc)
    daily = (payload or {}).get("daily") or {}
    times = daily.get("time") or []
    wanted_set = set(wanted)
    docs: list[dict] = []
    for i, date in enumerate(times):
        if date not in wanted_set:
            continue

        def v(key, i=i):
            arr = daily.get(key) or []
            return arr[i] if i < len(arr) else None

        # ERA5 lag: the newest days come back as nulls — skip, retry later.
        if v("temperature_2m_max") is None or v("temperature_2m_min") is None:
            continue

        day_daily = {
            "time": [date],
            "weather_code": [v("weather_code")],
            "temperature_2m_max": [v("temperature_2m_max")],
            "temperature_2m_min": [v("temperature_2m_min")],
            "apparent_temperature_max": [v("apparent_temperature_max")],
            "apparent_temperature_min": [v("apparent_temperature_min")],
            "precipitation_sum": [v("precipitation_sum")],
            "sunrise": [v("sunrise")],
            "sunset": [v("sunset")],
            "wind_speed_10m_max": [v("wind_speed_10m_max")],
            "wind_gusts_10m_max": [v("wind_gusts_10m_max")],
            "wind_direction_10m_dominant": [v("wind_direction_10m_dominant")],
        }
        # `current` holds DAILY MEANS for archive days (there is no "current"
        # for a past day) so the dashboard's current-based columns — humidity,
        # cloud, pressure, wind — are populated. `aggregation` says so.
        current = {
            "temperature_2m": v("temperature_2m_mean"),
            "apparent_temperature": v("apparent_temperature_mean"),
            "relative_humidity_2m": v("relative_humidity_2m_mean"),
            "cloud_cover": v("cloud_cover_mean"),
            "surface_pressure": v("surface_pressure_mean"),
            "wind_speed_10m": v("wind_speed_10m_mean"),
            "wind_direction_10m": v("wind_direction_10m_dominant"),
            "wind_gusts_10m": v("wind_gusts_10m_max"),
            "precipitation": v("precipitation_sum"),
            "weather_code": v("weather_code"),
            "uv_index": None,  # not available in the reanalysis archive
            "is_day": 1,
        }
        insights = {
            k: val
            for k, val in (
                ("dewPoint", v("dew_point_2m_mean")),
                ("evapotranspiration", v("et0_fao_evapotranspiration")),
            )
            if val is not None
        }
        doc = {
            "locationSlug": slug,
            "date": date,
            "source": SOURCE_ARCHIVE,
            "provider": "open-meteo-archive",
            "aggregation": "daily-mean",
            "current": current,
            "daily": day_daily,
            "recordedAt": now,
            "createdAt": now,
        }
        if insights:
            doc["insights"] = insights
        docs.append(doc)
    return docs


def fetch_archive(http_client, lat: float, lon: float, start: str, end: str) -> tuple[int, Optional[dict]]:
    """Returns ``(status_code, payload_or_None)``."""
    resp = http_client.get(
        ARCHIVE_URL,
        params={
            "latitude": str(lat),
            "longitude": str(lon),
            "start_date": start,
            "end_date": end,
            "timezone": "auto",
            "daily": ",".join(ARCHIVE_DAILY_VARS),
        },
        timeout=ARCHIVE_TIMEOUT_S,
    )
    if resp.status_code != 200:
        return resp.status_code, None
    return 200, resp.json()


def backfill_history(
    slug: str,
    lat: float,
    lon: float,
    days: int,
    existing_dates: Iterable[str],
    *,
    http_client,
    breaker,
    client_ip: Optional[str] = None,
    rate_limiter=None,
    now: Optional[datetime] = None,
) -> list[dict]:
    """Fill missing past days from the Open-Meteo archive. Never raises.

    At most ONE archive request per call, gated by the circuit breaker, a
    per-location cooldown and a per-IP rate limit. Returns the newly built
    docs (already upserted with ``$setOnInsert``, so recorded days are never
    overwritten).
    """
    try:
        missing = missing_past_dates(existing_dates, days, lon=lon, now=now)
        if not missing:
            return []
        if _cooldown_blocks(slug, missing[0]):
            return []
        if not breaker.is_allowed:
            return []
        if rate_limiter is not None and client_ip:
            if not rate_limiter(client_ip, "history-backfill", BACKFILL_RATE_LIMIT, BACKFILL_RATE_WINDOW_S).get("allowed", True):
                return []

        try:
            status, payload = fetch_archive(http_client, lat, lon, missing[0], missing[-1])
        except Exception as exc:  # noqa: BLE001
            breaker.record_failure()
            logger.warning("Open-Meteo archive fetch failed for %s: %s", slug, exc)
            return []
        if payload is None:
            # Only 5xx / 429 say Open-Meteo is unwell. A 4xx is OUR request
            # (bad range or variable) and must not open the breaker that
            # also gates the forecast fallback, AQ, haze and normals.
            if status >= 500 or status == 429:
                breaker.record_failure()
            else:
                logger.warning("Open-Meteo archive rejected request for %s: HTTP %s", slug, status)
            return []
        breaker.record_success()

        docs = build_archive_docs(slug, payload, missing, now=now)
        persisted = _upsert_archive_docs(docs) if docs else True
        # Cool down only after a fetch that succeeded AND was saved, so a
        # transient timeout or failed write is retried on the next view.
        if persisted:
            _backfill_attempts[slug] = (time.monotonic(), missing[0])
        return docs
    except Exception as exc:  # noqa: BLE001
        logger.warning("History backfill failed for %s: %s", slug, exc)
        return []


def _upsert_archive_docs(docs: list[dict]) -> bool:
    """Persist archive docs insert-only. Never raises: the caller still
    returns the fetched days to the user even if saving them failed."""
    try:
        from pymongo import UpdateOne

        ops = []
        for doc in docs:
            body = {k: v for k, v in doc.items() if k not in ("locationSlug", "date")}
            ops.append(
                UpdateOne(
                    {"locationSlug": doc["locationSlug"], "date": doc["date"]},
                    {"$setOnInsert": body},
                    upsert=True,
                )
            )
        _collection().bulk_write(ops, ordered=False)
        return True
    except Exception as exc:  # noqa: BLE001
        # Duplicate-key races with a concurrent writer are harmless here —
        # the other writer's doc is at least as good. Anything else failed.
        if type(exc).__name__ == "BulkWriteError":
            return True
        logger.warning("Archive history upsert failed: %s", exc)
        return False
