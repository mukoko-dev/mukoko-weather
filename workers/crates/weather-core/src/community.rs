//! Community weather reports and device preference profiles: the rules of
//! `api/py/_reports.py` and `api/py/_devices.py`, as pure functions.
//!
//! Both live in MongoDB (`weather.weather_reports`, `device.device_profiles`),
//! reached by the Workers through the TypeScript `mukoko-weather-mongo-bridge`
//! Worker (`workers/mongo-bridge`, which applies the same rules again before it
//! writes). The vectors in
//! `tests/fixtures/community-contract.json` are read by this module's tests
//! and by `tests/py/test_community_contract.py`, so the two backends cannot
//! drift apart while the Python still exists.

use serde::{Deserialize, Serialize};

use crate::budget::Decision;
use crate::slug::valid_slug;

pub const REPORT_TYPES: [&str; 13] = [
    "light-rain",
    "heavy-rain",
    "thunderstorm",
    "hail",
    "flooding",
    "strong-wind",
    "clear-skies",
    "cloudy",
    "fog",
    "mist",
    "haze",
    "dust",
    "frost",
];

pub const MAX_DESCRIPTION: usize = 300;
/// Submissions per client per hour.
pub const SUBMIT_PER_HOUR: u32 = 5;
/// Clarification requests per client per hour.
pub const CLARIFY_PER_HOUR: u32 = 10;
/// New device profiles per client per hour (an existing id is idempotent).
pub const DEVICE_CREATE_PER_HOUR: u32 = 20;
/// The list never returns more than this many reports.
pub const LIST_LIMIT: usize = 20;

pub fn valid_report_type(t: &str) -> bool {
    REPORT_TYPES.contains(&t)
}

/// A severity outside the three levels is `moderate`, as in the Python.
pub fn severity_or_default(s: &str) -> &'static str {
    match s {
        "mild" => "mild",
        "severe" => "severe",
        _ => "moderate",
    }
}

/// How long a report lives, by severity: 24, 48 or 72 hours.
pub fn ttl_seconds(severity: &str) -> u64 {
    match severity {
        "mild" => 86_400,
        "severe" => 259_200,
        _ => 172_800,
    }
}

/// The report's description is capped at 300 characters (the client's
/// `maxLength` can be bypassed).
pub fn description_ok(d: &str) -> bool {
    d.chars().count() <= MAX_DESCRIPTION
}

/// The first 16 hex characters of the SHA-256 of an IP: the anonymous id a
/// report and an upvote are keyed by.
pub fn hash_ip(ip: &str) -> String {
    let mut h = crate::crypto::sha256_hex(ip);
    h.truncate(16);
    h
}

/// An epoch-millisecond time as RFC 3339 with milliseconds, in UTC.
pub fn iso_ms(ms: u64) -> String {
    chrono::DateTime::from_timestamp_millis(ms as i64)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// A device id a caller may supply: 1 to 64 of letters, digits, `-` and `_`.
pub fn valid_device_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The cell a coordinate spot's data is stored under: `geo:<7-char geohash>`,
/// so the spellable name half of a `{name}--{geohash}` slug never becomes a
/// storage key. `None` for anything that is not a spot slug.
pub fn spot_cell_key(slug: &str) -> Option<String> {
    crate::locations::parse_spot_slug(slug)?;
    let hash = &slug[slug.rfind("--")? + 2..];
    if hash.len() < 5 {
        return None;
    }
    Some(format!("geo:{}", &hash[..hash.len().min(7)]))
}

/// The key a report is stored under: a catalogue slug as it is, a spot by its
/// cell.
pub fn storage_slug(slug: &str, is_catalogue: bool) -> String {
    if is_catalogue {
        return slug.to_owned();
    }
    spot_cell_key(slug).unwrap_or_else(|| slug.to_owned())
}

/// Every key a list should read for a slug: the slug itself and its cell.
pub fn read_keys(slug: &str) -> Vec<String> {
    let mut keys = vec![slug.to_owned()];
    keys.extend(spot_cell_key(slug));
    keys
}

/// Current conditions at the place when a report was filed.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub temperature: Option<f64>,
    pub weather_code: Option<i64>,
    pub precipitation: Option<f64>,
    pub wind_speed: Option<f64>,
    pub humidity: Option<f64>,
}

impl Snapshot {
    /// From a forecast Worker KV entry (`weather_core::geo::forecast_cache_key`):
    /// `{data: WeatherData, source, provider, ...}`. `None` for anything else.
    pub fn from_forecast_cache(entry: &serde_json::Value) -> Option<Snapshot> {
        Snapshot::from_current(entry.get("data")?.get("current")?)
    }

    /// From the `current` block of a `WeatherData` document.
    pub fn from_current(current: &serde_json::Value) -> Option<Snapshot> {
        let obj = current.as_object().filter(|o| !o.is_empty())?;
        let num = |k: &str| obj.get(k).and_then(|v| v.as_f64());
        Some(Snapshot {
            temperature: num("temperature_2m"),
            weather_code: obj.get("weather_code").and_then(|v| v.as_i64()),
            precipitation: num("precipitation"),
            wind_speed: num("wind_speed_10m"),
            humidity: num("relative_humidity_2m"),
        })
    }
}

