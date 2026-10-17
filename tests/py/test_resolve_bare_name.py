"""GET /api/py/search?mode=resolve — a bare place name from a URL (/koh-samui).

Reuses the search top-up's upstream (Open-Meteo geocoding) and breaker gate;
only the budgets are its own. Nothing is stored.
"""

from __future__ import annotations

from unittest.mock import PropertyMock, patch

import pytest
from fastapi import HTTPException

from py import _locations
from py._locations import resolve_bare_name, search_locations

KOH_SAMUI = {
    "name": "Ko Samui", "country": "TH", "countryName": "Thailand",
    "admin1": "Surat Thani", "lat": 9.51201, "lon": 100.01361,
    "elevation": 12, "featureCode": "PPLA2",
}
THAILAND = {
    "name": "Thailand", "country": "TH", "countryName": "Thailand",
    "admin1": "", "lat": 15.5, "lon": 101.0, "elevation": None, "featureCode": "PCLI",
}
KARIBA = {
    "name": "Kariba", "country": "ZW", "countryName": "Zimbabwe",
    "admin1": "Mashonaland West", "lat": -16.52, "lon": 28.76,
    "elevation": 518, "featureCode": "PPL",
}


@pytest.fixture(autouse=True)
def _isolate():
    _locations._resolve_cache.clear()
    with patch("py._locations.enforce_rate_limit", return_value="1.2.3.4"), patch(
        "py._locations.check_rate_limit", return_value={"allowed": True}
    ):
        yield
    _locations._resolve_cache.clear()


class TestResolveBareName:
    @patch("py._locations._forward_geocode", return_value=[KOH_SAMUI])
    def test_resolves_to_a_spot_slug_with_the_geocoded_coordinate(self, mock_geo):
        out = resolve_bare_name("koh-samui", None)
        assert out["status"] == "ok"
        loc = out["location"]
        # The slug is the cosmetic geocoder name plus the coordinate identity.
        assert loc["slug"].startswith("ko-samui--")
        assert loc["lat"] == pytest.approx(9.51201)
        assert loc["source"] == "geocoded"
        # Hyphens are spaces to the geocoder.
        assert mock_geo.call_args.args == ("koh samui", _locations.RESOLVE_GEOCODE_COUNT)

    @patch("py._locations._forward_geocode", return_value=[])
    def test_nothing_found_is_a_definitive_miss(self, _geo):
        out = resolve_bare_name("zzzzqx", None)
        assert out == {"status": "no_match", "location": None}

    @patch("py._locations._forward_geocode", return_value=[KARIBA])
    def test_dissimilar_hit_is_rejected(self, _geo):
        """The geocoder matches loosely; /admin must not become some village."""
        assert resolve_bare_name("sandwich", None)["status"] == "no_match"

    @patch("py._locations._forward_geocode", return_value=[{**KARIBA, "name": "Zorbaville"}])
    def test_partial_name_still_resolves(self, _geo):
        """lake-zorbaville -> Zorbaville (a qualifier word in the URL)."""
        out = resolve_bare_name("lake-zorbaville", None)
        assert out["status"] == "ok"
        assert out["location"]["slug"].startswith("zorbaville--")

    @patch("py._locations._forward_geocode", return_value=[THAILAND, {**KOH_SAMUI, "name": "Thailand"}])
    def test_place_beats_area_of_the_same_name(self, _geo):
        out = resolve_bare_name("thailand", None)
        assert "area" not in out["location"]
        assert out["location"]["lat"] == pytest.approx(9.51201)

    @patch("py._locations._forward_geocode", return_value=[THAILAND])
    def test_area_alone_renders_at_its_centre(self, _geo):
        """Any name on the map renders weather: a country is better than a 404."""
        out = resolve_bare_name("thailand", None)
        assert out["status"] == "ok"
        assert out["location"]["area"] is True
        assert out["location"]["slug"].startswith("thailand--")

    @patch("py._locations._forward_geocode", return_value=[{**KOH_SAMUI, "name": "Phuket", "lat": 7.89, "lon": 98.4}])
    def test_seed_city_hit_returns_the_seed_slug(self, _geo):
        out = resolve_bare_name("phuket", None)
        assert out["location"]["slug"] == "phuket-th"

    @pytest.mark.parametrize("q", ["", "ab", "x" * 61, "12345", "a/b", "a%20b", "café", "../etc"])
    @patch("py._locations._forward_geocode")
    def test_bad_names_never_reach_the_geocoder(self, mock_geo, q):
        assert resolve_bare_name(q, None)["status"] == "no_match"
        mock_geo.assert_not_called()

    @patch("py._locations._forward_geocode", return_value=[KOH_SAMUI])
    def test_answers_are_cached_and_cache_hits_are_not_metered(self, mock_geo):
        with patch("py._locations.enforce_rate_limit", return_value="1.2.3.4") as rate:
            resolve_bare_name("koh-samui", None)
            resolve_bare_name("  Koh-Samui ", None)
        assert mock_geo.call_count == 1
        assert rate.call_count == 1
        assert rate.call_args[0][1] == "slug-geocode"
        assert rate.call_args.kwargs["require_ip"] is False

    @patch("py._locations._forward_geocode", return_value=[])
    def test_misses_are_cached_briefly(self, mock_geo):
        resolve_bare_name("zzzzqx", None)
        resolve_bare_name("zzzzqx", None)
        assert mock_geo.call_count == 1
        assert _locations.RESOLVE_MISS_TTL_S < _locations.RESOLVE_CACHE_TTL_S

    @patch("py._locations._forward_geocode", return_value=[KOH_SAMUI])
    def test_per_ip_budget_exhausted(self, mock_geo):
        with patch("py._locations.enforce_rate_limit", side_effect=HTTPException(status_code=429)):
            out = resolve_bare_name("koh-samui", None)
        assert out == {"status": "over_budget", "location": None}
        mock_geo.assert_not_called()
        assert "koh samui" not in _locations._resolve_cache  # not cached

    @patch("py._locations._forward_geocode", return_value=[KOH_SAMUI])
    def test_global_budget_exhausted(self, mock_geo):
        with patch("py._locations.check_rate_limit", return_value={"allowed": False}) as glob:
            out = resolve_bare_name("koh-samui", None)
        assert out["status"] == "over_budget"
        assert glob.call_args[0][:2] == ("all", "slug-geocode-global")
        mock_geo.assert_not_called()

    @patch("py._locations._forward_geocode", return_value=[KOH_SAMUI])
    def test_open_breaker_is_unavailable_and_not_cached(self, mock_geo):
        from py._circuit_breaker import open_meteo_breaker

        with patch.object(type(open_meteo_breaker), "is_allowed", new_callable=PropertyMock, return_value=False):
            out = resolve_bare_name("koh-samui", None)
        assert out["status"] == "unavailable"
        mock_geo.assert_not_called()
        assert not _locations._resolve_cache

    def test_budgets_are_conservative(self):
        assert _locations.RESOLVE_PER_IP <= 15
        assert _locations.RESOLVE_GLOBAL <= 300


