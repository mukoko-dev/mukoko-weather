"""Geohash encoding — Python mirror of ``src/lib/geohash.ts``.

Kept deliberately small: the backend only ever needs to *mint* a slug when it
creates a place. Decoding happens in TypeScript on the render path, where the
coordinate is actually used.

Both implementations are pinned to the same published reference vectors (see
``tests/py/test_geohash.py`` and ``src/lib/geohash.test.ts``), so a slug minted
here always decodes to the same box there. If you change one, change both.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Optional

# Base-32 alphabet, excluding a/i/l/o to avoid look-alike confusion.
_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz"

# 7 characters ≈ a 153 m × 153 m box. Matches DEFAULT_GEOHASH_PRECISION in
# src/lib/geohash.ts — the two must agree or minted slugs decode to a different
# sized cell than the front end expects.
DEFAULT_PRECISION = 7

# Separator between name and geohash. Mirrors SMART_SLUG_DELIMITER in
# src/lib/smart-slug.ts. Must be two dashes: slugification collapses runs of
# non-alphanumerics to one dash, so `--` cannot occur inside a generated name,
# which is what makes parsing unambiguous.
SMART_SLUG_DELIMITER = "--"

MAX_NAME_LENGTH = 60


def encode_geohash(lat: float, lon: float, precision: int = DEFAULT_PRECISION) -> str:
    """Encode a WGS 84 coordinate to a geohash.

    Returns "" for unusable input rather than raising — a bad coordinate must
    not be able to abort a location creation.
    """
    try:
        lat = float(lat)
        lon = float(lon)
    except (TypeError, ValueError):
        return ""

    if lat != lat or lon != lon:  # NaN
        return ""
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return ""

    length = max(1, min(12, int(precision)))

    lat_min, lat_max = -90.0, 90.0
    lon_min, lon_max = -180.0, 180.0

    out: list[str] = []
    bits = 0
    bit_count = 0
    is_lon = True  # Longitude is encoded first, then alternating.

    while len(out) < length:
        if is_lon:
            mid = (lon_min + lon_max) / 2
            if lon >= mid:
                bits = (bits << 1) | 1
                lon_min = mid
            else:
                bits <<= 1
                lon_max = mid
        else:
            mid = (lat_min + lat_max) / 2
            if lat >= mid:
                bits = (bits << 1) | 1
                lat_min = mid
            else:
                bits <<= 1
                lat_max = mid
        is_lon = not is_lon

        bit_count += 1
        if bit_count == 5:
            out.append(_BASE32[bits])
            bits = 0
            bit_count = 0

    return "".join(out)


def slugify_name(name: str) -> str:
    """Slugify a place name. Mirrors ``slugifyName`` in src/lib/smart-slug.ts."""
    if not name:
        return ""
    ascii_name = (
        unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    )
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")
    return slug[:MAX_NAME_LENGTH].rstrip("-")


def build_smart_slug(
    name: str,
    lat: float,
    lon: float,
    precision: int = DEFAULT_PRECISION,
) -> str:
    """Build a ``{name}--{geohash}`` slug for a named coordinate.

    Deterministic: the same name at the same coordinate always yields the same
    slug. That is the property the old random hex suffix lacked — two
    simultaneous requests for one new place now converge on a single URL rather
    than racing to mint rival records.

    Returns "" when the coordinate is unusable, so callers can fall back to a
    legacy name-and-country slug instead of emitting a URL that decodes nowhere.
    """
    geohash = encode_geohash(lat, lon, precision)
    if not geohash:
        return ""
    prefix = slugify_name(name) or "place"
    return f"{prefix}{SMART_SLUG_DELIMITER}{geohash}"


# ---------------------------------------------------------------------------
# Place slugs — identity from the map, not from the coordinate
# ---------------------------------------------------------------------------

#: Prefix marking a map-feature ref in a slug. Contains an ``o``, which the
#: geohash alphabet excludes, so a place ref and a geohash can never be
#: confused for one another and no discriminator flag is needed.
OSM_REF_PREFIX = "osm-"

_OSM_REF_RE = re.compile(r"^([nwr])([0-9]{1,19})$")


def normalise_osm_ref(ref: str) -> Optional[str]:
    """Canonicalise an OSM ref (``"W890123"`` -> ``"w890123"``), else None.

    A leading zero is rejected: it would spell one feature two ways, and two
    spellings of an id is two identities for one place.
    """
    if not ref:
        return None
    match = _OSM_REF_RE.match(ref.strip().lower())
    if not match:
        return None
    letter, digits = match.groups()
    if len(digits) > 1 and digits.startswith("0"):
        return None
    return f"{letter}{digits}"


def build_place_slug(name: str, osm_ref: str) -> str:
    """Build ``{name}--osm-{ref}`` for a named feature the map already knows.

    Preferred over :func:`build_smart_slug` whenever a ref is available: the
    identity then belongs to the map, so it survives GPS jitter and later name
    improvements, and two adjacent features stay two places. Returns "" when the
    ref is unusable so callers fall back to a coordinate slug.
    """
    canonical = normalise_osm_ref(osm_ref)
    if not canonical:
        return ""
    prefix = slugify_name(name) or "place"
    return f"{prefix}{SMART_SLUG_DELIMITER}{OSM_REF_PREFIX}{canonical}"
