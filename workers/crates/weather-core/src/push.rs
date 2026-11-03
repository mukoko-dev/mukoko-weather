//! Web Push alerts: the pure rules (mukoko-dev/mukoko-weather#289).
//!
//! Nothing here touches the network, a clock or a binding, so it tests
//! natively. The Nyuchi API stores subscriptions and preferences; the jobs
//! Worker evaluates the rules. This module (and this PR) cannot send anything.
//! Delivery is best effort: a push service may drop, delay or never deliver
//! a message, so nothing in this module (or the copy it produces) promises
//! delivery. The in-app inbox is the record.

use serde::{Deserialize, Serialize};

/// Push services we accept subscriptions from. An endpoint is a URL the
/// server will POST to, so an open list would make the sender an SSRF tool.
const ALLOWED_HOSTS: &[&str] = &[
    "fcm.googleapis.com",
    "updates.push.services.mozilla.com",
    "web.push.apple.com",
];
/// Allowed host suffixes (a leading dot is part of the match).
const ALLOWED_SUFFIXES: &[&str] = &[
    ".push.apple.com",
    ".push.services.mozilla.com",
    ".notify.windows.com",
];

/// The alert kind of a frost alert: in the dedupe key, the delivery log, the
/// payload and the push `Topic`.
pub const KIND_FROST: &str = "frost";

/// At most this many pushes to one person in one local day.
pub const MAX_PUSHES_PER_DAY: u32 = 2;
/// At most this many of one kind to one person in one local night.
pub const MAX_PUSHES_PER_KIND_PER_NIGHT: u32 = 1;
/// Frost looks at the next 24 hourly values.
pub const FROST_LOOKAHEAD_HOURS: usize = 24;
/// An hour at or below this air temperature (C) inside the frost window is a
/// frost hour. Shared with the station join (`station_alert`), so a forecast
/// and an observation can never disagree about what frost is.
pub const FROST_THRESHOLD_C: f64 = 3.0;
/// Local hour at which the frost window opens (22:00).
pub const NIGHT_START_HOUR: u8 = 22;
/// Delivery log rows older than this many days are deleted.
pub const DELIVERY_RETENTION_DAYS: u32 = 90;
/// A person may hold this many active subscriptions (browsers or devices).
pub const MAX_SUBSCRIPTIONS_PER_PERSON: usize = 5;
/// A person may follow alerts for this many places.
pub const MAX_PLACES_PER_PERSON: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushError {
    NotHttps,
    HostNotAllowed,
    BadEndpoint,
    BadKey,
    BadQuietHours,
    BadSlug,
    TooManyPlaces,
}

impl PushError {
    pub fn code(self) -> &'static str {
        match self {
            PushError::NotHttps => "endpoint_not_https",
            PushError::HostNotAllowed => "endpoint_host_not_allowed",
            PushError::BadEndpoint => "endpoint_invalid",
            PushError::BadKey => "subscription_key_invalid",
            PushError::BadQuietHours => "quiet_hours_invalid",
            PushError::BadSlug => "place_invalid",
            PushError::TooManyPlaces => "too_many_places",
        }
    }
}

/// The host of an `https://` URL, lower-cased, without port or path.
fn https_host(endpoint: &str) -> Result<String, PushError> {
    let rest = endpoint
        .strip_prefix("https://")
        .ok_or(PushError::NotHttps)?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') || endpoint.len() > 1024 {
        return Err(PushError::BadEndpoint);
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (authority, None),
    };
    if let Some(p) = port {
        if p != "443" {
            return Err(PushError::BadEndpoint);
        }
    }
    let host = host.to_ascii_lowercase();
    if host.is_empty()
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return Err(PushError::BadEndpoint);
    }
    Ok(host)
}

/// Accept only https endpoints on a known push service.
pub fn validate_endpoint(endpoint: &str) -> Result<(), PushError> {
    let host = https_host(endpoint)?;
    let ok = ALLOWED_HOSTS.contains(&host.as_str())
        || ALLOWED_SUFFIXES
            .iter()
            .any(|s| host.ends_with(s) && host.len() > s.len());
    if ok {
        Ok(())
    } else {
        Err(PushError::HostNotAllowed)
    }
}

/// The origin (`https://host`) of an endpoint the sender may use: the VAPID
/// `aud` claim names it (RFC 8292 section 2). The endpoint goes through
/// [`validate_endpoint`] first, so a host outside the allow list never gets a
/// token. A port is refused by that check (only the default is accepted), so
/// the origin never carries one.
pub fn endpoint_origin(endpoint: &str) -> Result<String, PushError> {
    validate_endpoint(endpoint)?;
    Ok(format!("https://{}", https_host(endpoint)?))
}

fn is_b64url(s: &str) -> bool {
    s.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// `p256dh` is an uncompressed P-256 point (65 bytes, 87 base64url chars)
/// and `auth` is 16 random bytes (22 chars). Trailing `=` padding is
/// tolerated (some clients send it) and ignored. An uncompressed point starts
/// with the byte 0x04, which in base64 is `B` followed by a character in
/// `A..=P` (the second character's top two bits are zero).
pub fn validate_keys(p256dh: &str, auth: &str) -> Result<(), PushError> {
    let p256dh = p256dh.trim_end_matches('=');
    let auth = auth.trim_end_matches('=');
    let mut chars = p256dh.chars();
    let uncompressed = chars.next() == Some('B') && matches!(chars.next(), Some('A'..='P'));
    if p256dh.len() == 87
        && auth.len() == 22
        && is_b64url(p256dh)
        && is_b64url(auth)
        && uncompressed
    {
        Ok(())
    } else {
        Err(PushError::BadKey)
    }
}

/// The stable lookup id of a subscription: SHA-256 of its endpoint, hex.
/// The endpoint is a bearer capability (anyone holding it can push to the
/// browser), so logs and API answers carry this hash, never the endpoint.
///
/// The endpoint is canonicalised first (lower-case scheme and host, default
/// port dropped) so the same subscription never hashes two ways.
pub fn endpoint_id(endpoint: &str) -> String {
    crate::crypto::sha256_hex(&canonical_endpoint(endpoint))
}

/// Lower-case the scheme and host and drop `:443`; the path and query keep
/// their case (they are part of the capability). Anything that does not parse
/// as an `https://` URL is returned unchanged.
pub fn canonical_endpoint(endpoint: &str) -> String {
    let Some(rest) = endpoint.strip_prefix("https://") else {
        return endpoint.to_string();
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    let host = authority.strip_suffix(":443").unwrap_or(authority);
    format!("https://{}{}", host.to_ascii_lowercase(), tail)
}

/// A seed or community place slug (`^[a-z0-9-]{1,80}$`, as `SLUG_RE`).
pub fn validate_slug(slug: &str) -> Result<(), PushError> {
    if (1..=80).contains(&slug.len())
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        Ok(())
    } else {
        Err(PushError::BadSlug)
    }
}

/// What a person asked to be told about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AlertPrefs {
    /// Frost alerts on or off. Off until the person turns it on.
    pub frost: bool,
    /// Quiet hours in the place's local time, `[start, end)` in whole hours
    /// 0..=23; the window may wrap midnight. Equal values mean no quiet time.
    pub quiet_start: u8,
    pub quiet_end: u8,
    /// Place slugs followed for alerts. The wire name matches the app's
    /// `AlertPreferences.place_slugs`.
    #[serde(rename = "place_slugs")]
    pub places: Vec<String>,
}

