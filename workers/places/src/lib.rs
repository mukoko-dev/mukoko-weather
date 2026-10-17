//! `mukoko-weather-places`: locations and their weather history.
//!
//! Ported from `api/py/_locations.py` (`/api/py/locations`, `/search`, `/geo`)
//! and `api/py/_history.py` (`/api/py/history`), with the same parameters and
//! response shapes. No route and no workers.dev address: `mukoko-weather-api`
//! reaches it through the `PLACES` service binding and serves it as
//! `/v1/locations`, `/v1/search`, `/v1/geo` and `/v1/history`.
//!
//! ```text
//! GET /locations?slug= | tag= | country= | mode=tags|stats  [&limit=1..200&skip=]
//! GET /search?q= | tag= | lat=&lon= | mode=tags              [&limit=1..50&skip=]
//! GET /search?q=<name>&mode=resolve                          one best place for a URL (always 200)
//! GET /geo?lat=&lon=[&autoCreate=true]
//! GET /history?location=&days=1..365
//! GET /health
//! ```
//!
//! The Python backend read `places.placesGeo` in MongoDB. This Worker reads no
//! database for places: the seed locations are compiled in, a
//! `{name}--{geohash}` slug carries its own point, community places come from
//! the Nyuchi API, and geocoding from Open-Meteo and Nominatim. The Nyuchi API
//! does not expose `placesGeo` yet (mukoko-weather#148, platform ask 1), so a
//! seed in the countries the platform geography covers stands for "stored" in
//! the find-only lookup (`weather_core::place_search`). The decisions
//! (area filter, top-up, resolve, find-only order) are pure and pinned to
//! `tests/fixtures/places-contract.json`, shared with the Python tests.
//!
//! No route needs a sign-in: places are public reads, limited per client IP
//! (the hourly budgets are in D1 `rate_events`, the per-minute reverse
//! geocode limit is the `GEOCODE_LIMITER` binding). `geo?autoCreate=true`
//! names the point and answers its `{name}--{geohash}` slug, but writes no
//! canonical place (the Nyuchi API has no endpoint for that yet). History is
//! read from D1 `place_daily`, which `mukoko-weather-jobs` writes.

mod limits;
mod sources;

use serde_json::{json, Value};
use weather_core::geo::valid_coordinates;
use weather_core::locations::{self, LocationDoc};
use weather_core::place_search::{self as ps, ResolveStatus};
use weather_edge::{error, json, now_ms, query_pairs};
use worker::{event, Context, Env, Method, Request, Response, Result};

const DB: &str = "WEATHER_DB";
const GEOCODE_LIMITER: &str = "GEOCODE_LIMITER";
/// Set by mukoko-weather-api to the caller's IP, for the budgets.
const CLIENT_IP_HEADER: &str = "X-Mukoko-Client-IP";
/// Location creations an hour per client (`location-create`).
const CREATE_PER_IP: u32 = 5;

struct Query(Vec<(String, String)>);

impl Query {
    fn get(&self, k: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.trim())
            .filter(|v| !v.is_empty())
    }
    fn int(&self, k: &str, default: i64) -> std::result::Result<i64, ()> {
        self.get(k)
            .map_or(Ok(default), |v| v.parse().map_err(|_| ()))
    }
    fn num(&self, k: &str) -> Option<f64> {
        self.get(k)?.parse::<f64>().ok().filter(|x| x.is_finite())
    }
}

fn client_ip(req: &Request) -> String {
    req.headers()
        .get(CLIENT_IP_HEADER)
        .ok()
        .flatten()
        .or_else(|| req.headers().get("CF-Connecting-IP").ok().flatten())
        .unwrap_or_else(|| "unknown".into())
}

#[event(fetch)]
pub async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    if req.method() != Method::Get {
        return error(405, "method_not_allowed", "Only GET is served.");
    }
    let q = Query(query_pairs(&req)?);
    match req.path().as_str() {
        "/health" => json(
            200,
            &json!({"service": "mukoko-weather-places", "status": "ok"}),
        ),
        "/locations" => locations_route(&env, &q).await,
        "/search" => search_route(&req, &env, &q).await,
        "/geo" => geo_route(&req, &env, &q).await,
        "/history" => history_route(&env, &q).await,
        _ => error(404, "not_found", "No such route."),
    }
}

