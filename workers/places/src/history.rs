//! `GET /history`: our own store first, an external archive for the rest
//! (#268). The rules are `weather_core::history` (tested natively against the
//! real Python functions of PR #285); this file only does the I/O.
//!
//! ```text
//! GET /history?location=harare&days=30
//! GET /history?location=harare&start=2020-01-01&end=2020-12-31
//! GET /history?lat=51.5072&lon=-0.1276&days=365
//! ```
//!
//! What it reads, in order:
//!
//! 1. D1 `place_daily`: the days `mukoko-weather-jobs` RECORDED from the
//!    forecast (one a day for every seed place).
//! 2. MongoDB `weather.weather_history` through the bridge: the days the old
//!    Python backend recorded and every archive day we filled before. Workers
//!    never write MongoDB directly; the bridge validates and inserts.
//! 3. For the past dates neither holds: NASA POWER, then Open-Meteo's archive
//!    (order from `HISTORY_PROVIDERS`), newest runs first, chunked to each
//!    provider's span, at most six upstream calls a request. Each chunk is
//!    written back insert-only as soon as it lands, so the next request is
//!    served from our store.
//!
//! It never fails the answer because a provider did: a failing, open, spent or
//! slow provider falls through to the next, then to what we hold. A bridge that
//! is down means the fetched days are served but not saved (`saved: false`).
//! Only when nothing at all could be read AND nothing fetched is it a 502.

use std::cell::RefCell;
use std::collections::BTreeSet;

use serde_json::{json, Value};
use weather_core::breaker::{self, Breaker};
use weather_core::budget::Action;
use weather_core::community::storage_slug;
use weather_core::geo::valid_coordinates;
use weather_core::history::{
    self as h, Day, ProviderSpec, COORD_MAX_RANGE_DAYS, MAX_DAYS_PER_WRITE, MAX_FETCHES_PER_CALL,
    RUN_MERGE_GAP_DAYS, SOURCE_NASA_POWER, SOURCE_OPEN_METEO_ARCHIVE,
};
use weather_core::locations::{self, LocationDoc};
use weather_edge::{config, error, get_with_timeout, json, now_ms, secret, FetchError};
use worker::{Env, Method, Request, Response, Result};

use crate::bridge;
use crate::budget::{self, Caller};

const DB: &str = "WEATHER_DB";
const CACHE: &str = "CACHE";
/// Provider answers are kept for three hours: a chunk's newest days may not be
/// published yet, and an empty chunk must not be asked again on every view.
const CHUNK_TTL_S: u64 = 3 * 3600;
/// No new upstream call is started after this long into a request.
const TIME_BUDGET_MS: u64 = 20_000;
/// The optional Open-Meteo commercial key (a paid plan). Not bound as a Secrets
/// Store secret on purpose: a binding to a store secret that does not exist
/// fails the deploy.
const OPEN_METEO_KEY: &str = "OPEN_METEO_API_KEY";

thread_local! {
    static NASA: RefCell<Breaker> = const { RefCell::new(Breaker::new(breaker::NASA_POWER)) };
    static OPEN_METEO: RefCell<Breaker> = const { RefCell::new(Breaker::new(breaker::OPEN_METEO)) };
}

fn with_breaker<T>(id: &str, f: impl FnOnce(&mut Breaker) -> T) -> T {
    if id == SOURCE_NASA_POWER {
        NASA.with(|b| f(&mut b.borrow_mut()))
    } else {
        OPEN_METEO.with(|b| f(&mut b.borrow_mut()))
    }
}

/// How a provider call failed. Only the transient ones count against its breaker.
struct ProviderError {
    transient: bool,
    what: String,
}

