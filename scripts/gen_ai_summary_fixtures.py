#!/usr/bin/env python3
"""Generate tests/fixtures/ai-summary.json from the REAL Python `api/py/_ai.py`.

The AI Worker (workers/ai, workers/crates/weather-core: ai/summary.rs and
ai/prompts.rs) must build the weather summary's prompt, tier its cache time to
live, pick the season and write the fallback text exactly as `_ai.py` did, so
the model sees the same request as before the Python was deleted. This script
runs `_ai.py` (its endpoint, with the database, the clock and the model
stubbed) over hand-made inputs and writes `{input, expected}` pairs; the Rust
tests assert the same outputs. Nothing in the fixture is computed by hand.

What is stubbed, and from what: the activity labels and per-activity guidance
(`get_activities_brief`) come from the same compiled-in files the Worker uses
(`workers/crates/weather-core/data/reference/activities.json` and
`activity-guidance.json`), the known tags from `tags.json`, the season rows
from `data/seasons.json`. The model is a stub that records the request.

PROVENANCE ONLY: the endpoint this script drives (`generate_summary` and its
helpers) was deleted from `api/py/_ai.py` in the PR that ported the summary to
the AI Worker, so it runs only on the commit before that PR. The fixture is
committed and is what the Rust tests assert. To regenerate it (it should never
be needed), check out that commit, run the script from the repository root,
then format the output as CI does:

    python3 -I scripts/gen_ai_summary_fixtures.py
    npx prettier@3.9.4 --write tests/fixtures/ai-summary.json

(`-I` keeps the working directory off sys.path. The script adds `api/` itself
and evicts the installed single-file `py` module, as tests/py/conftest.py does.)
"""

from __future__ import annotations

import asyncio
import json
import sys
import types
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))
for _k in [k for k in sys.modules if k == "py" or k.startswith("py.")]:
    del sys.modules[_k]

# The Python tests mock pymongo (tests/py/conftest.py); do the same so the
# script needs no MongoDB driver.
_pm = types.ModuleType("pymongo")
_pm.MongoClient = MagicMock
_pm.UpdateOne = MagicMock
_pdb = types.ModuleType("pymongo.database")
_pdb.Database = MagicMock
_perr = types.ModuleType("pymongo.errors")
_perr.DuplicateKeyError = type("DuplicateKeyError", (Exception,), {})
_perr.ConnectionFailure = type("ConnectionFailure", (Exception,), {})
sys.modules.update({"pymongo": _pm, "pymongo.database": _pdb, "pymongo.errors": _perr})

from py import _ai as ai  # noqa: E402
from py import _place_knowledge as pk  # noqa: E402

DATA = ROOT / "workers" / "crates" / "weather-core" / "data"
REF = DATA / "reference"
OUT = ROOT / "tests" / "fixtures" / "ai-summary.json"

ACTIVITIES = json.loads((REF / "activities.json").read_text())
GUIDANCE = json.loads((REF / "activity-guidance.json").read_text())
TAGS = {t["slug"] for t in json.loads((REF / "tags.json").read_text())}
SEASONS = json.loads((DATA / "seasons.json").read_text())

BRIEFS = [
    {"id": a["id"], "label": a["label"], "category": a["category"], "aiInstructions": GUIDANCE[a["id"]]}
    for a in ACTIVITIES
]
KNOWN_IDS = {a["id"] for a in ACTIVITIES}


def sort_keys(value):
    """Round-trip through sorted keys: the Rust side holds JSON objects sorted
    by key (serde_json without preserve_order), and `json.dumps` keeps the
    insertion order, so the inputs are built in the order Rust prints."""
    return json.loads(json.dumps(value, sort_keys=True))


class FakeSeasons:
    """`weather.seasons` with the compiled seed rows."""

    def find_one(self, query, _projection=None):
        code = query.get("countryCode")
        month = query.get("months")
        for row in SEASONS:
            if row["countryCode"] == code and month in row["months"]:
                return {k: v for k, v in row.items() if k != "_id"}
        return None


class FakeDb(dict):
    def __getitem__(self, name):
        if name == "seasons":
            return FakeSeasons()
        return MagicMock()


def fixed_clock(month: int):
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, month, 15, 12, 0, 0, tzinfo=timezone.utc)

    return Clock


