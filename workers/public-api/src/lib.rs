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
//! GET /v1/locations/profile?slug=|lat=&lon=[&country=]   a place's knowledge (seasons, crops, climate, soil) and today's context
//! GET /v1/agriculture?lat=&lon=[&location=][&country=][&crops=]   farm windows, rain, soil, water balance, frost and heat risk (the shape of /api/py/agriculture)
//! GET /v1/air-quality?lat=&lon=                     the EPA AQI, the shape of /api/py/airquality
//! GET /v1/air-quality/grid?lat=&lon=[&radiusKm=&n=]  US AQI on an n x n grid (the shape of /api/py/airquality/grid)
//! GET /v1/haze?lat=&lon=                             haze panel data (the shape of /api/py/haze)
//! GET /v1/normals?lat=&lon=[&date=]                  climate normals (the shape of /api/py/normals)
//! GET /v1/normals/monthly?lat=&lon=                  the twelve monthly normals (temperature, rainfall, rainy days)
//! GET /v1/enso                                       El Nino / La Nina phase (the shape of /api/py/enso)
//! GET /v1/sg-air?lat=&lon=                           official Singapore NEA air quality (the shape of /api/py/sg-air)
//! GET /v1/aviation/nearest-metar?lat=&lon=           nearest airport with a recent METAR (the shape of /api/py/aviation/nearest-metar)
//! GET /v1/metar?icao=                                METARs and TAF, the shape of /api/py/metar
//! GET /v1/airports/nearest?lat=&lon=[&count=][&maxDistanceKm=]
//!                                                    the shape of /api/py/airports/nearest
//! GET /v1/locations, /v1/search, /v1/geo, /v1/history   places (mukoko-weather-places)
//! POST /v1/devices, GET|PATCH /v1/devices/{id}      device preference profiles
//! POST|GET /v1/reports, POST /v1/reports/upvote     community weather reports
//! POST /v1/ai/{followup,chat,history/analyze}   Shamwari Weather (the weather summary is not public: it is
//!                                               a signed-in route of the app, reached through mukoko-weather-internal)
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
//! over `PLACES`; `/v1/ai/*` is forwarded to `mukoko-weather-ai` over
//! `AI_SERVICE` with the client's IP (that Worker has its own, tighter limit).
//! Anonymous requests are rate limited per client IP
//! (`RATE_LIMITER`). A developer may send a Nyuchi API key, checked by the
//! Nyuchi API (`keys`), and is then limited per key (`KEY_RATE_LIMITER`).

mod keys;

use serde_json::Value;
use weather_core::query::ForecastQuery;
use weather_core::{geo, normalize, places, reference, status as health};
use weather_edge::{
    cors, error, get_with_timeout, json, now, now_ms, now_rfc3339, query_pairs, responses, service,
};
use worker::wasm_bindgen::JsValue;
use worker::{event, Context, Env, Headers, Method, Request, RequestInit, Response, Result};

const FORECAST_BINDING: &str = "FORECAST";
const AVIATION_BINDING: &str = "AVIATION";
const AI_BINDING: &str = "AI_SERVICE";
/// AI request bodies larger than this are refused here.
const MAX_AI_BODY_BYTES: usize = 64 * 1024;
/// Device profile bodies are a few hundred bytes.
/// Device profile and community report bodies larger than this are refused here.
const MAX_COMMUNITY_BODY_BYTES: usize = 16 * 1024;
const RATE_LIMITER: &str = "RATE_LIMITER";
const KEY_RATE_LIMITER: &str = "KEY_RATE_LIMITER";
const PLACES_BINDING: &str = "PLACES";
/// The Python backend's default point (Harare) when none is given.
const DEFAULT_POINT: (f64, f64) = (-17.83, 31.05);
/// The Python backend's default elevation for the seasonal estimate.
const DEFAULT_ELEVATION_M: f64 = 1200.0;

