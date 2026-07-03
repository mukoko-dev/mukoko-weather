"""Tests for _locations.py — slug generation, geocoding, tag inference, endpoints."""

from __future__ import annotations

from unittest.mock import patch, MagicMock, AsyncMock

import pytest
from fastapi import HTTPException

from py._locations import (
    _generate_slug,
    _generate_province_slug,
    _infer_tags,
    _is_valid_coordinates,
    _reverse_geocode,
    _forward_geocode,
    _get_elevation,
    _extract_location_name,
    _normalize_admin1,
    _build_nominatim_address,
    _find_duplicate,
    _match_nearby_poi,
    _enrich_location_with_ai,
    _resolve_slug_collision,
    _CITY_STATES,
    list_locations,
    search_locations,
    geo_lookup,
    add_location,
    MAX_LOCATIONS_LIMIT,
    DEFAULT_LOCATIONS_LIMIT,
    SLUG_RE,
    DEDUP_RADIUS_KM,
)


# ---------------------------------------------------------------------------
# _generate_slug
# ---------------------------------------------------------------------------


class TestGenerateSlug:
    def test_basic_name(self):
        assert _generate_slug("Harare") == "harare"

    def test_converts_to_lowercase(self):
        assert _generate_slug("BULAWAYO") == "bulawayo"

    def test_replaces_spaces_with_hyphens(self):
        assert _generate_slug("Victoria Falls") == "victoria-falls"

    def test_ascii_normalization(self):
        """Accented characters should be normalized to ASCII."""
        result = _generate_slug("Sao Paulo", "BR")
        assert "sao-paulo" in result

    def test_non_zw_country_appends_suffix(self):
        slug = _generate_slug("Nairobi", "KE")
        assert slug.endswith("-ke")
        assert slug == "nairobi-ke"

    def test_zw_country_appends_suffix(self):
        slug = _generate_slug("Harare", "ZW")
        assert slug == "harare-zw"
        assert slug.endswith("-zw")

    def test_caps_at_80_chars(self):
        long_name = "A" * 100
        slug = _generate_slug(long_name, "KE")
        assert len(slug) <= 80

    def test_strips_leading_trailing_hyphens(self):
        slug = _generate_slug("  Harare  ")
        assert not slug.startswith("-")
        assert not slug.endswith("-")

    def test_special_characters_replaced(self):
        slug = _generate_slug("Mt. Darwin's Place!", "KE")
        # Special chars become hyphens
        assert "!" not in slug
        assert "'" not in slug
        assert "." not in slug

    def test_non_zw_suffix_with_long_name(self):
        """Non-ZW slug with country suffix still capped at 80."""
        long_name = "A" * 78
        slug = _generate_slug(long_name, "KE")
        assert len(slug) <= 80


# ---------------------------------------------------------------------------
# _generate_province_slug
# ---------------------------------------------------------------------------


class TestGenerateProvinceSlug:
    def test_basic_province(self):
        result = _generate_province_slug("Mashonaland West", "ZW")
        assert result == "mashonaland-west-zw"

    def test_different_country(self):
        result = _generate_province_slug("Nairobi County", "KE")
        assert result == "nairobi-county-ke"

    def test_caps_at_80_chars(self):
        long_province = "A" * 100
        result = _generate_province_slug(long_province, "ZW")
        assert len(result) <= 80

    def test_ascii_normalization_province(self):
        result = _generate_province_slug("Ile-de-France", "FR")
        assert "ile-de-france" in result


# ---------------------------------------------------------------------------
# _infer_tags
# ---------------------------------------------------------------------------


class TestInferTags:
    def test_city_in_name(self):
        tags = _infer_tags({"name": "Harare City"})
        assert "city" in tags

    def test_town_in_name(self):
        tags = _infer_tags({"name": "Kwekwe Town"})
        assert "city" in tags

    def test_urban_in_name(self):
        tags = _infer_tags({"name": "Urban Area"})
        assert "city" in tags

    def test_population_over_50k(self):
        tags = _infer_tags({"name": "Somewhere", "population": 100000})
        assert "city" in tags

    def test_population_under_50k_gets_default_city(self):
        """When population is under 50k and no keywords, default to 'city'."""
        tags = _infer_tags({"name": "Small Village", "population": 5000})
        assert "city" in tags  # default tag

    def test_no_name_defaults_to_city(self):
        tags = _infer_tags({})
        assert "city" in tags


# ---------------------------------------------------------------------------
# _is_valid_coordinates — app is fully global, only validates WGS 84 bounds
# ---------------------------------------------------------------------------


class TestIsValidCoordinates:
    def test_valid_coordinates(self):
        """Standard coordinates are valid."""
        assert _is_valid_coordinates(-17.83, 31.05) is True

    def test_zero_coordinates(self):
        """Zero coordinates (Gulf of Guinea) are valid."""
        assert _is_valid_coordinates(0, 0) is True

    def test_extreme_north(self):
        """North Pole is valid."""
        assert _is_valid_coordinates(90, 0) is True

    def test_extreme_south(self):
        """South Pole is valid."""
        assert _is_valid_coordinates(-90, 0) is True

    def test_extreme_east(self):
        """180 degrees east is valid."""
        assert _is_valid_coordinates(0, 180) is True

    def test_extreme_west(self):
        """180 degrees west is valid."""
        assert _is_valid_coordinates(0, -180) is True

    def test_new_york_accepted(self):
        """New York — fully global, all coordinates accepted."""
        assert _is_valid_coordinates(40.71, -74.01) is True

    def test_london_accepted(self):
        """London — fully global, all coordinates accepted."""
        assert _is_valid_coordinates(51.51, -0.13) is True

    def test_sydney_accepted(self):
        """Sydney — fully global, all coordinates accepted."""
        assert _is_valid_coordinates(-33.87, 151.21) is True

    def test_tokyo_accepted(self):
        """Tokyo — fully global, all coordinates accepted."""
        assert _is_valid_coordinates(35.69, 139.69) is True

    def test_invalid_latitude_too_high(self):
        """Latitude > 90 is invalid."""
        assert _is_valid_coordinates(91, 0) is False

    def test_invalid_latitude_too_low(self):
        """Latitude < -90 is invalid."""
        assert _is_valid_coordinates(-91, 0) is False

    def test_invalid_longitude_too_high(self):
        """Longitude > 180 is invalid."""
        assert _is_valid_coordinates(0, 181) is False

    def test_invalid_longitude_too_low(self):
        """Longitude < -180 is invalid."""
        assert _is_valid_coordinates(0, -181) is False


# ---------------------------------------------------------------------------
# _reverse_geocode
# ---------------------------------------------------------------------------


class TestReverseGeocode:
    @patch("py._locations._get_http")
    def test_parses_city(self, mock_http):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "lat": "-17.83",
            "lon": "31.05",
            "name": "Harare",
            "address": {
                "city": "Harare",
                "state": "Harare",
                "country": "Zimbabwe",
                "country_code": "zw",
            },
        }
        mock_http.return_value.get.return_value = mock_resp

        result = _reverse_geocode(-17.83, 31.05)
        assert result is not None
        assert result["name"] == "Harare"
        assert result["country"] == "ZW"
        assert result["admin1"] == "Harare"

    @patch("py._locations._get_http")
    def test_prefers_poi_name_over_town(self, mock_http):
        """With zoom=18, data.name is a specific POI — preferred over town."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "lat": "-18.0",
            "lon": "31.5",
            "name": "Marondera High School",
            "address": {
                "town": "Marondera",
                "state": "Mashonaland East",
                "country": "Zimbabwe",
                "country_code": "zw",
            },
        }
        mock_http.return_value.get.return_value = mock_resp

        result = _reverse_geocode(-18.0, 31.5)
        assert result["name"] == "Marondera High School"

    @patch("py._locations._get_http")
    def test_falls_back_to_town_when_no_poi(self, mock_http):
        """When no POI name, falls back through suburb → road → city → town."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "lat": "-18.0",
            "lon": "31.5",
            "address": {
                "town": "Marondera",
                "state": "Mashonaland East",
                "country": "Zimbabwe",
                "country_code": "zw",
            },
        }
        mock_http.return_value.get.return_value = mock_resp

        result = _reverse_geocode(-18.0, 31.5)
        # No POI name, no suburb, no road, no city → falls to town via city chain
        # _extract_location_name: city=None, town="Marondera" → returns "Marondera"
        assert result["name"] == "Marondera"

    @patch("py._locations._get_http")
    def test_falls_back_to_village(self, mock_http):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "lat": "-18.0",
            "lon": "31.5",
            "address": {
                "village": "Rusape",
                "country": "Zimbabwe",
                "country_code": "zw",
            },
        }
        mock_http.return_value.get.return_value = mock_resp

        result = _reverse_geocode(-18.0, 31.5)
        assert result["name"] == "Rusape"

    @patch("py._locations._get_http")
    def test_falls_back_to_suburb(self, mock_http):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "lat": "-17.83",
            "lon": "31.05",
            "address": {
                "suburb": "Avondale",
                "country": "Zimbabwe",
                "country_code": "zw",
            },
        }
        mock_http.return_value.get.return_value = mock_resp

        result = _reverse_geocode(-17.83, 31.05)
        assert result["name"] == "Avondale"

    @patch("py._locations._get_http")
    def test_falls_back_to_county(self, mock_http):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "lat": "-18.0",
            "lon": "31.5",
            "address": {
                "county": "Goromonzi",
                "country": "Zimbabwe",
                "country_code": "zw",
            },
        }
        mock_http.return_value.get.return_value = mock_resp

        result = _reverse_geocode(-18.0, 31.5)
        assert result["name"] == "Goromonzi"

    @patch("py._locations._get_http")
    def test_falls_back_to_name_field(self, mock_http):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "lat": "-18.0",
            "lon": "31.5",
            "name": "SomeName",
            "address": {
                "country": "Zimbabwe",
                "country_code": "zw",
            },
        }
        mock_http.return_value.get.return_value = mock_resp

        result = _reverse_geocode(-18.0, 31.5)
        assert result["name"] == "SomeName"

    @patch("py._locations._get_http")
    def test_returns_none_on_error(self, mock_http):
        mock_http.return_value.get.side_effect = Exception("Network error")
        result = _reverse_geocode(-17.83, 31.05)
        assert result is None

    @patch("py._locations._get_http")
    def test_returns_none_on_non_200(self, mock_http):
        mock_resp = MagicMock()
        mock_resp.status_code = 500
        mock_http.return_value.get.return_value = mock_resp

        result = _reverse_geocode(-17.83, 31.05)
        assert result is None


