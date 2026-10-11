"""The shared location-profile helper.

One import path for every consumer of place knowledge (``_place_knowledge.py``
holds the implementation):

    from ._location_profile import get_location_profile, profile_prompt_block

``get_location_profile(slug=..., lat=..., lon=..., country=...)`` returns a
:class:`LocationProfile` (or ``None``). It never waits on an upstream by
default (``allow_build=False``): it serves the stored document, or a
cache-only partial while a full build runs in the background. The model
dumps to the flat shape ``_agriculture.load_location_profile`` reads::

    {
      "season": {"name", "localName", "description", ...},
      "crops": [{"id": "crop-farming", "label", "phase", "calendar": {stage: [month, ...]}}],
      "normals": {"high", "low"},
      "koppen": "Cwb",
      "enso": {"phase", "oni"},
    }

plus the full stored groups (``seasons``, ``agriculture``, ``climate``,
``soil``, ``provenance``) and ``current`` (computed at read time).
"""

from __future__ import annotations

from ._place_knowledge import (  # noqa: F401 — the public surface
    LocationProfile,
    PROFILE_GROUNDING_RULE,
    get_location_profile,
    profile_block_for,
    profile_block_sync,
    profile_prompt_block,
    with_profile,
)

__all__ = [
    "LocationProfile",
    "PROFILE_GROUNDING_RULE",
    "get_location_profile",
    "profile_block_for",
    "profile_block_sync",
    "profile_prompt_block",
    "with_profile",
]
