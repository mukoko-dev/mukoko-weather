//! Derived weather insights, computed from global-model data (no Tomorrow.io).
//!
//! Ported from `api/py/_insights.py` and pinned to it by
//! `tests/fixtures/model-blend.json`. Every field the suitability rules and
//! ActivityInsights read (dew point, GDD, heat index, thunderstorm
//! probability, UV, visibility, ET0, moon phase, cloud base and ceiling) is
//! derived here from the Open-Meteo baseline; Tomorrow.io is merged on top
//! only as an optional enrichment (`enrichment.rs`).
//!
//! Units follow the `WeatherInsights` type: degrees C, km/h, km (visibility,
//! cloud base and ceiling), mm (evapotranspiration), % (thunderstorm
//! probability).

use chrono::{DateTime, TimeZone, Utc};
use serde_json::{json, Map, Value};

use crate::blend::pyround;

/// Magnus-formula coefficients (Alduchov and Eskridge 1996), -40 to 50 C.
const MAGNUS_A: f64 = 17.625;
const MAGNUS_B: f64 = 243.04;

/// Hours ahead scanned for convective potential.
pub const CONVECTIVE_WINDOW_H: usize = 6;

/// Intermediate fields requested only to derive insights; stripped before the
/// payload is cached so the WeatherData shape is unchanged.
pub const INTERMEDIATE_HOURLY: [&str; 3] = ["cape", "lifted_index", "dew_point_2m"];
pub const INTERMEDIATE_DAILY: [&str; 1] = ["et0_fao_evapotranspiration"];

/// The four GDD fields the rules can read: (key, base C, cap C).
pub const GDD_DEFINITIONS: [(&str, f64, f64); 4] = [
    ("gdd10To30", 10.0, 30.0),
    ("gdd10To31", 10.0, 31.0),
    ("gdd08To30", 8.0, 30.0),
    ("gdd03To25", 3.0, 25.0),
];

fn as_num(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64(),
        _ => None,
    }
}

/// Dew point (C) from air temperature and relative humidity (Magnus).
pub fn dew_point_c(temp_c: Option<f64>, rh_pct: Option<f64>) -> Option<f64> {
    let (t, rh) = (temp_c?, rh_pct?);
    let rh = rh.clamp(1.0, 100.0);
    let gamma = (rh / 100.0).ln() + (MAGNUS_A * t) / (MAGNUS_B + t);
    Some(pyround((MAGNUS_B * gamma) / (MAGNUS_A - gamma), 1))
}

/// NOAA heat index (Rothfusz regression) in C. Below 27 C (80 F) the
/// regression is not valid and the heat index is the air temperature.
pub fn heat_index_c(temp_c: Option<f64>, rh_pct: Option<f64>) -> Option<f64> {
    let (t_c, rh) = (temp_c?, rh_pct?.clamp(0.0, 100.0));
    if t_c < 27.0 {
        return Some(pyround(t_c, 1));
    }
    let t = t_c * 9.0 / 5.0 + 32.0;
    let mut hi = -42.379 + 2.04901523 * t + 10.14333127 * rh
        - 0.22475541 * t * rh
        - 6.83783e-3 * t * t
        - 5.481717e-2 * rh * rh
        + 1.22874e-3 * t * t * rh
        + 8.5282e-4 * t * rh * rh
        - 1.99e-6 * t * t * rh * rh;
    if rh < 13.0 && (80.0..=112.0).contains(&t) {
        hi -= ((13.0 - rh) / 4.0) * ((17.0 - (t - 95.0).abs()) / 17.0).sqrt();
    } else if rh > 85.0 && (80.0..=87.0).contains(&t) {
        hi += ((rh - 85.0) / 10.0) * ((87.0 - t) / 5.0);
    }
    Some(pyround((hi - 32.0) * 5.0 / 9.0, 1))
}

/// Daily GDD with base and upper-cap clamping (the standard maize method).
pub fn growing_degree_days(
    tmax: Option<f64>,
    tmin: Option<f64>,
    base: f64,
    cap: f64,
) -> Option<f64> {
    let hi = tmax?.max(base).min(cap);
    let lo = tmin?.max(base).min(cap);
    Some(pyround(((hi + lo) / 2.0 - base).max(0.0), 1))
}