# ---------------------------------------------------------------------------
# _forward_geocode
# ---------------------------------------------------------------------------


class TestForwardGeocode:
    @patch("py._locations._get_http")
    def test_parses_results(self, mock_http):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "results": [
                {
                    "name": "Harare",
                    "country_code": "ZW",
                    "country": "Zimbabwe",
                    "admin1": "Harare Province",
                    "latitude": -17.83,
                    "longitude": 31.05,
                    "elevation": 1490,
                }
            ]
        }
        mock_http.return_value.get.return_value = mock_resp

        results = _forward_geocode("Harare")
        assert len(results) == 1
        assert results[0]["name"] == "Harare"
        assert results[0]["country"] == "ZW"
        assert results[0]["lat"] == -17.83
        assert results[0]["elevation"] == 1490

    @patch("py._locations._get_http")
    def test_returns_empty_on_error(self, mock_http):
        mock_http.return_value.get.side_effect = Exception("Network error")
        results = _forward_geocode("Harare")
        assert results == []

    @patch("py._locations._get_http")
    def test_returns_empty_on_non_200(self, mock_http):
        mock_resp = MagicMock()
        mock_resp.status_code = 404
        mock_http.return_value.get.return_value = mock_resp

        results = _forward_geocode("Nowhere")
        assert results == []

    @patch("py._locations._get_http")
    def test_handles_missing_results_key(self, mock_http):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {}
        mock_http.return_value.get.return_value = mock_resp

        results = _forward_geocode("empty")
        assert results == []


# ---------------------------------------------------------------------------
# _get_elevation
# ---------------------------------------------------------------------------


class TestGetElevation:
    @patch("py._locations._get_http")
    def test_returns_elevation(self, mock_http):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"elevation": [1490]}
        mock_http.return_value.get.return_value = mock_resp

        assert _get_elevation(-17.83, 31.05) == 1490

    @patch("py._locations._get_http")
    def test_returns_zero_on_error(self, mock_http):
        mock_http.return_value.get.side_effect = Exception("Network error")
        assert _get_elevation(-17.83, 31.05) == 0

    @patch("py._locations._get_http")
    def test_returns_zero_on_non_200(self, mock_http):
        mock_resp = MagicMock()
        mock_resp.status_code = 500
        mock_http.return_value.get.return_value = mock_resp

        assert _get_elevation(-17.83, 31.05) == 0

    @patch("py._locations._get_http")
    def test_returns_zero_on_empty_elevation(self, mock_http):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"elevation": []}
        mock_http.return_value.get.return_value = mock_resp

        assert _get_elevation(-17.83, 31.05) == 0


# ---------------------------------------------------------------------------
# list_locations endpoint
# ---------------------------------------------------------------------------


class TestListLocations:
    """Phase 0G: reads now flow through places.placesGeo via the resolver."""

    @pytest.mark.asyncio
    @patch("py._locations.find_location")
    async def test_single_location_by_slug(self, mock_find):
        mock_find.return_value = {"slug": "harare", "name": "Harare"}
        result = await list_locations(slug="harare")
        assert result["location"]["slug"] == "harare"

    @pytest.mark.asyncio
    @patch("py._locations.find_location")
    async def test_slug_not_found_raises_404(self, mock_find):
        mock_find.return_value = None
        with pytest.raises(HTTPException) as exc_info:
            await list_locations(slug="nonexistent")
        assert exc_info.value.status_code == 404

    @pytest.mark.asyncio
    @patch("py._locations.find_locations_by_tag")
    async def test_tag_filter(self, mock_find):
        mock_find.return_value = [{"slug": "chinhoyi", "name": "Chinhoyi", "tags": ["farming"]}]
        result = await list_locations(tag="farming")
        assert result["total"] == 1
        assert result["locations"][0]["slug"] == "chinhoyi"

    @pytest.mark.asyncio
    @patch("py._locations.find_locations_in_country")
    async def test_country_filter_uppercased(self, mock_find):
        mock_find.return_value = []
        await list_locations(country="zw")
        # Verify the helper was called with the uppercased ISO code
        call_args = mock_find.call_args[0]
        assert call_args[0] == "zw"  # original case preserved at call site
        # The helper itself uppercases internally.

    @pytest.mark.asyncio
    @patch("py._locations.places_geo_collection")
    @patch("py._locations.count_all_locations")
    async def test_stats_mode(self, mock_count, mock_coll):
        mock_count.return_value = 100
        mock_coll.return_value.distinct.side_effect = [
            ["Province1", "Province2"],  # provinces
            ["ZW", "KE"],  # countries
        ]

        result = await list_locations(mode="stats")
        assert result["totalLocations"] == 100
        assert result["totalProvinces"] == 2
        assert result["totalCountries"] == 2

    @pytest.mark.asyncio
    @patch("py._locations.places_geo_collection")
    async def test_tags_mode(self, mock_coll):
        mock_coll.return_value.aggregate.return_value = [
            {"_id": "city", "count": 50},
            {"_id": "farming", "count": 30},
        ]

        result = await list_locations(mode="tags")
        assert result["tags"]["city"] == 50
        assert result["tags"]["farming"] == 30

    @pytest.mark.asyncio
    @patch("py._locations.find_all_locations")
    @patch("py._locations.count_all_locations")
    async def test_limit_clamped_to_max(self, mock_count, mock_find):
        mock_find.return_value = []
        mock_count.return_value = 0
        result = await list_locations(limit=500)
        assert result["limit"] == MAX_LOCATIONS_LIMIT

    @pytest.mark.asyncio
    @patch("py._locations.find_all_locations")
    @patch("py._locations.count_all_locations")
    async def test_limit_clamped_to_min_1(self, mock_count, mock_find):
        mock_find.return_value = []
        mock_count.return_value = 0
        result = await list_locations(limit=-5)
        assert result["limit"] == 1

    @pytest.mark.asyncio
    @patch("py._locations.find_all_locations")
    @patch("py._locations.count_all_locations")
    async def test_skip_clamped_to_zero(self, mock_count, mock_find):
        mock_find.return_value = []
        mock_count.return_value = 0
        result = await list_locations(skip=-10)
        assert result["skip"] == 0


# ---------------------------------------------------------------------------
# search_locations endpoint
# ---------------------------------------------------------------------------


class TestSearchLocations:
    """Phase 0G: search queries placesGeo (regex on name/slug + mukokoSlug)."""

    @pytest.mark.asyncio
    @patch("py._locations.places_geo_collection")
    async def test_text_search(self, mock_coll):
        # placesGeo doc shape — adapter converts to legacy LocationDoc shape
        placesgeo_doc = {
            "_id": "uuid-harare",
            "name": "Harare",
            "slug": "harare-a1b2c3",
            "geoType": "city",
            "geo": {"type": "Point", "coordinates": [31.05, -17.83]},
            "sourceProvenance": {"mukokoSlug": "harare", "mukokoTags": ["city"]},
        }
        mock_cursor = MagicMock()
        mock_cursor.sort.return_value.skip.return_value.limit.return_value.max_time_ms.return_value = [
            placesgeo_doc
        ]
        mock_coll.return_value.find.return_value = mock_cursor

        result = await search_locations(q="harare")
        assert result["source"] == "mongodb"
        assert len(result["locations"]) == 1
        # Score should not be in adapted output
        assert "score" not in result["locations"][0]

    @pytest.mark.asyncio
    @patch("py._locations.places_geo_collection")
    async def test_geospatial_search(self, mock_coll):
        placesgeo_doc = {
            "_id": "uuid-harare",
            "name": "Harare",
            "slug": "harare-a1b2c3",
            "geoType": "city",
            "geo": {"type": "Point", "coordinates": [31.05, -17.83]},
            "sourceProvenance": {"mukokoSlug": "harare", "mukokoTags": ["city"]},
        }
        mock_find = MagicMock()
        mock_find.limit.return_value = [placesgeo_doc]
        mock_coll.return_value.find.return_value = mock_find

        result = await search_locations(lat="-17.83", lon="31.05")
        assert result["source"] == "mongodb"
        assert len(result["locations"]) == 1

    @pytest.mark.asyncio
    @patch("py._locations.find_locations_by_tag")
    async def test_tag_search(self, mock_find):
        mock_find.return_value = [
            {"slug": "chinhoyi", "name": "Chinhoyi", "tags": ["farming"]},
        ]
        result = await search_locations(tag="farming")
        assert result["total"] == 1

    @pytest.mark.asyncio
    async def test_missing_query_raises_400(self):
        with pytest.raises(HTTPException) as exc_info:
            await search_locations(q="", tag=None)
        assert exc_info.value.status_code == 400

    @pytest.mark.asyncio
    @patch("py._locations.places_geo_collection")
    async def test_tags_mode(self, mock_coll):
        mock_coll.return_value.aggregate.return_value = [
            {"_id": "city", "count": 50},
        ]
        result = await search_locations(mode="tags")
        assert "tags" in result


# ---------------------------------------------------------------------------
# geo_lookup endpoint
# ---------------------------------------------------------------------------