/// Does the weather data back up what the person reported? With no snapshot
/// nothing can be confirmed. Missing numbers read as the Python's defaults
/// (0 for rain, wind and code; 20 degrees for temperature).
pub fn cross_validate(report_type: &str, snapshot: Option<&Snapshot>) -> bool {
    let Some(s) = snapshot else { return false };
    let precip = s.precipitation.unwrap_or(0.0);
    let wind = s.wind_speed.unwrap_or(0.0);
    let code = s.weather_code.unwrap_or(0);
    let temp = s.temperature.unwrap_or(20.0);
    match report_type {
        "light-rain" | "heavy-rain" => precip > 0.0 || (51..83).contains(&code),
        "thunderstorm" => matches!(code, 95 | 96 | 99),
        "strong-wind" => wind > 20.0,
        "clear-skies" => matches!(code, 0 | 1) && precip == 0.0,
        "cloudy" => matches!(code, 2 | 3),
        "fog" | "mist" | "haze" => matches!(code, 45 | 48),
        "frost" => temp <= 3.0,
        _ => false,
    }
}

/// Two short questions per report type, used when the model is unavailable.
pub fn fallback_questions(report_type: &str) -> [&'static str; 2] {
    match report_type {
        "light-rain" => [
            "Is it a drizzle or steady light rain?",
            "Can you see across the street clearly?",
        ],
        "heavy-rain" => [
            "Can you hear the rain hitting the roof loudly?",
            "Is water pooling on the ground?",
        ],
        "thunderstorm" => [
            "How close are the lightning flashes?",
            "Is there hail or just rain?",
        ],
        "hail" => [
            "How large are the hailstones \u{2014} pea, marble, or larger?",
            "Is the hail causing damage?",
        ],
        "flooding" => [
            "How deep is the water on the road?",
            "Are vehicles able to pass?",
        ],
        "strong-wind" => [
            "Are tree branches bending or breaking?",
            "Is it hard to walk against the wind?",
        ],
        "clear-skies" => ["Is the sun fully visible?", "Are there any clouds at all?"],
        "cloudy" => [
            "Is it fully overcast or partly cloudy?",
            "Any sign of rain coming?",
        ],
        "fog" => [
            "How far can you see ahead?",
            "Is the fog getting thicker or thinner?",
        ],
        "mist" => [
            "How far can you see ahead?",
            "Is it affecting your visibility while driving?",
        ],
        "haze" => [
            "Does the air look dusty, smoky, or just hazy?",
            "How far can you see ahead?",
        ],
        "dust" => ["Can you taste the dust in the air?", "How far can you see?"],
        "frost" => [
            "Is the frost visible on surfaces?",
            "Are your car windows frosted over?",
        ],
        _ => [
            "How severe would you rate it?",
            "Is it affecting your plans?",
        ],
    }
}

/// The system prompt used when no stored prompt exists.
pub const CLARIFY_PROMPT: &str = "You are helping a user submit a weather report for {locationName}. They selected: {reportType}.\n\nAsk 1-2 brief follow-up questions to clarify the severity and specifics of what they're experiencing. Use simple, conversational language.\n\nRules:\n- Ask maximum 2 questions\n- Use simple language accessible to all literacy levels\n- Never use emoji\n- Format as a numbered list\n- Keep questions under 15 words each";

pub fn clarify_prompt(location_name: &str, report_type: &str) -> String {
    CLARIFY_PROMPT
        .replace("{locationName}", location_name)
        .replace("{reportType}", report_type)
}

/// The numbered lines of a model answer, at most two, numbering stripped.
pub fn parse_questions(text: &str) -> Vec<String> {
    text.trim()
        .lines()
        .map(str::trim)
        .filter(|l| l.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .map(|l| {
            l.trim_start_matches(|c: char| c.is_ascii_digit() || c == '.')
                .trim()
                .to_owned()
        })
        .filter(|q| !q.is_empty())
        .take(2)
        .collect()
}

// ---------------------------------------------------------------------------
// Submitting, listing and upvoting a report (`POST /reports`, `GET /reports`,
// `POST /reports/upvote`)
// ---------------------------------------------------------------------------

/// The longest place name the store keeps (the bridge refuses more).
pub const MAX_LOCATION_NAME: usize = 120;
/// Reports are listed for at most this many hours back.
pub const MAX_LIST_HOURS: i64 = 72;

/// The body of `POST /reports`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SubmitRequest {
    pub location_slug: String,
    pub report_type: String,
    pub severity: Option<String>,
    pub description: Option<String>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
}

/// The body of `POST /reports/upvote`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UpvoteRequest {
    pub report_id: String,
}

