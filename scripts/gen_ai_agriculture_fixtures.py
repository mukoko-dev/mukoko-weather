#!/usr/bin/env python3
"""Generate tests/fixtures/ai-agriculture.json from the REAL Python `api/py/_agriculture.py`.

The AI Worker (workers/ai, workers/crates/weather-core: ai/agriculture.rs)
must turn the Worker's deterministic farm data into the model's request, and
into the fallback text, exactly as `_agriculture.py` did. This script runs the
real `data_brief`, `fallback_text`, `farming_activities` and the endpoint
`agriculture_ai` (with the database, the Worker fetch and the model stubbed)
over the pinned farm-data answers in tests/fixtures/agriculture-analysis.json,
and writes `{input, expected}` pairs; the Rust tests assert the same outputs.
Nothing in the fixture is computed by hand.

What is stubbed, and from what: the activity labels, categories and guidance
(`get_activities_brief`) come from the compiled-in files the Worker uses
(`workers/crates/weather-core/data/reference/activities.json` and
`activity-guidance.json`); the system prompts (`get_ai_prompt`) are the seed
documents in `ai-prompts.json`. The model is a stub that records the request.

PROVENANCE ONLY: the code this script drives was deleted from
`api/py/_agriculture.py` in the PR that ported the agriculture AI route to the
AI Worker, so it runs only on the commit before that PR. The fixture is
committed and is what the Rust tests assert. To regenerate it (it should never
be needed), check out that commit, run the script from the repository root,
then format the output as CI does:

    python3 -I scripts/gen_ai_agriculture_fixtures.py
    npx prettier@3.9.4 --write tests/fixtures/ai-agriculture.json
"""

from __future__ import annotations

import asyncio
import json
import sys
import types
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))
for _k in [k for k in sys.modules if k == "py" or k.startswith("py.")]:
    del sys.modules[_k]

# The Python tests mock pymongo (tests/py/conftest.py); do the same.
_pm = types.ModuleType("pymongo")
_pm.MongoClient = MagicMock
_pm.UpdateOne = MagicMock
_pdb = types.ModuleType("pymongo.database")
_pdb.Database = MagicMock
_perr = types.ModuleType("pymongo.errors")
_perr.DuplicateKeyError = type("DuplicateKeyError", (Exception,), {})
_perr.ConnectionFailure = type("ConnectionFailure", (Exception,), {})
sys.modules.update({"pymongo": _pm, "pymongo.database": _pdb, "pymongo.errors": _perr})

from py import _agriculture as agri  # noqa: E402
from py._ai_gateway import AIResponse  # noqa: E402

REF = ROOT / "workers" / "crates" / "weather-core" / "data" / "reference"
OUT = ROOT / "tests" / "fixtures" / "ai-agriculture.json"

ACTIVITIES = json.loads((REF / "activities.json").read_text())
GUIDANCE = json.loads((REF / "activity-guidance.json").read_text())
PROMPTS = {p["promptKey"]: p for p in json.loads((REF / "ai-prompts.json").read_text())}
ANALYSES = {c["name"]: c["expected"] for c in json.loads((ROOT / "tests" / "fixtures" / "agriculture-analysis.json").read_text())["cases"]}

BRIEFS = [
    {"id": a["id"], "label": a["label"], "category": a["category"], "aiInstructions": GUIDANCE[a["id"]]}
    for a in ACTIVITIES
]
KNOWN_IDS = {a["id"] for a in ACTIVITIES}

HARARE = {"slug": "harare", "name": "Harare", "country": "ZW", "elevation": 1490, "lat": -17.83, "lon": 31.05}
NAIROBI = {"slug": "nairobi-ke", "name": "Nairobi", "country": "KE", "elevation": 1795, "lat": -1.29, "lon": 36.82}
KARIBA = {"slug": "kariba", "name": "Kariba", "country": "ZW", "elevation": 519, "lat": -16.52, "lon": 28.8}
SPOT = {"slug": "", "name": "West Paddock", "country": "", "elevation": 612.5, "lat": -20.1, "lon": 28.6}

