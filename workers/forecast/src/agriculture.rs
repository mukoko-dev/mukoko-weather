//! `GET /agriculture?lat=&lon=[&location=][&country=][&crops=]`: deterministic
//! farm-weather data (ported from `api/py/_agriculture.py`, the GET route).
//!
//! The analysis is `weather_core::agriculture`, pinned to the Python by
//! `tests/fixtures/agriculture-analysis.json`. This is the I/O around it:
//!
//! - ONE batched Open-Meteo forecast request (soil moisture and temperature by
//!   depth, ET0, VPD, leaf wetness, rain, wind, temperature; the past 30 days
//!   plus 16 forecast days) behind the shared Open-Meteo breaker, its raw
//!   payload cached 1 h in KV per 0.05° cell. The analysis runs on every
//!   request: it is cheap and depends on the caller's crops;
//! - the location profile (season, crop calendars with the current phase,
//!   climate context, ENSO) from `profile::cached_profile`: cache-only, as the
//!   Python's `get_location_profile(allow_build=False)` was. It reads the
//!   cell's normals when KV holds them and never fetches soil or normals, and
//!   it spends no `PlaceProfile` budget. It is NOT free of upstream calls: a
//!   `location` slug that is neither a seed nor a `{name}--{geohash}` spot
//!   resolves through the Nyuchi API (`places::resolve`, KV-cached under
//!   `place:v1:`, one call per slug per miss), as `/weather?location=` does.
//!   Nothing but the public API's per-IP limit bounds those lookups.
//!
//! Only upstream trouble (5xx, 429, transport, timeout, an undecodable 200
//! body) counts against the breaker; a 4xx is our own request being refused,
//! and letting it open the breaker would also cut off the forecast, air
//! quality and haze. Failures are HTTP 200 with `available: false` and a
//! `reason` (`provider_unavailable`, `provider_error`, `insufficient_data`,
//! `analysis_error`), `no-store`; a successful answer is
//! `weather_core::agriculture::CLIENT_CACHE_CONTROL`.

use std::time::Duration;

use serde_json::Value;
use weather_core::agriculture as ag;
use weather_core::reference::is_known_activity;
use weather_edge::{error, get_with_timeout, json, now, query_pairs};
use worker::{Context, Env, Request, Response, Result};

use crate::chain::{self, CACHE_BINDING};
use crate::profile;

const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CROPS: usize = 20;

/// `SLUG_RE`: `^[a-z0-9-]{1,80}$`.
fn clean_slug(raw: &str) -> Option<String> {
    let s = raw.trim().to_lowercase();
    (!s.is_empty()
        && s.len() <= 80
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'))
    .then_some(s)
}

/// The caller's activity ids: lowercased, at most 20, unknown ones dropped.
fn parse_crops(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|c| c.trim().to_lowercase())
        .filter(|c| !c.is_empty())
        .take(MAX_CROPS)
        .filter(|c| is_known_activity(c))
        .collect()
}

/// `weather_edge::json` defaults to `no-store`, and the public API relay reads
/// an upstream `no-store` as a degraded answer, so a success must say what it
/// may be cached for (`weather_core::agriculture::cache_control`).
fn respond(body: &ag::AgricultureResponse, cache: &str) -> Result<Response> {
    let resp = json(200, body)?;
    resp.headers().set("X-Cache", cache)?;
    resp.headers()
        .set("Cache-Control", ag::cache_control(body.available))?;
    Ok(resp)
}

enum Raw {
    Hit(Value),
    Fresh(Value),
    Failed(&'static str),
}

async fn raw_payload(env: &Env, ctx: &Context, lat: f64, lon: f64) -> Raw {
    let key = ag::cache_key(lat, lon);
    let kv = env.kv(CACHE_BINDING).ok();
    if let Some(kv) = &kv {
        if let Ok(Some(hit)) = kv.get(&key).json::<Value>().await {
            return Raw::Hit(hit);
        }
    }
    if !chain::open_meteo_allowed() {
        return Raw::Failed("provider_unavailable");
    }
    let url = ag::forecast_url("https://api.open-meteo.com", lat, lon);
    let data = match get_with_timeout(&url, None, TIMEOUT).await {
        Ok(mut resp) => {
            let status = resp.status_code();
            if status >= 400 {
                if status == 429 || status >= 500 {
                    chain::record_open_meteo(false);
                }
                return Raw::Failed("provider_error");
            }
            match resp.json::<Value>().await {
                Ok(v) if v.is_object() => v,
                // Valid JSON of the wrong shape is not an outage (the Python
                // did not count it either).
                Ok(_) => return Raw::Failed("provider_error"),
                // A truncated or undecodable 200, or a connection dropped
                // mid-body, is upstream trouble: it counts, as it did in the
                // Python and in `chain::open_meteo`. Otherwise the breaker never
                // opens on this failure mode and every request waits out the
                // timeout.
                Err(_) => {
                    chain::record_open_meteo(false);
                    return Raw::Failed("provider_error");
                }
            }
        }
        Err(_) => {
            chain::record_open_meteo(false);
            return Raw::Failed("provider_error");
        }
    };
    chain::record_open_meteo(true);
    if let Some(kv) = kv {
        if let Ok(text) = serde_json::to_string(&data) {
            ctx.wait_until(async move {
                if let Ok(put) = kv.put(&key, text) {
                    let _ = put
                        .expiration_ttl(ag::DATA_CACHE_TTL_SECONDS)
                        .execute()
                        .await;
                }
            });
        }
    }
    Raw::Fresh(data)
}

pub async fn agriculture(req: &Request, env: &Env, ctx: &Context) -> Result<Response> {
    let pairs = query_pairs(req)?;
    let get = |k: &str| pairs.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
    let coord = |k: &str, lo: f64, hi: f64| {
        get(k)
            .and_then(|v| v.trim().parse::<f64>().ok())
            .filter(|v| v.is_finite() && (lo..=hi).contains(v))
    };
    let (Some(lat), Some(lon)) = (coord("lat", -90.0, 90.0), coord("lon", -180.0, 180.0)) else {
        return error(422, "invalid_request", "Give valid `lat` and `lon`.");
    };
    let location = get("location").unwrap_or("");
    let country = get("country").unwrap_or("");
    let crops_raw = get("crops").unwrap_or("");
    if location.len() > 80 || country.len() > 3 || crops_raw.len() > 400 {
        return error(422, "invalid_request", "A parameter is too long.");
    }
    let crops = parse_crops(crops_raw);

    let (raw, cache) = match raw_payload(env, ctx, lat, lon).await {
        Raw::Hit(v) => (v, "HIT"),
        Raw::Fresh(v) => (v, "MISS"),
        Raw::Failed(reason) => return respond(&ag::unavailable(reason, now()), "MISS"),
    };

    // The country is only a hint: a two-letter code, else the place's own.
    let iso = country.trim().to_uppercase();
    let iso = (iso.len() == 2 && iso.chars().all(|c| c.is_ascii_uppercase())).then_some(iso);
    let slug = clean_slug(location);
    let profile = profile::cached_profile(env, slug.as_deref(), lat, lon, iso.as_deref()).await;

    respond(
        &ag::analyse(&raw, lat, &crops, profile.as_ref(), now()),
        cache,
    )
}
