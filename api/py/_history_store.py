"""
Weather history store — the Python reader for ``weather.weather_history``.

``GET /api/py/history``, its Open-Meteo archive backfill and the recorder that
``/api/py/weather`` ran on a fresh provider fetch are gone: the app reads the
Rust Worker's ``GET /v1/history`` (``workers/places/src/history.rs``, rules in
``weather_core::history``), which reads this same collection through the
MongoDB bridge and fills the missing days from NASA POWER / Open-Meteo,
inserting them with ``source`` ``nasa-power`` or ``open-meteo-archive``; the
jobs Worker records the nightly ``place_daily`` row. What stays here is the
reader ``/api/py/history/analyze`` uses until it is ported (#333)
(:func:`read_history`, :func:`history_slugs`).

One document per ``(locationSlug, date)`` where ``date`` is the location-local
calendar day (``YYYY-MM-DD``); db-init creates a UNIQUE index on
``{locationSlug: 1, date: -1}``.

Provenances share the collection, marked by ``source``:

* ``"recorded"`` — a day the Python recorder wrote before it was removed (and
  the jobs Worker's nightly row). Recorded data wins on its day.
* ``"open-meteo-archive"`` / ``"nasa-power"`` — a past day written by the Rust
  Worker's history route, insert-only, so it never overwrites a recorded day.

Document shape mirrors the TS ``WeatherHistoryDoc`` the HistoryDashboard and
``_history_analyze`` read: ``current`` (WeatherData current fields),
``daily`` (WeatherData daily arrays, sliced to the one day), ``insights``.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Iterable, Optional

from ._db import get_db
from ._places_resolver import storage_slug

COLLECTION = "weather_history"

SOURCE_RECORDED = "recorded"


def _collection():
    return get_db()[COLLECTION]


def estimate_utc_offset_seconds(lon: float) -> int:
    """Longitude-based UTC offset — the SAME estimator the forecast Worker
    (``weather_core::blend::estimate_utc_offset``) uses when a provider gives
    no offset, so the Worker's history route and this reader agree on "today"
    whenever neither has the real one.

    Where the writer DID have the provider's real offset (e.g. India +5:30,
    western China +8) the reader's estimate can be up to a day out at the
    window edges. That only moves one boundary day in or out of the window;
    it never loses a doc, because the reader has no upper bound and dates
    are unique per location.
    """
    try:
        lon_f = float(lon)
    except (TypeError, ValueError):
        return 0
    if lon_f != lon_f or lon_f in (float("inf"), float("-inf")):
        return 0
    # Solar-meridian estimate: 15 degrees an hour, in quarter-hour steps.
    return int(round(lon_f / 15 * 4)) * 900


def local_date(utc_offset_seconds: Optional[int], now: Optional[datetime] = None) -> str:
    """Location-local calendar date (``YYYY-MM-DD``) for ``now``."""
    now = now or datetime.now(timezone.utc)
    offset = int(utc_offset_seconds or 0)
    return (now + timedelta(seconds=offset)).date().isoformat()


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
