//! Station lookup and ingest-key checks.
//!
//! Which backend answers is `STATIONS_BACKEND` (`d1`, the default, or
//! `nyuchi`; `weather_core::station_service::Backend`).
//!
//! **`d1`** (today's behaviour): the key check is PBKDF2 with 60,000
//! iterations, which matches the hashes the Python backend stored. Stations
//! upload every 16 to 60 seconds, so after one successful check the isolate
//! remembers a SHA-256 of the key for 10 minutes. The slow hash then runs
//! about once per station per isolate per 10 minutes, not on every upload.
//!
//! **`nyuchi`**: the Nyuchi API checks the key (`nyuchi::verify`), with the
//! same ten minutes of positive cache, sixty seconds of negative cache, and a
//! `503` (never a `401`) when the API cannot answer.

use std::cell::RefCell;
use std::collections::HashMap;

use serde::Deserialize;
use weather_core::crypto::sha256_hex;
use weather_core::station::{valid_station_id, verify_ingest_key};
use weather_core::station_service::{Backend, StationIdentity};
use weather_edge::now_ms;
use worker::{Env, Result};

const VERIFIED_TTL_MS: u64 = 10 * 60_000;
/// Bounds the isolate cache; it is cleared when full.
const VERIFIED_MAX: usize = 5_000;

thread_local! {
    static VERIFIED: RefCell<HashMap<String, (String, u64)>> = RefCell::new(HashMap::new());
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

impl Station {
    /// What the hot path needs of the station.
    pub fn identity(&self) -> StationIdentity {
        StationIdentity {
            station_id: self.station_id.clone(),
            lat: self.lat,
            lon: self.lon,
            country_code: self.country_code.clone(),
        }
    }
}

/// How an upload's credentials came out.
pub enum Outcome {
    Station(StationIdentity),
    /// The key does not open the station: `401`.
    Denied,
    /// The backend could not judge the key (and has logged why): `503`. A good
    /// station is never told its key is wrong because of this.
    Unavailable,
}

/// Check an upload's station id and key against the chosen backend. In `d1`
/// mode a database error is an error (the caller answers 5xx), as it always
/// was.
pub async fn authenticate(
    env: &Env,
    backend: Backend,
    station_id: &str,
    key: &str,
) -> Result<Outcome> {
    if key.is_empty() || key.len() > 128 || !valid_station_id(station_id) {
        return Ok(Outcome::Denied);
    }
    match backend {
        Backend::D1 => Ok(match find_station(env, station_id, key).await? {
            Some(station) => Outcome::Station(station.identity()),
            None => Outcome::Denied,
        }),
        Backend::Nyuchi => crate::nyuchi::verify(env, station_id, key).await,
    }
}

/// The key's SHA-256, kept in place of the key for the verified cache.
fn digest(key: &str) -> String {
    sha256_hex(key)
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
