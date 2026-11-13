//! The stations Worker's use of the Nyuchi API (mukoko-dev/mukoko-weather#556,
//! B2 of the station-console plan, #293 Part 5.4): the decisions, with no I/O
//! and no clock, so they are tested natively. `workers/stations` does the
//! fetches and passes in what it read and the time.
//!
//! The contract is the Nyuchi API's `POST /v1/stations/service/verify` and
//! `POST /v1/stations/service/observations` (nyuchi/nyuchi-api#542,
//! `docs/architecture/stations.md` there), plus `GET /v1/stations/{id}` and
//! `POST /v1/stations/{id}/readings` for the legacy `status` and `manual`
//! proxies, which carry the station's own key as the bearer.
//!
//! The rules this module holds:
//!
//! - **Which backend** (`STATIONS_BACKEND`): `d1` (the default, and exactly the
//!   behaviour before B2) or `nyuchi`. An unknown value is an error, never a
//!   silent default, so a typo cannot flip or un-flip the Worker unseen.
//! - **Verifying a key** is cached in the isolate: a positive answer for ten
//!   minutes, a negative one for sixty seconds, both keyed on a SHA-256 of the
//!   station id and the key (the key itself is never stored).
//! - **What an API failure means to a station**: always `503`, never `401`. A
//!   station is told its key is wrong only when the API said `valid: false`.
//!   A `401` or `403` from a service route means the Worker's own credential
//!   failed, which is the owner's alarm, not the station's fault.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::crypto::sha256_hex;
use crate::station::{valid_station_id, IngestMessage, Metrics};

// ---------------------------------------------------------------------------
// Names (the code asks for these; the Worker configs and the README list them)
// ---------------------------------------------------------------------------

/// The var that picks the backend.
pub const BACKEND_VAR: &str = "STATIONS_BACKEND";
/// The var holding the Nyuchi API's base URL.
pub const API_URL_VAR: &str = "NYUCHI_API_URL";
/// The longest key the Worker will send anywhere (the API's own bound is
/// longer; every key issued so far is 32 characters).
pub const MAX_KEY_LEN: usize = 128;
/// The ISO 3166-1 alpha-2 code a station is filed under when the API gives none
/// (what the Worker has always assumed).
pub const DEFAULT_COUNTRY: &str = "ZW";

// ---------------------------------------------------------------------------
// Which backend
// ---------------------------------------------------------------------------

/// Where a station's identity and its readings live.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    /// The Worker's own D1 registry and tables: the behaviour before B2.
    D1,
    /// The Nyuchi API: `verify` for keys, `observations` for readings.
    Nyuchi,
}

/// A `STATIONS_BACKEND` value that is neither `d1` nor `nyuchi`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownBackend(pub String);

impl Backend {
    /// The backend for the var's value. Unset or blank is `d1`, so deploying
    /// this code changes nothing until the owner sets `nyuchi`. Case and
    /// surrounding spaces do not matter; anything else is an error (the
    /// Workers then fail closed and say so, rather than guess).
    pub fn parse(value: Option<&str>) -> Result<Backend, UnknownBackend> {
        let v = value.map(str::trim).unwrap_or_default();
        if v.is_empty() || v.eq_ignore_ascii_case("d1") {
            Ok(Backend::D1)
        } else if v.eq_ignore_ascii_case("nyuchi") {
            Ok(Backend::Nyuchi)
        } else {
            // The value is configuration, not a secret, but a log line is not
            // the place for an arbitrary length of it.
            Err(UnknownBackend(v.chars().take(32).collect()))
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Backend::D1 => "d1",
            Backend::Nyuchi => "nyuchi",
        }
    }
}

impl UnknownBackend {
    /// The loud log line for an unknown value.
    pub fn log_line(&self) -> String {
        format!(
            "ALERT stations_backend_unknown: {BACKEND_VAR} is {:?}, which is neither \"d1\" nor \"nyuchi\". \
             Failing closed until it is fixed.",
            self.0
        )
    }
}

/// The API base URL from the var: `https://` (or `http://` to `localhost` or
/// `127.0.0.1`, for `wrangler dev`), no query, no fragment, no trailing slash.
/// `None` when it is unset or unusable, which the Worker reports as missing
/// configuration: the internal key is never sent over plain HTTP to a remote
/// host.
pub fn api_base(raw: Option<&str>) -> Option<String> {
    let v = raw?.trim().trim_end_matches('/');
    if v.is_empty() || v.contains(char::is_whitespace) || v.contains(['?', '#']) {
        return None;
    }
    let rest = if let Some(rest) = v.strip_prefix("https://") {
        rest
    } else {
        let rest = v.strip_prefix("http://")?;
        let host = rest.split(['/', ':']).next().unwrap_or_default();
        if !matches!(host, "localhost" | "127.0.0.1") {
            return None;
        }
        rest
    };
    (!rest.is_empty() && !rest.starts_with('/')).then(|| v.to_owned())
}

// ---------------------------------------------------------------------------
// What a station is, as the Worker needs it
// ---------------------------------------------------------------------------

/// A station as the hot path uses it, whichever backend named it.
#[derive(Debug, Clone, PartialEq)]
pub struct StationIdentity {
    pub station_id: String,
    pub lat: f64,
    pub lon: f64,
    pub country_code: String,
}

/// `station` of a `verify` answer: what the Worker needs and no more. The API
/// leaves out the owner's id and every digest on purpose.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedStation {
    pub station_id: String,
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub station_type: String,
    pub lat: f64,
    pub lon: f64,
    #[serde(default)]
    pub country_code: Option<String>,
    #[serde(default)]
    pub elevation_metres: Option<f64>,
    /// `person`, or `community` for a station nobody has claimed yet.
    #[serde(default)]
    pub owner_type: Option<String>,
}

impl VerifiedStation {
    pub fn identity(&self) -> StationIdentity {
        StationIdentity {
            station_id: self.station_id.clone(),
            lat: self.lat,
            lon: self.lon,
            country_code: self
                .country_code
                .as_deref()
                .map(str::trim)
                .filter(|c| c.len() == 2)
                .map_or_else(|| DEFAULT_COUNTRY.to_owned(), str::to_ascii_uppercase),
        }
    }
}

// ---------------------------------------------------------------------------
// Failures: what an API problem means
// ---------------------------------------------------------------------------

/// Why the Nyuchi API could not settle a request. Every one of these is a
/// `503` to the station, never a `401`: the station's key was not judged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    /// `STATIONS_BACKEND=nyuchi` without what it needs (the API URL, the
    /// internal key, the KV binding). Names only.
    NotConfigured { missing: Vec<&'static str> },
    /// The API is down, slow, rate limiting or erroring, or did not answer.
    /// The station (or the queue) tries again.
    Unavailable {
        what: &'static str,
        status: Option<u16>,
    },
    /// A `401` or `403` on a service route: the API refused the Worker's own
    /// credential (a wrong, revoked or under-scoped internal key).
    CredentialRejected {
        what: &'static str,
        status: u16,
        code: Option<String>,
    },
    /// An answer this code does not understand: a route that is not deployed
    /// (`404`), a `4xx` about our own request, or a body that does not parse.
    Contract {
        what: &'static str,
        status: u16,
        code: Option<String>,
    },
}

impl Failure {
    /// The status a station (or a legacy client) is answered with.
    pub const STATION_STATUS: u16 = 503;
    /// How long a station is told to wait (`Retry-After`, seconds).
    pub const RETRY_AFTER_SECONDS: u32 = 30;

