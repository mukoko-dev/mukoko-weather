"""
Weather history store: the single writer and reader for ``weather.weather_history``,
and the external archive providers that fill its gaps (issue #268).

Owner decision (#268): check what our own data infrastructure holds first,
then pull only the missing dates from an external archive API. We never host
a reanalysis dataset ourselves.

Keys and writes
---------------
There is one document per ``(locationSlug, date)``, where ``date`` is the
location-local calendar day (``YYYY-MM-DD``). db-init creates a UNIQUE index on
``{locationSlug: 1, date: -1}``, so:

* every write is an UPSERT keyed on ``(locationSlug, date)``, never a bare
  ``insert_one``. (Issue #245: the Python writer used ``insert_one`` without a
  ``date`` field, so every doc indexed as ``(slug, null)``. The second insert
  per slug raised DuplicateKeyError, which was silently swallowed, and history
  stopped growing the day #112 retired the TS writer.)
* ``date`` is always present.
* ``locationSlug`` is a place slug, or a ``cell:<lat>_<lon>`` 0.05° grid key
  (``weather_cache_key``) for a bare coordinate that has no catalogue place.
  History therefore works for any coordinate on Earth.

Provenance (``source``)
-----------------------
* ``"recorded"``: a fresh provider fetch from ``/api/py/weather`` (today's
  ``current`` snapshot plus the day-0 ``daily`` forecast). Recorded data wins
  on its day because it ``$set``s the doc.
* one id per archive provider (``"nasa-power"``, ``"open-meteo-archive"``): a
  past day filled from an external archive. Archive days are inserted with
  ``$setOnInsert`` only, so they never overwrite a stored day, recorded or not.

Archive providers
-----------------
Each provider implements ``fetch_daily_range(lat, lon, start, end)`` and
returns canonical day dicts keyed by Open-Meteo daily variable names. The
order of the chain comes from config (``HISTORY_PROVIDERS``). A date that the
first provider can't supply (an outage, an open breaker, a spent budget, or
data that hasn't been published yet) falls through to the next. ``/api/py/normals``
uses the same chain.

The document shape mirrors the TS ``WeatherHistoryDoc`` that HistoryDashboard
and ``_history_analyze`` read: ``current`` (WeatherData current fields),
``daily`` (WeatherData daily arrays, sliced to the one day) and ``insights``.
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from datetime import date as _date, datetime, timedelta, timezone
from typing import Callable, Iterable, Optional, Protocol, Sequence

from ._circuit_breaker import CircuitBreaker, nasa_power_breaker, open_meteo_breaker
from ._db import get_db

logger = logging.getLogger(__name__)

COLLECTION = "weather_history"

SOURCE_RECORDED = "recorded"
SOURCE_NASA_POWER = "nasa-power"
SOURCE_OPEN_METEO_ARCHIVE = "open-meteo-archive"
#: Backwards-compatible alias (the only archive source before #268).
SOURCE_ARCHIVE = SOURCE_OPEN_METEO_ARCHIVE

#: Earliest date any request may ask for. ERA5 (Open-Meteo) starts in 1940;
#: NASA POWER daily starts in 1981, and earlier dates fall through to the next
#: provider in the chain.
EARLIEST_DATE = "1940-01-01"
#: Widest range one request may ask for (about 10 years). The response carries
#: one doc per day (about 1 KB each), so this bounds the payload.
MAX_RANGE_DAYS = 3660
#: Upstream calls one request may make, across all providers and chunks. A
#: wider gap is filled over successive views (each one stores what it fetched).
MAX_FETCHES_PER_CALL = 6
#: Wall-clock budget for starting new fetches within one request.
BACKFILL_TIME_BUDGET_S = 20.0
#: Missing runs closer than this are fetched as one span (fewer calls; the
#: dates already stored inside the span are dropped before writing).
RUN_MERGE_GAP_DAYS = 31
#: Don't re-attempt the same (or a narrower) backfill for a location within
#: this window. Archives lag by a few days, so yesterday can legitimately come
#: back empty, and we must not hammer the API on every page view.
BACKFILL_COOLDOWN_S = 3600
#: Per-IP cap on backfill attempts (the endpoint is reachable directly).
BACKFILL_RATE_LIMIT = 30
BACKFILL_RATE_WINDOW_S = 3600
#: Window for the per-provider (global) call budget.
PROVIDER_BUDGET_WINDOW_S = 3600

#: Canonical daily fields a provider may return (Open-Meteo daily names).
CANONICAL_DAILY_FIELDS = (
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
#: Kept for callers and tests that predate #268.
ARCHIVE_DAILY_VARS = CANONICAL_DAILY_FIELDS

# slug -> list of (attempted_at_monotonic, start, end) for successful attempts
_backfill_attempts: dict[str, list[tuple[float, str, str]]] = {}


def _collection():
    return get_db()[COLLECTION]


def estimate_utc_offset_seconds(lon: float) -> int:
    """Longitude-based UTC offset. This is the SAME estimator ``/api/py/weather``
    uses when a provider gives no offset, so the writer and reader agree on
    "today" whenever neither has the real one.

    Where the writer DID have the provider's real offset (e.g. India +5:30,
    western China +8), the reader's estimate can be up to a day out at the
    window edges. That only moves one boundary day in or out of the window. It
    never loses a doc, because dates are unique per location.
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