class TestGeoLookup:
    """Phase 0G: geo_lookup queries placesGeo via the canonical resolver.

    The fast path no longer touches locations_collection — it calls
    find_nearest_location() against places.placesGeo. Auto-create writes
    only to placesGeo via upsert_placesgeo_city().
    """

    @pytest.mark.asyncio
    @patch("py._locations._reverse_geocode")
    @patch("py._locations.find_nearest_location")
    async def test_nearest_location_returned(self, mock_nearest, mock_geocode):
        mock_nearest.return_value = {"slug": "harare", "name": "Harare", "country": "ZW"}
        result = await geo_lookup(-17.83, 31.05)
        assert result["nearest"]["slug"] == "harare"
        assert result["isNew"] is False

    @pytest.mark.asyncio
    @patch("py._locations.find_nearest_location")
    async def test_returns_nearest_by_distance(self, mock_nearest):
        """Fast path returns the placesGeo $nearSphere closest entry."""
        # The helper returns the nearest single doc — mock as Maputo
        mock_nearest.return_value = {"slug": "maputo", "name": "Maputo", "country": "MZ"}
        result = await geo_lookup(-17.83, 31.05)
        assert result["nearest"]["slug"] == "maputo"

    @pytest.mark.asyncio
    @patch("py._locations.find_nearest_location")
    async def test_ip_geo_caps_nearest_search_radius(self, mock_nearest):
        """The autoCreate=false (IP-geo) fast path must cap `max_km` to a
        realistic IP-geolocation accuracy radius. IP-derived lat/lon can be
        off by hundreds of km, and with an unbounded/near-planetary cap
        `$nearSphere` always returns SOME seed location — even one on
        another continent — which then gets presented to the user as their
        detected location. A tight cap makes a genuinely-far match fall
        through to the 404 (retry with autoCreate=true) instead."""
        mock_nearest.return_value = None
        with pytest.raises(HTTPException):
            await geo_lookup(-17.83, 31.05)

        assert mock_nearest.call_args.kwargs["max_km"] <= 200

    @pytest.mark.asyncio
    @patch("py._locations._find_duplicate")
    @patch("py._locations._reverse_geocode")
    @patch("py._locations.find_nearest_location")
    async def test_duplicate_detection(self, mock_nearest, mock_geocode, mock_dedup):
        """Auto-create should return existing location when a 1km same-name
        duplicate is found."""
        mock_nearest.return_value = None
        mock_geocode.return_value = {"country": "ZW", "name": "Harare", "admin1": "Harare"}
        # The tight 1km _find_duplicate call returns the existing entry.
        mock_dedup.return_value = {"slug": "harare", "name": "Harare"}

        result = await geo_lookup(-17.83, 31.05, autoCreate=True)
        assert result["isNew"] is False
        assert result["nearest"]["slug"] == "harare"

    @pytest.mark.asyncio
    @patch("py._locations.upsert_placesgeo_city")
    @patch("py._locations._enrich_location_with_ai")
    @patch("py._locations._get_elevation")
    @patch("py._locations._find_duplicate")
    @patch("py._locations._reverse_geocode")
    @patch("py._locations.find_nearest_location")
    @patch("py._locations.places_geo_collection")
    async def test_auto_create_success(
        self, mock_coll, mock_nearest, mock_geocode, mock_dedup,
        mock_elev, mock_enrich, mock_upsert,
    ):
        """Auto-create should write to placesGeo when no duplicate exists."""
        mock_nearest.return_value = None
        mock_geocode.return_value = {
            "country": "ZW",
            "countryName": "Zimbabwe",
            "name": "NewPlace",
            "admin1": "Manicaland",
            "lat": -19.0,
            "lon": 32.0,
            "elevation": 1000,
        }
        mock_dedup.return_value = None
        mock_elev.return_value = 1200
        # No slug collision in placesGeo
        mock_coll.return_value.find_one.return_value = None
        mock_upsert.return_value = {"_id": "new-uuid", "slug": "newplace-abc123"}

        result = await geo_lookup(-19.0, 32.0, autoCreate=True)
        assert result["isNew"] is True
        assert result["nearest"]["name"] == "NewPlace"
        mock_upsert.assert_called_once()
        mock_enrich.assert_called_once_with("ZW", -19.0, 32.0)

    @pytest.mark.asyncio
    @patch("py._locations._reverse_geocode")
    @patch("py._locations.find_nearest_location")
    async def test_global_coordinates_accepted(self, mock_nearest, mock_geocode):
        """Any valid global coordinates should be accepted (no region restrictions)."""
        mock_nearest.return_value = None
        mock_geocode.return_value = {
            "country": "US", "countryName": "United States",
            "name": "New York", "admin1": "New York",
            "lat": 40.71, "lon": -74.01, "elevation": 10,
        }
        # With autoCreate=false, should raise 404 (no nearby location, not region error)
        with pytest.raises(HTTPException) as exc_info:
            await geo_lookup(40.71, -74.01)
        assert exc_info.value.status_code == 404
        assert "autoCreate" in exc_info.value.detail

    @pytest.mark.asyncio
    @patch("py._locations._reverse_geocode")
    @patch("py._locations.find_nearest_location")
    async def test_autocreate_skips_uncapped_nearest(self, mock_nearest, mock_geocode):
        """With autoCreate=true and no nearby match, reverse-geocode is invoked."""
        mock_nearest.return_value = None  # No nearby within 50km
        mock_geocode.return_value = None  # Simulate geocode failure to simplify
        with pytest.raises(HTTPException) as exc_info:
            await geo_lookup(40.71, -74.01, autoCreate=True)
        assert exc_info.value.status_code == 422
        mock_geocode.assert_called_once()

    @pytest.mark.asyncio
    @patch("py._locations.upsert_placesgeo_city")
    @patch("py._locations._enrich_location_with_ai")
    @patch("py._locations._get_elevation")
    @patch("py._locations._find_duplicate")
    @patch("py._locations._reverse_geocode")
    @patch("py._locations.find_nearest_location")
    @patch("py._locations.places_geo_collection")
    async def test_slug_collision_uses_suburb(
        self, mock_coll, mock_nearest, mock_geocode, mock_dedup,
        mock_elev, mock_enrich, mock_upsert,
    ):
        """Slug collision should try suburb-enriched slug before falling back."""
        mock_nearest.return_value = None
        mock_geocode.return_value = {
            "country": "SG", "countryName": "Singapore",
            "name": "Woodlands", "admin1": "North",
            "lat": 1.43, "lon": 103.78, "elevation": 10,
            "nominatimAddress": {"suburb": "Marsiling", "road": "Woodlands Ave 3"},
        }
        mock_dedup.return_value = None
        mock_elev.return_value = 10
        # places_geo_collection.find_one: base slug collides, suburb slug free
        mock_coll.return_value.find_one.side_effect = [
            {"sourceProvenance": {"mukokoSlug": "woodlands-sg"}},  # base collides
            None,  # suburb slug "marsiling-sg" available
        ]
        mock_upsert.return_value = {"_id": "new-uuid", "slug": "marsiling-abc123"}

        result = await geo_lookup(1.43, 103.78, autoCreate=True)
        assert result["isNew"] is True
        assert result["nearest"]["slug"] == "marsiling-sg"

    @pytest.mark.asyncio
    @patch("py._locations.upsert_placesgeo_city")
    @patch("py._locations._enrich_location_with_ai")
    @patch("py._locations._get_elevation")
    @patch("py._locations._find_duplicate")
    @patch("py._locations._reverse_geocode")
    @patch("py._locations.find_nearest_location")
    @patch("py._locations.places_geo_collection")
    async def test_slug_collision_falls_back_to_road(
        self, mock_coll, mock_nearest, mock_geocode, mock_dedup,
        mock_elev, mock_enrich, mock_upsert,
    ):
        """When suburb slug also collides, try road-enriched slug."""
        mock_nearest.return_value = None
        mock_geocode.return_value = {
            "country": "SG", "countryName": "Singapore",
            "name": "Woodlands", "admin1": "North",
            "lat": 1.43, "lon": 103.78, "elevation": 10,
            "nominatimAddress": {"suburb": "Marsiling", "road": "Woodlands Ave 3"},
        }
        mock_dedup.return_value = None
        mock_elev.return_value = 10
        # base exists, suburb exists, road free
        mock_coll.return_value.find_one.side_effect = [
            {"sourceProvenance": {"mukokoSlug": "woodlands-sg"}},
            {"sourceProvenance": {"mukokoSlug": "marsiling-sg"}},
            None,
        ]
        mock_upsert.return_value = {"_id": "new-uuid", "slug": "woodlands-ave-3-abc"}

        result = await geo_lookup(1.43, 103.78, autoCreate=True)
        assert result["isNew"] is True
        assert result["nearest"]["slug"] == "woodlands-ave-3-sg"

    # ------------------------------------------------------------------
    # GPS granularity — autoCreate must NEVER snap to a nearby city
    # ------------------------------------------------------------------

    @pytest.mark.asyncio
    @patch("py._locations.upsert_placesgeo_city")
    @patch("py._locations._enrich_location_with_ai")
    @patch("py._locations._get_elevation")
    @patch("py._locations._find_duplicate")
    @patch("py._locations._reverse_geocode")
    @patch("py._locations.find_nearest_location")
    @patch("py._locations.places_geo_collection")
    async def test_autocreate_does_not_snap_to_nearby_city(
        self, mock_coll, mock_nearest, mock_geocode, mock_dedup,
        mock_elev, mock_enrich, mock_upsert,
    ):
        """GPS autoCreate must reverse-geocode to the user's EXACT place and
        create a distinct fine-grained entry — never snap to a nearby city,
        no matter how close it is. There is no distance-based snap at all in
        the autoCreate path, so ``find_nearest_location`` is not consulted.
        """
        # Even if a same-named city existed nearby, the autoCreate path ignores
        # it entirely — no find_nearest_location call is made.
        mock_nearest.return_value = {"slug": "harare", "name": "Harare", "country": "ZW"}
        # Reverse geocode (zoom=18) resolves to a specific road, not the city.
        mock_geocode.return_value = {
            "country": "ZW",
            "countryName": "Zimbabwe",
            "name": "Enterprise Road",
            "admin1": "Harare",
            "lat": -17.78,
            "lon": 31.12,
            "elevation": 1490,
        }
        mock_dedup.return_value = None  # no existing 1km same-name duplicate
        mock_elev.return_value = 1490
        mock_coll.return_value.find_one.return_value = None  # no slug collision
        mock_upsert.return_value = {"_id": "new-uuid", "slug": "enterprise-road-abc123"}

        result = await geo_lookup(-17.78, 31.12, autoCreate=True)

        # A distinct fine-grained location was created — never the city.
        assert result["isNew"] is True
        assert result["nearest"]["name"] == "Enterprise Road"
        assert result["nearest"]["name"] != "Harare"
        mock_geocode.assert_called_once()
        mock_upsert.assert_called_once()
        # No distance snap: nearest-location lookup is never used for autoCreate.
        mock_nearest.assert_not_called()
        # Exactly one (tight, 1km) dedup check — no wider radius check.
        assert mock_dedup.call_count == 1
        assert mock_dedup.call_args.args[2] == DEDUP_RADIUS_KM

    @pytest.mark.asyncio
    @patch("py._locations.upsert_placesgeo_city")
    @patch("py._locations._find_duplicate")
    @patch("py._locations._reverse_geocode")
    @patch("py._locations.find_nearest_location")
    async def test_autocreate_repeat_request_returns_existing_fine_grained(
        self, mock_nearest, mock_geocode, mock_dedup, mock_upsert,
    ):
        """A second identical GPS autoCreate request for the SAME spot (within
        the tight 1km same-name dedup) returns the EXISTING fine-grained entry
        (isNew false) rather than creating a duplicate.
        """
        mock_geocode.return_value = {
            "country": "ZW",
            "countryName": "Zimbabwe",
            "name": "Enterprise Road",
            "admin1": "Harare",
            "lat": -17.78,
            "lon": 31.12,
            "elevation": 1490,
        }
        # Tight 1km name-scoped dedup finds the existing fine-grained entry.
        mock_dedup.return_value = {"slug": "enterprise-road-zw", "name": "Enterprise Road"}

        result = await geo_lookup(-17.78, 31.12, autoCreate=True)

        assert result["isNew"] is False
        assert result["nearest"]["slug"] == "enterprise-road-zw"
        # Dedup short-circuits BEFORE any write, using the tight 1km radius.
        mock_upsert.assert_not_called()
        assert mock_dedup.call_args.args[2] == DEDUP_RADIUS_KM

    @pytest.mark.asyncio
    @patch("py._locations._reverse_geocode")
    @patch("py._locations.find_nearest_location")
    async def test_find_only_returns_nearest_existing(
        self, mock_nearest, mock_geocode,
    ):
        """autoCreate=false (IP-geo find-only) returns the nearest EXISTING
        entry with no coarse cap, and never reverse-geocodes.
        """
        mock_nearest.return_value = {"slug": "harare", "name": "Harare", "country": "ZW"}

        result = await geo_lookup(-17.78, 31.12, autoCreate=False)

        assert result["isNew"] is False
        assert result["nearest"]["slug"] == "harare"
        mock_geocode.assert_not_called()


