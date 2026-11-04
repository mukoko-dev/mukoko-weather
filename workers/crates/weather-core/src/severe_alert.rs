//! Severe-weather alerts from an OFFICIAL CAP source
//! (mukoko-dev/mukoko-weather#289, "frost first, then severe"; the pure half).
//!
//! **Where a severe alert comes from.** Only from an alerting authority that
//! publishes the OASIS Common Alerting Protocol 1.2 (CAP): a national
//! meteorological service in the WMO Register of Alerting Authorities (for
//! Zimbabwe, the Meteorological Services Department, whose registered feed the
//! WMO Severe Weather Information Centre lists as operating). Never from our
//! own thresholds over the blended forecast, and never from a weather station.
//! A forecast model can say "frost is likely"; a warning that tells someone to
//! leave a flooded valley is the authority's to issue, and a push that looks
//! like one but is our own guess would overclaim. The authority is named in
//! the message. (The standards rule: CAP exists, so we adopt it and convert at
//! the edge; a provider's own names never become ours.)
//!
//! **What is here, and what is not.** The input is a [`CapAlert`]: the facts of
//! one CAP `alert/info` block, already parsed. Turning the XML feed into that
//! struct is a later step (a feed fetch with the `external_fetch` guards, an
//! XML reader and a polygon store), and nothing here reads a feed, a clock or a
//! key: the caller passes `now`. Nothing here can send anything. What is here:
//!
//! - [`evaluate_severe`]: whether one alert warrants a push for one point, and
//!   if not, the single reason why ([`Skip`]).
//! - [`severe_push_options`]: the RFC 8030 `TTL`, `Urgency` and `Topic`.
//! - [`severe_dedupe_key`]: the delivery-log key, `{cell}:severe:{token}`.
//! - [`severe_payload`]: the message text, with the authority's name in it.
//! - [`area_covers`]: CAP polygons and circles against a point.
//!
//! **The gate (conservative on purpose; every line is a constant or a match
//! arm to change).** An alert is pushed only when ALL hold: `status` is
//! `Actual` (never `Test`, `Exercise`, `System` or `Draft`); `scope` is
//! `Public`; `msgType` is `Alert` or `Update`; a `category` is `Met`;
//! `severity` is `Extreme` or `Severe`; `urgency` is `Immediate` or `Expected`;
//! `certainty` is `Observed` or `Likely`; it has an `expires` that has not
//! passed and an `effective` no more than [`EFFECTIVE_LEAD_SECONDS`] ahead; and
//! its area, a polygon or a circle, contains the place. `Moderate` and `Minor`
//! warnings, `Future` ones and `Possible` ones are real information but not a
//! reason to wake someone: they belong in an in-app list, not a push. A
//! `Cancel` is not pushed either (a "cancelled" push is its own design).
//!
//! **Fail closed.** An alert whose area is only `geocode` values (a code table
//! per country that we do not hold) cannot be matched, so it is skipped with
//! [`Skip::AreaNotMatchable`], a reason distinct from [`Skip::OutsideArea`] so a
//! coverage gap is visible instead of silent. An alert with no `expires`
//! cannot be given a `TTL` and is skipped. Anything malformed is
//! [`Skip::Invalid`]. Not sending is repaired by the next tick; a wrong
//! life-safety push is not.
//!
//! **Known limits, stated.**
//!
//! - Polygons are read in the lat/lon plane (straight edges), as CAP defines
//!   them. An edge that crosses the antimeridian is handled; a polygon that
//!   encloses a pole is not, and is refused as [`Skip::Invalid`] rather than
//!   misjudged.
//! - An `Update` carries a new identifier, so it is a new alert here: it is
//!   pushed again (a person may see the original and its update) rather than
//!   risk replacing a warning with a quieter one. Linking by `references`
//!   needs the delivery log.
//! - The per-person gates (follows this place, quiet hours, daily caps, kind
//!   on/off) are `push::decide`'s for frost and are generalised to kinds
//!   separately; [`bypasses_quiet_hours`] is this module's input to that.
//! - The `Topic` is a hash of the sender and identifier, which the authority
//!   publishes. It carries no place, cell or person, but a push service that
//!   already knows an alert could recognise it, and so learn that this
//!   subscription received that alert, an area no finer than the authority's.

use std::fmt::Write as _;

use chrono::{DateTime, Utc};

use crate::push::{Payload, PushOptions, Urgency, MAX_PUSH_TTL_SECONDS};

/// The `kind` of a severe alert in the delivery log and the push payload.
pub const KIND_SEVERE: &str = "severe";

/// How far ahead of its `effective` time an alert may be pushed: six hours. An
/// alert further out is [`Skip::NotYet`] and a later tick picks it up.
pub const EFFECTIVE_LEAD_SECONDS: i64 = 6 * 3600;

/// How far in the future an alert's `sent` time may be before the alert is
/// treated as malformed (clock skew at the authority): one day.
pub const MAX_SENT_SKEW_SECONDS: i64 = 24 * 3600;

/// Longest `identifier` or `sender` we accept. CAP puts no bound; a feed that
/// sends more is not one we read.
pub const MAX_ID_LEN: usize = 256;

/// The most polygons plus circles in one alert, and the most polygon vertices
/// in all. Generous (national warnings are drawn in detail) but bounded, so a
/// hostile or broken feed cannot make one evaluation expensive.
pub const MAX_SHAPES: usize = 256;
pub const MAX_VERTICES: usize = 50_000;

/// The characters of the `Topic` token and of the payload's `night` field (the
/// service worker keeps ten characters of it to build its notification tag).
const TOKEN_LEN: usize = 20;
const PAYLOAD_TOKEN_LEN: usize = 10;

macro_rules! cap_enum {
    ($(#[$m:meta])* $name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        $(#[$m])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub enum $name { $($variant),+ }

        impl $name {
            /// Every value, in the standard's order.
            pub const ALL: &'static [$name] = &[$($name::$variant),+];

            /// The value exactly as CAP 1.2 spells it.
            pub fn as_str(self) -> &'static str {
                match self { $($name::$variant => $text),+ }
            }

            /// Parse the standard's spelling. CAP values are case-sensitive;
            /// anything else is `None`, never a guess.
            pub fn parse(s: &str) -> Option<Self> {
                match s { $($text => Some($name::$variant),)+ _ => None }
            }
        }
    };
}

