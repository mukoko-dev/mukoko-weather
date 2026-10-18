//! One global model's forecast on an n×n grid (ported from
//! `api/py/_model_grid.py`; the contract is pinned by
//! `tests/fixtures/model-grid.json`, which the Python tests check too).
//!
//! `GET /model-grid?lat=&lon=&model=ecmwf_ifs` answers temperature, rain and
//! 10 m wind for the next 72 hours, 3-hourly, at every point of a fixed 7×7
//! grid over ±120 km, from ONE batched Open-Meteo request per (cell, model).
//! The map paints each point as a cell and plays the steps forward.

use serde::Serialize;
use serde_json::Value;

/// The blend members, in the order the map lists them.
pub const MAP_MODELS: [&str; 6] = [
    "ecmwf_ifs",
    "ecmwf_aifs025_single",
    "gfs_seamless",
    "icon_global",
    "gem_global",
    "meteofrance_arpege_world",
];

pub const DEFAULT_MODEL: &str = "ecmwf_ifs";
/// 3 hours: global models run every 6 h, so this bounds staleness.
pub const CACHE_TTL_SECONDS: u64 = 3 * 60 * 60;
/// Hours of forecast and the step between frames (Now, +3h, … +72h).
pub const FORECAST_HOURS: usize = 72;
pub const STEP_HOURS: usize = 3;
/// 7×7 over ±120 km: 40 km cells, 49 Open-Meteo "locations" a fetch.
pub const GRID_N: usize = 7;
pub const RADIUS_KM: f64 = 120.0;
/// Centre snap, so neighbouring pages share one cache row (~28 km).
pub const CENTRE_SNAP_DEG: f64 = 0.25;
const KM_PER_DEG: f64 = 111.195;
const HOURLY_VARS: &str = "temperature_2m,precipitation,wind_speed_10m,wind_direction_10m";
pub const OPEN_METEO_FORECAST_URL: &str = "https://api.open-meteo.com/v1/forecast";

/// A blend member id (the dead `ecmwf_ifs04` mapped to `ecmwf_ifs`), else `None`.
pub fn canonical_model(model: &str) -> Option<&'static str> {
    let m = model.trim();
    let m = if m == "ecmwf_ifs04" { "ecmwf_ifs" } else { m };
    MAP_MODELS.iter().copied().find(|k| *k == m)
}

/// Python's `round(x, digits)` (round-half-even on the exact binary value),
/// through Rust's correctly rounded formatting.
fn round_to(x: f64, digits: usize) -> f64 {
    format!("{x:.digits$}").parse().unwrap_or(x)
}

pub fn snap_centre(value: f64) -> f64 {
    let snapped = round_to(
        (value / CENTRE_SNAP_DEG).round_ties_even() * CENTRE_SNAP_DEG,
        2,
    );
    // Python's int round never yields -0.0, so one place never has two keys.
    if snapped == 0.0 {
        0.0
    } else {
        snapped
    }
}

/// Spacing between adjacent grid points, the side of each map cell.
pub fn cell_km() -> f64 {
    (2.0 * RADIUS_KM) / (GRID_N as f64 - 1.0)
}

/// The n×n (lat, lon) grid, row-major from north-west to south-east
/// (`_aq_grid.build_grid` with `clamp=False`).
pub fn build_grid(lat: f64, lon: f64) -> Vec<(f64, f64)> {
    let n = GRID_N;
    let lat_rad = lat.clamp(-89.0, 89.0).to_radians();
    let km_per_deg_lon = KM_PER_DEG * lat_rad.cos();
    let half = (n as f64 - 1.0) / 2.0;
    let step_km = if half > 0.0 { RADIUS_KM / half } else { 0.0 };
    let mut points = Vec::with_capacity(n * n);
    for row in 0..n {
        let ns_km = (half - row as f64) * step_km;
        let p_lat = lat + ns_km / KM_PER_DEG;
        for col in 0..n {
            let ew_km = (col as f64 - half) * step_km;
            let p_lon = lon + ew_km / km_per_deg_lon;
            points.push((round_to(p_lat, 6), round_to(p_lon, 6)));
        }
    }
    points
}

/// Keep the grid inside WGS 84: latitudes clipped to ±89.9 and longitudes
/// wrapped into [-180, 180) across the antimeridian.
pub fn valid_grid(points: &[(f64, f64)]) -> Vec<(f64, f64)> {
    points
        .iter()
        .map(|&(lat, lon)| {
            let lat = lat.clamp(-89.9, 89.9);
            let lon = (lon + 180.0).rem_euclid(360.0) - 180.0;
            (round_to(lat, 6), round_to(lon, 6))
        })
        .collect()
}

pub fn cache_key(model: &str, lat: f64, lon: f64) -> String {
    format!(
        "mgrid:v1:{model}_{lat:.2}_{lon:.2}_{GRID_N}_{}",
        RADIUS_KM.round() as i64
    )
}

