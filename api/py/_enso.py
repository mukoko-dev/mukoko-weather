"""
ENSO outlook endpoint — El Niño / La Niña phase from NOAA CPC's Oceanic Niño Index.

Source: ``https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt``. The file is
a plain-text table with columns ``SEAS YR TOTAL ANOM``; ``ANOM`` is the ONI, the
3-month running mean of sea-surface temperature anomalies in the Niño-3.4 box.
Rows are chronological, so the last row is the most recent season.

Phase thresholds follow the CPC convention (ONI ≥ +0.5 El Niño, ≤ −0.5 La Niña).
Strength buckets use the absolute ONI value (weak 0.5–0.9, moderate 1.0–1.4,
strong 1.5–1.9, very strong ≥ 2.0).

The upstream file changes once a month, so responses are cached in memory for
12 hours. Calls go through ``noaa_breaker``. The endpoint never fails the page:
on any upstream error, or when the breaker is open, it returns HTTP 200 with
``available: false``.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Literal, Optional

import httpx
from fastapi import APIRouter
from pydantic import BaseModel

from ._circuit_breaker import noaa_breaker, CircuitOpenError

router = APIRouter()


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

ONI_URL = "https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt"

#: In-memory cache lifetime for the parsed ONI table (seconds).
ENSO_CACHE_TTL_SECONDS = 12 * 60 * 60

#: Number of most recent seasons returned as the series.
SERIES_LENGTH = 6

SOURCE_LABEL = "NOAA CPC ONI"

#: Three-month season codes as they appear in the ONI file.
SEASON_CODES = frozenset(
    ["DJF", "JFM", "FMA", "MAM", "AMJ", "MJJ", "JJA", "JAS", "ASO", "SON", "OND", "NDJ"]
)

PhaseName = Literal["El Niño", "La Niña", "Neutral"]
StrengthName = Literal["weak", "moderate", "strong", "very strong"]


# ---------------------------------------------------------------------------
# Response models (OpenAPI contract)
# ---------------------------------------------------------------------------


class EnsoSeason(BaseModel):
    """One three-month ONI season."""

    season: str
    year: int
    oni: float


class EnsoOutlookResponse(BaseModel):
    """Latest ENSO state. When ``available`` is false, the other fields are null."""

    available: bool
    season: Optional[str] = None
    year: Optional[int] = None
    oni: Optional[float] = None
    phase: Optional[PhaseName] = None
    strength: Optional[StrengthName] = None
    series: list[EnsoSeason] = []
    source: str = SOURCE_LABEL
    fetchedAt: Optional[str] = None


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def phase_for(oni: float) -> PhaseName:
    """CPC phase convention: ≥ +0.5 El Niño, ≤ −0.5 La Niña, otherwise Neutral."""
    if oni >= 0.5:
        return "El Niño"
    if oni <= -0.5:
        return "La Niña"
    return "Neutral"


def strength_for(oni: float) -> Optional[StrengthName]:
    """Strength of the event by absolute ONI. ``None`` when the phase is Neutral."""
    magnitude = abs(oni)
    if magnitude >= 2.0:
        return "very strong"
    if magnitude >= 1.5:
        return "strong"
    if magnitude >= 1.0:
        return "moderate"
    if magnitude >= 0.5:
        return "weak"
    return None


def parse_oni_text(text: str) -> list[EnsoSeason]:
    """
    Parse the CPC ONI ASCII table into chronological seasons.

    Skips the header and any malformed line. Raises ``ValueError`` when no
    valid rows are found, so an HTML error page or an empty body counts as a
    failure rather than an empty series.
    """
    seasons: list[EnsoSeason] = []
    for raw in text.splitlines():
        parts = raw.split()
        if len(parts) != 4:
            continue
        season, year_s, _total, anom_s = parts
        if season not in SEASON_CODES:
            continue
        try:
            year = int(year_s)
            oni = float(anom_s)
        except ValueError:
            continue
        seasons.append(EnsoSeason(season=season, year=year, oni=oni))
    if not seasons:
        raise ValueError("No ONI rows found in NOAA CPC response")
    return seasons


def build_outlook(seasons: list[EnsoSeason], fetched_at: str) -> EnsoOutlookResponse:
    """Turn the parsed table into the response payload (latest season + tail series)."""
    latest = seasons[-1]
    return EnsoOutlookResponse(
        available=True,
        season=latest.season,
        year=latest.year,
        oni=latest.oni,
        phase=phase_for(latest.oni),
        strength=strength_for(latest.oni),
        series=seasons[-SERIES_LENGTH:],
        source=SOURCE_LABEL,
        fetchedAt=fetched_at,
    )


def _unavailable() -> EnsoOutlookResponse:
    return EnsoOutlookResponse(available=False)


# ---------------------------------------------------------------------------
# Upstream client + cache
# ---------------------------------------------------------------------------

_http_client: Optional[httpx.Client] = None
_cache: dict = {"at": 0.0, "payload": None}


def _get_http() -> httpx.Client:
    global _http_client
    if _http_client is None:
        _http_client = httpx.Client(timeout=8.0)
    return _http_client


def _fetch_oni_text() -> str:
    """Blocking GET of the ONI table. Raises on HTTP error (breaker records it)."""
    resp = _get_http().get(ONI_URL)
    resp.raise_for_status()
    return resp.text


async def _run_sync(fn):
    """Run a blocking call on the executor so the async breaker can time it out."""
    import asyncio

    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, fn)


def _cached() -> Optional[EnsoOutlookResponse]:
    payload = _cache["payload"]
    if payload is not None and time.time() - _cache["at"] < ENSO_CACHE_TTL_SECONDS:
        return payload
    return None


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


@router.get("/api/py/enso", response_model=EnsoOutlookResponse)
async def get_enso() -> EnsoOutlookResponse:
    """
    GET /api/py/enso

    Latest El Niño / La Niña state from NOAA CPC's ONI table, with the last
    six seasons as a series. Global (not location-specific); the frontend
    applies region-aware impact guidance.
    """
    cached = _cached()
    if cached is not None:
        return cached

    if not noaa_breaker.is_allowed:
        return _unavailable()

    try:
        text = await noaa_breaker.execute(
            lambda: _run_sync(_fetch_oni_text)
        )
        seasons = parse_oni_text(text)
    except CircuitOpenError:
        return _unavailable()
    except Exception:
        return _unavailable()

    payload = build_outlook(seasons, datetime.now(timezone.utc).isoformat())
    _cache["at"] = time.time()
    _cache["payload"] = payload
    return payload