fn cached_json(body: &Value, max_age: u32) -> Result<Response> {
    let resp = json(200, body)?;
    resp.headers()
        .set("Cache-Control", &format!("public, max-age={max_age}"))?;
    Ok(resp)
}

fn page<T: Clone>(items: &[T], skip: usize, limit: usize) -> Vec<T> {
    items.iter().skip(skip).take(limit).cloned().collect()
}

/// A location by slug: seed, then a `{name}--{geohash}` spot (named by an
/// earlier reverse geocode when there is one), then the Nyuchi API. A spot
/// is a coordinate, not a stored place, and says so (`synthesized`).
async fn find_location(env: &Env, slug: &str) -> std::result::Result<Option<LocationDoc>, ()> {
    if let Some(l) = locations::find_seed(slug) {
        return Ok(Some(l.clone()));
    }
    if let Some(spot) = LocationDoc::spot(slug) {
        let named = sources::reverse_cached(env, spot.lat, spot.lon)
            .await
            .filter(|l| l.slug == slug)
            .map(|mut l| {
                l.synthesized = Some(true);
                l
            });
        return Ok(Some(named.unwrap_or(spot)));
    }
    sources::nyuchi_place(env, slug).await
}

async fn locations_route(env: &Env, q: &Query) -> Result<Response> {
    let (Ok(limit), Ok(skip)) = (q.int("limit", 50), q.int("skip", 0)) else {
        return error(
            422,
            "invalid_request",
            "`limit` and `skip` must be integers.",
        );
    };
    let limit = limit.clamp(1, 200) as usize;
    let skip = skip.max(0) as usize;

    if let Some(slug) = q.get("slug") {
        return match find_location(env, slug).await {
            Ok(Some(loc)) => cached_json(&json!({"location": loc}), 300),
            Ok(None) => error(404, "not_found", "Location not found"),
            Err(()) => error(503, "places_unavailable", "Location data unavailable"),
        };
    }
    match q.get("mode") {
        Some("tags") => return cached_json(&json!({"tags": locations::tag_counts()}), 3_600),
        Some("stats") => return cached_json(&locations::stats(), 3_600),
        _ => {}
    }
    let all: Vec<&LocationDoc> = if let Some(country) = q.get("country") {
        locations::seed_in_country(country)
    } else if let Some(tag) = q.get("tag") {
        locations::search_seed("", Some(tag))
    } else {
        locations::seed_locations().iter().collect()
    };
    cached_json(
        &json!({
            "locations": page(&all, skip, limit),
            "total": all.len(),
            "limit": limit,
            "skip": skip,
        }),
        300,
    )
}

