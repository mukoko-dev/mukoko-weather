//! `mukoko-weather-aviation`: aviation weather.
//!
//! Ported from `api/py/_metar.py` and `api/py/_airports.py`. It has no route
//! and no workers.dev address: `mukoko-weather-api` reaches it through the
//! `AVIATION` service binding.
//!
//! ```text
//! GET /metar?icao=FVRG       METARs of the last 12 h and the TAF:
//!                            {icao, metar: [...], taf, source: "awc" | "checkwx"}
//! GET /airports/nearest?lat=&lon=[&count=1..20, default 5][&maxDistanceKm=, default 500]
//!                            {airports: [{icao, name, distanceKm}], source: "catalog" | "empty"}
//! GET /aviation/nearest-metar?lat=&lon=[&count=1..10, default 5][&radiusKm=, default 150][&maxAgeMinutes=30..720, default 180]
//!                            the nearest airport with a recent METAR, its METAR and TAF, and every
//!                            candidate considered: {status, icao, name, metar, taf, candidates, ...}
//! GET /health
//! ```
//!
//! METARs come from the Aviation Weather Center (free, no key). If it fails
//! and `CHECKWX_API_KEY` is set, CheckWX answers instead. Answers, even empty
//! ones, are cached for 30 minutes so a quiet airfield is not asked again and
//! again. The airports are the app's catalogue, compiled in, so the nearest
//! lookup needs no subrequest.

use std::cell::RefCell;
use std::collections::HashMap;
use std::time::Duration;

use serde_json::{json as j, Value};
use weather_core::aviation::{self as avn, MetarResponse};
use weather_core::breaker::{self, Breaker};
use weather_core::secrets;
use weather_edge::{error, get_with_timeout, json, now, now_ms, query_pairs, secret, FetchError};
use worker::{event, Context, Env, Headers, Method, Request, Response, Result};

const CACHE_BINDING: &str = "CACHE";
const TIMEOUT: Duration = Duration::from_secs(10);

thread_local! {
    /// The Aviation Weather Center's breaker (the Python `aviation_breaker`).
    static AWC: RefCell<Breaker> = const { RefCell::new(Breaker::new(breaker::DEFAULT)) };
}

#[event(fetch)]
pub async fn fetch(req: Request, env: Env, ctx: Context) -> Result<Response> {
    if req.method() != Method::Get {
        return error(405, "method_not_allowed", "Only GET is served.");
    }
    match req.path().as_str() {
        "/metar" => metar(&req, &env, &ctx).await,
        "/airports/nearest" => nearest(&req),
        "/aviation/nearest-metar" => nearest_metar(&req, &env, &ctx).await,
        "/health" => {
            let checkwx = secret(&env, secrets::CHECKWX_API_KEY).await.is_some();
            json(
                200,
                &j!({
                "service": "mukoko-weather-aviation",
                "status": "ok",
                "configured": {
                    "cache": env.kv(CACHE_BINDING).is_ok(),
                    "checkwx": checkwx,
                    }
                }),
            )
        }
        _ => error(404, "not_found", "No such route."),
    }
}

fn nearest(req: &Request) -> Result<Response> {
    let pairs = query_pairs(req)?;
    let get = |k: &str| {
        pairs
            .iter()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.trim())
            .filter(|v| !v.is_empty())
    };
    let num = |k: &str| {
        get(k)
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|x| x.is_finite())
    };
    let (Some(lat), Some(lon)) = (num("lat"), num("lon")) else {
        return error(422, "invalid_request", "Give both `lat` and `lon`.");
    };
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
        return error(422, "invalid_request", "Invalid coordinates.");
    }
    let count = match get("count") {
        None => 5,
        Some(v) => match v.parse::<usize>() {
            Ok(n) if (1..=avn::MAX_NEAREST).contains(&n) => n,
            _ => return error(422, "invalid_request", "`count` must be 1 to 20."),
        },
    };
    let max_km = match get("maxDistanceKm") {
        None => avn::DEFAULT_MAX_DISTANCE_KM,
        Some(_) => match num("maxDistanceKm") {
            Some(d) if d > 0.0 && d <= 20_000.0 => d,
            _ => {
                return error(
                    422,
                    "invalid_request",
                    "`maxDistanceKm` must be above 0 and at most 20000.",
                )
            }
        },
    };
    let airports = avn::nearest_airports(lat, lon, count, max_km);
    let source = if airports.is_empty() {
        "empty"
    } else {
        "catalog"
    };
    let resp = json(200, &j!({"airports": airports, "source": source}))?;
    resp.headers()
        .set("Cache-Control", "public, max-age=86400")?;
    Ok(resp)
}

