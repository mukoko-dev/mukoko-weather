//! The fetch layer for the external station feeds (`external_feeds`), as pure
//! code behind a [`Transport`] trait. Issue #361.
//!
//! Nothing here opens a socket. A Worker implements [`Transport`] over its own
//! `fetch`; tests implement it over recorded fixtures. What this module owns
//! is everything around the call that must be the same wherever it runs:
//!
//! - **Which request.** The URLs, the headers (a polite `User-Agent` that
//!   names a contact, an `Accept`, no credentials of any kind: both feeds are
//!   keyless) and a timeout per request.
//! - **Whether to call at all.** [`FeedSwitches`] is OFF by default for both
//!   feeds, so wiring a Worker to this module calls nothing until its
//!   configuration says so. SAAOPA publishes no terms and its switch stays off
//!   until permission is recorded in #361; WIS2 is open under WMO's core data
//!   policy but is still off by default, because the store the observations go
//!   to is not decided. A switched-off feed makes no request and returns
//!   [`FetchError::Disabled`].
//! - **How often.** [`FeedPolicy`] holds each feed's minimum interval (never
//!   faster than the feed updates), its back-off after failures and its
//!   timeout. [`due`] and [`backoff_ms`] are the pure rules a scheduler asks.
//! - **What counts as a failure.** [`FetchError::counts_against_breaker`] is
//!   the same rule as the forecast Worker's providers: transport errors,
//!   timeouts, 5xx, 429 and a body that is not what the feed documents count;
//!   a 4xx is our request and never opens the breaker. The breaker itself
//!   (`breaker::EXTERNAL_FEED`) is owned by the caller, one per feed, and
//!   passed in with the clock.
//! - **Paging.** WIS2 pages by feature and a page boundary can cut a station
//!   hour in two (see `external_feeds`). [`Fetcher::wis2`] collects the pages
//!   of one window and groups them as ONE collection, so a cut inside the
//!   window is repaired here; a cut at the edge of the window, or a later page
//!   that fails, is reported as `complete: false` and the writer merges per
//!   measure, as `external_feeds` documents.
//!
//! Errors carry a stable code and a status number, never a URL, a body or a
//! message from the upstream, so logging one cannot leak anything.
//!
//! **Not verified against the live nodes** (the first scheduled call is the
//! owner's gate, and this module was written from the documented formats and
//! the recorded fixtures only): the WIS2 query parameters (`f`, `datetime`,
//! `limit`, `offset` are OGC API - Features conventions; `offset` is the
//! pygeoapi extension this node is expected to run). Correctness does not
//! depend on the server honouring the `datetime` window: rows outside it are
//! dropped here, and a server that ignores `limit` or `offset` costs at most
//! `max_pages` requests.

use std::collections::BTreeSet;

use chrono::{DateTime, Duration, Utc};
use serde_json::{json, Value};

use crate::breaker::Breaker;
use crate::external_feeds::{
    rfc3339, saaopa_aws_registry, saaopa_status_observations, wis2_observations, FeedObservation,
    SaaopaStation,
};

/// The Zimbabwe MSD WIS2 node, surface weather observations (OGC API
/// Features, GeoJSON).
pub const WIS2_ITEMS_URL: &str = "https://wis2.weatherzw.org.zw/oapi/collections/urn:wmo:md:zw-msd:surface-weather-observations/items";
/// SAAOPA WX-CoPilot: current reading and age for every station.
pub const SAAOPA_STATUS_URL: &str = "https://wx-api.saaopa.org/stations/status";
/// SAAOPA WX-CoPilot: the station registry.
pub const SAAOPA_STATIONS_URL: &str = "https://wx-api.saaopa.org/stations";

/// Where a feed's operator can reach us. Goes in the `User-Agent`.
pub const CONTACT: &str = "hi@mukoko.com";
/// A response bigger than this is not what the feed documents.
pub const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
/// A SAAOPA reading older than this is skipped. The stations report about
/// every 10 minutes, so this is three missed reports.
pub const SAAOPA_MAX_AGE_MINUTES: u32 = 30;
/// A WIS2 report stamped later than this after `now` comes from a station
/// with a wrong clock and is dropped.
pub const MAX_FUTURE_SKEW_MINUTES: i64 = 10;

const ACCEPT_GEOJSON: &str = "application/geo+json, application/json";
const ACCEPT_JSON: &str = "application/json";

/// The `User-Agent` for every request: who we are, where to read about us and
/// whom to write to. The version is reduced to characters a header can carry.
pub fn user_agent(version: &str) -> String {
    let v: String = version
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
        .collect();
    format!("mukoko-weather-jobs/{v} (+https://weather.mukoko.com; {CONTACT})")
}

/// The feeds this module can read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Feed {
    Wis2ZwMsd,
    SaaopaStatus,
    SaaopaRegistry,
}

impl Feed {
    /// A stable name for logs and status rows.
    pub fn name(self) -> &'static str {
        match self {
            Self::Wis2ZwMsd => "wis2-zw-msd",
            Self::SaaopaStatus => "saaopa-status",
            Self::SaaopaRegistry => "saaopa-registry",
        }
    }

    pub fn policy(self) -> FeedPolicy {
        match self {
            Self::Wis2ZwMsd => WIS2_POLICY,
            Self::SaaopaStatus => SAAOPA_STATUS_POLICY,
            Self::SaaopaRegistry => SAAOPA_REGISTRY_POLICY,
        }
    }
}

