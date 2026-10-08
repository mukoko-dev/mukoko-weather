//! The scheduled jobs (`mukoko-weather-jobs`), as pure planning logic.
//!
//! Each Cron Trigger only plans: it turns the tick and the clock into a list
//! of [`Job`]s, which the Worker puts on its queue. The queue consumer does
//! the work, one message at a time, so no tick or message grows unbounded.
//!
//! | Cron              | Tick           | Jobs                                                        |
//! | ----------------- | -------------- | ----------------------------------------------------------- |
//! | `*/15 * * * *`    | warm           | refresh the forecast cache for the popular places          |
//! | `30 21 * * *`     | history        | one `place_daily` row per seed place (23:30 in Harare)      |
//! | `15 2 * * *`      | maintenance    | `station_daily` rollup, retention to R2, raw cleanup, limits |

use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::places::{resolve_seed, seed, Place};

/// The cache-warming schedule. Every tick refreshes each popular place once,
/// so the provider budget is `places x 96` calls a day.
pub const CRON_WARM: &str = "*/15 * * * *";
/// The place-history schedule: 21:30 UTC is 23:30 in Harare (UTC+2), so the
/// row describes a day that is almost over.
pub const CRON_HISTORY: &str = "30 21 * * *";
/// The maintenance schedule: rollups and retention, at a quiet hour.
pub const CRON_MAINTENANCE: &str = "15 2 * * *";
/// Ticks a day of [`CRON_WARM`].
pub const WARM_TICKS_PER_DAY: usize = 96;

/// The popular places warmed when `WARM_PLACES` is not set: the biggest seed
/// cities. Six places cost 576 provider calls a day.
pub const DEFAULT_WARM_PLACES: &str = "harare,bulawayo,mutare,gweru,masvingo,victoria-falls";
/// At most this many places are warmed, whatever `WARM_PLACES` says.
pub const MAX_WARM_PLACES: usize = 50;
/// Places per queue message (warming and history).
pub const PLACES_PER_MESSAGE: usize = 10;

/// D1 observations are kept this many days, then archived to R2.
pub const DEFAULT_RETENTION_DAYS: u32 = 90;
/// Raw uploads in R2 (`raw/YYYY/MM/DD/`) are kept this many days.
pub const DEFAULT_RAW_RETENTION_DAYS: u32 = 365;
/// Observations archived per message.
pub const ARCHIVE_ROWS_PER_MESSAGE: u32 = 1000;
/// Archive messages per maintenance tick: at most 5,000 rows a day leave D1.
/// A backlog drains over the following days.
pub const ARCHIVE_MESSAGES_PER_TICK: usize = 5;
/// Raw days looked at past the retention line, so a missed tick catches up.
pub const RAW_CLEANUP_LOOKBACK_DAYS: u32 = 7;

/// One unit of work on the `weather-jobs` queue.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "job", rename_all = "snake_case")]
pub enum Job {
    /// Refresh the forecast cache for these seed slugs.
    Warm { slugs: Vec<String> },
    /// Record today's `place_daily` row for these seed slugs.
    PlaceHistory { slugs: Vec<String> },
    /// Roll up one UTC day of validated observations into `station_daily`.
    StationRollup { date: String },
    /// Move up to [`ARCHIVE_ROWS_PER_MESSAGE`] observations older than the
    /// cutoff to R2, then delete them from D1.
    Archive { cutoff_ms: i64 },
    /// Delete the raw uploads under one day prefix.
    RawCleanup { prefix: String },
    /// Delete rate-limit events older than this.
    RateEvents { before_ms: i64 },
}

/// Which schedule fired.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tick {
    Warm,
    History,
    Maintenance,
}

impl Tick {
    /// The tick for a cron expression, as the runtime reports it.
    pub fn from_cron(cron: &str) -> Option<Tick> {
        match cron.trim() {
            CRON_WARM => Some(Tick::Warm),
            CRON_HISTORY => Some(Tick::History),
            CRON_MAINTENANCE => Some(Tick::Maintenance),
            _ => None,
        }
    }
}

/// The Worker's settings (vars), already read.
#[derive(Debug, Clone, Default)]
pub struct Settings {
    pub warm_places: Option<String>,
    pub retention_days: Option<String>,
    pub raw_retention_days: Option<String>,
}

