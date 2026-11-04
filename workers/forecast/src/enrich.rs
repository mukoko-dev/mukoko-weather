//! Tomorrow.io enrichment: insights only, budgeted, never blocking (issue
//! #246). The rules are `weather_core::enrichment` (ported from
//! `api/py/_enrichment.py`); this runs them: the KV cache (3 h, 1 h when
//! there was nothing to merge), the D1 budget, and the one HTTP call.
//!
//! Order, as in Python: cache, then the breaker, then the API key, then a
//! remembered 429, then the budget, then the call. It never raises and never
//! touches `current`, `hourly` or `daily`.
//!
//! The owner has NO paid Tomorrow.io plan. The free tier allows 25 calls an
//! hour and 500 a day; normal traffic stops at 12 and 250, priority traffic at
//! 20 and 400 (`weather_core::enrichment`). The budget is a count of D1
//! `rate_events` rows (action `tomorrow`, the service-wide client `*`) over the
//! last hour and the last 24 hours, taken by ONE guarded INSERT so concurrent
//! isolates cannot overshoot; any D1 error means no call (fails closed).

use std::cell::RefCell;
use std::time::Duration;

use serde_json::{json, Value};
use weather_core::budget::{self, GLOBAL_CLIENT};
use weather_core::enrichment::{self as rules, Memo, Reservation, Status};
use weather_core::secrets;
use weather_edge::{get_with_timeout, now_ms, secret};
use worker::{Context, Env, Headers};

use crate::chain::{self, CACHE_BINDING};

const DB: &str = "WEATHER_DB";
const TOMORROW_TIMEOUT: Duration = Duration::from_secs(4);

thread_local! {
    static MEMO: RefCell<Memo> = const { RefCell::new(Memo::new()) };
}

/// Take one slot against the hour and day caps, or say why not. `Err` is a
/// D1 failure (fail closed).
async fn reserve(env: &Env, priority: bool) -> Result<Reservation, ()> {
    let db = env.d1(DB).map_err(|_| ())?;
    let now = now_ms();
    let caps = rules::caps(priority);
    let hour_start = now.saturating_sub(rules::HOUR_MS);
    let day_start = now.saturating_sub(rules::DAY_MS);
    // One statement: the row goes in only if both windows have room, so two
    // isolates racing for the last slot cannot both get it.
    let insert = db
        .prepare(
            "INSERT INTO rate_events (client, action, at) \
             SELECT ?1, ?2, ?3 WHERE \
             (SELECT COUNT(*) FROM rate_events WHERE action = ?2 AND client = ?1 AND at >= ?4) < ?5 AND \
             (SELECT COUNT(*) FROM rate_events WHERE action = ?2 AND client = ?1 AND at >= ?6) < ?7",
        )
        .bind(&[
            GLOBAL_CLIENT.into(),
            rules::ACTION.into(),
            (now as f64).into(),
            (hour_start as f64).into(),
            (caps.hour as f64).into(),
            (day_start as f64).into(),
            (caps.day as f64).into(),
        ])
        .map_err(|_| ())?;
    let result = insert.run().await.map_err(|_| ())?;
    let changes = result
        .meta()
        .ok()
        .flatten()
        .and_then(|m| m.changes)
        .ok_or(())?;
    if changes > 0 {
        // Old rows go (best effort; the guarded insert above is what counts).
        if let Ok(prune) = db
            .prepare("DELETE FROM rate_events WHERE at < ?1")
            .bind(&[(budget::prune_before(now) as f64).into()])
        {
            let _ = prune.run().await;
        }
        return Ok(Reservation::Granted);
    }
    // Refused: say which window is full.
    let (hour, day) = usage(env).await.ok_or(())?;
    match rules::decide(hour, day, priority) {
        // A window moved between the two statements: skip this call, but do
        // not call the budget spent.
        Reservation::Granted => Err(()),
        full => Ok(full),
    }
}

/// Calls made in the last hour and the last 24 hours. `None` on a D1 error.
pub async fn usage(env: &Env) -> Option<(u64, u64)> {
    let now = now_ms();
    let row = env
        .d1(DB)
        .ok()?
        .prepare(
            "SELECT COALESCE(SUM(CASE WHEN at >= ?3 THEN 1 ELSE 0 END), 0) AS hour, COUNT(*) AS day \
             FROM rate_events WHERE action = ?1 AND client = ?2 AND at >= ?4",
        )
        .bind(&[
            rules::ACTION.into(),
            GLOBAL_CLIENT.into(),
            (now.saturating_sub(rules::HOUR_MS) as f64).into(),
            (now.saturating_sub(rules::DAY_MS) as f64).into(),
        ])
        .ok()?
        .first::<Value>(None)
        .await
        .ok()??;
    Some((
        row.get("hour").and_then(Value::as_f64)? as u64,
        row.get("day").and_then(Value::as_f64)? as u64,
    ))
}

/// What the status page shows: caps and usage, no provider call.
pub async fn snapshot(env: &Env) -> Value {
    let mut out = json!({
        "role": "enrichment",
        "hourCap": rules::HOURLY_CAP,
        "dayCap": rules::DAILY_CAP,
        "hourCapNormal": rules::HOURLY_CAP_NORMAL,
        "dayCapNormal": rules::DAILY_CAP_NORMAL,
    });
    if let Some((hour, day)) = usage(env).await {
        out["hourUsed"] = json!(hour);
        out["dayUsed"] = json!(day);
    }
    out
}

