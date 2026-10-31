//! Singapore official air quality: NEA PSI and PM2.5 via data.gov.sg (ported
//! from `api/py/_sg_air.py`).
//!
//! The payload carries no `national` key, so the headline is a reported
//! national value when present and otherwise the highest regional value,
//! recorded in `psiBasis` / `pm25Basis`.

use serde_json::{json, Map, Value};

use crate::geo::haversine_km;

pub const PSI_URL: &str = "https://api-open.data.gov.sg/v2/real-time/api/psi";
pub const PM25_URL: &str = "https://api-open.data.gov.sg/v2/real-time/api/pm25";
pub const SOURCE_ATTRIBUTION: &str = "NEA via data.gov.sg";
/// The upstream payloads are cached for 10 minutes.
pub const CACHE_TTL_SECONDS: u64 = 600;
pub const CACHE_KEY: &str = "sgair:v1";
pub const REGION_NAMES: [&str; 5] = ["north", "south", "east", "west", "central"];

/// PSI bands, upper bound inclusive; above the last is hazardous.
pub fn psi_band(value: f64) -> Option<(&'static str, &'static str)> {
    if !value.is_finite() {
        return None;
    }
    Some(if value <= 50.0 {
        ("good", "Good")
    } else if value <= 100.0 {
        ("moderate", "Moderate")
    } else if value <= 200.0 {
        ("unhealthy", "Unhealthy")
    } else if value <= 300.0 {
        ("very_unhealthy", "Very unhealthy")
    } else {
        ("hazardous", "Hazardous")
    })
}

/// Python's `int(round(float(v)))`; `None` for null, NaN or a non-number.
fn clean_int(v: &Value) -> Option<i64> {
    let n = v
        .as_f64()
        .or_else(|| v.as_str().and_then(|s| s.trim().parse::<f64>().ok()))?;
    n.is_finite().then(|| n.round_ties_even() as i64)
}

fn region_values(readings: &Value) -> Vec<(&'static str, i64)> {
    REGION_NAMES
        .iter()
        .filter_map(|n| clean_int(&readings[*n]).map(|v| (*n, v)))
        .collect()
}

fn headline(readings: &Value, regional: &[(&str, i64)]) -> (Option<i64>, Option<&'static str>) {
    if let Some(n) = clean_int(&readings["national"]) {
        return (Some(n), Some("national"));
    }
    match regional.iter().map(|(_, v)| *v).max() {
        Some(m) => (Some(m), Some("highest_region")),
        None => (None, None),
    }
}

fn first_item(payload: &Value) -> Result<&Value, &'static str> {
    if payload.get("code").and_then(Value::as_i64).unwrap_or(0) != 0 {
        return Err("NEA error code");
    }
    payload["data"]["items"]
        .as_array()
        .and_then(|a| a.first())
        .ok_or("NEA returned no items")
}