async fn metar(req: &Request, env: &Env, ctx: &Context) -> Result<Response> {
    let pairs = query_pairs(req)?;
    let raw = pairs
        .iter()
        .find(|(n, _)| n == "icao")
        .map(|(_, v)| v.as_str());
    let Some(raw) = raw else {
        return error(422, "invalid_request", "Give `icao`.");
    };
    let Some(icao) = avn::normalize_icao(raw) else {
        return error(
            400,
            "invalid_request",
            "Invalid ICAO code — must be 4 uppercase letters",
        );
    };

    let kv = env.kv(CACHE_BINDING).ok();
    let key = avn::cache_key(&icao);
    if let Some(kv) = &kv {
        if let Ok(Some(hit)) = kv.get(&key).json::<MetarResponse>().await {
            return respond(&hit, "HIT");
        }
    }

    let (metar, source) = match awc_metars(&icao).await {
        Some(obs) => (Some(obs), "awc"),
        None => match secret(env, secrets::CHECKWX_API_KEY).await {
            Some(k) => (checkwx(&icao, &k).await, "checkwx"),
            None => (None, "awc"),
        },
    };
    let answered = metar.is_some();
    let taf = if answered { awc_taf(&icao).await } else { None };
    let body = MetarResponse {
        icao,
        metar: metar.unwrap_or_default(),
        taf,
        // When nothing answered the app still gets an empty list, as from
        // Python; it is not cached, so the next request tries again.
        source: source.to_owned(),
    };

    if let (true, Some(kv)) = (answered, kv) {
        if let Ok(text) = serde_json::to_string(&body) {
            ctx.wait_until(async move {
                if let Ok(put) = kv.put(&key, text) {
                    let _ = put
                        .expiration_ttl(avn::METAR_CACHE_TTL_SECONDS)
                        .execute()
                        .await;
                }
            });
        }
    }
    respond(&body, "MISS")
}

fn respond(body: &MetarResponse, cache: &str) -> Result<Response> {
    let resp = json(200, body)?;
    resp.headers().set("X-Cache", cache)?;
    Ok(resp)
}

/// `Ok(Some(body))` for a JSON answer, `Ok(None)` for "no data" (204), and
/// `Err` for anything else.
async fn get_json(url: &str, headers: Option<Headers>) -> std::result::Result<Option<Value>, ()> {
    match get_with_timeout(url, headers, TIMEOUT).await {
        Ok(resp) if resp.status_code() == 204 => Ok(None),
        Ok(mut resp) if resp.status_code() == 200 => {
            resp.json::<Value>().await.map(Some).map_err(|_| ())
        }
        Ok(_) | Err(FetchError::Timeout) | Err(FetchError::Network(_)) => Err(()),
    }
}

/// METARs from the Aviation Weather Center; `None` when it failed.
async fn awc_metars(icao: &str) -> Option<Vec<avn::MetarObs>> {
    match get_json(&avn::awc_metar_url(icao), None).await {
        Ok(Some(body)) => Some(avn::decode_awc_metars(&body)),
        // An unknown or silent station: AWC answers 204.
        Ok(None) => Some(Vec::new()),
        Err(()) => None,
    }
}

/// The TAF, best effort.
async fn awc_taf(icao: &str) -> Option<String> {
    match get_json(&avn::awc_taf_url(icao), None).await {
        Ok(Some(body)) => avn::awc_taf(&body),
        _ => None,
    }
}

async fn checkwx(icao: &str, key: &str) -> Option<Vec<avn::MetarObs>> {
    let headers = Headers::new();
    headers.set("X-API-Key", key).ok()?;
    match get_json(&avn::checkwx_url(icao), Some(headers)).await {
        Ok(Some(body)) => Some(avn::decode_checkwx(&body)),
        Ok(None) => Some(Vec::new()),
        Err(()) => None,
    }
}

// ---------------------------------------------------------------------------
// Nearest airport with a recent report (ported from `find_nearest_report` in
// `api/py/_metar.py`)
// ---------------------------------------------------------------------------

fn awc_allowed() -> bool {
    AWC.with(|b| b.borrow_mut().allow(now_ms()))
}

fn awc_record(ok: bool) {
    AWC.with(|b| {
        let mut b = b.borrow_mut();
        if ok {
            b.record_success();
        } else {
            b.record_failure(now_ms());
        }
    });
}

async fn kv_put(kv: worker::kv::KvStore, key: String, value: String, ttl: u64) {
    if let Ok(put) = kv.put(&key, value) {
        let _ = put.expiration_ttl(ttl).execute().await;
    }
}

