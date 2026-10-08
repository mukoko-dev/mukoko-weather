//! The provider chain: KV cache, then Tomorrow.io, then Open-Meteo.

use std::cell::RefCell;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use weather_core::breaker::{self, Breaker};
use weather_core::{geo, normalize, Source};
use weather_edge::{config, get_with_timeout, now_ms, now_rfc3339};
use worker::{Context, Env};

pub const CACHE_BINDING: &str = "FORECAST_CACHE";
/// 15 minutes, as in the Python backend.
const CACHE_TTL_SECONDS: u64 = 900;
const TOMORROW_TIMEOUT: Duration = Duration::from_secs(5);
const OPEN_METEO_TIMEOUT: Duration = Duration::from_secs(8);

thread_local! {
    static TOMORROW: RefCell<Breaker> = const { RefCell::new(Breaker::new(breaker::TOMORROW)) };
    static OPEN_METEO: RefCell<Breaker> = const { RefCell::new(Breaker::new(breaker::OPEN_METEO)) };
}

/// A forecast and where it came from.
#[derive(Serialize, Deserialize)]
pub struct Got {
    pub data: Value,
    pub source: Source,
    pub fetched_at: String,
    #[serde(skip)]
    pub cache_hit: bool,
}

fn cache_key(lat: f64, lon: f64) -> String {
    format!("wx:v1:{}", geo::cache_key(lat, lon))
}

/// The forecast for a point, or `None` when the cache is cold and every
/// provider failed. `refresh` skips the cache read (the answer is still
/// cached): the jobs Worker uses it to keep popular places warm.
pub async fn forecast(env: &Env, ctx: &Context, lat: f64, lon: f64, refresh: bool) -> Option<Got> {
    let kv = env.kv(CACHE_BINDING).ok();
    let key = cache_key(lat, lon);

    if let Some(kv) = kv.as_ref().filter(|_| !refresh) {
        if let Ok(Some(mut hit)) = kv.get(&key).json::<Got>().await {
            hit.cache_hit = true;
            return Some(hit);
        }
    }

    let (data, source) = match tomorrow(env, lat, lon).await {
        Some(d) => (d, Source::Tomorrow),
        None => (open_meteo(lat, lon).await?, Source::OpenMeteo),
    };
    let got = Got {
        data,
        source,
        fetched_at: now_rfc3339(),
        cache_hit: false,
    };

    if let Some(kv) = kv {
        if let Ok(body) = serde_json::to_string(&got) {
            ctx.wait_until(async move {
                if let Ok(put) = kv.put(&key, body) {
                    let _ = put.expiration_ttl(CACHE_TTL_SECONDS).execute().await;
                }
            });
        }
    }
    Some(got)
}

async fn tomorrow(env: &Env, lat: f64, lon: f64) -> Option<Value> {
    let key = config(env, "TOMORROW_API_KEY")?;
    if !TOMORROW.with(|b| b.borrow_mut().allow(now_ms())) {
        return None;
    }
    // The URL carries the key: it is never logged.
    let url = normalize::tomorrow_url(lat, lon, &key);
    let data = match get_with_timeout(&url, None, TOMORROW_TIMEOUT).await {
        // 429 is Tomorrow.io's rate limit: fall through to Open-Meteo.
        Ok(mut resp) if resp.status_code() == 200 => resp
            .json::<Value>()
            .await
            .ok()
            .map(|raw| normalize::normalize_tomorrow(&raw))
            .filter(|d| d["current"].as_object().is_some_and(|c| !c.is_empty())),
        _ => None,
    };
    TOMORROW.with(|b| {
        let mut b = b.borrow_mut();
        if data.is_some() {
            b.record_success();
        } else {
            b.record_failure(now_ms());
        }
    });
    data
}

async fn open_meteo(lat: f64, lon: f64) -> Option<Value> {
    if !OPEN_METEO.with(|b| b.borrow_mut().allow(now_ms())) {
        return None;
    }
    let url = normalize::open_meteo_url(lat, lon);
    let data = match get_with_timeout(&url, None, OPEN_METEO_TIMEOUT).await {
        Ok(mut resp) if resp.status_code() == 200 => resp
            .json::<Value>()
            .await
            .ok()
            .and_then(|raw| normalize::normalize_open_meteo(&raw)),
        _ => None,
    };
    record_open_meteo(data.is_some());
    data
}

/// Whether the Open-Meteo breaker lets a call through now. Air quality
/// shares it: one Open-Meteo, one breaker, as in Python.
pub fn open_meteo_allowed() -> bool {
    OPEN_METEO.with(|b| b.borrow_mut().allow(now_ms()))
}

pub fn record_open_meteo(ok: bool) {
    OPEN_METEO.with(|b| {
        let mut b = b.borrow_mut();
        if ok {
            b.record_success();
        } else {
            b.record_failure(now_ms());
        }
    });
}

/// The Windy-style extras (multi-model series, next-hour nowcast). Best
/// effort: `None` on any failure, never failing the forecast.
pub async fn extras(lat: f64, lon: f64, models: &[String]) -> Option<Value> {
    if !OPEN_METEO.with(|b| b.borrow_mut().allow(now_ms())) {
        return None;
    }
    let url = normalize::open_meteo_extras_url(lat, lon, models);
    let out = match get_with_timeout(&url, None, OPEN_METEO_TIMEOUT).await {
        Ok(mut resp) if resp.status_code() == 200 => resp
            .json::<Value>()
            .await
            .ok()
            .map(|raw| normalize::open_meteo_extras(&raw, models)),
        _ => None,
    };
    record_open_meteo(out.is_some());
    out
}
