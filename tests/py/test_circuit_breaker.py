"""Tests for the circuit breaker — state machine, failure counting, cooldown."""

from __future__ import annotations

import asyncio
import time

import pytest

from py._circuit_breaker import (
    CircuitBreaker,
    CircuitBreakerConfig,
    CircuitOpenError,
    _circuit_states,
)


@pytest.fixture(autouse=True)
def _reset_state():
    """Clear all circuit breaker state between tests."""
    _circuit_states.clear()
    yield
    _circuit_states.clear()


def _make_breaker(**kwargs) -> CircuitBreaker:
    config = CircuitBreakerConfig(
        failure_threshold=kwargs.get("failure_threshold", 3),
        cooldown_s=kwargs.get("cooldown_s", 0.1),
        window_s=kwargs.get("window_s", 60),
        timeout_s=kwargs.get("timeout_s", 5),
    )
    return CircuitBreaker("test-provider", config)


# ---------------------------------------------------------------------------
# State transitions
# ---------------------------------------------------------------------------


class TestCircuitBreakerStates:
    def test_starts_closed(self):
        cb = _make_breaker()
        assert cb.state == "closed"
        assert cb.is_allowed is True

    def test_opens_after_threshold_failures(self):
        cb = _make_breaker(failure_threshold=3)
        for _ in range(3):
            cb.record_failure()
        assert cb.state == "open"
        assert cb.is_allowed is False

    def test_stays_closed_below_threshold(self):
        cb = _make_breaker(failure_threshold=3)
        cb.record_failure()
        cb.record_failure()
        assert cb.state == "closed"
        assert cb.is_allowed is True

    def test_transitions_to_half_open_after_cooldown(self):
        cb = _make_breaker(failure_threshold=1, cooldown_s=0.05)
        cb.record_failure()
        assert cb.state == "open"

        time.sleep(0.06)
        assert cb.state == "half_open"
        assert cb.is_allowed is True

    def test_half_open_closes_on_success(self):
        cb = _make_breaker(failure_threshold=1, cooldown_s=0.05)
        cb.record_failure()
        time.sleep(0.06)
        assert cb.state == "half_open"

        cb.record_success()
        assert cb.state == "closed"

    def test_half_open_reopens_on_failure(self):
        cb = _make_breaker(failure_threshold=1, cooldown_s=0.05)
        cb.record_failure()
        time.sleep(0.06)
        assert cb.state == "half_open"

        cb.record_failure()
        assert cb.state == "open"

    def test_reset_returns_to_closed(self):
        cb = _make_breaker(failure_threshold=1)
        cb.record_failure()
        assert cb.state == "open"

        cb.reset()
        assert cb.state == "closed"
        assert cb.is_allowed is True


# ---------------------------------------------------------------------------
# Failure window
# ---------------------------------------------------------------------------


class TestFailureWindow:
    def test_old_failures_pruned_outside_window(self):
        cb = _make_breaker(failure_threshold=3, window_s=0.05)
        cb.record_failure()
        cb.record_failure()
        time.sleep(0.06)
        # Third failure but the first two are outside the window
        cb.record_failure()
        assert cb.state == "closed"

    def test_failures_within_window_count(self):
        cb = _make_breaker(failure_threshold=3, window_s=60)
        cb.record_failure()
        cb.record_failure()
        cb.record_failure()
        assert cb.state == "open"


# ---------------------------------------------------------------------------
# Execute method
# ---------------------------------------------------------------------------


class TestExecute:
    @pytest.mark.asyncio
    async def test_execute_success(self):
        cb = _make_breaker()

        async def ok():
            return "result"

        result = await cb.execute(ok)
        assert result == "result"
        assert cb.state == "closed"

    @pytest.mark.asyncio
    async def test_execute_failure_records(self):
        cb = _make_breaker(failure_threshold=2)

        async def fail():
            raise ValueError("boom")

        with pytest.raises(ValueError):
            await cb.execute(fail)
        with pytest.raises(ValueError):
            await cb.execute(fail)

        assert cb.state == "open"

    @pytest.mark.asyncio
    async def test_execute_raises_circuit_open_error(self):
        cb = _make_breaker(failure_threshold=1)
        cb.record_failure()
        assert cb.state == "open"

        with pytest.raises(CircuitOpenError) as exc_info:
            await cb.execute(lambda: asyncio.sleep(0))

        assert exc_info.value.provider == "test-provider"

    @pytest.mark.asyncio
    async def test_execute_timeout_records_failure(self):
        cb = _make_breaker(failure_threshold=2, timeout_s=0.01)

        async def slow():
            await asyncio.sleep(1)

        with pytest.raises(TimeoutError):
            await cb.execute(slow)

        # One timeout = one failure
        assert cb.state == "closed"


# ---------------------------------------------------------------------------
# Singleton breakers exist
# ---------------------------------------------------------------------------


class TestSingletonBreakers:
    def test_provider_breakers_exist(self):
        from py._circuit_breaker import (
            tomorrow_breaker,
            open_meteo_breaker,
            anthropic_breaker,
        )

        assert tomorrow_breaker.provider == "tomorrow-io"
        assert open_meteo_breaker.provider == "open-meteo"
        assert anthropic_breaker.provider == "anthropic"

    def test_provider_configs(self):
        from py._circuit_breaker import tomorrow_breaker, anthropic_breaker

        assert tomorrow_breaker.config.failure_threshold == 3
        assert tomorrow_breaker.config.timeout_s == 5
        assert anthropic_breaker.config.failure_threshold == 3
        assert anthropic_breaker.config.timeout_s == 15
