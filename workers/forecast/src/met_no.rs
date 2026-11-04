//! The failover forecast: MET Norway Locationforecast, asked only when
//! Open-Meteo gave nothing (a 429 to the Workers' shared egress, an open
//! circuit breaker) and no stored forecast is fresh (mukoko-dev/mukoko-weather#434).
//! The rules, the conversion to our shape and the terms of use it follows are
//! `weather_core::met_no`; this runs them: the KV memo, the breaker, the
//! request.
//!
//! Order: a memo still inside MET Norway's `Expires` answers with no request;
//! then the breaker; then the per-isolate request brake; then one conditional
//! request (`If-Modified-Since` with the previous `Last-Modified`). Only a
//! 5xx, a 429, a timeout, a transport error or an unreadable body counts
//! against the breaker; a 429 or 403 opens it at once (the terms: stop
//! traffic immediately), and any other 4xx is our request, not an outage. It
//! never raises and never invents data: `None` leaves the caller with the
//! stored forecast or the seasonal estimate.
//!
//! Nothing here logs a coordinate, a URL or a body.

use std::cell::RefCell;
use std::time::Duration;

use serde_json::Value;
use weather_core::breaker::{self, Breaker};
use weather_core::met_no::{self, Memo, OffsetHint, RateWindow};
use weather_edge::{get_with_timeout, now, now_ms};
use worker::{console_log, console_warn, Context, Env, Headers};

use crate::chain::CACHE_BINDING;

const TIMEOUT: Duration = Duration::from_secs(6);

thread_local! {
    static MET_NO: RefCell<Breaker> = const { RefCell::new(Breaker::new(breaker::MET_NO)) };
    static RATE: RefCell<RateWindow> = const { RefCell::new(RateWindow::new()) };
}

fn allowed() -> bool {
    MET_NO.with(|b| b.borrow_mut().allow(now_ms()))
        && RATE.with(|r| {
            r.borrow_mut().try_acquire(
                now_ms(),
                met_no::MAX_REQUESTS_PER_WINDOW,
                met_no::RATE_WINDOW_MS,
            )
        })
}

fn record(ok: bool) {
    MET_NO.with(|b| {
        let mut b = b.borrow_mut();
        if ok {
            b.record_success();
        } else {
            b.record_failure(now_ms());
        }
    });
}

/// MET Norway said stop (429, or a 403 for a blocked client): the circuit
/// opens at once and rests for its whole cooldown.
fn trip() {
    MET_NO.with(|b| b.borrow_mut().trip(now_ms()));
}

/// The forecast for a point from MET Norway, in the app's shape, or `None`.
/// `hint` is the place's UTC offset when known (it sends none).
pub async fn forecast(
    env: &Env,
    ctx: &Context,
    lat: f64,
    lon: f64,
    hint: Option<OffsetHint>,
) -> Option<Value> {
    let kv = env.kv(CACHE_BINDING).ok();
    let key = met_no::memo_key(lat, lon);
    let memo = match &kv {
        Some(kv) => kv.get(&key).json::<Memo>().await.ok().flatten(),
        None => None,
    };
    // Inside `Expires`: no request may be made (the terms), and none is needed.
    if let Some(m) = memo.as_ref().filter(|m| m.is_fresh(now_ms())) {
        return met_no::finish(&m.payload, now());
    }
    if !allowed() {
        return None;
    }

    let headers = Headers::new();
    headers.set("User-Agent", met_no::USER_AGENT).ok()?;
    headers.set("Accept", "application/json").ok()?;
    if let Some(since) = memo.as_ref().and_then(|m| m.last_modified.as_deref()) {
        headers.set("If-Modified-Since", since).ok()?;
    }
    let mut resp =
        match get_with_timeout(&met_no::request_url(lat, lon), Some(headers), TIMEOUT).await {
            Ok(resp) => resp,
            Err(_) => {
                record(false);
                return None;
            }
        };

    let header = |name: &str| resp.headers().get(name).ok().flatten();
    let status = resp.status_code();
    match status {
        // 203 is a deprecated product version: still an answer, but worth a line.
        200 | 203 => {
            if status == 203 {
                console_warn!("met-no: the Locationforecast version is deprecated (HTTP 203)");
            }
            let (expires, last_modified) = (header("Expires"), header("Last-Modified"));
            let Ok(raw) = resp.json::<Value>().await else {
                record(false);
                return None;
            };
            record(true);
            let Some(converted) = met_no::convert(&raw, lat, lon, hint.as_ref()) else {
                // Valid JSON that is no forecast: not an outage, but the shape
                // may have changed.
                console_warn!("met-no: the response is not a usable forecast");
                return None;
            };
            let out = met_no::finish(&converted, now());
            if let Some(kv) = kv {
                let memo = Memo::new(
                    converted,
                    expires.as_deref(),
                    last_modified.as_deref(),
                    now_ms(),
                );
                store(ctx, kv, key, &memo);
            }
            console_log!("met-no: forecast fetched");
            out
        }
        // Not modified: the same forecast, asked for again after the new Expires.
        304 => {
            record(true);
            let memo = memo?.revalidated(header("Expires").as_deref(), now_ms());
            let out = met_no::finish(&memo.payload, now());
            if let Some(kv) = kv {
                store(ctx, kv, key, &memo);
            }
            out
        }
        429 | 403 => {
            console_warn!("met-no: refused the request (HTTP {status}); stopping for a while");
            trip();
            None
        }
        s if s >= 500 => {
            record(false);
            None
        }
        // Any other 4xx is our request: not an outage, nothing to count.
        _ => {
            console_warn!("met-no: request rejected (HTTP {status})");
            None
        }
    }
}

/// Keep the converted forecast for the next conditional request, after the
/// answer is sent.
fn store(ctx: &Context, kv: worker::kv::KvStore, key: String, memo: &Memo) {
    if let Ok(body) = serde_json::to_string(memo) {
        ctx.wait_until(async move {
            if let Ok(put) = kv.put(&key, body) {
                let _ = put.expiration_ttl(met_no::MEMO_TTL_SECONDS).execute().await;
            }
        });
    }
}