/// How often and how patiently one feed is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FeedPolicy {
    /// No attempt sooner than this after the previous one. A little under
    /// the feed's own cadence, so a cron tick that fires a few seconds early
    /// is not refused; the cron expression sets the real cadence.
    pub min_interval_ms: u64,
    /// The longest wait after repeated failures.
    pub max_backoff_ms: u64,
    /// Per request.
    pub timeout_ms: u32,
}

const MINUTE: u64 = 60_000;
const HOUR: u64 = 60 * MINUTE;

/// WIS2 publishes hourly (the cron plan is :10 past the hour).
pub const WIS2_POLICY: FeedPolicy = FeedPolicy {
    min_interval_ms: 55 * MINUTE,
    max_backoff_ms: 6 * HOUR,
    timeout_ms: 15_000,
};
/// SAAOPA stations report about every 10 minutes.
pub const SAAOPA_STATUS_POLICY: FeedPolicy = FeedPolicy {
    min_interval_ms: 9 * MINUTE,
    max_backoff_ms: 2 * HOUR,
    timeout_ms: 10_000,
};
/// The registry changes rarely; it feeds a reviewed import, not a poll.
pub const SAAOPA_REGISTRY_POLICY: FeedPolicy = FeedPolicy {
    min_interval_ms: 6 * HOUR,
    max_backoff_ms: 24 * HOUR,
    timeout_ms: 10_000,
};

/// How long to wait after `consecutive_failures` failed attempts in a row:
/// the minimum interval, doubled per failure, up to the policy's ceiling.
pub fn backoff_ms(policy: &FeedPolicy, consecutive_failures: u32) -> u64 {
    policy
        .min_interval_ms
        .saturating_mul(1u64 << consecutive_failures.min(16))
        .min(policy.max_backoff_ms.max(policy.min_interval_ms))
}

/// Whether a feed may be attempted now: never attempted, or the wait for its
/// failure count has passed. `last_attempt_ms` is when the previous attempt
/// STARTED (success or not).
pub fn due(
    policy: &FeedPolicy,
    last_attempt_ms: Option<u64>,
    consecutive_failures: u32,
    now_ms: u64,
) -> bool {
    match last_attempt_ms {
        None => true,
        Some(last) => now_ms.saturating_sub(last) >= backoff_ms(policy, consecutive_failures),
    }
}

/// Which feeds may be called. Off by default: the safe state of a Worker that
/// has been wired to this module but not yet configured.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FeedSwitches {
    pub wis2: bool,
    /// Covers both SAAOPA routes. Stays off until SAAOPA's permission is
    /// recorded in #361.
    pub saaopa: bool,
}

impl FeedSwitches {
    pub fn allows(self, feed: Feed) -> bool {
        match feed {
            Feed::Wis2ZwMsd => self.wis2,
            Feed::SaaopaStatus | Feed::SaaopaRegistry => self.saaopa,
        }
    }
}

/// One GET. No body, no method: the feeds are read-only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub url: String,
    pub headers: Vec<(&'static str, String)>,
    pub timeout_ms: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

/// Why no response came back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportError {
    Timeout,
    Network,
}

/// What a runtime supplies: one GET with a timeout. In a Worker this wraps
/// `fetch`; its future is not `Send`, which is why the trait is not either.
#[allow(async_fn_in_trait)]
pub trait Transport {
    async fn get(&self, req: &HttpRequest) -> Result<HttpResponse, TransportError>;
}

/// Why a fetch produced nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchError {
    /// The feed's switch is off. No request was made.
    Disabled(Feed),
    /// The breaker is open. No request was made.
    CircuitOpen,
    Timeout,
    Transport,
    /// The feed answered with this status (anything outside 2xx).
    Status(u16),
    /// A 2xx that is not what the feed documents.
    BadBody(&'static str),
}

impl FetchError {
    /// Whether this failure counts toward opening the breaker: the feed is
    /// unwell (transport, timeout, 5xx, 429, a body that is not the feed's).
    /// A 4xx or an unfollowed redirect is our request, and does not.
    pub fn counts_against_breaker(self) -> bool {
        match self {
            Self::Timeout | Self::Transport | Self::BadBody(_) => true,
            Self::Status(s) => s >= 500 || s == 429,
            Self::Disabled(_) | Self::CircuitOpen => false,
        }
    }

    /// A stable machine-readable code for logs and status rows.
    pub fn code(self) -> &'static str {
        match self {
            Self::Disabled(_) => "disabled",
            Self::CircuitOpen => "circuit_open",
            Self::Timeout => "timeout",
            Self::Transport => "transport",
            Self::Status(429) => "rate_limited",
            Self::Status(s) if s >= 500 => "upstream_5xx",
            Self::Status(_) => "upstream_4xx",
            Self::BadBody(why) => why,
        }
    }
}

