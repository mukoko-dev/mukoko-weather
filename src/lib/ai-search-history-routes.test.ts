/**
 * Structural tests for how the AI location search and the history analysis
 * are wired through the AI Worker (the logic itself is tested natively in
 * `weather_core::ai::explore` and `weather_core::ai::history`, against
 * `tests/fixtures/explore-search.json`, `history-analysis-stats.json` and
 * `ai-place-profile.json`, whose `expected` values the real Python produced).
 *
 *   - both are public routes the public API relays, each with an hourly
 *     per-client budget in D1 that fails closed;
 *   - the search answers without the model (a text match) when the model or
 *     its budget is unavailable, so it decides for itself what a missing
 *     guardrails block means;
 *   - the history analysis takes its budget after the cache, so a cached
 *     analysis is free, and splices the place profile through the one
 *     `profile::block` wiring;
 *   - the app calls the Worker only, with no `/api/py` fallback.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const aiLib = read("workers/ai/src/lib.rs");
const aiHandlers = read("workers/ai/src/handlers.rs");
const aiExplore = read("workers/ai/src/explore.rs");
const aiWrangler = read("workers/ai/wrangler.jsonc");
const publicApi = read("workers/public-api/src/lib.rs");

const history = aiHandlers.slice(aiHandlers.indexOf("pub async fn history("));

describe("the AI search route", () => {
  it("is a public POST route, answered before the guardrails gate", () => {
    expect(aiLib).toContain('"/v1/ai/explore/search" => Route::Explore');
    expect(aiLib.indexOf("Route::Explore)")).toBeLessThan(
      aiLib.indexOf("Fail closed: no guardrails block"),
    );
    expect(aiLib).toContain("explore::handle(&env, guardrails, caller, body)");
  });

  it("spends the client's hour before any model call and fails closed", () => {
    expect(aiExplore).toContain("Action::ExploreSearch");
    expect(aiExplore).toContain("Decision::ClientLimit");
    // A spent service hour (or an unreadable budget) is the text match.
    expect(aiExplore).toMatch(
      /Decision::GlobalLimit => return text_search\(env, &query, catalogue\)/,
    );
    expect(aiExplore.indexOf("budget::take")).toBeLessThan(
      aiExplore.indexOf("ai_search(env"),
    );
  });

  it("refuses personal data before any call", () => {
    expect(aiExplore).toContain("pii::contains_personal_data(&query)");
    expect(aiExplore).toContain("personal_data_detected");
  });
});

describe("the history analysis route", () => {
  it("spends the visitor's hour only after the cache was tried", () => {
    expect(history).toContain("Action::HistoryAnalysis");
    expect(history.indexOf("kv_get::<CachedAnalysis>")).toBeLessThan(
      history.indexOf("budget::take(ctx.env, Action::HistoryAnalysis"),
    );
    expect(history).toContain("None => Decision::GlobalLimit");
  });

  it("is keyed by the visitor's address, never a person header", () => {
    expect(aiLib).toContain(
      "Route::History).then(|| Caller::from_request(&req))",
    );
  });

  it("grounds the prompt in the place profile through the one wiring", () => {
    expect(history).toContain("with_profile(");
    expect(history).toContain("profile::block(");
    expect(history).toContain("Some(&place.slug)");
  });
});

describe("the bindings and the public API", () => {
  it("the AI Worker binds D1 for the budgets", () => {
    expect(aiWrangler).toContain('"binding": "WEATHER_DB"');
  });

  it("the public API relays the route and names the visitor to the AI Worker", () => {
    expect(publicApi).toContain("explore/search");
    expect(publicApi).toContain('headers.set("X-Mukoko-Client-IP"');
  });
});

describe("the app calls the Worker only", () => {
  it("the search and the analysis components have no /api/py fallback", () => {
    for (const file of [
      "src/components/explore/ExploreSearch.tsx",
      "src/components/weather/HistoryAnalysis.tsx",
    ]) {
      const source = read(file);
      expect(source).toContain("postWorker(");
      expect(source).not.toContain("/api/py/");
    }
  });
});