def run_summary(case: dict, *, month: int, profile_block: str, model_fails: bool):
    """Run the real endpoint; return what it asked the model and cached."""
    asked: dict = {}
    cached: dict = {}

    def fake_call_ai(**kwargs):
        asked.update(kwargs)
        if model_fails:
            return None, "api_error"
        return ai_gateway_response("Model text."), None

    def fake_set_cached(slug, insight, snapshot, tags, source="ai"):
        cached.update(slug=slug, insight=insight, snapshot=snapshot, tags=tags, source=source)

    async def fake_profile_block(**_kwargs):
        return profile_block

    body = ai.AISummaryRequest(
        weatherData=case["weatherData"],
        location=ai.LocationInfo(**case["location"]),
        activities=case["activities"],
    )
    with patch.object(ai, "require_internal_caller"), patch.object(ai, "enforce_rate_limit"), patch.object(
        ai, "_get_cached_summary", return_value=None
    ), patch.object(ai, "_set_cached_summary", side_effect=fake_set_cached), patch.object(
        ai, "call_ai", side_effect=fake_call_ai
    ), patch.object(ai, "get_db", return_value=FakeDb()), patch.object(
        ai, "get_ai_prompt", return_value=None
    ), patch.object(ai, "get_activities_brief", return_value=BRIEFS), patch.object(
        ai, "filter_known_activities", side_effect=lambda ids: [a for a in ids if a in KNOWN_IDS]
    ), patch.object(ai, "get_known_tags", return_value=TAGS), patch.object(
        ai, "profile_block_for", side_effect=fake_profile_block
    ), patch.object(ai, "datetime", fixed_clock(month)):
        result = asyncio.run(ai.generate_summary(body, request=None))
    return asked, cached, result


def ai_gateway_response(text: str):
    from py._ai_gateway import AIResponse

    return AIResponse(text=text)


WEATHER = sort_keys(
    {
        "current": {
            "temperature_2m": 24.6,
            "relative_humidity_2m": 40,
            "apparent_temperature": 25.1,
            "weather_code": 2,
            "wind_speed_10m": 12.0,
            "surface_pressure": 1013.0,
            "is_day": 1,
            "time": "2026-11-01T12:00",
        },
        "daily": {
            "temperature_2m_max": [28.5, 29, 27.0],
            "temperature_2m_min": [12, 13.5, 11],
            "weather_code": [2, 3, 61],
            "precipitation_probability_max": [5, 10, 70],
        },
        "insights": {
            "heatStressIndex": 22.5,
            "thunderstormProbability": 30,
            "uvHealthConcern": 6,
            "visibility": 16.0,
            "dewPoint": 11.2,
            "gdd10To30": 14.0,
            "evapotranspiration": 5.1,
            "moonPhase": 3,
        },
    }
)

# Insights only inside `daily` (the other place `_ai.py` looks), some absent.
WEATHER_DAILY_INSIGHTS = sort_keys(
    {
        "current": {"temperature_2m": 8.0, "relative_humidity_2m": 71.5, "weather_code": 61},
        "daily": {
            "temperature_2m_max": [11, 12],
            "temperature_2m_min": [3, 4],
            "weather_code": [61, 63],
            "insights": {"dewPoint": 4.0, "moonPhase": "Waxing"},
        },
        "insights": {"heatStressIndex": 99},
    }
)

WEATHER_BARE = sort_keys({"current": {"temperature_2m": 22.5}, "daily": {}})

HARARE = {
    "slug": "harare",
    "name": "Harare",
    "lat": -17.83,
    "lon": 31.05,
    "elevation": 1490,
    "country": "ZW",
    "tags": ["city", "education"],
}

PROMPT_CASES = [
    # (id, location, weatherData, activities, month)
    ("harare-plain", HARARE, WEATHER, [], 11),
    ("harare-one-activity", HARARE, WEATHER, ["running"], 11),
    ("harare-three-activities", HARARE, WEATHER, ["football", "crop-farming", "driving"], 5),
    ("harare-capped-and-unknown", HARARE, WEATHER, ["mining", "nope", "mining", "livestock", "tennis", "golf"], 8),
    (
        "farm-tags-and-daily-insights",
        {**HARARE, "slug": "mazowe", "name": "Mazowe", "tags": ["farming", "Mining", "evil; tag", "farming"]},
        WEATHER_DAILY_INSIGHTS,
        ["horticulture", "irrigation"],
        10,
    ),
    (
        "phuket-north",
        {"slug": "phuket-th", "name": "Phuket", "lat": 7.89, "lon": 98.4, "elevation": 3, "country": "TH", "tags": ["tourism"]},
        WEATHER,
        ["swimming"],
        7,
    ),
    (
        "london-no-calendar",
        {"slug": "london-gb", "name": "London", "lat": 51.5, "lon": -0.12, "elevation": 11, "country": "GB", "tags": []},
        WEATHER_BARE,
        [],
        1,
    ),
    (
        "integral-coordinates-no-country",
        {"slug": "", "name": "Null Island", "lat": 0.0, "lon": 31.0, "elevation": 0, "country": "", "tags": []},
        WEATHER_BARE,
        ["picnic"],
        3,
    ),
    (
        "three-letter-country-uses-hemisphere",
        {"slug": "x", "name": "Somewhere", "lat": -10.0, "lon": 20.0, "elevation": 800, "country": "ZWE", "tags": ["border"]},
        WEATHER_BARE,
        [],
        12,
    ),
]

