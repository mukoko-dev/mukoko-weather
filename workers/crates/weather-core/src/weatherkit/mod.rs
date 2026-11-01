//! Apple WeatherKit as a forecast model: `apple_weatherkit`, "Apple Weather".
//!
//! The owner has an Apple Developer Program membership, which includes 500,000
//! WeatherKit calls a month (owner, 2026-11-01: "This should be added to our
//! model list"). This module is every host-agnostic rule for using it, pure and
//! tested natively. It does no I/O, holds no key and reads no clock; the
//! Servers API origin (Gwaihir, nyuchi/nyuchi-servers-api) is the host that
//! makes the call, keeps the cache and runs the budget. Nothing here is wired
//! into a Cloudflare Worker, and nothing in the Workers serves the model.
//!
//! **Unverified against the live API.** No WeatherKit key was available, so no
//! response was ever recorded. The fixture
//! (`tests/fixtures/weatherkit-documented.json`) is built from the property
//! tables of Apple's REST documentation (names, types and units) and says so:
//! `provenance: documented`, never `recorded`. The first real response must be
//! compared with it before the model is switched on.
//!
//! | Module | Rule |
//! | --- | --- |
//! | [`condition`] | `conditionCode` to WMO, all 34 documented codes |
//! | [`token`] | the ES256 developer token, signer injected |
//! | [`snapshot`] | the response in our form: names, units, times |
//! | [`align`] | that form on a place's own time axis; the comparison series; composing with the filler |
//! | [`budget`] | the call budget and its atomic statements |
//!
//! # Host adapter contract (for Gwaihir)
//!
//! 1. **Configured?** Four values, `MUKOKO_WEATHER_WEATHERKIT_TEAM_ID`,
//!    `_SERVICE_ID`, `_KEY_ID` and `_PRIVATE_KEY` ([`SECRETS`]; the private key
//!    is the PKCS#8 PEM text of the `.p8`). The three identifiers go through
//!    [`Credentials::validate`] at startup. If any is missing the model is
//!    unavailable ([`Unavailable::NotConfigured`]): it is not offered in
//!    `models_available`, and `?model=apple_weatherkit` answers the blend
//!    labelled with that reason. Nothing breaks.
//! 2. **The filler first.** Fetch Open-Meteo `best_match` (one request,
//!    unsuffixed) before Apple: it supplies the time axis, the offset, the IANA
//!    `timezone` name Apple needs, and the variables Apple does not publish
//!    (CAPE, lifted index, surface pressure, apparent-temperature extremes, wind
//!    maxima, ET0).
//! 3. **Cache.** Key [`cache_key`] (`wk:v1:` plus the 0.05 degree cell key),
//!    TTL [`cache_ttl_seconds`] (15 minutes, never past Apple's own
//!    `expireTime`), value the serialised [`Snapshot`] (the standard form, the
//!    only stored form of Apple data). Shared by all callers, so it must be a
//!    store the origin's instances share: with a per-process cache every
//!    instance spends its own call for the same cell. Apple data is written
//!    NOWHERE else: not a database, the history store, the archive, or the
//!    forecast-verification capture. Do not cache the composed payload either
//!    (it is Apple data too and would outlive the snapshot): compose per
//!    request, which is cheap.
//! 4. **A miss spends.** If `breaker::APPLE_WEATHERKIT` will not `allow` a
//!    call, the answer is [`Unavailable::CircuitOpen`]. Then the budget:
//!    [`budget::ROLLING_SPEND_SQL`]
//!    then [`budget::MONTH_SPEND_SQL`], both must write, any error is a refusal
//!    ([`Unavailable::BudgetExhausted`] / [`Unavailable::BudgetUnavailable`]).
//!    Then the token ([`token::developer_token`], reused while
//!    [`token::reusable`], never logged, never in a URL), then
//!    `GET` [`weather_url`] with `Authorization: Bearer <token>`, timeout
//!    [`REQUEST_TIMEOUT_MS`].
//! 5. **Classify.** [`classify`]: `Ok` parses ([`snapshot::parse`]; `None` is an
//!    upstream failure) and writes the cache; `Unauthorized` (401, 403) drops
//!    the cached token, pauses [`UNAUTHORIZED_PAUSE_SECONDS`] and is
//!    [`Unavailable::AuthFailed`]; `Rejected` (other 4xx) is
//!    [`Unavailable::UpstreamError`] without touching the breaker; `Outage`
//!    (5xx, 429, timeout, transport, unreadable body) records a breaker failure.
//!    Log status codes only.
//! 6. **Compose.** [`align::compose_raw`] then `blend::build_single_model(raw,
//!    "apple_weatherkit", now)` (PR #398; on `staging` before it lands the
//!    composed raw is read with `blend::blend_payload`, which the tests do);
//!    set `payload["baseline"]` to
//!    [`baseline_marker`]; answer `X-Weather-Provider: apple-weatherkit`
//!    ([`PROVIDER`]) and no `X-Weather-Blend`. For the comparison, append
//!    [`align::series`] to `models` and `models_available` (spend class
//!    [`budget::Class::Comparison`]).
//! 7. **Attribution travels with the data.** `baseline.attribution`
//!    ([`attribution`]) names the source, links the legal page, and says the
//!    data was modified when it was.
//!
//! Alerts are out of scope: nothing here asks for `weatherAlerts`.

