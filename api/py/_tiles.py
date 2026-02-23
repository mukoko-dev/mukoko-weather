"""
Map tile proxy — migrated from /api/map-tiles.

Proxies weather map tiles from Tomorrow.io, keeping the API key server-side.
"""

from __future__ import annotations

import re
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from ._db import get_api_key

router = APIRouter()

VALID_LAYERS = {
    "precipitationIntensity",
    "temperature",
    "windSpeed",
    "cloudCover",
    "humidity",
}

TOMORROW_TILE_ORIGIN = "https://api.tomorrow.io"
TIMESTAMP_RE = re.compile(r"^(?:now|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$")

_http_client: Optional[httpx.Client] = None


def _get_http() -> httpx.Client:
    global _http_client
    if _http_client is None:
        _http_client = httpx.Client(timeout=8.0)
    return _http_client


@router.get("/api/py/map-tiles")
async def proxy_map_tile(
    z: int,
    x: int,
    y: int,
    layer: str,
    timestamp: str = "now",
):
    """
    GET /api/py/map-tiles?z=5&x=18&y=17&layer=precipitationIntensity

    Proxy weather map tiles from Tomorrow.io.
    SSRF protection: pinned origin, whitelist layers, range-checked coords.
    """
    if layer not in VALID_LAYERS:
        raise HTTPException(status_code=400, detail="Invalid layer")

    if z < 1 or z > 12:
        raise HTTPException(status_code=400, detail="Zoom out of range")

    if not TIMESTAMP_RE.match(timestamp):
        raise HTTPException(status_code=400, detail="Invalid timestamp")

    try:
        api_key = get_api_key("tomorrow")
        if not api_key:
            raise HTTPException(status_code=503, detail="Map service unavailable")

        tile_url = f"{TOMORROW_TILE_ORIGIN}/v4/map/tile/{z}/{x}/{y}/{layer}/{timestamp}.png?apikey={api_key}"

        client = _get_http()
        resp = client.get(tile_url)

        if resp.status_code == 429:
            return Response(status_code=429)

        if resp.status_code != 200:
            return Response(status_code=resp.status_code)

        return Response(
            content=resp.content,
            media_type="image/png",
            headers={
                "Cache-Control": "public, max-age=300, s-maxage=300",
                "X-Map-Layer": layer,
            },
        )
    except HTTPException:
        raise
    except Exception:
        return Response(status_code=502)