/// `(thunderstormProbability, precipitationType)` implied by a WMO code.
/// precipitationType: 0 none, 1 rain, 2 snow, 3 freezing rain or drizzle.
pub fn wmo_hazards(code: Option<i64>) -> (i64, i64) {
    let c = code.unwrap_or(0);
    let thunder = if c >= 99 {
        95
    } else if c >= 96 {
        85
    } else if c >= 95 {
        70
    } else {
        0
    };
    let ptype = if (71..=77).contains(&c) || (85..=86).contains(&c) {
        2
    } else if matches!(c, 56 | 57 | 66 | 67) {
        3
    } else if c >= 51 {
        1
    } else {
        0
    };
    (thunder, ptype)
}

/// Thunderstorm potential (%) from CAPE (J/kg) and lifted index (K). A
/// deliberately simple proxy, not a calibrated probability: CAPE >= 2500 or
/// LI <= -6 is 60; >= 1000 or <= -3 is 40; >= 500 or <= -1 is 20.
pub fn convective_proxy(cape: Option<f64>, lifted_index: Option<f64>) -> i64 {
    let c = |t: f64| cape.is_some_and(|v| v >= t);
    let l = |t: f64| lifted_index.is_some_and(|v| v <= t);
    if c(2500.0) || l(-6.0) {
        60
    } else if c(1000.0) || l(-3.0) {
        40
    } else if c(500.0) || l(-1.0) {
        20
    } else {
        0
    }
}

const SYNODIC_DAYS: f64 = 29.530588853;

/// Moon phase on Tomorrow.io's 0 to 7 scale (0 new, 4 full, 7 waning crescent).
pub fn moon_phase(when: DateTime<Utc>) -> i64 {
    // A reference new moon: 2000-01-06 18:14 UTC.
    let reference = Utc
        .with_ymd_and_hms(2000, 1, 6, 18, 14, 0)
        .single()
        .unwrap_or_default();
    let secs = (when - reference).num_milliseconds() as f64 / 1000.0;
    let age = (secs / 86400.0).rem_euclid(SYNODIC_DAYS);
    (pyround(age / SYNODIC_DAYS * 8.0, 0) as i64).rem_euclid(8)
}

/// Convective cloud base (km AGL), about the lifting condensation level:
/// 125 m x (T - Td). `None` under a clear sky (under 10 % cover).
pub fn cloud_base_km(
    temp_c: Option<f64>,
    dew_c: Option<f64>,
    cloud_cover: Option<f64>,
) -> Option<f64> {
    let (t, td, cover) = (temp_c?, dew_c?, cloud_cover?);
    if cover < 10.0 {
        return None;
    }
    Some(pyround((t - td).max(0.0) * 0.125, 2))
}

/// Index of the current hour in `hourly.time` (prefix match on
/// `YYYY-MM-DDTHH`); 0 when the time is missing or not found.
pub fn current_hour_index(hourly: &Value, current_time: Option<&str>) -> usize {
    let times = hourly.get("time").and_then(Value::as_array);
    let (Some(ct), Some(times)) = (current_time.filter(|t| !t.is_empty()), times) else {
        return 0;
    };
    let prefix: String = ct.chars().take(13).collect();
    times
        .iter()
        .position(|t| {
            let s: String = t.as_str().unwrap_or("").chars().take(13).collect();
            s == prefix
        })
        .unwrap_or(0)
}

fn at(arr: Option<&Value>, i: usize) -> Option<f64> {
    as_num(arr.and_then(Value::as_array).and_then(|a| a.get(i)))
}

fn at_value(arr: Option<&Value>, i: usize) -> Option<Value> {
    arr.and_then(Value::as_array)
        .and_then(|a| a.get(i))
        .filter(|v| v.is_number())
        .cloned()
}