def local_today(lon: float, now: Optional[datetime] = None) -> str:
    """Today at a longitude, by the shared offset estimator."""
    return local_date(estimate_utc_offset_seconds(lon), now)


def _first(values):
    if isinstance(values, list):
        return values[0] if values else None
    return None


def _iso(d: _date) -> str:
    return d.isoformat()


def _parse(d: str) -> _date:
    return _date.fromisoformat(d)


def date_span(start: str, end: str) -> list[str]:
    """Every date from ``start`` to ``end`` inclusive (empty when start > end)."""
    s, e = _parse(start), _parse(end)
    return [_iso(s + timedelta(days=i)) for i in range((e - s).days + 1)]


def window_for_days(days: int, *, lon: float, now: Optional[datetime] = None) -> tuple[str, str]:
    """``(start, end)`` for "the last ``days`` local days, including today"."""
    today = _parse(local_today(lon, now))
    return _iso(today - timedelta(days=max(1, days) - 1)), _iso(today)


# ---------------------------------------------------------------------------
# Writer: fresh provider fetch
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

    Returns True on success. Never raises. Failures are LOGGED, because the
    old writer's swallowed DuplicateKeyError is how the #245 outage went
    unnoticed.
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
            # the unique index. The loser's retry becomes a plain update.
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


def read_history_range(slugs: Iterable[str], start: str, end: str) -> list[dict]:
    """Docs dated ``start``..``end`` inclusive, newest first, one per date.

    ``slugs`` lists the canonical slug first, then aliases (e.g. the platform
    hash slug that older writes used). On a date present under several slugs
    or sources, recorded beats archive and the canonical slug beats an alias.
    Legacy docs without ``date`` are excluded by the date filter.
    """
    slug_list = [s for s in dict.fromkeys(slugs) if s]
    if not slug_list:
        return []
    docs = list(
        _collection()
        .find(
            {"locationSlug": {"$in": slug_list}, "date": {"$gte": start, "$lte": end}},
            {"_id": 0, "createdAt": 0},
        )
        .sort("date", -1)
    )
    return merge_by_date(docs, slug_list)


def read_history(
    slugs: Iterable[str],
    days: int,
    *,
    lon: float = 0.0,
    now: Optional[datetime] = None,
) -> list[dict]:
    """Docs for the last ``days`` local days (today included), newest first."""
    start, end = window_for_days(days, lon=lon, now=now)
    return read_history_range(slugs, start, end)


def merge_by_date(docs: Iterable[dict], slug_order: list[str]) -> list[dict]:
    """One doc per date (recorded > archive, canonical slug > alias), newest first."""
    order = {s: i for i, s in enumerate(slug_order)}
    best: dict[str, tuple] = {}
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
# Archive providers
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ProviderInfo:
    """Who supplied an archive day and how they must be credited."""

    id: str
    name: str
    attribution: str
    url: str
    licence: str
    licence_url: Optional[str] = None

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "attribution": self.attribution,
            "url": self.url,
            "licence": self.licence,
            "licenceUrl": self.licence_url,
        }


class ProviderError(Exception):
    """An archive fetch failed. ``transient`` failures count against the
    provider's breaker; a client error (our own bad request) does not."""

    def __init__(self, message: str, *, status: Optional[int] = None, transient: bool = True):
        super().__init__(message)
        self.status = status
        self.transient = transient


def _error_for_status(provider_id: str, status: int) -> ProviderError:
    # Only 5xx / 429 say the upstream is unwell. A 4xx is OUR request (bad
    # range or variable) and must not open a breaker that also gates the
    # forecast fallback, AQ, haze and normals.
    return ProviderError(
        f"{provider_id} HTTP {status}", status=status, transient=status >= 500 or status == 429,
    )


