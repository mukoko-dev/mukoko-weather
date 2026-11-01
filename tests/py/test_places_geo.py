"""Tests for api/py/_places_geo.py — the placesGeo helpers the place-knowledge builder still uses."""

from __future__ import annotations

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


@pytest.fixture(autouse=True)
def _mock_creation_lock_db():
    """Give the creation-lock helpers a working mock DB by default.

    Individual TOCTOU tests override this to exercise contention paths.
    """
    with patch("py._places_geo.weather_db") as mock_db:
        mock_db.return_value.__getitem__.return_value = MagicMock()
        yield mock_db


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


# ---------------------------------------------------------------------------
# upsert_placesgeo_city
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# poi_type_from_place — extract a single human-facing POI type
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# find_nearest_place — tight-radius POI matching against places.places
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# upsert_placesgeo_city — mukoko_poi_type stamped into sourceProvenance
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Creation lock (TOCTOU guard — issue #94)
# ---------------------------------------------------------------------------


class TestCreationLock:
    def test_acquires_lock_on_clean_insert(self, _mock_creation_lock_db):
        coll = _mock_creation_lock_db.return_value.__getitem__.return_value
        assert pg._acquire_create_lock("placesgeo:ZW:harare") is True
        coll.insert_one.assert_called_once()
        assert coll.insert_one.call_args[0][0]["_id"] == "placesgeo:ZW:harare"

    def test_contended_lock_returns_false(self, _mock_creation_lock_db):
        from pymongo.errors import DuplicateKeyError as DKE
        coll = _mock_creation_lock_db.return_value.__getitem__.return_value
        coll.insert_one.side_effect = DKE("duplicate")
        coll.delete_one.return_value.deleted_count = 0  # fresh lock — not stale
        assert pg._acquire_create_lock("placesgeo:ZW:harare") is False

    def test_stale_lock_is_stolen(self, _mock_creation_lock_db):
        from pymongo.errors import DuplicateKeyError as DKE
        coll = _mock_creation_lock_db.return_value.__getitem__.return_value
        # First insert collides; the stale delete removes one doc; retry succeeds.
        coll.insert_one.side_effect = [DKE("duplicate"), None]
        coll.delete_one.return_value.deleted_count = 1
        assert pg._acquire_create_lock("placesgeo:ZW:harare") is True
        assert coll.insert_one.call_count == 2

    def test_lock_infra_down_proceeds_unlocked(self, _mock_creation_lock_db):
        coll = _mock_creation_lock_db.return_value.__getitem__.return_value
        coll.insert_one.side_effect = RuntimeError("db down")
        assert pg._acquire_create_lock("x") is True