    /// A stable word for a log filter and an alert rule.
    pub fn tag(&self) -> &'static str {
        match self {
            Failure::NotConfigured { .. } => "stations_backend_misconfigured",
            Failure::Unavailable { .. } => "stations_api_unavailable",
            Failure::CredentialRejected { .. } => "stations_api_credential_rejected",
            Failure::Contract { .. } => "stations_api_contract",
        }
    }

    /// Whether this is something the owner must look at (an `ALERT` line) and
    /// not a passing outage (a warning).
    pub fn is_alert(&self) -> bool {
        !matches!(self, Failure::Unavailable { .. })
    }

    /// The log line. It names the problem and the status; it carries no key,
    /// no header and no body.
    pub fn log_line(&self) -> String {
        let code = |c: &Option<String>| c.as_deref().unwrap_or("none").to_owned();
        match self {
            Failure::NotConfigured { missing } => format!(
                "ALERT {}: {BACKEND_VAR}=nyuchi but not configured: {}. Every station is answered 503 until it is.",
                self.tag(),
                missing.join(", ")
            ),
            Failure::CredentialRejected { what, status, code: c } => format!(
                "ALERT {}: the Nyuchi API refused the Worker's own credential on {what} (HTTP {status}, code {}). \
                 Stations are answered 503, not 401. Check the Worker's internal API key and its scopes (stations, stations:service).",
                self.tag(),
                code(c)
            ),
            Failure::Contract { what, status, code: c } => format!(
                "ALERT {}: unexpected answer from the Nyuchi API on {what} (HTTP {status}, code {}). \
                 Stations are answered 503. Is the API deployed with the station routes?",
                self.tag(),
                code(c)
            ),
            Failure::Unavailable { what, status } => match status {
                Some(s) => format!("{}: the Nyuchi API answered {what} with HTTP {s}", self.tag()),
                None => format!("{}: the Nyuchi API did not answer {what}", self.tag()),
            },
        }
    }
}

/// The RFC 9457 problem `code` of an error body, if it is a plain
/// identifier. Only this one field of a body is ever read, and a value that is
/// not a short identifier is dropped, so a hostile or odd body cannot put text
/// in a log.
pub fn problem_code(body: &str) -> Option<String> {
    let code = serde_json::from_str::<Value>(body)
        .ok()?
        .get("code")?
        .as_str()?
        .to_owned();
    let ok = !code.is_empty()
        && code.len() <= 64
        && code.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-' | b'.')
        });
    ok.then_some(code)
}

/// What a status other than the expected `200` means on a **service** route
/// (the Worker's own credential is on the request).
pub fn service_failure(what: &'static str, status: u16, body: &str) -> Failure {
    match status {
        401 | 403 => Failure::CredentialRejected {
            what,
            status,
            code: problem_code(body),
        },
        // Busy, or the API or the path to it is down: the same request later.
        408 | 425 | 429 | 500..=599 => Failure::Unavailable {
            what,
            status: Some(status),
        },
        _ => Failure::Contract {
            what,
            status,
            code: problem_code(body),
        },
    }
}

/// The failure for a request that never produced an answer (a timeout, a
/// network error).
pub fn no_answer(what: &'static str) -> Failure {
    Failure::Unavailable { what, status: None }
}

fn unreadable(what: &'static str) -> Failure {
    // A 200 whose body is not the documented shape.
    Failure::Contract {
        what,
        status: 200,
        code: None,
    }
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

/// The body of `POST /v1/stations/service/verify`.
pub fn verify_body(station_id: &str, key: &str) -> Value {
    json!({"stationId": station_id, "key": key})
}

/// What the API said about a key.
#[derive(Debug, Clone, PartialEq)]
pub enum VerifyAnswer {
    /// The key opens this active station.
    Valid(VerifiedStation),
    /// The API judged the key and it does not open the station (unknown,
    /// malformed, wrong key, revoked or inactive). The only answer that
    /// becomes a `401`.
    Invalid,
}

#[derive(Deserialize)]
struct VerifyWire {
    valid: bool,
    #[serde(default)]
    station: Option<VerifiedStation>,
}

/// Read the answer to a `verify` call for `station_id`. Only `200` with
/// `valid: false` is [`VerifyAnswer::Invalid`]; every other thing that is not
/// a well-formed `valid: true` is a [`Failure`].
pub fn parse_verify(station_id: &str, status: u16, body: &str) -> Result<VerifyAnswer, Failure> {
    const WHAT: &str = "verify";
    if status != 200 {
        return Err(service_failure(WHAT, status, body));
    }
    let wire: VerifyWire = serde_json::from_str(body).map_err(|_| unreadable(WHAT))?;
    if !wire.valid {
        return Ok(VerifyAnswer::Invalid);
    }
    // A valid answer must be about the station asked for, with a place on the
    // globe: anything else is not trusted with an upload.
    match wire.station {
        Some(s) if s.station_id == station_id && crate::geo::valid_coordinates(s.lat, s.lon) => {
            Ok(VerifyAnswer::Valid(s))
        }
        _ => Err(unreadable(WHAT)),
    }
}

// ---------------------------------------------------------------------------
// The verify cache
// ---------------------------------------------------------------------------

/// A positive answer is trusted for this long (a key rotated at the API can
/// still work here for as long, as the API documents).
pub const VERIFY_POSITIVE_TTL_MS: u64 = 10 * 60_000;
/// A negative answer is remembered for this long, so a station with a wrong
/// key (or someone guessing) cannot make the Worker call the API on every
/// upload.
pub const VERIFY_NEGATIVE_TTL_MS: u64 = 60_000;
/// The bound on each map; one that is full of live entries is cleared.
pub const VERIFY_CACHE_MAX: usize = 5_000;

/// What the cache knew about a key.
#[derive(Debug, Clone, PartialEq)]
pub enum Cached {
    Valid(VerifiedStation),
    Invalid,
    Miss,
}

/// Verified keys, by a SHA-256 of the station id and the key. The raw key is
/// never stored, and the station id is part of the digest so a key valid for
/// one station can never vouch for another.
#[derive(Debug, Default)]
pub struct VerifyCache {
    valid: HashMap<String, (VerifiedStation, u64)>,
    invalid: HashMap<String, u64>,
}

impl VerifyCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// The cache key for a station id and a key.
    pub fn digest(station_id: &str, key: &str) -> String {
        sha256_hex(&format!("{station_id}:{key}"))
    }

    pub fn lookup(&self, digest: &str, now: u64) -> Cached {
        if let Some((station, until)) = self.valid.get(digest) {
            if *until > now {
                return Cached::Valid(station.clone());
            }
        }
        if self.invalid.get(digest).is_some_and(|until| *until > now) {
            return Cached::Invalid;
        }
        Cached::Miss
    }

    /// Remember what the API said. Positive and negative entries have their
    /// own maps and bounds, so a flood of wrong keys cannot push a real
    /// station out of the cache.
    pub fn remember(&mut self, digest: String, answer: &VerifyAnswer, now: u64) {
        match answer {
            VerifyAnswer::Valid(station) => {
                make_room(&mut self.valid, now, |(_, until)| *until);
                self.invalid.remove(&digest);
                self.valid.insert(
                    digest,
                    (station.clone(), now.saturating_add(VERIFY_POSITIVE_TTL_MS)),
                );
            }
            VerifyAnswer::Invalid => {
                make_room(&mut self.invalid, now, |until| *until);
                self.valid.remove(&digest);
                self.invalid
                    .insert(digest, now.saturating_add(VERIFY_NEGATIVE_TTL_MS));
            }
        }
    }

    /// Entries held (positive, negative).
    pub fn len(&self) -> (usize, usize) {
        (self.valid.len(), self.invalid.len())
    }

    pub fn is_empty(&self) -> bool {
        self.valid.is_empty() && self.invalid.is_empty()
    }
}

fn make_room<V>(map: &mut HashMap<String, V>, now: u64, until: impl Fn(&V) -> u64) {
    if map.len() < VERIFY_CACHE_MAX {
        return;
    }
    map.retain(|_, v| until(v) > now);
    if map.len() >= VERIFY_CACHE_MAX {
        map.clear();
    }
}

