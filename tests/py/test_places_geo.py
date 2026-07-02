"""Tests for api/py/_places_geo.py — placesGeo helpers and Fundi queue."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

import py._places_geo as pg


@pytest.fixture(autouse=True)
def _reset_country_cache():
    """Reset module-level country cache between tests so each call re-loads."""
    pg.COUNTRY_ID_BY_ISO.clear()
    pg._COUNTRY_CACHE_LOADED = False
    yield
    pg.COUNTRY_ID_BY_ISO.clear()
    pg._COUNTRY_CACHE_LOADED = False


# ---------------------------------------------------------------------------
# get_country_id
# ---------------------------------------------------------------------------


class TestGetCountryId:
    @patch("py._places_geo.places_geo_collection")
    def test_caches_after_first_call(self, mock_coll):
        """Country cache should be populated once, then reused."""
        mock_coll.return_value.find.return_value = iter([
            {"_id": "zw-uuid", "isoCode": "ZW"},
            {"_id": "ke-uuid", "isoCode": "KE"},
        ])

        first = pg.get_country_id("ZW")
        assert first == "zw-uuid"

        # Second call: should hit the cache, not call find again
        second = pg.get_country_id("KE")
        assert second == "ke-uuid"
        assert mock_coll.return_value.find.call_count == 1

    @patch("py._places_geo.places_geo_collection")
    def test_unknown_returns_none(self, mock_coll):
        mock_coll.return_value.find.return_value = iter([
            {"_id": "zw-uuid", "isoCode": "ZW"},
        ])
        assert pg.get_country_id("XX") is None

    @patch("py._places_geo.places_geo_collection")
    def test_lowercase_iso_normalised(self, mock_coll):
        mock_coll.return_value.find.return_value = iter([
            {"_id": "ke-uuid", "isoCode": "KE"},
        ])
        assert pg.get_country_id("ke") == "ke-uuid"

    @patch("py._places_geo.places_geo_collection")
    def test_empty_iso_returns_none(self, mock_coll):
        assert pg.get_country_id("") is None
        mock_coll.return_value.find.assert_not_called()

    @patch("py._places_geo.places_geo_collection")
    def test_db_error_is_swallowed_and_caches_empty(self, mock_coll):
        """DB error during cache load should be swallowed; subsequent calls return None."""
        mock_coll.return_value.find.side_effect = RuntimeError("boom")
        assert pg.get_country_id("ZW") is None
        # After failed load, we marked cache as loaded so we don't hammer the DB.
        assert pg._COUNTRY_CACHE_LOADED is True


# ---------------------------------------------------------------------------
# find_nearby_placesgeo
# ---------------------------------------------------------------------------


class TestFindNearbyPlacesGeo:
    @patch("py._places_geo.places_geo_collection")
    def test_returns_existing_match(self, mock_coll):
        """When $nearSphere finds a doc, return it."""
        existing = {"_id": "existing-uuid", "name": "Harare", "slug": "harare-abc123"}
        mock_coll.return_value.find.return_value.limit.return_value = iter([existing])

        result = pg.find_nearby_placesgeo(-17.83, 31.05, max_distance_km=2)
        assert result == existing

        # Verify the query used $nearSphere with [lon, lat]
        called_query = mock_coll.return_value.find.call_args[0][0]
        assert "geo" in called_query
        near_clause = called_query["geo"]["$nearSphere"]
        assert near_clause["$geometry"]["coordinates"] == [31.05, -17.83]
        assert near_clause["$maxDistance"] == 2000  # 2km

    @patch("py._places_geo.places_geo_collection")
    def test_returns_none_when_no_match(self, mock_coll):
        mock_coll.return_value.find.return_value.limit.return_value = iter([])
        assert pg.find_nearby_placesgeo(-17.83, 31.05) is None

    @patch("py._places_geo.places_geo_collection")
    def test_name_filter_uses_normalised_match(self, mock_coll):
        """Candidate names are normalised in Python; no $regex needed."""
        candidate = {"_id": "x", "name": "Windsor"}
        mock_coll.return_value.find.return_value.limit.return_value = iter([candidate])
        result = pg.find_nearby_placesgeo(0, 0, name="Windsor Avenue")
        assert result == candidate

    @patch("py._places_geo.places_geo_collection")
    def test_bbox_fallback_on_nearsphere_failure(self, mock_coll):
        """If $nearSphere raises, fall back to bbox query."""
        nearsphere_cursor = MagicMock()
        nearsphere_cursor.limit.side_effect = RuntimeError("no 2dsphere index")
        bbox_cursor = MagicMock()
        bbox_cursor.limit.return_value = iter([{"_id": "bbox-match", "name": "Harare"}])
        mock_coll.return_value.find.side_effect = [nearsphere_cursor, bbox_cursor]
        result = pg.find_nearby_placesgeo(-17.83, 31.05, max_distance_km=5)
        assert result == {"_id": "bbox-match", "name": "Harare"}

    @patch("py._places_geo.places_geo_collection")
    def test_parent_place_id_scopes_query(self, mock_coll):
        """parent_place_id is added to the geo query so other countries are excluded."""
        mock_coll.return_value.find.return_value.limit.return_value = iter([])
        pg.find_nearby_placesgeo(0, 0, parent_place_id="zw-uuid")
        called_query = mock_coll.return_value.find.call_args[0][0]
        assert called_query.get("parentPlaceId") == "zw-uuid"


# ---------------------------------------------------------------------------
# upsert_placesgeo_city
# ---------------------------------------------------------------------------


class TestUpsertPlacesGeoCity:
    @patch("py._places_geo.find_nearby_placesgeo", return_value=None)
    @patch("py._places_geo.get_country_id", return_value="zw-parent")
    @patch("py._places_geo.places_geo_collection")
    def test_builds_correct_doc_shape(self, mock_coll, _mock_parent, _mock_dedup):
        result = pg.upsert_placesgeo_city(
            name="Bindura",
            lat=-17.3,
            lon=31.33,
            country_iso="ZW",
            province="Mashonaland Central",
            elevation=1100,
        )

        # Required fields
        assert isinstance(result["_id"], str) and len(result["_id"]) > 0
        assert result["_schemaVersion"] == "v3.2"
        assert result["name"] == "Bindura"
        assert result["slug"].startswith("bindura-")
        assert len(result["slug"].split("-")[-1]) == 6  # 6-char hex suffix
        assert result["geoType"] == "town"

        # geo is GeoJSON Point with [lon, lat]
        assert result["geo"]["type"] == "Point"
        assert result["geo"]["coordinates"] == [31.33, -17.3]

        # Timestamps
        assert isinstance(result["createdAt"], datetime)
        assert result["createdAt"].tzinfo == timezone.utc
        assert isinstance(result["updatedAt"], datetime)

        # Source provenance
        prov = result["sourceProvenance"]
        assert prov["dataOrigin"] == "mukoko_user"
        assert prov["dataConfidence"] == 0.6
        assert prov["mukokoProvince"] == "Mashonaland Central"
        assert prov["mukokoElevation"] == 1100

        # Parent + iso
        assert result["parentPlaceId"] == "zw-parent"
        assert result["isoCode"] == "ZW"

        # Insert was called exactly once with the same doc
        mock_coll.return_value.insert_one.assert_called_once()

    @patch("py._places_geo.find_nearby_placesgeo", return_value=None)
    @patch("py._places_geo.get_country_id", return_value=None)
    @patch("py._places_geo.places_geo_collection")
    def test_omits_parent_when_country_not_in_cache(self, mock_coll, _mock_parent, _mock_dedup):
        result = pg.upsert_placesgeo_city(
            name="NewTown", lat=1.0, lon=2.0, country_iso="ZZ",
        )
        assert "parentPlaceId" not in result

    @patch("py._places_geo.find_nearby_placesgeo", return_value=None)
    @patch("py._places_geo.get_country_id", return_value="zw-parent")
    @patch("py._places_geo.places_geo_collection")
    def test_uses_v3_2_schema_version(self, mock_coll, _mock_parent, _mock_dedup):
        result = pg.upsert_placesgeo_city(
            name="Harare", lat=-17.83, lon=31.05, country_iso="ZW",
        )
        assert result["_schemaVersion"] == "v3.2"

    @patch("py._places_geo.find_nearby_placesgeo", return_value=None)
    @patch("py._places_geo.get_country_id", return_value="zw-parent")
    @patch("py._places_geo.places_geo_collection")
    def test_does_not_include_bundu(self, mock_coll, _mock_parent, _mock_dedup):
        """placesGeo validator does NOT include `bundu` — make sure we don't add it."""
        result = pg.upsert_placesgeo_city(
            name="Harare", lat=-17.83, lon=31.05, country_iso="ZW",
        )
        assert "bundu" not in result

    @patch("py._places_geo.find_nearby_placesgeo", return_value=None)
    @patch("py._places_geo.get_country_id", return_value=None)
    @patch("py._places_geo.places_geo_collection")
    def test_optional_provenance_fields_skipped_when_missing(self, mock_coll, _mock_parent, _mock_dedup):
        result = pg.upsert_placesgeo_city(
            name="X", lat=0, lon=0, country_iso="",
        )
        prov = result["sourceProvenance"]
        assert "mukokoProvince" not in prov
        assert "mukokoElevation" not in prov

    @patch("py._places_geo.find_nearby_placesgeo")
    @patch("py._places_geo.get_country_id", return_value="zw-parent")
    @patch("py._places_geo.places_geo_collection")
    def test_returns_existing_on_dedup_match(self, mock_coll, _mock_parent, mock_dedup):
        """When dedup finds a match, return it with wasExisting=True and DO NOT insert."""
        mock_dedup.return_value = {
            "_id": "existing-uuid",
            "slug": "bindura-existing",
            "name": "Bindura",
        }
        result = pg.upsert_placesgeo_city(
            name="Bindura",
            lat=-17.3,
            lon=31.33,
            country_iso="ZW",
        )
        assert result["_id"] == "existing-uuid"
        assert result["slug"] == "bindura-existing"
        assert result["wasExisting"] is True
        mock_coll.return_value.insert_one.assert_not_called()

    @patch("py._places_geo.find_nearby_placesgeo", return_value=None)
    @patch("py._places_geo.get_country_id", return_value="zw-parent")
    @patch("py._places_geo.places_geo_collection")
    def test_dedup_uses_5km_radius(self, mock_coll, _mock_parent, mock_dedup):
        pg.upsert_placesgeo_city(name="X", lat=0, lon=0, country_iso="ZW")
        kwargs = mock_dedup.call_args.kwargs
        assert kwargs["max_distance_km"] == 5

    @patch("py._places_geo.find_nearby_placesgeo", return_value=None)
    @patch("py._places_geo.get_country_id", return_value="zw-parent")
    @patch("py._places_geo.places_geo_collection")
    def test_dedup_includes_parent_place_id(self, mock_coll, _mock_parent, mock_dedup):
        """Two 'Springfield' in different countries must NOT collide — parentPlaceId scopes the search."""
        pg.upsert_placesgeo_city(name="Springfield", lat=0, lon=0, country_iso="ZW")
        kwargs = mock_dedup.call_args.kwargs
        assert kwargs["parent_place_id"] == "zw-parent"


