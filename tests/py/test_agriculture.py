"""Agriculture AI route tests (``POST /api/py/ai/agriculture``).

The deterministic analysis moved to the Rust Worker (``weather_core::agriculture``);
its answers are pinned to the old Python by ``tests/fixtures/agriculture-analysis.json``.
Here the Worker's JSON is the input: every fixture ``expected`` must still load
into the Pydantic models the AI route reads, and the route itself is tested
with that data.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from fastapi.testclient import TestClient

from py import _agriculture as agri

NOW = datetime(2026, 10, 11, 10, 30, tzinfo=timezone.utc)

FIXTURE = json.loads((Path(__file__).resolve().parents[1] / "fixtures" / "agriculture-analysis.json").read_text())


def _case(name: str) -> dict:
    return next(c for c in FIXTURE["cases"] if c["name"] == name)


@pytest.fixture
def client():
    from py.index import app

    return TestClient(app)


class TestWorkerContract:
    def test_every_pinned_worker_answer_loads_into_the_models(self):
        assert len(FIXTURE["cases"]) >= 8
        for case in FIXTURE["cases"]:
            data = agri.AgricultureResponse.model_validate(case["expected"])
            assert data.available == case["expected"]["available"]

    def test_fetch_asks_the_worker_and_parses(self):
        body = _case("harare_wet_season")["expected"]
        resp = MagicMock()
        resp.json.return_value = body
        resp.raise_for_status.return_value = None
        client = MagicMock()
        client.get.return_value = resp
        with patch.object(agri, "get_http_client", return_value=client):
            import asyncio

            data = asyncio.run(agri.fetch_agriculture(-17.83, 31.05, country="ZW", crops=["crop-farming"], location="harare"))
        assert data.available is True
        url = client.get.call_args[0][0]
        assert url.endswith("/v1/agriculture")
        assert client.get.call_args.kwargs["params"] == {
            "lat": "-17.83",
            "lon": "31.05",
            "location": "harare",
            "country": "ZW",
            "crops": "crop-farming",
        }

    def test_a_worker_failure_is_available_false_not_an_exception(self):
        client = MagicMock()
        client.get.side_effect = httpx.ConnectError("down")
        with patch.object(agri, "get_http_client", return_value=client):
            import asyncio

            data = asyncio.run(agri.fetch_agriculture(1.0, 2.0, country="", crops=[], location=""))
        assert data.available is False and data.reason == "provider_error"

    def test_worker_origin_defaults_and_accepts_only_https(self, monkeypatch):
        monkeypatch.delenv("NEXT_PUBLIC_WEATHER_API_URL", raising=False)
        assert agri._weather_api_base() == "https://weather-api.mukoko.com"
        monkeypatch.setenv("NEXT_PUBLIC_WEATHER_API_URL", "https://x.example.com/")
        assert agri._weather_api_base() == "https://x.example.com"
        monkeypatch.setenv("NEXT_PUBLIC_WEATHER_API_URL", "http://evil.example.com")
        assert agri._weather_api_base() == "https://weather-api.mukoko.com"

    def test_country_must_be_two_letters(self):
        assert agri._resolve_country("zw", "") == "ZW"
        assert agri._resolve_country("zimbabwe", "") == ""


# ---------------------------------------------------------------------------
# AI explanation
# ---------------------------------------------------------------------------


def _ok_data():
    return agri.AgricultureResponse.model_validate(_case("harare_wet_season")["expected"])


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
        ), patch.object(agri, "fetch_agriculture", new=AsyncMock(return_value=defaults.get("data", _ok_data()))), patch.object(
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
            agri, "fetch_agriculture", new=AsyncMock()
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
            agri, "fetch_agriculture", new=AsyncMock(return_value=_ok_data())
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
