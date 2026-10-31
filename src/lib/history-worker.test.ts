import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

/**
 * The history Worker's I/O loop (`workers/places/src/history.rs`) cannot run
 * natively (it needs a Worker runtime), so the rules that keep a degraded
 * answer from becoming a wrong one are pinned here against its source. The
 * decisions themselves (weighted units, clamps, merge, ranges) are natively
 * tested in `weather_core::history` and `weather_core::budget`.
 */
const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf-8");
const worker = read("workers/places/src/history.rs");
const budget = read("workers/places/src/budget.rs");
const bridge = read("workers/mongo-bridge/src/stores.ts");

describe("history Worker: degraded answers", () => {
  it("fetches nothing when a store could not be read (what is held is unknown)", () => {
    expect(worker).toContain("let holdings_known = d1_ok && mongo_ok;");
    expect(worker).toContain("if holdings_known && !missing.is_empty() {");
    expect(worker).toContain("let mut degraded = !holdings_known;");
  });

  it("never caches a degraded answer", () => {
    expect(worker).toContain("CachePolicy::NoStore");
    expect(worker).toMatch(/if degraded \{[\s\S]*?CachePolicy::NoStore/);
    // A plain lag is the only thing cached publicly for 60 s.
    expect(worker).toContain("CachePolicy::Public(60)");
    expect(worker).toContain('"no-store"');
  });

  it("marks a budget denial, an open breaker and a provider failure as degraded", () => {
    const denials = worker.match(/degraded = true;/g) ?? [];
    expect(denials.length).toBeGreaterThanOrEqual(4);
  });
});

describe("history Worker: the request survives a client that gives up", () => {
  it("answers first and stores in the background", () => {
    expect(worker).toContain("ctx.wait_until(async move {");
    // The save is not awaited inline in the backfill loop.
    const loop = worker.slice(
      worker.indexOf("async fn backfill("),
      worker.indexOf("/// Insert-only through the bridge"),
    );
    expect(loop).not.toContain("save(env");
  });

  it("sends the saving flag, not a saved flag it cannot know", () => {
    expect(worker).toContain("!pending.is_empty()");
    expect(worker).not.toContain('"saved"');
  });
});

describe("history Worker: budgets", () => {
  it("spends the request-level budget only when a call goes upstream", () => {
    const loop = worker.slice(
      worker.indexOf("async fn backfill("),
      worker.indexOf("/// Insert-only through the bridge"),
    );
    // The KV lookup comes before the request-level budget.
    expect(loop.indexOf("cached_days(env")).toBeGreaterThan(-1);
    expect(loop.indexOf("cached_days(env")).toBeLessThan(
      loop.indexOf("if request_budget.is_none() {"),
    );
    // And it is spent once.
    expect(loop).toContain("if request_budget.is_none() {");
    expect(worker).not.toMatch(
      /serve[\s\S]*budget::take\(env, action, &caller\)[\s\S]*backfill\(/,
    );
  });

  it("spends Open-Meteo in weighted units and caps a request", () => {
    expect(worker).toContain("spec.cost(");
    expect(worker).toContain("budget::take_units(env, action, caller, units)");
    expect(worker).toContain("spec.units_per_call()");
    expect(budget).toContain("pub async fn take_units(");
    // One event row per unit.
    expect(budget).toContain("WITH RECURSIVE n(i)");
  });
});

describe("history Worker: keys", () => {
  it("reads a place's platform alias too", () => {
    expect(worker).toContain("&aliases=1");
    expect(bridge).toContain("[0-9a-f]{6}$");
  });

  it("limits a spot to the newest year counted from today", () => {
    expect(worker).toContain("h::clamp_recent(");
    expect(worker).not.toContain("window_floor(");
  });
});

describe("the page waits long enough for a cold view", () => {
  const page = read("src/app/history/HistoryDashboard.tsx");
  it("passes the history fetch options", () => {
    expect(page).toContain("historyFetchOptions(dayCount)");
  });
  it("the cards that read 30 days wait longer than 8 s too", () => {
    expect(read("src/lib/use-climate-averages.ts")).toContain(
      "historyFetchOptions(30)",
    );
    expect(read("src/components/weather/AgricultureHistory.tsx")).toContain(
      "historyFetchOptions(30)",
    );
  });
});
