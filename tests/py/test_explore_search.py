"""Tests for _explore_search.py — AI-powered location search, tool execution, fallback."""

from __future__ import annotations

import json
from unittest.mock import patch, MagicMock

import pytest
from fastapi import HTTPException

from py._explore_search import (
    SLUG_RE,
    _exec_search,
    _exec_weather,
    _exec_tool,
    _text_search_fallback,
    _build_search_system_prompt,
    _FALLBACK_SYSTEM_PROMPT,
    explore_search,
    ExploreSearchRequest,
)


# ---------------------------------------------------------------------------
# SLUG_RE validation
# ---------------------------------------------------------------------------


class TestSlugRegex:
    def test_valid_slugs(self):
        assert SLUG_RE.match("harare")
        assert SLUG_RE.match("victoria-falls")
        assert SLUG_RE.match("a" * 80)
        assert SLUG_RE.match("123")
        assert SLUG_RE.match("city-1")

    def test_invalid_slugs(self):
        assert SLUG_RE.match("Harare") is None  # uppercase
        assert SLUG_RE.match("has space") is None
        assert SLUG_RE.match("a" * 81) is None  # too long
        assert SLUG_RE.match("") is None
        assert SLUG_RE.match("hello_world") is None  # underscore


# ---------------------------------------------------------------------------
# _exec_search — search_locations tool
# ---------------------------------------------------------------------------


class TestExecSearch:
    @pytest.fixture(autouse=True)
    def _reset_context(self):
        """Reset the location context cache between tests."""
        import py._explore_search as mod
        mod._location_context = None
        mod._location_context_at = 0
        yield
        mod._location_context = None
        mod._location_context_at = 0

    @patch("py._explore_search._get_location_context")
    def test_filters_by_query(self, mock_ctx):
        mock_ctx.return_value = [
            {"slug": "harare", "name": "Harare", "province": "Harare", "tags": ["city"], "country": "ZW"},
            {"slug": "bulawayo", "name": "Bulawayo", "province": "Bulawayo", "tags": ["city"], "country": "ZW"},
        ]
        result = json.loads(_exec_search({"query": "harare"}))
        assert len(result) == 1
        assert result[0]["slug"] == "harare"

    @patch("py._explore_search._get_location_context")
    def test_filters_by_tag(self, mock_ctx):
        mock_ctx.return_value = [
            {"slug": "harare", "name": "Harare", "province": "Harare", "tags": ["city"], "country": "ZW"},
            {"slug": "chinhoyi", "name": "Chinhoyi", "province": "Mash West", "tags": ["farming"], "country": "ZW"},
        ]
        result = json.loads(_exec_search({"tag": "farming"}))
        assert len(result) == 1
        assert result[0]["slug"] == "chinhoyi"

    @patch("py._explore_search._get_location_context")
    def test_filters_by_query_or_tag(self, mock_ctx):
        mock_ctx.return_value = [
            {"slug": "harare", "name": "Harare", "province": "Harare", "tags": ["city"], "country": "ZW"},
            {"slug": "chinhoyi", "name": "Chinhoyi", "province": "Mash West", "tags": ["farming"], "country": "ZW"},
            {"slug": "mutare", "name": "Mutare", "province": "Manicaland", "tags": ["city", "farming"], "country": "ZW"},
        ]
        # Query "mutare" AND tag "farming" — should match mutare on either condition
        result = json.loads(_exec_search({"query": "mutare", "tag": "farming"}))
        slugs = [r["slug"] for r in result]
        assert "mutare" in slugs
        assert "chinhoyi" in slugs  # matches tag

    @patch("py._explore_search._get_location_context")
    def test_returns_all_when_no_filter(self, mock_ctx):
        mock_ctx.return_value = [
            {"slug": f"loc-{i}", "name": f"Loc {i}", "province": "P", "tags": [], "country": "ZW"}
            for i in range(5)
        ]
        result = json.loads(_exec_search({}))
        assert len(result) == 5

    @patch("py._explore_search._get_location_context")
    def test_caps_at_20(self, mock_ctx):
        mock_ctx.return_value = [
            {"slug": f"loc-{i}", "name": f"Loc {i}", "province": "P", "tags": [], "country": "ZW"}
            for i in range(30)
        ]
        result = json.loads(_exec_search({}))
        assert len(result) == 20


# ---------------------------------------------------------------------------
# _exec_weather — get_weather tool
# ---------------------------------------------------------------------------