#[event(fetch)]
pub async fn fetch(mut req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let origin = req.headers().get("Origin")?.unwrap_or_default();
    let cors_origin = cors::allowed_origin(&env, &origin);
    let is_ai = is_ai_path(&req.path());

    let resp = if req.method() == Method::Options {
        cors::preflight(
            cors_origin.is_some(),
            "GET, POST, PATCH, OPTIONS",
            "Content-Type, Authorization, X-Mukoko-Client, X-API-Key, X-Client-Id, X-Client-Secret",
        )
    } else if is_ai {
        if req.method() != Method::Post {
            error(405, "method_not_allowed", "Only POST is served.")
        } else if let Some(limited) = rate_limited(&req, &env, &keys::Caller::Anonymous).await {
            limited
        } else {
            forward_ai(&mut req, &env).await
        }
    } else if is_community_path(&req.path()) {
        match req.method() {
            Method::Get | Method::Post | Method::Patch => {
                match rate_limited(&req, &env, &keys::Caller::Anonymous).await {
                    Some(limited) => limited,
                    None => forward_community(&mut req, &env).await,
                }
            }
            _ => error(405, "method_not_allowed", "Use POST, GET or PATCH."),
        }
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
    cors::apply(
        resp,
        cors_origin.as_deref(),
        Some(
            "X-Cache, X-Weather-Provider, X-Weather-Blend, X-Enrichment, X-Current-Source, \
             X-Fetched-At, X-AQ-Source",
        ),
    )
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
        "/v1/air-quality/grid" => {
            relay(
                req,
                env,
                FORECAST_BINDING,
                "/air-quality/grid",
                "public, max-age=900",
            )
            .await
        }
        "/v1/haze" => relay(req, env, FORECAST_BINDING, "/haze", "public, max-age=900").await,
        "/v1/normals" => {
            relay(
                req,
                env,
                FORECAST_BINDING,
                "/normals",
                "public, max-age=86400",
            )
            .await
        }
        "/v1/normals/monthly" => {
            relay(
                req,
                env,
                FORECAST_BINDING,
                "/monthly-normals",
                "public, max-age=86400",
            )
            .await
        }
        "/v1/enso" => relay(req, env, FORECAST_BINDING, "/enso", "public, max-age=3600").await,
        "/v1/sg-air" => relay(req, env, FORECAST_BINDING, "/sg-air", "public, max-age=300").await,
        "/v1/aviation/nearest-metar" => {
            relay(
                req,
                env,
                AVIATION_BINDING,
                "/aviation/nearest-metar",
                "public, max-age=300",
            )
            .await
        }
        "/v1/locations/profile" => {
            relay(
                req,
                env,
                FORECAST_BINDING,
                "/profile",
                "public, max-age=1800",
            )
            .await
        }
        "/v1/agriculture" => {
            relay(
                req,
                env,
                FORECAST_BINDING,
                "/agriculture",
                weather_core::agriculture::CLIENT_CACHE_CONTROL,
            )
            .await
        }
        "/v1/model-grid" => {
            relay(
                req,
                env,
                FORECAST_BINDING,
                "/model-grid",
                "public, max-age=3600",
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
        "/v1/status" => status(env).await,
        path if reference::serves(path) => {
            let query = query_pairs(req)?;
            match reference::reply(path, &query) {
                Some(r) => {
                    let resp = json(r.status, &r.body)?;
                    resp.headers().set("Cache-Control", r.cache)?;
                    Ok(resp)
                }
                None => error(404, "not_found", "No such route."),
            }
        }
        _ => error(404, "not_found", "No such route."),
    }
}

/// The caller's address for a call to a Worker with no public route.
fn client_ip(req: &Request) -> String {
    weather_edge::client_ip(req).unwrap_or_else(|| "service-binding".to_owned())
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
            Some(responses::rate_limited(60, "Too many requests; slow down."))
        }
        _ => None,
    }
}

/// The routes `mukoko-weather-places` serves from MongoDB through the bridge,
/// which are also the ones that write: device profiles and community reports.
fn is_community_path(path: &str) -> bool {
    path == "/v1/devices"
        || path.starts_with("/v1/devices/")
        || path == "/v1/reports"
        || path == "/v1/reports/upvote"
}

