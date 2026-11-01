//! Air quality: the EPA AQI (0 to 500) from Open-Meteo pollutant data.
//!
//! Ported from `api/py/_air_quality.py`. Open-Meteo's Air Quality API gives
//! concentrations in µg/m³; each pollutant gets an EPA sub-index by linear
//! interpolation between breakpoints, and the overall AQI is the highest
//! sub-index (the dominant pollutant). The breakpoint tables are EPA's,
//! converted from ppb/ppm to µg/m³ at 25 °C and 1 atm. NH3 has no EPA
//! breakpoints: its concentration is reported but does not score.
//!
//! The same request also asks for the hourly US AQI with `past_days=1`, so the
//! answer can say whether the air is better or worse than at this hour
//! yesterday ([`us_aqi_same_hour_pair`], [`trend`]). Both are pinned to the
//! Python by `tests/fixtures/air-quality-trend.json`, whose `expected` values
//! real functions produced before they were removed (frozen oracle data, #333).

use chrono::{Duration, NaiveDate, NaiveDateTime};
use serde_json::{json, Map, Value};

/// The Open-Meteo Air Quality endpoint.
pub const OPEN_METEO_AQ_URL: &str = "https://air-quality-api.open-meteo.com/v1/air-quality";

/// Cache lifetime, as in the Python backend: one hour.
pub const CACHE_TTL_SECONDS: u64 = 3600;

/// Open-Meteo field name, then the key the app uses.
pub const POLLUTANT_FIELDS: [(&str, &str); 7] = [
    ("pm2_5", "pm2_5"),
    ("pm10", "pm10"),
    ("ozone", "o3"),
    ("nitrogen_dioxide", "no2"),
    ("sulphur_dioxide", "so2"),
    ("carbon_monoxide", "co"),
    ("ammonia", "nh3"),
];

/// WHO 2021 guideline values (µg/m³), shown next to the EPA buckets.
pub const WHO_GUIDELINES_UGM3: [(&str, f64); 7] = [
    ("pm2_5", 15.0),
    ("pm10", 45.0),
    ("o3", 100.0),
    ("no2", 25.0),
    ("so2", 40.0),
    ("co", 4000.0),
    ("nh3", 0.0),
];

/// `(concentration low, concentration high, AQI low, AQI high)`.
type Breakpoint = (f64, f64, f64, f64);

const PM2_5: [Breakpoint; 6] = [
    (0.0, 12.0, 0.0, 50.0),
    (12.1, 35.4, 51.0, 100.0),
    (35.5, 55.4, 101.0, 150.0),
    (55.5, 150.4, 151.0, 200.0),
    (150.5, 250.4, 201.0, 300.0),
    (250.5, 500.4, 301.0, 500.0),
];
const PM10: [Breakpoint; 6] = [
    (0.0, 54.0, 0.0, 50.0),
    (55.0, 154.0, 51.0, 100.0),
    (155.0, 254.0, 101.0, 150.0),
    (255.0, 354.0, 151.0, 200.0),
    (355.0, 424.0, 201.0, 300.0),
    (425.0, 604.0, 301.0, 500.0),
];
const O3: [Breakpoint; 6] = [
    (0.0, 106.0, 0.0, 50.0),
    (107.0, 137.0, 51.0, 100.0),
    (138.0, 167.0, 101.0, 150.0),
    (168.0, 206.0, 151.0, 200.0),
    (207.0, 392.0, 201.0, 300.0),
    (393.0, 784.0, 301.0, 500.0),
];
const NO2: [Breakpoint; 6] = [
    (0.0, 100.0, 0.0, 50.0),
    (101.0, 188.0, 51.0, 100.0),
    (189.0, 677.0, 101.0, 150.0),
    (678.0, 1221.0, 151.0, 200.0),
    (1222.0, 2349.0, 201.0, 300.0),
    (2350.0, 3853.0, 301.0, 500.0),
];
const SO2: [Breakpoint; 6] = [
    (0.0, 92.0, 0.0, 50.0),
    (93.0, 197.0, 51.0, 100.0),
    (198.0, 485.0, 101.0, 150.0),
    (486.0, 797.0, 151.0, 200.0),
    (798.0, 1583.0, 201.0, 300.0),
    (1584.0, 2630.0, 301.0, 500.0),
];
const CO: [Breakpoint; 6] = [
    (0.0, 5040.0, 0.0, 50.0),
    (5041.0, 10764.0, 51.0, 100.0),
    (10765.0, 14199.0, 101.0, 150.0),
    (14200.0, 17634.0, 151.0, 200.0),
    (17635.0, 34812.0, 201.0, 300.0),
    (34813.0, 57612.0, 301.0, 500.0),
];