impl Default for AlertPrefs {
    fn default() -> Self {
        // Frost is the product's first alert, but it is the person's choice:
        // nothing is sent until they opt in. The default quiet window is the
        // small hours; severe frost still gets through (see `decide`).
        AlertPrefs {
            frost: false,
            quiet_start: 22,
            quiet_end: 6,
            places: Vec::new(),
        }
    }
}

impl AlertPrefs {
    pub fn validate(&self) -> Result<(), PushError> {
        if self.quiet_start > 23 || self.quiet_end > 23 {
            return Err(PushError::BadQuietHours);
        }
        if self.places.len() > MAX_PLACES_PER_PERSON {
            return Err(PushError::TooManyPlaces);
        }
        for p in &self.places {
            validate_slug(p)?;
        }
        Ok(())
    }
}

/// Whether `hour` (0..=23, the place's local hour) falls in `[start, end)`,
/// wrapping midnight when `start > end`.
pub fn in_quiet_hours(hour: u8, start: u8, end: u8) -> bool {
    if start == end {
        false
    } else if start < end {
        hour >= start && hour < end
    } else {
        hour >= start || hour < end
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    Moderate,
    High,
    Severe,
}

impl Risk {
    pub fn as_str(self) -> &'static str {
        match self {
            Risk::Moderate => "moderate",
            Risk::High => "high",
            Risk::Severe => "severe",
        }
    }
}

/// A frost night found in the forecast.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FrostAlert {
    pub risk: Risk,
    pub lowest: f64,
    /// Local wall-clock `YYYY-MM-DDTHH:MM` of the first and last frost hour.
    pub start: String,
    pub end: String,
    /// The local date the night began on; with the cell it is the dedupe key.
    pub night: String,
}

fn parse_hour(time: &str) -> Option<u8> {
    time.get(11..13)?.parse().ok().filter(|h| *h <= 23)
}

fn parse_date(time: &str) -> Option<chrono::NaiveDate> {
    chrono::NaiveDate::parse_from_str(time.get(0..10)?, "%Y-%m-%d").ok()
}

/// Whether a local hour (0..=23) is inside the frost window: 22:00 through
/// 08:59 (the hour that starts at 08:00 is included).
pub fn in_frost_window(hour: u8) -> bool {
    hour >= NIGHT_START_HOUR || hour <= NIGHT_END_HOUR
}

/// The date a frost night began on: hours 00..=08 belong to the previous
/// evening's night.
pub(crate) fn night_of(time: &str) -> Option<String> {
    let date = parse_date(time)?;
    let hour = parse_hour(time)?;
    let d = if hour <= NIGHT_END_HOUR {
        date.pred_opt()?
    } else {
        date
    };
    Some(d.format("%Y-%m-%d").to_string())
}

/// True for a provider whose numbers are not a forecast: the seasonal
/// estimate served when every provider failed (`X-Weather-Provider:
/// fallback`). Frost must never be alerted from invented data.
pub fn is_estimate_provider(provider: &str) -> bool {
    let p = provider.trim().to_ascii_lowercase();
    p.is_empty() || p.contains("fallback") || p.contains("seasonal") || p.contains("estimate")
}

/// A naive local wall-clock time, exactly `YYYY-MM-DDTHH:MM`. A zoned
/// instant (`Z`, `+02:00`) is refused: comparing it as text against a local
/// hour would put the night in the wrong place.
fn is_naive_local(t: &str) -> bool {
    t.len() == 16 && chrono::NaiveDateTime::parse_from_str(t, "%Y-%m-%dT%H:%M").is_ok()
}

/// Server-side port of the app's `checkFrostRisk`: temperatures at or below
/// 3 C between 22:00 and 08:00 local. `times` are Open-Meteo local wall-clock
/// strings (`YYYY-MM-DDTHH:MM`), `now_local` is the place's current local
/// time in the same format. Only the next [`FROST_LOOKAHEAD_HOURS`] values at
/// or after `now_local` are read, and only the FIRST night found is reported
/// so one alert covers one night.
///
/// Returns `None` (no alert) when `provider` is a fallback or seasonal
/// estimate, or when `now_local` or any time read is not a naive local
/// wall-clock string. Arrays of different lengths are read up to the shorter.
pub fn evaluate_frost(
    provider: &str,
    times: &[String],
    temps: &[f64],
    now_local: &str,
) -> Option<FrostAlert> {
    if is_estimate_provider(provider) || !is_naive_local(now_local) {
        return None;
    }
    let start_idx = times.iter().position(|t| t.as_str() >= now_local)?;
    let end_idx = (start_idx + FROST_LOOKAHEAD_HOURS)
        .min(times.len())
        .min(temps.len());
    let mut night: Option<String> = None;
    let mut hits: Vec<(&String, f64)> = Vec::new();
    for i in start_idx..end_idx {
        let (t, temp) = (&times[i], temps[i]);
        if !is_naive_local(t) {
            return None;
        }
        let Some(hour) = parse_hour(t) else { continue };
        if !in_frost_window(hour) || !temp.is_finite() || temp > FROST_THRESHOLD_C {
            continue;
        }
        let n = night_of(t)?;
        match &night {
            None => night = Some(n),
            Some(first) if *first != n => break,
            _ => {}
        }
        hits.push((t, temp));
    }
    let night = night?;
    let lowest = hits.iter().map(|h| h.1).fold(f64::INFINITY, f64::min);
    let risk = if lowest <= 0.0 {
        Risk::Severe
    } else if lowest <= 2.0 {
        Risk::High
    } else {
        Risk::Moderate
    };
    Some(FrostAlert {
        risk,
        lowest,
        start: hits.first()?.0.clone(),
        end: hits.last()?.0.clone(),
        night,
    })
}

/// The dedupe key for one alert: one per cell, kind and local night.
pub fn dedupe_key(cell: &str, kind: &str, night: &str) -> String {
    format!("{cell}:{kind}:{night}")
}

