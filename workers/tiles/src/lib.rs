//! `mukoko-weather-tiles`: weather map overlay tiles.
//!
//! Ported from `api/py/_tiles.py`. It proxies Tomorrow.io overlay tiles so
//! the provider key stays server-side, on the same path and query as the
//! Python route, so the app only changes its base URL:
//!
//! ```text
//! GET /api/py/map-tiles?z=&x=&y=&layer=[&timestamp=now|YYYY-MM-DDTHH:MM:SSZ]
//! GET /v1/map-tiles?…                  the same, under the API's prefix
//! GET /health
//! 200 image/png   X-Cache: HIT | MISS | STALE, X-Map-Layer; or the 1x1
//!                 transparent tile (X-Map-Tile: empty) when nothing can be served
//! 400 bad layer, zoom, tile or timestamp   422 missing or non-integer z/x/y/layer
//! 429 over the per-IP limit                503 no Tomorrow.io key configured
//! ```
//!
//! Caching, cheapest first:
//!
//! 1. the Cache API in this data centre, per tile and hour;
//! 2. KV (`tile:v1:{layer}/{z}/{x}/{y}/{hour}`), fresh for 90 minutes and
//!    kept for a day as a stale fallback;
//! 3. Tomorrow.io, behind a circuit breaker. When it fails or rate limits,
//!    a stale tile is served if one exists, otherwise a transparent tile, so
//!    the layer degrades instead of erroring.

use std::cell::RefCell;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use weather_core::breaker::{self, Breaker};
use weather_core::cors::origin_allowed;
use weather_core::tiles::{self, TileRequest};
use weather_edge::{config, error, get_with_timeout, json, now, now_ms, query_pairs};
use worker::{event, Cache, Context, Env, Method, Request, Response, Result};

const KV_BINDING: &str = "TILE_CACHE";
const RATE_LIMITER: &str = "RATE_LIMITER";
const KEY_SECRET: &str = "TOMORROW_API_KEY";
/// Stale tiles are kept this long in KV.
const KV_TTL_SECONDS: u64 = 86_400;
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(8);

thread_local! {
    static TOMORROW: RefCell<Breaker> = const { RefCell::new(Breaker::new(breaker::TOMORROW)) };
}

#[derive(Serialize, Deserialize)]
struct Meta {
    fetched_ms: u64,
}

#[event(fetch)]
pub async fn fetch(req: Request, env: Env, ctx: Context) -> Result<Response> {
    let origin = req.headers().get("Origin")?.unwrap_or_default();
    let allowed = config(&env, "CORS_ORIGINS").unwrap_or_default();
    let allow_local = config(&env, "ENVIRONMENT").as_deref() != Some("production");
    let cors = origin_allowed(&origin, &allowed, allow_local).then_some(origin);

    let resp = if req.method() == Method::Options {
        preflight(cors.is_some())
    } else if req.method() != Method::Get {
        error(405, "method_not_allowed", "Only GET is served.")
    } else {
        match req.path().as_str() {
            "/health" => json(
                200,
                &serde_json::json!({"service": "mukoko-weather-tiles", "status": "ok"}),
            ),
            "/api/py/map-tiles" | "/v1/map-tiles" => match rate_limited(&req, &env).await {
                Some(limited) => limited,
                None => tile(&req, &env, &ctx).await,
            },
            _ => error(404, "not_found", "No such route."),
        }
    }?;
    with_cors(resp, cors.as_deref())
}

fn preflight(allowed: bool) -> Result<Response> {
    let resp = Response::empty()?.with_status(if allowed { 204 } else { 403 });
    if allowed {
        let h = resp.headers();
        h.set("Access-Control-Allow-Methods", "GET, OPTIONS")?;
        h.set("Access-Control-Allow-Headers", "Content-Type")?;
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
            "X-Cache, X-Map-Layer, X-Map-Tile",
        )?;
    }
    Ok(resp)
}

/// `Some(429)` when the client is over its limit. A missing limiter binding
/// (local dev) does not block.
async fn rate_limited(req: &Request, env: &Env) -> Option<Result<Response>> {
    let limiter = env.rate_limiter(RATE_LIMITER).ok()?;
    let key = req
        .headers()
        .get("CF-Connecting-IP")
        .ok()
        .flatten()
        .unwrap_or_else(|| "unknown".to_owned());
    match limiter.limit(key).await {
        Ok(outcome) if !outcome.success => {
            let resp = error(429, "rate_limited", "Too many tile requests; slow down.");
            if let Ok(r) = &resp {
                let _ = r.headers().set("Retry-After", "60");
            }
            Some(resp)
        }
        _ => None,
    }
}

fn png(bytes: Vec<u8>, cache_control: &str) -> Result<Response> {
    let resp = Response::from_bytes(bytes)?;
    let h = resp.headers();
    h.set("Content-Type", "image/png")?;
    h.set("Cache-Control", cache_control)?;
    Ok(resp)
}

