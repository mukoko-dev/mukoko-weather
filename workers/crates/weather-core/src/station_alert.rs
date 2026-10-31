//! Station readings as CONFIRMATION of a frost alert (mukoko-dev/mukoko-weather
//! #361 and #289).
//!
//! The forecast is the only thing that can raise an alert
//! ([`crate::push::evaluate_frost`]). A weather station near the place can add
//! evidence to one that already exists, and that is all it can do:
//!
//! - **Never the sole trigger.** [`join_frost`] takes an `Option<FrostAlert>`
//!   and answers `None` for `None`, whatever the stations say, and
//!   [`confirm_frost`] cannot be called without an alert.
//! - **Never changes the alert.** The risk, the lowest temperature, the night
//!   and the dedupe key of the [`FrostAlert`] come out exactly as they went in.
//!   A station cannot escalate (a severe alert skips quiet hours, so that is
//!   the forecast's call), cannot downgrade, and cannot suppress. A warm
//!   reading at 23:00 says nothing about 04:00, so it is [`Confirmation::NotYet`]
//!   and the alert stands.
//! - **The same definition of frost.** The threshold and the frost window are
//!   `push::FROST_THRESHOLD_C` and `push::in_frost_window`, the ones
//!   `evaluate_frost` uses, so a forecast hour and an observed reading can
//!   never disagree about what counts. A test sweeps both.
//! - **Fail closed.** A reading that is not fresh, not close, not at a
//!   comparable height, not finite or not in range is not evidence. With no
//!   evidence the answer is [`Confirmation::Unconfirmed`], which changes
//!   nothing.
//!
//! The one effect of [`Confirmation::Confirmed`] is a sentence in the push body
//! ([`frost_payload_with_evidence`]) and the evidence for the delivery log.
//! The alert is not held back waiting for a confirmation: dedupe sends one
//! alert per night, so waiting would only delay it.
//!
//! Standards: the only quantity read is `Quantity::AirTemperature` (CF
//! `air_temperature`, UCUM `Cel`), times are RFC 3339, a station is a WIGOS id
//! or a SAAOPA code (`station_ref`), and `source` is the `external_feeds`
//! `SOURCE_*` tag. Rainfall is not read, so the open question about the MSD
//! rainfall (exactly 0.0 mm everywhere) does not touch this module.
//!
//! No network, no clock: the caller passes `now` and the place's UTC offset
//! (Open-Meteo `utc_offset_seconds`, the unit `evaluate_frost`'s local
//! wall-clock strings are in). A feed that is switched off
//! (`external_fetch::FeedSwitches`) yields no observations and so no readings.
//!
//! The limits below are ours: no standard names a representative radius for a
//! frost reading, and the right values should be fitted against the recorded
//! forecast verification once it exists. They are deliberately tight, because
//! a wrong "confirmation" costs trust and a missing one costs nothing.

use std::collections::BTreeMap;

use chrono::{DateTime, Duration, NaiveDateTime, Timelike, Utc};

use crate::external_feeds::{rfc3339, FeedObservation, Quantity};
use crate::geo::{haversine_km, valid_coordinates};
use crate::push::{
    frost_payload, in_frost_window, night_of, FrostAlert, Payload, FROST_THRESHOLD_C,
};

/// A station farther than this from the place is not evidence about it.
pub const MAX_DISTANCE_KM: f64 = 25.0;
/// Frost follows height (about 6 C per km of lapse, plus cold air pooling in
/// valleys), so a station this much higher or lower is a different climate.
/// Checked only when both heights are known.
pub const MAX_ELEVATION_DIFF_M: f64 = 250.0;
/// A reading older than this is stale. The same hour the current-conditions
/// overlay (`nearest_station_observation`) allows, and enough for an hourly
/// WIS2 report fetched shortly after it is published.
pub const MAX_READING_AGE_MINUTES: i64 = 60;
/// A reading stamped this far ahead of `now` is clock skew; further ahead it
/// is a bad stamp and is ignored.
pub const MAX_CLOCK_SKEW_MINUTES: i64 = 5;

/// UTC offsets that exist (UTC-12 to UTC+14). Anything else is a bad input and
/// the local hour would be wrong, so nothing is confirmed.
const MIN_UTC_OFFSET_S: i32 = -12 * 3600;
const MAX_UTC_OFFSET_S: i32 = 14 * 3600;

/// A registered station: where it is. Positions come from the reviewed
/// registry, never from a feed, and no station is created from a feed.
#[derive(Debug, Clone, PartialEq)]
pub struct StationSite {
    /// `external_feeds::SOURCE_*`.
    pub source: &'static str,
    /// A WIGOS id (WIS2) or a SAAOPA code, as `FeedObservation::station_ref`.
    pub station_ref: String,
    pub lon: f64,
    pub lat: f64,
    /// Height above mean sea level in metres, when the registry has it.
    pub elevation_m: Option<f64>,
}

