//! Weather-station ingest: protocol parsing, unit conversion, QC and ingest
//! keys. Ported from `api/py/_stations.py` so stations already registered keep
//! working with the keys they were given.

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};
use sha2::Sha256;
use subtle::ConstantTimeEq;

/// The metrics a station can report, in the platform's units.
pub type Metrics = BTreeMap<&'static str, Option<f64>>;

/// Physically plausible ranges. Values outside are archived raw but never
/// become a validated observation.
pub const QC_RANGES: [(&str, f64, f64); 9] = [
    ("airTemperatureCelsius", -50.0, 60.0),
    ("relativeHumidityPercent", 0.0, 100.0),
    ("atmosphericPressureMillibar", 800.0, 1100.0),
    ("windSpeedKph", 0.0, 250.0),
    ("windGustKph", 0.0, 300.0),
    ("windDirectionDegrees", 0.0, 360.0),
    ("precipitationMillimeters", 0.0, 500.0),
    ("uvIndex", 0.0, 20.0),
    ("solarRadiationWm2", 0.0, 1500.0),
];

/// PBKDF2 iterations for ingest keys (the Python backend's value; changing it
/// would lock out every registered station).
pub const KDF_ITERATIONS: u32 = 60_000;

pub fn f_to_c(v: f64) -> f64 {
    (v - 32.0) * 5.0 / 9.0
}
pub fn mph_to_kph(v: f64) -> f64 {
    v * 1.609344
}
pub fn inhg_to_hpa(v: f64) -> f64 {
    v * 33.8639
}
pub fn inch_to_mm(v: f64) -> f64 {
    v * 25.4
}

fn num(v: Option<&str>) -> Option<f64> {
    v.and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|x| x.is_finite())
}

/// Metrics from a Wunderground-protocol upload (`GET` query, imperial).
pub fn wunderground_metrics(get: impl Fn(&str) -> Option<String>) -> Metrics {
    let g = |k: &str| num(get(k).as_deref());
    Metrics::from([
        ("airTemperatureCelsius", g("tempf").map(f_to_c)),
        ("relativeHumidityPercent", g("humidity")),
        ("atmosphericPressureMillibar", g("baromin").map(inhg_to_hpa)),
        ("windSpeedKph", g("windspeedmph").map(mph_to_kph)),
        ("windGustKph", g("windgustmph").map(mph_to_kph)),
        ("windDirectionDegrees", g("winddir")),
        ("precipitationMillimeters", g("rainin").map(inch_to_mm)),
        ("uvIndex", g("UV")),
        ("solarRadiationWm2", g("solarradiation")),
    ])
}

/// Metrics from an Ecowitt-protocol upload (`POST` form, imperial).
pub fn ecowitt_metrics(get: impl Fn(&str) -> Option<String>) -> Metrics {
    let g = |k: &str| num(get(k).as_deref());
    let barom = if get("baromrelin").is_some_and(|s| !s.is_empty()) {
        g("baromrelin")
    } else {
        g("baromabsin")
    };
    Metrics::from([
        ("airTemperatureCelsius", g("tempf").map(f_to_c)),
        ("relativeHumidityPercent", g("humidity")),
        ("atmosphericPressureMillibar", barom.map(inhg_to_hpa)),
        ("windSpeedKph", g("windspeedmph").map(mph_to_kph)),
        ("windGustKph", g("windgustmph").map(mph_to_kph)),
        ("windDirectionDegrees", g("winddir")),
        ("precipitationMillimeters", g("rainratein").map(inch_to_mm)),
        ("uvIndex", g("uv")),
        ("solarRadiationWm2", g("solarradiation")),
    ])
}

/// Keep only metrics inside their range, rounded to 2 decimals.
pub fn qc_filter(metrics: &Metrics) -> BTreeMap<&'static str, f64> {
    let mut passed = BTreeMap::new();
    for (field, lo, hi) in QC_RANGES {
        if let Some(Some(v)) = metrics.get(field) {
            if (lo..=hi).contains(v) {
                passed.insert(field, (v * 100.0).round() / 100.0);
            }
        }
    }
    passed
}

/// Map validated metrics to the `current` block (`temperature_2m`, …). Only
/// fields the station measured are set.
pub fn station_current(metrics: &Map<String, Value>, observed_at: &str) -> Value {
    let pick = |k: &str| metrics.get(k).cloned().unwrap_or(Value::Null);
    json!({
        "time": observed_at,
        "temperature_2m": pick("airTemperatureCelsius"),
        "relative_humidity_2m": pick("relativeHumidityPercent"),
        "surface_pressure": pick("atmosphericPressureMillibar"),
        "wind_speed_10m": pick("windSpeedKph"),
        "wind_direction_10m": pick("windDirectionDegrees"),
        "precipitation": pick("precipitationMillimeters"),
        "uv_index": pick("uvIndex"),
    })
}