/// Build a `WeatherInsights` map from a baseline `WeatherData` payload. Reads
/// the optional intermediate fields when present (`hourly.cape`,
/// `hourly.lifted_index`, `hourly.dew_point_2m`,
/// `daily.et0_fao_evapotranspiration`).
pub fn derive_insights(data: &Value, now: DateTime<Utc>) -> Map<String, Value> {
    let empty = json!({});
    let current = data
        .get("current")
        .filter(|v| v.is_object())
        .unwrap_or(&empty);
    let hourly = data
        .get("hourly")
        .filter(|v| v.is_object())
        .unwrap_or(&empty);
    let daily = data
        .get("daily")
        .filter(|v| v.is_object())
        .unwrap_or(&empty);

    let idx = current_hour_index(hourly, current.get("time").and_then(Value::as_str));
    let temp = as_num(current.get("temperature_2m"));
    let rh = as_num(current.get("relative_humidity_2m"));

    let mut out = Map::new();
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(v) = value.filter(|v| !v.is_null()) {
            out.insert(key.to_owned(), v);
        }
    };

    put("windSpeed", current.get("wind_speed_10m").cloned());
    put("windGust", current.get("wind_gusts_10m").cloned());

    // Visibility: Open-Meteo reports metres, the insights field is km.
    put(
        "visibility",
        at(hourly.get("visibility"), idx).map(|m| json!(pyround(m / 1000.0, 2))),
    );

    let dew_value: Option<Value> = at_value(hourly.get("dew_point_2m"), idx)
        .or_else(|| dew_point_c(temp, rh).map(|d| json!(d)));
    let dew = dew_value.as_ref().and_then(Value::as_f64);
    put("dewPoint", dew_value);

    put("heatStressIndex", heat_index_c(temp, rh).map(|h| json!(h)));

    let uv = current
        .get("uv_index")
        .filter(|v| !v.is_null())
        .cloned()
        .or_else(|| at_value(hourly.get("uv_index"), idx));
    put("uvHealthConcern", uv);

    let trunc = |v: f64| v as i64;
    let (mut code_thunder, ptype) = wmo_hazards(as_num(current.get("weather_code")).map(trunc));
    put("precipitationType", Some(json!(ptype)));

    // Thunderstorm: max of the WMO-code value and the convective proxy over
    // the next few hours, damped when models don't agree on any rain.
    let cape_arr = hourly.get("cape");
    let li_arr = hourly.get("lifted_index");
    let code_arr = hourly.get("weather_code");
    let pp_arr = hourly.get("precipitation_probability");
    let mut convective = 0_i64;
    let mut max_pp = 0.0_f64;
    for i in idx..idx + CONVECTIVE_WINDOW_H {
        convective = convective.max(convective_proxy(at(cape_arr, i), at(li_arr, i)));
        if let Some(c) = at(code_arr, i) {
            code_thunder = code_thunder.max(wmo_hazards(Some(trunc(c))).0);
        }
        if let Some(pp) = at(pp_arr, i) {
            max_pp = max_pp.max(pp);
        }
    }
    let pp_present = pp_arr
        .and_then(Value::as_array)
        .is_some_and(|a| !a.is_empty());
    if pp_present && max_pp < 20.0 {
        convective /= 2;
    }
    put(
        "thunderstormProbability",
        Some(json!(code_thunder.max(convective))),
    );

    let tmax = at(daily.get("temperature_2m_max"), 0);
    let tmin = at(daily.get("temperature_2m_min"), 0);
    for (key, base, cap) in GDD_DEFINITIONS {
        put(
            key,
            growing_degree_days(tmax, tmin, base, cap).map(|g| json!(g)),
        );
    }

    put(
        "evapotranspiration",
        at_value(daily.get("et0_fao_evapotranspiration"), 0),
    );
    put("moonPhase", Some(json!(moon_phase(now))));

    let cover = as_num(current.get("cloud_cover"));
    if let Some(base_km) = cloud_base_km(temp, dew, cover) {
        out.insert("cloudBase".into(), json!(base_km));
        // Ceiling = base of a layer covering at least half the sky.
        out.insert(
            "cloudCeiling".into(),
            if cover.unwrap_or(0.0) >= 50.0 {
                json!(base_km)
            } else {
                Value::Null
            },
        );
    }
    out
}