/// Airports the catalogue does not hold, from AWC station info for the
/// point's 0.5° cell. A surveyed cell (stations found: 7 days, none: 6 hours)
/// is kept in KV with its stations, so the survey is one upstream request per
/// cell and the answer is served from KV after that. Never fails the card.
async fn discovered(
    env: &Env,
    ctx: &Context,
    lat: f64,
    lon: f64,
    radius_km: f64,
) -> Vec<avn::Station> {
    let kv = env.kv(CACHE_BINDING).ok();
    let survey_km = avn::discovery_radius(radius_km);
    let key = avn::discovery_key(lat, lon, survey_km);
    if let Some(kv) = &kv {
        if let Ok(Some(hit)) = kv.get(&key).json::<Vec<avn::Station>>().await {
            return hit;
        }
    }
    if !awc_allowed() {
        return Vec::new();
    }
    let url = avn::awc_stationinfo_url(avn::discovery_bbox(lat, lon, survey_km));
    let stations = match get_with_timeout(&url, None, TIMEOUT).await {
        Ok(resp) if resp.status_code() == 204 => {
            awc_record(true);
            Vec::new()
        }
        Ok(mut resp) if resp.status_code() == 200 => match resp.json::<Value>().await {
            Ok(body) if body.is_array() => {
                awc_record(true);
                avn::parse_awc_stations(&body)
            }
            _ => {
                awc_record(false);
                return Vec::new();
            }
        },
        // A 4xx is our request (a bad bbox, a limit on us), not an outage.
        Ok(resp) if (400..500).contains(&resp.status_code()) => return Vec::new(),
        _ => {
            awc_record(false);
            return Vec::new();
        }
    };
    if let (Some(kv), Ok(text)) = (kv, serde_json::to_string(&stations)) {
        let ttl = if stations.is_empty() {
            avn::DISCOVERY_EMPTY_TTL_SECONDS
        } else {
            avn::DISCOVERY_FOUND_TTL_SECONDS
        };
        ctx.wait_until(kv_put(kv, key, text, ttl));
    }
    stations
}

fn nm_key(icao: &str) -> String {
    format!("avn:nm:v1:{icao}")
}

fn taf_key(icao: &str) -> String {
    format!("avn:taf:v1:{icao}")
}

/// METARs per station: per-station KV cache first, then ONE batched AWC
/// request for the rest. `None` when AWC failed for the batch.
async fn metars_for(
    env: &Env,
    ctx: &Context,
    icaos: &[String],
) -> Option<HashMap<String, Vec<avn::MetarObs>>> {
    let kv = env.kv(CACHE_BINDING).ok();
    let mut out: HashMap<String, Vec<avn::MetarObs>> = HashMap::new();
    let mut missing: Vec<String> = Vec::new();
    for icao in icaos {
        let hit = match &kv {
            Some(kv) => kv
                .get(&nm_key(icao))
                .json::<Vec<avn::MetarObs>>()
                .await
                .ok()
                .flatten(),
            None => None,
        };
        match hit {
            Some(list) => {
                out.insert(icao.clone(), list);
            }
            None => missing.push(icao.clone()),
        }
    }
    if missing.is_empty() {
        return Some(out);
    }
    if !awc_allowed() {
        return None;
    }
    let body = match get_json(&avn::awc_batch_metar_url(&missing), None).await {
        Ok(Some(b)) if b.is_array() => b,
        Ok(None) => Value::Array(Vec::new()),
        _ => {
            awc_record(false);
            return None;
        }
    };
    awc_record(true);
    let mut grouped = avn::metars_by_station(&body, &missing);
    for icao in &missing {
        let list = grouped.remove(icao).unwrap_or_default();
        if let (Some(kv), Ok(text)) = (kv.clone(), serde_json::to_string(&list)) {
            let ttl = if list.is_empty() {
                avn::METAR_EMPTY_CACHE_TTL_SECONDS
            } else {
                avn::METAR_CACHE_TTL_SECONDS
            };
            ctx.wait_until(kv_put(kv, nm_key(icao), text, ttl));
        }
        out.insert(icao.clone(), list);
    }
    Some(out)
}

/// The TAF for a station, cached; a failed AWC call is `None` and not cached.
async fn taf_for(env: &Env, ctx: &Context, icao: &str) -> Option<String> {
    let kv = env.kv(CACHE_BINDING).ok();
    if let Some(kv) = &kv {
        if let Ok(Some(hit)) = kv.get(&taf_key(icao)).json::<Value>().await {
            return hit["taf"].as_str().map(str::to_owned);
        }
    }
    if !awc_allowed() {
        return None;
    }
    let taf = match get_json(&avn::awc_taf_url(icao), None).await {
        Ok(Some(body)) => avn::awc_taf(&body),
        Ok(None) => None,
        Err(()) => {
            awc_record(false);
            return None;
        }
    };
    awc_record(true);
    if let (Some(kv), Ok(text)) = (kv, serde_json::to_string(&j!({"taf": taf}))) {
        let ttl = if taf.is_some() {
            avn::METAR_CACHE_TTL_SECONDS
        } else {
            avn::METAR_EMPTY_CACHE_TTL_SECONDS
        };
        ctx.wait_until(kv_put(kv, taf_key(icao), text, ttl));
    }
    taf
}