class HistoryProvider(Protocol):
    """An external archive that returns daily history for a coordinate."""

    info: ProviderInfo
    breaker: CircuitBreaker
    #: Widest span one upstream request may cover.
    max_span_days: int
    #: Earliest date the provider has data for.
    earliest: str
    #: Upstream calls allowed per ``PROVIDER_BUDGET_WINDOW_S`` (all callers).
    budget_per_hour: int
    #: Whether this deployment may use the provider commercially.
    commercial: bool

    def fetch_daily_range(
        self,
        lat: float,
        lon: float,
        start: str,
        end: str,
        *,
        variables: Optional[Sequence[str]] = None,
        timeout: Optional[float] = None,
    ) -> list[dict]:
        """Canonical days (``{"date": ..., <CANONICAL_DAILY_FIELDS>}``) with a
        non-null daily max AND min, oldest first. Raises ``ProviderError``."""
        ...


def _http(timeout: float):
    from ._http import get_http_client

    return get_http_client(timeout)


# -- NASA POWER --------------------------------------------------------------

NASA_POWER_URL = "https://power.larc.nasa.gov/api/temporal/daily/point"
NASA_POWER_FILL = -999.0

#: POWER parameter -> (canonical field, multiplier). Wind is m/s and pressure
#: kPa upstream; the app stores km/h and hPa.
NASA_POWER_PARAMS: dict[str, tuple[str, float]] = {
    "T2M_MAX": ("temperature_2m_max", 1.0),
    "T2M_MIN": ("temperature_2m_min", 1.0),
    "T2M": ("temperature_2m_mean", 1.0),
    "PRECTOTCORR": ("precipitation_sum", 1.0),
    "RH2M": ("relative_humidity_2m_mean", 1.0),
    "WS10M": ("wind_speed_10m_mean", 3.6),
    "WS10M_MAX": ("wind_speed_10m_max", 3.6),
    "WD10M": ("wind_direction_10m_dominant", 1.0),
    "PS": ("surface_pressure_mean", 10.0),
    "T2MDEW": ("dew_point_2m_mean", 1.0),
    "CLOUD_AMT": ("cloud_cover_mean", 1.0),
}


def derive_weather_code(precip_mm: Optional[float], cloud_pct: Optional[float]) -> Optional[int]:
    """A coarse WMO code for a day from its rain total and mean cloud cover.

    POWER publishes no present-weather code. The dashboard's condition column
    needs one, so we derive it from what POWER does publish: rain first, then
    cloud. Reanalysis drizzles a little on most days, so under 1 mm counts as
    dry. Returns None when the day is dry and the cloud cover isn't known
    (POWER publishes cloud a few months late), rather than guessing "clear".
    """
    if precip_mm is not None:
        if precip_mm >= 10:
            return 63  # moderate rain
        if precip_mm >= 2.5:
            return 61  # slight rain
        if precip_mm >= 1.0:
            return 51  # drizzle / light showers
    if cloud_pct is None:
        return None
    if cloud_pct >= 85:
        return 3
    if cloud_pct >= 50:
        return 2
    if cloud_pct >= 20:
        return 1
    return 0


def apparent_temperature(temp_c: Optional[float], rh_pct: Optional[float], wind_kmh: Optional[float]) -> Optional[float]:
    """Steadman apparent temperature (the formula Open-Meteo uses):
    ``AT = T + 0.33e - 0.70v - 4.00``, with ``e`` the vapour pressure (hPa)
    and ``v`` the wind speed (m/s). Returns None when an input is missing."""
    if temp_c is None or rh_pct is None or wind_kmh is None:
        return None
    import math

    e = (rh_pct / 100.0) * 6.105 * math.exp(17.27 * temp_c / (237.7 + temp_c))
    return round(temp_c + 0.33 * e - 0.70 * (wind_kmh / 3.6) - 4.00, 1)


def sun_times(lat: float, lon: float, day: str, utc_offset_seconds: int) -> tuple[Optional[str], Optional[str]]:
    """Sunrise and sunset for ``day`` as local wall-clock ``YYYY-MM-DDTHH:MM``
    strings (the format Open-Meteo returns), from the NOAA solar equations.

    POWER has no sun times; without them the dashboard's daylight chart and
    average would read 0 h for every POWER day. Returns ``(None, None)`` in
    polar day or night, when the sun doesn't cross the horizon.
    """
    import math

    d = _parse(day)
    n = d.timetuple().tm_yday
    g = 2 * math.pi / 365 * (n - 1)
    eqtime = 229.18 * (
        0.000075 + 0.001868 * math.cos(g) - 0.032077 * math.sin(g)
        - 0.014615 * math.cos(2 * g) - 0.040849 * math.sin(2 * g)
    )
    decl = (
        0.006918 - 0.399912 * math.cos(g) + 0.070257 * math.sin(g)
        - 0.006758 * math.cos(2 * g) + 0.000907 * math.sin(2 * g)
        - 0.002697 * math.cos(3 * g) + 0.00148 * math.sin(3 * g)
    )
    phi = math.radians(lat)
    arg = math.cos(math.radians(90.833)) / (math.cos(phi) * math.cos(decl)) - math.tan(phi) * math.tan(decl)
    if not -1.0 <= arg <= 1.0:
        return None, None
    ha = math.degrees(math.acos(arg))
    midnight = datetime(d.year, d.month, d.day)

    def at(minutes_utc: float) -> str:
        t = midnight + timedelta(minutes=minutes_utc, seconds=utc_offset_seconds)
        return t.strftime("%Y-%m-%dT%H:%M")

    return at(720 - 4 * (lon + ha) - eqtime), at(720 - 4 * (lon - ha) - eqtime)