# (id, analysis, location, activities, mode)
CASES = [
    ("harare-snapshot-no-crops", "harare_wet_season", HARARE, [], "snapshot"),
    ("harare-briefing-crops", "harare_wet_season", HARARE, ["tobacco-farming", "crop-farming", "football", "irrigation"], "briefing"),
    ("frost-briefing", "highveld_frost_july", HARARE, ["livestock"], "briefing"),
    ("kariba-heat-snapshot", "kariba_heat_wave", KARIBA, ["cotton-farming"], "snapshot"),
    ("nairobi-wind-briefing", "windy_dry_nairobi", NAIROBI, ["horticulture", "gardening"], "briefing"),
    ("washout-snapshot", "heavy_rain_washout", HARARE, ["harvest", "planting"], "snapshot"),
    ("north-no-soil-briefing", "north_summer_no_soil_t", NAIROBI, ["crop-farming"], "briefing"),
    ("cold-planting-snapshot", "cold_planting_soil", HARARE, ["planting"], "snapshot"),
    ("spot-snapshot", "harare_wet_season", SPOT, ["crop-farming"], "snapshot"),
    ("empty-data-snapshot", "empty", HARARE, ["crop-farming"], "snapshot"),
]

FARMING_INPUTS = [
    [],
    ["crop-farming"],
    ["football", "crop-farming", "nope", "tobacco-farming", "crop-farming"],
    ["livestock", "cotton-farming", "horticulture", "gardening", "irrigation", "harvest", "planting"],
    ["driving", "mining"],
]


def prompt_doc(key: str):
    p = PROMPTS.get(key)
    return {"template": p["template"], "maxTokens": p.get("maxTokens")} if p else None


def run_endpoint(case_id: str, analysis: str, location: dict, activities: list, mode: str):
    """Run the real endpoint; return what it asked the model, what it cached and answered."""
    asked: dict = {}
    cached: dict = {}
    data = agri.AgricultureResponse.model_validate(ANALYSES[analysis])

    def fake_call_ai(**kwargs):
        asked.update(kwargs)
        return AIResponse(text="Model text."), None

    def fake_set_cached(key, text, source):
        cached.update(key=key, text=text, source=source)

    body = agri.AgriAIRequest(location=location, activities=activities, mode=mode)
    with patch.object(agri, "require_internal_caller"), patch.object(agri, "enforce_rate_limit"), patch.object(
        agri, "_get_cached_ai", return_value=None
    ), patch.object(agri, "_set_cached_ai", side_effect=fake_set_cached), patch.object(
        agri, "fetch_agriculture", new=AsyncMock(return_value=data)
    ), patch.object(agri, "get_activities_brief", return_value=BRIEFS), patch.object(
        agri, "filter_known_activities", side_effect=lambda ids: [a for a in ids if a in KNOWN_IDS]
    ), patch("py._ai_prompts.get_ai_prompt", side_effect=prompt_doc), patch("py._ai_gateway.call_ai", side_effect=fake_call_ai):
        result = asyncio.run(agri.agriculture_ai(body, request=MagicMock()))
    return data, asked, cached, result


def main() -> None:
    cases = []
    for case_id, analysis, location, activities, mode in CASES:
        data, asked, cached, result = run_endpoint(case_id, analysis, location, activities, mode)
        if data.available:
            assert asked["messages"][0]["role"] == "user", asked
            expected = {
                "system": asked["system"],
                "user": asked["messages"][0]["content"],
                "maxTokens": asked["max_tokens"],
                "source": result.source,
                "text": result.text,
            }
        else:
            # No data: the endpoint never reaches the model and caches the fallback.
            assert not asked and cached["source"] == "fallback", (asked, cached)
            expected = {"system": None, "user": None, "maxTokens": None, "source": result.source, "text": result.text}
        cases.append(
            {
                "id": case_id,
                "input": {"analysis": analysis, "location": location, "activities": activities, "mode": mode},
                "expected": expected,
            }
        )

    fixture = {
        "about": (
            "Generated by scripts/gen_ai_agriculture_fixtures.py from the real api/py/_agriculture.py. "
            "`analysis` names a pinned farm-data answer in tests/fixtures/agriculture-analysis.json (case `name`, its `expected`). "
            "The Rust AI Worker asserts the same outputs."
        ),
        "farmingActivities": [
            {
                "input": ids,
                "expected": _farming(ids),
            }
            for ids in FARMING_INPUTS
        ],
        "brief": [
            {"analysis": name, "expected": agri.data_brief(agri.AgricultureResponse.model_validate(a))}
            for name, a in ANALYSES.items()
        ],
        "fallback": [
            {"analysis": name, "mode": mode, "expected": agri.fallback_text(agri.AgricultureResponse.model_validate(a), mode)}
            for name, a in ANALYSES.items()
            for mode in ("snapshot", "briefing")
        ],
        "prompt": cases,
    }
    OUT.write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(cases)} prompt cases")


def _farming(ids: list) -> list:
    with patch.object(agri, "get_activities_brief", return_value=BRIEFS), patch.object(
        agri, "filter_known_activities", side_effect=lambda x: [a for a in x if a in KNOWN_IDS]
    ):
        return agri.farming_activities(ids)


if __name__ == "__main__":
    main()
