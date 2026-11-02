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
const budget = read("workers/crates/weather-edge/src/budget.rs");
const coreBudget = read("workers/crates/weather-core/src/budget.rs");
const bridge = read("workers/mongo-bridge/src/stores.ts");

describe("history Worker: degraded answers", () => {
  it("fetches nothing when a store could not be read (what is held is unknown)", () => {
    expect(worker).toContain(
      "let holdings_known = h::holdings_known(d1_read, mongo_read);",
    );
    expect(worker).toContain("if holdings_known && !missing.is_empty() {");
    expect(worker).toContain(
      "let degraded = h::is_degraded(holdings_known, upstream_trouble, still_missing);",
    );
  });

  it("is a 502 only when no store was actually read (a skipped store is not a read)", () => {
    expect(worker).toContain(
      "if stored.is_empty() && h::no_store_read(d1_read, mongo_read) {",
    );
    // D1 holds nothing for a spot or a bare coordinate: not asked, not read.
    expect(worker).toContain("return (Vec::new(), StoreRead::NotApplicable);");
    expect(worker).not.toContain("d1_ok");
    expect(worker).not.toContain("mongo_ok");
  });

  it("tells the client when the answer is degraded, not only when a store failed", () => {
    expect(worker).toMatch(
      /if degraded \{\s*body\["degraded"\] = json!\(true\);/,
    );
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
    expect(denials.length).toBeGreaterThanOrEqual(7);
  });

  it("marks the per-request caps as degraded too (a cut-short answer is not a plain lag)", () => {
    // The clock and the upstream-call cap end the whole attempt.
    expect(worker).toMatch(
      /now_ms\(\) - started > TIME_BUDGET_MS \{\s*degraded = true;\s*break 'runs;/,
    );
    expect(worker).toMatch(
      /fetches >= MAX_FETCHES_PER_CALL \{\s*degraded = true;\s*break 'runs;/,
    );
    // And so does Open-Meteo's weighted cap.
    expect(worker).toMatch(
      /om_units\.saturating_add\(units\) > spec\.units_per_call\(\) \{[\s\S]*?degraded = true;[\s\S]*?unusable\.insert/,
    );
  });

  it("serves a chunk from our own KV even after the upstream-call cap", () => {
    // The cap is checked on a cache miss only.
    const loop = worker.slice(worker.indexOf("async fn backfill("));
    expect(loop.indexOf("cached_days(env")).toBeLessThan(
      loop.indexOf("fetches >= MAX_FETCHES_PER_CALL"),
    );
  });

  it("logs why a background save failed: the status and the bridge's error code", () => {
    expect(worker).toContain(
      "if let Err(why) = save(&env, &key, &pending).await {",
    );
    expect(worker).toContain(
      '"history: could not store {} archive days: {why}"',
    );
    expect(worker).toContain("other.failure_reason()");
    const client = read("workers/places/src/bridge.rs");
    expect(client).toContain("bridge_failure_reason(");
    // Never a URL or a body in a log line.
    expect(client).not.toContain("console_warn");
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
    expect(coreBudget).toContain("WITH RECURSIVE");
    expect(coreBudget).toContain("n(i) AS");
  });

  it("decides a spend in ONE statement, so parallel requests cannot all pass", () => {
    // The check and the write are one guarded INSERT; D1's change count is
    // the decision. There is no count-then-insert pair.
    expect(budget).toContain(".prepare(budget::SPEND_SQL)");
    expect(budget).toContain("budget::spend_granted(changes)");
    expect(budget).not.toContain("decide_units(");
    expect(budget).not.toContain("INSERT_UNITS");
    expect(budget).not.toContain("async fn record(");
    // Both gates are in the statement itself.
    expect(coreBudget).toContain("AND at >= ?5) + ?4 <= ?6");
    expect(coreBudget).toContain("AND at >= ?5) + ?4 <= ?7");
    // The counts are read only to name the full hour AFTER a refusal.
    const take = budget.slice(budget.indexOf("pub async fn take_units("));
    expect(take.indexOf("spend(env")).toBeGreaterThan(-1);
    expect(take.indexOf("spend(env")).toBeLessThan(take.indexOf("counts(env"));
    expect(take).toContain("Ok(false) => match counts(");
  });

  it("fails closed when the budget cannot be written or read", () => {
    const take = budget.slice(budget.indexOf("pub async fn take_units("));
    expect(take).toContain("Err(_) => Decision::GlobalLimit");
    // A result without a change count is a refusal, not a grant.
    expect(budget).toContain('"no change count"');
    expect(coreBudget).toContain("changes.is_some_and(|c| c > 0)");
  });
});

describe("history Worker: keys", () => {
  it("reads a place's platform alias too, found from the place record", () => {
    // The Worker sends the catalogue place's own point with the flag ...
    expect(worker).toContain('"&aliases=1&lat={:.4}&lon={:.4}"');
    // ... and the bridge looks the place up in placesGeo (read only, by
    // distance), never by a name pattern: two places share a name.
    expect(bridge).toContain("$geoWithin");
    expect(bridge).toContain("placeAliasStore");
    expect(bridge).not.toContain("$regex");
    expect(bridge).not.toContain("replace(/[^a-z0-9-]/g");
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
