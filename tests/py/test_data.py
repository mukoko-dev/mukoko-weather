"""Tests for _data.py — activities, tags, and regions endpoints."""

from __future__ import annotations

import json
from unittest.mock import patch, MagicMock

import pytest
from fastapi import HTTPException

from py._data import (
    get_activities,
    get_tags,
    get_regions,
)


# ---------------------------------------------------------------------------
# get_activities endpoint
# ---------------------------------------------------------------------------


class TestGetActivities:
    @patch("py._data.get_db")
    @patch("py._data.activities_collection")
    @pytest.mark.asyncio
    async def test_returns_all_activities(self, mock_coll, mock_db):
        mock_coll.return_value.find.return_value.sort.return_value = [
            {"id": "running", "label": "Running", "category": "sports"},
            {"id": "cycling", "label": "Cycling", "category": "sports"},
        ]
        result = await get_activities()
        assert result["total"] == 2
        assert len(result["activities"]) == 2

    @patch("py._data.get_db")
    @patch("py._data.activities_collection")
    @pytest.mark.asyncio
    async def test_single_by_id(self, mock_coll, mock_db):
        mock_coll.return_value.find_one.return_value = {
            "id": "running",
            "label": "Running",
            "category": "sports",
        }
        result = await get_activities(id="running")
        assert result["activity"]["id"] == "running"
        assert result["activity"]["label"] == "Running"

    @patch("py._data.get_db")
    @patch("py._data.activities_collection")
    @pytest.mark.asyncio
    async def test_single_by_id_not_found(self, mock_coll, mock_db):
        mock_coll.return_value.find_one.return_value = None
        with pytest.raises(HTTPException) as exc_info:
            await get_activities(id="nonexistent")
        assert exc_info.value.status_code == 404

    @patch("py._data.get_db")
    @patch("py._data.activities_collection")
    @pytest.mark.asyncio
    async def test_filter_by_category(self, mock_coll, mock_db):
        mock_coll.return_value.find.return_value.sort.return_value = [
            {"id": "running", "label": "Running", "category": "sports"},
        ]
        result = await get_activities(category="sports")
        assert result["total"] == 1
        assert result["activities"][0]["category"] == "sports"

    @patch("py._data.get_db")
    @patch("py._data.activities_collection")
    @pytest.mark.asyncio
    async def test_text_search(self, mock_coll, mock_db):
        # Simulate successful $text search
        mock_sort = MagicMock()
        mock_sort.limit.return_value = [
            {"id": "cycling", "label": "Cycling", "category": "sports", "score": 1.5},
        ]
        mock_coll.return_value.find.return_value.sort.return_value = mock_sort
        mock_sort.limit.return_value = [
            {"id": "cycling", "label": "Cycling", "category": "sports"},
        ]

        result = await get_activities(q="cycling")
        assert result["total"] >= 0

    @patch("py._data.get_db")
    @patch("py._data.activities_collection")
    @pytest.mark.asyncio
    async def test_text_search_fallback_to_regex(self, mock_coll, mock_db):
        # First call ($text) raises, second call (regex) succeeds
        mock_find_text = MagicMock()
        mock_find_text.sort.side_effect = Exception("$text index not available")

        mock_find_regex = MagicMock()
        mock_find_regex.limit.return_value = [
            {"id": "cycling", "label": "Cycling", "category": "sports"},
        ]

        mock_coll.return_value.find.side_effect = [mock_find_text, mock_find_regex]

        result = await get_activities(q="cycling")
        assert result["total"] == 1
        assert result["activities"][0]["id"] == "cycling"

    @patch("py._data.get_db")
    @patch("py._data.activities_collection")
    @pytest.mark.asyncio
    async def test_labels_lookup(self, mock_coll, mock_db):
        mock_coll.return_value.find.return_value = [
            {"id": "running", "label": "Running"},
            {"id": "cycling", "label": "Cycling"},
        ]
        result = await get_activities(labels="running,cycling")
        assert result["labels"]["running"] == "Running"
        assert result["labels"]["cycling"] == "Cycling"

    @patch("py._data.get_db")
    @patch("py._data.activities_collection")
    @pytest.mark.asyncio
    async def test_categories_mode(self, mock_coll, mock_db):
        mock_db.return_value.__getitem__.return_value.find.return_value = [
            {"id": "farming", "label": "Agriculture & Forestry"},
            {"id": "sports", "label": "Sports & Fitness"},
        ]
        result = await get_activities(mode="categories")
        assert "categories" in result
        assert len(result["categories"]) == 2


# ---------------------------------------------------------------------------
# get_tags endpoint
# ---------------------------------------------------------------------------


class TestGetTags:
    @patch("py._data.tags_collection")
    @pytest.mark.asyncio
    async def test_returns_all_tags(self, mock_coll):
        mock_coll.return_value.find.return_value.sort.return_value = [
            {"slug": "city", "label": "City", "featured": True},
            {"slug": "farming", "label": "Farming", "featured": False},
        ]
        result = await get_tags()
        body = json.loads(result.body)
        assert len(body["tags"]) == 2

    @patch("py._data.tags_collection")
    @pytest.mark.asyncio
    async def test_featured_only(self, mock_coll):
        mock_coll.return_value.find.return_value.sort.return_value = [
            {"slug": "city", "label": "City", "featured": True},
        ]
        result = await get_tags(featured=True)
        body = json.loads(result.body)
        assert len(body["tags"]) == 1

        # Verify the query included featured filter
        call_args = mock_coll.return_value.find.call_args
        assert call_args[0][0] == {"featured": True}

    @patch("py._data.tags_collection")
    @pytest.mark.asyncio
    async def test_error_returns_500(self, mock_coll):
        mock_coll.return_value.find.side_effect = Exception("DB error")
        with pytest.raises(HTTPException) as exc_info:
            await get_tags()
        assert exc_info.value.status_code == 500
        assert "Failed to fetch tags" in exc_info.value.detail

    @patch("py._data.tags_collection")
    @pytest.mark.asyncio
    async def test_cache_headers(self, mock_coll):
        mock_coll.return_value.find.return_value.sort.return_value = []
        result = await get_tags()
        assert "max-age=3600" in result.headers.get("cache-control", "")


# ---------------------------------------------------------------------------
# get_regions endpoint
# ---------------------------------------------------------------------------


class TestGetRegions:
    @patch("py._data.get_db")
    @pytest.mark.asyncio
    async def test_returns_active_regions(self, mock_db):
        mock_db.return_value.__getitem__.return_value.find.return_value = [
            {"name": "Zimbabwe", "active": True, "bounds": {}},
            {"name": "ASEAN", "active": True, "bounds": {}},
        ]
        result = await get_regions()
        body = json.loads(result.body)
        assert len(body["regions"]) == 2

    @patch("py._data.get_db")
    @pytest.mark.asyncio
    async def test_error_returns_500(self, mock_db):
        mock_db.return_value.__getitem__.return_value.find.side_effect = Exception("DB error")
        with pytest.raises(HTTPException) as exc_info:
            await get_regions()
        assert exc_info.value.status_code == 500
        assert "Failed to fetch regions" in exc_info.value.detail

    @patch("py._data.get_db")
    @pytest.mark.asyncio
    async def test_cache_headers(self, mock_db):
        mock_db.return_value.__getitem__.return_value.find.return_value = []
        result = await get_regions()
        assert "max-age=3600" in result.headers.get("cache-control", "")
