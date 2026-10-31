#!/usr/bin/env python3
"""Generate tests/fixtures/model-blend.json from the REAL Python functions.

The Rust port (workers/crates/weather-core: blend.rs, insights.rs,
enrichment.rs) must produce exactly what api/py/_model_blend.py,
api/py/_insights.py and api/py/_enrichment.py produce. This script feeds
hand-made and seeded-random inputs through the Python and writes
`{input, expected}` pairs; the Rust tests assert the same outputs. Nothing in
the fixture is computed by hand.

Run from the repository root:

    python3 -I scripts/gen_model_blend_fixtures.py

(`-I` keeps the working directory off sys.path. The script adds `api/` itself
and evicts the installed single-file `py` module, as tests/py/conftest.py does.)
"""

from __future__ import annotations

import json
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))
for _k in [k for k in sys.modules if k == "py" or k.startswith("py.")]:
    del sys.modules[_k]

from py import _enrichment as enr  # noqa: E402
from py import _insights as ins  # noqa: E402
from py import _model_blend as blend  # noqa: E402

OUT = ROOT / "tests" / "fixtures" / "model-blend.json"

MEMBERS = [
    blend.ECMWF_IFS, blend.ECMWF_AIFS, blend.GFS, blend.ICON, blend.GEM, blend.ARPEGE,
    blend.UKMO, blend.CMA, blend.JMA,
]
HOURS = 26
DAYS = 4


def _hours(n: int) -> list[str]:
    return [f"2026-10-31T{h % 24:02d}:00" if h < 24 else f"2026-11-01T{h % 24:02d}:00" for h in range(n)]


def _days(n: int) -> list[str]:
    return ["2026-10-31"] + [f"2026-11-{i:02d}" for i in range(1, n)]