/// The batched Open-Meteo request for a grid and a model.
pub fn open_meteo_url(points: &[(f64, f64)], model: &str) -> String {
    let join = |f: fn(&(f64, f64)) -> f64| {
        points
            .iter()
            .map(|p| format!("{:.4}", f(p)))
            .collect::<Vec<_>>()
            .join(",")
    };
    let q = [
        ("latitude", join(|p| p.0)),
        ("longitude", join(|p| p.1)),
        ("hourly", HOURLY_VARS.to_owned()),
        ("models", model.to_owned()),
        ("forecast_hours", (FORECAST_HOURS + 1).to_string()),
        ("timezone", "GMT".to_owned()),
        ("wind_speed_unit", "kmh".to_owned()),
    ];
    let query = q
        .iter()
        .map(|(k, v)| format!("{k}={}", v.replace(',', "%2C")))
        .collect::<Vec<_>>()
        .join("&");
    format!("{OPEN_METEO_FORECAST_URL}?{query}")
}

#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridPoint {
    pub lat: f64,
    pub lon: f64,
    pub temperature: Vec<Option<f64>>,
    pub precipitation: Vec<Option<f64>>,
    pub wind_speed: Vec<Option<f64>>,
    pub wind_direction: Vec<Option<f64>>,
}

/// A finite number rounded to one decimal, else `None`.
fn num(v: &Value) -> Option<f64> {
    let f = v.as_f64()?;
    f.is_finite().then(|| round_to(f, 1))
}

/// Every `STEP_HOURS`-th value of an hourly series, padded with `None`.
fn sample(series: Option<&Value>, length: usize) -> Vec<Option<f64>> {
    let values = series.and_then(Value::as_array);
    (0..length)
        .step_by(STEP_HOURS)
        .map(|i| values.and_then(|v| v.get(i)).and_then(num))
        .collect()
}

#[derive(Debug, PartialEq, Eq)]
pub struct ParseError(pub String);

