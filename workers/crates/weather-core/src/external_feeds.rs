//! Live observations from external public weather networks.
//!
//! Two feeds, both public and keyless, and both read-only for us:
//!
//! - **WIS2, Zimbabwe MSD** (`wis2_observations`): the Meteorological
//!   Services Department's hourly surface observations through an OGC API
//!   Features endpoint, under WMO's core data policy.
//! - **SAAOPA WX-CoPilot** (`saaopa_status_observations`,
//!   `saaopa_aws_registry`): a community network of automatic weather
//!   stations, read from the `/stations` and `/stations/status` routes of its
//!   own API.
//!
//! Nothing here touches the network or a clock: a Worker fetches the JSON and
//! passes it in with the current time, and gets back plain observations.
//! Mapping to the platform's stored shape (names, units, ids) is one table in
//! each function, because the metric-naming family is still an open decision
//! (the platform standard is CF names; `station.rs` uses the `airTemperature…`
//! family today).
//!
//! A WIS2 station-hour can arrive in pieces: the API pages by feature, and a
//! page boundary can cut a report in two (seen live on 2026-10-29: three
//! reports in one page of 12 rows, one with 2 of its 6 parameters and none
//! with precipitation). `FeedObservation.metrics` is therefore a PARTIAL set,
//! and a writer must merge it into the stored station-hour (`$set` per metric
//! on `_id = wis2:<reportId>`), never replace the document.
//!
//! What this module will NOT do, on purpose:
//!
//! - It never fills `atmosphericPressureMillibar` from a QNH. QNH is pressure
//!   adjusted to sea level; that metric is station pressure. QNH is kept in
//!   `extra` as `pressureQnhHpa`.
//! - It never invents a station. Callers match `station_ref` (a WIGOS id or a
//!   SAAOPA code) against a registered station and skip what does not match.
//! - It does not decide whether a feed may be switched on. SAAOPA publishes no
//!   licence or terms; a data-sharing agreement comes first (see the
//!   playbook).

use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde_json::Value;

use crate::station::{qc_filter, Metrics};

/// Knots to km/h.
pub fn kt_to_kph(v: f64) -> f64 {
    v * 1.852
}

/// Metres per second to km/h.
pub fn ms_to_kph(v: f64) -> f64 {
    v * 3.6
}

/// Source tags, stored on every observation as provenance.
pub const SOURCE_WIS2_ZW_MSD: &str = "wis2-zw-msd";
pub const SOURCE_SAAOPA: &str = "saaopa-wx";

/// One observation from an external feed, after unit conversion and range
/// checks. Not yet matched to a registered station.
#[derive(Debug, Clone, PartialEq)]
pub struct FeedObservation {
    /// `SOURCE_*`.
    pub source: &'static str,
    /// The feed's own station key: a WIGOS id (WIS2) or a SAAOPA code.
    pub station_ref: String,
    /// The feed's own report id when it has one (WIS2 `reportId`); the
    /// basis of an idempotent `_id` (`wis2:<reportId>`).
    pub report_id: Option<String>,
    /// RFC 3339, UTC.
    pub observed_at: String,
    /// WGS 84 `(lon, lat)` when the feed carries a position.
    pub position: Option<(f64, f64)>,
    /// Range-checked metrics in the platform's units.
    pub metrics: BTreeMap<&'static str, f64>,
    /// Values we keep but do not map to a platform metric (dew point, QNH).
    pub extra: BTreeMap<&'static str, f64>,
    /// How long the precipitation value accumulates over, when it is
    /// reported: `Some("PT1H")` for WIS2 (the preceding hour).
    pub precipitation_period: Option<&'static str>,
}

fn num(v: &Value) -> Option<f64> {
    v.as_f64().filter(|x| x.is_finite())
}

fn rfc3339(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Secs, true)
}

// --- WIS2 --------------------------------------------------------------------

/// One WIS2 parameter: its `name`, the stored metric and the conversion.
type Wis2Param = (&'static str, &'static str, fn(f64) -> f64);

/// The six parameters read from a WIS2 answer.
const WIS2_PARAMS: [Wis2Param; 6] = [
    ("air_temperature", "airTemperatureCelsius", |v| v),
    ("relative_humidity", "relativeHumidityPercent", |v| v),
    // Station-level pressure, not sea-level: `non_coordinate_pressure`.
    (
        "non_coordinate_pressure",
        "atmosphericPressureMillibar",
        |v| v,
    ),
    ("wind_speed", "windSpeedKph", ms_to_kph),
    ("wind_direction", "windDirectionDegrees", |v| v),
    (
        "total_precipitation_or_total_water_equivalent",
        "precipitationMillimeters",
        |v| v,
    ),
];

