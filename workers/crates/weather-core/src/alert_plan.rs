//! The frost alert PLAN: what one evaluation tick would do for one place
//! (mukoko-dev/mukoko-weather#289, step d, the pure half).
//!
//! The jobs Worker's tick will read a place's forecast, ask the Nyuchi API who
//! follows that place, call [`plan_frost`] and act on the answer. Everything
//! that DECIDES is here and nothing that DOES: no network, no clock (the
//! caller passes `now`), no binding, no key. A plan cannot send anything. It
//! lists, for every target it was given, either the one alert a sender may
//! attempt to claim and send, or the reason that target gets nothing.
//!
//! **One source for each decision.** The alert is raised by
//! [`push::evaluate_frost`] from the forecast alone (never from a seasonal
//! estimate), a station near the place can only add a sentence to it
//! ([`station_alert::join_frost`]), the copy is
//! [`station_alert::frost_payload_with_evidence`] (which is
//! [`push::frost_payload`] unless a station confirmed it), the key is
//! [`push::dedupe_key`], and what to do with each person is [`push::decide`]
//! (preferences, staleness, dedupe, rate caps, quiet hours, in that order).
//! This module adds only what those do not know: whether the target is
//! active, whether its record is well formed, a target given twice, and a
//! bound on one tick's work.
//!
//! **Properties the tests hold.**
//!
//! - *Fail closed.* A malformed place, preference record or target id sends
//!   nothing. An inactive subscription is never planned.
//! - *Deterministic and order independent.* Entries are sorted by target id,
//!   so the same targets in any order give the same plan.
//! - *Idempotent.* The dedupe key is `{cell}:frost:{night}`. It does not
//!   depend on `now` or on the target, so planning the same inputs twice, or
//!   again on the next tick of the same night, gives the same key. The plan is
//!   NOT what stops a second push: the delivery log is. A [`PlannedSend`]
//!   only authorises an attempt to claim `dedupe_key` in the log, and a send
//!   happens only after that claim succeeds (a 201, or a 200 that was
//!   `updated` or `queued`).
//! - *No personal data.* A target is an opaque id of `[A-Za-z0-9_-]`, which
//!   alone keeps an endpoint URL or an email address out of a plan (pass a
//!   hash such as `push::endpoint_id`, never the endpoint). The plan never
//!   echoes a target's preferences. An id that fails the check is counted in
//!   [`FrostPlan::invalid_targets`] and never copied into the plan.
//! - *No promise.* The copy is the existing payload copy, which promises
//!   nothing about delivery (a push service may drop, delay or never deliver
//!   a message; the in-app inbox is the record).
//!
//! **What a send asks of the push service.** Each [`PlannedSend`] carries its
//! [`PushOptions`] ([`push::frost_push_options`]): a `TTL` that ends the
//! message with its night (09:00 local the next morning; a "tonight" alert is
//! worth nothing after that), `Urgency: high` for severe frost and `normal`
//! otherwise, and a `Topic` derived from the dedupe key so a retry replaces
//! the copy a push service still holds. They come from the same `now` as the
//! rest of the plan, so planning the same inputs twice still gives the same
//! plan, while a later tick of the same night has a shorter TTL and the same
//! key and topic. A night that is already over gives no options and so no
//! send ([`Skip::Stale`]).
//!
//! **Not here, on purpose.** Severe-weather alerts (frost only), the
//! delivery-log claim itself, the guard that a batch in which every send is
//! `Expired` deactivates nothing, and every call to the Nyuchi API or a push
//! service.
//!
//! The two bounds below are ours, untuned: no standard names them, and they
//! should follow the Worker's subrequest budget once the tick exists.

use chrono::{DateTime, Timelike, Utc};

use crate::push::{
    self, AlertPrefs, Decision, DecisionInput, Payload, PushOptions, MAX_PUSHES_PER_DAY,
};
use crate::station_alert::{self, Confirmation, JoinedFrost, PlaceSite, StationReading};

/// The alert kind in the dedupe key and the delivery log.
pub const KIND_FROST: &str = "frost";
/// At most this many targets are planned for one place in one tick. More
/// targets than this are counted in [`FrostPlan::unplanned_targets`], not
/// listed. The caller's list is already bounded by the Nyuchi API; this
/// bounds the planner's own work whatever it is handed.
pub const MAX_TARGETS_PER_PLACE: usize = 1000;
/// At most this many [`Action::Send`] entries in one plan. A target that would
/// be the next is [`Skip::TickLimit`], and is planned again on the next tick
/// (the ones already sent are then `AlreadySent` and no longer take a slot, so
/// nobody starves).
pub const MAX_SENDS_PER_PLACE: usize = 200;
/// The longest target id.
pub const MAX_TARGET_ID_LEN: usize = 128;

/// Where and what the forecast says, for one place, at one moment.
#[derive(Debug, Clone, Copy)]
pub struct PlaceInput<'a> {
    /// The place's slug (`valid_slug`): matched against each person's
    /// followed places and the page the push opens.
    pub slug: &'a str,
    /// The display name for the title, 1 to 80 characters, no control
    /// characters.
    pub name: &'a str,
    /// The place's grid cell (`geo::cell_key`, e.g. `cell:-17.85_31.05`): the
    /// first part of the dedupe key.
    pub cell: &'a str,
    /// `X-Weather-Provider` of the forecast the series came from. A seasonal
    /// estimate never raises an alert.
    pub provider: &'a str,
    /// The forecast hours as local wall-clock `YYYY-MM-DDTHH:MM`.
    pub times: &'a [String],
    /// Air temperature (C) for each of `times`.
    pub temps: &'a [f64],
    /// The instant the tick runs at.
    pub now: DateTime<Utc>,
    /// The place's UTC offset (Open-Meteo `utc_offset_seconds`), -12 to +14
    /// hours. The local "now" is `now` plus this; there is one clock.
    pub utc_offset_seconds: i32,
    /// Registered stations near the place, when the tick has readings. Only
    /// ever evidence for an alert the forecast already raised.
    pub stations: Option<StationInput<'a>>,
}

/// Station readings near a place (see `station_alert`).
#[derive(Debug, Clone, Copy)]
pub struct StationInput<'a> {
    pub place: PlaceSite,
    pub readings: &'a [StationReading],
}

/// One destination for an alert, as the Nyuchi API's alert-targets route
/// describes it once the caller has joined the counts. Targets of the same
/// person carry the same counts: the caps are per person, and counting them is
/// the caller's job.
#[derive(Debug, Clone, PartialEq)]
pub struct AlertTarget {
    /// An opaque id of `[A-Za-z0-9_-]`, 1 to [`MAX_TARGET_ID_LEN`] characters,
    /// unique within a plan. A hash, never an endpoint, an email or a name.
    pub id: String,
    pub prefs: AlertPrefs,
    /// Whether the subscription is active. An inactive one is never planned.
    pub active: bool,
    /// Whether the delivery log already holds this alert for this person. The
    /// caller says `false` when it does not know: the claim is the authority.
    pub already_sent_this_night: bool,
    /// Pushes to this person today (the place's local day).
    pub sent_today: u32,
    /// Pushes of this kind to this person tonight.
    pub sent_kind_tonight: u32,
}

