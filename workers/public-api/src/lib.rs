//! `mukoko-weather-api`: the public weather API.
//!
//! It serves three kinds of caller:
//!
//! - the Mukoko Weather app (browser, CORS);
//! - developers;
//! - mukoko-api, which binds to this Worker for consumer reuse.
//!
//! ```text
//! GET /v1/weather?lat=&lon=[&models=a,b]   full WeatherData, the shape of /api/py/weather
//! GET /v1/forecast?location=|lat=&lon=[&days=1..7]   the daily forecast contract
//! GET /v1/air-quality?lat=&lon=                     the EPA AQI, the shape of /api/py/airquality
//! GET /v1/metar?icao=                                METARs and TAF, the shape of /api/py/metar
//! GET /v1/airports/nearest?lat=&lon=[&count=][&maxDistanceKm=]
//!                                                    the shape of /api/py/airports/nearest
//! GET /v1/locations, /v1/search, /v1/geo, /v1/history   places (mukoko-weather-places)
//! GET /health
//! ```
//!
//! `/v1/weather` keeps the app's behaviour: when no provider answers it serves
//! the seasonal estimate labelled `X-Weather-Provider: fallback`, so a page
//! always renders. `/v1/forecast` (data for other apps) fails with `503`
//! instead of estimating.
//!
//! Forecasts and air quality come from `mukoko-weather-forecast` over the
//! `FORECAST` service binding; aviation weather from `mukoko-weather-aviation`
//! over `AVIATION`; locations, search and history from `mukoko-weather-places`
//! over `PLACES`. Anonymous requests are rate limited per client IP
//! (`RATE_LIMITER`). A developer may send a Nyuchi API key, checked by the
//! Nyuchi API (`keys`), and is then limited per key (`KEY_RATE_LIMITER`).

mod keys;

use serde_json::Value;
use weather_core::cors::origin_allowed;
use weather_core::query::ForecastQuery;
use weather_core::{geo, normalize, places};
use weather_edge::{config, error, json, now, query_pairs};
use worker::{event, Context, Env, Headers, Method, Request, Response, Result};

const FORECAST_BINDING: &str = "FORECAST";
const AVIATION_BINDING: &str = "AVIATION";
const RATE_LIMITER: &str = "RATE_LIMITER";
const KEY_RATE_LIMITER: &str = "KEY_RATE_LIMITER";
const PLACES_BINDING: &str = "PLACES";
/// The Python backend's default point (Harare) when none is given.
const DEFAULT_POINT: (f64, f64) = (-17.83, 31.05);
/// The Python backend's default elevation for the seasonal estimate.
const DEFAULT_ELEVATION_M: f64 = 1200.0;

#[event(fetch)]
pub async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let origin = req.headers().get("Origin")?.unwrap_or_default();
    let cors_origin = cors_origin(&env, &origin);

    let resp = if req.method() == Method::Options {
        preflight(cors_origin.is_some())
    } else if req.method() != Method::Get {
        error(405, "method_not_allowed", "Only GET is served.")
    } else {
        match keys::caller(&req, &env).await? {
            Err(refused) => Ok(refused),
            Ok(caller) => match rate_limited(&req, &env, &caller).await {
                Some(limited) => limited,
                None => route(&req, &env).await,
            },
        }
    }?;
    with_cors(resp, cors_origin.as_deref())
}

async fn route(req: &Request, env: &Env) -> Result<Response> {
    match req.path().as_str() {
        "/health" => json(
            200,
            &serde_json::json!({"service": "mukoko-weather-api", "status": "ok"}),
        ),
        "/v1/weather" => weather(req, env).await,
        "/v1/forecast" => forecast(req, env).await,
        "/v1/air-quality" => {
            relay(
                req,
                env,
                FORECAST_BINDING,
                "/air-quality",
                "public, max-age=1800",
            )
            .await
        }
        "/v1/metar" => relay(req, env, AVIATION_BINDING, "/metar", "public, max-age=600").await,
        "/v1/airports/nearest" => {
            relay(
                req,
                env,
                AVIATION_BINDING,
                "/airports/nearest",
                "public, max-age=86400",
            )
            .await
        }
        "/v1/locations" | "/v1/search" | "/v1/geo" | "/v1/history" => places(req, env).await,
        _ => error(404, "not_found", "No such route."),
    }
}

