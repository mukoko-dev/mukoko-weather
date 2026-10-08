"""WMO label dict used by the AI history analysis prompt."""

from __future__ import annotations

from py._wmo import WMO_LABELS


class TestWmoLabels:
    def test_covers_codes_the_app_emits(self):
        for code in (0, 1, 2, 3, 45, 48, 51, 61, 65, 71, 80, 95, 99):
            assert code in WMO_LABELS

    def test_labels_are_non_empty_strings(self):
        assert WMO_LABELS
        for code, label in WMO_LABELS.items():
            assert isinstance(code, int)
            assert isinstance(label, str) and label.strip()

    def test_uses_canonical_wording(self):
        assert WMO_LABELS[0] == "Clear sky"
        assert WMO_LABELS[95] == "Thunderstorm"
