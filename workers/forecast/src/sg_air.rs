//! `GET /sg-air?lat=&lon=`: official Singapore air quality from NEA via
//! data.gov.sg (ported from `api/py/_sg_air.py`).
//!
//! The raw PSI and PM2.5 payloads are cached in KV for 10 minutes (the
//! parsed answer depends on the coordinates). Calls go through an NEA
//! circuit breaker. Always HTTP 200: any failure is `available: false`,
//! `no-store`.

use std::cell::RefCell;
use std::time::Duration;

use serde_json::{json, Value};
use weather_core::breaker::{self, Breaker};
use weather_core::sg_air as sg;
use weather_edge::{get_with_timeout, json, now_ms, now_rfc3339, query_pairs};
use worker::{Context, Env, Request, Response, Result};

use crate::chain::CACHE_BINDING;

const TIMEOUT: Duration = Duration::from_secs(5);

thread_local! {
    static NEA: RefCell<Breaker> = const { RefCell::new(Breaker::new(breaker::DEFAULT)) };
}

async fn get_json(url: &str) -> Option<Value> {
    match get_with_timeout(url, None, TIMEOUT).await {
        Ok(mut r) if r.status_code() == 200 => r.json::<Value>().await.ok(),
        _ => None,
    }
}

pub async fn sg_air(req: &Request, env: &Env, ctx: &Context) -> Result<Response> {
    let pairs = query_pairs(req)?;
    let num = |k: &str| {
        pairs
            .iter()
            .find(|(n, _)| n == k)
            .and_then(|(_, v)| v.trim().parse::<f64>().ok())
            .filter(|x| x.is_finite())
    };
    let point = match (num("lat"), num("lon")) {
        (Some(lat), Some(lon))
            if (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon) =>
        {
            Some((lat, lon))
        }
        (None, None) => None,
        _ => {
            return weather_edge::error(
                422,
                "invalid_request",
                "Give `lat` and `lon` together, within range.",
            )
        }
    };

    let kv = env.kv(CACHE_BINDING).ok();
    let cached = match &kv {
        Some(kv) => kv.get(sg::CACHE_KEY).json::<Value>().await.ok().flatten(),
        None => None,
    };
    let (psi, pm25, fetched_at) = match cached {
        Some(c) => (
            c["psi"].clone(),
            Some(c["pm25"].clone()).filter(|v| !v.is_null()),
            c["fetchedAt"].as_str().unwrap_or_default().to_owned(),
        ),
        None => {
            if !NEA.with(|b| b.borrow_mut().allow(now_ms())) {
                return respond(&sg::unavailable(None));
            }
            let psi = get_json(sg::PSI_URL).await;
            // PM2.5 is optional: its failure never fails the answer.
            let pm25 = get_json(sg::PM25_URL).await;
            NEA.with(|b| {
                let mut b = b.borrow_mut();
                if psi.is_some() {
                    b.record_success();
                } else {
                    b.record_failure(now_ms());
                }
            });
            let Some(psi) = psi else {
                return respond(&sg::unavailable(None));
            };
            let fetched_at = now_rfc3339();
            if let Some(kv) = kv {
                let entry = json!({"psi": psi, "pm25": pm25, "fetchedAt": fetched_at});
                if let Ok(text) = serde_json::to_string(&entry) {
                    ctx.wait_until(async move {
                        if let Ok(put) = kv.put(sg::CACHE_KEY, text) {
                            let _ = put.expiration_ttl(sg::CACHE_TTL_SECONDS).execute().await;
                        }
                    });
                }
            }
            (psi, pm25, fetched_at)
        }
    };
    match sg::parse_sg_air(&psi, pm25.as_ref(), point, Some(&fetched_at)) {
        Ok(body) => respond(&body),
        Err(_) => respond(&sg::unavailable(Some(&fetched_at))),
    }
}

fn respond(body: &Value) -> Result<Response> {
    let resp = json(200, body)?;
    if body["available"] != Value::Bool(true) {
        resp.headers().set("Cache-Control", "no-store")?;
    }
    Ok(resp)
}
