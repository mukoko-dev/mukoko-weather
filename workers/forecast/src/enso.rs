//! `GET /enso`: the latest El Niño / La Niña phase from NOAA CPC's Oceanic
//! Niño Index (ported from `api/py/_enso.py`).
//!
//! The parsed answer is cached in KV for 12 hours. Calls go through a NOAA
//! circuit breaker. The route never fails the page: on any upstream error or
//! an open breaker it answers 200 with `available: false` (not cached, and
//! `no-store` so no edge keeps it).

use std::cell::RefCell;
use std::time::Duration;

use serde_json::Value;
use weather_core::breaker::{self, Breaker};
use weather_core::enso;
use weather_edge::{get_with_timeout, json, now_ms, now_rfc3339};
use worker::{Context, Env, Response, Result};

use crate::chain::CACHE_BINDING;

const TIMEOUT: Duration = Duration::from_secs(8);

thread_local! {
    static NOAA: RefCell<Breaker> = const { RefCell::new(Breaker::new(breaker::DEFAULT)) };
}

pub async fn enso(env: &Env, ctx: &Context) -> Result<Response> {
    let kv = env.kv(CACHE_BINDING).ok();
    if let Some(kv) = &kv {
        if let Ok(Some(hit)) = kv.get(enso::CACHE_KEY).json::<Value>().await {
            return respond(&hit, true);
        }
    }
    if !NOAA.with(|b| b.borrow_mut().allow(now_ms())) {
        return respond(&enso::unavailable(), false);
    }
    let text = match get_with_timeout(enso::ONI_URL, None, TIMEOUT).await {
        Ok(mut r) if r.status_code() == 200 => r.text().await.ok(),
        _ => None,
    };
    NOAA.with(|b| {
        let mut b = b.borrow_mut();
        if text.is_some() {
            b.record_success();
        } else {
            b.record_failure(now_ms());
        }
    });
    let Some(seasons) = text.and_then(|t| enso::parse_oni_text(&t).ok()) else {
        return respond(&enso::unavailable(), false);
    };
    let body = enso::build_outlook(&seasons, &now_rfc3339());
    if let (Some(kv), Ok(text)) = (kv, serde_json::to_string(&body)) {
        ctx.wait_until(async move {
            if let Ok(put) = kv.put(enso::CACHE_KEY, text) {
                let _ = put.expiration_ttl(enso::CACHE_TTL_SECONDS).execute().await;
            }
        });
    }
    respond(&body, false)
}

fn respond(body: &Value, hit: bool) -> Result<Response> {
    let resp = json(200, body)?;
    resp.headers()
        .set("X-Cache", if hit { "HIT" } else { "MISS" })?;
    if body["available"] != Value::Bool(true) {
        resp.headers().set("Cache-Control", "no-store")?;
    }
    Ok(resp)
}
