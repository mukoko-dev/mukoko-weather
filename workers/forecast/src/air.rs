//! `GET /air-quality?lat=&lon=`: the EPA AQI from Open-Meteo's Air Quality
//! API (ported from `api/py/_air_quality.py`).
//!
//! KV cache for an hour, keyed to about 11 m. Open-Meteo calls go through the
//! same circuit breaker as the forecast: when it is open the answer is `503`;
//! when the call fails it is `502`.

use std::time::Duration;

use serde_json::Value;
use weather_core::{air_quality as aq, geo};
use weather_edge::{error, get_with_timeout, json, now_rfc3339, query_pairs};
use worker::{Context, Env, Request, Response, Result};

use crate::chain::{self, CACHE_BINDING};

const TIMEOUT: Duration = Duration::from_secs(10);

pub async fn air_quality(req: &Request, env: &Env, ctx: &Context) -> Result<Response> {
    let pairs = query_pairs(req)?;
    let num = |k: &str| {
        pairs
            .iter()
            .find(|(n, _)| n == k)
            .and_then(|(_, v)| v.trim().parse::<f64>().ok())
    };
    let (Some(lat), Some(lon)) = (num("lat"), num("lon")) else {
        return error(422, "invalid_request", "Give both `lat` and `lon`.");
    };
    if !geo::valid_coordinates(lat, lon) {
        return error(400, "invalid_request", "Invalid coordinates");
    }

    let kv = env.kv(CACHE_BINDING).ok();
    let key = aq::cache_key(lat, lon);
    if let Some(kv) = &kv {
        if let Ok(Some(mut hit)) = kv.get(&key).json::<Value>().await {
            hit["source"] = Value::from("cache");
            hit["whoGuidelines"] = aq::who_guidelines();
            return respond(&hit, "HIT", "cache");
        }
    }

    if !chain::open_meteo_allowed() {
        return error(
            503,
            "provider_unavailable",
            "Air quality provider temporarily unavailable",
        );
    }
    let fetched = match get_with_timeout(&aq::open_meteo_url(lat, lon), None, TIMEOUT).await {
        Ok(mut resp) if resp.status_code() == 200 => resp.json::<Value>().await.ok(),
        _ => None,
    };
    chain::record_open_meteo(fetched.is_some());
    let Some(raw) = fetched else {
        return error(502, "upstream_error", "Failed to fetch air quality data.");
    };

    let mut body = aq::payload(&aq::pollutants_from_open_meteo(&raw));
    body["fetchedAt"] = Value::from(now_rfc3339());
    if let Some(kv) = kv {
        if let Ok(text) = serde_json::to_string(&body) {
            ctx.wait_until(async move {
                if let Ok(put) = kv.put(&key, text) {
                    let _ = put.expiration_ttl(aq::CACHE_TTL_SECONDS).execute().await;
                }
            });
        }
    }
    body["source"] = Value::from("open-meteo");
    body["whoGuidelines"] = aq::who_guidelines();
    respond(&body, "MISS", "open-meteo")
}

fn respond(body: &Value, cache: &str, source: &str) -> Result<Response> {
    let resp = json(200, body)?;
    resp.headers().set("X-Cache", cache)?;
    resp.headers().set("X-AQ-Source", source)?;
    Ok(resp)
}