fn query_has(q: &[(String, String)], k: &str) -> Option<String> {
    q.iter()
        .find(|(n, _)| n == k)
        .map(|(_, v)| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

struct Target {
    /// What the response calls the location.
    key: String,
    /// Keys under which MongoDB holds its days (the canonical one first).
    mongo_keys: Vec<String>,
    /// The D1 `place_daily` slug, for a place the jobs record.
    d1_slug: Option<String>,
    lat: f64,
    lon: f64,
    /// A catalogue place (a seed or a canonical place) rather than a spot or a
    /// bare coordinate: only these may ask for the full range.
    catalogue: bool,
}

/// The validated query.
pub struct Params {
    pub location: Option<String>,
    lat_lon: Option<(f64, f64)>,
    days: Option<i64>,
    start: Option<String>,
    end: Option<String>,
}

/// Check the query before any lookup. `Err` is the response to send.
#[allow(clippy::result_large_err)]
pub fn validate(q: &[(String, String)]) -> std::result::Result<Params, Result<Response>> {
    let location = query_has(q, "location");
    let lat_lon = match (
        query_has(q, "lat").and_then(|v| v.parse::<f64>().ok()),
        query_has(q, "lon").and_then(|v| v.parse::<f64>().ok()),
    ) {
        (Some(a), Some(b)) => Some((a, b)),
        _ => None,
    };
    if location.is_none() && lat_lon.is_none() {
        return Err(error(
            400,
            "invalid_request",
            "Missing location parameter (or lat and lon)",
        ));
    }
    if let Some((a, b)) = lat_lon {
        if !valid_coordinates(a, b) {
            return Err(error(400, "invalid_request", "Invalid coordinates"));
        }
    }
    let days = match query_has(q, "days") {
        None => None,
        Some(v) => match v.parse::<i64>() {
            Ok(d) if (1..=h::MAX_RANGE_DAYS).contains(&d) => Some(d),
            _ => {
                return Err(error(
                    400,
                    "invalid_request",
                    &format!("days must be between 1 and {}", h::MAX_RANGE_DAYS),
                ))
            }
        },
    };
    let (start, end) = (query_has(q, "start"), query_has(q, "end"));
    for (name, v) in [("start", &start), ("end", &end)] {
        if v.as_deref().is_some_and(|v| h::valid_date(v).is_none()) {
            return Err(error(
                400,
                "invalid_request",
                &format!("{name} must be YYYY-MM-DD"),
            ));
        }
    }
    Ok(Params {
        location,
        lat_lon,
        days,
        start,
        end,
    })
}

/// Answer a validated request. `found` is the lookup of `params.location`
/// (`None` when there was none).
pub async fn serve(
    req: &Request,
    env: &Env,
    params: Params,
    found: Option<std::result::Result<Option<LocationDoc>, ()>>,
) -> Result<Response> {
    let Params {
        lat_lon,
        days,
        start,
        end,
        ..
    } = params;
    // A lookup ERROR is 503 even with coordinates: falling back to the cell
    // would hide the place's recorded days and fetch a duplicate set.
    let target = match found {
        Some(Ok(Some(loc))) => target_of(&loc),
        Some(Ok(None)) | None => match lat_lon {
            Some((a, b)) => cell_target(a, b),
            None => return error(404, "not_found", "Unknown location"),
        },
        Some(Err(())) => return error(503, "places_unavailable", "Location service unavailable"),
    };

    let now = now_ms();
    let today = h::local_today(target.lon, now);
    let (mut range_start, range_end) =
        match h::resolve_range(days, start.as_deref(), end.as_deref(), &today) {
            Ok(r) => r,
            Err(detail) => return error(400, "invalid_request", &detail),
        };
    // Spots and bare coordinates are anonymous and unbounded in number (one
    // key per cell), so each stores at most a year.
    let mut clamped = false;
    if !target.catalogue {
        let floor = window_floor(&range_end, COORD_MAX_RANGE_DAYS);
        if range_start < floor {
            range_start = floor;
            clamped = true;
        }
    }

    // 1 + 2: what we hold.
    let (d1, d1_ok) = read_d1(env, &target, &range_start, &range_end).await;
    let (mongo, mongo_ok) = read_bridge(env, &target, &range_start, &range_end).await;
    let mut docs = d1;
    docs.extend(mongo);
    let order = target.mongo_keys.clone();
    let mut stored = h::merge_by_date(docs, &order);
    let existing = h::dates_of(&stored);

    // 3: the rest from the archives.
    let missing = h::missing_dates(&existing, &range_start, &range_end, target.lon, now);
    let mut fetched: Vec<Value> = Vec::new();
    let mut saved: Option<bool> = None;
    let mut still_missing = missing.len();
    if !missing.is_empty() {
        let caller = Caller::from_request(req);
        let action = if target.catalogue {
            Action::HistoryBackfill
        } else {
            Action::HistoryBackfillCoords
        };
        if budget::take(env, action, &caller).await.allowed() {
            let out = backfill(env, &caller, &target, &missing).await;
            still_missing = out.remaining;
            saved = out.saved;
            fetched = out.docs;
        }
    }
    let backfilled = fetched.len();
    if backfilled > 0 {
        stored.extend(fetched);
        stored = h::merge_by_date(stored, &order);
    }

    // Nothing readable and nothing fetched: say so rather than "no history".
    if stored.is_empty() && !d1_ok && !mongo_ok {
        return error(
            502,
            "history_unavailable",
            "Failed to fetch weather history",
        );
    }

    let mut body = h::response(
        &target.key,
        &range_start,
        &range_end,
        stored,
        backfilled,
        clamped,
        saved,
    );
    body["missing"] = json!(still_missing);
    let resp = json(200, &body)?;
    // A request that left dates unfilled (a lag, an outage, a spent budget)
    // must not be pinned for ten minutes.
    let ttl = if still_missing > 0 { 60 } else { 600 };
    resp.headers()
        .set("Cache-Control", &format!("public, max-age={ttl}"))?;
    Ok(resp)
}

fn window_floor(end: &str, max_days: i64) -> String {
    h::window_for_days(max_days, end).0
}

fn target_of(loc: &LocationDoc) -> Target {
    let catalogue = locations::find_seed(&loc.slug).is_some() || loc.source == "places";
    let storage = storage_slug(&loc.slug, catalogue);
    Target {
        key: loc.slug.clone(),
        mongo_keys: vec![storage],
        d1_slug: catalogue.then(|| loc.slug.clone()),
        lat: loc.lat,
        lon: loc.lon,
        catalogue,
    }
}

fn cell_target(lat: f64, lon: f64) -> Target {
    let key = h::cell_key(lat, lon);
    Target {
        key: key.clone(),
        mongo_keys: vec![key],
        d1_slug: None,
        lat,
        lon,
        catalogue: false,
    }
}

/// The days the jobs Worker recorded. `false` when D1 could not be read.
async fn read_d1(env: &Env, t: &Target, start: &str, end: &str) -> (Vec<Value>, bool) {
    let Some(slug) = &t.d1_slug else {
        return (Vec::new(), true);
    };
    let rows = async {
        env.d1(DB)?
            .prepare(
                "SELECT slug, date, recorded_at, source, current, daily, insights \
                 FROM place_daily WHERE slug = ?1 AND date >= ?2 AND date <= ?3 \
                 ORDER BY date DESC LIMIT 3700",
            )
            .bind(&[slug.as_str().into(), start.into(), end.into()])?
            .all()
            .await?
            .results::<Value>()
    }
    .await;
    let Ok(rows) = rows else {
        return (Vec::new(), false);
    };
    let docs = rows
        .iter()
        .filter_map(|r| {
            let s = |k: &str| r.get(k).and_then(Value::as_str);
            Some(h::recorded_from_d1(
                slug,
                s("date")?,
                r.get("recorded_at").and_then(Value::as_f64).unwrap_or(0.0) as i64,
                s("source").unwrap_or("unknown"),
                s("current"),
                s("daily"),
                s("insights"),
            ))
        })
        .collect();
    (docs, true)
}

/// The days MongoDB holds, through the bridge. `false` when it did not answer.
async fn read_bridge(env: &Env, t: &Target, start: &str, end: &str) -> (Vec<Value>, bool) {
    let mut path = format!("/history?start={start}&end={end}");
    for k in &t.mongo_keys {
        path.push_str("&slug=");
        path.push_str(&url_encode(k));
    }
    match bridge::call(env, Method::Get, &path, None).await {
        bridge::Answer::Relay { status: 200, body } => {
            (body["days"].as_array().cloned().unwrap_or_default(), true)
        }
        _ => (Vec::new(), false),
    }
}

fn url_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

struct Backfill {
    docs: Vec<Value>,
    /// Dates still missing after the attempt.
    remaining: usize,
    /// `Some(false)` when days were fetched but could not be stored.
    saved: Option<bool>,
}

async fn backfill(env: &Env, caller: &Caller, t: &Target, missing: &[String]) -> Backfill {
    let chain = chain(env);
    let key = t.mongo_keys[0].clone();
    let started = now_ms();
    let mut fetches = 0usize;
    let mut unusable: BTreeSet<&'static str> = BTreeSet::new();
    let mut docs: Vec<Value> = Vec::new();
    let mut saved: Option<bool> = None;
    let mut left: BTreeSet<String> = missing.iter().cloned().collect();

    let out_of_budget =
        |fetches: usize| fetches >= MAX_FETCHES_PER_CALL || now_ms() - started > TIME_BUDGET_MS;

    for (run_start, run_end) in h::group_runs(missing, RUN_MERGE_GAP_DAYS).into_iter().rev() {
        let mut remaining: BTreeSet<String> = left
            .iter()
            .filter(|d| **d >= run_start && **d <= run_end)
            .cloned()
            .collect();
        for spec in &chain {
            if remaining.is_empty() {
                break;
            }
            if unusable.contains(spec.id) {
                continue;
            }
            for (c_start, c_end) in h::chunks_for(spec, &remaining) {
                if out_of_budget(fetches) {
                    break;
                }
                // Our own KV first: no upstream call, no budget.
                let cache_key = format!(
                    "hist:v1:{}:{}:{c_start}:{c_end}",
                    spec.id,
                    h::cell_key(t.lat, t.lon)
                );
                let days = match cached_days(env, &cache_key).await {
                    Some(d) => d,
                    None => {
                        if !with_breaker(spec.id, |b| b.allow(now_ms())) {
                            unusable.insert(spec.id);
                            break;
                        }
                        let action = if spec.id == SOURCE_NASA_POWER {
                            Action::HistoryNasaPower
                        } else {
                            Action::HistoryOpenMeteo
                        };
                        if !budget::take(env, action, caller).await.allowed() {
                            unusable.insert(spec.id);
                            break;
                        }
                        fetches += 1;
                        match fetch(env, spec, t.lat, t.lon, &c_start, &c_end).await {
                            Ok(d) => {
                                with_breaker(spec.id, Breaker::record_success);
                                store_days(env, &cache_key, &d).await;
                                d
                            }
                            Err(e) => {
                                if e.transient {
                                    with_breaker(spec.id, |b| b.record_failure(now_ms()));
                                }
                                worker::console_warn!(
                                    "history: {} failed for {c_start}..{c_end}: {}",
                                    spec.id,
                                    e.what
                                );
                                unusable.insert(spec.id);
                                break;
                            }
                        }
                    }
                };
                let now_iso = weather_edge::now_rfc3339();
                let chunk: Vec<Value> = days
                    .iter()
                    .filter(|d| {
                        d.get("date")
                            .and_then(Value::as_str)
                            .is_some_and(|x| remaining.contains(x))
                    })
                    .map(|d| h::build_history_doc(&key, d, spec.id, &now_iso))
                    .collect();
                for doc in &chunk {
                    if let Some(date) = doc["date"].as_str() {
                        remaining.remove(date);
                        left.remove(date);
                    }
                }
                if !chunk.is_empty() {
                    let ok = save(env, &key, &chunk).await;
                    saved = Some(saved.unwrap_or(true) && ok);
                    docs.extend(chunk);
                }
            }
        }
    }
    Backfill {
        docs,
        remaining: left.len(),
        saved,
    }
}

/// Insert-only through the bridge, in batches the bridge accepts.
async fn save(env: &Env, key: &str, docs: &[Value]) -> bool {
    let mut all_ok = true;
    for batch in docs.chunks(MAX_DAYS_PER_WRITE) {
        let body = json!({
            "slug": key,
            "days": batch.iter().map(h::to_archive_day).collect::<Vec<_>>(),
        });
        let ok = matches!(
            bridge::call(env, Method::Post, "/history/days", Some(&body)).await,
            bridge::Answer::Relay { status: 200, .. }
        );
        all_ok &= ok;
    }
    all_ok
}

fn chain(env: &Env) -> Vec<&'static ProviderSpec> {
    let commercial_only = config(env, "HISTORY_COMMERCIAL_ONLY")
        .is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes"));
    let paid = config(env, OPEN_METEO_KEY).is_some();
    h::provider_chain(
        config(env, "HISTORY_PROVIDERS").as_deref(),
        commercial_only,
        paid,
    )
}

async fn fetch(
    env: &Env,
    spec: &ProviderSpec,
    lat: f64,
    lon: f64,
    start: &str,
    end: &str,
) -> std::result::Result<Vec<Day>, ProviderError> {
    let url = match spec.id {
        SOURCE_NASA_POWER => h::nasa_power_url(lat, lon, start, end),
        SOURCE_OPEN_METEO_ARCHIVE => {
            let key = secret(env, OPEN_METEO_KEY).await;
            h::open_meteo_archive_url(lat, lon, start, end, key.as_deref())
        }
        _ => {
            return Err(ProviderError {
                transient: false,
                what: "unknown provider".into(),
            })
        }
    };
    let timeout = std::time::Duration::from_secs(spec.timeout_s);
    let mut resp = match get_with_timeout(&url, None, timeout).await {
        Ok(r) => r,
        // Never log the URL: it can carry a key.
        Err(FetchError::Timeout) => {
            return Err(ProviderError {
                transient: true,
                what: "timeout".into(),
            })
        }
        Err(_) => {
            return Err(ProviderError {
                transient: true,
                what: "transport error".into(),
            })
        }
    };
    let status = resp.status_code();
    if status != 200 {
        return Err(ProviderError {
            transient: h::status_is_transient(status),
            what: format!("HTTP {status}"),
        });
    }
    let payload = resp.json::<Value>().await.map_err(|_| ProviderError {
        transient: true,
        what: "invalid JSON".into(),
    })?;
    Ok(h::parse_provider(spec.id, &payload, lat, lon))
}

async fn cached_days(env: &Env, key: &str) -> Option<Vec<Day>> {
    env.kv(CACHE)
        .ok()?
        .get(key)
        .json::<Vec<Day>>()
        .await
        .ok()
        .flatten()
}

async fn store_days(env: &Env, key: &str, days: &[Day]) {
    let (Ok(kv), Ok(body)) = (env.kv(CACHE), serde_json::to_string(days)) else {
        return;
    };
    if let Ok(put) = kv.put(key, body) {
        let _ = put.expiration_ttl(CHUNK_TTL_S).execute().await;
    }
}