impl Settings {
    /// `RETENTION_DAYS`, never below a week.
    pub fn retention_days(&self) -> u32 {
        parse_days(self.retention_days.as_deref(), DEFAULT_RETENTION_DAYS, 7)
    }

    /// `RAW_RETENTION_DAYS`, never below 30 days.
    pub fn raw_retention_days(&self) -> u32 {
        parse_days(
            self.raw_retention_days.as_deref(),
            DEFAULT_RAW_RETENTION_DAYS,
            30,
        )
    }
}

/// A day count from a var: the default when unset or unreadable, never below
/// `min`, never above ten years.
pub fn parse_days(value: Option<&str>, default: u32, min: u32) -> u32 {
    value
        .and_then(|v| v.trim().parse::<u32>().ok())
        .unwrap_or(default)
        .clamp(min, 3650)
}

/// The popular places: `WARM_PLACES` (comma-separated slugs or names), or
/// [`DEFAULT_WARM_PLACES`]. Unknown entries are skipped, duplicates dropped.
pub fn warm_places(list: Option<&str>) -> Vec<&'static Place> {
    let list = list
        .filter(|l| !l.trim().is_empty())
        .unwrap_or(DEFAULT_WARM_PLACES);
    let mut out: Vec<&'static Place> = Vec::new();
    for entry in list.split(',') {
        if let Some(p) = resolve_seed(entry) {
            if !out.iter().any(|o| o.slug == p.slug) {
                out.push(p);
            }
        }
        if out.len() == MAX_WARM_PLACES {
            break;
        }
    }
    out
}

fn slug_batches<'a>(places: impl Iterator<Item = &'a Place>) -> Vec<Vec<String>> {
    let slugs: Vec<String> = places.map(|p| p.slug.clone()).collect();
    slugs
        .chunks(PLACES_PER_MESSAGE)
        .map(<[String]>::to_vec)
        .collect()
}

/// The jobs one tick puts on the queue.
pub fn plan(tick: Tick, now: DateTime<Utc>, settings: &Settings) -> Vec<Job> {
    match tick {
        Tick::Warm => slug_batches(warm_places(settings.warm_places.as_deref()).into_iter())
            .into_iter()
            .map(|slugs| Job::Warm { slugs })
            .collect(),
        Tick::History => slug_batches(seed().iter())
            .into_iter()
            .map(|slugs| Job::PlaceHistory { slugs })
            .collect(),
        Tick::Maintenance => {
            let mut jobs = vec![Job::StationRollup {
                date: previous_utc_day(now).format("%Y-%m-%d").to_string(),
            }];
            let cutoff = now - Duration::days(i64::from(settings.retention_days()));
            jobs.extend((0..ARCHIVE_MESSAGES_PER_TICK).map(|_| Job::Archive {
                cutoff_ms: cutoff.timestamp_millis(),
            }));
            jobs.extend(
                raw_prefixes(
                    now,
                    settings.raw_retention_days(),
                    RAW_CLEANUP_LOOKBACK_DAYS,
                )
                .into_iter()
                .map(|prefix| Job::RawCleanup { prefix }),
            );
            jobs.push(Job::RateEvents {
                before_ms: (now - Duration::days(1)).timestamp_millis(),
            });
            jobs
        }
    }
}

/// The UTC day before `now`.
pub fn previous_utc_day(now: DateTime<Utc>) -> NaiveDate {
    (now - Duration::days(1)).date_naive()
}

/// `[start, end)` of a UTC day in epoch milliseconds.
pub fn day_bounds_ms(date: NaiveDate) -> (i64, i64) {
    let start = date
        .and_hms_opt(0, 0, 0)
        .map(|d| d.and_utc().timestamp_millis())
        .unwrap_or_default();
    (start, start + 86_400_000)
}

/// Parse a `YYYY-MM-DD` date.
pub fn parse_date(date: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()
}

/// The raw-upload day prefixes (`raw/YYYY/MM/DD/`) that are past retention:
/// the `lookback` days just before the retention line.
pub fn raw_prefixes(now: DateTime<Utc>, retention_days: u32, lookback: u32) -> Vec<String> {
    (0..lookback)
        .map(|i| {
            let day = now - Duration::days(i64::from(retention_days) + 1 + i64::from(i));
            day.format("raw/%Y/%m/%d/").to_string()
        })
        .collect()
}

