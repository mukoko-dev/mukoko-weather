"""Canonical slugs for Python (#317): the mirror of ``src/lib/slug-migration.ts``.

Every shipped seed place has one legacy slug (``harare``, ``nairobi-ke``) and
one canonical slug (``harare--ksy4dd1``, ``{name}--{geohash7}``). The pinned
pairs live in ``data/slug_migration.json``, a generated copy of
``src/lib/slug-migration-data.ts`` (``src/lib/slug-migration.test.ts`` pins
the two; regenerate with ``workers/scripts/gen-seed-locations.mjs``).

The backend accepts BOTH spellings of a seed and keys durable data (weather
history, community reports, AI caches) by the LEGACY slug: that is where all
existing data lives, so moving the URL never splits or loses it.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

_DATA_PATH = Path(__file__).parent / "data" / "slug_migration.json"


@lru_cache(maxsize=1)
def _tables() -> tuple[dict[str, str], dict[str, str]]:
    """(legacy -> canonical, canonical -> legacy), read once per process."""
    try:
        with _DATA_PATH.open(encoding="utf-8") as fh:
            rows = json.load(fh)
    except (OSError, ValueError):
        return {}, {}
    to_canonical = {r["legacy"]: r["canonical"] for r in rows}
    to_legacy = {r["canonical"]: r["legacy"] for r in rows}
    return to_canonical, to_legacy


def canonical_slug(slug: str) -> str:
    """The canonical slug for ``slug``: a legacy seed slug is mapped, any
    other slug is returned unchanged. Idempotent."""
    return _tables()[0].get(slug, slug)


def storage_key_slug(slug: str) -> str:
    """The key durable data is stored under: a canonical seed slug maps back
    to its legacy slug, any other slug is its own key. Idempotent."""
    return _tables()[1].get(slug, slug)


def is_canonical_seed_slug(slug: str) -> bool:
    return slug in _tables()[1]
