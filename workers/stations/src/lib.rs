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
//!
//! # Two backends (`STATIONS_BACKEND`)
//!
//! `d1` (the default, and what the Worker has always done) keeps the station
//! registry and the observations in this Worker's D1 database. `nyuchi` moves
//! both to the Nyuchi API (mukoko-dev/mukoko-weather#556, B2 of #293): the API
//! checks the key (`/v1/stations/service/verify`) and stores the observations
//! (`/v1/stations/service/observations`); `register` answers `410` and points
//! to the console; `manual` and `status` proxy to the API by the station's own
//! key; and the consumer keeps the KV snapshot `stations:latest` for the
//! forecast blend. The hot path is the same in both. In `nyuchi` mode an API
//! that cannot answer is a `503`, never a `401`, and anything the mode needs
//! that is missing fails closed and is logged as an `ALERT`. The rules are in
//! `weather_core::station_service`; `nyuchi.rs` is the I/O.

mod auth;
mod consumer;
mod latest;
mod limits;
mod nyuchi;

use serde::Serialize;
use serde_json::json;
use weather_core::station::{
    ecowitt_metrics, hash_ingest_key, qc_filter, scrub_raw, split_passkey, wunderground_metrics,
    IngestMessage, ManualReading, Metrics, Registration,
};
use weather_core::station_service::{
    self, Backend, Failure, ManualResult, Proxied, StationIdentity, UnknownBackend,
};
use weather_edge::{config, cors, error, json, now_ms};
use worker::{
    event, Context, Env, MessageBatch, Method, QueueContentType, RawMessageBuilder, Request,
    Response, Result, Url,
};

pub(crate) const DB: &str = "WEATHER_DB";
const QUEUE: &str = "OBSERVATIONS";
/// Where `register` points once the Nyuchi API is the backend (override with
/// the var `CONSOLE_URL`).
const CONSOLE_URL: &str = "https://weatherstations.nyuchi.com";

/// The backend this Worker runs (`STATIONS_BACKEND`): unset is `d1`.
pub(crate) fn backend(env: &Env) -> std::result::Result<Backend, UnknownBackend> {
    Backend::parse(config(env, station_service::BACKEND_VAR).as_deref())
}

#[event(fetch)]
pub async fn fetch(mut req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let path = req.path();
    let route = path.strip_prefix("/api/py").unwrap_or(&path).to_owned();
    let origin = req.headers().get("Origin")?.unwrap_or_default();
    let cors = cors::allowed_origin(&env, &origin);
    let mode = backend(&env);
    // Only read where the match below has checked it is `Ok`.
    let b = mode.clone().unwrap_or(Backend::D1);

    let resp = match (req.method(), route.as_str()) {
        (Method::Options, _) => {
            cors::preflight(cors.is_some(), "GET, POST, OPTIONS", "Content-Type")
        }
        (Method::Get, "/health") => health(&env, &mode).await,
        // An unknown STATIONS_BACKEND fails closed on every station route.
        (_, r) if r.starts_with("/stations/") && mode.is_err() => unknown_backend(&mode),
        (Method::Get, "/stations/ingest") => ingest_wunderground(&req, &env, b).await,
        (Method::Post, "/stations/ingest") => ingest_ecowitt(&mut req, &env, b).await,
        (Method::Post, "/stations/register") => register(&mut req, &env, b).await,
        (Method::Post, "/stations/manual") => manual(&mut req, &env, b).await,
        (Method::Get, "/stations/status") => status(&req, &env, b).await,
        _ => error(404, "not_found", "No such route."),
    }?;
    cors::apply(resp, cors.as_deref(), None)
}

#[event(queue)]
pub async fn queue(batch: MessageBatch<IngestMessage>, env: Env, _ctx: Context) -> Result<()> {
    consumer::write_batch(batch, &env).await
}

fn text(status: u16, body: &str) -> Result<Response> {
    let resp = Response::ok(body)?.with_status(status);
    resp.headers().set("Cache-Control", "no-store")?;
    Ok(resp)
}

/// `Retry-After` on an answer that asks the caller to come back.
fn retry_later(resp: Result<Response>) -> Result<Response> {
    let resp = resp?;
    resp.headers()
        .set("Retry-After", &Failure::RETRY_AFTER_SECONDS.to_string())?;
    Ok(resp)
}

