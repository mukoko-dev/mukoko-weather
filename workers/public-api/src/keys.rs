//! Developer API keys, checked by the Nyuchi API.
//!
//! The public API stays open to anonymous callers (per-IP limit). A caller
//! that sends a Nyuchi API key (`X-API-Key: nyk_….nys_…`, or `X-Client-Id`
//! and `X-Client-Secret`) is checked by `GET {NYUCHI_API_URL}/v1/weather/key`
//! with that key. The Nyuchi API validates it, requires the `weather` scope,
//! enforces the monthly quota and counts the call; there is no key store here.
//!
//! A good answer is kept in this isolate's memory for 60 seconds, under a
//! SHA-256 of the key (never the key itself). So the Nyuchi API counts at
//! most one call a minute per key per isolate, not every request.
//!
//! Outcomes: anonymous, a verified key (its own, higher rate limit, keyed by
//! the key id), `401` for a bad or malformed key, `403` for a key without the
//! `weather` scope, and `503` when the Nyuchi API cannot answer and nothing is
//! cached (fail closed: a key is never taken on trust).

use std::cell::RefCell;
use std::collections::HashMap;
use std::time::Duration;

use serde_json::Value;
use weather_core::devkey::{Credential, KeyContext};
use weather_edge::{config, error, get_with_timeout, now_ms};
use worker::{Env, Headers, Request, Response, Result};

const TTL_MS: u64 = 60_000;
const MAX_CACHED: usize = 1_000;
const TIMEOUT: Duration = Duration::from_secs(5);

thread_local! {
    static VERIFIED: RefCell<HashMap<String, (KeyContext, u64)>> = RefCell::new(HashMap::new());
}

pub enum Caller {
    Anonymous,
    Key(KeyContext),
}

fn credential(req: &Request) -> Result<Credential> {
    let h = req.headers();
    Ok(Credential::parse(
        h.get("X-API-Key")?.as_deref(),
        h.get("X-Client-Id")?.as_deref(),
        h.get("X-Client-Secret")?.as_deref(),
    ))
}

/// Who is calling, or the response that refuses them.
pub async fn caller(req: &Request, env: &Env) -> Result<std::result::Result<Caller, Response>> {
    let cred = credential(req)?;
    let (Some(combined), Some(fingerprint)) = (cred.combined(), cred.fingerprint()) else {
        return Ok(match cred {
            Credential::None => Ok(Caller::Anonymous),
            _ => Err(unauthorized("That is not a Nyuchi API key.")?),
        });
    };

    let now = now_ms();
    let hit = VERIFIED.with(|v| {
        v.borrow()
            .get(&fingerprint)
            .filter(|(_, until)| *until > now)
            .map(|(ctx, _)| ctx.clone())
    });
    if let Some(ctx) = hit {
        return Ok(Ok(Caller::Key(ctx)));
    }

    let Some(base) = config(env, "NYUCHI_API_URL") else {
        return Ok(Err(unavailable()?));
    };
    let headers = Headers::new();
    headers.set("X-API-Key", &combined)?;
    headers.set("Accept", "application/json")?;
    let url = format!("{}/v1/weather/key", base.trim_end_matches('/'));
    let ctx = match get_with_timeout(&url, Some(headers), TIMEOUT).await {
        Ok(mut r) if r.status_code() == 200 => match r.json::<Value>().await {
            Ok(body) => KeyContext::from_answer(&body),
            Err(_) => return Ok(Err(unavailable()?)),
        },
        Ok(r) if r.status_code() == 401 => {
            return Ok(Err(unauthorized(
                "Invalid, expired or over-limit API key.",
            )?))
        }
        Ok(r) if r.status_code() == 403 => {
            return Ok(Err(error(
                403,
                "forbidden",
                "This API key is not enabled for the weather API.",
            )?))
        }
        _ => return Ok(Err(unavailable()?)),
    };
    let Some(ctx) = ctx else {
        return Ok(Err(unavailable()?));
    };
    VERIFIED.with(|v| {
        let mut v = v.borrow_mut();
        if v.len() >= MAX_CACHED {
            v.retain(|_, (_, until)| *until > now);
            if v.len() >= MAX_CACHED {
                v.clear();
            }
        }
        v.insert(fingerprint, (ctx.clone(), now + TTL_MS));
    });
    Ok(Ok(Caller::Key(ctx)))
}

fn unauthorized(description: &str) -> Result<Response> {
    let resp = error(401, "unauthorized", description)?;
    resp.headers().set("WWW-Authenticate", "ApiKey")?;
    Ok(resp)
}

fn unavailable() -> Result<Response> {
    let resp = error(
        503,
        "key_check_unavailable",
        "API keys cannot be checked right now; retry, or call without a key.",
    )?;
    resp.headers().set("Retry-After", "30")?;
    Ok(resp)
}
