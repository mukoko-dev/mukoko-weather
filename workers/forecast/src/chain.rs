//! The provider chain: KV cache, then the Open-Meteo multi-model blend, then
//! Open-Meteo `best_match`. Tomorrow.io is NOT in this chain: it only enriches
//! the insights afterwards (`enrich.rs`, issue #246).
//!
//! Ported from `api/py/_weather.py`:
//!
//! * the baseline is the Africa-weighted blend of six global models
//!   (`weather_core::blend`), served only when at least four members return
//!   data (the owner's floor; the Python accepted two);
//! * otherwise Open-Meteo `best_match`, clearly marked (`X-Weather-Provider:
//!   open-meteo:best_match`, and `baseline.blend: false` in the payload);
//! * breaker accounting: only a 5xx, a 429, a timeout, a transport error or an
//!   unreadable body counts against the Open-Meteo breaker. "Too few members",
//!   "no data here" and a rejected request (4xx) never do (they would open the
//!   breaker for everyone: `record_success` does not clear failures while it
//!   is closed).

use std::cell::RefCell;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use weather_core::blend::{self, NotBlended};
use weather_core::breaker::{self, Breaker};
use weather_core::{geo, normalize, Source};
use weather_edge::{get_with_timeout, now, now_ms, now_rfc3339};
use worker::{Context, Env};

pub const CACHE_BINDING: &str = "FORECAST_CACHE";
/// 15 minutes, as in the Python backend, for a blend.
const BLEND_TTL_SECONDS: u64 = 900;
/// A `best_match` answer is cached for less, so a blend that was missed to a
/// passing upstream problem is back within minutes, not a quarter of an hour.
const BEST_MATCH_TTL_SECONDS: u64 = 300;
const OPEN_METEO_TIMEOUT: Duration = Duration::from_secs(8);

thread_local! {
    pub static TOMORROW: RefCell<Breaker> = const { RefCell::new(Breaker::new(breaker::TOMORROW)) };
    static OPEN_METEO: RefCell<Breaker> = const { RefCell::new(Breaker::new(breaker::OPEN_METEO)) };
}

/// A forecast and where it came from.
#[derive(Serialize, Deserialize)]
pub struct Got {
    pub data: Value,
    pub source: Source,
    /// The baseline, as `X-Weather-Provider` says it: `open-meteo:blend` or
    /// `open-meteo:best_match`.
    pub provider: String,
    /// `X-Weather-Blend` (a blend only).
    #[serde(default)]
    pub blend: Option<String>,
    pub fetched_at: String,
    #[serde(skip)]
    pub cache_hit: bool,
}

/// The forecast KV key. The version is part of it: `wx:v1:` rows hold a
/// Tomorrow.io-or-best_match document and must never be served as a blend.
pub fn cache_key(lat: f64, lon: f64) -> String {
    format!("wx:v2:{}", geo::cache_key(lat, lon))
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

    let (data, provider, blend_header) = baseline(lat, lon).await?;
    let ttl = if blend_header.is_some() {
        BLEND_TTL_SECONDS
    } else {
        BEST_MATCH_TTL_SECONDS
    };
    let got = Got {
        data,
        source: Source::OpenMeteo,
        provider: provider.to_owned(),
        blend: blend_header,
        fetched_at: now_rfc3339(),
        cache_hit: false,
    };

    if let Some(kv) = kv {
        if let Ok(body) = serde_json::to_string(&got) {
            ctx.wait_until(async move {
                if let Ok(put) = kv.put(&key, body) {
                    let _ = put.expiration_ttl(ttl).execute().await;
                }
            });
        }
    }
    Some(got)
}

/// What one Open-Meteo call came to.
enum Fetched {
    Ok(Value),
    /// A 4xx: our request was rejected. Not an outage.
    Rejected,
    /// A 5xx, 429, timeout, transport error or unreadable body.
    Failed,
}

async fn fetch(url: &str) -> Fetched {
    match get_with_timeout(url, None, OPEN_METEO_TIMEOUT).await {
        Ok(mut resp) => {
            let status = resp.status_code();
            if status == 200 {
                match resp.json::<Value>().await {
                    Ok(v) => Fetched::Ok(v),
                    Err(_) => Fetched::Failed,
                }
            } else if status == 429 || status >= 500 {
                Fetched::Failed
            } else {
                Fetched::Rejected
            }
        }
        Err(_) => Fetched::Failed,
    }
}

/// The baseline: the blend when at least four members answered, else
/// `best_match`, marked as such. `None` when Open-Meteo gave nothing usable
/// (the caller answers 503; this Worker never invents data).
async fn baseline(lat: f64, lon: f64) -> Option<(Value, &'static str, Option<String>)> {
    let region = blend::region_for(lat, lon);
    let weights = blend::weights_for(region);
    let members = blend::order_members(&weights);

    let mut why = NotBlended::CircuitOpen;
    if open_meteo_allowed() {
        let url = blend::open_meteo_url(lat, lon, &blend::request_models(&weights));
        match fetch(&url).await {
            Fetched::Ok(raw) => match blend::build_blend(&raw, region, &weights, now()) {
                Some(out) => {
                    record_open_meteo(true);
                    return Some((out.payload, blend::PROVIDER_BLEND, Some(out.header)));
                }
                // Too few members: not an outage, so no breaker failure.
                None => {
                    why = NotBlended::TooFewMembers(blend::members_with_data(&raw, &members).len())
                }
            },
            Fetched::Rejected => why = NotBlended::Rejected,
            Fetched::Failed => {
                record_open_meteo(false);
                why = NotBlended::UpstreamError;
            }
        }
    }

    if !open_meteo_allowed() {
        return None;
    }
    let url = blend::open_meteo_url(lat, lon, &[]);
    match fetch(&url).await {
        Fetched::Ok(raw) => {
            // A 200 with no temperatures is "no data here", not an outage.
            let payload = blend::best_match_payload(&raw, why, now())?;
            record_open_meteo(true);
            Some((payload, blend::PROVIDER_BEST_MATCH, None))
        }
        Fetched::Rejected => None,
        Fetched::Failed => {
            record_open_meteo(false);
            None
        }
    }
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

/// The comparison extras for models the baseline did not carry (per-model
/// series, next-hour nowcast, and the zone, offset and elevation of the
/// point). Best effort: `None` on any failure, never failing the forecast.
pub async fn extras(lat: f64, lon: f64, models: &[String]) -> Option<Value> {
    if !open_meteo_allowed() {
        return None;
    }
    let url = normalize::open_meteo_extras_url(lat, lon, models);
    let out = match fetch(&url).await {
        Fetched::Ok(raw) => {
            let mut x = normalize::open_meteo_extras(&raw, models);
            if let Some(Value::Number(n)) = raw.get("utc_offset_seconds") {
                x["utc_offset_seconds"] = json!(n.as_f64().map(|f| f as i64));
            }
            if let Some(z) = raw
                .get("timezone")
                .and_then(Value::as_str)
                .filter(|z| !z.is_empty())
            {
                x["timezone"] = json!(z);
            }
            if let Some(e) = blend::forecast_elevation(&raw) {
                x["elevation"] = json!(e);
            }
            record_open_meteo(true);
            Some(x)
        }
        Fetched::Rejected => None,
        Fetched::Failed => {
            record_open_meteo(false);
            None
        }
    };
    out
}