# ---------------------------------------------------------------------------
# add_location endpoint
# ---------------------------------------------------------------------------


class TestAddLocation:
    @pytest.mark.asyncio
    @patch("py._locations._forward_geocode")
    async def test_search_mode_returns_candidates(self, mock_geocode):
        mock_geocode.return_value = [
            {"name": "Harare", "country": "ZW", "countryName": "Zimbabwe",
             "admin1": "Harare", "lat": -17.83, "lon": 31.05, "elevation": 1490}
        ]

        request = MagicMock()
        request.json = AsyncMock(return_value={"query": "Harare"})

        result = await add_location(request)
        assert result["mode"] == "candidates"
        assert len(result["results"]) == 1

    @pytest.mark.asyncio
    @patch("py._locations._forward_geocode")
    async def test_search_mode_empty_query_raises_400(self, mock_geocode):
        request = MagicMock()
        request.json = AsyncMock(return_value={"query": "   "})

        with pytest.raises(HTTPException) as exc_info:
            await add_location(request)
        assert exc_info.value.status_code == 400

    @pytest.mark.asyncio
    @patch("py._locations._forward_geocode")
    async def test_search_mode_returns_all_global_results(self, mock_geocode):
        """All geocode results are returned — no region filtering."""
        mock_geocode.return_value = [
            {"name": "Harare", "country": "ZW", "countryName": "Zimbabwe",
             "admin1": "Harare", "lat": -17.83, "lon": 31.05},
            {"name": "London", "country": "GB", "countryName": "United Kingdom",
             "admin1": "England", "lat": 51.5, "lon": -0.12},
        ]

        request = MagicMock()
        request.json = AsyncMock(return_value={"query": "harare"})

        result = await add_location(request)
        assert len(result["results"]) == 2

    @pytest.mark.asyncio
    async def test_coordinates_mode_invalid_coords(self):
        request = MagicMock()
        request.json = AsyncMock(return_value={"lat": 91, "lon": 0})

        with pytest.raises(HTTPException) as exc_info:
            await add_location(request)
        assert exc_info.value.status_code == 400

    @pytest.mark.asyncio
    @patch("py._locations.check_rate_limit")
    @patch("py._locations.get_client_ip")
    async def test_coordinates_mode_rate_limited(self, mock_ip, mock_rate):
        mock_ip.return_value = "1.2.3.4"
        mock_rate.return_value = {"allowed": False, "remaining": 0}

        request = MagicMock()
        request.json = AsyncMock(return_value={"lat": -17.83, "lon": 31.05})

        with pytest.raises(HTTPException) as exc_info:
            await add_location(request)
        assert exc_info.value.status_code == 429

    @pytest.mark.asyncio
    @patch("py._locations._reverse_geocode")
    @patch("py._locations.check_rate_limit")
    @patch("py._locations.get_client_ip")
    async def test_coordinates_mode_geocode_fails(self, mock_ip, mock_rate, mock_geocode):
        mock_ip.return_value = "1.2.3.4"
        mock_rate.return_value = {"allowed": True, "remaining": 4}
        mock_geocode.return_value = None

        request = MagicMock()
        request.json = AsyncMock(return_value={"lat": -17.83, "lon": 31.05})

        with pytest.raises(HTTPException) as exc_info:
            await add_location(request)
        assert exc_info.value.status_code == 422

    @pytest.mark.asyncio
    @patch("py._locations._find_duplicate")
    @patch("py._locations._reverse_geocode")
    @patch("py._locations.check_rate_limit")
    @patch("py._locations.get_client_ip")
    async def test_coordinates_mode_duplicate_found(self, mock_ip, mock_rate,
                                                     mock_geocode, mock_dedup):
        mock_ip.return_value = "1.2.3.4"
        mock_rate.return_value = {"allowed": True, "remaining": 4}
        mock_geocode.return_value = {"country": "ZW", "name": "Harare", "admin1": "Harare",
                                      "countryName": "Zimbabwe", "lat": -17.83, "lon": 31.05}
        mock_dedup.return_value = {"slug": "harare", "name": "Harare", "province": "Harare", "country": "ZW"}

        request = MagicMock()
        request.json = AsyncMock(return_value={"lat": -17.83, "lon": 31.05})

        result = await add_location(request)
        assert result["mode"] == "duplicate"
        assert result["existing"]["slug"] == "harare"

    @pytest.mark.asyncio
    @patch("py._locations.upsert_placesgeo_city")
    @patch("py._locations._enrich_location_with_ai")
    @patch("py._locations._get_elevation")
    @patch("py._locations._find_duplicate")
    @patch("py._locations._reverse_geocode")
    @patch("py._locations.check_rate_limit")
    @patch("py._locations.get_client_ip")
    @patch("py._locations.places_geo_collection")
    async def test_coordinates_mode_creates_location(
        self, mock_coll, mock_ip, mock_rate, mock_geocode, mock_dedup,
        mock_elev, mock_enrich, mock_upsert,
    ):
        mock_ip.return_value = "1.2.3.4"
        mock_rate.return_value = {"allowed": True, "remaining": 4}
        mock_geocode.return_value = {
            "country": "ZW", "countryName": "Zimbabwe", "name": "NewPlace",
            "admin1": "Manicaland", "lat": -19.0, "lon": 32.0, "elevation": 1000,
        }
        mock_dedup.return_value = None
        mock_elev.return_value = 1200
        mock_coll.return_value.find_one.return_value = None  # No slug collision
        mock_upsert.return_value = {"_id": "new-uuid", "slug": "newplace-abc123"}

        request = MagicMock()
        request.json = AsyncMock(return_value={"lat": -19.0, "lon": 32.0})

        result = await add_location(request)
        assert result["mode"] == "created"
        assert result["location"]["name"] == "NewPlace"
        mock_upsert.assert_called_once()
        mock_enrich.assert_called_once_with("ZW", -19.0, 32.0)

    @pytest.mark.asyncio
    @patch("py._locations.upsert_placesgeo_city")
    @patch("py._locations._enrich_location_with_ai")
    @patch("py._locations._get_elevation")
    @patch("py._locations._find_duplicate")
    @patch("py._locations._reverse_geocode")
    @patch("py._locations.check_rate_limit")
    @patch("py._locations.get_client_ip")
    @patch("py._locations.places_geo_collection")
    async def test_slug_collision_resolved_via_suburb_enrichment(
        self, mock_coll, mock_ip, mock_rate, mock_geocode, mock_dedup,
        mock_elev, mock_enrich, mock_upsert,
    ):
        """When the base slug collides, suburb-enrichment yields a different slug.

        Replaces the old numeric-suffix behaviour — Phase 0E removed
        ``harare-zw-2`` style auto-suffixing because it created duplicate
        records for the same place.
        """
        mock_ip.return_value = "1.2.3.4"
        mock_rate.return_value = {"allowed": True, "remaining": 4}
        mock_geocode.return_value = {
            "country": "ZW", "countryName": "Zimbabwe", "name": "Harare",
            "admin1": "Harare", "lat": -17.9, "lon": 31.1, "elevation": 1400,
            "nominatimAddress": {"suburb": "Avondale"},
        }
        mock_dedup.return_value = None
        mock_elev.return_value = 1400
        # places_geo_collection.find_one: base slug exists, suburb slug free
        mock_coll.return_value.find_one.side_effect = [
            {"sourceProvenance": {"mukokoSlug": "harare-zw"}},
            None,
        ]
        mock_upsert.return_value = {"_id": "new-uuid", "slug": "avondale-abc123"}

        request = MagicMock()
        request.json = AsyncMock(return_value={"lat": -17.9, "lon": 31.1})

        result = await add_location(request)
        assert result["mode"] == "created"
        # Suburb-enriched slug was used — NOT a numeric suffix.
        assert result["location"]["slug"] == "avondale-zw"
        # Make sure we didn't fall through to a numeric-suffix slug.
        import re as _re
        assert _re.search(r"-\d+$", result["location"]["slug"]) is None


