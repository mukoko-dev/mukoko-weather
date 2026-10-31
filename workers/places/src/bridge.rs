//! The call to `mukoko-weather-mongo-bridge` (workers/mongo-bridge), the
//! TypeScript Worker that reads and writes the device profiles and community
//! reports in MongoDB. Reached only through the `MONGO_BRIDGE` service binding.

use std::time::Duration;

use futures::future::{select, Either};
use serde_json::Value;
use weather_core::community::{bridge_answer, BridgeAnswer};
use worker::wasm_bindgen::JsValue;
use worker::{Delay, Env, Headers, Method, Request, RequestInit};

pub const BINDING: &str = "MONGO_BRIDGE";

/// A connection to MongoDB inside the bridge can take a few seconds when it
/// is cold; its own server selection gives up at 5 s.
const TIMEOUT: Duration = Duration::from_secs(8);

/// What the bridge said.
pub enum Answer {
    /// A success, or a rejection of the request itself: relay it.
    Relay { status: u16, body: Value },
    /// The bridge, or the store behind it, did not answer.
    Unavailable,
}

/// Call the bridge. `path` is the bridge's own path (`/devices/{id}`); the
/// body, when given, is JSON.
pub async fn call(env: &Env, method: Method, path: &str, body: Option<&Value>) -> Answer {
    send(env, method, path, body)
        .await
        .unwrap_or(Answer::Unavailable)
}

async fn send(
    env: &Env,
    method: Method,
    path: &str,
    body: Option<&Value>,
) -> worker::Result<Answer> {
    let fetcher = env.service(BINDING)?;
    let headers = Headers::new();
    headers.set("Content-Type", "application/json")?;
    let mut init = RequestInit::new();
    init.with_method(method).with_headers(headers);
    if let Some(body) = body {
        init.with_body(Some(JsValue::from_str(&body.to_string())));
    }
    let req = Request::new_with_init(&format!("https://mongo-bridge{path}"), &init)?;
    let call = Box::pin(fetcher.fetch_request(req));
    let timer = Box::pin(Delay::from(TIMEOUT));
    let mut resp = match select(call, timer).await {
        Either::Left((resp, _)) => resp?,
        // A service binding fetch has no abort signal; the call is dropped.
        Either::Right(_) => return Ok(Answer::Unavailable),
    };
    let status = resp.status_code();
    if bridge_answer(status) == BridgeAnswer::Unavailable {
        return Ok(Answer::Unavailable);
    }
    Ok(match resp.json::<Value>().await {
        Ok(body) => Answer::Relay { status, body },
        Err(_) => Answer::Unavailable,
    })
}
