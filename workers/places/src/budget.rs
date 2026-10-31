//! The hourly geocoder budgets, run against D1 `rate_events` (the same table
//! the stations Worker uses for its hourly limits). The arithmetic and the
//! limits are `weather_core::budget`, tested natively; this only runs the SQL.
//!
//! A spend is ONE guarded statement (`budget::SPEND_SQL`): the rows are written
//! only when the client's and the service's hour both have room, and the number
//! of rows D1 reports it wrote is the decision. There is no count-then-insert
//! pair for parallel cold requests to slip through. The counts are read again
//! only to say WHICH hour was full after a refusal.
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

/// The hour's counts for a client and for the service: only used to name the
/// full hour after a refusal, never to decide one.
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

/// Best effort: old events go. The guarded insert is what counts, so a failed
/// prune never changes a decision.
async fn prune(env: &Env, now: u64) {
    let Ok(db) = env.d1(DB) else { return };
    if let Ok(stmt) = db
        .prepare("DELETE FROM rate_events WHERE at < ?1")
        .bind(&[(budget::prune_before(now) as f64).into()])
    {
        let _ = stmt.run().await;
    }
}

/// Spend `units` of `action` for `client` in ONE statement
/// ([`budget::SPEND_SQL`]): the rows are written only if both the client's and
/// the service's hour have room for the whole spend, so parallel cold requests
/// cannot all read the same counts and all pass. `Ok(true)` means D1 wrote the
/// rows (`meta.changes` above zero); `Ok(false)` means it refused; `Err` is a
/// D1 failure or a result without a change count, which the caller treats as
/// refused (fail closed).
async fn spend(env: &Env, action: Action, client: &str, now: u64, units: u32) -> Result<bool> {
    let limits = action.limits();
    let result = env
        .d1(DB)?
        .prepare(budget::SPEND_SQL)
        .bind(&[
            client.into(),
            action.name().into(),
            (now as f64).into(),
            f64::from(units).into(),
            (budget::window_start(now) as f64).into(),
            f64::from(limits.per_client).into(),
            f64::from(limits.global).into(),
            GLOBAL_CLIENT.into(),
        ])?
        .run()
        .await?;
    let changes = result.meta()?.and_then(|m| m.changes);
    if changes.is_none() {
        return Err(worker::Error::RustError("no change count".into()));
    }
    Ok(budget::spend_granted(changes))
}

/// Spend one call of `action` for `caller`, if the hour allows it.
pub async fn take(env: &Env, action: Action, caller: &Caller) -> Decision {
    take_units(env, action, caller, 1).await
}

/// Spend `units` of `action` (a weighted call) for `caller`, if the whole
/// spend fits inside the client's and the service's hour. Fails closed: a D1
/// error is a refusal, so nothing goes upstream on a budget it cannot read.
pub async fn take_units(env: &Env, action: Action, caller: &Caller, units: u32) -> Decision {
    let client = caller.key();
    let now = now_ms();
    let units = budget::spend_units(units);
    match spend(env, action, &client, now, units).await {
        Ok(true) => {
            prune(env, now).await;
            Decision::Allow
        }
        // Refused: say which hour is full. If the counts cannot be read now,
        // the refusal stands with the service-wide label.
        Ok(false) => match counts(env, action, &client, budget::window_start(now)).await {
            Ok((mine, all)) => budget::refusal(action.limits(), mine, all, units),
            Err(_) => Decision::GlobalLimit,
        },
        Err(_) => Decision::GlobalLimit,
    }
}
