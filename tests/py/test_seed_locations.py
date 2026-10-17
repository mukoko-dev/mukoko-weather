"""The Python copy of the static seed catalogue (#302)."""

from py._seed_locations import load_seed, nearest_seed, seed_in_country


class TestSeedCatalogue:
    def test_loaded_with_expected_places(self):
        slugs = {s["slug"] for s in load_seed()}
        assert len(slugs) == len(load_seed()) > 200
        assert {"harare", "phuket-th", "bangkok-th", "nairobi-ke"} <= slugs

    def test_country_lists_cities_first(self):
        th = seed_in_country("th")
        assert th and all(p["country"] == "TH" for p in th)
        assert th[0]["tags"] and "city" in th[0]["tags"]
        assert {"bangkok-th", "phuket-th"} <= {p["slug"] for p in th}
        assert all(p["source"] == "seed" for p in th)

    def test_unknown_or_blank_country_is_empty(self):
        assert seed_in_country("XX") == []
        assert seed_in_country("") == []

    def test_limit(self):
        assert len(seed_in_country("TH", limit=2)) == 2

    def test_nearest_within_range(self):
        hit = nearest_seed(7.89, 98.39, max_km=50)
        assert hit and hit["slug"] == "phuket-th"
        assert hit["distanceKm"] < 10

    def test_nearest_out_of_range_is_none(self):
        assert nearest_seed(0.0, -30.0, max_km=50) is None


class TestSeedMatching:
    def test_same_name_nearby_is_the_seed(self):
        from py._seed_locations import seed_matching

        assert seed_matching("phuket", 7.89, 98.39)["slug"] == "phuket-th"

    def test_other_name_or_far_is_none(self):
        from py._seed_locations import seed_matching

        assert seed_matching("Springfield", 7.89, 98.39) is None
        assert seed_matching("Phuket", 51.5, -0.1) is None
        assert seed_matching("", 7.89, 98.39) is None