def parse_nasa_power(payload: dict, *, lat: Optional[float] = None, lon: Optional[float] = None) -> list[dict]:
    """Turn a POWER daily point payload into canonical days (oldest first).

    With ``lat``/``lon``, each day also gets computed sunrise/sunset."""
    params = ((payload or {}).get("properties") or {}).get("parameter") or {}
    if not isinstance(params, dict):
        return []
    fill = ((payload or {}).get("header") or {}).get("fill_value", NASA_POWER_FILL)
    dates: set[str] = set()
    for series in params.values():
        if isinstance(series, dict):
            dates.update(series.keys())

    out: list[dict] = []
    for raw in sorted(dates):
        if len(raw) != 8 or not raw.isdigit():
            continue
        day: dict = {"date": f"{raw[:4]}-{raw[4:6]}-{raw[6:]}"}
        for param, (field, factor) in NASA_POWER_PARAMS.items():
            value = (params.get(param) or {}).get(raw)
            if value is None or value == fill or value == NASA_POWER_FILL:
                continue
            try:
                number = float(value)
            except (TypeError, ValueError):
                continue
            if param == "WD10M" and not 0 <= number <= 360:
                # POWER's daily wind direction is currently out of range
                # (large negative numbers). Drop it rather than store nonsense.
                continue
            day[field] = round(number * factor, 2)
        if day.get("temperature_2m_max") is None or day.get("temperature_2m_min") is None:
            continue  # not published yet (a few days' lag) or a fill value
        code = derive_weather_code(day.get("precipitation_sum"), day.get("cloud_cover_mean"))
        if code is not None:
            day["weather_code"] = code
        # POWER has no apparent temperature. Derive it from the day's
        # temperatures with the mean humidity and wind (an approximation for
        # the max/min, which is all a daily archive can give).
        rh, wind = day.get("relative_humidity_2m_mean"), day.get("wind_speed_10m_mean")
        for src, dst in (
            ("temperature_2m_max", "apparent_temperature_max"),
            ("temperature_2m_min", "apparent_temperature_min"),
            ("temperature_2m_mean", "apparent_temperature_mean"),
        ):
            at = apparent_temperature(day.get(src), rh, wind)
            if at is not None:
                day[dst] = at
        if lat is not None and lon is not None:
            rise, set_ = sun_times(float(lat), float(lon), day["date"], estimate_utc_offset_seconds(lon))
            if rise and set_:
                day["sunrise"], day["sunset"] = rise, set_
        out.append(day)
    return out


class NasaPowerProvider:
    """NASA POWER daily point API: free, keyless, open for commercial use.

    MERRA-2 / GEOS-IT assimilation (~0.5° x 0.625°), daily from 1981, about
    two to three days behind real time. One request returns decades of data
    in about 1.5 s, so a 10-year span is a single call.
    """

    info = ProviderInfo(
        id=SOURCE_NASA_POWER,
        name="NASA POWER",
        attribution=(
            "Data obtained from the NASA Langley Research Center (LaRC) POWER "
            "Project, funded through the NASA Earth Science/Applied Science Program"
        ),
        url="https://power.larc.nasa.gov",
        licence="NASA open data (no restrictions on use)",
        licence_url="https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-information-policy",
    )
    breaker = nasa_power_breaker
    max_span_days = 3660
    earliest = "1981-01-01"
    budget_per_hour = 600  # POWER asks for equitable use; ~10 calls a minute
    commercial = True
    timeout_s = 12.0

    def fetch_daily_range(self, lat, lon, start, end, *, variables=None, timeout=None):
        wanted = set(variables or CANONICAL_DAILY_FIELDS)
        params = [p for p, (field, _) in NASA_POWER_PARAMS.items() if field in wanted]
        if not params:
            params = ["T2M_MAX", "T2M_MIN"]
        for required in ("T2M_MAX", "T2M_MIN"):
            if required not in params:
                params.append(required)
        try:
            resp = _http(timeout or self.timeout_s).get(
                NASA_POWER_URL,
                params={
                    "parameters": ",".join(params),
                    "community": "AG",
                    "latitude": f"{float(lat):.4f}",
                    "longitude": f"{float(lon):.4f}",
                    "start": start.replace("-", ""),
                    "end": end.replace("-", ""),
                    "format": "JSON",
                },
            )
        except Exception as exc:  # noqa: BLE001
            raise ProviderError(f"nasa-power request failed: {type(exc).__name__}") from exc
        if resp.status_code != 200:
            raise _error_for_status(self.info.id, resp.status_code)
        try:
            payload = resp.json()
        except Exception as exc:  # noqa: BLE001
            raise ProviderError("nasa-power returned invalid JSON") from exc
        return parse_nasa_power(payload, lat=lat, lon=lon)


