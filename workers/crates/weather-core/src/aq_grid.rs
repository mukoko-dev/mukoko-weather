//! Air quality grid: US AQI on a regular n×n grid around a point (ported from
//! `api/py/_aq_grid.py`). One batched Open-Meteo request covers every point.

use serde_json::{json, Value};

pub const OPEN_METEO_AQ_URL: &str = "https://air-quality-api.open-meteo.com/v1/air-quality";
/// Cache lifetime: 30 minutes.
pub const CACHE_TTL_SECONDS: u64 = 30 * 60;
pub const GRID_N_MIN: i64 = 5;
pub const GRID_N_MAX: i64 = 9;
pub const GRID_N_DEFAULT: i64 = 7;
pub const RADIUS_KM_MIN: f64 = 5.0;
pub const RADIUS_KM_MAX: f64 = 100.0;
pub const RADIUS_KM_DEFAULT: f64 = 40.0;
pub const SOURCE_LABEL: &str = "Open-Meteo Air Quality (CAMS)";
/// One degree of arc on a spherical Earth, shared with `src/lib/aq-grid.ts`.
const KM_PER_DEG: f64 = 111.195;

/// Clamp n to 5..9 and bump an even value up to the next odd.
pub fn normalise_n(n: i64) -> i64 {
    let n = n.clamp(GRID_N_MIN, GRID_N_MAX);
    if n % 2 == 0 {
        n + 1
    } else {
        n
    }
}

pub fn clamp_radius(radius_km: f64) -> f64 {
    radius_km.clamp(RADIUS_KM_MIN, RADIUS_KM_MAX)
}

/// Spacing between adjacent points, also the side of each map cell.
pub fn grid_cell_km(radius_km: f64, n: i64) -> f64 {
    (2.0 * radius_km) / (n - 1) as f64
}

fn round_to(v: f64, places: i32) -> f64 {
    let f = 10f64.powi(places);
    (v * f).round_ties_even() / f
}

/// The n×n grid, row-major from north-west to south-east.
pub fn build_grid(lat: f64, lon: f64, radius_km: f64, n: i64) -> Vec<(f64, f64)> {
    let n = normalise_n(n);
    let radius_km = clamp_radius(radius_km);
    let lat_rad = lat.clamp(-89.0, 89.0).to_radians();
    let km_per_deg_lon = KM_PER_DEG * lat_rad.cos();
    let half = (n - 1) as f64 / 2.0;
    let step_km = if half > 0.0 { radius_km / half } else { 0.0 };
    let mut points = Vec::with_capacity((n * n) as usize);
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

/// The Open-Meteo batch request URL for a grid (comma-separated lists).
pub fn open_meteo_url(points: &[(f64, f64)]) -> String {
    let lats: Vec<String> = points.iter().map(|p| format!("{:.4}", p.0)).collect();
    let lons: Vec<String> = points.iter().map(|p| format!("{:.4}", p.1)).collect();
    format!(
        "{OPEN_METEO_AQ_URL}?latitude={}&longitude={}&current=us_aqi,pm2_5",
        lats.join(","),
        lons.join(",")
    )
}

/// One grid point's reading: `(US AQI, PM2.5)`.
pub type Reading = (Option<i64>, Option<f64>);

fn parse_current(entry: &Value) -> Reading {
    let cur = &entry["current"];
    let num = |v: &Value| {
        v.as_f64()
            .or_else(|| v.as_str().and_then(|s| s.trim().parse::<f64>().ok()))
            .filter(|x| x.is_finite())
    };
    (
        num(&cur["us_aqi"]).map(|a| a.round_ties_even() as i64),
        num(&cur["pm2_5"]),
    )
}

/// One `(aqi, pm2_5)` per point. A single-coordinate request answers an
/// object, a batch a list. A length mismatch is an upstream contract
/// violation (`Err`, so the breaker records a failure).
pub fn parse_grid_response(
    data: &Value,
    points: &[(f64, f64)],
) -> Result<Vec<Reading>, &'static str> {
    let entries: Vec<&Value> = match data.as_array() {
        Some(a) => a.iter().collect(),
        None => vec![data],
    };
    if entries.len() != points.len() {
        return Err("grid entry count mismatch");
    }
    Ok(entries.into_iter().map(parse_current).collect())
}

/// `{lat:.2f}_{lon:.2f}_{n}_{radius}` under a Worker prefix.
pub fn cache_key(lat: f64, lon: f64, n: i64, radius_km: f64) -> String {
    format!(
        "aqgrid:v1:{lat:.2}_{lon:.2}_{n}_{}",
        radius_km.round_ties_even() as i64
    )
}

/// The success body (without `fetchedAt`, which the caller adds).
pub fn payload(
    lat_r: f64,
    lon_r: f64,
    n: i64,
    radius_km: f64,
    readings: &[(Option<i64>, Option<f64>)],
    points: &[(f64, f64)],
) -> Value {
    let pts: Vec<Value> = points
        .iter()
        .zip(readings)
        .map(|(p, r)| json!({"lat": p.0, "lon": p.1, "aqi": r.0, "pm2_5": r.1}))
        .collect();
    let centre_aqi = pts[((n * n) / 2) as usize]["aqi"].clone();
    json!({
        "available": true,
        "center": {"lat": lat_r, "lon": lon_r, "aqi": centre_aqi},
        "cellKm": round_to(grid_cell_km(radius_km, n), 3),
        "points": pts,
        "fetchedAt": null,
        "source": SOURCE_LABEL,
    })
}

/// The degraded body: `available: false`, nothing else but the cell size.
pub fn unavailable(cell_km: f64) -> Value {
    json!({
        "available": false,
        "center": null,
        "cellKm": round_to(cell_km, 3),
        "points": [],
        "fetchedAt": null,
        "source": SOURCE_LABEL,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn n_is_odd_and_bounded() {
        assert_eq!(normalise_n(1), 5);
        assert_eq!(normalise_n(6), 7);
        assert_eq!(normalise_n(8), 9);
        assert_eq!(normalise_n(40), 9);
        assert_eq!(clamp_radius(1.0), 5.0);
        assert_eq!(clamp_radius(500.0), 100.0);
    }

    #[test]
    fn grid_is_centred_and_row_major() {
        let g = build_grid(-17.83, 31.05, 40.0, 7);
        assert_eq!(g.len(), 49);
        assert_eq!(g[24], (-17.83, 31.05));
        assert!(g[0].0 > g[48].0, "north first");
        assert!(g[0].1 < g[48].1, "west first");
        assert!((grid_cell_km(40.0, 7) - 13.333).abs() < 1e-2);
    }

    #[test]
    fn parses_batches_and_rejects_mismatch() {
        let pts = vec![(0.0, 0.0), (1.0, 1.0)];
        let ok = parse_grid_response(
            &json!([{"current": {"us_aqi": 41.6, "pm2_5": 9.5}}, {"current": {}}]),
            &pts,
        )
        .unwrap();
        assert_eq!(ok, vec![(Some(42), Some(9.5)), (None, None)]);
        assert!(parse_grid_response(&json!([{"current": {}}]), &pts).is_err());
    }
}