class TestSearchModeResolve:
    @pytest.mark.asyncio
    @patch("py._locations._forward_geocode", return_value=[KOH_SAMUI])
    @patch("py._locations.search_locations_by_name")
    async def test_returns_one_location_and_skips_the_catalogue(self, mock_db, _geo):
        out = await search_locations(q="koh-samui", mode="resolve")
        assert out["resolve"] == "ok"
        assert out["total"] == 1
        assert out["locations"][0]["slug"].startswith("ko-samui--")
        mock_db.assert_not_called()

    @pytest.mark.asyncio
    @patch("py._locations._forward_geocode", return_value=[])
    async def test_nothing_is_a_200_with_an_empty_list(self, _geo):
        out = await search_locations(q="zzzzqx", mode="resolve")
        assert out == {"locations": [], "total": 0, "source": "none", "resolve": "no_match"}

    @pytest.mark.asyncio
    async def test_needs_a_name(self):
        with pytest.raises(HTTPException) as exc:
            await search_locations(q="", mode="resolve")
        assert exc.value.status_code == 400

    @pytest.mark.asyncio
    @patch("py._locations._forward_geocode", return_value=[KOH_SAMUI])
    async def test_over_budget_is_200_not_429(self, _geo):
        with patch("py._locations.enforce_rate_limit", side_effect=HTTPException(status_code=429)):
            out = await search_locations(q="koh-samui", mode="resolve")
        assert out["resolve"] == "over_budget"
        assert out["locations"] == []

    @pytest.mark.asyncio
    @patch("py._locations._forward_geocode", return_value=[KOH_SAMUI])
    async def test_nothing_is_written(self, _geo):
        with patch("py._locations.upsert_placesgeo_city") as upsert, patch(
            "py._locations.places_geo_collection"
        ) as coll:
            await search_locations(q="koh-samui", mode="resolve")
        upsert.assert_not_called()
        coll.assert_not_called()
