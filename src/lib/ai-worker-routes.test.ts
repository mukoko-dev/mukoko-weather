/**
 * Structural tests for how the signed-in AI summary is wired through the
 * Workers (the logic itself is tested natively in `weather_core::ai`, against
 * `tests/fixtures/ai-summary.json`).
 *
 * The summary is a signed-in feature. The sign-in gate is the app's
 * `/api/ai` proxy, so the Workers must not offer a way round it:
 *   - the AI Worker serves the summary on an `/internal/` path only;
 *   - `mukoko-weather-api` (public) forwards `/v1/ai/*` only, and the AI
 *     Worker has no `/v1/ai/summary` or `/v1/ai` route;
 *   - `mukoko-weather-internal` checks the service key before it forwards;
 *   - a model call is counted against the person only after the cache has
 *     been tried, and fails closed.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const aiLib = read("workers/ai/src/lib.rs");
const aiHandlers = read("workers/ai/src/handlers.rs");
const aiWrangler = read("workers/ai/wrangler.jsonc");
const internal = read("workers/internal-api/src/lib.rs");
const aiProfile = read("workers/ai/src/profile.rs");
const forecastLib = read("workers/forecast/src/lib.rs");
const forecastProfile = read("workers/forecast/src/profile.rs");
const publicApi = read("workers/public-api/src/lib.rs");

describe("the AI summary is not public", () => {
  it("the AI Worker serves it on /internal/summary only", () => {
    expect(aiLib).toContain('"/internal/summary" => Route::Summary');
    expect(aiLib).not.toContain('"/v1/ai/summary"');
    expect(aiLib).not.toMatch(/"\/v1\/ai"\s*(\||=>)/);
  });

  it("the public API forwards /v1/ai/* only and builds its own request", () => {
    expect(publicApi).toContain('path.starts_with("/v1/ai/")');
    // The path it forwards is the visitor's, so /internal/* is unreachable.
    expect(publicApi).toContain('format!("https://ai{}", req.path())');
    expect(publicApi).not.toContain("/internal/summary");
  });

  it("the internal Worker checks the service key before it forwards", () => {
    expect(internal).toMatch(
      /\("\/internal\/ai\/summary", Method::Post\) => match authorised\(&req, &env\)\.await\? \{\s*Some\(refused\) => Ok\(refused\),\s*None => app_ai\(&mut req, &env, "\/internal\/summary"\)\.await,/,
    );
  });

  it("the internal Worker never passes the service key on", () => {
    const fn = internal.slice(internal.indexOf("async fn app_ai("));
    expect(fn.slice(0, fn.indexOf("async fn relay_ai("))).not.toContain(
      "Authorization",
    );
  });
});

describe("the model budget", () => {
  const summary = aiHandlers.slice(
    aiHandlers.indexOf("pub async fn summary("),
    aiHandlers.indexOf("/// `POST /v1/ai/followup`"),
  );

  it("counts a summary only when the cache missed, and before the model", () => {
    const cache = summary.indexOf("kv_get::<CachedSummary>");
    const spend = summary.indexOf("spend(ctx, Action::AiSummary)");
    const model = summary.indexOf("gateway::run(");
    expect(cache).toBeGreaterThan(-1);
    expect(spend).toBeGreaterThan(cache);
    expect(model).toBeGreaterThan(spend);
  });

  it("fails closed: a budget it cannot read is a refusal", () => {
    expect(aiHandlers).toContain("budget::take(ctx.env, action, caller)");
    expect(aiHandlers).toContain("Decision::GlobalLimit");
  });

  it("the AI Worker binds the D1 database the budgets live in", () => {
    expect(aiWrangler).toMatch(/"binding":\s*"WEATHER_DB"/);
    expect(aiWrangler).toContain("9a8846ea-ee34-4479-bc4c-790ee2beabee");
  });

  it("only the signed-in routes spend a budget (the public ones keep the per-minute limiter)", () => {
    expect(aiLib).toContain("matches!(route, Route::Summary).then(");
    expect(aiLib).toContain("Route::Completions | Route::Summary");
  });
});

describe("the place profile grounds the summary prompt", () => {
  const summary = aiHandlers.slice(
    aiHandlers.indexOf("pub async fn summary("),
    aiHandlers.indexOf("/// `POST /v1/ai/followup`"),
  );

  it("the summary splices the block with its grounding rule, from the point and never the client's slug", () => {
    expect(summary).toContain("with_profile(");
    expect(summary).toContain("profile::block(ctx.env, None,");
    expect(summary).toContain(
      "prompts::summary_request(&summary_loc, &data, &acts, &season, &block)",
    );
  });

  it("the AI Worker asks the forecast Worker over the binding, bounded at 4 s, and never fails an answer", () => {
    expect(aiProfile).toContain("https://forecast/profile-block?");
    expect(aiProfile).toContain("Duration::from_secs(4)");
    expect(aiProfile).toContain("pub async fn block(");
    // Every failure is an empty block.
    expect(aiProfile).toContain('.unwrap_or("")');
    expect(aiProfile).toContain("return String::new()");
  });

  it("the forecast route exists and is cache-only", () => {
    expect(forecastLib).toContain(
      '"/profile-block" => profile::prompt_block(&req, &env).await',
    );
    const route = forecastProfile.slice(
      forecastProfile.indexOf("pub async fn prompt_block("),
    );
    for (const upstream of [
      "fetch_normals(",
      "fetch_soil(",
      "limit::take(",
      "get_with_timeout(",
    ]) {
      expect(route).not.toContain(upstream);
    }
    expect(route).toContain("profile_prompt_block(&profile)");
  });
});
