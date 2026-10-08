"""
Shared, process-wide ``httpx.Client`` instances keyed by timeout.

Vercel functions stay warm for minutes, so one pooled client per timeout
reuses TCP/TLS connections across requests instead of paying a handshake on
every upstream call. Callers that need per-request headers pass them to the
request itself; the clients are deliberately header-free so they can be shared.

Never close these clients: they live for the life of the process.
"""

from __future__ import annotations

import threading

import httpx

_clients: dict[float, httpx.Client] = {}
_lock = threading.Lock()


def get_http_client(timeout: float) -> httpx.Client:
    """Return the shared sync client for ``timeout`` seconds, creating it once."""
    client = _clients.get(timeout)
    if client is None:
        with _lock:
            client = _clients.get(timeout)
            if client is None:
                client = httpx.Client(timeout=timeout)
                _clients[timeout] = client
    return client
