//! `GET /profile?slug=<slug> | lat=&lon=[&country=]`: a place's knowledge and
//! its current context (ported from `api/py/_place_knowledge.py`, endpoint
//! `/api/py/locations/profile`).
//!
//! The logic is `weather_core::place_profile`, pinned to the Python. This is
//! the I/O around it:
//!
//! - the place: a catalogue slug, a `{name}--{geohash}` spot (matched to a
//!   catalogue place within 3 km), a canonical place from the Nyuchi API, or a
//!   bare coordinate;
//! - the cell's monthly normals (ERA5 1991–2020, one archive request per
//!   0.25° cell, behind the Open-Meteo breaker) and the soil (SoilGrids, behind
//!   its own breaker), both kept in KV;
//! - the country's season calendar: MongoDB `weather.seasons` when the Worker
//!   can read it (it may hold AI-made rows), else the compiled seed;
//! - ENSO from the `enso:v1` KV entry the `/enso` route keeps (absent until
//!   something has asked for it, as the Python's was until its first warm).
//!
//! Nothing is stored: the Mongo client is read-only and `places.placeKnowledge`
//! does not exist yet, so a profile is built on every read from the cached
//! normals and soil, exactly as the Python did while the collection was
//! missing. A request that needs an upstream spends an hourly budget (120 per
//! client, 600 service-wide); one answered from the caches is free.

use std::cell::{Cell, RefCell};
use std::time::Duration;

use serde_json::{json, Value};
use weather_core::breaker::{self, Breaker};
use weather_core::budget::Action;
use weather_core::cache::Slot;
use weather_core::climate_normals as nm;
use weather_core::place_profile as pp;
use weather_edge::{error, get_with_timeout, json, now, now_ms, query_pairs};
use weather_mongo::conn::FindOptions;
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::{Context, Env, Request, Response, Result};

use crate::chain::{self, CACHE_BINDING};
use crate::limit;
use crate::places::{self, Resolved};

/// The one-off 30-year build: longer than the usual provider budget.
const ARCHIVE_TIMEOUT: Duration = Duration::from_secs(20);
const SOIL_TIMEOUT: Duration = Duration::from_secs(10);
/// Normals do not change: kept for the period's life, refreshed yearly.
const NORMALS_TTL_SECONDS: u64 = 400 * 24 * 3_600;
/// Soil does not change on a human timescale.
const SOIL_TTL_SECONDS: u64 = 30 * 24 * 3_600;
/// After a MongoDB failure, skip it for this long.
const MONGO_BACKOFF_MS: u64 = 60_000;

thread_local! {
    static SOILGRIDS: RefCell<Breaker> = const { RefCell::new(Breaker::new(breaker::SOILGRIDS)) };
    static MONGO_DOWN_UNTIL: Cell<u64> = const { Cell::new(0) };
}

fn normals_key(lat: f64, lon: f64) -> String {
    format!(
        "nrm:v1:{}",
        nm::cache_key(nm::snap_to_grid(lat), nm::snap_to_grid(lon))
    )
}

fn soil_key(lat: f64, lon: f64) -> String {
    format!("soil:v1:{:.2}_{:.2}", pp_round2(lat), pp_round2(lon))
}

fn pp_round2(v: f64) -> f64 {
    let r = nm::round_to(v, 2);
    if r == 0.0 {
        0.0
    } else {
        r
    }
}

// ---------------------------------------------------------------------------
// MongoDB (read-only, optional)
// ---------------------------------------------------------------------------

async fn mongo(env: &Env) -> Option<weather_mongo::edge::Mongo> {
    if MONGO_DOWN_UNTIL.with(|d| d.get()) > now_ms() {
        return None;
    }
    weather_edge::mongo(env).await
}

fn mongo_failed() {
    MONGO_DOWN_UNTIL.with(|d| d.set(now_ms() + MONGO_BACKOFF_MS));
}

/// The country's season rows from `weather.seasons`, when MongoDB answers
/// with some; `None` falls back to the compiled seed.
async fn mongo_season_rows(env: &Env, country: &str) -> Option<Vec<pp::SeasonRow>> {
    let m = mongo(env).await?;
    let opts = FindOptions {
        filter: json!({"countryCode": country}),
        projection: Some(json!({"_id": 0})),
        ..FindOptions::default()
    };
    match m.find("weather", "seasons", &opts).await {
        Ok(rows) => {
            let rows: Vec<pp::SeasonRow> = rows
                .into_iter()
                .filter_map(|r| serde_json::from_value(r).ok())
                .collect();
            (!rows.is_empty()).then_some(rows)
        }
        Err(_) => {
            mongo_failed();
            None
        }
    }
}

