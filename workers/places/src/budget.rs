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
/// Set by mukoko-weather-api to the caller's IP (this Worker has no public
/// route, so only the API's service binding can set it).
const CLIENT_IP_HEADER: &str = "X-Mukoko-Client-IP";
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
        let ip = req
            .headers()
            .get(CLIENT_IP_HEADER)
            .ok()
            .flatten()
            .or_else(|| req.headers().get("CF-Connecting-IP").ok().flatten())
            .unwrap_or_else(|| "unknown".into());
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

async fn record(env: &Env, action: Action, client: &str, now: u64) -> Result<()> {
    let db = env.d1(DB)?;
    let at = now as f64;
    db.batch(vec![
        db.prepare("INSERT INTO rate_events (client, action, at) VALUES (?1, ?2, ?3)")
            .bind(&[client.into(), action.name().into(), at.into()])?,
        db.prepare("INSERT INTO rate_events (client, action, at) VALUES (?1, ?2, ?3)")
            .bind(&[GLOBAL_CLIENT.into(), action.name().into(), at.into()])?,
        db.prepare("DELETE FROM rate_events WHERE at < ?1")
            .bind(&[(budget::prune_before(now) as f64).into()])?,
    ])
    .await?;
    Ok(())
}

/// Spend one call of `action` for `caller`, if the hour allows it.
pub async fn take(env: &Env, action: Action, caller: &Caller) -> Decision {
    let client = caller.key();
    let now = now_ms();
    let Ok((mine, all)) = counts(env, action, &client, budget::window_start(now)).await else {
        return Decision::GlobalLimit;
    };
    let decision = budget::decide(action.limits(), mine, all);
    if decision.allowed() && record(env, action, &client, now).await.is_err() {
        return Decision::GlobalLimit;
    }
    decision
}
