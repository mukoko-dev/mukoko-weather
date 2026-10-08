"""Tests for _metar.py — AWC decoding, caching, station + nearest-report flows.

Fixtures are REAL Aviation Weather Center records (captured 2026-10-08), not
hand-written shapes: AWC sends ``obsTime`` as epoch seconds, ``visib`` as a
string ("6+"), ``altim`` in hPa and the category as ``fltCat``. The previous
fixtures used numeric visib / inHg altim / ISO obsTime, which is why the
decoder passed its tests while every station came back empty in production.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from py import _metar
from py._airports import NearbyAirport
from py._circuit_breaker import aviation_breaker
from py._metar import (
    METAR_CACHE_TTL,
    METAR_EMPTY_CACHE_TTL,
    CloudLayer,
    MetarObs,
    _compute_flight_category,
    _decode_awc_metar,
    _decode_wx,
    _format_visibility,
    _altimeter_hpa,
    _obs_datetime,
    decode_awc_metars,
    find_nearest_report,
    fetch_awc_metars,
    parse_visibility_sm,
    station_report,
    _metar_for_stations,
)

# A real FVRG METAR as AWC returns it (2026-10-08 15:00Z).
FVRG_RECORD = {
    "icaoId": "FVRG",
    "receiptTime": "2026-10-08T15:15:07.474Z",
    "obsTime": 1791471600,
    "reportTime": "2026-10-08T15:00:00.000Z",
    "temp": 19,
    "dewp": 17,
    "wdir": 100,
    "wspd": 7,
    "visib": "6+",
    "altim": 1024,
    "qcField": 16,
    "metarType": "METAR",
    "rawOb": "METAR FVRG 081500Z 10007KT 9999 FEW040CB BKN045 19/17 Q1024 RESHRA NOSIG",
    "lat": -17.921,
    "lon": 31.1,
    "elev": 1490,
    "name": "Harare/Mugabe Intl, ME, ZW",
    "cover": "BKN",
    "clouds": [{"cover": "FEW", "base": 4000}, {"cover": "BKN", "base": 4500}],
    "fltCat": "VFR",
}

# A real FVRG TAF payload entry (trimmed to the fields we read).
FVRG_TAF = {
    "icaoId": "FVRG",
    "rawTAF": "TAF FVRG 081000Z 0812/0918 07010KT 9999 SCT040TCU PROB30 TEMPO 0814/0818 09012KT 8000 -TSRA FEW045CB BKN050 BECMG 0820/0822 11006KT CAVOK",
}

UTC = timezone.utc


@pytest.fixture(autouse=True)
def _reset_breaker():
    aviation_breaker.reset()
    yield
    aviation_breaker.reset()


# ---------------------------------------------------------------------------
# Visibility
# ---------------------------------------------------------------------------


class TestVisibility:
    @pytest.mark.parametrize(
        "raw, expected",
        [
            ("6+", (6.0, True)),
            ("10+", (10.0, True)),
            ("3", (3.0, False)),
            ("1/2", (0.5, False)),
            ("1 1/2", (1.5, False)),
            ("2 1/2SM", (2.5, False)),
            (6.25, (6.25, False)),
        ],
    )
    def test_parse_statute_miles(self, raw, expected):
        assert parse_visibility_sm(raw) == expected

    def test_parse_rejects_garbage(self):
        assert parse_visibility_sm("abc") == (None, False)
        assert parse_visibility_sm(None) == (None, False)
        assert parse_visibility_sm(True) == (None, False)
        assert parse_visibility_sm("1/0") == (None, False)

    def test_string_six_plus_formats_as_open_ended_km(self):
        # "6+" means more than 6 SM (~9.7 km) — must not be read as ">10km".
        assert _format_visibility("6+") == ">9.7km"

    def test_ten_plus_formats_as_gt_10km(self):
        assert _format_visibility("10+") == ">10km"

    def test_fraction_formats_as_km(self):
        assert _format_visibility("3") == "4.8km"

    def test_numeric_high_vis_returns_gt10km(self):
        assert _format_visibility(9.0) == ">10km"   # ~14.5 km
        assert _format_visibility(6.25) == ">10km"  # ~10.06 km

    def test_none_returns_none(self):
        assert _format_visibility(None) is None
        assert _format_visibility("not a number") is None


# ---------------------------------------------------------------------------
# Time, pressure, wx
# ---------------------------------------------------------------------------


class TestObsTime:
    def test_epoch_seconds_obstime(self):
        dt = _obs_datetime({"obsTime": 1791471600})
        assert dt == datetime(2026, 10, 8, 15, 0, tzinfo=UTC)

    def test_iso_text_obstime(self):
        assert _obs_datetime({"obsTime": "2026-06-27T08:00:00Z"}) == datetime(
            2026, 6, 27, 8, 0, tzinfo=UTC,
        )

    def test_falls_back_to_report_time(self):
        dt = _obs_datetime({"obsTime": None, "reportTime": "2026-10-08T15:00:00.000Z"})
        assert dt == datetime(2026, 10, 8, 15, 0, tzinfo=UTC)

    def test_unparseable_is_none(self):
        assert _obs_datetime({"obsTime": "yesterday"}) is None
        assert _obs_datetime({}) is None


class TestPressure:
    def test_hpa_passthrough(self):
        # AWC reports hPa today.
        assert _altimeter_hpa(1024) == 1024.0

    def test_legacy_inhg_converted(self):
        assert 1028 < _altimeter_hpa(30.39) < 1030

    def test_missing_is_none(self):
        assert _altimeter_hpa(None) is None
        assert _altimeter_hpa("n/a") is None


class TestDecodeWx:
    def test_simple_rain(self):
        assert _decode_wx("RA") == "Rain"

    def test_light_rain_showers(self):
        assert _decode_wx("-SHRA") == "Light Rain Showers"

    def test_heavy_rain(self):
        assert "Heavy" in _decode_wx("+RA")

    def test_none_returns_none(self):
        assert _decode_wx(None) is None
        assert _decode_wx("") is None

    def test_unknown_code_passthrough(self):
        assert "XX" in _decode_wx("XX")


# ---------------------------------------------------------------------------
# Flight category
# ---------------------------------------------------------------------------


class TestComputeFlightCategory:
    def _make_clouds(self, layers):
        return [CloudLayer(cover=c, base_ft=b) for c, b in layers]

    def test_vfr_clear(self):
        assert _compute_flight_category([], ">10km") == "VFR"

    def test_vfr_six_plus_visibility(self):
        assert _compute_flight_category([], ">9.7km") == "VFR"

    def test_mvfr_broken_ceiling_2500ft(self):
        assert _compute_flight_category(self._make_clouds([("BKN", 2500)]), ">10km") == "MVFR"

    def test_ifr_broken_ceiling_800ft(self):
        assert _compute_flight_category(self._make_clouds([("BKN", 800)]), ">10km") == "IFR"

    def test_lifr_ceiling_below_500ft(self):
        assert _compute_flight_category(self._make_clouds([("OVC", 300)]), ">10km") == "LIFR"

    def test_ifr_low_visibility(self):
        assert _compute_flight_category([], "3.0km") == "IFR"

    def test_lifr_very_low_visibility(self):
        assert _compute_flight_category([], "1.0km") == "LIFR"

    def test_few_and_sct_ignored_for_ceiling(self):
        clouds = self._make_clouds([("FEW", 500), ("SCT", 600)])
        assert _compute_flight_category(clouds, ">10km") == "VFR"

    def test_lowest_bkn_used_for_ceiling(self):
        clouds = self._make_clouds([("BKN", 3500), ("BKN", 800)])
        assert _compute_flight_category(clouds, ">10km") == "IFR"


# ---------------------------------------------------------------------------
# Full AWC record decoding
# ---------------------------------------------------------------------------


class TestDecodeAwcMetar:
    def test_real_fvrg_record(self):
        obs = _decode_awc_metar(FVRG_RECORD)
        assert obs.time == "2026-10-08T15:00:00+00:00"
        assert obs.temp == 19.0
        assert obs.dewp == 17.0
        assert obs.wind_dir == 100
        assert obs.wind_speed == 7
        assert obs.wind_variable is False
        assert obs.visibility == ">9.7km"
        assert obs.pressure_hpa == 1024.0
        assert obs.flight_category == "VFR"
        assert obs.change == "No Significant Change"
        assert obs.weather is None
        assert obs.raw.startswith("METAR FVRG 081500Z")
        assert [(c.cover, c.base_ft) for c in obs.clouds] == [("FEW", 4000), ("BKN", 4500)]

    def test_wx_string_decoded(self):
        obs = _decode_awc_metar({**FVRG_RECORD, "wxString": "-SHRA"})
        assert obs.weather == "Light Rain Showers"

    def test_variable_wind(self):
        obs = _decode_awc_metar({**FVRG_RECORD, "wdir": "VRB", "wspd": 2})
        assert obs.wind_variable is True
        assert obs.wind_dir is None
        assert obs.wind_speed == 2

    def test_change_from_raw_text_tempo(self):
        obs = _decode_awc_metar({**FVRG_RECORD, "rawOb": "METAR FVRG 081300Z 01007KT 9999 TEMPO 8000"})
        assert obs.change == "Temporary"

    def test_flight_category_recomputed_when_unknown(self):
        obs = _decode_awc_metar({**FVRG_RECORD, "fltCat": "UNKNOWN"})
        assert obs.flight_category in ("VFR", "MVFR", "IFR", "LIFR")

    def test_flight_category_accepts_legacy_key(self):
        obs = _decode_awc_metar({**FVRG_RECORD, "fltCat": None, "flightCategory": "IFR"})
        assert obs.flight_category == "IFR"

    def test_minimal_record_does_not_raise(self):
        obs = _decode_awc_metar({"icaoId": "FVRG", "rawOb": "METAR FVRG"})
        assert obs.time == ""
        assert obs.temp is None
        assert obs.visibility is None
        assert obs.clouds == []
        assert obs.flight_category == "VFR"

    def test_string_numbers_are_coerced(self):
        obs = _decode_awc_metar({**FVRG_RECORD, "temp": "21", "wspd": "14"})
        assert obs.temp == 21.0
        assert obs.wind_speed == 14

    def test_malformed_cloud_entries_skipped(self):
        obs = _decode_awc_metar({**FVRG_RECORD, "clouds": [None, {"cover": ""}, {"cover": "SCT", "base": "2500"}]})
        assert [(c.cover, c.base_ft) for c in obs.clouds] == [("SCT", 2500)]


class TestDecodeAwcMetars:
    def test_sorted_newest_first(self):
        older = {**FVRG_RECORD, "obsTime": 1791468000}
        newer = {**FVRG_RECORD, "obsTime": 1791471600}
        decoded = decode_awc_metars([older, newer])
        assert [o.time for o in decoded] == [
            "2026-10-08T15:00:00+00:00",
            "2026-10-08T14:00:00+00:00",
        ]

    def test_skips_non_dict_and_keeps_good_records(self):
        decoded = decode_awc_metars(["junk", None, FVRG_RECORD])
        assert len(decoded) == 1

    def test_empty(self):
        assert decode_awc_metars([]) == []


# ---------------------------------------------------------------------------
# Model shape
# ---------------------------------------------------------------------------


class TestConstants:
    def test_cache_ttls(self):
        assert METAR_CACHE_TTL == 1800
        assert METAR_EMPTY_CACHE_TTL == 120
        assert METAR_EMPTY_CACHE_TTL < METAR_CACHE_TTL

    def test_metar_obs_model_fields(self):
        obs = MetarObs(time="2026-06-27T08:00:00+00:00", flight_category="VFR", raw="FVRG VFR")
        assert obs.wind_variable is False
        assert obs.clouds == []


# ---------------------------------------------------------------------------
# Cache semantics
# ---------------------------------------------------------------------------


class TestEmptyAnswerCaching:
    async def test_real_answer_cached_for_full_ttl_and_empty_for_short_ttl(self):
        fetched = {"FVRG": decode_awc_metars([FVRG_RECORD]), "FVHA": []}
        put = MagicMock()
        with patch.object(_metar, "_cache_get", return_value=None), \
             patch.object(_metar, "_cache_put", put), \
             patch.object(_metar, "fetch_awc_metars", return_value=fetched):
            result = await _metar_for_stations(["FVRG", "FVHA"])

        assert len(result["FVRG"]) == 1
        assert result["FVHA"] == []
        ttls = {call.args[0]: call.args[3] for call in put.call_args_list}
        assert ttls == {"FVRG": METAR_CACHE_TTL, "FVHA": METAR_EMPTY_CACHE_TTL}

    async def test_failed_fetch_is_never_cached(self):
        put = MagicMock()
        with patch.object(_metar, "_cache_get", return_value=None), \
             patch.object(_metar, "_cache_put", put), \
             patch.object(_metar, "fetch_awc_metars", side_effect=RuntimeError("AWC down")):
            with pytest.raises(RuntimeError):
                await _metar_for_stations(["FVRG"])
        put.assert_not_called()

    def test_cache_reads_are_schema_versioned(self):
        coll = MagicMock()
        coll.find_one.return_value = None
        with patch.object(_metar, "_metar_cache_collection", return_value=coll):
            _metar._cache_get("FVRG", "metar")
        query = coll.find_one.call_args.args[0]
        assert query["icao"] == "FVRG"
        assert query["kind"] == "metar"
        assert query["schema"] == _metar.CACHE_SCHEMA
        assert "$gt" in query["expiresAt"]


# ---------------------------------------------------------------------------
# AWC transport
# ---------------------------------------------------------------------------


def _fake_awc(metar_payload, taf_payload=None):
    """Route _awc_get by URL: metar and taf endpoints return canned payloads."""
    def fake(url, params):
        if url == _metar.AWC_METAR_URL:
            if isinstance(metar_payload, Exception):
                raise metar_payload
            return metar_payload
        if url == _metar.AWC_TAF_URL:
            return taf_payload or []
        raise AssertionError(url)
    return fake


class TestFetchAwcMetars:
    def test_one_request_for_many_stations_and_groups_by_icao(self):
        calls = []

        def fake(url, params):
            calls.append((url, params))
            return [FVRG_RECORD]

        with patch.object(_metar, "_awc_get", side_effect=fake):
            result = fetch_awc_metars(["FVRG", "FVKB"])

        assert len(calls) == 1
        assert calls[0][1]["ids"] == "FVRG,FVKB"
        assert len(result["FVRG"]) == 1
        assert result["FVKB"] == []

    def test_ignores_retired_code_absent_from_payload(self):
        # The live API simply omits FVHA; that is an empty answer, not an error.
        with patch.object(_metar, "_awc_get", return_value=[]):
            assert fetch_awc_metars(["FVHA"]) == {"FVHA": []}


class TestStationReport:
    async def test_real_fvrg_report_from_awc(self):
        with patch.object(_metar, "_cache_get", return_value=None), \
             patch.object(_metar, "_cache_put"), \
             patch.object(_metar, "_awc_get", side_effect=_fake_awc([FVRG_RECORD], [FVRG_TAF])):
            resp = await station_report("FVRG")

        assert resp.source == "awc"
        assert len(resp.metar) == 1
        assert resp.metar[0].visibility == ">9.7km"
        assert resp.taf.startswith("TAF FVRG")

    async def test_retired_fvha_is_empty_not_unavailable(self):
        put = MagicMock()
        with patch.object(_metar, "_cache_get", return_value=None), \
             patch.object(_metar, "_cache_put", put), \
             patch.object(_metar, "_awc_get", side_effect=_fake_awc([], [])):
            resp = await station_report("FVHA")

        assert resp.source == "awc"
        assert resp.metar == []
        # The empty answer is cached only briefly.
        metar_put = [c for c in put.call_args_list if c.args[1] == "metar"][0]
        assert metar_put.args[3] == METAR_EMPTY_CACHE_TTL

    async def test_transport_failure_reports_unavailable_and_caches_nothing(self):
        put = MagicMock()
        with patch.object(_metar, "_cache_get", return_value=None), \
             patch.object(_metar, "_cache_put", put), \
             patch.object(_metar, "get_api_key", return_value=None), \
             patch.object(_metar, "_awc_get", side_effect=_fake_awc(RuntimeError("timeout"))):
            resp = await station_report("FVRG")

        assert resp.source == "unavailable"
        assert resp.metar == []
        put.assert_not_called()


# ---------------------------------------------------------------------------
# Nearest airport with a recent report (AWC mocked)
# ---------------------------------------------------------------------------


def _iso_ago(minutes: int) -> str:
    return (datetime.now(UTC) - timedelta(minutes=minutes)).isoformat()


def _obs_ago(minutes: int) -> MetarObs:
    return MetarObs(time=_iso_ago(minutes), flight_category="VFR", raw="METAR X")


HARARE_CANDIDATES = [
    NearbyAirport(icao="FVRG", name="Harare (Robert Gabriel Mugabe Intl)", distanceKm=12.0),
    NearbyAirport(icao="FVKB", name="Kariba", distanceKm=80.0),
    NearbyAirport(icao="FVMV", name="Masvingo", distanceKm=120.0),
]


class TestFindNearestReport:
    async def test_picks_nearest_airport_that_has_a_recent_report(self):
        # FVRG is nearest but its last METAR is 3 hours old: skip it.
        reports = {
            "FVRG": [_obs_ago(180 + 5)],
            "FVKB": [_obs_ago(35)],
            "FVMV": [_obs_ago(10)],
        }
        with patch.object(_metar, "nearest_airports", return_value=HARARE_CANDIDATES), \
             patch.object(_metar, "_metar_for_stations", AsyncMock(return_value=reports)), \
             patch.object(_metar, "_taf_for", AsyncMock(return_value="TAF FVKB ...")):
            resp = await find_nearest_report(-17.85, 31.05)

        assert resp.status == "ok"
        assert resp.icao == "FVKB"
        assert resp.distanceKm == 80.0
        assert 34 <= resp.ageMinutes <= 36
        assert resp.taf == "TAF FVKB ..."
        assert resp.source == "awc"
        # The picker still sees every candidate, with report status.
        by_icao = {c.icao: c for c in resp.candidates}
        assert by_icao["FVRG"].reported is False
        assert by_icao["FVRG"].ageMinutes is not None and by_icao["FVRG"].ageMinutes > 180
        assert by_icao["FVKB"].reported is True

    async def test_nearest_fresh_airport_wins_over_farther_ones(self):
        reports = {"FVRG": [_obs_ago(5)], "FVKB": [_obs_ago(5)], "FVMV": [_obs_ago(5)]}
        with patch.object(_metar, "nearest_airports", return_value=HARARE_CANDIDATES), \
             patch.object(_metar, "_metar_for_stations", AsyncMock(return_value=reports)), \
             patch.object(_metar, "_taf_for", AsyncMock(return_value=None)):
            resp = await find_nearest_report(-17.85, 31.05)
        assert resp.icao == "FVRG"
        assert resp.metar[0].raw == "METAR X"

    async def test_no_recent_report_says_so(self):
        reports = {c.icao: [_obs_ago(600)] for c in HARARE_CANDIDATES}
        with patch.object(_metar, "nearest_airports", return_value=HARARE_CANDIDATES), \
             patch.object(_metar, "_metar_for_stations", AsyncMock(return_value=reports)):
            resp = await find_nearest_report(-17.85, 31.05)
        assert resp.status == "no_recent_report"
        assert resp.icao is None
        assert "150 km" in resp.message
        assert "3 hours" in resp.message
        assert len(resp.candidates) == 3

    async def test_no_airport_in_range(self):
        with patch.object(_metar, "nearest_airports", return_value=[]):
            resp = await find_nearest_report(-40.0, -20.0)
        assert resp.status == "no_airports"
        assert "No airport" in resp.message
        assert resp.candidates == []

    async def test_awc_failure_is_unavailable_not_blank(self):
        with patch.object(_metar, "nearest_airports", return_value=HARARE_CANDIDATES), \
             patch.object(_metar, "_metar_for_stations", AsyncMock(side_effect=RuntimeError("AWC down"))):
            resp = await find_nearest_report(-17.85, 31.05)
        assert resp.status == "unavailable"
        assert resp.message == "Aviation data temporarily unavailable."
        assert len(resp.candidates) == 3

    async def test_radius_and_age_are_echoed(self):
        with patch.object(_metar, "nearest_airports", return_value=[]):
            resp = await find_nearest_report(0, 0, radius_km=150.0, max_age_min=180)
        assert resp.searchRadiusKm == 150.0
        assert resp.maxAgeMinutes == 180