/// What to do with one alert for one person.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Send,
    /// Skip this tick; a later tick may still send (quiet hours end).
    HoldQuiet,
    /// Already sent for this night.
    Duplicate,
    /// A rate cap was reached.
    RateLimited,
    /// The person has not turned this alert on, or does not follow the place.
    NotWanted,
    /// The night this alert is about is over (the copy says "tonight"): drop
    /// it, do not hold it for later.
    Stale,
}

/// Local hour at which a frost night ends (the window is 22:00 to 08:00).
pub const NIGHT_END_HOUR: u8 = 8;

/// Everything the decision needs, gathered by the caller.
#[derive(Debug, Clone, Copy)]
pub struct DecisionInput<'a> {
    pub prefs: &'a AlertPrefs,
    pub slug: &'a str,
    pub risk: Risk,
    /// The place's current local hour.
    pub local_hour: u8,
    /// The place's current local date, `YYYY-MM-DD`.
    pub local_date: &'a str,
    /// The local date the alert's night began on (`FrostAlert::night`).
    pub night: &'a str,
    pub already_sent_this_night: bool,
    pub sent_today: u32,
    pub sent_kind_tonight: u32,
}

/// Apply preferences, staleness, dedupe, quiet hours and rate caps, in that
/// order. Severe frost (0 C or below) is a safety matter for crops and
/// bypasses quiet hours, but never the dedupe or the caps.
///
/// An alert says "tonight", so it is `Stale` once its night is over: any time
/// after 08:00 on a later local date, and, for non-severe frost, any time on
/// a later local date at all (a moderate alert held by quiet hours must not
/// arrive at 06:00 the next morning). Severe frost still under way before
/// 09:00 on the morning right after its night is sent; on any later date it is
/// stale, whatever the hour.
pub fn decide(i: &DecisionInput) -> Decision {
    if !i.prefs.frost || !i.prefs.places.iter().any(|p| p == i.slug) {
        return Decision::NotWanted;
    }
    if i.local_date > i.night {
        // Past the night's own date. The one thing still sent is severe frost
        // under way before 09:00 on the morning right after its night: not a
        // later morning, which would be about a night two days gone.
        let morning_after = chrono::NaiveDate::parse_from_str(i.night, "%Y-%m-%d")
            .ok()
            .and_then(|d| d.succ_opt())
            .is_some_and(|d| d.format("%Y-%m-%d").to_string() == i.local_date);
        if !(i.risk == Risk::Severe && morning_after && i.local_hour <= NIGHT_END_HOUR) {
            return Decision::Stale;
        }
    }
    if i.already_sent_this_night {
        return Decision::Duplicate;
    }
    if i.sent_today >= MAX_PUSHES_PER_DAY || i.sent_kind_tonight >= MAX_PUSHES_PER_KIND_PER_NIGHT {
        return Decision::RateLimited;
    }
    if i.risk != Risk::Severe
        && in_quiet_hours(i.local_hour, i.prefs.quiet_start, i.prefs.quiet_end)
    {
        return Decision::HoldQuiet;
    }
    Decision::Send
}

/// The small payload sent to the browser. It carries no personal data: a
/// place slug, the kind, a night and short generic text. The service worker
/// shows it and opens `url`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Payload {
    pub v: u8,
    pub kind: &'static str,
    pub slug: String,
    pub night: String,
    pub title: String,
    pub body: String,
    pub url: String,
}

pub fn frost_payload(place_name: &str, slug: &str, a: &FrostAlert) -> Payload {
    let lowest = a.lowest.round() as i32;
    let body = match a.risk {
        Risk::Severe => {
            format!("Severe frost expected tonight, down to {lowest}°C. Protect sensitive crops.")
        }
        _ => format!("Frost risk tonight, down to {lowest}°C. Cover sensitive plants."),
    };
    Payload {
        v: 1,
        kind: KIND_FROST,
        slug: slug.to_string(),
        night: a.night.clone(),
        title: format!("Frost alert for {place_name}"),
        body,
        url: format!("/{slug}"),
    }
}

/// The `Urgency` header of a Web Push request (RFC 8030 section 5.3). It tells
/// the push service how hard to try to wake a device that is saving power: on
/// Android a `normal` message may wait for the next maintenance window, and
/// only `high` is delivered at once.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Urgency {
    VeryLow,
    Low,
    Normal,
    High,
}

impl Urgency {
    /// The header value, exactly as RFC 8030 spells it.
    pub fn as_str(self) -> &'static str {
        match self {
            Urgency::VeryLow => "very-low",
            Urgency::Low => "low",
            Urgency::Normal => "normal",
            Urgency::High => "high",
        }
    }
}

/// The longest `TTL` we ask for: 36 hours. The forecast looks 24 hours ahead
/// ([`FROST_LOOKAHEAD_HOURS`]) and a frost night runs another 11 (22:00 to
/// 08:59), so no alert [`evaluate_frost`] can raise lives longer than this; the
/// bound only keeps a malformed night far in the future from asking a push
/// service to hold a message for days.
pub const MAX_PUSH_TTL_SECONDS: u32 = 36 * 3600;

/// The length of a `Topic` (RFC 8030 section 5.4): at most 32 characters of
/// the URL-safe base64 alphabet.
pub const MAX_TOPIC_LEN: usize = 32;

/// What a frost alert asks of the push service: how long to keep it, how hard
/// to try, and which message it replaces. The sender sets the three headers
/// from this and the delivery log records them as sent (`pushTtl`,
/// `pushUrgency`, `pushTopic` in data-infra ADR-0003).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushOptions {
    /// The `TTL` header, in seconds. After this long the push service drops
    /// the message instead of showing a "tonight" alert the next day.
    pub ttl_seconds: u32,
    pub urgency: Urgency,
    /// The `Topic` header: a newer message with the same topic replaces one the
    /// push service still holds, so a retry never leaves two copies queued.
    pub topic: String,
}

/// Why no push options could be built.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OptionsError {
    /// The alert's night is already over: nothing is left to say "tonight" about.
    NightOver,
    /// The night is not a date, or the offset is not a time zone.
    Invalid,
}

/// How urgent a frost alert is. Severe frost (0 C or below) is a safety matter
/// for crops and bypasses quiet hours, so it is the only one that asks to wake
/// a sleeping device; moderate and high frost are `normal`, which a device may
/// hold until its next maintenance window.
pub fn frost_urgency(risk: Risk) -> Urgency {
    match risk {
        Risk::Severe => Urgency::High,
        Risk::Moderate | Risk::High => Urgency::Normal,
    }
}

