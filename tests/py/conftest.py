"""Shared test fixtures for Python backend tests."""

from __future__ import annotations

import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

# ---------------------------------------------------------------------------
# Path setup — must run before any other imports that reference `py.*`
#
# The installed `py.py` module (/usr/local/lib/…/py.py) shadows our
# `api/py/` package.  Remove it from sys.modules so Python finds our
# package first via the sys.path entry we insert below.
# ---------------------------------------------------------------------------

_api_root = Path(__file__).resolve().parent.parent.parent / "api"
if str(_api_root) not in sys.path:
    sys.path.insert(0, str(_api_root))

# Evict the installed `py` module (single-file, not a package) so that
# `from py._chat import ...` resolves to `api/py/_chat.py`.
for _key in list(sys.modules.keys()):
    if _key == "py" or _key.startswith("py."):
        del sys.modules[_key]

# ---------------------------------------------------------------------------
# Mock heavy dependencies that may not compile in all CI environments
# (e.g. pymongo needs cryptography + cffi which fails in some containers).
# We only unit-test business logic — not MongoDB connectivity.
# ---------------------------------------------------------------------------

# Build a fake pymongo package with the submodules that _db.py imports
_mock_pymongo = types.ModuleType("pymongo")
_mock_pymongo.MongoClient = MagicMock  # type: ignore[attr-defined]
_mock_pymongo.UpdateOne = MagicMock  # type: ignore[attr-defined]

_mock_pymongo_database = types.ModuleType("pymongo.database")
_mock_pymongo_database.Database = MagicMock  # type: ignore[attr-defined]

# pymongo.errors — real exception classes that _devices.py and index.py import
_mock_pymongo_errors = types.ModuleType("pymongo.errors")


class _DuplicateKeyError(Exception):
    pass


class _ConnectionFailure(Exception):
    pass


_mock_pymongo_errors.DuplicateKeyError = _DuplicateKeyError  # type: ignore[attr-defined]
_mock_pymongo_errors.ConnectionFailure = _ConnectionFailure  # type: ignore[attr-defined]

# Force-replace (the real pymongo may already be loaded but broken)
sys.modules["pymongo"] = _mock_pymongo
sys.modules["pymongo.database"] = _mock_pymongo_database
sys.modules["pymongo.errors"] = _mock_pymongo_errors


# ---------------------------------------------------------------------------
# Now safe to import from our api/py package
# ---------------------------------------------------------------------------

import pytest  # noqa: E402
from fastapi import Request  # noqa: E402


@pytest.fixture(autouse=True)
def _no_overpass_network(monkeypatch):
    """Keep Overpass off the network in every test.

    `_locations._reverse_geocode` now tries Overpass before Nominatim. Tests
    that patch `py._locations._get_http` do not cover `py._overpass._get_http`,
    so without this the suite makes real HTTP calls — slow, flaky, and dependent
    on a public community endpoint.

    Defaulting it to unreachable means the existing Nominatim-path assertions
    keep testing exactly what they did before. Tests that want the Overpass path
    patch `py._overpass._get_http` themselves, which overrides this.
    """
    try:
        from py import _overpass
    except Exception:  # pragma: no cover - module always importable in practice
        return

    def _unavailable():
        raise RuntimeError("Overpass disabled in tests")

    monkeypatch.setattr(_overpass, "_get_http", _unavailable)


@pytest.fixture(autouse=True)
def _no_place_knowledge_side_effects(monkeypatch):
    """Keep place-knowledge lookups off the network and off background threads.

    The AI endpoints now ask `_place_knowledge.profile_block_for` for a profile
    block (#277). Against the mocked pymongo that lookup must never reach
    SoilGrids or the Open-Meteo archive, and must never start a background
    build thread. Tests of the module itself override these patches.
    """
    try:
        from py import _place_knowledge as pk
    except Exception:  # pragma: no cover - module always importable in practice
        return

    def _soil_unavailable():
        raise RuntimeError("SoilGrids disabled in tests")

    monkeypatch.setattr(pk, "_get_soil_http", _soil_unavailable)
    monkeypatch.setattr(pk, "schedule_knowledge_build", lambda place: False)
    monkeypatch.setitem(pk._collection_state, "ready", False)
    monkeypatch.setitem(pk._collection_state, "checked", float("inf"))


@pytest.fixture
def mock_request():
    """Create a mock FastAPI Request with configurable headers and client."""

    def _make(
        ip: str | None = "203.0.113.42",
        forwarded_for: str | None = None,
        real_ip: str | None = None,
    ) -> Request:
        headers: dict[str, str] = {}
        if forwarded_for:
            headers["x-forwarded-for"] = forwarded_for
        if real_ip:
            headers["x-real-ip"] = real_ip

        req = MagicMock(spec=Request)
        req.headers = headers
        if ip:
            req.client = MagicMock()
            req.client.host = ip
        else:
            req.client = None
        return req

    return _make