fn breakpoints(pollutant: &str) -> Option<&'static [Breakpoint]> {
    Some(match pollutant {
        "pm2_5" => &PM2_5,
        "pm10" => &PM10,
        "o3" => &O3,
        "no2" => &NO2,
        "so2" => &SO2,
        "co" => &CO,
        _ => return None,
    })
}

fn interpolate(value: f64, (bp_lo, bp_hi, aqi_lo, aqi_hi): Breakpoint) -> i64 {
    // Python's round() rounds half to even; keep that.
    (((aqi_hi - aqi_lo) / (bp_hi - bp_lo)) * (value - bp_lo) + aqi_lo).round_ties_even() as i64
}

/// One pollutant's EPA sub-index. `None` for a negative or non-finite value,
/// or a value that falls in a gap between two breakpoints. Above the top
/// breakpoint it extrapolates the last segment (not clamped).
pub fn sub_index(value: f64, table: &[Breakpoint]) -> Option<i64> {
    if !value.is_finite() || value < 0.0 {
        return None;
    }
    if let Some(bp) = table.iter().find(|bp| bp.0 <= value && value <= bp.1) {
        return Some(interpolate(value, *bp));
    }
    let last = *table.last()?;
    (value > last.1).then(|| interpolate(value, last))
}

/// The EPA category for an AQI score.
pub fn level_for(aqi: i64) -> &'static str {
    match aqi {
        i64::MIN..=50 => "good",
        51..=100 => "moderate",
        101..=150 => "unhealthy_sensitive",
        151..=200 => "unhealthy",
        201..=300 => "very_unhealthy",
        _ => "hazardous",
    }
}

/// The overall AQI from a pollutant map (µg/m³; `None` for missing):
/// `{aqi, level, dominantPollutant, subIndexes}`. With nothing scoreable it
/// is `{aqi: 0, level: "good", dominantPollutant: null}`.
pub fn compute(pollutants: &[(&str, Option<f64>)]) -> Value {
    let mut subs = Map::new();
    let mut dominant: Option<(&str, i64)> = None;
    for (key, value) in pollutants {
        let (Some(v), Some(table)) = (value, breakpoints(key)) else {
            continue;
        };
        if let Some(idx) = sub_index(*v, table) {
            subs.insert((*key).to_owned(), json!(idx));
            // The first maximum wins, as Python's max() does.
            if dominant.is_none_or(|(_, best)| idx > best) {
                dominant = Some((key, idx));
            }
        }
    }
    match dominant {
        None => json!({"aqi": 0, "level": "good", "dominantPollutant": null, "subIndexes": {}}),
        Some((key, aqi)) => json!({
            "aqi": aqi,
            "level": level_for(aqi),
            "dominantPollutant": key,
            "subIndexes": subs,
        }),
    }
}

/// The Open-Meteo Air Quality request for a point: the current pollutant
/// values, and the hourly US AQI for yesterday and today (one request, so the
/// trend costs no second round trip).
pub fn open_meteo_url(lat: f64, lon: f64) -> String {
    let fields: Vec<&str> = POLLUTANT_FIELDS.iter().map(|(f, _)| *f).collect();
    format!(
        "{OPEN_METEO_AQ_URL}?latitude={lat}&longitude={lon}&current={}&hourly=us_aqi&past_days=1&timezone=auto",
        fields.join(",")
    )
}

