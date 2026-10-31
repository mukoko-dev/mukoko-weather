//! The hourly geocoder budgets, run against D1 `rate_events` (the same table
//! the stations Worker uses for its hourly limits). The arithmetic and the
//! limits are `weather_core::budget`, tested natively; this only runs the SQL.
//!
//! Fails CLOSED: if the budget cannot be read or written, the call does not go
//! to a third-party geocoder (a KV hit still answers, and the caller treats it
//! as over budget and says so with `no-store`).

use serde_json::Value;
use weather_core::budget::{self, Action, Decision, GLOBAL_CLIENT};
use weather_edge::now_ms;
use worker::{Env, Request, Result};

const DB: &str = "WEATHER_DB";
/// Reserved for a verified short-lived token subject, once a verifier exists
/// (the issuer is a platform responsibility, tracked in #148). Nothing sets or
/// reads a subject yet: every caller is keyed by IP.
const NO_VERIFIED_SUBJECT: Option<String> = None;

/// Who is asking, as the budget keys it.
pub struct Caller {
    /// A verified token subject, when a verifier supplies one.
    pub subject: Option<String>,
    pub ip: String,
}

impl Caller {
    pub fn from_request(req: &Request) -> Caller {
        // The API's service binding stamps the visitor's address (this Worker
        // has no public route); see `weather_edge::client_ip`.
        let ip = weather_edge::client_ip(req).unwrap_or_else(|| "unknown".into());
        Caller {
            subject: NO_VERIFIED_SUBJECT,
            ip,
        }
    }

    fn key(&self) -> String {
        budget::client_key(self.subject.as_deref(), &self.ip)
    }
}

async fn counts(env: &Env, action: Action, client: &str, since: u64) -> Result<(u64, u64)> {
    let rows = env
        .d1(DB)?
        .prepare(
            "SELECT client, COUNT(*) AS n FROM rate_events \
             WHERE action = ?1 AND at >= ?2 AND client IN (?3, ?4) GROUP BY client",
        )
        .bind(&[
            action.name().into(),
            (since as f64).into(),
            client.into(),
            GLOBAL_CLIENT.into(),
        ])?
        .all()
        .await?
        .results::<Value>()?;
    let n = |who: &str| {
        rows.iter()
            .find(|r| r.get("client").and_then(Value::as_str) == Some(who))
            .and_then(|r| r.get("n").and_then(Value::as_f64))
            .unwrap_or(0.0) as u64
    };
    Ok((n(client), n(GLOBAL_CLIENT)))
}

/// One event row per unit: a weighted call (Open-Meteo history) writes its
/// cost, so the hourly count IS the spend. The rows come from a recursive CTE,
/// which keeps a 50-unit call to one statement.
const INSERT_UNITS: &str =
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?4) \
     INSERT INTO rate_events (client, action, at) SELECT ?1, ?2, ?3 FROM n";

/// The most units one spend may write (the history caps are far below it).
const MAX_UNITS: u32 = 1_000;

async fn record(env: &Env, action: Action, client: &str, now: u64, units: u32) -> Result<()> {
    let db = env.d1(DB)?;
    let at = now as f64;
    let units = f64::from(units.clamp(1, MAX_UNITS));
    db.batch(vec![
        db.prepare(INSERT_UNITS).bind(&[
            client.into(),
            action.name().into(),
            at.into(),
            units.into(),
        ])?,
        db.prepare(INSERT_UNITS).bind(&[
            GLOBAL_CLIENT.into(),
            action.name().into(),
            at.into(),
            units.into(),
        ])?,
        db.prepare("DELETE FROM rate_events WHERE at < ?1")
            .bind(&[(budget::prune_before(now) as f64).into()])?,
    ])
    .await?;
    Ok(())
}

/// Spend one call of `action` for `caller`, if the hour allows it.
pub async fn take(env: &Env, action: Action, caller: &Caller) -> Decision {
    take_units(env, action, caller, 1).await
}

/// Spend `units` of `action` (a weighted call) for `caller`, if the whole
/// spend fits inside the client's and the service's hour. Fails closed.
pub async fn take_units(env: &Env, action: Action, caller: &Caller, units: u32) -> Decision {
    let client = caller.key();
    let now = now_ms();
    let Ok((mine, all)) = counts(env, action, &client, budget::window_start(now)).await else {
        return Decision::GlobalLimit;
    };
    let decision = budget::decide_units(action.limits(), mine, all, units);
    if decision.allowed() && record(env, action, &client, now, units).await.is_err() {
        return Decision::GlobalLimit;
    }
    decision
}