/// What the forecast (and the stations) said about the place.
#[derive(Debug, Clone, PartialEq)]
pub enum PlaceVerdict {
    /// A frost night is ahead. The alert is the forecast's, untouched; the
    /// confirmation is only evidence.
    Frost(Box<JoinedFrost>),
    /// No frost hour in the next 24.
    NoFrost,
    /// The series is a seasonal estimate, not a forecast.
    EstimateProvider,
    /// The slug, name, cell, offset or time was not usable. Nothing is sent.
    InvalidPlace,
}

/// Why a target gets nothing from this plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skip {
    /// The place has no frost ahead.
    NoFrost,
    /// The forecast is a seasonal estimate.
    EstimateProvider,
    /// The place input was malformed.
    InvalidPlace,
    /// The subscription is not active.
    Inactive,
    /// The preference record is malformed (`AlertPrefs::validate`).
    BadPreferences,
    /// The person has not turned frost alerts on, or does not follow the place.
    NotWanted,
    /// The night the alert is about is over; it is dropped, not held.
    Stale,
    /// The delivery log already holds this alert for this person.
    AlreadySent,
    /// The person has had `MAX_PUSHES_PER_DAY` today.
    DailyCap,
    /// The person has had `MAX_PUSHES_PER_KIND_PER_NIGHT` of this kind tonight.
    NightCap,
    /// Quiet hours (moderate and high frost only). A later tick may send.
    QuietHours,
    /// The same target id was given more than once: ambiguous, so nothing is
    /// sent for it.
    DuplicateTarget,
    /// More sends than [`MAX_SENDS_PER_PLACE`]; planned again next tick.
    TickLimit,
}

impl Skip {
    /// A stable snake_case code for logs and counters.
    pub fn code(self) -> &'static str {
        match self {
            Skip::NoFrost => "no_frost",
            Skip::EstimateProvider => "estimate_provider",
            Skip::InvalidPlace => "invalid_place",
            Skip::Inactive => "inactive",
            Skip::BadPreferences => "bad_preferences",
            Skip::NotWanted => "not_wanted",
            Skip::Stale => "stale",
            Skip::AlreadySent => "already_sent",
            Skip::DailyCap => "daily_cap",
            Skip::NightCap => "night_cap",
            Skip::QuietHours => "quiet_hours",
            Skip::DuplicateTarget => "duplicate_target",
            Skip::TickLimit => "tick_limit",
        }
    }
}

/// An alert a sender may attempt to claim and send.
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedSend {
    /// `{cell}:frost:{night}` (`push::dedupe_key`).
    pub dedupe_key: String,
    pub payload: Payload,
    /// The `TTL`, `Urgency` and `Topic` of the push ([`push::frost_push_options`]):
    /// the message expires with its night, severe frost is `high`, and the
    /// topic follows the key. Fixed for the plan, so every target of one place
    /// asks the push service the same.
    pub options: PushOptions,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Send(PlannedSend),
    Skip(Skip),
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlanEntry {
    pub target_id: String,
    pub action: Action,
}

/// What one tick does for one place.
#[derive(Debug, Clone, PartialEq)]
pub struct FrostPlan {
    pub place: PlaceVerdict,
    /// One entry per distinct valid target id, sorted by id.
    pub entries: Vec<PlanEntry>,
    /// Targets whose id failed the check. Counted; never listed.
    pub invalid_targets: usize,
    /// Distinct targets beyond [`MAX_TARGETS_PER_PLACE`] (the last ids in
    /// order). Counted; never listed or planned.
    pub unplanned_targets: usize,
}

impl FrostPlan {
    /// The planned sends, in target id order.
    pub fn sends(&self) -> impl Iterator<Item = (&str, &PlannedSend)> {
        self.entries.iter().filter_map(|e| match &e.action {
            Action::Send(s) => Some((e.target_id.as_str(), s)),
            Action::Skip(_) => None,
        })
    }
}

fn is_target_id(id: &str) -> bool {
    (1..=MAX_TARGET_ID_LEN).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `cell:-17.85_31.05`-shaped: lower-case, digits and `: . _ -`.
fn is_cell_key(cell: &str) -> bool {
    !cell.is_empty()
        && cell.len() <= 64
        && cell.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b':' | b'.' | b'_' | b'-')
        })
}

fn is_display_name(name: &str) -> bool {
    let n = name.trim();
    !n.is_empty() && n.chars().count() <= 80 && !n.chars().any(char::is_control)
}

/// The place's local clock, read once.
struct Local {
    /// `YYYY-MM-DDTHH:MM`, the form `evaluate_frost` reads.
    time: String,
    /// `YYYY-MM-DD`.
    date: String,
    hour: u8,
}

fn local_now(now: DateTime<Utc>, utc_offset_seconds: i32) -> Option<Local> {
    let t = station_alert::local_time(now, utc_offset_seconds)?;
    Some(Local {
        time: t.format("%Y-%m-%dT%H:%M").to_string(),
        date: t.format("%Y-%m-%d").to_string(),
        hour: t.hour() as u8,
    })
}

fn place_is_valid(place: &PlaceInput) -> bool {
    push::validate_slug(place.slug).is_ok()
        && is_cell_key(place.cell)
        && is_display_name(place.name)
}

/// What the forecast says about the place, before any person is considered.
/// The tick can call this first and skip fetching targets when the answer is
/// not [`PlaceVerdict::Frost`].
pub fn assess_place(place: &PlaceInput) -> PlaceVerdict {
    let Some(local) = local_now(place.now, place.utc_offset_seconds) else {
        return PlaceVerdict::InvalidPlace;
    };
    if !place_is_valid(place) {
        return PlaceVerdict::InvalidPlace;
    }
    if push::is_estimate_provider(place.provider) {
        return PlaceVerdict::EstimateProvider;
    }
    let Some(alert) = push::evaluate_frost(place.provider, place.times, place.temps, &local.time)
    else {
        return PlaceVerdict::NoFrost;
    };
    let joined = match place.stations {
        Some(s) => station_alert::join_frost(
            Some(alert),
            &s.place,
            s.readings,
            place.now,
            place.utc_offset_seconds,
        ),
        None => Some(JoinedFrost {
            alert,
            confirmation: Confirmation::Unconfirmed,
        }),
    };
    match joined {
        Some(j) => PlaceVerdict::Frost(Box::new(j)),
        None => PlaceVerdict::NoFrost,
    }
}

/// The reason a verdict that is not a frost gives every target.
fn verdict_skip(verdict: &PlaceVerdict) -> Option<Skip> {
    match verdict {
        PlaceVerdict::Frost(_) => None,
        PlaceVerdict::NoFrost => Some(Skip::NoFrost),
        PlaceVerdict::EstimateProvider => Some(Skip::EstimateProvider),
        PlaceVerdict::InvalidPlace => Some(Skip::InvalidPlace),
    }
}