/// `GET /search?q=<name>&mode=resolve`: the one best place for a bare name in
/// a URL (mukoko-weather#318). Always 200; `resolve` is `ok`, `no_match`,
/// `over_budget` or `unavailable`. Only `ok` and `no_match` are cached.
/// Nothing is stored.
async fn resolve_route(req: &Request, env: &Env, q: &Query) -> Result<Response> {
    let Some(raw) = q.get("q") else {
        return error(400, "invalid_request", "Provide q (the place name)");
    };
    let answer = |status: ResolveStatus, found: Option<LocationDoc>| {
        let source = if found.is_some() { "geocoded" } else { "none" };
        let body = json!({
            "locations": found.iter().collect::<Vec<_>>(),
            "total": usize::from(found.is_some()),
            "source": source,
            "resolve": status.as_str(),
        });
        // A definitive answer may be cached by the edge for a short while;
        // a budget or availability answer must not be pinned.
        match status {
            ResolveStatus::Ok | ResolveStatus::NoMatch => cached_json(&body, 600),
            _ => json(200, &body),
        }
    };
    let Some(name) = ps::resolve_name(raw) else {
        return answer(ResolveStatus::NoMatch, None);
    };
    if let Some(hit) = sources::resolve_cached(env, &name).await {
        let status = if hit.is_some() {
            ResolveStatus::Ok
        } else {
            ResolveStatus::NoMatch
        };
        return answer(status, hit);
    }
    if !sources::open_meteo_allowed() {
        return answer(ResolveStatus::Unavailable, None);
    }
    let ip = client_ip(req);
    if !limits::within(env, &ip, "slug-geocode", ps::RESOLVE_PER_IP).await
        || !limits::within(env, "all", "slug-geocode-global", ps::RESOLVE_GLOBAL).await
    {
        return answer(ResolveStatus::OverBudget, None);
    }
    // The resolve budgets above replace the search top-up budget.
    let Ok(hits) = sources::geocode_hits(env, &name, ps::RESOLVE_GEOCODE_COUNT, None).await else {
        return answer(ResolveStatus::Unavailable, None);
    };
    let found = ps::pick_resolve(&name, &hits);
    sources::resolve_store(env, &name, found.as_ref()).await;
    let status = if found.is_some() {
        ResolveStatus::Ok
    } else {
        ResolveStatus::NoMatch
    };
    answer(status, found)
}

async fn search_route(req: &Request, env: &Env, q: &Query) -> Result<Response> {
    let (Ok(limit), Ok(skip)) = (q.int("limit", 20), q.int("skip", 0)) else {
        return error(
            422,
            "invalid_request",
            "`limit` and `skip` must be integers.",
        );
    };
    let limit = limit.clamp(1, 50) as usize;
    let skip = skip.max(0) as usize;

    if q.get("q")
        .is_some_and(|t| t.chars().count() > ps::MAX_SEARCH_QUERY_LENGTH)
    {
        return error(
            400,
            "invalid_request",
            &format!(
                "q too long (max {} characters)",
                ps::MAX_SEARCH_QUERY_LENGTH
            ),
        );
    }
    if q.get("mode") == Some("resolve") {
        return resolve_route(req, env, q).await;
    }
    if q.get("mode") == Some("tags") {
        return cached_json(&json!({"tags": locations::tag_counts()}), 3_600);
    }

    // Nearest to a point: a discovery action, so a 100 km radius.
    if let (Some(lat), Some(lon)) = (q.num("lat"), q.num("lon")) {
        if !valid_coordinates(lat, lon) {
            return error(400, "invalid_request", "Invalid coordinates");
        }
        let found: Vec<LocationDoc> = locations::nearest_seeds(lat, lon, 100.0, limit)
            .into_iter()
            .cloned()
            .collect();
        let total = found.len();
        return cached_json(
            &json!({"locations": found, "total": total, "source": "places"}),
            300,
        );
    }

    let text = q.get("q");
    let tag = q.get("tag");
    if text.is_none() && tag.is_none() {
        return error(
            400,
            "invalid_request",
            "Provide q (search query) or tag (filter)",
        );
    }
    let found: Vec<LocationDoc> = locations::search_seed(text.unwrap_or(""), tag)
        .into_iter()
        .cloned()
        .collect();
    let mut results = page(&found, skip, limit);
    let mut source = "places";
    // A thin catalogue answer is topped up with geocoded candidates: the
    // places of a named country, then each non-area hit (a seed where one
    // matches, else a spot slug that renders without a record).
    if let (Some(text), None) = (text, tag) {
        if skip == 0 && results.len() < ps::GEOCODE_TOP_UP_BELOW && sources::open_meteo_allowed() {
            let ip = client_ip(req);
            let hits = sources::geocode_hits(env, text, ps::geocode_fetch_count(limit), Some(&ip))
                .await
                .unwrap_or_default();
            let (extra, top_source) = ps::top_up(&results, &hits, limit);
            source = top_source;
            results.extend(extra);
        }
    }
    let total = results.len();
    cached_json(
        &json!({"locations": results, "total": total, "source": source}),
        300,
    )
}

