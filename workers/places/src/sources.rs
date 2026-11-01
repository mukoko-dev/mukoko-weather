//! Where locations come from beyond the seed list: the Nyuchi API's canonical
//! places, Open-Meteo forward geocoding and Nominatim reverse geocoding. Every
//! answer is cached in KV; a failure is `None`/`Err` and never cached.

use std::time::Duration;

use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use weather_core::budget::Action;
use weather_core::cache::Slot;
use weather_core::locations::{
    community_lookup, encode_geohash, CommunityLookup, LocationDoc, GEOHASH_PRECISION,
};
use weather_core::places::slugify;
use weather_core::secrets;
use weather_edge::{config, get_with_timeout, secret};
use worker::{Env, Headers, Method, Url};

use crate::bridge::{self, Answer};

const CACHE: &str = "CACHE";
const TIMEOUT: Duration = Duration::from_secs(5);
/// The canonical-places lookup behind `/search` only enriches the answer, so
/// it gets a short leash: a slow upstream must not slow every search.
const SEARCH_ENRICH_TIMEOUT: Duration = Duration::from_millis(1_500);
/// KV marker: the canonical-places search failed lately, skip it for a while.
const SEARCH_DOWN_KEY: &str = "psearch:v1:down";
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

/// A cached lookup that may be a cached "nothing here" (`Some(None)`); `None`
/// is a real miss. Stored as a [`Slot`] because KV reads a bare JSON `null`
/// back as a miss.
async fn cached_slot<T: DeserializeOwned>(env: &Env, key: &str) -> Option<Option<T>> {
    cached::<Slot<T>>(env, key).await.map(|slot| slot.found)
}

async fn store_slot<T: Serialize>(env: &Env, key: &str, found: &Option<T>, ttl: u64) {
    // Slot owns its value, so serialise a borrowed view.
    #[derive(Serialize)]
    struct Borrowed<'a, T> {
        found: &'a Option<T>,
    }
    store(env, key, &Borrowed { found }, ttl).await;
}

/// `(base URL, machine key)` when the Nyuchi API is configured.
async fn nyuchi_api(env: &Env) -> Option<(String, String)> {
    Some((
        config(env, "NYUCHI_API_URL")?
            .trim_end_matches('/')
            .to_owned(),
        secret(env, secrets::NYUCHI_API_KEY).await?,
    ))
}

async fn nyuchi_get(env: &Env, path_and_query: &str) -> Result<Option<Value>, ()> {
    nyuchi_get_within(env, path_and_query, TIMEOUT).await
}

