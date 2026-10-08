"""Tests for the haze endpoint — classification, seasons, official adapters, cache, failure paths."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from py import _haze
from py._circuit_breaker import CircuitOpenError
from py._haze import (
    HAZE_SEASONS,
    OFFICIAL_SOURCES,
    analyse,
    active_season,
    classify_level,
    classify_type,
    fetch_official,
    headline_for,
    is_mist,
    parse_sg_psi,
    pm_level,
    psi_band,
    vis_level,
    _window_months,
)

NOW = datetime(2026, 10, 8, 12, 0, tzinfo=timezone.utc)
MONTH = 10  # matches NOW for season lookups


# ---------------------------------------------------------------------------
# Fixture builders — Open-Meteo-shaped payloads, 48 hourly steps from midnight.
# Current hour is index 12 (12:00 local).
# ---------------------------------------------------------------------------


def _times() -> list[str]:
    return [f"2026-10-{8 + h // 24:02d}T{h % 24:02d}:00" for h in range(48)]


def make_payloads(
    *,
    pm25: float | None = 10.0,
    pm10: float | None = 20.0,
    dust: float | None = 0.0,
    aod: float | None = 0.2,
    us_aqi: int | None = 50,
    rh: float | None = 60.0,
    vis_m: float | None = 20000.0,
    pm_series: list[float | None] | None = None,
):
    times = _times()
    pm_hourly = pm_series if pm_series is not None else [pm25] * 48
    aq = {
        "current": {
            "time": "2026-10-08T12:00",
            "pm2_5": pm25,
            "pm10": pm10,
            "dust": dust,
            "aerosol_optical_depth": aod,
            "us_aqi": us_aqi,
        },
        "hourly": {
            "time": times,
            "pm2_5": pm_hourly,
            "dust": [dust] * 48,
            "aerosol_optical_depth": [aod] * 48,
            "us_aqi": [us_aqi] * 48,
        },
    }
    fc = {
        "current": {"time": "2026-10-08T12:00", "relative_humidity_2m": rh, "visibility": vis_m},
        "hourly": {"time": times, "visibility": [vis_m] * 48, "relative_humidity_2m": [rh] * 48},
    }
    return aq, fc


def run_analyse(lat: float, lon: float, month: int = MONTH, official=None, **kwargs):
    aq, fc = make_payloads(**kwargs)
    return analyse(aq, fc, lat, lon, month=month, official=official, fetched_at=NOW)


SG = (1.35, 103.82)
DELHI = (28.61, 77.21)
LAGOS = (6.52, 3.38)
HARARE = (-17.83, 31.05)
RIYADH = (24.71, 46.68)
LONDON = (51.5, -0.12)


# ---------------------------------------------------------------------------
# Level bands
# ---------------------------------------------------------------------------


class TestLevelBands:
    @pytest.mark.parametrize(
        "pm, level",
        [(0.0, "none"), (12.0, "none"), (12.1, "light"), (35.4, "light"),
         (35.5, "moderate"), (55.4, "moderate"), (55.5, "heavy"),
         (150.4, "heavy"), (150.5, "hazardous"), (400.0, "hazardous")],
    )
    def test_pm_level_uses_epa_pm25_floors(self, pm, level):
        assert pm_level(pm) == level

    def test_pm_level_none_is_none(self):
        assert pm_level(None) == "none"

    @pytest.mark.parametrize(
        "vis, level", [(1.5, "heavy"), (3.0, "moderate"), (7.0, "light"), (12.0, "none")]
    )
    def test_visibility_bands_when_dry(self, vis, level):
        assert vis_level(vis, rh=40) == level

    def test_visibility_ignored_when_humid(self):
        assert vis_level(1.0, rh=95) == "none"

    def test_visibility_alone_cannot_create_haze(self):
        # Rain or fog with clean air: visibility is low but PM2.5 and dust are not.
        assert classify_level(pm25_mean=4.0, vis_km=1.2, rh=80, dust=2.0) == "none"

    def test_visibility_raises_a_particle_level(self):
        assert classify_level(pm25_mean=20.0, vis_km=1.5, rh=50, dust=0.0) == "heavy"

    def test_dust_can_carry_low_visibility(self):
        assert classify_level(pm25_mean=5.0, vis_km=1.5, rh=30, dust=40.0) == "heavy"


# ---------------------------------------------------------------------------
# Classification — smoke vs dust vs smog vs mist vs clear
# ---------------------------------------------------------------------------


class TestClassification:
    def test_southeast_asian_smoke(self):
        r = run_analyse(*SG, pm25=90.0, pm10=100.0, dust=0.0, aod=1.6, rh=70.0, vis_m=4000.0,
                        pm_series=[90.0] * 48)
        assert r.available is True
        assert r.level == "heavy"
        assert r.type == "smoke"
        assert r.headline == "Heavy smoke haze"

    def test_urban_winter_smog_is_fine_particles_low_aod(self):
        r = run_analyse(*DELHI, month=12, pm25=180.0, pm10=260.0, dust=5.0, aod=0.45,
                        rh=60.0, vis_m=1500.0)
        assert r.level == "hazardous"
        assert r.type == "smog"
        assert r.headline == "Hazardous smog"

    def test_saharan_dust_is_coarse_dominated(self):
        r = run_analyse(*LAGOS, month=1, pm25=30.0, pm10=200.0, dust=150.0, aod=0.9,
                        rh=20.0, vis_m=3000.0)
        assert r.type == "dust"
        assert r.level == "moderate"
        assert r.headline == "Moderate dust haze"

    def test_gulf_dust_storm_is_dust(self):
        r = run_analyse(*RIYADH, month=6, pm25=95.0, pm10=1200.0, dust=1100.0, aod=0.63,
                        rh=10.0, vis_m=20000.0)
        assert r.type == "dust"

    def test_humid_low_visibility_is_mist_not_haze(self):
        r = run_analyse(*LONDON, pm25=8.0, pm10=15.0, dust=0.0, aod=0.1, rh=96.0, vis_m=1200.0)
        assert r.level == "none"
        assert r.type == "mist"
        assert r.headline == "Mist, not pollution"

    def test_humidity_with_heavy_particles_is_not_mist(self):
        r = run_analyse(*SG, pm25=60.0, pm10=75.0, dust=0.0, aod=0.8, rh=96.0, vis_m=2000.0)
        assert r.type != "mist"
        assert r.level == "heavy"

    def test_clean_air_is_clear(self):
        r = run_analyse(*LONDON, pm25=4.0, pm10=8.0, dust=0.0, aod=0.05, rh=50.0, vis_m=25000.0)
        assert r.level == "none"
        assert r.type == "clear"
        assert r.headline == "Clear air"

    def test_fire_season_turns_moderate_aod_into_smoke(self):
        # AOD 0.4 is below the high-smoke cut-off; an active burning season makes it smoke.
        r = run_analyse(*HARARE, month=8, pm25=40.0, pm10=60.0, dust=0.0, aod=0.4, rh=30.0,
                        vis_m=6000.0)
        assert r.season.active is True
        assert r.type == "smoke"

    def test_same_reading_off_season_is_smog(self):
        r = run_analyse(*HARARE, month=3, pm25=40.0, pm10=60.0, dust=0.0, aod=0.4, rh=30.0,
                        vis_m=6000.0)
        assert r.season.active is False
        assert r.type == "smog"

    def test_advice_is_capped_and_mentions_peak(self):
        r = run_analyse(*SG, pm25=90.0, pm10=100.0, aod=1.6, rh=70.0, vis_m=4000.0,
                        pm_series=[10.0] * 14 + [90.0] * 48)
        assert 1 <= len(r.advice) <= 3
        assert any("worst around" in a for a in r.advice)

    def test_peak_time_is_next_day_spike(self):
        series = [10.0] * 48
        series[12 + 5] = 120.0
        r = run_analyse(*SG, pm25=20.0, pm10=30.0, aod=0.7, rh=60.0, vis_m=8000.0,
                        pm_series=series)
        assert r.peakTime == "2026-10-08T17:00"

    def test_window_mean_smooths_a_single_reading(self):
        series = [5.0] * 48
        series[12] = 80.0  # current hour spikes; ±12 h mean stays low
        r = run_analyse(*LONDON, pm25=80.0, pm10=90.0, aod=0.1, rh=40.0, vis_m=30000.0,
                        pm_series=series)
        assert r.pm25Mean < 12.1
        assert r.level == "none"

    def test_no_particle_or_visibility_data_is_unavailable(self):
        aq, fc = make_payloads(pm25=None, pm10=None, dust=None, aod=None, us_aqi=None,
                               rh=None, vis_m=None, pm_series=[None] * 48)
        r = analyse(aq, fc, *LONDON, month=MONTH, fetched_at=NOW)
        assert r.available is False
        assert r.reason == "insufficient_data"

    def test_headline_for_each_type(self):
        assert headline_for("light", "smog") == "Light smog"
        assert headline_for("moderate", "smoke") == "Moderate smoke haze"
        assert headline_for("none", "clear") == "Clear air"

    def test_is_mist_requires_low_visibility_and_humidity(self):
        assert is_mist(pm25_mean=5.0, vis_km=2.0, rh=95.0) is True
        assert is_mist(pm25_mean=5.0, vis_km=15.0, rh=95.0) is False
        assert is_mist(pm25_mean=5.0, vis_km=2.0, rh=60.0) is False
        assert is_mist(pm25_mean=50.0, vis_km=2.0, rh=95.0) is False

    def test_classify_type_smoke_when_aod_high(self):
        t = classify_type("heavy", pm25_mean=90, pm25=90, pm10=100, dust=0, aod=0.9, rh=50,
                          vis_km=3, fire_season_active=False)
        assert t == "smoke"


# ---------------------------------------------------------------------------
# Seasons — lookup, wrap-around months
# ---------------------------------------------------------------------------


class TestSeasons:
    def test_southeast_asian_haze_season_active_in_june_to_october(self):
        s = active_season(*SG, month=8)
        assert s.name == "Southeast Asian haze season"
        assert s.active is True
        assert s.typical_months == [6, 7, 8, 9, 10]

    def test_southeast_asian_haze_season_inactive_in_may(self):
        s = active_season(*SG, month=5)
        assert s.name == "Southeast Asian haze season"
        assert s.active is False

    @pytest.mark.parametrize("month, active", [(11, True), (12, True), (1, True), (3, True),
                                               (4, False), (7, False)])
    def test_harmattan_wraps_the_year_end(self, month, active):
        s = active_season(*LAGOS, month=month)
        assert s.name == "Harmattan dust season"
        assert s.active is active
        assert s.typical_months == [11, 12, 1, 2, 3]

    def test_window_months_wrap(self):
        assert _window_months(11, 3) == [11, 12, 1, 2, 3]
        assert _window_months(6, 8) == [6, 7, 8]

    def test_south_asian_winter_smog_for_delhi_in_october(self):
        s = active_season(*DELHI, month=10)
        assert s.name == "South Asian winter smog"
        assert s.typical_type == "smog"
        assert s.active is True

    def test_point_outside_every_season_has_no_season(self):
        assert active_season(*LONDON, month=10) is None

    def test_points_listed_in_table_are_consistent(self):
        for season in HAZE_SEASONS:
            assert season.lat_min < season.lat_max
            assert season.lon_min < season.lon_max
            assert 1 <= season.start_month <= 12 and 1 <= season.end_month <= 12
            assert season.haze_type in {"smoke", "dust", "smog"}

    def test_season_present_but_inactive_is_reported(self):
        aq, fc = make_payloads(pm25=5.0)
        r = analyse(aq, fc, *RIYADH, month=10, fetched_at=NOW)
        assert r.season is not None
        assert r.season.name == "Gulf dust season"
        assert r.season.active is False


# ---------------------------------------------------------------------------
# Official sources — Singapore NEA PSI and stubs
# ---------------------------------------------------------------------------

PSI_PAYLOAD = {
    "code": 0,
    "data": {
        "regionMetadata": [],
        "items": [
            {
                "date": "2026-10-08",
                "timestamp": "2026-10-08T23:00:00+08:00",
                "readings": {
                    "psi_twenty_four_hourly": {
                        "north": 99, "south": 109, "west": 142, "east": 111, "central": 140,
                    },
                    "pm25_twenty_four_hourly": {"west": 94},
                },
            }
        ],
    },
}


class TestOfficialSources:
    def test_parse_picks_highest_region_without_national_key(self):
        out = parse_sg_psi(PSI_PAYLOAD)
        assert out == {
            "source": "NEA Singapore",
            "metric": "PSI",
            "value": 142,
            "band": "Unhealthy",
            "region": "West",
            "observedAt": "2026-10-08T23:00:00+08:00",
        }

    def test_parse_ignores_national_if_present(self):
        payload = {"data": {"items": [{"timestamp": "t", "readings": {
            "psi_twenty_four_hourly": {"national": 300, "north": 50, "west": 60}}}]}}
        assert parse_sg_psi(payload)["value"] == 60

    @pytest.mark.parametrize("bad", [{}, {"data": {}}, {"data": {"items": []}},
                                     {"data": {"items": [{"readings": {}}]}}, None, "x"])
    def test_parse_returns_none_on_malformed_payload(self, bad):
        assert parse_sg_psi(bad) is None

    @pytest.mark.parametrize(
        "value, band",
        [(0, "Good"), (50, "Good"), (51, "Moderate"), (100, "Moderate"), (101, "Unhealthy"),
         (200, "Unhealthy"), (201, "Very unhealthy"), (300, "Very unhealthy"), (301, "Hazardous")],
    )
    def test_psi_bands(self, value, band):
        assert psi_band(value) == band

    def test_singapore_adapter_applies_only_inside_singapore(self):
        sg = next(s for s in OFFICIAL_SOURCES if s.id == "sg-nea-psi")
        assert sg.applies(*SG) is True
        assert sg.applies(*RIYADH) is False

    def test_stubs_are_present_and_not_wired(self):
        stubs = [s for s in OFFICIAL_SOURCES if s.id in {"my-apims", "id-ispu"}]
        assert len(stubs) == 2
        assert all(not s.wired for s in stubs)

    def test_fetch_official_singapore(self):
        with patch.object(_haze, "_http_get_json", AsyncMock(return_value=PSI_PAYLOAD)) as get:
            out = asyncio.run(fetch_official(*SG))
        assert out["value"] == 142
        get.assert_awaited_once()

    def test_fetch_official_skips_outside_coverage(self):
        with patch.object(_haze, "_http_get_json", AsyncMock(return_value=PSI_PAYLOAD)) as get:
            out = asyncio.run(fetch_official(*RIYADH))
        assert out is None
        get.assert_not_awaited()

    def test_fetch_official_swallows_errors(self):
        with patch.object(_haze, "_http_get_json", AsyncMock(side_effect=RuntimeError("boom"))):
            assert asyncio.run(fetch_official(*SG)) is None

    def test_official_appears_in_analysis(self):
        official = parse_sg_psi(PSI_PAYLOAD)
        r = run_analyse(*SG, pm25=90.0, pm10=100.0, aod=1.6, rh=70.0, vis_m=4000.0,
                        official=official)
        assert r.official is not None
        assert r.official.value == 142
        assert r.official.region == "West"


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------


class TestCache:
    def test_cache_key_is_two_decimal_coordinates(self):
        assert _haze._cache_key(1.35, 103.8249) == "1.35_103.82"

    def test_get_cached_returns_payload(self):
        coll = MagicMock()
        coll.find_one.return_value = {"_id": "1.35_103.82", "payload": {"available": True}}
        with patch.object(_haze, "_haze_cache_collection", return_value=coll):
            assert _haze._get_cached(1.35, 103.82) == {"available": True}
        query = coll.find_one.call_args[0][0]
        assert query["_id"] == "1.35_103.82"
        assert "$gt" in query["expiresAt"]

    def test_get_cached_miss_returns_none(self):
        coll = MagicMock()
        coll.find_one.return_value = None
        with patch.object(_haze, "_haze_cache_collection", return_value=coll):
            assert _haze._get_cached(1.0, 1.0) is None

    def test_get_cached_swallows_db_errors(self):
        coll = MagicMock()
        coll.find_one.side_effect = RuntimeError("mongo down")
        with patch.object(_haze, "_haze_cache_collection", return_value=coll):
            assert _haze._get_cached(1.0, 1.0) is None

    def test_set_cached_upserts_on_deterministic_id_with_ttl(self):
        coll = MagicMock()
        with patch.object(_haze, "_haze_cache_collection", return_value=coll):
            _haze._set_cached(1.35, 103.82, {"available": True})
        filt, update = coll.update_one.call_args[0]
        kwargs = coll.update_one.call_args[1]
        assert filt == {"_id": "1.35_103.82"}
        assert kwargs == {"upsert": True}
        assert update["$set"]["_id"] == "1.35_103.82"
        ttl = update["$set"]["expiresAt"] - update["$set"]["fetchedAt"]
        assert ttl.total_seconds() == _haze.HAZE_CACHE_TTL_SECONDS == 1800
        assert update["$set"]["_schemaVersion"] == "v3.1"

    def test_set_cached_swallows_db_errors(self):
        coll = MagicMock()
        coll.update_one.side_effect = RuntimeError("write failed")
        with patch.object(_haze, "_haze_cache_collection", return_value=coll):
            _haze._set_cached(1.0, 1.0, {"available": True})  # must not raise


# ---------------------------------------------------------------------------
# Failure paths — available:false, never a 500
# ---------------------------------------------------------------------------


class TestFailurePaths:
    def test_provider_error_is_unavailable(self):
        with patch.object(_haze, "_fetch_open_meteo", AsyncMock(side_effect=RuntimeError("x"))), \
                patch.object(_haze, "fetch_official", AsyncMock(return_value=None)):
            r = asyncio.run(_haze.build_haze(*LONDON))
        assert r.available is False
        assert r.reason == "provider_error"
        assert r.level is None and r.advice == []

    def test_open_breaker_is_unavailable(self):
        with patch.object(_haze, "_fetch_open_meteo", AsyncMock(side_effect=CircuitOpenError("open-meteo"))), \
                patch.object(_haze, "fetch_official", AsyncMock(return_value=None)):
            r = asyncio.run(_haze.build_haze(*LONDON))
        assert r.available is False
        assert r.reason == "provider_unavailable"

    def test_official_failure_does_not_block_result(self):
        aq, fc = make_payloads(pm25=90.0, pm10=100.0, aod=1.6, rh=70.0, vis_m=4000.0)
        with patch.object(_haze, "_fetch_open_meteo", AsyncMock(return_value=(aq, fc))), \
                patch.object(_haze, "fetch_official", AsyncMock(side_effect=RuntimeError("psi"))):
            r = asyncio.run(_haze.build_haze(*SG))
        assert r.available is True
        assert r.official is None

    def test_fetch_open_meteo_uses_breaker_and_both_endpoints(self):
        calls = []

        async def fake_get(url, params=None, timeout=None):
            calls.append(url)
            return {"current": {}, "hourly": {}}

        with patch.object(_haze, "_http_get_json", side_effect=fake_get):
            asyncio.run(_haze._fetch_open_meteo(1.0, 2.0))
        assert calls == [_haze.OPEN_METEO_AQ_URL, _haze.OPEN_METEO_FORECAST_URL]


# ---------------------------------------------------------------------------
# HTTP endpoint
# ---------------------------------------------------------------------------


@pytest.fixture
def client():
    from py.index import app
    return TestClient(app)


class TestEndpoint:
    def test_returns_haze_payload_on_miss(self, client):
        aq, fc = make_payloads(pm25=90.0, pm10=100.0, aod=1.6, rh=70.0, vis_m=4000.0)
        with patch.object(_haze, "_get_cached", return_value=None), \
                patch.object(_haze, "_set_cached") as set_cached, \
                patch.object(_haze, "_fetch_open_meteo", AsyncMock(return_value=(aq, fc))), \
                patch.object(_haze, "fetch_official", AsyncMock(return_value=None)):
            resp = client.get("/api/py/haze", params={"lat": SG[0], "lon": SG[1]})
        assert resp.status_code == 200
        assert resp.headers["X-Cache"] == "MISS"
        body = resp.json()
        assert body["available"] is True
        assert body["type"] == "smoke"
        assert body["level"] == "heavy"
        assert set(body) >= {"available", "level", "type", "headline", "advice", "visibilityKm",
                             "pm25", "dust", "aod", "usAqi", "peakTime", "season", "official",
                             "attribution", "fetchedAt"}
        set_cached.assert_called_once()

    def test_serves_cache_hit_without_fetching(self, client):
        cached = {"available": True, "level": "light", "type": "smog"}
        with patch.object(_haze, "_get_cached", return_value=cached), \
                patch.object(_haze, "_fetch_open_meteo", AsyncMock()) as fetch:
            resp = client.get("/api/py/haze", params={"lat": 1.0, "lon": 1.0})
        assert resp.headers["X-Cache"] == "HIT"
        assert resp.json() == cached
        fetch.assert_not_awaited()

    def test_failure_is_200_unavailable_and_not_cached(self, client):
        with patch.object(_haze, "_get_cached", return_value=None), \
                patch.object(_haze, "_set_cached") as set_cached, \
                patch.object(_haze, "_fetch_open_meteo", AsyncMock(side_effect=RuntimeError("x"))), \
                patch.object(_haze, "fetch_official", AsyncMock(return_value=None)):
            resp = client.get("/api/py/haze", params={"lat": 6.5, "lon": 3.4})
        assert resp.status_code == 200
        assert resp.json()["available"] is False
        set_cached.assert_not_called()

    def test_rejects_out_of_range_coordinates(self, client):
        assert client.get("/api/py/haze", params={"lat": 91, "lon": 0}).status_code == 422
        assert client.get("/api/py/haze", params={"lat": 0, "lon": 181}).status_code == 422