cap_enum!(
    /// CAP `status` (section 3.2.1).
    CapStatus { Actual => "Actual", Exercise => "Exercise", System => "System", Test => "Test", Draft => "Draft" }
);
cap_enum!(
    /// CAP `msgType`.
    CapMsgType { Alert => "Alert", Update => "Update", Cancel => "Cancel", Ack => "Ack", Error => "Error" }
);
cap_enum!(
    /// CAP `scope`.
    CapScope { Public => "Public", Restricted => "Restricted", Private => "Private" }
);
cap_enum!(
    /// CAP `info/category`.
    CapCategory {
        Geo => "Geo", Met => "Met", Safety => "Safety", Security => "Security", Rescue => "Rescue",
        Fire => "Fire", Health => "Health", Env => "Env", Transport => "Transport", Infra => "Infra",
        Cbrne => "CBRNE", Other => "Other",
    }
);
cap_enum!(
    /// CAP `info/severity`.
    CapSeverity { Extreme => "Extreme", Severe => "Severe", Moderate => "Moderate", Minor => "Minor", Unknown => "Unknown" }
);
cap_enum!(
    /// CAP `info/urgency`.
    CapUrgency { Immediate => "Immediate", Expected => "Expected", Future => "Future", Past => "Past", Unknown => "Unknown" }
);
cap_enum!(
    /// CAP `info/certainty`. The CAP 1.0 value `Very Likely` is deprecated and
    /// is read as `Likely` by [`parse_certainty`].
    CapCertainty { Observed => "Observed", Likely => "Likely", Possible => "Possible", Unlikely => "Unlikely", Unknown => "Unknown" }
);

/// `certainty` as feeds write it, with the deprecated CAP 1.0 `Very Likely`
/// read as `Likely` (data-infra `CapCertainty` does the same).
pub fn parse_certainty(s: &str) -> Option<CapCertainty> {
    if s == "Very Likely" {
        Some(CapCertainty::Likely)
    } else {
        CapCertainty::parse(s)
    }
}

/// One `area` of an alert: its polygons and circles, as `(lat, lon)` in WGS 84
/// decimal degrees. `geocode` values are not represented: they cannot be
/// matched to a point here, so an area with neither a polygon nor a circle
/// stands for one described only by geocodes (see [`area_covers`]).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CapArea {
    pub polygons: Vec<Vec<(f64, f64)>>,
    /// `(lat, lon, radius_km)`.
    pub circles: Vec<(f64, f64, f64)>,
}

/// The facts of one CAP `alert` with one `info` block, already parsed.
#[derive(Debug, Clone, PartialEq)]
pub struct CapAlert {
    pub identifier: String,
    pub sender: String,
    pub sent: DateTime<Utc>,
    pub status: CapStatus,
    pub msg_type: CapMsgType,
    pub scope: CapScope,
    pub categories: Vec<CapCategory>,
    /// CAP `info/event`: the authority's own words ("Heavy Rain").
    pub event: String,
    pub severity: CapSeverity,
    pub urgency: CapUrgency,
    pub certainty: CapCertainty,
    /// Absent means `sent`.
    pub effective: Option<DateTime<Utc>>,
    pub expires: Option<DateTime<Utc>>,
    pub headline: Option<String>,
    pub area_desc: String,
    pub areas: Vec<CapArea>,
    /// Who to credit in the message: the authority's name as the WMO register
    /// gives it ("Zimbabwe: Meteorological Services Department").
    pub source: String,
}

/// Why an alert is not pushed to a point. One reason, the first that applies,
/// in the order the gate checks them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skip {
    /// A field is missing, malformed or out of range, or the point is not a
    /// coordinate.
    Invalid,
    /// `status` is not `Actual`: a test, an exercise, a system message or a draft.
    NotActual,
    /// `scope` is not `Public`.
    NotPublic,
    /// `msgType` is not `Alert` or `Update`.
    NotAnAlert,
    /// No `category` is `Met`.
    NotWeather,
    /// `severity` is below `Severe`.
    BelowSeverity,
    /// `urgency` is not `Immediate` or `Expected`.
    NotImminent,
    /// `certainty` is not `Observed` or `Likely`.
    NotLikely,
    /// No `expires`: no end to give a `TTL`.
    NoExpiry,
    /// `expires` has passed.
    Expired,
    /// `effective` is more than [`EFFECTIVE_LEAD_SECONDS`] away. A later tick
    /// may send it.
    NotYet,
    /// The alert's area has no polygon or circle (only `geocode` values), so it
    /// cannot be matched to a point.
    AreaNotMatchable,
    /// The area was matched and does not contain the point.
    OutsideArea,
}

impl Skip {
    /// The reason as a stable lower-case word, for logs and the delivery log.
    pub fn as_str(self) -> &'static str {
        match self {
            Skip::Invalid => "invalid",
            Skip::NotActual => "not_actual",
            Skip::NotPublic => "not_public",
            Skip::NotAnAlert => "not_an_alert",
            Skip::NotWeather => "not_weather",
            Skip::BelowSeverity => "below_severity",
            Skip::NotImminent => "not_imminent",
            Skip::NotLikely => "not_likely",
            Skip::NoExpiry => "no_expiry",
            Skip::Expired => "expired",
            Skip::NotYet => "not_yet",
            Skip::AreaNotMatchable => "area_not_matchable",
            Skip::OutsideArea => "outside_area",
        }
    }
}

/// An alert that warrants a push for the point it was evaluated for.
#[derive(Debug, Clone, PartialEq)]
pub struct SevereAlert {
    pub identifier: String,
    pub sender: String,
    pub event: String,
    pub severity: CapSeverity,
    pub urgency: CapUrgency,
    pub certainty: CapCertainty,
    pub effective: DateTime<Utc>,
    pub expires: DateTime<Utc>,
    pub headline: Option<String>,
    pub area_desc: String,
    pub source: String,
    /// `msgType` was `Update`.
    pub is_update: bool,
}

fn clean_id(s: &str) -> bool {
    !s.trim().is_empty() && s.len() <= MAX_ID_LEN && !s.chars().any(char::is_control)
}