/// Whether a station id has the registered form `mws-` + 8 hex digits.
pub fn valid_station_id(id: &str) -> bool {
    id.len() == 12
        && id.starts_with("mws-")
        && id[4..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Salted PBKDF2-HMAC-SHA256 of an ingest key, hex-encoded (the stored form).
pub fn hash_ingest_key(key: &str, salt: &str) -> String {
    let mut out = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(key.as_bytes(), salt.as_bytes(), KDF_ITERATIONS, &mut out);
    hex::encode(out)
}

/// Check an ingest key against its stored salt and hash, in constant time.
pub fn verify_ingest_key(key: &str, salt: &str, expected_hex: &str) -> bool {
    if key.is_empty() || salt.is_empty() || expected_hex.is_empty() {
        return false;
    }
    let actual = hash_ingest_key(key, salt);
    actual.as_bytes().ct_eq(expected_hex.as_bytes()).into()
}

/// Split an Ecowitt `PASSKEY` of the form `<stationId>:<key>`.
pub fn split_passkey(passkey: &str) -> (&str, &str) {
    passkey.split_once(':').unwrap_or((passkey, ""))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn getter(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect();
        move |k| m.get(k).cloned()
    }

    #[test]
    fn wunderground_uploads_are_converted() {
        let m = wunderground_metrics(getter(&[
            ("tempf", "68"),
            ("humidity", "40"),
            ("baromin", "29.92"),
            ("windspeedmph", "10"),
            ("rainin", "0.1"),
        ]));
        assert!((m["airTemperatureCelsius"].unwrap() - 20.0).abs() < 1e-9);
        assert!((m["atmosphericPressureMillibar"].unwrap() - 1013.21).abs() < 0.01);
        assert!((m["windSpeedKph"].unwrap() - 16.09344).abs() < 1e-9);
        assert!((m["precipitationMillimeters"].unwrap() - 2.54).abs() < 1e-9);
        assert_eq!(m["uvIndex"], None);
    }

    #[test]
    fn ecowitt_prefers_relative_pressure() {
        let m = ecowitt_metrics(getter(&[("baromrelin", "30"), ("baromabsin", "25")]));
        assert!((m["atmosphericPressureMillibar"].unwrap() - 1015.917).abs() < 0.001);
        let m = ecowitt_metrics(getter(&[("baromrelin", ""), ("baromabsin", "25")]));
        assert!((m["atmosphericPressureMillibar"].unwrap() - 846.5975).abs() < 0.001);
    }

    #[test]
    fn qc_drops_implausible_values_and_rounds() {
        let m = Metrics::from([
            ("airTemperatureCelsius", Some(21.456)),
            ("relativeHumidityPercent", Some(140.0)),
            ("uvIndex", None),
        ]);
        let q = qc_filter(&m);
        assert_eq!(q.get("airTemperatureCelsius"), Some(&21.46));
        assert!(!q.contains_key("relativeHumidityPercent"));
        assert_eq!(q.len(), 1);
    }

    #[test]
    fn ingest_keys_match_the_python_hash() {
        // hashlib.pbkdf2_hmac("sha256", b"test-key", b"salt", 60000).hex()
        let h = hash_ingest_key("test-key", "salt");
        assert_eq!(
            h,
            "568fdcdb1ed66c4ebddc9e59860649a395968f11bddc619037ee0dc7df0742e9"
        );
        assert!(verify_ingest_key("test-key", "salt", &h));
        assert!(!verify_ingest_key("wrong", "salt", &h));
        assert!(!verify_ingest_key("test-key", "", &h));
    }

    #[test]
    fn station_ids_and_passkeys() {
        assert!(valid_station_id("mws-0a1b2c3d"));
        assert!(!valid_station_id("mws-0A1B2C3D"));
        assert!(!valid_station_id("mws-0a1b2c3"));
        assert_eq!(
            split_passkey("mws-0a1b2c3d:secret:x"),
            ("mws-0a1b2c3d", "secret:x")
        );
        assert_eq!(split_passkey("nokey"), ("nokey", ""));
    }

    #[test]
    fn station_current_maps_only_measured_fields() {
        let metrics: Map<String, Value> =
            serde_json::from_value(json!({"airTemperatureCelsius": 22.4, "windSpeedKph": 5.0}))
                .unwrap();
        let c = station_current(&metrics, "2026-10-04T08:00:00Z");
        assert_eq!(c["temperature_2m"], 22.4);
        assert_eq!(c["wind_speed_10m"], 5.0);
        assert_eq!(c["uv_index"], Value::Null);
    }
}
