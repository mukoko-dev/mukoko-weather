"""Where the Open-Meteo forecast and air-quality calls go.

By default every call goes to the public Open-Meteo API, exactly as before.
Setting the env vars below points the calls at our own self-hosted Open-Meteo
(``infra/open-meteo/``) with no other code change:

- ``OPEN_METEO_BASE_URL`` — origin of the self-hosted forecast API, e.g.
  ``https://om.example.com``. ``/v1/forecast`` is appended.
- ``OPEN_METEO_AQ_BASE_URL`` — origin of the self-hosted air-quality API
  (CAMS). ``/v1/air-quality`` is appended. It is set on its own so the
  forecast can move first while air quality stays on the public API.
- ``OPEN_METEO_API_KEY`` — the key the self-hosted gateway checks, sent in
  the :data:`KEY_HEADER` header. The header name is fixed because the
  gateway's matcher and its log redaction are written for exactly this name.

The key is only ever sent to a host we run (never to an ``open-meteo.com``
host) and travels in a header, never in the URL, so it cannot reach a log
line.

The ERA5 archive (history backfill, climate normals), geocoding and the
elevation lookup are deliberately NOT covered here: the self-hosted instance
serves forecasts, the minutely nowcast and CAMS air quality only.

Env is read on every call (no import-time snapshot), so tests and a warm
serverless instance both see the current values.
"""

from __future__ import annotations

import logging
import os
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

PUBLIC_FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
PUBLIC_AIR_QUALITY_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"

FORECAST_PATH = "/v1/forecast"
AIR_QUALITY_PATH = "/v1/air-quality"

#: Must match ``infra/open-meteo/gateway/Caddyfile``.
KEY_HEADER = "X-Mukoko-OM-Key"

_PUBLIC_DOMAIN = "open-meteo.com"
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}

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
    if parts.scheme != "https" and not (parts.scheme == "http" and host in _LOCAL_HOSTS):
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
    """True unless ``url`` points at an Open-Meteo-run host.

    Decided by hostname, not string equality, so a differently cased or
    differently spelled public URL can never be mistaken for ours.
    """
    host = (urlsplit(url).hostname or "").lower()
    return not (host == _PUBLIC_DOMAIN or host.endswith("." + _PUBLIC_DOMAIN))


def headers_for(url: str) -> dict[str, str]:
    """Request headers for a call to ``url``.

    Empty for any Open-Meteo host, so the key never leaves for a host we do
    not run. For a self-hosted URL it carries the gateway key when one is set.
    """
    if not is_self_hosted(url):
        return {}
    key = (os.environ.get("OPEN_METEO_API_KEY") or "").strip()
    return {KEY_HEADER: key} if key else {}


def forecast() -> tuple[str, dict[str, str]]:
    """``(url, headers)`` for one forecast call."""
    url = forecast_url()
    return url, headers_for(url)


def air_quality() -> tuple[str, dict[str, str]]:
    """``(url, headers)`` for one air-quality call."""
    url = air_quality_url()
    return url, headers_for(url)


def forecast_is_self_hosted() -> bool:
    return is_self_hosted(forecast_url())


def air_quality_is_self_hosted() -> bool:
    return is_self_hosted(air_quality_url())
