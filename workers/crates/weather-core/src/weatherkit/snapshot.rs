//! A WeatherKit answer in OUR form: the standards rule at the edge.
//!
//! [`parse`] reads the `GET /api/v1/weather/{language}/{lat}/{lon}` response
//! (`currentWeather`, `forecastHourly`, `forecastDaily`, `forecastNextHour`)
//! and keeps only the standard form: Open-Meteo's variable names, degrees
//! Celsius, kilometres an hour, millimetres, percent, WMO weather codes and
//! RFC 3339 instants (UTC). Apple's names and fractions never leave this
//! function. The result is what the 15-minute cache holds; it is the only
//! stored form of Apple data.
//!
//! | WeatherKit | Canonical field | Conversion |
//! | --- | --- | --- |
//! | `temperature` | `temperature_2m` | degrees C, none |
//! | `temperatureApparent` | `apparent_temperature` | degrees C, none |
//! | `temperatureDewPoint` | `dew_point_2m` | degrees C, none |
//! | `humidity` (0 to 1) | `relative_humidity_2m` | x 100, percent |
//! | `cloudCover` (0 to 1) | `cloud_cover` | x 100, percent |
//! | `pressure` (mb, SEA LEVEL) | `pressure_msl` | mb is hPa, none |
//! | `visibility` (m) | `visibility` | metres, none (as Open-Meteo) |
//! | `uvIndex` | `uv_index` | none |
//! | `windSpeed` (km/h) | `wind_speed_10m` | none |
//! | `windDirection` | `wind_direction_10m` | degrees, 360 is 0 |
//! | `windGust` (km/h) | `wind_gusts_10m` | none |
//! | `precipitationIntensity` (mm/h) | `precipitation` (current) | none |
//! | `precipitationAmount` (mm) | `precipitation` (hour) | none |
//! | `precipitationChance` (0 to 1) | `precipitation_probability` | x 100, percent |
//! | `conditionCode` | `weather_code` | [`super::condition::to_wmo`] |
//! | `daylight` | `is_day` | bool |
//! | `temperatureMax` / `Min` | `temperature_2m_max` / `_min` | none |
//! | `maxUvIndex` | `uv_index_max` | none |
//! | day `precipitationAmount` | `precipitation_sum` | none |
//! | day `precipitationChance` | `precipitation_probability_max` | x 100 (the chance over the day, the nearest thing Apple publishes) |
//! | `sunrise` / `sunset` | `sunrise` / `sunset` | UTC instant |
//! | minute `precipitationIntensity` (mm/h) | `precipitation_rate` | none |
//!
//! Apple publishes only SEA-LEVEL pressure. The app's `surface_pressure` is
//! pressure at the station, which in Harare (1,500 m) is about 850 hPa where
//! sea-level pressure is about 1,015, so the value is kept as `pressure_msl`
//! and is NOT put into `surface_pressure`: that stays with the filler.
//!
//! Apple's data is untrusted input. A number that is not finite or is outside
//! what the atmosphere allows is dropped to `None` (never clamped, never
//! zero); a row without a valid time is dropped; a section Apple marks
//! `temporarilyUnavailable`, or reports in anything but metric units, is
//! dropped whole; and rows are capped.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::condition;

/// Most hourly rows kept (Apple's default is 240: ten days).
pub const MAX_HOURLY: usize = 300;
/// Most daily rows kept (Apple's default is 10 days).
pub const MAX_DAILY: usize = 15;
/// Most next-hour minutes kept (Apple sends 60).
pub const MAX_MINUTES: usize = 90;

/// One instant's values (`currentWeather`) or one forecast hour
/// (`forecastHourly`). `precipitation` is mm in the hour for an hour and mm/h
/// for the current reading: the same number for the same rate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reading {
    /// `asOf` (current) or `forecastStart` (hour), UTC.
    pub at: DateTime<Utc>,
    pub temperature_2m: Option<f64>,
    pub apparent_temperature: Option<f64>,
    pub dew_point_2m: Option<f64>,
    pub relative_humidity_2m: Option<f64>,
    /// Sea-level pressure in hPa. Not the app's `surface_pressure`.
    pub pressure_msl: Option<f64>,
    pub cloud_cover: Option<f64>,
    /// Metres.
    pub visibility: Option<f64>,
    pub uv_index: Option<f64>,
    pub wind_speed_10m: Option<f64>,
    pub wind_direction_10m: Option<f64>,
    pub wind_gusts_10m: Option<f64>,
    pub precipitation: Option<f64>,
    /// Hours only.
    pub precipitation_probability: Option<f64>,
    pub weather_code: Option<u8>,
    pub is_day: Option<bool>,
}

