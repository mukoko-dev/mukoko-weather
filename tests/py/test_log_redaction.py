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
    @patch("py._weather._get_http_client")
    def test_forecast_sends_key_in_header(self, mock_client):
        from py._weather import _fetch_tomorrow

        resp = MagicMock(status_code=500)
        mock_client.return_value.get.return_value = resp

        _fetch_tomorrow(-17.83, 31.05, FAKE_KEY)

        call = mock_client.return_value.get.call_args
        url = call.args[0]
        params = call.kwargs.get("params") or {}
        assert FAKE_KEY not in url
        assert "apikey" not in params
        assert FAKE_KEY not in str(params)
        assert call.kwargs["headers"] == {"apikey": FAKE_KEY}

    @patch("py._status.get_http_client")
    @patch("py._status.get_api_key")
    def test_status_probe_sends_key_in_header(self, mock_key, mock_client):
        from py._status import _check_tomorrow_io

        mock_key.return_value = FAKE_KEY
        mock_client.return_value.get.return_value = MagicMock(status_code=200)

        _check_tomorrow_io()

        call = mock_client.return_value.get.call_args
        assert FAKE_KEY not in call.args[0]
        assert "apikey" not in (call.kwargs.get("params") or {})
        assert call.kwargs["headers"] == {"apikey": FAKE_KEY}


# ---------------------------------------------------------------------------
# Redaction
# ---------------------------------------------------------------------------


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