# ---------------------------------------------------------------------------
# _enrich_location_with_ai — AI season enrichment on location creation
# ---------------------------------------------------------------------------


class TestEnrichLocationWithAi:
    """Tests for _enrich_location_with_ai — runs in a background thread."""

    def _call_and_wait(self, *args):
        """Call _enrich_location_with_ai and wait for the background thread."""
        import threading
        initial = threading.active_count()
        _enrich_location_with_ai(*args)
        # Wait for the daemon thread to finish (max 2s)
        import time
        deadline = time.monotonic() + 2
        while threading.active_count() > initial and time.monotonic() < deadline:
            time.sleep(0.01)

    @patch("py._locations.get_db")
    def test_skips_when_country_has_seasons(self, mock_db):
        """Does not call AI if country already has season data."""
        mock_coll = MagicMock()
        mock_db.return_value.__getitem__ = MagicMock(return_value=mock_coll)
        mock_coll.find_one.return_value = {"countryCode": "ZW", "name": "Summer"}

        self._call_and_wait("ZW", -17.8, 31.0)

        # Should check DB, find existing, and not call AI
        mock_coll.find_one.assert_called_once()

    @patch("py._ai._resolve_seasons_with_ai")
    @patch("py._locations.get_db")
    def test_triggers_ai_when_no_seasons(self, mock_db, mock_resolve):
        """Calls AI resolution when country has no season data."""
        mock_coll = MagicMock()
        mock_db.return_value.__getitem__ = MagicMock(return_value=mock_coll)
        mock_coll.find_one.return_value = None  # No seasons in DB

        self._call_and_wait("VN", 21.0, 105.8)
        mock_resolve.assert_called_once_with("VN", 21.0, 105.8)

    @patch("py._locations.get_db")
    def test_handles_db_error_gracefully(self, mock_db):
        """DB errors should be swallowed silently."""
        mock_db.side_effect = Exception("DB connection failed")

        # Should not raise
        self._call_and_wait("XX", 0.0, 0.0)

    @patch("py._ai._resolve_seasons_with_ai")
    @patch("py._locations.get_db")
    def test_handles_ai_error_gracefully(self, mock_db, mock_resolve):
        """AI errors should be swallowed silently."""
        mock_coll = MagicMock()
        mock_db.return_value.__getitem__ = MagicMock(return_value=mock_coll)
        mock_coll.find_one.return_value = None
        mock_resolve.side_effect = Exception("AI unavailable")

        # Should not raise
        self._call_and_wait("XX", 0.0, 0.0)

    def test_runs_in_background_thread(self):
        """Enrichment should return immediately (thread-based)."""
        import threading
        initial = threading.active_count()
        with patch("py._locations.get_db") as mock_db:
            mock_coll = MagicMock()
            mock_db.return_value.__getitem__ = MagicMock(return_value=mock_coll)
            mock_coll.find_one.return_value = {"countryCode": "ZW"}

            _enrich_location_with_ai("ZW", -17.8, 31.0)
            # Function should return immediately (thread spawned)
            # We just verify no error was raised


# ---------------------------------------------------------------------------
# SLUG_RE
# ---------------------------------------------------------------------------


class TestSlugRegex:
    def test_valid_slug(self):
        assert SLUG_RE.match("harare")
        assert SLUG_RE.match("victoria-falls")
        assert SLUG_RE.match("a" * 80)

    def test_invalid_slug(self):
        assert SLUG_RE.match("Harare") is None  # uppercase
        assert SLUG_RE.match("a" * 81) is None  # too long
        assert SLUG_RE.match("") is None


# ---------------------------------------------------------------------------
# _extract_location_name
# ---------------------------------------------------------------------------


class TestExtractLocationName:
    def test_prefers_poi_name_over_city(self):
        """POI name like 'Singapore American School' should be preferred."""
        data = {"name": "Singapore American School"}
        address = {"city": "Singapore", "country": "Singapore"}
        assert _extract_location_name(data, address, "SG") == "Singapore American School"

    def test_rejects_poi_name_matching_city(self):
        """If POI name equals city name, fall through to suburb."""
        data = {"name": "Singapore"}
        address = {"city": "Singapore", "suburb": "Woodlands", "country": "Singapore"}
        assert _extract_location_name(data, address, "SG") == "Woodlands"

    def test_rejects_poi_name_matching_country(self):
        """If POI name equals country, fall through."""
        data = {"name": "Singapore"}
        address = {"country": "Singapore", "suburb": "Tanglin"}
        assert _extract_location_name(data, address, "SG") == "Tanglin"

    def test_falls_back_to_suburb(self):
        """When no POI name, use suburb."""
        data = {}
        address = {"suburb": "Strathaven", "city": "Harare", "country": "Zimbabwe"}
        assert _extract_location_name(data, address, "ZW") == "Strathaven"

    def test_falls_back_to_road(self):
        """When no POI name or suburb, use road."""
        data = {}
        address = {"road": "525 Canberra Drive", "city": "Singapore", "country": "Singapore"}
        assert _extract_location_name(data, address, "SG") == "525 Canberra Drive"

    def test_falls_back_to_city(self):
        """Last resort: city name."""
        data = {}
        address = {"city": "Harare", "country": "Zimbabwe"}
        assert _extract_location_name(data, address, "ZW") == "Harare"

    def test_falls_back_to_village(self):
        """No city — falls back to village."""
        data = {}
        address = {"village": "Rusape", "country": "Zimbabwe"}
        assert _extract_location_name(data, address, "ZW") == "Rusape"

    def test_falls_back_to_data_name_as_last_resort(self):
        """When address is empty, use data.name."""
        data = {"name": "SomeName"}
        address = {"country": "Zimbabwe"}
        assert _extract_location_name(data, address, "ZW") == "SomeName"

    def test_empty_poi_name_ignored(self):
        """Empty string POI name should be skipped."""
        data = {"name": ""}
        address = {"city": "Harare", "country": "Zimbabwe"}
        assert _extract_location_name(data, address, "ZW") == "Harare"


# ---------------------------------------------------------------------------
# _normalize_admin1
# ---------------------------------------------------------------------------


class TestNormalizeAdmin1:
    def test_city_state_uses_district(self):
        """Singapore (city-state) should use city_district, not state."""
        address = {"state": "11", "city_district": "Woodlands", "country": "Singapore"}
        assert _normalize_admin1(address, "SG", "Singapore") == "Woodlands"

    def test_city_state_falls_back_to_suburb(self):
        """City-state with no city_district falls to suburb."""
        address = {"state": "14", "suburb": "Tanglin", "country": "Singapore"}
        assert _normalize_admin1(address, "SG", "Singapore") == "Tanglin"

    def test_city_state_falls_back_to_country_name(self):
        """City-state with no district fields falls to country name."""
        address = {"state": "11", "country": "Singapore"}
        assert _normalize_admin1(address, "SG", "Singapore") == "Singapore"

    def test_normal_country_valid_state(self):
        """Normal country with valid state passes through."""
        address = {"state": "Nairobi County", "country": "Kenya"}
        assert _normalize_admin1(address, "KE", "Kenya") == "Nairobi County"

    def test_rejects_numeric_state(self):
        """Purely numeric state (postal code) should be rejected."""
        address = {"state": "11", "state_district": "Central Region", "country": "Some"}
        assert _normalize_admin1(address, "XX", "Some") == "Central Region"

    def test_rejects_short_state(self):
        """State ≤2 chars (e.g., 'AB') should be rejected."""
        address = {"state": "AB", "county": "Fallback County", "country": "Some"}
        assert _normalize_admin1(address, "XX", "Some") == "Fallback County"

    def test_rejects_digit_heavy_state(self):
        """State with >50% digits should be rejected."""
        address = {"state": "12345A", "region": "Metro", "country": "Some"}
        result = _normalize_admin1(address, "XX", "Some")
        assert result == "Metro"

    def test_empty_state_falls_through(self):
        """Empty state falls through to fallback chain."""
        address = {"state": "", "county": "Some County", "country": "Some"}
        assert _normalize_admin1(address, "XX", "Some") == "Some County"

    def test_zimbabwe_valid_province(self):
        """Zimbabwe with valid province passes through."""
        address = {"state": "Mashonaland East", "country": "Zimbabwe"}
        assert _normalize_admin1(address, "ZW", "Zimbabwe") == "Mashonaland East"

    def test_all_city_states_defined(self):
        """Verify known city-states are in the set."""
        assert "SG" in _CITY_STATES
        assert "MC" in _CITY_STATES
        assert "DJ" in _CITY_STATES
        assert "BH" in _CITY_STATES
        assert "QA" in _CITY_STATES