/// What a successful fetch returns.
#[derive(Debug, Clone, PartialEq)]
pub struct Fetched<T> {
    pub items: Vec<T>,
    /// Requests actually made.
    pub requests: u32,
    /// `false` when the window may hold more than `items`: the page limit was
    /// reached with a full page, or a later page failed. The writer merges
    /// per measure either way.
    pub complete: bool,
}

/// How WIS2 is paged and windowed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Wis2Query {
    /// Features per page (`limit`). One station-hour is up to six features.
    pub page_size: u32,
    pub max_pages: u32,
    /// Look back this far from now: the last hour plus a six-hour overlap, so
    /// a late or cut report is repaired by the next run.
    pub window_minutes: u32,
}

pub const DEFAULT_WIS2_QUERY: Wis2Query = Wis2Query {
    page_size: 500,
    max_pages: 4,
    window_minutes: 7 * 60,
};

/// The WIS2 URL for one page of one window.
pub fn wis2_url(from: DateTime<Utc>, to: DateTime<Utc>, limit: u32, offset: u32) -> String {
    format!(
        "{WIS2_ITEMS_URL}?f=json&datetime={}/{}&limit={limit}&offset={offset}",
        rfc3339(from),
        rfc3339(to)
    )
}

fn millis(t: DateTime<Utc>) -> u64 {
    u64::try_from(t.timestamp_millis()).unwrap_or(0)
}

fn is_feature_collection(v: &Value) -> bool {
    v.get("features").is_some_and(Value::is_array)
}

fn is_array(v: &Value) -> bool {
    v.is_array()
}

/// Reads the feeds through a [`Transport`].
pub struct Fetcher<'a, T: Transport> {
    transport: &'a T,
    switches: FeedSwitches,
    user_agent: String,
    wis2: Wis2Query,
}

impl<'a, T: Transport> Fetcher<'a, T> {
    /// A fetcher with every feed switched off; turn feeds on with
    /// [`Fetcher::with_switches`].
    pub fn new(transport: &'a T, version: &str) -> Self {
        Fetcher {
            transport,
            switches: FeedSwitches::default(),
            user_agent: user_agent(version),
            wis2: DEFAULT_WIS2_QUERY,
        }
    }

    pub fn with_switches(mut self, switches: FeedSwitches) -> Self {
        self.switches = switches;
        self
    }

    /// Override the WIS2 paging; values are clamped to sane bounds.
    pub fn with_wis2_query(mut self, q: Wis2Query) -> Self {
        self.wis2 = Wis2Query {
            page_size: q.page_size.clamp(1, 10_000),
            max_pages: q.max_pages.clamp(1, 20),
            window_minutes: q.window_minutes.clamp(10, 24 * 60),
        };
        self
    }

    fn gate(&self, feed: Feed) -> Result<(), FetchError> {
        if self.switches.allows(feed) {
            Ok(())
        } else {
            Err(FetchError::Disabled(feed))
        }
    }

    /// One GET, classified, with the breaker told exactly once what happened.
    async fn get_json(
        &self,
        breaker: &mut Breaker,
        now_ms: u64,
        feed: Feed,
        url: String,
        accept: &'static str,
        shape: fn(&Value) -> bool,
    ) -> Result<Value, FetchError> {
        let req = HttpRequest {
            url,
            headers: vec![
                ("User-Agent", self.user_agent.clone()),
                ("Accept", accept.to_string()),
            ],
            timeout_ms: feed.policy().timeout_ms,
        };
        let outcome = match self.transport.get(&req).await {
            Err(TransportError::Timeout) => Err(FetchError::Timeout),
            Err(TransportError::Network) => Err(FetchError::Transport),
            Ok(r) if !(200..300).contains(&r.status) => Err(FetchError::Status(r.status)),
            Ok(r) if r.body.len() > MAX_BODY_BYTES => Err(FetchError::BadBody("too_large")),
            Ok(r) => match serde_json::from_str::<Value>(&r.body) {
                Ok(v) if shape(&v) => Ok(v),
                Ok(_) => Err(FetchError::BadBody("unexpected_shape")),
                Err(_) => Err(FetchError::BadBody("not_json")),
            },
        };
        match &outcome {
            Ok(_) => breaker.record_success(),
            Err(e) if e.counts_against_breaker() => breaker.record_failure(now_ms),
            Err(_) => {}
        }
        outcome
    }