/// `Ok(())` when the target may be sent this alert, else the reason it may not.
fn judge(t: &AlertTarget, slug: &str, joined: &JoinedFrost, local: &Local) -> Result<(), Skip> {
    if !t.active {
        return Err(Skip::Inactive);
    }
    if t.prefs.validate().is_err() {
        return Err(Skip::BadPreferences);
    }
    let input = DecisionInput {
        prefs: &t.prefs,
        slug,
        risk: joined.alert.risk,
        local_hour: local.hour,
        local_date: &local.date,
        night: &joined.alert.night,
        already_sent_this_night: t.already_sent_this_night,
        sent_today: t.sent_today,
        sent_kind_tonight: t.sent_kind_tonight,
    };
    match push::decide(&input) {
        Decision::Send => Ok(()),
        Decision::HoldQuiet => Err(Skip::QuietHours),
        Decision::Duplicate => Err(Skip::AlreadySent),
        // `decide` checks the daily cap first; so does the reason.
        Decision::RateLimited if t.sent_today >= MAX_PUSHES_PER_DAY => Err(Skip::DailyCap),
        Decision::RateLimited => Err(Skip::NightCap),
        Decision::NotWanted => Err(Skip::NotWanted),
        Decision::Stale => Err(Skip::Stale),
    }
}