pub mod align;
pub mod budget;
pub mod condition;
pub mod snapshot;
pub mod token;

use serde_json::{json, Value};

pub use snapshot::{parse, Snapshot};
pub use token::{Credentials, Es256Signer, TokenError};

use crate::{geo, normalize};

/// The model id: what `selectedForecastModel`, `?model=` and `models=` carry.
/// Not an Open-Meteo model: it must never be forwarded to Open-Meteo, which
/// answers an unknown model with `400`.
pub const MODEL_ID: &str = "apple_weatherkit";
/// What a person reads.
pub const LABEL: &str = "Apple Weather";
/// `X-Weather-Provider` of an answer that is Apple's forecast (the other
/// providers are `open-meteo:<variant>`; Apple is its own provider).
pub const PROVIDER: &str = "apple-weatherkit";

/// The WeatherKit REST API.
pub const API_BASE: &str = "https://weatherkit.apple.com";
/// The language of the request. Nothing localisable is kept (condition codes
/// are not text), so one language, and the cache needs no language in its key.
pub const LANGUAGE: &str = "en";
/// ONE request names all four data sets: a request is one call however many it
/// names. Not `weatherAlerts` (out of scope).
pub const DATA_SETS: &str = "currentWeather,forecastHourly,forecastDaily,forecastNextHour";
/// How long the origin waits for Apple.
pub const REQUEST_TIMEOUT_MS: u64 = 5_000;

/// Apple's legal page for the data sources. Required wherever Apple weather data
/// is displayed, next to the Apple Weather trademark.
pub const LEGAL_URL: &str = "https://developer.apple.com/weatherkit/data-source-attribution/";
/// The trademark text Apple's terms name: "Apple Weather trademark (Weather)".
pub const TRADEMARK: &str = "Weather";
/// Apple: value-added data must be attributed to "Weather" "along with a notice
/// that the data provided by Apple has been modified".
pub const MODIFIED_NOTICE: &str = "Data provided by Apple has been modified.";

/// The four values that configure the provider (Servers API secret store). The
/// last is the PKCS#8 PEM text of the downloaded `.p8`. Never logged.
pub const SECRET_TEAM_ID: &str = "MUKOKO_WEATHER_WEATHERKIT_TEAM_ID";
pub const SECRET_SERVICE_ID: &str = "MUKOKO_WEATHER_WEATHERKIT_SERVICE_ID";
pub const SECRET_KEY_ID: &str = "MUKOKO_WEATHER_WEATHERKIT_KEY_ID";
pub const SECRET_PRIVATE_KEY: &str = "MUKOKO_WEATHER_WEATHERKIT_PRIVATE_KEY";
pub const SECRETS: [&str; 4] = [
    SECRET_TEAM_ID,
    SECRET_SERVICE_ID,
    SECRET_KEY_ID,
    SECRET_PRIVATE_KEY,
];

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/// The cache key prefix. Bump the version when [`Snapshot`] changes shape.
pub const CACHE_PREFIX: &str = "wk:v1:";
/// How long a snapshot is kept: 15 minutes.
pub const CACHE_TTL_SECONDS: u64 = 15 * 60;
/// The shortest TTL (also the smallest a key-value store accepts), so an
/// `expireTime` already in the past does not turn every request into a call.
pub const CACHE_MIN_TTL_SECONDS: u64 = 60;

