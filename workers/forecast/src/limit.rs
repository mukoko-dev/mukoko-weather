//! Hourly budgets for third-party calls the forecast Worker makes on behalf
//! of one visitor (today the model grid), run against D1 `rate_events`. The
//! arithmetic and the limits are `weather_core::budget`; this only runs the
//! SQL. Fails CLOSED: when the budget cannot be read or written the call does
//! not go upstream (a KV hit still answers).

use serde_json::Value;
use weather_core::budget::{self, Action, Decision, GLOBAL_CLIENT};
use weather_edge::now_ms;
use worker::{Env, Request, Result};

const DB: &str = "WEATHER_DB";
/// The stored identity of the caller: a hash of the IP, never the IP.
pub fn caller_key(req: &Request) -> String {
    // The API's service binding stamps the visitor's address; see
    // `weather_edge::client_ip`.
    let ip = weather_edge::client_ip(req).unwrap_or_else(|| "unknown".into());
    budget::client_key(None, &ip)
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

/// Spend one call of `action` for `client`, if the hour allows it.
pub async fn take(env: &Env, action: Action, client: &str) -> Decision {
    let now = now_ms();
    let Ok((mine, all)) = counts(env, action, client, budget::window_start(now)).await else {
        return Decision::GlobalLimit;
    };
    let decision = budget::decide(action.limits(), mine, all);
    if decision.allowed() && record(env, action, client, now).await.is_err() {
        return Decision::GlobalLimit;
    }
    decision
}
