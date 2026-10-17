//! Where locations come from beyond the seed list: the Nyuchi API's
//! community places, Open-Meteo forward geocoding and Nominatim reverse
//! geocoding. Every answer is cached in KV; a failure is `Err` and never
//! cached. Only an outage (5xx, transport error, timeout) counts against a
//! provider's circuit breaker, never a 4xx or an empty answer, as in the
//! Python backend.

use std::cell::RefCell;
use std::time::Duration;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use weather_core::breaker::{self, Breaker};
use weather_core::locations::{encode_geohash, LocationDoc, GEOHASH_PRECISION};
use weather_core::place_search::{self as ps, GeocodeHit};
use weather_core::places::slugify;
use weather_core::secrets;
use weather_edge::{config, get_with_timeout, now_ms, secret, FetchError};
use worker::{Env, Headers, Url};

use crate::limits;

const CACHE: &str = "CACHE";
const TIMEOUT: Duration = Duration::from_secs(5);
const DAY: u64 = 86_400;
/// The Python backend's Nominatim identity.
const USER_AGENT: &str = "mukoko-weather/2.0 (support@mukoko.com)";
/// Geocoder answers are kept an hour (the Python per-instance cache).
const GEOCODE_TTL: u64 = 3_600;

thread_local! {
    static OPEN_METEO: RefCell<Breaker> = const { RefCell::new(Breaker::new(breaker::OPEN_METEO)) };
    static NOMINATIM: RefCell<Breaker> = const { RefCell::new(Breaker::new(breaker::NOMINATIM)) };
}

/// Whether the Open-Meteo (geocoder) breaker lets a call through now.
pub fn open_meteo_allowed() -> bool {
    OPEN_METEO.with(|b| b.borrow_mut().allow(now_ms()))
}

fn nominatim_allowed() -> bool {
    NOMINATIM.with(|b| b.borrow_mut().allow(now_ms()))
}

fn record(breaker: &'static std::thread::LocalKey<RefCell<Breaker>>, ok: bool) {
    breaker.with(|b| {
        let mut b = b.borrow_mut();
        if ok {
            b.record_success();
        } else {
            b.record_failure(now_ms());
        }
    });
}

/// A cached value that may itself be "nothing": KV cannot tell a stored JSON
/// `null` from a missing key, so negative answers are wrapped.
#[derive(Serialize, Deserialize)]
struct Slot<T> {
    v: Option<T>,
}

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
        let _ = put.expiration_ttl(ttl.max(60)).execute().await;
    }
}

/// `Some(answer)` when a slot is cached (the answer may be `None`).
async fn cached_slot<T: DeserializeOwned>(env: &Env, key: &str) -> Option<Option<T>> {
    cached::<Slot<T>>(env, key).await.map(|s| s.v)
}