# -- Open-Meteo Historical / Archive ----------------------------------------

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
#: Commercial (paid plan) host; used with an ``apikey`` when one is stored.
ARCHIVE_URL_COMMERCIAL = "https://customer-archive-api.open-meteo.com/v1/archive"
ARCHIVE_TIMEOUT_S = 8.0
#: Max days a single archive request may span.
ARCHIVE_MAX_SPAN_DAYS = 366

_om_key_cache: dict[str, tuple[float, Optional[str]]] = {}
_OM_KEY_TTL_S = 300


def _open_meteo_key() -> Optional[str]:
    """The Open-Meteo commercial key from ``api_keys`` (5-min cache), or None."""
    cached = _om_key_cache.get("key")
    if cached and time.monotonic() - cached[0] < _OM_KEY_TTL_S:
        return cached[1]
    key: Optional[str] = None
    try:
        from ._db import get_api_key

        key = get_api_key("open-meteo") or None
    except Exception:  # noqa: BLE001
        key = None
    _om_key_cache["key"] = (time.monotonic(), key)
    return key


def parse_open_meteo_daily(payload: dict) -> list[dict]:
    """Turn an Open-Meteo archive payload into canonical days (oldest first)."""
    daily = (payload or {}).get("daily") or {}
    times = daily.get("time") or []
    out: list[dict] = []
    for i, date in enumerate(times):
        if not isinstance(date, str):
            continue
        day: dict = {"date": date}
        for field in CANONICAL_DAILY_FIELDS:
            arr = daily.get(field) or []
            value = arr[i] if i < len(arr) else None
            if value is not None:
                day[field] = value
        # Archive lag: the newest days come back as nulls. Skip and retry later.
        if day.get("temperature_2m_max") is None or day.get("temperature_2m_min") is None:
            continue
        out.append(day)
    return out


class OpenMeteoArchiveProvider:
    """Open-Meteo Historical Weather API (ERA5 0.25° from 1940, best-match blend).

    The free host is NON-COMMERCIAL. When an ``open-meteo`` key is stored in
    ``api_keys`` (Professional plan or above), the commercial host is used and
    ``commercial`` is True.
    """

    info = ProviderInfo(
        id=SOURCE_OPEN_METEO_ARCHIVE,
        name="Open-Meteo (ERA5)",
        attribution="Weather data by Open-Meteo.com, from ERA5 (Copernicus Climate Change Service / ECMWF)",
        url="https://open-meteo.com",
        licence="CC BY 4.0",
        licence_url="https://creativecommons.org/licenses/by/4.0/",
    )
    breaker = open_meteo_breaker
    max_span_days = ARCHIVE_MAX_SPAN_DAYS
    earliest = EARLIEST_DATE
    budget_per_hour = 200  # free tier is 5,000/h shared with forecasts, AQ and haze

    @property
    def commercial(self) -> bool:
        return bool(_open_meteo_key())

    def fetch_daily_range(self, lat, lon, start, end, *, variables=None, timeout=None):
        fields = [f for f in (variables or CANONICAL_DAILY_FIELDS) if f in CANONICAL_DAILY_FIELDS]
        for required in ("temperature_2m_max", "temperature_2m_min"):
            if required not in fields:
                fields.append(required)
        params = {
            "latitude": str(lat),
            "longitude": str(lon),
            "start_date": start,
            "end_date": end,
            "timezone": "auto",
            "daily": ",".join(fields),
        }
        key = _open_meteo_key()
        url = ARCHIVE_URL
        if key:
            # Open-Meteo only accepts the key as a query parameter. The log
            # redaction filter (_logging.py) masks `apikey` in every record.
            url = ARCHIVE_URL_COMMERCIAL
            params["apikey"] = key
        try:
            resp = _http(timeout or ARCHIVE_TIMEOUT_S).get(url, params=params)
        except Exception as exc:  # noqa: BLE001
            raise ProviderError(f"open-meteo-archive request failed: {type(exc).__name__}") from exc
        if resp.status_code != 200:
            raise _error_for_status(self.info.id, resp.status_code)
        try:
            payload = resp.json()
        except Exception as exc:  # noqa: BLE001
            raise ProviderError("open-meteo-archive returned invalid JSON") from exc
        return parse_open_meteo_daily(payload)


