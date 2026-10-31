//! Tomorrow.io as ENRICHMENT ONLY (issue #246).
//!
//! Tomorrow.io never provides the forecast baseline (the owner has no paid
//! plan: free tier 25 calls an hour, 500 a day). It contributes only its
//! proprietary `insights` fields, merged onto the baseline's derived insights;
//! it never blocks or replaces the baseline. Ported from
//! `api/py/_enrichment.py`; the pure rules here are pinned to it by
//! `tests/fixtures/model-blend.json`. The Worker (`workers/forecast`) runs the
//! D1 budget, the KV cache and the HTTP call.
//!
//! What the free `/v4/weather/forecast` endpoint actually returns in
//! `timelines.daily[].values` (checked 2026-10-10): of [`ENRICHMENT_FIELDS`]
//! only `cloudBaseAvg` and `cloudCeilingAvg`, null under a clear sky. A 200
//! with nothing to merge is NORMAL: it is cached (1 hour) and reported as
//! `tomorrow`, never counted as a provider failure.

use serde_json::{Map, Value};

use crate::normalize;

/// Hard caps (headroom under the free tier's 25 an hour and 500 a day).
pub const HOURLY_CAP: u64 = 20;
pub const DAILY_CAP: u64 = 400;
/// Caps for normal traffic; the rest is reserved for priority callers.
pub const HOURLY_CAP_NORMAL: u64 = 12;
pub const DAILY_CAP_NORMAL: u64 = 250;

/// Enrichment cache lifetime: 3 hours, so a grid cell costs at most 8 calls a
/// day.
pub const ENRICHMENT_TTL_S: u64 = 3 * 3600;
/// Lifetime of an answer with nothing to merge (a clear sky has no cloud
/// base): still bounds the quota, but a cell that clouds over picks up its
/// cloud base within the hour.
pub const EMPTY_ENRICHMENT_TTL_S: u64 = 3600;
/// A 429 whose headers cannot tell a spent quota from a per-second burst is
/// remembered this briefly.
pub const UNCLEAR_429_MEMO_MS: u64 = 60_000;

pub const HOUR_MS: u64 = 3_600_000;
pub const DAY_MS: u64 = 24 * HOUR_MS;

/// `rate_events.action` of a Tomorrow.io call, and its service-wide client row.
pub const ACTION: &str = "tomorrow";

/// Insights fields Tomorrow.io may override on the baseline. Wind, visibility
/// and dew point stay with the (fresher, hourly) baseline.
/// `uvHealthConcern` is deliberately NOT here (Tomorrow.io's is a 0 to 4
/// category, the rules compare the 0 to 11+ UV index) and neither is
/// `evapotranspiration` (Tomorrow.io's is an hourly average, the rules use
/// daily FAO ET0 in mm/day).
pub const ENRICHMENT_FIELDS: [&str; 7] = [
    "thunderstormProbability",
    "heatStressIndex",
    "gdd10To30",
    "cloudBase",
    "cloudCeiling",
    "moonPhase",
    "precipitationType",
];

/// `X-Enrichment` header values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// Enrichment answered (possibly with nothing to add) or came from cache.
    Enriched,
    /// Our budget, or Tomorrow.io's quota (a 429), is spent.
    SkippedBudget,
    /// The breaker is open, or Tomorrow.io failed.
    SkippedError,
    /// No API key is configured.
    None,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Enriched => "tomorrow",
            Status::SkippedBudget => "skipped-budget",
            Status::SkippedError => "skipped-error",
            Status::None => "none",
        }
    }
}

/// The per-hour and per-day caps for a caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Caps {
    pub hour: u64,
    pub day: u64,
}