fn cors_origin(env: &Env, origin: &str) -> Option<String> {
    let allowed = config(env, "CORS_ORIGINS").unwrap_or_default();
    let allow_local = config(env, "ENVIRONMENT").as_deref() != Some("production");
    origin_allowed(origin, &allowed, allow_local).then(|| origin.to_owned())
}

fn preflight(allowed: bool) -> Result<Response> {
    let resp = Response::empty()?.with_status(if allowed { 204 } else { 403 });
    if allowed {
        let h = resp.headers();
        h.set("Access-Control-Allow-Methods", "GET, OPTIONS")?;
        h.set(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization, X-Mukoko-Client, X-API-Key, X-Client-Id, X-Client-Secret",
        )?;
        h.set("Access-Control-Max-Age", "86400")?;
    }
    Ok(resp)
}

fn with_cors(resp: Response, origin: Option<&str>) -> Result<Response> {
    let h = resp.headers();
    h.append("Vary", "Origin")?;
    if let Some(o) = origin {
        h.set("Access-Control-Allow-Origin", o)?;
        h.set(
            "Access-Control-Expose-Headers",
            "X-Cache, X-Weather-Provider, X-Current-Source, X-Fetched-At, X-AQ-Source",
        )?;
    }
    Ok(resp)
}

fn client_ip(req: &Request) -> String {
    req.headers()
        .get("CF-Connecting-IP")
        .ok()
        .flatten()
        .unwrap_or_else(|| "service-binding".to_owned())
}

/// `Some(429)` when the caller is over its limit: per IP when anonymous, per
/// key id with a key. A missing limiter binding (local dev) does not block.
async fn rate_limited(req: &Request, env: &Env, caller: &keys::Caller) -> Option<Result<Response>> {
    let (limiter, key) = match caller {
        keys::Caller::Anonymous => (env.rate_limiter(RATE_LIMITER).ok()?, client_ip(req)),
        keys::Caller::Key(ctx) => (
            env.rate_limiter(KEY_RATE_LIMITER).ok()?,
            format!("key:{}", ctx.key_id),
        ),
    };
    match limiter.limit(key).await {
        Ok(outcome) if !outcome.success => {
            let resp = error(429, "rate_limited", "Too many requests; slow down.");
            if let Ok(r) = &resp {
                let _ = r.headers().set("Retry-After", "60");
            }
            Some(resp)
        }
        _ => None,
    }
}

async fn ask_forecast(env: &Env, path_and_query: &str) -> Result<Option<Response>> {
    let fetcher = env.service(FORECAST_BINDING)?;
    Ok(fetcher
        .fetch(format!("https://forecast{path_and_query}"), None)
        .await
        .ok())
}

fn copy_header(from: &Headers, to: &Headers, name: &str) -> Result<()> {
    if let Some(v) = from.get(name)? {
        to.set(name, &v)?;
    }
    Ok(())
}

async fn weather(req: &Request, env: &Env) -> Result<Response> {
    let pairs = query_pairs(req)?;
    let get = |k: &str| {
        pairs
            .iter()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.trim())
            .filter(|v| !v.is_empty())
    };
    let parse = |k: &str, default: f64| -> Option<f64> {
        match get(k) {
            None => Some(default),
            Some(v) => v.parse::<f64>().ok().filter(|x| x.is_finite()),
        }
    };
    let (Some(lat), Some(lon)) = (parse("lat", DEFAULT_POINT.0), parse("lon", DEFAULT_POINT.1))
    else {
        return error(422, "invalid_request", "`lat` and `lon` must be numbers.");
    };
    if !geo::valid_coordinates(lat, lon) {
        return error(400, "invalid_request", "Invalid coordinates");
    }

    let mut q = format!("/weather?lat={lat}&lon={lon}&extras=1");
    if let Some(models) = get("models") {
        // The forecast Worker keeps only known model ids; send just the
        // characters a model id can have.
        let safe: String = models
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == ',')
            .take(200)
            .collect();
        q.push_str("&models=");
        q.push_str(&safe);
    }

    if let Some(mut upstream) = ask_forecast(env, &q).await? {
        if upstream.status_code() == 200 {
            if let Ok(body) = upstream.json::<Value>().await {
                let resp = json(200, &body)?;
                for h in [
                    "X-Cache",
                    "X-Weather-Provider",
                    "X-Current-Source",
                    "X-Fetched-At",
                ] {
                    copy_header(upstream.headers(), resp.headers(), h)?;
                }
                resp.headers().set("Cache-Control", "public, max-age=300")?;
                return Ok(resp);
            }
        }
    }

    // Every provider failed: the app still gets a page, clearly labelled.
    let elevation = places::nearest_seed(lat, lon, 50.0)
        .and_then(|p| p.elevation)
        .unwrap_or(DEFAULT_ELEVATION_M);
    let resp = json(200, &normalize::seasonal_fallback(lat, elevation, now()))?;
    let h = resp.headers();
    h.set("X-Cache", "MISS")?;
    h.set("X-Weather-Provider", "fallback")?;
    h.set("X-Current-Source", "fallback")?;
    Ok(resp)
}

