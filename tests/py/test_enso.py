"""
Tests for _enso.py — ONI parsing, phase/strength thresholds, cache, and failure
handling. Upstream HTTP is always mocked; nothing touches the network.

Covers:
  * Phase thresholds incl. the ±0.5 boundaries
  * Strength buckets incl. the 0.5 / 1.0 / 1.5 / 2.0 boundaries
  * Parsing a CPC-format sample (header, chronology, latest + 6-season series)
  * Malformed upstream body → ValueError (treated as unavailable)
  * Upstream failure and open breaker → 200 with available: false
  * 12 h in-memory cache avoids a second upstream call
"""

from __future__ import annotations

import time
from unittest.mock import MagicMock, patch

import httpx
import pytest

from py._enso import (
    ENSO_CACHE_TTL_SECONDS,
    EnsoOutlookResponse,
    _cache,
    build_outlook,
    get_enso,
    parse_oni_text,
    phase_for,
    strength_for,
)
from py._circuit_breaker import _circuit_states, _CircuitState


SAMPLE_ONI = """SEAS YR  TOTAL ANOM
DJF 2025  26.15  -0.39
JFM 2025  26.57  -0.21
FMA 2025  27.34   0.11
MAM 2025  28.09   0.46
AMJ 2025  28.74   0.95
MJJ 2025  29.02   1.39
JJA 2025  29.09   1.80
JAS 2025  29.12   2.16
this line is not a data row
ASO 2025  26.33  -0.43
SON 2025  26.14  -0.57
OND 2025  26.04  -0.61
NDJ 2025  25.96  -0.60

"""


@pytest.fixture(autouse=True)
def _reset_state():
    """Each test starts with a clean breaker and an empty cache."""
    _circuit_states.clear()
    _cache["at"] = 0.0
    _cache["payload"] = None
    yield
    _circuit_states.clear()
    _cache["at"] = 0.0
    _cache["payload"] = None


def _mock_http(text: str = SAMPLE_ONI) -> MagicMock:
    client = MagicMock()
    response = MagicMock()
    response.text = text
    response.raise_for_status = MagicMock()
    client.get.return_value = response
    return client


# ---------------------------------------------------------------------------
# Phase thresholds
# ---------------------------------------------------------------------------


class TestPhaseFor:
    def test_exactly_plus_half_is_el_nino(self):
        assert phase_for(0.5) == "El Niño"

    def test_just_below_plus_half_is_neutral(self):
        assert phase_for(0.49) == "Neutral"

    def test_exactly_minus_half_is_la_nina(self):
        assert phase_for(-0.5) == "La Niña"

    def test_just_above_minus_half_is_neutral(self):
        assert phase_for(-0.49) == "Neutral"

    def test_zero_is_neutral(self):
        assert phase_for(0.0) == "Neutral"

    def test_large_positive_is_el_nino(self):
        assert phase_for(2.16) == "El Niño"

    def test_large_negative_is_la_nina(self):
        assert phase_for(-1.8) == "La Niña"


# ---------------------------------------------------------------------------
# Strength buckets
# ---------------------------------------------------------------------------


class TestStrengthFor:
    def test_neutral_has_no_strength(self):
        assert strength_for(0.0) is None
        assert strength_for(0.49) is None
        assert strength_for(-0.49) is None

    def test_weak_lower_boundary(self):
        assert strength_for(0.5) == "weak"
        assert strength_for(-0.5) == "weak"

    def test_weak_upper_region(self):
        assert strength_for(0.99) == "weak"

    def test_moderate_boundaries(self):
        assert strength_for(1.0) == "moderate"
        assert strength_for(1.49) == "moderate"

    def test_strong_boundaries(self):
        assert strength_for(1.5) == "strong"
        assert strength_for(1.99) == "strong"

    def test_very_strong_boundary(self):
        assert strength_for(2.0) == "very strong"
        assert strength_for(2.16) == "very strong"

    def test_strength_uses_absolute_value_for_la_nina(self):
        assert strength_for(-1.0) == "moderate"
        assert strength_for(-2.3) == "very strong"


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


