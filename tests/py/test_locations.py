"""Tests for _locations.py — slug generation, geocoding, tag inference, endpoints."""

from __future__ import annotations

from unittest.mock import patch, MagicMock, AsyncMock

import pytest
from fastapi import HTTPException

from py._locations import (
    _generate_slug,
    _generate_province_slug,
    _infer_tags,
    _dedup_radius,
    _is_in_supported_region,
    _hardcoded_region_check,
    _reverse_geocode,
    _forward_geocode,
    _get_elevation,
    list_locations,
    search_locations,
    geo_lookup,
    add_location,
    DEDUP_RADIUS_ZW_KM,
    DEDUP_RADIUS_DEFAULT_KM,
    MAX_LOCATIONS_LIMIT,
    DEFAULT_LOCATIONS_LIMIT,
    SLUG_RE,
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

    def test_zw_country_no_suffix(self):
        slug = _generate_slug("Harare", "ZW")
        assert slug == "harare"
        assert not slug.endswith("-zw")

    def test_caps_at_80_chars(self):
        long_name = "A" * 100
        slug = _generate_slug(long_name, "ZW")
        assert len(slug) <= 80

    def test_strips_leading_trailing_hyphens(self):
        slug = _generate_slug("  Harare  ")
        assert not slug.startswith("-")
        assert not slug.endswith("-")

    def test_special_characters_replaced(self):
        slug = _generate_slug("Mt. Darwin's Place!", "ZW")
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
# _dedup_radius
# ---------------------------------------------------------------------------


class TestDedupRadius:
    def test_zimbabwe_5km(self):
        assert _dedup_radius("ZW") == DEDUP_RADIUS_ZW_KM
        assert _dedup_radius("ZW") == 5

    def test_zimbabwe_case_insensitive(self):
        assert _dedup_radius("zw") == 5

    def test_other_country_10km(self):
        assert _dedup_radius("KE") == DEDUP_RADIUS_DEFAULT_KM
        assert _dedup_radius("KE") == 10

    def test_none_country_10km(self):
        assert _dedup_radius(None) == 10

    def test_empty_string_10km(self):
        assert _dedup_radius("") == 10


# ---------------------------------------------------------------------------
# _is_in_supported_region
# ---------------------------------------------------------------------------


class TestIsInSupportedRegion:
    @patch("py._locations.get_db")
    def test_db_lookup_finds_region(self, mock_db):
        mock_db.return_value.__getitem__ = MagicMock(
            return_value=MagicMock(find_one=MagicMock(return_value={"_id": "1"}))
        )
        assert _is_in_supported_region(-17.83, 31.05) is True

    @patch("py._locations.get_db")
    def test_db_lookup_no_region_falls_back_to_hardcoded(self, mock_db):
        """When DB returns no region match, fall back to hardcoded bounds.
        Zimbabwe (-17.83, 31.05) is within the Africa hardcoded fallback range,
        so it should still return True (supported), not False."""
        mock_db.return_value.__getitem__ = MagicMock(
            return_value=MagicMock(find_one=MagicMock(return_value=None))
        )
        # Zimbabwe is in Africa fallback bounds: -23≤lat≤38, -18≤lon≤52
        assert _is_in_supported_region(-17.83, 31.05) is True

    @patch("py._locations.get_db")
    def test_db_lookup_no_region_outside_fallback_rejected(self, mock_db):
        """When DB returns no region match and coords are outside all fallback bounds,
        return False."""
        mock_db.return_value.__getitem__ = MagicMock(
            return_value=MagicMock(find_one=MagicMock(return_value=None))
        )
        # New York — outside Africa and ASEAN fallback bounds
        assert _is_in_supported_region(40.71, -74.01) is False

    @patch("py._locations.get_db")
    def test_fallback_africa_accepted(self, mock_db):
        """When DB fails, Africa coordinates should be accepted."""
        mock_db.side_effect = Exception("DB down")
        # Central Africa coordinates
        assert _is_in_supported_region(0, 25) is True

    @patch("py._locations.get_db")
    def test_fallback_asean_accepted(self, mock_db):
        """When DB fails, ASEAN coordinates should be accepted."""
        mock_db.side_effect = Exception("DB down")
        # Bangkok
        assert _is_in_supported_region(13.75, 100.5) is True

    @patch("py._locations.get_db")
    def test_fallback_outside_regions_rejected(self, mock_db):
        """When DB fails, coordinates outside Africa/ASEAN should be rejected."""
        mock_db.side_effect = Exception("DB down")
        # New York
        assert _is_in_supported_region(40.71, -74.01) is False


# ---------------------------------------------------------------------------
# _hardcoded_region_check — acceptance tests for all 8 regions
# ---------------------------------------------------------------------------


class TestHardcodedRegionCheck:
    """Direct tests for _hardcoded_region_check to verify all region bounds are correct."""

    def test_africa_zimbabwe(self):
        """Zimbabwe — should be in Africa region."""
        assert _hardcoded_region_check(-17.83, 31.05) is True

    def test_africa_north_africa_cairo(self):
        """Cairo (Egypt) — North Africa should now be included."""
        assert _hardcoded_region_check(30.06, 31.24) is True

    def test_asean_singapore(self):
        """Singapore — ASEAN, this was the original reported bug."""
        assert _hardcoded_region_check(1.35, 103.82) is True

    def test_asean_bangkok(self):
        """Bangkok (Thailand) — core ASEAN."""
        assert _hardcoded_region_check(13.75, 100.5) is True

    def test_south_asia_mumbai(self):
        """Mumbai (India) — South Asia region."""
        assert _hardcoded_region_check(19.08, 72.88) is True

    def test_south_asia_dhaka(self):
        """Dhaka (Bangladesh) — South Asia region."""
        assert _hardcoded_region_check(23.72, 90.41) is True

    def test_middle_east_riyadh(self):
        """Riyadh (Saudi Arabia) — Middle East region."""
        assert _hardcoded_region_check(24.69, 46.72) is True

    def test_middle_east_istanbul(self):
        """Istanbul (Turkey) — northern edge of Middle East region."""
        assert _hardcoded_region_check(41.01, 28.98) is True

    def test_central_asia_almaty(self):
        """Almaty (Kazakhstan) — Central Asia region."""
        assert _hardcoded_region_check(43.26, 76.95) is True

    def test_south_america_sao_paulo(self):
        """São Paulo (Brazil) — South America region."""
        assert _hardcoded_region_check(-23.55, -46.63) is True

    def test_south_america_buenos_aires(self):
        """Buenos Aires (Argentina) — South America region."""
        assert _hardcoded_region_check(-34.6, -58.38) is True

    def test_central_america_mexico_city(self):
        """Mexico City — Central America + Mexico region."""
        assert _hardcoded_region_check(19.43, -99.13) is True

    def test_central_america_guatemala_city(self):
        """Guatemala City — Central America region."""
        assert _hardcoded_region_check(14.64, -90.51) is True

    def test_pacific_islands_fiji(self):
        """Fiji (lon ~178°E) — Pacific Islands, east of antimeridian.
        This coordinate should be accepted by _hardcoded_region_check but NOT
        by the MongoDB bounding-box query (which cannot handle antimeridian crossing)."""
        assert _hardcoded_region_check(-18.14, 178.44) is True

    def test_pacific_islands_tonga(self):
        """Tonga (lon ~-175.2°W) — Pacific Islands, just west of antimeridian.
        -175.2 <= -175 (the padded east boundary), so this is within range."""
        assert _hardcoded_region_check(-21.18, -175.20) is True

    def test_pacific_islands_fiji_db_query_limitation(self):
        """Pacific Islands (Fiji) is NOT matched by the MongoDB bounding-box query
        due to the antimeridian crossing (east=-176 fails $gte check for lon=178).
        The hardcoded fallback is the authoritative source for this region."""
        # Simulate DB returning None (which is what happens for antimeridian points)
        # and confirm the overall function still returns True via _hardcoded_region_check.
        with patch("py._locations.get_db") as mock_db:
            mock_db.return_value.__getitem__ = MagicMock(
                return_value=MagicMock(find_one=MagicMock(return_value=None))
            )
            assert _is_in_supported_region(-18.14, 178.44) is True

    def test_rejected_new_york(self):
        """New York (USA) — should be rejected."""
        assert _hardcoded_region_check(40.71, -74.01) is False

    def test_rejected_london(self):
        """London (UK) — should be rejected."""
        assert _hardcoded_region_check(51.51, -0.13) is False

    def test_rejected_sydney(self):
        """Sydney (Australia) — should be rejected (not a developing country region)."""
        assert _hardcoded_region_check(-33.87, 151.21) is False

    def test_rejected_tokyo(self):
        """Tokyo (Japan) — should be rejected (developed, not in ASEAN or developing Asia)."""
        assert _hardcoded_region_check(35.69, 139.69) is False


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
    def test_falls_back_to_town(self, mock_http):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "lat": "-18.0",
            "lon": "31.5",
            "name": "Somewhere",
            "address": {
                "town": "Marondera",
                "state": "Mashonaland East",
                "country": "Zimbabwe",
                "country_code": "zw",
            },
        }
        mock_http.return_value.get.return_value = mock_resp

        result = _reverse_geocode(-18.0, 31.5)
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
    @pytest.mark.asyncio
    @patch("py._locations.locations_collection")
    async def test_single_location_by_slug(self, mock_coll):
        mock_coll.return_value.find_one.return_value = {"slug": "harare", "name": "Harare"}
        result = await list_locations(slug="harare")
        assert result["location"]["slug"] == "harare"

    @pytest.mark.asyncio
    @patch("py._locations.locations_collection")
    async def test_slug_not_found_raises_404(self, mock_coll):
        mock_coll.return_value.find_one.return_value = None
        with pytest.raises(HTTPException) as exc_info:
            await list_locations(slug="nonexistent")
        assert exc_info.value.status_code == 404

    @pytest.mark.asyncio
    @patch("py._locations.locations_collection")
    async def test_tag_filter(self, mock_coll):
        mock_find = MagicMock()
        mock_find.sort.return_value.skip.return_value.limit.return_value = [
            {"slug": "chinhoyi", "name": "Chinhoyi"}
        ]
        mock_coll.return_value.find.return_value = mock_find
        mock_coll.return_value.count_documents.return_value = 1

        result = await list_locations(tag="farming")
        assert result["total"] == 1

    @pytest.mark.asyncio
    @patch("py._locations.locations_collection")
    async def test_country_filter_uppercased(self, mock_coll):
        mock_find = MagicMock()
        mock_find.sort.return_value.skip.return_value.limit.return_value = []
        mock_coll.return_value.find.return_value = mock_find
        mock_coll.return_value.count_documents.return_value = 0

        await list_locations(country="zw")
        # Verify the query used uppercase country
        call_args = mock_coll.return_value.count_documents.call_args[0][0]
        assert call_args["country"] == "ZW"

    @pytest.mark.asyncio
    @patch("py._locations.locations_collection")
    async def test_stats_mode(self, mock_coll):
        mock_coll.return_value.count_documents.return_value = 100
        mock_coll.return_value.distinct.side_effect = [
            ["Province1", "Province2"],  # provinces
            ["ZW", "KE"],  # countries
        ]

        result = await list_locations(mode="stats")
        assert result["totalLocations"] == 100
        assert result["totalProvinces"] == 2
        assert result["totalCountries"] == 2

    @pytest.mark.asyncio
    @patch("py._locations.locations_collection")
    async def test_tags_mode(self, mock_coll):
        mock_coll.return_value.aggregate.return_value = [
            {"_id": "city", "count": 50},
            {"_id": "farming", "count": 30},
        ]

        result = await list_locations(mode="tags")
        assert result["tags"]["city"] == 50
        assert result["tags"]["farming"] == 30

    @pytest.mark.asyncio
    @patch("py._locations.locations_collection")
    async def test_limit_clamped_to_max(self, mock_coll):
        mock_find = MagicMock()
        mock_find.sort.return_value.skip.return_value.limit.return_value = []
        mock_coll.return_value.find.return_value = mock_find
        mock_coll.return_value.count_documents.return_value = 0

        result = await list_locations(limit=500)
        assert result["limit"] == MAX_LOCATIONS_LIMIT

    @pytest.mark.asyncio
    @patch("py._locations.locations_collection")
    async def test_limit_clamped_to_min_1(self, mock_coll):
        mock_find = MagicMock()
        mock_find.sort.return_value.skip.return_value.limit.return_value = []
        mock_coll.return_value.find.return_value = mock_find
        mock_coll.return_value.count_documents.return_value = 0

        result = await list_locations(limit=-5)
        assert result["limit"] == 1

    @pytest.mark.asyncio
    @patch("py._locations.locations_collection")
    async def test_skip_clamped_to_zero(self, mock_coll):
        mock_find = MagicMock()
        mock_find.sort.return_value.skip.return_value.limit.return_value = []
        mock_coll.return_value.find.return_value = mock_find
        mock_coll.return_value.count_documents.return_value = 0

        result = await list_locations(skip=-10)
        assert result["skip"] == 0


