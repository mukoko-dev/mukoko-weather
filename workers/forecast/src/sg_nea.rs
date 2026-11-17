//! Singapore's `current` from NEA's real-time open data (mukoko-dev/mukoko-weather#596):
//! the adapter. It fetches, caches and calls `weather_core::nea_current`, which
//! holds every decision (the island, the nearest station, freshness, the
//! phrase table, the merge) and does no I/O.
//!
//! - Only a point inside Singapore's box does anything; every other request
//!   returns before touching KV or NEA.
//! - The six NEA calls (air temperature, humidity, rainfall, wind speed, wind
//!   direction, the 2-hour forecast; the v2 API, no key, 6 calls per 10 seconds)
//!   are made together at most once per `SNAPSHOT_FRESH_MS`, parsed once, and kept
//!   as one `Snapshot` in the isolate and in KV (`sgnea:v1`).
//! - FAIL OPEN. NEA slow, down, rate limited (HTTP 429) or answering junk: the
//!   forecast is served exactly as it was. A dataset that failed keeps its
//!   last copy from the previous snapshot (its readings are age-gated, so a
//!   stale one is refused); when nothing at all can be had, `None`.
//! - Calls go through a circuit breaker (3 failures in 5 minutes open it for 2),
//!   and a 429 opens it at once for the full cooldown, as NEA's rate limit asks.
//!   Each call has a 3 second timeout, and they run together.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

use futures::join;
use serde_json::Value;
use weather_core::breaker::{self, Breaker};
use weather_core::nea_current as nea;
use weather_core::Source;
use weather_edge::{get_with_timeout, log_throttled, now_ms};
use worker::{Context, Env};

use crate::chain::CACHE_BINDING;

const TIMEOUT: Duration = Duration::from_secs(3);
/// After a refresh that failed, the snapshot already held is used for this
/// long before NEA (and KV) are asked again.
const RETRY_AFTER_MS: i64 = 30_000;

thread_local! {
    static BREAKER: RefCell<Breaker> = const { RefCell::new(Breaker::new(breaker::DEFAULT)) };
    /// The snapshot this isolate holds and until when it needs no refresh.
    static MEMO: RefCell<Option<(i64, Rc<nea::Snapshot>)>> = const { RefCell::new(None) };
    /// A refresh is running in this isolate; another request waits for it by
    /// using what it already has, not by calling NEA again.
    static REFRESHING: Cell<bool> = const { Cell::new(false) };
}

/// Clears [`REFRESHING`] however the refresh ends (a dropped request included).
struct InFlight;

impl InFlight {
    fn start() -> Option<InFlight> {
        (!REFRESHING.with(|f| f.replace(true))).then_some(InFlight)
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        REFRESHING.with(|f| f.set(false));
    }
}

/// What one NEA call came to.
enum Fetched {
    Body(Value),
    /// HTTP 429: stop calling for the cooldown.
    RateLimited,
    Failed,
}

async fn fetch(url: &str) -> Fetched {
    match get_with_timeout(url, None, TIMEOUT).await {
        Ok(mut r) => match r.status_code() {
            200 => match r.json::<Value>().await {
                Ok(v) => Fetched::Body(v),
                Err(_) => Fetched::Failed,
            },
            429 => Fetched::RateLimited,
            _ => Fetched::Failed,
        },
        Err(_) => Fetched::Failed,
    }
}

/// Overlay NEA's observations onto `data["current"]` for a point in Singapore.
/// Returns `Some(Source::Nea)` when something was applied.
pub async fn overlay(
    env: &Env,
    ctx: &Context,
    data: &mut Value,
    lat: f64,
    lon: f64,
) -> Option<Source> {
    // Before anything else, and with no I/O: not Singapore, not our business.
    if !nea::in_singapore(lat, lon) {
        return None;
    }
    let now = now_ms() as i64;
    let snapshot = snapshot(env, ctx, now).await?;
    nea::apply(data, &snapshot, lat, lon, now).then_some(Source::Nea)
}

