"""weather_cache grid key (issue #252): coordinate cells, not nearest places.

The Rust forecast Worker derives the same key (`weather_core::geo::cache_key`),
pinned to the same fixture.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from py._weather_cache_key import (
    GRID_DEG,
    KEY_PREFIX,
    weather_cache_key,
    weather_cache_key_for,
)

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "weather-cache-keys.json"


def _haversine_km(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (
        math.sin((p2 - p1) / 2) ** 2
        + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    )
    return 2 * 6371 * math.asin(math.sqrt(a))


class TestKeyFunction:
    def test_shared_vectors(self):
        """Same vectors as src/lib/weather-cache-key.test.ts (reader/writer parity)."""
        fx = json.loads(FIXTURE.read_text())
        assert fx["gridDeg"] == GRID_DEG
        assert len(fx["vectors"]) >= 10
        for v in fx["vectors"]:
            assert weather_cache_key(v["lat"], v["lon"]) == v["key"], v

    def test_prefix_keeps_new_keys_disjoint_from_legacy(self):
        """Legacy rows were keyed by place slugs (SLUG_RE) or the raw
        ``{lat:.2f}_{lon:.2f}`` fallback; no new key can equal either, so a
        legacy row is never read under a new key while it waits to expire."""
        from py._db import SLUG_RE

        for lat, lon in [(-17.83, 31.05), (0, 0), (-90, -180), (24.86, 67.01)]:
            key = weather_cache_key(lat, lon)
            assert key.startswith(KEY_PREFIX)
            assert not SLUG_RE.match(key)
            assert key != f"{lat:.2f}_{lon:.2f}"

    def test_reported_mismatches_now_get_their_own_rows(self):
        """Prod rows seen in #252: each request and the place its old key
        named now map to different cells."""
        pairs = [
            ((24.86, 67.01), (11.28, 49.18)),  # Karachi vs Bosaso
            ((50.1112, 8.6831), (37.29042, 9.855)),  # Frankfurt vs Bizerte
            ((23.92298, 90.71768), (1.44124, 103.80205)),  # Bangladesh vs Singapore
            ((41.85003, -87.65005), (42.31284, -88.4227)),  # Chicago vs 82 km away
        ]
        for a, b in pairs:
            assert weather_cache_key(*a) != weather_cache_key(*b)

    def test_far_apart_coordinates_never_share_a_row(self):
        """Any two points more than one cell diagonal apart get distinct keys."""
        import random

        rng = random.Random(252)
        max_cell_km = _haversine_km(0, 0, GRID_DEG, GRID_DEG)
        for _ in range(5000):
            a = (rng.uniform(-89, 89), rng.uniform(-179.9, 179.9))
            b = (rng.uniform(-89, 89), rng.uniform(-179.9, 179.9))
            if _haversine_km(*a, *b) > max_cell_km:
                assert weather_cache_key(*a) != weather_cache_key(*b)

    def test_nearby_requests_in_one_cell_share_a_row(self):
        # GPS jitter, the page coordinate and the client refresh for Harare.
        keys = {
            weather_cache_key(-17.8292, 31.0522),
            weather_cache_key(-17.8300, 31.0500),
            weather_cache_key(-17.8350, 31.0600),
            weather_cache_key(-17.8400, 31.0400),
        }
        assert keys == {"cell:-17.85_31.05"}

    def test_cell_is_at_most_a_few_km(self):
        # Points in one cell are within one cell diagonal (~7.9 km at the equator).
        assert _haversine_km(0, 0, GRID_DEG, GRID_DEG) < 8

    def test_antimeridian_and_poles(self):
        assert weather_cache_key(10, 180) == weather_cache_key(10, -180)
        assert weather_cache_key(90, 0) == "cell:90.00_0.00"
        assert weather_cache_key(-90, 0) == "cell:-90.00_0.00"

    def test_no_negative_zero(self):
        assert weather_cache_key(-0.01, -0.01) == "cell:0.00_0.00"

    def test_key_for_location(self):
        assert weather_cache_key_for({"lat": -17.83, "lon": 31.05}) == "cell:-17.85_31.05"
        assert weather_cache_key_for(None) is None
        assert weather_cache_key_for({"slug": "x"}) is None
        assert weather_cache_key_for({"lat": None, "lon": 1}) is None
