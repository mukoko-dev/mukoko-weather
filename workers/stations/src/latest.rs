//! The `stations:latest` KV snapshot (`nyuchi` mode only): the latest
//! validated observation per active station, for the forecast Worker's blend
//! (`weather_core::station_latest` holds the rules and the shape).
//!
//! The queue consumer calls [`update`] after the API has stored a batch. It is
//! derived and disposable: a failure here never fails the batch (the API
//! already holds the observations), it is logged and the next batch tries
//! again. It reads the namespace the forecast Worker caches in, under its own
//! key (`stations:latest`), so there is no new store to create.

use weather_core::station_latest::{Entry, Snapshot, KV_KEY, KV_TTL_SECONDS};
use weather_edge::now_ms;
use worker::Env;

use crate::nyuchi::{log_throttled, LATEST_KV};

/// Fold `entries` (each station's newest observation of the batch) into the
/// snapshot and write it back.
pub async fn update(env: &Env, entries: Vec<(String, Entry)>) {
    if entries.is_empty() {
        return;
    }
    let Ok(kv) = env.kv(LATEST_KV) else {
        // Checked when the mode's configuration is loaded, so this is a binding
        // that vanished mid-flight: say so loudly.
        log_throttled(
            "stations_latest_unavailable",
            true,
            "ALERT stations_latest_unavailable: the KV binding for stations:latest is missing; \
             the forecast blend gets no station observations.",
        );
        return;
    };

    // Read as text and parse here, so that a KV error (skip: do not overwrite
    // what we could not read) is told apart from a value that is not a
    // snapshot (replace it).
    let mut snapshot = match kv.get(KV_KEY).text().await {
        Ok(None) => Snapshot::default(),
        Ok(Some(text)) => serde_json::from_str::<Snapshot>(&text)
            .ok()
            .filter(Snapshot::is_current)
            .unwrap_or_default(),
        Err(_) => {
            log_throttled(
                "stations_latest_read_failed",
                false,
                "stations_latest_read_failed: could not read stations:latest; the snapshot is not updated this batch",
            );
            return;
        }
    };
    snapshot.merge(entries, now_ms());

    let Ok(body) = serde_json::to_string(&snapshot) else {
        return;
    };
    let written = match kv.put(KV_KEY, body) {
        Ok(put) => put.expiration_ttl(KV_TTL_SECONDS).execute().await.is_ok(),
        Err(_) => false,
    };
    if !written {
        // KV allows one write a second to a key: concurrent consumers can
        // lose a race. The next batch writes again.
        log_throttled(
            "stations_latest_write_failed",
            false,
            "stations_latest_write_failed: could not write stations:latest; the next batch tries again",
        );
    }
}
