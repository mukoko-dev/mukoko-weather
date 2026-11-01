#!/usr/bin/env python3
"""Regenerate tests/fixtures/report-submit.json from the REAL Python.

The fixture is the oracle for ``weather_core::community::build_report`` (the
Rust Worker's report builder): for each request it holds what the Python
``submit_report`` stored. The Python route is deleted from the working tree,
so the source is taken from a PINNED git commit, never from the checkout:

    PINNED_COMMIT:api/py/   ->  a temporary directory  ->  imported and run

The commit is recorded in the fixture header (``_generated.commit``), and a
vitest (``src/lib/report-fixture.test.ts``) fails when the header and this
file disagree, so the "oracle" claim can be reproduced by anyone with the
repository history:

    python3 -I scripts/gen_report_submit_fixtures.py            # rewrite
    python3 -I scripts/gen_report_submit_fixtures.py --check    # compare only
    npx prettier@3.9.4 --check tests/fixtures/report-submit.json

It needs the full git history (``git archive`` of the pinned commit), and
``fastapi``, ``pydantic`` and ``bson`` (``requirements.txt``). ``pymongo`` is
replaced by an empty stand-in exactly as ``tests/py/conftest.py`` does, so no
database is touched. Nothing is read from the network.
"""

from __future__ import annotations

import asyncio
import io
import json
import subprocess
import sys
import tarfile
import tempfile
import types
from pathlib import Path
from unittest.mock import MagicMock, patch

#: The last commit on ``staging`` that still has ``api/py/_reports.py`` with
#: ``submit_report`` (the parent of the PR that ported it to the Worker).
PINNED_COMMIT = "4091aa3c69120077c38a753fcd7d98f6927d696b"

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "tests" / "fixtures" / "report-submit.json"

IP = "203.0.113.9"
HARARE = {"slug": "harare", "name": "Harare", "lat": -17.83, "lon": 31.05}