/// A report id is a MongoDB ObjectId: 24 hexadecimal characters.
pub fn valid_report_id(id: &str) -> bool {
    id.len() == 24 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The report types, sorted, as the Python names them in its refusal.
fn sorted_report_types() -> String {
    let mut types = REPORT_TYPES;
    types.sort_unstable();
    types.join(", ")
}

/// What can be refused before any place is looked up, with the `400` detail
/// the Python gave (description first, then the type). The coordinates are
/// ours: a given latitude or longitude must be on the globe.
pub fn check_submit(req: &SubmitRequest) -> Result<(), String> {
    if let Some(d) = &req.description {
        if !description_ok(d) {
            return Err(format!(
                "Description too long (max {MAX_DESCRIPTION} characters)"
            ));
        }
    }
    if !valid_report_type(&req.report_type) {
        return Err(format!(
            "Invalid report type. Must be one of: {}",
            sorted_report_types()
        ));
    }
    let in_range = |v: Option<f64>, max: f64| v.is_none_or(|v| v.is_finite() && v.abs() <= max);
    if !in_range(req.lat, 90.0) || !in_range(req.lon, 180.0) {
        return Err("Invalid coordinates".into());
    }
    Ok(())
}

/// The place a report is about.
#[derive(Debug, Clone, Copy)]
pub struct ReportPlace<'a> {
    pub name: &'a str,
    pub lat: f64,
    pub lon: f64,
    /// The key the report is stored under ([`storage_slug`]).
    pub storage_key: &'a str,
}

/// A validated report, ready for the bridge.
#[derive(Debug, Clone, PartialEq)]
pub struct Submission {
    /// The bridge's `POST /reports` body. It adds the times, the zero votes
    /// and the empty voter list itself.
    pub body: serde_json::Value,
    pub verified: bool,
    pub ttl_seconds: u64,
}

/// Build the report the Python `submit_report` stored. A severity outside the
/// three levels is `moderate`; the weather snapshot is `{}` when no forecast
/// was at hand; `verified` is the cross-validation of the type against it.
pub fn build_report(
    req: &SubmitRequest,
    place: ReportPlace<'_>,
    snapshot: Option<&Snapshot>,
    reported_by: &str,
) -> Submission {
    let severity = severity_or_default(req.severity.as_deref().unwrap_or(""));
    let verified = cross_validate(&req.report_type, snapshot);
    let name: String = place.name.chars().take(MAX_LOCATION_NAME).collect();
    let body = serde_json::json!({
        "locationSlug": place.storage_key,
        "locationName": name,
        "lat": req.lat.unwrap_or(place.lat),
        "lon": req.lon.unwrap_or(place.lon),
        "reportType": req.report_type,
        "severity": severity,
        "description": req.description.as_deref().unwrap_or(""),
        "weatherSnapshot": snapshot
            .map_or_else(|| serde_json::json!({}), |s| serde_json::json!(s)),
        "reportedBy": reported_by,
        "verified": verified,
    });
    Submission {
        body,
        verified,
        ttl_seconds: ttl_seconds(severity),
    }
}

/// `hours` of a list request, clamped to 1..=72.
pub fn clamp_hours(hours: i64) -> i64 {
    hours.clamp(1, MAX_LIST_HOURS)
}

/// The `hours` query value: 24 when absent or empty, clamped when a whole
/// number, the `422` detail otherwise.
pub fn list_hours(raw: Option<&str>) -> Result<i64, String> {
    match raw.map(str::trim).filter(|v| !v.is_empty()) {
        None => Ok(24),
        Some(v) => v
            .parse::<i64>()
            .map(clamp_hours)
            .map_err(|_| "`hours` must be an integer.".to_owned()),
    }
}

/// A place's data is stored under its own slug only when a record backs it:
/// the seed list, the Nyuchi API, or a community place from `placesGeo`. A
/// `{name}--{geohash}` spot (source `geocoded` or `geolocation`) is a
/// coordinate, stored by its cell ([`storage_slug`]).
pub fn is_catalogue(source: &str) -> bool {
    matches!(source, "seed" | "places" | "community")
}

/// The bridge's path for listing a slug's reports: the slug and, for a spot,
/// its cell ([`read_keys`]), newest first, at most [`LIST_LIMIT`].
pub fn bridge_list_path(location: &str, hours: i64) -> String {
    let mut path = format!("/reports?hours={hours}&limit={LIST_LIMIT}");
    for key in read_keys(location) {
        path.push_str("&slug=");
        path.push_str(&key);
    }
    path
}

/// The list answer: the bridge's `reports` (an empty list when it sent none)
/// and the slug that was asked about, as the Python answered.
pub fn list_body(bridge: &serde_json::Value, location: &str) -> serde_json::Value {
    serde_json::json!({
        "reports": bridge.get("reports").cloned().unwrap_or_else(|| serde_json::json!([])),
        "location": location,
    })
}

/// What a write limited per client and per hour says when it was not taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Limited {
    Reports,
    Devices,
}

/// A refused write: the HTTP status, the error code and the description.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Refusal {
    pub status: u16,
    pub code: &'static str,
    pub description: &'static str,
}