/// One forecast day (`forecastDaily`). `start` is the instant the day begins in
/// the time zone the request named (local midnight).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Day {
    pub start: DateTime<Utc>,
    pub weather_code: Option<u8>,
    pub temperature_2m_max: Option<f64>,
    pub temperature_2m_min: Option<f64>,
    pub precipitation_sum: Option<f64>,
    pub precipitation_probability_max: Option<f64>,
    pub uv_index_max: Option<f64>,
    pub sunrise: Option<DateTime<Utc>>,
    pub sunset: Option<DateTime<Utc>>,
}

/// One minute of the next-hour forecast (`forecastNextHour`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Minute {
    pub at: DateTime<Utc>,
    /// mm an hour.
    pub precipitation_rate: Option<f64>,
    /// Percent.
    pub precipitation_probability: Option<f64>,
}

/// What the cache holds for one 0.05 degree cell. Serialises to JSON with
/// RFC 3339 instants; a cached value is read back with `serde_json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
    /// When Apple procured the data (`metadata.readTime`).
    pub read_at: Option<DateTime<Utc>>,
    /// When Apple says the data stops being valid (`metadata.expireTime`).
    pub expires_at: Option<DateTime<Utc>>,
    pub current: Option<Reading>,
    pub hourly: Vec<Reading>,
    pub daily: Vec<Day>,
    pub next_hour: Vec<Minute>,
}

// ---------------------------------------------------------------------------
// Reading the response
// ---------------------------------------------------------------------------

fn finite(v: &Value, key: &str) -> Option<f64> {
    v.get(key)?.as_f64().filter(|x| x.is_finite())
}

/// A finite number inside `lo..=hi`, else `None`.
fn within(v: &Value, key: &str, lo: f64, hi: f64) -> Option<f64> {
    finite(v, key).filter(|x| (lo..=hi).contains(x))
}

/// Round to one decimal and normalise `-0.0`, so float noise from a x 100
/// (0.58 x 100 is 57.99999999999999) never reaches the cache or the app.
fn tenth(x: f64) -> f64 {
    (x * 10.0).round() / 10.0 + 0.0
}

/// A 0 to 1 fraction as a percentage with one decimal.
fn percent(v: &Value, key: &str) -> Option<f64> {
    within(v, key, 0.0, 1.0).map(|f| tenth(f * 100.0))
}

fn time(v: &Value, key: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(v.get(key)?.as_str()?)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

fn code(v: &Value) -> Option<u8> {
    condition::to_wmo(v.get("conditionCode")?.as_str()?)
}

/// A section, unless Apple marks it temporarily unavailable or reports it in
/// a unit system other than metric (`m`): values in another system would be
/// read as metric, so the section is not used at all.
fn section<'a>(raw: &'a Value, name: &str) -> Option<&'a Value> {
    let s = raw.get(name)?;
    let meta = s.get("metadata");
    let unavailable = meta
        .and_then(|m| m.get("temporarilyUnavailable"))
        .and_then(Value::as_bool)
        == Some(true);
    let metric = meta
        .and_then(|m| m.get("units"))
        .and_then(Value::as_str)
        .is_none_or(|u| u == "m");
    (s.is_object() && !unavailable && metric).then_some(s)
}

