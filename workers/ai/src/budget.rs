//! Hourly budgets for the model calls this Worker makes for one visitor
//! (`weather_core::budget`: the AI location search and the history analysis),
//! run against D1 `rate_events`, the table the places and stations Workers
//! use for their hourly limits.
//!
//! A spend is ONE guarded statement (`budget::SPEND_SQL`): the rows are
//! written only when the client's and the service's hour both have room, and
//! the number of rows D1 reports it wrote is the decision. There is no
//! count-then-insert pair for parallel requests to slip through. The counts
//! are read again only to say WHICH hour was full after a refusal.
//!
//! Fails CLOSED: when the budget cannot be read or written, the model is not
//! called (the caller answers without it).

use serde_json::Value;
use weather_core::budget::{self, Action, Decision, GLOBAL_CLIENT};
use weather_edge::now_ms;
use worker::{Env, Result};

const DB: &str = "WEATHER_DB";

/// The stored identity of a caller: a hash of the address, never the address
/// (`weather_core::budget::client_key`). No token verifier exists yet, so
/// every caller is keyed by its IP.
pub fn client_key(ip: Option<&str>) -> String {
    budget::client_key(None, ip.unwrap_or("unknown"))
}

/// Whether the budget store is bound.
pub fn bound(env: &Env) -> bool {
    env.d1(DB).is_ok()
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

/// Write the spend if both hours have room. `Ok(true)` means D1 wrote the
/// rows; `Ok(false)` that it refused; `Err` is a D1 failure or a result
/// without a change count, which the caller treats as refused.
async fn spend(env: &Env, action: Action, client: &str, now: u64) -> Result<bool> {
    let limits = action.limits();
    let result = env
        .d1(DB)?
        .prepare(budget::SPEND_SQL)
        .bind(&[
            client.into(),
            action.name().into(),
            (now as f64).into(),
            f64::from(budget::spend_units(1)).into(),
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

/// Spend one call of `action` for `client`, if the hour allows it. Fails
/// closed: a D1 error is a refusal (`GlobalLimit`), so nothing goes to the
/// model on a budget that cannot be read.
pub async fn take(env: &Env, action: Action, client: &str) -> Decision {
    let now = now_ms();
    match spend(env, action, client, now).await {
        Ok(true) => {
            prune(env, now).await;
            Decision::Allow
        }
        Ok(false) => match counts(env, action, client, budget::window_start(now)).await {
            Ok((mine, all)) => budget::refusal(action.limits(), mine, all, 1),
            Err(_) => Decision::GlobalLimit,
        },
        Err(_) => Decision::GlobalLimit,
    }
}
