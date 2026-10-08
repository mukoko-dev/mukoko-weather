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
//! GET /health
//! ```
//!
//! METARs come from the Aviation Weather Center (free, no key). If it fails
//! and `CHECKWX_API_KEY` is set, CheckWX answers instead. Answers, even empty
//! ones, are cached for 30 minutes so a quiet airfield is not asked again and
//! again. The airports are the app's catalogue, compiled in, so the nearest
//! lookup needs no subrequest.

use std::time::Duration;

use serde_json::{json as j, Value};
use weather_core::aviation::{self as avn, MetarResponse};
use weather_edge::{config, error, get_with_timeout, json, query_pairs, FetchError};
use worker::{event, Context, Env, Headers, Method, Request, Response, Result};

const CACHE_BINDING: &str = "CACHE";
const TIMEOUT: Duration = Duration::from_secs(10);

#[event(fetch)]
pub async fn fetch(req: Request, env: Env, ctx: Context) -> Result<Response> {
    if req.method() != Method::Get {
        return error(405, "method_not_allowed", "Only GET is served.");
    }
    match req.path().as_str() {
        "/metar" => metar(&req, &env, &ctx).await,
        "/airports/nearest" => nearest(&req),
        "/health" => json(
            200,
            &j!({
                "service": "mukoko-weather-aviation",
                "status": "ok",
                "configured": {
                    "cache": env.kv(CACHE_BINDING).is_ok(),
                    "checkwx": config(&env, "CHECKWX_API_KEY").is_some(),
                }
            }),
        ),
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
        None => match config(env, "CHECKWX_API_KEY") {
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