/// `wk:v1:cell:-17.85_31.05`: the 0.05 degree cell, as every weather cache.
pub fn cache_key(lat: f64, lon: f64) -> String {
    format!("{CACHE_PREFIX}{}", geo::cell_key(lat, lon))
}

/// How long to keep `snapshot` read at `now`: [`CACHE_TTL_SECONDS`], cut to the
/// time left before Apple's own `expireTime` when that is sooner, never below
/// [`CACHE_MIN_TTL_SECONDS`]. This is the longest any Apple data is retained.
pub fn cache_ttl_seconds(snapshot: &Snapshot, now: chrono::DateTime<chrono::Utc>) -> u64 {
    let until_expiry = snapshot
        .expires_at
        .map(|t| (t - now).num_seconds().max(0) as u64);
    until_expiry
        .map_or(CACHE_TTL_SECONDS, |left| left.min(CACHE_TTL_SECONDS))
        .max(CACHE_MIN_TTL_SECONDS)
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/// A time zone name safe to put in a request: an IANA name (`Africa/Harare`,
/// `America/Argentina/Buenos_Aires`, `Etc/GMT+5`), letters, digits and `_ + - /`.
fn timezone_ok(tz: &str) -> bool {
    !tz.is_empty()
        && tz.len() <= 64
        && !tz.starts_with('/')
        && !tz.contains("//")
        && !tz.contains("..")
        && tz
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '+' | '-' | '/'))
}

/// The WeatherKit URL for the 0.05 degree cell around a point, or `None` for an
/// invalid coordinate.
///
/// The request is for the CELL CENTRE ([`geo::cell_center`]), not the visitor:
/// everyone in a cell shares one cached answer, so it must not depend on who
/// asked first, and Apple is sent a point about 5 km coarse. `timezone` is the
/// place's IANA name (Open-Meteo's `timezone`): it is how Apple rolls hours up
/// into days, and without it a day does not start at local midnight, which
/// [`align::day_date`] refuses to guess around. A name that is not a plausible
/// IANA name is left out (Apple then rolls up in its own default, and the daily
/// values are not used).
///
/// Not asked for: `countryCode` (alerts only), `hourlyStart`/`dailyStart` (the
/// defaults, the current hour and day, are documented; whether Apple serves
/// past hours is not verified, and the filler covers earlier hours of today).
pub fn weather_url(lat: f64, lon: f64, timezone: Option<&str>) -> Option<String> {
    if !geo::valid_coordinates(lat, lon) {
        return None;
    }
    let (clat, clon) = geo::cell_center(lat, lon);
    let mut pairs = vec![("dataSets", DATA_SETS.to_owned())];
    if let Some(tz) = timezone.filter(|tz| timezone_ok(tz)) {
        pairs.push(("timezone", tz.to_owned()));
    }
    Some(format!(
        "{API_BASE}/api/v1/weather/{LANGUAGE}/{clat:.2}/{clon:.2}?{}",
        normalize::query_string(&pairs)
    ))
}

// ---------------------------------------------------------------------------
// What came back
// ---------------------------------------------------------------------------

/// What an Apple response means for the host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// A `200` with a body that parsed.
    Ok,
    /// `401` or `403`: our token or key is wrong (rotated, revoked, the service
    /// not enabled for the key). Not an Apple outage, but it will not heal on
    /// retry: drop the cached token and pause.
    Unauthorized,
    /// Any other `4xx`: our request. Never counts against the breaker.
    Rejected,
    /// A `5xx`, a `429`, a timeout (no status), a transport error, or a `200`
    /// whose body did not parse: the breaker records a failure.
    Outage,
}

impl Outcome {
    /// Only an outage counts against the breaker: a rejected request or a bad
    /// token would otherwise open it for everyone.
    pub fn counts_against_breaker(self) -> bool {
        self == Outcome::Outage
    }
}

/// How long to stop calling after an [`Outcome::Unauthorized`], so a rotated
/// key does not turn every request into a refused call.
pub const UNAUTHORIZED_PAUSE_SECONDS: u64 = 300;

