//! Where locations come from beyond the seed list: the Nyuchi API's canonical
//! places, Open-Meteo forward geocoding and Nominatim reverse geocoding. Every
//! answer is cached in KV; a failure is `None`/`Err` and never cached.

use std::time::Duration;

use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use weather_core::locations::{encode_geohash, LocationDoc, GEOHASH_PRECISION};
use weather_core::places::slugify;
use weather_edge::{config, get_with_timeout};
use worker::{Env, Headers, Url};

const CACHE: &str = "CACHE";
const TIMEOUT: Duration = Duration::from_secs(5);
const DAY: u64 = 86_400;
/// The Python backend's Nominatim identity.
const USER_AGENT: &str = "mukoko-weather/2.0 (support@mukoko.com)";

async fn cached<T: DeserializeOwned>(env: &Env, key: &str) -> Option<T> {
    env.kv(CACHE)
        .ok()?
        .get(key)
        .json::<T>()
        .await
        .ok()
        .flatten()
}

async fn store<T: Serialize>(env: &Env, key: &str, value: &T, ttl: u64) {
    let (Ok(kv), Ok(body)) = (env.kv(CACHE), serde_json::to_string(value)) else {
        return;
    };
    if let Ok(put) = kv.put(key, body) {
        let _ = put.expiration_ttl(ttl).execute().await;
    }
}

/// `(base URL, machine key)` when the Nyuchi API is configured.
fn nyuchi_api(env: &Env) -> Option<(String, String)> {
    Some((
        config(env, "NYUCHI_API_URL")?
            .trim_end_matches('/')
            .to_owned(),
        config(env, "NYUCHI_API_KEY")?,
    ))
}

async fn nyuchi_get(env: &Env, path_and_query: &str) -> Result<Option<Value>, ()> {
    let Some((base, key)) = nyuchi_api(env) else {
        return Ok(None);
    };
    let headers = Headers::new();
    headers.set("X-API-Key", &key).map_err(|_| ())?;
    headers.set("Accept", "application/json").map_err(|_| ())?;
    match get_with_timeout(&format!("{base}{path_and_query}"), Some(headers), TIMEOUT).await {
        Ok(mut r) if r.status_code() == 200 => r.json::<Value>().await.map(Some).map_err(|_| ()),
        Ok(r) if r.status_code() == 404 => Ok(None),
        _ => Err(()),
    }
}

fn docs(list: &Value) -> Vec<LocationDoc> {
    list.get("data")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(LocationDoc::from_nyuchi_place)
                .collect()
        })
        .unwrap_or_default()
}

fn with_query(base: &str, pairs: &[(&str, &str)]) -> String {
    let mut url = Url::parse(base).expect("static base URL");
    url.query_pairs_mut().extend_pairs(pairs);
    url.to_string()
}

/// A canonical place by slug (`GET /v1/places/{slug}`). `Err` when the API
/// did not answer.
pub async fn nyuchi_place(env: &Env, slug: &str) -> Result<Option<LocationDoc>, ()> {
    let slug = slugify(slug);
    if slug.is_empty() {
        return Ok(None);
    }
    let key = format!("ploc:v1:{slug}");
    if let Some(hit) = cached::<Option<LocationDoc>>(env, &key).await {
        return Ok(hit);
    }
    // `slug` is [a-z0-9-] only, so it is safe in a path.
    let found = nyuchi_get(env, &format!("/v1/places/{slug}"))
        .await?
        .and_then(|b| LocationDoc::from_nyuchi_place(&b));
    store(env, &key, &found, if found.is_some() { DAY } else { 3_600 }).await;
    Ok(found)
}

/// Canonical places whose name matches `q`.
pub async fn nyuchi_search(env: &Env, q: &str, limit: usize) -> Result<Vec<LocationDoc>, ()> {
    let norm = slugify(q);
    if norm.is_empty() {
        return Ok(vec![]);
    }
    let key = format!("psearch:v1:{norm}:{limit}");
    if let Some(hit) = cached(env, &key).await {
        return Ok(hit);
    }
    let mut url = Url::parse("https://nyuchi.invalid/v1/places").expect("static URL");
    url.query_pairs_mut()
        .append_pair("q", q.trim())
        .append_pair("limit", &limit.to_string());
    let path = format!("{}?{}", url.path(), url.query().unwrap_or(""));
    let found = nyuchi_get(env, &path)
        .await?
        .map(|b| docs(&b))
        .unwrap_or_default();
    store(env, &key, &found, 3_600).await;
    Ok(found)
}

