//! `mukoko-weather-internal`: the weather API for first-party services.
//!
//! The Nyuchi API (nyuchi-api) proxies `GET /v1/weather/forecast` here
//! (nyuchi/api-gateway#154), configured with `WEATHER_SERVICE_URL` (this
//! Worker's origin) and `WEATHER_SERVICE_API_KEY` (the same value as this
//! Worker's secret of that name).
//!
//! ```text
//! GET /internal/forecast?location=<slug|name> | lat=&lon= [&days=1..7]
//!     Authorization: Bearer <WEATHER_SERVICE_API_KEY>
//! 200 {location, data: [{date, description, weather_code, high, low,
//!      precipitation_probability}], source, fetched_at, attribution}
//! 401 missing or wrong key   404 unknown location   422 bad query
//! 503 key not configured here, or no provider answered (fails closed)
//! GET /health  liveness, no auth, no detail
//! ```
//!
//! This Worker validates and authorises; the forecast itself comes from
//! `mukoko-weather-forecast` over the `FORECAST` service binding.

use weather_core::query::ForecastQuery;
use weather_edge::{bearer_matches, config, error, json, query_pairs};
use worker::{event, Context, Env, Method, Request, Response, Result};

const KEY_SECRET: &str = "WEATHER_SERVICE_API_KEY";
const FORECAST_BINDING: &str = "FORECAST";

#[event(fetch)]
pub async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    if req.method() != Method::Get {
        return error(405, "method_not_allowed", "Only GET is served.");
    }
    match req.path().as_str() {
        "/health" => json(
            200,
            &serde_json::json!({"service": "mukoko-weather-internal", "status": "ok"}),
        ),
        "/internal/forecast" => forecast(req, &env).await,
        _ => error(404, "not_found", "No such route."),
    }
}

async fn forecast(req: Request, env: &Env) -> Result<Response> {
    // Fail closed: with no key configured, nobody is let in.
    let Some(expected) = config(env, KEY_SECRET) else {
        return error(
            503,
            "not_configured",
            "The internal weather API has no key configured.",
        );
    };
    if !bearer_matches(req.headers(), &expected) {
        let resp = error(401, "unauthorized", "A valid service key is required.")?;
        resp.headers().set("WWW-Authenticate", "Bearer")?;
        return Ok(resp);
    }

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
