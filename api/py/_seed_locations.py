"""The static seed catalogue, for Python (#302).

``src/lib/locations.ts`` (+ ``locations-global.ts``) is the source of truth
for the shipped seed places (Harare, Bangkok, Phuket ...). Python had no copy,
so a country placesGeo holds no cities for (Thailand) listed nothing in search,
and the find-only geo lookup could not tell that a coordinate sits in Phuket.

``data/seed_locations.json`` is a generated copy: slug, name, country,
province, lat, lon, elevation, tags. ``src/lib/seed-catalogue-parity.test.ts``
pins it to the TypeScript source and regenerates it
(``UPDATE_SEED_JSON=1``), so the two cannot drift.
"""

from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path

_DATA_PATH = Path(__file__).parent / "data" / "seed_locations.json"


@lru_cache(maxsize=1)
def load_seed() -> tuple[dict, ...]:
    """Every seed place, as stored (read once per process)."""
    try:
        with _DATA_PATH.open(encoding="utf-8") as fh:
            return tuple(json.load(fh))
    except (OSError, ValueError):
        return ()


def _as_location(seed: dict) -> dict:
    """A seed row in the shape the search endpoint returns for a place."""
    return {
        "slug": seed["slug"],
        "name": seed["name"],
        "province": seed.get("province", ""),
        "lat": seed["lat"],
        "lon": seed["lon"],
        "elevation": seed.get("elevation"),
        "tags": list(seed.get("tags") or []),
        "country": seed.get("country") or None,
        "source": "seed",
    }


def seed_by_slug(slug: str) -> dict | None:
    """The seed place whose LEGACY slug is ``slug`` (``harare``), else None."""
    for s in load_seed():
        if s.get("slug") == slug:
            return _as_location(s)
    return None


def seed_in_country(iso: str, *, limit: int = 200) -> list[dict]:
    """Seed places in ``iso``, cities first, then by name."""
    code = (iso or "").strip().upper()
    if not code:
        return []
    rows = [s for s in load_seed() if (s.get("country") or "").upper() == code]
    rows.sort(key=lambda s: ("city" not in (s.get("tags") or []), s["name"]))
    return [_as_location(s) for s in rows[: max(1, limit)]]


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371.0088 * 2 * math.asin(min(1.0, math.sqrt(a)))


def nearest_seed(lat: float, lon: float, *, max_km: float = 50.0) -> dict | None:
    """The closest seed place within ``max_km`` of the point, else None.

    The returned dict carries ``distanceKm``.
    """
    best: tuple[float, dict] | None = None
    for s in load_seed():
        try:
            km = _haversine_km(lat, lon, float(s["lat"]), float(s["lon"]))
        except (KeyError, TypeError, ValueError):
            continue
        if km <= max_km and (best is None or km < best[0]):
            best = (km, s)
    if best is None:
        return None
    loc = _as_location(best[1])
    loc["distanceKm"] = round(best[0], 1)
    return loc


def seed_matching(name: str, lat: float, lon: float, *, max_km: float = 25.0) -> dict | None:
    """The seed place with this name (case-insensitive) within ``max_km`` of
    the point, else None: a geocoder hit for a shipped city is that city."""
    wanted = " ".join((name or "").lower().split())
    if not wanted:
        return None
    best: tuple[float, dict] | None = None
    for s in load_seed():
        if " ".join(str(s.get("name", "")).lower().split()) != wanted:
            continue
        try:
            km = _haversine_km(float(lat), float(lon), float(s["lat"]), float(s["lon"]))
        except (KeyError, TypeError, ValueError):
            continue
        if km <= max_km and (best is None or km < best[0]):
            best = (km, s)
    return _as_location(best[1]) if best else None
