"""Tests for _chat.py — system prompt building, tool helpers, input validation."""

from __future__ import annotations

import json
from unittest.mock import patch, MagicMock

import pytest

from py._chat import (
    _build_chat_system_prompt,
    _execute_search_locations,
    _execute_list_by_tag,
    _execute_get_weather,
    _execute_get_activity_advice,
    _execute_tool,
    SLUG_RE,
    MAX_MESSAGE_LEN,
    MAX_HISTORY,
    MAX_ACTIVITIES,
    _FALLBACK_CHAT_PROMPT,
)
from py._db import get_known_tags


# ---------------------------------------------------------------------------
# System prompt builder
# ---------------------------------------------------------------------------


class TestBuildChatSystemPrompt:
    @patch("py._chat._get_chat_prompt_template", return_value=None)
    @patch("py._chat._get_activities_list")
    @patch("py._chat._get_location_context")
    def test_includes_location_names(self, mock_ctx, mock_act, _mock_tmpl):
        mock_ctx.return_value = (
            [{"name": "Harare", "slug": "harare", "province": "Harare"}],
            "95",
        )
        mock_act.return_value = []

        prompt = _build_chat_system_prompt([])
        assert "Harare (harare)" in prompt

    @patch("py._chat._get_chat_prompt_template", return_value=None)
    @patch("py._chat._get_activities_list")
    @patch("py._chat._get_location_context")
    def test_includes_location_count(self, mock_ctx, mock_act, _mock_tmpl):
        mock_ctx.return_value = ([], "142")
        mock_act.return_value = []

        prompt = _build_chat_system_prompt([])
        assert "142" in prompt

    @patch("py._chat._get_chat_prompt_template", return_value=None)
    @patch("py._chat._get_activities_list")
    @patch("py._chat._get_location_context")
    def test_includes_activity_list(self, mock_ctx, mock_act, _mock_tmpl):
        mock_ctx.return_value = ([], "10")
        mock_act.return_value = [{"id": "running", "label": "Running", "category": "sports"}]

        prompt = _build_chat_system_prompt([])
        assert "Running (running)" in prompt

    @patch("py._chat._get_chat_prompt_template", return_value=None)
    @patch("py._chat._get_activities_list")
    @patch("py._chat._get_location_context")
    def test_includes_user_activities_section(self, mock_ctx, mock_act, _mock_tmpl):
        mock_ctx.return_value = ([], "10")
        mock_act.return_value = []

        prompt = _build_chat_system_prompt(["running", "drone-flying"])
        assert "running" in prompt
        assert "drone-flying" in prompt
        assert "interests" in prompt.lower()

    @patch("py._chat._get_chat_prompt_template", return_value=None)
    @patch("py._chat._get_activities_list")
    @patch("py._chat._get_location_context")
    def test_no_user_activities_omits_section(self, mock_ctx, mock_act, _mock_tmpl):
        mock_ctx.return_value = ([], "10")
        mock_act.return_value = []

        prompt = _build_chat_system_prompt([])
        assert "interests" not in prompt.lower()

    @patch("py._chat._get_chat_prompt_template", return_value=None)
    @patch("py._chat._get_activities_list")
    @patch("py._chat._get_location_context")
    def test_uses_fallback_prompt_when_db_unavailable(self, mock_ctx, mock_act, _mock_tmpl):
        mock_ctx.return_value = ([], "many")
        mock_act.return_value = []

        prompt = _build_chat_system_prompt([])
        assert "Shamwari Weather" in prompt
        assert "LOCATION DISCOVERY" in prompt

    @patch("py._chat._get_activities_list")
    @patch("py._chat._get_location_context")
    def test_uses_db_template_when_available(self, mock_ctx, mock_act):
        mock_ctx.return_value = ([], "50")
        mock_act.return_value = []

        db_template = "Custom prompt. Locations: {locationList}. Count: {locationCount}."
        with patch(
            "py._chat._get_chat_prompt_template",
            return_value={"template": db_template},
        ):
            prompt = _build_chat_system_prompt([])
        assert prompt.startswith("Custom prompt.")
        assert "50" in prompt

    @patch("py._chat._get_chat_prompt_template", return_value=None)
    @patch("py._chat._get_activities_list")
    @patch("py._chat._get_location_context")
    def test_caps_location_sample_at_20(self, mock_ctx, mock_act, _mock_tmpl):
        """Only the first 20 locations appear in the sample."""
        locs = [{"name": f"Loc{i}", "slug": f"loc{i}", "province": "P"} for i in range(50)]
        mock_ctx.return_value = (locs, "50")
        mock_act.return_value = []

        prompt = _build_chat_system_prompt([])
        assert "Loc19 (loc19)" in prompt
        assert "Loc20 (loc20)" not in prompt