/// Device preference profiles (`POST /v1/devices`, `GET` and `PATCH
/// /v1/devices/{id}`) and community reports (`POST` and `GET /v1/reports`,
/// `POST /v1/reports/upvote`), passed to `mukoko-weather-places` with the
/// client's IP and the query string, and never cached.
async fn forward_community(req: &mut Request, env: &Env) -> Result<Response> {
    let method = req.method();
    let body = if method == Method::Get {
        String::new()
    } else {
        let text = req.text().await.unwrap_or_default();
        if text.len() > MAX_COMMUNITY_BODY_BYTES {
            return error(413, "payload_too_large", "The request body is too large.");
        }
        text
    };
    let path = req.path();
    let query = req
        .url()?
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let headers = Headers::new();
    headers.set("Content-Type", "application/json")?;
    headers.set("X-Mukoko-Client-IP", &client_ip(req))?;
    let mut init = RequestInit::new();
    init.with_method(method).with_headers(headers);
    if !body.is_empty() {
        init.with_body(Some(JsValue::from_str(&body)));
    }
    let inner = Request::new_with_init(
        &format!("https://places{}{query}", path.trim_start_matches("/v1")),
        &init,
    )?;
    let Ok(mut upstream) = env.service(PLACES_BINDING)?.fetch_request(inner).await else {
        return error(
            502,
            "upstream_unreachable",
            "The places service did not answer.",
        );
    };
    let status = upstream.status_code();
    match upstream.json::<Value>().await {
        Ok(body) => {
            let resp = json(status, &body)?;
            resp.headers().set("Cache-Control", "no-store")?;
            Ok(resp)
        }
        Err(_) => error(
            502,
            "upstream_malformed",
            "The places service sent a bad answer.",
        ),
    }
}

/// Shamwari's POST routes. The two reference-data GETs under `/v1/ai/` are
/// answered here, not forwarded.
fn is_ai_path(path: &str) -> bool {
    (path == "/v1/ai" || path.starts_with("/v1/ai/")) && !reference::serves(path)
}