# ---------------------------------------------------------------------------
# normalize_name — handles street suffixes, house numbers, diacritics
# ---------------------------------------------------------------------------


class TestNormalizeName:
    def test_strips_road_suffix(self):
        assert pg.normalize_name("Windsor Road") == "windsor"

    def test_strips_rd_short_suffix(self):
        assert pg.normalize_name("Windsor Rd") == "windsor"

    def test_strips_avenue_suffix(self):
        assert pg.normalize_name("Windsor Avenue") == "windsor"

    def test_strips_ave_short_suffix(self):
        assert pg.normalize_name("Windsor Ave") == "windsor"

    def test_strips_street_suffix(self):
        assert pg.normalize_name("Main Street") == "main"

    def test_strips_drive_suffix(self):
        assert pg.normalize_name("Canberra Drive") == "canberra"

    def test_strips_leading_house_number(self):
        assert pg.normalize_name("23 Windsor Ave") == "windsor"

    def test_strips_diacritics(self):
        assert pg.normalize_name("São Paulo") == "sao paulo"

    def test_strips_diacritics_with_suffix(self):
        assert pg.normalize_name("Avenida São Paulo Avenue") == "avenida sao paulo"

    def test_collapses_whitespace(self):
        assert pg.normalize_name("  Windsor   Road  ") == "windsor"

    def test_lowercases(self):
        assert pg.normalize_name("HARARE") == "harare"

    def test_empty_string_returns_empty(self):
        assert pg.normalize_name("") == ""

    def test_preserves_name_without_suffix(self):
        assert pg.normalize_name("Harare") == "harare"

    def test_does_not_strip_partial_suffix(self):
        """A word that *contains* a suffix substring should not lose it."""
        assert pg.normalize_name("Roadside") == "roadside"


