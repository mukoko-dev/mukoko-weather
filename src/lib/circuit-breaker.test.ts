import { describe, it, expect, beforeEach } from "vitest";
import { CircuitBreaker, CircuitOpenError } from "./circuit-breaker";

describe("CircuitBreaker", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker("test-provider", {
      failureThreshold: 3,
      cooldownMs: 100,
      windowMs: 5000,
      timeoutMs: 1000,
    });
    breaker.reset();
  });

  it("starts in closed state", () => {
    expect(breaker.state).toBe("closed");
    expect(breaker.isAllowed).toBe(true);
  });

  it("stays closed when failures are below threshold", () => {
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe("closed");
    expect(breaker.isAllowed).toBe(true);
  });

  it("opens after reaching failure threshold", () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe("open");
    expect(breaker.isAllowed).toBe(false);
  });

  it("transitions to half-open after cooldown", async () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe("open");

    // Wait for cooldown (100ms)
    await new Promise((r) => setTimeout(r, 150));
    expect(breaker.state).toBe("half_open");
    expect(breaker.isAllowed).toBe(true);
  });

  it("closes after successful probe in half-open state", async () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    await new Promise((r) => setTimeout(r, 150));
    expect(breaker.state).toBe("half_open");

    breaker.recordSuccess();
    expect(breaker.state).toBe("closed");
  });

  it("re-opens after failed probe in half-open state", async () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    await new Promise((r) => setTimeout(r, 150));
    expect(breaker.state).toBe("half_open");

    breaker.recordFailure();
    expect(breaker.state).toBe("open");
  });

  it("execute() succeeds through closed circuit", async () => {
    const result = await breaker.execute(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it("execute() throws CircuitOpenError when circuit is open", async () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    await expect(
      breaker.execute(() => Promise.resolve(42)),
    ).rejects.toThrow(CircuitOpenError);
  });

  it("execute() records failures automatically", async () => {
    await expect(
      breaker.execute(() => Promise.reject(new Error("fail"))),
    ).rejects.toThrow("fail");

    await expect(
      breaker.execute(() => Promise.reject(new Error("fail"))),
    ).rejects.toThrow("fail");

    await expect(
      breaker.execute(() => Promise.reject(new Error("fail"))),
    ).rejects.toThrow("fail");

    // Circuit should now be open
    expect(breaker.state).toBe("open");
  });

  it("reset() closes the circuit", () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe("open");

    breaker.reset();
    expect(breaker.state).toBe("closed");
    expect(breaker.isAllowed).toBe(true);
  });

  it("CircuitOpenError has provider info", () => {
    const error = new CircuitOpenError("test-provider");
    expect(error.provider).toBe("test-provider");
    expect(error.name).toBe("CircuitOpenError");
    expect(error.message).toContain("test-provider");
  });

  it("old failures outside the window are pruned", () => {
    const shortWindowBreaker = new CircuitBreaker("prune-test", {
      failureThreshold: 3,
      cooldownMs: 100,
      windowMs: 50,
      timeoutMs: 1000,
    });

    shortWindowBreaker.recordFailure();
    shortWindowBreaker.recordFailure();

    // These two failures will be outside the window after 60ms
    setTimeout(() => {
      shortWindowBreaker.recordFailure();
      // Should NOT open — the first two failures expired
      expect(shortWindowBreaker.state).toBe("closed");
    }, 60);
  });
});
