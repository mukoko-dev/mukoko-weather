//! The queue consumer: writes each batch of uploads, and archives it in one
//! R2 object. Where the observations go depends on `STATIONS_BACKEND`.
//!
//! **`d1`** (the default, today's behaviour):
//!
//! - Validated observations go to `observations` in D1, and the station's
//!   `last_observation_at` moves on, in one D1 batch.
//! - Every upload, validated or not, is archived to R2 as one NDJSON line,
//!   with credentials already removed, under
//!   `raw/YYYY/MM/DD/<first-received-ms>-<random>.ndjson`.
//!
//! **`nyuchi`**:
//!
//! - The batch goes to the Nyuchi API's `POST /v1/stations/service/observations`
//!   (chunks of at most 500), which runs quality control again, derives the
//!   ids and moves each station's `lastSeenAt`. Each item is judged alone, so a
//!   rejected one (a station deactivated since its key was cached) is logged
//!   and not retried.
//! - The latest validated observation per station is folded into the KV
//!   snapshot `stations:latest` for the forecast blend (`latest`).
//! - The same R2 archive.
//!
//! On any failure the whole batch is retried. Observation ids are derived
//! from the message (station, time, source), so a retried batch does not
//! duplicate rows (`INSERT OR IGNORE` in D1; `duplicate` at the API). A
//! failure of the API is retried after a pause, not at once, and logged; the
//! queue's dead-letter queue catches a batch that outlasts the retries.

use std::collections::BTreeMap;

use serde_json::json;
use sha2::{Digest, Sha256};
use weather_core::station::IngestMessage;
use weather_core::station_latest::entry_of;
use weather_core::station_service::{
    observation_items, request_chunks, Backend, BatchSummary, Failure, ObservationItem,
};
use worker::{console_warn, Env, MessageBatch, QueueRetryOptionsBuilder, Result};

use crate::nyuchi::{self, Service};

const RAW_BUCKET: &str = "RAW_OBSERVATIONS";
/// How long a batch waits before the queue offers it again after the API
/// failed. The retries then span minutes, not the second or two an immediate
/// retry takes; with `max_retries` 10, an outage longer than about five
/// minutes reaches the dead-letter queue.
const API_RETRY_DELAY_SECONDS: u32 = 30;

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
    let after_api_failure = || {
        QueueRetryOptionsBuilder::new()
            .with_delay_seconds(API_RETRY_DELAY_SECONDS)
            .build()
    };
    match crate::backend(env) {
        Ok(Backend::D1) => match write(&messages, env).await {
            Ok(()) => batch.ack_all(),
            Err(e) => {
                worker::console_error!("stations batch write failed: {e}");
                batch.retry_all();
            }
        },
        Ok(Backend::Nyuchi) => match write_nyuchi(&messages, env).await {
            Ok(()) => batch.ack_all(),
            Err(WriteError::Api(f)) => {
                nyuchi::report(&f);
                batch.retry_all_with_options(&after_api_failure());
            }
            Err(WriteError::Other(e)) => {
                worker::console_error!("stations batch write failed: {e}");
                batch.retry_all();
            }
        },
        // An unknown STATIONS_BACKEND fails closed: nothing is written
        // anywhere, and the batch stays in the queue until it is fixed.
        Err(bad) => {
            nyuchi::report_unknown(&bad);
            batch.retry_all_with_options(&after_api_failure());
        }
    }
    Ok(())
}

/// Why a `nyuchi` batch was not written.
enum WriteError {
    /// The API could not take it (already classified; see [`Failure`]).
    Api(Failure),
    /// The R2 archive.
    Other(worker::Error),
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

    archive(messages, env).await
}

/// Write the whole batch to R2 as NDJSON, credentials already removed.
async fn archive(messages: &[IngestMessage], env: &Env) -> Result<()> {
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

/// The `nyuchi` write: the API, then the blend snapshot, then the archive.
async fn write_nyuchi(
    messages: &[IngestMessage],
    env: &Env,
) -> std::result::Result<(), WriteError> {
    // Fail closed: without the API URL, the Worker's key and the KV binding the
    // mode is not working, and nothing is acknowledged.
    let service = Service::load(env).await.map_err(WriteError::Api)?;

    // Every message goes, including one with nothing in range: the API judges
    // it and still moves the station's `lastSeenAt`.
    let mut stored = vec![false; messages.len()];
    for chunk in request_chunks(observation_items(messages)) {
        let items: Vec<&ObservationItem> = chunk.iter().map(|(_, item)| item).collect();
        let outcomes = service
            .write_observations(&items)
            .await
            .map_err(WriteError::Api)?;
        let summary = BatchSummary::of(&items, &outcomes);
        if summary.is_unusual() {
            console_warn!("{}", summary.log_line());
        }
        for ((at, _), outcome) in chunk.iter().zip(&outcomes) {
            stored[*at] = outcome.accepted();
        }
    }

    // What the API holds now is what the forecast may blend. A failure here is
    // logged by `latest` and does not fail the batch.
    let entries = messages
        .iter()
        .zip(&stored)
        .filter(|(_, held)| **held)
        .filter_map(|(m, _)| entry_of(m))
        .collect();
    crate::latest::update(env, entries).await;

    archive(messages, env).await.map_err(WriteError::Other)
}
