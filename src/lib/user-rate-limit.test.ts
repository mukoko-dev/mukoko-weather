/** Per-user Mongo rate limiter: counts, Retry-After, fails open. No DB. */
import { describe, it, expect, vi } from "vitest";

vi.mock("./db", () => ({ rateLimitsCollection: vi.fn() }));

import { checkUserRateLimit, type CounterStore } from "./user-rate-limit";

const T0 = 1_800_000_000_000;
const now = () => T0;

function counting(): CounterStore & { keys: string[] } {
  const counts = new Map<string, { count: number; expiresAt: Date }>();
  const keys: string[] = [];
  const store = (async (key: string, expiresAt: Date) => {
    keys.push(key);
    const doc = counts.get(key) ?? { count: 0, expiresAt };
    doc.count += 1;
    counts.set(key, doc);
    return doc;
  }) as CounterStore & { keys: string[] };
  store.keys = keys;
  return store;
}

describe("checkUserRateLimit", () => {
  it("allows up to max per user, then refuses with Retry-After", async () => {
    const store = counting();
    for (let i = 0; i < 5; i++) {
      expect(
        (
          await checkUserRateLimit(
            "app-keys-create",
            "user_1",
            5,
            3600,
            store,
            now,
          )
        ).allowed,
      ).toBe(true);
    }
    const sixth = await checkUserRateLimit(
      "app-keys-create",
      "user_1",
      5,
      3600,
      store,
      now,
    );
    expect(sixth).toEqual({ allowed: false, retryAfterSeconds: 3600 });
    // Another user has their own bucket.
    expect(
      (
        await checkUserRateLimit(
          "app-keys-create",
          "user_2",
          5,
          3600,
          store,
          now,
        )
      ).allowed,
    ).toBe(true);
    expect(store.keys[0]).toBe("app-keys-create:user:user_1");
  });

  it("Retry-After counts down to the window's end and stays 1–3600", async () => {
    const store: CounterStore = async () => ({
      count: 99,
      expiresAt: new Date(T0 + 12_300),
    });
    expect(await checkUserRateLimit("a", "u", 1, 60, store, now)).toEqual({
      allowed: false,
      retryAfterSeconds: 13,
    });
    const past: CounterStore = async () => ({
      count: 99,
      expiresAt: new Date(T0 - 5),
    });
    expect(
      (await checkUserRateLimit("a", "u", 1, 60, past, now)).retryAfterSeconds,
    ).toBe(1);
  });

  it("fails open on a DB error", async () => {
    const broken: CounterStore = async () => {
      throw new Error("quota");
    };
    expect(await checkUserRateLimit("a", "u", 1, 60, broken, now)).toEqual({
      allowed: true,
    });
  });
});
