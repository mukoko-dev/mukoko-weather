//! `mukoko-weather-stations`: weather-station registration and ingest.
//!
//! The paths and protocols are those of `api/py/_stations.py`, so a station
//! console only has to change its upload host:
//!
//! ```text
//! POST /api/py/stations/register   JSON; the ingest key is shown once, only its hash is stored
//! GET  /api/py/stations/ingest     Wunderground protocol (ID, PASSWORD, imperial query)
//! POST /api/py/stations/ingest     Ecowitt protocol (form; PASSKEY=<stationId>:<key>)
//! POST /api/py/stations/manual     JSON reading from an analog station
//! GET  /api/py/stations/status     ?id=&key=, for the station console
//! ```
//!
//! The same routes are served without the `/api/py` prefix.
//!
//! The hot path does only the work an upload needs:
//!
//! 1. authenticate (PBKDF2, with the result cached for 10 minutes in the
//!    isolate);
//! 2. run QC;
//! 3. put one message on the `OBSERVATIONS` queue;
//! 4. answer `success`.
//!
//! The queue consumer, in this same Worker, then writes each batch: validated
//! observations to D1, and the raw uploads, with credentials removed, to R2
//! as NDJSON.

mod auth;
mod consumer;
mod limits;

use serde_json::json;
use weather_core::station::{
    ecowitt_metrics, hash_ingest_key, qc_filter, scrub_raw, split_passkey, wunderground_metrics,
    IngestMessage, ManualReading, Metrics, Registration,
};
use weather_edge::{config, error, json, now_ms};
use worker::{event, Context, Env, MessageBatch, Method, Request, Response, Result, Url};

pub(crate) const DB: &str = "WEATHER_DB";
const QUEUE: &str = "OBSERVATIONS";

#[event(fetch)]
pub async fn fetch(mut req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let path = req.path();
    let route = path.strip_prefix("/api/py").unwrap_or(&path).to_owned();
    let origin = req.headers().get("Origin")?.unwrap_or_default();
    let cors = cors_origin(&env, &origin);

    let resp = match (req.method(), route.as_str()) {
        (Method::Options, _) => preflight(cors.is_some()),
        (Method::Get, "/health") => json(
            200,
            &json!({"service": "mukoko-weather-stations", "status": "ok"}),
        ),
        (Method::Get, "/stations/ingest") => ingest_wunderground(&req, &env).await,
        (Method::Post, "/stations/ingest") => ingest_ecowitt(&mut req, &env).await,
        (Method::Post, "/stations/register") => register(&mut req, &env).await,
        (Method::Post, "/stations/manual") => manual(&mut req, &env).await,
        (Method::Get, "/stations/status") => status(&req, &env).await,
        _ => error(404, "not_found", "No such route."),
    }?;
    with_cors(resp, cors.as_deref())
}

#[event(queue)]
pub async fn queue(batch: MessageBatch<IngestMessage>, env: Env, _ctx: Context) -> Result<()> {
    consumer::write_batch(batch, &env).await
}

fn cors_origin(env: &Env, origin: &str) -> Option<String> {
    let allowed = config(env, "CORS_ORIGINS").unwrap_or_default();
    let allow_local = config(env, "ENVIRONMENT").as_deref() != Some("production");
    weather_core::cors::origin_allowed(origin, &allowed, allow_local).then(|| origin.to_owned())
}

fn preflight(allowed: bool) -> Result<Response> {
    let resp = Response::empty()?.with_status(if allowed { 204 } else { 403 });
    if allowed {
        let h = resp.headers();
        h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")?;
        h.set("Access-Control-Allow-Headers", "Content-Type")?;
        h.set("Access-Control-Max-Age", "86400")?;
    }
    Ok(resp)
}

fn with_cors(resp: Response, origin: Option<&str>) -> Result<Response> {
    resp.headers().append("Vary", "Origin")?;
    if let Some(o) = origin {
        resp.headers().set("Access-Control-Allow-Origin", o)?;
    }
    Ok(resp)
}