/// The pollutant map from an Open-Meteo answer, in the app's keys. Numbers
/// and numeric strings are read; anything else is `None`.
pub fn pollutants_from_open_meteo(raw: &Value) -> Vec<(&'static str, Option<f64>)> {
    let current = &raw["current"];
    POLLUTANT_FIELDS
        .iter()
        .map(|(field, key)| {
            let v = &current[*field];
            let n = v
                .as_f64()
                .or_else(|| v.as_str().and_then(|s| s.trim().parse::<f64>().ok()))
                .filter(|x| x.is_finite());
            (*key, n)
        })
        .collect()
}

/// The response body the app reads (`/api/py/airquality`), less `source`
/// and `fetchedAt`, which the Worker adds.
pub fn payload(pollutants: &[(&str, Option<f64>)]) -> Value {
    let mut out = compute(pollutants);
    let map: Map<String, Value> = pollutants
        .iter()
        .map(|(k, v)| ((*k).to_owned(), v.map_or(Value::Null, |x| json!(x))))
        .collect();
    out["pollutants"] = Value::Object(map);
    out
}

/// A change of more than this many US AQI points since the same hour
/// yesterday is "better" or "worse"; anything within the band is "similar".
pub const AQI_TREND_BAND: i64 = 10;

/// Today's and yesterday's US AQI at the current local hour.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SameHourPair {
    pub today: Option<i64>,
    pub yesterday: Option<i64>,
}

/// The local time of an ISO timestamp, to the hour, or `None` when it is not
/// one. Port of `datetime.fromisoformat` for the shapes Open-Meteo sends
/// (`2026-11-01T03:00`, with seconds, a space, a zone suffix, or a date only).
fn parse_local_hour(s: &str) -> Option<NaiveDateTime> {
    let s = s.trim();
    let date = NaiveDate::parse_from_str(s.get(..10)?, "%Y-%m-%d").ok()?;
    let rest = s.get(10..)?;
    if rest.is_empty() {
        return date.and_hms_opt(0, 0, 0);
    }
    if !(rest.starts_with('T') || rest.starts_with(' ')) {
        return None;
    }
    let hour: u32 = rest.get(1..3)?.parse().ok()?;
    let after = rest.get(3..)?;
    if !after
        .chars()
        .all(|c| c.is_ascii_digit() || ":.+-Z".contains(c))
    {
        return None;
    }
    date.and_hms_opt(hour, 0, 0)
}

/// An integer AQI from a JSON number or numeric string, rounding half to even
/// (Python's `int(round(float(x)))`).
fn aqi_int(v: &Value) -> Option<i64> {
    let f = match v {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => s.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    f.is_finite().then(|| f.round_ties_even() as i64)
}

/// Today's and yesterday's US AQI at the current local hour, from the hourly
/// `us_aqi` series requested with `past_days=1` (port of
/// `_us_aqi_same_hour_pair`). Both values come from Open-Meteo's own US AQI,
/// so the comparison is like-for-like. A missing series, one of a different
/// length from `hourly.time`, or an unreadable `current.time` gives `None`
/// for both.
pub fn us_aqi_same_hour_pair(raw: &Value) -> SameHourPair {
    let empty = SameHourPair::default();
    let Some(current_time) = raw
        .pointer("/current/time")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
    else {
        return empty;
    };
    let times = raw
        .pointer("/hourly/time")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    let values = raw
        .pointer("/hourly/us_aqi")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    if times.len() != values.len() {
        return empty;
    }
    let Some(now) = parse_local_hour(current_time) else {
        return empty;
    };
    // Match on "YYYY-MM-DDTHH" so a minute or second suffix never breaks it.
    // The last matching hour wins, as the Python's dict does.
    let at = |when: NaiveDateTime| -> Option<i64> {
        let key = when.format("%Y-%m-%dT%H").to_string();
        let i = times.iter().rposition(|t| {
            t.as_str()
                .is_some_and(|t| t.chars().take(13).collect::<String>() == key)
        })?;
        aqi_int(&values[i])
    };
    SameHourPair {
        today: at(now),
        yesterday: at(now - Duration::days(1)),
    }
}

/// Today's US AQI against yesterday's at the same hour: `"better"` when more
/// than [`AQI_TREND_BAND`] points lower, `"worse"` when more than that higher,
/// else `"similar"`; `None` when either value is missing.
pub fn trend(today: Option<i64>, yesterday: Option<i64>) -> Option<&'static str> {
    let delta = today? - yesterday?;
    Some(if delta < -AQI_TREND_BAND {
        "better"
    } else if delta > AQI_TREND_BAND {
        "worse"
    } else {
        "similar"
    })
}