async fn store_slot<T: Serialize>(env: &Env, key: &str, value: Option<&T>, ttl: u64) {
    store(env, key, &Slot { v: value }, ttl).await;
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
    let Some((base, key)) = nyuchi_api(env).await else {
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

fn with_query(base: &str, pairs: &[(&str, &str)]) -> String {
    let mut url = Url::parse(base).expect("static base URL");
    url.query_pairs_mut().extend_pairs(pairs);
    url.to_string()
}

/// A community place by slug (`GET /v1/places/{slug}`: `places.places`, the
/// place refs `{name}--osm-…`). `Err` when the API did not answer.
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

/// Open-Meteo forward geocoding. `budget_ip` is the client to charge a miss
/// to (`search-geocode`, 120 an hour): over budget the answer is empty and
/// not cached, never an error. Cached answers are free. `Err` when the
/// breaker is open or Open-Meteo is down.
pub async fn geocode_hits(
    env: &Env,
    q: &str,
    count: usize,
    budget_ip: Option<&str>,
) -> Result<Vec<GeocodeHit>, ()> {
    let norm = ps::normalise_query(q);
    if norm.is_empty() {
        return Ok(vec![]);
    }
    let key = format!("geocode:v2:{}:{count}", slugify(&norm));
    if let Some(hit) = cached::<Vec<GeocodeHit>>(env, &key).await {
        return Ok(hit);
    }
    if !open_meteo_allowed() {
        return Err(());
    }
    if let Some(ip) = budget_ip {
        if !limits::within(env, ip, "search-geocode", ps::GEOCODE_TOP_UP_PER_IP).await {
            return Ok(vec![]);
        }
    }
    let url = with_query(
        "https://geocoding-api.open-meteo.com/v1/search",
        &[
            ("name", q.trim()),
            ("count", &count.to_string()),
            ("language", "en"),
        ],
    );
    let hits: Vec<GeocodeHit> = match get_with_timeout(&url, None, TIMEOUT).await {
        Ok(mut r) if r.status_code() == 200 => {
            let body = r.json::<Value>().await.map_err(|_| ());
            record(&OPEN_METEO, body.is_ok());
            body?
                .get("results")
                .and_then(Value::as_array)
                .map(|rs| rs.iter().filter_map(GeocodeHit::from_open_meteo).collect())
                .unwrap_or_default()
        }
        // Our own request was refused: not an outage, nothing to cache.
        Ok(r) if r.status_code() < 500 => return Ok(vec![]),
        Ok(_) | Err(FetchError::Timeout) | Err(FetchError::Network(_)) => {
            record(&OPEN_METEO, false);
            return Err(());
        }
    };
    store(env, &key, &hits, GEOCODE_TTL).await;
    Ok(hits)
}

/// A bare name from a URL, resolved: the cached answer, if any.
pub async fn resolve_cached(env: &Env, name: &str) -> Option<Option<LocationDoc>> {
    cached_slot(env, &format!("resolve:v1:{}", slugify(name))).await
}

pub async fn resolve_store(env: &Env, name: &str, found: Option<&LocationDoc>) {
    let ttl = if found.is_some() {
        ps::RESOLVE_CACHE_TTL_S
    } else {
        ps::RESOLVE_MISS_TTL_S
    };
    store_slot(env, &format!("resolve:v1:{}", slugify(name)), found, ttl).await;
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

/// How a Nominatim call ended.
enum Reverse {
    Body(Value),
    /// 4xx, or an unreadable body: not an outage.
    Refused,
    Outage,
}

async fn nominatim(lat: f64, lon: f64, zoom: u8) -> Reverse {
    let url = with_query(
        "https://nominatim.openstreetmap.org/reverse",
        &[
            ("lat", &lat.to_string()),
            ("lon", &lon.to_string()),
            ("format", "jsonv2"),
            ("zoom", &zoom.to_string()),
            ("accept-language", "en"),
        ],
    );
    let headers = Headers::new();
    if headers.set("User-Agent", USER_AGENT).is_err() {
        return Reverse::Refused;
    }
    match get_with_timeout(&url, Some(headers), TIMEOUT).await {
        Ok(mut r) if r.status_code() == 200 => match r.json::<Value>().await {
            Ok(body) => {
                record(&NOMINATIM, true);
                Reverse::Body(body)
            }
            Err(_) => {
                record(&NOMINATIM, false);
                Reverse::Outage
            }
        },
        Ok(r) if r.status_code() < 500 => Reverse::Refused,
        Ok(_) | Err(FetchError::Timeout) | Err(FetchError::Network(_)) => {
            record(&NOMINATIM, false);
            Reverse::Outage
        }
    }
}

/// Nominatim reverse geocoding at building level: name the exact point.
/// `Ok(None)` when Nominatim has no name for it.
pub async fn reverse(env: &Env, lat: f64, lon: f64) -> Result<Option<LocationDoc>, ()> {
    let key = reverse_key(lat, lon);
    if let Some(hit) = cached::<Option<LocationDoc>>(env, &key).await {
        return Ok(hit);
    }
    if !nominatim_allowed() {
        return Err(());
    }
    let found = match nominatim(lat, lon, 18).await {
        Reverse::Body(body) => LocationDoc::from_nominatim(&body, lat, lon),
        Reverse::Refused | Reverse::Outage => return Err(()),
    };
    store(env, &key, &found, 30 * DAY).await;
    Ok(found)
}

/// Find-only naming of a point no stored place is near: one city-level
/// reverse geocode of the coordinate snapped to 0.01 degrees, cached per
/// cell (6 h; a miss 10 min), within 30 an hour per client and 900 an hour
/// service-wide, behind the Nominatim breaker. Any skip or failure is
/// `None`; nothing is stored and the exact position never leaves the request.
pub async fn find_only_spot(env: &Env, lat: f64, lon: f64, client: &str) -> Option<LocationDoc> {
    let (slat, slon) = (ps::snap(lat), ps::snap(lon));
    let key = format!("fo:v1:{slat}_{slon}");
    if let Some(answer) = cached_slot::<LocationDoc>(env, &key).await {
        return answer;
    }
    if !nominatim_allowed() {
        return None;
    }
    if !limits::within(
        env,
        client,
        "geo-find-geocode",
        ps::FIND_ONLY_GEOCODE_PER_IP,
    )
    .await
        || !limits::within(
            env,
            "all",
            "geo-find-geocode-global",
            ps::FIND_ONLY_GEOCODE_GLOBAL,
        )
        .await
    {
        return None;
    }
    let spot = match nominatim(slat, slon, ps::FIND_ONLY_ZOOM).await {
        Reverse::Body(body) => ps::spot_from_nominatim(&body, slat, slon),
        Reverse::Refused => None,
        Reverse::Outage => return None,
    };
    let ttl = if spot.is_some() {
        ps::FIND_ONLY_CACHE_TTL_S
    } else {
        ps::FIND_ONLY_MISS_TTL_S
    };
    store_slot(env, &key, spot.as_ref(), ttl).await;
    spot
}