# ---------------------------------------------------------------------------
# Constants / regex
# ---------------------------------------------------------------------------


class TestConstants:
    def test_slug_regex_valid(self):
        assert SLUG_RE.match("harare")
        assert SLUG_RE.match("victoria-falls")
        assert SLUG_RE.match("a" * 80)

    def test_slug_regex_rejects_invalid(self):
        assert SLUG_RE.match("Harare") is None  # uppercase
        assert SLUG_RE.match("has space") is None
        assert SLUG_RE.match("a" * 81) is None  # too long
        assert SLUG_RE.match("") is None

    def test_known_tags_fallback(self):
        """get_known_tags returns a fallback set when DB is unavailable."""
        tags = get_known_tags()
        assert "farming" in tags
        assert "mining" in tags
        assert "invalid" not in tags


# ---------------------------------------------------------------------------
# Tool: list_locations_by_tag
# ---------------------------------------------------------------------------


class TestListByTag:
    @patch("py._chat.locations_collection")
    def test_rejects_unknown_tag(self, _mock_coll):
        result = _execute_list_by_tag("not-a-tag")
        assert "error" in result
        assert "Unknown tag" in result["error"]

    @patch("py._chat.locations_collection")
    def test_valid_tag_returns_results(self, mock_coll):
        mock_coll.return_value.find.return_value.sort.return_value.limit.return_value = [
            {"slug": "chinhoyi", "name": "Chinhoyi", "province": "Mashonaland West"}
        ]

        result = _execute_list_by_tag("farming")
        assert result["tag"] == "farming"
        assert len(result["locations"]) == 1
        assert result["locations"][0]["slug"] == "chinhoyi"


# ---------------------------------------------------------------------------
# Tool: search_locations
# ---------------------------------------------------------------------------


class TestSearchLocations:
    def test_empty_query_returns_empty(self):
        result = _execute_search_locations("")
        assert result["locations"] == []
        assert result["total"] == 0

    def test_whitespace_query_returns_empty(self):
        result = _execute_search_locations("   ")
        assert result["total"] == 0


# ---------------------------------------------------------------------------
# Tool: get_weather (slug validation)
# ---------------------------------------------------------------------------


class TestGetWeather:
    def test_invalid_slug_returns_error(self):
        result = _execute_get_weather("INVALID SLUG!", {})
        assert "error" in result
        assert "Invalid slug" in result["error"]

    def test_uses_request_cache(self):
        """Cached weather should be returned without hitting MongoDB."""
        cache = {"harare": {"location": "harare", "current": {"temperature": 25}}}
        result = _execute_get_weather("harare", cache)
        assert result["current"]["temperature"] == 25


# ---------------------------------------------------------------------------
# Tool dispatch
# ---------------------------------------------------------------------------


class TestExecuteTool:
    @patch("py._chat._execute_search_locations")
    def test_dispatches_search(self, mock_search):
        mock_search.return_value = {"locations": [], "total": 0}

        result = json.loads(_execute_tool("search_locations", {"query": "harare"}, {}, {}))
        assert result["total"] == 0
        mock_search.assert_called_once_with("harare")

    def test_unknown_tool_returns_error(self):
        result = json.loads(_execute_tool("nonexistent_tool", {}, {}, {}))
        assert "error" in result
        assert "Unknown tool" in result["error"]


# ---------------------------------------------------------------------------
# Tool: get_activity_advice
# ---------------------------------------------------------------------------