/// One air-temperature reading from a registered station.
#[derive(Debug, Clone, PartialEq)]
pub struct StationReading {
    pub site: StationSite,
    pub observed_at: DateTime<Utc>,
    /// Degrees Celsius (UCUM `Cel`).
    pub air_temperature_c: f64,
}

/// The place an alert is about.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlaceSite {
    pub lat: f64,
    pub lon: f64,
    /// `None` when unknown or approximate (a spot, the IP fallback): a
    /// placeholder height would wrongly reject or accept a station.
    pub elevation_m: Option<f64>,
}

/// Turn feed observations into readings of registered stations. An
/// observation of a station not in `sites` (matched on source and
/// `station_ref`), without an air temperature or without a parsable time is
/// skipped; nothing is invented. The position is the registry's, never the
/// feed's.
pub fn readings_from_feed(
    observations: &[FeedObservation],
    sites: &[StationSite],
) -> Vec<StationReading> {
    let by_key: BTreeMap<(&str, &str), &StationSite> = sites
        .iter()
        .map(|s| ((s.source, s.station_ref.as_str()), s))
        .collect();
    observations
        .iter()
        .filter_map(|o| {
            let site = by_key.get(&(o.source, o.station_ref.as_str()))?;
            let air_temperature_c = *o.measures.get(&Quantity::AirTemperature)?;
            let observed_at = DateTime::parse_from_rfc3339(&o.observed_at)
                .ok()?
                .with_timezone(&Utc);
            Some(StationReading {
                site: (*site).clone(),
                observed_at,
                air_temperature_c,
            })
        })
        .collect()
}

/// What a station reading said about a forecast frost alert.
#[derive(Debug, Clone, PartialEq)]
pub struct Evidence {
    /// `external_feeds::SOURCE_*`.
    pub source: &'static str,
    pub station_ref: String,
    /// Great-circle distance to the place, to 0.1 km.
    pub distance_km: f64,
    /// RFC 3339, UTC.
    pub observed_at: String,
    /// The place's local wall-clock time of the reading, `YYYY-MM-DDTHH:MM`
    /// (the same form as `FrostAlert::start`).
    pub observed_local: String,
    /// Whole minutes between the reading and `now`.
    pub age_minutes: i64,
    /// Degrees Celsius.
    pub air_temperature_c: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Confirmation {
    /// The nearest usable station reads at or below the frost line, inside the
    /// frost window of the alert's night.
    Confirmed(Evidence),
    /// There is a usable reading and it does not (yet) show frost: it is above
    /// the line, or outside the frost window, or from another night. The alert
    /// is unchanged.
    NotYet(Evidence),
    /// No station gave usable evidence. The alert is unchanged.
    Unconfirmed,
}

/// A forecast alert and what the stations said about it. `alert` is the one
/// passed in, untouched.
#[derive(Debug, Clone, PartialEq)]
pub struct JoinedFrost {
    pub alert: FrostAlert,
    pub confirmation: Confirmation,
}

/// The place's local wall-clock time, or `None` for an offset that does not
/// exist.
fn local_time(t: DateTime<Utc>, utc_offset_seconds: i32) -> Option<NaiveDateTime> {
    if !(MIN_UTC_OFFSET_S..=MAX_UTC_OFFSET_S).contains(&utc_offset_seconds) {
        return None;
    }
    t.naive_utc()
        .checked_add_signed(Duration::seconds(i64::from(utc_offset_seconds)))
}

fn local_string(t: NaiveDateTime) -> String {
    t.format("%Y-%m-%dT%H:%M").to_string()
}

/// A reading that passed every eligibility rule, with what the choice needs.
struct Candidate<'a> {
    reading: &'a StationReading,
    km: f64,
    local: NaiveDateTime,
    age: Duration,
}

fn finite_height(h: Option<f64>) -> Option<f64> {
    h.filter(|v| v.is_finite())
}

/// `None` unless the reading is usable evidence for `place` at `now`.
fn candidate<'a>(
    r: &'a StationReading,
    place: &PlaceSite,
    now: DateTime<Utc>,
    utc_offset_seconds: i32,
) -> Option<Candidate<'a>> {
    let (lo, hi) = Quantity::AirTemperature.range();
    if !r.air_temperature_c.is_finite() || !(lo..=hi).contains(&r.air_temperature_c) {
        return None;
    }
    if !valid_coordinates(r.site.lat, r.site.lon) {
        return None;
    }
    let km = haversine_km(place.lat, place.lon, r.site.lat, r.site.lon);
    if !km.is_finite() || km > MAX_DISTANCE_KM {
        return None;
    }
    if let (Some(a), Some(b)) = (
        finite_height(place.elevation_m),
        finite_height(r.site.elevation_m),
    ) {
        if (a - b).abs() > MAX_ELEVATION_DIFF_M {
            return None;
        }
    }
    let age = now.signed_duration_since(r.observed_at);
    if age < -Duration::minutes(MAX_CLOCK_SKEW_MINUTES)
        || age > Duration::minutes(MAX_READING_AGE_MINUTES)
    {
        return None;
    }
    Some(Candidate {
        reading: r,
        km,
        local: local_time(r.observed_at, utc_offset_seconds)?,
        age,
    })
}