/// The R2 key for an archived run of observations. It depends only on the
/// rows, so a retried message overwrites the same object.
pub fn archive_key(first_ms: i64, last_ms: i64, ids: &[String]) -> String {
    let mut h = Sha256::new();
    for id in ids {
        h.update(id.as_bytes());
        h.update(b"\n");
    }
    let day = DateTime::from_timestamp_millis(first_ms)
        .unwrap_or_default()
        .format("%Y/%m/%d");
    format!(
        "archive/observations/{day}/{first_ms}-{last_ms}-{}.ndjson",
        hex::encode(&h.finalize()[..8])
    )
}

/// The first daily entry of a `WeatherData`, with the field names the
/// Python backend recorded in `weather_history.daily`. `None` without a
/// daily series.
pub fn daily_record(data: &Value) -> Option<Value> {
    let daily = data.get("daily")?.as_object()?;
    let first = |k: &str| {
        daily
            .get(k)
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .cloned()
            .unwrap_or(Value::Null)
    };
    let date = first("time");
    if date.is_null() {
        return None;
    }
    let mut out = Map::new();
    out.insert("date".into(), date);
    for (name, field) in [
        ("weatherCode", "weather_code"),
        ("tempMax", "temperature_2m_max"),
        ("tempMin", "temperature_2m_min"),
        ("apparentTempMax", "apparent_temperature_max"),
        ("apparentTempMin", "apparent_temperature_min"),
        ("precipSum", "precipitation_sum"),
        ("precipProbMax", "precipitation_probability_max"),
        ("windSpeedMax", "wind_speed_10m_max"),
        ("windGustMax", "wind_gusts_10m_max"),
        ("windDirDominant", "wind_direction_10m_dominant"),
        ("uvIndexMax", "uv_index_max"),
        ("sunrise", "sunrise"),
        ("sunset", "sunset"),
    ] {
        out.insert(name.into(), first(field));
    }
    Some(Value::Object(out))
}

/// The `place_daily` row for a forecast: the date of its first daily entry
/// (the place's local day) or, without one, the UTC date of `now`.
pub fn place_daily_row(data: &Value, now: DateTime<Utc>) -> PlaceDaily {
    let daily = daily_record(data);
    let date = daily
        .as_ref()
        .and_then(|d| d["date"].as_str())
        .and_then(|d| d.get(..10))
        .and_then(parse_date)
        .unwrap_or_else(|| now.date_naive());
    let insights = data.get("insights").filter(|v| !v.is_null()).cloned();
    PlaceDaily {
        date: date.format("%Y-%m-%d").to_string(),
        current: data.get("current").cloned().unwrap_or_else(|| json!({})),
        daily,
        insights,
    }
}