class TestExecWeather:
    def test_invalid_slug_returns_error(self):
        result = json.loads(_exec_weather({"slug": "INVALID!"}))
        assert "error" in result
        assert "Invalid" in result["error"]

    @patch("py._explore_search.find_location", return_value={"slug": "harare", "name": "Harare", "lat": -17.83, "lon": 31.05})
    @patch("py._explore_search.weather_cache_collection")
    def test_cached_weather_returned(self, mock_coll, _fl):
        mock_coll.return_value.find_one.return_value = {
            "data": {
                "current": {
                    "temperature_2m": 25.0,
                    "relative_humidity_2m": 60,
                    "wind_speed_10m": 10,
                    "weather_code": 1,
                    "precipitation": 0,
                    "uv_index": 5,
                    "cloud_cover": 30,
                }
            },
            "provider": "tomorrow",
        }
        result = json.loads(_exec_weather({"slug": "harare"}))
        assert result["slug"] == "harare"
        assert result["temperature"] == 25.0
        assert result["humidity"] == 60
        assert result["provider"] == "tomorrow"
        # Read by the place's coordinate cell, never by slug (#252).
        assert mock_coll.return_value.find_one.call_args[0][0] == {
            "locationSlug": "cell:-17.85_31.05"
        }

    @patch("py._explore_search.find_location", return_value=None)
    @patch("py._explore_search.weather_cache_collection")
    def test_unresolvable_slug_never_reads_cache(self, mock_coll, _fl):
        result = json.loads(_exec_weather({"slug": "harare"}))
        assert "No weather data" in result["error"]
        mock_coll.return_value.find_one.assert_not_called()

    @patch("py._explore_search.find_location", return_value={"slug": "harare", "name": "Harare", "lat": -17.83, "lon": 31.05})
    @patch("py._explore_search.weather_cache_collection")
    def test_no_cache_returns_error(self, mock_coll, _fl):
        mock_coll.return_value.find_one.return_value = None
        result = json.loads(_exec_weather({"slug": "harare"}))
        assert "error" in result
        assert "No weather data" in result["error"]

    @patch("py._explore_search.find_location", return_value={"slug": "harare", "name": "Harare", "lat": -17.83, "lon": 31.05})
    @patch("py._explore_search.weather_cache_collection")
    def test_db_exception_returns_error(self, mock_coll, _fl):
        mock_coll.return_value.find_one.side_effect = Exception("DB down")
        result = json.loads(_exec_weather({"slug": "harare"}))
        assert "error" in result
        assert "unavailable" in result["error"]


# ---------------------------------------------------------------------------
# _exec_tool — tool dispatch
# ---------------------------------------------------------------------------


class TestExecTool:
    @patch("py._explore_search._exec_search")
    def test_routes_search_locations(self, mock_search):
        mock_search.return_value = '[]'
        result = _exec_tool("search_locations", {"query": "harare"})
        mock_search.assert_called_once_with({"query": "harare"})
        assert result == "[]"

    @patch("py._explore_search._exec_weather")
    def test_routes_get_weather(self, mock_weather):
        mock_weather.return_value = '{"slug": "harare"}'
        result = _exec_tool("get_weather", {"slug": "harare"})
        mock_weather.assert_called_once_with({"slug": "harare"})

    def test_unknown_tool_returns_error(self):
        result = json.loads(_exec_tool("nonexistent_tool", {}))
        assert "error" in result
        assert "Unknown tool" in result["error"]


# ---------------------------------------------------------------------------
# _text_search_fallback
# ---------------------------------------------------------------------------


