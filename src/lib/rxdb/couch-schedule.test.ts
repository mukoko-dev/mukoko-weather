import { describe, expect, it } from "vitest";
import {
  BACKOFF_MAX_MS,
  BACKOFF_START_MS,
  REFRESH_LEAD_MS,
  REFRESH_MIN_DELAY_MS,
  backoffDelayMs,
  failureAction,
  isTokenUsable,
  refreshDelayMs,
  renewalDelayMs,
} from "./couch-schedule";
import { REFRESH_MIN_DELAY_MS as SHARED_MIN } from "../couch-session-timing";

const NOW = 1_000_000_000_000;
const exact = () => 0.5; // spread factor 1.0

describe("refreshDelayMs (injected clock)", () => {
  it("refreshes a minute before a ten-minute credential expires", () => {
    expect(refreshDelayMs(NOW + 600_000, NOW)).toBe(600_000 - REFRESH_LEAD_MS);
  });

  it("refreshes now once inside the lead window or after expiry", () => {
    expect(refreshDelayMs(NOW + REFRESH_LEAD_MS, NOW)).toBe(0);
    expect(refreshDelayMs(NOW + 1_000, NOW)).toBe(0);
    expect(refreshDelayMs(NOW - 5_000, NOW)).toBe(0);
  });

  it("never schedules sooner than the minimum delay", () => {
    expect(refreshDelayMs(NOW + REFRESH_LEAD_MS + 1, NOW)).toBe(
      REFRESH_MIN_DELAY_MS,
    );
  });

  it("an unusable expiry means refresh now", () => {
    expect(refreshDelayMs(Number.NaN, NOW)).toBe(0);
    expect(refreshDelayMs(NOW + 600_000, Number.NaN)).toBe(0);
  });

  it("moves with the clock, not with wall time", () => {
    expect(refreshDelayMs(NOW + 600_000, NOW + 100_000)).toBe(
      500_000 - REFRESH_LEAD_MS,
    );
  });
});

describe("renewalDelayMs (what the engine arms its timer with)", () => {
  it("is refreshDelayMs for a credential with room, and the minimum for one without", () => {
    expect(renewalDelayMs(NOW + 600_000, NOW)).toBe(600_000 - REFRESH_LEAD_MS);
    for (const expiresAtMs of [
      NOW + REFRESH_LEAD_MS,
      NOW + 1_000,
      NOW - 5_000,
      Number.NaN,
    ]) {
      expect(refreshDelayMs(expiresAtMs, NOW)).toBe(0);
      expect(renewalDelayMs(expiresAtMs, NOW), String(expiresAtMs)).toBe(
        REFRESH_MIN_DELAY_MS,
      );
    }
  });

  it("is never below the minimum, whatever the expiry and the clock", () => {
    for (let ttl = -10_000; ttl <= 400_000; ttl += 7_000) {
      expect(renewalDelayMs(NOW + ttl, NOW)).toBeGreaterThanOrEqual(
        REFRESH_MIN_DELAY_MS,
      );
    }
  });

  it("the minimum is the one the server side shares", () => {
    expect(REFRESH_MIN_DELAY_MS).toBe(SHARED_MIN);
  });
});

describe("isTokenUsable", () => {
  it("is true with time left and false at or past the slack", () => {
    expect(isTokenUsable(NOW + 120_000, NOW, REFRESH_LEAD_MS)).toBe(true);
    expect(isTokenUsable(NOW + REFRESH_LEAD_MS, NOW, REFRESH_LEAD_MS)).toBe(
      false,
    );
    expect(isTokenUsable(Number.NaN, NOW)).toBe(false);
  });
});

describe("backoffDelayMs: 30 s, doubling, capped at 15 min", () => {
  it("doubles from 30 s", () => {
    expect([1, 2, 3, 4, 5].map((n) => backoffDelayMs(n, exact))).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000,
    ]);
  });

  it("stops at 15 minutes however many failures", () => {
    expect(backoffDelayMs(6, exact)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelayMs(50, exact)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelayMs(50, () => 0.999)).toBeLessThanOrEqual(BACKOFF_MAX_MS);
  });

  it("starts at 30 s and spreads by at most 10 percent", () => {
    expect(backoffDelayMs(1, () => 0)).toBe(Math.round(BACKOFF_START_MS * 0.9));
    expect(backoffDelayMs(1, () => 0.9999)).toBeLessThanOrEqual(
      Math.round(BACKOFF_START_MS * 1.1),
    );
    expect(backoffDelayMs(0, exact)).toBe(BACKOFF_START_MS);
  });
});

describe("failureAction", () => {
  it("a refused database credential is refetched once, then backs off", () => {
    expect(failureAction("couch", 401, false)).toBe("refetch_token_once");
    expect(failureAction("couch", 401, true)).toBe("back_off");
  });

  it("a 401 from our own route means signed out", () => {
    expect(failureAction("route", 401, false)).toBe("stay_idle");
  });

  it("404, 503, 403, 429, 5xx and no answer all back off", () => {
    for (const status of [404, 503, 403, 429, 500, 502, 0, undefined]) {
      expect(failureAction("route", status, false), `route ${status}`).toBe(
        "back_off",
      );
      expect(failureAction("couch", status, false), `couch ${status}`).toBe(
        "back_off",
      );
    }
  });
});
