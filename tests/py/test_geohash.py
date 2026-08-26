"""Tests for api/py/_geohash.py — the Python mirror of src/lib/geohash.ts.

Two things are being protected here:

1. Correctness against the geohash standard, using published reference values
   (Wikipedia / geohash.org) rather than values this implementation produced.
2. Cross-language parity. A slug minted in Python must decode to the same box
   in TypeScript, so both suites pin the SAME vectors. If you change one
   implementation, these vectors are what catch the drift.
"""

from __future__ import annotations

import pytest

from py._geohash import (
    DEFAULT_PRECISION,
    SMART_SLUG_DELIMITER,
    build_smart_slug,
    encode_geohash,
    slugify_name,
)

# Published reference values — shared verbatim with src/lib/geohash.test.ts.
PUBLISHED_VECTORS = [
    (57.64911, 10.40744, 11, "u4pruydqqvj"),
    (42.6, -5.6, 5, "ezs42"),
    (51.5074, -0.1278, 6, "gcpvj0"),
    (-33.8688, 151.2093, 6, "r3gx2f"),
]

# App coordinates at default precision — also asserted in the TypeScript suite.
PARITY_VECTORS = [
    (-17.8292, 31.0522, "ksy4dd7"),   # Harare
    (1.3521, 103.8198, "w21zdqp"),    # Singapore
    (-20.1594, 28.5886, "kskm6d1"),   # Bulawayo
]


class TestEncodeGeohash:
    @pytest.mark.parametrize("lat,lon,precision,expected", PUBLISHED_VECTORS)
    def test_matches_published_reference_values(self, lat, lon, precision, expected):
        assert encode_geohash(lat, lon, precision) == expected

    @pytest.mark.parametrize("lat,lon,expected", PARITY_VECTORS)
    def test_matches_the_typescript_implementation(self, lat, lon, expected):
        assert encode_geohash(lat, lon) == expected

    def test_default_precision_agrees_with_typescript(self):
        assert DEFAULT_PRECISION == 7

    def test_produces_exactly_precision_characters(self):
        for p in range(1, 10):
            assert len(encode_geohash(-17.8292, 31.0522, p)) == p

    def test_is_deterministic(self):
        # The property the old random hex suffix lacked.
        assert encode_geohash(-17.8292, 31.0522) == encode_geohash(-17.8292, 31.0522)

    def test_uses_only_the_reduced_alphabet(self):
        for lat, lon in [(-17.8, 31.0), (1.35, 103.8), (51.5, -0.13)]:
            assert not set(encode_geohash(lat, lon, 9)) & set("ailo")

    @pytest.mark.parametrize("lat,lon", [(91, 0), (-91, 0), (0, 181), (0, -181)])
    def test_returns_empty_for_out_of_range(self, lat, lon):
        assert encode_geohash(lat, lon) == ""

    def test_returns_empty_for_unusable_input(self):
        assert encode_geohash(float("nan"), 0) == ""
        assert encode_geohash(None, 0) == ""
        assert encode_geohash("abc", 0) == ""

    def test_handles_poles_and_antimeridian(self):
        assert len(encode_geohash(90, 180, 6)) == 6
        assert len(encode_geohash(-90, -180, 6)) == 6
        assert len(encode_geohash(0, 0, 6)) == 6

    def test_clamps_absurd_precision(self):
        assert len(encode_geohash(0, 0, 999)) == 12
        assert len(encode_geohash(0, 0, 0)) == 1


class TestSlugifyName:
    def test_lowercases_and_dashes(self):
        assert slugify_name("Victoria Falls") == "victoria-falls"

    def test_strips_diacritics(self):
        assert slugify_name("São Paulo") == "sao-paulo"

    def test_collapses_punctuation_runs(self):
        # Why `--` is safe as a delimiter: it cannot survive slugification.
        assert slugify_name("St. Mary's  School") == "st-mary-s-school"
        assert slugify_name("A -- B") == "a-b"

    def test_never_emits_the_delimiter(self):
        for value in ["A -- B", "x---y", "Foo -- Bar -- Baz", "a__b"]:
            assert SMART_SLUG_DELIMITER not in slugify_name(value)

    def test_handles_empty_and_junk(self):
        assert slugify_name("") == ""
        assert slugify_name("!!!") == ""


class TestBuildSmartSlug:
    def test_joins_name_and_geohash(self):
        assert build_smart_slug("Harare", -17.8292, 31.0522) == "harare--ksy4dd7"

    def test_is_deterministic(self):
        a = build_smart_slug("Mbare Musika", -17.8492, 31.0432)
        b = build_smart_slug("Mbare Musika", -17.8492, 31.0432)
        assert a == b

    def test_distinct_places_get_distinct_slugs(self):
        harare = build_smart_slug("Market", -17.8292, 31.0522)
        singapore = build_smart_slug("Market", 1.3521, 103.8198)
        assert harare != singapore

    def test_same_name_far_apart_no_longer_collides(self):
        # The collision the suburb/road enrichment dance existed to work around:
        # two "Central Market"s in different cities used to fight for one slug.
        a = build_smart_slug("Central Market", -17.8292, 31.0522)
        b = build_smart_slug("Central Market", -20.1594, 28.5886)
        assert a != b

    def test_unnamed_coordinate_still_gets_a_usable_slug(self):
        slug = build_smart_slug("", -17.8292, 31.0522)
        assert slug.startswith(f"place{SMART_SLUG_DELIMITER}")

    def test_returns_empty_for_unusable_coordinates(self):
        assert build_smart_slug("Nowhere", float("nan"), 0) == ""
        assert build_smart_slug("Nowhere", 91, 0) == ""

    def test_carries_no_country_suffix(self):
        # The coordinate carries the geography now, so the country code no
        # longer has to be smuggled into the name.
        assert build_smart_slug("Nairobi", -1.2921, 36.8219).count("--") == 1
        assert not build_smart_slug("Nairobi", -1.2921, 36.8219).endswith("-ke")
