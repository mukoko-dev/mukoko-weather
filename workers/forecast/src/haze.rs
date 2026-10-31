//! `GET /haze?lat=&lon=`: location-aware haze panel data (ported from
//! `api/py/_haze.py`). Open-Meteo Air Quality and Forecast, sequentially (the
//! free tier answers bursts from one client with 429, and each 429 counts
//! against the breaker), plus Singapore's official NEA PSI inside its box.
//!
//! Cached in KV for 30 minutes under the point rounded to 0.01°. Always HTTP
//! 200 for a valid point: `available: false` with a `reason` when it cannot
//! be classified (not cached, `no-store`).

use std::time::Duration;

use chrono::Datelike;
use serde_json::Value;
use weather_core::haze;
use weather_edge::{error, get_with_timeout, json, now, now_rfc3339, query_pairs};
use worker::{Context, Env, Request, Response, Result};

use crate::chain::{self, CACHE_BINDING};

const TIMEOUT: Duration = Duration::from_secs(8);
const OFFICIAL_TIMEOUT: Duration = Duration::from_secs(4);

async fn get_json(url: &str, timeout: Duration) -> Option<Value> {
    match get_with_timeout(url, None, timeout).await {
        Ok(mut r) if r.status_code() == 200 => r.json::<Value>().await.ok(),
        _ => None,
    }
}

pub async fn haze(req: &Request, env: &Env, ctx: &Context) -> Result<Response> {
    let pairs = query_pairs(req)?;
    let num = |k: &str| {
        pairs
            .iter()
            .find(|(n, _)| n == k)
            .and_then(|(_, v)| v.trim().parse::<f64>().ok())
            .filter(|x| x.is_finite())
    };
    let (Some(lat), Some(lon)) = (num("lat"), num("lon")) else {
        return error(422, "invalid_request", "Give both `lat` and `lon`.");
    };
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
        return error(422, "invalid_request", "Invalid coordinates.");
    }

    let kv = env.kv(CACHE_BINDING).ok();
    let key = haze::cache_key(lat, lon);
    if let Some(kv) = &kv {
        if let Ok(Some(hit)) = kv.get(&key).json::<Value>().await {
            return respond(&hit, "HIT");
        }
    }

    let fetched_at = now_rfc3339();
    if !chain::open_meteo_allowed() {
        return respond(
            &haze::unavailable("provider_unavailable", &fetched_at),
            "MISS",
        );
    }
    let aq_url = format!(
        "{}?latitude={lat}&longitude={lon}&{}",
        haze::AQ_URL,
        haze::AQ_QUERY
    );
    let aq = get_json(&aq_url, TIMEOUT).await;
    chain::record_open_meteo(aq.is_some());
    let Some(aq) = aq else {
        return respond(&haze::unavailable("provider_error", &fetched_at), "MISS");
    };
    let fc_url = format!(
        "{}?latitude={lat}&longitude={lon}&{}",
        haze::FORECAST_URL,
        haze::FORECAST_QUERY
    );
    let fc = get_json(&fc_url, TIMEOUT).await;
    chain::record_open_meteo(fc.is_some());
    let Some(fc) = fc else {
        return respond(&haze::unavailable("provider_error", &fetched_at), "MISS");
    };

    // The official reading never blocks or fails the answer.
    let official = if haze::sg_applies(lat, lon) {
        get_json(haze::PSI_URL, OFFICIAL_TIMEOUT)
            .await
            .and_then(|p| haze::parse_sg_psi(&p))
    } else {
        None
    };

    let body = haze::analyse(&aq, &fc, lat, lon, now().month(), official, &fetched_at);
    if body["available"] == Value::Bool(true) {
        if let (Some(kv), Ok(text)) = (kv, serde_json::to_string(&body)) {
            ctx.wait_until(async move {
                if let Ok(put) = kv.put(&key, text) {
                    let _ = put.expiration_ttl(haze::CACHE_TTL_SECONDS).execute().await;
                }
            });
        }
    }
    respond(&body, "MISS")
}

fn respond(body: &Value, cache: &str) -> Result<Response> {
    let resp = json(200, body)?;
    resp.headers().set("X-Cache", cache)?;
    if body["available"] != Value::Bool(true) {
        resp.headers().set("Cache-Control", "no-store")?;
    }
    Ok(resp)
}