/// `status` is `None` for a timeout or a transport error; `body_parsed` is
/// whether a `200` body became a [`Snapshot`].
pub fn classify(status: Option<u16>, body_parsed: bool) -> Outcome {
    match status {
        Some(200) if body_parsed => Outcome::Ok,
        Some(401 | 403) => Outcome::Unauthorized,
        Some(429) => Outcome::Outage,
        Some(400..=499) => Outcome::Rejected,
        _ => Outcome::Outage,
    }
}

/// Why an answer is not Apple's forecast although it was asked for. The reason
/// goes in `baseline.reason` of the blend that is served instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unavailable {
    /// A secret is missing or invalid.
    NotConfigured,
    /// The budget is spent ([`budget::Decision`] other than `Grant` and
    /// `Unreadable`).
    BudgetExhausted,
    /// The budget could not be read or written: fail closed.
    BudgetUnavailable,
    /// The WeatherKit breaker is open.
    CircuitOpen,
    /// Apple failed, or sent something unusable.
    UpstreamError,
    /// The token was refused.
    AuthFailed,
    /// Apple answered but has nothing for the point's hours.
    NoData,
}

impl Unavailable {
    pub fn reason(self) -> &'static str {
        match self {
            Unavailable::NotConfigured => "not_configured",
            Unavailable::BudgetExhausted => "budget_exhausted",
            Unavailable::BudgetUnavailable => "budget_unavailable",
            Unavailable::CircuitOpen => "circuit_open",
            Unavailable::UpstreamError => "upstream_error",
            Unavailable::AuthFailed => "auth_failed",
            Unavailable::NoData => "no_data",
        }
    }

    /// The reason a budget decision refuses a call, or `None` for a grant.
    pub fn from_budget(decision: budget::Decision) -> Option<Unavailable> {
        match decision {
            budget::Decision::Grant => None,
            budget::Decision::Unreadable => Some(Unavailable::BudgetUnavailable),
            _ => Some(Unavailable::BudgetExhausted),
        }
    }
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

/// The attribution that travels with Apple's data. `modified` is true when the
/// values were combined into something else (the single-model baseline: nulls
/// filled from another model, insights derived from the values), which Apple
/// calls value-added data and which needs the modified notice; a series plotted
/// as it came, converted only in unit, does not.
pub fn attribution(modified: bool) -> Value {
    let mut a = json!({
        "name": LABEL,
        "trademark": TRADEMARK,
        "url": LEGAL_URL,
        "modified": modified,
    });
    if modified {
        a["notice"] = json!(MODIFIED_NOTICE);
    }
    a
}