/// Normalise a batched Open-Meteo response to `(times, points)`. A length
/// mismatch or a response with no times is a contract violation (counts
/// against the breaker); a point whose series are all null is kept.
pub fn parse_model_grid(
    data: &Value,
    points: &[(f64, f64)],
) -> Result<(Vec<String>, Vec<GridPoint>), ParseError> {
    let single = [data.clone()];
    let entries: &[Value] = match data.as_array() {
        Some(a) => a,
        None => &single,
    };
    if entries.len() != points.len() {
        return Err(ParseError(format!(
            "expected {} grid entries, got {}",
            points.len(),
            entries.len()
        )));
    }
    let hourly = |e: &Value| e.get("hourly").filter(|h| h.is_object()).cloned();
    let raw_times = entries
        .first()
        .and_then(hourly)
        .and_then(|h| h.get("time").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    if raw_times.is_empty() {
        return Err(ParseError("no hourly times in model grid response".into()));
    }
    let length = raw_times.len().min(FORECAST_HOURS + 1);
    let times = raw_times[..length]
        .iter()
        .step_by(STEP_HOURS)
        .map(|t| format!("{}Z", t.as_str().unwrap_or("")))
        .collect();
    let out = points
        .iter()
        .zip(entries)
        .map(|(&(lat, lon), entry)| {
            let h = hourly(entry).unwrap_or(Value::Null);
            GridPoint {
                lat,
                lon,
                temperature: sample(h.get("temperature_2m"), length),
                precipitation: sample(h.get("precipitation"), length),
                wind_speed: sample(h.get("wind_speed_10m"), length),
                wind_direction: sample(h.get("wind_direction_10m"), length),
            }
        })
        .collect();
    Ok((times, out))
}

/// Does any point carry a temperature, rain or wind value? A model with no
/// data here answers all nulls: not an upstream failure.
pub fn has_any_value(points: &[GridPoint]) -> bool {
    points.iter().any(|p| {
        [&p.temperature, &p.precipitation, &p.wind_speed]
            .iter()
            .any(|s| s.iter().any(Option::is_some))
    })
}

/// The `ModelGridResponse` body, in the Pydantic field order.
#[allow(clippy::too_many_arguments)]
pub fn body(
    available: bool,
    model: &str,
    cell_km: f64,
    times: &[String],
    points: &[GridPoint],
    fetched_at: Option<&str>,
    reason: Option<&str>,
) -> Value {
    serde_json::json!({
        "available": available,
        "model": model,
        "cellKm": round_to(cell_km, 3),
        "times": times,
        "points": points,
        "fetchedAt": fetched_at,
        "reason": reason,
    })
}

/// An `available: false` answer; never cached.
pub fn unavailable(model: &str, reason: &str) -> Value {
    body(false, model, cell_km(), &[], &[], None, Some(reason))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../../../tests/fixtures/model-grid.json");

    fn fixture() -> Value {
        serde_json::from_str(FIXTURE).unwrap()
    }

    fn f(v: &Value) -> f64 {
        v.as_f64().unwrap()
    }

    #[test]
    fn centres_snap_like_python() {
        for c in fixture()["snap"].as_array().unwrap() {
            assert_eq!(snap_centre(f(&c["in"])), f(&c["out"]), "{c}");
        }
    }

    #[test]
    fn the_cell_is_forty_km() {
        assert_eq!(cell_km(), f(&fixture()["cellKm"]));
    }

    #[test]
    fn model_names_resolve_like_python() {
        for c in fixture()["canonical"].as_array().unwrap() {
            assert_eq!(
                canonical_model(c["in"].as_str().unwrap()),
                c["out"].as_str(),
                "{c}"
            );
        }
        assert_eq!(
            MAP_MODELS.to_vec(),
            fixture()["maxModels"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| m.as_str().unwrap())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn grids_match_python_everywhere_including_poles_and_the_antimeridian() {
        for g in fixture()["grids"].as_array().unwrap() {
            let (lat, lon) = (snap_centre(f(&g["lat"])), snap_centre(f(&g["lon"])));
            assert_eq!(lat, f(&g["snapLat"]));
            assert_eq!(lon, f(&g["snapLon"]));
            let pts = valid_grid(&build_grid(lat, lon));
            let want: Vec<(f64, f64)> = g["points"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| (f(&p[0]), f(&p[1])))
                .collect();
            assert_eq!(pts.len(), 49);
            for (a, b) in pts.iter().zip(&want) {
                assert!(
                    (a.0 - b.0).abs() < 1e-9 && (a.1 - b.1).abs() < 1e-9,
                    "{a:?} {b:?}"
                );
            }
            let url = open_meteo_url(&pts, "ecmwf_ifs");
            assert!(url.contains(&format!(
                "latitude={}",
                g["latitude"].as_str().unwrap().replace(',', "%2C")
            )));
            assert!(url.contains(&format!(
                "longitude={}",
                g["longitude"].as_str().unwrap().replace(',', "%2C")
            )));
            assert!(cache_key("ecmwf_ifs", lat, lon).ends_with(g["key"].as_str().unwrap()));
        }
    }

    #[test]
    fn the_request_carries_the_fixed_parameters() {
        let url = open_meteo_url(&[(0.0, 0.0)], "gfs_seamless");
        for (k, v) in fixture()["params"].as_object().unwrap() {
            assert!(
                url.contains(&format!("{k}={}", v.as_str().unwrap().replace(',', "%2C"))),
                "{k}"
            );
        }
    }

    fn pts(v: &Value) -> Vec<(f64, f64)> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|p| (f(&p[0]), f(&p[1])))
            .collect()
    }

    #[test]
    fn parsing_matches_python() {
        let p = &fixture()["parse"];
        let (times, out) = parse_model_grid(&p["data"], &pts(&p["points"])).unwrap();
        let want_times: Vec<&str> = p["times"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t.as_str().unwrap())
            .collect();
        assert_eq!(times, want_times);
        assert_eq!(serde_json::to_value(&out).unwrap(), p["out"]);
        assert_eq!(has_any_value(&out), p["hasAny"].as_bool().unwrap());
    }

    #[test]
    fn a_single_object_response_is_one_point() {
        let p = &fixture()["parseSingle"];
        let (times, out) = parse_model_grid(&p["data"], &pts(&p["points"])).unwrap();
        assert_eq!(times.len(), 2);
        assert_eq!(serde_json::to_value(&out).unwrap(), p["out"]);
    }

    #[test]
    fn all_nulls_is_kept_but_has_no_value() {
        let p = &fixture()["parseNulls"];
        let (_, out) = parse_model_grid(&p["data"], &pts(&p["points"])).unwrap();
        assert_eq!(out.len(), 1);
        assert!(!has_any_value(&out));
    }

    #[test]
    fn a_length_mismatch_and_a_response_without_times_are_errors() {
        let one = serde_json::json!([{"hourly": {"time": ["2026-10-18T00:00"]}}]);
        assert!(parse_model_grid(&one, &[(0.0, 0.0), (1.0, 1.0)]).is_err());
        assert!(parse_model_grid(&serde_json::json!([{"hourly": {}}]), &[(0.0, 0.0)]).is_err());
    }

    #[test]
    fn the_unavailable_body_has_the_pydantic_shape() {
        let b = unavailable("x", "unknown_model");
        assert_eq!(b["available"], false);
        assert_eq!(b["cellKm"], 40.0);
        assert_eq!(b["times"], serde_json::json!([]));
        assert_eq!(b["points"], serde_json::json!([]));
        assert!(b["fetchedAt"].is_null());
        assert_eq!(b["reason"], "unknown_model");
    }
}