PROVIDERS: dict[str, HistoryProvider] = {
    SOURCE_NASA_POWER: NasaPowerProvider(),
    SOURCE_OPEN_METEO_ARCHIVE: OpenMeteoArchiveProvider(),
}

#: Default chain: NASA POWER (commercially safe) first, then Open-Meteo.
DEFAULT_PROVIDER_CHAIN = (SOURCE_NASA_POWER, SOURCE_OPEN_METEO_ARCHIVE)


def provider_chain(config: Optional[str] = None) -> list[HistoryProvider]:
    """Providers in configured order.

    ``HISTORY_PROVIDERS`` is a comma list of provider ids. Unknown ids are
    ignored, and an empty or unusable value falls back to the default chain.
    """
    raw = config if config is not None else os.environ.get("HISTORY_PROVIDERS", "")
    ids = [p.strip() for p in raw.split(",") if p.strip()]
    chain = [PROVIDERS[i] for i in dict.fromkeys(ids) if i in PROVIDERS]
    if not chain:
        chain = [PROVIDERS[i] for i in DEFAULT_PROVIDER_CHAIN]
    if commercial_only():
        chain = [p for p in chain if p.commercial]
    return chain


def commercial_only() -> bool:
    """``HISTORY_COMMERCIAL_ONLY=1`` keeps only providers this deployment may
    use commercially: NASA POWER always, Open-Meteo only with a paid key.
    Turn it on when the product starts charging (#238)."""
    return os.environ.get("HISTORY_COMMERCIAL_ONLY", "").strip().lower() in ("1", "true", "yes")


def provider_info(source: str) -> Optional[dict]:
    """Attribution for a stored ``source`` id, or None for recorded/unknown."""
    provider = PROVIDERS.get(source)
    return provider.info.as_dict() if provider else None


def attributions_for(docs: Iterable[dict]) -> list[dict]:
    """One attribution entry per archive source present in ``docs``."""
    seen: list[str] = []
    for doc in docs:
        source = doc.get("source")
        if source and source != SOURCE_RECORDED and source not in seen:
            seen.append(source)
    return [info for info in (provider_info(s) for s in seen) if info]


# ---------------------------------------------------------------------------
# Archive docs
# ---------------------------------------------------------------------------


def build_history_doc(slug: str, day: dict, *, source: str, now: Optional[datetime] = None) -> dict:
    """A ``weather_history`` doc for one canonical archive day."""
    now = now or datetime.now(timezone.utc)
    date = day["date"]

    def v(key):
        return day.get(key)

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
    # `current` holds DAILY MEANS for archive days (there is no "current" for
    # a past day), so the dashboard's current-based columns (humidity, cloud,
    # pressure, wind) are populated. `aggregation` says so.
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
        "uv_index": None,  # not available from the reanalysis archives
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
        "source": source,
        "provider": source,
        "aggregation": "daily-mean",
        "current": current,
        "daily": day_daily,
        "recordedAt": now,
        "createdAt": now,
    }
    if insights:
        doc["insights"] = insights
    return doc


def build_archive_docs(slug: str, payload: dict, wanted: Iterable[str], *, now: Optional[datetime] = None) -> list[dict]:
    """Open-Meteo archive payload -> history docs for the ``wanted`` dates."""
    wanted_set = set(wanted)
    return [
        build_history_doc(slug, day, source=SOURCE_OPEN_METEO_ARCHIVE, now=now)
        for day in parse_open_meteo_daily(payload)
        if day["date"] in wanted_set
    ]


# ---------------------------------------------------------------------------
# Backfill: DB first, then pull only the missing dates
# ---------------------------------------------------------------------------


def missing_dates(existing: Iterable[str], start: str, end: str, *, lon: float, now: Optional[datetime] = None) -> list[str]:
    """Past dates in ``start..end`` with no stored doc, oldest first.

    Today and future dates are excluded: today is recorded live by
    ``/api/py/weather``, and no archive has it yet.
    """
    yesterday = _iso(_parse(local_today(lon, now)) - timedelta(days=1))
    last = min(end, yesterday)
    first = max(start, EARLIEST_DATE)
    if first > last:
        return []
    have = set(existing)
    return [d for d in date_span(first, last) if d not in have]


def missing_past_dates(existing: Iterable[str], days: int, *, lon: float, now: Optional[datetime] = None) -> list[str]:
    """``missing_dates`` for the last ``days`` local days."""
    start, end = window_for_days(min(max(1, days), MAX_RANGE_DAYS), lon=lon, now=now)
    return missing_dates(existing, start, end, lon=lon, now=now)