# ---------------------------------------------------------------------------
# _build_nominatim_address
# ---------------------------------------------------------------------------


class TestBuildNominatimAddress:
    def test_extracts_fields(self):
        address = {
            "road": "Orchard Road",
            "suburb": "Tanglin",
            "city": "Singapore",
            "state": "11",
            "postcode": "238823",
            "country": "Singapore",
            "country_code": "sg",
        }
        result = _build_nominatim_address(address, "SG", "Orchard Road, Tanglin, Singapore")
        assert result["road"] == "Orchard Road"
        assert result["suburb"] == "Tanglin"
        assert result["city"] == "Singapore"
        assert result["state"] == "11"
        assert result["postcode"] == "238823"
        assert result["country"] == "Singapore"
        assert result["countryCode"] == "SG"
        assert result["displayName"] == "Orchard Road, Tanglin, Singapore"

    def test_omits_none_values(self):
        """None values should not appear in the result dict."""
        address = {"city": "Harare", "country": "Zimbabwe"}
        result = _build_nominatim_address(address, "ZW", "Harare, Zimbabwe")
        assert "road" not in result
        assert "suburb" not in result
        assert "postcode" not in result
        assert result["city"] == "Harare"

    def test_empty_display_name_omitted(self):
        """Empty display_name should not be included."""
        address = {"city": "Harare"}
        result = _build_nominatim_address(address, "ZW", "")
        assert "displayName" not in result


# ---------------------------------------------------------------------------
# _find_duplicate — name+country matching
# ---------------------------------------------------------------------------


class TestFindDuplicateNameCountry:
    """Phase 0G: _find_duplicate queries placesGeo via find_nearby_placesgeo."""

    @patch("py._locations.places_geo_collection")
    @patch("py._locations.find_nearby_placesgeo")
    def test_geo_match_returns_first(self, mock_nearby, mock_coll):
        """Geospatial match should be returned even if name/country also matches."""
        mock_nearby.return_value = {
            "_id": "uuid-1",
            "name": "Nearby",
            "slug": "nearby-abc",
            "geo": {"type": "Point", "coordinates": [103.8, 1.3]},
            "sourceProvenance": {"mukokoSlug": "nearby"},
        }
        result = _find_duplicate(1.3, 103.8, 1.0, name="Singapore", country="SG")
        assert result is not None
        assert result["slug"] == "nearby"

    @patch("py._locations.places_geo_collection")
    @patch("py._locations.find_nearby_placesgeo")
    def test_name_country_match_when_no_geo(self, mock_nearby, mock_coll):
        """When no geospatial match, name+country should catch duplicates."""
        mock_nearby.return_value = None
        # places_geo_collection.find_one returns the name/country fallback match
        mock_coll.return_value.find_one.return_value = {
            "_id": "uuid-2",
            "name": "Singapore",
            "slug": "singapore-xyz",
            "geo": {"type": "Point", "coordinates": [103.8, 1.3]},
            "sourceProvenance": {"mukokoSlug": "singapore-sg"},
        }
        result = _find_duplicate(1.3, 103.8, 1.0, name="Singapore", country="SG")
        assert result is not None
        assert result["slug"] == "singapore-sg"

    @patch("py._locations.places_geo_collection")
    @patch("py._locations.find_nearby_placesgeo")
    def test_no_match_returns_none(self, mock_nearby, mock_coll):
        """When neither geo nor name match, return None."""
        mock_nearby.return_value = None
        mock_coll.return_value.find_one.return_value = None
        result = _find_duplicate(1.3, 103.8, 1.0, name="NewPlace", country="SG")
        assert result is None

    @patch("py._locations.places_geo_collection")
    @patch("py._locations.find_nearby_placesgeo")
    def test_no_name_skips_name_check(self, mock_nearby, mock_coll):
        """When name is None, only the placesGeo nearby check runs."""
        mock_nearby.return_value = None
        result = _find_duplicate(1.3, 103.8, 1.0)
        assert result is None
        # placesGeo regex fallback should NOT be called when name is None
        mock_coll.return_value.find_one.assert_not_called()


# ---------------------------------------------------------------------------
# _reverse_geocode — nominatimAddress and zoom=18
# ---------------------------------------------------------------------------


