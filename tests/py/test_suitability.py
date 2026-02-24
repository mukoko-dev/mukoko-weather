"""Tests for _suitability.py — suitability rules endpoint, KEY_RE validation."""

from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi import HTTPException

from py._suitability import (
    KEY_RE,
    get_suitability,
)


# ---------------------------------------------------------------------------
# KEY_RE validation
# ---------------------------------------------------------------------------


class TestKeyRegex:
    def test_valid_activity_keys(self):
        assert KEY_RE.match("activity:running")
        assert KEY_RE.match("activity:drone-flying")
        assert KEY_RE.match("activity:123")

    def test_valid_category_keys(self):
        assert KEY_RE.match("category:farming")
        assert KEY_RE.match("category:sports")
        assert KEY_RE.match("category:casual")

    def test_rejects_invalid_prefix(self):
        assert KEY_RE.match("rule:running") is None
        assert KEY_RE.match("unknown:farming") is None

    def test_rejects_missing_prefix(self):
        assert KEY_RE.match("running") is None
        assert KEY_RE.match("farming") is None

    def test_rejects_uppercase(self):
        assert KEY_RE.match("activity:Running") is None
        assert KEY_RE.match("Activity:running") is None

    def test_rejects_spaces(self):
        assert KEY_RE.match("activity:has space") is None

    def test_rejects_empty_value(self):
        assert KEY_RE.match("activity:") is None
        assert KEY_RE.match("category:") is None


# ---------------------------------------------------------------------------
# get_suitability endpoint
# ---------------------------------------------------------------------------


class TestGetSuitability:
    @patch("py._suitability.suitability_rules_collection")
    @pytest.mark.asyncio
    async def test_returns_all_rules(self, mock_coll):
        mock_coll.return_value.find.return_value = [
            {"key": "category:farming", "conditions": [], "fallback": {}},
            {"key": "category:sports", "conditions": [], "fallback": {}},
        ]
        result = await get_suitability(key=None)
        # JSONResponse — check the body
        assert result.status_code == 200
        import json
        body = json.loads(result.body)
        assert len(body["rules"]) == 2

    @patch("py._suitability.suitability_rules_collection")
    @pytest.mark.asyncio
    async def test_returns_single_rule_by_key(self, mock_coll):
        mock_coll.return_value.find_one.return_value = {
            "key": "activity:drone-flying",
            "conditions": [{"field": "windSpeed", "operator": "gt", "value": 30}],
            "fallback": {"level": "good", "label": "Good", "detail": "OK"},
        }
        result = await get_suitability(key="activity:drone-flying")
        import json
        body = json.loads(result.body)
        assert body["rule"]["key"] == "activity:drone-flying"

    @pytest.mark.asyncio
    async def test_invalid_key_format_raises_400(self):
        with pytest.raises(HTTPException) as exc_info:
            await get_suitability(key="invalid-format")
        assert exc_info.value.status_code == 400
        assert "Invalid key format" in exc_info.value.detail

    @patch("py._suitability.suitability_rules_collection")
    @pytest.mark.asyncio
    async def test_rule_not_found_raises_404(self, mock_coll):
        mock_coll.return_value.find_one.return_value = None
        with pytest.raises(HTTPException) as exc_info:
            await get_suitability(key="activity:nonexistent")
        assert exc_info.value.status_code == 404

    @patch("py._suitability.suitability_rules_collection")
    @pytest.mark.asyncio
    async def test_db_error_returns_empty_array(self, mock_coll):
        mock_coll.return_value.find.side_effect = Exception("DB down")
        result = await get_suitability(key=None)
        import json
        body = json.loads(result.body)
        assert body["rules"] == []

    @patch("py._suitability.suitability_rules_collection")
    @pytest.mark.asyncio
    async def test_cache_headers_set(self, mock_coll):
        mock_coll.return_value.find.return_value = []
        result = await get_suitability(key=None)
        assert "s-maxage=300" in result.headers.get("cache-control", "")

    @patch("py._suitability.suitability_rules_collection")
    @pytest.mark.asyncio
    async def test_single_rule_cache_headers(self, mock_coll):
        mock_coll.return_value.find_one.return_value = {
            "key": "category:farming",
            "conditions": [],
        }
        result = await get_suitability(key="category:farming")
        assert "s-maxage=300" in result.headers.get("cache-control", "")