def group_runs(dates: Sequence[str], *, max_gap_days: int = RUN_MERGE_GAP_DAYS) -> list[tuple[str, str]]:
    """Sorted dates -> ``(start, end)`` spans. Spans closer than ``max_gap_days``
    are merged, so a few stored days in the middle don't split one fetch."""
    runs: list[list[str]] = []
    for d in sorted(set(dates)):
        if runs and (_parse(d) - _parse(runs[-1][1])).days <= max_gap_days:
            runs[-1][1] = d
        else:
            runs.append([d, d])
    return [(a, b) for a, b in runs]


def split_span(start: str, end: str, max_days: int) -> list[tuple[str, str]]:
    """Split ``start..end`` into chunks of at most ``max_days``, NEWEST first,
    so a request that runs out of budget has filled the most recent days."""
    s, e = _parse(start), _parse(end)
    chunks: list[tuple[str, str]] = []
    hi = e
    while hi >= s:
        lo = max(s, hi - timedelta(days=max_days - 1))
        chunks.append((_iso(lo), _iso(hi)))
        hi = lo - timedelta(days=1)
    return chunks


def _cooldown_blocks(slug: str, start: str, end: str) -> bool:
    """True when a successful attempt in the last hour already covered
    ``start..end`` (or a wider span)."""
    now = time.monotonic()
    attempts = [a for a in _backfill_attempts.get(slug, []) if now - a[0] <= BACKFILL_COOLDOWN_S]
    if attempts:
        _backfill_attempts[slug] = attempts
    else:
        _backfill_attempts.pop(slug, None)
    return any(a_start <= start and end <= a_end for _, a_start, a_end in attempts)


#: Bound on remembered cooldowns per warm instance. Coordinate requests mint
#: a key per 0.05° cell, so the map must not grow without limit.
MAX_COOLDOWN_KEYS = 5000


def _note_attempt(slug: str, start: str, end: str) -> None:
    now = time.monotonic()
    if slug not in _backfill_attempts and len(_backfill_attempts) >= MAX_COOLDOWN_KEYS:
        for key in [k for k, v in _backfill_attempts.items() if all(now - a[0] > BACKFILL_COOLDOWN_S for a in v)]:
            del _backfill_attempts[key]
        while len(_backfill_attempts) >= MAX_COOLDOWN_KEYS:
            del _backfill_attempts[next(iter(_backfill_attempts))]  # oldest inserted
    _backfill_attempts.setdefault(slug, []).append((now, start, end))


def _budget_allows(provider: HistoryProvider, rate_limiter) -> bool:
    """Spend one call from the provider's global hourly budget."""
    if rate_limiter is None:
        return True
    try:
        result = rate_limiter(
            "global", f"history-provider:{provider.info.id}",
            provider.budget_per_hour, PROVIDER_BUDGET_WINDOW_S,
        )
    except Exception:  # noqa: BLE001
        return True
    return bool((result or {}).get("allowed", True))


