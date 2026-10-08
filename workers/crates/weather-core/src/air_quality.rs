//! Air quality: the EPA AQI (0 to 500) from Open-Meteo pollutant data.
//!
//! Ported from `api/py/_air_quality.py`. Open-Meteo's Air Quality API gives
//! concentrations in µg/m³; each pollutant gets an EPA sub-index by linear
//! interpolation between breakpoints, and the overall AQI is the highest
//! sub-index (the dominant pollutant). The breakpoint tables are EPA's,
//! converted from ppb/ppm to µg/m³ at 25 °C and 1 atm. NH3 has no EPA
//! breakpoints: its concentration is reported but does not score.

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

/// The Open-Meteo Air Quality request for a point (current values only).
pub fn open_meteo_url(lat: f64, lon: f64) -> String {
    let fields: Vec<&str> = POLLUTANT_FIELDS.iter().map(|(f, _)| *f).collect();
    format!(
        "{OPEN_METEO_AQ_URL}?latitude={lat}&longitude={lon}&current={}&timezone=auto",
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