def build_raw(rng: random.Random, present: list[str], null_rate: float = 0.08) -> dict:
    """A realistic multi-model Open-Meteo response with model-suffixed arrays."""
    times = _hours(HOURS)
    dtimes = _days(DAYS)
    hourly: dict = {"time": times}
    daily: dict = {"time": dtimes}
    # UV, lifted index: GFS only. Visibility: some members. CAPE: some.
    only = {"uv_index": {blend.GFS}, "lifted_index": {blend.GFS}}
    # JMA publishes no gusts, visibility or CAPE; the AIFS publishes no gusts (live-checked).
    some = {
        "visibility": {blend.GFS, blend.UKMO, blend.CMA, blend.ECMWF_IFS},
        "cape": set(MEMBERS) - {blend.JMA, blend.ECMWF_AIFS},
        "wind_gusts_10m": set(MEMBERS) - {blend.JMA, blend.ECMWF_AIFS},
    }

    def num(lo, hi, nd=1):
        if rng.random() < null_rate:
            return None
        return round(rng.uniform(lo, hi), nd)

    spec_h = {
        "temperature_2m": (8, 34, 1),
        "relative_humidity_2m": (15, 99, 0),
        "apparent_temperature": (6, 38, 1),
        "precipitation_probability": (0, 100, 0),
        "precipitation": (0, 4, 2),
        "wind_speed_10m": (0, 40, 1),
        "wind_gusts_10m": (0, 70, 1),
        "surface_pressure": (840, 860, 1),
        "cloud_cover": (0, 100, 0),
        "uv_index": (0, 11, 2),
        "visibility": (2000, 24000, 0),
        "dew_point_2m": (0, 20, 1),
        "cape": (0, 3200, 0),
        "lifted_index": (-8, 6, 1),
    }
    for model in MEMBERS:
        for var, (lo, hi, nd) in spec_h.items():
            if model not in present:
                hourly[f"{var}_{model}"] = [None] * HOURS
                continue
            if var in only and model not in only[var]:
                hourly[f"{var}_{model}"] = [None] * HOURS
                continue
            if var in some and model not in some[var]:
                hourly[f"{var}_{model}"] = [None] * HOURS
                continue
            hourly[f"{var}_{model}"] = [num(lo, hi, nd) for _ in range(HOURS)]
        hourly[f"weather_code_{model}"] = (
            [rng.choice([0, 1, 2, 3, 45, 51, 61, 63, 80, 95, 96, 99]) for _ in range(HOURS)]
            if model in present
            else [None] * HOURS
        )
        hourly[f"wind_direction_10m_{model}"] = (
            [rng.choice([None, rng.randint(0, 359), rng.randint(340, 359), rng.randint(0, 20)]) for _ in range(HOURS)]
            if model in present
            else [None] * HOURS
        )
        hourly[f"is_day_{model}"] = [1 if 5 <= h % 24 < 18 else 0 for h in range(HOURS)] if model in present else [None] * HOURS

        spec_d = {
            "temperature_2m_max": (20, 36, 1),
            "temperature_2m_min": (4, 20, 1),
            "apparent_temperature_max": (20, 38, 1),
            "apparent_temperature_min": (2, 20, 1),
            "uv_index_max": (3, 12, 2),
            "precipitation_sum": (0, 25, 2),
            "precipitation_probability_max": (0, 100, 0),
            "wind_speed_10m_max": (5, 45, 1),
            "wind_gusts_10m_max": (10, 75, 1),
            "et0_fao_evapotranspiration": (1, 8, 2),
        }
        for var, (lo, hi, nd) in spec_d.items():
            if model not in present or (var == "uv_index_max" and model != blend.GFS):
                daily[f"{var}_{model}"] = [None] * DAYS
            else:
                daily[f"{var}_{model}"] = [num(lo, hi, nd) for _ in range(DAYS)]
        daily[f"weather_code_{model}"] = (
            [rng.choice([0, 3, 61, 63, 80, 95]) for _ in range(DAYS)] if model in present else [None] * DAYS
        )
        daily[f"wind_direction_10m_dominant_{model}"] = (
            [rng.randint(0, 359) for _ in range(DAYS)] if model in present else [None] * DAYS
        )
        daily[f"sunrise_{model}"] = [f"{d}T05:4{i % 10}" for i, d in enumerate(dtimes)] if model in present else [None] * DAYS
        daily[f"sunset_{model}"] = [f"{d}T18:1{i % 10}" for i, d in enumerate(dtimes)] if model in present else [None] * DAYS

    current = {
        "time": "2026-10-31T10:15",
        "interval": 900,
        "temperature_2m": 24.3,
        "relative_humidity_2m": None,
        "apparent_temperature": 25.0,
        "precipitation": 0.0,
        "weather_code": None,
        "wind_speed_10m": 11.2,
        "wind_direction_10m": None,
        "wind_gusts_10m": None,
        "surface_pressure": 851.2,
        "cloud_cover": None,
        "uv_index": None,
        "is_day": None,
    }
    return {
        "current": current,
        "current_units": {"temperature_2m": "°C"},
        "hourly": hourly,
        "daily": daily,
        "minutely_15": {
            "time": [f"2026-10-31T10:{m:02d}" for m in (15, 30, 45)] + [f"2026-10-31T11:{m:02d}" for m in (0, 15, 30, 45, 0)],
            "precipitation_ecmwf_ifs": [0.0, 0.1, None, 0.3, 0, 0, 0, 0],
        },
        "utc_offset_seconds": 7200,
        "timezone": "Africa/Harare",
        "elevation": 1490.0,
    }


def handmade(codes: list, dirs: list, probs: list | None = None, weights: dict | None = None) -> tuple[dict, dict]:
    """Single hourly step, hand-picked per-member values."""
    models = list(weights) if weights else MEMBERS[: len(codes)]
    hourly = {"time": ["2026-10-31T10:00"]}
    for i, m in enumerate(models):
        hourly[f"weather_code_{m}"] = [codes[i]]
        hourly[f"wind_direction_10m_{m}"] = [dirs[i]]
        hourly[f"precipitation_{m}"] = [0.0 if (probs is None or probs[i] is None) else probs[i]]
        hourly[f"precipitation_probability_{m}"] = [None if probs is None else (None if probs[i] is None else probs[i] * 100)]
    raw = {"current": {"time": "2026-10-31T10:00"}, "hourly": hourly, "daily": {"time": []}}
    w = weights or {m: 1.0 for m in models}
    return raw, w