/// Pass a Shamwari request to `mukoko-weather-ai` with the client's IP, and
/// its answer back unchanged.
async fn forward_ai(req: &mut Request, env: &Env) -> Result<Response> {
    let body = req.text().await.unwrap_or_default();
    if body.len() > MAX_AI_BODY_BYTES {
        return error(413, "payload_too_large", "The request body is too large.");
    }
    let headers = Headers::new();
    headers.set("Content-Type", "application/json")?;
    if let Some(ip) = req.headers().get("CF-Connecting-IP")? {
        headers.set("CF-Connecting-IP", &ip)?;
    }
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(JsValue::from_str(&body)));
    let inner = Request::new_with_init(&format!("https://ai{}", req.path()), &init)?;
    let Ok(mut upstream) = env.service(AI_BINDING)?.fetch_request(inner).await else {
        return error(502, "upstream_unreachable", "Shamwari did not answer.");
    };
    let status = upstream.status_code();
    match upstream.json::<Value>().await {
        Ok(body) => {
            let resp = json(status, &body)?;
            copy_header(upstream.headers(), resp.headers(), "Retry-After")?;
            Ok(resp)
        }
        Err(_) => error(502, "upstream_malformed", "Shamwari sent a bad answer."),
    }
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

    if let Some(mut upstream) = service::ask(env, FORECAST_BINDING, &q).await? {
        if upstream.status_code() == 200 {
            if let Ok(body) = upstream.json::<Value>().await {
                let resp = json(200, &body)?;
                for h in [
                    "X-Cache",
                    "X-Weather-Provider",
                    "X-Weather-Blend",
                    "X-Enrichment",
                    "X-Current-Source",
                    "X-Fetched-At",
                ] {
                    copy_header(upstream.headers(), resp.headers(), h)?;
                }
                // Only the full blend is worth five minutes at the edge. A
                // degraded answer (single model, best_match) is short-lived,
                // so the blend comes back as soon as it recovers.
                let blended = upstream.headers().get("X-Weather-Provider")?.as_deref()
                    == Some("open-meteo:blend");
                let cache = if blended {
                    "public, max-age=300"
                } else {
                    "public, max-age=30"
                };
                resp.headers().set("Cache-Control", cache)?;
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
    h.set("X-Enrichment", "none")?;
    h.set("X-Current-Source", "fallback")?;
    Ok(resp)
}

async fn forecast(req: &Request, env: &Env) -> Result<Response> {
    let pairs = query_pairs(req)?;
    if let Err(e) = ForecastQuery::parse(pairs.iter().map(|(k, v)| (k.as_str(), v.as_str()))) {
        return error(422, "invalid_request", &e.to_string());
    }
    let query = req.url()?.query().unwrap_or("").to_owned();
    let Some(mut upstream) =
        service::ask(env, FORECAST_BINDING, &format!("/daily?{query}")).await?
    else {
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
    // The Worker behind has no public route; the visitor's address lets it
    // meter a call that spends a third-party budget.
    let headers = Headers::new();
    headers.set("X-Mukoko-Client-IP", &client_ip(req))?;
    let mut init = worker::RequestInit::new();
    init.with_headers(headers);
    let Ok(mut upstream) = fetcher
        .fetch(format!("https://upstream{path}?{query}"), Some(init))
        .await
    else {
        return error(502, "upstream_unreachable", "The service did not answer.");
    };
    let status = upstream.status_code();
    if !matches!(status, 200 | 400 | 404 | 422 | 429 | 502 | 503) {
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
        // An upstream `no-store` (a degraded answer) must never be cached.
        // The converse holds too: `weather_edge::json` defaults every answer
        // to `no-store`, so the `cache_control` passed in only takes effect
        // for a route whose handler stamps its own `Cache-Control` on success
        // (`/agriculture` via `weather_core::agriculture::cache_control`, and
        // the aviation `/airports/nearest`). A route that does not (haze,
        // normals, enso, sg-air, air-quality/grid, model-grid, profile) is
        // `no-store` however it is registered here.
        let no_store = upstream
            .headers()
            .get("Cache-Control")
            .ok()
            .flatten()
            .is_some_and(|v| v == "no-store");
        resp.headers().set(
            "Cache-Control",
            if no_store { "no-store" } else { cache_control },
        )?;
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

/// How long a probe of another Worker or Open-Meteo may take.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);
/// The status payload is rebuilt at most this often (seconds).
const STATUS_TTL_S: &str = "public, max-age=60";
const OPEN_METEO_PROBE: &str =
    "https://api.open-meteo.com/v1/forecast?latitude=-17.83&longitude=31.05&current=temperature_2m";

/// `GET <binding>/health`, timed.
async fn probe_worker(env: &Env, binding: &str) -> (health::Probe, u64) {
    let started = now_ms();
    let outcome = match env.service(binding) {
        Ok(fetcher) => {
            let call = Box::pin(fetcher.fetch("https://upstream/health".to_owned(), None));
            let timer = Box::pin(worker::Delay::from(PROBE_TIMEOUT));
            match futures::future::select(call, timer).await {
                futures::future::Either::Left((Ok(resp), _)) => Some(resp),
                _ => None,
            }
        }
        Err(_) => None,
    };
    let probe = match outcome {
        Some(mut resp) if resp.status_code() == 200 => match resp.json::<Value>().await {
            Ok(body) => health::Probe::Healthy(body),
            Err(_) => health::Probe::Status(502),
        },
        Some(resp) => health::Probe::Status(resp.status_code()),
        None => health::Probe::Unreachable,
    };
    (probe, now_ms().saturating_sub(started))
}

async fn probe_open_meteo() -> (Result<Option<f64>, u16>, u64) {
    let started = now_ms();
    let outcome = match get_with_timeout(OPEN_METEO_PROBE, None, PROBE_TIMEOUT).await {
        Ok(mut resp) if resp.status_code() == 200 => Ok(resp
            .json::<Value>()
            .await
            .ok()
            .and_then(|b| b["current"]["temperature_2m"].as_f64())),
        Ok(resp) => Err(resp.status_code()),
        Err(_) => Err(0),
    };
    (outcome, now_ms().saturating_sub(started))
}

/// `GET /v1/status`: live health of the Workers and Open-Meteo, in the shape
/// the status page reads (`weather_core::status`).
async fn status(env: &Env) -> Result<Response> {
    let started = now_ms();
    let (forecast, places, aviation, ai, meteo) = futures::join!(
        probe_worker(env, FORECAST_BINDING),
        probe_worker(env, PLACES_BINDING),
        probe_worker(env, AVIATION_BINDING),
        probe_worker(env, AI_BINDING),
        probe_open_meteo(),
    );
    let mut checks = vec![health::worker_row(
        "Forecast Worker",
        &forecast.0,
        forecast.1,
    )];
    checks.extend(health::forecast_storage_row(&forecast.0, forecast.1));
    checks.extend(health::blend_row(&forecast.0, forecast.1));
    checks.push(health::enrichment_row(&forecast.0, forecast.1));
    checks.push(health::worker_row("Places Worker", &places.0, places.1));
    checks.push(health::worker_row(
        "Aviation Worker",
        &aviation.0,
        aviation.1,
    ));
    checks.push(health::ai_row(&ai.0, ai.1));
    checks.push(health::open_meteo_row(meteo.0, meteo.1));
    let body = health::payload(checks, &now_rfc3339(), now_ms().saturating_sub(started));
    let resp = json(200, &body)?;
    resp.headers().set("Cache-Control", STATUS_TTL_S)?;
    Ok(resp)
}