pub fn caps(priority: bool) -> Caps {
    if priority {
        Caps {
            hour: HOURLY_CAP,
            day: DAILY_CAP,
        }
    } else {
        Caps {
            hour: HOURLY_CAP_NORMAL,
            day: DAILY_CAP_NORMAL,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reservation {
    Granted,
    HourFull,
    DayFull,
}

/// May one more call go out, given the calls already made in the last hour
/// and the last 24 hours? Priority callers (seed places, paying users) may
/// use the headroom above the normal caps.
pub fn decide(hour_used: u64, day_used: u64, priority: bool) -> Reservation {
    let c = caps(priority);
    if hour_used >= c.hour {
        Reservation::HourFull
    } else if day_used >= c.day {
        Reservation::DayFull
    } else {
        Reservation::Granted
    }
}

/// Baseline-derived insights with Tomorrow.io's [`ENRICHMENT_FIELDS`] on top.
/// Always an object.
pub fn merge_insights(baseline: &Value, enrichment: &Value) -> Value {
    let mut merged: Map<String, Value> = baseline.as_object().cloned().unwrap_or_default();
    if let Some(e) = enrichment.as_object() {
        for key in ENRICHMENT_FIELDS {
            if let Some(v) = e.get(key).filter(|v| !v.is_null()) {
                merged.insert(key.to_owned(), v.clone());
            }
        }
    }
    Value::Object(merged)
}

/// Read a Tomorrow.io 429's rate-limit headers (`get` returns a header value
/// by lower-case name).
///
/// `Some(true)`: a remaining-count header is 0, the hourly or daily quota is
/// spent. `Some(false)`: the headers show quota left, so it was a per-second
/// burst. `None`: no readable header, cannot tell.
pub fn classify_429(get: impl Fn(&str) -> Option<String>) -> Option<bool> {
    let remaining: Vec<i64> = ["x-ratelimit-remaining-hour", "x-ratelimit-remaining-day"]
        .iter()
        .filter_map(|n| get(n))
        .filter_map(|v| v.trim().parse::<i64>().ok())
        .collect();
    remaining.iter().min().map(|m| *m <= 0)
}

/// In-process memos for one isolate (as the Python keeps per warm instance):
/// budget tiers known to be exhausted for the current hour, and a remembered
/// 429. Time is passed in.
#[derive(Debug, Default)]
pub struct Memo {
    exhausted: [Option<u64>; 2],
    limited_hour: Option<u64>,
    limited_until_ms: Option<u64>,
}

fn hour_bucket(now_ms: u64) -> u64 {
    now_ms / HOUR_MS
}

impl Memo {
    pub const fn new() -> Self {
        Memo {
            exhausted: [None, None],
            limited_hour: None,
            limited_until_ms: None,
        }
    }

    /// Record a Tomorrow.io 429. With no `ttl_ms` the quota is spent for the
    /// rest of this hour (every tier stops); with one, only a short pause.
    pub fn mark_rate_limited(&mut self, now_ms: u64, ttl_ms: Option<u64>) {
        match ttl_ms {
            Some(ttl) => self.limited_until_ms = Some(now_ms + ttl),
            None => {
                let b = hour_bucket(now_ms);
                self.limited_hour = Some(b);
                self.exhausted = [Some(b), Some(b)];
            }
        }
    }

    pub fn rate_limited(&self, now_ms: u64) -> bool {
        self.limited_hour == Some(hour_bucket(now_ms))
            || self.limited_until_ms.is_some_and(|u| now_ms < u)
    }

    pub fn exhausted(&self, priority: bool, now_ms: u64) -> bool {
        self.exhausted[usize::from(priority)] == Some(hour_bucket(now_ms))
    }

    pub fn mark_exhausted(&mut self, priority: bool, now_ms: u64) {
        self.exhausted[usize::from(priority)] = Some(hour_bucket(now_ms));
    }
}

/// The KV key of a grid cell's enrichment (the same cell the forecast cache
/// uses, so a cell costs at most 8 calls a day).
pub fn cache_key(grid_key: &str) -> String {
    format!("enr:v1:{grid_key}")
}

/// The Tomorrow.io daily-timestep URL. The API key goes in the `apikey`
/// header, never the URL.
pub fn tomorrow_url(lat: f64, lon: f64) -> String {
    format!(
        "{}?{}",
        normalize::TOMORROW_FORECAST_URL,
        normalize::query_string(&[
            ("location", format!("{lat},{lon}")),
            ("timesteps", "1d".into()),
            ("units", "metric".into()),
        ])
    )
}

/// The insights Tomorrow.io may contribute, from a `/v4/weather/forecast`
/// body. `Ok(empty)` when it answered but carried no field we merge (normal);
/// `Err` when the body is not a healthy answer (no daily timeline), which is
/// the only case, besides a non-200 or a timeout, that counts against the
/// Tomorrow.io breaker.
pub fn extract_insights(raw: &Value) -> Result<Map<String, Value>, &'static str> {
    let daily = raw
        .pointer("/timelines/daily")
        .and_then(Value::as_array)
        .filter(|d| !d.is_empty());
    if daily.is_none() {
        return Err("no daily timeline");
    }
    let normalized = normalize::normalize_tomorrow(raw);
    Ok(normalized["insights"]
        .as_object()
        .map(|i| {
            i.iter()
                .filter(|(k, v)| ENRICHMENT_FIELDS.contains(&k.as_str()) && !v.is_null())
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        })
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    fn fx() -> Value {
        serde_json::from_str(include_str!("../../../../tests/fixtures/model-blend.json")).unwrap()
    }

    #[test]
    fn constants_match_the_python() {
        let c = &fx()["enrichment_constants"];
        assert_eq!(c["hourly_cap"], HOURLY_CAP);
        assert_eq!(c["daily_cap"], DAILY_CAP);
        assert_eq!(c["hourly_cap_normal"], HOURLY_CAP_NORMAL);
        assert_eq!(c["daily_cap_normal"], DAILY_CAP_NORMAL);
        assert_eq!(c["ttl_s"], ENRICHMENT_TTL_S);
        assert_eq!(c["empty_ttl_s"], EMPTY_ENRICHMENT_TTL_S);
        assert_eq!(
            c["unclear_429_memo_s"].as_u64().unwrap() * 1000,
            UNCLEAR_429_MEMO_MS
        );
        assert_eq!(c["fields"], json!(ENRICHMENT_FIELDS));
    }

    #[test]
    fn merging_matches_the_python() {
        for c in fx()["merge_insights"].as_array().unwrap() {
            assert_eq!(
                merge_insights(&c["baseline"], &c["enrichment"]),
                c["expected"],
                "{c}"
            );
        }
    }

    #[test]
    fn a_429_is_classified_like_the_python() {
        for c in fx()["classify_429"].as_array().unwrap() {
            let headers: HashMap<String, String> = c["headers"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned()))
                .collect();
            let got = classify_429(|n| headers.get(n).cloned());
            let want = match &c["expected"] {
                Value::Null => None,
                v => v.as_bool(),
            };
            assert_eq!(got, want, "{c}");
        }
    }

    #[test]
    fn the_normal_and_hard_caps_are_the_owners() {
        // Normal traffic stops at 12 an hour and 250 a day; priority at 20 and 400.
        assert_eq!(decide(11, 249, false), Reservation::Granted);
        assert_eq!(decide(12, 0, false), Reservation::HourFull);
        assert_eq!(decide(0, 250, false), Reservation::DayFull);
        assert_eq!(decide(12, 250, true), Reservation::Granted, "headroom");
        assert_eq!(decide(19, 399, true), Reservation::Granted);
        assert_eq!(decide(20, 0, true), Reservation::HourFull);
        assert_eq!(decide(0, 400, true), Reservation::DayFull);
        // Hard caps sit under the free tier (25 an hour, 500 a day).
        const { assert!(HOURLY_CAP < 25 && DAILY_CAP < 500) };
    }

    #[test]
    fn a_429_stops_calls_for_the_hour_and_a_short_pause_does_not() {
        let mut m = Memo::new();
        let t = 10 * HOUR_MS + 5_000;
        assert!(!m.rate_limited(t));
        m.mark_rate_limited(t, None);
        assert!(m.rate_limited(t + 1_000));
        assert!(
            m.exhausted(false, t) && m.exhausted(true, t),
            "every tier stops"
        );
        assert!(
            !m.rate_limited(11 * HOUR_MS + 1),
            "the next hour is free again"
        );
        assert!(!m.exhausted(false, 11 * HOUR_MS + 1));

        let mut m = Memo::new();
        m.mark_rate_limited(t, Some(UNCLEAR_429_MEMO_MS));
        assert!(m.rate_limited(t + 59_999));
        assert!(!m.rate_limited(t + 60_000));
        assert!(!m.exhausted(false, t), "a burst is not our budget");

        let mut m = Memo::new();
        m.mark_exhausted(false, t);
        assert!(m.exhausted(false, t) && !m.exhausted(true, t));
    }

    #[test]
    fn statuses_are_the_header_values() {
        assert_eq!(Status::Enriched.as_str(), "tomorrow");
        assert_eq!(Status::SkippedBudget.as_str(), "skipped-budget");
        assert_eq!(Status::SkippedError.as_str(), "skipped-error");
        assert_eq!(Status::None.as_str(), "none");
    }

    #[test]
    fn the_url_has_no_key_and_asks_for_daily_values_only() {
        let u = tomorrow_url(-17.83, 31.05);
        assert_eq!(
            u,
            "https://api.tomorrow.io/v4/weather/forecast?location=-17.83,31.05&timesteps=1d&units=metric"
        );
        assert!(!u.contains("apikey"));
        assert_eq!(cache_key("cell:-17.85_31.05"), "enr:v1:cell:-17.85_31.05");
    }

    #[test]
    fn only_a_body_with_a_daily_timeline_is_healthy() {
        assert_eq!(extract_insights(&json!({})), Err("no daily timeline"));
        assert_eq!(
            extract_insights(&json!({"timelines": {"daily": []}})),
            Err("no daily timeline")
        );
        // A clear sky: nothing to merge, and that is a healthy answer.
        let clear = json!({"timelines": {"daily": [{"time": "2026-10-31T00:00:00Z", "values": {"temperatureMax": 30}}]}});
        assert_eq!(extract_insights(&clear), Ok(Map::new()));
        let cloudy = json!({"timelines": {"daily": [{"time": "t", "values": {
            "cloudBaseAvg": 1.2, "cloudCeilingAvg": null, "moonPhase": 4,
            "windSpeedMax": 9.0, "uvHealthConcernMax": 3, "evapotranspirationAvg": 0.2,
            "dewPointAvg": 7.0, "thunderstormProbability": 30}}]}});
        let got = extract_insights(&cloudy).unwrap();
        assert_eq!(got.get("cloudBase"), Some(&json!(1.2)));
        assert_eq!(got.get("moonPhase"), Some(&json!(4)));
        assert_eq!(got.get("thunderstormProbability"), Some(&json!(30)));
        // Wind, UV, ET0 and dew point stay with the baseline.
        for k in [
            "windSpeed",
            "uvHealthConcern",
            "evapotranspiration",
            "dewPoint",
            "cloudCeiling",
        ] {
            assert!(!got.contains_key(k), "{k}");
        }
    }
}
