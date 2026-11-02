"""Tests for the search and proximity helpers in api/py/_places_resolver.py."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from py._places_resolver import find_nearest_locations, search_locations_by_name


class TestSearchLocationsByName:
    """search_locations_by_name (py._places_resolver) — the regex search the
    Shamwari chat tool's search_locations uses."""

    def test_empty_query_returns_empty_without_querying_db(self):
        assert search_locations_by_name("") == []
        assert search_locations_by_name("   ") == []

    @patch("py._places_resolver.places_geo_collection")
    def test_scopes_to_consumer_facing_geo_types(self, mock_coll):
        mock_cursor = MagicMock()
        mock_cursor.sort.return_value.skip.return_value.limit.return_value.max_time_ms.return_value = []
        mock_coll.return_value.find.return_value = mock_cursor

        search_locations_by_name("harare")

        query_filter = mock_coll.return_value.find.call_args[0][0]
        assert query_filter["geoType"] == {"$in": ["city", "town", "village"]}
        assert {"name": {"$regex": "harare", "$options": "i"}} in query_filter["$or"]

    @patch("py._places_resolver.places_geo_collection")
    def test_tag_filter_is_optional(self, mock_coll):
        mock_cursor = MagicMock()
        mock_cursor.sort.return_value.skip.return_value.limit.return_value.max_time_ms.return_value = []
        mock_coll.return_value.find.return_value = mock_cursor

        search_locations_by_name("harare", tag="farming")

        query_filter = mock_coll.return_value.find.call_args[0][0]
        assert query_filter["sourceProvenance.mukokoTags"] == "farming"

    @patch("py._places_resolver.places_geo_collection")
    def test_db_error_returns_empty(self, mock_coll):
        mock_coll.return_value.find.side_effect = RuntimeError("boom")
        assert search_locations_by_name("harare") == []


class TestFindNearestLocations:
    """find_nearest_locations (py._places_resolver) — the canonical
    $nearSphere proximity query behind find_nearest_location."""

    @patch("py._places_resolver.places_geo_collection")
    def test_scopes_to_consumer_facing_geo_types_and_radius(self, mock_coll):
        mock_coll.return_value.find.return_value.limit.return_value = []
        find_nearest_locations(-17.83, 31.05, limit=5, max_km=100)

        query = mock_coll.return_value.find.call_args[0][0]
        assert query["geoType"] == {"$in": ["city", "town", "village"]}
        near = query["geo"]["$nearSphere"]
        assert near["$geometry"]["coordinates"] == [31.05, -17.83]
        assert near["$maxDistance"] == 100000
        mock_coll.return_value.find.return_value.limit.assert_called_once_with(5)

    @patch("py._places_resolver.places_geo_collection")
    def test_db_error_returns_empty_list(self, mock_coll):
        mock_coll.return_value.find.side_effect = RuntimeError("no index")
        assert find_nearest_locations(0, 0) == []

    @patch("py._places_resolver.find_nearest_locations")
    def test_singular_delegates_to_plural(self, mock_plural):
        from py._places_resolver import find_nearest_location as singular
        mock_plural.return_value = [{"slug": "harare"}]
        assert singular(-17.83, 31.05, max_km=150) == {"slug": "harare"}
        mock_plural.assert_called_once_with(-17.83, 31.05, limit=1, max_km=150)
