#!/usr/bin/env python3
"""Generate tests/fixtures/single-model.json and air-quality-trend.json from
the REAL Python functions.

The Rust port (workers/crates/weather-core: blend.rs `build_single_model`,
air_quality.rs `us_aqi_same_hour_pair` / `trend` / `payload`) must produce
exactly what `api/py/_weather.py::_fetch_single_model` and
`api/py/_air_quality.py` produce. This script feeds hand-made and
seeded-random inputs through the Python and writes `{input, expected}` pairs;
the Rust tests assert the same outputs. Nothing in the fixtures is computed
by hand.

Run from the repository root:

    python3 -I scripts/gen_weather_core_fixtures.py
    npx prettier@3.9.4 --write tests/fixtures/single-model.json tests/fixtures/air-quality-trend.json

(`-I` keeps the working directory off sys.path. The script adds `api/` itself
and evicts the installed single-file `py` module, as tests/py/conftest.py does.)
"""

from __future__ import annotations

import importlib.util
import json
import random
import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))
for _k in [k for k in sys.modules if k == "py" or k.startswith("py.")]:
    del sys.modules[_k]

from py import _air_quality as aq  # noqa: E402
from py import _insights as ins  # noqa: E402
from py import _model_blend as blend  # noqa: E402
from py import _weather as weather  # noqa: E402

# The seeded Open-Meteo response builder of the blend fixtures.
_spec = importlib.util.spec_from_file_location("gen_blend", ROOT / "scripts" / "gen_model_blend_fixtures.py")
gen_blend = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gen_blend)  # type: ignore[union-attr]

SINGLE_OUT = ROOT / "tests" / "fixtures" / "single-model.json"
AQ_OUT = ROOT / "tests" / "fixtures" / "air-quality-trend.json"


def _as_best_match(raw: dict, donor: str) -> dict:
    """Add the `best_match` member Open-Meteo returns beside a picked model.

    The donor member's series are copied under the `_best_match` suffix, so
    the filler has values where the picked model has none (UV, lifted index).
    """
    out = json.loads(json.dumps(raw))
    for section in ("hourly", "daily", "minutely_15"):
        block = out.get(section) or {}
        for key in list(block):
            if key.endswith(f"_{donor}"):
                block[key[: -len(donor)] + "best_match"] = list(block[key])
    return out


def _keep_only(raw: dict, model: str) -> dict:
    """Drop every other member's series: the picked model and best_match are
    all `_fetch_single_model` reads, and the fixture stays small."""
    out = json.loads(json.dumps(raw))
    keep = (f"_{model}", "_best_match")
    for section in ("hourly", "daily", "minutely_15"):
        block = out.get(section)
        if not block:
            continue
        for key in list(block):
            if key == "time":
                continue
            suffixed = any(key.endswith(s) for s in (f"_{m}" for m in gen_blend.MEMBERS + ["best_match"]))
            if suffixed and not key.endswith(keep):
                del block[key]
    return out


