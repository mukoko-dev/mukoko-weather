//! Worker-side helpers shared by the Mukoko Weather Workers.
//!
//! Kept thin on purpose: anything that can be tested without a Worker runtime
//! belongs in `weather-core`.

use std::time::Duration;

use futures::future::{select, Either};
use serde::Serialize;
use serde_json::json;
use subtle::ConstantTimeEq;
use weather_core::secrets::{self, SecretCache, StoreRead};
use worker::wasm_bindgen::JsValue;
use worker::{
    console_warn, AbortController, Delay, Env, Fetch, Headers, Request, Response, Result,
    SecretStore, Url,
};

/// Milliseconds since the epoch, from the Worker clock.
pub fn now_ms() -> u64 {
    js_sys::Date::now() as u64
}

/// The Worker clock as a `chrono` time.
pub fn now() -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::from_timestamp_millis(now_ms() as i64).unwrap_or_default()
}

/// RFC 3339 with second precision and a `Z`.
pub fn now_rfc3339() -> String {
    now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// A JSON response with a status and `Cache-Control: no-store` unless the
/// caller sets its own.
pub fn json<T: Serialize>(status: u16, body: &T) -> Result<Response> {
    let resp = Response::from_json(body)?.with_status(status);
    resp.headers().set("Cache-Control", "no-store")?;
    Ok(resp)
}

/// The error envelope every Worker uses: `{"error": code, "error_description": text}`.
pub fn error(status: u16, code: &str, description: &str) -> Result<Response> {
    json(
        status,
        &json!({"error": code, "error_description": description}),
    )
}

/// Read a plain var (or a plain wrangler secret); `None` when unset or empty.
/// Secrets go through [`secret`], which reads the Secrets Store first.
pub fn config(env: &Env, name: &str) -> Option<String> {
    env.secret(name)
        .map(|s| s.to_string())
        .or_else(|_| env.var(name).map(|v| v.to_string()))
        .ok()
        .filter(|s| !s.trim().is_empty())
}

thread_local! {
    /// Secrets read in this isolate (`weather_core::secrets`).
    static SECRETS: std::rc::Rc<SecretCache> = std::rc::Rc::new(SecretCache::new());
}

/// A secret by its plain name (`weather_core::secrets::TOMORROW_API_KEY`
/// and friends); `None` when unset or empty.
///
/// Read from the Cloudflare Secrets Store binding named after the key's one
/// store secret (`weather_core::secrets::ALL`) and kept for the isolate. TRANSITION: falls back to the plain wrangler
/// secret `<name>` when the binding is missing, the secret is not in the
/// store, or the read fails, logging a warning once per isolate (name and
/// reason only, never the value). Remove the fallback once every secret is
/// confirmed in the store (see `weather_core::secrets`).
pub async fn secret(env: &Env, name: &str) -> Option<String> {
    let cache = SECRETS.with(|c| c.clone());
    let lookup = cache
        .get(name, || read_store(env, name), || config(env, name))
        .await;
    if let Some(why) = lookup.warn {
        console_warn!(
            "secrets: {name} read from the plain Worker secret ({}); add {} to the Secrets Store",
            why.reason(),
            secrets::store_name(name).unwrap_or("its store secret")
        );
    }
    lookup.value
}

async fn read_store(env: &Env, name: &str) -> StoreRead {
    let Some(binding) = secrets::store_name(name) else {
        return StoreRead::Unbound;
    };
    let Ok(value) = js_sys::Reflect::get(env, &JsValue::from_str(binding)) else {
        return StoreRead::Unbound;
    };
    if value.is_undefined() || value.is_null() {
        return StoreRead::Unbound;
    }
    // `wrangler dev --var` / `.dev.vars` under the store name: a plain string.
    if let Some(v) = value.as_string() {
        return StoreRead::Value(v);
    }
    // A Secrets Store binding is an object with an async `get()`. workers-rs's
    // `Env::secret_store` also checks the constructor name; this does not
    // depend on it.
    let is_store = js_sys::Reflect::get(&value, &JsValue::from_str("get"))
        .map(|get| get.is_function())
        .unwrap_or(false);
    if !is_store {
        return StoreRead::Unbound;
    }
    match SecretStore::from(value).get().await {
        Ok(Some(v)) => StoreRead::Value(v),
        Ok(None) => StoreRead::Missing,
        // The runtime rejects `get()` for a secret the store does not hold.
        Err(_) => StoreRead::Failed,
    }
}

/// Check `Authorization: Bearer <key>` against the expected key in constant
/// time. `false` when either side is missing.
pub fn bearer_matches(headers: &Headers, expected: &str) -> bool {
    let Ok(Some(value)) = headers.get("Authorization") else {
        return false;
    };
    let Some(token) = value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))
    else {
        return false;
    };
    let token = token.trim();
    !token.is_empty() && !expected.is_empty() && token.as_bytes().ct_eq(expected.as_bytes()).into()
}

/// Decoded query pairs of a request URL.
pub fn query_pairs(req: &Request) -> Result<Vec<(String, String)>> {
    Ok(req
        .url()?
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect())
}

/// Why an outbound call did not produce a response.
#[derive(Debug)]
pub enum FetchError {
    Timeout,
    Network(worker::Error),
}

/// `GET` a URL, giving up after `timeout`. The request is aborted on timeout
/// so it does not keep a subrequest slot.
pub async fn get_with_timeout(
    url: &str,
    headers: Option<Headers>,
    timeout: Duration,
) -> std::result::Result<Response, FetchError> {
    let parsed = Url::parse(url).map_err(|e| FetchError::Network(e.into()))?;
    let fetch = match headers {
        Some(h) => {
            let mut init = worker::RequestInit::new();
            init.with_headers(h);
            let req =
                Request::new_with_init(parsed.as_str(), &init).map_err(FetchError::Network)?;
            Fetch::Request(req)
        }
        None => Fetch::Url(parsed),
    };
    let controller = AbortController::default();
    let signal = controller.signal();
    let call = Box::pin(fetch.send_with_signal(&signal));
    let timer = Box::pin(Delay::from(timeout));
    let outcome = match select(call, timer).await {
        Either::Left((result, _)) => Some(result),
        Either::Right(_) => None,
    };
    match outcome {
        Some(result) => result.map_err(FetchError::Network),
        None => {
            controller.abort();
            Err(FetchError::Timeout)
        }
    }
}