/// Whether this reading shows the frost the alert is about: at or below the
/// shared frost line, inside the frost window, and in the alert's own night.
fn shows_frost(c: &Candidate, alert: &FrostAlert) -> bool {
    c.reading.air_temperature_c <= FROST_THRESHOLD_C
        && in_frost_window(c.local.hour() as u8)
        && night_of(&local_string(c.local)).as_deref() == Some(alert.night.as_str())
}

fn evidence(c: &Candidate) -> Evidence {
    Evidence {
        source: c.reading.site.source,
        station_ref: c.reading.site.station_ref.clone(),
        distance_km: (c.km * 10.0).round() / 10.0,
        observed_at: rfc3339(c.reading.observed_at),
        observed_local: local_string(c.local),
        age_minutes: c.age.num_minutes().max(0),
        air_temperature_c: c.reading.air_temperature_c,
    }
}

/// What the stations near `place` say about `alert` at `now`.
///
/// 1. A reading is evidence only if it is finite and in the platform's range,
///    from a station within [`MAX_DISTANCE_KM`] (and [`MAX_ELEVATION_DIFF_M`]
///    when both heights are known), and no older than
///    [`MAX_READING_AGE_MINUTES`] nor ahead of `now` by more than
///    [`MAX_CLOCK_SKEW_MINUTES`].
/// 2. Each station speaks once, with its latest evidence (a station that has
///    warmed since an earlier cold reading is warm). Two readings with the
///    same stamp and different values keep the warmer one.
/// 3. The nearest station speaks for the place (ties: the colder, then the
///    station id). It is `Confirmed` if its reading shows frost
///    (`shows_frost`), else `NotYet`. A farther station that reads colder
///    does not override a nearer one that does not.
///
/// A place or `now` the function cannot place in time (invalid coordinates, a
/// UTC offset that does not exist) is `Unconfirmed`.
pub fn confirm_frost(
    alert: &FrostAlert,
    place: &PlaceSite,
    readings: &[StationReading],
    now: DateTime<Utc>,
    utc_offset_seconds: i32,
) -> Confirmation {
    if !valid_coordinates(place.lat, place.lon) || local_time(now, utc_offset_seconds).is_none() {
        return Confirmation::Unconfirmed;
    }
    let mut latest: BTreeMap<(&str, &str), Candidate> = BTreeMap::new();
    for r in readings {
        let Some(c) = candidate(r, place, now, utc_offset_seconds) else {
            continue;
        };
        let key = (r.site.source, r.site.station_ref.as_str());
        let replace = latest.get(&key).is_none_or(|prev| {
            c.reading.observed_at > prev.reading.observed_at
                || (c.reading.observed_at == prev.reading.observed_at
                    && c.reading.air_temperature_c > prev.reading.air_temperature_c)
        });
        if replace {
            latest.insert(key, c);
        }
    }
    let mut ranked: Vec<Candidate> = latest.into_values().collect();
    ranked.sort_by(|a, b| {
        a.km.total_cmp(&b.km)
            .then(
                a.reading
                    .air_temperature_c
                    .total_cmp(&b.reading.air_temperature_c),
            )
            .then_with(|| a.reading.site.station_ref.cmp(&b.reading.site.station_ref))
    });
    match ranked.first() {
        Some(c) if shows_frost(c, alert) => Confirmation::Confirmed(evidence(c)),
        Some(c) => Confirmation::NotYet(evidence(c)),
        None => Confirmation::Unconfirmed,
    }
}

/// The join the evaluation tick runs after `evaluate_frost`. With no forecast
/// alert there is nothing to join, however cold a station reads: a station is
/// never the sole trigger.
pub fn join_frost(
    alert: Option<FrostAlert>,
    place: &PlaceSite,
    readings: &[StationReading],
    now: DateTime<Utc>,
    utc_offset_seconds: i32,
) -> Option<JoinedFrost> {
    let alert = alert?;
    let confirmation = confirm_frost(&alert, place, readings, now, utc_offset_seconds);
    Some(JoinedFrost {
        alert,
        confirmation,
    })
}

