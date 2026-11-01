//! `mukoko-weather-ai`: Shamwari Weather.
//!
//! Reached only through `mukoko-weather-api`, which forwards `/v1/ai/*` over
//! the `AI_SERVICE` binding with the caller's `CF-Connecting-IP`.
//!
//! ```text
//! POST /internal/summary        {location: {slug, name, lat, lon, elevation, country, tags},
//!                                activities} → {insight, cached, generatedAt}
//!                               Only from mukoko-weather-internal (service key checked
//!                               there), for the signed-in app: counted against the
//!                               person's hour (`X-Mukoko-User-Id`, `X-Mukoko-Client-IP`).
//! POST /v1/ai/followup          {message, locationName, locationSlug, weatherSummary,
//!                                activities, season, history} → {response}
//! POST /v1/ai/chat              {message, history, activities} → {response, references}
//! POST /v1/ai/history/analyze   {location, days 7..365, activities}
//!                               → {analysis, stats, cached, dataPoints}
//! POST /v1/ai/explore/search    {query} → {locations, summary, source}
//!                               (the model with two tools, else a text match)
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

mod explore;
mod gateway;
mod handlers;
mod passthrough;
mod profile;

use weather_edge::budget::Caller;
use weather_edge::{error, json, responses};
use worker::{event, Context, Env, Method, Request, Response, Result};

pub(crate) const FORECAST_BINDING: &str = "FORECAST";
pub(crate) const CACHE_BINDING: &str = "AI_CACHE";
pub(crate) const PLACES_BINDING: &str = "PLACES";
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
                "history": env.service(PLACES_BINDING).is_ok(),
                "budget": env.d1("WEATHER_DB").is_ok(),
            }),
        );
    }
    let route = match path.as_str() {
        "/internal/summary" => Route::Summary,
        "/v1/ai/followup" => Route::Followup,
        "/v1/ai/chat" => Route::Chat,
        "/v1/ai/history/analyze" => Route::History,
        "/v1/ai/explore/search" => Route::Explore,
        "/internal/chat/completions" => Route::Completions,
        _ => return error(404, "not_found", "No such route."),
    };
    if req.method() != Method::Post {
        return error(405, "method_not_allowed", "Only POST is served.");
    }
    // The per-IP limit is for the public /v1/ai/* callers. Internal calls all
    // arrive with one key, so a shared bucket would throttle the whole site:
    // the backend passthrough rate-limits per visitor itself, and the
    // signed-in app routes spend the person's hourly D1 budget.
    let internal = matches!(route, Route::Completions | Route::Summary);
    if !internal {
        if let Some(limited) = rate_limited(&req, &env).await {
            return limited;
        }
    }

    let text = req.text().await.unwrap_or_default();
    // Only the backend passthrough carries whole tool loops; the app's routes
    // are a location and a few ids.
    let cap = if matches!(route, Route::Completions) {
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

    // The search is the one route that still answers without the model (the
    // text match), so it decides for itself what a missing block means.
    if matches!(route, Route::Explore) {
        let guardrails = gateway::guardrails(&env).await;
        let caller = Caller::from_request(&req);
        return explore::handle(&env, guardrails, caller, body).await;
    }

    // Fail closed: no guardrails block, no model call on any route.
    let Some(guardrails) = gateway::guardrails(&env).await else {
        return error(
            503,
            "guardrails_unavailable",
            "Shamwari is unavailable right now. Please try again shortly.",
        );
    };
    // The person behind an internal app route, named by the app's server after
    // it checked the WorkOS session and `mukoko-weather-internal` checked the
    // service key. These paths are not reachable from the public API, which
    // forwards `/v1/ai/*` only and builds its own request.
    let caller = matches!(route, Route::Summary).then(|| {
        let subject = req
            .headers()
            .get(weather_core::ai::USER_ID_HEADER)
            .ok()
            .flatten()
            .and_then(|s| weather_core::ai::valid_subject(&s));
        Caller::with_subject(&req, subject)
    });
    // The public history analysis spends the visitor's hour too, keyed by the
    // visitor's address; a person header is never read on a public route.
    let caller =
        caller.or_else(|| matches!(route, Route::History).then(|| Caller::from_request(&req)));
    let ctx = handlers::Ctx {
        env: &env,
        guardrails,
        client_ip: weather_edge::client_ip(&req),
        caller,
    };
    match route {
        Route::Summary => handlers::summary(&ctx, body).await,
        Route::Followup => handlers::followup(&ctx, body).await,
        Route::Chat => handlers::chat(&ctx, body).await,
        Route::History => handlers::history(&ctx, body).await,
        Route::Completions => passthrough::handle(&env, &ctx.guardrails, &body).await,
        // Answered above, before the guardrails gate.
        Route::Explore => error(404, "not_found", "No such route."),
    }
}

enum Route {
    Summary,
    Followup,
    Chat,
    History,
    Explore,
    Completions,
}

/// `Some(429)` when the client is over its limit. A missing limiter binding
/// (local dev) does not block.
async fn rate_limited(req: &Request, env: &Env) -> Option<Result<Response>> {
    let limiter = env.rate_limiter(RATE_LIMITER).ok()?;
    let key = weather_edge::client_ip(req).unwrap_or_else(|| "service-binding".to_owned());
    match limiter.limit(key).await {
        Ok(outcome) if !outcome.success => Some(responses::rate_limited(
            60,
            "Too many requests. Please wait a moment.",
        )),
        _ => None,
    }
}