fn merge(data: &mut Value, enrichment: &Value) {
    let baseline = data.get("insights").cloned().unwrap_or(Value::Null);
    let merged = rules::merge_insights(&baseline, enrichment);
    // Nothing to add keeps `insights` as it was (null stays null).
    if enrichment.as_object().is_some_and(|e| !e.is_empty()) {
        data["insights"] = merged;
    }
}

/// Merge Tomorrow.io's insights onto `data` when the cache, the budget and
/// the provider allow. Returns the `X-Enrichment` status.
pub async fn apply(
    env: &Env,
    ctx: &Context,
    data: &mut Value,
    lat: f64,
    lon: f64,
    priority: bool,
) -> Status {
    let key = rules::cache_key(&weather_core::geo::cache_key(lat, lon));
    let kv = env.kv(CACHE_BINDING).ok();

    // 1. Cache. `{}` means Tomorrow.io answered but had nothing to add: a hit,
    // do not call it again until the TTL ends.
    if let Some(kv) = &kv {
        if let Ok(Some(hit)) = kv.get(&key).json::<Value>().await {
            if let Some(insights) = hit.get("insights").filter(|i| i.is_object()) {
                merge(data, insights);
                return Status::Enriched;
            }
        }
    }

    // 2. Breaker.
    if !chain::TOMORROW.with(|b| b.borrow_mut().allow(now_ms())) {
        return Status::SkippedError;
    }

    // 3. API key.
    let Some(api_key) = secret(env, secrets::TOMORROW_API_KEY).await else {
        return Status::None;
    };

    // 4. A remembered 429, then the budget.
    let now = now_ms();
    if MEMO.with(|m| m.borrow().rate_limited(now)) {
        return Status::SkippedBudget;
    }
    if MEMO.with(|m| m.borrow().exhausted(priority, now)) {
        return Status::SkippedBudget;
    }
    match reserve(env, priority).await {
        Ok(Reservation::Granted) => {}
        Ok(_) => {
            MEMO.with(|m| m.borrow_mut().mark_exhausted(priority, now));
            return Status::SkippedBudget;
        }
        // D1 trouble is not a spent budget: skip this call, remember nothing.
        Err(()) => return Status::SkippedBudget,
    }

    // 5. The call. The key travels in a header, never the URL.
    let headers = Headers::new();
    if headers.set("apikey", &api_key).is_err() {
        return Status::SkippedError;
    }
    let url = rules::tomorrow_url(lat, lon);
    let outcome = match get_with_timeout(&url, Some(headers), TOMORROW_TIMEOUT).await {
        Ok(mut resp) => {
            let status = resp.status_code();
            if status == 200 {
                match resp.json::<Value>().await {
                    Ok(raw) => rules::extract_insights(&raw).map_err(|_| Failure::Provider),
                    Err(_) => Err(Failure::Provider),
                }
            } else if status == 429 {
                let h = resp.headers().clone();
                Err(Failure::RateLimited(rules::classify_429(|n| {
                    h.get(n).ok().flatten()
                })))
            } else {
                Err(Failure::Provider)
            }
        }
        Err(_) => Err(Failure::Provider),
    };

    match outcome {
        Ok(insights) => {
            // HTTP 200 is healthy even when there is nothing to merge (a
            // clear sky has no cloud base): cache the empty answer too, so
            // the TTL bounds the quota.
            chain::TOMORROW.with(|b| b.borrow_mut().record_success());
            let ttl = if insights.is_empty() {
                rules::EMPTY_ENRICHMENT_TTL_S
            } else {
                rules::ENRICHMENT_TTL_S
            };
            let value = Value::Object(insights);
            if let Some(kv) = kv {
                let body = json!({"insights": value}).to_string();
                ctx.wait_until(async move {
                    if let Ok(put) = kv.put(&key, body) {
                        let _ = put.expiration_ttl(ttl).execute().await;
                    }
                });
            }
            merge(data, &value);
            Status::Enriched
        }
        // 429 is not provider ill-health: the breaker is not touched. A
        // remaining-count header at 0 means the quota is spent (stop for the
        // hour); headers showing quota left mean a per-second burst
        // (remember nothing); no readable header gets a short pause.
        Err(Failure::RateLimited(quota)) => {
            match quota {
                Some(true) => MEMO.with(|m| m.borrow_mut().mark_rate_limited(now, None)),
                None => MEMO.with(|m| {
                    m.borrow_mut()
                        .mark_rate_limited(now, Some(rules::UNCLEAR_429_MEMO_MS))
                }),
                Some(false) => {}
            }
            Status::SkippedBudget
        }
        // A real provider failure counts against the breaker.
        Err(Failure::Provider) => {
            chain::TOMORROW.with(|b| b.borrow_mut().record_failure(now_ms()));
            Status::SkippedError
        }
    }
}

enum Failure {
    Provider,
    RateLimited(Option<bool>),
}