/// The answer to a refused spend (`None` when it was granted). The client's
/// own hour is a `429`. The service's hour is a `503`, and so is a budget the
/// database could not read or write: `budget::take_units` reports that as
/// [`Decision::GlobalLimit`], so the write fails CLOSED and a database outage
/// never lifts a limit.
pub fn limit_refusal(decision: Decision, what: Limited) -> Option<Refusal> {
    match (decision, what) {
        (Decision::Allow, _) => None,
        (Decision::ClientLimit, Limited::Reports) => Some(Refusal {
            status: 429,
            code: "rate_limited",
            description: "Too many reports. Try again later.",
        }),
        (Decision::ClientLimit, Limited::Devices) => Some(Refusal {
            status: 429,
            code: "rate_limited",
            description: "Too many device profiles created. Try again later.",
        }),
        (Decision::GlobalLimit, Limited::Reports) => Some(Refusal {
            status: 503,
            code: "unavailable",
            description: "Community reports are unavailable.",
        }),
        (Decision::GlobalLimit, Limited::Devices) => Some(Refusal {
            status: 503,
            code: "unavailable",
            description: "Device sync is unavailable.",
        }),
    }
}

// ---------------------------------------------------------------------------
// Device profiles
// ---------------------------------------------------------------------------

pub const MAX_ACTIVITIES: usize = 30;
pub const MAX_SAVED_LOCATIONS: usize = 10;

/// Every forecast model id a device may store (the blend members, the map's
/// picker, Apple Weather, and the legacy ids older devices still carry).
///
/// `apple_weatherkit` is accepted before anything serves it: a device on a newer
/// client may store it, and refusing it would fail every preference sync for
/// that device with a 400. Whether a person is OFFERED it is the app's feature
/// flag (`apple_weatherkit`), not this list.
pub const FORECAST_MODELS: [&str; 12] = [
    "best_match",
    "ecmwf_ifs",
    "ecmwf_ifs025",
    "ecmwf_aifs025_single",
    "gfs_seamless",
    "icon_global",
    "gem_global",
    "meteofrance_arpege_world",
    "meteofrance_seamless",
    "apple_weatherkit",
    "ecmwf_ifs04",
    "icon_seamless",
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Preferences {
    pub theme: String,
    pub selected_location: String,
    pub saved_locations: Vec<String>,
    pub selected_activities: Vec<String>,
    pub has_onboarded: bool,
    pub selected_forecast_model: String,
}

impl Default for Preferences {
    fn default() -> Self {
        Preferences {
            theme: "system".into(),
            selected_location: String::new(),
            saved_locations: vec![],
            selected_activities: vec![],
            has_onboarded: false,
            selected_forecast_model: "best_match".into(),
        }
    }
}

/// A partial update: only the fields present change (last write wins; the
/// whole array is replaced, never merged).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PreferencesPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved_locations: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_activities: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_onboarded: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_forecast_model: Option<String>,
}

/// What to do with the bridge's answer to a device or report call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeAnswer {
    /// Pass the status and body on: a success, or a rejection of the request
    /// itself (400, 404, 413, 422, which the bridge only sends for bad input
    /// or a missing record).
    Relay,
    /// The store is not answering (5xx, anything unexpected): `503`.
    Unavailable,
}

/// Classify the status the bridge answered with.
pub fn bridge_answer(status: u16) -> BridgeAnswer {
    match status {
        200..=299 | 400 | 404 | 413 | 422 => BridgeAnswer::Relay,
        _ => BridgeAnswer::Unavailable,
    }
}

fn check_theme(t: &str) -> Result<(), String> {
    if matches!(t, "light" | "dark" | "system") {
        Ok(())
    } else {
        Err(format!("Invalid theme: {t}"))
    }
}

fn check_slug(s: &str) -> Result<(), String> {
    if s.is_empty() || valid_slug(s) {
        Ok(())
    } else {
        Err(format!("Invalid location slug: {s}"))
    }
}

fn check_saved(list: &[String]) -> Result<(), String> {
    if list.len() > MAX_SAVED_LOCATIONS {
        return Err(format!(
            "Too many saved locations (max {MAX_SAVED_LOCATIONS})"
        ));
    }
    list.iter().try_for_each(|s| {
        if valid_slug(s) {
            Ok(())
        } else {
            Err(format!("Invalid location slug: {s}"))
        }
    })
}

fn check_activities(list: &[String]) -> Result<(), String> {
    if list.len() > MAX_ACTIVITIES {
        Err(format!("Too many activities (max {MAX_ACTIVITIES})"))
    } else {
        Ok(())
    }
}

fn check_model(m: &str) -> Result<(), String> {
    if FORECAST_MODELS.contains(&m) {
        Ok(())
    } else {
        Err(format!("Invalid forecast model: {m}"))
    }
}