/// Observations from a WIS2 OGC API Features answer (a GeoJSON
/// `FeatureCollection`). The API returns one feature per parameter per
/// station per hour, so features are grouped by `reportId`, never by
/// `phenomenonTime` (precipitation carries an interval, the rest an instant).
///
/// A report with no usable value is dropped. Out-of-range values are dropped
/// by the platform's QC ranges; the rest of the report is kept.
pub fn wis2_observations(collection: &Value) -> Vec<FeedObservation> {
    struct Acc {
        wigos: String,
        time: String,
        pos: Option<(f64, f64)>,
        raw: Metrics,
    }
    let Some(features) = collection.get("features").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut reports: BTreeMap<String, Acc> = BTreeMap::new();
    for f in features {
        let p = &f["properties"];
        let (Some(report), Some(wigos), Some(time)) = (
            p["reportId"].as_str(),
            p["wigos_station_identifier"].as_str(),
            p["reportTime"].as_str(),
        ) else {
            continue;
        };
        let acc = reports.entry(report.to_string()).or_insert_with(|| Acc {
            wigos: wigos.to_string(),
            time: time.to_string(),
            pos: f["geometry"]["coordinates"]
                .as_array()
                .and_then(|c| Some((c.first().and_then(num)?, c.get(1).and_then(num)?))),
            raw: Metrics::new(),
        });
        let Some(name) = p["name"].as_str() else {
            continue;
        };
        if let Some((_, key, conv)) = WIS2_PARAMS.iter().find(|(n, _, _)| *n == name) {
            if let Some(v) = num(&p["value"]) {
                acc.raw.insert(*key, Some(conv(v)));
            }
        }
    }
    reports
        .into_iter()
        .filter_map(|(report, acc)| {
            let metrics = qc_filter(&acc.raw);
            if metrics.is_empty() {
                return None;
            }
            let observed = DateTime::parse_from_rfc3339(&acc.time)
                .ok()?
                .with_timezone(&Utc);
            Some(FeedObservation {
                source: SOURCE_WIS2_ZW_MSD,
                station_ref: acc.wigos,
                report_id: Some(report),
                observed_at: rfc3339(observed),
                position: acc.pos,
                precipitation_period: metrics
                    .contains_key("precipitationMillimeters")
                    .then_some("PT1H"),
                metrics,
                extra: BTreeMap::new(),
            })
        })
        .collect()
}

// --- SAAOPA ------------------------------------------------------------------

/// A station from the SAAOPA registry, reduced to what a registry import
/// needs. Only automatic weather stations (`kind` = `aws`) are kept: the
/// `official` aerodromes republish METARs we can read from the Aviation
/// Weather Center directly, and `cam` entries are webcams.
#[derive(Debug, Clone, PartialEq)]
pub struct SaaopaStation {
    pub code: String,
    pub name: String,
    pub country: Option<String>,
    pub lon: f64,
    pub lat: f64,
    pub elevation_m: Option<f64>,
    pub sensor_height_agl_m: Option<f64>,
    /// `weatherlink`, `ecowitt` or `push`.
    pub source_type: String,
    pub device_type: Option<String>,
}