/// Decide whether `alert` warrants a push for the point (`lat`, `lon`) at
/// `now`. See the module documentation for the gate.
pub fn evaluate_severe(
    alert: &CapAlert,
    lat: f64,
    lon: f64,
    now: DateTime<Utc>,
) -> Result<SevereAlert, Skip> {
    // The message names the event and the authority, so neither may be blank.
    if !crate::geo::valid_coordinates(lat, lon)
        || !clean_id(&alert.identifier)
        || !clean_id(&alert.sender)
        || alert.event.trim().is_empty()
        || alert.source.trim().is_empty()
    {
        return Err(Skip::Invalid);
    }
    if alert.sent.timestamp() - now.timestamp() > MAX_SENT_SKEW_SECONDS {
        return Err(Skip::Invalid);
    }
    if alert.status != CapStatus::Actual {
        return Err(Skip::NotActual);
    }
    if alert.scope != CapScope::Public {
        return Err(Skip::NotPublic);
    }
    let is_update = match alert.msg_type {
        CapMsgType::Alert => false,
        CapMsgType::Update => true,
        CapMsgType::Cancel | CapMsgType::Ack | CapMsgType::Error => return Err(Skip::NotAnAlert),
    };
    if !alert.categories.contains(&CapCategory::Met) {
        return Err(Skip::NotWeather);
    }
    if !matches!(alert.severity, CapSeverity::Extreme | CapSeverity::Severe) {
        return Err(Skip::BelowSeverity);
    }
    if !matches!(alert.urgency, CapUrgency::Immediate | CapUrgency::Expected) {
        return Err(Skip::NotImminent);
    }
    if !matches!(
        alert.certainty,
        CapCertainty::Observed | CapCertainty::Likely
    ) {
        return Err(Skip::NotLikely);
    }
    let expires = alert.expires.ok_or(Skip::NoExpiry)?;
    if expires <= now {
        return Err(Skip::Expired);
    }
    let effective = alert.effective.unwrap_or(alert.sent);
    // An alert that ends before it starts is bad data, whatever `effective` is.
    if expires <= effective {
        return Err(Skip::Invalid);
    }
    if effective.timestamp() - now.timestamp() > EFFECTIVE_LEAD_SECONDS {
        return Err(Skip::NotYet);
    }
    match area_covers(&alert.areas, lat, lon) {
        Area::Inside => {}
        Area::Outside => return Err(Skip::OutsideArea),
        Area::NotMatchable => return Err(Skip::AreaNotMatchable),
        Area::Invalid => return Err(Skip::Invalid),
    }
    Ok(SevereAlert {
        identifier: alert.identifier.clone(),
        sender: alert.sender.clone(),
        event: alert.event.clone(),
        severity: alert.severity,
        urgency: alert.urgency,
        certainty: alert.certainty,
        effective,
        expires,
        headline: alert.headline.clone(),
        area_desc: alert.area_desc.clone(),
        source: alert.source.clone(),
        is_update,
    })
}

// --- Areas -----------------------------------------------------------------

/// How an alert's area relates to a point.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Area {
    Inside,
    Outside,
    /// No polygon or circle to test (geocode-only, or an empty area list).
    NotMatchable,
    /// A shape is malformed, or the alert is larger than the bounds.
    Invalid,
}

/// Whether any of `areas` contains the point. A polygon or circle that is
/// malformed makes the whole answer [`Area::Invalid`] (never a quiet `Outside`
/// that hides a broken warning); a point on a boundary is inside.
pub fn area_covers(areas: &[CapArea], lat: f64, lon: f64) -> Area {
    if !crate::geo::valid_coordinates(lat, lon) {
        return Area::Invalid;
    }
    let shapes: usize = areas
        .iter()
        .map(|a| a.polygons.len() + a.circles.len())
        .sum();
    let vertices: usize = areas
        .iter()
        .flat_map(|a| a.polygons.iter())
        .map(Vec::len)
        .sum();
    if shapes > MAX_SHAPES || vertices > MAX_VERTICES {
        return Area::Invalid;
    }
    if shapes == 0 {
        return Area::NotMatchable;
    }
    let mut inside = false;
    for area in areas {
        for ring in &area.polygons {
            match polygon_contains(ring, lat, lon) {
                Some(true) => inside = true,
                Some(false) => {}
                None => return Area::Invalid,
            }
        }
        for &(clat, clon, radius_km) in &area.circles {
            match circle_contains(clat, clon, radius_km, lat, lon) {
                Some(true) => inside = true,
                Some(false) => {}
                None => return Area::Invalid,
            }
        }
    }
    if inside {
        Area::Inside
    } else if areas
        .iter()
        .any(|a| a.polygons.is_empty() && a.circles.is_empty())
    {
        // Another area is described only by geocodes. The point is outside
        // every shape we hold, but it may be inside that one, so this is a gap
        // and not a "no".
        Area::NotMatchable
    } else {
        Area::Outside
    }
}

/// Parse a CAP `polygon` value: space-separated `lat,lon` pairs, the first
/// repeated as the last. At least four pairs as written (a triangle closed);
/// every coordinate finite and in range. `None` otherwise.
pub fn parse_polygon(s: &str) -> Option<Vec<(f64, f64)>> {
    let points: Vec<(f64, f64)> = s
        .split_whitespace()
        .map(parse_pair)
        .collect::<Option<_>>()?;
    (points.len() >= 4 && points.first() == points.last()).then_some(points)
}

/// Parse a CAP `circle` value: `lat,lon radius`, the radius in kilometres.
pub fn parse_circle(s: &str) -> Option<(f64, f64, f64)> {
    let mut parts = s.split_whitespace();
    let (lat, lon) = parse_pair(parts.next()?)?;
    let radius: f64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() || !radius.is_finite() || radius <= 0.0 || radius > 20_000.0 {
        return None;
    }
    Some((lat, lon, radius))
}

fn parse_pair(s: &str) -> Option<(f64, f64)> {
    let (a, b) = s.split_once(',')?;
    let (lat, lon): (f64, f64) = (a.parse().ok()?, b.parse().ok()?);
    crate::geo::valid_coordinates(lat, lon).then_some((lat, lon))
}

/// Whether the point is in the ring, in the plane of (longitude, latitude).
///
/// The ring's longitudes are first UNWRAPPED along its edges, each step taking
/// the short way (at most 180 degrees), so an edge from 179 E to 179 W is a
/// two-degree edge across the antimeridian and not one that spans the world.
/// The point is then tried at its longitude and 360 degrees either side of it.
/// A ring that does not close after unwrapping winds around a pole, which this
/// does not handle, so it is `None` (invalid) and never a guess. `None` also for
/// fewer than three distinct vertices or a coordinate that is not valid.
fn polygon_contains(ring: &[(f64, f64)], lat: f64, lon: f64) -> Option<bool> {
    if ring.len() < 3
        || ring
            .iter()
            .any(|&(la, lo)| !crate::geo::valid_coordinates(la, lo))
    {
        return None;
    }
    let short = |d: f64| {
        if d > 180.0 {
            d - 360.0
        } else if d < -180.0 {
            d + 360.0
        } else {
            d
        }
    };
    let mut pts: Vec<(f64, f64)> = Vec::with_capacity(ring.len());
    let (first_lat, first_lon) = ring[0];
    let (mut x, mut prev) = (first_lon, first_lon);
    pts.push((x, first_lat));
    for &(la, lo) in &ring[1..] {
        x += short(lo - prev);
        prev = lo;
        pts.push((x, la));
    }
    // The closing edge must land back on the first vertex.
    if (x + short(first_lon - prev) - first_lon).abs() > 1e-9 {
        return None;
    }
    // At least three distinct vertices, found in one pass.
    let first = pts[0];
    let second = pts.iter().find(|p| **p != first)?;
    if !pts.iter().any(|p| *p != first && p != second) {
        return None;
    }
    Some(
        [-360.0, 0.0, 360.0]
            .iter()
            .any(|k| ray_inside(&pts, lon + k, lat)),
    )
}