/// The backend could not judge the upload (and has logged why): `503`, never
/// `401`, so a good station keeps its key and tries again.
fn unavailable_text() -> Result<Response> {
    retry_later(text(Failure::STATION_STATUS, "service unavailable"))
}

fn unavailable_json() -> Result<Response> {
    retry_later(error(
        Failure::STATION_STATUS,
        "unavailable",
        "The station service is not available right now. Try again shortly.",
    ))
}

/// `STATIONS_BACKEND` is neither `d1` nor `nyuchi`: fail closed, and say so.
fn unknown_backend(mode: &std::result::Result<Backend, UnknownBackend>) -> Result<Response> {
    if let Err(bad) = mode {
        nyuchi::report_unknown(bad);
    }
    retry_later(error(
        Failure::STATION_STATUS,
        "misconfigured",
        "The station service is misconfigured.",
    ))
}

async fn health(
    env: &Env,
    mode: &std::result::Result<Backend, UnknownBackend>,
) -> Result<Response> {
    // Always 200 (the deploy's smoke check reads it). `status` says whether the
    // chosen backend can work; what is missing is in the `ALERT` log line, not
    // in this public body.
    let (backend, status) = match mode {
        Ok(Backend::D1) => (json!("d1"), "ok"),
        Ok(Backend::Nyuchi) => {
            let ready = nyuchi::Present::of(env).await.missing().is_empty();
            (json!("nyuchi"), if ready { "ok" } else { "misconfigured" })
        }
        Err(_) => (json!(null), "misconfigured"),
    };
    json(
        200,
        &json!({"service": "mukoko-weather-stations", "status": status, "backend": backend}),
    )
}

/// Put one accepted upload on the queue.
///
/// **`nyuchi` mode** sends the message with its maps (`validated`, `raw`) as
/// plain JS objects. `Queue::send` serialises a Rust map to a JS `Map`, and the
/// queue's JSON content type turns a `Map` into `{}`: the consumer then gets an
/// upload with no metrics and no raw payload. Seen in a local workerd run with
/// `STATIONS_BACKEND=d1` (mukoko-dev/mukoko-weather#558); the consumer reads
/// the object form.
///
/// **`d1` mode** still sends it exactly as before B2, so that mode's behaviour
/// does not change until the owner decides (#558 has the one-line fix and what
/// it would change).
async fn queue_message(env: &Env, backend: Backend, msg: &IngestMessage) -> Result<()> {
    let queue = env.queue(QUEUE)?;
    match backend {
        Backend::D1 => queue.send(msg).await,
        Backend::Nyuchi => {
            let plain = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
            let body = msg.serialize(&plain)?;
            queue
                .send_raw(
                    RawMessageBuilder::new(body).build_with_content_type(QueueContentType::Json),
                )
                .await
        }
    }
}

/// QC the metrics and queue the upload. The raw record is archived even when
/// nothing passes QC.
async fn enqueue(
    env: &Env,
    backend: Backend,
    station: &StationIdentity,
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
    queue_message(env, backend, &msg).await?;
    Ok(accepted)
}

