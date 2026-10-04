//! Hourly per-client limits, kept in D1 (`rate_events`). The Workers rate
//! limiting binding only counts per 10 s or 60 s, and these limits are per
//! hour. Clients are stored as a SHA-256 of their IP.

use sha2::{Digest, Sha256};
use weather_edge::now_ms;
use worker::{Env, Result};

const HOUR_MS: u64 = 3_600_000;
const DAY_MS: u64 = 24 * HOUR_MS;

/// Record an attempt and say whether it is within `max` an hour.
pub async fn allow(env: &Env, ip: &str, action: &str, max: u32) -> Result<bool> {
    let db = env.d1(crate::DB)?;
    let client = hex::encode(Sha256::digest(ip.as_bytes()));
    let now = now_ms();
    let since = now.saturating_sub(HOUR_MS) as f64;
    let count: Option<f64> = db
        .prepare(
            "SELECT COUNT(*) AS n FROM rate_events WHERE client = ?1 AND action = ?2 AND at >= ?3",
        )
        .bind(&[client.as_str().into(), action.into(), since.into()])?
        .first(Some("n"))
        .await?;
    if count.unwrap_or(0.0) >= f64::from(max) {
        return Ok(false);
    }
    db.batch(vec![
        db.prepare("INSERT INTO rate_events (client, action, at) VALUES (?1, ?2, ?3)")
            .bind(&[client.as_str().into(), action.into(), (now as f64).into()])?,
        db.prepare("DELETE FROM rate_events WHERE at < ?1")
            .bind(&[(now.saturating_sub(DAY_MS) as f64).into()])?,
    ])
    .await?;
    Ok(true)
}