/// Canonical places near a point, nearest first.
pub async fn nyuchi_nearby(
    env: &Env,
    lat: f64,
    lon: f64,
    radius_km: f64,
    limit: usize,
) -> Result<Vec<LocationDoc>, ()> {
    let path =
        format!("/v1/places/nearby?lat={lat:.4}&lng={lon:.4}&radius_km={radius_km}&limit={limit}");
    let key = format!("pnear:v1:{lat:.2}_{lon:.2}:{radius_km}:{limit}");
    if let Some(hit) = cached(env, &key).await {
        return Ok(hit);
    }
    let found = nyuchi_get(env, &path)
        .await?
        .map(|b| docs(&b))
        .unwrap_or_default();
    store(env, &key, &found, 3_600).await;
    Ok(found)
}

/// Open-Meteo forward geocoding: candidates for a name.
pub async fn geocode(env: &Env, q: &str, count: usize) -> Result<Vec<LocationDoc>, ()> {
    let norm = slugify(q);
    if norm.is_empty() {
        return Ok(vec![]);
    }
    let key = format!("geocode:v1:{norm}:{count}");
    if let Some(hit) = cached(env, &key).await {
        return Ok(hit);
    }
    let url = with_query(
        "https://geocoding-api.open-meteo.com/v1/search",
        &[
            ("name", q.trim()),
            ("count", &count.to_string()),
            ("language", "en"),
        ],
    );
    let found: Vec<LocationDoc> = match get_with_timeout(&url, None, TIMEOUT).await {
        Ok(mut r) if r.status_code() == 200 => r
            .json::<Value>()
            .await
            .map_err(|_| ())?
            .get("results")
            .and_then(Value::as_array)
            .map(|rs| rs.iter().filter_map(LocationDoc::from_open_meteo).collect())
            .unwrap_or_default(),
        _ => return Err(()),
    };
    store(env, &key, &found, DAY).await;
    Ok(found)
}

/// The cache key of a reverse geocode: the point's 153 m geohash cell.
pub fn reverse_key(lat: f64, lon: f64) -> String {
    format!("rev:v1:{}", encode_geohash(lat, lon, GEOHASH_PRECISION))
}

/// A reverse geocode cached earlier for this cell, if any.
pub async fn reverse_cached(env: &Env, lat: f64, lon: f64) -> Option<LocationDoc> {
    cached::<Option<LocationDoc>>(env, &reverse_key(lat, lon))
        .await
        .flatten()
}

/// Nominatim reverse geocoding: name the point. `Ok(None)` when Nominatim has
/// no name for it.
pub async fn reverse(env: &Env, lat: f64, lon: f64) -> Result<Option<LocationDoc>, ()> {
    let key = reverse_key(lat, lon);
    if let Some(hit) = cached::<Option<LocationDoc>>(env, &key).await {
        return Ok(hit);
    }
    let url = with_query(
        "https://nominatim.openstreetmap.org/reverse",
        &[
            ("lat", &lat.to_string()),
            ("lon", &lon.to_string()),
            ("format", "jsonv2"),
            ("zoom", "18"),
            ("accept-language", "en"),
        ],
    );
    let headers = Headers::new();
    headers.set("User-Agent", USER_AGENT).map_err(|_| ())?;
    let found = match get_with_timeout(&url, Some(headers), TIMEOUT).await {
        Ok(mut r) if r.status_code() == 200 => {
            let body = r.json::<Value>().await.map_err(|_| ())?;
            LocationDoc::from_nominatim(&body, lat, lon)
        }
        _ => return Err(()),
    };
    store(env, &key, &found, 30 * DAY).await;
    Ok(found)
}
