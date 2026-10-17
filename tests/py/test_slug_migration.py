"""Canonical slugs (#317): every seed has a legacy and a canonical slug, the
backend accepts both, and durable data stays under the legacy key."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from py._geohash import build_smart_slug
from py._history import get_history, history_slugs
from py._places_resolver import find_location, spot_storage_key, storage_slug
from py._seed_locations import load_seed
from py._slug_migration import (
    canonical_slug,
    is_canonical_seed_slug,
    storage_key_slug,
)

DATA = Path(__file__).resolve().parents[2] / "api" / "py" / "data" / "slug_migration.json"
ROWS = json.loads(DATA.read_text(encoding="utf-8"))


def _empty_collection() -> MagicMock:
    coll = MagicMock()
    coll.find_one.return_value = None
    coll.find.return_value.limit.return_value = []
    return coll


class TestTable:
    def test_one_row_per_seed_and_a_bijection(self):
        legacy = [r["legacy"] for r in ROWS]
        canonical = [r["canonical"] for r in ROWS]
        assert len(set(legacy)) == len(legacy)
        assert len(set(canonical)) == len(canonical)
        assert set(legacy) == {s["slug"] for s in load_seed()}
        assert not set(legacy) & set(canonical)

    def test_every_row_is_name_and_geohash7_of_the_seed(self):
        # The Python geohash/slugify mirror must derive the SAME canonical slug
        # the TypeScript table pins, for every seed (cross-language parity).
        seeds = {s["slug"]: s for s in load_seed()}
        for row in ROWS:
            s = seeds[row["legacy"]]
            assert build_smart_slug(s["name"], s["lat"], s["lon"]) == row["canonical"], row

    def test_helpers_are_inverse_and_idempotent(self):
        for row in ROWS:
            legacy, canonical = row["legacy"], row["canonical"]
            assert canonical_slug(legacy) == canonical
            assert canonical_slug(canonical) == canonical
            assert storage_key_slug(canonical) == legacy
            assert storage_key_slug(legacy) == legacy
            assert is_canonical_seed_slug(canonical)
            assert not is_canonical_seed_slug(legacy)

    def test_other_slugs_are_left_alone(self):
        for slug in ["west-paddock--ksy4dd7", "x--osm-w1", "harare-35c223", "nope", ""]:
            assert canonical_slug(slug) == slug
            assert storage_key_slug(slug) == slug


class TestFindLocation:
    @patch("py._places_resolver.places_geo_collection")
    def test_canonical_seed_slug_resolves_as_the_seed_under_its_legacy_slug(self, mock_coll):
        mock_coll.return_value = _empty_collection()
        loc = find_location(canonical_slug("bulawayo"))
        assert loc is not None
        assert loc["slug"] == "bulawayo"
        assert loc["name"] == "Bulawayo"
        assert loc["country"] == "ZW"
        assert loc["elevation"] == 1348
        # A catalogue place, not a synthesized spot: durable data keys by slug.
        assert not str(loc["_id"]).startswith("geo:")

    @patch("py._places_resolver.places_geo_collection")
    def test_legacy_and_canonical_resolve_to_the_same_place(self, mock_coll):
        mock_coll.return_value = _empty_collection()
        by_canonical = find_location(canonical_slug("nairobi-ke"))
        assert by_canonical is not None
        assert by_canonical["name"] == "Nairobi"
        assert by_canonical["country"] == "KE"

    @patch("py._places_resolver.places_geo_collection")
    def test_a_stored_placesgeo_doc_still_wins_for_the_seed(self, mock_coll):
        coll = _empty_collection()
        coll.find_one.return_value = {
            "_id": "pg-harare",
            "name": "Harare",
            "slug": "harare-35c223",
            "geoType": "city",
            "isoCode": "ZW",
            "geo": {"type": "Point", "coordinates": [31.05, -17.83]},
            "sourceProvenance": {"mukokoSlug": "harare", "mukokoProvince": "Harare"},
        }
        mock_coll.return_value = coll
        loc = find_location(canonical_slug("harare"))
        assert loc["_id"] == "pg-harare"
        assert loc["slug"] == "harare"

    @patch("py._places_resolver.places_geo_collection")
    def test_a_plain_spot_is_still_a_synthesized_spot(self, mock_coll):
        mock_coll.return_value = _empty_collection()
        slug = build_smart_slug("West Paddock", -17.9, 31.1)
        loc = find_location(slug)
        assert str(loc["_id"]).startswith("geo:")


class TestStorageKeys:
    def test_canonical_seed_slug_is_keyed_by_the_legacy_slug(self):
        loc = {"slug": "harare", "_id": "seed:harare"}
        assert storage_slug(canonical_slug("harare"), loc) == "harare"
        assert storage_slug("harare", loc) == "harare"

    def test_a_synthesized_spot_keeps_its_cell_key(self):
        slug = build_smart_slug("West Paddock", -17.9, 31.1)
        loc = {"slug": slug, "_id": spot_storage_key(slug)}
        assert storage_slug(slug, loc) == spot_storage_key(slug)

    def test_history_reads_the_legacy_key_first_then_the_cell_it_was_spotted_under(self):
        canonical = canonical_slug("harare")
        loc = {"slug": "harare", "_id": "seed:harare", "platformSlug": "harare-35c223"}
        slugs = history_slugs(canonical, loc)
        assert slugs[0] == "harare"
        assert "harare-35c223" in slugs
        # Records written when this URL was only a spot are still read.
        assert spot_storage_key(canonical) in slugs
        assert len(set(slugs)) == len(slugs)

    def test_history_for_the_legacy_slug_adds_no_cell_key(self):
        loc = {"slug": "harare", "_id": "seed:harare"}
        assert history_slugs("harare", loc) == ["harare"]

    @pytest.mark.asyncio
    async def test_history_endpoint_reads_the_legacy_data_for_the_canonical_url(self):
        canonical = canonical_slug("harare")
        loc = {"slug": "harare", "_id": "seed:harare", "lat": -17.83, "lon": 31.05}
        with (
            patch("py._history.find_location", return_value=loc),
            patch("py._history.read_history", return_value=[]) as read,
            patch("py._history.backfill_history", return_value=[]) as backfill,
            patch("py._history._get_http_client", return_value=MagicMock()),
        ):
            result = await get_history(location=canonical, days=7, request=None)
        keys = read.call_args[0][0]
        assert keys[0] == "harare"
        # Backfill (the only writer here) writes to the legacy key, never a new one.
        assert backfill.call_args[0][0] == "harare"
        assert result["location"] == canonical

    @pytest.mark.asyncio
    async def test_history_unknown_location_is_still_404(self):
        with patch("py._history.find_location", return_value=None):
            with pytest.raises(HTTPException) as exc:
                await get_history(location="nowhere--ksy4dd7", days=7, request=None)
        assert exc.value.status_code == 404


class TestCaches:
    def test_ai_summary_cache_key_is_shared_across_both_spellings(self):
        from py._ai import LocationInfo, _summary_cache_key

        legacy = _summary_cache_key(LocationInfo(slug="harare", name="Harare"))
        canonical = _summary_cache_key(
            LocationInfo(slug=canonical_slug("harare"), name="Harare")
        )
        assert legacy == canonical == "harare"

    def test_agriculture_slug_is_shared_across_both_spellings(self):
        from py._agriculture import _clean_slug

        assert _clean_slug(canonical_slug("harare")) == "harare"
        assert _clean_slug("harare") == "harare"
        assert _clean_slug("west-paddock--ksy4dd7") == "west-paddock--ksy4dd7"

    @pytest.mark.asyncio
    async def test_reports_list_reads_the_legacy_key(self):
        from py import _reports

        coll = MagicMock()
        coll.find.return_value.sort.return_value.limit.return_value = []
        with patch.object(_reports, "weather_reports_collection", return_value=coll):
            await _reports.list_reports(location=canonical_slug("harare"), hours=24)
        keys = coll.find.call_args[0][0]["locationSlug"]["$in"]
        assert keys[0] == "harare"
        assert canonical_slug("harare") in keys