/// One reading. `at_key` is `asOf` or `forecastStart`; `precip_key` is
/// `precipitationIntensity` (current) or `precipitationAmount` (hour).
fn reading(v: &Value, at_key: &str, precip_key: &str) -> Option<Reading> {
    Some(Reading {
        at: time(v, at_key)?,
        temperature_2m: within(v, "temperature", -100.0, 70.0).map(tenth),
        apparent_temperature: within(v, "temperatureApparent", -120.0, 90.0).map(tenth),
        dew_point_2m: within(v, "temperatureDewPoint", -100.0, 50.0).map(tenth),
        relative_humidity_2m: percent(v, "humidity"),
        pressure_msl: within(v, "pressure", 800.0, 1100.0).map(tenth),
        cloud_cover: percent(v, "cloudCover"),
        visibility: within(v, "visibility", 0.0, 200_000.0).map(tenth),
        uv_index: within(v, "uvIndex", 0.0, 25.0),
        wind_speed_10m: within(v, "windSpeed", 0.0, 500.0).map(tenth),
        // 360 is north spelled the other way round.
        wind_direction_10m: within(v, "windDirection", 0.0, 360.0).map(|d| d % 360.0),
        wind_gusts_10m: within(v, "windGust", 0.0, 500.0).map(tenth),
        precipitation: within(v, precip_key, 0.0, 500.0).map(|p| (p * 100.0).round() / 100.0 + 0.0),
        precipitation_probability: percent(v, "precipitationChance"),
        weather_code: code(v),
        is_day: v.get("daylight").and_then(Value::as_bool),
    })
}

fn day(v: &Value) -> Option<Day> {
    Some(Day {
        start: time(v, "forecastStart")?,
        weather_code: code(v),
        temperature_2m_max: within(v, "temperatureMax", -100.0, 70.0).map(tenth),
        temperature_2m_min: within(v, "temperatureMin", -100.0, 70.0).map(tenth),
        precipitation_sum: within(v, "precipitationAmount", 0.0, 2000.0)
            .map(|p| (p * 100.0).round() / 100.0 + 0.0),
        precipitation_probability_max: percent(v, "precipitationChance"),
        uv_index_max: within(v, "maxUvIndex", 0.0, 25.0),
        sunrise: time(v, "sunrise"),
        sunset: time(v, "sunset"),
    })
}

fn minute(v: &Value) -> Option<Minute> {
    Some(Minute {
        at: time(v, "startTime")?,
        precipitation_rate: within(v, "precipitationIntensity", 0.0, 500.0)
            .map(|p| (p * 100.0).round() / 100.0 + 0.0),
        precipitation_probability: percent(v, "precipitationChance"),
    })
}

/// Rows from `section[key]`, valid ones only, oldest first, one per instant,
/// at most `max`.
fn rows<T>(
    raw: &Value,
    name: &str,
    key: &str,
    max: usize,
    parse: impl Fn(&Value) -> Option<T>,
    at: impl Fn(&T) -> DateTime<Utc>,
) -> Vec<T> {
    let mut out: Vec<T> = section(raw, name)
        .and_then(|s| s.get(key))
        .and_then(Value::as_array)
        .map(|a| a.iter().take(max * 2).filter_map(&parse).collect())
        .unwrap_or_default();
    out.sort_by_key(|r| at(r));
    out.dedup_by_key(|r| at(r));
    out.truncate(max);
    out
}

