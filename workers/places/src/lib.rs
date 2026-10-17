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
//! GET /geo?lat=&lon=[&autoCreate=true]
//! GET /history?location=&days=1..365
//! GET /health
//! ```
//!
//! The Python backend read `places.placesGeo` in MongoDB. This Worker reads no
//! database for places: the seed locations are compiled in, a
//! `{name}--{geohash}` slug carries its own point, canonical places come from
//! the Nyuchi API, and geocoding from Open-Meteo and Nominatim
//! (`weather_core::locations`). `geo?autoCreate=true` names the point and
//! answers its `{name}--{geohash}` slug, which needs no record to resolve; it
//! does not write a canonical place (the Nyuchi API has no endpoint for that
//! yet). History is read from D1 `place_daily`, written by
//! `mukoko-weather-jobs`.

mod budget;
mod sources;

use serde_json::{json, Value};
use weather_core::budget::Action;
use weather_core::geo::valid_coordinates;
use weather_core::locations::{self, LocationDoc};
use weather_core::resolve::{self, Naming, PointAnswer, SpotKind};
use weather_edge::{error, json, now_ms, query_pairs};
use worker::{event, Context, Env, Method, Request, Response, Result};

const DB: &str = "WEATHER_DB";
const GEOCODE_LIMITER: &str = "GEOCODE_LIMITER";

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

/// A degraded answer (a budget, an outage, a failed lookup produced it) must
/// not be cached anywhere: the next call may well succeed.
fn uncached_json(body: &Value) -> Result<Response> {
    let resp = json(200, body)?;
    resp.headers().set("Cache-Control", "no-store")?;
    Ok(resp)
}

fn page<T: Clone>(items: &[T], skip: usize, limit: usize) -> Vec<T> {
    items.iter().skip(skip).take(limit).cloned().collect()
}

