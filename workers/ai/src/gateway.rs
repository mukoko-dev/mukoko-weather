//! The two outside calls: the Nyuchi API's compiled guardrails, and the
//! model through the `shamwari` AI Gateway.

use std::cell::RefCell;
use std::time::Duration;

use js_sys::{Function, Promise, Reflect, JSON};
use serde_json::{json, Value};
use weather_core::ai::failure::{Class, Failure, Stage};
use weather_core::ai::guardrails::{self, Compiled, Fetched, Freshness};
use weather_core::ai::{completions, Turn};
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
        .map_err(|fault| fault.report(call.route))?;
    completions::completion(&out)
        .map(|c| c.content)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| empty(call.route, &out))
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
        .map_err(|fault| fault.report(route))?;
    completions::completion(&out).ok_or_else(|| empty(route, &out))
}

/// One warn line for a failed call, and the error the caller sees. The line
/// carries the route, the class, the stage and the error code and HTTP status
/// when the error names them: never the message, a prompt, an answer or a key
/// (`weather_core::ai::failure`).
fn log_failure(failure: &Failure) -> ModelError {
    worker::console_warn!("{}", failure.line());
    match failure.class() {
        Class::Blocked => ModelError::Blocked,
        Class::RateLimited => ModelError::RateLimited,
        Class::Failed | Class::Empty => ModelError::Failed,
    }
}

/// The call answered, with no text and no tool call.
fn empty(route: &str, out: &Value) -> ModelError {
    log_failure(&Failure::from_output(route, out))
}

/// What went wrong in [`invoke`], and where.
struct Fault {
    stage: Stage,
    /// The JS error's class name (`AiError`), when it had one.
    name: Option<String>,
    /// The error's message. Read for a code and a status, never logged.
    text: String,
}

impl Fault {
    /// A failure with no JS value behind it.
    fn new(stage: Stage, text: String) -> Fault {
        Fault {
            stage,
            name: None,
            text,
        }
    }

    /// A failure with a thrown or rejected JS value: its message, and its
    /// `name` when it is an object (an `Error`, or the plain object the
    /// binding rejects with).
    fn of(stage: Stage, v: JsValue) -> Fault {
        let name = v
            .is_object()
            .then(|| Reflect::get(&v, &JsValue::from_str("name")).ok())
            .flatten()
            .and_then(|n| n.as_string());
        Fault {
            stage,
            name,
            text: js_text(v),
        }
    }

    fn report(self, route: &str) -> ModelError {
        log_failure(&Failure::from_error(
            route,
            self.stage,
            self.name.as_deref(),
            &self.text,
        ))
    }
}

/// `env.AI.run(model, input, options)`. workers-rs's `Ai::run` takes no
/// options, and the gateway is chosen in the options, so the binding's JS
/// method is called directly.
async fn invoke(env: &Env, model: &str, input: &Value, options: &Value) -> Result<Value, Fault> {
    let ai = env
        .ai("AI")
        .map_err(|e| Fault::new(Stage::Binding, e.to_string()))?;
    let target: &JsValue = ai.as_ref();
    let run: Function = Reflect::get(target, &JsValue::from_str("run"))
        .map_err(|v| Fault::of(Stage::Binding, v))?
        .dyn_into()
        .map_err(|v| Fault::of(Stage::Binding, v))?;
    let input = JSON::parse(&input.to_string()).map_err(|v| Fault::of(Stage::Input, v))?;
    let options = JSON::parse(&options.to_string()).map_err(|v| Fault::of(Stage::Input, v))?;
    let promise: Promise = run
        .call3(target, &JsValue::from_str(model), &input, &options)
        .map_err(|v| Fault::of(Stage::Call, v))?
        .dyn_into()
        .map_err(|v| Fault::of(Stage::Call, v))?;
    let out = JsFuture::from(promise)
        .await
        .map_err(|v| Fault::of(Stage::Rejected, v))?;
    let text = JSON::stringify(&out)
        .map_err(|v| Fault::of(Stage::Output, v))?
        .as_string()
        .unwrap_or_default();
    serde_json::from_str(&text).map_err(|e| Fault::new(Stage::Output, e.to_string()))
}

fn js_text(v: JsValue) -> String {
    if let Some(e) = v.dyn_ref::<js_sys::Error>() {
        return String::from(e.message());
    }
    v.as_string()
        .or_else(|| JSON::stringify(&v).ok().and_then(|s| s.as_string()))
        .unwrap_or_default()
}
