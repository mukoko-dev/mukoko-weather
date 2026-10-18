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


class TestSynthesizedSpotsAreNotKnownPlaces:
    @patch("py._places_resolver.places_geo_collection")
    def test_flagged(self, mock_coll):
        from py._places_resolver import is_synthesized_spot

        mock_coll.return_value = _empty_collection()
        assert is_synthesized_spot(find_location(build_smart_slug("X", 51.5, -0.12)))
        assert not is_synthesized_spot({"_id": "uuid-harare", "slug": "harare"})
        assert not is_synthesized_spot(None)

    @patch("py._places_resolver.places_geo_collection")
    def test_weather_history_ignores_a_made_up_spot_hint(self, mock_coll):
        """Anyone can spell `foo--ksy4dd7`; history must not be keyed by it."""
        from py._weather import _resolve_location_hint

        mock_coll.return_value = _empty_collection()
        slug = build_smart_slug("Anything", -17.8292, 31.0522)
        assert _resolve_location_hint(slug, -17.8292, 31.0522) is None


# ---------------------------------------------------------------------------
# Review X1: junk slugs, storage keys, and every caller that persists by slug
# ---------------------------------------------------------------------------

import pytest  # noqa: E402

from py._places_resolver import (  # noqa: E402
    is_synthesized_spot,
    spot_storage_key,
    storage_slug,
)


class TestJunkSpotSlugsAreRejected:
    @pytest.mark.parametrize(
        "slug",
        [
            "anything--k",  # 1-char geohash: a 5,000 km box, not a spot
            "anything--ksy4",  # 4 chars, below the 5-char backend floor
            "Anything--ksy4dd7",  # upper case fails SLUG_RE
            "any thing--ksy4dd7",  # space fails SLUG_RE
            "a_b--ksy4dd7",  # underscore fails SLUG_RE
            "x" * 75 + "--ksy4dd7",  # over 80 characters
            "anything--ksy4ddo",  # 'o' is not in the geohash alphabet
        ],
    )
    @patch("py._places_resolver.places_geo_collection")
    def test_find_location_refuses(self, mock_coll, slug):
        mock_coll.return_value = _empty_collection()
        assert find_location(slug) is None
        assert spot_storage_key(slug) is None

    @patch("py._places_resolver.places_geo_collection")
    def test_five_char_geohash_is_the_floor(self, mock_coll):
        mock_coll.return_value = _empty_collection()
        assert find_location("farm--ksy4d") is not None


class TestSynthesizedSpotShape:
    @patch("py._places_resolver.places_geo_collection")
    def test_no_fake_elevation_or_city_tag(self, mock_coll):
        mock_coll.return_value = _empty_collection()
        loc = find_location(build_smart_slug("West Paddock", -17.83, 31.05))
        assert loc["elevation"] is None
        assert loc["tags"] == []
        assert loc["_id"].startswith("geo:")


class TestStorageSlug:
    @patch("py._places_resolver.places_geo_collection")
    def test_names_do_not_split_a_cell(self, mock_coll):
        mock_coll.return_value = _empty_collection()
        a = "harare-cbd--ksy4dd7"
        b = "made-up-name--ksy4dd7"
        assert storage_slug(a, find_location(a)) == storage_slug(b, find_location(b)) == "geo:ksy4dd7"

    def test_longer_geohash_is_keyed_at_mint_precision(self):
        assert spot_storage_key("x--ksy4dd7zzzz") == "geo:ksy4dd7"

    def test_catalogue_place_keeps_its_slug(self):
        assert storage_slug("harare", {"_id": "uuid-harare", "slug": "harare"}) == "harare"


SPOT = "made-up--ksy4dd7"
SPOT_LOC = {
    "slug": SPOT, "name": "Made Up", "lat": -17.83, "lon": 31.05, "elevation": None,
    "tags": [], "_id": "geo:ksy4dd7", "province": "",
}


class TestCallersKeyASpotByItsCell:
    @pytest.mark.asyncio
    async def test_history_reads_and_backfills_under_the_cell(self):
        from py._history import get_history

        with patch("py._history.find_location", return_value=dict(SPOT_LOC)), \
             patch("py._history.read_history_range", return_value=[]) as read, \
             patch("py._history.backfill_range", return_value=[]) as backfill:
            result = await get_history(location=SPOT, days=7)
        assert read.call_args[0][0] == ["geo:ksy4dd7"]
        assert backfill.call_args[0][0] == "geo:ksy4dd7"
        assert result["location"] == SPOT  # the response still echoes the URL

    @pytest.mark.asyncio
    async def test_report_is_stored_under_the_cell(self):
        from py._reports import SubmitReportRequest, submit_report

        with patch("py._reports.enforce_rate_limit", return_value="1.2.3.4"), \
             patch("py._reports.find_location", return_value=dict(SPOT_LOC)), \
             patch("py._reports.weather_cache_collection") as cache, \
             patch("py._reports.weather_reports_collection") as reports:
            cache.return_value.find_one.return_value = None
            reports.return_value.insert_one.return_value = MagicMock(inserted_id="r1")
            await submit_report(
                SubmitReportRequest(locationSlug=SPOT, reportType="light-rain"), MagicMock(),
            )
        stored = reports.return_value.insert_one.call_args[0][0]
        assert stored["locationSlug"] == "geo:ksy4dd7"

    @pytest.mark.asyncio
    async def test_report_list_reads_the_cell_too(self):
        from py._reports import list_reports

        with patch("py._reports.weather_reports_collection") as reports:
            reports.return_value.find.return_value.sort.return_value.limit.return_value = []
            await list_reports(location=SPOT)
        query = reports.return_value.find.call_args[0][0]
        assert query["locationSlug"] == {"$in": [SPOT, "geo:ksy4dd7"]}

    @pytest.mark.asyncio
    async def test_report_list_for_a_catalogue_slug_is_unchanged(self):
        from py._reports import list_reports

        with patch("py._reports.weather_reports_collection") as reports:
            reports.return_value.find.return_value.sort.return_value.limit.return_value = []
            await list_reports(location="harare")
        assert reports.return_value.find.call_args[0][0]["locationSlug"] == {"$in": ["harare"]}

    @pytest.mark.asyncio
    async def test_locations_endpoint_flags_a_synthesized_spot(self):
        from py._locations import list_locations

        with patch("py._locations.find_location", return_value=dict(SPOT_LOC)):
            result = await list_locations(slug=SPOT)
        assert result["location"]["synthesized"] is True
        assert "_id" not in result["location"]

    def test_place_knowledge_never_labels_a_spot_placesgeo(self):
        from py import _place_knowledge as pk

        with patch("py._places_resolver.find_location", return_value=dict(SPOT_LOC)), \
             patch("py._places_resolver.find_nearest_location", return_value=None):
            place = pk.resolve_place(slug=SPOT, lat=None, lon=None)
        assert place["collection"] is None
        assert place["id"] is None
        assert place["lat"] == -17.83 and place["name"] == "Made Up"

    def test_is_synthesized_spot_on_the_fixture(self):
        assert is_synthesized_spot(SPOT_LOC)
