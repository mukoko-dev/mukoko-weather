"""Where the Open-Meteo forecast and air-quality calls go.

By default every call goes to the public Open-Meteo API, exactly as before.
Setting the env vars below points the calls at our own self-hosted Open-Meteo
(``infra/open-meteo/``) with no other code change:

- ``OPEN_METEO_BASE_URL`` — origin of the self-hosted forecast API, e.g.
  ``https://om.example.com``. ``/v1/forecast`` is appended.
- ``OPEN_METEO_AQ_BASE_URL`` — origin of the self-hosted air-quality API
  (CAMS). ``/v1/air-quality`` is appended. It is set on its own so the
  forecast can move first while air quality stays on the public API.
- ``OPEN_METEO_API_KEY`` — the key the self-hosted gateway checks.
- ``OPEN_METEO_API_KEY_HEADER`` — the header that carries it
  (default ``X-Mukoko-OM-Key``).

The key is only ever sent to a host we configured, never to the public API,
and travels in a header, never in the URL (so it cannot reach a log line).

The ERA5 archive (history backfill, climate normals), geocoding and the
elevation lookup are deliberately NOT covered here: the self-hosted instance
serves forecasts, the minutely nowcast and CAMS air quality only.

Env is read on every call (no import-time snapshot), so tests and a warm
serverless instance both see the current values.
"""

from __future__ import annotations

import logging
import os
import re
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

PUBLIC_FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
PUBLIC_AIR_QUALITY_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"

FORECAST_PATH = "/v1/forecast"
AIR_QUALITY_PATH = "/v1/air-quality"

DEFAULT_KEY_HEADER = "X-Mukoko-OM-Key"
_HEADER_NAME_RE = re.compile(r"^[A-Za-z0-9-]{1,64}$")

_warned: set[str] = set()


def _warn_once(var: str, reason: str) -> None:
    if var in _warned:
        return
    _warned.add(var)
    # Never log the value: it may be a URL with credentials in it.
    logger.warning("Open-Meteo config: %s ignored (%s)", var, reason)


def _configured_base(var: str) -> str | None:
    """The validated origin (plus optional path prefix) from ``var``, or None.

    Only ``https://`` is accepted, plus ``http://`` for localhost so the
    compose stack can be tested locally. Anything else falls back to the
    public API rather than sending traffic (and the key) somewhere odd.
    """
    raw = (os.environ.get(var) or "").strip()
    if not raw:
        return None
    try:
        parts = urlsplit(raw)
    except ValueError:
        _warn_once(var, "not a URL")
        return None
    host = parts.hostname or ""
    local = host in {"localhost", "127.0.0.1", "::1"}
    if parts.scheme != "https" and not (parts.scheme == "http" and local):
        _warn_once(var, "must be https")
        return None
    if not host or parts.query or parts.fragment or parts.username or parts.password:
        _warn_once(var, "must be a bare origin with no query, fragment or credentials")
        return None
    return raw.rstrip("/")


def _url(var: str, path: str, public: str) -> str:
    base = _configured_base(var)
    if base is None:
        return public
    # Accept a value that already ends in the endpoint path.
    return base if base.endswith(path) else base + path


def forecast_url() -> str:
    """URL of the forecast endpoint (``/v1/forecast``)."""
    return _url("OPEN_METEO_BASE_URL", FORECAST_PATH, PUBLIC_FORECAST_URL)


def air_quality_url() -> str:
    """URL of the air-quality endpoint (``/v1/air-quality``)."""
    return _url("OPEN_METEO_AQ_BASE_URL", AIR_QUALITY_PATH, PUBLIC_AIR_QUALITY_URL)


def is_self_hosted(url: str) -> bool:
    """True when ``url`` is one of our configured self-hosted endpoints."""
    return url not in (PUBLIC_FORECAST_URL, PUBLIC_AIR_QUALITY_URL)


def headers_for(url: str) -> dict[str, str]:
    """Request headers for a call to ``url``.

    Empty for the public API, so the key never leaves for a host we do not
    run. For a self-hosted URL it carries the gateway key when one is set.
    """
    if not is_self_hosted(url):
        return {}
    key = (os.environ.get("OPEN_METEO_API_KEY") or "").strip()
    if not key:
        return {}
    name = (os.environ.get("OPEN_METEO_API_KEY_HEADER") or "").strip() or DEFAULT_KEY_HEADER
    if not _HEADER_NAME_RE.match(name):
        _warn_once("OPEN_METEO_API_KEY_HEADER", "not a valid header name")
        name = DEFAULT_KEY_HEADER
    return {name: key}


def source_label(url: str) -> str:
    """``self-hosted`` or ``public`` — for the status page, never the URL."""
    return "self-hosted" if is_self_hosted(url) else "public"
