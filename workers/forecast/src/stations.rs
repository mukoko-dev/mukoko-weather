//! StationKit ground truth: the freshest validated observation near a point
//! overlays the forecast's `current` block.
//!
//! Observations live in the weather backend's own D1 database (written by the
//! station ingest Worker; schema in `workers/d1/migrations`). Until that
//! database exists, or if the query fails, the forecast is served unchanged.

use serde::Deserialize;
use serde_json::{Map, Value};
use weather_core::geo::{bounding_box, haversine_km};
use weather_core::{normalize, station, Source};
use weather_edge::now_ms;
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

/// Overlay the nearest observation onto `data["current"]`. Returns
/// `Some(StationKit)` when one was used.
pub async fn overlay(env: &Env, data: &mut Value, lat: f64, lon: f64) -> Option<Source> {
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