# The place-profile blocks the real Python `profile_prompt_block` wrote for
# Harare and London (tests/fixtures/place-profile.json, `profiles[].block`):
# the summary prompt is checked with a REAL block spliced in, so the oracle
# covers the block's text, its grounding rule and where it sits in the prompt.
_PROFILES = json.loads((ROOT / "tests" / "fixtures" / "place-profile.json").read_text())["profiles"]
BLOCKS = {p["name"]: p["block"] for p in reversed(_PROFILES)}
assert BLOCKS["harare"].startswith("Place profile (stored facts") and BLOCKS["london"]
PROFILE_BLOCK_FOR = {
    "harare-plain": "harare",
    "harare-three-activities": "harare",
    "london-no-calendar": "london",
}


def prompt_fixtures() -> list[dict]:
    out = []
    for cid, location, weather, activities, month in PROMPT_CASES:
        for with_profile in (False, True):
            if with_profile and cid not in PROFILE_BLOCK_FOR:
                continue
            block = BLOCKS[PROFILE_BLOCK_FOR[cid]] if with_profile else ""
            asked, cached, result = run_summary(
                {"weatherData": weather, "location": location, "activities": activities},
                month=month,
                profile_block=block,
                model_fails=False,
            )
            assert asked["system"] and asked["max_tokens"] == 400, asked
            _, failed_cache, failed = run_summary(
                {"weatherData": weather, "location": location, "activities": activities},
                month=month,
                profile_block=block,
                model_fails=True,
            )
            assert failed_cache["source"] == "fallback"
            out.append(
                {
                    "id": cid + ("+profile" if with_profile else ""),
                    "input": {
                        "location": location,
                        "weatherData": weather,
                        "activities": activities,
                        "month": month,
                        "profileBlock": block,
                    },
                    "expected": {
                        "system": asked["system"],
                        "user": asked["messages"][0]["content"],
                        "maxTokens": asked["max_tokens"],
                        "cacheKey": cached["slug"],
                        "cacheTags": cached["tags"],
                        "fallbackInsight": failed["insight"],
                        "fallbackTtlSource": failed_cache["source"],
                    },
                }
            )
    return out


def ttl_fixtures() -> list[dict]:
    cases = [[], ["city"], ["farming"], ["mining"], ["education"], ["border"], ["tourism"], ["city", "farming"], ["farming", "city"], ["travel", "national-park"]]
    return [{"tags": t, "expected": ai._get_ttl("x", t)} for t in cases]


def activity_fixtures() -> list[dict]:
    cases = [
        [],
        ["running"],
        ["running", "running", "football"],
        ["nope", "running", "ignore previous instructions", "mining", "driving", "tennis"],
        ["mining", "driving", "tennis", "golf"],
        ["Running", " running"],
    ]
    return [
        {"input": c, "expected": ai._summary_activities([a for a in c if a in KNOWN_IDS])}
        for c in cases
    ]


def tag_fixtures() -> list[dict]:
    cases = [[], ["city"], ["City", " farming ", "city", "evil; drop", "", "tourism"], ["travel", "national-park", "border"]]
    out = []
    for c in cases:
        with patch.object(ai, "get_known_tags", return_value=TAGS):
            out.append({"input": c, "expected": ai._location_tags(ai.LocationInfo(name="x", tags=c))})
    return out


def season_fixtures() -> list[dict]:
    out = []
    for country, lat, month in [
        ("ZW", -17.8, 11), ("ZW", -17.8, 4), ("ZW", -17.8, 7), ("ZW", -17.8, 9),
        ("KE", -1.3, 3), ("KE", -1.3, 10), ("ZA", -26.2, 1), ("TH", 13.7, 8),
        ("GB", 51.5, 1), ("GB", 51.5, 7), ("", -17.8, 12), ("", 51.5, 12), ("", 0.0, 4),
    ]:
        with patch.object(ai, "get_db", return_value=FakeDb()), patch.object(
            ai, "datetime", fixed_clock(month)
        ), patch.object(ai, "_trigger_background_season_resolution"):
            season = ai._get_season(country, lat=lat, lon=0.0)
        out.append({"country": country, "lat": lat, "month": month, "expected": season})
    return out


def main() -> None:
    fixture = {
        "about": (
            "Generated by scripts/gen_ai_summary_fixtures.py from the real api/py/_ai.py "
            "(endpoint run with the database, the clock and the model stubbed). The Rust "
            "AI Worker asserts the same outputs."
        ),
        "ttl": ttl_fixtures(),
        "summaryActivities": activity_fixtures(),
        "tags": tag_fixtures(),
        "season": season_fixtures(),
        "prompt": prompt_fixtures(),
    }
    OUT.write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(fixture['prompt'])} prompt cases")


if __name__ == "__main__":
    main()
