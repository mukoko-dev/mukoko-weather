"""
Process-wide logging hygiene: keep secrets out of every log line.

Two layers, both installed by :func:`configure_logging` (called once from
``index.py`` before any router module is imported):

1. **Quiet the HTTP client loggers.** ``httpx`` logs every request at INFO as
   ``HTTP Request: GET <full URL> "HTTP/1.1 200 OK"``, and ``httpcore`` logs
   connection chatter at DEBUG. A full URL can carry a provider key in its
   query string, so both are pinned to WARNING.

2. **Redact at record creation.** A log-record factory masks the value of any
   ``apikey`` / ``api_key`` / ``key`` / ``token`` / ``access_token`` /
   ``password`` / ``passkey`` query-style parameter in the formatted message
   and in any attached traceback text. A record factory runs for EVERY
   record from EVERY logger, whatever handlers the runtime installs, so the
   redaction cannot be bypassed by a logger that propagates to a handler we
   didn't configure. :class:`RedactSecretsFilter` exposes the same masking as
   a ``logging.Filter`` and is also attached to the root handlers.

Prefer sending secrets in headers (Tomorrow.io ``apikey``, CheckWX
``X-API-Key``); this module is the backstop for anything that still travels
in a URL (e.g. the inbound Weather Underground ``PASSWORD`` parameter).
"""

from __future__ import annotations

import logging
import re

# Parameter names whose values are secrets. Matched case-insensitively, as a
# whole parameter name (preceded by start, ``?``, ``&``, ``;``, whitespace or a
# quote) so e.g. ``monkey=`` or ``max_tokens=`` are left alone.
SECRET_PARAM_NAMES = (
    "apikey",
    "api_key",
    "access_token",
    "token",
    "key",
    "password",
    "passkey",
)

REDACTED = "[REDACTED]"

_SECRET_PARAM_RE = re.compile(
    r"(?P<prefix>(?:^|[?&;\s\"'(]))"
    r"(?P<name>" + "|".join(re.escape(n) for n in SECRET_PARAM_NAMES) + r")"
    r"(?P<eq>=)"
    r"(?P<value>[^&\s\"'#;)]+)",
    re.IGNORECASE,
)

QUIET_LOGGERS = ("httpx", "httpcore")


def redact_secrets(text: str) -> str:
    """Mask secret query-parameter values in ``text``."""
    if not text or "=" not in text:
        return text
    return _SECRET_PARAM_RE.sub(
        lambda m: f"{m.group('prefix')}{m.group('name')}{m.group('eq')}{REDACTED}",
        text,
    )


_formatter = logging.Formatter()


def _redact_record(record: logging.LogRecord) -> logging.LogRecord:
    """Redact a record in place: message (with args merged) and traceback."""
    try:
        message = record.getMessage()
    except Exception:
        # Malformed format/args — leave it for logging's own error path.
        return record
    redacted = redact_secrets(message)
    if redacted != message or record.args:
        record.msg = redacted
        record.args = None
    if record.exc_info and not record.exc_text:
        try:
            record.exc_text = _formatter.formatException(record.exc_info)
        except Exception:
            pass
    if record.exc_text:
        record.exc_text = redact_secrets(record.exc_text)
    return record


class RedactSecretsFilter(logging.Filter):
    """``logging.Filter`` that masks secret query values; never drops a record."""

    def filter(self, record: logging.LogRecord) -> bool:
        _redact_record(record)
        return True


_installed = False


def configure_logging() -> None:
    """Install the quiet levels, the redacting record factory and filter.

    Idempotent — safe to call more than once (e.g. on warm re-imports).
    """
    global _installed

    for name in QUIET_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)

    root = logging.getLogger()
    for handler in root.handlers:
        if not any(isinstance(f, RedactSecretsFilter) for f in handler.filters):
            handler.addFilter(RedactSecretsFilter())

    if _installed:
        return

    previous_factory = logging.getLogRecordFactory()

    def _factory(*args, **kwargs) -> logging.LogRecord:
        return _redact_record(previous_factory(*args, **kwargs))

    logging.setLogRecordFactory(_factory)
    _installed = True