/// One day of a place's history, ready to store.
#[derive(Debug, Clone, PartialEq)]
pub struct PlaceDaily {
    pub date: String,
    pub current: Value,
    pub daily: Option<Value>,
    pub insights: Option<Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(y: i32, m: u32, d: u32, h: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, m, d, h, 0, 0).unwrap()
    }

    #[test]
    fn default_warm_places_all_resolve() {
        let places = warm_places(None);
        assert_eq!(places.len(), DEFAULT_WARM_PLACES.split(',').count());
        assert_eq!(places[0].slug, "harare");
    }

    #[test]
    fn warm_places_skips_unknown_and_duplicates() {
        let places = warm_places(Some("harare, Harare,nowhere-at-all,bulawayo"));
        let slugs: Vec<&str> = places.iter().map(|p| p.slug.as_str()).collect();
        assert_eq!(slugs, ["harare", "bulawayo"]);
        assert_eq!(warm_places(Some("  ")).len(), 6);
    }

    #[test]
    fn crons_map_to_ticks() {
        assert_eq!(Tick::from_cron("*/15 * * * *"), Some(Tick::Warm));
        assert_eq!(Tick::from_cron("30 21 * * *"), Some(Tick::History));
        assert_eq!(Tick::from_cron("15 2 * * *"), Some(Tick::Maintenance));
        assert_eq!(Tick::from_cron("0 0 * * *"), None);
    }

    #[test]
    fn warm_plan_batches_places() {
        let s = Settings::default();
        let jobs = plan(Tick::Warm, at(2026, 10, 5, 12), &s);
        assert_eq!(
            jobs,
            vec![Job::Warm {
                slugs: DEFAULT_WARM_PLACES.split(',').map(String::from).collect()
            }]
        );
    }

    #[test]
    fn history_plan_covers_every_seed_place() {
        let jobs = plan(Tick::History, at(2026, 10, 5, 21), &Settings::default());
        let total: usize = jobs
            .iter()
            .map(|j| match j {
                Job::PlaceHistory { slugs } => {
                    assert!(slugs.len() <= PLACES_PER_MESSAGE);
                    slugs.len()
                }
                _ => panic!("unexpected job"),
            })
            .sum();
        assert_eq!(total, seed().len());
    }

    #[test]
    fn maintenance_plan() {
        let now = at(2026, 10, 5, 2);
        let jobs = plan(Tick::Maintenance, now, &Settings::default());
        assert_eq!(
            jobs[0],
            Job::StationRollup {
                date: "2026-10-04".into()
            }
        );
        let cutoff = (now - Duration::days(90)).timestamp_millis();
        let archives = jobs
            .iter()
            .filter(|j| **j == Job::Archive { cutoff_ms: cutoff })
            .count();
        assert_eq!(archives, ARCHIVE_MESSAGES_PER_TICK);
        assert!(jobs.contains(&Job::RawCleanup {
            prefix: "raw/2025/10/04/".into()
        }));
        assert_eq!(
            jobs.last(),
            Some(&Job::RateEvents {
                before_ms: (now - Duration::days(1)).timestamp_millis()
            })
        );
    }

    #[test]
    fn retention_has_floors() {
        let s = Settings {
            retention_days: Some("1".into()),
            raw_retention_days: Some("junk".into()),
            ..Settings::default()
        };
        assert_eq!(s.retention_days(), 7);
        assert_eq!(s.raw_retention_days(), DEFAULT_RAW_RETENTION_DAYS);
        assert_eq!(parse_days(Some("120"), 90, 7), 120);
    }

    #[test]
    fn raw_prefixes_are_past_retention() {
        let p = raw_prefixes(at(2026, 10, 5, 2), 365, 3);
        assert_eq!(p, ["raw/2025/10/04/", "raw/2025/10/03/", "raw/2025/10/02/"]);
    }

    #[test]
    fn day_bounds() {
        let (s, e) = day_bounds_ms(parse_date("2026-10-04").unwrap());
        assert_eq!(s, at(2026, 10, 4, 0).timestamp_millis());
        assert_eq!(e - s, 86_400_000);
    }

    #[test]
    fn archive_key_is_stable() {
        let ids = vec!["a".to_string(), "b".to_string()];
        let first = at(2026, 7, 1, 3).timestamp_millis();
        let k = archive_key(first, first + 5, &ids);
        assert_eq!(k, archive_key(first, first + 5, &ids));
        assert!(k.starts_with("archive/observations/2026/07/01/"));
        assert!(k.ends_with(".ndjson"));
        assert_ne!(k, archive_key(first, first + 5, &ids[..1]));
    }

    #[test]
    fn daily_record_uses_python_field_names() {
        let data = json!({
            "current": {"temperature_2m": 24.0},
            "daily": {
                "time": ["2026-10-05", "2026-10-06"],
                "weather_code": [2, 3],
                "temperature_2m_max": [28.1, 27.0],
                "temperature_2m_min": [14.2, 13.0],
                "precipitation_sum": [0.0, 1.0],
                "sunrise": ["2026-10-05T05:40"]
            },
            "insights": {"uvHealthConcern": 6}
        });
        let d = daily_record(&data).unwrap();
        assert_eq!(d["date"], "2026-10-05");
        assert_eq!(d["weatherCode"], 2);
        assert_eq!(d["tempMax"], 28.1);
        assert_eq!(d["tempMin"], 14.2);
        assert_eq!(d["precipSum"], 0.0);
        assert_eq!(d["sunrise"], "2026-10-05T05:40");
        assert!(d["uvIndexMax"].is_null());

        let row = place_daily_row(&data, at(2026, 10, 5, 21));
        assert_eq!(row.date, "2026-10-05");
        assert_eq!(row.current["temperature_2m"], 24.0);
        assert_eq!(row.insights.unwrap()["uvHealthConcern"], 6);
    }

    #[test]
    fn place_daily_row_without_daily_uses_utc_date() {
        let row = place_daily_row(&json!({"current": {}}), at(2026, 10, 5, 21));
        assert_eq!(row.date, "2026-10-05");
        assert!(row.daily.is_none());
        assert!(row.insights.is_none());
        assert!(daily_record(&json!({"daily": {"time": []}})).is_none());
    }
}