async fn nyuchi_get_within(
    env: &Env,
    path_and_query: &str,
    timeout: Duration,
) -> Result<Option<Value>, ()> {
    let Some((base, key)) = nyuchi_api(env).await else {
        return Ok(None);
    };
    let headers = Headers::new();
    headers.set("X-API-Key", &key).map_err(|_| ())?;
    headers.set("Accept", "application/json").map_err(|_| ())?;
    match get_with_timeout(&format!("{base}{path_and_query}"), Some(headers), timeout).await {
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
    let key = format!("ploc:v2:{slug}");
    if let Some(hit) = cached_slot::<LocationDoc>(env, &key).await {
        return Ok(hit);
    }
    // `slug` is [a-z0-9-] only, so it is safe in a path.
    let found = nyuchi_get(env, &format!("/v1/places/{slug}"))
        .await?
        .and_then(|b| LocationDoc::from_nyuchi_place(&b));
    store_slot(env, &key, &found, if found.is_some() { DAY } else { 3_600 }).await;
    Ok(found)
}

/// A community place from `places.placesGeo`, by the slug the app stamped on
/// it (`windsor-avenue-zw`), through the MongoDB bridge: this Worker holds no
/// database connection. `Ok(None)` is the platform saying it has no such
/// place; `Err` is the bridge not answering or the read not being permitted,
/// which is NEVER "not found" (the caller fails closed). Not cached here: the
/// bridge keeps its own short cache.
pub async fn community_place(env: &Env, slug: &str) -> Result<Option<LocationDoc>, ()> {
    if !weather_core::slug::valid_slug(slug) {
        return Ok(None);
    }
    // `slug` is [a-z0-9-] only, so it is safe in a query string.
    let (status, body) =
        match bridge::call(env, Method::Get, &format!("/places?slug={slug}"), None).await {
            Answer::Relay { status, body } => (status, body),
            Answer::Unavailable { .. } => return Err(()),
        };
    match community_lookup(status, &body) {
        CommunityLookup::Found(place) => Ok(Some(*place)),
        CommunityLookup::NotFound => Ok(None),
        CommunityLookup::Unavailable => Err(()),
    }
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
    let down = cached::<bool>(env, SEARCH_DOWN_KEY).await.is_some();
    if !weather_core::cache::should_call_upstream(down) {
        return Err(());
    }
    let body = match nyuchi_get_within(env, &path, SEARCH_ENRICH_TIMEOUT).await {
        Ok(body) => body,
        Err(()) => {
            store(
                env,
                SEARCH_DOWN_KEY,
                &true,
                weather_core::cache::marker_ttl_on_failure(),
            )
            .await;
            return Err(());
        }
    };
    let found = body.map(|b| docs(&b)).unwrap_or_default();
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

/// Why a forward geocode gave no answer.
#[derive(Debug, PartialEq, Eq)]
pub enum GeoErr {
    /// Over the hourly per-client or service-wide budget (or the budget store
    /// could not be read: it fails closed): no upstream call was made.
    Budget,
    /// Open-Meteo did not answer, or answered badly.
    Upstream,
}

/// A forward-geocode answer is kept a day; an empty one (no such name) only
/// ten minutes, since empty can also be a hiccup.
const GEOCODE_HIT_TTL: u64 = DAY;
const GEOCODE_MISS_TTL: u64 = 600;

/// Open-Meteo forward geocoding: candidates for a name. Cached in KV (hits a
/// day, misses ten minutes); an upstream failure is never cached.
pub async fn geocode(
    env: &Env,
    q: &str,
    count: usize,
    action: Action,
    caller: &crate::budget::Caller,
) -> Result<Vec<LocationDoc>, GeoErr> {
    let norm = slugify(q);
    if norm.is_empty() {
        return Ok(vec![]);
    }
    // v2: hits carry spot slugs and the `area` flag (v1 held `london-gb`).
    let key = format!("geocode:v2:{norm}:{count}");
    if let Some(hit) = cached(env, &key).await {
        return Ok(hit);
    }
    // Only an uncached call goes upstream, so only it spends the budget.
    // `action` keeps resolve and search budgets apart.
    if !crate::budget::take(env, action, caller).await.allowed() {
        return Err(GeoErr::Budget);
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
            .map_err(|_| GeoErr::Upstream)?
            .get("results")
            .and_then(Value::as_array)
            .map(|rs| rs.iter().filter_map(LocationDoc::from_open_meteo).collect())
            .unwrap_or_default(),
        _ => return Err(GeoErr::Upstream),
    };
    let ttl = if found.is_empty() {
        GEOCODE_MISS_TTL
    } else {
        GEOCODE_HIT_TTL
    };
    store(env, &key, &found, ttl).await;
    Ok(found)
}

/// The cache key of a reverse geocode: the point's 153 m geohash cell.
pub fn reverse_key(lat: f64, lon: f64) -> String {
    format!("rev:v2:{}", encode_geohash(lat, lon, GEOHASH_PRECISION))
}

/// A reverse geocode cached earlier for this cell, if any.
pub async fn reverse_cached(env: &Env, lat: f64, lon: f64) -> Option<Option<LocationDoc>> {
    cached_slot::<LocationDoc>(env, &reverse_key(lat, lon)).await
}

/// Nominatim reverse geocoding: name the point. `Ok(None)` when Nominatim has
/// no name for it.
pub async fn reverse(env: &Env, lat: f64, lon: f64) -> Result<Option<LocationDoc>, ()> {
    let key = reverse_key(lat, lon);
    if let Some(hit) = cached_slot::<LocationDoc>(env, &key).await {
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
    store_slot(env, &key, &found, 30 * DAY).await;
    Ok(found)
}

/// A reverse geocode cached for a snapped cell: the document, or `None` when
/// Nominatim named nothing there.
type CellName = Option<LocationDoc>;

fn cell_key(lat: f64, lon: f64) -> String {
    format!("revcell:v2:{lat:.2}_{lon:.2}")
}

/// The cached answer for a cell, if any (`Some(None)` is a cached "nothing
/// here"), so a cache hit never spends the per-IP budget.
pub async fn reverse_cell_cached(env: &Env, lat: f64, lon: f64) -> Option<CellName> {
    cached_slot::<LocationDoc>(env, &cell_key(lat, lon)).await
}

/// A city-level (zoom 10) Nominatim name for a snapped ~1 km cell, for the
/// find-only path: the answer stands for "around here", never an address, and
/// one cell shares one lookup. `Ok(None)` when Nominatim names nothing (open
/// water, polar ice, empty desert); `Err` when it did not answer (never
/// cached). Hits are kept 6 hours, "nothing here" 10 minutes.
pub async fn reverse_cell(env: &Env, lat: f64, lon: f64) -> Result<CellName, ()> {
    let key = cell_key(lat, lon);
    if let Some(hit) = cached_slot::<LocationDoc>(env, &key).await {
        return Ok(hit);
    }
    let url = with_query(
        "https://nominatim.openstreetmap.org/reverse",
        &[
            ("lat", &lat.to_string()),
            ("lon", &lon.to_string()),
            ("format", "jsonv2"),
            ("zoom", "10"),
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
        // "Unable to geocode" is a 200 with an error body: nothing here.
        Ok(r) if r.status_code() == 404 => None,
        _ => return Err(()),
    };
    let ttl = if found.is_some() { 6 * 3_600 } else { 600 };
    store_slot(env, &key, &found, ttl).await;
    Ok(found)
}
