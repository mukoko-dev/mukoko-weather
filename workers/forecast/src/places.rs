//! Resolving a place by slug or name.
//!
//! The app's seed locations are compiled in, and a `{name}--{geohash}` slug
//! decodes to its own point. Anything else is a canonical
//! place record, which only the Nyuchi API reads and writes: this asks
//! `GET {NYUCHI_API_URL}/v1/places/{slug}` with a machine key and caches the
//! answer (found for a day, not found for an hour). The Worker never reads a
//! database for places.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use weather_core::locations::parse_spot_slug;
use weather_core::places::{resolve_seed, slugify};
use weather_core::Place;
use weather_edge::{config, get_with_timeout};
use worker::{Env, Headers};

use crate::chain::CACHE_BINDING;

const FOUND_TTL_SECONDS: u64 = 86_400;
const MISSING_TTL_SECONDS: u64 = 3_600;
const TIMEOUT: Duration = Duration::from_secs(5);

pub enum Resolved {
    Found(Place),
    Unknown,
    /// The Nyuchi API is configured but did not answer.
    Unavailable,
}

#[derive(Serialize, Deserialize)]
struct Cached {
    place: Option<Place>,
}

/// `(base URL, machine key)` when the Nyuchi API is configured.
pub fn nyuchi_api(env: &Env) -> Option<(String, String)> {
    Some((
        config(env, "NYUCHI_API_URL")?
            .trim_end_matches('/')
            .to_owned(),
        config(env, "NYUCHI_API_KEY")?,
    ))
}

pub async fn resolve(env: &Env, query: &str) -> Resolved {
    if let Some(p) = resolve_seed(query) {
        return Resolved::Found(p.clone());
    }
    // A `{name}--{geohash}` slug carries its own point (the app's smart slugs).
    if let Some((name, lat, lon)) = parse_spot_slug(query.trim()) {
        return Resolved::Found(Place {
            slug: query.trim().to_owned(),
            name: (!name.is_empty()).then_some(name),
            lat,
            lon,
            elevation: None,
            country: None,
        });
    }
    let slug = slugify(query);
    if slug.is_empty() {
        return Resolved::Unknown;
    }
    let Some((base, key)) = nyuchi_api(env) else {
        return Resolved::Unknown;
    };

    let kv = env.kv(CACHE_BINDING).ok();
    let cache_key = format!("place:v1:{slug}");
    if let Some(kv) = &kv {
        if let Ok(Some(c)) = kv.get(&cache_key).json::<Cached>().await {
            return c.place.map_or(Resolved::Unknown, Resolved::Found);
        }
    }

    let headers = Headers::new();
    if headers.set("X-API-Key", &key).is_err() || headers.set("Accept", "application/json").is_err()
    {
        return Resolved::Unavailable;
    }
    // `slug` is [a-z0-9-] only, so it is safe in a path.
    let url = format!("{base}/v1/places/{slug}");
    let (outcome, ttl) = match get_with_timeout(&url, Some(headers), TIMEOUT).await {
        Ok(mut resp) if resp.status_code() == 200 => match resp.json::<Value>().await {
            Ok(body) => match Place::from_nyuchi_place(&body) {
                Some(p) => (Resolved::Found(p), FOUND_TTL_SECONDS),
                // A place with no coordinates cannot have a forecast.
                None => (Resolved::Unknown, MISSING_TTL_SECONDS),
            },
            Err(_) => return Resolved::Unavailable,
        },
        Ok(resp) if resp.status_code() == 404 => (Resolved::Unknown, MISSING_TTL_SECONDS),
        _ => return Resolved::Unavailable,
    };

    if let Some(kv) = kv {
        let place = match &outcome {
            Resolved::Found(p) => Some(p.clone()),
            _ => None,
        };
        if let Ok(body) = serde_json::to_string(&Cached { place }) {
            if let Ok(put) = kv.put(&cache_key, body) {
                let _ = put.expiration_ttl(ttl).execute().await;
            }
        }
    }
    outcome
}