def single_model_cases(now: datetime) -> list[dict]:
    cases = []
    spec = [
        ("ecmwf_ifs lacks UV and lifted index: best_match fills them", 11, blend.ECMWF_IFS, [blend.ECMWF_IFS]),
        ("icon_global", 12, blend.ICON, [blend.ICON]),
        ("jma_gsm lacks gusts, visibility and CAPE", 13, blend.JMA, [blend.JMA]),
        ("gfs_seamless has everything", 14, blend.GFS, [blend.GFS]),
        ("meteofrance_arpege_world", 15, blend.ARPEGE, [blend.ARPEGE]),
    ]
    for name, seed, model, present in spec:
        rng = random.Random(seed)
        # The picked model plus GFS, whose series become `best_match`.
        raw = gen_blend.build_raw(rng, sorted(set(present + [blend.GFS])), null_rate=0.15)
        raw = _as_best_match(raw, blend.GFS)
        cases.append({"name": name, "model": model, "raw": raw})

    # The picked model returns nothing here: the Python answers None.
    rng = random.Random(21)
    raw = _as_best_match(gen_blend.build_raw(rng, [blend.GFS]), blend.GFS)
    cases.append({"name": "the model has no data at this point", "model": blend.ECMWF_IFS, "raw": raw})

    # The current block arrives with holes the hourly series fills.
    rng = random.Random(22)
    raw = _as_best_match(gen_blend.build_raw(rng, [blend.ICON, blend.GFS]), blend.GFS)
    raw["current"]["temperature_2m"] = None
    raw["current"]["surface_pressure"] = None
    cases.append({"name": "null current values come from the current hour", "model": blend.ICON, "raw": raw})

    # A response with no minutely block and no elevation.
    rng = random.Random(23)
    raw = _as_best_match(gen_blend.build_raw(rng, [blend.ECMWF_IFS, blend.GFS]), blend.GFS)
    raw.pop("minutely_15", None)
    raw.pop("elevation", None)
    cases.append({"name": "no nowcast and no elevation", "model": blend.ECMWF_IFS, "raw": raw})

    # The real Python, with the Open-Meteo call replaced by the case's raw
    # response and the clock pinned (the insights read it for the moon).
    for case in cases:
        case["raw"] = _keep_only(case["raw"], case["model"])
        with patch.object(weather, "_open_meteo_forecast", return_value=case["raw"]), patch.object(
            weather, "derive_insights", lambda payload, _now=now: ins.derive_insights(payload, now=_now)
        ):
            case["expected"] = weather._fetch_single_model(-17.83, 31.05, case["model"])
    return cases


def baseline_model_cases() -> list[dict]:
    inputs = [
        None, "", "  ", "best_match", "ecmwf_ifs", " ecmwf_ifs ", "ecmwf_ifs04", "icon_seamless", "meteofrance_seamless",
        "gfs_seamless", "jma_gsm", "ukmo_global_deterministic_10km", "cma_grapes_global", "evil", "ECMWF_IFS",
        "ecmwf_ifs,gfs_seamless", "ecmwf_ifs025", "gem_global",
    ]
    return [{"input": i, "expected": weather._sanitize_baseline_model(i)} for i in inputs]