/// `payload["baseline"]` of an answer that is Apple's forecast: it replaces the
/// marker `blend::build_single_model` sets, whose provider is Open-Meteo.
pub fn baseline_marker() -> Value {
    json!({
        "provider": PROVIDER,
        "blend": false,
        "model": MODEL_ID,
        "reason": "selected_model",
        // What fills the variables Apple does not publish.
        "filledFrom": "open-meteo:best_match",
        "attribution": attribution(true),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, TimeZone, Utc};

    fn snapshot_expiring(expires_in: Option<i64>, now: chrono::DateTime<Utc>) -> Snapshot {
        Snapshot {
            read_at: Some(now),
            expires_at: expires_in.map(|s| now + Duration::seconds(s)),
            current: None,
            hourly: vec![],
            daily: vec![],
            next_hour: vec![],
        }
    }

    fn now() -> chrono::DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 1, 10, 0, 0).unwrap()
    }

    #[test]
    fn the_model_is_ours_and_never_goes_to_open_meteo() {
        assert_eq!(MODEL_ID, "apple_weatherkit");
        assert_eq!(LABEL, "Apple Weather");
        // Open-Meteo answers an unknown model with 400, so it is not in the
        // list of models forwarded there, and a request naming it is cleaned.
        assert!(!normalize::KNOWN_FORECAST_MODELS.contains(&MODEL_ID));
        assert_eq!(
            normalize::sanitize_models(&[MODEL_ID]),
            normalize::sanitize_models(&[]),
            "falls back to the default set, never forwarded"
        );
        assert!(crate::community::FORECAST_MODELS.contains(&MODEL_ID));
        // Its provider header is its own, not an `open-meteo:` variant.
        assert!(!PROVIDER.starts_with("open-meteo"));
    }

    #[test]
    fn the_cache_key_is_the_cell_under_a_versioned_prefix() {
        assert_eq!(cache_key(-17.8312, 31.0499), "wk:v1:cell:-17.85_31.05");
        // Everyone in the 0.05 degree cell shares a key; the next cell does not.
        assert_eq!(cache_key(-17.86, 31.03), cache_key(-17.84, 31.07));
        assert_ne!(cache_key(-17.86, 31.03), cache_key(-17.90, 31.03));
        // Other weather caches use other prefixes, so a key is never shared.
        assert_ne!(
            cache_key(0.0, 0.0),
            format!("wx:v2:{}", geo::cell_key(0.0, 0.0))
        );
    }

    #[test]
    fn a_snapshot_is_kept_fifteen_minutes_at_most() {
        let n = now();
        assert_eq!(cache_ttl_seconds(&snapshot_expiring(None, n), n), 900);
        // Apple says it is good for half an hour: still 15 minutes.
        assert_eq!(cache_ttl_seconds(&snapshot_expiring(Some(1800), n), n), 900);
        // Apple says it expires sooner: not kept past that.
        assert_eq!(cache_ttl_seconds(&snapshot_expiring(Some(300), n), n), 300);
        // Already expired, or about to: a short floor, not a call per request.
        assert_eq!(cache_ttl_seconds(&snapshot_expiring(Some(-60), n), n), 60);
        assert_eq!(cache_ttl_seconds(&snapshot_expiring(Some(10), n), n), 60);
        // Never longer than the 15 minutes the retention decision allows.
        for e in [None, Some(0), Some(60), Some(899), Some(900), Some(86_400)] {
            assert!(cache_ttl_seconds(&snapshot_expiring(e, n), n) <= CACHE_TTL_SECONDS);
        }
    }

    #[test]
    fn one_request_names_every_data_set_for_the_cell_centre() {
        let url = weather_url(-17.8312, 31.0499, Some("Africa/Harare")).unwrap();
        assert!(url.starts_with("https://weatherkit.apple.com/api/v1/weather/en/-17.85/31.05?"));
        assert!(
            url.contains("dataSets=currentWeather,forecastHourly,forecastDaily,forecastNextHour")
        );
        assert!(url.contains("timezone=Africa%2FHarare"));
        // The visitor's exact coordinate is not sent.
        assert!(!url.contains("17.8312") && !url.contains("31.0499"));
        // Alerts are out of scope.
        assert!(!url.contains("weatherAlerts") && !url.contains("countryCode"));
        // One request, one URL: the data sets are one comma-separated list.
        assert_eq!(url.matches("dataSets=").count(), 1);
        assert_eq!(DATA_SETS.split(',').count(), 4);
    }

    #[test]
    fn two_visitors_in_one_cell_send_the_same_request() {
        assert_eq!(
            weather_url(-17.8312, 31.0499, Some("Africa/Harare")),
            weather_url(-17.8601, 31.0251, Some("Africa/Harare"))
        );
    }

    #[test]
    fn a_bad_point_or_zone_is_not_sent() {
        assert_eq!(weather_url(91.0, 0.0, None), None);
        assert_eq!(weather_url(0.0, f64::NAN, None), None);
        let u = weather_url(51.5, -0.1, Some("Europe/London")).unwrap();
        assert!(u.contains("/51.50/-0.10?"));
        for bad in [
            "",
            "a b",
            "x&y=1",
            "../etc",
            "/abs",
            "a//b",
            &"z".repeat(65),
            "q#",
        ] {
            let u = weather_url(0.0, 0.0, Some(bad)).unwrap();
            assert!(!u.contains("timezone"), "{bad:?}");
        }
        assert!(weather_url(0.0, 0.0, None)
            .unwrap()
            .ends_with("forecastNextHour"));
        // Etc zones carry a sign.
        assert!(weather_url(0.0, 0.0, Some("Etc/GMT+5"))
            .unwrap()
            .contains("timezone=Etc%2FGMT%2B5"));
        // The southern hemisphere and the antimeridian are plain numbers.
        let u = weather_url(-0.001, 180.0, None).unwrap();
        assert!(u.contains("/0.00/-180.00?"), "{u}");
    }

    #[test]
    fn only_an_outage_counts_against_the_breaker() {
        use Outcome::*;
        assert_eq!(classify(Some(200), true), Ok);
        assert_eq!(
            classify(Some(200), false),
            Outage,
            "a body that will not parse"
        );
        for s in [500, 502, 503, 504] {
            assert_eq!(classify(Some(s), false), Outage, "{s}");
        }
        assert_eq!(classify(Some(429), false), Outage);
        assert_eq!(classify(None, false), Outage, "timeout or transport");
        assert_eq!(classify(Some(401), false), Unauthorized);
        assert_eq!(classify(Some(403), false), Unauthorized);
        for s in [400, 404, 405, 410, 422] {
            assert_eq!(classify(Some(s), false), Rejected, "{s}");
        }
        // Redirects and 1xx are not a usable answer.
        assert_eq!(classify(Some(302), false), Outage);
        for (o, counts) in [
            (Ok, false),
            (Unauthorized, false),
            (Rejected, false),
            (Outage, true),
        ] {
            assert_eq!(o.counts_against_breaker(), counts, "{o:?}");
        }
    }

    #[test]
    fn the_breaker_is_the_default_one() {
        use crate::breaker::{self, Breaker, State};
        let c = breaker::APPLE_WEATHERKIT;
        assert_eq!(
            (c.failure_threshold, c.cooldown_ms, c.window_ms),
            (3, 120_000, 300_000)
        );
        let mut b = Breaker::new(c);
        for _ in 0..3 {
            b.record_failure(1_000);
        }
        assert!(!b.allow(2_000));
        assert_eq!(b.state(1_000 + 120_000), State::HalfOpen);
    }

    #[test]
    fn every_reason_is_distinct_and_a_grant_is_not_one() {
        let all = [
            Unavailable::NotConfigured,
            Unavailable::BudgetExhausted,
            Unavailable::BudgetUnavailable,
            Unavailable::CircuitOpen,
            Unavailable::UpstreamError,
            Unavailable::AuthFailed,
            Unavailable::NoData,
        ];
        let reasons: std::collections::BTreeSet<_> = all.iter().map(|u| u.reason()).collect();
        assert_eq!(reasons.len(), all.len());
        assert_eq!(Unavailable::NotConfigured.reason(), "not_configured");
        let from = Unavailable::from_budget;
        assert_eq!(from(budget::Decision::Grant), None);
        assert_eq!(
            from(budget::Decision::Unreadable),
            Some(Unavailable::BudgetUnavailable)
        );
        for d in [
            budget::Decision::MonthFull,
            budget::Decision::DayFull,
            budget::Decision::HourFull,
            budget::Decision::ClientHourFull,
        ] {
            assert_eq!(from(d), Some(Unavailable::BudgetExhausted), "{d:?}");
        }
    }

    #[test]
    fn the_attribution_names_apple_links_the_legal_page_and_says_when_modified() {
        let plain = attribution(false);
        assert_eq!(plain["name"], "Apple Weather");
        assert_eq!(plain["trademark"], "Weather");
        assert_eq!(
            plain["url"],
            "https://developer.apple.com/weatherkit/data-source-attribution/"
        );
        assert_eq!(plain["modified"], false);
        assert!(plain.get("notice").is_none());
        let modified = attribution(true);
        assert_eq!(modified["modified"], true);
        assert_eq!(
            modified["notice"],
            "Data provided by Apple has been modified."
        );
    }

    #[test]
    fn the_baseline_marker_says_whose_forecast_it_is_and_what_filled_it() {
        let b = baseline_marker();
        assert_eq!(b["provider"], "apple-weatherkit");
        assert_eq!(b["blend"], false);
        assert_eq!(b["model"], "apple_weatherkit");
        assert_eq!(b["filledFrom"], "open-meteo:best_match");
        // A baseline is value-added (filled, derived): the notice is required.
        assert_eq!(b["attribution"]["modified"], true);
    }

    #[test]
    fn the_secret_names_are_this_apps_own_and_four() {
        assert_eq!(SECRETS.len(), 4);
        for s in SECRETS {
            assert!(s.starts_with("MUKOKO_WEATHER_WEATHERKIT_"), "{s}");
        }
        let unique: std::collections::BTreeSet<_> = SECRETS.iter().collect();
        assert_eq!(unique.len(), 4);
    }
}
