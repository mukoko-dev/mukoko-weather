#!/usr/bin/env python3
"""Backfill place knowledge for places that already exist (#277).

New places get their knowledge built when they are created, and existing
places get it lazily on first load. This script covers the rest: it walks
`places.placesGeo` (city, town and village records) and builds a profile for
each place that has none in `places.placeKnowledge`.

    python3 scripts/backfill_place_knowledge.py                    # plan: counts only, changes nothing
    python3 scripts/backfill_place_knowledge.py --country ZW       # plan for one country
    python3 scripts/backfill_place_knowledge.py --apply --limit 50 # build 50 (then re-run for more)

Safe to re-run and to stop at any time: a place with a fresh profile is
skipped. Writes happen only with `--apply`, and only once the collection
exists (it is created by nyuchi/api-gateway `scripts/places_knowledge_validators.py`;
until then `--apply` reports that and writes nothing). A build is one
Open-Meteo archive request per 0.25 degree cell plus one SoilGrids call, so
`--sleep` (seconds between builds, default 1.5) keeps it under the free
tier's limits. Needs MONGODB_URI. Prints counts and opaque ids only.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path
from typing import Iterator, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

from py import _place_knowledge as pk  # noqa: E402
from py._db import places_geo_collection  # noqa: E402
from py._places_geo import get_country_id  # noqa: E402
from py._places_resolver import get_country_iso  # noqa: E402

GEO_TYPES = ["city", "town", "village"]


def candidates(country: Optional[str] = None) -> Iterator[dict]:
    """Place dicts (the builder's input) for every placesGeo place."""
    query: dict = {"geoType": {"$in": GEO_TYPES}}
    if country:
        # `isoCode` is a denormalised convenience that platform-seeded places
        # may lack; their country is the `parentPlaceId` document, which is
        # also how the resolver finds it.
        iso = country.upper()
        parent = get_country_id(iso)
        query["$or"] = [{"isoCode": iso}] + ([{"parentPlaceId": parent}] if parent else [])
    for doc in places_geo_collection().find(query):
        coords = (doc.get("geo") or {}).get("coordinates") or []
        if len(coords) < 2:
            continue
        prov = doc.get("sourceProvenance") or {}
        yield {
            "id": doc["_id"],
            "collection": "placesGeo",
            "name": doc.get("name"),
            "lat": coords[1],
            "lon": coords[0],
            "country": (doc.get("isoCode") or get_country_iso(doc.get("parentPlaceId")) or "").upper() or None,
            "admin1": prov.get("mukokoProvince"),
            "elevation": prov.get("mukokoElevation"),
        }


def needs_build(place: dict) -> bool:
    stored = pk.read_knowledge(place["id"])
    return stored is None or pk.is_stale(stored)


def run(*, apply: bool, limit: int, country: Optional[str], sleep_s: float) -> dict:
    ready = pk.collection_ready()
    summary = {"seen": 0, "to_build": 0, "built": 0, "skipped_no_country": 0, "collection_ready": ready}
    for place in candidates(country):
        summary["seen"] += 1
        if not place.get("country"):
            summary["skipped_no_country"] += 1
            continue
        if ready and not needs_build(place):
            continue
        summary["to_build"] += 1
        if not apply or not ready or summary["built"] >= limit:
            continue
        doc = pk.build_and_store(place)
        if doc and doc.get("_stored"):
            summary["built"] += 1
        time.sleep(sleep_s)
    return summary


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--apply", action="store_true", help="build and store (default: plan only)")
    parser.add_argument("--limit", type=int, default=100, help="most places to build in one run")
    parser.add_argument("--country", help="ISO 3166-1 alpha-2 code to restrict to")
    parser.add_argument("--sleep", type=float, default=1.5, help="seconds between builds")
    args = parser.parse_args(argv)
    summary = run(apply=args.apply, limit=args.limit, country=args.country, sleep_s=args.sleep)
    print(summary)
    if not summary["collection_ready"]:
        print("places.placeKnowledge does not exist yet: nothing is written until the owner creates it "
              "(nyuchi/api-gateway scripts/places_knowledge_validators.py).")
    elif not args.apply:
        print("Plan only. Re-run with --apply to build.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
