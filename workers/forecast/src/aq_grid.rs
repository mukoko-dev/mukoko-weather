//! `GET /air-quality/grid?lat=&lon=&radiusKm=40&n=7`: US AQI on an n×n grid
//! around a point (ported from `api/py/_aq_grid.py`).
//!
//! One batched Open-Meteo request covers every point; the answer is cached in
//! KV for 30 minutes under the rounded request. Open-Meteo calls share the
//! forecast's circuit breaker. Any upstream failure is HTTP 200 with
//! `available: false` (not cached, `no-store`): the card renders nothing
//! rather than surfacing a 5xx to the page.

use std::time::Duration;

use serde_json::Value;
use weather_core::aq_grid as grid;
use weather_edge::{error, get_with_timeout, json, now_rfc3339, query_pairs};
use worker::{Context, Env, Request, Response, Result};

use crate::chain::{self, CACHE_BINDING};

const TIMEOUT: Duration = Duration::from_secs(10);

pub async fn air_quality_grid(req: &Request, env: &Env, ctx: &Context) -> Result<Response> {
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
    let radius_raw = num("radiusKm").unwrap_or(grid::RADIUS_KM_DEFAULT);
    let n_raw = num("n").map_or(grid::GRID_N_DEFAULT, |v| v as i64);

    let (lat_r, lon_r) = (round2(lat), round2(lon));
    let n = grid::normalise_n(n_raw);
    let radius = grid::clamp_radius(radius_raw);
    let cell_km = grid::grid_cell_km(radius, n);
    let key = grid::cache_key(lat_r, lon_r, n, radius);

    let kv = env.kv(CACHE_BINDING).ok();
    if let Some(kv) = &kv {
        if let Ok(Some(hit)) = kv.get(&key).json::<Value>().await {
            return respond(&hit, "HIT");
        }
    }
    if !chain::open_meteo_allowed() {
        return respond(&grid::unavailable(cell_km), "MISS");
    }

    let points = grid::build_grid(lat_r, lon_r, radius, n);
    let fetched = match get_with_timeout(&grid::open_meteo_url(&points), None, TIMEOUT).await {
        Ok(mut r) if r.status_code() == 200 => r
            .json::<Value>()
            .await
            .ok()
            .and_then(|raw| grid::parse_grid_response(&raw, &points).ok()),
        _ => None,
    };
    chain::record_open_meteo(fetched.is_some());
    let Some(readings) = fetched else {
        return respond(&grid::unavailable(cell_km), "MISS");
    };

    let mut body = grid::payload(lat_r, lon_r, n, radius, &readings, &points);
    body["fetchedAt"] = Value::from(now_rfc3339());
    if let (Some(kv), Ok(text)) = (kv, serde_json::to_string(&body)) {
        ctx.wait_until(async move {
            if let Ok(put) = kv.put(&key, text) {
                let _ = put.expiration_ttl(grid::CACHE_TTL_SECONDS).execute().await;
            }
        });
    }
    respond(&body, "MISS")
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round_ties_even() / 100.0
}

fn respond(body: &Value, cache: &str) -> Result<Response> {
    let resp = json(200, body)?;
    resp.headers().set("X-Cache", cache)?;
    if body["available"] != Value::Bool(true) {
        resp.headers().set("Cache-Control", "no-store")?;
    }
    Ok(resp)
}