# ---------------------------------------------------------------------------
# enqueue_fundi_seed
# ---------------------------------------------------------------------------


class TestEnqueueFundiSeed:
    @staticmethod
    def _wire_db(mock_db, existing=None):
        """Helper — wire places_db()['seedRequests'] to return a fresh collection mock."""
        coll = MagicMock()
        coll.find_one.return_value = existing
        mock_db.return_value.__getitem__.return_value = coll
        return coll

    @patch("py._places_geo.places_db")
    def test_writes_request_doc(self, mock_db):
        coll = self._wire_db(mock_db)

        request_id = pg.enqueue_fundi_seed(
            lat=-17.83, lon=31.05, radius_meters=5000, query="Harare",
        )

        # places_db()["seedRequests"] was used
        mock_db.return_value.__getitem__.assert_any_call("seedRequests")
        coll.insert_one.assert_called_once()

        doc = coll.insert_one.call_args[0][0]
        assert doc["_id"] == request_id
        assert doc["_schemaVersion"] == "v3.1"
        assert doc["status"] == "queued"
        assert doc["region"]["kind"] == "point_radius"
        assert doc["region"]["center"] == [31.05, -17.83]  # [lon, lat]
        assert doc["region"]["radiusMeters"] == 5000
        assert doc["source"]["kind"] == "search_miss"
        assert doc["source"]["surface"] == "mukoko-weather"
        assert doc["source"]["query"] == "Harare"
        assert doc["categories"] == "all"
        assert doc["startedAt"] is None
        assert doc["finishedAt"] is None
        assert doc["error"] is None
        assert doc["placesCreated"] is None
        assert doc["placesGeoCreated"] is None

    @patch("py._places_geo.places_db")
    def test_returns_request_id(self, mock_db):
        coll = self._wire_db(mock_db)
        request_id = pg.enqueue_fundi_seed(lat=1.0, lon=2.0)
        assert isinstance(request_id, str)
        assert len(request_id) > 0
        doc = coll.insert_one.call_args[0][0]
        assert doc["_id"] == request_id

    @patch("py._places_geo.places_db")
    def test_default_radius_5000(self, mock_db):
        coll = self._wire_db(mock_db)
        pg.enqueue_fundi_seed(lat=0, lon=0)
        doc = coll.insert_one.call_args[0][0]
        assert doc["region"]["radiusMeters"] == 5000

    @patch("py._places_geo.places_db")
    def test_requester_person_id_propagated(self, mock_db):
        coll = self._wire_db(mock_db)
        pg.enqueue_fundi_seed(
            lat=0, lon=0, requested_by_person_id="person-uuid",
        )
        doc = coll.insert_one.call_args[0][0]
        assert doc["source"]["requestedByPersonId"] == "person-uuid"

    @patch("py._places_geo.places_db")
    def test_dedupes_existing_queued_request(self, mock_db):
        """If an in-flight queued request already covers this point, surface its _id."""
        coll = self._wire_db(mock_db, existing={
            "_id": "already-queued-uuid",
            "status": "queued",
        })
        request_id = pg.enqueue_fundi_seed(lat=-17.83, lon=31.05)
        assert request_id == "already-queued-uuid"
        coll.insert_one.assert_not_called()

    @patch("py._places_geo.places_db")
    def test_dedupes_processing_request_too(self, mock_db):
        coll = self._wire_db(mock_db, existing={
            "_id": "in-progress",
            "status": "processing",
        })
        request_id = pg.enqueue_fundi_seed(lat=0, lon=0)
        assert request_id == "in-progress"
        coll.insert_not_called = MagicMock()
        coll.insert_one.assert_not_called()