async fn forecast(req: &Request, env: &Env) -> Result<Response> {
    let pairs = query_pairs(req)?;
    if let Err(e) = ForecastQuery::parse(pairs.iter().map(|(k, v)| (k.as_str(), v.as_str()))) {
        return error(422, "invalid_request", &e.to_string());
    }
    let query = req.url()?.query().unwrap_or("").to_owned();
    let Some(mut upstream) = ask_forecast(env, &format!("/daily?{query}")).await? else {
        return error(
            502,
            "upstream_unreachable",
            "The forecast service did not answer.",
        );
    };
    let status = upstream.status_code();
    match status {
        200 | 404 | 422 | 503 => match upstream.json::<Value>().await {
            Ok(body) => {
                let resp = json(status, &body)?;
                if status == 200 {
                    resp.headers().set("Cache-Control", "public, max-age=900")?;
                }
                Ok(resp)
            }
            Err(_) => error(
                502,
                "upstream_malformed",
                "The forecast service sent a bad answer.",
            ),
        },
        _ => error(502, "upstream_error", "The forecast service failed."),
    }
}

/// Pass a request through to a service-bound Worker, keeping its JSON body
/// and its client-error statuses. The query string is passed as is; the
/// Worker behind validates it.
async fn relay(
    req: &Request,
    env: &Env,
    binding: &str,
    path: &str,
    cache_control: &str,
) -> Result<Response> {
    let query = req.url()?.query().unwrap_or("").to_owned();
    let fetcher = env.service(binding)?;
    let Ok(mut upstream) = fetcher
        .fetch(format!("https://upstream{path}?{query}"), None)
        .await
    else {
        return error(502, "upstream_unreachable", "The service did not answer.");
    };
    let status = upstream.status_code();
    if !matches!(status, 200 | 400 | 404 | 422 | 502 | 503) {
        return error(502, "upstream_error", "The service failed.");
    }
    let Ok(body) = upstream.json::<Value>().await else {
        return error(502, "upstream_malformed", "The service sent a bad answer.");
    };
    let resp = json(status, &body)?;
    for h in ["X-Cache", "X-AQ-Source"] {
        copy_header(upstream.headers(), resp.headers(), h)?;
    }
    if status == 200 {
        resp.headers().set("Cache-Control", cache_control)?;
    }
    Ok(resp)
}

/// Locations, search, nearest place and history, from `mukoko-weather-places`.
/// The path loses its `/v1`; status, body and `Cache-Control` pass through.
async fn places(req: &Request, env: &Env) -> Result<Response> {
    let url = req.url()?;
    let path = url.path().trim_start_matches("/v1");
    let target = match url.query() {
        Some(q) => format!("https://places{path}?{q}"),
        None => format!("https://places{path}"),
    };
    let headers = Headers::new();
    headers.set("X-Mukoko-Client-IP", &client_ip(req))?;
    let mut init = worker::RequestInit::new();
    init.with_headers(headers);
    let Ok(mut upstream) = env.service(PLACES_BINDING)?.fetch(target, Some(init)).await else {
        return error(
            502,
            "upstream_unreachable",
            "The places service did not answer.",
        );
    };
    let status = upstream.status_code();
    let Ok(body) = upstream.json::<Value>().await else {
        return error(
            502,
            "upstream_malformed",
            "The places service sent a bad answer.",
        );
    };
    let resp = json(status, &body)?;
    if let Some(cc) = upstream.headers().get("Cache-Control")? {
        resp.headers().set("Cache-Control", &cc)?;
    }
    Ok(resp)
}
