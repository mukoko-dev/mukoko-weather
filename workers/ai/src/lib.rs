//! `mukoko-weather-ai`: Shamwari Weather.
//!
//! Reached only through `mukoko-weather-api`, which forwards `/v1/ai/*` over
//! the `AI_SERVICE` binding with the caller's `CF-Connecting-IP`.
//!
//! ```text
//! POST /v1/ai, /v1/ai/summary   {weatherData, location, activities} → {insight, cached, generatedAt}
//! POST /v1/ai/followup          {message, locationName, locationSlug, weatherSummary,
//!                                activities, season, history} → {response}
//! POST /v1/ai/chat              {message, history, activities} → {response, references}
//! POST /v1/ai/history/analyze   {location, days 7..365, activities}
//!                               → {analysis, stats, cached, dataPoints}
//! POST /internal/chat/completions  OpenAI-style {messages, tools?, max_tokens?, model?}
//!                               → an OpenAI chat completion. Only from
//!                                 mukoko-weather-internal (service key checked
//!                                 there): the Python backend's model calls.
//! GET  /health
//! ```
//!
//! Every model call goes to an open-weights Workers AI model through the
//! `shamwari` AI Gateway, with the Nyuchi API's compiled guardrails first in
//! the system prompt. No guardrails, no model call: `503
//! guardrails_unavailable`. Messages carrying personal data are refused
//! before any call (`422 personal_data_detected`).

mod gateway;
mod handlers;
mod passthrough;

use weather_edge::{error, json};
use worker::{event, Context, Env, Method, Request, Response, Result};

pub(crate) const FORECAST_BINDING: &str = "FORECAST";
pub(crate) const CACHE_BINDING: &str = "AI_CACHE";
pub(crate) const DB_BINDING: &str = "WEATHER_DB";
const RATE_LIMITER: &str = "RATE_LIMITER";
/// Bodies larger than this are refused before parsing.
const MAX_BODY_BYTES: usize = 64 * 1024;
/// The backend passthrough carries whole tool loops (forecasts as JSON).
const MAX_INTERNAL_BODY_BYTES: usize = 512 * 1024;

#[event(fetch)]
pub async fn fetch(mut req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let path = req.path();
    if path == "/health" {
        return json(
            200,
            &serde_json::json!({
                "service": "mukoko-weather-ai",
                "status": "ok",
                "ai": env.ai("AI").is_ok(),
                "cache": env.kv(CACHE_BINDING).is_ok(),
                "history_db": env.d1(DB_BINDING).is_ok(),
            }),
        );
    }
    let route = match path.as_str() {
        "/v1/ai" | "/v1/ai/summary" => Route::Summary,
        "/v1/ai/followup" => Route::Followup,
        "/v1/ai/chat" => Route::Chat,
        "/v1/ai/history/analyze" => Route::History,
        "/internal/chat/completions" => Route::Completions,
        _ => return error(404, "not_found", "No such route."),
    };
    if req.method() != Method::Post {
        return error(405, "method_not_allowed", "Only POST is served.");
    }
    // The per-IP limit is for the app's own /v1/ai/* callers. Backend calls
    // all arrive with one key, so a shared bucket would throttle the whole
    // site; the backend rate-limits per visitor itself.
    let internal = matches!(route, Route::Completions);
    if !internal {
        if let Some(limited) = rate_limited(&req, &env).await {
            return limited;
        }
    }

    let text = req.text().await.unwrap_or_default();
    let cap = if internal {
        MAX_INTERNAL_BODY_BYTES
    } else {
        MAX_BODY_BYTES
    };
    if text.len() > cap {
        return error(413, "payload_too_large", "The request body is too large.");
    }
    let Ok(body) = serde_json::from_str::<serde_json::Value>(&text) else {
        return error(400, "invalid_request", "The body must be JSON.");
    };

    // Fail closed: no guardrails block, no model call on any route.
    let Some(guardrails) = gateway::guardrails(&env).await else {
        return error(
            503,
            "guardrails_unavailable",
            "Shamwari is unavailable right now. Please try again shortly.",
        );
    };
    let ctx = handlers::Ctx {
        env: &env,
        guardrails,
    };
    match route {
        Route::Summary => handlers::summary(&ctx, body).await,
        Route::Followup => handlers::followup(&ctx, body).await,
        Route::Chat => handlers::chat(&ctx, body).await,
        Route::History => handlers::history(&ctx, body).await,
        Route::Completions => passthrough::handle(&env, &ctx.guardrails, &body).await,
    }
}

enum Route {
    Summary,
    Followup,
    Chat,
    History,
    Completions,
}

/// `Some(429)` when the client is over its limit. A missing limiter binding
/// (local dev) does not block.
async fn rate_limited(req: &Request, env: &Env) -> Option<Result<Response>> {
    let limiter = env.rate_limiter(RATE_LIMITER).ok()?;
    let key = req
        .headers()
        .get("CF-Connecting-IP")
        .ok()
        .flatten()
        .unwrap_or_else(|| "service-binding".to_owned());
    match limiter.limit(key).await {
        Ok(outcome) if !outcome.success => {
            let resp = error(
                429,
                "rate_limited",
                "Too many requests. Please wait a moment.",
            );
            if let Ok(r) = &resp {
                let _ = r.headers().set("Retry-After", "60");
            }
            Some(resp)
        }
        _ => None,
    }
}
