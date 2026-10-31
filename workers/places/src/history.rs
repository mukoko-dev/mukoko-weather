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
//!    provider's span, at most six upstream calls a request (Open-Meteo's are
//!    weighted: see `open_meteo_units`). The fetched days are written back
//!    insert-only, so the next request is served from our store.
//!
//! It never fails the answer because a provider did: a failing, open, spent or
//! slow provider falls through to the next, then to what we hold.
//!
//! Three rules keep a degraded answer from becoming a wrong one:
//!
//! - When a store could not be read (the bridge timed out, or predates the
//!   history routes, or D1 failed) what we hold is UNKNOWN, so nothing is
//!   fetched (every date would look missing and reanalysis would replace days
//!   we recorded) and the answer is `no-store`.
//! - The answer is returned as soon as the days are in hand; the insert-only
//!   writes through the bridge finish in the background (`wait_until`), so a
//!   client that gives up cannot lose them. `saving: true` says so.
//! - An answer that is incomplete for any reason but the archive's plain lag
//!   (a store that could not be read, a spent budget, an open breaker, a
//!   provider failure, a per-request cap) says `degraded: true` and is
//!   `no-store`, so the client can offer a retry; only a plain archive lag is
//!   cached (60 s). A provider that failed but whose dates another provider
//!   filled is not degraded.
//!
//! Only when NO store was actually read (a spot's only store, the bridge, is
//! down, or both are) and nothing was fetched is it a 502. A store that does
//! not apply to a request (D1 for a spot) was not read, and does not count.

use std::cell::RefCell;
use std::collections::BTreeSet;

use serde_json::{json, Value};
use weather_core::breaker::{self, Breaker};
use weather_core::budget::Action;
use weather_core::community::storage_slug;
use weather_core::geo::valid_coordinates;
use weather_core::history::{
    self as h, Day, ProviderSpec, StoreRead, COORD_MAX_RANGE_DAYS, MAX_DAYS_PER_WRITE,
    MAX_FETCHES_PER_CALL, RUN_MERGE_GAP_DAYS, SOURCE_NASA_POWER, SOURCE_OPEN_METEO_ARCHIVE,
};
use weather_core::locations::{self, LocationDoc};
use weather_edge::{config, error, get_with_timeout, json, now_ms, secret, FetchError};
use worker::{Context, Env, Method, Request, Response, Result};

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
    /// Also read the days stored under the place's platform slug
    /// (`harare-35c223`), which some writers used.
    aliases: bool,
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
    ctx: &Context,
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
    // key per cell), so each stores at most the newest year, counted from
    // TODAY: a range the caller placed in 1990 is not a year they may keep.
    let mut clamped = false;
    if !target.catalogue {
        match h::clamp_recent(&range_start, &range_end, &today, COORD_MAX_RANGE_DAYS) {
            h::Clamp::Within => {}
            h::Clamp::Start(floor) => {
                range_start = floor;
                clamped = true;
            }
            h::Clamp::Outside => {
                let body = h::response(
                    &target.key,
                    &range_start,
                    &range_end,
                    vec![],
                    0,
                    true,
                    false,
                );
                return stamped(body, 0, CachePolicy::Public(600));
            }
        }
    }

    // 1 + 2: what we hold.
    let (d1, d1_read) = read_d1(env, &target, &range_start, &range_end).await;
    let (mongo, mongo_read) = read_bridge(env, &target, &range_start, &range_end).await;
    let mut docs = d1;
    docs.extend(mongo);
    let order = target.mongo_keys.clone();
    let mut stored = h::merge_by_date(docs, &order);
    // When a store could not be read, what we hold is UNKNOWN: every date would
    // look missing, and an archive's reanalysis would replace days we recorded.
    let holdings_known = h::holdings_known(d1_read, mongo_read);
    let existing = h::dates_of(&stored);

    // 3: the rest from the archives (only when we know what is missing).
    let missing = h::missing_dates(&existing, &range_start, &range_end, target.lon, now);
    let mut fetched: Vec<Value> = Vec::new();
    let mut still_missing = missing.len();
    let mut upstream_trouble = false;
    let mut pending: Vec<Value> = Vec::new();
    if holdings_known && !missing.is_empty() {
        let caller = Caller::from_request(req);
        let out = backfill(env, &caller, &target, &missing).await;
        still_missing = out.remaining;
        upstream_trouble = out.degraded;
        pending = out.docs.clone();
        fetched = out.docs;
    }
    let degraded = h::is_degraded(holdings_known, upstream_trouble, still_missing);
    let backfilled = fetched.len();
    if backfilled > 0 {
        stored.extend(fetched);
        stored = h::merge_by_date(stored, &order);
    }

    // No store was actually read and nothing was fetched: say so rather than
    // "no history". (A store that did not apply, like D1 for a spot, was not
    // read: a spot whose bridge is down has read nothing.)
    if stored.is_empty() && h::no_store_read(d1_read, mongo_read) {
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
        !pending.is_empty(),
    );
    if degraded {
        body["degraded"] = json!(true);
    }
    // Answer first, store after: the days are in hand, and a client that gives
    // up (or a slow bridge) must not lose them. `wait_until` keeps the Worker
    // alive for the writes, which are insert-only and so safe to repeat.
    if !pending.is_empty() {
        let env = env.clone();
        let key = target.mongo_keys[0].clone();
        ctx.wait_until(async move {
            if let Err(why) = save(&env, &key, &pending).await {
                // Status and the bridge's own error code only: no URL, no body.
                worker::console_warn!(
                    "history: could not store {} archive days: {why}",
                    pending.len()
                );
            }
        });
    }
    let policy = if degraded {
        // A budget, an outage, an open breaker or an unreadable store made
        // this answer: the next call may well do better.
        CachePolicy::NoStore
    } else if still_missing > 0 {
        // Only the archive lag: a minute is long enough.
        CachePolicy::Public(60)
    } else {
        CachePolicy::Public(600)
    };
    stamped(body, still_missing, policy)
}