/// A `Topic` for one alert: its kind and the night it is about, such as
/// `frost-2026-07-10` (16 characters). A new alert for the same night replaces
/// one the push service still holds for that subscription; the next night's is
/// a different message. It carries **no place, cell or person**, and no hash of
/// one: the cell grid is public, so a hash of it would let the push service
/// read the place back by trying every cell. (A person is sent at most one
/// frost alert a night, so the night alone separates the messages.)
///
/// `None` when the result would not be a valid `Topic`: longer than
/// [`MAX_TOPIC_LEN`] or outside `[A-Za-z0-9_-]`.
pub fn topic_for(kind: &str, night: &str) -> Option<String> {
    let topic = format!("{kind}-{night}");
    let valid = !kind.is_empty()
        && topic.len() <= MAX_TOPIC_LEN
        && topic
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    valid.then_some(topic)
}

/// The instant a frost alert stops being useful, as a UTC unix timestamp, where
/// [`decide`] stops sending it. Severe frost still under way is sent until
/// 09:00 local on the morning after its night (the frost window includes the
/// hour that starts at 08:00); moderate and high frost are dropped as stale
/// from midnight, because their copy says "tonight". `None` for a night that
/// is not a date or an offset outside -12 to +14 hours.
fn night_end_unix(night: &str, risk: Risk, utc_offset_seconds: i32) -> Option<i64> {
    if !(-12 * 3600..=14 * 3600).contains(&utc_offset_seconds) {
        return None;
    }
    let morning = chrono::NaiveDate::parse_from_str(night, "%Y-%m-%d")
        .ok()?
        .succ_opt()?;
    let end_hour = match risk {
        Risk::Severe => u32::from(NIGHT_END_HOUR) + 1,
        Risk::Moderate | Risk::High => 0,
    };
    let end_local = morning.and_hms_opt(end_hour, 0, 0)?;
    Some(end_local.and_utc().timestamp() - i64::from(utc_offset_seconds))
}

/// The push options for one frost alert, planned at `now` for a place whose
/// clock is `utc_offset_seconds` from UTC.
///
/// **TTL.** The message expires where [`decide`] would stop sending it: 09:00
/// local on the morning after for severe frost, midnight for moderate and high
/// frost, at most [`MAX_PUSH_TTL_SECONDS`]. A push held by a phone that is off
/// or out of coverage is then dropped instead of arriving after its night,
/// saying "tonight" about a night that is over.
///
/// An error means nothing is built, and a caller sends nothing: a push without
/// these options is never made.
pub fn frost_push_options(
    alert: &FrostAlert,
    now: chrono::DateTime<chrono::Utc>,
    utc_offset_seconds: i32,
) -> Result<PushOptions, OptionsError> {
    let end = night_end_unix(&alert.night, alert.risk, utc_offset_seconds)
        .ok_or(OptionsError::Invalid)?;
    let topic = topic_for(KIND_FROST, &alert.night).ok_or(OptionsError::Invalid)?;
    let left = end - now.timestamp();
    if left <= 0 {
        return Err(OptionsError::NightOver);
    }
    Ok(PushOptions {
        ttl_seconds: u32::try_from(left)
            .unwrap_or(MAX_PUSH_TTL_SECONDS)
            .min(MAX_PUSH_TTL_SECONDS),
        urgency: frost_urgency(alert.risk),
        topic,
    })
}

/// What a push service said.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    /// Accepted by the push service (2xx). Not proof the device showed it.
    Accepted,
    /// 404 or 410 (gone), or 403 (VAPID key mismatch): deactivate it.
    Expired,
    /// 429, 5xx, network error: try again on a later tick.
    Retry,
    /// Any other 4xx: our request was refused; do not retry.
    Failed,
}

impl Outcome {
    /// The `AlertDeliveryStatus` value for the delivery log
    /// (`platform.alertDeliveries.status`, nyuchi/data-infra
    /// `schemas/model/notifications.yaml`). `skipped_quiet` and
    /// `skipped_cap` come from [`Decision`], not from a push service.
    pub fn delivery_status(self) -> &'static str {
        match self {
            Self::Accepted => "sent",
            Self::Expired => "gone",
            Self::Retry | Self::Failed => "failed",
        }
    }
}