    /// Recent WIS2 observations for the Zimbabwe MSD node.
    ///
    /// Reads pages of one window (`now - window` to `now`) until a short page,
    /// an empty page or `max_pages`; groups all of it as one collection; drops
    /// reports outside the window or stamped in the future. A failure on the
    /// first page is an error; a failure on a later page returns what was
    /// read with `complete: false`.
    pub async fn wis2(
        &self,
        breaker: &mut Breaker,
        now: DateTime<Utc>,
    ) -> Result<Fetched<FeedObservation>, FetchError> {
        let feed = Feed::Wis2ZwMsd;
        self.gate(feed)?;
        let now_ms = millis(now);
        if !breaker.allow(now_ms) {
            return Err(FetchError::CircuitOpen);
        }
        let q = self.wis2;
        let from = now - Duration::minutes(i64::from(q.window_minutes));
        let mut features: Vec<Value> = Vec::new();
        let mut requests = 0u32;
        let mut complete = false;
        for page in 0..q.max_pages {
            let url = wis2_url(from, now, q.page_size, page.saturating_mul(q.page_size));
            requests += 1;
            let mut body = match self
                .get_json(
                    breaker,
                    now_ms,
                    feed,
                    url,
                    ACCEPT_GEOJSON,
                    is_feature_collection,
                )
                .await
            {
                Ok(b) => b,
                Err(e) if page == 0 => return Err(e),
                Err(_) => break,
            };
            let Some(Value::Array(rows)) = body.get_mut("features").map(Value::take) else {
                break;
            };
            let n = rows.len();
            features.extend(rows);
            if n < q.page_size as usize {
                complete = true;
                break;
            }
        }
        let collection = json!({ "type": "FeatureCollection", "features": features });
        let (lo, hi) = (
            rfc3339(from),
            rfc3339(now + Duration::minutes(MAX_FUTURE_SKEW_MINUTES)),
        );
        // RFC 3339 UTC at second precision sorts as text, so these compare
        // the instants.
        let items = wis2_observations(&collection)
            .into_iter()
            .filter(|o| o.observed_at >= lo && o.observed_at <= hi)
            .collect();
        Ok(Fetched {
            items,
            requests,
            complete,
        })
    }

    /// Current SAAOPA readings for the stations in `registered` (the active
    /// automatic stations, from the registry import). With nothing registered
    /// there is nothing to match, so no request is made.
    pub async fn saaopa_status(
        &self,
        breaker: &mut Breaker,
        now: DateTime<Utc>,
        registered: &BTreeSet<String>,
    ) -> Result<Fetched<FeedObservation>, FetchError> {
        let feed = Feed::SaaopaStatus;
        self.gate(feed)?;
        if registered.is_empty() {
            return Ok(Fetched {
                items: Vec::new(),
                requests: 0,
                complete: true,
            });
        }
        let now_ms = millis(now);
        if !breaker.allow(now_ms) {
            return Err(FetchError::CircuitOpen);
        }
        let body = self
            .get_json(
                breaker,
                now_ms,
                feed,
                SAAOPA_STATUS_URL.to_string(),
                ACCEPT_JSON,
                is_array,
            )
            .await?;
        Ok(Fetched {
            items: saaopa_status_observations(&body, now, SAAOPA_MAX_AGE_MINUTES, Some(registered)),
            requests: 1,
            complete: true,
        })
    }

    /// The active automatic SAAOPA stations, for a reviewed registry import.
    pub async fn saaopa_registry(
        &self,
        breaker: &mut Breaker,
        now: DateTime<Utc>,
    ) -> Result<Fetched<SaaopaStation>, FetchError> {
        let feed = Feed::SaaopaRegistry;
        self.gate(feed)?;
        let now_ms = millis(now);
        if !breaker.allow(now_ms) {
            return Err(FetchError::CircuitOpen);
        }
        let body = self
            .get_json(
                breaker,
                now_ms,
                feed,
                SAAOPA_STATIONS_URL.to_string(),
                ACCEPT_JSON,
                is_array,
            )
            .await?;
        Ok(Fetched {
            items: saaopa_aws_registry(&body),
            requests: 1,
            complete: true,
        })
    }
}

