"""Tests for _verification.py — per-model forecast capture (issue #246)."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

from py._verification import LEAD_HOURS, build_verification_doc, capture


def _raw(n=80):
    return {
        "utc_offset_seconds": 7200,
        "hourly": {
            "time": [f"h{i}" for i in range(n)],
            "temperature_2m_ecmwf_ifs": [20.0 + i * 0.1 for i in range(n)],
            "temperature_2m_gfs_seamless": [21.0] * n,
            "precipitation_ecmwf_ifs": [0.0] * n,
        },
    }


NOW = datetime(2026, 10, 10, 9, 40, tzinfo=timezone.utc)


class TestBuildDoc:
    def test_captures_members_and_blend_at_leads(self):
        blended = {"temperature_2m": [20.5] * 80}
        doc = build_verification_doc("harare", -17.83, 31.05, "southern-africa",
                                     {"ecmwf_ifs": 0.6, "gfs_seamless": 0.4}, _raw(), blended, 2, NOW)
        assert doc["_id"] == "harare:2026101006"  # 6-hour issuance bucket
        assert set(doc["leads"]) == {str(h) for h in LEAD_HOURS}
        lead24 = doc["leads"]["24"]
        assert lead24["validAtLocal"] == "h26"
        assert lead24["members"]["ecmwf_ifs"]["temperature_2m"] == 20.0 + 26 * 0.1
        assert lead24["members"]["gfs_seamless"] == {"temperature_2m": 21.0}
        assert lead24["blend"]["temperature_2m"] == 20.5
        assert doc["location"] == {"type": "Point", "coordinates": [31.05, -17.83]}
        assert doc["verified"] is False
        assert doc["expiresAt"] > NOW

    def test_short_series_drops_unreachable_leads(self):
        doc = build_verification_doc("x", 0, 0, "default", {"ecmwf_ifs": 1}, _raw(30), {}, 0, NOW)
        assert set(doc["leads"]) == {"6", "24"}

    def test_nothing_to_capture(self):
        assert build_verification_doc("x", 0, 0, "default", {"ecmwf_ifs": 1}, {"hourly": {}}, {}, 0, NOW) is None


class TestCapture:
    def test_first_write_per_bucket_wins(self):
        coll = MagicMock()
        db = MagicMock()
        db.__getitem__.return_value = coll
        doc = {"_id": "harare:2026101006", "leads": {}}
        with patch("py._db.weather_db", return_value=db):
            capture(doc)
        flt, update = coll.update_one.call_args.args
        assert flt == {"_id": "harare:2026101006"}
        assert "_id" not in update["$setOnInsert"]
        assert coll.update_one.call_args.kwargs["upsert"] is True

    def test_never_raises(self):
        with patch("py._db.weather_db", side_effect=RuntimeError("down")):
            capture({"_id": "x"})
        capture(None)
