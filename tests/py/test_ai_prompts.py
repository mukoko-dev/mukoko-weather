"""Tests for _ai_prompts.py — AI prompt library and suggested rules endpoints."""

from __future__ import annotations

import json
import time
from unittest.mock import patch

import pytest

from py._ai_prompts import (
    get_prompts,
    get_suggested_rules,
    CACHE_TTL,
)


# ---------------------------------------------------------------------------
# get_prompts endpoint
# ---------------------------------------------------------------------------


class TestGetPrompts:
    @pytest.fixture(autouse=True)
    def _reset_cache(self):
        """Reset the module-level cache between tests."""
        import py._ai_prompts as mod
        mod._prompts_cache = None
        mod._prompts_cache_at = 0
        yield
        mod._prompts_cache = None
        mod._prompts_cache_at = 0

    @patch("py._ai_prompts.ai_prompts_collection")
    @pytest.mark.asyncio
    async def test_returns_single_prompt_by_key(self, mock_coll):
        mock_coll.return_value.find_one.return_value = {
            "promptKey": "system:weather_summary",
            "template": "You are Shamwari Weather...",
            "model": "claude-haiku-4-5-20251001",
            "maxTokens": 800,
            "active": True,
        }
        result = await get_prompts(key="system:weather_summary")
        body = json.loads(result.body)
        assert body["prompt"]["promptKey"] == "system:weather_summary"
        assert body["prompt"]["template"] == "You are Shamwari Weather..."

    @patch("py._ai_prompts.ai_prompts_collection")
    @pytest.mark.asyncio
    async def test_single_prompt_not_found(self, mock_coll):
        mock_coll.return_value.find_one.return_value = None
        result = await get_prompts(key="system:nonexistent")
        body = json.loads(result.body)
        assert body["prompt"] is None

    @patch("py._ai_prompts.ai_prompts_collection")
    @pytest.mark.asyncio
    async def test_single_prompt_cache_header(self, mock_coll):
        mock_coll.return_value.find_one.return_value = {
            "promptKey": "system:test",
            "template": "test",
        }
        result = await get_prompts(key="system:test")
        assert "max-age=300" in result.headers.get("cache-control", "")

    @patch("py._ai_prompts.ai_prompts_collection")
    @pytest.mark.asyncio
    async def test_not_found_prompt_cache_header(self, mock_coll):
        mock_coll.return_value.find_one.return_value = None
        result = await get_prompts(key="system:missing")
        assert "max-age=60" in result.headers.get("cache-control", "")

    @patch("py._ai_prompts.ai_prompts_collection")
    @pytest.mark.asyncio
    async def test_returns_all_active_prompts(self, mock_coll):
        mock_coll.return_value.find.return_value.sort.return_value = [
            {"promptKey": "system:summary", "template": "t1", "active": True},
            {"promptKey": "system:chat", "template": "t2", "active": True},
        ]
        result = await get_prompts(key=None)
        body = json.loads(result.body)
        assert len(body["prompts"]) == 2

    @patch("py._ai_prompts.ai_prompts_collection")
    @pytest.mark.asyncio
    async def test_all_prompts_cache_header(self, mock_coll):
        mock_coll.return_value.find.return_value.sort.return_value = []
        result = await get_prompts(key=None)
        assert "max-age=300" in result.headers.get("cache-control", "")

    @patch("py._ai_prompts.ai_prompts_collection")
    @pytest.mark.asyncio
    async def test_cached_response(self, mock_coll):
        """Second call within TTL should return cached data without hitting DB."""
        import py._ai_prompts as mod

        # Pre-populate cache
        mod._prompts_cache = [{"promptKey": "cached", "template": "cached_template"}]
        mod._prompts_cache_at = time.time()

        result = await get_prompts(key=None)
        body = json.loads(result.body)
        assert len(body["prompts"]) == 1
        assert body["prompts"][0]["promptKey"] == "cached"
        # DB should not be called
        mock_coll.return_value.find.assert_not_called()

    @patch("py._ai_prompts.ai_prompts_collection")
    @pytest.mark.asyncio
    async def test_db_error_returns_empty(self, mock_coll):
        mock_coll.return_value.find.side_effect = Exception("DB down")
        result = await get_prompts(key=None)
        body = json.loads(result.body)
        assert body["prompts"] == []
        assert "error" in body

    @patch("py._ai_prompts.ai_prompts_collection")
    @pytest.mark.asyncio
    async def test_db_error_returns_cached_if_available(self, mock_coll):
        """On DB error, should return previously cached prompts."""
        import py._ai_prompts as mod

        # Expired cache
        mod._prompts_cache = [{"promptKey": "old", "template": "old_template"}]
        mod._prompts_cache_at = time.time() - CACHE_TTL - 10

        mock_coll.return_value.find.return_value.sort.side_effect = Exception("DB down")
        result = await get_prompts(key=None)
        body = json.loads(result.body)
        assert len(body["prompts"]) == 1
        assert body["prompts"][0]["promptKey"] == "old"


