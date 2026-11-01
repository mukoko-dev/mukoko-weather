//! Putting a [`Snapshot`] on a place's own time axis.
//!
//! WeatherKit speaks UTC instants; the app's payload speaks the place's wall
//! clock (`2026-11-01T12:00` for the hour starting at noon local time, with a
//! `utc_offset_seconds` beside it). This module aligns one onto the other so the
//! Apple values can sit in the canonical `hourly` and `daily` arrays, or beside
//! another model's in the comparison, slot for slot. A slot Apple has no row for
//! is `null` (never zero), and a baseline fills it from `best_match`.
//!
//! **What an hour label means.** Open-Meteo labels instantaneous variables
//! (temperature, wind, humidity, cloud, visibility, UV, weather code, is_day)
//! with the instant, and period variables with the END of the period they sum
//! or take the maximum over: `precipitation`, `precipitation_probability` and
//! `wind_gusts_10m` at `13:00` describe `12:00` to `13:00`. WeatherKit labels
//! every row with the START of its hour, so for the three period variables the
//! row that fills the `13:00` slot is the one starting at `12:00`. Without that
//! shift Apple's rain would sit an hour late.
//!
//! **Known limit: daylight-saving changes.** The axis is local wall-clock text
//! plus ONE offset, so the UTC instant of a slot is exact only while the offset
//! does not change inside the 7 days. On the day a place changes its clock, the
//! hours after the change are off by the clock step. Two things bound it: the
//! DAILY alignment never uses the offset to pick a day (it needs the day to
//! start at local midnight, [`day_date`]), and a caller with exact instants (an
//! Open-Meteo request with `timeformat=unixtime`) passes them to [`hourly`]
//! directly and has no error at all. [`local_instants`] is the convenience for
//! the text form.

use std::collections::BTreeMap;

use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use serde_json::{json, Map, Value};

use super::snapshot::{Day, Reading, Snapshot};
use super::MODEL_ID;

const HOUR_SECONDS: i64 = 3600;
/// A nowcast step is 15 minutes.
const STEP_SECONDS: i64 = 900;
/// The next-hour nowcast is four steps.
pub const MINUTELY_STEPS: usize = 4;
/// A 15-minute step needs at least this many of its minutes to be reported.
const MIN_MINUTES_PER_STEP: usize = 5;
/// An Apple `currentWeather` older than this is not shown as "now".
pub const CURRENT_MAX_AGE_SECS: i64 = 2 * HOUR_SECONDS;
/// The comparison chart shows 24 hours.
pub const SERIES_HOURS: usize = 24;

/// UTC instants (epoch seconds) of local wall-clock slots `YYYY-MM-DDTHH:MM`,
/// at one constant offset. `None` for a slot that is not that form. See the
/// module docs for the daylight-saving limit.
pub fn local_instants(times: &[Value], offset_seconds: i64) -> Vec<Option<i64>> {
    times
        .iter()
        .map(|t| {
            let naive = NaiveDateTime::parse_from_str(t.as_str()?, "%Y-%m-%dT%H:%M").ok()?;
            Some(naive.and_utc().timestamp() - offset_seconds)
        })
        .collect()
}

/// `YYYY-MM-DDTHH:MM` of an instant on the wall clock at `offset_seconds`.
fn local_label(instant: i64, offset_seconds: i64) -> Option<String> {
    Some(
        DateTime::from_timestamp(instant.checked_add(offset_seconds)?, 0)?
            .format("%Y-%m-%dT%H:%M")
            .to_string(),
    )
}

fn number(x: Option<f64>) -> Value {
    x.map_or(Value::Null, |v| json!(v))
}

fn integer(x: Option<i64>) -> Value {
    x.map_or(Value::Null, |v| json!(v))
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0 + 0.0
}

// ---------------------------------------------------------------------------
// Hourly
// ---------------------------------------------------------------------------