def _extract_pinned_python(dest: Path) -> None:
    """Unpack ``api/py`` as it was at PINNED_COMMIT into ``dest``."""
    archive = subprocess.run(
        ["git", "archive", "--format=tar", PINNED_COMMIT, "api/py"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    ).stdout
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(dest, filter="data")


def _import_pinned(dest: Path):
    """Import ``py._reports`` from the pinned tree, with pymongo stubbed."""
    for key in list(sys.modules):
        if key == "py" or key.startswith("py."):
            del sys.modules[key]
    pymongo = types.ModuleType("pymongo")
    pymongo.MongoClient = MagicMock
    pymongo.UpdateOne = MagicMock
    database = types.ModuleType("pymongo.database")
    database.Database = MagicMock
    errors = types.ModuleType("pymongo.errors")
    errors.DuplicateKeyError = type("DuplicateKeyError", (Exception,), {})
    errors.ConnectionFailure = type("ConnectionFailure", (Exception,), {})
    sys.modules.update(
        {"pymongo": pymongo, "pymongo.database": database, "pymongo.errors": errors}
    )
    sys.path.insert(0, str(dest / "api"))
    import py._reports as reports  # noqa: PLC0415 (after the path is set)

    return reports


def _spot_location(reports_mod, slug: str) -> dict:
    """The location the pinned resolver builds for a spot slug with no record."""
    from py._places_resolver import parse_spot_slug, spot_storage_key  # noqa: PLC0415

    spot = parse_spot_slug(slug)
    return {
        "slug": slug,
        "name": spot["name"] or "Selected location",
        "province": "",
        "lat": spot["lat"],
        "lon": spot["lon"],
        "elevation": None,
        "tags": [],
        "_id": spot_storage_key(slug),
    }


def _cases(reports_mod) -> list[dict]:
    return [
        {
            "name": "described mild rain, snapshot confirms",
            "request": {
                "locationSlug": "harare",
                "reportType": "light-rain",
                "severity": "mild",
                "description": "Light drizzle started.",
            },
            "location": HARARE,
            "current": {
                "temperature_2m": 25,
                "weather_code": 61,
                "precipitation": 0.5,
                "wind_speed_10m": 12,
                "relative_humidity_2m": 65,
            },
        },
        {
            "name": "no cached forecast: no snapshot, not verified",
            "request": {"locationSlug": "harare", "reportType": "clear-skies"},
            "location": HARARE,
            "current": None,
        },
        {
            "name": "unknown severity falls to moderate",
            "request": {
                "locationSlug": "harare",
                "reportType": "thunderstorm",
                "severity": "unknown-level",
            },
            "location": HARARE,
            "current": {
                "temperature_2m": 21.5,
                "weather_code": 95,
                "precipitation": 2.0,
                "wind_speed_10m": 30,
                "relative_humidity_2m": 80,
            },
        },
        {
            "name": "severe frost with a cold snapshot",
            "request": {
                "locationSlug": "harare",
                "reportType": "frost",
                "severity": "severe",
            },
            "location": HARARE,
            "current": {
                "temperature_2m": 1.5,
                "weather_code": 0,
                "precipitation": 0,
                "wind_speed_10m": 3,
                "relative_humidity_2m": 90,
            },
        },
        {
            "name": "snapshot with missing numbers reads as the defaults",
            "request": {"locationSlug": "harare", "reportType": "strong-wind"},
            "location": HARARE,
            "current": {"temperature_2m": 18, "weather_code": 3},
        },
        {
            "name": "a spot is stored by its cell, not its name",
            "request": {
                "locationSlug": "west-paddock--kqwy4dd7",
                "reportType": "fog",
                "severity": "moderate",
            },
            "location": _spot_location(reports_mod, "west-paddock--kqwy4dd7"),
            "current": {
                "temperature_2m": 12,
                "weather_code": 45,
                "precipitation": 0,
                "wind_speed_10m": 4,
                "relative_humidity_2m": 99,
            },
        },
        {
            "name": "client coordinates replace the place's",
            "request": {
                "locationSlug": "harare",
                "reportType": "hail",
                "lat": -17.9,
                "lon": 31.1,
            },
            "location": HARARE,
            "current": None,
        },
        {
            "name": "a description of exactly 300 characters is kept whole",
            "request": {
                "locationSlug": "harare",
                "reportType": "dust",
                "description": "d" * 300,
            },
            "location": HARARE,
            "current": None,
        },
        {
            "name": "301 characters is refused",
            "request": {
                "locationSlug": "harare",
                "reportType": "dust",
                "description": "d" * 301,
            },
            "location": HARARE,
            "current": None,
        },
        {
            "name": "an unknown report type is refused",
            "request": {"locationSlug": "harare", "reportType": "tornado"},
            "location": HARARE,
            "current": None,
        },
        {
            "name": "an unknown place is refused",
            "request": {"locationSlug": "nowhere-land", "reportType": "fog"},
            "location": None,
            "current": None,
        },
    ]


def _run(reports_mod, case: dict) -> dict:
    """Run the real ``submit_report`` for one case and record what it stored."""
    request = reports_mod.SubmitReportRequest(**case["request"])
    http = MagicMock(headers={}, client=MagicMock(host=IP))
    inserted: dict = {}

    def insert_one(doc):
        inserted.update(doc)
        return MagicMock(inserted_id="507f1f77bcf86cd799439011")

    cached = None if case["current"] is None else {"data": {"current": case["current"]}}
    with patch("py._reports.enforce_rate_limit", return_value=IP), patch(
        "py._reports.find_location", return_value=case["location"]
    ), patch("py._reports.weather_cache_collection") as cache, patch(
        "py._reports.weather_reports_collection"
    ) as reports:
        cache.return_value.find_one.return_value = cached
        reports.return_value.insert_one.side_effect = insert_one
        try:
            result = asyncio.run(reports_mod.submit_report(request, http))
        except Exception as exc:  # fastapi.HTTPException
            return {"error": {"status": exc.status_code, "detail": exc.detail}}
    keys = [
        "locationSlug",
        "locationName",
        "lat",
        "lon",
        "reportType",
        "severity",
        "description",
        "weatherSnapshot",
        "reportedBy",
        "verified",
    ]
    return {
        "doc": {k: inserted[k] for k in keys},
        "ttl": result["expiresIn"],
        "verified": result["verified"],
    }


def build() -> str:
    with tempfile.TemporaryDirectory() as tmp:
        dest = Path(tmp)
        _extract_pinned_python(dest)
        reports_mod = _import_pinned(dest)
        out = {
            "_generated": {
                "by": "scripts/gen_report_submit_fixtures.py",
                "commit": PINNED_COMMIT,
                "source": "api/py/_reports.py submit_report",
            },
            "ip": IP,
            "cases": [],
        }
        for case in _cases(reports_mod):
            entry = {k: case[k] for k in ("name", "request", "location", "current")}
            entry["expected"] = _run(reports_mod, case)
            out["cases"].append(entry)
    return json.dumps(out, indent=2, sort_keys=True) + "\n"


def main() -> int:
    text = build()
    if "--check" in sys.argv[1:]:
        if OUT.read_text() != text:
            print(f"{OUT.relative_to(ROOT)} differs from the pinned Python's output", file=sys.stderr)
            return 1
        print(f"{OUT.relative_to(ROOT)} matches {PINNED_COMMIT[:10]}")
        return 0
    OUT.write_text(text)
    print(f"wrote {OUT.relative_to(ROOT)} from {PINNED_COMMIT[:10]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
