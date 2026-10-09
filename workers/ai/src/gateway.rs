//! The two outside calls: the Nyuchi API's compiled guardrails, and the
//! model through the `shamwari` AI Gateway.

use std::cell::RefCell;
use std::time::Duration;

use js_sys::{Function, Promise, Reflect, JSON};
use serde_json::{json, Value};
use weather_core::ai::guardrails::{self, Compiled, Fetched, Freshness};
use weather_core::ai::{completions, is_content_block, is_rate_limited, Turn};
use weather_core::secrets;
use weather_edge::{config, get_with_timeout, now_ms, secret};
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::wasm_bindgen_futures::JsFuture;
use worker::{Env, Headers};

/// The AI Gateway every call goes through (Nyuchi Web Services account).
pub const GATEWAY_ID: &str = "shamwari";
const GUARDRAILS_TIMEOUT: Duration = Duration::from_secs(4);

thread_local! {
    /// The last good guardrails block, kept for the isolate's life.
    static GUARDRAILS: RefCell<Option<Compiled>> = const { RefCell::new(None) };
}

/// The guardrails block to use now, or `None`: refuse.
pub async fn guardrails(env: &Env) -> Option<Compiled> {
    let now = now_ms();
    let cached = GUARDRAILS.with(|g| g.borrow().clone());
    if guardrails::freshness(cached.as_ref(), now) == Freshness::Fresh {
        return cached;
    }
    let etag = cached.as_ref().and_then(|c| c.etag.clone());
    let fetched = fetch_guardrails(env, etag.as_deref(), now).await;
    let settled = guardrails::settle(cached, fetched, now);
    GUARDRAILS.with(|g| *g.borrow_mut() = settled.clone());
    settled
}

async fn fetch_guardrails(env: &Env, etag: Option<&str>, now: u64) -> Fetched {
    let (Some(base), Some(key)) = (
        config(env, "NYUCHI_API_URL"),
        secret(env, secrets::NYUCHI_API_KEY).await,
    ) else {
        return Fetched::Failed;
    };
    let headers = Headers::new();
    let mut ok =
        headers.set("X-API-Key", &key).is_ok() && headers.set("Accept", "application/json").is_ok();
    if let Some(tag) = etag {
        ok &= headers.set("If-None-Match", tag).is_ok();
    }
    if !ok {
        return Fetched::Failed;
    }
    let url = format!(
        "{}/v1/ai/guardrails/compiled?applies_to={}",
        base.trim_end_matches('/'),
        guardrails::SURFACE
    );
    match get_with_timeout(&url, Some(headers), GUARDRAILS_TIMEOUT).await {
        Ok(resp) if resp.status_code() == 304 => Fetched::NotModified,
        Ok(mut resp) if resp.status_code() == 200 => {
            let tag = resp.headers().get("ETag").ok().flatten();
            match resp.json::<Value>().await {
                Ok(body) => {
                    guardrails::parse(&body, tag, now).map_or(Fetched::Failed, Fetched::New)
                }
                Err(_) => Fetched::Failed,
            }
        }
        _ => Fetched::Failed,
    }
}

/// Why a model call gave no text.
pub enum ModelError {
    /// The gateway's Guardrails or DLP blocked the prompt or the answer.
    Blocked,
    /// The gateway or Workers AI rate limit.
    RateLimited,
    /// Anything else (binding missing, model error, empty answer).
    Failed,
}

/// Which call this is, for the gateway's metadata (no user content).
pub struct Call<'a> {
    pub route: &'a str,
    pub max_tokens: u32,
}

/// The configured model (`AI_MODEL`, `@cf/` only), else the default.
pub fn configured_model(env: &Env) -> String {
    completions::pick_model(None, config(env, "AI_MODEL").as_deref())
}

fn gateway_options(route: &str) -> Value {
    json!({
        "gateway": {
            "id": GATEWAY_ID,
            "collectLog": false,
            "metadata": {"route": route, "surface": "weather", "call": "mukoko-weather-ai"},
        }
    })
}

/// Run the model: `system` (guardrails first, already joined) then `turns`.
pub async fn run(
    env: &Env,
    call: Call<'_>,
    system: &str,
    turns: &[Turn],
) -> Result<String, ModelError> {
    let model = configured_model(env);
    let mut messages = vec![json!({"role": "system", "content": system})];
    messages.extend(
        turns
            .iter()
            .map(|t| json!({"role": t.role, "content": t.content})),
    );
    let mut input = json!({
        "messages": messages,
        "max_tokens": completions::token_budget(&model, call.max_tokens),
    });
    if completions::is_reasoning_model(&model) {
        input["reasoning_effort"] = json!(completions::REASONING_EFFORT);
    }
    let out = invoke(env, &model, &input, &gateway_options(call.route))
        .await
        .map_err(|e| classify(&e))?;
    completions::completion(&out)
        .map(|c| c.content)
        .filter(|t| !t.is_empty())
        .ok_or(ModelError::Failed)
}

/// Run a prepared chat-completions `input` (see
/// `weather_core::ai::completions::build_input`) on `model`.
pub async fn complete(
    env: &Env,
    route: &str,
    model: &str,
    input: &Value,
) -> Result<completions::Completion, ModelError> {
    let out = invoke(env, model, input, &gateway_options(route))
        .await
        .map_err(|e| classify(&e))?;
    completions::completion(&out).ok_or(ModelError::Failed)
}

fn classify(err: &str) -> ModelError {
    if is_content_block(err) {
        ModelError::Blocked
    } else if is_rate_limited(err) {
        ModelError::RateLimited
    } else {
        ModelError::Failed
    }
}

/// `env.AI.run(model, input, options)`. workers-rs's `Ai::run` takes no
/// options, and the gateway is chosen in the options, so the binding's JS
/// method is called directly.
async fn invoke(env: &Env, model: &str, input: &Value, options: &Value) -> Result<Value, String> {
    let ai = env.ai("AI").map_err(|e| e.to_string())?;
    let target: &JsValue = ai.as_ref();
    let run: Function = Reflect::get(target, &JsValue::from_str("run"))
        .map_err(js_text)?
        .dyn_into()
        .map_err(js_text)?;
    let input = JSON::parse(&input.to_string()).map_err(js_text)?;
    let options = JSON::parse(&options.to_string()).map_err(js_text)?;
    let promise: Promise = run
        .call3(target, &JsValue::from_str(model), &input, &options)
        .map_err(js_text)?
        .dyn_into()
        .map_err(js_text)?;
    let out = JsFuture::from(promise).await.map_err(js_text)?;
    let text = JSON::stringify(&out)
        .map_err(js_text)?
        .as_string()
        .unwrap_or_default();
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

fn js_text(v: JsValue) -> String {
    if let Some(e) = v.dyn_ref::<js_sys::Error>() {
        return String::from(e.message());
    }
    v.as_string()
        .or_else(|| JSON::stringify(&v).ok().and_then(|s| s.as_string()))
        .unwrap_or_default()
}