class TestTextSearchFallback:
    @pytest.fixture(autouse=True)
    def _reset_context(self):
        import py._explore_search as mod
        mod._location_context = None
        mod._location_context_at = 0
        yield
        mod._location_context = None
        mod._location_context_at = 0

    @patch("py._explore_search.weather_cache_collection")
    @patch("py._explore_search._get_location_context")
    def test_matches_name(self, mock_ctx, mock_weather_coll):
        mock_ctx.return_value = [
            {"slug": "harare", "name": "Harare", "province": "Harare", "tags": ["city"], "country": "ZW"},
            {"slug": "bulawayo", "name": "Bulawayo", "province": "Bulawayo", "tags": ["city"], "country": "ZW"},
        ]
        mock_weather_coll.return_value.find_one.return_value = None

        result = _text_search_fallback("harare")
        assert len(result["locations"]) == 1
        assert result["locations"][0]["slug"] == "harare"
        assert "1" in result["summary"]

    @patch("py._explore_search.weather_cache_collection")
    @patch("py._explore_search._get_location_context")
    def test_matches_province(self, mock_ctx, mock_weather_coll):
        mock_ctx.return_value = [
            {"slug": "harare", "name": "Harare", "province": "Harare", "tags": ["city"], "country": "ZW"},
        ]
        mock_weather_coll.return_value.find_one.return_value = None

        result = _text_search_fallback("Harare")
        assert len(result["locations"]) >= 1

    @patch("py._explore_search.weather_cache_collection")
    @patch("py._explore_search._get_location_context")
    def test_matches_tags(self, mock_ctx, mock_weather_coll):
        mock_ctx.return_value = [
            {"slug": "chinhoyi", "name": "Chinhoyi", "province": "Mash West", "tags": ["farming"], "country": "ZW"},
        ]
        mock_weather_coll.return_value.find_one.return_value = None

        result = _text_search_fallback("farming")
        assert len(result["locations"]) == 1
        assert result["locations"][0]["slug"] == "chinhoyi"

    @patch("py._explore_search.weather_cache_collection")
    @patch("py._explore_search._get_location_context")
    def test_caps_at_10(self, mock_ctx, mock_weather_coll):
        mock_ctx.return_value = [
            {"slug": f"loc-{i}", "name": f"Loc {i}", "province": "test", "tags": ["city"], "country": "ZW"}
            for i in range(20)
        ]
        mock_weather_coll.return_value.find_one.return_value = None

        result = _text_search_fallback("loc")
        assert len(result["locations"]) == 10

    @patch("py._explore_search.weather_cache_collection")
    @patch("py._explore_search._get_location_context")
    def test_includes_weather_if_cached(self, mock_ctx, mock_weather_coll):
        mock_ctx.return_value = [
            {"slug": "harare", "name": "Harare", "province": "Harare", "tags": ["city"], "country": "ZW",
             "lat": -17.83, "lon": 31.05},
        ]
        mock_weather_coll.return_value.find_one.return_value = {
            "data": {"current": {"temperature_2m": 28, "weather_code": 0}}
        }

        result = _text_search_fallback("harare")
        loc = result["locations"][0]
        assert loc.get("temperature") == 28
        assert loc.get("weatherCode") == 0
        assert mock_weather_coll.return_value.find_one.call_args[0][0] == {
            "locationSlug": "cell:-17.85_31.05"
        }

    @patch("py._explore_search._get_location_context")
    def test_no_match_returns_helpful_message(self, mock_ctx):
        mock_ctx.return_value = [
            {"slug": "harare", "name": "Harare", "province": "Harare", "tags": ["city"], "country": "ZW"},
        ]

        result = _text_search_fallback("nonexistent")
        assert len(result["locations"]) == 0
        assert "No locations found" in result["summary"]


# ---------------------------------------------------------------------------
# _build_search_system_prompt
# ---------------------------------------------------------------------------


class TestBuildSearchSystemPrompt:
    @patch("py._explore_search.get_ai_prompt")
    def test_uses_db_template(self, mock_prompt):
        mock_prompt.return_value = {"template": "Custom search for: {query}"}
        result = _build_search_system_prompt("farming areas")
        assert "Custom search for: farming areas" in result

    @patch("py._explore_search.get_ai_prompt")
    def test_falls_back_to_hardcoded(self, mock_prompt):
        mock_prompt.return_value = None
        result = _build_search_system_prompt("farming areas")
        assert "Shamwari Weather" in result
        assert "farming areas" in result

    @patch("py._explore_search.get_ai_prompt")
    def test_replaces_query_placeholder(self, mock_prompt):
        mock_prompt.return_value = None
        result = _build_search_system_prompt("test query")
        assert "test query" in result

    @patch("py._explore_search.get_ai_prompt")
    def test_truncates_long_query_in_prompt(self, mock_prompt):
        mock_prompt.return_value = {"template": "Q: {query}"}
        long_query = "x" * 500
        result = _build_search_system_prompt(long_query)
        # Template replaces with query[:200]
        assert "x" * 200 in result
        assert "x" * 201 not in result


# ---------------------------------------------------------------------------
# explore_search endpoint
# ---------------------------------------------------------------------------