// ---------------------------------------------------------------------------
// observations
// ---------------------------------------------------------------------------

/// The API takes at most this many items in one call.
pub const OBSERVATIONS_MAX_PER_REQUEST: usize = 500;

/// One item of `POST /v1/stations/service/observations`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationItem {
    pub station_id: String,
    /// RFC 3339 with a zone: when the Worker received the upload.
    pub received_at: String,
    /// `wunderground`, `ecowitt` or `manual`.
    pub source: String,
    /// By stored name, in the platform's units (metric: the Worker converts
    /// the hardware protocols' imperial units before it queues the upload).
    pub metrics: BTreeMap<String, f64>,
}

/// An instant as RFC 3339 UTC with millisecond precision.
pub fn rfc3339_millis(ms: i64) -> Option<String> {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

/// The API items for a queue batch, each with the position of its message.
///
/// Every message is sent, including an upload whose metrics all failed quality
/// control (empty `metrics`): the API judges it `no_valid_metrics` and writes
/// no observation, but moves the station's `lastSeenAt`, so a console can tell
/// a silent station from a broken sensor.
pub fn observation_items(messages: &[IngestMessage]) -> Vec<(usize, ObservationItem)> {
    messages
        .iter()
        .enumerate()
        .filter_map(|(i, m)| {
            Some((
                i,
                ObservationItem {
                    station_id: m.station_id.clone(),
                    received_at: rfc3339_millis(m.received_at)?,
                    source: m.source.clone(),
                    metrics: m.validated.clone(),
                },
            ))
        })
        .collect()
}

/// Split into requests the API accepts.
pub fn request_chunks<T>(items: Vec<T>) -> Vec<Vec<T>> {
    let mut chunks = Vec::new();
    let mut it = items.into_iter().peekable();
    while it.peek().is_some() {
        chunks.push(it.by_ref().take(OBSERVATIONS_MAX_PER_REQUEST).collect());
    }
    chunks
}

/// The body of `POST /v1/stations/service/observations`.
pub fn observations_body(items: &[&ObservationItem]) -> Value {
    json!({ "observations": items })
}

/// What happened to one item.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemStatus {
    Stored,
    /// Stored before (a retry): a success.
    Duplicate,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemOutcome {
    pub status: ItemStatus,
    /// Why it was rejected: `station_not_found`, `received_at_out_of_range`,
    /// `no_valid_metrics`.
    pub code: Option<String>,
}

impl ItemOutcome {
    /// Whether the API holds this observation now.
    pub fn accepted(&self) -> bool {
        self.status != ItemStatus::Rejected
    }
}

#[derive(Deserialize)]
struct ObservationsWire {
    results: Vec<ResultWire>,
}

#[derive(Deserialize)]
struct ResultWire {
    index: usize,
    status: String,
    #[serde(default)]
    code: Option<String>,
}

/// Read the answer to a call that sent `sent` items. The outcomes come back in
/// the order of the items. An answer that does not account for every item
/// exactly once is a [`Failure`]: the batch is retried, which stores nothing
/// twice.
pub fn parse_observations(
    sent: usize,
    status: u16,
    body: &str,
) -> Result<Vec<ItemOutcome>, Failure> {
    const WHAT: &str = "observations";
    if status != 200 {
        return Err(service_failure(WHAT, status, body));
    }
    let wire: ObservationsWire = serde_json::from_str(body).map_err(|_| unreadable(WHAT))?;
    if wire.results.len() != sent {
        return Err(unreadable(WHAT));
    }
    let mut slots: Vec<Option<ItemOutcome>> = vec![None; sent];
    for r in wire.results {
        let outcome = ItemOutcome {
            status: match r.status.as_str() {
                "stored" => ItemStatus::Stored,
                "duplicate" => ItemStatus::Duplicate,
                "rejected" => ItemStatus::Rejected,
                _ => return Err(unreadable(WHAT)),
            },
            code: r.code.filter(|c| {
                c.len() <= 64 && c.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
            }),
        };
        // An index outside the batch, or one answered twice, is not an answer
        // to what was sent.
        let Some(slot) = slots.get_mut(r.index) else {
            return Err(unreadable(WHAT));
        };
        if slot.is_some() {
            return Err(unreadable(WHAT));
        }
        *slot = Some(outcome);
    }
    slots
        .into_iter()
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| unreadable(WHAT))
}

/// The counts of a batch, for one log line.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct BatchSummary {
    pub sent: usize,
    pub stored: usize,
    pub duplicates: usize,
    /// Rejected uploads that had nothing in range to begin with (expected).
    pub empty: usize,
    /// Rejected for any other reason, by code. Something to look at.
    pub rejected: BTreeMap<String, usize>,
}

impl BatchSummary {
    /// `messages` and `outcomes` are in the same order.
    pub fn of(items: &[&ObservationItem], outcomes: &[ItemOutcome]) -> Self {
        let mut s = BatchSummary {
            sent: items.len(),
            ..Self::default()
        };
        for (item, outcome) in items.iter().zip(outcomes) {
            match outcome.status {
                ItemStatus::Stored => s.stored += 1,
                ItemStatus::Duplicate => s.duplicates += 1,
                ItemStatus::Rejected if item.metrics.is_empty() => s.empty += 1,
                ItemStatus::Rejected => {
                    let code = outcome.code.clone().unwrap_or_else(|| "unknown".into());
                    *s.rejected.entry(code).or_default() += 1;
                }
            }
        }
        s
    }

    /// Whether anything unexpected happened (worth a warning).
    pub fn is_unusual(&self) -> bool {
        !self.rejected.is_empty()
    }

    pub fn log_line(&self) -> String {
        let why: Vec<String> = self
            .rejected
            .iter()
            .map(|(c, n)| format!("{c} {n}"))
            .collect();
        format!(
            "stations: batch of {}: stored {}, duplicates {}, empty {}, rejected {} ({})",
            self.sent,
            self.stored,
            self.duplicates,
            self.empty,
            self.rejected.values().sum::<usize>(),
            why.join(", ")
        )
    }
}

// ---------------------------------------------------------------------------
// The legacy proxies: `manual` and `status`, by the station's own key
// ---------------------------------------------------------------------------

/// Whether a key can be sent as a bearer: visible ASCII only, so it can never
/// break a header. A real key is URL-safe base64.
pub fn is_sendable_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= MAX_KEY_LEN && key.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

/// Whether the Worker should ask the API at all about this id and key; a
/// request that cannot be a station's is `401` without a call (as before).
pub fn plausible_credentials(station_id: &str, key: &str) -> bool {
    valid_station_id(station_id) && is_sendable_key(key)
}

/// The legacy `manual` fields, by the stored metric name each carries, and the
/// reading field the API's `POST /v1/stations/{id}/readings` calls it.
const MANUAL_FIELDS: [(&str, &str); 6] = [
    ("airTemperatureCelsius", "temperatureC"),
    ("relativeHumidityPercent", "humidityPct"),
    ("atmosphericPressureMillibar", "pressureHpa"),
    ("windSpeedKph", "windSpeedKph"),
    ("windDirectionDegrees", "windDirDeg"),
    ("precipitationMillimeters", "rainfallMm"),
];

/// The API's readings request for a manual reading that has passed the local
/// range check: one reading, dated now by the API. Wind goes as kilometres per
/// hour, which the API accepts beside metres per second, so nothing is
/// converted and back. The note is not sent (the API has no field for it).
pub fn manual_readings_body(metrics: &Metrics) -> Value {
    let mut reading = serde_json::Map::new();
    for (stored, field) in MANUAL_FIELDS {
        if let Some(Some(v)) = metrics.get(stored) {
            reading.insert(field.to_owned(), json!(v));
        }
    }
    json!({"stationType": "generic", "readings": [Value::Object(reading)]})
}