/// Apple's hourly values on an hourly axis, as `variable -> array` with one
/// entry per slot (`axis[i]` is the slot's UTC instant, `None` for a slot whose
/// instant is unknown). Variables Apple publishes: `temperature_2m`,
/// `apparent_temperature`, `dew_point_2m`, `relative_humidity_2m`,
/// `cloud_cover`, `visibility`, `uv_index`, `wind_speed_10m`,
/// `wind_direction_10m`, `weather_code`, `is_day` (instants) and
/// `precipitation`, `precipitation_probability`, `wind_gusts_10m` (periods, from
/// the row of the PRECEDING hour). Not published, so absent: CAPE, lifted
/// index, and surface pressure (Apple's is sea level).
pub fn hourly(snapshot: &Snapshot, axis: &[Option<i64>]) -> Map<String, Value> {
    let rows: BTreeMap<i64, &Reading> = snapshot
        .hourly
        .iter()
        .map(|r| (r.at.timestamp(), r))
        .collect();
    // The row for a slot: the one starting at the slot (`back` = 0), or one
    // period earlier (`back` = 1 hour) for the period variables.
    let column = |back: i64, pick: &dyn Fn(&Reading) -> Value| -> Value {
        Value::Array(
            axis.iter()
                .map(|slot| {
                    slot.and_then(|t| rows.get(&(t - back)).copied())
                        .map_or(Value::Null, pick)
                })
                .collect(),
        )
    };
    let mut out = Map::new();
    // Instants: the row that starts at the slot.
    out.insert(
        "temperature_2m".into(),
        column(0, &|r| number(r.temperature_2m)),
    );
    out.insert(
        "apparent_temperature".into(),
        column(0, &|r| number(r.apparent_temperature)),
    );
    out.insert(
        "dew_point_2m".into(),
        column(0, &|r| number(r.dew_point_2m)),
    );
    out.insert(
        "relative_humidity_2m".into(),
        column(0, &|r| number(r.relative_humidity_2m)),
    );
    out.insert("cloud_cover".into(), column(0, &|r| number(r.cloud_cover)));
    out.insert("visibility".into(), column(0, &|r| number(r.visibility)));
    out.insert("uv_index".into(), column(0, &|r| number(r.uv_index)));
    out.insert(
        "wind_speed_10m".into(),
        column(0, &|r| number(r.wind_speed_10m)),
    );
    out.insert(
        "wind_direction_10m".into(),
        column(0, &|r| number(r.wind_direction_10m)),
    );
    out.insert(
        "weather_code".into(),
        column(0, &|r| integer(r.weather_code.map(i64::from))),
    );
    out.insert(
        "is_day".into(),
        column(0, &|r| integer(r.is_day.map(i64::from))),
    );
    // Periods: the END of the period labels the slot, so the row of the
    // preceding hour fills it.
    out.insert(
        "precipitation".into(),
        column(HOUR_SECONDS, &|r| number(r.precipitation)),
    );
    out.insert(
        "precipitation_probability".into(),
        column(HOUR_SECONDS, &|r| number(r.precipitation_probability)),
    );
    out.insert(
        "wind_gusts_10m".into(),
        column(HOUR_SECONDS, &|r| number(r.wind_gusts_10m)),
    );
    out
}

// ---------------------------------------------------------------------------
// Current
// ---------------------------------------------------------------------------