# ---------------------------------------------------------------------------
# get_suggested_rules endpoint
# ---------------------------------------------------------------------------


class TestGetSuggestedRules:
    @pytest.fixture(autouse=True)
    def _reset_cache(self):
        import py._ai_prompts as mod
        mod._suggested_cache = None
        mod._suggested_cache_at = 0
        yield
        mod._suggested_cache = None
        mod._suggested_cache_at = 0

    @patch("py._ai_prompts.ai_suggested_rules_collection")
    @pytest.mark.asyncio
    async def test_returns_active_rules_sorted(self, mock_coll):
        mock_coll.return_value.find.return_value.sort.return_value = [
            {"ruleKey": "rule1", "condition": {}, "prompt": "p1", "order": 1, "active": True},
            {"ruleKey": "rule2", "condition": {}, "prompt": "p2", "order": 2, "active": True},
        ]
        result = await get_suggested_rules()
        body = json.loads(result.body)
        assert len(body["rules"]) == 2
        assert body["rules"][0]["ruleKey"] == "rule1"

    @patch("py._ai_prompts.ai_suggested_rules_collection")
    @pytest.mark.asyncio
    async def test_cache_header(self, mock_coll):
        mock_coll.return_value.find.return_value.sort.return_value = []
        result = await get_suggested_rules()
        assert "max-age=300" in result.headers.get("cache-control", "")

    @patch("py._ai_prompts.ai_suggested_rules_collection")
    @pytest.mark.asyncio
    async def test_cached_response(self, mock_coll):
        import py._ai_prompts as mod
        mod._suggested_cache = [{"ruleKey": "cached_rule", "prompt": "p"}]
        mod._suggested_cache_at = time.time()

        result = await get_suggested_rules()
        body = json.loads(result.body)
        assert len(body["rules"]) == 1
        assert body["rules"][0]["ruleKey"] == "cached_rule"
        mock_coll.return_value.find.assert_not_called()

    @patch("py._ai_prompts.ai_suggested_rules_collection")
    @pytest.mark.asyncio
    async def test_db_error_returns_empty(self, mock_coll):
        mock_coll.return_value.find.side_effect = Exception("DB down")
        result = await get_suggested_rules()
        body = json.loads(result.body)
        assert body["rules"] == []
        assert "error" in body

    @patch("py._ai_prompts.ai_suggested_rules_collection")
    @pytest.mark.asyncio
    async def test_db_error_returns_cached_if_available(self, mock_coll):
        import py._ai_prompts as mod
        mod._suggested_cache = [{"ruleKey": "stale", "prompt": "p"}]
        mod._suggested_cache_at = time.time() - CACHE_TTL - 10

        mock_coll.return_value.find.return_value.sort.side_effect = Exception("DB down")
        result = await get_suggested_rules()
        body = json.loads(result.body)
        assert len(body["rules"]) == 1
        assert body["rules"][0]["ruleKey"] == "stale"