/// What a proxied call to a key-protected route came to.
#[derive(Debug, Clone, PartialEq)]
pub enum Proxied<T> {
    Done(T),
    /// The API said this id and key open nothing: `401` (as before).
    Denied,
}

/// A status on a **key-protected** route (`status`, `readings`), where the
/// station's key is the only credential sent. Only the API's own
/// `invalid_credentials` is the station's `401`; any other refusal (a gateway
/// that wants a different credential, a route that is not there) is not the
/// station's fault, so it is a [`Failure`], never "your key is wrong".
fn key_route_failure<T>(
    what: &'static str,
    status: u16,
    body: &str,
) -> Result<Proxied<T>, Failure> {
    if status == 401 && problem_code(body).as_deref() == Some("invalid_credentials") {
        return Ok(Proxied::Denied);
    }
    match status {
        408 | 425 | 429 | 500..=599 => Err(Failure::Unavailable {
            what,
            status: Some(status),
        }),
        _ => Err(Failure::Contract {
            what,
            status,
            code: problem_code(body),
        }),
    }
}

/// `GET /v1/stations/{id}` for the legacy `status` route. The body is the
/// station and its latest metrics (never a key, a digest or an owner id), and
/// a superset of what `status` has always answered; it is passed on as it is.
pub fn parse_status(station_id: &str, status: u16, body: &str) -> Result<Proxied<Value>, Failure> {
    const WHAT: &str = "status";
    if status != 200 {
        return key_route_failure(WHAT, status, body);
    }
    let v: Value = serde_json::from_str(body).map_err(|_| unreadable(WHAT))?;
    if v.get("stationId").and_then(Value::as_str) != Some(station_id) {
        return Err(unreadable(WHAT));
    }
    Ok(Proxied::Done(v))
}

/// What a manual reading came to at the API.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManualResult {
    /// Stored, or stored before (a retry).
    Accepted,
    /// The API refused the reading (a value out of range, a time outside the
    /// window); `detail` says which field and why, never the value.
    Rejected { detail: String },
}

#[derive(Deserialize)]
struct ReadingsWire {
    accepted: u64,
    #[serde(default)]
    errors: Vec<ReadingErrorWire>,
}

#[derive(Deserialize)]
struct ReadingErrorWire {
    #[serde(default)]
    field: Option<String>,
    #[serde(default)]
    detail: Option<String>,
}

/// `POST /v1/stations/{id}/readings` for the legacy `manual` route.
pub fn parse_manual(status: u16, body: &str) -> Result<Proxied<ManualResult>, Failure> {
    const WHAT: &str = "readings";
    if status != 200 {
        return key_route_failure(WHAT, status, body);
    }
    let wire: ReadingsWire = serde_json::from_str(body).map_err(|_| unreadable(WHAT))?;
    if wire.accepted > 0 {
        return Ok(Proxied::Done(ManualResult::Accepted));
    }
    let detail = wire
        .errors
        .first()
        .map(|e| match (e.field.as_deref(), e.detail.as_deref()) {
            (Some(f), Some(d)) => format!("`{f}`: {d}"),
            (None, Some(d)) => d.to_owned(),
            (Some(f), None) => format!("`{f}` was refused."),
            (None, None) => "The reading was refused.".to_owned(),
        })
        .unwrap_or_else(|| "The reading was refused.".to_owned());
    // Keep the answer short and free of anything a body could smuggle in.
    let detail: String = detail
        .chars()
        .filter(|c| !c.is_control())
        .take(200)
        .collect();
    Ok(Proxied::Done(ManualResult::Rejected { detail }))
}

// ---------------------------------------------------------------------------
// Logging without a flood
// ---------------------------------------------------------------------------

/// At most one log line per tag per interval, per isolate: an outage must be
/// loud, not a line for every upload of every station.
#[derive(Debug, Default)]
pub struct LogThrottle {
    last: HashMap<&'static str, u64>,
}

impl LogThrottle {
    /// How often a given tag may log.
    pub const INTERVAL_MS: u64 = 30_000;

    pub fn new() -> Self {
        Self::default()
    }

    /// Whether the tag may log now; records it if so.
    pub fn allow(&mut self, tag: &'static str, now: u64) -> bool {
        match self.last.get(tag) {
            Some(last) if now.saturating_sub(*last) < Self::INTERVAL_MS => false,
            _ => {
                self.last.insert(tag, now);
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The examples below are copied from the Nyuchi API's OpenAPI document
    // (nyuchi/nyuchi-api `gateway/routers/stations.py`, `json_schema_extra`),
    // so a change to the contract that breaks the Worker breaks these tests
    // when they are refreshed.

    const VERIFY_OK: &str = r#"{
        "valid": true,
        "station": {
            "stationId": "mws-0a1b2c3d",
            "deviceId": "6f1c3a0e-8d52-4f4e-9d0a-3f0b6c1e2a77",
            "name": "Chinhoyi School",
            "stationType": "digital",
            "lat": -17.36,
            "lon": 30.2,
            "countryCode": "ZW",
            "elevationMetres": 1150,
            "ownerType": "person"
        }
    }"#;

    const OBSERVATIONS_REQUEST: &str = r#"{
        "observations": [
            {
                "stationId": "mws-0a1b2c3d",
                "receivedAt": "2026-11-13T09:00:00Z",
                "source": "ecowitt",
                "metrics": {"airTemperatureCelsius": 21.46, "relativeHumidityPercent": 40, "windSpeedKph": 16.09}
            }
        ]
    }"#;

    const OBSERVATIONS_OK: &str = r#"{
        "stored": 1,
        "duplicates": 0,
        "rejected": 1,
        "results": [
            {"index": 0, "status": "stored", "qcStatus": "validated",
             "observationId": "0b6e7f4a-3c1d-5a52-8f6e-2d1c9a7b4e10", "code": null},
            {"index": 1, "status": "rejected", "qcStatus": "rejected", "observationId": null,
             "code": "no_valid_metrics"}
        ]
    }"#;

