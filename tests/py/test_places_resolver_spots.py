"""Spot slugs resolve on the backend without a placesGeo record (global scope).

A place found by search anywhere on Earth gets a ``{name}--{geohash}`` slug.
The page renders it from the slug alone; these tests pin that history,
reports and chat (all of which go through ``find_location``) can too.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from py._geohash import build_smart_slug
from py._places_resolver import find_location


def _empty_collection() -> MagicMock:
    coll = MagicMock()
    coll.find_one.return_value = None
    coll.find.return_value.limit.return_value = []
    return coll


class TestFindLocationSpots:
    @patch("py._places_resolver.places_geo_collection")
    def test_unstamped_spot_resolves_from_its_coordinate(self, mock_coll):
        mock_coll.return_value = _empty_collection()
        slug = build_smart_slug("London", 51.5074, -0.1278)
        loc = find_location(slug)
        assert loc is not None
        assert loc["slug"] == slug
        assert loc["name"] == "London"
        assert abs(loc["lat"] - 51.5074) < 0.002
        assert abs(loc["lon"] + 0.1278) < 0.002
        # No country is guessed from a coordinate.
        assert "country" not in loc

    @patch("py._places_resolver.places_geo_collection")
    def test_open_ocean_spot_resolves(self, mock_coll):
        mock_coll.return_value = _empty_collection()
        loc = find_location(build_smart_slug("Pacific", -30.0, -140.0))
        assert loc is not None
        assert loc["lat"] < -29 and loc["lon"] < -139

    @patch("py._places_resolver.places_geo_collection")
    def test_stamped_record_still_wins(self, mock_coll):
        slug = build_smart_slug("Tokyo", 35.6762, 139.6503)
        coll = _empty_collection()
        coll.find_one.return_value = {
            "_id": "uuid-tokyo",
            "name": "Tokyo",
            "slug": "tokyo-abc123",
            "geoType": "city",
            "isoCode": "JP",
            "geo": {"type": "Point", "coordinates": [139.6503, 35.6762]},
            "sourceProvenance": {"mukokoSlug": slug, "mukokoProvince": "Tokyo"},
        }
        mock_coll.return_value = coll
        loc = find_location(slug)
        assert loc["country"] == "JP"
        assert loc["province"] == "Tokyo"
        assert loc["_id"] == "uuid-tokyo"

    @patch("py._places_resolver.places_geo_collection")
    def test_unknown_legacy_slug_still_misses(self, mock_coll):
        mock_coll.return_value = _empty_collection()
        assert find_location("nowhere-xx") is None
        assert find_location("canberra--osm-w890123") is None