/// Put `todayUsAqi`, `yesterdayAqi` and `trend` on a payload (JSON `null` for
/// what is missing, so the shape never changes).
pub fn add_trend(body: &mut Value, pair: SameHourPair) {
    body["todayUsAqi"] = pair.today.map_or(Value::Null, |v| json!(v));
    body["yesterdayAqi"] = pair.yesterday.map_or(Value::Null, |v| json!(v));
    body["trend"] = trend(pair.today, pair.yesterday).map_or(Value::Null, |t| json!(t));
}

/// The whole answer body (less `source`, `whoGuidelines` and `fetchedAt`,
/// which the Worker adds) from an Open-Meteo Air Quality response.
pub fn payload_from_open_meteo(raw: &Value) -> Value {
    let mut body = payload(&pollutants_from_open_meteo(raw));
    add_trend(&mut body, us_aqi_same_hour_pair(raw));
    body
}

/// The WHO guideline values as a JSON object.
pub fn who_guidelines() -> Value {
    Value::Object(
        WHO_GUIDELINES_UGM3
            .iter()
            .map(|(k, v)| ((*k).to_owned(), json!(v)))
            .collect(),
    )
}

/// The cache key for a point: four decimals (about 11 m), as in Python.
pub fn cache_key(lat: f64, lon: f64) -> String {
    format!("aq:v1:{lat:.4}_{lon:.4}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sub_index_matches_the_epa_anchors() {
        assert_eq!(sub_index(12.0, &PM2_5), Some(50));
        assert_eq!(sub_index(12.1, &PM2_5), Some(51));
        assert_eq!(sub_index(35.5, &PM2_5), Some(101));
        assert_eq!(sub_index(55.5, &PM2_5), Some(151));
        assert_eq!(sub_index(250.5, &PM2_5), Some(301));
        assert_eq!(sub_index(0.0, &PM2_5), Some(0));
        assert_eq!(sub_index(54.0, &PM10), Some(50));
        assert_eq!(sub_index(55.0, &PM10), Some(51));
        let mid = sub_index(24.0, &PM2_5).unwrap();
        assert!((60..=90).contains(&mid));
    }

    #[test]
    fn sub_index_extrapolates_and_refuses_negatives() {
        assert!(sub_index(1000.0, &PM2_5).unwrap() > 500);
        assert_eq!(sub_index(-1.0, &PM2_5), None);
        assert_eq!(sub_index(f64::NAN, &PM2_5), None);
        // A value in the gap between two segments scores nothing, as in Python.
        assert_eq!(sub_index(12.05, &PM2_5), None);
    }

    #[test]
    fn levels() {
        for (aqi, level) in [
            (0, "good"),
            (50, "good"),
            (51, "moderate"),
            (100, "moderate"),
            (101, "unhealthy_sensitive"),
            (150, "unhealthy_sensitive"),
            (151, "unhealthy"),
            (200, "unhealthy"),
            (201, "very_unhealthy"),
            (300, "very_unhealthy"),
            (301, "hazardous"),
            (750, "hazardous"),
        ] {
            assert_eq!(level_for(aqi), level, "{aqi}");
        }
    }

    #[test]
    fn compute_picks_the_dominant_pollutant() {
        let r = compute(&[("pm2_5", Some(35.5)), ("pm10", Some(10.0))]);
        assert_eq!(r["aqi"], 101);
        assert_eq!(r["dominantPollutant"], "pm2_5");
        assert_eq!(r["level"], "unhealthy_sensitive");

        let r = compute(&[("pm10", Some(200.0)), ("o3", Some(220.0))]);
        assert_eq!(r["dominantPollutant"], "o3");
        assert!(r["aqi"].as_i64().unwrap() > 150);

        let r = compute(&[("nh3", Some(100.0)), ("pm2_5", Some(3.0))]);
        assert_eq!(r["dominantPollutant"], "pm2_5");

        let r = compute(&[("pm2_5", None), ("pm10", Some(60.0))]);
        assert_eq!(r["dominantPollutant"], "pm10");

        let r = compute(&[("pm2_5", Some(12.0)), ("pm10", Some(54.0))]);
        assert_eq!(r["subIndexes"]["pm2_5"], 50);
        assert_eq!(r["subIndexes"]["pm10"], 50);
    }

    #[test]
    fn compute_with_nothing_scoreable_is_good() {
        for input in [vec![], vec![("pm2_5", None), ("pm10", None)]] {
            let r = compute(&input);
            assert_eq!(r["aqi"], 0);
            assert_eq!(r["level"], "good");
            assert!(r["dominantPollutant"].is_null());
        }
    }

    #[test]
    fn reads_open_meteo_and_builds_the_payload() {
        let raw = json!({"current": {"pm2_5": 24.1, "pm10": "38.0", "ozone": null,
            "nitrogen_dioxide": 5, "sulphur_dioxide": "x", "carbon_monoxide": 200.0, "ammonia": 1.5}});
        let p = pollutants_from_open_meteo(&raw);
        assert_eq!(p[0], ("pm2_5", Some(24.1)));
        assert_eq!(p[1], ("pm10", Some(38.0)));
        assert_eq!(p[2], ("o3", None));
        assert_eq!(p[4], ("so2", None));
        let body = payload(&p);
        assert_eq!(body["pollutants"]["pm10"], 38.0);
        assert!(body["pollutants"]["o3"].is_null());
        assert_eq!(body["dominantPollutant"], "pm2_5");
        assert_eq!(who_guidelines()["pm2_5"], 15.0);
    }

    fn trend_fx() -> Value {
        serde_json::from_str(include_str!(
            "../../../../tests/fixtures/air-quality-trend.json"
        ))
        .unwrap()
    }

    #[test]
    fn the_trend_band_is_the_pythons() {
        assert_eq!(trend_fx()["band"], AQI_TREND_BAND);
    }

    #[test]
    fn the_trend_matches_the_python() {
        let fx = trend_fx();
        let rows = fx["trend"].as_array().unwrap();
        assert!(rows.len() >= 12);
        for r in rows {
            let got = trend(r["today"].as_i64(), r["yesterday"].as_i64());
            assert_eq!(
                got.map_or(Value::Null, Value::from),
                r["expected"],
                "{} vs {}",
                r["today"],
                r["yesterday"]
            );
        }
    }

    #[test]
    fn the_same_hour_pair_and_the_whole_payload_match_the_python() {
        let fx = trend_fx();
        let cases = fx["cases"].as_array().unwrap();
        assert!(cases.len() >= 15);
        for c in cases {
            let pair = us_aqi_same_hour_pair(&c["raw"]);
            let side = |k: &str| c["side"].get(k).cloned().unwrap_or(Value::Null);
            assert_eq!(
                pair.today.map_or(Value::Null, |v| json!(v)),
                side("todayUsAqi"),
                "{} (today)",
                c["name"]
            );
            assert_eq!(
                pair.yesterday.map_or(Value::Null, |v| json!(v)),
                side("yesterdayAqi"),
                "{} (yesterday)",
                c["name"]
            );
            assert_eq!(
                payload_from_open_meteo(&c["raw"]),
                c["expected"],
                "{}",
                c["name"]
            );
        }
    }

    #[test]
    fn the_request_asks_for_yesterday_and_today() {
        let url = open_meteo_url(-17.8, 31.0);
        assert!(url.contains("hourly=us_aqi"));
        assert!(url.contains("past_days=1"));
    }

    #[test]
    fn cache_key_has_four_decimals() {
        assert_eq!(cache_key(-17.8252, 31.0335), "aq:v1:-17.8252_31.0335");
        assert_eq!(
            cache_key(-17.82521, 31.03349),
            cache_key(-17.82519, 31.0335)
        );
        assert!(open_meteo_url(-17.8, 31.0).contains("current=pm2_5,pm10,ozone"));
    }
}
