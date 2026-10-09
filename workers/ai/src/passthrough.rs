//! `POST /internal/chat/completions`: the Python backend's model calls.
//!
//! Reached only from `mukoko-weather-internal`, which checks the service key
//! first and forwards over its `AI_SERVICE` binding. `mukoko-weather-api`
//! forwards `/v1/ai/*` only, so this path is not reachable from the public
//! API. The caller keeps its own prompts and tool loop; this route adds the
//! guardrails, picks the model and budget, and returns an OpenAI chat
//! completion (`weather_core::ai::completions`).

use serde_json::Value;
use weather_core::ai::completions;
use weather_core::ai::guardrails::{system_prompt, Compiled};
use weather_edge::{error, json};
use worker::{Env, Response, Result};

use crate::gateway::{self, ModelError};

/// The gateway metadata route name (no user content).
const ROUTE: &str = "backend";

pub async fn handle(env: &Env, guardrails: &Compiled, body: &Value) -> Result<Response> {
    let req = match completions::parse(body) {
        Ok(r) => r,
        Err(e) => return error(e.status(), e.code(), e.description()),
    };
    let model = completions::pick_model(
        req.model.as_deref(),
        Some(gateway::configured_model(env).as_str()),
    );
    let input = completions::build_input(&req, &model, |app| system_prompt(guardrails, app));
    match gateway::complete(env, ROUTE, &model, &input).await {
        Ok(c) => {
            let created = (js_sys::Date::now() / 1000.0) as i64;
            json(200, &completions::response(&c, &model, created))
        }
        Err(ModelError::Blocked) => error(
            422,
            "content_blocked",
            "The AI Gateway's guardrails blocked this request or its answer.",
        ),
        Err(ModelError::RateLimited) => {
            let resp = error(429, "rate_limited", "The model is busy. Try again shortly.")?;
            resp.headers().set("Retry-After", "30")?;
            Ok(resp)
        }
        Err(ModelError::Failed) => error(502, "model_failed", "The model gave no answer."),
    }
}
