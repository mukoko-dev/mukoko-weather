/** Per-user Mongo rate limiter: windows, Retry-After, races, fails open. */
import { describe, it, expect, vi } from "vitest";

const collection = vi.hoisted(() => ({ findOneAndUpdate: vi.fn() }));
vi.mock("./db", () => ({ rateLimitsCollection: () => collection }));

import {
  checkUserRateLimit,
  WINDOW_GRACE_MS,
  type CounterStore,
} from "./user-rate-limit";

const HOUR = 3_600_000;
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % HOUR); // a window start

/** An in-memory store that, like the TTL reaper that never ran, keeps every
 * document forever. */
function counting(): CounterStore & { keys: string[]; expiries: Date[] } {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  const expiries: Date[] = [];
  const store = (async (key: string, expiresAt: Date) => {
    keys.push(key);
    expiries.push(expiresAt);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return { count };
  }) as CounterStore & { keys: string[]; expiries: Date[] };
  store.keys = keys;
  store.expiries = expiries;
  return store;
}

describe("checkUserRateLimit", () => {
  it("allows up to max per user per window, then refuses with Retry-After", async () => {
    const store = counting();
    let clock = T0 + 1_000;
    const now = () => clock;
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
    clock = T0 + 10 * 60_000;
    expect(
      await checkUserRateLimit(
        "app-keys-create",
        "user_1",
        5,
        3600,
        store,
        now,
      ),
    ).toEqual({ allowed: false, retryAfterSeconds: 3000 });
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
    expect(store.keys[0]).toBe(`app-keys-create:user:user_1:${T0 / HOUR}`);
    expect(store.expiries[0].getTime()).toBe(T0 + HOUR + WINDOW_GRACE_MS);
  });

  it("unblocks when the window ends even if the old counter is never deleted", async () => {
    const store = counting();
    let clock = T0;
    const now = () => clock;
    for (let i = 0; i < 6; i++) {
      await checkUserRateLimit("a", "u", 5, 3600, store, now);
    }
    expect(
      (await checkUserRateLimit("a", "u", 5, 3600, store, now)).allowed,
    ).toBe(false);
    clock = T0 + HOUR; // next window; the old document is still there
    expect(
      (await checkUserRateLimit("a", "u", 5, 3600, store, now)).allowed,
    ).toBe(true);
  });

  it("Retry-After is at least 1 and at most 3600", async () => {
    const full: CounterStore = async () => ({ count: 99 });
    const lastMs = () => T0 + HOUR - 1;
    expect(
      (await checkUserRateLimit("a", "u", 1, 3600, full, lastMs))
        .retryAfterSeconds,
    ).toBe(1);
    expect(
      (await checkUserRateLimit("a", "u", 1, 86_400, full, () => T0))
        .retryAfterSeconds,
    ).toBeLessThanOrEqual(3600);
  });

  it("fails open on a DB error", async () => {
    const broken: CounterStore = async () => {
      throw new Error("quota");
    };
    expect(await checkUserRateLimit("a", "u", 1, 60, broken, () => T0)).toEqual(
      {
        allowed: true,
      },
    );
  });

  it("the Mongo store retries once on a duplicate-key race", async () => {
    collection.findOneAndUpdate.mockReset();
    collection.findOneAndUpdate
      .mockRejectedValueOnce(
        Object.assign(new Error("E11000"), { code: 11000 }),
      )
      .mockResolvedValueOnce({ count: 2 });
    expect(
      await checkUserRateLimit("a", "u", 5, 60, undefined, () => T0),
    ).toEqual({
      allowed: true,
    });
    expect(collection.findOneAndUpdate).toHaveBeenCalledTimes(2);
    const [filter, update, opts] = collection.findOneAndUpdate.mock.calls[0];
    expect(filter.key).toMatch(/^a:user:u:\d+$/);
    expect(update).toMatchObject({ $inc: { count: 1 } });
    expect(opts).toMatchObject({ upsert: true, returnDocument: "after" });
  });
});