class TestGetActivityAdvice:
    def test_invalid_slug_returns_error(self):
        result = _execute_get_activity_advice("INVALID!", ["running"], {}, {})
        assert "error" in result

    def test_no_insights_returns_message(self):
        """When weather has no insights, returns a no-insights message."""
        cache = {"harare": {"location": "harare", "current": {"temperature": 25}}}
        result = _execute_get_activity_advice("harare", ["running"], cache, {})
        assert "message" in result or "error" in result

    @patch("py._chat.suitability_rules_collection")
    @patch("py._chat.activities_collection")
    def test_evaluates_suitability_with_insights(self, mock_act_coll, mock_rules_coll):
        """Activity advice should evaluate rules against weather insights."""
        mock_act_coll.return_value.find.return_value = [
            {"id": "running", "label": "Running", "category": "sports"}
        ]
        mock_rules_coll.return_value.find.return_value = [
            {
                "key": "category:sports",
                "conditions": [
                    {"field": "heatStressIndex", "operator": "gt", "value": 40,
                     "level": "poor", "label": "Dangerous heat", "detail": "Too hot"},
                ],
                "fallback": {"level": "good", "label": "Good conditions", "detail": ""},
            }
        ]
        cache = {
            "harare": {
                "location": "harare",
                "current": {"temperature": 25},
                "insights": {"heatStressIndex": 50, "windSpeed": 10},
            }
        }
        result = _execute_get_activity_advice("harare", ["running"], cache, {})
        assert "ratings" in result
        assert len(result["ratings"]) == 1
        assert result["ratings"][0]["level"] == "poor"
        assert result["ratings"][0]["label"] == "Dangerous heat"

    @patch("py._chat.suitability_rules_collection")
    @patch("py._chat.activities_collection")
    def test_fallback_when_no_conditions_match(self, mock_act_coll, mock_rules_coll):
        """Should return fallback rating when no conditions match."""
        mock_act_coll.return_value.find.return_value = [
            {"id": "running", "label": "Running", "category": "sports"}
        ]
        mock_rules_coll.return_value.find.return_value = [
            {
                "key": "category:sports",
                "conditions": [
                    {"field": "heatStressIndex", "operator": "gt", "value": 40,
                     "level": "poor", "label": "Dangerous", "detail": "Too hot"},
                ],
                "fallback": {"level": "good", "label": "Good conditions", "detail": "All clear"},
            }
        ]
        cache = {
            "harare": {
                "location": "harare",
                "current": {"temperature": 20},
                "insights": {"heatStressIndex": 20, "windSpeed": 5},
            }
        }
        result = _execute_get_activity_advice("harare", ["running"], cache, {})
        assert result["ratings"][0]["level"] == "good"
        assert result["ratings"][0]["label"] == "Good conditions"

    def test_unknown_activity_returns_error(self):
        """Activities not in DB should get an error entry."""
        cache = {
            "harare": {
                "location": "harare",
                "current": {"temperature": 25},
                "insights": {"heatStressIndex": 20},
            }
        }
        # Mock activities_collection to return nothing
        with patch("py._chat.activities_collection") as mock_act:
            mock_act.return_value.find.return_value = []
            result = _execute_get_activity_advice("harare", ["nonexistent"], cache, {})
        assert "ratings" in result
        assert result["ratings"][0]["error"] == "Unknown activity"


# ---------------------------------------------------------------------------
# Tool: list_locations_by_tag (cap test)
# ---------------------------------------------------------------------------


class TestListByTagCap:
    @patch("py._chat.locations_collection")
    def test_caps_results_at_20(self, mock_coll):
        """list_locations_by_tag should return at most 20 results."""
        locs = [{"slug": f"loc{i}", "name": f"Loc{i}", "province": "P"} for i in range(20)]
        mock_coll.return_value.find.return_value.sort.return_value.limit.return_value = locs

        result = _execute_list_by_tag("farming")
        assert result["total"] == 20
        assert result["note"] is not None
        assert "20" in result["note"]


# ---------------------------------------------------------------------------
# Location count exception path
# ---------------------------------------------------------------------------


class TestLocationCountFallback:
    @patch("py._chat._get_chat_prompt_template", return_value=None)
    @patch("py._chat._get_activities_list", return_value=[])
    @patch("py._chat.locations_collection")
    def test_estimated_document_count_exception_returns_many(self, mock_coll, _mock_act, _mock_tmpl):
        """If estimated_document_count() fails, location count should be 'many'."""
        # Reset cache to force re-fetch
        import py._chat as chat_mod
        chat_mod._location_context = None
        chat_mod._location_context_at = 0

        mock_coll.return_value.find.return_value.sort.return_value.limit.return_value = []
        mock_coll.return_value.estimated_document_count.side_effect = Exception("DB error")

        prompt = _build_chat_system_prompt([])
        assert "many" in prompt
