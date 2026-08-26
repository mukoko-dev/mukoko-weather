"""Tests for api/py/_overpass.py — Overpass-backed naming of bare coordinates.

Covers the ranking that decides WHICH nearby feature names a point, the
`is_in` admin extraction that replaces shipping a GeoJSON boundary dataset,
and the degrade-don't-fail contract every failure path must honour.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from py import _overpass
from py._overpass import (
    _build_query,
    _extract_admin,
    _feature_score,
    _feature_type,
    reverse_name,
)


def _client(status: int = 200, payload: dict | None = None) -> MagicMock:
    """A stand-in Overpass HTTP client returning one canned response."""
    resp = MagicMock()
    resp.status_code = status
    resp.json.return_value = payload if payload is not None else {"elements": []}
    client = MagicMock()
    client.post.return_value = resp
    return client


class TestFeatureScore:
    def test_concrete_features_outrank_place_polygons(self):
        # The whole point: standing at a school should name the school, not the
        # city polygon that also covers the point.
        school = _feature_score({"amenity": "school", "name": "Prince Edward"})
        city = _feature_score({"place": "city", "name": "Harare"})
        assert school < city

    def test_amenity_outranks_highway(self):
        assert _feature_score({"amenity": "hospital"}) < _feature_score({"highway": "residential"})

    def test_place_values_keep_their_own_specificity_order(self):
        assert _feature_score({"place": "suburb"}) < _feature_score({"place": "city"})
        assert _feature_score({"place": "hamlet"}) < _feature_score({"place": "town"})

    def test_unknown_tags_sort_last_but_remain_usable(self):
        assert _feature_score({"random_key": "x"}) == 999

    def test_unrecognised_place_value_still_beats_nothing(self):
        assert _feature_score({"place": "not_a_real_value"}) < 999


class TestFeatureType:
    def test_returns_the_most_specific_tag_value(self):
        assert _feature_type({"amenity": "school"}) == "school"
        assert _feature_type({"leisure": "park"}) == "park"

    def test_skips_yes_valued_tags(self):
        # `building=yes` says a building exists, not what it is.
        assert _feature_type({"building": "yes", "place": "suburb"}) == "suburb"

    def test_returns_none_when_nothing_typed(self):
        assert _feature_type({"name": "Somewhere"}) is None


class TestBuildQuery:
    def test_asks_for_nearby_named_features_and_containing_areas(self):
        q = _build_query(-17.8292, 31.0522, 250)
        assert "nwr(around:250,-17.8292,31.0522)[name]" in q
        assert "is_in(-17.8292,31.0522)" in q
        assert "[out:json]" in q

    def test_carries_a_server_side_timeout(self):
        assert f"timeout:{_overpass.OVERPASS_TIMEOUT_S}" in _build_query(0, 0, 100)


class TestExtractAdmin:
    def test_reads_iso_country_and_level_four_province(self):
        code, name, province = _extract_admin([
            {"tags": {"ISO3166-1:alpha2": "ZW", "name": "Zimbabwe", "admin_level": "2"}},
            {"tags": {"name": "Harare Province", "admin_level": "4"}},
        ])
        assert code == "ZW"
        assert name == "Zimbabwe"
        assert province == "Harare Province"

    def test_falls_back_to_plain_iso3166_1_tag(self):
        code, _, _ = _extract_admin([{"tags": {"ISO3166-1": "SG", "name": "Singapore"}}])
        assert code == "SG"

    def test_prefers_english_names(self):
        _, _, province = _extract_admin([
            {"tags": {"admin_level": "4", "name": ""                        , "name:en": "Bangkok"}},
        ])
        assert province == "Bangkok"

    def test_city_state_with_no_subdivision_yields_empty_province(self):
        # Singapore legitimately has no admin_level 4. That must not error.
        code, name, province = _extract_admin([
            {"tags": {"ISO3166-1:alpha2": "SG", "name": "Singapore", "admin_level": "2"}},
        ])
        assert (code, name, province) == ("SG", "Singapore", "")

    def test_prefers_the_outermost_subdivision(self):
        _, _, province = _extract_admin([
            {"tags": {"admin_level": "6", "name": "Some District"}},
            {"tags": {"admin_level": "4", "name": "The Province"}},
        ])
        assert province == "The Province"

    def test_tolerates_junk_admin_levels(self):
        code, _, province = _extract_admin([
            {"tags": {"admin_level": "not-a-number", "name": "Nowhere"}},
            {"tags": {"admin_level": None, "name": "Also Nowhere"}},
            {"tags": {"ISO3166-1:alpha2": "ZW"}},
        ])
        assert code == "ZW"
        assert province == ""

    def test_handles_areas_with_no_tags(self):
        assert _extract_admin([{}, {"tags": {}}]) == ("", "", "")


class TestReverseName:
    def test_names_a_point_from_the_most_specific_nearby_feature(self):
        payload = {"elements": [
            {"type": "way", "tags": {"highway": "residential", "name": "Josiah Tongogara Ave"}},
            {"type": "node", "tags": {"amenity": "school", "name": "Prince Edward School"}},
            {"type": "area", "tags": {"ISO3166-1:alpha2": "ZW", "name": "Zimbabwe", "admin_level": "2"}},
            {"type": "area", "tags": {"admin_level": "4", "name": "Harare"}},
        ]}
        with patch.object(_overpass, "_get_http", return_value=_client(payload=payload)):
            out = reverse_name(-17.8292, 31.0522)
        assert out["name"] == "Prince Edward School"
        assert out["poiType"] == "school"
        assert out["country"] == "ZW"
        assert out["admin1"] == "Harare"

    def test_returns_the_shape_reverse_geocode_callers_expect(self):
        payload = {"elements": [{"type": "node", "tags": {"place": "suburb", "name": "Strathaven"}}]}
        with patch.object(_overpass, "_get_http", return_value=_client(payload=payload)):
            out = reverse_name(-17.8, 31.0)
        assert set(out) == {
            "name", "osmRef", "poiType", "country", "countryName",
            "admin1", "lat", "lon", "elevation",
        }

    def test_admin_only_result_when_nothing_named_is_nearby(self):
        payload = {"elements": [
            {"type": "area", "tags": {"ISO3166-1:alpha2": "ZW", "name": "Zimbabwe", "admin_level": "2"}},
            {"type": "area", "tags": {"admin_level": "4", "name": "Matabeleland North"}},
        ]}
        with patch.object(_overpass, "_get_http", return_value=_client(payload=payload)):
            out = reverse_name(-18.0, 26.0)
        assert out["name"] == "Matabeleland North"
        assert out["poiType"] is None

    def test_ignores_nearby_elements_with_no_name(self):
        payload = {"elements": [
            {"type": "node", "tags": {"amenity": "bench"}},
            {"type": "node", "tags": {"place": "village", "name": "Real Place"}},
        ]}
        with patch.object(_overpass, "_get_http", return_value=_client(payload=payload)):
            assert reverse_name(-17.0, 31.0)["name"] == "Real Place"

    # --- degrade, never fail -------------------------------------------------

    def test_none_on_non_200(self):
        with patch.object(_overpass, "_get_http", return_value=_client(status=503)):
            assert reverse_name(-17.8, 31.0) is None

    def test_none_when_the_request_raises(self):
        client = MagicMock()
        client.post.side_effect = RuntimeError("connection reset")
        with patch.object(_overpass, "_get_http", return_value=client):
            assert reverse_name(-17.8, 31.0) is None

    def test_none_on_unparseable_body(self):
        resp = MagicMock()
        resp.status_code = 200
        resp.json.side_effect = ValueError("not json")
        client = MagicMock()
        client.post.return_value = resp
        with patch.object(_overpass, "_get_http", return_value=client):
            assert reverse_name(-17.8, 31.0) is None

    def test_none_when_nothing_at_all_is_returned(self):
        with patch.object(_overpass, "_get_http", return_value=_client(payload={"elements": []})):
            assert reverse_name(-17.8, 31.0) is None

    def test_none_when_only_untagged_areas_come_back(self):
        payload = {"elements": [{"type": "area", "tags": {}}]}
        with patch.object(_overpass, "_get_http", return_value=_client(payload=payload)):
            assert reverse_name(-17.8, 31.0) is None

    @pytest.mark.parametrize("lat,lon", [(91, 0), (-91, 0), (0, 181), (0, -181)])
    def test_rejects_out_of_range_coordinates_without_a_request(self, lat, lon):
        client = _client()
        with patch.object(_overpass, "_get_http", return_value=client):
            assert reverse_name(lat, lon) is None
        client.post.assert_not_called()


class TestReverseGeocodeIntegration:
    """`_locations._reverse_geocode` must prefer Overpass but never depend on it."""

    def test_prefers_overpass_when_it_produces_a_name(self):
        from py import _locations

        payload = {"elements": [
            {"type": "node", "tags": {"amenity": "school", "name": "Singapore American School"}},
            {"type": "area", "tags": {"ISO3166-1:alpha2": "SG", "name": "Singapore", "admin_level": "2"}},
        ]}
        with patch.object(_overpass, "_get_http", return_value=_client(payload=payload)):
            out = _locations._reverse_geocode(1.3521, 103.8198)
        assert out["name"] == "Singapore American School"
        assert out["country"] == "SG"

    def test_falls_back_to_nominatim_when_overpass_is_unavailable(self):
        from py import _locations

        nominatim = MagicMock()
        nominatim.status_code = 200
        nominatim.json.return_value = {
            "lat": "-17.8292", "lon": "31.0522",
            "display_name": "Harare, Zimbabwe",
            "address": {"city": "Harare", "state": "Harare", "country": "Zimbabwe", "country_code": "zw"},
        }
        nominatim_client = MagicMock()
        nominatim_client.get.return_value = nominatim

        failing = MagicMock()
        failing.post.side_effect = RuntimeError("overpass down")

        with patch.object(_overpass, "_get_http", return_value=failing), \
             patch.object(_locations, "_get_http", return_value=nominatim_client):
            out = _locations._reverse_geocode(-17.8292, 31.0522)

        assert out is not None
        assert out["country"] == "ZW"
        nominatim_client.get.assert_called_once()

    def test_falls_back_when_overpass_returns_admin_context_but_no_name(self):
        from py import _locations

        # Admin-only is thinner than Nominatim would give for the same point.
        payload = {"elements": [
            {"type": "area", "tags": {"ISO3166-1:alpha2": "ZW", "admin_level": "2", "name": "Zimbabwe"}},
        ]}
        nominatim = MagicMock()
        nominatim.status_code = 200
        nominatim.json.return_value = {
            "lat": "-17.8", "lon": "31.0",
            "display_name": "Strathaven, Harare",
            "address": {"suburb": "Strathaven", "state": "Harare", "country": "Zimbabwe", "country_code": "zw"},
        }
        nominatim_client = MagicMock()
        nominatim_client.get.return_value = nominatim

        with patch.object(_overpass, "_get_http", return_value=_client(payload=payload)), \
             patch.object(_locations, "_get_http", return_value=nominatim_client):
            out = _locations._reverse_geocode(-17.8, 31.0)

        assert out["name"] == "Strathaven"
        nominatim_client.get.assert_called_once()


class TestOsmRef:
    """The map's own id for a feature — the identity of a place."""

    def test_builds_short_refs_for_each_element_type(self):
        from py._overpass import osm_ref

        assert osm_ref({"type": "node", "id": 1234567}) == "n1234567"
        assert osm_ref({"type": "way", "id": 890123}) == "w890123"
        assert osm_ref({"type": "relation", "id": 45678}) == "r45678"

    def test_returns_none_for_unusable_elements(self):
        from py._overpass import osm_ref

        assert osm_ref({"type": "area", "id": 1}) is None
        assert osm_ref({"type": "node"}) is None
        assert osm_ref({}) is None

    def test_reverse_name_carries_the_ref_of_the_chosen_feature(self):
        payload = {"elements": [
            {"type": "way", "id": 111, "tags": {"highway": "residential", "name": "Canberra Link"}},
            {"type": "node", "id": 222, "tags": {"amenity": "school", "name": "Canberra Primary"}},
        ]}
        with patch.object(_overpass, "_get_http", return_value=_client(payload=payload)):
            out = reverse_name(1.4491, 103.8203)
        # The ref must belong to the feature that won the ranking, not the first
        # element in the response.
        assert out["name"] == "Canberra Primary"
        assert out["osmRef"] == "n222"

    def test_admin_only_result_carries_no_ref(self):
        payload = {"elements": [
            {"type": "area", "id": 9, "tags": {"admin_level": "4", "name": "North West"}},
        ]}
        with patch.object(_overpass, "_get_http", return_value=_client(payload=payload)):
            assert reverse_name(1.44, 103.82)["osmRef"] is None

    def test_neighbouring_features_get_distinct_refs(self):
        """The requirement coordinate-derived identity cannot meet.

        Canberra Residences and Visionaire are metres apart. Any cell coarse
        enough to absorb GPS jitter merges them; the map keeps them separate.
        """
        from py._overpass import osm_ref

        residences = osm_ref({"type": "way", "id": 111222})
        visionaire = osm_ref({"type": "way", "id": 111223})
        assert residences != visionaire