/// The snapshot to read: the isolate's, else KV's, else a refresh from NEA.
/// When a refresh cannot be had, the last snapshot is used as it is (its
/// readings are age-gated where they are read); `None` only when there never was one.
async fn snapshot(env: &Env, ctx: &Context, now: i64) -> Option<Rc<nea::Snapshot>> {
    if let Some((until, s)) = MEMO.with(|m| m.borrow().clone()) {
        // Still inside its window (and not from a clock that has since moved back).
        if (1..=nea::SNAPSHOT_FRESH_MS).contains(&(until - now)) {
            return Some(s);
        }
    }
    let kv = env.kv(CACHE_BINDING).ok();
    let stored = match &kv {
        Some(kv) => kv
            .get(nea::CACHE_KEY)
            .json::<nea::Snapshot>()
            .await
            .ok()
            .flatten()
            .map(Rc::new),
        None => None,
    };
    if let Some(s) = stored.as_ref().filter(|s| s.is_fresh(now)) {
        remember(s, s.fetched_at_ms + nea::SNAPSHOT_FRESH_MS);
        return Some(s.clone());
    }
    // Stale or missing: ask NEA. What this isolate held last is the second
    // choice for the datasets that fail.
    let previous = stored.or_else(|| MEMO.with(|m| m.borrow().as_ref().map(|(_, s)| s.clone())));
    match refresh(previous.as_deref(), now).await {
        Some(fresh) => {
            let fresh = Rc::new(fresh);
            remember(&fresh, now + nea::SNAPSHOT_FRESH_MS);
            if let (Some(kv), Ok(text)) = (kv, serde_json::to_string(&*fresh)) {
                ctx.wait_until(async move {
                    if let Ok(put) = kv.put(nea::CACHE_KEY, text) {
                        let _ = put.expiration_ttl(nea::CACHE_TTL_SECONDS).execute().await;
                    }
                });
            }
            Some(fresh)
        }
        None => {
            if let Some(p) = &previous {
                remember(p, now + RETRY_AFTER_MS);
            }
            previous
        }
    }
}

fn remember(s: &Rc<nea::Snapshot>, until_ms: i64) {
    MEMO.with(|m| *m.borrow_mut() = Some((until_ms, s.clone())));
}

/// Ask NEA for all six datasets together and parse them. `None` when the
/// circuit is open, another request is already refreshing, or nothing usable
/// came back. A dataset that failed is filled from `previous`.
async fn refresh(previous: Option<&nea::Snapshot>, now: i64) -> Option<nea::Snapshot> {
    if !BREAKER.with(|b| b.borrow_mut().allow(now as u64)) {
        return None;
    }
    let _in_flight = InFlight::start()?;
    let (temperature, humidity, rainfall, wind_speed, wind_direction, forecast) = join!(
        fetch(nea::AIR_TEMPERATURE_URL),
        fetch(nea::RELATIVE_HUMIDITY_URL),
        fetch(nea::RAINFALL_URL),
        fetch(nea::WIND_SPEED_URL),
        fetch(nea::WIND_DIRECTION_URL),
        fetch(nea::TWO_HOUR_FORECAST_URL),
    );
    let all = [
        &temperature,
        &humidity,
        &rainfall,
        &wind_speed,
        &wind_direction,
        &forecast,
    ];
    let limited = all.iter().any(|f| matches!(f, Fetched::RateLimited));
    let readings = |f: &Fetched| match f {
        Fetched::Body(v) => nea::parse_readings(v),
        _ => Vec::new(),
    };
    let mut fresh = nea::Snapshot {
        fetched_at_ms: now,
        temperature: readings(&temperature),
        humidity: readings(&humidity),
        rainfall: readings(&rainfall),
        wind_speed: readings(&wind_speed),
        wind_direction: readings(&wind_direction),
        forecast: match &forecast {
            Fetched::Body(v) => nea::parse_forecast(v),
            _ => None,
        },
    };
    let usable = !fresh.is_empty();
    BREAKER.with(|b| {
        let mut b = b.borrow_mut();
        if limited {
            b.trip(now as u64);
        } else if usable {
            b.record_success();
        } else {
            b.record_failure(now as u64);
        }
    });
    if limited {
        log_throttled(
            "sg_nea_rate_limited",
            false,
            "sg_nea_rate_limited: data.gov.sg answered HTTP 429; stopping for a while",
        );
    } else if !usable {
        log_throttled(
            "sg_nea_unavailable",
            false,
            "sg_nea_unavailable: NEA open data gave nothing usable; Singapore's current conditions are the forecast's",
        );
    }
    if let Some(previous) = previous {
        fresh.fill_missing_from(previous);
    }
    (!fresh.is_empty()).then_some(fresh)
}