fn label_points(psi_payload: &Value) -> Vec<(String, f64, f64)> {
    psi_payload["data"]["regionMetadata"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| {
                    let lat = m["labelLocation"]["latitude"].as_f64()?;
                    let lon = m["labelLocation"]["longitude"].as_f64()?;
                    Some((m["name"].as_str()?.to_owned(), lat, lon))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Closest region by distance to its NEA label point, or `None`.
pub fn nearest_region(regions: &[Value], lat: f64, lon: f64) -> Option<String> {
    regions
        .iter()
        .filter_map(|r| {
            Some((
                r["region"].as_str()?,
                haversine_km(
                    lat,
                    lon,
                    r["labelLatitude"].as_f64()?,
                    r["labelLongitude"].as_f64()?,
                ),
            ))
        })
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(n, _)| n.to_owned())
}

/// The response from raw NEA payloads. `Err` on a malformed payload (the
/// route turns it into `available: false`).
pub fn parse_sg_air(
    psi_payload: &Value,
    pm25_payload: Option<&Value>,
    point: Option<(f64, f64)>,
    fetched_at: Option<&str>,
) -> Result<Value, &'static str> {
    let psi_item = first_item(psi_payload)?;
    let psi_readings = &psi_item["readings"]["psi_twenty_four_hourly"];
    if !psi_readings.is_object() {
        return Err("NEA PSI payload has no readings");
    }
    let pm25_readings = pm25_payload
        .and_then(|p| first_item(p).ok())
        .map(|i| i["readings"]["pm25_one_hourly"].clone())
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Map::new()));

    let psi_regional = region_values(psi_readings);
    if psi_regional.is_empty() && clean_int(&psi_readings["national"]).is_none() {
        return Err("NEA PSI payload has no readings");
    }
    let pm25_regional = region_values(&pm25_readings);
    let points = label_points(psi_payload);

    let mut regions = Vec::new();
    for name in REGION_NAMES {
        let psi_v = psi_regional
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, v)| *v);
        let pm_v = pm25_regional
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, v)| *v);
        if psi_v.is_none() && pm_v.is_none() {
            continue;
        }
        let point = points.iter().find(|(n, _, _)| n == name);
        regions.push(json!({
            "region": name,
            "psi24h": psi_v,
            "band": psi_v.and_then(|v| psi_band(v as f64)).map(|b| b.0),
            "pm25OneHour": pm_v,
            "labelLatitude": point.map(|p| p.1),
            "labelLongitude": point.map(|p| p.2),
        }));
    }

    let (psi24h, psi_basis) = headline(psi_readings, &psi_regional);
    let (pm25, pm25_basis) = headline(&pm25_readings, &pm25_regional);
    let band = psi24h.and_then(|v| psi_band(v as f64));
    let nearest = point.and_then(|(lat, lon)| nearest_region(&regions, lat, lon));

    Ok(json!({
        "available": true,
        "source": SOURCE_ATTRIBUTION,
        "observedAt": psi_item["timestamp"].as_str(),
        "fetchedAt": fetched_at,
        "psi24h": psi24h,
        "psiBasis": psi_basis,
        "band": band.map(|b| b.0),
        "bandLabel": band.map(|b| b.1),
        "pm25OneHour": pm25,
        "pm25Basis": pm25_basis,
        "regions": regions,
        "nearestRegion": nearest,
    }))
}

/// `{available: false, ...}` as FastAPI sends it (every other field null).
pub fn unavailable(fetched_at: Option<&str>) -> Value {
    json!({
        "available": false,
        "source": SOURCE_ATTRIBUTION,
        "observedAt": null,
        "fetchedAt": fetched_at,
        "psi24h": null,
        "psiBasis": null,
        "band": null,
        "bandLabel": null,
        "pm25OneHour": null,
        "pm25Basis": null,
        "regions": [],
        "nearestRegion": null,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn psi() -> Value {
        json!({"code": 0, "data": {
            "regionMetadata": [
                {"name": "west", "labelLocation": {"latitude": 1.35, "longitude": 103.7}},
                {"name": "east", "labelLocation": {"latitude": 1.35, "longitude": 103.94}},
            ],
            "items": [{"timestamp": "2026-10-18T10:00:00+08:00", "readings": {
                "psi_twenty_four_hourly": {"west": 55, "east": 62.0, "north": 48}}}]}})
    }

    #[test]
    fn bands_are_inclusive() {
        assert_eq!(psi_band(50.0).unwrap().0, "good");
        assert_eq!(psi_band(51.0).unwrap().0, "moderate");
        assert_eq!(psi_band(300.0).unwrap().0, "very_unhealthy");
        assert_eq!(psi_band(301.0).unwrap().0, "hazardous");
        assert!(psi_band(f64::NAN).is_none());
    }

    #[test]
    fn headline_is_the_highest_region_without_national() {
        let out = parse_sg_air(&psi(), None, Some((1.35, 103.93)), Some("t")).unwrap();
        assert_eq!(out["psi24h"], 62);
        assert_eq!(out["psiBasis"], "highest_region");
        assert_eq!(out["band"], "moderate");
        assert_eq!(out["nearestRegion"], "east");
        assert!(out["pm25OneHour"].is_null());
        assert_eq!(out["regions"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn malformed_is_an_error() {
        assert!(parse_sg_air(&json!({"code": 5}), None, None, None).is_err());
        assert!(
            parse_sg_air(&json!({"code": 0, "data": {"items": []}}), None, None, None).is_err()
        );
    }
}
