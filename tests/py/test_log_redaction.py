"""Secrets must never reach logs: header-borne provider keys + log redaction."""

from __future__ import annotations

import io
import logging
from unittest.mock import MagicMock, patch

import pytest

from py._logging import (
    QUIET_LOGGERS,
    REDACTED,
    RedactSecretsFilter,
    configure_logging,
    redact_secrets,
)

FAKE_KEY = "test-fake-key-123"


# ---------------------------------------------------------------------------
# Tomorrow.io: key in the header, not the URL
# ---------------------------------------------------------------------------


class TestTomorrowKeyInHeader:
    @patch("py._http.get_http_client")
    def test_forecast_sends_key_in_header(self, mock_client):
        # Tomorrow.io is enrichment-only now (issue #246); same key rule applies.
        from py._enrichment import fetch_tomorrow_insights

        resp = MagicMock(status_code=500)
        mock_client.return_value.get.return_value = resp

        from py._enrichment import TomorrowUnavailable

        with pytest.raises(TomorrowUnavailable) as exc:
            fetch_tomorrow_insights(-17.83, 31.05, FAKE_KEY)
        assert FAKE_KEY not in str(exc.value)  # the logged reason never carries the key

        call = mock_client.return_value.get.call_args
        url = call.args[0]
        params = call.kwargs.get("params") or {}
        assert FAKE_KEY not in url
        assert "apikey" not in params
        assert FAKE_KEY not in str(params)
        assert call.kwargs["headers"] == {"apikey": FAKE_KEY}

class TestRedactSecrets:
    @pytest.mark.parametrize(
        "name", ["apikey", "api_key", "key", "token", "access_token", "password", "PASSWORD", "ApiKey"]
    )
    def test_masks_each_secret_param(self, name):
        text = f"GET https://example.com/v4/x?location=1,2&{name}={FAKE_KEY}&units=metric"
        out = redact_secrets(text)
        assert FAKE_KEY not in out
        assert f"{name}={REDACTED}" in out
        assert "location=1,2" in out and "units=metric" in out

    def test_masks_first_param_and_quoted_urls(self):
        out = redact_secrets(f'HTTP Request: GET https://h/p?apikey={FAKE_KEY} "HTTP/1.1 200 OK"')
        assert FAKE_KEY not in out
        assert '"HTTP/1.1 200 OK"' in out

    def test_leaves_lookalike_names_alone(self):
        text = "max_tokens=400 monkey=1 cache_hit=true"
        assert redact_secrets(text) == text

    def test_filter_masks_message_args_and_never_drops(self):
        record = logging.LogRecord(
            "httpx", logging.WARNING, __file__, 1,
            "HTTP Request: %s %s", ("GET", f"https://h/p?token={FAKE_KEY}"), None,
        )
        assert RedactSecretsFilter().filter(record) is True
        assert FAKE_KEY not in record.getMessage()
        assert f"token={REDACTED}" in record.getMessage()

    def test_global_factory_redacts_any_logger_and_tracebacks(self):
        configure_logging()
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)  # deliberately no filter
        log = logging.getLogger("mukoko.test.redaction")
        log.addHandler(handler)
        log.propagate = False
        try:
            log.warning("upstream failed: %s", f"https://h/p?api_key={FAKE_KEY}")
            try:
                raise RuntimeError(f"boom https://h/p?password={FAKE_KEY}")
            except RuntimeError:
                log.exception("call failed")
        finally:
            log.removeHandler(handler)
        output = stream.getvalue()
        assert FAKE_KEY not in output
        assert REDACTED in output
        assert "RuntimeError" in output


# ---------------------------------------------------------------------------
# App import quiets httpx/httpcore
# ---------------------------------------------------------------------------


class TestHttpLoggersQuiet:
    def test_httpx_and_httpcore_at_warning_after_app_import(self):
        import py.index  # noqa: F401 — import is the behaviour under test

        for name in QUIET_LOGGERS:
            assert logging.getLogger(name).getEffectiveLevel() >= logging.WARNING
        assert logging.getLogger("httpx").isEnabledFor(logging.INFO) is False


class TestCoordinateRounding:
    def test_rounds_query_style_coordinates(self):
        out = redact_secrets("GET /api/py/geo?lat=-17.8312345&lon=31.0498765&autoCreate=true")
        assert "lat=-17.831&" in out and "lon=31.050&" in out

    def test_rounds_json_and_kv_styles(self):
        assert "lat: 1.235" in redact_secrets("lat: 1.23456")
        assert '"lon": 31.050' in redact_secrets('{"lon": 31.04987}')

    def test_leaves_short_precision_and_lookalikes(self):
        assert redact_secrets("lat=-17.83&lon=31.05") == "lat=-17.83&lon=31.05"
        assert redact_secrets("slat=1.234567") == "slat=1.234567"

    def test_record_factory_rounds(self):
        rec = logging.LogRecord("x", logging.INFO, "f", 1, "at lat=%s lon=%s", ("-17.123456", "31.654321"), None)
        from py._logging import _redact_record
        assert "lat=-17.123 lon=31.654" in _redact_record(rec).getMessage()
