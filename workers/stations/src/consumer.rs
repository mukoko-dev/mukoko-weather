//! The queue consumer: writes each batch of uploads in one D1 batch and one
//! R2 object.
//!
//! - Validated observations go to `observations` in D1, and the station's
//!   `last_observation_at` moves on.
//! - Every upload, validated or not, is archived to R2 as one NDJSON line,
//!   with credentials already removed, under
//!   `raw/YYYY/MM/DD/<first-received-ms>-<random>.ndjson`.
//!
//! On any failure the whole batch is retried. Observation ids are derived
//! from the message (station, time, source), so a retried batch does not
//! duplicate rows (`INSERT OR IGNORE`).

use std::collections::BTreeMap;

use serde_json::json;
use sha2::{Digest, Sha256};
use weather_core::station::IngestMessage;
use worker::{Env, MessageBatch, Result};

const RAW_BUCKET: &str = "RAW_OBSERVATIONS";

fn observation_id(m: &IngestMessage) -> String {
    let mut h = Sha256::new();
    h.update(m.station_id.as_bytes());
    h.update(m.received_at.to_be_bytes());
    h.update(m.source.as_bytes());
    hex::encode(&h.finalize()[..16])
}

pub async fn write_batch(batch: MessageBatch<IngestMessage>, env: &Env) -> Result<()> {
    let messages: Vec<IngestMessage> = batch
        .messages()?
        .into_iter()
        .map(|m| m.into_body())
        .collect();
    if messages.is_empty() {
        return Ok(());
    }
    match write(&messages, env).await {
        Ok(()) => batch.ack_all(),
        Err(e) => {
            worker::console_error!("stations batch write failed: {e}");
            batch.retry_all();
        }
    }
    Ok(())
}

async fn write(messages: &[IngestMessage], env: &Env) -> Result<()> {
    let db = env.d1(crate::DB)?;
    let mut statements = Vec::new();
    let mut latest: BTreeMap<&str, i64> = BTreeMap::new();
    for m in messages.iter().filter(|m| !m.validated.is_empty()) {
        let metrics = serde_json::to_string(&m.validated)?;
        statements.push(
            db.prepare(
                "INSERT OR IGNORE INTO observations \
                 (id, station_id, lat, lon, observed_at, qc_status, source_type, metrics, country_code) \
                 VALUES (?1, ?2, ?3, ?4, ?5, 'validated', ?6, ?7, ?8)",
            )
            .bind(&[
                observation_id(m).as_str().into(),
                m.station_id.as_str().into(),
                m.lat.into(),
                m.lon.into(),
                (m.received_at as f64).into(),
                m.source.as_str().into(),
                metrics.as_str().into(),
                m.country_code.as_str().into(),
            ])?,
        );
        let at = latest.entry(m.station_id.as_str()).or_insert(m.received_at);
        *at = (*at).max(m.received_at);
    }
    for (station_id, at) in latest {
        statements.push(
            db.prepare(
                "UPDATE stations SET last_observation_at = MAX(COALESCE(last_observation_at, 0), ?2), \
                 updated_at = ?2 WHERE station_id = ?1",
            )
            .bind(&[station_id.into(), (at as f64).into()])?,
        );
    }
    if !statements.is_empty() {
        db.batch(statements).await?;
    }

    let first = messages.iter().map(|m| m.received_at).min().unwrap_or(0);
    let day = chrono::DateTime::from_timestamp_millis(first)
        .unwrap_or_default()
        .format("%Y/%m/%d");
    let mut body = String::new();
    for m in messages {
        let line = json!({
            "stationId": m.station_id,
            "receivedAt": m.received_at,
            "sourceType": m.source,
            "qcStatus": if m.validated.is_empty() { "rejected" } else { "validated" },
            "countryCode": m.country_code,
            "payload": m.raw,
        });
        body.push_str(&line.to_string());
        body.push('\n');
    }
    let mut suffix = [0u8; 4];
    let _ = getrandom::getrandom(&mut suffix);
    let key = format!("raw/{day}/{first}-{}.ndjson", hex::encode(suffix));
    env.bucket(RAW_BUCKET)?
        .put(key, body.into_bytes())
        .execute()
        .await?;
    Ok(())
}