/// Plan one tick for one place: the verdict ([`assess_place`]) and, for each
/// distinct valid target in id order, either a [`PlannedSend`] or the
/// [`Skip`] reason. The place-level reason (no frost, an estimate, an invalid
/// place) comes before any per-target reason, so a plan with nothing to send
/// says why in the same way for everybody.
///
/// Targets are handled in three steps. An id that is not 1 to
/// [`MAX_TARGET_ID_LEN`] characters of `[A-Za-z0-9_-]` is counted and dropped.
/// The rest are sorted by id, and an id that appears more than once becomes ONE
/// [`Skip::DuplicateTarget`] entry (order independent, and nothing is sent on
/// ambiguous data). Then the first [`MAX_TARGETS_PER_PLACE`] are planned, and
/// sends beyond [`MAX_SENDS_PER_PLACE`] become [`Skip::TickLimit`].
pub fn plan_frost(place: &PlaceInput, targets: &[AlertTarget]) -> FrostPlan {
    let verdict = assess_place(place);

    let mut valid: Vec<&AlertTarget> = targets.iter().filter(|t| is_target_id(&t.id)).collect();
    let invalid_targets = targets.len() - valid.len();
    valid.sort_by(|a, b| a.id.cmp(&b.id));
    // (the target, whether its id appeared more than once)
    let mut distinct: Vec<(&AlertTarget, bool)> = Vec::new();
    for t in valid {
        match distinct.last_mut() {
            Some((prev, repeated)) if prev.id == t.id => *repeated = true,
            _ => distinct.push((t, false)),
        }
    }
    let unplanned_targets = distinct.len().saturating_sub(MAX_TARGETS_PER_PLACE);
    distinct.truncate(MAX_TARGETS_PER_PLACE);

    // Everything a send needs, built once. `None` means nothing can be sent.
    let local = local_now(place.now, place.utc_offset_seconds);
    let send = match (&verdict, &local) {
        (PlaceVerdict::Frost(joined), Some(_)) => {
            let dedupe_key = push::dedupe_key(place.cell, KIND_FROST, &joined.alert.night);
            // `None` when the night is already over: a push that would say
            // "tonight" about a night that has ended is never built.
            let planned = push::frost_push_options(
                &joined.alert,
                &dedupe_key,
                place.now,
                place.utc_offset_seconds,
            )
            .map(|options| PlannedSend {
                dedupe_key,
                payload: station_alert::frost_payload_with_evidence(
                    place.name.trim(),
                    place.slug,
                    joined,
                ),
                options,
            });
            Some((joined, planned))
        }
        _ => None,
    };

    let mut sends = 0usize;
    let mut entries = Vec::with_capacity(distinct.len());
    for (t, repeated) in distinct {
        let action = if repeated {
            Action::Skip(Skip::DuplicateTarget)
        } else if let Some(skip) = verdict_skip(&verdict) {
            Action::Skip(skip)
        } else {
            match (&send, &local) {
                (Some((joined, planned)), Some(local)) => {
                    match judge(t, place.slug, joined, local) {
                        Err(skip) => Action::Skip(skip),
                        // Its night is over, so nothing can be asked of a push
                        // service (`decide` drops these first; this is the
                        // fail-closed side of the same rule).
                        Ok(()) if planned.is_none() => Action::Skip(Skip::Stale),
                        Ok(()) if sends >= MAX_SENDS_PER_PLACE => Action::Skip(Skip::TickLimit),
                        Ok(()) => match planned {
                            Some(planned) => {
                                sends += 1;
                                Action::Send(planned.clone())
                            }
                            None => Action::Skip(Skip::Stale),
                        },
                    }
                }
                // A frost verdict always has both; if it ever did not, send nothing.
                _ => Action::Skip(Skip::InvalidPlace),
            }
        };
        entries.push(PlanEntry {
            target_id: t.id.clone(),
            action,
        });
    }

    FrostPlan {
        place: verdict,
        entries,
        invalid_targets,
        unplanned_targets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::external_feeds::SOURCE_SAAOPA;
    use crate::push::{FrostAlert, Risk, Urgency};
    use crate::station_alert::StationSite;
    use chrono::{Duration, NaiveDateTime};

    const OM: &str = "open-meteo:blend";
    /// Harare is UTC+2 all year.
    const HARARE_OFFSET: i32 = 2 * 3600;
    const CELL: &str = "cell:-17.85_31.05";
    const KEY_JUL10: &str = "cell:-17.85_31.05:frost:2026-07-10";

    /// 2026-07-10 18:00 to 2026-07-11 09:00 local, one value per hour. Frost
    /// hours (22:00 to 08:00 at or below 3 C): 22:00 3.0, 23:00 2.5, 00:00 2.0,
    /// 01:00 1.0, 02:00 -0.5, 03:00 0.0, 04:00 1.0, 05:00 2.0, 06:00 3.0.
    /// Lowest -0.5 is severe; the first frost hour is 22:00.
    const SEVERE: [f64; 16] = [
        9.0, 7.0, 5.0, 4.0, 3.0, 2.5, 2.0, 1.0, -0.5, 0.0, 1.0, 2.0, 3.0, 4.0, 6.0, 9.0,
    ];
    /// Same hours. Frost hours: 02:00 3.0 and 03:00 2.4. Lowest 2.4 is moderate.
    const MODERATE: [f64; 16] = [
        10.0, 9.0, 8.0, 7.0, 6.0, 5.0, 4.0, 3.5, 3.0, 2.4, 3.5, 4.0, 5.0, 6.0, 8.0, 10.0,
    ];

    fn naive(local: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(local, "%Y-%m-%dT%H:%M").unwrap()
    }

    /// Consecutive hourly local times from `start`, one per temperature.
    fn hourly(start: &str, temps: &[f64]) -> (Vec<String>, Vec<f64>) {
        let t0 = naive(start);
        let times = (0..temps.len() as i64)
            .map(|h| {
                (t0 + Duration::hours(h))
                    .format("%Y-%m-%dT%H:%M")
                    .to_string()
            })
            .collect();
        (times, temps.to_vec())
    }

    /// The UTC instant at which Harare's wall clock reads `local`.
    fn harare_at(local: &str) -> DateTime<Utc> {
        naive(local).and_utc() - Duration::seconds(i64::from(HARARE_OFFSET))
    }

    fn harare<'a>(times: &'a [String], temps: &'a [f64], local: &str) -> PlaceInput<'a> {
        PlaceInput {
            slug: "harare",
            name: "Harare",
            cell: CELL,
            provider: OM,
            times,
            temps,
            now: harare_at(local),
            utc_offset_seconds: HARARE_OFFSET,
            stations: None,
        }
    }

    /// Wants frost alerts for Harare, default quiet hours 22:00 to 06:00.
    fn target(id: &str) -> AlertTarget {
        AlertTarget {
            id: id.to_string(),
            prefs: AlertPrefs {
                frost: true,
                places: vec!["harare".to_string()],
                ..AlertPrefs::default()
            },
            active: true,
            already_sent_this_night: false,
            sent_today: 0,
            sent_kind_tonight: 0,
        }
    }

    fn skip(id: &str, why: Skip) -> PlanEntry {
        PlanEntry {
            target_id: id.to_string(),
            action: Action::Skip(why),
        }
    }

    fn actions(plan: &FrostPlan) -> Vec<(&str, Option<Skip>)> {
        plan.entries
            .iter()
            .map(|e| {
                let why = match &e.action {
                    Action::Send(_) => None,
                    Action::Skip(s) => Some(*s),
                };
                (e.target_id.as_str(), why)
            })
            .collect()
    }

    fn severe_payload() -> Payload {
        Payload {
            v: 1,
            kind: "frost",
            slug: "harare".into(),
            night: "2026-07-10".into(),
            title: "Frost alert for Harare".into(),
            body: "Severe frost expected tonight, down to -1°C. Protect sensitive crops.".into(),
            url: "/harare".into(),
        }
    }

    fn severe_alert() -> FrostAlert {
        FrostAlert {
            risk: Risk::Severe,
            lowest: -0.5,
            start: "2026-07-10T22:00".into(),
            end: "2026-07-11T06:00".into(),
            night: "2026-07-10".into(),
        }
    }

    /// The frozen vector: Harare, a severe frost night, 19:30 local on the
    /// evening it begins (17:30 UTC). Hand-computed:
    /// - alert: lowest -0.5 (22:00 to 06:00), severe, night 2026-07-10;
    /// - local hour 19, date 2026-07-10, so nobody is in the default quiet
    ///   window (22 to 6) and the night is not over;
    /// - copy: -0.5 rounds away from zero to -1, so "down to -1°C";
    /// - key: cell, "frost", night.
    #[test]
    fn a_severe_frost_evening_plans_the_sends_and_names_every_reason() {
        let (times, temps) = hourly("2026-07-10T18:00", &SEVERE);
        let place = harare(&times, &temps, "2026-07-10T19:30");
        assert_eq!(place.now.to_rfc3339(), "2026-07-10T17:30:00+00:00");

        let mut daily = target("t-02");
        daily.sent_today = 2;
        let mut night = target("t-03");
        night.sent_kind_tonight = 1;
        let mut inactive = target("t-04");
        inactive.active = false;
        let mut off = target("t-05");
        off.prefs.frost = false;
        let mut elsewhere = target("t-06");
        elsewhere.prefs.places = vec!["bulawayo".into()];
        let mut sent = target("t-07");
        sent.already_sent_this_night = true;
        // Severe frost ignores quiet hours; this person's are 18:00 to 21:00.
        let mut quiet = target("t-08");
        quiet.prefs.quiet_start = 18;
        quiet.prefs.quiet_end = 21;
        let mut broken = target("t-09");
        broken.prefs.quiet_start = 24;
        // Deliberately not in id order.
        let targets = vec![
            quiet,
            broken,
            inactive,
            target("t-01"),
            sent,
            elsewhere,
            night,
            off,
            daily,
        ];

        let plan = plan_frost(&place, &targets);

        let send = || {
            Action::Send(PlannedSend {
                dedupe_key: KEY_JUL10.to_string(),
                payload: severe_payload(),
                // 19:30 local to 09:00 local is 13.5 hours
                options: PushOptions {
                    ttl_seconds: 48_600,
                    urgency: Urgency::High,
                    topic: "frost-6e60291b482856a333062897b9".to_string(),
                },
            })
        };
        let entry = |id: &str, action: Action| PlanEntry {
            target_id: id.to_string(),
            action,
        };
        let expected = FrostPlan {
            place: PlaceVerdict::Frost(Box::new(JoinedFrost {
                alert: severe_alert(),
                confirmation: Confirmation::Unconfirmed,
            })),
            entries: vec![
                entry("t-01", send()),
                entry("t-02", Action::Skip(Skip::DailyCap)),
                entry("t-03", Action::Skip(Skip::NightCap)),
                entry("t-04", Action::Skip(Skip::Inactive)),
                entry("t-05", Action::Skip(Skip::NotWanted)),
                entry("t-06", Action::Skip(Skip::NotWanted)),
                entry("t-07", Action::Skip(Skip::AlreadySent)),
                entry("t-08", send()),
                entry("t-09", Action::Skip(Skip::BadPreferences)),
            ],
            invalid_targets: 0,
            unplanned_targets: 0,
        };
        assert_eq!(plan, expected);
        assert_eq!(
            plan.sends().map(|(id, _)| id).collect::<Vec<_>>(),
            ["t-01", "t-08"]
        );
    }

    /// Moderate frost (lowest 2.4 at 03:00, night 2026-07-10), hand-computed
    /// at three moments of the same local night.
    #[test]
    fn quiet_hours_hold_moderate_frost_and_the_morning_after_drops_it() {
        let (times, temps) = hourly("2026-07-10T18:00", &MODERATE);
        let mut no_quiet = target("t-02");
        no_quiet.prefs.quiet_start = 0;
        no_quiet.prefs.quiet_end = 0;
        let mut evening_quiet = target("t-03");
        evening_quiet.prefs.quiet_start = 20;
        evening_quiet.prefs.quiet_end = 23;
        let targets = vec![target("t-01"), no_quiet, evening_quiet];

        // 21:30 local: default quiet starts at 22:00, so t-01 sends; t-03 is
        // quiet 20:00 to 23:00 and waits.
        let at_2130 = plan_frost(&harare(&times, &temps, "2026-07-10T21:30"), &targets);
        assert_eq!(
            actions(&at_2130),
            [
                ("t-01", None),
                ("t-02", None),
                ("t-03", Some(Skip::QuietHours))
            ]
        );
        let (_, s) = at_2130.sends().next().unwrap();
        assert_eq!(s.dedupe_key, KEY_JUL10);
        assert_eq!(
            s.payload.body,
            "Frost risk tonight, down to 2°C. Cover sensitive plants."
        );

        // 23:10 local: t-01 (quiet 22 to 6) is held; t-02 has no quiet time;
        // t-03's quiet window (20 to 23) has ended, so it sends.
        let at_2310 = plan_frost(&harare(&times, &temps, "2026-07-10T23:10"), &targets);
        assert_eq!(
            actions(&at_2310),
            [
                ("t-01", Some(Skip::QuietHours)),
                ("t-02", None),
                ("t-03", None)
            ]
        );

        // 02:30 local the next day: the moderate frost is still ahead (03:00)
        // but the night it was raised for has begun to end; the copy says
        // "tonight", so a held alert is dropped, not delivered.
        let at_0230 = plan_frost(&harare(&times, &temps, "2026-07-11T02:30"), &targets);
        assert_eq!(
            actions(&at_0230),
            [
                ("t-01", Some(Skip::Stale)),
                ("t-02", Some(Skip::Stale)),
                ("t-03", Some(Skip::Stale))
            ]
        );
    }

    #[test]
    fn severe_frost_still_under_way_before_dawn_is_sent_through_quiet_hours() {
        let (times, temps) = hourly("2026-07-10T18:00", &SEVERE);
        // 02:30 local on the 11th: 03:00 (0.0 C) is still ahead, quiet hours
        // (22 to 6) are in force, the date is later than the night's.
        let plan = plan_frost(
            &harare(&times, &temps, "2026-07-11T02:30"),
            &[target("t-01")],
        );
        assert_eq!(actions(&plan), [("t-01", None)]);
        assert_eq!(plan.sends().next().unwrap().1.dedupe_key, KEY_JUL10);
    }

    #[test]
    fn the_daily_cap_is_two_and_the_night_cap_is_one() {
        let (times, temps) = hourly("2026-07-10T18:00", &SEVERE);
        let place = harare(&times, &temps, "2026-07-10T19:30");
        let with = |today: u32, tonight: u32| {
            let mut t = target("t-01");
            t.sent_today = today;
            t.sent_kind_tonight = tonight;
            actions(&plan_frost(&place, &[t]))[0].1
        };
        assert_eq!(with(0, 0), None);
        assert_eq!(with(1, 0), None);
        assert_eq!(with(MAX_PUSHES_PER_DAY - 1, 0), None);
        assert_eq!(with(MAX_PUSHES_PER_DAY, 0), Some(Skip::DailyCap));
        assert_eq!(with(MAX_PUSHES_PER_DAY + 7, 0), Some(Skip::DailyCap));
        assert_eq!(with(0, 1), Some(Skip::NightCap));
        assert_eq!(with(1, 1), Some(Skip::NightCap));
        // both reached: the daily cap is the one named, as `decide` checks it first
        assert_eq!(with(MAX_PUSHES_PER_DAY, 1), Some(Skip::DailyCap));
    }

    #[test]
    fn an_estimate_never_plans_a_send() {
        let (times, temps) = hourly("2026-07-10T18:00", &SEVERE);
        for provider in [
            "fallback",
            "Fallback",
            "seasonal-estimate",
            "estimate",
            "",
            "  ",
        ] {
            let place = PlaceInput {
                provider,
                ..harare(&times, &temps, "2026-07-10T19:30")
            };
            let plan = plan_frost(&place, &[target("t-01"), target("t-02")]);
            assert_eq!(plan.place, PlaceVerdict::EstimateProvider, "{provider:?}");
            assert_eq!(
                actions(&plan),
                [
                    ("t-01", Some(Skip::EstimateProvider)),
                    ("t-02", Some(Skip::EstimateProvider))
                ]
            );
            assert_eq!(plan.sends().count(), 0);
        }
        // a live second provider is a forecast
        let place = PlaceInput {
            provider: "met-no",
            ..harare(&times, &temps, "2026-07-10T19:30")
        };
        assert_eq!(plan_frost(&place, &[target("t-01")]).sends().count(), 1);
    }

    #[test]
    fn a_warm_night_plans_no_send_and_says_so() {
        let (times, temps) = hourly("2026-07-10T18:00", &[12.0; 16]);
        let place = harare(&times, &temps, "2026-07-10T19:30");
        assert_eq!(assess_place(&place), PlaceVerdict::NoFrost);
        let plan = plan_frost(&place, &[target("t-01")]);
        assert_eq!(actions(&plan), [("t-01", Some(Skip::NoFrost))]);
    }

    #[test]
    fn no_forecast_series_plans_no_send() {
        let place = harare(&[], &[], "2026-07-10T19:30");
        assert_eq!(assess_place(&place), PlaceVerdict::NoFrost);
        assert_eq!(plan_frost(&place, &[target("t-01")]).sends().count(), 0);
    }

    #[test]
    fn an_inactive_subscription_is_never_planned() {
        let (times, temps) = hourly("2026-07-10T18:00", &SEVERE);
        let place = harare(&times, &temps, "2026-07-10T19:30");
        let mut t = target("t-01");
        t.active = false;
        let plan = plan_frost(&place, &[t]);
        assert_eq!(plan.entries, [skip("t-01", Skip::Inactive)]);
        // and an inactive target is not hiding behind an unrelated reason
        let mut t = target("t-01");
        t.active = false;
        t.sent_today = 9;
        t.prefs.frost = false;
        assert_eq!(
            plan_frost(&place, &[t]).entries,
            [skip("t-01", Skip::Inactive)]
        );
    }

    #[test]
    fn malformed_preferences_send_nothing() {
        let (times, temps) = hourly("2026-07-10T18:00", &SEVERE);
        let place = harare(&times, &temps, "2026-07-10T19:30");
        let mut hours = target("t-01");
        hours.prefs.quiet_end = 99;
        let mut places = target("t-02");
        places.prefs.places = (0..11).map(|i| format!("p{i}")).collect();
        places.prefs.places.push("harare".into());
        let mut slug = target("t-03");
        slug.prefs.places.push("Not A Slug".into());
        let plan = plan_frost(&place, &[hours, places, slug]);
        assert_eq!(
            actions(&plan),
            [
                ("t-01", Some(Skip::BadPreferences)),
                ("t-02", Some(Skip::BadPreferences)),
                ("t-03", Some(Skip::BadPreferences))
            ]
        );
    }

    #[test]
    fn an_unusable_place_plans_nothing() {
        let (times, temps) = hourly("2026-07-10T18:00", &SEVERE);
        let base = harare(&times, &temps, "2026-07-10T19:30");
        assert_eq!(plan_frost(&base, &[target("t-01")]).sends().count(), 1);
        let bad = [
            PlaceInput {
                slug: "Har are",
                ..base
            },
            PlaceInput { slug: "", ..base },
            PlaceInput { cell: "", ..base },
            PlaceInput {
                cell: "cell:Harare/../x",
                ..base
            },
            PlaceInput {
                cell: &"c".repeat(65),
                ..base
            },
            PlaceInput {
                name: "   ",
                ..base
            },
            PlaceInput {
                name: "Har\nare",
                ..base
            },
            PlaceInput {
                name: &"H".repeat(81),
                ..base
            },
            PlaceInput {
                utc_offset_seconds: 14 * 3600 + 1,
                ..base
            },
            PlaceInput {
                utc_offset_seconds: -12 * 3600 - 1,
                ..base
            },
        ];
        for place in bad {
            let plan = plan_frost(&place, &[target("t-01")]);
            assert_eq!(plan.place, PlaceVerdict::InvalidPlace, "{place:?}");
            assert_eq!(plan.entries, [skip("t-01", Skip::InvalidPlace)]);
        }
        // the extremes that do exist are accepted
        for offset in [-12 * 3600, 14 * 3600] {
            let place = PlaceInput {
                utc_offset_seconds: offset,
                ..base
            };
            assert_ne!(assess_place(&place), PlaceVerdict::InvalidPlace, "{offset}");
        }
    }

    #[test]
    fn a_time_that_is_not_local_wall_clock_plans_nothing() {
        let (_, temps) = hourly("2026-07-10T18:00", &SEVERE);
        let zoned: Vec<String> = (0..16)
            .map(|h| format!("2026-07-10T{:02}:00Z", h + 8))
            .collect();
        let place = harare(&zoned, &temps, "2026-07-10T19:30");
        assert_eq!(plan_frost(&place, &[target("t-01")]).sends().count(), 0);
    }

    #[test]
    fn planning_twice_gives_the_same_plan_and_the_same_keys() {
        let (times, temps) = hourly("2026-07-10T18:00", &SEVERE);
        let place = harare(&times, &temps, "2026-07-10T19:30");
        let targets: Vec<AlertTarget> = (0..5).map(|i| target(&format!("t-{i}"))).collect();
        let first = plan_frost(&place, &targets);
        let second = plan_frost(&place, &targets);
        assert_eq!(first, second);
        let keys: Vec<&str> = first.sends().map(|(_, s)| s.dedupe_key.as_str()).collect();
        assert_eq!(keys, [KEY_JUL10; 5]);
    }

    #[test]
    fn every_tick_of_one_night_has_the_same_key_and_the_next_night_a_new_one() {
        // Two severe frost nights: 02:00 on the 11th and 02:00 on the 12th
        // (-1 C each, so quiet hours never hold them). Index 0 is 18:00 on the
        // 10th, so index 8 is 02:00 on the 11th and index 32 is 02:00 on the 12th.
        let mut series = vec![10.0; 40];
        series[8] = -1.0;
        series[32] = -1.0;
        let (times, temps) = hourly("2026-07-10T18:00", &series);
        let key_at = |local: &str| {
            let plan = plan_frost(&harare(&times, &temps, local), &[target("t-01")]);
            let key = plan.sends().next().map(|(_, s)| s.dedupe_key.clone());
            key
        };
        let night1 = Some("cell:-17.85_31.05:frost:2026-07-10".to_string());
        // 15-minute ticks through the evening and the small hours of one night:
        // `start` of the alert moves as hours pass, the key does not.
        for local in [
            "2026-07-10T18:00",
            "2026-07-10T18:15",
            "2026-07-10T21:45",
            "2026-07-10T23:00",
            "2026-07-11T00:15",
            "2026-07-11T01:45",
        ] {
            assert_eq!(key_at(local), night1, "{local}");
        }
        // after dawn on the 11th the next frost ahead is the night of the 11th
        let night2 = Some("cell:-17.85_31.05:frost:2026-07-11".to_string());
        assert_eq!(key_at("2026-07-11T09:15"), night2);
        assert_eq!(key_at("2026-07-11T18:15"), night2);
    }

    #[test]
    fn a_push_expires_with_its_night_and_keeps_the_same_topic_all_night() {
        // Moderate frost (lowest 2.4 at 03:00): `normal` urgency. The night of
        // the 10th ends 09:00 local on the 11th (07:00Z).
        let (times, temps) = hourly("2026-07-10T18:00", &MODERATE);
        let mut no_quiet = target("t-01");
        no_quiet.prefs.quiet_start = 0;
        no_quiet.prefs.quiet_end = 0;
        let options_at = |local: &str| {
            let plan = plan_frost(&harare(&times, &temps, local), &[no_quiet.clone()]);
            let options = plan.sends().next().map(|(_, s)| s.options.clone());
            options
        };
        // 21:30 local: 11.5 hours to go
        let first = options_at("2026-07-10T21:30").unwrap();
        assert_eq!(first.ttl_seconds, 41_400);
        assert_eq!(first.urgency, Urgency::Normal);
        assert_eq!(first.topic, "frost-6e60291b482856a333062897b9");
        // 23:10 local: 9 h 50 min. A later tick asks for less time, never more,
        // and the same topic, so a retry replaces the copy still queued.
        let later = options_at("2026-07-10T23:10").unwrap();
        assert_eq!(later.ttl_seconds, 35_400);
        assert_eq!(later.topic, first.topic);
        // the morning after dawn, nothing is planned at all
        assert_eq!(options_at("2026-07-11T09:15"), None);
    }

    #[test]
    fn every_target_of_a_plan_asks_the_push_service_the_same() {
        let (times, temps) = hourly("2026-07-10T18:00", &SEVERE);
        let place = harare(&times, &temps, "2026-07-10T19:30");
        let targets: Vec<AlertTarget> = (0..4).map(|i| target(&format!("t-{i}"))).collect();
        let plan = plan_frost(&place, &targets);
        let options: Vec<&PushOptions> = plan.sends().map(|(_, s)| &s.options).collect();
        assert_eq!(options.len(), 4);
        assert!(options.iter().all(|o| *o == options[0]));
        assert_eq!(options[0].urgency, Urgency::High);
    }

    #[test]
    fn the_ttl_is_the_time_left_in_the_night_at_every_tick_that_sends() {
        // Severe frost at 03:00 on the 11th. Walk 15-minute ticks from 18:00 on
        // the 10th to 08:45 on the 11th: whenever a send is planned, its TTL is
        // exactly the time to 09:00 local, and it is never zero.
        let (times, temps) = hourly("2026-07-10T18:00", &SEVERE);
        let end = harare_at("2026-07-11T09:00");
        let mut checked = 0;
        let mut local = naive("2026-07-10T18:00");
        let stop = naive("2026-07-11T09:00");
        while local < stop {
            let label = local.format("%Y-%m-%dT%H:%M").to_string();
            let plan = plan_frost(&harare(&times, &temps, &label), &[target("t-01")]);
            if let Some((_, s)) = plan.sends().next() {
                let left = (end - harare_at(&label)).num_seconds();
                assert!(left > 0, "{label}");
                assert_eq!(i64::from(s.options.ttl_seconds), left, "{label}");
                assert_eq!(s.options.urgency, Urgency::High, "{label}");
                checked += 1;
            }
            local += Duration::minutes(15);
        }
        // The 03:00 frost is ahead from 18:00 through 03:00 itself: 37 ticks.
        // After that no frost hour is left in the forecast, so nothing is sent.
        assert_eq!(checked, 37);
    }

    #[test]
    fn the_key_names_the_cell_so_two_places_never_share_one() {
        let (times, temps) = hourly("2026-07-10T18:00", &SEVERE);
        let a = harare(&times, &temps, "2026-07-10T19:30");
        let b = PlaceInput {
            cell: "cell:-20.15_28.60",
            ..a
        };
        let key = |p: &PlaceInput| {
            plan_frost(p, &[target("t-01")])
                .sends()
                .next()
                .unwrap()
                .1
                .dedupe_key
                .clone()
        };
        assert_ne!(key(&a), key(&b));
        assert_eq!(key(&b), "cell:-20.15_28.60:frost:2026-07-10");
    }

    #[test]
    fn the_order_of_the_input_does_not_change_the_plan() {
        let (times, temps) = hourly("2026-07-10T18:00", &SEVERE);
        let place = harare(&times, &temps, "2026-07-10T19:30");
        let mut inactive = target("b");
        inactive.active = false;
        let mut capped = target("c");
        capped.sent_today = 2;
        let targets = vec![target("d"), inactive, target("a"), capped, target("e")];
        let want = plan_frost(&place, &targets);
        assert_eq!(
            want.entries
                .iter()
                .map(|e| e.target_id.as_str())
                .collect::<Vec<_>>(),
            ["a", "b", "c", "d", "e"]
        );
        let mut reversed = targets.clone();
        reversed.reverse();
        assert_eq!(plan_frost(&place, &reversed), want);
        let mut rotated = targets.clone();
        rotated.rotate_left(2);
        assert_eq!(plan_frost(&place, &rotated), want);
    }

    #[test]
    fn a_target_id_given_twice_gets_nothing_and_the_order_does_not_matter() {
        let (times, temps) = hourly("2026-07-10T18:00", &SEVERE);
        let place = harare(&times, &temps, "2026-07-10T19:30");
        let mut other = target("dup-1");
        other.prefs.frost = false;
        let one = vec![target("dup-1"), target("ok-1"), other.clone()];
        let two = vec![other, target("ok-1"), target("dup-1")];
        let plan = plan_frost(&place, &one);
        assert_eq!(
            plan.entries
                .iter()
                .map(|e| (e.target_id.as_str(), matches!(e.action, Action::Send(_))))
                .collect::<Vec<_>>(),
            [("dup-1", false), ("ok-1", true)]
        );
        assert_eq!(plan.entries[0].action, Action::Skip(Skip::DuplicateTarget));
        assert_eq!(plan_frost(&place, &two), plan);
        // three copies are still one entry
        let three = vec![target("dup-1"), target("dup-1"), target("dup-1")];
        assert_eq!(
            plan_frost(&place, &three).entries,
            [skip("dup-1", Skip::DuplicateTarget)]
        );
    }

    #[test]
    fn a_malformed_id_is_counted_and_never_copied_into_the_plan() {
        let (times, temps) = hourly("2026-07-10T18:00", &SEVERE);
        let place = harare(&times, &temps, "2026-07-10T19:30");
        let too_long = "a".repeat(MAX_TARGET_ID_LEN + 1);
        let bad = [
            "",
            "has space",
            "mkoko@example.com",
            "https://fcm.googleapis.com/fcm/send/secret-token",
            "dots.are.out",
            too_long.as_str(),
            "tab\there",
        ];
        let mut targets: Vec<AlertTarget> = bad.iter().map(|id| target(id)).collect();
        targets.push(target("ok_1-A"));
        targets.push(target(&"a".repeat(MAX_TARGET_ID_LEN)));
        let plan = plan_frost(&place, &targets);
        assert_eq!(plan.invalid_targets, bad.len());
        assert_eq!(plan.entries.len(), 2);
        let shown = format!("{plan:?}");
        for needle in ["example.com", "fcm.googleapis", "secret-token", "has space"] {
            assert!(!shown.contains(needle), "{needle}");
        }
    }

    #[test]
    fn the_send_limit_defers_the_rest_and_nobody_starves() {
        let (times, temps) = hourly("2026-07-10T18:00", &SEVERE);
        let place = harare(&times, &temps, "2026-07-10T19:30");
        let extra = 5;
        let n = MAX_SENDS_PER_PLACE + extra;
        let mut targets: Vec<AlertTarget> = (0..n).map(|i| target(&format!("u-{i:04}"))).collect();

        let tick1 = plan_frost(&place, &targets);
        assert_eq!(tick1.sends().count(), MAX_SENDS_PER_PLACE);
        for (i, e) in tick1.entries.iter().enumerate() {
            match &e.action {
                Action::Send(_) => assert!(i < MAX_SENDS_PER_PLACE, "{}", e.target_id),
                Action::Skip(s) => {
                    assert!(i >= MAX_SENDS_PER_PLACE, "{}", e.target_id);
                    assert_eq!(*s, Skip::TickLimit);
                }
            }
        }

        // The next tick: the delivery log now holds the first batch. They no
        // longer take a send slot, so the rest are planned.
        for t in targets.iter_mut().take(MAX_SENDS_PER_PLACE) {
            t.already_sent_this_night = true;
        }
        let tick2 = plan_frost(&place, &targets);
        assert_eq!(tick2.sends().count(), extra);
        assert_eq!(
            tick2.sends().map(|(id, _)| id).collect::<Vec<_>>(),
            (MAX_SENDS_PER_PLACE..n)
                .map(|i| format!("u-{i:04}"))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn targets_past_the_planning_limit_are_counted_not_listed() {
        let (times, temps) = hourly("2026-07-10T18:00", &SEVERE);
        let place = harare(&times, &temps, "2026-07-10T19:30");
        let n = MAX_TARGETS_PER_PLACE + 3;
        let targets: Vec<AlertTarget> =
            (0..n).rev().map(|i| target(&format!("u-{i:05}"))).collect();
        let plan = plan_frost(&place, &targets);
        assert_eq!(plan.entries.len(), MAX_TARGETS_PER_PLACE);
        assert_eq!(plan.unplanned_targets, 3);
        assert_eq!(plan.invalid_targets, 0);
        assert_eq!(plan.entries[0].target_id, "u-00000");
        assert_eq!(
            plan.entries.last().unwrap().target_id,
            format!("u-{:05}", MAX_TARGETS_PER_PLACE - 1)
        );
        assert_eq!(plan.sends().count(), MAX_SENDS_PER_PLACE);
    }

    fn station(code: &str, lat: f64) -> StationSite {
        StationSite {
            source: SOURCE_SAAOPA,
            station_ref: code.to_string(),
            lon: 31.05,
            lat,
            elevation_m: Some(1500.0),
        }
    }

    const HARARE_SITE: PlaceSite = PlaceSite {
        lat: -17.83,
        lon: 31.05,
        elevation_m: Some(1490.0),
    };

    fn reading(code: &str, observed_utc: &str, t: f64) -> StationReading {
        StationReading {
            // about 9 km north of the place, at a comparable height
            site: station(code, -17.75),
            observed_at: DateTime::parse_from_rfc3339(observed_utc)
                .unwrap()
                .with_timezone(&Utc),
            air_temperature_c: t,
        }
    }

    #[test]
    fn a_confirming_station_adds_one_sentence_and_changes_nothing_else() {
        let (times, temps) = hourly("2026-07-10T18:00", &SEVERE);
        let targets = vec![target("t-01"), target("t-02"), {
            let mut t = target("t-03");
            t.sent_today = 2;
            t
        }];
        // 23:45 local; the station read 1 C at 23:40 local (21:40Z).
        let without = plan_frost(&harare(&times, &temps, "2026-07-10T23:45"), &targets);
        let readings = [reading("S1", "2026-07-10T21:40:00Z", 1.0)];
        let with_place = PlaceInput {
            stations: Some(StationInput {
                place: HARARE_SITE,
                readings: &readings,
            }),
            ..harare(&times, &temps, "2026-07-10T23:45")
        };
        let with = plan_frost(&with_place, &targets);

        match &with.place {
            PlaceVerdict::Frost(j) => {
                // from 23:45 the first frost hour ahead is 00:00
                assert_eq!(j.alert.risk, Risk::Severe);
                assert_eq!(j.alert.lowest, -0.5);
                assert_eq!(j.alert.night, "2026-07-10");
                assert_eq!(j.alert.start, "2026-07-11T00:00");
                match &j.confirmation {
                    Confirmation::Confirmed(e) => {
                        assert_eq!(e.station_ref, "S1");
                        assert_eq!(e.air_temperature_c, 1.0);
                        assert_eq!(e.observed_local, "2026-07-10T23:40");
                    }
                    other => panic!("expected a confirmation, got {other:?}"),
                }
            }
            other => panic!("expected frost, got {other:?}"),
        }
        assert_eq!(with.entries.len(), without.entries.len());
        let mut sends = 0;
        for (a, b) in with.entries.iter().zip(&without.entries) {
            assert_eq!(a.target_id, b.target_id);
            match (&a.action, &b.action) {
                (Action::Send(a), Action::Send(b)) => {
                    sends += 1;
                    assert_eq!(a.dedupe_key, b.dedupe_key);
                    assert_eq!(a.payload.title, b.payload.title);
                    assert_eq!(a.payload.url, b.payload.url);
                    assert_eq!(a.payload.night, b.payload.night);
                    assert_eq!(
                        a.payload.body,
                        format!("{} A nearby station read 1°C at 23:40.", b.payload.body)
                    );
                }
                (a, b) => assert_eq!(a, b),
            }
        }
        assert_eq!(sends, 2);
    }

    #[test]
    fn a_warm_or_far_station_changes_nothing() {
        let (times, temps) = hourly("2026-07-10T18:00", &SEVERE);
        let targets = vec![target("t-01")];
        let base = plan_frost(&harare(&times, &temps, "2026-07-10T23:45"), &targets);
        // warm, and cold but 55 km away
        let mut far = reading("S2", "2026-07-10T21:40:00Z", -4.0);
        far.site = station("S2", -17.33);
        for readings in [vec![reading("S1", "2026-07-10T21:40:00Z", 6.0)], vec![far]] {
            let place = PlaceInput {
                stations: Some(StationInput {
                    place: HARARE_SITE,
                    readings: &readings,
                }),
                ..harare(&times, &temps, "2026-07-10T23:45")
            };
            let plan = plan_frost(&place, &targets);
            assert_eq!(plan.entries, base.entries);
        }
    }

    #[test]
    fn a_cold_station_is_never_the_trigger() {
        let (times, temps) = hourly("2026-07-10T18:00", &[12.0; 16]);
        let readings = [reading("S1", "2026-07-10T21:40:00Z", -6.0)];
        let place = PlaceInput {
            stations: Some(StationInput {
                place: HARARE_SITE,
                readings: &readings,
            }),
            ..harare(&times, &temps, "2026-07-10T23:45")
        };
        let plan = plan_frost(&place, &[target("t-01")]);
        assert_eq!(plan.place, PlaceVerdict::NoFrost);
        assert_eq!(plan.entries, [skip("t-01", Skip::NoFrost)]);
        // nor can it rescue a seasonal estimate
        let frosty = [-3.0; 16];
        let est = PlaceInput {
            provider: "fallback",
            ..harare(&times, &frosty, "2026-07-10T23:45")
        };
        assert_eq!(assess_place(&est), PlaceVerdict::EstimateProvider);
    }

    #[test]
    fn the_plan_holds_no_personal_data_and_promises_nothing() {
        let (times, temps) = hourly("2026-07-10T18:00", &SEVERE);
        let place = harare(&times, &temps, "2026-07-10T19:30");
        let mut t = target("t-01");
        // a place the person follows that is not this one must not surface
        t.prefs.places.push("secret-farm--ksy4dd7".into());
        let plan = plan_frost(&place, &[t]);
        assert_eq!(plan.sends().count(), 1);
        let shown = format!("{plan:?}").to_lowercase();
        for word in [
            "secret-farm",
            "quiet_start",
            "quiet_end",
            "guarantee",
            "email",
            "token",
            "endpoint",
            "p256dh",
        ] {
            assert!(!shown.contains(word), "{word}");
        }
        let (_, send) = plan.sends().next().unwrap();
        let json = serde_json::to_string(&send.payload).unwrap().to_lowercase();
        for word in ["guarantee", "ensure", "will be delivered", "email", "token"] {
            assert!(!json.contains(word), "{word}");
        }
        assert_eq!(send.payload.url, "/harare");
    }

    #[test]
    fn skip_codes_are_unique_snake_case_words() {
        let all = [
            Skip::NoFrost,
            Skip::EstimateProvider,
            Skip::InvalidPlace,
            Skip::Inactive,
            Skip::BadPreferences,
            Skip::NotWanted,
            Skip::Stale,
            Skip::AlreadySent,
            Skip::DailyCap,
            Skip::NightCap,
            Skip::QuietHours,
            Skip::DuplicateTarget,
            Skip::TickLimit,
        ];
        let mut codes: Vec<&str> = all.iter().map(|s| s.code()).collect();
        assert!(codes
            .iter()
            .all(|c| !c.is_empty() && c.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')));
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), all.len());
    }
}