/// Convert a WeatherKit weather response to the canonical [`Snapshot`], or
/// `None` when it holds nothing usable (no current reading and no hourly row:
/// the caller treats that as an upstream failure, not as "no weather").
pub fn parse(raw: &Value) -> Option<Snapshot> {
    let current_section = section(raw, "currentWeather");
    let current = current_section.and_then(|s| reading(s, "asOf", "precipitationIntensity"));
    let hourly = rows(
        raw,
        "forecastHourly",
        "hours",
        MAX_HOURLY,
        |h| reading(h, "forecastStart", "precipitationAmount"),
        |r| r.at,
    );
    if current.is_none() && hourly.is_empty() {
        return None;
    }
    let meta_time = |key: &str| {
        [current_section, section(raw, "forecastHourly")]
            .into_iter()
            .flatten()
            .find_map(|s| time(s.get("metadata")?, key))
    };
    Some(Snapshot {
        read_at: meta_time("readTime"),
        expires_at: meta_time("expireTime"),
        current,
        hourly,
        daily: rows(raw, "forecastDaily", "days", MAX_DAILY, day, |d| d.start),
        next_hour: rows(
            raw,
            "forecastNextHour",
            "minutes",
            MAX_MINUTES,
            minute,
            |m| m.at,
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../../../tests/fixtures/weatherkit-documented.json"
        ))
        .expect("fixture parses")
    }

    fn utc(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn the_fixture_says_it_is_documented_not_recorded() {
        let f = fixture();
        assert_eq!(f["provenance"], "documented");
        assert!(f["note"]
            .as_str()
            .unwrap()
            .to_lowercase()
            .contains("not recorded"));
    }

    #[test]
    fn the_current_reading_is_converted_to_our_units() {
        let f = fixture();
        let snap = parse(&f["response"]).unwrap();
        let cur = snap.current.as_ref().unwrap();
        let want = &f["expected"]["current"];
        assert_eq!(cur.at, utc(want["at"].as_str().unwrap()));
        for (field, got) in [
            ("temperature_2m", cur.temperature_2m),
            ("apparent_temperature", cur.apparent_temperature),
            ("dew_point_2m", cur.dew_point_2m),
            ("relative_humidity_2m", cur.relative_humidity_2m),
            ("pressure_msl", cur.pressure_msl),
            ("cloud_cover", cur.cloud_cover),
            ("visibility", cur.visibility),
            ("uv_index", cur.uv_index),
            ("wind_speed_10m", cur.wind_speed_10m),
            ("wind_direction_10m", cur.wind_direction_10m),
            ("wind_gusts_10m", cur.wind_gusts_10m),
            ("precipitation", cur.precipitation),
        ] {
            assert_eq!(got, want[field].as_f64(), "current.{field}");
        }
        assert_eq!(
            cur.weather_code,
            Some(want["weather_code"].as_u64().unwrap() as u8)
        );
        assert_eq!(cur.is_day, want["is_day"].as_bool());
        assert_eq!(
            cur.precipitation_probability, None,
            "no chance at an instant"
        );
    }

    #[test]
    fn humidity_and_cloud_cover_are_fractions_in_and_percent_out() {
        let raw = json!({"currentWeather": {
            "asOf": "2026-11-01T10:00:00Z",
            "humidity": 0.58, "cloudCover": 0.07, "temperature": 21.0
        }});
        let c = parse(&raw).unwrap().current.unwrap();
        // 0.58 x 100 is 57.99999999999999 in floating point.
        assert_eq!(c.relative_humidity_2m, Some(58.0));
        assert_eq!(c.cloud_cover, Some(7.0));
        // A value that is already a percentage is out of range, not 5800 %.
        let raw = json!({"currentWeather": {
            "asOf": "2026-11-01T10:00:00Z", "humidity": 58, "temperature": 21.0
        }});
        assert_eq!(
            parse(&raw).unwrap().current.unwrap().relative_humidity_2m,
            None
        );
    }

    #[test]
    fn hourly_rows_follow_the_fixture() {
        let f = fixture();
        let snap = parse(&f["response"]).unwrap();
        assert_eq!(
            snap.hourly.len(),
            f["expected"]["hourly_len"].as_u64().unwrap() as usize
        );
        for want in f["expected"]["hourly"].as_array().unwrap() {
            let at = utc(want["at"].as_str().unwrap());
            let got = snap.hourly.iter().find(|h| h.at == at).expect("row");
            for (field, g) in [
                ("temperature_2m", got.temperature_2m),
                ("apparent_temperature", got.apparent_temperature),
                ("dew_point_2m", got.dew_point_2m),
                ("relative_humidity_2m", got.relative_humidity_2m),
                ("cloud_cover", got.cloud_cover),
                ("visibility", got.visibility),
                ("uv_index", got.uv_index),
                ("wind_speed_10m", got.wind_speed_10m),
                ("wind_direction_10m", got.wind_direction_10m),
                ("wind_gusts_10m", got.wind_gusts_10m),
                ("precipitation", got.precipitation),
                ("precipitation_probability", got.precipitation_probability),
            ] {
                assert_eq!(g, want[field].as_f64(), "{} {field}", want["at"]);
            }
            assert_eq!(
                got.weather_code,
                want["weather_code"].as_u64().map(|c| c as u8),
                "{} weather_code",
                want["at"]
            );
            assert_eq!(
                got.is_day,
                want["is_day"].as_bool(),
                "{} is_day",
                want["at"]
            );
        }
    }

    #[test]
    fn daily_rows_follow_the_fixture() {
        let f = fixture();
        let snap = parse(&f["response"]).unwrap();
        assert_eq!(
            snap.daily.len(),
            f["expected"]["daily"].as_array().unwrap().len()
        );
        for (got, want) in snap
            .daily
            .iter()
            .zip(f["expected"]["daily"].as_array().unwrap())
        {
            assert_eq!(got.start, utc(want["start"].as_str().unwrap()));
            assert_eq!(got.temperature_2m_max, want["temperature_2m_max"].as_f64());
            assert_eq!(got.temperature_2m_min, want["temperature_2m_min"].as_f64());
            assert_eq!(got.precipitation_sum, want["precipitation_sum"].as_f64());
            assert_eq!(
                got.precipitation_probability_max,
                want["precipitation_probability_max"].as_f64()
            );
            assert_eq!(got.uv_index_max, want["uv_index_max"].as_f64());
            assert_eq!(got.sunrise, want["sunrise"].as_str().map(utc));
            assert_eq!(got.sunset, want["sunset"].as_str().map(utc));
            assert_eq!(
                got.weather_code,
                want["weather_code"].as_u64().map(|c| c as u8)
            );
        }
    }

    #[test]
    fn the_minutes_are_millimetres_an_hour_and_percent() {
        let f = fixture();
        let snap = parse(&f["response"]).unwrap();
        let want = f["expected"]["next_hour"].as_array().unwrap();
        assert_eq!(snap.next_hour.len(), want.len());
        for (got, w) in snap.next_hour.iter().zip(want) {
            assert_eq!(got.at, utc(w["at"].as_str().unwrap()));
            assert_eq!(got.precipitation_rate, w["precipitation_rate"].as_f64());
            assert_eq!(
                got.precipitation_probability,
                w["precipitation_probability"].as_f64()
            );
        }
    }

    #[test]
    fn sea_level_pressure_is_kept_under_its_own_name() {
        // The canonical `surface_pressure` is station pressure; Apple's is
        // sea level, so it is stored as `pressure_msl` and nothing else.
        let snap = parse(&fixture()["response"]).unwrap();
        assert!(snap.current.unwrap().pressure_msl.is_some());
        let json = serde_json::to_string(&parse(&fixture()["response"]).unwrap()).unwrap();
        assert!(!json.contains("surface_pressure"));
    }

    #[test]
    fn an_unmapped_condition_is_none_not_zero() {
        let raw = json!({"forecastHourly": {"hours": [
            {"forecastStart": "2026-11-01T10:00:00Z", "temperature": 20.0, "conditionCode": "Haze"},
            {"forecastStart": "2026-11-01T11:00:00Z", "temperature": 20.0, "conditionCode": "Clear"},
            {"forecastStart": "2026-11-01T12:00:00Z", "temperature": 20.0, "conditionCode": "Nonsense"},
            {"forecastStart": "2026-11-01T13:00:00Z", "temperature": 20.0}
        ]}});
        let codes: Vec<Option<u8>> = parse(&raw)
            .unwrap()
            .hourly
            .iter()
            .map(|h| h.weather_code)
            .collect();
        assert_eq!(codes, vec![None, Some(0), None, None]);
    }

    #[test]
    fn implausible_numbers_are_dropped_not_clamped() {
        let raw = json!({"currentWeather": {
            "asOf": "2026-11-01T10:00:00Z",
            "temperature": 900.0,
            "temperatureApparent": "warm",
            "humidity": 1.5,
            "cloudCover": -0.1,
            "uvIndex": 99,
            "windSpeed": -3.0,
            "windDirection": 720,
            "pressure": 12.0,
            "visibility": null,
            "precipitationIntensity": 1.0e9
        }});
        let c = parse(&raw).unwrap().current.unwrap();
        assert_eq!(c.temperature_2m, None);
        assert_eq!(c.apparent_temperature, None);
        assert_eq!(c.relative_humidity_2m, None);
        assert_eq!(c.cloud_cover, None);
        assert_eq!(c.uv_index, None);
        assert_eq!(c.wind_speed_10m, None);
        assert_eq!(c.wind_direction_10m, None);
        assert_eq!(c.pressure_msl, None);
        assert_eq!(c.visibility, None);
        assert_eq!(c.precipitation, None);
    }

    #[test]
    fn a_wind_direction_of_360_is_north() {
        let raw = json!({"currentWeather": {"asOf": "2026-11-01T10:00:00Z", "windDirection": 360}});
        assert_eq!(
            parse(&raw).unwrap().current.unwrap().wind_direction_10m,
            Some(0.0)
        );
    }

    #[test]
    fn rows_without_a_valid_time_are_dropped_and_the_rest_sorted_and_unique() {
        let raw = json!({"forecastHourly": {"hours": [
            {"forecastStart": "2026-11-01T12:00:00Z", "temperature": 3.0},
            {"forecastStart": "not a time", "temperature": 99.0},
            {"temperature": 98.0},
            {"forecastStart": "2026-11-01T10:00:00Z", "temperature": 1.0},
            {"forecastStart": "2026-11-01T10:00:00Z", "temperature": 2.0},
            {"forecastStart": "2026-11-01T11:00:00+00:00", "temperature": 2.5}
        ]}});
        let snap = parse(&raw).unwrap();
        let hours: Vec<(String, Option<f64>)> = snap
            .hourly
            .iter()
            .map(|h| (h.at.to_rfc3339(), h.temperature_2m))
            .collect();
        assert_eq!(hours.len(), 3);
        assert_eq!(hours[0].0, "2026-11-01T10:00:00+00:00");
        assert_eq!(hours[1].1, Some(2.5));
        assert_eq!(hours[2].1, Some(3.0));
    }

    #[test]
    fn rows_are_capped() {
        let hours: Vec<Value> = (0..2000)
            .map(|i| {
                let t = utc("2026-11-01T00:00:00Z") + chrono::Duration::hours(i);
                json!({"forecastStart": t.to_rfc3339(), "temperature": 20.0})
            })
            .collect();
        let snap = parse(&json!({"forecastHourly": {"hours": hours}})).unwrap();
        assert_eq!(snap.hourly.len(), MAX_HOURLY);
        // The earliest rows are the ones kept.
        assert_eq!(snap.hourly[0].at, utc("2026-11-01T00:00:00Z"));
    }

    #[test]
    fn a_section_marked_unavailable_or_in_other_units_is_not_used() {
        let hours = json!([{"forecastStart": "2026-11-01T10:00:00Z", "temperature": 20.0}]);
        let current = json!({"asOf": "2026-11-01T10:00:00Z", "temperature": 21.0});
        // The hourly section is unavailable; the current one carries the answer.
        let raw = json!({
            "currentWeather": current.clone(),
            "forecastHourly": {"metadata": {"temporarilyUnavailable": true}, "hours": hours.clone()}
        });
        let snap = parse(&raw).unwrap();
        assert!(snap.current.is_some() && snap.hourly.is_empty());
        // Imperial values read as metric would be wrong by a factor: dropped.
        let raw = json!({
            "currentWeather": {"metadata": {"units": "i"}, "asOf": "2026-11-01T10:00:00Z", "temperature": 70.0},
            "forecastHourly": {"metadata": {"units": "m"}, "hours": hours}
        });
        let snap = parse(&raw).unwrap();
        assert!(snap.current.is_none());
        assert_eq!(snap.hourly.len(), 1);
    }

    #[test]
    fn nothing_usable_is_none() {
        assert!(parse(&json!({})).is_none());
        assert!(parse(&json!(null)).is_none());
        assert!(parse(&json!({"currentWeather": {"temperature": 1.0}})).is_none());
        assert!(parse(&json!({"forecastHourly": {"hours": []}})).is_none());
        assert!(parse(&json!({"forecastHourly": "oops"})).is_none());
        // Daily and next-hour alone are not a forecast baseline.
        assert!(parse(&json!({"forecastDaily": {"days": [
            {"forecastStart": "2026-11-01T00:00:00Z", "temperatureMax": 30.0}
        ]}}))
        .is_none());
    }

    #[test]
    fn the_snapshot_round_trips_through_the_cache_as_json() {
        let snap = parse(&fixture()["response"]).unwrap();
        let text = serde_json::to_string(&snap).unwrap();
        let back: Snapshot = serde_json::from_str(&text).unwrap();
        assert_eq!(back, snap);
        // The stored form is the standard form: no provider names.
        for apple in [
            "temperatureApparent",
            "conditionCode",
            "forecastStart",
            "daylight",
        ] {
            assert!(!text.contains(apple), "{apple} leaked into the cache form");
        }
        assert!(text.contains("temperature_2m") && text.contains("2026-11-01T10:00:00Z"));
    }

    #[test]
    fn the_read_and_expiry_times_come_from_the_metadata() {
        let snap = parse(&fixture()["response"]).unwrap();
        assert_eq!(snap.read_at, Some(utc("2026-11-01T10:00:41Z")));
        assert_eq!(snap.expires_at, Some(utc("2026-11-01T10:30:41Z")));
    }
}
