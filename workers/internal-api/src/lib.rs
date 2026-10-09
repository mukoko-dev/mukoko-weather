//! `mukoko-weather-internal`: the weather API for first-party services.
//!
//! The Nyuchi API (nyuchi-api) proxies `GET /v1/weather/forecast` here
//! (nyuchi/api-gateway#154), configured with `WEATHER_SERVICE_URL` (this
//! Worker's origin) and `WEATHER_SERVICE_API_KEY` (the same value as this
//! Worker's secret of that name, read from the Secrets Store as
//! `MUKOKO_WEATHER_SERVICE_API_KEY`).
//!
//! ```text
//! GET /internal/forecast?location=<slug|name> | lat=&lon= [&days=1..7]
//!     Authorization: Bearer <WEATHER_SERVICE_API_KEY>
//! 200 {location, data: [{date, description, weather_code, high, low,
//!      precipitation_probability}], source, fetched_at, attribution}
//! 401 missing or wrong key   404 unknown location   422 bad query
//! 503 key not configured here, or no provider answered (fails closed)
//!
//! POST /internal/ai/chat/completions
//!     Authorization: Bearer <WEATHER_SERVICE_API_KEY>
//!     {messages, tools?, max_tokens?, model?}   (OpenAI chat completions)
//! 200 an OpenAI chat completion (content only, never the model's reasoning)
//! 400 bad request   401 missing or wrong key   413 too large
//! 422 personal data or a guardrails block   429 model busy
//! 502 model or AI Worker failed   503 key or guardrails not configured
//! GET /health  liveness, no auth, no detail
//! ```
//!
//! The chat-completions route is how the app's Python backend (on Vercel)
//! reaches Workers AI: it holds this key and no Cloudflare AI token. The
//! call goes over the `AI_SERVICE` binding to `mukoko-weather-ai`, which
//! runs it through the `shamwari` AI Gateway with the Nyuchi guardrails.
//!
//! This Worker validates and authorises; the forecast itself comes from
//! `mukoko-weather-forecast` over the `FORECAST` service binding.

use weather_core::auth::{gate, Gate};
use weather_core::query::ForecastQuery;
use weather_edge::{error, json, query_pairs, secret};
use worker::wasm_bindgen::JsValue;
use worker::{event, Context, Env, Headers, Method, Request, RequestInit, Response, Result};

const KEY_SECRET: &str = weather_core::secrets::WEATHER_SERVICE_API_KEY;
const FORECAST_BINDING: &str = "FORECAST";
const AI_BINDING: &str = "AI_SERVICE";
/// Larger chat-completions bodies are refused here (the AI Worker's cap).
const MAX_AI_BODY_BYTES: usize = 512 * 1024;

#[event(fetch)]
pub async fn fetch(mut req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let method = req.method();
    match (req.path().as_str(), method) {
        ("/health", Method::Get) => json(
            200,
            &serde_json::json!({"service": "mukoko-weather-internal", "status": "ok"}),
        ),
        ("/internal/forecast", Method::Get) => match authorised(&req, &env).await? {
            Some(refused) => Ok(refused),
            None => forecast(req, &env).await,
        },
        ("/internal/ai/chat/completions", Method::Post) => match authorised(&req, &env).await? {
            Some(refused) => Ok(refused),
            None => completions(&mut req, &env).await,
        },
        ("/health" | "/internal/forecast", _) => {
            error(405, "method_not_allowed", "Only GET is served.")
        }
        ("/internal/ai/chat/completions", _) => {
            error(405, "method_not_allowed", "Only POST is served.")
        }
        _ => error(404, "not_found", "No such route."),
    }
}

/// `None` when the service key matches; otherwise the refusal. Fails
/// closed: with no key configured, nobody is let in.
async fn authorised(req: &Request, env: &Env) -> Result<Option<Response>> {
    let expected = secret(env, KEY_SECRET).await;
    let header = req.headers().get("Authorization").ok().flatten();
    match gate(header.as_deref(), expected.as_deref()) {
        Gate::Allowed => Ok(None),
        Gate::NotConfigured => error(
            503,
            "not_configured",
            "The internal weather API has no key configured.",
        )
        .map(Some),
        Gate::Unauthorized => {
            let resp = error(401, "unauthorized", "A valid service key is required.")?;
            resp.headers().set("WWW-Authenticate", "Bearer")?;
            Ok(Some(resp))
        }
    }
}

/// Forward a chat-completions call to `mukoko-weather-ai` and relay its
/// answer. Only the body crosses; the service key does not.
async fn completions(req: &mut Request, env: &Env) -> Result<Response> {
    let body = req.text().await.unwrap_or_default();
    if body.len() > MAX_AI_BODY_BYTES {
        return error(413, "payload_too_large", "The request body is too large.");
    }
    let headers = Headers::new();
    headers.set("Content-Type", "application/json")?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(JsValue::from_str(&body)));
    let inner = Request::new_with_init("https://ai/internal/chat/completions", &init)?;
    let Ok(mut upstream) = env.service(AI_BINDING)?.fetch_request(inner).await else {
        return error(
            502,
            "upstream_unreachable",
            "The AI service did not answer.",
        );
    };
    let status = upstream.status_code();
    let Ok(answer) = upstream.json::<serde_json::Value>().await else {
        return error(
            502,
            "upstream_malformed",
            "The AI service sent a bad answer.",
        );
    };
    let resp = json(status, &answer)?;
    if let Ok(Some(after)) = upstream.headers().get("Retry-After") {
        resp.headers().set("Retry-After", &after)?;
    }
    Ok(resp)
}

async fn forecast(req: Request, env: &Env) -> Result<Response> {
    let pairs = query_pairs(&req)?;
    if let Err(e) = ForecastQuery::parse(pairs.iter().map(|(k, v)| (k.as_str(), v.as_str()))) {
        return error(422, "invalid_request", &e.to_string());
    }

    let query = req.url()?.query().unwrap_or("").to_owned();
    let upstream = env
        .service(FORECAST_BINDING)?
        .fetch(format!("https://forecast/daily?{query}"), None)
        .await;
    let mut upstream = match upstream {
        Ok(r) => r,
        Err(_) => {
            return error(
                502,
                "upstream_unreachable",
                "The forecast service did not answer.",
            )
        }
    };
    let status = upstream.status_code();
    match status {
        200 | 404 | 422 | 503 => {
            let body: serde_json::Value = match upstream.json().await {
                Ok(b) => b,
                Err(_) => {
                    return error(
                        502,
                        "upstream_malformed",
                        "The forecast service sent a bad answer.",
                    )
                }
            };
            let resp = json(status, &body)?;
            if status == 200 {
                resp.headers()
                    .set("Cache-Control", "private, max-age=300")?;
            }
            Ok(resp)
        }
        _ => error(502, "upstream_error", "The forecast service failed."),
    }
}