# ---------------------------------------------------------------------------
# search_locations endpoint
# ---------------------------------------------------------------------------


class TestSearchLocations:
    @pytest.mark.asyncio
    @patch("py._locations.locations_collection")
    async def test_text_search(self, mock_coll):
        mock_cursor = MagicMock()
        mock_cursor.sort.return_value.skip.return_value.limit.return_value = [
            {"slug": "harare", "name": "Harare", "score": 2.5}
        ]
        mock_coll.return_value.find.return_value = mock_cursor
        mock_coll.return_value.count_documents.return_value = 1

        result = await search_locations(q="harare")
        assert result["source"] == "mongodb"
        assert len(result["locations"]) == 1
        # Score should be stripped
        assert "score" not in result["locations"][0]

    @pytest.mark.asyncio
    @patch("py._locations.locations_collection")
    async def test_geospatial_search(self, mock_coll):
        mock_find = MagicMock()
        mock_find.limit.return_value = [
            {"slug": "harare", "name": "Harare"}
        ]
        mock_coll.return_value.find.return_value = mock_find

        result = await search_locations(lat="-17.83", lon="31.05")
        assert result["source"] == "mongodb"
        assert len(result["locations"]) == 1

    @pytest.mark.asyncio
    @patch("py._locations.locations_collection")
    async def test_tag_search(self, mock_coll):
        mock_cursor = MagicMock()
        mock_cursor.sort.return_value.skip.return_value.limit.return_value = [
            {"slug": "chinhoyi", "name": "Chinhoyi"}
        ]
        mock_coll.return_value.find.return_value = mock_cursor
        mock_coll.return_value.count_documents.return_value = 1

        result = await search_locations(tag="farming")
        assert result["total"] == 1

    @pytest.mark.asyncio
    async def test_missing_query_raises_400(self):
        with patch("py._locations.locations_collection"):
            with pytest.raises(HTTPException) as exc_info:
                await search_locations(q="", tag=None)
            assert exc_info.value.status_code == 400

    @pytest.mark.asyncio
    @patch("py._locations.locations_collection")
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
    @pytest.mark.asyncio
    @patch("py._locations._reverse_geocode")
    @patch("py._locations.locations_collection")
    async def test_nearest_location_returned(self, mock_coll, mock_geocode):
        mock_geocode.return_value = {"country": "ZW"}
        mock_find = MagicMock()
        mock_find.limit.return_value = [
            {"slug": "harare", "name": "Harare", "country": "ZW"}
        ]
        mock_coll.return_value.find.return_value = mock_find

        result = await geo_lookup(-17.83, 31.05)
        assert result["nearest"]["slug"] == "harare"
        assert result["isNew"] is False

    @pytest.mark.asyncio
    @patch("py._locations.locations_collection")
    async def test_returns_nearest_by_distance(self, mock_coll):
        """Fast path returns the first $near result (nearest by distance)."""
        mock_find = MagicMock()
        mock_find.limit.return_value = [
            {"slug": "maputo", "name": "Maputo", "country": "MZ"},
            {"slug": "harare", "name": "Harare", "country": "ZW"},
        ]
        mock_coll.return_value.find.return_value = mock_find

        result = await geo_lookup(-17.83, 31.05)
        # Returns first result (nearest by $near distance), no geocoding needed
        assert result["nearest"]["slug"] == "maputo"

    @pytest.mark.asyncio
    @patch("py._locations._is_in_supported_region")
    @patch("py._locations._reverse_geocode")
    @patch("py._locations.locations_collection")
    async def test_unsupported_region_rejected(self, mock_coll, mock_geocode, mock_region):
        mock_geocode.return_value = {"country": "US"}
        mock_find = MagicMock()
        mock_find.limit.return_value = []
        mock_coll.return_value.find.return_value = mock_find
        mock_coll.return_value.find_one.return_value = None
        mock_region.return_value = False

        with pytest.raises(HTTPException) as exc_info:
            await geo_lookup(40.71, -74.01)
        assert exc_info.value.status_code == 404
        assert "outside supported regions" in exc_info.value.detail

    @pytest.mark.asyncio
    @patch("py._locations._find_duplicate")
    @patch("py._locations._is_in_supported_region")
    @patch("py._locations._reverse_geocode")
    @patch("py._locations.locations_collection")
    async def test_duplicate_detection(self, mock_coll, mock_geocode, mock_region, mock_dedup):
        """Auto-create should return existing location when duplicate found."""
        mock_geocode.return_value = {"country": "ZW", "name": "Harare", "admin1": "Harare"}
        mock_find = MagicMock()
        mock_find.limit.return_value = []
        mock_coll.return_value.find.return_value = mock_find
        mock_coll.return_value.find_one.return_value = None
        mock_region.return_value = True
        mock_dedup.return_value = {"slug": "harare", "name": "Harare"}

        result = await geo_lookup(-17.83, 31.05, autoCreate=True)
        assert result["isNew"] is False
        assert result["nearest"]["slug"] == "harare"

    @pytest.mark.asyncio
    @patch("py._locations.get_db")
    @patch("py._locations._get_elevation")
    @patch("py._locations._find_duplicate")
    @patch("py._locations._is_in_supported_region")
    @patch("py._locations._reverse_geocode")
    @patch("py._locations.locations_collection")
    async def test_auto_create_success(self, mock_coll, mock_geocode, mock_region,
                                        mock_dedup, mock_elev, mock_db):
        """Auto-create should insert a new location when no duplicate exists."""
        mock_geocode.return_value = {
            "country": "ZW",
            "countryName": "Zimbabwe",
            "name": "NewPlace",
            "admin1": "Manicaland",
            "lat": -19.0,
            "lon": 32.0,
            "elevation": 1000,
        }
        mock_find = MagicMock()
        mock_find.limit.return_value = []
        mock_coll.return_value.find.return_value = mock_find
        mock_coll.return_value.find_one.side_effect = [None, None]  # No uncapped, no slug collision
        mock_region.return_value = True
        mock_dedup.return_value = None
        mock_elev.return_value = 1200
        mock_db_inst = MagicMock()
        mock_db.return_value = mock_db_inst
        mock_db_inst.__getitem__ = MagicMock(return_value=MagicMock())

        result = await geo_lookup(-19.0, 32.0, autoCreate=True)
        assert result["isNew"] is True
        assert result["nearest"]["name"] == "NewPlace"
        mock_coll.return_value.insert_one.assert_called_once()


