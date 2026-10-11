"""Tests for api/py/_agriculture.py — deterministic farm windows + AI explanation."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from py import _agriculture as agri
from py._circuit_breaker import CircuitOpenError

# 2026-10-11 10:30 UTC → 12:30 in Harare (UTC+2).
NOW = datetime(2026, 10, 11, 10, 30, tzinfo=timezone.utc)
OFFSET = 7200
TODAY = "2026-10-11"


def make_raw(
    *,
    hours: int = 16 * 24,
    rain_hour=lambda i, t: 0.0,
    rain_prob_hour=lambda i, t: 0.0,
    wind=lambda i, t: 8.0,
    gust=lambda i, t: 14.0,
    temp=lambda i, t: 22.0,
    rh=lambda i, t: 55.0,
    moisture: float | None = 0.27,
    soil_temp: float | None = 18.0,
    daily_rain=lambda d: 0.0,
    daily_prob=lambda d: 0.0,
    tmax=lambda d: 28.0,
    tmin=lambda d: 12.0,
    et0=lambda d: 5.0,
) -> dict:
    """A synthetic Open-Meteo payload starting one hour before NOW (local)."""
    local_start = datetime(2026, 10, 11, 11, 0)
    times = [(local_start + timedelta(hours=i)).strftime("%Y-%m-%dT%H:%M") for i in range(hours)]
    hourly: dict = {"time": times}
    for f in agri.SOIL_MOISTURE_FIELDS:
        hourly[f] = [moisture] * hours
    for f in agri.SOIL_TEMPERATURE_FIELDS:
        hourly[f] = [soil_temp] * hours
    hourly["vapour_pressure_deficit"] = [1.2] * hours
    hourly["leaf_wetness_probability"] = [10] * hours
    hourly["precipitation"] = [rain_hour(i, t) for i, t in enumerate(times)]
    hourly["precipitation_probability"] = [rain_prob_hour(i, t) for i, t in enumerate(times)]
    hourly["wind_speed_10m"] = [wind(i, t) for i, t in enumerate(times)]
    hourly["wind_gusts_10m"] = [gust(i, t) for i, t in enumerate(times)]
    hourly["temperature_2m"] = [temp(i, t) for i, t in enumerate(times)]
    hourly["relative_humidity_2m"] = [rh(i, t) for i, t in enumerate(times)]
    hourly["is_day"] = [1 if 6 <= int(t[11:13]) < 18 else 0 for t in times]

    start_day = datetime(2026, 10, 11) - timedelta(days=30)
    dates = [(start_day + timedelta(days=d)).strftime("%Y-%m-%d") for d in range(46)]
    daily = {
        "time": dates,
        "precipitation_sum": [daily_rain(d) for d in range(46)],
        "precipitation_probability_max": [daily_prob(d) for d in range(46)],
        "temperature_2m_max": [tmax(d) for d in range(46)],
        "temperature_2m_min": [tmin(d) for d in range(46)],
        "et0_fao_evapotranspiration": [et0(d) for d in range(46)],
        "wind_speed_10m_max": [15.0] * 46,
        "wind_gusts_10m_max": [25.0] * 46,
    }
    return {"utc_offset_seconds": OFFSET, "timezone": "Africa/Harare", "elevation": 1484.0, "hourly": hourly, "daily": daily}


# Index of TODAY in the daily arrays.
T = 30


def run(raw: dict, crops=None, profile=None):
    return agri.analyse(raw, -17.83, 31.05, crops=crops or [], profile=profile, now=NOW)


# ---------------------------------------------------------------------------
# Spraying
# ---------------------------------------------------------------------------


class TestSpray:
    def test_good_conditions_give_a_window_today(self):
        res = run(make_raw())
        assert res.windows.spray.status == "go"
        assert res.sprayWindows
        first = res.sprayWindows[0]
        assert first.start == "2026-10-11T12:00"  # starts at the current local hour
        assert first.end == "2026-10-11T18:00"  # daylight ends at 18:00
        assert first.hours == 6

    def test_strong_wind_blocks_spraying(self):
        res = run(make_raw(wind=lambda i, t: 25.0, gust=lambda i, t: 40.0))
        assert res.windows.spray.status == "avoid"
        assert "drift" in res.windows.spray.detail
        assert res.sprayWindows == []

    def test_calm_air_is_not_sprayable(self):
        res = run(make_raw(wind=lambda i, t: 1.0))
        assert res.windows.spray.status == "avoid"
        assert res.wind.detail.startswith("Calm")

    def test_rain_within_two_hours_blocks_the_hour(self):
        hours = agri.hours_from(make_raw(rain_hour=lambda i, t: 1.0 if i == 3 else 0.0)["hourly"])
        assert agri.spray_hour_ok(hours, 1) is False  # rain 2 h later
        assert agri.spray_hour_ok(hours, 4) is True

    def test_rain_reason_reported(self):
        res = run(make_raw(rain_prob_hour=lambda i, t: 80.0))
        assert res.windows.spray.status == "avoid"
        assert "rain" in res.windows.spray.detail

    def test_tomorrow_only_is_wait(self):
        # Wind too strong today, fine tomorrow.
        res = run(make_raw(wind=lambda i, t: 25.0 if t.startswith(TODAY) else 8.0))
        assert res.windows.spray.status == "wait"
        assert "tomorrow" in res.windows.spray.label

    def test_short_runs_are_not_windows(self):
        hours = agri.hours_from(make_raw(wind=lambda i, t: 8.0 if i == 2 else 25.0)["hourly"])
        assert agri.spray_windows(hours, 0) == []

    def test_night_hours_never_sprayable(self):
        hours = agri.hours_from(make_raw()["hourly"])
        night = next(i for i, h in enumerate(hours) if not h.is_day)
        assert agri.spray_hour_ok(hours, night) is False


# ---------------------------------------------------------------------------
# Planting / harvest / irrigation
# ---------------------------------------------------------------------------


class TestPlant:
    def test_warm_moist_soil_is_go(self):
        assert run(make_raw()).windows.plant.status == "go"

    def test_cold_soil_is_avoid(self):
        res = run(make_raw(soil_temp=8.0))
        assert res.windows.plant.status == "avoid"
        assert "cold" in res.windows.plant.label.lower()

    def test_dry_soil_waits_for_planting_rains(self):
        res = run(make_raw(moisture=0.10))
        assert res.windows.plant.status == "wait"
        assert "rain" in res.windows.plant.label.lower()

    def test_dry_soil_with_effective_rain_is_go(self):
        res = run(make_raw(moisture=0.10, daily_rain=lambda d: 15.0 if d in (T - 1, T, T + 1) else 0.0))
        assert res.windows.plant.status == "go"

    def test_washout_rain_waits(self):
        res = run(make_raw(daily_rain=lambda d: 60.0 if d == T + 1 else 0.0))
        assert res.windows.plant.status == "wait"
        assert "heavy rain" in res.windows.plant.label.lower()

    def test_moist_soil_without_temperature_is_not_called_dry(self):
        res = run(make_raw(soil_temp=None, moisture=0.30))
        assert res.windows.plant.status == "wait"
        assert "dry" not in res.windows.plant.detail.lower()

    def test_missing_soil_data(self):
        res = run(make_raw(moisture=None, soil_temp=None))
        assert res.windows.plant.status == "wait"
        assert res.soil.moistureBand is None


class TestHarvest:
    def test_three_dry_days_is_go(self):
        assert run(make_raw()).windows.harvest.status == "go"

    def test_rain_today_is_avoid(self):
        res = run(make_raw(daily_rain=lambda d: 10.0 if d == T else 0.0))
        assert res.windows.harvest.status == "avoid"

    def test_rain_day_after_tomorrow_is_wait(self):
        res = run(make_raw(daily_rain=lambda d: 10.0 if d == T + 2 else 0.0))
        assert res.windows.harvest.status == "wait"
        assert res.windows.harvest.label.startswith("Dry until")

    def test_short_forecast_all_dry_does_not_crash(self):
        days = [agri.AgriDay(date=TODAY, forecast=True, rainMm=0.0, rainProbability=0.0)]
        assert agri.harvest_window(days, TODAY).status == "go"


class TestIrrigate:
    def test_deficit_is_go(self):
        res = run(make_raw(et0=lambda d: 6.0))
        assert res.windows.irrigate.status == "go"
        assert "18 mm" in res.windows.irrigate.label

    def test_rain_covers_demand(self):
        res = run(make_raw(et0=lambda d: 4.0, daily_rain=lambda d: 10.0 if d >= T else 0.0))
        assert res.windows.irrigate.status == "avoid"

    def test_light_deficit_is_wait(self):
        res = run(make_raw(et0=lambda d: 2.0))
        assert res.windows.irrigate.status == "wait"


# ---------------------------------------------------------------------------
# Summaries
# ---------------------------------------------------------------------------


class TestSummaries:
    def test_rain_totals_split_past_and_future(self):
        res = run(make_raw(daily_rain=lambda d: 2.0, rain_hour=lambda i, t: 0.5 if i < 24 else 0.0))
        assert res.rain.past30dMm == 60.0
        assert res.rain.past7dMm == 14.0
        assert res.rain.next7dMm == 14.0
        assert res.rain.next16dMm == 32.0
        assert res.rain.rainyDaysNext7 == 7
        assert res.rain.nextRainDate == TODAY
        # next 24 h counts from the current hour (index 1)
        assert res.rain.next24hMm == 11.5

    def test_water_balance_status(self):
        res = run(make_raw(et0=lambda d: 5.0))
        assert res.waterBalance.et0Next7dMm == 35.0
        assert res.waterBalance.balanceNext7dMm == -35.0
        assert res.waterBalance.status == "deficit"
        wet = run(make_raw(et0=lambda d: 1.0, daily_rain=lambda d: 5.0))
        assert wet.waterBalance.status == "surplus"

    def test_gdd_base10_cap30(self):
        res = run(make_raw(tmax=lambda d: 34.0, tmin=lambda d: 14.0))
        # (min(34,30) + 14) / 2 - 10 = 12
        assert res.gdd.today == 12.0
        assert res.gdd.past30d == 360.0
        assert res.gdd.next7d == 84.0
        assert res.daily[T].gddCumulative == pytest.approx(31 * 12.0)

    def test_moisture_bands(self):
        assert agri.moisture_band(0.40) == "saturated"
        assert agri.moisture_band(0.30) == "moist"
        assert agri.moisture_band(0.20) == "adequate"
        assert agri.moisture_band(0.05) == "dry"
        assert agri.moisture_band(None) is None

    def test_daily_series_marks_forecast_and_soil(self):
        res = run(make_raw())
        assert len(res.daily) == 46
        assert res.daily[0].forecast is False and res.daily[0].soilMoisture0to1 is None
        assert res.daily[T].forecast is True and res.daily[T].soilMoisture0to1 == 0.27
        assert res.daily[T].soilTemp6 == 18.0
        assert res.daily[T].sprayHours == 6
        assert res.daily[0].sprayHours is None

    def test_frost_and_heat(self):
        cold = run(make_raw(tmin=lambda d: 1.0 if d == T + 2 else 10.0))
        assert cold.risks.frost.level == "high"
        assert cold.risks.frost.days == ["2026-10-13"]
        assert cold.verdict == "avoid"
        # The detail names the first frost day's own low, not the week's extreme.
        two = run(make_raw(tmin=lambda d: {T: 1.5, T + 3: -2.0}.get(d, 10.0)))
        assert "today (low 2 °C)" in two.risks.frost.detail
        assert two.risks.frost.extremeC == -2.0
        mild = run(make_raw(tmin=lambda d: 3.5 if d == T + 1 else 10.0))
        assert mild.risks.frost.level == "moderate"
        hot = run(make_raw(tmax=lambda d: 37.0 if d == T + 3 else 28.0))
        assert hot.risks.heat.level == "high"
        warm = run(make_raw(tmax=lambda d: 33.0 if d == T + 3 else 28.0))
        assert warm.risks.heat.level == "moderate"

    def test_headline_lists_go_jobs(self):
        res = run(make_raw(et0=lambda d: 6.0))
        assert res.verdict == "go"
        assert res.headline == "Good day to spray, plant, harvest and irrigate."

    def test_local_time_not_server_time(self):
        res = run(make_raw())
        assert res.utcOffsetSeconds == OFFSET
        assert res.daily[T].date == TODAY

    def test_insufficient_data(self):
        res = agri.analyse({}, 0, 0, crops=[], now=NOW)
        assert res.available is False and res.reason == "insufficient_data"


# ---------------------------------------------------------------------------
# Calendar + season
# ---------------------------------------------------------------------------


PROFILE = {
    "season": {"name": "Hot dry", "localName": "Zhizha", "description": "Heat stress, water scarcity"},
    "crops": [
        {"id": "crop-farming", "label": "Maize", "phase": "pre-planting", "calendar": {"plant": [11, 12], "harvest": [4, 5, 6], "bogus": [1]}},
        {"id": "tobacco-farming", "label": "Tobacco", "phase": "transplanting", "calendar": {"plant": [9, 10, 13, "x"]}},
    ],
    "normals": {"high": 29.1, "low": 13.4},
    "koppen": "Cwb",
    "enso": {"phase": "La Niña"},
}


class TestProfile:
    def test_default_crop_is_maize(self):
        assert agri.normalise_crops([]) == ["crop-farming"]
        assert agri.normalise_crops(["livestock", "tobacco-farming", "tobacco-farming"]) == ["tobacco-farming"]

    def test_calendar_follows_user_crops_and_sanitises_months(self):
        cal = agri.calendar_from_profile(PROFILE, ["tobacco-farming", "cotton-farming", "crop-farming"])
        assert [c.id for c in cal] == ["tobacco-farming", "crop-farming"]
        assert cal[0].months == {"plant": [9, 10]}
        assert cal[1].months == {"plant": [11, 12], "harvest": [4, 5, 6]}
        assert cal[1].phase == "pre-planting"

    def test_season_and_context_from_profile(self):
        res = run(make_raw(), crops=["crop-farming"], profile=PROFILE)
        assert res.season.localName == "Zhizha"
        assert res.profile.koppen == "Cwb"
        assert res.profile.normalHigh == 29.1
        assert res.profile.ensoPhase == "La Niña"
        assert res.calendar[0].label == "Maize"

    def test_no_profile_falls_back(self):
        res = run(make_raw(), profile=None)
        assert res.season.name == "Spring"  # October, southern hemisphere
        assert res.calendar == [] and res.profile is None
        assert agri.calendar_from_profile({"crops": "nope"}, ["crop-farming"]) == []

    def test_loader_returns_none_without_helper(self):
        # The helper module is owned by the location-profile work; absent here.
        with patch.dict("sys.modules", {"py._location_profile": None}):
            assert agri.load_location_profile(-17.83, 31.05) is None

    def test_loader_uses_helper_and_swallows_errors(self):
        import types

        fake = types.ModuleType("py._location_profile")
        fake.get_location_profile = MagicMock(return_value=PROFILE)
        with patch.dict("sys.modules", {"py._location_profile": fake}):
            assert agri.load_location_profile(-17.83, 31.05, slug="harare", country="ZW") == PROFILE
            fake.get_location_profile.assert_called_once_with(lat=-17.83, lon=31.05, slug="harare", country="ZW")
            fake.get_location_profile.side_effect = RuntimeError("db down")
            assert agri.load_location_profile(-17.83, 31.05) is None


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


@pytest.fixture
def client():
    from py.index import app

    return TestClient(app)


class TestEndpoint:
    def test_cache_hit_skips_fetch(self, client):
        with patch.object(agri, "_get_cached_raw", return_value=make_raw()), patch.object(
            agri, "fetch_raw", new=AsyncMock()
        ) as fetch, patch.object(agri, "load_location_profile", return_value=None):
            res = client.get("/api/py/agriculture?lat=-17.83&lon=31.05&country=ZW&crops=tobacco-farming")
        assert res.status_code == 200
        assert res.headers["X-Cache"] == "HIT"
        fetch.assert_not_called()
        assert res.json()["available"] is True

    def test_miss_fetches_and_caches_by_grid_cell(self, client):
        with patch.object(agri, "_get_cached_raw", return_value=None) as get, patch.object(
            agri, "fetch_raw", new=AsyncMock(return_value=make_raw())
        ), patch.object(agri, "_set_cached_raw") as put, patch.object(agri, "load_location_profile", return_value=None):
            res = client.get("/api/py/agriculture?lat=-17.83&lon=31.05")
        assert res.status_code == 200 and res.headers["X-Cache"] == "MISS"
        assert get.call_args[0][0] == "cell:-17.85_31.05"
        assert put.call_args[0][0] == "cell:-17.85_31.05"

    def test_open_breaker_is_available_false(self, client):
        with patch.object(agri, "_get_cached_raw", return_value=None), patch.object(
            agri, "fetch_raw", new=AsyncMock(side_effect=CircuitOpenError("open-meteo"))
        ), patch.object(agri, "_set_cached_raw") as put:
            res = client.get("/api/py/agriculture?lat=-17.83&lon=31.05")
        assert res.status_code == 200
        assert res.json() == {**res.json(), "available": False, "reason": "provider_unavailable"}
        put.assert_not_called()

    def test_upstream_error_is_available_false(self, client):
        with patch.object(agri, "_get_cached_raw", return_value=None), patch.object(
            agri, "fetch_raw", new=AsyncMock(side_effect=RuntimeError("boom"))
        ):
            res = client.get("/api/py/agriculture?lat=-17.83&lon=31.05")
        assert res.status_code == 200 and res.json()["reason"] == "provider_error"

    def test_analysis_error_degrades(self, client):
        with patch.object(agri, "_get_cached_raw", return_value={"hourly": {"time": ["x"]}, "daily": {"time": "bad"}}), patch.object(
            agri, "analyse", side_effect=ValueError("bad")
        ):
            res = client.get("/api/py/agriculture?lat=1&lon=1")
        assert res.status_code == 200 and res.json()["reason"] == "analysis_error"

    def test_bad_coords_rejected(self, client):
        assert client.get("/api/py/agriculture?lat=95&lon=0").status_code == 422

    def test_country_resolved_from_slug(self):
        with patch("py._places_resolver.find_location", return_value={"country": "KE"}):
            assert agri._resolve_country("", "nairobi-ke") == "KE"
        assert agri._resolve_country("zw", "") == "ZW"
        assert agri._resolve_country("", "Bad Slug!") == ""

    @pytest.mark.parametrize(
        "exc,counts",
        [
            (agri.OpenMeteoUpstreamError("HTTP 500", status=500), True),
            (agri.OpenMeteoUpstreamError("HTTP 429", status=429), True),
            (agri.OpenMeteoUpstreamError("HTTP 400", status=400), False),
            (agri.OpenMeteoUpstreamError("non-object body"), False),
            (TimeoutError("slow"), True),
        ],
    )
    def test_only_upstream_trouble_counts_against_breaker(self, exc, counts):
        import asyncio

        with patch.object(agri, "_fetch_sync", side_effect=exc), patch.object(
            agri.open_meteo_breaker, "record_failure"
        ) as fail, patch.object(type(agri.open_meteo_breaker), "is_allowed", new=property(lambda self: True)):
            with pytest.raises(type(exc)):
                asyncio.run(agri.fetch_raw(1, 1))
        assert fail.called is counts

    def test_profile_skips_country_lookup_without_helper(self):
        with patch.object(agri, "_profile_helper_available", return_value=False), patch.object(
            agri, "_resolve_country"
        ) as resolve:
            assert agri.profile_for(-17.83, 31.05, country="", location="harare") is None
        resolve.assert_not_called()

    def test_profile_is_memoised_per_cell_and_place(self):
        agri._profile_memo.clear()
        with patch.object(agri, "_profile_helper_available", return_value=True), patch.object(
            agri, "load_location_profile", return_value={"koppen": "Cwb"}
        ) as load:
            for _ in range(3):
                assert agri.profile_for(-17.83, 31.05, country="ZW", location="harare") == {"koppen": "Cwb"}
            agri.profile_for(-17.83, 31.05, country="ZW", location="epworth")
        assert load.call_count == 2
        agri._profile_memo.clear()


# ---------------------------------------------------------------------------
# AI explanation
# ---------------------------------------------------------------------------


def _ok_data():
    return run(make_raw(), crops=["crop-farming"])


class TestAI:
    BODY = {
        "location": {"slug": "harare", "name": "Harare", "country": "ZW", "elevation": 1490, "lat": -17.83, "lon": 31.05},
        "activities": ["tobacco-farming", "crop-farming", "soccer"],
        "mode": "snapshot",
    }

    LOC = agri.AgriLocation(slug="harare", name="Harare", country="ZW", lat=-17.83, lon=31.05)

    def test_cache_key_is_cell_place_mode_and_sorted_activities(self):
        a = agri.ai_cache_key(self.LOC, "snapshot", ["tobacco-farming", "crop-farming"])
        b = agri.ai_cache_key(self.LOC, "snapshot", ["crop-farming", "tobacco-farming"])
        assert a == b == "cell:-17.85_31.05:harare:ZW:snapshot:crop-farming,tobacco-farming"
        assert agri.ai_cache_key(self.LOC, "briefing", []) == "cell:-17.85_31.05:harare:ZW:briefing"
        assert agri.ai_cache_key(self.LOC, "snapshot", ["cotton-farming"]) != a

    def test_two_places_in_one_cell_never_share_text(self):
        suburb = agri.AgriLocation(slug="", name="Strathaven", country="ZW", lat=-17.84, lon=31.04)
        no_country = agri.AgriLocation(slug="harare", name="Harare", lat=-17.83, lon=31.05)
        k = agri.ai_cache_key(self.LOC, "snapshot", [])
        assert agri.ai_cache_key(suburb, "snapshot", []) != k
        assert ":strathaven:" in agri.ai_cache_key(suburb, "snapshot", [])
        assert agri.ai_cache_key(no_country, "snapshot", []) != k

    def test_farming_activities_filters_category(self):
        briefs = [
            {"id": "tobacco-farming", "category": "farming"},
            {"id": "crop-farming", "category": "farming"},
            {"id": "soccer", "category": "sports"},
        ]
        with patch.object(agri, "filter_known_activities", side_effect=lambda ids: ids), patch.object(
            agri, "get_activities_brief", return_value=briefs
        ):
            assert agri.farming_activities(["soccer", "tobacco-farming", "crop-farming", "tobacco-farming"]) == [
                "tobacco-farming",
                "crop-farming",
            ]

    def _post(self, client, body=None, **patches):
        defaults = {
            "_get_cached_ai": None,
            "farming_activities": ["crop-farming", "tobacco-farming"],
        }
        defaults.update(patches)
        with patch.object(agri, "_get_cached_ai", return_value=defaults["_get_cached_ai"]), patch.object(
            agri, "farming_activities", return_value=defaults["farming_activities"]
        ), patch.object(agri, "build_agriculture", new=AsyncMock(return_value=(defaults.get("data", _ok_data()), "HIT"))), patch.object(
            agri, "_set_cached_ai"
        ) as put, patch.object(agri, "get_activities_brief", return_value=[]), patch.object(
            agri, "enforce_rate_limit"
        ), patch("py._ai_gateway.call_ai", return_value=defaults.get("ai", (MagicMock(text="Spray before noon."), None))) as call, patch(
            "py._ai_prompts.get_ai_prompt", return_value=None
        ):
            res = client.post("/api/py/ai/agriculture", json=body or self.BODY)
        return res, put, call

    def test_generates_and_caches_ai_text(self, client):
        res, put, call = self._post(client)
        assert res.status_code == 200
        assert res.json()["text"] == "Spray before noon."
        assert res.json()["source"] == "ai"
        assert put.call_args[0][0] == "cell:-17.85_31.05:harare:ZW:snapshot:crop-farming,tobacco-farming"
        assert put.call_args[0][2] == "ai"
        prompt = call.call_args.kwargs["messages"][0]["content"]
        assert "Harare, ZW" in prompt
        assert "elevation 1490 m" in prompt
        assert "Spray:" in prompt and "Water balance" in prompt

    def test_cache_hit_is_not_rate_limited(self, client):
        cached = {"text": "cached line", "source": "ai", "generatedAt": NOW}
        with patch.object(agri, "_get_cached_ai", return_value=cached), patch.object(
            agri, "farming_activities", return_value=[]
        ), patch.object(agri, "enforce_rate_limit") as limit:
            res = client.post("/api/py/ai/agriculture", json=self.BODY)
        assert res.status_code == 200 and res.json()["cached"] is True
        limit.assert_not_called()

    def test_cache_miss_is_rate_limited(self, client):
        from fastapi import HTTPException

        with patch.object(agri, "_get_cached_ai", return_value=None), patch.object(
            agri, "farming_activities", return_value=[]
        ), patch.object(agri, "enforce_rate_limit", side_effect=HTTPException(429)), patch.object(
            agri, "build_agriculture", new=AsyncMock()
        ) as build:
            res = client.post("/api/py/ai/agriculture", json=self.BODY)
        assert res.status_code == 429
        build.assert_not_called()

    def test_cache_hit_returns_cached(self, client):
        cached = {"text": "cached line", "source": "ai", "generatedAt": NOW}
        res, put, call = self._post(client, _get_cached_ai=cached)
        assert res.json()["cached"] is True and res.json()["text"] == "cached line"
        call.assert_not_called()
        put.assert_not_called()

    def test_ai_failure_caches_fallback(self, client):
        res, put, _ = self._post(client, ai=(None, "circuit_open"))
        assert res.json()["source"] == "fallback"
        assert put.call_args[0][2] == "fallback"
        assert res.json()["text"]

    def test_unavailable_data_skips_model(self, client):
        data = agri.AgricultureResponse(available=False, reason="provider_error", fetchedAt=NOW.isoformat())
        res, _, call = self._post(client, data=data)
        assert res.json()["source"] == "fallback"
        call.assert_not_called()

    def test_briefing_mode_uses_briefing_budget(self, client):
        body = {**self.BODY, "mode": "briefing"}
        res, put, call = self._post(client, body=body)
        assert res.json()["mode"] == "briefing"
        assert call.call_args.kwargs["max_tokens"] == agri._MAX_TOKENS["briefing"]
        assert ":briefing:" in put.call_args[0][0]

    def test_internal_secret_enforced(self, client, monkeypatch):
        monkeypatch.setenv("MUKOKO_INTERNAL_SECRET", "s3cret")
        res = client.post("/api/py/ai/agriculture", json=self.BODY)
        assert res.status_code == 401

    def test_bad_mode_rejected(self, client):
        res = client.post("/api/py/ai/agriculture", json={**self.BODY, "mode": "poem"})
        assert res.status_code == 422

    def test_rate_limited_ai_is_429_and_not_cached(self, client):
        res, put, _ = self._post(client, ai=(None, "rate_limited"))
        assert res.status_code == 429
        put.assert_not_called()

    def test_unentitled_caller_never_touches_ai_cache(self, client):
        with patch.object(agri, "agri_ai_entitled", return_value=False), patch.object(
            agri, "_get_cached_ai"
        ) as get, patch.object(agri, "_set_cached_ai") as put, patch.object(
            agri, "build_agriculture", new=AsyncMock(return_value=(_ok_data(), "HIT"))
        ), patch.object(agri, "farming_activities", return_value=[]), patch.object(agri, "enforce_rate_limit"), patch(
            "py._ai_gateway.call_ai"
        ) as call:
            res = client.post("/api/py/ai/agriculture", json=self.BODY)
        assert res.status_code == 200 and res.json()["source"] == "fallback"
        get.assert_not_called()
        put.assert_not_called()
        call.assert_not_called()

    def test_entitlement_hook_allows_today(self):
        assert agri.agri_ai_entitled(None) is True
        assert agri.AGRI_CAPABILITY == "weather.agri_insights"

    def test_fallback_text_shapes(self):
        data = _ok_data()
        assert "\n" not in agri.fallback_text(data, "snapshot")
        brief = agri.fallback_text(data, "briefing")
        assert "**Spraying:**" in brief and "**Frost:**" in brief

    def test_data_brief_is_numbers_only(self):
        text = agri.data_brief(_ok_data())
        assert "Rain: next 24h" in text
        assert "GDD (base 10)" in text
