/**
 * Circuit breaker — Netflix Hystrix-inspired resilience pattern.
 *
 * Protects the app from cascading failures by tracking provider health
 * and short-circuiting requests to failing services. When a provider
 * exceeds its failure threshold, the circuit "opens" and all requests
 * skip directly to the fallback for a configurable cooldown period.
 *
 * State machine:
 *   CLOSED  → (failure threshold exceeded) → OPEN
 *   OPEN    → (cooldown elapsed)           → HALF_OPEN
 *   HALF_OPEN → (probe succeeds)           → CLOSED
 *   HALF_OPEN → (probe fails)              → OPEN
 *
 * This is an in-memory implementation optimised for serverless (Vercel).
 * Each function invocation starts with a fresh breaker state, but the
 * breaker persists within a single invocation's lifetime — enough to
 * prevent retry storms within a request, and to carry state across
 * the warm-start reuse window (~5-15 minutes on Vercel).
 */

import { logWarn, logError } from "./observability";

// ── Types ──────────────────────────────────────────────────────────────────

type CircuitState = "closed" | "open" | "half_open";

interface CircuitBreakerConfig {
  /** Max failures before opening the circuit */
  failureThreshold: number;
  /** How long the circuit stays open before allowing a probe (ms) */
  cooldownMs: number;
  /** Rolling window for counting failures (ms) */
  windowMs: number;
  /** Timeout for individual requests wrapped by this breaker (ms) */
  timeoutMs: number;
}

interface CircuitBreakerState {
  state: CircuitState;
  failures: number[];
  lastOpenedAt: number | null;
}

// ── Default configs per provider ───────────────────────────────────────────

const PROVIDER_CONFIGS: Record<string, CircuitBreakerConfig> = {
  "tomorrow-io": {
    failureThreshold: 3,
    cooldownMs: 2 * 60 * 1000,
    windowMs: 5 * 60 * 1000,
    timeoutMs: 5000,
  },
  "open-meteo": {
    failureThreshold: 5,
    cooldownMs: 5 * 60 * 1000,
    windowMs: 5 * 60 * 1000,
    timeoutMs: 8000,
  },
  anthropic: {
    failureThreshold: 3,
    cooldownMs: 5 * 60 * 1000,
    windowMs: 10 * 60 * 1000,
    timeoutMs: 15000,
  },
};

// ── In-memory state store ──────────────────────────────────────────────────
// Persists across warm starts within the same Vercel function instance.

const circuitStates = new Map<string, CircuitBreakerState>();

function getState(provider: string): CircuitBreakerState {
  if (!circuitStates.has(provider)) {
    circuitStates.set(provider, {
      state: "closed",
      failures: [],
      lastOpenedAt: null,
    });
  }
  return circuitStates.get(provider)!;
}

// ── Core circuit breaker ───────────────────────────────────────────────────

export class CircuitBreaker {
  private provider: string;
  private config: CircuitBreakerConfig;

  constructor(provider: string, config?: Partial<CircuitBreakerConfig>) {
    this.provider = provider;
    this.config = {
      ...(PROVIDER_CONFIGS[provider] ?? PROVIDER_CONFIGS["open-meteo"]),
      ...config,
    };
  }

  /** Current circuit state */
  get state(): CircuitState {
    const s = getState(this.provider);
    if (s.state === "open" && this.cooldownElapsed(s)) {
      s.state = "half_open";
    }
    return s.state;
  }

  /** Whether the circuit is allowing requests through */
  get isAllowed(): boolean {
    const state = this.state;
    return state === "closed" || state === "half_open";
  }

  /**
   * Execute a function through the circuit breaker.
   *
   * If the circuit is open, throws immediately without calling the fn.
   * If the fn succeeds, records success (closes half-open circuits).
   * If the fn fails, records failure (may open the circuit).
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.isAllowed) {
      throw new CircuitOpenError(this.provider);
    }

    try {
      const result = await this.withTimeout(fn());
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  /** Record a successful call */
  recordSuccess(): void {
    const s = getState(this.provider);
    if (s.state === "half_open") {
      s.state = "closed";
      s.failures = [];
      s.lastOpenedAt = null;
      logWarn({
        source: this.provider as "tomorrow-io",
        message: `Circuit breaker closed for ${this.provider} — provider recovered`,
      });
    }
  }

  /** Record a failed call */
  recordFailure(): void {
    const s = getState(this.provider);
    const now = Date.now();

    // Add failure timestamp and prune old ones outside the window
    s.failures.push(now);
    s.failures = s.failures.filter(
      (t) => now - t < this.config.windowMs,
    );

    if (s.state === "half_open") {
      // Probe failed — reopen
      s.state = "open";
      s.lastOpenedAt = now;
      logError({
        source: this.provider as "tomorrow-io",
        severity: "high",
        message: `Circuit breaker re-opened for ${this.provider} — probe failed`,
      });
    } else if (
      s.state === "closed" &&
      s.failures.length >= this.config.failureThreshold
    ) {
      s.state = "open";
      s.lastOpenedAt = now;
      logError({
        source: this.provider as "tomorrow-io",
        severity: "high",
        message: `Circuit breaker opened for ${this.provider} — ${s.failures.length} failures in ${this.config.windowMs / 1000}s window`,
      });
    }
  }

  /** Reset the circuit to closed (e.g., manual recovery) */
  reset(): void {
    const s = getState(this.provider);
    s.state = "closed";
    s.failures = [];
    s.lastOpenedAt = null;
  }

  // ── Internal helpers ───────────────────────────────────────────────────

  private cooldownElapsed(s: CircuitBreakerState): boolean {
    if (s.lastOpenedAt === null) return false;
    return Date.now() - s.lastOpenedAt >= this.config.cooldownMs;
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${this.provider} request timed out after ${this.config.timeoutMs}ms`)),
        this.config.timeoutMs,
      );
      promise
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }
}

// ── Error types ────────────────────────────────────────────────────────────

export class CircuitOpenError extends Error {
  public readonly provider: string;

  constructor(provider: string) {
    super(`Circuit breaker is open for ${provider} — requests are being short-circuited`);
    this.name = "CircuitOpenError";
    this.provider = provider;
  }
}

// ── Singleton breakers for each provider ───────────────────────────────────
// Reused across warm starts within the same Vercel function instance.

export const tomorrowBreaker = new CircuitBreaker("tomorrow-io");
export const openMeteoBreaker = new CircuitBreaker("open-meteo");
export const anthropicBreaker = new CircuitBreaker("anthropic");