/// Ray casting for the point (`px`, `py`) against a ring of (x, y). A point on
/// an edge or a vertex is inside, so a boundary is never missed.
fn ray_inside(pts: &[(f64, f64)], px: f64, py: f64) -> bool {
    let mut inside = false;
    let n = pts.len();
    for i in 0..n {
        let (x1, y1) = (pts[i].0 - px, pts[i].1 - py);
        let (x2, y2) = (pts[(i + 1) % n].0 - px, pts[(i + 1) % n].1 - py);
        let cross = x1 * y2 - x2 * y1;
        let within =
            x1.min(x2) <= 0.0 && 0.0 <= x1.max(x2) && y1.min(y2) <= 0.0 && 0.0 <= y1.max(y2);
        if cross == 0.0 && within {
            return true;
        }
        if (y1 > 0.0) != (y2 > 0.0) {
            let x_at_zero = x1 + (0.0 - y1) * (x2 - x1) / (y2 - y1);
            if x_at_zero > 0.0 {
                inside = !inside;
            }
        }
    }
    inside
}

fn circle_contains(clat: f64, clon: f64, radius_km: f64, lat: f64, lon: f64) -> Option<bool> {
    if !crate::geo::valid_coordinates(clat, clon)
        || !radius_km.is_finite()
        || radius_km <= 0.0
        || radius_km > 20_000.0
    {
        return None;
    }
    Some(crate::geo::haversine_km(clat, clon, lat, lon) <= radius_km)
}

// --- Push ------------------------------------------------------------------

/// A short token naming one alert, from its sender and identifier. Hex, so it
/// is safe in a dedupe key, a `Topic` and a payload field.
pub fn alert_token(sender: &str, identifier: &str) -> String {
    let mut h = crate::crypto::sha256_hex(&format!("{sender}\n{identifier}"));
    h.truncate(TOKEN_LEN);
    h
}

/// The delivery-log key for one alert at one place: `{cell}:severe:{token}`,
/// the same three-part shape as [`crate::push::dedupe_key`] (the API requires
/// three non-empty parts and a middle part equal to the delivery's kind). One
/// alert is one key whatever its updates do.
///
/// `cell` is the place's `geo::cell_key` (`cell:-17.85_31.05`; the prefix is
/// dropped, see [`crate::push::dedupe_key`]) or a label with no `:` in it. `None`
/// when what is left is empty or holds a `:`: a key with a fourth part would be
/// refused by the log.
pub fn severe_dedupe_key(cell: &str, alert: &SevereAlert) -> Option<String> {
    let place = cell.strip_prefix("cell:").unwrap_or(cell);
    if place.is_empty() || place.contains(':') {
        return None;
    }
    Some(crate::push::dedupe_key(
        cell,
        KIND_SEVERE,
        &alert_token(&alert.sender, &alert.identifier),
    ))
}

/// A severe alert at `Extreme`, or `Severe` and `Immediate`, is a safety matter
/// that bypasses quiet hours (as severe frost does) and asks the push service to
/// wake the device. The rest are pushed in quiet hours' respect and `normal`.
pub fn bypasses_quiet_hours(alert: &SevereAlert) -> bool {
    alert.severity == CapSeverity::Extreme
        || (alert.severity == CapSeverity::Severe && alert.urgency == CapUrgency::Immediate)
}

/// Why no push options could be built.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SevereOptionsError {
    /// The alert has ended: there is nothing left to hold a message for.
    Expired,
    /// The token does not make a valid `Topic`.
    Invalid,
}

/// The push options for one alert, planned at `now`.
///
/// **TTL.** The message expires with the alert: where [`evaluate_severe`] would
/// say [`Skip::Expired`], at most [`MAX_PUSH_TTL_SECONDS`]. A warning held by a
/// phone that is off is dropped when it is over, not shown hours late as if it
/// were current.
///
/// **Urgency.** `high` for [`bypasses_quiet_hours`], otherwise `normal`.
///
/// **Topic.** `sv-` and the alert token (23 characters).
pub fn severe_push_options(
    alert: &SevereAlert,
    now: DateTime<Utc>,
) -> Result<PushOptions, SevereOptionsError> {
    let left = alert.expires.timestamp() - now.timestamp();
    if left <= 0 {
        return Err(SevereOptionsError::Expired);
    }
    let topic = crate::push::topic_for("sv", &alert_token(&alert.sender, &alert.identifier))
        .ok_or(SevereOptionsError::Invalid)?;
    Ok(PushOptions {
        ttl_seconds: u32::try_from(left)
            .unwrap_or(MAX_PUSH_TTL_SECONDS)
            .min(MAX_PUSH_TTL_SECONDS),
        urgency: if bypasses_quiet_hours(alert) {
            Urgency::High
        } else {
            Urgency::Normal
        },
        topic,
    })
}

/// `s` without control characters, cut to `max` characters (not bytes, so a
/// multi-byte character is never split), with an ellipsis when cut.
fn tidy(s: &str, max: usize) -> String {
    let flat: String = s
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        return flat;
    }
    let mut out: String = flat.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// The message. Plain text only (the service worker shows it with the