/// The frost push for a joined alert. Identical to `push::frost_payload`
/// unless a station confirmed it, in which case one factual sentence names the
/// reading and its local time. It says "a nearby station", never an operator,
/// and promises nothing about delivery. Only `Confirmed` is mentioned: "not
/// yet" and "unconfirmed" are not news.
pub fn frost_payload_with_evidence(place_name: &str, slug: &str, joined: &JoinedFrost) -> Payload {
    let mut payload = frost_payload(place_name, slug, &joined.alert);
    if let Confirmation::Confirmed(e) = &joined.confirmation {
        if let Some(clock) = e.observed_local.get(11..16) {
            let temp = e.air_temperature_c.round() as i32;
            payload
                .body
                .push_str(&format!(" A nearby station read {temp}°C at {clock}."));
        }
    }
    payload
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::external_feeds::{
        saaopa_status_observations, wis2_observations, SOURCE_SAAOPA, SOURCE_WIS2_ZW_MSD,
    };
    use crate::push::{evaluate_frost, Risk};
    use serde_json::Value;

    const WIS2: &str = include_str!("../tests/fixtures/wis2_zw_msd_items.json");
    const SAAOPA_STATUS: &str = include_str!("../tests/fixtures/saaopa_stations_status.json");

    /// Harare is UTC+2 all year.
    const HARARE_OFFSET: i32 = 2 * 3600;
    const HARARE: PlaceSite = PlaceSite {
        lat: -17.83,
        lon: 31.05,
        elevation_m: Some(1490.0),
    };

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    fn alert(night: &str, risk: Risk, lowest: f64) -> FrostAlert {
        FrostAlert {
            risk,
            lowest,
            start: format!("{night}T22:00"),
            end: format!("{night}T05:00"),
            night: night.to_string(),
        }
    }

    fn site(code: &str, lat: f64, lon: f64, elevation_m: Option<f64>) -> StationSite {
        StationSite {
            source: SOURCE_SAAOPA,
            station_ref: code.to_string(),
            lon,
            lat,
            elevation_m,
        }
    }

    fn reading(site: StationSite, observed_at: &str, t: f64) -> StationReading {
        StationReading {
            site,
            observed_at: at(observed_at),
            air_temperature_c: t,
        }
    }

    /// About 9 km north of `HARARE`, at a comparable height.
    fn near(code: &str) -> StationSite {
        site(code, -17.75, 31.05, Some(1500.0))
    }

    fn confirm(a: &FrostAlert, rs: &[StationReading], now: &str) -> Confirmation {
        confirm_frost(a, &HARARE, rs, at(now), HARARE_OFFSET)
    }

    fn evidence_of(c: &Confirmation) -> &Evidence {
        match c {
            Confirmation::Confirmed(e) | Confirmation::NotYet(e) => e,
            Confirmation::Unconfirmed => panic!("no evidence"),
        }
    }

    // 2026-07-10 is the alert's night. 21:40Z is 23:40 in Harare.
    const NIGHT: &str = "2026-07-10";
    const NOW: &str = "2026-07-10T21:45:00Z";

    #[test]
    fn a_cold_reading_from_a_close_station_inside_the_night_confirms() {
        let a = alert(NIGHT, Risk::High, 1.5);
        let rs = [reading(near("A"), "2026-07-10T21:40:00Z", 1.2)];
        let c = confirm(&a, &rs, NOW);
        let Confirmation::Confirmed(e) = &c else {
            panic!("{c:?}")
        };
        assert_eq!(e.station_ref, "A");
        assert_eq!(e.source, SOURCE_SAAOPA);
        assert_eq!(e.air_temperature_c, 1.2);
        assert_eq!(e.observed_at, "2026-07-10T21:40:00Z");
        assert_eq!(e.observed_local, "2026-07-10T23:40");
        assert_eq!(e.age_minutes, 5);
        assert!((8.0..10.0).contains(&e.distance_km), "{}", e.distance_km);
    }

    #[test]
    fn a_warm_reading_is_not_yet_and_the_alert_stands() {
        let a = alert(NIGHT, Risk::High, 1.5);
        let rs = [reading(near("A"), "2026-07-10T21:40:00Z", 9.0)];
        let c = confirm(&a, &rs, NOW);
        assert!(matches!(c, Confirmation::NotYet(_)), "{c:?}");
        assert_eq!(evidence_of(&c).air_temperature_c, 9.0);
        // The join hands the alert back exactly as it came in.
        let joined = join_frost(Some(a.clone()), &HARARE, &rs, at(NOW), HARARE_OFFSET).unwrap();
        assert_eq!(joined.alert, a);
    }

    #[test]
    fn a_station_alone_never_triggers_an_alert() {
        let rs = [reading(near("A"), "2026-07-10T21:40:00Z", -6.0)];
        assert!(join_frost(None, &HARARE, &rs, at(NOW), HARARE_OFFSET).is_none());
        assert!(join_frost(None, &HARARE, &[], at(NOW), HARARE_OFFSET).is_none());
    }

    #[test]
    fn confirmation_never_changes_the_risk_the_dedupe_inputs_or_the_decision_inputs() {
        // A severe reading under a moderate forecast does not escalate it: a
        // severe alert skips quiet hours, which is the forecast's call.
        let a = alert(NIGHT, Risk::Moderate, 2.8);
        let rs = [reading(near("A"), "2026-07-10T21:40:00Z", -4.0)];
        let joined = join_frost(Some(a.clone()), &HARARE, &rs, at(NOW), HARARE_OFFSET).unwrap();
        assert!(matches!(joined.confirmation, Confirmation::Confirmed(_)));
        assert_eq!(joined.alert.risk, Risk::Moderate);
        assert_eq!(joined.alert.lowest, 2.8);
        assert_eq!(joined.alert.night, NIGHT);
        assert_eq!(joined.alert, a);
        // ...and a warm reading does not downgrade a severe one.
        let sev = alert(NIGHT, Risk::Severe, -2.0);
        let warm = [reading(near("A"), "2026-07-10T21:40:00Z", 12.0)];
        let joined = join_frost(Some(sev.clone()), &HARARE, &warm, at(NOW), HARARE_OFFSET).unwrap();
        assert_eq!(joined.alert, sev);
    }

    #[test]
    fn no_usable_reading_is_unconfirmed() {
        let a = alert(NIGHT, Risk::High, 1.5);
        assert_eq!(confirm(&a, &[], NOW), Confirmation::Unconfirmed);
        let cold = |site: StationSite, when: &str, t: f64| [reading(site, when, t)];
        // Too far (Bulawayo is about 360 km away).
        let far = site("B", -20.15, 28.58, Some(1340.0));
        assert_eq!(
            confirm(&a, &cold(far, "2026-07-10T21:40:00Z", 0.0), NOW),
            Confirmation::Unconfirmed
        );
        // Stale: 61 minutes old.
        assert_eq!(
            confirm(&a, &cold(near("A"), "2026-07-10T20:44:00Z", 0.0), NOW),
            Confirmation::Unconfirmed
        );
        // Stamped in the future beyond the skew.
        assert_eq!(
            confirm(&a, &cold(near("A"), "2026-07-10T21:51:00Z", 0.0), NOW),
            Confirmation::Unconfirmed
        );
        // Not finite, or outside the platform's air temperature range.
        for t in [f64::NAN, f64::INFINITY, -90.0, 99.0] {
            assert_eq!(
                confirm(&a, &cold(near("A"), "2026-07-10T21:40:00Z", t), NOW),
                Confirmation::Unconfirmed,
                "{t}"
            );
        }
        // A station with a position that is not on Earth.
        let nowhere = site("N", 95.0, 31.0, None);
        assert_eq!(
            confirm(&a, &cold(nowhere, "2026-07-10T21:40:00Z", 0.0), NOW),
            Confirmation::Unconfirmed
        );
        // An offset that does not exist, and a place that is not on Earth.
        let rs = cold(near("A"), "2026-07-10T21:40:00Z", 0.0);
        assert_eq!(
            confirm_frost(&a, &HARARE, &rs, at(NOW), 15 * 3600),
            Confirmation::Unconfirmed
        );
        assert_eq!(
            confirm_frost(&a, &HARARE, &rs, at(NOW), -13 * 3600),
            Confirmation::Unconfirmed
        );
        let nowhere = PlaceSite {
            lat: f64::NAN,
            ..HARARE
        };
        assert_eq!(
            confirm_frost(&a, &nowhere, &rs, at(NOW), HARARE_OFFSET),
            Confirmation::Unconfirmed
        );
    }

    #[test]
    fn the_limits_are_inclusive_at_the_edge() {
        let a = alert(NIGHT, Risk::High, 1.5);
        // Exactly 60 minutes old (20:45Z) and 5 minutes ahead (21:50Z) count.
        for when in ["2026-07-10T20:45:00Z", "2026-07-10T21:50:00Z"] {
            let c = confirm(&a, &[reading(near("A"), when, 0.0)], NOW);
            assert!(matches!(c, Confirmation::Confirmed(_)), "{when}: {c:?}");
        }
        // Elevation: 250 m apart counts, 251 m does not (both heights known).
        let level = |dz: f64| site("E", -17.75, 31.05, Some(1490.0 + dz));
        let r = |s| [reading(s, "2026-07-10T21:40:00Z", 0.0)];
        assert!(matches!(
            confirm(&a, &r(level(250.0)), NOW),
            Confirmation::Confirmed(_)
        ));
        assert!(matches!(
            confirm(&a, &r(level(-250.0)), NOW),
            Confirmation::Confirmed(_)
        ));
        assert_eq!(
            confirm(&a, &r(level(251.0)), NOW),
            Confirmation::Unconfirmed
        );
        // An unknown height on either side is not compared.
        let unknown = site("E", -17.75, 31.05, None);
        assert!(matches!(
            confirm(&a, &r(unknown), NOW),
            Confirmation::Confirmed(_)
        ));
        let no_height = PlaceSite {
            elevation_m: None,
            ..HARARE
        };
        let high = site("E", -17.75, 31.05, Some(3000.0));
        assert!(matches!(
            confirm_frost(&a, &no_height, &r(high), at(NOW), HARARE_OFFSET),
            Confirmation::Confirmed(_)
        ));
        // Distance: a station just inside the limit counts, one just outside
        // does not. 0.2 degrees of latitude is about 22 km, 0.25 is 27.8 km.
        let inside = site("D", -17.83 + 0.2, 31.05, Some(1490.0));
        let outside = site("D", -17.83 + 0.25, 31.05, Some(1490.0));
        assert!(matches!(
            confirm(&a, &r(inside), NOW),
            Confirmation::Confirmed(_)
        ));
        assert_eq!(confirm(&a, &r(outside), NOW), Confirmation::Unconfirmed);
    }

    #[test]
    fn the_reading_must_show_frost_in_the_frost_window_of_the_alerts_night() {
        let a = alert(NIGHT, Risk::High, 1.5);
        // 18:00 local is cold (2 C) but outside the 22:00 to 08:00 window.
        let early = [reading(near("A"), "2026-07-10T16:00:00Z", 2.0)];
        let c = confirm(&a, &early, "2026-07-10T16:10:00Z");
        assert!(matches!(c, Confirmation::NotYet(_)), "{c:?}");
        // 07:30 local on the 11th still belongs to the night of the 10th.
        let morning = [reading(near("A"), "2026-07-11T05:30:00Z", 0.5)];
        assert!(matches!(
            confirm(&a, &morning, "2026-07-11T05:40:00Z"),
            Confirmation::Confirmed(_)
        ));
        // 08:59 is inside the window, 09:00 is not.
        let edge = |when: &str| confirm(&a, &[reading(near("A"), when, 0.5)], when);
        assert!(matches!(
            edge("2026-07-11T06:59:00Z"),
            Confirmation::Confirmed(_)
        ));
        assert!(matches!(
            edge("2026-07-11T07:00:00Z"),
            Confirmation::NotYet(_)
        ));
        // A cold reading of tonight does not confirm an alert for tomorrow's
        // night (the first frost found 24 hours ahead can be the next night).
        let tomorrow = alert("2026-07-11", Risk::High, 1.5);
        let rs = [reading(near("A"), "2026-07-10T21:40:00Z", 0.0)];
        assert!(matches!(
            confirm(&tomorrow, &rs, NOW),
            Confirmation::NotYet(_)
        ));
        // An alert whose night is not a date confirms nothing.
        let bad = alert("tonight", Risk::High, 1.5);
        assert!(matches!(confirm(&bad, &rs, NOW), Confirmation::NotYet(_)));
    }

    #[test]
    fn a_station_speaks_once_with_its_latest_reading() {
        let a = alert(NIGHT, Risk::High, 1.5);
        let cold_then_warm = [
            reading(near("A"), "2026-07-10T21:10:00Z", 0.0),
            reading(near("A"), "2026-07-10T21:40:00Z", 8.0),
        ];
        let c = confirm(&a, &cold_then_warm, NOW);
        assert!(matches!(c, Confirmation::NotYet(_)), "{c:?}");
        assert_eq!(evidence_of(&c).air_temperature_c, 8.0);
        // The order of the list does not matter.
        let reversed = [cold_then_warm[1].clone(), cold_then_warm[0].clone()];
        assert_eq!(confirm(&a, &reversed, NOW), c);
        // Warm then cold is cold.
        let warm_then_cold = [
            reading(near("A"), "2026-07-10T21:10:00Z", 8.0),
            reading(near("A"), "2026-07-10T21:40:00Z", 0.0),
        ];
        assert!(matches!(
            confirm(&a, &warm_then_cold, NOW),
            Confirmation::Confirmed(_)
        ));
        // Same stamp, conflicting values: the warmer one, whatever the order.
        let tie = [
            reading(near("A"), "2026-07-10T21:40:00Z", 0.0),
            reading(near("A"), "2026-07-10T21:40:00Z", 6.0),
        ];
        let tie_rev = [tie[1].clone(), tie[0].clone()];
        for rs in [&tie, &tie_rev] {
            let c = confirm(&a, rs, NOW);
            assert!(matches!(c, Confirmation::NotYet(_)), "{c:?}");
        }
        // A bogus future stamp does not mask the valid earlier reading.
        let bogus = [
            reading(near("A"), "2026-07-10T21:40:00Z", 0.0),
            reading(near("A"), "2026-07-11T21:40:00Z", 20.0),
        ];
        assert!(matches!(
            confirm(&a, &bogus, NOW),
            Confirmation::Confirmed(_)
        ));
    }

    #[test]
    fn the_nearest_station_speaks_for_the_place() {
        let a = alert(NIGHT, Risk::High, 1.5);
        let nearer_warm = site("NEAR", -17.78, 31.05, Some(1490.0)); // ~5.6 km
        let farther_cold = site("FAR", -17.65, 31.05, Some(1490.0)); // ~20 km
        let rs = [
            reading(farther_cold.clone(), "2026-07-10T21:40:00Z", -1.0),
            reading(nearer_warm.clone(), "2026-07-10T21:40:00Z", 7.0),
        ];
        // A colder station farther away does not override a nearer warm one.
        let c = confirm(&a, &rs, NOW);
        assert!(matches!(c, Confirmation::NotYet(_)), "{c:?}");
        assert_eq!(evidence_of(&c).station_ref, "NEAR");
        // When the nearer station is cold it is the evidence.
        let rs = [
            reading(farther_cold, "2026-07-10T21:40:00Z", 7.0),
            reading(nearer_warm, "2026-07-10T21:40:00Z", -1.0),
        ];
        let c = confirm(&a, &rs, NOW);
        assert!(matches!(c, Confirmation::Confirmed(_)), "{c:?}");
        assert_eq!(evidence_of(&c).station_ref, "NEAR");
        // A nearer station whose reading is stale does not speak.
        let rs = [
            reading(
                site("STALE", -17.80, 31.05, Some(1490.0)),
                "2026-07-10T18:00:00Z",
                9.0,
            ),
            reading(near("FRESH"), "2026-07-10T21:40:00Z", 0.0),
        ];
        assert_eq!(evidence_of(&confirm(&a, &rs, NOW)).station_ref, "FRESH");
        // Equal distance: the colder, then the station id, whatever the order.
        let p = site("P", -17.75, 31.05, Some(1490.0));
        let q = site("Q", -17.75, 31.05, Some(1490.0));
        let rs = [
            reading(q.clone(), "2026-07-10T21:40:00Z", 2.0),
            reading(p.clone(), "2026-07-10T21:40:00Z", 2.0),
        ];
        assert_eq!(evidence_of(&confirm(&a, &rs, NOW)).station_ref, "P");
        let rs = [
            reading(p, "2026-07-10T21:40:00Z", 2.5),
            reading(q, "2026-07-10T21:40:00Z", 2.0),
        ];
        assert_eq!(evidence_of(&confirm(&a, &rs, NOW)).station_ref, "Q");
    }

    #[test]
    fn the_frost_line_is_the_one_the_forecast_uses() {
        // Sweep every tenth of a degree: a forecast hour inside the window is
        // frost exactly when a station reading at the same temperature and
        // hour confirms. They share `FROST_THRESHOLD_C` and `in_frost_window`.
        let a = alert(NIGHT, Risk::Moderate, 3.0);
        let times = vec!["2026-07-10T23:00".to_string()];
        let mut t = -10.0_f64;
        while t <= 10.0 {
            let t1 = (t * 10.0).round() / 10.0;
            let forecast = evaluate_frost("open-meteo:blend", &times, &[t1], "2026-07-10T23:00");
            let station = confirm(
                &a,
                &[reading(near("A"), "2026-07-10T21:00:00Z", t1)],
                "2026-07-10T21:05:00Z",
            );
            assert_eq!(
                forecast.is_some(),
                matches!(station, Confirmation::Confirmed(_)),
                "{t1}"
            );
            t += 0.1;
        }
        // And every local hour, at a temperature well below the line.
        for hour_utc in 0..24 {
            let when = format!("2026-07-10T{hour_utc:02}:00:00Z");
            let local_hour = (hour_utc + 2) % 24;
            let local_date = if hour_utc + 2 >= 24 {
                "2026-07-11"
            } else {
                "2026-07-10"
            };
            let time = format!("{local_date}T{local_hour:02}:00");
            let forecast = evaluate_frost(
                "open-meteo:blend",
                std::slice::from_ref(&time),
                &[-3.0],
                &time,
            );
            let night = forecast.as_ref().map(|f| f.night.clone());
            // The alert for that hour's own night.
            let a = alert(night.as_deref().unwrap_or(NIGHT), Risk::Severe, -3.0);
            let station = confirm_frost(
                &a,
                &HARARE,
                &[reading(near("A"), &when, -3.0)],
                at(&when),
                HARARE_OFFSET,
            );
            assert_eq!(
                forecast.is_some(),
                matches!(station, Confirmation::Confirmed(_)),
                "{time}"
            );
        }
    }

    #[test]
    fn the_push_names_the_station_only_when_it_confirmed() {
        let a = alert(NIGHT, Risk::High, 1.5);
        let plain = frost_payload("Harare", "harare", &a);
        let confirmed = JoinedFrost {
            alert: a.clone(),
            confirmation: confirm(&a, &[reading(near("A"), "2026-07-10T21:40:00Z", 1.2)], NOW),
        };
        let p = frost_payload_with_evidence("Harare", "harare", &confirmed);
        assert_eq!(p.title, plain.title);
        assert_eq!(p.url, plain.url);
        assert_eq!(p.night, plain.night);
        assert!(p.body.starts_with(&plain.body));
        assert!(
            p.body.ends_with(" A nearby station read 1°C at 23:40."),
            "{}",
            p.body
        );
        // The service worker cuts a body at 300 characters.
        assert!(p.body.chars().count() <= 300);
        // No operator, no station id, no promise of delivery.
        for word in ["SAAOPA", "WIS2", "MSD", "deliver", "guarantee", "confirmed"] {
            assert!(!p.body.contains(word), "{}", p.body);
        }
        // NotYet and Unconfirmed leave the push exactly as it was.
        for confirmation in [
            confirm(&a, &[reading(near("A"), "2026-07-10T21:40:00Z", 9.0)], NOW),
            Confirmation::Unconfirmed,
        ] {
            let joined = JoinedFrost {
                alert: a.clone(),
                confirmation,
            };
            assert_eq!(
                frost_payload_with_evidence("Harare", "harare", &joined),
                plain
            );
        }
        // A reading just under zero rounds to 0, not "-0".
        let near_zero = confirm(&a, &[reading(near("A"), "2026-07-10T21:40:00Z", -0.4)], NOW);
        let joined = JoinedFrost {
            alert: a.clone(),
            confirmation: near_zero,
        };
        let p = frost_payload_with_evidence("Harare", "harare", &joined);
        assert!(p.body.contains("read 0°C at"), "{}", p.body);
    }

    #[test]
    fn feed_observations_join_only_registered_stations_with_a_temperature() {
        // WIS2: the recorded fixture. Register two of its stations at the
        // positions the feed itself carried; the third is not registered.
        let v: Value = serde_json::from_str(WIS2).unwrap();
        let obs = wis2_observations(&v);
        assert_eq!(obs.len(), 3);
        let registered: Vec<StationSite> = obs
            .iter()
            .take(2)
            .map(|o| {
                let (lon, lat) = o.position.unwrap();
                StationSite {
                    source: SOURCE_WIS2_ZW_MSD,
                    station_ref: o.station_ref.clone(),
                    lon,
                    lat,
                    elevation_m: None,
                }
            })
            .collect();
        let readings = readings_from_feed(&obs, &registered);
        let expected = obs
            .iter()
            .take(2)
            .filter(|o| o.measures.contains_key(&Quantity::AirTemperature))
            .count();
        assert_eq!(readings.len(), expected, "{readings:?}");
        for r in &readings {
            assert_eq!(r.site.source, SOURCE_WIS2_ZW_MSD);
            assert!(registered
                .iter()
                .any(|s| s.station_ref == r.site.station_ref));
            assert!(r.observed_at.timestamp() > 0);
        }
        // No registered station, no reading: nothing is invented from a feed.
        assert!(readings_from_feed(&obs, &[]).is_empty());
        // The source is part of the key: a SAAOPA site with a WIS2 id matches
        // nothing.
        let wrong_source = StationSite {
            source: SOURCE_SAAOPA,
            ..registered[0].clone()
        };
        assert!(readings_from_feed(&obs, &[wrong_source]).is_empty());

        // SAAOPA: the recorded status answer, read at its own time. A station
        // not in the registry is dropped, and the position is the registry's.
        let status: Value = serde_json::from_str(SAAOPA_STATUS).unwrap();
        let now = at("2026-10-29T12:38:00Z");
        let obs = saaopa_status_observations(&status, now, 120, None);
        let sites = [site("INYANGA", -18.29, 32.72, Some(1800.0))];
        let readings = readings_from_feed(&obs, &sites);
        assert_eq!(readings.len(), 1);
        assert_eq!(readings[0].site, sites[0]);
        assert_eq!(readings[0].observed_at, at("2026-10-29T12:30:00Z"));
        assert!((readings[0].air_temperature_c - 21.17).abs() < 0.01);

        // An observation with no air temperature, or an unparsable time, is
        // skipped.
        let mut no_temp = obs[1].clone();
        no_temp.measures.remove(&Quantity::AirTemperature);
        assert!(readings_from_feed(&[no_temp], &sites).is_empty());
        let mut bad_time = obs[1].clone();
        bad_time.observed_at = "yesterday".into();
        assert!(readings_from_feed(&[bad_time], &sites).is_empty());
    }

    #[test]
    fn a_recorded_daytime_reading_is_not_frost_end_to_end() {
        // From the recorded SAAOPA answer through the join: a warm afternoon
        // reading is NotYet for a frost alert tonight, and says why.
        let status: Value = serde_json::from_str(SAAOPA_STATUS).unwrap();
        let now = at("2026-10-29T12:38:00Z");
        let obs = saaopa_status_observations(&status, now, 120, None);
        let sites = [site("INYANGA", -18.29, 32.72, None)];
        let readings = readings_from_feed(&obs, &sites);
        let inyanga = PlaceSite {
            lat: -18.29,
            lon: 32.72,
            elevation_m: None,
        };
        let a = alert("2026-10-29", Risk::High, 1.0);
        let joined = join_frost(Some(a.clone()), &inyanga, &readings, now, HARARE_OFFSET).unwrap();
        let Confirmation::NotYet(e) = &joined.confirmation else {
            panic!("{:?}", joined.confirmation)
        };
        assert_eq!(e.station_ref, "INYANGA");
        assert_eq!(e.observed_local, "2026-10-29T14:30");
        assert_eq!(joined.alert, a);
        assert_eq!(e.distance_km, 0.0);
    }
}