/// A stored neighbour in the same region cell, for a bare spot.
async fn mongo_neighbour(env: &Env, region_cell: &str) -> Option<Value> {
    let m = mongo(env).await?;
    match m
        .find_one(
            "places",
            "placeKnowledge",
            json!({"regionCell": region_cell, "climate": {"$ne": Value::Null}}),
        )
        .await
    {
        Ok(doc) => doc,
        Err(_) => {
            mongo_failed();
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Upstreams
// ---------------------------------------------------------------------------

async fn fetch_normals(lat: f64, lon: f64) -> Option<pp::NormalsBundle> {
    if !chain::open_meteo_allowed() {
        return None;
    }
    let (glat, glon) = (nm::snap_to_grid(lat), nm::snap_to_grid(lon));
    let parsed = match get_with_timeout(&nm::archive_url(glat, glon), None, ARCHIVE_TIMEOUT).await {
        Ok(mut resp) if resp.status_code() == 200 => resp
            .json::<Value>()
            .await
            .ok()
            .and_then(|data| nm::parse_archive(&data)),
        _ => None,
    };
    chain::record_open_meteo(parsed.is_some());
    let (daily, meta) = parsed?;
    Some(pp::NormalsBundle {
        cell: Some(nm::cache_key(glat, glon)),
        period: nm::NORMALS_PERIOD.to_owned(),
        source: nm::NORMALS_SOURCE.to_owned(),
        monthly: nm::compute_monthly_normals(&daily),
        time_zone: meta.timezone,
        utc_offset_seconds: meta.utc_offset_seconds,
        elevation: meta.elevation,
    })
}

fn soilgrids_allowed() -> bool {
    SOILGRIDS.with(|b| b.borrow_mut().allow(now_ms()))
}

fn soilgrids_record(ok: bool) {
    SOILGRIDS.with(|b| {
        let mut b = b.borrow_mut();
        if ok {
            b.record_success();
        } else {
            b.record_failure(now_ms());
        }
    });
}

enum SoilFetch {
    Json(Value),
    /// Our request, or no data for this point: a definitive "nothing here".
    NoData,
    Failed,
}

async fn soil_get(url: &str) -> SoilFetch {
    match get_with_timeout(url, None, SOIL_TIMEOUT).await {
        Ok(mut r) => match r.status_code() {
            200 => match r.json::<Value>().await {
                Ok(v) => SoilFetch::Json(v),
                Err(_) => SoilFetch::Failed,
            },
            // A 4xx other than 429 is our request or no data for the point:
            // not the service's fault, so it never opens the breaker.
            s if (400..500).contains(&s) && s != 429 => SoilFetch::NoData,
            _ => SoilFetch::Failed,
        },
        Err(_) => SoilFetch::Failed,
    }
}

/// `(soil, answered)`: `answered` is true for a definitive answer, including
/// "no data here" (so the caller waits before asking again); a failure is
/// `(None, false)`.
async fn fetch_soil(lat: f64, lon: f64) -> (Option<pp::Soil>, bool) {
    if !soilgrids_allowed() {
        return (None, false);
    }
    let class = match soil_get(&pp::soil_classification_url(lat, lon)).await {
        SoilFetch::Json(v) => v,
        SoilFetch::NoData => {
            soilgrids_record(true);
            return (None, true);
        }
        SoilFetch::Failed => {
            soilgrids_record(false);
            return (None, false);
        }
    };
    let props = match soil_get(&pp::soil_properties_url(lat, lon)).await {
        SoilFetch::Json(v) => v,
        SoilFetch::NoData => {
            soilgrids_record(true);
            return (None, true);
        }
        SoilFetch::Failed => {
            soilgrids_record(false);
            return (None, false);
        }
    };
    soilgrids_record(true);
    // A payload we cannot parse is an anomaly, not an answer: retried
    // tomorrow rather than waiting a year.
    match pp::parse_soil(&class, &props) {
        Ok(soil) => (soil, true),
        Err(_) => (None, false),
    }
}

// ---------------------------------------------------------------------------
// The caches
// ---------------------------------------------------------------------------

async fn cached<T: serde::de::DeserializeOwned>(env: &Env, key: &str) -> Option<T> {
    env.kv(CACHE_BINDING)
        .ok()?
        .get(key)
        .json::<T>()
        .await
        .ok()
        .flatten()
}

fn store(env: &Env, ctx: &Context, key: String, body: String, ttl: u64) {
    if let Ok(kv) = env.kv(CACHE_BINDING) {
        ctx.wait_until(async move {
            if let Ok(put) = kv.put(&key, body) {
                let _ = put.expiration_ttl(ttl).execute().await;
            }
        });
    }
}

/// ENSO from the `/enso` route's KV entry (`available`, `phase`, `strength`,
/// `oni`, `season`, `year`), or `None` while it is cold.
async fn enso_now(env: &Env) -> Option<pp::EnsoNow> {
    let v: Value = cached(env, "enso:v1").await?;
    if v["available"] != Value::Bool(true) {
        return None;
    }
    let phase = v["phase"].as_str()?;
    let season = match (v["season"].as_str(), v["year"].as_i64()) {
        (Some(s), Some(y)) => Some(format!("{s} {y}")),
        _ => None,
    };
    Some(pp::EnsoNow::new(
        phase,
        v["strength"].as_str(),
        v["oni"].as_f64(),
        season.as_deref(),
    ))
}

/// The zone's UTC offset at an instant, from the runtime's `Intl` (which
/// knows the IANA database and its daylight saving rules).
fn zone_offset_seconds(zone: &str, when_ms: f64) -> Option<i64> {
    use js_sys::{Array, Function, Object, Reflect};
    let global = js_sys::global();
    let intl = Reflect::get(&global, &"Intl".into()).ok()?;
    let ctor: Function = Reflect::get(&intl, &"DateTimeFormat".into())
        .ok()?
        .dyn_into()
        .ok()?;
    let opts = Object::new();
    Reflect::set(&opts, &"timeZone".into(), &zone.into()).ok()?;
    Reflect::set(&opts, &"timeZoneName".into(), &"longOffset".into()).ok()?;
    // An unknown zone throws a RangeError: `construct` catches it.
    let fmt = Reflect::construct(&ctor, &Array::of2(&"en-US".into(), &opts)).ok()?;
    let to_parts: Function = Reflect::get(&fmt, &"formatToParts".into())
        .ok()?
        .dyn_into()
        .ok()?;
    let date = js_sys::Date::new(&JsValue::from_f64(when_ms));
    let parts: Array = to_parts.call1(&fmt, &date).ok()?.dyn_into().ok()?;
    parts.iter().find_map(|part| {
        let kind = Reflect::get(&part, &"type".into()).ok()?.as_string()?;
        if kind != "timeZoneName" {
            return None;
        }
        pp::parse_offset_label(&Reflect::get(&part, &"value".into()).ok()?.as_string()?)
    })
}

// ---------------------------------------------------------------------------
// The place
// ---------------------------------------------------------------------------

async fn resolve_place(
    env: &Env,
    slug: Option<&str>,
    lat: Option<f64>,
    lon: Option<f64>,
    country: Option<&str>,
) -> Option<pp::PlaceIn> {
    let (mut lat, mut lon, mut name) = (lat, lon, None);
    if let Some(slug) = slug.filter(|s| pp::valid_slug(s)) {
        match pp::from_slug(slug) {
            pp::FromSlug::Place(mut p) => {
                pp::apply_country_hint(&mut p, country, Some(slug));
                return Some(*p);
            }
            pp::FromSlug::Spot {
                name: n,
                lat: slat,
                lon: slon,
            } => {
                // A spot slug with no record is a coordinate: it falls through
                // to the nearest-place path with its own point and name.
                if lat.is_none() || lon.is_none() {
                    (lat, lon) = (Some(slat), Some(slon));
                }
                name = n;
            }
            pp::FromSlug::Unknown => {
                if let Resolved::Found(p) = places::resolve(env, slug).await {
                    let mut place = pp::PlaceIn {
                        id: Some(format!("place:{}", p.slug)),
                        collection: Some("places".to_owned()),
                        slug: Some(slug.to_owned()),
                        name: p.name.clone(),
                        lat: p.lat,
                        lon: p.lon,
                        country: p.country.clone().filter(|c| !c.is_empty()),
                        admin1: None,
                        elevation: p.elevation.filter(|e| *e != 0.0),
                        country_hint: false,
                    };
                    pp::apply_country_hint(&mut place, country, Some(slug));
                    return Some(place);
                }
            }
        }
    }
    let (lat, lon) = (lat?, lon?);
    let mut place = pp::place_near(lat, lon, slug, name);
    pp::apply_country_hint(&mut place, country, slug);
    Some(place)
}

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

pub async fn profile(req: &Request, env: &Env, ctx: &Context) -> Result<Response> {
    let pairs = query_pairs(req)?;
    let get = |k: &str| pairs.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
    let slug = get("slug").filter(|s| !s.is_empty());
    if let Some(s) = slug {
        if s.len() > 120 {
            return error(422, "invalid_request", "`slug` is too long.");
        }
        if !pp::valid_slug(s) {
            return error(400, "invalid_request", "Invalid slug");
        }
    }
    let coord = |k: &str, lo: f64, hi: f64| -> std::result::Result<Option<f64>, ()> {
        match get(k) {
            None => Ok(None),
            Some(v) => match v.trim().parse::<f64>() {
                Ok(f) if f.is_finite() && (lo..=hi).contains(&f) => Ok(Some(f)),
                _ => Err(()),
            },
        }
    };
    let (Ok(lat), Ok(lon)) = (coord("lat", -90.0, 90.0), coord("lon", -180.0, 180.0)) else {
        return error(422, "invalid_request", "Invalid coordinates.");
    };
    let country = match get("country") {
        None => None,
        Some(c) if c.len() == 2 && c.chars().all(|ch| ch.is_ascii_alphabetic()) => {
            Some(c.to_uppercase())
        }
        Some(_) => return error(422, "invalid_request", "`country` must be two letters."),
    };
    if slug.is_none() && (lat.is_none() || lon.is_none()) {
        return error(400, "invalid_request", "Provide slug, or lat and lon");
    }

    let Some(place) = resolve_place(env, slug, lat, lon, country.as_deref()).await else {
        return error(404, "not_found", "Location not found");
    };

    // What the caches hold, then what is missing.
    let nkey = normals_key(place.lat, place.lon);
    let mut normals: Option<pp::NormalsBundle> = cached(env, &nkey).await;
    let skey = soil_key(place.lat, place.lon);
    let mut soil: Option<(Option<pp::Soil>, bool)> = if place.id.is_some() {
        cached::<Slot<pp::Soil>>(env, &skey)
            .await
            .map(|slot| (slot.found, true))
    } else {
        Some((None, false))
    };

    // A request that would start a build is rate limited; one answered from
    // the caches is not.
    if normals.is_none() || soil.is_none() {
        let caller = limit::caller_key(req);
        if !limit::take(env, Action::PlaceProfile, &caller)
            .await
            .allowed()
        {
            return error(429, "rate_limited", "Rate limit exceeded. Try again later.");
        }
    }
    if normals.is_none() {
        normals = fetch_normals(place.lat, place.lon).await;
        if let Some(n) = &normals {
            if let Ok(text) = serde_json::to_string(n) {
                store(env, ctx, nkey, text, NORMALS_TTL_SECONDS);
            }
        }
    }
    let soil = match soil.take() {
        Some(s) => s,
        None => {
            let fetched = fetch_soil(place.lat, place.lon).await;
            if fetched.1 {
                if let Ok(text) = serde_json::to_string(&Slot::new(fetched.0.clone())) {
                    store(env, ctx, skey, text, SOIL_TTL_SECONDS);
                }
            }
            fetched
        }
    };

    let profile = assemble(env, place, normals.as_ref(), soil).await;
    json(200, &profile)
}

/// The profile built from what is already known: seasons (MongoDB rows or the
/// compiled seed), the neighbour's climate for a bare spot, the zone offset
/// and ENSO. No upstream call and no budget.
async fn assemble(
    env: &Env,
    place: pp::PlaceIn,
    normals: Option<&pp::NormalsBundle>,
    soil: (Option<pp::Soil>, bool),
) -> pp::LocationProfile {
    // The country's calendar: MongoDB's rows (seed and AI-made) when it
    // answers, else the compiled seed.
    let seasons = match place.country.as_deref() {
        Some(iso) => {
            let rows = match mongo_season_rows(env, iso).await {
                Some(rows) => rows,
                None => pp::seed_season_rows(iso),
            };
            pp::seasons_from_rows(&rows)
        }
        None => None,
    };

    let when = now();
    let mut doc = pp::build_knowledge(&place, normals, seasons, soil, when);
    if place.id.is_none() && doc.climate.is_none() {
        if let Some(neighbour) = mongo_neighbour(env, &doc.region_cell).await {
            pp::merge_neighbour(&mut doc, &neighbour);
        }
    }
    let mut profile = pp::to_profile(&doc, &place, false, when);
    let zone = profile
        .time_zone
        .as_deref()
        .and_then(|z| zone_offset_seconds(z, when.timestamp_millis() as f64));
    let offset = pp::utc_offset_seconds(zone, doc.utc_offset_seconds, profile.lon);
    let enso = enso_now(env).await;
    profile.current = Some(pp::compute_current(&profile, when, offset, enso));
    pp::apply_consumer_view(&mut profile);
    profile
}

/// The profile the agriculture route grounds its advice in, as the flat
/// consumer view (`season`, `crops`, `normals`, `koppen`, `enso`). Cache-only,
/// as the Python `get_location_profile(allow_build=False)` was: the cell's
/// normals when KV already holds them, no soil, no upstream call, no budget.
/// `None` when no place can be resolved.
pub async fn cached_profile(
    env: &Env,
    slug: Option<&str>,
    lat: f64,
    lon: f64,
    country: Option<&str>,
) -> Option<Value> {
    let place = resolve_place(env, slug, Some(lat), Some(lon), country).await?;
    let normals: Option<pp::NormalsBundle> = cached(env, &normals_key(place.lat, place.lon)).await;
    let profile = assemble(env, place, normals.as_ref(), (None, false)).await;
    serde_json::to_value(&profile).ok()
}