def air_quality_cases() -> list[dict]:
    """Full oracle for the pollutants, the same-hour pair and the payload."""

    class _Resp:
        def __init__(self, body: dict):
            self._body = body

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return self._body

    class _Client:
        def __init__(self, body: dict):
            self._body = body

        def get(self, *_a, **_k):
            return _Resp(self._body)

    def hours(day: str, n: int = 24) -> list[str]:
        return [f"{day}T{h:02d}:00" for h in range(n)]

    two_days = hours("2026-10-31") + hours("2026-11-01")

    def series(fn):
        return [fn(i) for i in range(len(two_days))]

    base = {
        "latitude": -17.83,
        "longitude": 31.05,
        "current": {
            "time": "2026-11-01T03:00",
            "pm2_5": 19.8, "pm10": 21.0, "ozone": 36.0, "nitrogen_dioxide": 10.8,
            "sulphur_dioxide": 2.0, "carbon_monoxide": 271.0, "ammonia": None,
        },
        "hourly": {"time": two_days, "us_aqi": series(lambda i: 40 + (i * 7) % 55)},
    }
    cases: list[tuple[str, dict]] = [("a full answer", base)]

    def variant(name: str, mutate) -> None:
        body = json.loads(json.dumps(base))
        mutate(body)
        cases.append((name, body))

    variant("today much better than yesterday", lambda b: b["hourly"].update(
        us_aqi=[120 if i < 24 else 40 for i in range(len(two_days))]))
    variant("today much worse than yesterday", lambda b: b["hourly"].update(
        us_aqi=[30 if i < 24 else 95 for i in range(len(two_days))]))
    variant("exactly the band is similar", lambda b: b["hourly"].update(
        us_aqi=[50 if i < 24 else 60 for i in range(len(two_days))]))
    variant("one past the band", lambda b: b["hourly"].update(
        us_aqi=[50 if i < 24 else 61 for i in range(len(two_days))]))
    variant("fractional values round half to even", lambda b: b["hourly"].update(
        us_aqi=[10.5 if i < 24 else 11.5 for i in range(len(two_days))]))
    variant("hour zero looks at yesterday's midnight", lambda b: b["current"].update(time="2026-11-01T00:00"))
    variant("month boundary", lambda b: (
        b["current"].update(time="2026-11-01T23:00")))
    variant("no hourly series", lambda b: b.pop("hourly"))
    variant("series of unequal length", lambda b: b["hourly"].update(us_aqi=[1, 2, 3]))
    variant("current time is not a timestamp", lambda b: b["current"].update(time="soon"))
    variant("no current time", lambda b: b["current"].pop("time"))
    variant("yesterday's hour is missing", lambda b: b["hourly"].update(
        time=two_days[24:], us_aqi=series(lambda i: 50)[24:]))
    variant("null values in the series", lambda b: b["hourly"].update(
        us_aqi=[None if i < 24 else 70 for i in range(len(two_days))]))
    variant("string numbers and nulls in the pollutants", lambda b: b["current"].update(
        pm2_5="35.5", pm10=None, ozone="x", carbon_monoxide=0))
    variant("seconds and a space separator in the time", lambda b: b["current"].update(time="2026-11-01 03:00:00"))
    variant("a date only", lambda b: b["current"].update(time="2026-11-01"))
    variant("a zone suffix", lambda b: b["current"].update(time="2026-11-01T03:00Z"))

    out = []
    for name, body in cases:
        side: dict = {}
        with patch.object(aq, "get_http_client", return_value=_Client(body)):
            pollutants = aq._fetch_open_meteo_air_quality(-17.83, 31.05, side)
        computed = aq.compute_aqi(pollutants)
        payload = {
            "aqi": computed["aqi"],
            "level": computed["level"],
            "dominantPollutant": computed["dominantPollutant"],
            "pollutants": pollutants,
            "subIndexes": computed["subIndexes"],
            "todayUsAqi": side.get("todayUsAqi"),
            "yesterdayAqi": side.get("yesterdayAqi"),
            "trend": aq.compute_aqi_trend(side.get("todayUsAqi"), side.get("yesterdayAqi")),
        }
        out.append({"name": name, "raw": body, "side": side, "expected": payload})
    return out


def trend_cases() -> list[dict]:
    pairs = [(None, None), (10, None), (None, 10), (50, 50), (60, 50), (61, 50), (39, 50), (40, 50), (0, 11), (11, 0),
             (500, 0), (0, 500), (-5, 5)]
    return [{"today": t, "yesterday": y, "expected": aq.compute_aqi_trend(t, y)} for t, y in pairs]


def main() -> None:
    now = datetime(2026, 10, 31, 10, 20, tzinfo=timezone.utc)
    note = "Generated by scripts/gen_weather_core_fixtures.py from the real api/py functions. Do not edit by hand."

    single = {
        "_note": note,
        "now": now.isoformat(),
        "single_model": single_model_cases(now),
        "baseline_model": baseline_model_cases(),
    }
    SINGLE_OUT.write_text(json.dumps(single, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {SINGLE_OUT.relative_to(ROOT)}: {SINGLE_OUT.stat().st_size} bytes")

    air = {
        "_note": note,
        "band": aq.AQI_TREND_BAND,
        "cases": air_quality_cases(),
        "trend": trend_cases(),
    }
    AQ_OUT.write_text(json.dumps(air, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {AQ_OUT.relative_to(ROOT)}: {AQ_OUT.stat().st_size} bytes")


if __name__ == "__main__":
    main()