/// A location by slug: seed, then a `{name}--{geohash}` spot (named by an
/// earlier reverse geocode when there is one), then the Nyuchi API.
async fn find_location(env: &Env, slug: &str) -> std::result::Result<Option<LocationDoc>, ()> {
    if let Some(l) = locations::find_seed(slug) {
        return Ok(Some(l.clone()));
    }
    if let Some(spot) = LocationDoc::spot(slug) {
        let named = sources::reverse_cached(env, spot.lat, spot.lon)
            .await
            .flatten()
            .filter(|l| l.slug == slug);
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

/// Add `extra` locations whose slug is not already listed.
fn merge(into: &mut Vec<LocationDoc>, extra: Vec<LocationDoc>) {
    for l in extra {
        if !into.iter().any(|x| x.slug == l.slug) {
            into.push(l);
        }
    }
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

    if q.get("mode") == Some("tags") {
        return cached_json(&json!({"tags": locations::tag_counts()}), 3_600);
    }
    if q.get("mode") == Some("resolve") {
        return resolve_route(req, env, q).await;
    }

    // Nearest to a point: a discovery action, so a 100 km radius.
    if let (Some(lat), Some(lon)) = (q.num("lat"), q.num("lon")) {
        if !valid_coordinates(lat, lon) {
            return error(400, "invalid_request", "Invalid coordinates");
        }
        let mut found: Vec<LocationDoc> = locations::nearest_seeds(lat, lon, 100.0, limit)
            .into_iter()
            .cloned()
            .collect();
        if found.len() < limit {
            if let Ok(near) = sources::nyuchi_nearby(env, lat, lon, 100.0, limit).await {
                merge(&mut found, near);
            }
        }
        found.truncate(limit);
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
    let mut found: Vec<LocationDoc> = locations::search_seed(text.unwrap_or(""), tag)
        .into_iter()
        .cloned()
        .collect();
    let mut source = "places";
    let mut degraded = false;
    if let (Some(text), None) = (text, tag) {
        if found.len() < skip + limit {
            if let Ok(canonical) = sources::nyuchi_search(env, text, limit).await {
                merge(&mut found, canonical);
            }
        }
        // A thin catalogue answer is topped up from the geocoder, so nothing
        // a person types is a dead end: places first, then the best cities of
        // a country the query named, and last the area itself (a country,
        // province or continent) as a spot at its centre. A shipped city is
        // always its canonical slug, and nothing is listed twice.
        if skip == 0 && found.len() < resolve::TOP_UP_BELOW {
            let caller = budget::Caller::from_request(req);
            let count = resolve::geocode_count(limit);
            match sources::geocode(env, text, count, Action::Search, &caller).await {
                Ok(geocoded) => {
                    let catalogue_empty = found.is_empty();
                    found = resolve::compose_search(found, &geocoded, limit);
                    if found.iter().any(|l| l.source == "geocoded") {
                        source = if catalogue_empty { "geocoded" } else { "mixed" };
                    }
                }
                // Over budget: the catalogue answer stands (an empty one is
                // still an answer), and nothing downstream may cache it.
                Err(sources::GeoErr::Budget) => degraded = true,
                // A hard failure is an error only when there is nothing else
                // to show; otherwise the catalogue answer stands, uncached.
                Err(sources::GeoErr::Upstream) if found.is_empty() => {
                    return error(503, "search_unavailable", "Search unavailable");
                }
                Err(sources::GeoErr::Upstream) => degraded = true,
            }
        }
    }
    let results = page(&found, skip, limit);
    let total = results.len();
    let body = json!({"locations": results, "total": total, "source": source});
    if degraded {
        uncached_json(&body)
    } else {
        cached_json(&body, 300)
    }
}

/// `GET /search?q=<name>&mode=resolve`: the one best place for a bare name in
/// a URL (`/koh-samui`), for the app's proxy to redirect to as a spot slug.
///
/// Reuses the forward geocode behind `/search` (its KV cache and budgets);
/// stores nothing. Always 200: `resolve` is `ok`, `no_match`, `over_budget`
/// or `unavailable`, and only the first two are final.
async fn resolve_route(req: &Request, env: &Env, q: &Query) -> Result<Response> {
    let answer = |status: &str, found: Option<LocationDoc>| {
        let body = json!({
            "locations": found.iter().collect::<Vec<_>>(),
            "total": usize::from(found.is_some()),
            "source": if found.is_some() { "geocoded" } else { "none" },
            "resolve": status,
        });
        // Only a final answer may be cached downstream; over budget and
        // unavailable are `no-store`.
        if matches!(status, "ok" | "no_match") {
            cached_json(&body, 300)
        } else {
            uncached_json(&body)
        }
    };
    let Some(name) = q.get("q").and_then(resolve::bare_query) else {
        return answer("no_match", None);
    };
    let caller = budget::Caller::from_request(req);
    match sources::geocode(env, &name, 10, Action::Resolve, &caller).await {
        Ok(hits) => match resolve::pick_resolution(&hits, &name) {
            Some(place) => answer("ok", Some(place)),
            None => answer("no_match", None),
        },
        Err(sources::GeoErr::Budget) => answer("over_budget", None),
        Err(sources::GeoErr::Upstream) => answer("unavailable", None),
    }
}

/// A spot as `/geo` answers it: the document plus what a caller needs to
/// know. `elevationApproximate`: nothing measured the height. `named: false`
/// only for a DEFINITIVE "nothing here" (open water, polar ice, empty desert);
/// `namingSkipped: true` when naming was skipped (over budget, the geocoder
/// down, or the caller asked not to spend a lookup), which says nothing about
/// the point and must not be read as `named: false`.
fn spot_json(spot: &LocationDoc, kind: SpotKind) -> Value {
    let mut doc = serde_json::to_value(spot).unwrap_or(Value::Null);
    if let Some(obj) = doc.as_object_mut() {
        obj.insert("elevationApproximate".into(), true.into());
        match kind {
            SpotKind::Named => {}
            SpotKind::NothingHere => {
                obj.insert("named".into(), false.into());
            }
            SpotKind::NamingSkipped => {
                obj.insert("namingSkipped".into(), true.into());
            }
        }
    }
    doc
}

/// The `/geo` response for a [`PointAnswer`].
fn point_response(answer: PointAnswer) -> Result<Response> {
    let (nearest, is_new, synthesized, slug) = match answer {
        PointAnswer::Seed(loc) => (json!(loc), false, false, loc.slug),
        PointAnswer::Created(loc) => (json!(loc), true, false, loc.slug),
        PointAnswer::Spot { spot, kind } => {
            (spot_json(&spot, kind), false, true, spot.slug.clone())
        }
    };
    let mut body = json!({"nearest": nearest, "redirectTo": format!("/{slug}"), "isNew": is_new});
    if synthesized {
        body["synthesized"] = true.into();
    }
    json(200, &body)
}

/// Name a point for find-only: the cached ~1 km cell, else (when allowed and
/// within the hourly Nominatim budget) one city-level lookup. Anything that
/// is not a real answer is `Skipped`, never a claim about the point.
async fn name_cell(req: &Request, env: &Env, lat: f64, lon: f64, spend: bool) -> Naming {
    let (cell_lat, cell_lon) = (resolve::snap(lat), resolve::snap(lon));
    // A cached cell costs no budget, so it is read even when spending is off.
    if let Some(hit) = sources::reverse_cell_cached(env, cell_lat, cell_lon).await {
        return hit.map_or(Naming::NothingHere, Naming::Named);
    }
    if !spend || !nominatim_budget(req, env).await {
        return Naming::Skipped;
    }
    match sources::reverse_cell(env, cell_lat, cell_lon).await {
        Ok(Some(doc)) => Naming::Named(doc),
        Ok(None) => Naming::NothingHere,
        Err(()) => Naming::Skipped,
    }
}

/// May this call go to Nominatim? A per-minute burst limit per client, then
/// the hourly per-client and service-wide budgets (`weather_core::budget`;
/// Nominatim's policy is about one request a second for the whole app).
async fn nominatim_budget(req: &Request, env: &Env) -> bool {
    let caller = budget::Caller::from_request(req);
    if let Ok(limiter) = env.rate_limiter(GEOCODE_LIMITER) {
        if let Ok(outcome) = limiter.limit(caller.ip.clone()).await {
            if !outcome.success {
                return false;
            }
        }
    }
    budget::take(env, Action::Nominatim, &caller)
        .await
        .allowed()
}

/// A skipped or failed naming is a flag, not a verdict: the answer is never
/// cached publicly, because the next call may name the point.
fn no_store(resp: Result<Response>, degraded: bool) -> Result<Response> {
    let resp = resp?;
    if degraded {
        resp.headers().set("Cache-Control", "no-store")?;
    }
    Ok(resp)
}

async fn geo_route(req: &Request, env: &Env, q: &Query) -> Result<Response> {
    let (Some(lat), Some(lon)) = (q.num("lat"), q.num("lon")) else {
        return error(422, "invalid_request", "Give both `lat` and `lon`.");
    };
    if !valid_coordinates(lat, lon) {
        return error(400, "invalid_request", "Invalid coordinates");
    }
    let auto_create = matches!(q.get("autoCreate"), Some("true" | "1"));
    // A server-side caller (the home page's IP lookup) shares one egress
    // address with every visitor, so it asks not to spend a lookup: a seed or
    // a coordinate spot, and the caller names an IP position from its own
    // headers.
    let spend = !matches!(q.get("noName"), Some("true" | "1"));

    let answer = if auto_create {
        // "Use my location" resolves to the exact place, never the nearest
        // city. A failure to name it is `Skipped`, which returns a seed within
        // 50 km, else a spot flagged `namingSkipped`.
        let cached = sources::reverse_cached(env, lat, lon).await;
        let naming = if let Some(hit) = cached {
            // A cached answer costs no budget.
            hit.map_or(Naming::NothingHere, Naming::Named)
        } else if !spend || !nominatim_budget(req, env).await {
            Naming::Skipped
        } else {
            match sources::reverse(env, lat, lon).await {
                Ok(Some(l)) => Naming::Named(l),
                Ok(None) => Naming::NothingHere,
                Err(()) => Naming::Skipped,
            }
        };
        resolve::create_answer(lat, lon, &naming)
    } else {
        // A seed within 150 km wins without any lookup; only past that is the
        // point named (its cell, cached and budgeted).
        let naming = if locations::nearest_seeds(lat, lon, 150.0, 1).is_empty() {
            name_cell(req, env, lat, lon, spend).await
        } else {
            Naming::Skipped
        };
        resolve::find_only_answer(lat, lon, &naming)
    };
    match answer {
        Some(answer) => {
            let degraded = matches!(
                answer,
                PointAnswer::Spot {
                    kind: SpotKind::NamingSkipped,
                    ..
                }
            );
            no_store(point_response(answer), degraded)
        }
        None => error(400, "invalid_request", "Invalid coordinates"),
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