/// A copy of `data` without the intermediate fields.
pub fn strip_intermediate(data: &Value) -> Value {
    let mut out = data.clone();
    if let Some(h) = out.get_mut("hourly").and_then(Value::as_object_mut) {
        for k in INTERMEDIATE_HOURLY {
            h.remove(k);
        }
    }
    if let Some(d) = out.get_mut("daily").and_then(Value::as_object_mut) {
        for k in INTERMEDIATE_DAILY {
            d.remove(k);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fx() -> Value {
        serde_json::from_str(include_str!("../../../../tests/fixtures/model-blend.json")).unwrap()
    }

    fn opt(v: &Value) -> Option<f64> {
        v.as_f64()
    }

    fn out(v: Option<f64>) -> Value {
        v.map_or(Value::Null, |x| json!(x))
    }

    #[test]
    fn dew_point_heat_index_gdd_match_the_python() {
        let fx = fx();
        for c in fx["dew_point"].as_array().unwrap() {
            assert_eq!(
                out(dew_point_c(opt(&c["t"]), opt(&c["rh"]))),
                c["expected"],
                "{c}"
            );
        }
        for c in fx["heat_index"].as_array().unwrap() {
            assert_eq!(
                out(heat_index_c(opt(&c["t"]), opt(&c["rh"]))),
                c["expected"],
                "{c}"
            );
        }
        for c in fx["gdd"].as_array().unwrap() {
            let got = growing_degree_days(
                opt(&c["tmax"]),
                opt(&c["tmin"]),
                c["base"].as_f64().unwrap(),
                c["cap"].as_f64().unwrap(),
            );
            assert_eq!(out(got), c["expected"], "{c}");
        }
    }

    #[test]
    fn hazards_convective_moon_and_cloud_base_match_the_python() {
        let fx = fx();
        for c in fx["wmo_hazards"].as_array().unwrap() {
            let (t, p) = wmo_hazards(c["code"].as_i64());
            assert_eq!(json!([t, p]), c["expected"], "{c}");
        }
        for c in fx["convective"].as_array().unwrap() {
            assert_eq!(
                convective_proxy(opt(&c["cape"]), opt(&c["li"])),
                c["expected"].as_i64().unwrap(),
                "{c}"
            );
        }
        for c in fx["moon_phase"].as_array().unwrap() {
            let at = DateTime::parse_from_rfc3339(c["at"].as_str().unwrap())
                .unwrap()
                .with_timezone(&Utc);
            assert_eq!(moon_phase(at), c["expected"].as_i64().unwrap(), "{c}");
        }
        for c in fx["cloud_base"].as_array().unwrap() {
            assert_eq!(
                out(cloud_base_km(opt(&c["t"]), opt(&c["td"]), opt(&c["cover"]))),
                c["expected"],
                "{c}"
            );
        }
        for c in fx["hour_index"].as_array().unwrap() {
            assert_eq!(
                current_hour_index(&c["hourly"], c["current"].as_str()) as i64,
                c["expected"].as_i64().unwrap()
            );
        }
    }

    #[test]
    fn derive_insights_matches_the_python() {
        let fx = fx();
        let now = DateTime::parse_from_rfc3339(fx["now"].as_str().unwrap())
            .unwrap()
            .with_timezone(&Utc);
        let cases = fx["derive_insights"].as_array().unwrap();
        assert!(cases.len() >= 10);
        for c in cases {
            assert_eq!(
                Value::Object(derive_insights(&c["data"], now)),
                c["expected"],
                "{}",
                c["name"]
            );
        }
    }

    #[test]
    fn stripping_removes_only_the_intermediate_fields() {
        let d = json!({
            "hourly": {"time": [], "cape": [1], "lifted_index": [1], "dew_point_2m": [1], "temperature_2m": [1]},
            "daily": {"time": [], "et0_fao_evapotranspiration": [1], "sunrise": []},
            "current": {"a": 1},
        });
        let s = strip_intermediate(&d);
        assert_eq!(s["hourly"], json!({"time": [], "temperature_2m": [1]}));
        assert_eq!(s["daily"], json!({"time": [], "sunrise": []}));
        assert_eq!(s["current"], d["current"]);
    }
}