/// The active automatic weather stations in a `/stations` answer.
pub fn saaopa_aws_registry(stations: &Value) -> Vec<SaaopaStation> {
    stations
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|s| s["kind"] == "aws" && s["active"] != Value::Bool(false))
                .filter_map(|s| {
                    Some(SaaopaStation {
                        code: s["code"].as_str()?.to_string(),
                        name: s["name"].as_str()?.to_string(),
                        country: s["country"].as_str().map(str::to_string),
                        lon: num(&s["longitude"])?,
                        lat: num(&s["latitude"])?,
                        elevation_m: num(&s["elevationM"]),
                        sensor_height_agl_m: num(&s["sensorHeightAglM"]),
                        source_type: s["sourceType"].as_str().unwrap_or("").to_string(),
                        device_type: s["deviceType"].as_str().map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Current observations from a SAAOPA `/stations/status` answer.
///
/// The feed gives each station's age in minutes, not a timestamp, so the
/// observation time is `now - age`, rounded to the minute. A station with no
/// age (offline), or older than `max_age_minutes`, is skipped. `only_codes`
/// limits the result to registered stations (the AWS from `saaopa_aws_registry`);
/// pass `None` to take every station that reports.
///
/// Wind is knots in the feed (km/h out). The pressure is QNH and goes to
/// `extra`, never to station pressure.
pub fn saaopa_status_observations(
    status: &Value,
    now: DateTime<Utc>,
    max_age_minutes: u32,
    only_codes: Option<&BTreeSet<String>>,
) -> Vec<FeedObservation> {
    let Some(rows) = status.as_array() else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|r| {
            let code = r["code"].as_str()?;
            if only_codes.is_some_and(|set| !set.contains(code)) {
                return None;
            }
            let age = num(&r["obsAgeMinutes"])?;
            if age < 0.0 || age > f64::from(max_age_minutes) {
                return None;
            }
            let observed = now - Duration::minutes(age.round() as i64);
            let get = |k: &str| num(&r[k]);
            let raw = Metrics::from([
                ("airTemperatureCelsius", get("temperatureC")),
                ("windSpeedKph", get("windSpeedKt").map(kt_to_kph)),
                ("windGustKph", get("windGustKt").map(kt_to_kph)),
                ("windDirectionDegrees", get("windDirDeg")),
            ]);
            let metrics = qc_filter(&raw);
            let mut extra = BTreeMap::new();
            if let Some(d) = get("dewpointC").filter(|d| (-60.0..=40.0).contains(d)) {
                extra.insert("dewPointCelsius", d);
            }
            if let Some(q) = get("pressureQnhHpa").filter(|q| (850.0..=1090.0).contains(q)) {
                extra.insert("pressureQnhHpa", q);
            }
            if metrics.is_empty() && extra.is_empty() {
                return None;
            }
            Some(FeedObservation {
                source: SOURCE_SAAOPA,
                station_ref: code.to_string(),
                report_id: None,
                observed_at: rfc3339(observed),
                position: None,
                metrics,
                extra,
                precipitation_period: None,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const WIS2: &str = include_str!("../tests/fixtures/wis2_zw_msd_items.json");
    const SAAOPA_STATUS: &str = include_str!("../tests/fixtures/saaopa_stations_status.json");
    const SAAOPA_STATIONS: &str = include_str!("../tests/fixtures/saaopa_stations.json");

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn wis2_groups_a_station_hour_by_report_not_by_phenomenon_time() {
        let v: Value = serde_json::from_str(WIS2).unwrap();
        let obs = wis2_observations(&v);
        // The fixture is the newest 12 live rows: three station-hours. The
        // page boundary cut Mount Darwin's report after two rows, and the
        // precipitation rows of all three are on a later page. That is real,
        // and why a loader merges metrics into a station-hour (see the module
        // docs) instead of replacing it.
        assert_eq!(obs.len(), 3, "{obs:?}");
        let counts: Vec<_> = obs.iter().map(|o| o.metrics.len()).collect();
        assert_eq!(counts, [2, 5, 5], "{obs:?}"); // BTreeMap order: 67779, 67843, 67964
        for o in &obs {
            assert_eq!(o.source, SOURCE_WIS2_ZW_MSD);
            assert!(o.station_ref.starts_with("0-716-2-"), "{}", o.station_ref);
            assert!(o.report_id.as_deref().unwrap().starts_with(&o.station_ref));
            assert!(o.position.is_some());
            assert_eq!(o.precipitation_period, None);
            assert!(o.observed_at.ends_with('Z'));
        }
        assert_eq!(obs[1].station_ref, "0-716-2-67843AWS");
    }

    #[test]
    fn wis2_wind_is_converted_from_metres_per_second_and_pressure_stays_station_level() {
        let v = json!({"features": [
          {"geometry": {"coordinates": [28.6, -20.1]}, "properties": {
            "reportId": "0-716-2-X-1", "wigos_station_identifier": "0-716-2-X",
            "reportTime": "2026-10-29T11:00:00Z", "name": "wind_speed", "value": 3.0, "units": "m/s"}},
          {"geometry": {"coordinates": [28.6, -20.1]}, "properties": {
            "reportId": "0-716-2-X-1", "wigos_station_identifier": "0-716-2-X",
            "reportTime": "2026-10-29T11:00:00Z", "name": "non_coordinate_pressure", "value": 869.7, "units": "hPa"}}
        ]});
        let obs = wis2_observations(&v);
        assert_eq!(obs.len(), 1);
        // 3 m/s is 10.8 km/h.
        assert!((obs[0].metrics["windSpeedKph"] - 10.8).abs() < 1e-9);
        // 869.7 hPa is real station pressure at Bulawayo's elevation. It
        // passes the QC range (800 to 1100) and is stored as station pressure.
        assert_eq!(obs[0].metrics["atmosphericPressureMillibar"], 869.7);
        assert_eq!(obs[0].precipitation_period, None);
    }

    #[test]
    fn wis2_drops_out_of_range_values_but_keeps_the_rest_of_the_report() {
        let v = json!({"features": [
          {"geometry": {"coordinates": [1.0, 2.0]}, "properties": {
            "reportId": "R", "wigos_station_identifier": "W", "reportTime": "2026-10-29T10:00:00Z",
            "name": "air_temperature", "value": 999.0}},
          {"geometry": {"coordinates": [1.0, 2.0]}, "properties": {
            "reportId": "R", "wigos_station_identifier": "W", "reportTime": "2026-10-29T10:00:00Z",
            "name": "relative_humidity", "value": 55.0}}
        ]});
        let obs = wis2_observations(&v);
        assert_eq!(obs.len(), 1);
        assert!(!obs[0].metrics.contains_key("airTemperatureCelsius"));
        assert_eq!(obs[0].metrics["relativeHumidityPercent"], 55.0);
    }

    #[test]
    fn wis2_ignores_malformed_input_without_panicking() {
        assert!(wis2_observations(&json!(null)).is_empty());
        assert!(wis2_observations(&json!({"features": "no"})).is_empty());
        assert!(wis2_observations(&json!({"features": [{"properties": {}}]})).is_empty());
        // A null value and an unknown parameter leave nothing to keep.
        let v = json!({"features": [{"properties": {
            "reportId": "R", "wigos_station_identifier": "W", "reportTime": "2026-10-29T10:00:00Z",
            "name": "air_temperature", "value": null}}]});
        assert!(wis2_observations(&v).is_empty());
    }

    #[test]
    fn saaopa_status_converts_knots_and_keeps_qnh_out_of_station_pressure() {
        let v: Value = serde_json::from_str(SAAOPA_STATUS).unwrap();
        let now = at("2026-10-29T12:38:00Z");
        let obs = saaopa_status_observations(&v, now, 120, None);
        // FVHP, INYANGA and FVCD report; ZBIKI is offline (null age).
        let codes: Vec<_> = obs.iter().map(|o| o.station_ref.as_str()).collect();
        assert_eq!(codes, ["FVHP", "INYANGA", "FVCD"]);
        let fvhp = &obs[0];
        // 6.951808 kt is 12.875 km/h.
        assert!((fvhp.metrics["windSpeedKph"] - 12.875).abs() < 0.01);
        assert!((fvhp.metrics["airTemperatureCelsius"] - 28.611).abs() < 0.01);
        assert!(!fvhp.metrics.contains_key("atmosphericPressureMillibar"));
        assert!((fvhp.extra["pressureQnhHpa"] - 1021.098).abs() < 0.01);
        assert_eq!(fvhp.extra["dewPointCelsius"], 13.7);
        // Observed 8 minutes before `now`.
        assert_eq!(fvhp.observed_at, "2026-10-29T12:30:00Z");
        assert_eq!(fvhp.source, SOURCE_SAAOPA);
    }

    #[test]
    fn saaopa_status_skips_stale_and_unregistered_stations() {
        let v: Value = serde_json::from_str(SAAOPA_STATUS).unwrap();
        let now = at("2026-10-29T12:38:00Z");
        // Everything is 7 to 8 minutes old: a 5 minute limit drops all.
        assert!(saaopa_status_observations(&v, now, 5, None).is_empty());
        let only: BTreeSet<String> = ["FVCD".to_string()].into();
        let obs = saaopa_status_observations(&v, now, 120, Some(&only));
        assert_eq!(obs.len(), 1);
        assert_eq!(obs[0].station_ref, "FVCD");
        assert!(saaopa_status_observations(&json!({}), now, 120, None).is_empty());
    }

    #[test]
    fn saaopa_registry_keeps_only_active_automatic_stations() {
        let v: Value = serde_json::from_str(SAAOPA_STATIONS).unwrap();
        let reg = saaopa_aws_registry(&v);
        // The fixture holds one AWS, one official aerodrome and one webcam.
        assert_eq!(reg.len(), 1, "{reg:?}");
        let s = &reg[0];
        assert_eq!(s.code, "CHIPINDA");
        assert_eq!(s.country.as_deref(), Some("Zimbabwe"));
        assert_eq!(s.source_type, "weatherlink");
        assert_eq!(s.device_type.as_deref(), Some("davis_vantage_vue"));
        assert_eq!(s.elevation_m, Some(288.0));
        assert!((s.lat + 21.2888).abs() < 1e-9 && (s.lon - 31.9132).abs() < 1e-9);
    }

    #[test]
    fn unit_conversions() {
        assert!((kt_to_kph(1.0) - 1.852).abs() < 1e-12);
        assert!((ms_to_kph(1.0) - 3.6).abs() < 1e-12);
    }
}