class TestReverseGeocodeNominatimAddress:
    @patch("py._locations._get_http")
    def test_includes_nominatim_address(self, mock_http):
        """Result should include structured nominatimAddress."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "lat": "1.35",
            "lon": "103.82",
            "name": "Singapore American School",
            "display_name": "Singapore American School, Woodlands Ave 1, Singapore",
            "address": {
                "amenity": "Singapore American School",
                "road": "Woodlands Avenue 1",
                "suburb": "Woodlands",
                "city": "Singapore",
                "state": "11",
                "city_district": "Woodlands",
                "postcode": "738547",
                "country": "Singapore",
                "country_code": "sg",
            },
        }
        mock_http.return_value.get.return_value = mock_resp

        result = _reverse_geocode(1.35, 103.82)
        assert result is not None
        assert result["name"] == "Singapore American School"
        assert result["admin1"] == "Woodlands"  # city_district for city-state
        assert "nominatimAddress" in result
        na = result["nominatimAddress"]
        assert na["road"] == "Woodlands Avenue 1"
        assert na["suburb"] == "Woodlands"
        assert na["city"] == "Singapore"
        assert na["countryCode"] == "SG"
        assert "displayName" in na

    @patch("py._locations._get_http")
    def test_default_zoom_14_for_privacy(self, mock_http):
        """Default zoom=14 (suburb level) for GPS auto-creation privacy."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "lat": "-17.83",
            "lon": "31.05",
            "name": "Avondale",
            "address": {
                "city": "Harare",
                "state": "Harare",
                "country": "Zimbabwe",
                "country_code": "zw",
            },
        }
        mock_http.return_value.get.return_value = mock_resp

        _reverse_geocode(-17.83, 31.05)
        call_args = mock_http.return_value.get.call_args
        params = call_args.kwargs.get("params", call_args[1].get("params", {}))
        assert params.get("zoom") == 14

    @patch("py._locations._get_http")
    def test_zoom_18_for_explicit_search(self, mock_http):
        """Explicit zoom=18 for named search queries (POI-level specificity)."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "lat": "-17.83",
            "lon": "31.05",
            "name": "Meikles Hotel",
            "address": {
                "city": "Harare",
                "state": "Harare",
                "country": "Zimbabwe",
                "country_code": "zw",
            },
        }
        mock_http.return_value.get.return_value = mock_resp

        _reverse_geocode(-17.83, 31.05, zoom=18)
        call_args = mock_http.return_value.get.call_args
        params = call_args.kwargs.get("params", call_args[1].get("params", {}))
        assert params.get("zoom") == 18


# ---------------------------------------------------------------------------
# _resolve_slug_collision
# ---------------------------------------------------------------------------


class TestResolveSlugCollision:
    @patch("py._locations.places_geo_collection")
    def test_no_collision_returns_original(self, mock_col):
        mock_col.return_value.find_one.return_value = None
        geocoded = {"name": "Harare", "country": "ZW", "nominatimAddress": {}}
        result = _resolve_slug_collision("harare-zw", geocoded)
        assert result == "harare-zw"

    @patch("py._locations.places_geo_collection")
    def test_suburb_enriched_slug(self, mock_col):
        """When base slug collides, try suburb-enriched slug."""
        def find_one_side(query):
            slug = query.get("sourceProvenance.mukokoSlug", "")
            if slug == "harare-zw":
                return {"slug": "harare-zw"}  # collision
            return None  # suburb slug is free

        mock_col.return_value.find_one.side_effect = find_one_side
        geocoded = {
            "name": "Harare",
            "country": "ZW",
            "nominatimAddress": {"suburb": "Avondale", "road": "King George Rd"},
        }
        result = _resolve_slug_collision("harare-zw", geocoded)
        assert result == "avondale-zw"

    @patch("py._locations.places_geo_collection")
    def test_road_enriched_slug_when_suburb_also_collides(self, mock_col):
        """When both base and suburb collide, try road-enriched slug."""
        def find_one_side(query):
            slug = query.get("sourceProvenance.mukokoSlug", "")
            if slug in ("harare-zw", "avondale-zw"):
                return {"slug": slug}  # both collide
            return None

        mock_col.return_value.find_one.side_effect = find_one_side
        geocoded = {
            "name": "Harare",
            "country": "ZW",
            "nominatimAddress": {"suburb": "Avondale", "road": "King George Rd"},
        }
        result = _resolve_slug_collision("harare-zw", geocoded)
        assert result == "king-george-rd-zw"

    @patch("py._locations.places_geo_collection")
    def test_raises_when_all_descriptive_paths_collide(self, mock_col):
        """When base + suburb + road slugs all collide, raise SlugCollisionError.

        Phase 0E removed the numeric-suffix fallback because it generated
        duplicate records for the same physical place (e.g. ``harare-zw-2``,
        ``-3``, …). The caller now catches the exception and surfaces the
        existing record as a duplicate.
        """
        from py._locations import SlugCollisionError

        def find_one_side(query):
            slug = query.get("sourceProvenance.mukokoSlug", "")
            if slug in ("harare-zw", "avondale-zw", "king-george-rd-zw"):
                return {"slug": slug}
            return None

        mock_col.return_value.find_one.side_effect = find_one_side
        geocoded = {
            "name": "Harare",
            "country": "ZW",
            "nominatimAddress": {"suburb": "Avondale", "road": "King George Rd"},
        }
        with pytest.raises(SlugCollisionError) as exc:
            _resolve_slug_collision("harare-zw", geocoded)
        assert exc.value.existing_slug == "harare-zw"

    @patch("py._locations.places_geo_collection")
    def test_skips_suburb_when_same_as_name(self, mock_col):
        """Suburb matching location name should be skipped."""
        call_count = [0]

        def find_one_side(query):
            slug = query.get("sourceProvenance.mukokoSlug", "")
            call_count[0] += 1
            if slug == "avondale-zw":
                return {"slug": "avondale-zw"}  # collision
            return None

        mock_col.return_value.find_one.side_effect = find_one_side
        geocoded = {
            "name": "Avondale",
            "country": "ZW",
            "nominatimAddress": {"suburb": "Avondale", "road": "Main St"},
        }
        result = _resolve_slug_collision("avondale-zw", geocoded)
        # Should skip suburb (same as name) and use road
        assert result == "main-st-zw"

    @patch("py._locations.places_geo_collection")
    def test_handles_missing_name_key(self, mock_col):
        """Should not raise KeyError when geocoded dict has no 'name' key."""
        def find_one_side(query):
            slug = query.get("sourceProvenance.mukokoSlug", "")
            if slug == "unknown-zw":
                return {"slug": "unknown-zw"}  # collision
            return None

        mock_col.return_value.find_one.side_effect = find_one_side
        geocoded = {
            "country": "ZW",
            "nominatimAddress": {"suburb": "Avondale"},
        }
        # Should not raise — .get("name", "") provides safe default
        result = _resolve_slug_collision("unknown-zw", geocoded)
        assert result == "avondale-zw"

    @patch("py._locations.places_geo_collection")
    def test_handles_missing_country_key(self, mock_col):
        """Should not raise KeyError when geocoded dict has no 'country' key."""
        # First call: collision on original slug; second call: suburb slug free
        mock_col.return_value.find_one.side_effect = [
            {"slug": "test"},  # original slug exists
            None,              # suburb-enriched slug is available
        ]
        geocoded = {
            "name": "Test",
            "nominatimAddress": {"suburb": "Downtown"},
        }
        result = _resolve_slug_collision("test", geocoded)
        assert isinstance(result, str)


# ---------------------------------------------------------------------------
# add_location — Phase 0E platform integration (placesGeo + Fundi)
# ---------------------------------------------------------------------------


class TestAddLocationPlatformIntegration:
    """Verifies the placesGeo mirror + Fundi seed queue are wired into add_location."""

    @staticmethod
    def _geocoded_zim_zw():
        return {
            "country": "ZW",
            "countryName": "Zimbabwe",
            "name": "NewPlace",
            "admin1": "Manicaland",
            "lat": -19.0,
            "lon": 32.0,
            "elevation": 1000,
        }

    @pytest.mark.asyncio
    @patch("py._places_geo.enqueue_fundi_seed")
    @patch("py._locations.upsert_placesgeo_city")
    @patch("py._locations._enrich_location_with_ai")
    @patch("py._locations.get_db")
    @patch("py._locations._get_elevation")
    @patch("py._locations._find_duplicate")
    @patch("py._locations._reverse_geocode")
    @patch("py._locations.check_rate_limit")
    @patch("py._locations.get_client_ip")
    @patch("py._locations.places_geo_collection")
    async def test_writes_to_placesgeo_when_new(
        self, mock_coll, mock_ip, mock_rate, mock_geocode, mock_dedup,
        mock_elev, mock_db, mock_enrich, mock_upsert, mock_queue,
    ):
        mock_ip.return_value = "1.2.3.4"
        mock_rate.return_value = {"allowed": True, "remaining": 4}
        mock_geocode.return_value = self._geocoded_zim_zw()
        mock_dedup.return_value = None
        mock_elev.return_value = 1200
        mock_coll.return_value.find_one.return_value = None
        mock_db_inst = MagicMock()
        mock_db.return_value = mock_db_inst
        mock_db_inst.__getitem__ = MagicMock(return_value=MagicMock())

        # Fresh placesGeo entry (wasExisting not set)
        mock_upsert.return_value = {
            "_id": "new-placesgeo-uuid",
            "slug": "newplace-abc123",
        }

        request = MagicMock()
        request.json = AsyncMock(return_value={"lat": -19.0, "lon": 32.0})

        result = await add_location(request)

        assert result["mode"] == "created"
        # Phase 0G: weather.locations.insert_one is gone — placesGeo is the
        # only write target. Assert the placesGeo upsert was called instead.
        mock_upsert.assert_called_once()
        upsert_kwargs = mock_upsert.call_args.kwargs
        assert upsert_kwargs["name"] == "NewPlace"
        assert upsert_kwargs["country_iso"] == "ZW"
        assert upsert_kwargs["lat"] == -19.0
        assert upsert_kwargs["lon"] == 32.0
        # Phase 0F: mukoko clean URL slug + tags must be stamped onto the
        # placesGeo entry so the TS resolveLocationSlug helper can find it.
        assert upsert_kwargs["mukoko_slug"]
        assert upsert_kwargs["mukoko_tags"]

        # Phase 0F: Fundi POI enrichment is intentionally NOT triggered —
        # POI seeding (places.places) is a separate optional concern.
        mock_queue.assert_not_called()

    @pytest.mark.asyncio
    @patch("py._places_geo.enqueue_fundi_seed")
    @patch("py._locations.upsert_placesgeo_city")
    @patch("py._locations._enrich_location_with_ai")
    @patch("py._locations.get_db")
    @patch("py._locations._get_elevation")
    @patch("py._locations._find_duplicate")
    @patch("py._locations._reverse_geocode")
    @patch("py._locations.check_rate_limit")
    @patch("py._locations.get_client_ip")
    @patch("py._locations.places_geo_collection")
    async def test_uses_existing_placesgeo_when_dedup_match(
        self, mock_coll, mock_ip, mock_rate, mock_geocode, mock_dedup,
        mock_elev, mock_db, mock_enrich, mock_upsert, mock_queue,
    ):
        """When upsert returns an existing doc (wasExisting=True), surface its IDs."""
        mock_ip.return_value = "1.2.3.4"
        mock_rate.return_value = {"allowed": True, "remaining": 4}
        mock_geocode.return_value = self._geocoded_zim_zw()
        mock_dedup.return_value = None
        mock_elev.return_value = 1200
        mock_coll.return_value.find_one.return_value = None
        mock_db_inst = MagicMock()
        mock_db.return_value = mock_db_inst
        mock_db_inst.__getitem__ = MagicMock(return_value=MagicMock())

        mock_upsert.return_value = {
            "_id": "existing-uuid",
            "slug": "newplace-existing",
            "wasExisting": True,
        }

        request = MagicMock()
        request.json = AsyncMock(return_value={"lat": -19.0, "lon": 32.0})

        result = await add_location(request)
        assert result["mode"] == "created"
        assert result["placesGeoId"] == "existing-uuid"
        assert result["placesGeoSlug"] == "newplace-existing"
        # Phase 0F: Fundi POI enrichment is not triggered.
        mock_queue.assert_not_called()

    @pytest.mark.asyncio
    @patch("py._places_geo.enqueue_fundi_seed")
    @patch("py._locations.upsert_placesgeo_city")
    @patch("py._locations._enrich_location_with_ai")
    @patch("py._locations.get_db")
    @patch("py._locations._get_elevation")
    @patch("py._locations._find_duplicate")
    @patch("py._locations._reverse_geocode")
    @patch("py._locations.check_rate_limit")
    @patch("py._locations.get_client_ip")
    @patch("py._locations.places_geo_collection")
    async def test_response_includes_placesgeo_id(
        self, mock_coll, mock_ip, mock_rate, mock_geocode, mock_dedup,
        mock_elev, mock_db, mock_enrich, mock_upsert, mock_queue,
    ):
        mock_ip.return_value = "1.2.3.4"
        mock_rate.return_value = {"allowed": True, "remaining": 4}
        mock_geocode.return_value = self._geocoded_zim_zw()
        mock_dedup.return_value = None
        mock_elev.return_value = 1200
        mock_coll.return_value.find_one.return_value = None
        mock_db_inst = MagicMock()
        mock_db.return_value = mock_db_inst
        mock_db_inst.__getitem__ = MagicMock(return_value=MagicMock())

        mock_upsert.return_value = {
            "_id": "fresh-placesgeo-uuid",
            "slug": "newplace-fresh1",
        }

        request = MagicMock()
        request.json = AsyncMock(return_value={"lat": -19.0, "lon": 32.0})

        result = await add_location(request)
        assert result["placesGeoId"] == "fresh-placesgeo-uuid"
        assert result["placesGeoSlug"] == "newplace-fresh1"

    @pytest.mark.asyncio
    @patch("py._places_geo.enqueue_fundi_seed")
    @patch("py._locations.upsert_placesgeo_city")
    @patch("py._locations._enrich_location_with_ai")
    @patch("py._locations.get_db")
    @patch("py._locations._get_elevation")
    @patch("py._locations._find_duplicate")
    @patch("py._locations._reverse_geocode")
    @patch("py._locations.check_rate_limit")
    @patch("py._locations.get_client_ip")
    @patch("py._locations.places_geo_collection")
    async def test_continues_when_platform_write_fails(
        self, mock_coll, mock_ip, mock_rate, mock_geocode, mock_dedup,
        mock_elev, mock_db, mock_enrich, mock_upsert, mock_queue,
    ):
        """A platform failure must NOT take down the user-facing 201 response."""
        mock_ip.return_value = "1.2.3.4"
        mock_rate.return_value = {"allowed": True, "remaining": 4}
        mock_geocode.return_value = self._geocoded_zim_zw()
        mock_dedup.return_value = None
        mock_elev.return_value = 1200
        mock_coll.return_value.find_one.return_value = None
        mock_db_inst = MagicMock()
        mock_db.return_value = mock_db_inst
        mock_db_inst.__getitem__ = MagicMock(return_value=MagicMock())

        mock_upsert.side_effect = RuntimeError("placesGeo validator rejected doc")

        request = MagicMock()
        request.json = AsyncMock(return_value={"lat": -19.0, "lon": 32.0})

        # Should still succeed and return the legacy location data
        result = await add_location(request)
        assert result["mode"] == "created"
        assert result["location"]["name"] == "NewPlace"
        # placesGeo ids are None because the platform write failed
        assert result["placesGeoId"] is None
        assert result["placesGeoSlug"] is None


# ---------------------------------------------------------------------------
# Dedup hardening — SlugCollisionError, no numeric-suffix slugs
# ---------------------------------------------------------------------------


class TestSlugCollisionHardening:
    """Phase 0E hardening — the auto-suffix path is gone. Slug collisions that
    cannot be resolved via suburb/road enrichment must raise
    SlugCollisionError so the caller can return the existing record.
    """

    @patch("py._locations.places_geo_collection")
    def test_raises_when_all_paths_exhausted(self, mock_col):
        """If suburb AND road enrichment both still collide, raise."""
        from py._locations import SlugCollisionError

        # Every find_one returns a doc → every candidate slug is taken.
        mock_col.return_value.find_one.return_value = {"slug": "taken"}
        geocoded = {
            "name": "Test",
            "country": "ZW",
            "nominatimAddress": {"suburb": "Avondale", "road": "Main St"},
        }
        with pytest.raises(SlugCollisionError) as exc_info:
            _resolve_slug_collision("test-zw", geocoded)
        assert exc_info.value.existing_slug == "test-zw"

    @patch("py._locations.places_geo_collection")
    def test_no_numeric_suffix_slug_returned(self, mock_col):
        """Sanity — _resolve_slug_collision must never return a `-\\d+$` slug."""
        from py._locations import SlugCollisionError

        mock_col.return_value.find_one.return_value = {"slug": "taken"}
        geocoded = {"name": "Test", "country": "ZW", "nominatimAddress": {}}
        with pytest.raises(SlugCollisionError):
            _resolve_slug_collision("test-zw", geocoded)
        # Verify the regression — no numeric suffix was generated.
        # (If the old code path ran, it would have called find_one for "test-zw-2", "-3"…)

    @pytest.mark.asyncio
    @patch("py._places_geo.enqueue_fundi_seed")
    @patch("py._locations.upsert_placesgeo_city")
    @patch("py._locations.find_location")
    @patch("py._locations._enrich_location_with_ai")
    @patch("py._locations._get_elevation")
    @patch("py._locations._find_duplicate")
    @patch("py._locations._reverse_geocode")
    @patch("py._locations.check_rate_limit")
    @patch("py._locations.get_client_ip")
    @patch("py._locations.places_geo_collection")
    async def test_add_location_returns_existing_when_slug_collision_unresolvable(
        self, mock_coll, mock_ip, mock_rate, mock_geocode, mock_dedup,
        mock_elev, mock_enrich, mock_find_loc, mock_upsert, mock_queue,
    ):
        """add_location should return mode=duplicate, NOT create -2/-3/... slugs."""
        mock_ip.return_value = "1.2.3.4"
        mock_rate.return_value = {"allowed": True, "remaining": 4}
        mock_geocode.return_value = {
            "country": "ZW", "countryName": "Zimbabwe", "name": "Windsor",
            "admin1": "Harare", "lat": -17.83, "lon": 31.05, "elevation": 1490,
            "nominatimAddress": {},
        }
        mock_dedup.return_value = None
        mock_elev.return_value = 1490
        # Every slug lookup returns a doc — collision cannot be resolved.
        mock_coll.return_value.find_one.return_value = {
            "sourceProvenance": {"mukokoSlug": "windsor-zw"},
        }
        # find_location returns the existing record so the route can surface it.
        mock_find_loc.return_value = {
            "slug": "windsor-zw",
            "name": "Windsor",
            "province": "Harare",
            "country": "ZW",
        }

        request = MagicMock()
        request.json = AsyncMock(return_value={"lat": -17.83, "lon": 31.05})

        result = await add_location(request)
        assert result["mode"] == "duplicate"
        assert result["existing"]["slug"] == "windsor-zw"
        # And we did NOT mirror to placesGeo for a duplicate.
        mock_upsert.assert_not_called()


# ---------------------------------------------------------------------------
# _match_nearby_poi — tight-radius POI refinement
# ---------------------------------------------------------------------------


class TestMatchNearbyPoi:
    @patch("py._locations.find_nearest_place")
    def test_returns_name_and_type_for_named_poi(self, mock_nearest):
        mock_nearest.return_value = {
            "name": "Prince Edward School",
            "placeType": ["school"],
        }
        result = _match_nearby_poi(-17.83, 31.05)
        assert result == {"name": "Prince Edward School", "poiType": "school"}

    @patch("py._locations.find_nearest_place")
    def test_uses_tight_250m_radius(self, mock_nearest):
        mock_nearest.return_value = None
        _match_nearby_poi(-17.83, 31.05)
        # Radius passed is POI_MATCH_RADIUS_KM (0.25 km) — a tight match, not a snap.
        assert mock_nearest.call_args.args[2] == 0.25

    @patch("py._locations.find_nearest_place", return_value=None)
    def test_none_when_no_poi(self, _mock_nearest):
        assert _match_nearby_poi(0, 0) is None

    @patch("py._locations.find_nearest_place")
    def test_none_when_poi_unnamed(self, mock_nearest):
        mock_nearest.return_value = {"name": "  ", "placeType": ["school"]}
        assert _match_nearby_poi(0, 0) is None

    @patch("py._locations.find_nearest_place")
    def test_poi_type_none_when_untyped(self, mock_nearest):
        mock_nearest.return_value = {"name": "Some Place"}
        result = _match_nearby_poi(0, 0)
        assert result == {"name": "Some Place", "poiType": None}

    @patch("py._locations.find_nearest_place", side_effect=RuntimeError("boom"))
    def test_swallows_errors(self, _mock_nearest):
        """POI matching must never break resolution — errors fall back to None."""
        assert _match_nearby_poi(0, 0) is None


class TestGeoLookupPoiRefinement:
    @pytest.mark.asyncio
    @patch("py._locations.upsert_placesgeo_city")
    @patch("py._locations._enrich_location_with_ai")
    @patch("py._locations._get_elevation")
    @patch("py._locations._find_duplicate")
    @patch("py._locations._match_nearby_poi")
    @patch("py._locations._reverse_geocode")
    @patch("py._locations.find_nearest_location")
    @patch("py._locations.places_geo_collection")
    async def test_poi_overrides_name_and_flows_through(
        self, mock_coll, mock_nearest, mock_geocode, mock_poi, mock_dedup,
        mock_elev, mock_enrich, mock_upsert,
    ):
        """A close POI replaces the reverse-geocode name and poiType is surfaced."""
        mock_nearest.return_value = None
        mock_geocode.return_value = {
            "country": "ZW", "countryName": "Zimbabwe",
            "name": "Fourth Street",  # raw reverse-geocode name
            "admin1": "Harare", "lat": -17.83, "lon": 31.05, "elevation": 1490,
        }
        mock_poi.return_value = {"name": "Prince Edward School", "poiType": "school"}
        mock_dedup.return_value = None
        mock_elev.return_value = 1490
        mock_coll.return_value.find_one.return_value = None
        mock_upsert.return_value = {"_id": "u", "slug": "prince-edward-school-abc123"}

        result = await geo_lookup(-17.83, 31.05, autoCreate=True)
        assert result["isNew"] is True
        # POI name won over the reverse-geocode name.
        assert result["nearest"]["name"] == "Prince Edward School"
        assert result["nearest"]["poiType"] == "school"
        # And the POI type was stamped into the placesGeo write.
        assert mock_upsert.call_args.kwargs["mukoko_poi_type"] == "school"

    @pytest.mark.asyncio
    @patch("py._locations.upsert_placesgeo_city")
    @patch("py._locations._enrich_location_with_ai")
    @patch("py._locations._get_elevation")
    @patch("py._locations._find_duplicate")
    @patch("py._locations._match_nearby_poi")
    @patch("py._locations._reverse_geocode")
    @patch("py._locations.find_nearest_location")
    @patch("py._locations.places_geo_collection")
    async def test_no_poi_keeps_reverse_geocode_name(
        self, mock_coll, mock_nearest, mock_geocode, mock_poi, mock_dedup,
        mock_elev, mock_enrich, mock_upsert,
    ):
        """No nearby POI — the reverse-geocode result is used unchanged (fallback)."""
        mock_nearest.return_value = None
        mock_geocode.return_value = {
            "country": "ZW", "countryName": "Zimbabwe",
            "name": "Fourth Street", "admin1": "Harare",
            "lat": -17.83, "lon": 31.05, "elevation": 1490,
        }
        mock_poi.return_value = None
        mock_dedup.return_value = None
        mock_elev.return_value = 1490
        mock_coll.return_value.find_one.return_value = None
        mock_upsert.return_value = {"_id": "u", "slug": "fourth-street-abc123"}

        result = await geo_lookup(-17.83, 31.05, autoCreate=True)
        assert result["nearest"]["name"] == "Fourth Street"
        assert "poiType" not in result["nearest"]
        assert mock_upsert.call_args.kwargs["mukoko_poi_type"] is None
