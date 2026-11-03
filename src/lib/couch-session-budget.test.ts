/**
 * The site-wide budget for sync grants: one counter for every person, kept
 * apart from the per-person limit and from `/api/app-keys`, so that sync
 * traffic cannot use up the gateway's token endpoint (30 a minute for this
 * site's one key) and break developer-key management for people who never
 * turned sync on. No network, no database: the counter store and the clock are
 * injected.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// `app-keys/shared` (read only for its limits) imports AuthKit, which needs
// Next's runtime; the budget itself never touches it.
vi.mock("@workos-inc/authkit-nextjs", () => ({ withAuth: vi.fn() }));

import { checkUserRateLimit, type CounterStore } from "@/lib/user-rate-limit";
import {
  COUCH_SYNC_BUDGET,
  COUCH_SYNC_BUDGET_ACTION,
  GATEWAY_COOLDOWN_MAX_SECONDS,
  GATEWAY_TOKEN_LIMIT_PER_MINUTE,
  RENEWAL_PERIOD_SECONDS,
  SUPPORTED_VISIBLE_TABS,
  SUSTAINED_EXCHANGES_PER_MINUTE,
  createSyncBudget,
} from "./couch-session-budget";
import { COUCH_SYNC_MAX_SECONDS } from "./couch-session-issuer";
import { REFRESH_LEAD_MS } from "./rxdb/couch-schedule";
import { APP_KEYS_LIMITS } from "@/app/api/app-keys/shared";

/** An in-memory `weather.rate_limits`: one counter per key. */
function memoryStore() {
  const counts = new Map<string, number>();
  const store: CounterStore = async (key) => {
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return { count };
  };
  return { store, counts };
}

const T0 = Date.parse("2026-11-03T12:00:00.000Z");

function budgetOver(store: CounterStore, clock: { now: number } = { now: T0 }) {
  return {
    clock,
    budget: createSyncBudget({
      check: (action, id, max, window) =>
        checkUserRateLimit(action, id, max, window, store, () => clock.now),
      now: () => clock.now,
    }),
  };
}

describe("the arithmetic", () => {
  it("leaves the rest of the gateway's 30 a minute to /api/app-keys, even in the worst case across a window boundary", () => {
    const [max, windowSeconds] = COUCH_SYNC_BUDGET;
    // Sustained: what the budget lets through in a minute.
    const perMinute = (max * 60) / windowSeconds;
    expect(perMinute).toBeLessThanOrEqual(18);
    // A fixed window can pass its whole limit at its very end and again at the
    // very start of the next: in ANY 60 s a span overlaps this many windows.
    const windowsInAMinute = Math.ceil(60 / windowSeconds) + 1;
    const worstMinute = windowsInAMinute * max;
    expect(worstMinute).toBeLessThanOrEqual(GATEWAY_TOKEN_LIMIT_PER_MINUTE - 6);
  });

  it("is one counter for the whole site, not one per person", () => {
    expect(COUCH_SYNC_BUDGET_ACTION).toBe("couch-session-global");
  });
});

describe("spend", () => {
  it("lets the budget through, then refuses with the time left in the window", async () => {
    const { store } = memoryStore();
    const { budget } = budgetOver(store, { now: T0 + 5_000 });
    const [max] = COUCH_SYNC_BUDGET;
    for (let i = 0; i < max; i++) {
      expect(await budget.spend()).toEqual({ allowed: true });
    }
    const refused = await budget.spend();
    expect(refused.allowed).toBe(false);
    // 5 s into a 20 s window: 15 s to go.
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 15 });
  });

  it("a new window is a new budget", async () => {
    const { store } = memoryStore();
    const clock = { now: T0 };
    const { budget } = budgetOver(store, clock);
    const [max, windowSeconds] = COUCH_SYNC_BUDGET;
    for (let i = 0; i <= max; i++) await budget.spend();
    expect((await budget.spend()).allowed).toBe(false);
    clock.now += windowSeconds * 1000;
    expect(await budget.spend()).toEqual({ allowed: true });
  });

  it("people share it: it is one counter however many different people ask", async () => {
    const { store, counts } = memoryStore();
    const { budget } = budgetOver(store);
    await budget.spend();
    await budget.spend();
    expect([...counts.keys()]).toHaveLength(1);
    expect([...counts.values()]).toEqual([2]);
  });
});

describe("separate from /api/app-keys (the other user of the same gateway key)", () => {
  it("while the sync budget is spent, listing, creating and revoking developer keys are still allowed", async () => {
    const { store, counts } = memoryStore();
    const { budget, clock } = budgetOver(store);
    const [max] = COUCH_SYNC_BUDGET;
    for (let i = 0; i <= max + 3; i++) await budget.spend();
    expect((await budget.spend()).allowed).toBe(false);

    for (const [action, [limit, window]] of Object.entries(APP_KEYS_LIMITS)) {
      const answer = await checkUserRateLimit(
        `app-keys-${action}`,
        "user_1",
        limit,
        window,
        store,
        () => clock.now,
      );
      expect(answer, action).toEqual({ allowed: true });
    }
    // Not one counter of the sync budget is an app-keys counter.
    const syncKeys = [...counts.keys()].filter((k) =>
      k.startsWith(COUCH_SYNC_BUDGET_ACTION),
    );
    const appKeysKeys = [...counts.keys()].filter((k) =>
      k.startsWith("app-keys-"),
    );
    expect(syncKeys).toHaveLength(1);
    expect(appKeysKeys).toHaveLength(Object.keys(APP_KEYS_LIMITS).length);
  });

  it("and the other way: spending /api/app-keys does not take from the sync budget", async () => {
    const { store } = memoryStore();
    const { budget, clock } = budgetOver(store);
    for (let i = 0; i < 12; i++) {
      await checkUserRateLimit(
        "app-keys-list",
        "user_1",
        10,
        60,
        store,
        () => clock.now,
      );
    }
    expect(await budget.spend()).toEqual({ allowed: true });
  });
});