/// Notification API, which does not read markup). It names the authority and
/// sends the person to the app for the details; it does not say what to do
/// (the authority's text may), and does not claim to be complete or promise
/// delivery. `night` carries a ten-character alert token, from which the
/// service worker builds its notification tag, so two alerts for one place on
/// one day are two notifications and the second never replaces the first.
pub fn severe_payload(place_name: &str, slug: &str, alert: &SevereAlert) -> Payload {
    let event = tidy(&alert.event, 60);
    let place = tidy(place_name, 40);
    let what = match alert.headline.as_deref().map(|h| tidy(h, 120)) {
        Some(h) if !h.is_empty() => h,
        _ => event.clone(),
    };
    let mut body = String::new();
    let _ = write!(
        body,
        "{what}. Issued by {}. Open for details.",
        tidy(&alert.source, 60)
    );
    let mut token = alert_token(&alert.sender, &alert.identifier);
    token.truncate(PAYLOAD_TOKEN_LEN);
    Payload {
        v: 1,
        kind: KIND_SEVERE,
        slug: slug.to_string(),
        night: token,
        title: tidy(&format!("{event} for {place}"), 90),
        body,
        url: format!("/{slug}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn t(h: i64) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 4, 12, 0, 0).unwrap() + chrono::Duration::hours(h)
    }

    /// Harare is at about (-17.83, 31.05). A box around it.
    const HARARE: (f64, f64) = (-17.83, 31.05);

    fn harare_box() -> CapArea {
        CapArea {
            polygons: vec![
                parse_polygon("-17.5,30.7 -17.5,31.4 -18.2,31.4 -18.2,30.7 -17.5,30.7").unwrap(),
            ],
            circles: vec![],
        }
    }

    fn alert() -> CapAlert {
        CapAlert {
            identifier: "ZW-MSD-2026-1104-001".into(),
            sender: "msd@weatherzw.org.zw".into(),
            sent: t(-1),
            status: CapStatus::Actual,
            msg_type: CapMsgType::Alert,
            scope: CapScope::Public,
            categories: vec![CapCategory::Met],
            event: "Severe thunderstorm".into(),
            severity: CapSeverity::Severe,
            urgency: CapUrgency::Expected,
            certainty: CapCertainty::Likely,
            effective: Some(t(0)),
            expires: Some(t(6)),
            headline: Some("Severe thunderstorms with heavy rain expected".into()),
            area_desc: "Harare and Mashonaland East".into(),
            areas: vec![harare_box()],
            source: "Zimbabwe: Meteorological Services Department".into(),
        }
    }

    fn ok(a: &CapAlert) -> SevereAlert {
        evaluate_severe(a, HARARE.0, HARARE.1, t(0)).expect("eligible")
    }

    fn skip(a: &CapAlert) -> Skip {
        evaluate_severe(a, HARARE.0, HARARE.1, t(0)).expect_err("skipped")
    }

    #[test]
    fn the_baseline_alert_is_pushed() {
        let s = ok(&alert());
        assert_eq!(s.severity, CapSeverity::Severe);
        assert_eq!(s.expires, t(6));
        assert!(!s.is_update);
    }

    #[test]
    fn parsing_uses_the_standards_spelling_only() {
        for v in CapSeverity::ALL {
            assert_eq!(CapSeverity::parse(v.as_str()), Some(*v));
        }
        for v in CapUrgency::ALL {
            assert_eq!(CapUrgency::parse(v.as_str()), Some(*v));
        }
        for v in CapCategory::ALL {
            assert_eq!(CapCategory::parse(v.as_str()), Some(*v));
        }
        assert_eq!(CapCategory::parse("CBRNE"), Some(CapCategory::Cbrne));
        // Case-sensitive, no trimming, no guessing.
        assert_eq!(CapSeverity::parse("severe"), None);
        assert_eq!(CapSeverity::parse("SEVERE"), None);
        assert_eq!(CapSeverity::parse(" Severe"), None);
        assert_eq!(CapStatus::parse("actual"), None);
        assert_eq!(CapCertainty::parse("Very Likely"), None);
        assert_eq!(parse_certainty("Very Likely"), Some(CapCertainty::Likely));
        assert_eq!(parse_certainty("Observed"), Some(CapCertainty::Observed));
    }

    #[test]
    fn each_gate_has_its_own_reason() {
        let mut a = alert();
        a.status = CapStatus::Test;
        assert_eq!(skip(&a), Skip::NotActual);
        for s in [CapStatus::Exercise, CapStatus::System, CapStatus::Draft] {
            a.status = s;
            assert_eq!(skip(&a), Skip::NotActual);
        }

        let mut a = alert();
        a.scope = CapScope::Restricted;
        assert_eq!(skip(&a), Skip::NotPublic);

        for m in [CapMsgType::Cancel, CapMsgType::Ack, CapMsgType::Error] {
            let mut a = alert();
            a.msg_type = m;
            assert_eq!(skip(&a), Skip::NotAnAlert);
        }

        let mut a = alert();
        a.categories = vec![CapCategory::Fire, CapCategory::Health];
        assert_eq!(skip(&a), Skip::NotWeather);
        a.categories = vec![];
        assert_eq!(skip(&a), Skip::NotWeather);
        a.categories = vec![CapCategory::Fire, CapCategory::Met];
        ok(&a);

        for s in [
            CapSeverity::Moderate,
            CapSeverity::Minor,
            CapSeverity::Unknown,
        ] {
            let mut a = alert();
            a.severity = s;
            assert_eq!(skip(&a), Skip::BelowSeverity);
        }
        for u in [CapUrgency::Future, CapUrgency::Past, CapUrgency::Unknown] {
            let mut a = alert();
            a.urgency = u;
            assert_eq!(skip(&a), Skip::NotImminent);
        }
        for c in [
            CapCertainty::Possible,
            CapCertainty::Unlikely,
            CapCertainty::Unknown,
        ] {
            let mut a = alert();
            a.certainty = c;
            assert_eq!(skip(&a), Skip::NotLikely);
        }
    }

    #[test]
    fn exactly_the_sixteen_eligible_combinations_are_pushed() {
        let mut pushed = 0;
        for &status in CapStatus::ALL {
            for &scope in CapScope::ALL {
                for &msg in CapMsgType::ALL {
                    for &sev in CapSeverity::ALL {
                        for &urg in CapUrgency::ALL {
                            for &cert in CapCertainty::ALL {
                                let mut a = alert();
                                a.status = status;
                                a.scope = scope;
                                a.msg_type = msg;
                                a.severity = sev;
                                a.urgency = urg;
                                a.certainty = cert;
                                let want = status == CapStatus::Actual
                                    && scope == CapScope::Public
                                    && matches!(msg, CapMsgType::Alert | CapMsgType::Update)
                                    && matches!(sev, CapSeverity::Extreme | CapSeverity::Severe)
                                    && matches!(urg, CapUrgency::Immediate | CapUrgency::Expected)
                                    && matches!(
                                        cert,
                                        CapCertainty::Observed | CapCertainty::Likely
                                    );
                                let got = evaluate_severe(&a, HARARE.0, HARARE.1, t(0)).is_ok();
                                assert_eq!(
                                    got, want,
                                    "{status:?} {scope:?} {msg:?} {sev:?} {urg:?} {cert:?}"
                                );
                                pushed += usize::from(got);
                            }
                        }
                    }
                }
            }
        }
        assert_eq!(pushed, 16);
    }

    #[test]
    fn an_update_is_marked_and_pushed() {
        let mut a = alert();
        a.msg_type = CapMsgType::Update;
        assert!(ok(&a).is_update);
    }

    #[test]
    fn time_rules() {
        let mut a = alert();
        a.expires = None;
        assert_eq!(skip(&a), Skip::NoExpiry);

        let mut a = alert();
        a.expires = Some(t(0));
        assert_eq!(skip(&a), Skip::Expired);
        a.expires = Some(t(-3));
        assert_eq!(skip(&a), Skip::Expired);

        // Effective in 5 hours: pushed now. In 7 hours: a later tick.
        let mut a = alert();
        a.effective = Some(t(5));
        a.expires = Some(t(10));
        ok(&a);
        a.effective = Some(t(7));
        a.expires = Some(t(12));
        assert_eq!(skip(&a), Skip::NotYet);
        // Exactly at the lead is still sent; a second past is not.
        a.effective = Some(t(6));
        ok(&a);
        a.effective = Some(t(6) + chrono::Duration::seconds(1));
        assert_eq!(skip(&a), Skip::NotYet);

        // No `effective` means `sent`.
        let mut a = alert();
        a.effective = None;
        a.sent = t(-2);
        assert_eq!(ok(&a).effective, t(-2));

        // Ends before it starts, or `sent` far in the future: malformed.
        let mut a = alert();
        a.effective = Some(t(5));
        a.expires = Some(t(3));
        assert_eq!(skip(&a), Skip::Invalid);
        let mut a = alert();
        a.sent = t(48);
        assert_eq!(skip(&a), Skip::Invalid);
    }

    #[test]
    fn untrusted_text_fields_and_points_are_checked() {
        for bad in ["", "   ", "\t \n", "a\u{0}b", "line\nbreak"] {
            let mut a = alert();
            a.identifier = bad.into();
            assert_eq!(skip(&a), Skip::Invalid, "{bad:?}");
            let mut a = alert();
            a.sender = bad.into();
            assert_eq!(skip(&a), Skip::Invalid, "{bad:?}");
        }
        let mut a = alert();
        a.identifier = "x".repeat(MAX_ID_LEN + 1);
        assert_eq!(skip(&a), Skip::Invalid);
        a.identifier = "x".repeat(MAX_ID_LEN);
        ok(&a);

        for (la, lo) in [
            (f64::NAN, 31.0),
            (-17.0, f64::INFINITY),
            (91.0, 0.0),
            (0.0, 181.0),
        ] {
            assert_eq!(
                evaluate_severe(&alert(), la, lo, t(0)),
                Err(Skip::Invalid),
                "{la} {lo}"
            );
        }
    }

    #[test]
    fn a_message_needs_an_event_and_an_authority() {
        for blank in ["", "  ", "\t"] {
            let mut a = alert();
            a.event = blank.into();
            assert_eq!(skip(&a), Skip::Invalid, "event {blank:?}");
            let mut a = alert();
            a.source = blank.into();
            assert_eq!(skip(&a), Skip::Invalid, "source {blank:?}");
        }
        // A missing headline is fine: the event stands in.
        let mut a = alert();
        a.headline = None;
        ok(&a);
    }

    #[test]
    fn a_window_that_ends_before_it_starts_is_invalid_not_not_yet() {
        let mut a = alert();
        a.effective = Some(t(7));
        a.expires = Some(t(3));
        assert_eq!(skip(&a), Skip::Invalid);
        a.effective = Some(t(2));
        a.expires = Some(t(2));
        assert_eq!(skip(&a), Skip::Invalid);
    }

    #[test]
    fn a_geocode_only_area_beside_shapes_is_a_gap_not_a_no() {
        // Mutare's polygon, and a second area given only by geocodes.
        let mutare = CapArea {
            polygons: vec![
                parse_polygon("-18.8,32.5 -18.8,32.8 -19.1,32.8 -19.1,32.5 -18.8,32.5").unwrap(),
            ],
            circles: vec![],
        };
        let mut a = alert();
        a.areas = vec![mutare.clone(), CapArea::default()];
        // Harare is outside the one shape, but may be in the geocoded area.
        assert_eq!(skip(&a), Skip::AreaNotMatchable);
        // A point inside the shape is still a match.
        assert!(evaluate_severe(&a, -18.95, 32.65, t(0)).is_ok());
        // Without the unmatchable area it is a plain "outside".
        a.areas = vec![mutare];
        assert_eq!(skip(&a), Skip::OutsideArea);
    }

    #[test]
    fn a_large_polygon_is_judged_in_linear_time() {
        // 50,000 vertices all on the same two points is not a polygon, and
        // must be refused without a quadratic scan (a hang would fail here).
        let degenerate = vec![(-17.0, 31.0); MAX_VERTICES];
        let started = std::time::Instant::now();
        assert_eq!(polygon_contains(&degenerate, -17.5, 31.5), None);
        // A big real ring is judged correctly.
        let n = MAX_VERTICES;
        let ring: Vec<(f64, f64)> = (0..n)
            .map(|i| {
                let a = (i as f64) / (n as f64) * std::f64::consts::TAU;
                (-17.83 + 0.5 * a.sin(), 31.05 + 0.5 * a.cos())
            })
            .collect();
        assert_eq!(polygon_contains(&ring, -17.83, 31.05), Some(true));
        assert_eq!(polygon_contains(&ring, -19.5, 31.05), Some(false));
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    #[test]
    fn areas_inside_outside_and_unmatchable() {
        // Outside: Bulawayo is about 440 km south-west.
        assert_eq!(
            evaluate_severe(&alert(), -20.15, 28.58, t(0)),
            Err(Skip::OutsideArea)
        );
        // A geocode-only alert has no shape to test.
        let mut a = alert();
        a.areas = vec![CapArea::default()];
        assert_eq!(skip(&a), Skip::AreaNotMatchable);
        a.areas = vec![];
        assert_eq!(skip(&a), Skip::AreaNotMatchable);
        // A circle also matches.
        let mut a = alert();
        a.areas = vec![CapArea {
            polygons: vec![],
            circles: vec![(-17.83, 31.05, 25.0)],
        }];
        ok(&a);
        // Any one matching shape among several is enough.
        let mut a = alert();
        a.areas = vec![
            CapArea {
                polygons: vec![],
                circles: vec![(-20.15, 28.58, 20.0)],
            },
            harare_box(),
        ];
        ok(&a);
    }

    #[test]
    fn a_malformed_shape_is_invalid_never_a_quiet_outside() {
        let mut a = alert();
        a.areas = vec![CapArea {
            polygons: vec![vec![(-17.0, 31.0), (-17.0, 32.0)]],
            circles: vec![],
        }];
        assert_eq!(skip(&a), Skip::Invalid);
        a.areas = vec![CapArea {
            polygons: vec![vec![
                (f64::NAN, 31.0),
                (-17.0, 32.0),
                (-18.0, 32.0),
                (-17.0, 31.0),
            ]],
            circles: vec![],
        }];
        assert_eq!(skip(&a), Skip::Invalid);
        a.areas = vec![CapArea {
            polygons: vec![],
            circles: vec![(-17.0, 31.0, -5.0)],
        }];
        assert_eq!(skip(&a), Skip::Invalid);
        a.areas = vec![CapArea {
            polygons: vec![],
            circles: vec![(-17.0, 31.0, f64::NAN)],
        }];
        assert_eq!(skip(&a), Skip::Invalid);
        // Three copies of one point are not a polygon.
        a.areas = vec![CapArea {
            polygons: vec![vec![(-17.0, 31.0); 4]],
            circles: vec![],
        }];
        assert_eq!(skip(&a), Skip::Invalid);
    }

    #[test]
    fn the_bounds_fail_closed() {
        let ring = parse_polygon("-17.5,30.7 -17.5,31.4 -18.2,31.4 -18.2,30.7 -17.5,30.7").unwrap();
        let mut a = alert();
        a.areas = vec![CapArea {
            polygons: vec![ring.clone(); MAX_SHAPES],
            circles: vec![],
        }];
        ok(&a);
        a.areas = vec![CapArea {
            polygons: vec![ring.clone(); MAX_SHAPES + 1],
            circles: vec![],
        }];
        assert_eq!(skip(&a), Skip::Invalid);
        let big: Vec<(f64, f64)> = (0..MAX_VERTICES + 1)
            .map(|i| (-17.5 - (i % 2) as f64 * 0.1, 30.7 + (i as f64) * 1e-5))
            .collect();
        a.areas = vec![CapArea {
            polygons: vec![big],
            circles: vec![],
        }];
        assert_eq!(skip(&a), Skip::Invalid);
    }

    #[test]
    fn polygons_a_walk_against_a_box() {
        // A 1 x 1 degree box; walk a grid around and across it and compare with
        // the obvious bounds test (boundary inclusive).
        let ring = vec![(0.0, 0.0), (0.0, 1.0), (1.0, 1.0), (1.0, 0.0), (0.0, 0.0)];
        for i in -10..=20 {
            for j in -10..=20 {
                let (lat, lon) = (f64::from(i) / 10.0, f64::from(j) / 10.0);
                let want = (0.0..=1.0).contains(&lat) && (0.0..=1.0).contains(&lon);
                assert_eq!(polygon_contains(&ring, lat, lon), Some(want), "{lat} {lon}");
            }
        }
    }

    #[test]
    fn polygons_concave_and_the_antimeridian() {
        // A "U": the notch between the arms is outside.
        let u = vec![
            (0.0, 0.0),
            (0.0, 3.0),
            (2.0, 3.0),
            (2.0, 2.0),
            (1.0, 2.0),
            (1.0, 1.0),
            (2.0, 1.0),
            (2.0, 0.0),
            (0.0, 0.0),
        ];
        assert_eq!(polygon_contains(&u, 0.5, 0.5), Some(true));
        assert_eq!(polygon_contains(&u, 0.5, 2.5), Some(true));
        assert_eq!(polygon_contains(&u, 1.5, 1.5), Some(false));
        assert_eq!(polygon_contains(&u, 1.5, 0.5), Some(true));

        // A box that straddles the antimeridian: 179 E to 179 W.
        let fiji = vec![
            (-17.0, 179.0),
            (-17.0, -179.0),
            (-19.0, -179.0),
            (-19.0, 179.0),
            (-17.0, 179.0),
        ];
        assert_eq!(polygon_contains(&fiji, -18.0, 179.5), Some(true));
        assert_eq!(polygon_contains(&fiji, -18.0, -179.5), Some(true));
        assert_eq!(polygon_contains(&fiji, -18.0, 180.0), Some(true));
        assert_eq!(polygon_contains(&fiji, -18.0, 178.0), Some(false));
        assert_eq!(polygon_contains(&fiji, -18.0, -178.0), Some(false));
        assert_eq!(polygon_contains(&fiji, -18.0, 0.0), Some(false));
        assert_eq!(polygon_contains(&fiji, -18.0, 90.0), Some(false));

        // A ring around the pole does not close after unwrapping: refused.
        let polar = vec![
            (80.0, 0.0),
            (80.0, 90.0),
            (80.0, 180.0),
            (80.0, -90.0),
            (80.0, 0.0),
        ];
        assert_eq!(polygon_contains(&polar, 85.0, 10.0), None);
        let mut a = alert();
        a.areas = vec![CapArea {
            polygons: vec![polar],
            circles: vec![],
        }];
        assert_eq!(skip(&a), Skip::Invalid);
    }

    #[test]
    fn polygon_and_circle_text_follow_cap() {
        assert_eq!(
            parse_polygon("38.47,-120.14 38.34,-119.95 38.52,-119.74 38.62,-119.89 38.47,-120.14")
                .map(|p| p.len()),
            Some(5)
        );
        // Not closed, too short, not numbers, out of range, trailing junk.
        assert_eq!(parse_polygon("1,1 2,2 3,3 4,4"), None);
        assert_eq!(parse_polygon("1,1 2,2 1,1"), None);
        assert_eq!(parse_polygon("a,b 2,2 3,3 a,b"), None);
        assert_eq!(parse_polygon("91,0 2,2 3,3 91,0"), None);
        assert_eq!(parse_polygon("1,1 2,2 3,3 1,1,5"), None);
        assert_eq!(parse_polygon(""), None);

        assert_eq!(parse_circle("-17.83,31.05 25"), Some((-17.83, 31.05, 25.0)));
        assert_eq!(parse_circle("-17.83,31.05 0"), None);
        assert_eq!(parse_circle("-17.83,31.05 -3"), None);
        assert_eq!(parse_circle("-17.83,31.05"), None);
        assert_eq!(parse_circle("-17.83,31.05 25 7"), None);
        assert_eq!(parse_circle("-17.83,31.05 NaN"), None);
        assert_eq!(parse_circle("-17.83,31.05 99999"), None);
    }

    #[test]
    fn a_circle_includes_its_edge() {
        let d = crate::geo::haversine_km(0.0, 0.0, 0.0, 1.0);
        assert_eq!(circle_contains(0.0, 0.0, d, 0.0, 1.0), Some(true));
        assert_eq!(circle_contains(0.0, 0.0, d - 0.001, 0.0, 1.0), Some(false));
    }

    #[test]
    fn options_ttl_urgency_and_topic() {
        let a = ok(&alert());
        let o = severe_push_options(&a, t(0)).unwrap();
        assert_eq!(o.ttl_seconds, 6 * 3600);
        assert_eq!(o.urgency, Urgency::Normal);
        assert!(o.topic.starts_with("sv-"));
        assert!(o.topic.len() <= crate::push::MAX_TOPIC_LEN);
        assert!(o
            .topic
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        // No identifier, sender or place in the topic.
        assert!(!o.topic.contains("ZW-MSD"));
        assert!(!o.topic.contains("msd"));

        // The TTL falls as time passes, and is capped at 36 hours.
        assert_eq!(severe_push_options(&a, t(5)).unwrap().ttl_seconds, 3600);
        let mut long = a.clone();
        long.expires = t(0) + chrono::Duration::days(5);
        assert_eq!(
            severe_push_options(&long, t(0)).unwrap().ttl_seconds,
            MAX_PUSH_TTL_SECONDS
        );
        // Ended: nothing is built.
        assert_eq!(
            severe_push_options(&a, t(6)),
            Err(SevereOptionsError::Expired)
        );
        assert_eq!(
            severe_push_options(&a, t(9)),
            Err(SevereOptionsError::Expired)
        );

        // One alert, one topic; another alert, another topic.
        let mut b = alert();
        b.identifier = "ZW-MSD-2026-1104-002".into();
        let ob = severe_push_options(&ok(&b), t(0)).unwrap();
        assert_ne!(o.topic, ob.topic);
        assert_eq!(
            o.topic,
            severe_push_options(&ok(&alert()), t(1)).unwrap().topic
        );
    }

    #[test]
    fn urgency_is_high_only_for_the_gravest() {
        for (sev, urg, high) in [
            (CapSeverity::Extreme, CapUrgency::Immediate, true),
            (CapSeverity::Extreme, CapUrgency::Expected, true),
            (CapSeverity::Severe, CapUrgency::Immediate, true),
            (CapSeverity::Severe, CapUrgency::Expected, false),
        ] {
            let mut a = alert();
            a.severity = sev;
            a.urgency = urg;
            let s = ok(&a);
            assert_eq!(bypasses_quiet_hours(&s), high, "{sev:?} {urg:?}");
            let o = severe_push_options(&s, t(0)).unwrap();
            assert_eq!(o.urgency == Urgency::High, high);
        }
    }

    #[test]
    fn the_dedupe_key_has_the_apis_three_parts() {
        let s = ok(&alert());
        // The real cell key, as the plan passes it: `cell:` is dropped.
        let cell = crate::geo::cell_key(HARARE.0, HARARE.1);
        assert_eq!(cell, "cell:-17.85_31.05");
        let k = severe_dedupe_key(&cell, &s).expect("a key");
        let (c, kind, token) = crate::push::split_dedupe_key(&k).unwrap_or_else(|| panic!("{k}"));
        assert_eq!((c, kind), ("-17.85_31.05", KIND_SEVERE));
        assert_eq!(token.len(), TOKEN_LEN);
        assert!(token.bytes().all(|b| b.is_ascii_hexdigit()));
        // A label with no prefix is used as it is.
        let k2 = severe_dedupe_key("harare", &s).expect("a key");
        assert!(k2.starts_with("harare:severe:"));
        // Stable for one alert, distinct for two, distinct per sender.
        assert_eq!(k, severe_dedupe_key(&cell, &ok(&alert())).unwrap());
        let mut b = alert();
        b.identifier = "other".into();
        assert_ne!(k, severe_dedupe_key(&cell, &ok(&b)).unwrap());
        let mut c = alert();
        c.sender = "other@example.org".into();
        assert_ne!(k, severe_dedupe_key(&cell, &ok(&c)).unwrap());
        // A cell that would make a fourth part, or nothing, is refused.
        for bad in ["", "cell:", "a:b", "cell:-17.85:31.05"] {
            assert_eq!(severe_dedupe_key(bad, &s), None, "{bad:?}");
        }
        // `a\nb` + `c` and `a` + `b\nc` can not collide: control characters are refused.
    }

    #[test]
    fn the_payload_names_the_authority_and_stays_plain() {
        let s = ok(&alert());
        let p = severe_payload("Harare", "harare", &s);
        assert_eq!(p.kind, "severe");
        assert_eq!(p.slug, "harare");
        assert_eq!(p.url, "/harare");
        assert_eq!(p.night.len(), PAYLOAD_TOKEN_LEN);
        assert_eq!(p.title, "Severe thunderstorm for Harare");
        assert!(p
            .body
            .starts_with("Severe thunderstorms with heavy rain expected."));
        assert!(p
            .body
            .contains("Issued by Zimbabwe: Meteorological Services Department."));
        assert!(p.body.ends_with("Open for details."));
        let lower = p.body.to_lowercase();
        for banned in ["guarantee", "will be delivered", "stay safe", "you must"] {
            assert!(!lower.contains(banned), "{banned}");
        }
        // Two alerts for one place get different notification tags.
        let mut b = alert();
        b.identifier = "ZW-MSD-2026-1104-002".into();
        assert_ne!(p.night, severe_payload("Harare", "harare", &ok(&b)).night);
    }

    #[test]
    fn payload_text_is_cleaned_and_cut_by_characters() {
        let mut a = alert();
        a.event = "Hail\u{0}\nstorm\t\u{7}".into();
        a.headline = None;
        let p = severe_payload("Harare", "harare", &ok(&a));
        assert_eq!(p.title, "Hail storm for Harare");
        assert!(p.body.starts_with("Hail storm. Issued by"));
        assert!(!p.title.chars().any(char::is_control));
        assert!(!p.body.chars().any(char::is_control));

        // A long headline of multi-byte characters is cut on a character boundary.
        let mut a = alert();
        a.headline = Some("é".repeat(400));
        a.event = "ü".repeat(300);
        let p = severe_payload(&"ñ".repeat(200), "harare", &ok(&a));
        assert!(p.title.chars().count() <= 90);
        assert!(p.body.chars().count() <= 120 + 80 + 30);
        assert!(p.body.contains('…'));
        // An empty headline falls back to the event.
        let mut a = alert();
        a.headline = Some("   ".into());
        assert!(severe_payload("Harare", "harare", &ok(&a))
            .body
            .starts_with("Severe thunderstorm."));
    }

    #[test]
    fn skip_reasons_are_stable_distinct_words() {
        let all = [
            Skip::Invalid,
            Skip::NotActual,
            Skip::NotPublic,
            Skip::NotAnAlert,
            Skip::NotWeather,
            Skip::BelowSeverity,
            Skip::NotImminent,
            Skip::NotLikely,
            Skip::NoExpiry,
            Skip::Expired,
            Skip::NotYet,
            Skip::AreaNotMatchable,
            Skip::OutsideArea,
        ];
        let words: std::collections::BTreeSet<&str> = all.iter().map(|s| s.as_str()).collect();
        assert_eq!(words.len(), all.len());
        assert!(words
            .iter()
            .all(|w| w.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')));
    }
}