pub fn classify_status(status: u16) -> Outcome {
    match status {
        200..=299 => Outcome::Accepted,
        // 403 from a push service means the subscription was made with a
        // different VAPID key: it can never work again, so deactivate it.
        403 | 404 | 410 => Outcome::Expired,
        0 | 429 | 500..=599 => Outcome::Retry,
        _ => Outcome::Failed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OM: &str = "open-meteo:blend";

    fn hours(date: &str, from: u32, n: u32) -> Vec<String> {
        (from..from + n)
            .map(|h| format!("{date}T{:02}:00", h % 24))
            .collect()
    }

    #[test]
    fn endpoints_must_be_https_on_a_known_service() {
        assert!(validate_endpoint("https://fcm.googleapis.com/fcm/send/abc").is_ok());
        assert!(validate_endpoint("https://updates.push.services.mozilla.com/wpush/v2/x").is_ok());
        assert!(validate_endpoint("https://web.push.apple.com/QAbc").is_ok());
        assert!(validate_endpoint("https://wns2-par02p.notify.windows.com/w/?token=x").is_ok());
        assert_eq!(
            validate_endpoint("http://fcm.googleapis.com/x"),
            Err(PushError::NotHttps)
        );
        assert_eq!(
            validate_endpoint("https://evil.example/x"),
            Err(PushError::HostNotAllowed)
        );
        assert_eq!(
            validate_endpoint("https://fcm.googleapis.com.evil.example/x"),
            Err(PushError::HostNotAllowed)
        );
        assert_eq!(
            validate_endpoint("https://notify.windows.com/x"),
            Err(PushError::HostNotAllowed)
        );
        assert_eq!(
            validate_endpoint("https://u@fcm.googleapis.com/x"),
            Err(PushError::BadEndpoint)
        );
        assert_eq!(
            validate_endpoint("https://fcm.googleapis.com:8443/x"),
            Err(PushError::BadEndpoint)
        );
        assert_eq!(
            validate_endpoint("https://127.0.0.1/x"),
            Err(PushError::HostNotAllowed)
        );
    }

    #[test]
    fn keys_have_the_exact_encoded_length() {
        let p = format!("BA{}", "A".repeat(85));
        let a = "B".repeat(22);
        assert!(validate_keys(&p, &a).is_ok());
        assert_eq!(validate_keys(&p[..86], &a), Err(PushError::BadKey));
        assert_eq!(
            validate_keys(&p, "B=".repeat(11).as_str()),
            Err(PushError::BadKey)
        );
    }

    #[test]
    fn keys_tolerate_padding_and_need_an_uncompressed_point() {
        let p = format!("BA{}", "A".repeat(85));
        let a = "B".repeat(22);
        // trailing '=' padding is stripped before the length check
        assert!(validate_keys(&format!("{p}="), &format!("{a}==")).is_ok());
        // compressed points (0x02/0x03 -> "A.."/"C..") and junk are refused
        assert_eq!(
            validate_keys(&format!("Ag{}", "A".repeat(85)), &a),
            Err(PushError::BadKey)
        );
        assert_eq!(
            validate_keys(&format!("AA{}", "A".repeat(85)), &a),
            Err(PushError::BadKey)
        );
        // 0x04 is "BA".."BP"; "BQ" would be 0x04 with a nonzero low bit pair
        assert!(validate_keys(&format!("BP{}", "A".repeat(85)), &a).is_ok());
        assert_eq!(
            validate_keys(&format!("BQ{}", "A".repeat(85)), &a),
            Err(PushError::BadKey)
        );
    }

    #[test]
    fn the_endpoint_id_ignores_host_case_and_the_default_port() {
        let e = "https://fcm.googleapis.com/fcm/send/AbC";
        assert_eq!(
            endpoint_id(e),
            endpoint_id("https://FCM.Googleapis.COM/fcm/send/AbC")
        );
        assert_eq!(
            endpoint_id(e),
            endpoint_id("https://fcm.googleapis.com:443/fcm/send/AbC")
        );
        // the path is a secret and keeps its case
        assert_ne!(
            endpoint_id(e),
            endpoint_id("https://fcm.googleapis.com/fcm/send/abc")
        );
        assert_eq!(canonical_endpoint("not a url"), "not a url");
    }

    #[test]
    fn prefs_use_the_apps_wire_names() {
        let p = AlertPrefs {
            frost: true,
            quiet_start: 21,
            quiet_end: 7,
            places: vec!["harare".into(), "bulawayo".into()],
        };
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(
            json["place_slugs"],
            serde_json::json!(["harare", "bulawayo"])
        );
        assert!(json.get("places").is_none());
        let back: AlertPrefs = serde_json::from_value(json).unwrap();
        assert_eq!(back, p);
        let from_app: AlertPrefs = serde_json::from_str(
            r#"{"frost":false,"quiet_start":22,"quiet_end":6,"place_slugs":["x"]}"#,
        )
        .unwrap();
        assert_eq!(from_app.places, vec!["x".to_string()]);
    }

    #[test]
    fn the_endpoint_id_is_a_stable_hash_not_the_endpoint() {
        let e = "https://fcm.googleapis.com/fcm/send/abc";
        assert_eq!(endpoint_id(e), endpoint_id(e));
        assert_eq!(endpoint_id(e).len(), 64);
        assert!(!endpoint_id(e).contains("fcm"));
    }

    #[test]
    fn quiet_hours_wrap_midnight() {
        assert!(in_quiet_hours(23, 22, 6));
        assert!(in_quiet_hours(2, 22, 6));
        assert!(!in_quiet_hours(6, 22, 6));
        assert!(!in_quiet_hours(12, 22, 6));
        assert!(in_quiet_hours(13, 12, 14));
        assert!(!in_quiet_hours(5, 5, 5));
    }

    #[test]
    fn prefs_are_validated() {
        let mut p = AlertPrefs {
            frost: true,
            places: vec!["harare".into()],
            ..AlertPrefs::default()
        };
        assert!(p.validate().is_ok());
        p.quiet_start = 24;
        assert_eq!(p.validate(), Err(PushError::BadQuietHours));
        p.quiet_start = 22;
        p.places = vec!["Har are".into()];
        assert_eq!(p.validate(), Err(PushError::BadSlug));
        p.places = (0..11).map(|i| format!("p{i}")).collect();
        assert_eq!(p.validate(), Err(PushError::TooManyPlaces));
    }

    #[test]
    fn frost_is_found_overnight_and_graded() {
        let mut times = hours("2026-07-10", 18, 6); // 18:00..23:00
        times.extend(hours("2026-07-11", 0, 10)); // 00:00..09:00
        let mut temps = vec![9.0, 7.0, 5.0, 4.0, 3.0, 2.5];
        temps.extend([2.0, 1.0, -0.5, 0.0, 1.0, 2.0, 3.0, 4.0, 6.0, 9.0]);
        let a = evaluate_frost(OM, &times, &temps, "2026-07-10T18:00").unwrap();
        assert_eq!(a.risk, Risk::Severe);
        assert_eq!(a.lowest, -0.5);
        assert_eq!(a.night, "2026-07-10");
        assert_eq!(a.start, "2026-07-10T22:00");
        assert_eq!(a.end, "2026-07-11T06:00");
    }

    #[test]
    fn early_morning_hours_belong_to_the_previous_night() {
        let times = hours("2026-07-11", 0, 8);
        let temps = vec![2.5; 8];
        let a = evaluate_frost(OM, &times, &temps, "2026-07-11T00:00").unwrap();
        assert_eq!(a.night, "2026-07-10");
        assert_eq!(a.risk, Risk::Moderate);
    }

    #[test]
    fn warm_cold_daytime_and_past_hours_are_not_frost() {
        let times = hours("2026-07-10", 10, 12);
        assert!(evaluate_frost(OM, &times, &[2.0; 12], "2026-07-10T10:00").is_none());
        // a cold day hour (12:00) alone is not frost
        assert!(evaluate_frost(
            OM,
            &hours("2026-07-10", 10, 4),
            &[1.0; 4],
            "2026-07-10T10:00"
        )
        .is_none());
        // frost that already passed is not reported
        let t = hours("2026-07-11", 0, 8);
        assert!(evaluate_frost(OM, &t, &[1.0; 8], "2026-07-11T09:00").is_none());
    }

    #[test]
    fn only_the_first_night_is_reported() {
        let mut times = hours("2026-07-10", 22, 2);
        times.extend(hours("2026-07-11", 22, 2));
        let a = evaluate_frost(OM, &times, &[2.0, 2.0, -3.0, -3.0], "2026-07-10T22:00").unwrap();
        assert_eq!(a.night, "2026-07-10");
        assert_eq!(a.risk, Risk::High);
    }

    #[test]
    fn estimates_and_zoned_times_never_produce_an_alert() {
        let times = hours("2026-07-10", 22, 2);
        let temps = [-2.0, -2.0];
        assert!(evaluate_frost(OM, &times, &temps, "2026-07-10T22:00").is_some());
        for p in ["fallback", "Fallback", "seasonal-estimate", "estimate", ""] {
            assert!(evaluate_frost(p, &times, &temps, "2026-07-10T22:00").is_none());
        }
        assert!(
            evaluate_frost("open-meteo:best_match", &times, &temps, "2026-07-10T22:00").is_some()
        );
        // zoned instants are refused, in the times and in `now`
        let zoned: Vec<String> = vec!["2026-07-10T22:00Z".into(), "2026-07-10T23:00Z".into()];
        assert!(evaluate_frost(OM, &zoned, &temps, "2026-07-10T22:00").is_none());
        let offset: Vec<String> = vec!["2026-07-10T22:00+02:00".into()];
        assert!(evaluate_frost(OM, &offset, &[-2.0], "2026-07-10T22:00").is_none());
        assert!(evaluate_frost(OM, &times, &temps, "2026-07-10T22:00:00Z").is_none());
        assert!(evaluate_frost(OM, &times, &temps, "garbage").is_none());
    }

    #[test]
    fn frost_boundaries() {
        // exactly 3.0 C is frost (moderate); just above is not
        let t = hours("2026-07-10", 22, 1);
        let a = evaluate_frost(OM, &t, &[3.0], "2026-07-10T22:00").unwrap();
        assert_eq!(a.risk, Risk::Moderate);
        assert!(evaluate_frost(OM, &t, &[3.01], "2026-07-10T22:00").is_none());
        // 2.0 is high, 0.0 is severe
        assert_eq!(
            evaluate_frost(OM, &t, &[2.0], "2026-07-10T22:00")
                .unwrap()
                .risk,
            Risk::High
        );
        assert_eq!(
            evaluate_frost(OM, &t, &[0.0], "2026-07-10T22:00")
                .unwrap()
                .risk,
            Risk::Severe
        );
        // 21:00 is outside the window, 22:00 inside
        let t21 = hours("2026-07-10", 21, 1);
        assert!(evaluate_frost(OM, &t21, &[-5.0], "2026-07-10T21:00").is_none());
        // 08:00 is inside (night of the previous date), 09:00 outside
        let t8 = vec!["2026-07-11T08:00".to_string()];
        let a = evaluate_frost(OM, &t8, &[1.0], "2026-07-11T08:00").unwrap();
        assert_eq!(a.night, "2026-07-10");
        let t9 = vec!["2026-07-11T09:00".to_string()];
        assert!(evaluate_frost(OM, &t9, &[1.0], "2026-07-11T09:00").is_none());
        // NaN is skipped, not alerted on
        assert!(evaluate_frost(OM, &t, &[f64::NAN], "2026-07-10T22:00").is_none());
        // mismatched lengths read up to the shorter and never panic
        let two = hours("2026-07-10", 22, 2);
        let a = evaluate_frost(OM, &two, &[1.0], "2026-07-10T22:00").unwrap();
        assert_eq!(a.end, "2026-07-10T22:00");
        assert!(evaluate_frost(OM, &two, &[], "2026-07-10T22:00").is_none());
        assert!(evaluate_frost(OM, &[], &[1.0], "2026-07-10T22:00").is_none());
    }

    #[test]
    fn dedupe_key_is_cell_kind_night() {
        assert_eq!(
            dedupe_key("cell:-17.85_31.05", "frost", "2026-07-10"),
            "cell:-17.85_31.05:frost:2026-07-10"
        );
    }

    fn input<'a>(prefs: &'a AlertPrefs) -> DecisionInput<'a> {
        DecisionInput {
            prefs,
            slug: "harare",
            risk: Risk::High,
            local_hour: 12,
            local_date: "2026-07-10",
            night: "2026-07-10",
            already_sent_this_night: false,
            sent_today: 0,
            sent_kind_tonight: 0,
        }
    }

    fn wants() -> AlertPrefs {
        AlertPrefs {
            frost: true,
            places: vec!["harare".into()],
            ..AlertPrefs::default()
        }
    }

    #[test]
    fn nothing_is_sent_unless_the_person_opted_in_for_that_place() {
        let off = AlertPrefs {
            frost: false,
            ..wants()
        };
        assert_eq!(decide(&input(&off)), Decision::NotWanted);
        let elsewhere = AlertPrefs {
            places: vec!["bulawayo".into()],
            ..wants()
        };
        assert_eq!(decide(&input(&elsewhere)), Decision::NotWanted);
        assert_eq!(decide(&input(&wants())), Decision::Send);
    }

    #[test]
    fn dedupe_caps_and_quiet_hours_apply_in_order() {
        let p = wants();
        let mut i = input(&p);
        i.already_sent_this_night = true;
        assert_eq!(decide(&i), Decision::Duplicate);
        i.already_sent_this_night = false;
        i.sent_today = MAX_PUSHES_PER_DAY;
        assert_eq!(decide(&i), Decision::RateLimited);
        i.sent_today = 0;
        i.sent_kind_tonight = 1;
        assert_eq!(decide(&i), Decision::RateLimited);
        i.sent_kind_tonight = 0;
        i.local_hour = 23;
        assert_eq!(decide(&i), Decision::HoldQuiet);
        i.risk = Risk::Severe;
        assert_eq!(decide(&i), Decision::Send);
    }

    #[test]
    fn a_held_night_alert_is_never_delivered_the_next_morning() {
        let p = wants(); // quiet 22:00 to 06:00
        let mut i = input(&p);
        i.risk = Risk::Moderate;
        // seen at 23:00 on the night's date: held by quiet hours
        i.local_hour = 23;
        assert_eq!(decide(&i), Decision::HoldQuiet);
        // the same alert at 06:00 the next day is past its night: dropped
        i.local_date = "2026-07-11";
        i.local_hour = 6;
        assert_eq!(decide(&i), Decision::Stale);
        // and after 08:00, for any risk
        i.local_hour = 9;
        assert_eq!(decide(&i), Decision::Stale);
        i.risk = Risk::Severe;
        assert_eq!(decide(&i), Decision::Stale);
        // severe frost still under way before 08:00 is sent, quiet hours or not
        i.local_hour = 3;
        assert_eq!(decide(&i), Decision::Send);
        // severe at 23:00 on the night itself bypasses quiet hours
        i.local_date = "2026-07-10";
        i.local_hour = 23;
        assert_eq!(decide(&i), Decision::Send);
        // an evening alert the same date, outside quiet hours, is sent
        i.risk = Risk::Moderate;
        i.local_hour = 21;
        assert_eq!(decide(&i), Decision::Send);
    }

    #[test]
    fn the_payload_has_no_personal_data_and_no_delivery_promise() {
        let a = FrostAlert {
            risk: Risk::Severe,
            lowest: -1.2,
            start: "2026-07-10T22:00".into(),
            end: "2026-07-11T06:00".into(),
            night: "2026-07-10".into(),
        };
        let p = frost_payload("Harare", "harare", &a);
        assert_eq!(p.url, "/harare");
        assert!(p.body.contains("-1°C"));
        let json = serde_json::to_string(&p).unwrap().to_lowercase();
        for word in ["guarantee", "email", "token", "endpoint"] {
            assert!(!json.contains(word));
        }
    }

    #[test]
    fn the_origin_is_the_allowed_host_in_lower_case_and_nothing_else() {
        assert_eq!(
            endpoint_origin("https://FCM.googleapis.com/fcm/send/abc?x=1").as_deref(),
            Ok("https://fcm.googleapis.com")
        );
        assert_eq!(
            endpoint_origin("https://fcm.googleapis.com:443/fcm/send/abc").as_deref(),
            Ok("https://fcm.googleapis.com")
        );
        // a refused endpoint never yields an origin to sign for
        assert_eq!(
            endpoint_origin("https://evil.example/x"),
            Err(PushError::HostNotAllowed)
        );
        assert_eq!(
            endpoint_origin("http://fcm.googleapis.com/x"),
            Err(PushError::NotHttps)
        );
        assert_eq!(
            endpoint_origin("https://fcm.googleapis.com:8443/x"),
            Err(PushError::BadEndpoint)
        );
    }

    #[test]
    fn outcomes_map_onto_the_delivery_log_statuses() {
        assert_eq!(Outcome::Accepted.delivery_status(), "sent");
        assert_eq!(Outcome::Expired.delivery_status(), "gone");
        assert_eq!(Outcome::Retry.delivery_status(), "failed");
        assert_eq!(Outcome::Failed.delivery_status(), "failed");
    }

    #[test]
    fn push_service_answers_are_classified() {
        assert_eq!(classify_status(201), Outcome::Accepted);
        assert_eq!(classify_status(404), Outcome::Expired);
        assert_eq!(classify_status(410), Outcome::Expired);
        // a VAPID key mismatch can never succeed: deactivate, do not retry
        assert_eq!(classify_status(403), Outcome::Expired);
        assert_eq!(classify_status(401), Outcome::Failed);
        assert_eq!(classify_status(429), Outcome::Retry);
        assert_eq!(classify_status(503), Outcome::Retry);
        assert_eq!(classify_status(0), Outcome::Retry);
        assert_eq!(classify_status(400), Outcome::Failed);
        assert_eq!(classify_status(413), Outcome::Failed);
    }
    #[test]
    fn severe_frost_is_only_sent_through_the_morning_right_after_its_night() {
        let prefs = AlertPrefs {
            frost: true,
            quiet_start: 22,
            quiet_end: 6,
            places: vec!["harare".into()],
        };
        let at = |date: &str, hour: u8| {
            decide(&DecisionInput {
                prefs: &prefs,
                slug: "harare",
                risk: Risk::Severe,
                local_hour: hour,
                local_date: date,
                night: "2026-07-10",
                already_sent_this_night: false,
                sent_today: 0,
                sent_kind_tonight: 0,
            })
        };
        // the night itself, and the small hours of the morning after
        assert_eq!(at("2026-07-10", 23), Decision::Send);
        assert_eq!(at("2026-07-11", 2), Decision::Send);
        assert_eq!(at("2026-07-11", 8), Decision::Send);
        // after dawn on the morning after, and every hour of any later day
        assert_eq!(at("2026-07-11", 9), Decision::Stale);
        assert_eq!(at("2026-07-12", 2), Decision::Stale);
        assert_eq!(at("2026-08-01", 3), Decision::Stale);
        // a month boundary: the 31st's night ends on the 1st
        let month = decide(&DecisionInput {
            prefs: &prefs,
            slug: "harare",
            risk: Risk::Severe,
            local_hour: 3,
            local_date: "2026-08-01",
            night: "2026-07-31",
            already_sent_this_night: false,
            sent_today: 0,
            sent_kind_tonight: 0,
        });
        assert_eq!(month, Decision::Send);
    }

    fn utc(s: &str) -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339(s)
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    fn frost_on(night: &str, risk: Risk) -> FrostAlert {
        FrostAlert {
            risk,
            lowest: -1.0,
            start: format!("{night}T23:00"),
            end: format!("{night}T06:00"),
            night: night.to_string(),
        }
    }

    #[test]
    fn urgency_is_spelled_as_rfc_8030_spells_it() {
        // the type models the whole header; frost only uses two of its values
        assert_eq!(Urgency::VeryLow.as_str(), "very-low");
        assert_eq!(Urgency::Low.as_str(), "low");
        assert_eq!(Urgency::Normal.as_str(), "normal");
        assert_eq!(Urgency::High.as_str(), "high");
        // the serde form is the header form
        assert_eq!(
            serde_json::to_value(Urgency::VeryLow).unwrap(),
            serde_json::json!("very-low")
        );
    }

    #[test]
    fn only_severe_frost_asks_to_wake_a_sleeping_device() {
        assert_eq!(frost_urgency(Risk::Severe), Urgency::High);
        assert_eq!(frost_urgency(Risk::High), Urgency::Normal);
        assert_eq!(frost_urgency(Risk::Moderate), Urgency::Normal);
    }

    #[test]
    fn the_topic_is_the_kind_and_the_night_and_names_no_place_or_person() {
        let t = topic_for(KIND_FROST, "2026-07-10").unwrap();
        assert_eq!(t, "frost-2026-07-10");
        assert!(t.len() <= MAX_TOPIC_LEN);
        // the next night is another message
        assert_ne!(t, topic_for(KIND_FROST, "2026-07-11").unwrap());
        // nothing in it comes from a place, a cell or a person; the options
        // for two places on one night share it, so it tells a push service
        // nothing about where either device is
        let a = frost_push_options(
            &frost_on("2026-07-10", Risk::Severe),
            utc("2026-07-10T17:30:00Z"),
            7200,
        )
        .unwrap();
        assert_eq!(a.topic, t);
        // only the URL-safe base64 alphabet and at most 32 characters, else none
        assert_eq!(topic_for("frost", "2026-07-10 22:00"), None);
        assert_eq!(topic_for("frost", "x/y"), None);
        assert_eq!(topic_for("frost", &"9".repeat(40)), None);
        assert_eq!(topic_for("", "2026-07-10"), None);
    }

    #[test]
    fn a_severe_frost_push_lives_until_9am_local_the_morning_after() {
        let a = frost_on("2026-07-10", Risk::Severe);
        // Harare, UTC+2. The night ends 2026-07-11 09:00 local = 07:00Z.
        let at = |now: &str| frost_push_options(&a, utc(now), 7200);
        // 19:30 local: 13.5 hours
        let evening = at("2026-07-10T17:30:00Z").unwrap();
        assert_eq!(evening.ttl_seconds, 48_600);
        assert_eq!(evening.urgency, Urgency::High);
        assert_eq!(evening.topic, "frost-2026-07-10");
        // 03:00 local: 6 hours
        assert_eq!(at("2026-07-11T01:00:00Z").unwrap().ttl_seconds, 21_600);
        // 08:30 local: half an hour
        assert_eq!(at("2026-07-11T06:30:00Z").unwrap().ttl_seconds, 1_800);
        // 08:59:59 local: one second
        assert_eq!(at("2026-07-11T06:59:59Z").unwrap().ttl_seconds, 1);
        // 09:00 local and after: the night is over, nothing is built
        assert_eq!(at("2026-07-11T07:00:00Z"), Err(OptionsError::NightOver));
        assert_eq!(at("2026-07-12T00:00:00Z"), Err(OptionsError::NightOver));
    }

    #[test]
    fn a_moderate_or_high_frost_push_lives_until_midnight_where_decide_stops_sending() {
        for risk in [Risk::Moderate, Risk::High] {
            let a = frost_on("2026-07-10", risk);
            // Harare, UTC+2: the push is useful until 00:00 local on the 11th
            // (22:00Z on the 10th), not until the morning.
            let at = |now: &str| frost_push_options(&a, utc(now), 7200);
            // 21:30 local: 2.5 hours
            let o = at("2026-07-10T19:30:00Z").unwrap();
            assert_eq!(o.ttl_seconds, 9_000, "{risk:?}");
            assert_eq!(o.urgency, Urgency::Normal);
            // 23:50 local: ten minutes, so a phone that is off at 23:50 never
            // shows "frost tonight" at breakfast
            assert_eq!(at("2026-07-10T21:50:00Z").unwrap().ttl_seconds, 600);
            // midnight local and after
            assert_eq!(at("2026-07-10T22:00:00Z"), Err(OptionsError::NightOver));
            assert_eq!(at("2026-07-11T01:00:00Z"), Err(OptionsError::NightOver));
        }
    }

    /// The TTL ends where `decide` stops sending: for every risk, at every ten
    /// minutes across two days, options exist exactly when the alert is not
    /// `Stale`. One boundary, two functions, no way to disagree.
    #[test]
    fn a_push_has_options_exactly_while_decide_would_still_send_it() {
        let prefs = AlertPrefs {
            frost: true,
            quiet_start: 0,
            quiet_end: 0,
            places: vec!["harare".into()],
        };
        let offset = 7200;
        for risk in [Risk::Moderate, Risk::High, Risk::Severe] {
            let alert = frost_on("2026-07-10", risk);
            let mut now = utc("2026-07-10T04:00:00Z");
            let stop = utc("2026-07-12T04:00:00Z");
            let mut checked = 0;
            while now < stop {
                let local = now + chrono::Duration::seconds(i64::from(offset));
                let date = local.format("%Y-%m-%d").to_string();
                let hour = local.format("%H").to_string().parse::<u8>().unwrap();
                let decision = decide(&DecisionInput {
                    prefs: &prefs,
                    slug: "harare",
                    risk,
                    local_hour: hour,
                    local_date: &date,
                    night: &alert.night,
                    already_sent_this_night: false,
                    sent_today: 0,
                    sent_kind_tonight: 0,
                });
                let options = frost_push_options(&alert, now, offset);
                assert_eq!(
                    options.is_ok(),
                    decision != Decision::Stale,
                    "{risk:?} at {now}: {decision:?} vs {options:?}"
                );
                if let Ok(o) = &options {
                    assert!(o.ttl_seconds >= 1 && o.ttl_seconds <= MAX_PUSH_TTL_SECONDS);
                }
                now += chrono::Duration::minutes(10);
                checked += 1;
            }
            assert_eq!(checked, 288);
        }
    }

    #[test]
    fn the_offset_moves_the_end_of_the_night_both_ways() {
        // UTC-5: the night of 2026-01-10 ends, for high frost, at 2026-01-11
        // 00:00 local = 05:00Z.
        let a = frost_on("2026-01-10", Risk::High);
        let o = frost_push_options(&a, utc("2026-01-11T01:00:00Z"), -5 * 3600).unwrap();
        assert_eq!(o.ttl_seconds, 4 * 3600);
        // UTC+14: midnight local on the 11th is 10:00Z on the 10th.
        let o = frost_push_options(&a, utc("2026-01-10T04:00:00Z"), 14 * 3600).unwrap();
        assert_eq!(o.ttl_seconds, 6 * 3600);
        // severe frost in the same zone runs on to 09:00 local
        let s = frost_on("2026-01-10", Risk::Severe);
        let o = frost_push_options(&s, utc("2026-01-10T04:00:00Z"), 14 * 3600).unwrap();
        assert_eq!(o.ttl_seconds, 15 * 3600);
    }

    #[test]
    fn no_alert_the_forecast_can_raise_reaches_the_ttl_cap() {
        // The longest case: 08:00 local, severe frost from 22:00 tonight to
        // 08:59 tomorrow (the lookahead reaches 24 hours): 25 hours to 09:00.
        let a = frost_on("2026-07-10", Risk::Severe);
        let o = frost_push_options(&a, utc("2026-07-10T06:00:00Z"), 7200).unwrap();
        assert_eq!(o.ttl_seconds, 25 * 3600);
        assert!(o.ttl_seconds < MAX_PUSH_TTL_SECONDS);
        // a night days away is capped, not held for days
        let far = frost_on("2026-07-14", Risk::Severe);
        let o = frost_push_options(&far, utc("2026-07-10T08:00:00Z"), 0).unwrap();
        assert_eq!(o.ttl_seconds, MAX_PUSH_TTL_SECONDS);
    }

    #[test]
    fn push_options_fail_closed_and_say_why() {
        let now = utc("2026-07-10T17:30:00Z");
        let a = frost_on("2026-07-10", Risk::Severe);
        assert!(frost_push_options(&a, now, 7200).is_ok());
        // an offset outside -12h..=+14h is not a time zone
        for offset in [15 * 3600, -13 * 3600] {
            assert_eq!(
                frost_push_options(&a, now, offset),
                Err(OptionsError::Invalid)
            );
        }
        // a night that is not a date
        for bad in ["", "tomorrow", "2026-13-01", "2026-07-10T22:00"] {
            let mut b = a.clone();
            b.night = bad.to_string();
            assert_eq!(
                frost_push_options(&b, now, 7200),
                Err(OptionsError::Invalid),
                "{bad}"
            );
        }
        // a night that has ended is a normal morning, told apart from a bug
        assert_eq!(
            frost_push_options(&a, utc("2026-07-12T00:00:00Z"), 7200),
            Err(OptionsError::NightOver)
        );
    }
}