async fn geo_route(req: &Request, env: &Env, q: &Query) -> Result<Response> {
    let (Some(lat), Some(lon)) = (q.num("lat"), q.num("lon")) else {
        return error(422, "invalid_request", "Give both `lat` and `lon`.");
    };
    if !valid_coordinates(lat, lon) {
        return error(400, "invalid_request", "Invalid coordinates");
    }
    let auto_create = matches!(q.get("autoCreate"), Some("true" | "1"));

    let found = |loc: &LocationDoc, is_new: bool, synthesized: bool| {
        let mut body =
            json!({"nearest": loc, "redirectTo": format!("/{}", loc.slug), "isNew": is_new});
        if synthesized {
            body["synthesized"] = json!(true);
        }
        json(200, &body)
    };

    if !auto_create {
        // Nothing is created. A stored place within 150 km answers (IP
        // points can be off by a couple of hundred km), else a shipped seed
        // city within 50 km, else the point is named on demand as a spot.
        if let Some(loc) = ps::find_only_known(lat, lon) {
            return found(&loc, false, false);
        }
        return match sources::find_only_spot(env, lat, lon, &client_ip(req)).await {
            Some(spot) => found(&spot, false, true),
            None => error(
                404,
                "not_found",
                "No nearby location found. Use autoCreate=true to add one.",
            ),
        };
    }

    // "Use my location" resolves to the exact place, never the nearest city.
    let ip = client_ip(req);
    if let Ok(limiter) = env.rate_limiter(GEOCODE_LIMITER) {
        if let Ok(outcome) = limiter.limit(ip.clone()).await {
            if !outcome.success {
                return error(429, "rate_limited", "Rate limit exceeded. Try again later.");
            }
        }
    }
    if !limits::within(env, &ip, "location-create", CREATE_PER_IP).await {
        return error(429, "rate_limited", "Rate limit exceeded. Try again later.");
    }
    let named = match sources::reverse(env, lat, lon).await {
        Ok(Some(l)) => l,
        Ok(None) => return error(422, "unnamed", "Could not determine location name"),
        Err(()) => return error(503, "geocoding_unavailable", "Location service unavailable"),
    };
    // The same place already on the seed list (1 km, same name) is not new.
    let existing = locations::nearest_seeds(lat, lon, 1.0, 1)
        .into_iter()
        .find(|s| s.name.eq_ignore_ascii_case(&named.name));
    match existing {
        Some(seed) => found(seed, false, false),
        None => found(&named, true, false),
    }
}

async fn history_route(env: &Env, q: &Query) -> Result<Response> {
    let Some(location) = q.get("location") else {
        return error(400, "invalid_request", "Missing location parameter");
    };
    let days = match q.int("days", 30) {
        Ok(d) if (1..=365).contains(&d) => d,
        _ => return error(400, "invalid_request", "days must be between 1 and 365"),
    };
    let slug = match find_location(env, location).await {
        Ok(Some(loc)) => loc.slug,
        Ok(None) => return error(404, "not_found", "Unknown location"),
        Err(()) => return error(503, "places_unavailable", "Location service unavailable"),
    };

    let since = now_ms().saturating_sub(days as u64 * 86_400_000) as f64;
    let rows = async {
        env.d1(DB)?
            .prepare(
                "SELECT slug, recorded_at, current, daily, insights FROM place_daily \
                 WHERE slug = ?1 AND recorded_at >= ?2 ORDER BY recorded_at DESC LIMIT 400",
            )
            .bind(&[slug.as_str().into(), since.into()])?
            .all()
            .await?
            .results::<Value>()
    }
    .await;
    let Ok(rows) = rows else {
        return error(
            502,
            "history_unavailable",
            "Failed to fetch weather history",
        );
    };
    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            let s = |k: &str| r.get(k).and_then(Value::as_str);
            locations::history_record(
                &slug,
                r.get("recorded_at").and_then(Value::as_f64).unwrap_or(0.0) as i64,
                s("current"),
                s("daily"),
                s("insights"),
            )
        })
        .collect();
    cached_json(
        &json!({"location": slug, "days": days, "records": data.len(), "data": data}),
        600,
    )
}
