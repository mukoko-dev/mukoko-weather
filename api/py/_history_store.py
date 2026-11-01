"""
Weather history store — the Python writer/reader for ``weather.weather_history``.

``GET /api/py/history`` and its Open-Meteo archive backfill are gone: the app
reads the Rust Worker's ``GET /v1/history`` (``workers/places/src/history.rs``,
rules in ``weather_core::history``), which reads this same collection through
the MongoDB bridge and fills the missing days from NASA POWER / Open-Meteo,
inserting them with ``source`` ``nasa-power`` or ``open-meteo-archive``. What
stays here is what the remaining Python needs until it is ported (#333): the
recorder ``/api/py/weather`` calls on a fresh provider fetch
(:func:`record_weather_history`) and the reader ``/api/py/history/analyze``
uses (:func:`read_history`, :func:`history_slugs`).

One document per ``(locationSlug, date)`` where ``date`` is the location-local
calendar day (``YYYY-MM-DD``). db-init creates a UNIQUE index on
``{locationSlug: 1, date: -1}``, so:

* every write is an UPSERT keyed on ``(locationSlug, date)`` — never a bare
  ``insert_one``. (Issue #245: the Python writer used ``insert_one`` without a
  ``date`` field, so every doc indexed as ``(slug, null)``; the second insert
  per slug raised DuplicateKeyError and was silently swallowed. History
  stopped growing the day #112 retired the TS writer.)
* ``date`` is always present.

Provenances share the collection, marked by ``source``:

* ``"recorded"`` — a fresh provider fetch from ``/api/py/weather`` (today's
  ``current`` snapshot + day-0 ``daily`` forecast). Recorded data wins on its
  day: it ``$set``s the doc.
* ``"open-meteo-archive"`` / ``"nasa-power"`` — a past day written by the Rust
  Worker's history route. Inserted with ``$setOnInsert`` only, so it never
  overwrites a recorded day.

Document shape mirrors the TS ``WeatherHistoryDoc`` the HistoryDashboard and
``_history_analyze`` read: ``current`` (WeatherData current fields),
``daily`` (WeatherData daily arrays, sliced to the one day), ``insights``.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Iterable, Optional

from ._db import get_db
from ._places_resolver import storage_slug

logger = logging.getLogger(__name__)

COLLECTION = "weather_history"

SOURCE_RECORDED = "recorded"
SOURCE_ARCHIVE = "open-meteo-archive"


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


def history_slugs(location: str, loc: dict) -> list[str]:
    """Canonical slug first, then the platform hash slug older writes used.

    A synthesized spot (a ``{name}--{geohash}`` slug with no record) is a
    coordinate path: its history is keyed by its cell (``storage_slug``), so
    the name half of the URL never becomes a storage key.
    """
    slugs = [storage_slug(location, loc)]
    platform = loc.get("platformSlug")
    if platform and platform != location:
        slugs.append(platform)
    return slugs