fn tile_response(bytes: Vec<u8>, layer: &str, cache: &str) -> Result<Response> {
    let resp = png(bytes, tiles::TILE_CACHE_CONTROL)?;
    resp.headers().set("X-Map-Layer", layer)?;
    resp.headers().set("X-Cache", cache)?;
    Ok(resp)
}

fn stale_response(bytes: Vec<u8>, layer: &str) -> Result<Response> {
    let resp = png(bytes, tiles::FALLBACK_CACHE_CONTROL)?;
    resp.headers().set("X-Map-Layer", layer)?;
    resp.headers().set("X-Cache", "STALE")?;
    Ok(resp)
}

fn empty_response() -> Result<Response> {
    let resp = png(
        tiles::TRANSPARENT_PNG.to_vec(),
        tiles::FALLBACK_CACHE_CONTROL,
    )?;
    resp.headers().set("X-Cache", "MISS")?;
    resp.headers().set("X-Map-Tile", "empty")?;
    Ok(resp)
}

/// The Cache API key: a synthetic URL per tile and hour, never the client's
/// URL, so query order or extra parameters cannot split the cache.
fn edge_key(id: &str) -> String {
    format!("https://tiles.cache.internal/{id}.png")
}

async fn tile(req: &Request, env: &Env, ctx: &Context) -> Result<Response> {
    let pairs = query_pairs(req)?;
    let t = match TileRequest::parse(pairs.iter().map(|(k, v)| (k.as_str(), v.as_str()))) {
        Ok(t) => t,
        Err(e) => return error(e.status, "invalid_request", e.message),
    };
    let id = t.cache_id(now());
    let edge = Cache::default();

    // 1. This data centre's cache.
    if let Ok(Some(mut hit)) = edge.get(edge_key(&id), false).await {
        if let Ok(bytes) = hit.bytes().await {
            return tile_response(bytes, &t.layer, "HIT");
        }
    }

    // 2. KV: fresh, or kept as the stale fallback.
    let kv = env.kv(KV_BINDING).ok();
    let kv_key = format!("tile:v1:{id}");
    let mut stale: Option<Vec<u8>> = None;
    if let Some(kv) = &kv {
        if let Ok((Some(bytes), meta)) = kv.get(&kv_key).bytes_with_metadata::<Meta>().await {
            if meta.is_some_and(|m| tiles::is_fresh(m.fetched_ms, now_ms())) {
                put_edge(ctx, &edge_key(&id), &bytes, &t.layer);
                return tile_response(bytes, &t.layer, "HIT");
            }
            stale = Some(bytes);
        }
    }

    // 3. Tomorrow.io.
    let Some(api_key) = config(env, KEY_SECRET) else {
        return error(503, "not_configured", "Map service unavailable");
    };
    let fallback = |stale: Option<Vec<u8>>| match stale {
        Some(bytes) => stale_response(bytes, &t.layer),
        None => empty_response(),
    };
    if !TOMORROW.with(|b| b.borrow_mut().allow(now_ms())) {
        return fallback(stale);
    }
    let fetched = match get_with_timeout(&t.upstream_url(&api_key), None, UPSTREAM_TIMEOUT).await {
        Ok(mut resp) if resp.status_code() == 200 => {
            resp.bytes().await.ok().filter(|b| !b.is_empty())
        }
        Ok(resp) => {
            // Status and layer only: never the URL, which carries the key.
            worker::console_warn!(
                "tile upstream status={} layer={}",
                resp.status_code(),
                t.layer
            );
            None
        }
        Err(_) => None,
    };
    TOMORROW.with(|b| {
        let mut b = b.borrow_mut();
        if fetched.is_some() {
            b.record_success();
        } else {
            b.record_failure(now_ms());
        }
    });
    let Some(bytes) = fetched else {
        return fallback(stale);
    };

    if let Some(kv) = kv {
        let body = bytes.clone();
        ctx.wait_until(async move {
            if let Ok(put) = kv.put_bytes(&kv_key, &body) {
                if let Ok(put) = put.metadata(Meta {
                    fetched_ms: now_ms(),
                }) {
                    let _ = put.expiration_ttl(KV_TTL_SECONDS).execute().await;
                }
            }
        });
    }
    put_edge(ctx, &edge_key(&id), &bytes, &t.layer);
    tile_response(bytes, &t.layer, "MISS")
}

/// Store a tile in this data centre's cache for the fresh window.
fn put_edge(ctx: &Context, key: &str, bytes: &[u8], layer: &str) {
    let Ok(resp) = Response::from_bytes(bytes.to_vec()) else {
        return;
    };
    let h = resp.headers();
    if h.set("Content-Type", "image/png").is_err()
        || h.set(
            "Cache-Control",
            &format!("public, max-age={}", tiles::FRESH_SECONDS),
        )
        .is_err()
        || h.set("X-Map-Layer", layer).is_err()
    {
        return;
    }
    let key = key.to_owned();
    ctx.wait_until(async move {
        let _ = Cache::default().put(key, resp).await;
    });
}