def main() -> None:
    fx: dict = {"_note": "Generated by scripts/gen_model_blend_fixtures.py from api/py/_model_blend.py, _insights.py, _enrichment.py. Do not edit by hand."}

    # --- regions -------------------------------------------------------
    points = {
        "Harare": (-17.83, 31.05), "Nairobi": (-1.29, 36.82), "Lagos": (6.52, 3.38), "Cairo": (30.04, 31.24),
        "London": (51.5, -0.12), "Singapore": (1.35, 103.82), "Mid-Atlantic": (0.0, -30.0), "South Pole": (-89.0, 0.0),
        "Taba": (29.49, 34.89), "Port Sudan": (19.6, 37.2), "Tangier": (35.78, -5.8), "Madrid": (40.4, -3.7),
        "Athens": (37.98, 23.73), "Tel Aviv": (32.08, 34.78), "Riyadh": (24.7, 46.7), "Delhi": (28.6, 77.2),
        "Bangkok": (13.75, 100.5), "Tokyo": (35.7, 139.7), "Sydney": (-33.9, 151.2), "New York": (40.7, -74.0),
        "Sao Paulo": (-23.5, -46.6), "Moscow": (55.75, 37.6), "Kinshasa": (-4.3, 15.3), "Cape Town": (-33.9, 18.4),
        "Sanaa": (15.35, 44.2), "Aden": (12.8, 45.0), "Dakar": (14.7, -17.4), "Mogadishu": (2.05, 45.3),
        "Reykjavik": (64.1, -21.9), "Anchorage": (61.2, -149.9),
    }
    fx["regions"] = [{"name": n, "lat": la, "lon": lo, "expected": blend.region_for(la, lo)} for n, (la, lo) in points.items()]

    # --- weights -------------------------------------------------------
    fx["weights"] = []
    for region in list(blend.BLEND_WEIGHTS) + ["no-such-region"]:
        w = blend.weights_for(region)
        fx["weights"].append(
            {"region": region, "expected": w, "order": blend.order_members(w), "header": blend.format_weights(region, w)}
        )
    sub = {m: blend.BLEND_WEIGHTS["default"][m] for m in (blend.GFS, blend.ECMWF_IFS, blend.ICON, blend.GEM)}
    fx["format_weights"] = [{"region": "southern-africa", "weights": sub, "expected": blend.format_weights("southern-africa", sub)}]

    # --- hand-made blend_section --------------------------------------
    sec = []
    for name, (codes, dirs, probs, weights) in {
        "wind wrap 350/10 equal weights": ([1, 1], [350, 10], None, {"a": 1.0, "b": 1.0}),
        "wind wrap three members": ([1, 1, 1], [350, 10, 5], None, {"a": 0.5, "b": 0.3, "c": 0.2}),
        "opposite winds cancel": ([1, 1], [90, 270], None, {"a": 1.0, "b": 1.0}),
        "tied weather codes go to the more severe": ([3, 61], [0, 0], None, {"a": 0.5, "b": 0.5}),
        "tied codes 95 vs 0": ([95, 0, 95, 0], [0, 0, 0, 0], None, {"a": 0.25, "b": 0.25, "c": 0.25, "d": 0.25}),
        "heavier code wins the vote": ([3, 3, 61], [0, 0, 0], None, {"a": 0.35, "b": 0.25, "c": 0.4}),
        "agreement only (no ensemble probability)": ([0, 0, 0], [0, 0, 0], None, {"a": 0.5, "b": 0.3, "c": 0.2}),
    }.items():
        raw, w = handmade(codes, dirs, probs, weights)
        # models named a/b/c/d have no BLENDABLE restriction in blend_section
        vars_ = ["weather_code", "wind_direction_10m", "precipitation", "precipitation_probability"]
        sec.append({"name": name, "section": raw["hourly"], "variables": vars_, "weights": w, "expected": blend.blend_section(raw["hourly"], vars_, w)})
    # ensemble + agreement mixture, rounding ties (x.5) included
    hourly = {
        "time": ["t0", "t1", "t2", "t3"],
        "precipitation_probability_a": [50, 25, None, 10],
        "precipitation_probability_b": [50, 26, None, None],
        "precipitation_a": [0.2, 0.0, 0.0, 0.0],
        "precipitation_b": [0.0, 0.0, 0.2, 0.1],
    }
    fx_w = {"a": 0.5, "b": 0.5}
    sec.append({"name": "probability = 0.5 ensemble + 0.5 agreement", "section": hourly,
                "variables": ["precipitation_probability"], "weights": fx_w,
                "expected": blend.blend_section(hourly, ["precipitation_probability"], fx_w)})
    daily = {
        "time": ["d0", "d1"],
        "precipitation_probability_max_a": [60, None], "precipitation_probability_max_b": [40, None],
        "precipitation_sum_a": [1.0, 0.99], "precipitation_sum_b": [0.0, 1.0],
    }
    sec.append({"name": "daily agreement threshold is 1 mm", "section": daily, "variables": ["precipitation_probability_max"],
                "weights": fx_w, "agreement_threshold": 1.0, "precip_var": "precipitation_sum",
                "expected": blend.blend_section(daily, ["precipitation_probability_max"], fx_w, agreement_threshold=1.0, precip_var="precipitation_sum")})
    # rounding: banker's ties and per-variable decimals
    hourly = {"time": ["t0", "t1", "t2"], "temperature_2m_a": [20.25, 20.35, None], "temperature_2m_b": [20.25, 20.35, None],
              "relative_humidity_2m_a": [50.5, 51.5, None], "relative_humidity_2m_b": [50.5, 51.5, 70],
              "precipitation_a": [0.125, 0.135, 0.0], "precipitation_b": [0.125, 0.135, 0.0],
              "lifted_index_a": [-2.345, None, None], "lifted_index_b": [None, None, None],
              "is_day_a": [None, 1, 0], "is_day_b": [1, 0, 1]}
    vars_ = ["temperature_2m", "relative_humidity_2m", "precipitation", "lifted_index", "is_day"]
    sec.append({"name": "rounding and first non-null", "section": hourly, "variables": vars_, "weights": fx_w,
                "expected": blend.blend_section(hourly, vars_, fx_w)})
    # single-model (unsuffixed keys)
    hourly = {"time": ["t0", "t1"], "temperature_2m": [10.04, 11.06], "weather_code": [3, 61]}
    sec.append({"name": "single model reads unsuffixed keys", "section": hourly, "variables": ["temperature_2m", "weather_code"],
                "weights": {"gfs_seamless": 1.0}, "single": True,
                "expected": blend.blend_section(hourly, ["temperature_2m", "weather_code"], {"gfs_seamless": 1.0}, single=True)})
    fx["blend_section"] = sec

    # --- full blend_payload -------------------------------------------
    now = datetime(2026, 10, 31, 10, 20, tzinfo=timezone.utc)
    fx["now"] = now.isoformat()
    payloads = []
    cases = [
        ("nine members, seed 1", 1, MEMBERS, "southern-africa"),
        ("the original six present, the three newer members absent", 2, MEMBERS[:6], "europe"),
        ("eight present, one member all-null (dropped, weights renormalised)", 6, [m for m in MEMBERS if m != blend.JMA], "east-asia"),
        ("four members present (floor)", 3, [blend.ECMWF_IFS, blend.GFS, blend.ICON, blend.ARPEGE], "default"),
        ("three members present (below the new floor)", 4, [blend.ECMWF_IFS, blend.GFS, blend.GEM], "east-africa"),
        ("one member present", 5, [blend.GFS], "north-america"),
    ]
    for name, seed, present, region in cases:
        rng = random.Random(seed)
        raw = build_raw(rng, present)
        weights = blend.weights_for(region)
        pm = blend.members_with_data(raw, blend.order_members(weights))
        used = {m: weights[m] for m in pm}
        out = blend.blend_payload(raw, used) if used else None
        entry = {
            "name": name, "region": region, "raw": raw, "present": pm, "weights_used": used, "expected_present_count": len(pm),
            "minutely": blend.parse_minutely_any(raw, blend.order_members(weights), steps=8),
            "elevation": blend.forecast_elevation(raw),
        }
        if out is not None:
            entry["expected"] = out
            entry["insights"] = ins.derive_insights(out, now=now)
            entry["header"] = blend.format_weights(region, used)
        payloads.append(entry)
    fx["blend_payload"] = payloads

    # elevation edge cases and minutely_any
    fx["forecast_elevation"] = [
        {"raw": r, "expected": blend.forecast_elevation(r)}
        for r in [{"elevation": 1490.0}, {"elevation": -9999}, {"elevation": 9000}, {"elevation": 8848}, {"elevation": True},
                  {"elevation": "12"}, {}, {"elevation": 0}, {"elevation": -999.9}]
    ]
    fx["minutely_any"] = [
        {"name": "unsuffixed", "raw": {"minutely_15": {"time": ["a", "b", "c"], "precipitation": [0.1, None, 0.3]}}, "steps": 2},
        {"name": "first member with data", "raw": {"minutely_15": {"time": ["a", "b"], "precipitation_gfs_seamless": [None, None], "precipitation_icon_global": [0.2, None]}}, "steps": 4},
        {"name": "none", "raw": {}, "steps": 4},
    ]
    for case in fx["minutely_any"]:
        case["models"] = ["gfs_seamless", "icon_global"]
        case["expected"] = blend.parse_minutely_any(case["raw"], case["models"], steps=case["steps"])

    # --- insights pure helpers ----------------------------------------
    fx["dew_point"] = [{"t": t, "rh": rh, "expected": ins.dew_point_c(t, rh)} for t, rh in
                       [(25, 60), (0, 100), (-10, 40), (35.5, 0), (20, 150), (None, 50), (20, None), (14.2, 87.3)]]
    fx["heat_index"] = [{"t": t, "rh": rh, "expected": ins.heat_index_c(t, rh)} for t, rh in
                        [(26.9, 80), (27, 50), (32, 70), (35, 10), (30.5, 90), (40, 12), (29, 86), (None, 5), (31, None)]]
    fx["gdd"] = [{"tmax": a, "tmin": b, "base": base, "cap": cap, "expected": ins.growing_degree_days(a, b, base, cap)}
                 for a, b in [(30, 12), (35, 5), (8, 2), (None, 3), (22.3, 11.7)] for base, cap in [(10.0, 30.0), (3.0, 25.0)]]
    fx["wmo_hazards"] = [{"code": c, "expected": list(ins.wmo_hazards(c))} for c in [None, 0, 3, 51, 56, 61, 66, 71, 77, 80, 85, 95, 96, 99]]
    fx["convective"] = [{"cape": c, "li": li, "expected": ins.convective_proxy(c, li)} for c, li in
                        [(None, None), (2500, None), (None, -6), (1000, 3), (999, -2.9), (500, None), (None, -1), (499, -0.9), (3000, -9)]]
    moons = [datetime(2000, 1, 6, 18, 14, tzinfo=timezone.utc), datetime(2026, 10, 31, tzinfo=timezone.utc),
             datetime(2026, 11, 9, 12, tzinfo=timezone.utc), datetime(2026, 11, 24, tzinfo=timezone.utc),
             datetime(2030, 3, 3, 3, tzinfo=timezone.utc), datetime(1999, 12, 25, tzinfo=timezone.utc)]
    fx["moon_phase"] = [{"at": m.isoformat(), "expected": ins.moon_phase(m)} for m in moons]
    fx["cloud_base"] = [{"t": t, "td": td, "cover": c, "expected": ins.cloud_base_km(t, td, c)} for t, td, c in
                        [(25, 10, 60), (25, 10, 5), (25, 10, 10), (10, 12, 80), (None, 1, 50), (20, 5, None), (30.3, 8.8, 49.9)]]
    fx["hour_index"] = [{"hourly": {"time": ["2026-10-31T09:00", "2026-10-31T10:00"]}, "current": c, "expected": ins.current_hour_index({"time": ["2026-10-31T09:00", "2026-10-31T10:00"]}, c)}
                        for c in ["2026-10-31T10:15", "2026-10-31T08:00", None]]

    # derive_insights: hand-made edge cases
    derive = []
    base_hourly = {
        "time": _hours(10), "visibility": [24000] * 10, "dew_point_2m": [12.0] * 10, "cape": [0, 0, 600, 0, 0, 0, 3000, 0, 0, 0],
        "lifted_index": [None] * 10, "weather_code": [1, 1, 3, 3, 95, 3, 3, 3, 3, 3], "precipitation_probability": [5] * 10, "uv_index": [6.5] * 10,
    }
    base_daily = {"time": _days(2), "temperature_2m_max": [31.5, 30], "temperature_2m_min": [14.2, 13], "et0_fao_evapotranspiration": [5.5, 5]}
    for name, patch in {
        "typical": {},
        "dry atmosphere halves the convective score": {"hourly": {"precipitation_probability": [0] * 10}},
        "no probability array keeps the score": {"hourly": {"precipitation_probability": []}},
        "no dew point falls back to Magnus": {"hourly": {"dew_point_2m": []}},
        "clear sky: no cloud base": {"current": {"cloud_cover": 5}},
        "overcast: cloud ceiling set": {"current": {"cloud_cover": 90}},
        "partly cloudy: ceiling is null": {"current": {"cloud_cover": 30}},
        "hot and humid": {"current": {"temperature_2m": 33, "relative_humidity_2m": 80}},
        "snow": {"current": {"weather_code": 73}},
        "missing sections": None,
    }.items():
        if patch is None:
            data = {"current": {}, "hourly": {}, "daily": {}}
        else:
            data = {
                "current": {"time": "2026-10-31T01:30", "temperature_2m": 24.0, "relative_humidity_2m": 55, "wind_speed_10m": 9.5,
                            "wind_gusts_10m": 20, "weather_code": 3, "cloud_cover": 60, "uv_index": None},
                "hourly": dict(base_hourly), "daily": dict(base_daily),
            }
            for sect, vals in patch.items():
                data[sect] = {**data[sect], **vals}
        derive.append({"name": name, "data": data, "expected": ins.derive_insights(data, now=now)})
    fx["derive_insights"] = derive

    # --- enrichment pure rules ----------------------------------------
    fx["merge_insights"] = [
        {"baseline": b, "enrichment": e, "expected": enr.merge_insights(b, e)} for b, e in [
            ({"windSpeed": 9, "cloudBase": 1.2, "uvHealthConcern": 6}, {"cloudBase": 0.8, "uvHealthConcern": 3, "windSpeed": 99, "moonPhase": 4}),
            (None, {"thunderstormProbability": 40}),
            ({"gdd10To30": 8.1}, None),
            ({"gdd10To30": 8.1, "cloudCeiling": None}, {"cloudCeiling": 2.0, "heatStressIndex": None, "precipitationType": 1}),
        ]
    ]
    fx["classify_429"] = [
        {"headers": h, "expected": enr.classify_429(h)} for h in [
            {"x-ratelimit-remaining-hour": "0"}, {"x-ratelimit-remaining-day": "0", "x-ratelimit-remaining-hour": "3"},
            {"x-ratelimit-remaining-hour": "3", "x-ratelimit-remaining-day": "100"}, {}, {"x-ratelimit-remaining-hour": "x"},
            {"x-ratelimit-remaining-hour": " 0 "}, {"x-ratelimit-remaining-day": "-1"},
        ]
    ]
    fx["enrichment_constants"] = {
        "hourly_cap": enr.HOURLY_CAP, "daily_cap": enr.DAILY_CAP, "hourly_cap_normal": enr.HOURLY_CAP_NORMAL,
        "daily_cap_normal": enr.DAILY_CAP_NORMAL, "ttl_s": enr.ENRICHMENT_TTL_S, "empty_ttl_s": enr.EMPTY_ENRICHMENT_TTL_S,
        "unclear_429_memo_s": enr.UNCLEAR_429_MEMO_S, "fields": list(enr.ENRICHMENT_FIELDS),
    }

    # --- weather.modelBlendConfig overrides (Python weights_for with a fake DB) ---
    import types

    def override_case(name, doc, region="east-africa"):
        fake = types.ModuleType("py._db")

        class _Coll:
            def find_one(self, *_a, **_k):
                return doc

        class _DB:
            def __getitem__(self, _k):
                return _Coll()

        fake.weather_db = lambda: _DB()
        sys.modules["py._db"] = fake
        blend._reset_config_cache()
        try:
            got = blend.weights_for(region)
        finally:
            del sys.modules["py._db"]
            blend._reset_config_cache()
        return {"name": name, "region": region, "doc": doc, "expected": got}

    fx["weights_override"] = [
        override_case("valid subset replaces the compiled-in set", {"weights": {"gfs_seamless": 0.7, "ecmwf_ifs": 0.3}}),
        override_case("unknown ids and non-positive weights are dropped", {"weights": {"gfs_seamless": 0.7, "ecmwf_ifs": 0.3, "evil": 5, "icon_global": -1, "gem_global": 0}}),
        override_case("a newer member can be tuned", {"weights": {"ukmo_global_deterministic_10km": 0.4, "ecmwf_ifs": 0.6}}),
        override_case("a string weight is dropped", {"weights": {"ecmwf_ifs": "0.9", "gfs_seamless": 0.1}}),
        override_case("nothing usable falls back to the constants", {"weights": {"evil": 1, "gfs_seamless": -2}}),
        override_case("weights that are not an object fall back", {"weights": [1, 2]}),
        override_case("a document without weights falls back", {"_id": "east-africa"}),
        override_case("no document falls back", None),
    ]

    OUT.write_text(json.dumps(fx, indent=2, ensure_ascii=False, sort_keys=False) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}: {OUT.stat().st_size} bytes")


if __name__ == "__main__":
    main()