fn text(status: u16, body: &str) -> Result<Response> {
    let resp = Response::ok(body)?.with_status(status);
    resp.headers().set("Cache-Control", "no-store")?;
    Ok(resp)
}

fn client_ip(req: &Request) -> Option<String> {
    req.headers().get("CF-Connecting-IP").ok().flatten()
}

/// QC the metrics and queue the upload. The raw record is archived even when
/// nothing passes QC.
async fn enqueue(
    env: &Env,
    station: &auth::Station,
    metrics: &Metrics,
    raw: serde_json::Map<String, serde_json::Value>,
    source: &str,
) -> Result<usize> {
    let validated: std::collections::BTreeMap<String, f64> = qc_filter(metrics)
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v))
        .collect();
    let accepted = validated.len();
    let msg = IngestMessage {
        station_id: station.station_id.clone(),
        lat: station.lat,
        lon: station.lon,
        country_code: station.country_code.clone(),
        received_at: now_ms() as i64,
        source: source.to_owned(),
        validated,
        raw,
    };
    env.queue(QUEUE)?.send(&msg).await?;
    Ok(accepted)
}

async fn ingest_wunderground(req: &Request, env: &Env) -> Result<Response> {
    let url = req.url()?;
    let pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let get = |k: &str| pairs.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
    let id = get("ID").unwrap_or_default();
    let key = get("PASSWORD").unwrap_or_default();
    let Some(station) = auth::find_station(env, &id, &key).await? else {
        return text(401, "unauthorized");
    };
    let metrics = wunderground_metrics(get);
    let raw = scrub_raw(pairs.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    enqueue(env, &station, &metrics, raw, "wunderground").await?;
    // The Wunderground protocol expects the literal body "success".
    text(200, "success")
}

async fn ingest_ecowitt(req: &mut Request, env: &Env) -> Result<Response> {
    let Ok(body) = req.text().await else {
        return text(400, "bad request");
    };
    if body.len() > 16 * 1024 {
        return text(413, "too large");
    }
    let pairs: Vec<(String, String)> = worker::url::form_urlencoded::parse(body.as_bytes())
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let get = |k: &str| pairs.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
    let passkey = get("PASSKEY").unwrap_or_default();
    let (id, key) = split_passkey(&passkey);
    let Some(station) = auth::find_station(env, id, key).await? else {
        return text(401, "unauthorized");
    };
    let metrics = ecowitt_metrics(get);
    let raw = scrub_raw(pairs.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    enqueue(env, &station, &metrics, raw, "ecowitt").await?;
    text(200, "success")
}

async fn manual(req: &mut Request, env: &Env) -> Result<Response> {
    let Some(ip) = client_ip(req) else {
        return error(400, "invalid_request", "Could not determine client IP");
    };
    let reading: ManualReading = match req.json().await {
        Ok(r) => r,
        Err(_) => return error(422, "invalid_request", "Send a JSON reading."),
    };
    let metrics = match reading.metrics() {
        Ok(m) => m,
        Err(msg) => return error(422, "invalid_request", &msg),
    };
    if !limits::allow(env, &ip, "station-manual", 12).await? {
        return error(429, "rate_limited", "Too many readings — try again later");
    }
    let Some(station) = auth::find_station(env, &reading.station_id, &reading.key).await? else {
        return error(401, "unauthorized", "Unknown station or key");
    };
    let mut raw = serde_json::Map::new();
    for (k, v) in &metrics {
        if let Some(v) = v {
            raw.insert((*k).to_owned(), json!(v));
        }
    }
    if let Some(n) = &reading.notes {
        raw.insert("notes".into(), json!(n));
    }
    let accepted = enqueue(env, &station, &metrics, raw, "manual").await?;
    let qc = if accepted > 0 {
        "validated"
    } else {
        "rejected"
    };
    json(200, &json!({"accepted": accepted, "qcStatus": qc}))
}

fn random_bytes<const N: usize>() -> Result<[u8; N]> {
    let mut b = [0u8; N];
    getrandom::getrandom(&mut b).map_err(|e| worker::Error::RustError(e.to_string()))?;
    Ok(b)
}

async fn register(req: &mut Request, env: &Env) -> Result<Response> {
    let Some(ip) = client_ip(req) else {
        return error(400, "invalid_request", "Could not determine client IP");
    };
    let body: Registration = match req.json().await {
        Ok(b) => b,
        Err(_) => return error(422, "invalid_request", "Send a JSON registration."),
    };
    if let Err(msg) = body.validate() {
        return error(422, "invalid_request", &msg);
    }
    if !limits::allow(env, &ip, "station-register", 3).await? {
        return error(
            429,
            "rate_limited",
            "Too many station registrations — try again later",
        );
    }

    use base64::Engine;
    let station_id = format!("mws-{}", hex::encode(random_bytes::<4>()?));
    let ingest_key = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random_bytes::<24>()?);
    let salt = hex::encode(random_bytes::<16>()?);
    let now = now_ms() as f64;
    let hardware = body
        .hardware
        .as_deref()
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .map(str::to_owned);

    let db = env.d1(DB)?;
    db.prepare(
        "INSERT INTO stations (station_id, name, lat, lon, elevation, station_type, hardware, \
         country_code, status, ingest_key_hash, ingest_key_salt, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active', ?9, ?10, ?11, ?11)",
    )
    .bind(&[
        station_id.as_str().into(),
        body.name.trim().into(),
        body.lat.into(),
        body.lon.into(),
        body.elevation
            .map_or(worker::wasm_bindgen::JsValue::NULL, Into::into),
        body.station_type.as_str().into(),
        hardware
            .as_deref()
            .map_or(worker::wasm_bindgen::JsValue::NULL, Into::into),
        body.country_code().as_str().into(),
        hash_ingest_key(&ingest_key, &salt).as_str().into(),
        salt.as_str().into(),
        now.into(),
    ])?
    .run()
    .await?;

    let host = config(env, "INGEST_HOST").unwrap_or_else(|| "weather-ingest.nyuchi.com".into());
    // The full key is returned exactly once; only its hash is stored.
    json(
        200,
        &json!({
            "stationId": station_id,
            "ingestKey": ingest_key,
            "stationType": body.station_type,
            "ingest": {
                "wunderground": {
                    "server": host,
                    "path": "/api/py/stations/ingest",
                    "params": "ID=<stationId>&PASSWORD=<ingestKey>",
                },
                "ecowitt": {
                    "server": host,
                    "path": "/api/py/stations/ingest",
                    "note": "Set the customized upload PASSKEY to <stationId>:<ingestKey>",
                },
            },
        }),
    )
}

async fn status(req: &Request, env: &Env) -> Result<Response> {
    let url: Url = req.url()?;
    let get = |k: &str| {
        url.query_pairs()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.into_owned())
            .unwrap_or_default()
    };
    let Some(station) = auth::find_station(env, &get("id"), &get("key")).await? else {
        return error(401, "unauthorized", "Unknown station or key");
    };
    let db = env.d1(DB)?;
    let latest: Option<String> = db
        .prepare(
            "SELECT metrics FROM observations WHERE station_id = ?1 \
             ORDER BY observed_at DESC LIMIT 1",
        )
        .bind(&[station.station_id.as_str().into()])?
        .first(Some("metrics"))
        .await
        .ok()
        .flatten();
    let latest_metrics = latest.and_then(|m| serde_json::from_str::<serde_json::Value>(&m).ok());
    let last_at = station
        .last_observation_at
        .and_then(chrono::DateTime::from_timestamp_millis)
        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
    json(
        200,
        &json!({
            "stationId": station.station_id,
            "name": station.name,
            "stationType": station.station_type,
            "status": station.status,
            "lastObservationAt": last_at,
            "latestMetrics": latest_metrics,
        }),
    )
}