class TestExploreSearchEndpoint:
    @pytest.fixture(autouse=True)
    def _reset_caches(self):
        import py._explore_search as mod
        mod._location_context = None
        mod._location_context_at = 0
        import py._ai_prompts as prompts_mod
        prompts_mod._prompt_doc_cache = {}
        prompts_mod._prompt_doc_cache_at = 0
        yield
        mod._location_context = None
        mod._location_context_at = 0

    @pytest.mark.asyncio
    async def test_empty_query_raises_400(self):
        body = ExploreSearchRequest(query="  ")
        mock_request = MagicMock()
        with pytest.raises(HTTPException) as exc_info:
            await explore_search(body, mock_request)
        assert exc_info.value.status_code == 400

    @patch("py._db.check_rate_limit")
    @patch("py._db.get_client_ip")
    @pytest.mark.asyncio
    async def test_rate_limiting_returns_429(self, mock_ip, mock_rate):
        mock_ip.return_value = "1.2.3.4"
        mock_rate.return_value = {"allowed": False, "remaining": 0}

        body = ExploreSearchRequest(query="farming")
        mock_request = MagicMock()
        with pytest.raises(HTTPException) as exc_info:
            await explore_search(body, mock_request)
        assert exc_info.value.status_code == 429

    @patch("py._explore_search._text_search_fallback")
    @patch("py._ai_gateway.ai_breaker")
    @patch("py._db.check_rate_limit")
    @patch("py._db.get_client_ip")
    @pytest.mark.asyncio
    async def test_circuit_breaker_falls_back_to_text_search(
        self, mock_ip, mock_rate, mock_breaker, mock_fallback
    ):
        mock_ip.return_value = "1.2.3.4"
        mock_rate.return_value = {"allowed": True, "remaining": 10}
        mock_breaker.is_allowed = False  # Circuit is open
        mock_fallback.return_value = {"locations": [], "summary": "fallback"}

        body = ExploreSearchRequest(query="farming")
        mock_request = MagicMock()
        result = await explore_search(body, mock_request)
        assert result["summary"] == "fallback"
        mock_fallback.assert_called_once_with("farming")

    @patch("py._db.get_client_ip")
    @pytest.mark.asyncio
    async def test_no_ip_raises_400(self, mock_ip):
        mock_ip.return_value = None

        body = ExploreSearchRequest(query="farming")
        mock_request = MagicMock()
        with pytest.raises(HTTPException) as exc_info:
            await explore_search(body, mock_request)
        assert exc_info.value.status_code == 400


# ---------------------------------------------------------------------------
# OpenAI-style tool-use loop through the AI gateway helper
# ---------------------------------------------------------------------------


class TestExploreSearchToolLoop:
    @pytest.fixture(autouse=True)
    def _reset_caches(self):
        import py._explore_search as mod
        mod._location_context = []
        mod._location_context_at = 0
        yield
        mod._location_context = None
        mod._location_context_at = 0

    def test_tools_in_openai_function_format(self):
        from py._explore_search import TOOLS
        assert {t["function"]["name"] for t in TOOLS} == {"search_locations", "get_weather"}
        assert all(t["type"] == "function" for t in TOOLS)

    @patch("py._explore_search.get_ai_prompt", return_value=None)
    @patch("py._explore_search._get_location_context", return_value=[])
    @patch("py._db.check_rate_limit", return_value={"allowed": True, "remaining": 10})
    @patch("py._db.get_client_ip", return_value="1.2.3.4")
    @pytest.mark.asyncio
    async def test_tool_call_then_summary(self, _ip, _rate, _ctx, _prompt):
        from py._ai_gateway import AIResponse, ToolCall

        first = AIResponse(
            text="",
            tool_calls=[ToolCall(id="c1", name="search_locations", arguments={"tag": "farming"})],
            message={"role": "assistant", "content": None, "tool_calls": [{"id": "c1"}]},
        )
        final = AIResponse(text="Two farming towns match.")
        seen = []

        def fake_call_ai(**kwargs):
            seen.append([dict(m) for m in kwargs["messages"]])
            return (first, None) if len(seen) == 1 else (final, None)

        tool_out = json.dumps([{"slug": "marondera", "name": "Marondera"}])
        with patch("py._explore_search.call_ai", side_effect=fake_call_ai), \
             patch("py._explore_search._exec_tool", return_value=tool_out) as tool:
            result = await explore_search(ExploreSearchRequest(query="farming areas"), MagicMock())

        tool.assert_called_once_with("search_locations", {"tag": "farming"})
        assert seen[1][-1] == {"role": "tool", "tool_call_id": "c1", "content": tool_out}
        assert seen[1][-2]["role"] == "assistant"
        assert result["summary"] == "Two farming towns match."
        assert [l["slug"] for l in result["locations"]] == ["marondera"]