/// `Err(detail)` is a 400 with that detail.
pub fn validate_preferences(p: &Preferences) -> Result<(), String> {
    check_theme(&p.theme)?;
    check_slug(&p.selected_location)?;
    check_saved(&p.saved_locations)?;
    check_activities(&p.selected_activities)?;
    check_model(&p.selected_forecast_model)
}

/// Apply a patch. An empty patch is `Err("No fields to update")`.
pub fn apply_patch(base: &Preferences, patch: &PreferencesPatch) -> Result<Preferences, String> {
    let mut next = base.clone();
    let mut changed = false;
    if let Some(t) = &patch.theme {
        check_theme(t)?;
        next.theme = t.clone();
        changed = true;
    }
    if let Some(s) = &patch.selected_location {
        check_slug(s)?;
        next.selected_location = s.clone();
        changed = true;
    }
    if let Some(l) = &patch.saved_locations {
        check_saved(l)?;
        next.saved_locations = l.clone();
        changed = true;
    }
    if let Some(a) = &patch.selected_activities {
        check_activities(a)?;
        next.selected_activities = a.clone();
        changed = true;
    }
    if let Some(b) = patch.has_onboarded {
        next.has_onboarded = b;
        changed = true;
    }
    if let Some(m) = &patch.selected_forecast_model {
        check_model(m)?;
        next.selected_forecast_model = m.clone();
        changed = true;
    }
    if changed {
        Ok(next)
    } else {
        Err("No fields to update".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn a_patch_serialises_only_the_fields_present() {
        let patch = PreferencesPatch {
            theme: Some("dark".into()),
            has_onboarded: Some(false),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_value(&patch).unwrap(),
            serde_json::json!({"theme": "dark", "hasOnboarded": false})
        );
        assert_eq!(
            serde_json::to_value(PreferencesPatch::default()).unwrap(),
            serde_json::json!({})
        );
    }

    #[test]
    fn the_bridge_answers_are_relayed_or_become_503() {
        for s in [200, 201, 400, 404, 413, 422] {
            assert_eq!(bridge_answer(s), BridgeAnswer::Relay, "{s}");
        }
        for s in [301, 401, 403, 429, 500, 502, 503, 504] {
            assert_eq!(bridge_answer(s), BridgeAnswer::Unavailable, "{s}");
        }
    }

    fn fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../../tests/fixtures/community-contract.json"
        ))
        .expect("fixture parses")
    }

    #[test]
    fn cross_validation_matches_the_shared_vectors() {
        for v in fixture()["crossValidate"].as_array().unwrap() {
            let snap = if v["snapshot"].is_null() {
                None
            } else {
                Some(Snapshot {
                    temperature: v["snapshot"]["temperature"].as_f64(),
                    weather_code: v["snapshot"]["weatherCode"].as_i64(),
                    precipitation: v["snapshot"]["precipitation"].as_f64(),
                    wind_speed: v["snapshot"]["windSpeed"].as_f64(),
                    humidity: v["snapshot"]["humidity"].as_f64(),
                })
            };
            let got = cross_validate(v["type"].as_str().unwrap(), snap.as_ref());
            assert_eq!(got, v["verified"].as_bool().unwrap(), "{v}");
        }
    }

    #[test]
    fn fallback_questions_match_the_shared_vectors() {
        let f = fixture();
        for (t, qs) in f["fallbackQuestions"].as_object().unwrap() {
            let got = fallback_questions(t);
            assert_eq!(got[0], qs[0].as_str().unwrap(), "{t}");
            assert_eq!(got[1], qs[1].as_str().unwrap(), "{t}");
        }
        let unknown = fallback_questions("zzz");
        assert_eq!(unknown[0], f["fallbackDefault"][0].as_str().unwrap());
        for t in REPORT_TYPES {
            assert!(f["fallbackQuestions"].get(t).is_some(), "{t} has a vector");
        }
    }

    #[test]
    fn severity_and_ttl_follow_the_python() {
        assert_eq!(severity_or_default("mild"), "mild");
        assert_eq!(severity_or_default("severe"), "severe");
        assert_eq!(severity_or_default("catastrophic"), "moderate");
        assert_eq!(ttl_seconds("mild"), 86_400);
        assert_eq!(ttl_seconds("moderate"), 172_800);
        assert_eq!(ttl_seconds("severe"), 259_200);
    }

    #[test]
    fn the_ip_hash_is_sixteen_hex_chars_and_stable() {
        let h = hash_ip("203.0.113.9");
        assert_eq!(h.len(), 16);
        assert_eq!(h, hash_ip("203.0.113.9"));
        assert_ne!(h, hash_ip("203.0.113.10"));
        let want = fixture()["ipHash"].clone();
        assert_eq!(h, want["203.0.113.9"].as_str().unwrap());
    }

    #[test]
    fn descriptions_are_capped_at_300_characters() {
        assert!(description_ok(&"a".repeat(300)));
        assert!(!description_ok(&"a".repeat(301)));
        assert!(description_ok(&"\u{e9}".repeat(300)));
    }

    #[test]
    fn model_answers_parse_to_at_most_two_numbered_questions() {
        let text = "Sure:\n1. How heavy is it?\n2) Is it flooding?\n3. Third?";
        // "2)" is not stripped by the Python either: only digits and dots.
        let got = parse_questions(text);
        assert_eq!(got, vec!["How heavy is it?", ") Is it flooding?"]);
        assert!(parse_questions("no numbers here").is_empty());
    }

    #[test]
    fn a_spot_is_stored_by_its_cell_not_its_name() {
        // Harare's cell, 7 characters.
        let spot = "west-paddock--kqwy4dd7";
        assert_eq!(spot_cell_key(spot).as_deref(), Some("geo:kqwy4dd"));
        assert_eq!(storage_slug(spot, false), "geo:kqwy4dd");
        assert_eq!(storage_slug("harare", true), "harare");
        assert_eq!(storage_slug("harare", false), "harare");
        assert_eq!(read_keys("harare"), vec!["harare"]);
        assert_eq!(read_keys(spot), vec![spot.to_owned(), "geo:kqwy4dd".into()]);
        assert_eq!(spot_cell_key("a--abc"), None, "under five characters");
    }

    #[test]
    fn every_forecast_model_a_device_can_pick_is_accepted() {
        // The blend members (the map's model picker), the My Weather radio
        // group and the legacy ids older devices still carry.
        for id in [
            "best_match",
            "ecmwf_ifs",
            "ecmwf_aifs025_single",
            "gfs_seamless",
            "icon_global",
            "gem_global",
            "meteofrance_arpege_world",
            "ecmwf_ifs025",
            "meteofrance_seamless",
            "apple_weatherkit",
            "ecmwf_ifs04",
            "icon_seamless",
        ] {
            assert!(FORECAST_MODELS.contains(&id), "{id}");
        }
        assert!(!FORECAST_MODELS.contains(&"gpt"));
    }

    #[test]
    fn device_ids_and_times() {
        assert!(valid_device_id("3f2a-9c_1"));
        assert!(!valid_device_id(""));
        assert!(!valid_device_id("a b"));
        assert!(!valid_device_id(&"a".repeat(65)));
        assert_eq!(iso_ms(1_760_000_000_123), "2025-10-09T08:53:20.123Z");
    }

    #[test]
    fn slugs_follow_the_shared_rule() {
        for (s, ok) in [
            ("harare", true),
            ("a-b-9", true),
            ("", false),
            ("Harare", false),
            ("a_b", false),
        ] {
            assert_eq!(valid_slug(s), ok, "{s}");
        }
        assert!(!valid_slug(&"a".repeat(81)));
        assert!(valid_slug(&"a".repeat(80)));
    }

    #[test]
    fn preference_validation_matches_the_shared_vectors() {
        for v in fixture()["preferences"].as_array().unwrap() {
            let p: Preferences = serde_json::from_value(v["input"].clone()).unwrap();
            let got = validate_preferences(&p);
            match v["error"].as_str() {
                None => assert!(got.is_ok(), "{v}"),
                Some(e) => assert_eq!(got.unwrap_err(), e, "{v}"),
            }
        }
    }

    #[test]
    fn patches_replace_arrays_and_refuse_empty_updates() {
        let base = Preferences {
            saved_locations: vec!["harare".into()],
            ..Preferences::default()
        };
        let patch = PreferencesPatch {
            saved_locations: Some(vec!["bulawayo".into()]),
            theme: Some("dark".into()),
            ..PreferencesPatch::default()
        };
        let next = apply_patch(&base, &patch).unwrap();
        assert_eq!(next.saved_locations, vec!["bulawayo"]);
        assert_eq!(next.theme, "dark");
        assert_eq!(
            apply_patch(&base, &PreferencesPatch::default()).unwrap_err(),
            "No fields to update"
        );
        let bad = PreferencesPatch {
            theme: Some("neon".into()),
            ..PreferencesPatch::default()
        };
        assert_eq!(apply_patch(&base, &bad).unwrap_err(), "Invalid theme: neon");
    }

    /// What the real Python `submit_report` built for each request
    /// (`tests/fixtures/report-submit.json`, generated by running it).
    fn report_fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../../tests/fixtures/report-submit.json"
        ))
        .expect("fixture parses")
    }

    /// JSON equality with numbers compared by value: the Python wrote `25`
    /// where this writes `25.0`, and the bridge reads both the same.
    fn same(a: &Value, b: &Value) -> bool {
        match (a, b) {
            (Value::Number(x), Value::Number(y)) => {
                (x.as_f64().unwrap() - y.as_f64().unwrap()).abs() < 1e-9
            }
            (Value::Object(x), Value::Object(y)) => {
                x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
            }
            (Value::Array(x), Value::Array(y)) => {
                x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q))
            }
            _ => a == b,
        }
    }

    #[test]
    fn a_submission_is_what_the_python_stored() {
        let f = report_fixture();
        // The oracle names the pinned git commit it was generated from.
        let commit = f["_generated"]["commit"].as_str().unwrap();
        assert!(
            commit.len() == 40 && commit.bytes().all(|b| b.is_ascii_hexdigit()),
            "the fixture records the commit it was generated from"
        );
        let ip = f["ip"].as_str().unwrap();
        let mut built = 0;
        for case in f["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let req: SubmitRequest = serde_json::from_value(case["request"].clone()).unwrap();
            let expected = &case["expected"];

            // Refused before any place is looked up (a 400).
            if let Err(detail) = check_submit(&req) {
                assert_eq!(expected["error"]["status"], 400, "{name}");
                assert_eq!(expected["error"]["detail"], detail.as_str(), "{name}");
                continue;
            }
            // An unknown place is refused after the lookup (a 404).
            let loc = &case["location"];
            if loc.is_null() {
                assert_eq!(expected["error"]["status"], 404, "{name}");
                assert_eq!(expected["error"]["detail"], "Unknown location", "{name}");
                continue;
            }

            let is_catalogue = !loc["_id"].as_str().is_some_and(|id| id.starts_with("geo:"));
            let key = storage_slug(&req.location_slug, is_catalogue);
            let place = ReportPlace {
                name: loc["name"].as_str().unwrap(),
                lat: loc["lat"].as_f64().unwrap(),
                lon: loc["lon"].as_f64().unwrap(),
                storage_key: &key,
            };
            let snapshot = Snapshot::from_current(&case["current"]);
            let got = build_report(&req, place, snapshot.as_ref(), &hash_ip(ip));

            let want = &expected["doc"];
            assert!(
                same(&got.body, want),
                "{name}\n got {}\nwant {want}",
                got.body
            );
            assert_eq!(got.ttl_seconds, expected["ttl"].as_u64().unwrap(), "{name}");
            assert_eq!(
                got.verified,
                expected["verified"].as_bool().unwrap(),
                "{name}"
            );
            built += 1;
        }
        assert!(built >= 8, "the fixture exercises the builder ({built})");
    }

    #[test]
    fn submissions_are_refused_for_a_bad_description_type_or_coordinate() {
        let ok = SubmitRequest {
            location_slug: "harare".into(),
            report_type: "fog".into(),
            ..SubmitRequest::default()
        };
        assert!(check_submit(&ok).is_ok());
        let with = |f: &dyn Fn(&mut SubmitRequest)| {
            let mut r = ok.clone();
            f(&mut r);
            check_submit(&r)
        };
        assert_eq!(
            with(&|r| r.report_type = "tornado".into()).unwrap_err(),
            "Invalid report type. Must be one of: clear-skies, cloudy, dust, flooding, fog, \
             frost, hail, haze, heavy-rain, light-rain, mist, strong-wind, thunderstorm"
        );
        assert_eq!(
            with(&|r| r.description = Some("x".repeat(301))).unwrap_err(),
            "Description too long (max 300 characters)"
        );
        assert!(with(&|r| r.description = Some("x".repeat(300))).is_ok());
        // The description is checked before the type, as the Python did.
        assert!(with(&|r| {
            r.description = Some("x".repeat(301));
            r.report_type = "tornado".into();
        })
        .unwrap_err()
        .starts_with("Description"));
        // A coordinate must be on the globe (0 is a real latitude).
        assert!(with(&|r| {
            r.lat = Some(0.0);
            r.lon = Some(0.0);
        })
        .is_ok());
        for (lat, lon) in [
            (91.0, 0.0),
            (0.0, -180.5),
            (f64::NAN, 1.0),
            (1.0, f64::INFINITY),
        ] {
            assert_eq!(
                with(&|r| {
                    r.lat = Some(lat);
                    r.lon = Some(lon);
                })
                .unwrap_err(),
                "Invalid coordinates",
                "{lat},{lon}"
            );
        }
    }

    #[test]
    fn a_long_place_name_is_cut_to_what_the_store_keeps() {
        let req = SubmitRequest {
            location_slug: "x".into(),
            report_type: "fog".into(),
            ..SubmitRequest::default()
        };
        let name = "\u{e9}".repeat(200);
        let place = ReportPlace {
            name: &name,
            lat: 1.0,
            lon: 2.0,
            storage_key: "x",
        };
        let sub = build_report(&req, place, None, "0123456789abcdef");
        assert_eq!(
            sub.body["locationName"].as_str().unwrap().chars().count(),
            MAX_LOCATION_NAME
        );
        assert_eq!(sub.body["weatherSnapshot"], serde_json::json!({}));
        assert!(!sub.verified, "nothing to confirm it against");
    }

    #[test]
    fn the_hours_query_defaults_clamps_and_refuses() {
        assert_eq!(list_hours(None), Ok(24));
        assert_eq!(list_hours(Some("")), Ok(24));
        assert_eq!(list_hours(Some("  ")), Ok(24));
        assert_eq!(list_hours(Some("6")), Ok(6));
        assert_eq!(list_hours(Some("0")), Ok(1));
        assert_eq!(list_hours(Some("-5")), Ok(1));
        assert_eq!(list_hours(Some("100")), Ok(72));
        assert_eq!(
            list_hours(Some("abc")),
            Err("`hours` must be an integer.".to_owned())
        );
        assert!(list_hours(Some("1.5")).is_err());
    }

    #[test]
    fn a_places_data_is_kept_under_its_slug_only_when_a_record_backs_it() {
        // Every source a LocationDoc can carry. The three with a record keep
        // their slug; a spot (named by a geocoder or a GPS fix) is a cell.
        for source in ["seed", "places", "community"] {
            assert!(is_catalogue(source), "{source}");
            assert_eq!(storage_slug("harare", is_catalogue(source)), "harare");
        }
        for source in ["geocoded", "geolocation", "", "Seed"] {
            assert!(!is_catalogue(source), "{source}");
        }
        let spot = "west-paddock--kqwy4dd7";
        assert_eq!(
            storage_slug(spot, is_catalogue("geolocation")),
            "geo:kqwy4dd"
        );
        // A community place with a spot-shaped slug is still its own record.
        assert_eq!(storage_slug(spot, is_catalogue("community")), spot);
    }

    #[test]
    fn the_bridge_list_path_names_the_slug_and_a_spots_cell() {
        assert_eq!(
            bridge_list_path("harare", 24),
            "/reports?hours=24&limit=20&slug=harare"
        );
        assert_eq!(
            bridge_list_path("west-paddock--kqwy4dd7", 6),
            "/reports?hours=6&limit=20&slug=west-paddock--kqwy4dd7&slug=geo:kqwy4dd"
        );
    }

    #[test]
    fn the_list_answer_echoes_the_slug_and_defaults_to_no_reports() {
        let body = serde_json::json!({"reports": [{"id": "x"}]});
        assert_eq!(
            list_body(&body, "harare"),
            serde_json::json!({"reports": [{"id": "x"}], "location": "harare"})
        );
        assert_eq!(
            list_body(&serde_json::json!({}), "harare"),
            serde_json::json!({"reports": [], "location": "harare"})
        );
    }

    #[test]
    fn a_limited_write_is_a_429_for_the_client_and_a_503_for_the_service_or_a_blind_budget() {
        for what in [Limited::Reports, Limited::Devices] {
            assert_eq!(limit_refusal(Decision::Allow, what), None);
            let client = limit_refusal(Decision::ClientLimit, what).unwrap();
            assert_eq!((client.status, client.code), (429, "rate_limited"));
            // `take_units` answers GlobalLimit for a D1 failure too: closed.
            let service = limit_refusal(Decision::GlobalLimit, what).unwrap();
            assert_eq!((service.status, service.code), (503, "unavailable"));
            assert_ne!(client.description, service.description);
        }
        assert_eq!(
            limit_refusal(Decision::GlobalLimit, Limited::Devices)
                .unwrap()
                .description,
            "Device sync is unavailable."
        );
    }

    #[test]
    fn a_forecast_cache_entry_gives_the_snapshot_of_its_current_block() {
        let entry = serde_json::json!({
            "data": {"current": {
                "temperature_2m": 21.5, "weather_code": 61, "precipitation": 0.4,
                "wind_speed_10m": 9.0, "relative_humidity_2m": 55.0
            }},
            "source": "open_meteo", "provider": "open-meteo:blend"
        });
        let s = Snapshot::from_forecast_cache(&entry).unwrap();
        assert_eq!(s.weather_code, Some(61));
        assert_eq!(s.temperature, Some(21.5));
        for bad in [
            serde_json::json!({}),
            serde_json::json!({"data": {}}),
            serde_json::json!({"data": {"current": {}}}),
            serde_json::Value::Null,
        ] {
            assert!(Snapshot::from_forecast_cache(&bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn report_ids_are_object_ids_and_hours_are_clamped() {
        assert!(valid_report_id("507f1f77bcf86cd799439011"));
        assert!(valid_report_id("507F1F77BCF86CD799439011"));
        for bad in [
            "",
            "507f1f77bcf86cd79943901",
            "507f1f77bcf86cd7994390112",
            "zzzzzzzzzzzzzzzzzzzzzzzz",
        ] {
            assert!(!valid_report_id(bad), "{bad}");
        }
        assert_eq!(clamp_hours(-5), 1);
        assert_eq!(clamp_hours(24), 24);
        assert_eq!(clamp_hours(100), 72);
    }

    #[test]
    fn a_snapshot_reads_the_current_block() {
        let cur = serde_json::json!({
            "temperature_2m": 21.5, "weather_code": 3, "precipitation": 0.0,
            "wind_speed_10m": 9.0, "relative_humidity_2m": 55.0
        });
        let s = Snapshot::from_current(&cur).unwrap();
        assert_eq!(s.weather_code, Some(3));
        assert_eq!(s.temperature, Some(21.5));
        assert!(Snapshot::from_current(&serde_json::json!({})).is_none());
        assert!(Snapshot::from_current(&Value::Null).is_none());
    }
}