# ---------------------------------------------------------------------------
# poi_type_from_place — extract a single human-facing POI type
# ---------------------------------------------------------------------------


class TestPoiTypeFromPlace:
    def test_prefers_first_placetype_list_entry(self):
        assert pg.poi_type_from_place({"placeType": ["school", "college"]}) == "school"

    def test_accepts_placetype_string(self):
        assert pg.poi_type_from_place({"placeType": "hospital"}) == "hospital"

    def test_falls_back_to_additional_categories(self):
        assert pg.poi_type_from_place(
            {"placeType": [], "additionalCategories": ["market"]}
        ) == "market"

    def test_strips_whitespace(self):
        assert pg.poi_type_from_place({"placeType": ["  park  "]}) == "park"

    def test_skips_blank_entries(self):
        assert pg.poi_type_from_place({"placeType": ["", "  ", "clinic"]}) == "clinic"

    def test_none_when_no_type(self):
        assert pg.poi_type_from_place({"name": "Somewhere"}) is None

    def test_none_for_empty_doc(self):
        assert pg.poi_type_from_place(None) is None
        assert pg.poi_type_from_place({}) is None


# ---------------------------------------------------------------------------
# find_nearest_place — tight-radius POI matching against places.places
# ---------------------------------------------------------------------------


class TestFindNearestPlace:
    @patch("py._places_geo.places_collection")
    def test_returns_dict_result(self, mock_coll):
        poi = {"_id": "poi-1", "name": "Prince Edward School", "placeType": ["school"]}
        mock_coll.return_value.find_one.return_value = poi
        result = pg.find_nearest_place(-17.83, 31.05)
        assert result == poi

    @patch("py._places_geo.places_collection")
    def test_uses_nearsphere_with_lon_lat_and_meters(self, mock_coll):
        mock_coll.return_value.find_one.return_value = None
        pg.find_nearest_place(-17.83, 31.05, 0.25)
        query = mock_coll.return_value.find_one.call_args.args[0]
        near = query["geo"]["$nearSphere"]
        assert near["$geometry"]["coordinates"] == [31.05, -17.83]  # [lon, lat]
        assert near["$maxDistance"] == 250  # 0.25 km -> 250 m

    @patch("py._places_geo.places_collection")
    def test_none_when_nothing_in_range(self, mock_coll):
        mock_coll.return_value.find_one.return_value = None
        assert pg.find_nearest_place(0, 0) is None

    @patch("py._places_geo.places_collection")
    def test_non_dict_result_becomes_none(self, mock_coll):
        """A non-dict result (e.g. mock/missing index) must fall back to None."""
        mock_coll.return_value.find_one.return_value = MagicMock()
        assert pg.find_nearest_place(0, 0) is None

    @patch("py._places_geo.places_collection")
    def test_swallows_errors_returns_none(self, mock_coll):
        """POI matching must never break resolution — errors fall back to None."""
        mock_coll.return_value.find_one.side_effect = RuntimeError("no 2dsphere index")
        assert pg.find_nearest_place(0, 0) is None


