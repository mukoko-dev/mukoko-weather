"""
Circuit breaker — Netflix Hystrix-inspired resilience pattern (Python port).

Protects the app from cascading failures by tracking provider health
and short-circuiting requests to failing services. When a provider
exceeds its failure threshold, the circuit "opens" and all requests
skip directly to the fallback for a configurable cooldown period.

State machine:
  CLOSED    → (failure threshold exceeded) → OPEN
  OPEN      → (cooldown elapsed)           → HALF_OPEN
  HALF_OPEN → (probe succeeds)             → CLOSED
  HALF_OPEN → (probe fails)                → OPEN

This is an in-memory implementation optimised for serverless (Vercel).
State persists across warm function starts (~5-15 minutes on Vercel),
enough to prevent retry storms within a request and across the warm
reuse window.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Callable, TypeVar

logger = logging.getLogger("mukoko.circuit_breaker")

T = TypeVar("T")


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


@dataclass
class CircuitBreakerConfig:
    """Per-provider circuit breaker configuration."""

    failure_threshold: int = 3
    cooldown_s: float = 120  # seconds
    window_s: float = 300  # rolling window for counting failures
    timeout_s: float = 8  # per-request timeout


# Default configs per provider
PROVIDER_CONFIGS: dict[str, CircuitBreakerConfig] = {
    "tomorrow-io": CircuitBreakerConfig(
        failure_threshold=3, cooldown_s=120, window_s=300, timeout_s=5,
    ),
    "open-meteo": CircuitBreakerConfig(
        failure_threshold=5, cooldown_s=300, window_s=300, timeout_s=8,
    ),
    "anthropic": CircuitBreakerConfig(
        failure_threshold=3, cooldown_s=300, window_s=600, timeout_s=15,
    ),
}


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------


@dataclass
class _CircuitState:
    state: str = "closed"  # "closed" | "open" | "half_open"
    failures: list[float] = field(default_factory=list)
    last_opened_at: float | None = None


# Module-level state — persists across Vercel warm function starts
_circuit_states: dict[str, _CircuitState] = {}


def _get_state(provider: str) -> _CircuitState:
    if provider not in _circuit_states:
        _circuit_states[provider] = _CircuitState()
    return _circuit_states[provider]


# ---------------------------------------------------------------------------
# Error types
# ---------------------------------------------------------------------------


class CircuitOpenError(Exception):
    """Raised when the circuit is open and requests are short-circuited."""

    def __init__(self, provider: str):
        self.provider = provider
        super().__init__(
            f"Circuit breaker is open for {provider} — requests are being short-circuited"
        )


# ---------------------------------------------------------------------------
# Circuit Breaker
# ---------------------------------------------------------------------------


class CircuitBreaker:
    """Per-provider circuit breaker with execute/record pattern."""

    def __init__(self, provider: str, config: CircuitBreakerConfig | None = None):
        self.provider = provider
        self.config = config or PROVIDER_CONFIGS.get(
            provider, CircuitBreakerConfig()
        )

    @property
    def state(self) -> str:
        s = _get_state(self.provider)
        if s.state == "open" and self._cooldown_elapsed(s):
            s.state = "half_open"
        return s.state

    @property
    def is_allowed(self) -> bool:
        return self.state in ("closed", "half_open")

    async def execute(self, fn: Callable[[], T]) -> T:
        """
        Execute a coroutine through the circuit breaker.

        If the circuit is open, raises CircuitOpenError immediately.
        On success, records success (closes half-open circuits).
        On failure, records failure (may open the circuit).
        """
        if not self.is_allowed:
            raise CircuitOpenError(self.provider)

        try:
            result = await asyncio.wait_for(
                fn(), timeout=self.config.timeout_s,
            )
            self.record_success()
            return result
        except asyncio.TimeoutError:
            self.record_failure()
            raise TimeoutError(
                f"{self.provider} request timed out after {self.config.timeout_s}s"
            )
        except CircuitOpenError:
            raise
        except Exception:
            self.record_failure()
            raise

    def record_success(self) -> None:
        """Record a successful call — closes half-open circuits."""
        s = _get_state(self.provider)
        if s.state == "half_open":
            s.state = "closed"
            s.failures.clear()
            s.last_opened_at = None
            logger.info(
                "Circuit breaker closed for %s — provider recovered",
                self.provider,
            )

    def record_failure(self) -> None:
        """Record a failed call — may open the circuit."""
        s = _get_state(self.provider)
        now = time.time()

        # Add failure timestamp and prune old ones outside the window
        s.failures.append(now)
        s.failures = [t for t in s.failures if now - t < self.config.window_s]

        if s.state == "half_open":
            # Probe failed — reopen
            s.state = "open"
            s.last_opened_at = now
            logger.warning(
                "Circuit breaker re-opened for %s — probe failed",
                self.provider,
            )
        elif (
            s.state == "closed"
            and len(s.failures) >= self.config.failure_threshold
        ):
            s.state = "open"
            s.last_opened_at = now
            logger.warning(
                "Circuit breaker opened for %s — %d failures in %ds window",
                self.provider, len(s.failures), self.config.window_s,
            )

    def reset(self) -> None:
        """Reset the circuit to closed (e.g. manual recovery)."""
        s = _get_state(self.provider)
        s.state = "closed"
        s.failures.clear()
        s.last_opened_at = None

    def _cooldown_elapsed(self, s: _CircuitState) -> bool:
        if s.last_opened_at is None:
            return False
        return time.time() - s.last_opened_at >= self.config.cooldown_s


# ---------------------------------------------------------------------------
# Singleton breakers for each provider
# ---------------------------------------------------------------------------

tomorrow_breaker = CircuitBreaker("tomorrow-io")
open_meteo_breaker = CircuitBreaker("open-meteo")
anthropic_breaker = CircuitBreaker("anthropic")