/// Apple's current reading as the canonical `current` fields, only those Apple
/// has a value for. Absent when Apple has no current reading, or it is more than
/// [`CURRENT_MAX_AGE_SECS`] old at `now` (or from the future): a stale "now" is
/// worse than the filler's.
pub fn current(snapshot: &Snapshot, now: DateTime<Utc>) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(c) = snapshot.current.as_ref() else {
        return out;
    };
    let age = (now - c.at).num_seconds();
    if !(0..=CURRENT_MAX_AGE_SECS).contains(&age) {
        return out;
    }
    for (name, value) in [
        ("temperature_2m", number(c.temperature_2m)),
        ("apparent_temperature", number(c.apparent_temperature)),
        ("relative_humidity_2m", number(c.relative_humidity_2m)),
        ("cloud_cover", number(c.cloud_cover)),
        ("uv_index", number(c.uv_index)),
        ("wind_speed_10m", number(c.wind_speed_10m)),
        ("wind_direction_10m", number(c.wind_direction_10m)),
        ("wind_gusts_10m", number(c.wind_gusts_10m)),
        ("precipitation", number(c.precipitation)),
        ("weather_code", integer(c.weather_code.map(i64::from))),
        ("is_day", integer(c.is_day.map(i64::from))),
    ] {
        if !value.is_null() {
            out.insert(name.to_owned(), value);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Daily
// ---------------------------------------------------------------------------

/// The local date a WeatherKit day belongs to, `YYYY-MM-DD`, or `None` when the
/// day does not start at local midnight (within an hour either side, for a
/// clock that changes that day).
///
/// A day starts at local midnight only because the request named the place's
/// time zone (`timezone=`, the parameter that says how to roll hours up into
/// days). If it did not, the day starts at some other hour, the date would be
/// guessed wrong for half the world, and the row is not used: the slot is
/// `null` and the filler covers it.
pub fn day_date(start: DateTime<Utc>, offset_seconds: i64) -> Option<String> {
    let local = start.checked_add_signed(Duration::seconds(offset_seconds))?;
    let seconds_into_day = local.timestamp().rem_euclid(86_400);
    // Within an hour of midnight: 23:00..24:00 belongs to the NEXT date.
    if seconds_into_day > HOUR_SECONDS && seconds_into_day < 86_400 - HOUR_SECONDS {
        return None;
    }
    let shifted = local.checked_add_signed(Duration::seconds(HOUR_SECONDS))?;
    Some(shifted.format("%Y-%m-%d").to_string())
}

/// Apple's daily values for local dates `YYYY-MM-DD` (Open-Meteo's `daily.time`),
/// as `variable -> array`: `weather_code`, `temperature_2m_max`,
/// `temperature_2m_min`, `uv_index_max`, `precipitation_sum`,
/// `precipitation_probability_max`, `sunrise`, `sunset` (`YYYY-MM-DDTHH:MM` on
/// the wall clock at `offset_seconds`). Not published at day level, so absent:
/// apparent temperature extremes, wind maxima and dominant direction, ET0.
pub fn daily(snapshot: &Snapshot, dates: &[Value], offset_seconds: i64) -> Map<String, Value> {
    let by_date: BTreeMap<String, &Day> = snapshot
        .daily
        .iter()
        .filter_map(|d| Some((day_date(d.start, offset_seconds)?, d)))
        .collect();
    let column = |pick: &dyn Fn(&Day) -> Value| -> Value {
        Value::Array(
            dates
                .iter()
                .map(|d| {
                    d.as_str()
                        .and_then(|d| by_date.get(d))
                        .map_or(Value::Null, |day| pick(day))
                })
                .collect(),
        )
    };
    let sun = |t: Option<DateTime<Utc>>| {
        t.and_then(|t| local_label(t.timestamp(), offset_seconds))
            .map_or(Value::Null, Value::from)
    };
    let mut out = Map::new();
    out.insert(
        "weather_code".into(),
        column(&|d| integer(d.weather_code.map(i64::from))),
    );
    out.insert(
        "temperature_2m_max".into(),
        column(&|d| number(d.temperature_2m_max)),
    );
    out.insert(
        "temperature_2m_min".into(),
        column(&|d| number(d.temperature_2m_min)),
    );
    out.insert("uv_index_max".into(), column(&|d| number(d.uv_index_max)));
    out.insert(
        "precipitation_sum".into(),
        column(&|d| number(d.precipitation_sum)),
    );
    out.insert(
        "precipitation_probability_max".into(),
        column(&|d| number(d.precipitation_probability_max)),
    );
    out.insert("sunrise".into(), column(&|d| sun(d.sunrise)));
    out.insert("sunset".into(), column(&|d| sun(d.sunset)));
    out
}

// ---------------------------------------------------------------------------
// Next hour
// ---------------------------------------------------------------------------

/// The next-hour forecast as the app's nowcast, `{time, precipitation}` in 15
/// minute steps (up to [`MINUTELY_STEPS`]) or `null` when Apple has none (it is
/// published for select regions only).
///
/// Apple gives a rate for each minute (mm an hour); the nowcast is millimetres
/// in each quarter hour, so a step is the mean rate of its minutes over a
/// quarter of an hour. Steps sit on the quarter-hour grid and are labelled with
/// their START on the wall clock (the app shows them as Now, +15, +30, +45). A
/// step with fewer than five minutes of data (the edge of the window) is left
/// out; the first step may begin part-way through, and its rate is the rate over
/// the minutes that remain.
pub fn minutely_15(snapshot: &Snapshot, offset_seconds: i64) -> Value {
    let mut steps: BTreeMap<i64, Vec<f64>> = BTreeMap::new();
    for m in &snapshot.next_hour {
        if let Some(rate) = m.precipitation_rate {
            steps
                .entry(m.at.timestamp().div_euclid(STEP_SECONDS))
                .or_default()
                .push(rate);
        }
    }
    let (mut time, mut precipitation) = (Vec::new(), Vec::new());
    for (step, rates) in steps
        .into_iter()
        .filter(|(_, r)| r.len() >= MIN_MINUTES_PER_STEP)
        .take(MINUTELY_STEPS)
    {
        let Some(label) = local_label(step * STEP_SECONDS, offset_seconds) else {
            continue;
        };
        let mean = rates.iter().sum::<f64>() / rates.len() as f64;
        time.push(Value::from(label));
        precipitation.push(json!(round2(mean * 0.25)));
    }
    if time.is_empty() {
        Value::Null
    } else {
        json!({"time": time, "precipitation": precipitation})
    }
}

// ---------------------------------------------------------------------------
// The comparison series
// ---------------------------------------------------------------------------

/// Apple's series for the model comparison, in the shape of every other model's
/// (`{model, temperature_2m, precipitation}`, the first [`SERIES_HOURS`] slots of
/// the axis), or `None` when Apple has no temperature for any of them.
pub fn series(snapshot: &Snapshot, axis: &[Option<i64>]) -> Option<Value> {
    let h = hourly(snapshot, axis);
    let take = |name: &str| -> Vec<Value> {
        h[name]
            .as_array()
            .map(|a| a.iter().take(SERIES_HOURS).cloned().collect())
            .unwrap_or_default()
    };
    let temperature = take("temperature_2m");
    if temperature.iter().all(Value::is_null) {
        return None;
    }
    Some(json!({
        "model": MODEL_ID,
        "temperature_2m": temperature,
        "precipitation": take("precipitation"),
    }))
}

// ---------------------------------------------------------------------------
// Composing with the filler
// ---------------------------------------------------------------------------

/// Everything from the unsuffixed Open-Meteo `best_match` response `raw`, plus
/// Apple's values as a model named [`MODEL_ID`] beside it, in the shape
/// `blend::build_single_model(raw, "apple_weatherkit", now)` reads: each hourly
/// and daily variable `v` is also present as `v_best_match` (the filler) and,
/// where Apple publishes it, as `v_apple_weatherkit`; `current` carries Apple's
/// values where it has them; `minutely_15` is Apple's nowcast when it has one.
///
/// `raw` supplies the axis (`hourly.time`, `daily.time`, both local wall
/// clock) and `utc_offset_seconds`. Returns `None` when `raw` lacks them, or
/// when Apple has no temperature for any hourly slot (nothing to be a baseline).
/// Variables Apple does not publish have no `_apple_weatherkit` key at all, so
/// the baseline's null there is filled from `best_match`, exactly as for any
/// other single model.
pub fn compose_raw(raw: &Value, snapshot: &Snapshot, now: DateTime<Utc>) -> Option<Value> {
    let offset = raw.get("utc_offset_seconds")?.as_i64()?;
    let hourly_times = raw.pointer("/hourly/time")?.as_array()?;
    let daily_times = raw.pointer("/daily/time")?.as_array()?;
    let axis = local_instants(hourly_times, offset);

    let apple_hourly = hourly(snapshot, &axis);
    if apple_hourly["temperature_2m"]
        .as_array()?
        .iter()
        .all(Value::is_null)
    {
        return None;
    }
    let apple_daily = daily(snapshot, daily_times, offset);

    let mut out = raw.clone();
    for (section, apple) in [("hourly", apple_hourly), ("daily", apple_daily)] {
        let obj = out.get_mut(section)?.as_object_mut()?;
        let filler: Vec<(String, Value)> = obj
            .iter()
            .filter(|(k, _)| k.as_str() != "time")
            .map(|(k, v)| (format!("{k}_best_match"), v.clone()))
            .collect();
        obj.extend(filler);
        for (var, values) in apple {
            obj.insert(format!("{var}_{MODEL_ID}"), values);
        }
    }

    let apple_current = current(snapshot, now);
    if let Some(cur) = out.get_mut("current").and_then(Value::as_object_mut) {
        for (var, value) in apple_current {
            cur.insert(var, value);
        }
    }
    let nowcast = minutely_15(snapshot, offset);
    if !nowcast.is_null() {
        out["minutely_15"] = nowcast;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::super::snapshot::{parse, Minute};
    use super::*;
    use crate::blend;

    const OFFSET: i64 = 7200; // Africa/Harare

    fn fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../../../tests/fixtures/weatherkit-documented.json"
        ))
        .expect("fixture parses")
    }

    fn snap() -> Snapshot {
        parse(&fixture()["response"]).unwrap()
    }

    fn utc(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    /// 48 hourly slots of 2026-11-01 and 2026-11-02 in Harare local time, with
    /// recognisable FILLER values (`50 + i`), and 3 daily slots.
    fn open_meteo_raw() -> Value {
        let times: Vec<Value> = (0..48)
            .map(|i| json!(format!("2026-11-0{}T{:02}:00", 1 + i / 24, i % 24)))
            .collect();
        let filler =
            |base: f64| -> Vec<Value> { (0..48).map(|i| json!(base + i as f64)).collect() };
        json!({
            "latitude": -17.85, "longitude": 31.05, "utc_offset_seconds": OFFSET,
            "timezone": "Africa/Harare", "elevation": 1490.0,
            "current_units": {"temperature_2m": "°C"},
            "current": {
                "time": "2026-11-01T12:15", "interval": 900,
                "temperature_2m": 1.0, "relative_humidity_2m": 2.0,
                "surface_pressure": 851.2, "weather_code": 3, "is_day": 1
            },
            "hourly": {
                "time": times,
                "temperature_2m": filler(50.0),
                "precipitation": filler(70.0),
                "wind_gusts_10m": filler(30.0),
                "surface_pressure": filler(850.0),
                "cape": filler(300.0),
                "weather_code": (0..48).map(|_| json!(3)).collect::<Vec<_>>(),
            },
            "daily": {
                "time": ["2026-11-01", "2026-11-02", "2026-11-03"],
                "temperature_2m_max": [90.0, 91.0, 92.0],
                "sunrise": ["2026-11-01T05:00", "2026-11-02T05:00", "2026-11-03T05:00"],
                "et0_fao_evapotranspiration": [5.0, 5.1, 5.2],
            },
            "minutely_15": {
                "time": ["2026-11-01T12:15", "2026-11-01T12:30"],
                "precipitation": [9.0, 9.0]
            }
        })
    }

    fn slot(local: &str) -> usize {
        // Hour index in `open_meteo_raw` of a local time on 1 or 2 November.
        let day: usize = local[9..10].parse().unwrap();
        let hour: usize = local[11..13].parse().unwrap();
        (day - 1) * 24 + hour
    }

    #[test]
    fn local_wall_clock_slots_become_utc_instants() {
        let times = [
            json!("2026-11-01T12:00"),
            json!("2026-11-01T00:00"),
            json!("garbage"),
            json!(null),
        ];
        let got = local_instants(&times, OFFSET);
        assert_eq!(got[0], Some(utc("2026-11-01T10:00:00Z").timestamp()));
        assert_eq!(got[1], Some(utc("2026-10-31T22:00:00Z").timestamp()));
        assert_eq!(&got[2..], &[None, None]);
        // A place behind UTC.
        let got = local_instants(&[json!("2026-11-01T12:00")], -5 * 3600);
        assert_eq!(got[0], Some(utc("2026-11-01T17:00:00Z").timestamp()));
    }

    #[test]
    fn instantaneous_variables_sit_at_the_instant() {
        let raw = open_meteo_raw();
        let axis = local_instants(raw["hourly"]["time"].as_array().unwrap(), OFFSET);
        let h = hourly(&snap(), &axis);
        let want = fixture()["expected"]["aligned_hourly"].clone();
        // 2026-11-01T12:00 local is the 10:00Z row.
        let i = slot("2026-11-01T12:00");
        assert_eq!(h["temperature_2m"][i], want["12:00"]["temperature_2m"]);
        assert_eq!(
            h["relative_humidity_2m"][i],
            want["12:00"]["relative_humidity_2m"]
        );
        assert_eq!(h["weather_code"][i], want["12:00"]["weather_code"]);
        assert_eq!(h["is_day"][i], want["12:00"]["is_day"]);
        // And the next hour is the next row.
        let j = slot("2026-11-01T13:00");
        assert_eq!(h["temperature_2m"][j], want["13:00"]["temperature_2m"]);
    }

    #[test]
    fn period_variables_come_from_the_preceding_hour() {
        let raw = open_meteo_raw();
        let axis = local_instants(raw["hourly"]["time"].as_array().unwrap(), OFFSET);
        let h = hourly(&snap(), &axis);
        let want = fixture()["expected"]["aligned_hourly"].clone();
        // The 13:00 slot is rain, gusts and chance over 12:00 to 13:00 local,
        // which is the row Apple starts at 10:00Z.
        let j = slot("2026-11-01T13:00");
        assert_eq!(h["precipitation"][j], want["13:00"]["precipitation"]);
        assert_eq!(h["wind_gusts_10m"][j], want["13:00"]["wind_gusts_10m"]);
        assert_eq!(
            h["precipitation_probability"][j],
            want["13:00"]["precipitation_probability"]
        );
        // The 12:00 slot's rain is the row Apple starts at 09:00Z, which
        // Apple does not have (its hours start at 10:00Z): null, not the
        // 10:00Z row.
        let i = slot("2026-11-01T12:00");
        assert!(h["precipitation"][i].is_null());
        assert!(h["wind_gusts_10m"][i].is_null());
        // The instantaneous value at 12:00 is still there.
        assert!(!h["temperature_2m"][i].is_null());
    }

    #[test]
    fn a_slot_apple_has_no_row_for_is_null_never_zero() {
        let raw = open_meteo_raw();
        let axis = local_instants(raw["hourly"]["time"].as_array().unwrap(), OFFSET);
        let h = hourly(&snap(), &axis);
        // Before Apple's first hour (hours start at 12:00 local).
        assert!(h["temperature_2m"][slot("2026-11-01T11:00")].is_null());
        assert!(h["temperature_2m"][0].is_null());
        // After its last (the fixture ends 30 hours on).
        assert!(h["temperature_2m"][47].is_null());
        // A slot with an unknown instant.
        let h = hourly(&snap(), &[None]);
        assert!(h["temperature_2m"][0].is_null());
        // What Apple does not publish is not invented.
        for absent in ["surface_pressure", "cape", "lifted_index", "pressure_msl"] {
            assert!(!h.contains_key(absent), "{absent}");
        }
    }

    #[test]
    fn exact_instants_need_no_offset() {
        // A caller that asked Open-Meteo for unix times passes them straight in.
        let t = utc("2026-11-01T10:00:00Z").timestamp();
        let h = hourly(&snap(), &[Some(t), Some(t + 3600)]);
        assert_eq!(h["temperature_2m"].as_array().unwrap().len(), 2);
        assert!(!h["temperature_2m"][0].is_null());
        // A place on a :15 clock (UTC+5:45): instants are matched exactly.
        let t15 = t + 15 * 60;
        let h = hourly(&snap(), &[Some(t15)]);
        assert!(h["temperature_2m"][0].is_null(), "no row starts at :15");
    }

    #[test]
    fn a_day_belongs_to_the_local_date_it_starts_at_midnight_of() {
        // Harare: local midnight of 1 November is 22:00Z on 31 October.
        assert_eq!(
            day_date(utc("2026-10-31T22:00:00Z"), OFFSET).as_deref(),
            Some("2026-11-01")
        );
        // New York behind UTC: 04:00Z is local midnight (EDT, -4h).
        assert_eq!(
            day_date(utc("2026-11-01T04:00:00Z"), -4 * 3600).as_deref(),
            Some("2026-11-01")
        );
        // A clock that changed that day starts the day within the hour.
        assert_eq!(
            day_date(utc("2026-10-31T21:00:00Z"), OFFSET).as_deref(),
            Some("2026-11-01"),
            "23:00 local"
        );
        assert_eq!(
            day_date(utc("2026-10-31T23:00:00Z"), OFFSET).as_deref(),
            Some("2026-11-01"),
            "01:00 local"
        );
        // A day rolled up at UTC midnight instead of the place's: not midnight
        // here, so no date is guessed.
        assert_eq!(day_date(utc("2026-11-01T00:00:00Z"), OFFSET), None);
        assert_eq!(day_date(utc("2026-11-01T00:00:00Z"), -10 * 3600), None);
    }

    #[test]
    fn daily_values_land_on_their_local_date_with_local_sun_times() {
        let raw = open_meteo_raw();
        let d = daily(&snap(), raw["daily"]["time"].as_array().unwrap(), OFFSET);
        let want = fixture()["expected"]["aligned_daily"].clone();
        for (i, date) in ["2026-11-01", "2026-11-02", "2026-11-03"]
            .iter()
            .enumerate()
        {
            for field in [
                "temperature_2m_max",
                "temperature_2m_min",
                "precipitation_sum",
                "precipitation_probability_max",
                "uv_index_max",
                "weather_code",
                "sunrise",
                "sunset",
            ] {
                assert_eq!(d[field][i], want[date][field], "{date} {field}");
            }
        }
        // Sunrise is local wall-clock text, minute precision, like Open-Meteo's.
        assert_eq!(d["sunrise"][0], json!("2026-11-01T05:27"));
        // What Apple does not publish at day level.
        for absent in [
            "apparent_temperature_max",
            "wind_speed_10m_max",
            "wind_gusts_10m_max",
            "et0_fao_evapotranspiration",
        ] {
            assert!(!d.contains_key(absent), "{absent}");
        }
        // A date Apple has no day for is null.
        let d = daily(&snap(), &[json!("2026-12-25"), json!(7)], OFFSET);
        assert!(d["temperature_2m_max"][0].is_null() && d["temperature_2m_max"][1].is_null());
    }

    #[test]
    fn the_nowcast_is_millimetres_per_quarter_hour_from_a_rate_per_hour() {
        // 60 minutes from 12:00 local (10:00Z): 6 mm/h for the first 15 minutes
        // (1.5 mm), none in the second, 2 mm/h in the third (0.5 mm), none after.
        let minutes: Vec<Minute> = (0..60)
            .map(|m| Minute {
                at: utc("2026-11-01T10:00:00Z") + Duration::minutes(m),
                precipitation_rate: Some(match m / 15 {
                    0 => 6.0,
                    2 => 2.0,
                    _ => 0.0,
                }),
                precipitation_probability: Some(50.0),
            })
            .collect();
        let mut s = snap();
        s.next_hour = minutes;
        let n = minutely_15(&s, OFFSET);
        assert_eq!(n["precipitation"], json!([1.5, 0.0, 0.5, 0.0]));
        assert_eq!(
            n["time"],
            json!([
                "2026-11-01T12:00",
                "2026-11-01T12:15",
                "2026-11-01T12:30",
                "2026-11-01T12:45"
            ])
        );
    }

    #[test]
    fn a_partial_first_step_uses_the_rate_over_the_minutes_it_has() {
        // The window starts at 12:23 local: the 12:15 step has 7 minutes at
        // 4 mm/h, so it reports 4 x 0.25 = 1.0 mm. The step after is whole.
        let minutes: Vec<Minute> = (0..60)
            .map(|m| Minute {
                at: utc("2026-11-01T10:23:00Z") + Duration::minutes(m),
                precipitation_rate: Some(4.0),
                precipitation_probability: None,
            })
            .collect();
        let mut s = snap();
        s.next_hour = minutes;
        let n = minutely_15(&s, OFFSET);
        assert_eq!(n["time"][0], json!("2026-11-01T12:15"));
        assert_eq!(n["precipitation"][0], json!(1.0));
        // 60 minutes from :23 touch five quarter hours; at most four are kept.
        assert_eq!(n["precipitation"].as_array().unwrap().len(), MINUTELY_STEPS);
    }

    #[test]
    fn a_step_with_almost_no_minutes_is_left_out_and_no_nowcast_is_null() {
        let mut s = snap();
        s.next_hour = (0..3)
            .map(|m| Minute {
                at: utc("2026-11-01T10:00:00Z") + Duration::minutes(m),
                precipitation_rate: Some(9.0),
                precipitation_probability: None,
            })
            .collect();
        assert!(minutely_15(&s, OFFSET).is_null());
        s.next_hour.clear();
        assert!(minutely_15(&s, OFFSET).is_null());
        // A minute with no rate does not count as dry.
        s.next_hour = (0..15)
            .map(|m| Minute {
                at: utc("2026-11-01T10:00:00Z") + Duration::minutes(m),
                precipitation_rate: None,
                precipitation_probability: Some(10.0),
            })
            .collect();
        assert!(minutely_15(&s, OFFSET).is_null());
    }

    #[test]
    fn the_current_reading_is_used_only_while_it_is_fresh() {
        let s = snap();
        let at = s.current.as_ref().unwrap().at;
        let c = current(&s, at + Duration::minutes(20));
        assert!(c.contains_key("temperature_2m") && c.contains_key("weather_code"));
        // Pressure is sea level: never put into the canonical current.
        assert!(!c.contains_key("surface_pressure") && !c.contains_key("pressure_msl"));
        assert!(current(&s, at + Duration::seconds(CURRENT_MAX_AGE_SECS + 1)).is_empty());
        assert!(
            current(&s, at - Duration::seconds(1)).is_empty(),
            "from the future"
        );
        let mut none = s;
        none.current = None;
        assert!(current(&none, at).is_empty());
    }

    #[test]
    fn the_comparison_series_has_the_shape_of_every_other_model() {
        let raw = open_meteo_raw();
        let axis = local_instants(raw["hourly"]["time"].as_array().unwrap(), OFFSET);
        let s = series(&snap(), &axis).unwrap();
        assert_eq!(s["model"], MODEL_ID);
        assert_eq!(s["temperature_2m"].as_array().unwrap().len(), SERIES_HOURS);
        assert_eq!(s["precipitation"].as_array().unwrap().len(), SERIES_HOURS);
        // 24 slots from local midnight: Apple's first hour is 12:00.
        assert!(s["temperature_2m"][11].is_null());
        assert!(!s["temperature_2m"][12].is_null());
        // No temperature on the axis, no series.
        assert!(series(&snap(), &[Some(0), Some(3600)]).is_none());
    }

    #[test]
    fn composing_gives_the_single_model_reader_apple_and_the_filler() {
        let raw = open_meteo_raw();
        let now = snap().current.as_ref().unwrap().at + Duration::minutes(10);
        let composed = compose_raw(&raw, &snap(), now).unwrap();

        // The filler is a copy of the best_match arrays; the axis is untouched.
        assert_eq!(composed["hourly"]["time"], raw["hourly"]["time"]);
        assert_eq!(
            composed["hourly"]["temperature_2m_best_match"],
            raw["hourly"]["temperature_2m"]
        );
        assert_eq!(composed["hourly"]["cape_best_match"], raw["hourly"]["cape"]);
        // Apple has values only where it published them.
        let i = slot("2026-11-01T14:00");
        assert!(composed["hourly"]["temperature_2m_apple_weatherkit"][i].is_number());
        assert!(composed["hourly"].get("cape_apple_weatherkit").is_none());
        assert!(composed["hourly"]
            .get("surface_pressure_apple_weatherkit")
            .is_none());
        assert!(composed["daily"]
            .get("et0_fao_evapotranspiration_apple_weatherkit")
            .is_none());

        // Read the way the single-model baseline reads it.
        let apple = blend::blend_payload(&composed, &[(MODEL_ID.to_owned(), 1.0)], false);
        let filler = blend::blend_payload(&composed, &[("best_match".to_owned(), 1.0)], false);
        let t = |p: &Value, i: usize| p["hourly"]["temperature_2m"][i].clone();
        let want = fixture()["expected"]["aligned_hourly"].clone();
        // Where Apple has a value, the baseline is Apple's (rounded as every
        // model's is); where it has none, it is null and the filler's value is
        // the one that fills the slot.
        let noon = slot("2026-11-01T12:00");
        assert_eq!(t(&apple, noon), want["12:00"]["temperature_2m"]);
        assert!(t(&apple, 0).is_null());
        assert_eq!(t(&filler, 0), json!(50.0));
        assert_eq!(t(&filler, noon), json!(50.0 + noon as f64));
        // The daily sunrise is Apple's local label; the ET0 stays the filler's.
        assert_eq!(apple["daily"]["sunrise"][0], json!("2026-11-01T05:27"));
        assert!(apple["daily"]["et0_fao_evapotranspiration"][0].is_null());
        assert_eq!(filler["daily"]["et0_fao_evapotranspiration"][0], json!(5.0));
    }

    #[test]
    fn composing_puts_apple_into_current_and_the_nowcast() {
        let raw = open_meteo_raw();
        let mut s = snap();
        s.next_hour = (0..60)
            .map(|m| Minute {
                at: utc("2026-11-01T10:00:00Z") + Duration::minutes(m),
                precipitation_rate: Some(8.0),
                precipitation_probability: None,
            })
            .collect();
        let now = s.current.as_ref().unwrap().at + Duration::minutes(5);
        let composed = compose_raw(&raw, &s, now).unwrap();
        let want = fixture()["expected"]["current"].clone();
        let cur = &composed["current"];
        assert_eq!(cur["temperature_2m"], want["temperature_2m"]);
        assert_eq!(cur["relative_humidity_2m"], want["relative_humidity_2m"]);
        // Open-Meteo's own time stamp and its station pressure are kept.
        assert_eq!(cur["time"], json!("2026-11-01T12:15"));
        assert_eq!(cur["surface_pressure"], json!(851.2));
        // The nowcast is Apple's: 8 mm/h is 2 mm in a quarter hour.
        assert_eq!(composed["minutely_15"]["precipitation"][0], json!(2.0));
        // With no Apple nowcast the filler's stays.
        let mut without = snap();
        without.next_hour.clear();
        let kept = compose_raw(&raw, &without, now).unwrap();
        assert_eq!(kept["minutely_15"], raw["minutely_15"]);
    }

    #[test]
    fn nothing_to_compose_is_none() {
        let now = utc("2026-11-01T10:10:00Z");
        // No axis, no offset.
        assert!(compose_raw(&json!({}), &snap(), now).is_none());
        let mut raw = open_meteo_raw();
        raw.as_object_mut().unwrap().remove("utc_offset_seconds");
        assert!(compose_raw(&raw, &snap(), now).is_none());
        // Apple's rows are all outside the axis (a different week).
        let mut raw = open_meteo_raw();
        let far: Vec<Value> = (0..48)
            .map(|i| json!(format!("2026-12-0{}T{:02}:00", 1 + i / 24, i % 24)))
            .collect();
        raw["hourly"]["time"] = Value::Array(far);
        assert!(compose_raw(&raw, &snap(), now).is_none());
    }
}
