//! `GET /model-grid?lat=&lon=&model=`: one global model's 3-hourly forecast
//! on a fixed 7×7 grid (ported from `api/py/_model_grid.py`).
//!
//! Failures answer 200 with `available: false` and a `reason`, and are never
//! cached: `unknown_model`, `circuit_open`, `rate_limited`, `upstream_error`,
//! `no_data`. Cached 3 h in KV per (model, 0.25° cell). Only an Open-Meteo
//! outage (5xx, 429, transport, timeout, a bad body) counts against the
//! shared Open-Meteo breaker; a rejected request (4xx) never does.

use std::time::Duration;

use serde_json::Value;
use weather_core::budget::Action;
use weather_core::model_grid as mg;
use weather_edge::{error, get_with_timeout, json, now_rfc3339, query_pairs};
use worker::{Context, Env, Request, Response, Result};

use crate::chain::{self, CACHE_BINDING};
use crate::limit;

/// Inside the Open-Meteo breaker's 8 s budget, as in the Python backend.
const TIMEOUT: Duration = Duration::from_millis(7_500);

fn respond(body: &Value, cache: &str) -> Result<Response> {
    let resp = json(200, body)?;
    resp.headers().set("X-Cache", cache)?;
    Ok(resp)
}

pub async fn model_grid(req: &Request, env: &Env, ctx: &Context) -> Result<Response> {
    let pairs = query_pairs(req)?;
    let get = |k: &str| pairs.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
    let num = |k: &str| get(k).and_then(|v| v.trim().parse::<f64>().ok());
    let (Some(lat), Some(lon)) = (num("lat"), num("lon")) else {
        return error(422, "invalid_request", "Give both `lat` and `lon`.");
    };
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
        return error(422, "invalid_request", "Invalid coordinates.");
    }
    let requested = get("model").unwrap_or(mg::DEFAULT_MODEL);
    let Some(model) = mg::canonical_model(requested) else {
        let shown: String = requested.chars().take(40).collect();
        return respond(&mg::unavailable(&shown, "unknown_model"), "MISS");
    };

    let (lat_c, lon_c) = (mg::snap_centre(lat), mg::snap_centre(lon));
    let key = mg::cache_key(model, lat_c, lon_c);
    let kv = env.kv(CACHE_BINDING).ok();
    if let Some(kv) = &kv {
        if let Ok(Some(hit)) = kv.get(&key).json::<Value>().await {
            return respond(&hit, "HIT");
        }
    }

    if !chain::open_meteo_allowed() {
        return respond(&mg::unavailable(model, "circuit_open"), "MISS");
    }
    if !limit::take(env, Action::ModelGrid, &limit::caller_key(req))
        .await
        .allowed()
    {
        return respond(&mg::unavailable(model, "rate_limited"), "MISS");
    }

    let coords = mg::valid_grid(&mg::build_grid(lat_c, lon_c));
    let url = mg::open_meteo_url(&coords, model);
    let (times, points) = match get_with_timeout(&url, None, TIMEOUT).await {
        Ok(mut resp) => {
            let status = resp.status_code();
            if status == 429 || status >= 500 {
                chain::record_open_meteo(false);
                return respond(&mg::unavailable(model, "upstream_error"), "MISS");
            }
            if status != 200 {
                // Our request was rejected: our bug, not an outage.
                return respond(&mg::unavailable(model, "upstream_error"), "MISS");
            }
            let parsed = match resp.json::<Value>().await {
                Ok(data) => mg::parse_model_grid(&data, &coords).ok(),
                Err(_) => None,
            };
            let Some(parsed) = parsed else {
                chain::record_open_meteo(false);
                return respond(&mg::unavailable(model, "upstream_error"), "MISS");
            };
            parsed
        }
        Err(_) => {
            chain::record_open_meteo(false);
            return respond(&mg::unavailable(model, "upstream_error"), "MISS");
        }
    };
    chain::record_open_meteo(true);

    if !mg::has_any_value(&points) {
        return respond(&mg::unavailable(model, "no_data"), "MISS");
    }

    let fetched_at = now_rfc3339();
    let body = mg::body(
        true,
        model,
        mg::cell_km(),
        &times,
        &points,
        Some(&fetched_at),
        None,
    );
    if let Some(kv) = kv {
        if let Ok(text) = serde_json::to_string(&body) {
            ctx.wait_until(async move {
                if let Ok(put) = kv.put(&key, text) {
                    let _ = put.expiration_ttl(mg::CACHE_TTL_SECONDS).execute().await;
                }
            });
        }
    }
    respond(&body, "MISS")
}