/// The codes of a registry, as the set `saaopa_status` matches against.
pub fn registry_codes(stations: &[SaaopaStation]) -> BTreeSet<String> {
    stations.iter().map(|s| s.code.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::breaker::{self, State};
    use crate::external_feeds::Quantity;
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::future::Future;
    use std::task::{Context, Poll, Waker};

    const WIS2: &str = include_str!("../tests/fixtures/wis2_zw_msd_items.json");
    const SAAOPA_STATUS: &str = include_str!("../tests/fixtures/saaopa_stations_status.json");
    const SAAOPA_STATIONS: &str = include_str!("../tests/fixtures/saaopa_stations.json");

    /// The futures here complete at once (the fake never waits), so polling in
    /// a loop is enough and no runtime is needed.
    fn block_on<F: Future>(f: F) -> F::Output {
        let mut f = std::pin::pin!(f);
        let mut cx = Context::from_waker(Waker::noop());
        loop {
            if let Poll::Ready(v) = f.as_mut().poll(&mut cx) {
                return v;
            }
        }
    }

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    /// A transport that plays back a script and records what it was asked.
    struct Fake {
        script: RefCell<VecDeque<Result<HttpResponse, TransportError>>>,
        seen: RefCell<Vec<HttpRequest>>,
    }

    impl Fake {
        fn new(script: Vec<Result<HttpResponse, TransportError>>) -> Self {
            Fake {
                script: RefCell::new(script.into()),
                seen: RefCell::new(Vec::new()),
            }
        }
        fn requests(&self) -> Vec<HttpRequest> {
            self.seen.borrow().clone()
        }
    }

    impl Transport for Fake {
        async fn get(&self, req: &HttpRequest) -> Result<HttpResponse, TransportError> {
            self.seen.borrow_mut().push(req.clone());
            self.script
                .borrow_mut()
                .pop_front()
                .unwrap_or(Err(TransportError::Network))
        }
    }

    fn ok(body: &str) -> Result<HttpResponse, TransportError> {
        Ok(HttpResponse {
            status: 200,
            body: body.to_string(),
        })
    }

    fn status(code: u16) -> Result<HttpResponse, TransportError> {
        Ok(HttpResponse {
            status: code,
            body: "<html>nope</html>".to_string(),
        })
    }

    fn on() -> FeedSwitches {
        FeedSwitches {
            wis2: true,
            saaopa: true,
        }
    }

    fn breaker() -> Breaker {
        Breaker::new(breaker::EXTERNAL_FEED)
    }

    fn fixture_features() -> Vec<Value> {
        let v: Value = serde_json::from_str(WIS2).unwrap();
        v["features"].as_array().unwrap().clone()
    }

    fn page(rows: &[Value]) -> Result<HttpResponse, TransportError> {
        ok(
            &json!({"type": "FeatureCollection", "features": rows, "numberReturned": rows.len()})
                .to_string(),
        )
    }

    /// The fixture rows are stamped 2026-10-29 around 11:00 to 12:00 UTC.
    const NOW: &str = "2026-10-29T12:50:00Z";

    #[test]
    fn every_feed_is_off_until_switched_on_and_a_disabled_feed_makes_no_request() {
        let fake = Fake::new(vec![ok(WIS2), ok(SAAOPA_STATUS), ok(SAAOPA_STATIONS)]);
        let f = Fetcher::new(&fake, "0.13.0");
        assert_eq!(
            FeedSwitches::default(),
            FeedSwitches {
                wis2: false,
                saaopa: false
            }
        );
        let mut b = breaker();
        let now = at(NOW);
        let codes: BTreeSet<String> = ["FVHP".to_string()].into();
        assert_eq!(
            block_on(f.wis2(&mut b, now)).unwrap_err(),
            FetchError::Disabled(Feed::Wis2ZwMsd)
        );
        assert_eq!(
            block_on(f.saaopa_status(&mut b, now, &codes)).unwrap_err(),
            FetchError::Disabled(Feed::SaaopaStatus)
        );
        assert_eq!(
            block_on(f.saaopa_registry(&mut b, now)).unwrap_err(),
            FetchError::Disabled(Feed::SaaopaRegistry)
        );
        assert!(
            fake.requests().is_empty(),
            "a disabled feed is never called"
        );
        // Switching one on does not switch the other on.
        let f = Fetcher::new(&fake, "0.13.0").with_switches(FeedSwitches {
            wis2: true,
            saaopa: false,
        });
        assert!(block_on(f.saaopa_registry(&mut b, now)).is_err());
        assert!(fake.requests().is_empty());
        assert_eq!(
            b.state(0),
            State::Closed,
            "a disabled feed never touches the breaker"
        );
    }

    #[test]
    fn wis2_reads_one_short_page_and_matches_the_parser_over_the_same_rows() {
        let fake = Fake::new(vec![ok(WIS2)]);
        let f = Fetcher::new(&fake, "0.13.0").with_switches(on());
        let mut b = breaker();
        let got = block_on(f.wis2(&mut b, at(NOW))).unwrap();
        assert_eq!(got.requests, 1);
        assert!(got.complete, "12 rows is a short page of 500");
        let direct = wis2_observations(&serde_json::from_str(WIS2).unwrap());
        assert_eq!(got.items, direct);
        assert_eq!(got.items.len(), 3);

        let req = &fake.requests()[0];
        assert!(req.url.starts_with(WIS2_ITEMS_URL), "{}", req.url);
        assert!(req.url.contains("f=json"));
        assert!(
            req.url
                .contains("datetime=2026-10-29T05:50:00Z/2026-10-29T12:50:00Z"),
            "a 7-hour window ending now: {}",
            req.url
        );
        assert!(req.url.contains("limit=500&offset=0"));
        assert_eq!(req.timeout_ms, WIS2_POLICY.timeout_ms);
    }

    #[test]
    fn requests_are_polite_and_carry_no_credentials() {
        let fake = Fake::new(vec![ok(WIS2), ok(SAAOPA_STATUS), ok(SAAOPA_STATIONS)]);
        let f = Fetcher::new(&fake, "0.13.0").with_switches(on());
        let now = at(NOW);
        let codes: BTreeSet<String> = ["FVHP".to_string()].into();
        block_on(f.wis2(&mut breaker(), now)).unwrap();
        block_on(f.saaopa_status(&mut breaker(), now, &codes)).unwrap();
        block_on(f.saaopa_registry(&mut breaker(), now)).unwrap();
        let seen = fake.requests();
        assert_eq!(seen.len(), 3);
        assert_eq!(seen[1].url, SAAOPA_STATUS_URL);
        assert_eq!(seen[2].url, SAAOPA_STATIONS_URL);
        for r in &seen {
            let names: Vec<_> = r.headers.iter().map(|(k, _)| *k).collect();
            assert_eq!(
                names,
                ["User-Agent", "Accept"],
                "no Authorization, no cookie"
            );
            let ua = &r.headers[0].1;
            assert_eq!(
                ua,
                "mukoko-weather-jobs/0.13.0 (+https://weather.mukoko.com; hi@mukoko.com)"
            );
            assert!(!r.url.contains("key") && !r.url.contains("token"));
        }
    }

    #[test]
    fn the_user_agent_cannot_carry_a_header_break() {
        let ua = user_agent("1.0\r\nX-Evil: 1");
        assert!(!ua.contains('\r') && !ua.contains('\n'));
        assert!(ua.starts_with("mukoko-weather-jobs/1.0X-Evil1 ("), "{ua}");
    }

    #[test]
    fn wis2_pages_until_a_short_page_and_a_report_cut_by_a_page_boundary_is_repaired() {
        let rows = fixture_features();
        assert_eq!(rows.len(), 12);
        // Pages of 5: 5 + 5 + 2. The boundaries fall inside station-hours.
        let fake = Fake::new(vec![
            page(&rows[0..5]),
            page(&rows[5..10]),
            page(&rows[10..12]),
        ]);
        let q = Wis2Query {
            page_size: 5,
            ..DEFAULT_WIS2_QUERY
        };
        let f = Fetcher::new(&fake, "0.13.0")
            .with_switches(on())
            .with_wis2_query(q);
        let got = block_on(f.wis2(&mut breaker(), at(NOW))).unwrap();
        assert_eq!(got.requests, 3);
        assert!(got.complete);
        let whole = wis2_observations(&serde_json::from_str(WIS2).unwrap());
        assert_eq!(
            got.items, whole,
            "grouping the pages as one collection equals grouping the whole answer"
        );
        let offsets: Vec<_> = fake
            .requests()
            .iter()
            .map(|r| r.url.rsplit("offset=").next().unwrap().to_string())
            .collect();
        assert_eq!(offsets, ["0", "5", "10"]);
    }

    #[test]
    fn wis2_stops_at_max_pages_and_says_the_window_may_hold_more() {
        let rows = fixture_features();
        let fake = Fake::new(vec![
            page(&rows[0..4]),
            page(&rows[4..8]),
            page(&rows[8..12]),
        ]);
        let q = Wis2Query {
            page_size: 4,
            max_pages: 2,
            ..DEFAULT_WIS2_QUERY
        };
        let f = Fetcher::new(&fake, "0.13.0")
            .with_switches(on())
            .with_wis2_query(q);
        let got = block_on(f.wis2(&mut breaker(), at(NOW))).unwrap();
        assert_eq!(got.requests, 2);
        assert!(!got.complete);
        assert_eq!(fake.requests().len(), 2, "never a third request");
    }

    #[test]
    fn a_later_page_that_fails_returns_what_was_read_and_counts_against_the_breaker() {
        let rows = fixture_features();
        let fake = Fake::new(vec![page(&rows[0..6]), status(503)]);
        let q = Wis2Query {
            page_size: 6,
            ..DEFAULT_WIS2_QUERY
        };
        let f = Fetcher::new(&fake, "0.13.0")
            .with_switches(on())
            .with_wis2_query(q);
        let mut b = breaker();
        let got = block_on(f.wis2(&mut b, at(NOW))).unwrap();
        assert!(!got.complete);
        assert!(!got.items.is_empty());
        // That page-2 failure was recorded: one more makes two, still short of
        // the threshold of three, and a third opens the breaker.
        let fake = Fake::new(vec![status(503)]);
        let f = Fetcher::new(&fake, "0.13.0").with_switches(on());
        assert_eq!(
            block_on(f.wis2(&mut b, at(NOW))).unwrap_err(),
            FetchError::Status(503)
        );
        assert_eq!(b.state(millis(at(NOW))), State::Closed);
        let fake = Fake::new(vec![status(503)]);
        let f = Fetcher::new(&fake, "0.13.0").with_switches(on());
        assert!(block_on(f.wis2(&mut b, at(NOW))).is_err());
        assert_eq!(b.state(millis(at(NOW))), State::Open);
    }

    #[test]
    fn three_unwell_answers_open_the_breaker_and_an_open_breaker_makes_no_request() {
        let mut b = breaker();
        let t0 = at(NOW);
        let bad: Vec<Result<HttpResponse, TransportError>> = vec![
            status(500),
            Err(TransportError::Timeout),
            ok("<html>maintenance</html>"),
        ];
        for r in bad {
            let fake = Fake::new(vec![r]);
            let f = Fetcher::new(&fake, "0.13.0").with_switches(on());
            assert!(block_on(f.wis2(&mut b, t0)).is_err());
        }
        assert_eq!(b.state(millis(t0)), State::Open);
        let fake = Fake::new(vec![ok(WIS2)]);
        let f = Fetcher::new(&fake, "0.13.0").with_switches(on());
        assert_eq!(
            block_on(f.wis2(&mut b, t0)).unwrap_err(),
            FetchError::CircuitOpen
        );
        assert!(fake.requests().is_empty());
        // After the cooldown one trial goes out, and its success closes it.
        let later = t0 + Duration::minutes(31);
        let got = block_on(f.wis2(&mut b, later)).unwrap();
        assert_eq!(fake.requests().len(), 1);
        // 13:21 minus the 7-hour window still covers the fixture's 11:00 to 12:00.
        assert_eq!(got.items.len(), 3, "the trial fetch reads normally");
        assert_eq!(b.state(millis(later)), State::Closed);
    }

    #[test]
    fn a_4xx_is_our_request_and_never_opens_the_breaker_but_429_does_count() {
        assert!(!FetchError::Status(404).counts_against_breaker());
        assert!(!FetchError::Status(400).counts_against_breaker());
        assert!(!FetchError::Status(301).counts_against_breaker());
        assert!(FetchError::Status(429).counts_against_breaker());
        assert!(FetchError::Status(502).counts_against_breaker());
        assert!(FetchError::Timeout.counts_against_breaker());
        assert!(FetchError::Transport.counts_against_breaker());
        assert!(FetchError::BadBody("not_json").counts_against_breaker());
        assert!(!FetchError::CircuitOpen.counts_against_breaker());
        assert!(!FetchError::Disabled(Feed::Wis2ZwMsd).counts_against_breaker());

        let mut b = breaker();
        for _ in 0..5 {
            let fake = Fake::new(vec![status(404)]);
            let f = Fetcher::new(&fake, "0.13.0").with_switches(on());
            assert_eq!(
                block_on(f.wis2(&mut b, at(NOW))).unwrap_err(),
                FetchError::Status(404)
            );
        }
        assert_eq!(b.state(millis(at(NOW))), State::Closed);
        let mut b = breaker();
        for _ in 0..3 {
            let fake = Fake::new(vec![status(429)]);
            let f = Fetcher::new(&fake, "0.13.0").with_switches(on());
            assert_eq!(
                block_on(f.wis2(&mut b, at(NOW))).unwrap_err(),
                FetchError::Status(429)
            );
        }
        assert_eq!(b.state(millis(at(NOW))), State::Open);
    }

    #[test]
    fn a_body_that_is_not_the_documented_shape_is_a_failure_not_an_empty_success() {
        for (body, why) in [
            ("<html>login</html>", "not_json"),
            (r#"{"features": "no"}"#, "unexpected_shape"),
            (r#"{"type": "Exception"}"#, "unexpected_shape"),
        ] {
            let fake = Fake::new(vec![ok(body)]);
            let f = Fetcher::new(&fake, "0.13.0").with_switches(on());
            assert_eq!(
                block_on(f.wis2(&mut breaker(), at(NOW))).unwrap_err(),
                FetchError::BadBody(why),
                "{body}"
            );
        }
        let fake = Fake::new(vec![ok(r#"{"stations": []}"#)]);
        let f = Fetcher::new(&fake, "0.13.0").with_switches(on());
        let codes: BTreeSet<String> = ["FVHP".to_string()].into();
        assert_eq!(
            block_on(f.saaopa_status(&mut breaker(), at(NOW), &codes)).unwrap_err(),
            FetchError::BadBody("unexpected_shape")
        );
        let big = format!("[\"{}\"]", "x".repeat(MAX_BODY_BYTES));
        let fake = Fake::new(vec![ok(&big)]);
        let f = Fetcher::new(&fake, "0.13.0").with_switches(on());
        assert_eq!(
            block_on(f.saaopa_registry(&mut breaker(), at(NOW))).unwrap_err(),
            FetchError::BadBody("too_large")
        );
    }

    #[test]
    fn wis2_drops_rows_outside_the_window_and_rows_from_the_future() {
        // The fixture is 11:00-12:00 UTC. Seven hours before 20:00 is 13:00:
        // every row is older than the window.
        let fake = Fake::new(vec![ok(WIS2)]);
        let f = Fetcher::new(&fake, "0.13.0").with_switches(on());
        let got = block_on(f.wis2(&mut breaker(), at("2026-10-29T20:00:00Z"))).unwrap();
        assert!(got.items.is_empty());
        assert!(got.complete);
        // At 10:00 every row is stamped more than ten minutes ahead.
        let fake = Fake::new(vec![ok(WIS2)]);
        let f = Fetcher::new(&fake, "0.13.0").with_switches(on());
        let got = block_on(f.wis2(&mut breaker(), at("2026-10-29T10:00:00Z"))).unwrap();
        assert!(got.items.is_empty());
    }

    #[test]
    fn saaopa_status_reads_only_registered_stations_with_time_from_age() {
        let fake = Fake::new(vec![ok(SAAOPA_STATUS)]);
        let f = Fetcher::new(&fake, "0.13.0").with_switches(on());
        let registered: BTreeSet<String> = ["FVHP".to_string(), "FVCD".to_string()].into();
        let got =
            block_on(f.saaopa_status(&mut breaker(), at("2026-10-29T12:38:00Z"), &registered))
                .unwrap();
        assert_eq!(got.requests, 1);
        let refs: Vec<_> = got.items.iter().map(|o| o.station_ref.as_str()).collect();
        assert_eq!(refs, ["FVHP", "FVCD"], "INYANGA is live but not registered");
        assert_eq!(got.items[0].observed_at, "2026-10-29T12:30:00Z");
        assert!(got.items[0]
            .measures
            .contains_key(&Quantity::AirPressureAtMeanSeaLevel));
        assert!(!got.items[0]
            .measures
            .contains_key(&Quantity::SurfaceAirPressure));
    }

    #[test]
    fn saaopa_status_skips_readings_older_than_three_missed_reports() {
        // Ages are relative to the fetch, so only the age decides: 29 minutes
        // is kept, 31 is not, and an offline station (no age) never is.
        let body = json!([
            {"code": "A", "obsAgeMinutes": 8, "temperatureC": 20.0},
            {"code": "B", "obsAgeMinutes": 29, "temperatureC": 20.0},
            {"code": "C", "obsAgeMinutes": 31, "temperatureC": 20.0},
            {"code": "D", "obsAgeMinutes": null, "temperatureC": 20.0},
        ])
        .to_string();
        let fake = Fake::new(vec![ok(&body)]);
        let f = Fetcher::new(&fake, "0.13.0").with_switches(on());
        let registered: BTreeSet<String> = ["A", "B", "C", "D"].map(String::from).into();
        let got =
            block_on(f.saaopa_status(&mut breaker(), at("2026-10-31T00:00:00Z"), &registered))
                .unwrap();
        let refs: Vec<_> = got.items.iter().map(|o| o.station_ref.as_str()).collect();
        assert_eq!(refs, ["A", "B"]);
        assert_eq!(got.items[0].observed_at, "2026-10-30T23:52:00Z");
        assert_eq!(got.items[1].observed_at, "2026-10-30T23:31:00Z");
    }

    #[test]
    fn saaopa_status_with_nothing_registered_makes_no_request() {
        let fake = Fake::new(vec![ok(SAAOPA_STATUS)]);
        let f = Fetcher::new(&fake, "0.13.0").with_switches(on());
        let got = block_on(f.saaopa_status(&mut breaker(), at(NOW), &BTreeSet::new())).unwrap();
        assert!(got.items.is_empty());
        assert_eq!(got.requests, 0);
        assert!(fake.requests().is_empty());
    }

    #[test]
    fn saaopa_registry_returns_the_automatic_stations_and_their_codes() {
        let fake = Fake::new(vec![ok(SAAOPA_STATIONS)]);
        let f = Fetcher::new(&fake, "0.13.0").with_switches(on());
        let got = block_on(f.saaopa_registry(&mut breaker(), at(NOW))).unwrap();
        assert_eq!(got.items.len(), 1);
        assert_eq!(got.items[0].code, "CHIPINDA");
        let codes = registry_codes(&got.items);
        assert_eq!(codes.len(), 1);
        assert!(codes.contains("CHIPINDA"));
    }

    #[test]
    fn schedule_never_runs_faster_than_the_feed_and_backs_off_after_failures() {
        let p = SAAOPA_STATUS_POLICY;
        let t = 1_000_000_000u64;
        assert!(due(&p, None, 0, t), "never attempted is due");
        assert!(!due(&p, Some(t), 0, t + 5 * MINUTE));
        assert!(due(&p, Some(t), 0, t + 9 * MINUTE));
        // Each failure doubles the wait, up to the ceiling.
        assert_eq!(backoff_ms(&p, 0), 9 * MINUTE);
        assert_eq!(backoff_ms(&p, 1), 18 * MINUTE);
        assert_eq!(backoff_ms(&p, 2), 36 * MINUTE);
        assert_eq!(backoff_ms(&p, 30), p.max_backoff_ms);
        assert!(!due(&p, Some(t), 2, t + 30 * MINUTE));
        assert!(due(&p, Some(t), 2, t + 36 * MINUTE));
        // A clock that went backwards is not due, and does not underflow.
        assert!(!due(&p, Some(t), 0, t - 1));
        // WIS2 is hourly: not due 30 minutes after the last attempt.
        assert!(!due(&WIS2_POLICY, Some(t), 0, t + 30 * MINUTE));
        assert!(due(&WIS2_POLICY, Some(t), 0, t + 55 * MINUTE));
    }

    #[test]
    fn every_policy_is_sane() {
        for feed in [Feed::Wis2ZwMsd, Feed::SaaopaStatus, Feed::SaaopaRegistry] {
            let p = feed.policy();
            assert!(p.min_interval_ms >= 5 * MINUTE, "{}", feed.name());
            assert!(p.max_backoff_ms >= p.min_interval_ms, "{}", feed.name());
            assert!(
                p.timeout_ms >= 1_000 && p.timeout_ms <= 30_000,
                "{}",
                feed.name()
            );
        }
        let names: BTreeSet<_> = [Feed::Wis2ZwMsd, Feed::SaaopaStatus, Feed::SaaopaRegistry]
            .iter()
            .map(|f| f.name())
            .collect();
        assert_eq!(names.len(), 3);
    }

    #[test]
    fn error_codes_are_stable_and_carry_no_upstream_text() {
        assert_eq!(FetchError::Status(503).code(), "upstream_5xx");
        assert_eq!(FetchError::Status(429).code(), "rate_limited");
        assert_eq!(FetchError::Status(404).code(), "upstream_4xx");
        assert_eq!(FetchError::Timeout.code(), "timeout");
        assert_eq!(FetchError::Transport.code(), "transport");
        assert_eq!(FetchError::CircuitOpen.code(), "circuit_open");
        assert_eq!(FetchError::BadBody("not_json").code(), "not_json");
        assert_eq!(FetchError::Disabled(Feed::SaaopaStatus).code(), "disabled");
    }
}