# ---------------------------------------------------------------------------
# add_location endpoint
# ---------------------------------------------------------------------------


class TestAddLocation:
    @pytest.mark.asyncio
    @patch("py._locations._is_in_supported_region")
    @patch("py._locations._forward_geocode")
    async def test_search_mode_returns_candidates(self, mock_geocode, mock_region):
        mock_geocode.return_value = [
            {"name": "Harare", "country": "ZW", "countryName": "Zimbabwe",
             "admin1": "Harare", "lat": -17.83, "lon": 31.05, "elevation": 1490}
        ]
        mock_region.return_value = True

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
    @patch("py._locations._is_in_supported_region")
    @patch("py._locations._forward_geocode")
    async def test_search_mode_filters_unsupported_regions(self, mock_geocode, mock_region):
        """Candidates outside supported regions should be filtered."""
        mock_geocode.return_value = [
            {"name": "Harare", "country": "ZW", "countryName": "Zimbabwe",
             "admin1": "Harare", "lat": -17.83, "lon": 31.05},
            {"name": "London", "country": "GB", "countryName": "UK",
             "admin1": "England", "lat": 51.5, "lon": -0.12},
        ]
        mock_region.side_effect = lambda lat, lon: lat < 0  # Only southern hemisphere supported

        request = MagicMock()
        request.json = AsyncMock(return_value={"query": "harare"})

        result = await add_location(request)
        assert len(result["results"]) == 1
        assert result["results"][0]["name"] == "Harare"

    @pytest.mark.asyncio
    @patch("py._locations._is_in_supported_region")
    async def test_coordinates_mode_invalid_coords(self, mock_region):
        request = MagicMock()
        request.json = AsyncMock(return_value={"lat": 91, "lon": 0})

        with pytest.raises(HTTPException) as exc_info:
            await add_location(request)
        assert exc_info.value.status_code == 400

    @pytest.mark.asyncio
    @patch("py._locations._is_in_supported_region")
    async def test_coordinates_mode_unsupported_region(self, mock_region):
        mock_region.return_value = False
        request = MagicMock()
        request.json = AsyncMock(return_value={"lat": 40.0, "lon": -74.0})

        with pytest.raises(HTTPException) as exc_info:
            await add_location(request)
        assert exc_info.value.status_code == 400
        assert "outside supported" in exc_info.value.detail

    @pytest.mark.asyncio
    @patch("py._locations.check_rate_limit")
    @patch("py._locations.get_client_ip")
    @patch("py._locations._is_in_supported_region")
    async def test_coordinates_mode_rate_limited(self, mock_region, mock_ip, mock_rate):
        mock_region.return_value = True
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
    @patch("py._locations._is_in_supported_region")
    async def test_coordinates_mode_geocode_fails(self, mock_region, mock_ip, mock_rate, mock_geocode):
        mock_region.return_value = True
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
    @patch("py._locations._is_in_supported_region")
    async def test_coordinates_mode_duplicate_found(self, mock_region, mock_ip, mock_rate,
                                                     mock_geocode, mock_dedup):
        mock_region.return_value = True
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
    @patch("py._locations.get_db")
    @patch("py._locations._get_elevation")
    @patch("py._locations._find_duplicate")
    @patch("py._locations._reverse_geocode")
    @patch("py._locations.check_rate_limit")
    @patch("py._locations.get_client_ip")
    @patch("py._locations._is_in_supported_region")
    @patch("py._locations.locations_collection")
    async def test_coordinates_mode_creates_location(self, mock_coll, mock_region, mock_ip,
                                                      mock_rate, mock_geocode, mock_dedup,
                                                      mock_elev, mock_db):
        mock_region.return_value = True
        mock_ip.return_value = "1.2.3.4"
        mock_rate.return_value = {"allowed": True, "remaining": 4}
        mock_geocode.return_value = {
            "country": "ZW", "countryName": "Zimbabwe", "name": "NewPlace",
            "admin1": "Manicaland", "lat": -19.0, "lon": 32.0, "elevation": 1000,
        }
        mock_dedup.return_value = None
        mock_elev.return_value = 1200
        mock_coll.return_value.find_one.return_value = None  # No slug collision
        mock_db_inst = MagicMock()
        mock_db.return_value = mock_db_inst
        mock_db_inst.__getitem__ = MagicMock(return_value=MagicMock())

        request = MagicMock()
        request.json = AsyncMock(return_value={"lat": -19.0, "lon": 32.0})

        result = await add_location(request)
        assert result["mode"] == "created"
        assert result["location"]["name"] == "NewPlace"
        mock_coll.return_value.insert_one.assert_called_once()

    @pytest.mark.asyncio
    @patch("py._locations.get_db")
    @patch("py._locations._get_elevation")
    @patch("py._locations._find_duplicate")
    @patch("py._locations._reverse_geocode")
    @patch("py._locations.check_rate_limit")
    @patch("py._locations.get_client_ip")
    @patch("py._locations._is_in_supported_region")
    @patch("py._locations.locations_collection")
    async def test_slug_collision_handling(self, mock_coll, mock_region, mock_ip,
                                           mock_rate, mock_geocode, mock_dedup,
                                           mock_elev, mock_db):
        """When slug already exists, should append a numeric suffix."""
        mock_region.return_value = True
        mock_ip.return_value = "1.2.3.4"
        mock_rate.return_value = {"allowed": True, "remaining": 4}
        mock_geocode.return_value = {
            "country": "ZW", "countryName": "Zimbabwe", "name": "Harare",
            "admin1": "Harare", "lat": -17.9, "lon": 31.1, "elevation": 1400,
        }
        mock_dedup.return_value = None
        mock_elev.return_value = 1400
        # First find_one: slug exists. Second find_one (slug-2): does not exist
        mock_coll.return_value.find_one.side_effect = [{"slug": "harare"}, None]
        mock_db_inst = MagicMock()
        mock_db.return_value = mock_db_inst
        mock_db_inst.__getitem__ = MagicMock(return_value=MagicMock())

        request = MagicMock()
        request.json = AsyncMock(return_value={"lat": -17.9, "lon": 31.1})

        result = await add_location(request)
        assert result["mode"] == "created"
        assert result["location"]["slug"] == "harare-2"


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