    const STATION_STATUS: &str = r#"{
        "stationId": "mws-0a1b2c3d",
        "name": "Chinhoyi School",
        "stationType": "digital",
        "status": "active",
        "hardware": "Ecowitt GW1100",
        "countryCode": "ZW",
        "location": {"type": "Point", "coordinates": [30.2, -17.36]},
        "elevationMetres": 1150,
        "registeredAt": "2026-11-13T09:00:00.000Z",
        "lastSeenAt": "2026-11-13T09:05:00.000Z",
        "lastObservationAt": "2026-11-13T09:04:30.000Z",
        "latestMetrics": {"airTemperatureCelsius": 21.46}
    }"#;

    const READINGS_OK: &str = r#"{
        "accepted": 1, "rejected": 0, "errors": [],
        "results": [{"index": 0, "status": "stored", "qcStatus": "validated",
                     "observationId": "0b6e7f4a-3c1d-5a52-8f6e-2d1c9a7b4e10",
                     "observedAt": "2026-06-29T09:55:00.000Z"}]
    }"#;

    const READINGS_REJECTED: &str = r#"{
        "accepted": 0, "rejected": 1,
        "errors": [{"index": 0, "code": "out_of_range",
                    "detail": "Must be between -50 and 60 in this unit.", "field": "temperatureC"}],
        "results": [{"index": 0, "status": "rejected", "qcStatus": "rejected",
                     "observationId": null, "observedAt": null}]
    }"#;

    const PROBLEM_INVALID_CREDENTIALS: &str = r#"{
        "type": "about:blank", "title": "Unauthorized", "status": 401,
        "detail": "Invalid credentials.", "code": "invalid_credentials"
    }"#;

    fn msg(id: &str, at: i64, source: &str, metrics: &[(&str, f64)]) -> IngestMessage {
        IngestMessage {
            station_id: id.into(),
            lat: -17.36,
            lon: 30.2,
            country_code: "ZW".into(),
            received_at: at,
            source: source.into(),
            validated: metrics.iter().map(|(k, v)| ((*k).to_owned(), *v)).collect(),
            raw: serde_json::Map::new(),
        }
    }

    // --- the backend flag -------------------------------------------------

    #[test]
    fn the_default_backend_is_d1_so_deploying_changes_nothing() {
        assert_eq!(Backend::parse(None), Ok(Backend::D1));
        assert_eq!(Backend::parse(Some("")), Ok(Backend::D1));
        assert_eq!(Backend::parse(Some("  ")), Ok(Backend::D1));
        assert_eq!(Backend::parse(Some("d1")), Ok(Backend::D1));
        assert_eq!(Backend::parse(Some("D1")), Ok(Backend::D1));
    }

    #[test]
    fn nyuchi_is_chosen_only_by_saying_so() {
        assert_eq!(Backend::parse(Some("nyuchi")), Ok(Backend::Nyuchi));
        assert_eq!(Backend::parse(Some(" Nyuchi ")), Ok(Backend::Nyuchi));
        assert_eq!(Backend::Nyuchi.as_str(), "nyuchi");
        assert_eq!(Backend::D1.as_str(), "d1");
    }

    #[test]
    fn a_typo_is_an_error_not_a_silent_default() {
        let bad = Backend::parse(Some("nuychi")).unwrap_err();
        assert_eq!(bad, UnknownBackend("nuychi".into()));
        assert!(bad.log_line().contains("ALERT stations_backend_unknown"));
        // Long values are cut before they reach a log.
        let long = "x".repeat(500);
        assert_eq!(Backend::parse(Some(&long)).unwrap_err().0.len(), 32);
    }

    #[test]
    fn the_api_url_must_be_https_or_loopback() {
        assert_eq!(
            api_base(Some("https://api.nyuchi.com/")).as_deref(),
            Some("https://api.nyuchi.com")
        );
        assert_eq!(
            api_base(Some(" https://api.nyuchi.com ")).as_deref(),
            Some("https://api.nyuchi.com")
        );
        assert_eq!(
            api_base(Some("http://127.0.0.1:8000")).as_deref(),
            Some("http://127.0.0.1:8000")
        );
        assert_eq!(
            api_base(Some("http://localhost:8787")).as_deref(),
            Some("http://localhost:8787")
        );
        // The internal key never goes over plain HTTP to a remote host.
        assert_eq!(api_base(Some("http://api.nyuchi.com")), None);
        assert_eq!(api_base(Some("http://localhost.evil.com")), None);
        assert_eq!(api_base(Some("ftp://api.nyuchi.com")), None);
        assert_eq!(api_base(Some("api.nyuchi.com")), None);
        assert_eq!(api_base(Some("https://")), None);
        assert_eq!(api_base(Some("https://a.b/x?y=1")), None);
        assert_eq!(api_base(Some("https://a.b c")), None);
        assert_eq!(api_base(Some("")), None);
        assert_eq!(api_base(None), None);
    }

    // --- verify: the contract ---------------------------------------------

    #[test]
    fn the_verify_request_is_the_documented_body() {
        let b = verify_body("mws-0a1b2c3d", "the key");
        assert_eq!(b, json!({"stationId": "mws-0a1b2c3d", "key": "the key"}));
    }

    #[test]
    fn a_valid_answer_gives_the_station_the_hot_path_needs() {
        let VerifyAnswer::Valid(s) = parse_verify("mws-0a1b2c3d", 200, VERIFY_OK).unwrap() else {
            panic!("valid");
        };
        assert_eq!(s.owner_type.as_deref(), Some("person"));
        assert_eq!(s.elevation_metres, Some(1150.0));
        assert_eq!(
            s.identity(),
            StationIdentity {
                station_id: "mws-0a1b2c3d".into(),
                lat: -17.36,
                lon: 30.2,
                country_code: "ZW".into(),
            }
        );
    }

    #[test]
    fn valid_false_is_the_only_answer_that_denies() {
        let body = r#"{"valid": false, "station": null}"#;
        assert_eq!(
            parse_verify("mws-0a1b2c3d", 200, body),
            Ok(VerifyAnswer::Invalid)
        );
        // `station` may be left out of a negative answer.
        assert_eq!(
            parse_verify("mws-0a1b2c3d", 200, r#"{"valid": false}"#),
            Ok(VerifyAnswer::Invalid)
        );
    }

    #[test]
    fn a_valid_answer_about_another_station_is_not_trusted() {
        let r = parse_verify("mws-ffffffff", 200, VERIFY_OK);
        assert!(
            matches!(r, Err(Failure::Contract { status: 200, .. })),
            "{r:?}"
        );
    }

    #[test]
    fn a_valid_answer_without_a_station_or_with_a_bad_place_is_not_trusted() {
        for body in [
            r#"{"valid": true}"#,
            r#"{"valid": true, "station": null}"#,
            r#"{"valid": true, "station": {"stationId": "mws-0a1b2c3d", "lat": 95, "lon": 0}}"#,
            r#"{"valid": true, "station": {"stationId": "mws-0a1b2c3d", "lon": 0}}"#,
            r#"{"valid": "yes"}"#,
            "not json",
            "",
            "{}",
        ] {
            let r = parse_verify("mws-0a1b2c3d", 200, body);
            assert!(matches!(r, Err(Failure::Contract { .. })), "{body}: {r:?}");
        }
    }

    #[test]
    fn a_missing_country_is_zimbabwe_as_the_worker_always_assumed() {
        let body = r#"{"valid": true, "station": {"stationId": "mws-0a1b2c3d", "lat": 1, "lon": 2, "countryCode": null}}"#;
        let VerifyAnswer::Valid(s) = parse_verify("mws-0a1b2c3d", 200, body).unwrap() else {
            panic!("valid");
        };
        assert_eq!(s.identity().country_code, "ZW");
        let lower = VerifiedStation {
            country_code: Some("ke".into()),
            ..s
        };
        assert_eq!(lower.identity().country_code, "KE");
    }

    // --- verify: the error mapping ----------------------------------------

    #[test]
    fn a_401_on_a_service_route_is_the_workers_credential_not_the_stations() {
        let body = r#"{"detail": "Send the ingest Worker's service key.", "code": "authentication_required"}"#;
        let f = parse_verify("mws-0a1b2c3d", 401, body).unwrap_err();
        assert_eq!(
            f,
            Failure::CredentialRejected {
                what: "verify",
                status: 401,
                code: Some("authentication_required".into())
            }
        );
        assert!(f.is_alert());
        assert_eq!(f.tag(), "stations_api_credential_rejected");
        let line = f.log_line();
        assert!(
            line.starts_with("ALERT stations_api_credential_rejected"),
            "{line}"
        );
        assert!(line.contains("503, not 401"), "{line}");
        // A station is told 503, whatever the cause.
        assert_eq!(Failure::STATION_STATUS, 503);
    }

    #[test]
    fn a_403_is_the_workers_credential_too() {
        for code in ["service_key_required", "insufficient_scope"] {
            let body = format!(r#"{{"code": "{code}"}}"#);
            let f = parse_verify("mws-0a1b2c3d", 403, &body).unwrap_err();
            assert!(
                matches!(&f, Failure::CredentialRejected { status: 403, code: Some(c), .. } if c == code),
                "{f:?}"
            );
        }
    }

    #[test]
    fn an_outage_is_unavailable_and_a_warning_not_an_alert() {
        for status in [429, 500, 502, 503, 504, 408] {
            let f = parse_verify("mws-0a1b2c3d", status, "").unwrap_err();
            assert_eq!(
                f,
                Failure::Unavailable {
                    what: "verify",
                    status: Some(status)
                }
            );
            assert!(!f.is_alert());
        }
        let none = no_answer("verify");
        assert!(none.log_line().contains("did not answer verify"));
    }

    #[test]
    fn a_route_that_is_not_deployed_is_a_contract_alert_never_a_401() {
        // FastAPI's own 404 for an unknown path.
        for (status, body) in [
            (404, r#"{"detail": "Not Found"}"#),
            (422, r#"{"code": "validation_error"}"#),
            (413, r#"{"code": "payload_too_large"}"#),
            (400, ""),
            (302, ""),
        ] {
            let f = parse_verify("mws-0a1b2c3d", status, body).unwrap_err();
            assert!(matches!(f, Failure::Contract { .. }), "{status}: {f:?}");
            assert!(f.is_alert());
        }
    }

    #[test]
    fn only_a_plain_identifier_is_read_from_an_error_body() {
        assert_eq!(
            problem_code(r#"{"code": "invalid_credentials"}"#).as_deref(),
            Some("invalid_credentials")
        );
        assert_eq!(problem_code(r#"{"code": "Bad Code!"}"#), None);
        assert_eq!(
            problem_code(&format!(r#"{{"code": "{}"}}"#, "a".repeat(65))),
            None
        );
        assert_eq!(problem_code(r#"{"code": 5}"#), None);
        assert_eq!(problem_code(r#"{"detail": "x"}"#), None);
        assert_eq!(problem_code("<html>"), None);
        // A body quoting a key never reaches a log line.
        let f = parse_verify(
            "mws-0a1b2c3d",
            401,
            r#"{"code": "k3y with spaces", "detail": "secret-key-value"}"#,
        )
        .unwrap_err();
        assert!(!f.log_line().contains("secret-key-value"));
        assert!(!f.log_line().contains("k3y"));
    }

    #[test]
    fn missing_configuration_names_what_is_missing_and_nothing_else() {
        let f = Failure::NotConfigured {
            missing: vec!["NYUCHI_API_URL", "NYUCHI_STATIONS_API_KEY"],
        };
        assert!(f.is_alert());
        let line = f.log_line();
        assert!(line.contains("ALERT stations_backend_misconfigured"));
        assert!(line.contains("NYUCHI_API_URL, NYUCHI_STATIONS_API_KEY"));
    }

    // --- the cache ----------------------------------------------------------

    fn valid_station(id: &str) -> VerifiedStation {
        VerifiedStation {
            station_id: id.into(),
            device_id: None,
            name: "Chinhoyi School".into(),
            station_type: "digital".into(),
            lat: -17.36,
            lon: 30.2,
            country_code: Some("ZW".into()),
            elevation_metres: None,
            owner_type: Some("person".into()),
        }
    }

    #[test]
    fn the_cache_key_is_a_digest_that_never_holds_the_key() {
        let d = VerifyCache::digest("mws-0a1b2c3d", "super-secret-key");
        assert_eq!(d.len(), 64);
        assert!(!d.contains("super-secret-key"));
        // Keyed on the station and the key together: the same key for another
        // station is a different entry.
        assert_ne!(d, VerifyCache::digest("mws-0a1b2c3e", "super-secret-key"));
        assert_ne!(d, VerifyCache::digest("mws-0a1b2c3d", "super-secret-kez"));
        assert_eq!(d, VerifyCache::digest("mws-0a1b2c3d", "super-secret-key"));
        let mut c = VerifyCache::new();
        c.remember(d, &VerifyAnswer::Valid(valid_station("mws-0a1b2c3d")), 0);
        // The debug form (which could reach a log) holds no key either.
        assert!(!format!("{c:?}").contains("super-secret-key"));
    }

    #[test]
    fn a_positive_answer_lasts_ten_minutes() {
        let mut c = VerifyCache::new();
        let d = VerifyCache::digest("mws-0a1b2c3d", "k");
        assert_eq!(c.lookup(&d, 1_000), Cached::Miss);
        c.remember(
            d.clone(),
            &VerifyAnswer::Valid(valid_station("mws-0a1b2c3d")),
            1_000,
        );
        assert!(matches!(c.lookup(&d, 1_000), Cached::Valid(_)));
        assert!(matches!(
            c.lookup(&d, 1_000 + 600_000 - 1),
            Cached::Valid(_)
        ));
        assert_eq!(c.lookup(&d, 1_000 + 600_000), Cached::Miss);
    }

    #[test]
    fn a_negative_answer_lasts_sixty_seconds() {
        let mut c = VerifyCache::new();
        let d = VerifyCache::digest("mws-0a1b2c3d", "wrong");
        c.remember(d.clone(), &VerifyAnswer::Invalid, 5_000);
        assert_eq!(c.lookup(&d, 5_000), Cached::Invalid);
        assert_eq!(c.lookup(&d, 5_000 + 59_999), Cached::Invalid);
        assert_eq!(c.lookup(&d, 5_000 + 60_000), Cached::Miss);
    }

    #[test]
    fn a_later_answer_replaces_the_other_kind() {
        let mut c = VerifyCache::new();
        let d = VerifyCache::digest("mws-0a1b2c3d", "k");
        c.remember(d.clone(), &VerifyAnswer::Invalid, 0);
        c.remember(
            d.clone(),
            &VerifyAnswer::Valid(valid_station("mws-0a1b2c3d")),
            10,
        );
        assert!(matches!(c.lookup(&d, 20), Cached::Valid(_)));
        c.remember(d.clone(), &VerifyAnswer::Invalid, 30);
        assert_eq!(c.lookup(&d, 40), Cached::Invalid);
        assert_eq!(c.len(), (0, 1));
    }

    #[test]
    fn a_failure_is_never_cached() {
        // The cache has no way to hold a Failure: only a VerifyAnswer goes in,
        // so an outage with a cold cache stays a miss and the next upload asks again.
        let c = VerifyCache::new();
        let d = VerifyCache::digest("mws-0a1b2c3d", "k");
        assert_eq!(c.lookup(&d, 0), Cached::Miss);
        assert!(c.is_empty());
    }

    #[test]
    fn a_flood_of_wrong_keys_cannot_evict_a_real_station() {
        let mut c = VerifyCache::new();
        let real = VerifyCache::digest("mws-0a1b2c3d", "real-key");
        c.remember(
            real.clone(),
            &VerifyAnswer::Valid(valid_station("mws-0a1b2c3d")),
            0,
        );
        for i in 0..(VERIFY_CACHE_MAX * 3) {
            let d = VerifyCache::digest("mws-0a1b2c3d", &format!("guess-{i}"));
            c.remember(d, &VerifyAnswer::Invalid, 1);
        }
        assert!(matches!(c.lookup(&real, 2), Cached::Valid(_)));
        assert!(c.len().1 <= VERIFY_CACHE_MAX);
    }

    #[test]
    fn a_full_cache_drops_what_expired_before_clearing() {
        let mut c = VerifyCache::new();
        for i in 0..VERIFY_CACHE_MAX {
            let d = VerifyCache::digest("mws-0a1b2c3d", &format!("k{i}"));
            c.remember(d, &VerifyAnswer::Valid(valid_station("mws-0a1b2c3d")), 0);
        }
        assert_eq!(c.len().0, VERIFY_CACHE_MAX);
        // Past the ttl everything has expired: the next one makes room by
        // dropping them, leaving one.
        let late = VERIFY_POSITIVE_TTL_MS + 1;
        c.remember(
            VerifyCache::digest("mws-0a1b2c3d", "new"),
            &VerifyAnswer::Valid(valid_station("mws-0a1b2c3d")),
            late,
        );
        assert_eq!(c.len().0, 1);
        // While full of live entries the map is cleared, bounded either way.
        let mut c = VerifyCache::new();
        for i in 0..VERIFY_CACHE_MAX {
            let d = VerifyCache::digest("mws-0a1b2c3d", &format!("k{i}"));
            c.remember(d, &VerifyAnswer::Valid(valid_station("mws-0a1b2c3d")), 0);
        }
        c.remember(
            VerifyCache::digest("mws-0a1b2c3d", "extra"),
            &VerifyAnswer::Valid(valid_station("mws-0a1b2c3d")),
            1,
        );
        assert_eq!(c.len().0, 1);
    }

    // --- observations ---------------------------------------------------------

    #[test]
    fn an_item_is_the_documented_shape() {
        let m = msg(
            "mws-0a1b2c3d",
            1_794_560_400_000, // 2026-11-13T09:00:00Z
            "ecowitt",
            &[
                ("airTemperatureCelsius", 21.46),
                ("relativeHumidityPercent", 40.0),
                ("windSpeedKph", 16.09),
            ],
        );
        let items = observation_items(std::slice::from_ref(&m));
        assert_eq!(items.len(), 1);
        let body = observations_body(&[&items[0].1]);
        let expected: Value = serde_json::from_str(OBSERVATIONS_REQUEST).unwrap();
        // The documented example has a whole-second instant; ours carries
        // milliseconds, which RFC 3339 allows and the API parses.
        assert_eq!(
            body["observations"][0]["receivedAt"],
            "2026-11-13T09:00:00.000Z"
        );
        // Same fields and values as the documented example. (JSON numbers are
        // compared as numbers: the example writes `40`, a float serialises as
        // `40.0`.)
        let (got, want) = (&body["observations"][0], &expected["observations"][0]);
        assert_eq!(got["stationId"], want["stationId"]);
        assert_eq!(got["source"], want["source"]);
        let numbers = |v: &Value| -> BTreeMap<String, f64> {
            v["metrics"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), v.as_f64().unwrap()))
                .collect()
        };
        assert_eq!(numbers(got), numbers(want));
        // Nothing but the four documented fields is sent.
        let keys: Vec<&str> = body["observations"][0]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, ["metrics", "receivedAt", "source", "stationId"]);
    }

    #[test]
    fn the_instant_keeps_its_milliseconds_so_a_retry_derives_the_same_id() {
        assert_eq!(
            rfc3339_millis(1_794_560_400_123).as_deref(),
            Some("2026-11-13T09:00:00.123Z")
        );
        assert_eq!(
            rfc3339_millis(0).as_deref(),
            Some("1970-01-01T00:00:00.000Z")
        );
        // The same message always gives the same item (a queue retry).
        let m = msg(
            "mws-0a1b2c3d",
            1_794_560_400_123,
            "wunderground",
            &[("uvIndex", 3.0)],
        );
        let again = observation_items(std::slice::from_ref(&m));
        assert_eq!(observation_items(&[m]), again);
    }

    #[test]
    fn an_upload_with_nothing_in_range_is_still_sent_so_last_seen_moves() {
        let m = msg("mws-0a1b2c3d", 1_794_560_400_000, "wunderground", &[]);
        let items = observation_items(&[m]);
        assert_eq!(items.len(), 1);
        assert!(items[0].1.metrics.is_empty());
        let body = observations_body(&[&items[0].1]);
        assert_eq!(body["observations"][0]["metrics"], json!({}));
    }

    #[test]
    fn items_keep_the_position_of_their_message() {
        let ms: Vec<IngestMessage> = (0..3)
            .map(|i| {
                msg(
                    "mws-0a1b2c3d",
                    1_794_560_400_000 + i,
                    "ecowitt",
                    &[("uvIndex", 1.0)],
                )
            })
            .collect();
        let idx: Vec<usize> = observation_items(&ms).into_iter().map(|(i, _)| i).collect();
        assert_eq!(idx, [0, 1, 2]);
    }

    #[test]
    fn batches_are_split_at_the_apis_limit() {
        assert!(request_chunks(Vec::<u8>::new()).is_empty());
        let one = request_chunks(vec![0u8; 500]);
        assert_eq!(one.len(), 1);
        let two = request_chunks(vec![0u8; 501]);
        assert_eq!(two.iter().map(Vec::len).collect::<Vec<_>>(), [500, 1]);
        let three = request_chunks(vec![0u8; 1_200]);
        assert_eq!(
            three.iter().map(Vec::len).collect::<Vec<_>>(),
            [500, 500, 200]
        );
    }

    #[test]
    fn the_documented_answer_is_read_item_by_item() {
        let out = parse_observations(2, 200, OBSERVATIONS_OK).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].status, ItemStatus::Stored);
        assert!(out[0].accepted());
        assert_eq!(out[1].status, ItemStatus::Rejected);
        assert_eq!(out[1].code.as_deref(), Some("no_valid_metrics"));
        assert!(!out[1].accepted());
    }

    #[test]
    fn a_duplicate_is_a_success() {
        let body = r#"{"stored": 0, "duplicates": 1, "rejected": 0,
            "results": [{"index": 0, "status": "duplicate", "qcStatus": "validated",
                         "observationId": "x", "code": null}]}"#;
        let out = parse_observations(1, 200, body).unwrap();
        assert_eq!(out[0].status, ItemStatus::Duplicate);
        assert!(out[0].accepted());
    }

    #[test]
    fn results_out_of_order_are_put_back_in_order() {
        let body = r#"{"stored": 2, "duplicates": 0, "rejected": 0, "results": [
            {"index": 1, "status": "rejected", "qcStatus": "rejected", "code": "station_not_found"},
            {"index": 0, "status": "stored", "qcStatus": "validated", "code": null}]}"#;
        let out = parse_observations(2, 200, body).unwrap();
        assert_eq!(out[0].status, ItemStatus::Stored);
        assert_eq!(out[1].code.as_deref(), Some("station_not_found"));
    }

    #[test]
    fn an_answer_that_does_not_account_for_every_item_is_retried() {
        for (sent, body) in [
            (3, OBSERVATIONS_OK), // fewer results than items
            (1, OBSERVATIONS_OK), // more results than items
            (1, r#"{"results": [{"index": 5, "status": "stored"}]}"#), // index out of range
            (
                2,
                r#"{"results": [{"index": 0, "status": "stored"}, {"index": 0, "status": "stored"}]}"#,
            ), // twice
            (1, r#"{"results": [{"index": 0, "status": "maybe"}]}"#), // unknown status
            (1, "{}"),
            (1, "nope"),
        ] {
            let r = parse_observations(sent, 200, body);
            assert!(matches!(r, Err(Failure::Contract { .. })), "{body}: {r:?}");
        }
    }

    #[test]
    fn batch_write_errors_map_like_verify() {
        assert!(matches!(
            parse_observations(1, 503, ""),
            Err(Failure::Unavailable {
                status: Some(503),
                what: "observations"
            })
        ));
        assert!(matches!(
            parse_observations(1, 401, r#"{"code": "authentication_required"}"#),
            Err(Failure::CredentialRejected {
                status: 401,
                what: "observations",
                ..
            })
        ));
        assert!(matches!(
            parse_observations(1, 422, ""),
            Err(Failure::Contract { status: 422, .. })
        ));
        assert!(matches!(
            parse_observations(1, 413, ""),
            Err(Failure::Contract { status: 413, .. })
        ));
    }

    #[test]
    fn the_summary_separates_the_expected_from_the_unusual() {
        let ok = msg("mws-0a1b2c3d", 1, "ecowitt", &[("uvIndex", 1.0)]);
        let empty = msg("mws-0a1b2c3d", 2, "ecowitt", &[]);
        let gone = msg("mws-0a1b2c3e", 3, "ecowitt", &[("uvIndex", 1.0)]);
        let dup = msg("mws-0a1b2c3d", 4, "ecowitt", &[("uvIndex", 1.0)]);
        let items = observation_items(&[ok, empty, gone, dup]);
        let refs: Vec<&ObservationItem> = items.iter().map(|(_, i)| i).collect();
        let outcomes = vec![
            ItemOutcome {
                status: ItemStatus::Stored,
                code: None,
            },
            ItemOutcome {
                status: ItemStatus::Rejected,
                code: Some("no_valid_metrics".into()),
            },
            ItemOutcome {
                status: ItemStatus::Rejected,
                code: Some("station_not_found".into()),
            },
            ItemOutcome {
                status: ItemStatus::Duplicate,
                code: None,
            },
        ];
        let s = BatchSummary::of(&refs, &outcomes);
        assert_eq!((s.sent, s.stored, s.duplicates, s.empty), (4, 1, 1, 1));
        assert_eq!(s.rejected.get("station_not_found"), Some(&1));
        assert!(s.is_unusual());
        let line = s.log_line();
        assert!(line.contains("station_not_found 1"), "{line}");
        // A batch that only held an empty upload is not unusual.
        let quiet = BatchSummary::of(&refs[1..2], &outcomes[1..2]);
        assert!(!quiet.is_unusual());
    }

    // --- the legacy proxies -----------------------------------------------------

    #[test]
    fn credentials_that_cannot_be_a_stations_never_reach_the_api() {
        assert!(plausible_credentials("mws-0a1b2c3d", "AbC-_123"));
        assert!(!plausible_credentials("mws-0A1B2C3D", "k"));
        assert!(!plausible_credentials("nope", "k"));
        assert!(!plausible_credentials("mws-0a1b2c3d", ""));
        assert!(!plausible_credentials(
            "mws-0a1b2c3d",
            &"k".repeat(MAX_KEY_LEN + 1)
        ));
        assert!(plausible_credentials(
            "mws-0a1b2c3d",
            &"k".repeat(MAX_KEY_LEN)
        ));
        // Nothing that could break a header.
        assert!(!is_sendable_key("a b"));
        assert!(!is_sendable_key("a\r\nX-Evil: 1"));
        assert!(!is_sendable_key("caf\u{e9}"));
    }

    #[test]
    fn a_manual_reading_becomes_the_apis_readings_request() {
        let metrics = Metrics::from([
            ("airTemperatureCelsius", Some(21.5)),
            ("relativeHumidityPercent", Some(63.0)),
            ("atmosphericPressureMillibar", None),
            ("windSpeedKph", Some(12.0)),
            ("windDirectionDegrees", Some(145.0)),
            ("precipitationMillimeters", Some(0.0)),
        ]);
        let body = manual_readings_body(&metrics);
        assert_eq!(
            body,
            json!({
                "stationType": "generic",
                "readings": [{
                    "temperatureC": 21.5,
                    "humidityPct": 63.0,
                    "windSpeedKph": 12.0,
                    "windDirDeg": 145.0,
                    "rainfallMm": 0.0
                }]
            })
        );
        // One reading, undated: the API dates a single reading now.
        assert!(body["readings"][0].get("observedAt").is_none());
        // The note has no field at the API and is not sent.
        assert!(body["readings"][0].get("notes").is_none());
    }

    #[test]
    fn the_readings_request_uses_only_fields_the_api_documents() {
        const DOCUMENTED: [&str; 9] = [
            "observedAt",
            "temperatureC",
            "humidityPct",
            "pressureHpa",
            "rainfallMm",
            "windSpeedMs",
            "windSpeedKph",
            "windDirDeg",
            "uvIndex",
        ];
        for (_, field) in MANUAL_FIELDS {
            assert!(
                DOCUMENTED.contains(&field),
                "{field} is not a reading field"
            );
        }
        // Every legacy metric the Worker's manual route accepts is mapped.
        for stored in [
            "airTemperatureCelsius",
            "relativeHumidityPercent",
            "atmosphericPressureMillibar",
            "windSpeedKph",
            "windDirectionDegrees",
            "precipitationMillimeters",
        ] {
            assert!(MANUAL_FIELDS.iter().any(|(s, _)| *s == stored), "{stored}");
        }
    }

    #[test]
    fn a_stored_manual_reading_is_accepted() {
        assert_eq!(
            parse_manual(200, READINGS_OK),
            Ok(Proxied::Done(ManualResult::Accepted))
        );
    }

    #[test]
    fn a_refused_manual_reading_says_which_field_and_never_the_value() {
        let Ok(Proxied::Done(ManualResult::Rejected { detail })) =
            parse_manual(200, READINGS_REJECTED)
        else {
            panic!("rejected");
        };
        assert_eq!(
            detail,
            "`temperatureC`: Must be between -50 and 60 in this unit."
        );
        // Odd text from the API cannot add control characters or run on.
        let body = format!(
            r#"{{"accepted": 0, "errors": [{{"field": "x", "detail": "a\nb{}"}}]}}"#,
            "z".repeat(500)
        );
        let Ok(Proxied::Done(ManualResult::Rejected { detail })) = parse_manual(200, &body) else {
            panic!("rejected");
        };
        assert!(detail.chars().count() <= 200 && !detail.contains('\n'));
        assert_eq!(
            parse_manual(200, r#"{"accepted": 0, "errors": []}"#),
            Ok(Proxied::Done(ManualResult::Rejected {
                detail: "The reading was refused.".into()
            }))
        );
    }

    #[test]
    fn the_status_is_passed_on_as_the_api_gave_it() {
        let Ok(Proxied::Done(v)) = parse_status("mws-0a1b2c3d", 200, STATION_STATUS) else {
            panic!("status");
        };
        // The legacy fields the console reads are all there.
        for field in [
            "stationId",
            "name",
            "stationType",
            "status",
            "lastObservationAt",
            "latestMetrics",
        ] {
            assert!(v.get(field).is_some(), "{field}");
        }
        // A body about another station is not passed on.
        assert!(matches!(
            parse_status("mws-ffffffff", 200, STATION_STATUS),
            Err(Failure::Contract { .. })
        ));
        assert!(matches!(
            parse_status("mws-0a1b2c3d", 200, "[]"),
            Err(Failure::Contract { .. })
        ));
    }

    #[test]
    fn only_invalid_credentials_is_a_stations_401_on_the_key_routes() {
        assert_eq!(
            parse_status("mws-0a1b2c3d", 401, PROBLEM_INVALID_CREDENTIALS),
            Ok(Proxied::Denied)
        );
        assert_eq!(
            parse_manual(401, PROBLEM_INVALID_CREDENTIALS),
            Ok(Proxied::Denied)
        );
        // A 401 with any other code, or none, is not "your key is wrong".
        for body in [
            r#"{"code": "invalid_token"}"#,
            r#"{"code": "authentication_required"}"#,
            "",
            "{}",
        ] {
            let r = parse_status("mws-0a1b2c3d", 401, body);
            assert!(
                matches!(r, Err(Failure::Contract { status: 401, .. })),
                "{body}: {r:?}"
            );
        }
        // Nor is a 403, a 404 with no problem (no route), or a 422.
        for (status, body) in [
            (403, ""),
            (404, r#"{"detail":"Not Found"}"#),
            (422, ""),
            (400, ""),
        ] {
            assert!(
                matches!(parse_manual(status, body), Err(Failure::Contract { .. })),
                "{status}"
            );
        }
        // An outage or a busy API is a retry.
        for status in [429, 500, 503, 504] {
            assert!(matches!(
                parse_manual(status, ""),
                Err(Failure::Unavailable { .. })
            ));
        }
    }

    // --- logging ------------------------------------------------------------------

    #[test]
    fn a_tag_logs_once_per_interval_so_an_outage_is_loud_not_a_flood() {
        let mut t = LogThrottle::new();
        assert!(t.allow("stations_api_unavailable", 1_000));
        assert!(!t.allow("stations_api_unavailable", 1_001));
        assert!(!t.allow("stations_api_unavailable", 30_999));
        // Another tag is not held back by it.
        assert!(t.allow("stations_api_credential_rejected", 1_002));
        assert!(t.allow("stations_api_unavailable", 31_000));
        assert!(!t.allow("stations_api_unavailable", 31_001));
    }
}
