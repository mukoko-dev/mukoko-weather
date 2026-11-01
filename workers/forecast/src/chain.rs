//! The provider chain: KV cache, then the Open-Meteo multi-model blend, then
//! Open-Meteo `best_match`. Tomorrow.io is NOT in this chain: it only enriches
//! the insights afterwards (`enrich.rs`, issue #246).
//!
//! Ported from `api/py/_weather.py`:
//!
//! * the baseline is the Africa-weighted blend of nine global models
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
use weather_core::blend::{self, Attempt, NotBlended, Upstream};
use weather_core::breaker::{self, Breaker};
use weather_core::{normalize, Source};
use weather_edge::{get_with_timeout, now, now_ms, now_rfc3339};
use worker::{Context, Env};

pub const CACHE_BINDING: &str = "FORECAST_CACHE";
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

/// The forecast for a point, or `None` when the cache is cold and every
/// provider failed. `refresh` skips the cache read (the answer is still
/// cached): the jobs Worker uses it to keep popular places warm. `model` is
/// the caller's single-model baseline (`?model=`, already sanitised with
/// [`blend::sanitize_baseline_model`]); `None` is the Africa-weighted blend.
pub async fn forecast(
    env: &Env,
    ctx: &Context,
    lat: f64,
    lon: f64,
    refresh: bool,
    model: Option<&str>,
) -> Option<Got> {
    let kv = env.kv(CACHE_BINDING).ok();
    // The key and the lifetime are `weather_core::blend`'s rules.
    let key = blend::forecast_cache_key(lat, lon, model);

    if let Some(kv) = kv.as_ref().filter(|_| !refresh) {
        if let Ok(Some(mut hit)) = kv.get(&key).json::<Got>().await {
            hit.cache_hit = true;
            return Some(hit);
        }
    }

    let (data, provider, blend_header) = baseline(env, lat, lon, model).await?;
    let ttl = blend::cache_ttl_seconds(&provider);
    let got = Got {
        data,
        source: Source::OpenMeteo,
        provider,
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

/// The baseline: the blend when at least four members answered (every member
/// that returned data is used, weights renormalised over those present), else
/// `best_match`, marked as such. With `model` set (the caller's own pick) the
/// baseline is that one model, nulls filled from `best_match`; when it has no
/// data here, or its request fails, the answer is `best_match` too. `None` when
/// Open-Meteo gave nothing usable (the caller answers 503; this Worker never
/// invents data).
async fn baseline(
    env: &Env,
    lat: f64,
    lon: f64,
    model: Option<&str>,
) -> Option<(Value, String, Option<String>)> {
    if let Some(model) = model {
        return match single_model(lat, lon, model).await {
            Some(payload) => Some((payload, blend::single_model_provider(model), None)),
            None => best_match(lat, lon, NotBlended::SelectedModelUnavailable).await,
        };
    }

    let region = blend::region_for(lat, lon);
    // The compiled-in weights, or the `weather.modelBlendConfig` override.
    let weights = crate::blend_config::weights(env, region).await;

    let upstream = if open_meteo_allowed() {
        let url = blend::open_meteo_url(lat, lon, &blend::request_models(&weights));
        Some(fetch(&url).await)
    } else {
        None
    };
    let attempt = blend::attempt_blend(
        match &upstream {
            Some(Fetched::Ok(raw)) => Upstream::Body(raw),
            Some(Fetched::Rejected) => Upstream::Rejected,
            Some(Fetched::Failed) => Upstream::Failed,
            None => Upstream::BreakerOpen,
        },
        region,
        &weights,
        now(),
    );
    let why = match attempt {
        Attempt::Blended(out) => {
            record_open_meteo(true);
            return Some((
                out.payload,
                blend::PROVIDER_BLEND.to_owned(),
                Some(out.header),
            ));
        }
        Attempt::Fallback {
            why,
            breaker_failure,
        } => {
            // Only an outage counts: too few members or a rejected request
            // would open the breaker for everyone.
            if breaker_failure {
                record_open_meteo(false);
            }
            why
        }
    };
    best_match(lat, lon, why).await
}

/// The baseline from the one model the caller picked: `models=<model>,
/// best_match` in one request, the model taking all the weight and
/// `best_match` filling what it does not publish. `None` when the model has no
/// data here (not an outage: no breaker failure), the breaker is open, or the
/// request was rejected or failed (only a failure counts against the breaker).
async fn single_model(lat: f64, lon: f64, model: &str) -> Option<Value> {
    let upstream = if open_meteo_allowed() {
        let url = blend::open_meteo_url(lat, lon, &blend::single_model_request(model));
        Some(fetch(&url).await)
    } else {
        None
    };
    // The decision (and the breaker accounting) is `weather_core`'s.
    match blend::attempt_single_model(
        match &upstream {
            Some(Fetched::Ok(raw)) => Upstream::Body(raw),
            Some(Fetched::Rejected) => Upstream::Rejected,
            Some(Fetched::Failed) => Upstream::Failed,
            None => Upstream::BreakerOpen,
        },
        model,
        now(),
    ) {
        blend::SingleAttempt::Built(payload) => {
            record_open_meteo(true);
            Some(payload)
        }
        blend::SingleAttempt::Fallback { breaker_failure } => {
            if breaker_failure {
                record_open_meteo(false);
            }
            None
        }
    }
}

/// The `best_match` baseline, marked with why it is not the blend (or the
/// picked model).
async fn best_match(
    lat: f64,
    lon: f64,
    why: NotBlended,
) -> Option<(Value, String, Option<String>)> {
    if !open_meteo_allowed() {
        return None;
    }
    let url = blend::open_meteo_url(lat, lon, &[]);
    match fetch(&url).await {
        Fetched::Ok(raw) => {
            // A 200 with no temperatures is "no data here", not an outage.
            let payload = blend::best_match_payload(&raw, why, now())?;
            record_open_meteo(true);
            Some((payload, blend::PROVIDER_BEST_MATCH.to_owned(), None))
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

/// [`extras`] through the KV cache: one Open-Meteo call per cell and model set
/// per quarter of an hour (the key and lifetime are
/// `weather_core::normalize::extras_cache_key` / `EXTRAS_CACHE_TTL_SECONDS`),
/// instead of one per request. Only a success is cached.
pub async fn extras_cached(
    env: &Env,
    ctx: &Context,
    lat: f64,
    lon: f64,
    models: &[String],
) -> Option<Value> {
    let kv = env.kv(CACHE_BINDING).ok();
    let key = normalize::extras_cache_key(lat, lon, models);
    if let Some(kv) = &kv {
        if let Ok(Some(hit)) = kv.get(&key).json::<Value>().await {
            return Some(hit);
        }
    }
    let fresh = extras(lat, lon, models).await?;
    if let Some(kv) = kv {
        if let Ok(body) = serde_json::to_string(&fresh) {
            ctx.wait_until(async move {
                if let Ok(put) = kv.put(&key, body) {
                    let _ = put
                        .expiration_ttl(normalize::EXTRAS_CACHE_TTL_SECONDS)
                        .execute()
                        .await;
                }
            });
        }
    }
    Some(fresh)
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