describe("the gateway saying 429 (its own ceiling for this key was reached)", () => {
  it("stops this instance sending more exchanges for as long as the gateway said, without touching the counter", async () => {
    const { store, counts } = memoryStore();
    const { budget, clock } = budgetOver(store);
    budget.noteGatewayRateLimit(12);
    const before = counts.size;
    const refused = await budget.spend();
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 12 });
    expect(counts.size).toBe(before);

    clock.now += 7_000;
    expect(await budget.spend()).toEqual({
      allowed: false,
      retryAfterSeconds: 5,
    });
    clock.now += 5_000;
    expect(await budget.spend()).toEqual({ allowed: true });
  });

  it("is bounded: a long or missing Retry-After never silences sync for more than the cap", async () => {
    const { store } = memoryStore();
    const { budget } = budgetOver(store);
    budget.noteGatewayRateLimit(3_600);
    const refused = await budget.spend();
    expect(refused).toEqual({
      allowed: false,
      retryAfterSeconds: GATEWAY_COOLDOWN_MAX_SECONDS,
    });

    const { budget: other } = budgetOver(store);
    other.noteGatewayRateLimit(undefined);
    const noHeader = await other.spend();
    expect(noHeader.allowed).toBe(false);
    expect(
      (noHeader as { retryAfterSeconds: number }).retryAfterSeconds,
    ).toBeLessThanOrEqual(GATEWAY_COOLDOWN_MAX_SECONDS);
  });

  it("a replayed 429 that is already inside the cooldown does not push it further out", async () => {
    const { store } = memoryStore();
    const { budget, clock } = budgetOver(store);
    budget.noteGatewayRateLimit(20);
    clock.now += 15_000;
    budget.noteGatewayRateLimit(5); // the exchanger's replay: 5 s left
    clock.now += 5_000;
    expect(await budget.spend()).toEqual({ allowed: true });
  });

  it("tells the caller whether this note began a cooldown (so the log line is written once, not once per request)", () => {
    const { store } = memoryStore();
    const { budget } = budgetOver(store);
    expect(budget.noteGatewayRateLimit(10)).toBe(true);
    expect(budget.noteGatewayRateLimit(8)).toBe(false);
  });
});

describe("when the counter cannot be read", () => {
  it("fails open like the per-person limit (abuse protection must not take sync down), and the gateway cooldown still applies", async () => {
    const down = vi.fn(async () => {
      throw new Error("mongo down");
    });
    const { budget } = budgetOver(down);
    expect(await budget.spend()).toEqual({ allowed: true });
    budget.noteGatewayRateLimit(10);
    expect((await budget.spend()).allowed).toBe(false);
  });
});

// One number, derived once. The docs and CONTRIBUTING.md quote how many visible
// tabs the budget carries; a hand-typed "roughly 120" outlived the arithmetic
// that gives 72, so the quotes are checked against the constants.
describe("how many tabs the budget carries is derived in one place", () => {
  const REPO = join(__dirname, "..", "..");
  const read = (...p: string[]) => readFileSync(join(REPO, ...p), "utf8");

  it("is the sustained rate times the renewal period: 18 a minute, one renewal per tab every 4 minutes", () => {
    expect(SUSTAINED_EXCHANGES_PER_MINUTE).toBe(18);
    expect(RENEWAL_PERIOD_SECONDS).toBe(240);
    expect(SUPPORTED_VISIBLE_TABS).toBe(72);
    // ...and the sustained rate is the constant's, not a copy of it.
    expect(SUSTAINED_EXCHANGES_PER_MINUTE).toBe(
      (COUCH_SYNC_BUDGET[0] * 60) / COUCH_SYNC_BUDGET[1],
    );
  });

  it("the renewal period is the grant's life less the page's renewal lead (the two constants it stands for)", () => {
    expect(RENEWAL_PERIOD_SECONDS).toBe(
      COUCH_SYNC_MAX_SECONDS - REFRESH_LEAD_MS / 1000,
    );
  });

  it("leaves room for /api/app-keys under the gateway's ceiling, sustained", () => {
    expect(SUSTAINED_EXCHANGES_PER_MINUTE).toBeLessThan(
      GATEWAY_TOKEN_LIMIT_PER_MINUTE,
    );
  });

  it.each([
    ["docs/couchdb-sync.md", ["docs", "couchdb-sync.md"]],
    ["CONTRIBUTING.md", ["CONTRIBUTING.md"]],
  ])(
    "%s quotes the same number as the constant, and no other",
    (_name, path) => {
      const text = read(...path);
      const quoted = [
        ...text.matchAll(/roughly (\d+) (?:visible )?(?:syncing )?tabs/gi),
      ].map((m) => Number(m[1]));
      expect(quoted.length).toBeGreaterThan(0);
      for (const n of quoted) expect(n).toBe(SUPPORTED_VISIBLE_TABS);
      // No other figure for the same thing survives anywhere in the file.
      expect(text).not.toMatch(/\b120 tabs\b/);
      expect(text).not.toMatch(/roughly 120\b/);
    },
  );

  it("the two documents agree with each other on the arithmetic they show", () => {
    const docs = read("docs", "couchdb-sync.md");
    expect(docs).toContain(`${SUSTAINED_EXCHANGES_PER_MINUTE} a minute`);
    expect(docs).toMatch(/every four minutes/);
  });
});