async fn nearest_metar(req: &Request, env: &Env, ctx: &Context) -> Result<Response> {
    let pairs = query_pairs(req)?;
    let get = |k: &str| {
        pairs
            .iter()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.trim())
            .filter(|v| !v.is_empty())
    };
    let num = |k: &str| {
        get(k)
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|x| x.is_finite())
    };
    let (Some(lat), Some(lon)) = (num("lat"), num("lon")) else {
        return error(422, "invalid_request", "Give both `lat` and `lon`.");
    };
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
        return error(422, "invalid_request", "Invalid coordinates.");
    }
    let count = match get("count") {
        None => 5,
        Some(v) => match v.parse::<usize>() {
            Ok(n) if (1..=avn::NEAREST_MAX_COUNT).contains(&n) => n,
            _ => return error(422, "invalid_request", "`count` must be 1 to 10."),
        },
    };
    let radius_km = match get("radiusKm") {
        None => avn::DEFAULT_RADIUS_KM,
        Some(_) => match num("radiusKm") {
            Some(r) if r > 0.0 && r <= 500.0 => r,
            _ => {
                return error(
                    422,
                    "invalid_request",
                    "`radiusKm` must be above 0 and at most 500.",
                )
            }
        },
    };
    let max_age = match get("maxAgeMinutes") {
        None => avn::DEFAULT_MAX_AGE_MIN,
        Some(v) => match v.parse::<i64>() {
            Ok(m) if (30..=720).contains(&m) => m,
            _ => return error(422, "invalid_request", "`maxAgeMinutes` must be 30 to 720."),
        },
    };

    let mut candidates = avn::nearest_airports(lat, lon, count, radius_km);
    if candidates.len() < count {
        let found = discovered(env, ctx, lat, lon, radius_km).await;
        let extra = avn::nearest_of(&found, lat, lon, count, radius_km);
        candidates = avn::merge_candidates(candidates, extra, count);
    }
    let respond = |body: Value| -> Result<Response> {
        let resp = json(200, &body)?;
        if body["status"] == "unavailable" {
            resp.headers().set("Cache-Control", "no-store")?;
        }
        Ok(resp)
    };
    let fields = |pairs: Vec<(&str, Value)>| {
        pairs
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect::<serde_json::Map<String, Value>>()
    };
    if candidates.is_empty() {
        return respond(avn::nearest_response(
            "no_airports",
            radius_km,
            max_age,
            fields(vec![("message", j!(avn::no_airports_message(radius_km)))]),
        ));
    }

    let icaos: Vec<String> = candidates.iter().map(|c| c.icao.clone()).collect();
    let Some(reports) = metars_for(env, ctx, &icaos).await else {
        let rows: Vec<Value> = candidates
            .iter()
            .map(|c| j!({"icao": c.icao, "name": c.name, "distanceKm": c.distance_km, "reported": false, "observedAt": null, "ageMinutes": null}))
            .collect();
        return respond(avn::nearest_response(
            "unavailable",
            radius_km,
            max_age,
            fields(vec![
                ("message", j!("Aviation data temporarily unavailable.")),
                ("candidates", Value::Array(rows)),
            ]),
        ));
    };

    let (rows, chosen) = avn::evaluate(&candidates, &reports, now(), max_age);
    let Some((i, age)) = chosen else {
        return respond(avn::nearest_response(
            "no_recent_report",
            radius_km,
            max_age,
            fields(vec![
                ("message", j!(avn::no_recent_message(radius_km, max_age))),
                ("candidates", Value::Array(rows)),
            ]),
        ));
    };
    let airport = &candidates[i];
    let metar = reports.get(&airport.icao).cloned().unwrap_or_default();
    let observed = metar
        .first()
        .map(|m| m.time.clone())
        .filter(|t| !t.is_empty());
    let taf = taf_for(env, ctx, &airport.icao).await;
    respond(avn::nearest_response(
        "ok",
        radius_km,
        max_age,
        fields(vec![
            ("icao", j!(airport.icao)),
            ("name", j!(airport.name)),
            ("distanceKm", j!(airport.distance_km)),
            ("observedAt", j!(observed)),
            ("ageMinutes", j!(age)),
            ("metar", serde_json::to_value(&metar).unwrap_or(Value::Null)),
            ("taf", j!(taf)),
            ("candidates", Value::Array(rows)),
        ]),
    ))
}