# ---------------------------------------------------------------------------
# upsert_placesgeo_city — mukoko_poi_type stamped into sourceProvenance
# ---------------------------------------------------------------------------


class TestUpsertStampsPoiType:
    @patch("py._places_geo.find_nearby_placesgeo", return_value=None)
    @patch("py._places_geo.get_country_id", return_value="zw-parent")
    @patch("py._places_geo.places_geo_collection")
    def test_new_doc_stamps_poi_type(self, mock_coll, _parent, _dedup):
        result = pg.upsert_placesgeo_city(
            name="Prince Edward School", lat=-17.83, lon=31.05,
            country_iso="ZW", mukoko_poi_type="school",
        )
        assert result["sourceProvenance"]["mukokoPoiType"] == "school"

    @patch("py._places_geo.find_nearby_placesgeo", return_value=None)
    @patch("py._places_geo.get_country_id", return_value="zw-parent")
    @patch("py._places_geo.places_geo_collection")
    def test_poi_type_omitted_when_none(self, mock_coll, _parent, _dedup):
        result = pg.upsert_placesgeo_city(
            name="Harare", lat=-17.83, lon=31.05, country_iso="ZW",
        )
        assert "mukokoPoiType" not in result["sourceProvenance"]

    @patch("py._places_geo.find_nearby_placesgeo")
    @patch("py._places_geo.get_country_id", return_value="zw-parent")
    @patch("py._places_geo.places_geo_collection")
    def test_patches_poi_type_onto_existing_doc(self, mock_coll, _parent, mock_dedup):
        """A pre-existing doc missing a POI type gets it stamped alongside the slug."""
        mock_dedup.return_value = {
            "_id": "existing-uuid",
            "slug": "prince-edward-existing",
            "name": "Prince Edward School",
            "sourceProvenance": {},
        }
        result = pg.upsert_placesgeo_city(
            name="Prince Edward School", lat=-17.83, lon=31.05,
            country_iso="ZW", mukoko_slug="prince-edward-school-zw",
            mukoko_poi_type="school",
        )
        assert result["wasExisting"] is True
        patch_set = mock_coll.return_value.update_one.call_args.args[1]["$set"]
        assert patch_set["sourceProvenance.mukokoPoiType"] == "school"