enum CachePolicy {
    NoStore,
    Public(u32),
}

fn stamped(mut body: Value, missing: usize, policy: CachePolicy) -> Result<Response> {
    body["missing"] = json!(missing);
    let resp = json(200, &body)?;
    let value = match policy {
        CachePolicy::NoStore => "no-store".to_owned(),
        CachePolicy::Public(s) => format!("public, max-age={s}"),
    };
    resp.headers().set("Cache-Control", &value)?;
    Ok(resp)
}

fn target_of(loc: &LocationDoc) -> Target {
    let catalogue = locations::find_seed(&loc.slug).is_some() || loc.source == "places";
    let storage = storage_slug(&loc.slug, catalogue);
    Target {
        key: loc.slug.clone(),
        mongo_keys: vec![storage],
        d1_slug: catalogue.then(|| loc.slug.clone()),
        aliases: catalogue,
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
        aliases: false,
        lat,
        lon,
        catalogue: false,
    }
}

/// The days the jobs Worker recorded. D1 holds nothing for a spot or a bare
/// coordinate, so it is not asked (`NotApplicable`: not a read); `Failed` when
/// it could not be read.
async fn read_d1(env: &Env, t: &Target, start: &str, end: &str) -> (Vec<Value>, StoreRead) {
    let Some(slug) = &t.d1_slug else {
        return (Vec::new(), StoreRead::NotApplicable);
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
        return (Vec::new(), StoreRead::Failed);
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
    (docs, StoreRead::Read)
}

/// The days MongoDB holds, through the bridge. `Failed` when it did not answer
/// (a timeout, a 5xx, or a bridge without the history routes).
async fn read_bridge(env: &Env, t: &Target, start: &str, end: &str) -> (Vec<Value>, StoreRead) {
    let mut path = format!("/history?start={start}&end={end}");
    for k in &t.mongo_keys {
        path.push_str("&slug=");
        path.push_str(&url_encode(k));
    }
    // A place's days may sit under its platform slug (`harare-35c223`) too. The
    // bridge finds that slug from the place record near these coordinates (the
    // catalogue place's own point), never from the name alone.
    if t.aliases && t.mongo_keys.len() == 1 {
        path.push_str(&format!("&aliases=1&lat={:.4}&lon={:.4}", t.lat, t.lon));
    }
    match bridge::call(env, Method::Get, &path, None).await {
        bridge::Answer::Relay { status: 200, body } => (
            body["days"].as_array().cloned().unwrap_or_default(),
            StoreRead::Read,
        ),
        _ => (Vec::new(), StoreRead::Failed),
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
    /// A budget, an open breaker, a provider failure or a per-request cap cut
    /// the attempt short (not a plain archive lag).
    degraded: bool,
}

async fn backfill(env: &Env, caller: &Caller, t: &Target, missing: &[String]) -> Backfill {
    let chain = chain(env);
    let key = t.mongo_keys[0].clone();
    let started = now_ms();
    let mut fetches = 0usize;
    let mut om_units = 0u32;
    let mut unusable: BTreeSet<&'static str> = BTreeSet::new();
    let mut docs: Vec<Value> = Vec::new();
    let mut degraded = false;
    // The request-level budget is spent once, and only when a call is about to
    // go upstream: an answer served from our own KV costs nothing.
    let mut request_budget: Option<bool> = None;
    let mut left: BTreeSet<String> = missing.iter().cloned().collect();

    'runs: for (run_start, run_end) in h::group_runs(missing, RUN_MERGE_GAP_DAYS).into_iter().rev()
    {
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
                // The clock: no new chunk (not even a cached one) after the
                // time budget. A chunk is still waiting, so the answer is cut
                // short: say so (it is not cached as a plain lag).
                if now_ms() - started > TIME_BUDGET_MS {
                    degraded = true;
                    break 'runs;
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
                        // The cap on upstream calls a request may start. A
                        // chunk from our own KV above never counts against it.
                        if fetches >= MAX_FETCHES_PER_CALL {
                            degraded = true;
                            break 'runs;
                        }
                        if !with_breaker(spec.id, |b| b.allow(now_ms())) {
                            degraded = true;
                            unusable.insert(spec.id);
                            break;
                        }
                        let units = spec.cost(h::span_days(&c_start, &c_end));
                        if om_units.saturating_add(units) > spec.units_per_call() {
                            // The per-request cap on Open-Meteo's weighted
                            // calls: the rest of this range is left for a
                            // later request, so the answer is cut short.
                            degraded = true;
                            unusable.insert(spec.id);
                            break;
                        }
                        if request_budget.is_none() {
                            let action = if t.catalogue {
                                Action::HistoryBackfill
                            } else {
                                Action::HistoryBackfillCoords
                            };
                            request_budget =
                                Some(budget::take(env, action, caller).await.allowed());
                        }
                        if request_budget == Some(false) {
                            degraded = true;
                            break 'runs;
                        }
                        let action = if spec.id == SOURCE_NASA_POWER {
                            Action::HistoryNasaPower
                        } else {
                            Action::HistoryOpenMeteo
                        };
                        if !budget::take_units(env, action, caller, units)
                            .await
                            .allowed()
                        {
                            degraded = true;
                            unusable.insert(spec.id);
                            break;
                        }
                        fetches += 1;
                        if spec.id == SOURCE_OPEN_METEO_ARCHIVE {
                            om_units += units;
                        }
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
                                degraded = true;
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
                docs.extend(chunk);
            }
        }
    }
    Backfill {
        docs,
        remaining: left.len(),
        degraded,
    }
}

/// Insert-only through the bridge, in batches the bridge accepts. Every batch
/// is tried; `Err` is the reason the first failing one gave (the HTTP status
/// and the bridge's error code, for a log line).
async fn save(env: &Env, key: &str, docs: &[Value]) -> std::result::Result<(), String> {
    let mut first_failure: Option<String> = None;
    for batch in docs.chunks(MAX_DAYS_PER_WRITE) {
        let body = json!({
            "slug": key,
            "days": batch.iter().map(h::to_archive_day).collect::<Vec<_>>(),
        });
        match bridge::call(env, Method::Post, "/history/days", Some(&body)).await {
            bridge::Answer::Relay { status: 200, .. } => {}
            other => {
                first_failure.get_or_insert_with(|| other.failure_reason());
            }
        }
    }
    first_failure.map_or(Ok(()), Err)
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
    Ok(h::parse_provider(spec.id, &payload))
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