class TestParseOniText:
    def test_skips_header_blank_and_malformed_lines(self):
        seasons = parse_oni_text(SAMPLE_ONI)
        assert len(seasons) == 12
        assert seasons[0].season == "DJF"
        assert seasons[0].year == 2025

    def test_preserves_chronological_order_and_values(self):
        seasons = parse_oni_text(SAMPLE_ONI)
        assert seasons[-1].season == "NDJ"
        assert seasons[-1].oni == -0.60

    def test_empty_body_raises(self):
        with pytest.raises(ValueError):
            parse_oni_text("")

    def test_html_error_page_raises(self):
        with pytest.raises(ValueError):
            parse_oni_text("<html><body>Service Unavailable</body></html>")


class TestBuildOutlook:
    def test_latest_season_phase_strength_and_series(self):
        seasons = parse_oni_text(SAMPLE_ONI)
        # Latest row in the sample is NDJ 2025 (-0.60) → La Niña, weak.
        out = build_outlook(seasons, "2026-10-08T00:00:00+00:00")
        assert out.available is True
        assert out.season == "NDJ"
        assert out.year == 2025
        assert out.oni == -0.60
        assert out.phase == "La Niña"
        assert out.strength == "weak"
        assert out.source == "NOAA CPC ONI"
        assert out.fetchedAt == "2026-10-08T00:00:00+00:00"
        assert len(out.series) == 6
        assert out.series[-1].season == "NDJ"
        assert out.series[0].season == seasons[-6].season

    def test_series_is_last_six_in_order(self):
        seasons = parse_oni_text(SAMPLE_ONI)
        out = build_outlook(seasons, "x")
        assert [(s.season, s.year) for s in out.series] == [
            (s.season, s.year) for s in seasons[-6:]
        ]


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


class TestGetEnso:
    async def test_success_returns_available_payload(self):
        with patch("py._enso._get_http", return_value=_mock_http()):
            out = await get_enso()
        assert isinstance(out, EnsoOutlookResponse)
        assert out.available is True
        assert out.season == "NDJ"
        assert out.phase == "La Niña"

    async def test_upstream_failure_returns_unavailable(self):
        client = MagicMock()
        client.get.side_effect = httpx.ConnectError("boom")
        with patch("py._enso._get_http", return_value=client):
            out = await get_enso()
        assert out.available is False
        assert out.phase is None
        assert out.series == []

    async def test_http_error_status_returns_unavailable(self):
        client = _mock_http()
        client.get.return_value.raise_for_status.side_effect = httpx.HTTPStatusError(
            "503", request=MagicMock(), response=MagicMock()
        )
        with patch("py._enso._get_http", return_value=client):
            out = await get_enso()
        assert out.available is False

    async def test_malformed_body_returns_unavailable(self):
        with patch("py._enso._get_http", return_value=_mock_http("<html>oops</html>")):
            out = await get_enso()
        assert out.available is False

    async def test_open_breaker_returns_unavailable_without_fetching(self):
        _circuit_states["noaa-cpc"] = _CircuitState(
            state="open", last_opened_at=time.time()
        )
        client = _mock_http()
        with patch("py._enso._get_http", return_value=client):
            out = await get_enso()
        assert out.available is False
        client.get.assert_not_called()

    async def test_cache_avoids_second_upstream_call(self):
        client = _mock_http()
        with patch("py._enso._get_http", return_value=client):
            first = await get_enso()
            second = await get_enso()
        assert first.available and second.available
        assert client.get.call_count == 1

    async def test_expired_cache_refetches(self):
        client = _mock_http()
        with patch("py._enso._get_http", return_value=client):
            await get_enso()
            _cache["at"] = time.time() - ENSO_CACHE_TTL_SECONDS - 1
            await get_enso()
        assert client.get.call_count == 2

    async def test_failures_are_not_cached(self):
        client = MagicMock()
        client.get.side_effect = httpx.ConnectError("boom")
        with patch("py._enso._get_http", return_value=client):
            await get_enso()
        assert _cache["payload"] is None


# ---------------------------------------------------------------------------
# Threshold helper consistency
# ---------------------------------------------------------------------------


class TestPhaseStrengthConsistency:
    @pytest.mark.parametrize("oni", [-2.5, -1.2, -0.5, 0.0, 0.5, 1.2, 2.5])
    def test_neutral_iff_no_strength(self, oni):
        neutral = phase_for(oni) == "Neutral"
        assert neutral == (strength_for(oni) is None)
