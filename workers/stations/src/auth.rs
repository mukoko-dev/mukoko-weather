//! Station lookup and ingest-key checks.
//!
//! The key check is PBKDF2 with 60,000 iterations, which matches the hashes
//! the Python backend stored. Stations upload every 16 to 60 seconds, so after
//! one successful check the isolate remembers a SHA-256 of the key for 10
//! minutes. The slow hash then runs about once per station per isolate per
//! 10 minutes, not on every upload.

use std::cell::RefCell;
use std::collections::HashMap;

use serde::Deserialize;
use sha2::{Digest, Sha256};
use weather_core::station::{valid_station_id, verify_ingest_key};
use weather_edge::now_ms;
use worker::{Env, Result};

const VERIFIED_TTL_MS: u64 = 10 * 60_000;
/// Bounds the isolate cache; it is cleared when full.
const VERIFIED_MAX: usize = 5_000;

thread_local! {
    static VERIFIED: RefCell<HashMap<String, ([u8; 32], u64)>> = RefCell::new(HashMap::new());
}

#[derive(Debug, Clone, Deserialize)]
pub struct Station {
    pub station_id: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    pub station_type: String,
    pub status: String,
    pub country_code: String,
    pub ingest_key_hash: String,
    pub ingest_key_salt: String,
    pub last_observation_at: Option<i64>,
}

fn digest(key: &str) -> [u8; 32] {
    Sha256::digest(key.as_bytes()).into()
}

/// The station for this id and key, or `None` for any mismatch (unknown id,
/// wrong key, inactive station). A database error is an error, so the
/// caller answers 5xx rather than telling a station its key is wrong.
pub async fn find_station(env: &Env, station_id: &str, key: &str) -> Result<Option<Station>> {
    if key.is_empty() || key.len() > 128 || !valid_station_id(station_id) {
        return Ok(None);
    }
    let db = env.d1(crate::DB)?;
    let station: Option<Station> = db
        .prepare(
            "SELECT station_id, name, lat, lon, station_type, status, country_code, \
             ingest_key_hash, ingest_key_salt, last_observation_at \
             FROM stations WHERE station_id = ?1",
        )
        .bind(&[station_id.into()])?
        .first(None)
        .await?;
    let Some(station) = station else {
        return Ok(None);
    };
    if station.status != "active" {
        return Ok(None);
    }

    let now = now_ms();
    let d = digest(key);
    let cached = VERIFIED.with(|v| {
        v.borrow()
            .get(station_id)
            .is_some_and(|(k, until)| *k == d && *until > now)
    });
    if cached {
        return Ok(Some(station));
    }
    if !verify_ingest_key(key, &station.ingest_key_salt, &station.ingest_key_hash) {
        return Ok(None);
    }
    VERIFIED.with(|v| {
        let mut v = v.borrow_mut();
        if v.len() >= VERIFIED_MAX {
            v.clear();
        }
        v.insert(station_id.to_owned(), (d, now + VERIFIED_TTL_MS));
    });
    Ok(Some(station))
}