def backfill_range(
    slug: str,
    lat: float,
    lon: float,
    start: str,
    end: str,
    existing_dates: Iterable[str],
    *,
    providers: Optional[Sequence[HistoryProvider]] = None,
    client_ip: Optional[str] = None,
    rate_limiter: Optional[Callable] = None,
    ip_bucket: str = "history-backfill",
    ip_limit: int = BACKFILL_RATE_LIMIT,
    now: Optional[datetime] = None,
    clock: Callable[[], float] = time.monotonic,
) -> list[dict]:
    """Fill the dates in ``start..end`` we don't hold, from the provider chain.

    Never raises. Gating: the per-location cooldown, the per-IP
    ``history-backfill`` limit, each provider's breaker and hourly budget, and
    ``MAX_FETCHES_PER_CALL`` / ``BACKFILL_TIME_BUDGET_S`` per request.

    Dates are fetched in runs, newest first. A provider that fails or has
    nothing for some dates leaves them to the next provider. Returns the new
    docs, which are already stored insert-only (``$setOnInsert``), so a stored
    day is never overwritten.
    """
    try:
        missing = missing_dates(existing_dates, start, end, lon=lon, now=now)
        if not missing:
            return []
        if _cooldown_blocks(slug, missing[0], missing[-1]):
            return []
        chain = list(providers) if providers is not None else provider_chain()
        if not chain:
            return []
        if rate_limiter is not None and client_ip:
            if not rate_limiter(client_ip, ip_bucket, ip_limit, BACKFILL_RATE_WINDOW_S).get("allowed", True):
                return []

        started = clock()
        fetches = 0
        complete = True  # every run was tried by every provider it needed
        persisted = True
        unusable: set[str] = set()  # providers that failed or ran out this call
        docs: list[dict] = []

        def out_of_budget() -> bool:
            return fetches >= MAX_FETCHES_PER_CALL or clock() - started > BACKFILL_TIME_BUDGET_S

        for run_start, run_end in reversed(group_runs(missing)):
            remaining = {d for d in missing if run_start <= d <= run_end}
            for provider in chain:
                if not remaining:
                    break
                pid = provider.info.id
                if pid in unusable:
                    continue
                lo, hi = max(min(remaining), provider.earliest), max(remaining)
                if lo > hi:
                    continue
                for c_start, c_end in split_span(lo, hi, provider.max_span_days):
                    if not any(c_start <= d <= c_end for d in remaining):
                        continue
                    if out_of_budget():
                        break
                    if not provider.breaker.is_allowed or not _budget_allows(provider, rate_limiter):
                        unusable.add(pid)
                        complete = False
                        break
                    fetches += 1
                    try:
                        days = provider.fetch_daily_range(lat, lon, c_start, c_end)
                    except ProviderError as exc:
                        if exc.transient:
                            provider.breaker.record_failure()
                            complete = False
                        logger.warning("History provider %s failed for %s %s..%s: %s", pid, slug, c_start, c_end, exc)
                        unusable.add(pid)
                        break
                    provider.breaker.record_success()
                    chunk_docs = [
                        build_history_doc(slug, day, source=pid, now=now)
                        for day in days
                        if day.get("date") in remaining
                    ]
                    for doc in chunk_docs:
                        remaining.discard(doc["date"])
                    # Save each chunk as it lands, so a request cut short by
                    # the function's time limit keeps what it already fetched.
                    if chunk_docs:
                        persisted = _upsert_archive_docs(chunk_docs) and persisted
                        docs.extend(chunk_docs)
            if remaining and out_of_budget():
                # Stopped by the per-call caps with dates still to try.
                complete = False

        # Cool down only after an attempt in which every provider was tried,
        # each one answered, and everything was saved. A transient failure, a
        # budget cut or a cap cut is retried on the next view, which then
        # fetches only what is still missing.
        if persisted and complete:
            _note_attempt(slug, missing[0], missing[-1])
        docs.sort(key=lambda d: d["date"], reverse=True)
        return docs
    except Exception as exc:  # noqa: BLE001
        logger.warning("History backfill failed for %s: %s", slug, exc)
        return []


def backfill_history(
    slug: str,
    lat: float,
    lon: float,
    days: int,
    existing_dates: Iterable[str],
    **kwargs,
) -> list[dict]:
    """``backfill_range`` for the last ``days`` local days."""
    start, end = window_for_days(min(max(1, days), MAX_RANGE_DAYS), lon=lon, now=kwargs.get("now"))
    return backfill_range(slug, lat, lon, start, end, existing_dates, **kwargs)


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
        # Duplicate-key races with a concurrent writer are harmless here,
        # because the other writer's doc is at least as good. Anything else
        # is a real failure.
        if type(exc).__name__ == "BulkWriteError":
            return True
        logger.warning("Archive history upsert failed: %s", exc)
        return False


# ---------------------------------------------------------------------------
# Climate normals through the same chain
# ---------------------------------------------------------------------------


def fetch_normals_series(
    lat: float,
    lon: float,
    start: str,
    end: str,
    *,
    providers: Optional[Sequence[HistoryProvider]] = None,
    rate_limiter: Optional[Callable] = None,
    timeout: float = 20.0,
) -> tuple[Optional[dict], Optional[HistoryProvider], Optional[str]]:
    """Daily max/min for ``start..end`` from the first provider that answers.

    Returns ``(daily, provider, reason)``. ``daily`` is an Open-Meteo-shaped
    ``{"time": [...], "temperature_2m_max": [...], "temperature_2m_min": [...]}``,
    or None with ``reason`` = ``circuit_open`` | ``upstream_error`` | ``no_data``.
    The span is fetched in one call per provider (normals need it whole).
    """
    chain = list(providers) if providers is not None else provider_chain()
    reason = "circuit_open"
    for provider in chain:
        if provider.earliest > start:
            continue
        if not provider.breaker.is_allowed or not _budget_allows(provider, rate_limiter):
            continue
        try:
            days = provider.fetch_daily_range(
                lat, lon, start, end,
                variables=("temperature_2m_max", "temperature_2m_min"),
                timeout=timeout,
            )
        except ProviderError as exc:
            if exc.transient:
                provider.breaker.record_failure()
            logger.warning("Normals provider %s failed: %s", provider.info.id, exc)
            reason = "upstream_error"
            continue
        provider.breaker.record_success()
        if not days:
            reason = "no_data"
            continue
        return (
            {
                "time": [d["date"] for d in days],
                "temperature_2m_max": [d.get("temperature_2m_max") for d in days],
                "temperature_2m_min": [d.get("temperature_2m_min") for d in days],
            },
            provider,
            None,
        )
    return None, None, reason
