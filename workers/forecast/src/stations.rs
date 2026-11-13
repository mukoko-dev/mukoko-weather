//! StationKit ground truth: the freshest validated observation near a point
//! overlays the forecast's `current` block.
//!
//! Where the observation is read from follows `STATIONS_BACKEND`, the same
//! var the stations Worker uses (mukoko-dev/mukoko-weather#556):
//!
//! - `d1` (the default, and what this Worker has always done): the weather
//!   backend's own D1 database, written by the station ingest Worker (schema
//!   in `workers/d1/migrations`).
//! - `nyuchi`: the KV snapshot `stations:latest`, written by the stations
//!   Worker's queue consumer after each batch (the observations now live at
//!   the Nyuchi API, which this Worker does not call).
//!
//! The rule is the same in both: within 50 km of the point and no older than 60
//! minutes, the freshest wins (`weather_core::station_latest` for the KV form).
//! Whatever is missing or fails, the forecast is served unchanged; in `nyuchi`
//! mode a missing piece is also logged as an `ALERT`, because the overlay is
//! then silently off.

use std::cell::RefCell;
use std::rc::Rc;

use serde::Deserialize;
use serde_json::{Map, Value};
use weather_core::geo::{bounding_box, haversine_km};
use weather_core::station_latest::{
    Snapshot, KV_KEY, READER_MEMO_MS, READ_CACHE_TTL_SECONDS, UNAVAILABLE_ALERT,
};
use weather_core::station_service::{Backend, BACKEND_VAR};
use weather_core::{normalize, station, Source};
use weather_edge::{config, log_throttled, now_ms};
use worker::Env;

pub const DB_BINDING: &str = "WEATHER_DB";
/// Within 50 km and 60 minutes, as in the Python backend.
const MAX_DISTANCE_KM: f64 = 50.0;
const MAX_AGE_MS: u64 = 60 * 60_000;

#[derive(Deserialize)]
struct Row {
    lat: f64,
    lon: f64,
    observed_at: i64,
    metrics: String,
}

thread_local! {
    /// The snapshot as last parsed in this isolate, and when.
    static MEMO: RefCell<Option<(u64, Rc<Snapshot>)>> = const { RefCell::new(None) };
}

/// The backend, as a short word for `/health`.
pub fn backend_name(env: &Env) -> &'static str {
    match Backend::parse(config(env, BACKEND_VAR).as_deref()) {
        Ok(b) => b.as_str(),
        Err(_) => "unknown",
    }
}

/// Overlay the freshest nearby observation onto `data["current"]`. Returns
/// `Some(StationKit)` when one was used.
pub async fn overlay(env: &Env, data: &mut Value, lat: f64, lon: f64) -> Option<Source> {
    match Backend::parse(config(env, BACKEND_VAR).as_deref()) {
        Ok(Backend::D1) => overlay_d1(env, data, lat, lon).await,
        Ok(Backend::Nyuchi) => overlay_snapshot(env, data, lat, lon).await,
        // Fail closed: no overlay, and say so.
        Err(bad) => {
            log_throttled("stations_backend_unknown", true, &bad.log_line());
            None
        }
    }
}

/// The snapshot, from the isolate's memo while it is fresh, else from KV. An
/// absent key is remembered too (an empty snapshot) so a quiet network does not
/// read KV on every request; a failure is not remembered.
async fn snapshot(env: &Env) -> Option<Rc<Snapshot>> {
    let now = now_ms();
    if let Some((at, s)) = MEMO.with(|m| m.borrow().clone()) {
        if now.saturating_sub(at) < READER_MEMO_MS {
            return Some(s);
        }
    }
    let Ok(kv) = env.kv(crate::chain::CACHE_BINDING) else {
        log_throttled("stations_latest_unavailable", true, UNAVAILABLE_ALERT);
        return None;
    };
    let text = match kv
        .get(KV_KEY)
        .cache_ttl(READ_CACHE_TTL_SECONDS)
        .text()
        .await
    {
        // Nothing written yet (or it expired): the normal state before the
        // first station uploads.
        Ok(None) => None,
        Ok(Some(text)) => Some(text),
        Err(_) => {
            log_throttled(
                "stations_latest_read_failed",
                false,
                "stations_latest_read_failed: could not read stations:latest; the forecast is served without station observations",
            );
            return None;
        }
    };
    let parsed = match text {
        None => Snapshot::default(),
        Some(text) => match serde_json::from_str::<Snapshot>(&text) {
            Ok(s) => s,
            Err(_) => {
                log_throttled(
                    "stations_latest_unreadable",
                    true,
                    "ALERT stations_latest_unreadable: stations:latest is not a snapshot this Worker understands",
                );
                return None;
            }
        },
    };
    let parsed = Rc::new(parsed);
    MEMO.with(|m| *m.borrow_mut() = Some((now, parsed.clone())));
    Some(parsed)
}

/// `nyuchi` mode: the snapshot the stations Worker keeps in KV.
async fn overlay_snapshot(env: &Env, data: &mut Value, lat: f64, lon: f64) -> Option<Source> {
    let hit = snapshot(env).await?.pick(lat, lon, now_ms())?;
    let observed_at = chrono::DateTime::from_timestamp_millis(hit.observed_at)?
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    normalize::blend_station_current(data, &station::station_current(&hit.metrics, &observed_at));
    Some(Source::StationKit)
}

/// `d1` mode: the nearest observation in the weather backend's D1.
async fn overlay_d1(env: &Env, data: &mut Value, lat: f64, lon: f64) -> Option<Source> {
    let db = env.d1(DB_BINDING).ok()?;
    let (lat_min, lat_max, lon_min, lon_max) = bounding_box(lat, lon, MAX_DISTANCE_KM);
    let cutoff = now_ms().saturating_sub(MAX_AGE_MS) as f64;
    let stmt = db
        .prepare(
            "SELECT lat, lon, observed_at, metrics FROM observations \
             WHERE qc_status = 'validated' AND observed_at >= ?1 \
               AND lat BETWEEN ?2 AND ?3 AND lon BETWEEN ?4 AND ?5 \
             ORDER BY observed_at DESC LIMIT 50",
        )
        .bind(&[
            cutoff.into(),
            lat_min.into(),
            lat_max.into(),
            lon_min.into(),
            lon_max.into(),
        ])
        .ok()?;
    let rows: Vec<Row> = stmt.all().await.ok()?.results().ok()?;
    let row = rows
        .into_iter()
        .find(|r| haversine_km(lat, lon, r.lat, r.lon) <= MAX_DISTANCE_KM)?;
    let metrics: Map<String, Value> = serde_json::from_str(&row.metrics).ok()?;
    let observed_at = chrono::DateTime::from_timestamp_millis(row.observed_at)?
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    normalize::blend_station_current(data, &station::station_current(&metrics, &observed_at));
    Some(Source::StationKit)
}