async fn ingest_wunderground(req: &Request, env: &Env, backend: Backend) -> Result<Response> {
    let url = req.url()?;
    let pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let get = |k: &str| pairs.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
    let id = get("ID").unwrap_or_default();
    let key = get("PASSWORD").unwrap_or_default();
    let station = match auth::authenticate(env, backend, &id, &key).await? {
        auth::Outcome::Station(station) => station,
        auth::Outcome::Denied => return text(401, "unauthorized"),
        auth::Outcome::Unavailable => return unavailable_text(),
    };
    let metrics = wunderground_metrics(get);
    let raw = scrub_raw(pairs.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    enqueue(env, backend, &station, &metrics, raw, "wunderground").await?;
    // The Wunderground protocol expects the literal body "success".
    text(200, "success")
}

async fn ingest_ecowitt(req: &mut Request, env: &Env, backend: Backend) -> Result<Response> {
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
    let station = match auth::authenticate(env, backend, id, key).await? {
        auth::Outcome::Station(station) => station,
        auth::Outcome::Denied => return text(401, "unauthorized"),
        auth::Outcome::Unavailable => return unavailable_text(),
    };
    let metrics = ecowitt_metrics(get);
    let raw = scrub_raw(pairs.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    enqueue(env, backend, &station, &metrics, raw, "ecowitt").await?;
    text(200, "success")
}

async fn manual(req: &mut Request, env: &Env, backend: Backend) -> Result<Response> {
    let Some(ip) = weather_edge::client_ip(req) else {
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
    if backend == Backend::Nyuchi {
        return manual_via_api(env, &reading, &metrics).await;
    }
    let Some(station) = auth::find_station(env, &reading.station_id, &reading.key)
        .await?
        .map(|s| s.identity())
    else {
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
    let accepted = enqueue(env, backend, &station, &metrics, raw, "manual").await?;
    let qc = if accepted > 0 {
        "validated"
    } else {
        "rejected"
    };
    json(200, &json!({"accepted": accepted, "qcStatus": qc}))
}

/// `nyuchi` mode: a thin proxy. The reading goes to the API's
/// `POST /v1/stations/{id}/readings` with the station's own key as the bearer;
/// the API judges the key and the reading. The answer keeps the shape legacy
/// clients read (`accepted`: measurements, `qcStatus`), and an unknown station
/// or key is the same `401` as before. The per-client limit above still
/// applies, so one client cannot spend the API's shared allowance for this
/// Worker's address.
async fn manual_via_api(env: &Env, reading: &ManualReading, metrics: &Metrics) -> Result<Response> {
    if !station_service::plausible_credentials(&reading.station_id, &reading.key) {
        return error(401, "unauthorized", "Unknown station or key");
    }
    let base = match nyuchi::base_url(env) {
        Ok(base) => base,
        Err(f) => {
            nyuchi::report(&f);
            return unavailable_json();
        }
    };
    match nyuchi::manual(&base, &reading.station_id, &reading.key, metrics).await {
        Ok(Proxied::Done(ManualResult::Accepted)) => {
            let accepted = metrics.values().flatten().count();
            json(200, &json!({"accepted": accepted, "qcStatus": "validated"}))
        }
        Ok(Proxied::Done(ManualResult::Rejected { detail })) => {
            error(422, "invalid_request", &detail)
        }
        Ok(Proxied::Denied) => error(401, "unauthorized", "Unknown station or key"),
        Err(f) => {
            nyuchi::report(&f);
            unavailable_json()
        }
    }
}

fn random_bytes<const N: usize>() -> Result<[u8; N]> {
    let mut b = [0u8; N];
    getrandom::getrandom(&mut b).map_err(|e| worker::Error::RustError(e.to_string()))?;
    Ok(b)
}

async fn register(req: &mut Request, env: &Env, backend: Backend) -> Result<Response> {
    if backend == Backend::Nyuchi {
        // Anonymous registration ended (owner decision O-S3): a station has an
        // owner, so it is registered in the console, signed in.
        let console = config(env, "CONSOLE_URL").unwrap_or_else(|| CONSOLE_URL.to_owned());
        return error(
            410,
            "gone",
            &format!(
                "Station registration moved to the StationKit console: {console}. \
                 Sign in there to register a station."
            ),
        );
    }
    let Some(ip) = weather_edge::client_ip(req) else {
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

async fn status(req: &Request, env: &Env, backend: Backend) -> Result<Response> {
    let url: Url = req.url()?;
    let get = |k: &str| {
        url.query_pairs()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.into_owned())
            .unwrap_or_default()
    };
    if backend == Backend::Nyuchi {
        return status_via_api(env, &get("id"), &get("key")).await;
    }
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

/// `nyuchi` mode: a thin proxy to `GET /v1/stations/{id}` with the station's
/// own key as the bearer. The API's answer (the station and its latest
/// metrics: a superset of the fields `status` has always had, and never a key,
/// a digest or an owner id) is passed on; an unknown station or key is the
/// same `401` as before.
async fn status_via_api(env: &Env, id: &str, key: &str) -> Result<Response> {
    if !station_service::plausible_credentials(id, key) {
        return error(401, "unauthorized", "Unknown station or key");
    }
    let base = match nyuchi::base_url(env) {
        Ok(base) => base,
        Err(f) => {
            nyuchi::report(&f);
            return unavailable_json();
        }
    };
    match nyuchi::status(&base, id, key).await {
        Ok(Proxied::Done(body)) => json(200, &body),
        Ok(Proxied::Denied) => error(401, "unauthorized", "Unknown station or key"),
        Err(f) => {
            nyuchi::report(&f);
            unavailable_json()
        }
    }
}