class TestPlaceSlug:
    def test_builds_a_place_slug_from_a_ref(self):
        from py._geohash import build_place_slug

        assert build_place_slug("Canberra Residences", "w890123") == (
            "canberra-residences--osm-w890123"
        )

    def test_two_neighbours_get_two_slugs(self):
        from py._geohash import build_place_slug

        a = build_place_slug("Canberra Residences", "w111222")
        b = build_place_slug("Visionaire", "w111223")
        assert a != b

    def test_same_feature_always_yields_the_same_slug(self):
        from py._geohash import build_place_slug

        # Stability across visits — the property a random suffix never had and
        # a fine-grained coordinate cell cannot have.
        assert build_place_slug("Canberra Plaza", "w42") == build_place_slug("Canberra Plaza", "w42")

    def test_rejects_unusable_refs_so_callers_fall_back(self):
        from py._geohash import build_place_slug

        assert build_place_slug("Somewhere", "") == ""
        assert build_place_slug("Somewhere", "x123") == ""
        assert build_place_slug("Somewhere", "n") == ""

    def test_normalises_case_and_rejects_leading_zeros(self):
        from py._geohash import normalise_osm_ref

        assert normalise_osm_ref("W890123") == "w890123"
        assert normalise_osm_ref("  n42  ") == "n42"
        # Two spellings of one id would be two identities for one place.
        assert normalise_osm_ref("n0042") is None

    def test_place_ref_prefix_cannot_be_spelled_by_a_geohash(self):
        from py._geohash import OSM_REF_PREFIX

        # The geohash alphabet excludes a/i/l/o, so `osm-` is unreachable from
        # it. That is what makes the two slug forms unambiguous without a flag.
        assert "o" in OSM_REF_PREFIX
        assert not set(OSM_REF_PREFIX) <= set("0123456789bcdefghjkmnpqrstuvwxyz")
