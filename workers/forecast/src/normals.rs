//! `GET /normals?lat=&lon=[&date=YYYY-MM-DD]`: the average daily high and low
//! for a calendar day at a place (ported from `api/py/_normals.py`).
//!
//! ERA5 via Open-Meteo's Historical Weather API over 1991-2020. Coordinates
//! snap to a 0.25° cell, one 30-year request per cell is reduced to two
//! 366-entry day-of-year tables and cached in KV without expiry (normals do
//! not change). Failures are HTTP 200 with `available: false` and a `reason`
//! (`circuit_open`, `upstream_error`, `timeout`, `no_data`), `no-store`; only
//! malformed input is a 400.

use std::time::Duration;

use serde_json::{json, Value};
use weather_core::normals as n;
use weather_edge::{error, get_with_timeout, json, now, now_rfc3339, query_pairs, FetchError};
use worker::{Context, Env, Request, Response, Result};

use crate::chain::{self, CACHE_BINDING};

/// The one-off 30-year build: the breaker's usual 8 s is too short for it.
const BUILD_TIMEOUT: Duration = Duration::from_secs(22);

pub async fn normals(req: &Request, env: &Env, ctx: &Context) -> Result<Response> {
    let pairs = query_pairs(req)?;
    let get = |k: &str| {
        pairs
            .iter()
            .find(|(name, _)| name == k)
            .map(|(_, v)| v.trim())
    };
    let num = |k: &str| {
        get(k)
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|x| x.is_finite())
    };
    let (Some(lat), Some(lon)) = (num("lat"), num("lon")) else {
        return error(422, "invalid_request", "Give both `lat` and `lon`.");
    };
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
        return error(400, "invalid_request", "Invalid coordinates");
    }
    let date = match get("date").filter(|d| !d.is_empty()) {
        None => now().format("%Y-%m-%d").to_string(),
        Some(raw) => match n::parse_target_date(raw) {
            Some(d) => d,
            None => return error(400, "invalid_request", "date must be YYYY-MM-DD"),
        },
    };
    let Some(slot) = n::slot_for_iso(&date) else {
        return error(400, "invalid_request", "date must be YYYY-MM-DD");
    };

    let (glat, glon) = (n::snap_to_grid(lat), n::snap_to_grid(lon));
    let key = n::cache_key(glat, glon);
    let kv = env.kv(CACHE_BINDING).ok();
    if let Some(kv) = &kv {
        if let Ok(Some(hit)) = kv.get(&key).json::<Value>().await {
            if let Some((hi, lo)) = tables(&hit) {
                let body = n::respond(lat, lon, &date, slot, &hi, &lo, hit["computedAt"].as_str());
                return respond(&body, "HIT");
            }
        }
    }

    if !chain::open_meteo_allowed() {
        return respond(&n::unavailable(lat, lon, &date, "circuit_open"), "MISS");
    }
    let fetched = get_with_timeout(&n::archive_url(glat, glon), None, BUILD_TIMEOUT).await;
    let timed_out = matches!(fetched, Err(FetchError::Timeout));
    let daily = match fetched {
        Ok(mut r) if r.status_code() == 200 => r
            .json::<Value>()
            .await
            .ok()
            .map(|d| d["daily"].clone())
            .filter(|d| d["time"].as_array().is_some_and(|t| !t.is_empty())),
        _ => None,
    };
    chain::record_open_meteo(daily.is_some());
    let Some(daily) = daily else {
        let reason = if timed_out {
            "timeout"
        } else {
            "upstream_error"
        };
        return respond(&n::unavailable(lat, lon, &date, reason), "MISS");
    };

    let (max_t, min_t) = n::compute_normal_tables(&daily);
    let computed_at = now_rfc3339();
    if let Some(kv) = kv {
        let entry = json!({"maxByDay": max_t, "minByDay": min_t, "computedAt": computed_at});
        if let Ok(text) = serde_json::to_string(&entry) {
            ctx.wait_until(async move {
                // No expiry: the normals of 1991-2020 do not change.
                if let Ok(put) = kv.put(&key, text) {
                    let _ = put.execute().await;
                }
            });
        }
    }
    let body = n::respond(lat, lon, &date, slot, &max_t, &min_t, Some(&computed_at));
    respond(&body, "MISS")
}

/// A day-of-year table, `None` for a day with no observation.
type Table = Vec<Option<f64>>;

fn tables(v: &Value) -> Option<(Table, Table)> {
    let col = |k: &str| -> Option<Table> {
        let a = v[k].as_array().filter(|a| a.len() == n::SLOTS)?;
        Some(a.iter().map(Value::as_f64).collect())
    };
    Some((col("maxByDay")?, col("minByDay")?))
}

fn respond(body: &Value, cache: &str) -> Result<Response> {
    let resp = json(200, body)?;
    resp.headers().set("X-Cache", cache)?;
    if body["available"] != Value::Bool(true) {
        resp.headers().set("Cache-Control", "no-store")?;
    }
    Ok(resp)
}
