//! Small geographic helpers.

const EARTH_RADIUS_KM: f64 = 6371.0;

/// Great-circle distance in kilometres.
pub fn haversine_km(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let (p1, p2) = (lat1.to_radians(), lat2.to_radians());
    let dp = (lat2 - lat1).to_radians();
    let dl = (lon2 - lon1).to_radians();
    let a = (dp / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_KM * a.sqrt().atan2((1.0 - a).sqrt())
}

/// A bounding box around a point, for an indexed range query before the
/// exact distance check (D1 has no geospatial index).
pub fn bounding_box(lat: f64, lon: f64, radius_km: f64) -> (f64, f64, f64, f64) {
    let dlat = radius_km / 111.0;
    let cos = lat.to_radians().cos().abs().max(0.01);
    let dlon = (radius_km / (111.0 * cos)).min(180.0);
    (lat - dlat, lat + dlat, lon - dlon, lon + dlon)
}

/// The forecast cache key for a point: coordinates rounded to 0.01°
/// (about 1 km).
///
/// The Python backend keyed its cache by the nearest known place at any
/// distance, so two points 500 km apart could share one cached forecast. This
/// keys by the point itself.
pub fn cache_key(lat: f64, lon: f64) -> String {
    // Normalise -0.00 to 0.00 so one place never has two keys.
    let r = |v: f64| {
        let x = (v * 100.0).round() / 100.0;
        if x == 0.0 {
            0.0
        } else {
            x
        }
    };
    format!("{:.2}_{:.2}", r(lat), r(lon))
}

/// The forecast Worker's KV key for a point (`wx:v2:` + [`cache_key`]). One
/// definition, used by `mukoko-weather-forecast` to write and read the entry
/// and by every Worker that reads it cache-only (the report snapshot).
pub fn forecast_cache_key(lat: f64, lon: f64) -> String {
    format!("wx:v2:{}", cache_key(lat, lon))
}

/// Whether a coordinate pair is on the globe.
pub fn valid_coordinates(lat: f64, lon: f64) -> bool {
    lat.is_finite()
        && lon.is_finite()
        && (-90.0..=90.0).contains(&lat)
        && (-180.0..=180.0).contains(&lon)
}

/// The 0.05° (~5.6 km) grid cell of a coordinate, `cell:-17.85_31.05`: the key
/// the Python `weather_cache_key` and the TypeScript `weatherCacheKey` derive,
/// pinned to `tests/fixtures/weather-cache-keys.json`. Built from integer cell
/// indices (round half up), never from formatted floats.
pub fn cell_key(lat: f64, lon: f64) -> String {
    let (lat_i, lon_i) = cell_indices(lat, lon);
    format!(
        "cell:{}_{}",
        hundredths_label(lat_i),
        hundredths_label(lon_i)
    )
}

/// The centre of the 0.05° cell a coordinate falls in, as `(lat, lon)`: the
/// point the cell key is named after (`cell:-17.85_31.05` is centred on
/// -17.85, 31.05). A provider that is asked about the cell, not about the
/// visitor, answers the same for everyone in it, so a cached answer does not
/// depend on who asked first, and the provider is sent a point about 5 km
/// coarse instead of the visitor's exact one.
pub fn cell_center(lat: f64, lon: f64) -> (f64, f64) {
    let (lat_i, lon_i) = cell_indices(lat, lon);
    ((lat_i * 5) as f64 / 100.0, (lon_i * 5) as f64 / 100.0)
}

/// Cells per degree: 0.05° is 1/20.
const CELLS_PER_DEG: f64 = 20.0;

/// The integer cell indices (round half up) of a coordinate, latitude clamped
/// to the poles and longitude wrapped across the antimeridian.
fn cell_indices(lat: f64, lon: f64) -> (i64, i64) {
    const LAT_MAX: i64 = 90 * 20;
    const LON_MAX: i64 = 180 * 20;
    let idx = |v: f64| (v * CELLS_PER_DEG + 0.5).floor() as i64;
    let lat_i = idx(lat).clamp(-LAT_MAX, LAT_MAX);
    let mut lon_i = idx(lon);
    if lon_i >= LON_MAX {
        lon_i -= 2 * LON_MAX;
    } else if lon_i < -LON_MAX {
        lon_i += 2 * LON_MAX;
    }
    (lat_i, lon_i)
}

/// A cell index as degrees with two decimals, built from integers so no
/// formatted float can disagree between implementations.
fn hundredths_label(i: i64) -> String {
    let hundredths = i * 5;
    let sign = if hundredths < 0 { "-" } else { "" };
    let a = hundredths.abs();
    format!("{sign}{}.{:02}", a / 100, a % 100)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn harare_to_bulawayo_is_about_365_km() {
        let d = haversine_km(-17.83, 31.05, -20.15, 28.58);
        assert!((d - 365.0).abs() < 10.0, "{d}");
    }

    #[test]
    fn the_forecast_kv_key_is_the_versioned_point_key() {
        // The forecast Worker writes under this key and others read it cache
        // only; changing it orphans every cached forecast.
        assert_eq!(forecast_cache_key(-17.83, 31.05), "wx:v2:-17.83_31.05");
        assert_eq!(forecast_cache_key(-0.001, 0.0), "wx:v2:0.00_0.00");
    }

    #[test]
    fn cache_key_rounds_and_has_no_negative_zero() {
        assert_eq!(cache_key(-17.8312, 31.0499), "-17.83_31.05");
        assert_eq!(cache_key(-0.001, 0.004), "0.00_0.00");
    }

    #[test]
    fn bounding_box_contains_the_radius() {
        let (lat_min, lat_max, lon_min, lon_max) = bounding_box(-17.83, 31.05, 50.0);
        assert!(lat_min < -18.2 && lat_max > -17.4);
        assert!(lon_min < 30.6 && lon_max > 31.5);
    }

    #[test]
    fn coordinates_are_validated() {
        assert!(valid_coordinates(-17.8, 31.0));
        assert!(!valid_coordinates(91.0, 0.0));
        assert!(!valid_coordinates(0.0, f64::NAN));
    }

    #[test]
    fn a_cell_centre_is_the_point_its_key_is_named_after() {
        // Everyone in the cell gets the same centre, and the key reads back
        // as that centre.
        for (lat, lon) in [
            (-17.8312, 31.0499),
            (-17.86, 31.03),
            (51.5072, -0.1276),
            (0.0, 0.0),
            (-0.01, 179.99),
        ] {
            let (clat, clon) = cell_center(lat, lon);
            assert_eq!(cell_key(clat, clon), cell_key(lat, lon), "{lat},{lon}");
            // The centre is within half a cell of the point.
            let dlon = (clon - lon).abs().min(360.0 - (clon - lon).abs());
            assert!((clat - lat).abs() <= 0.025 + 1e-9, "{lat}");
            assert!(dlon <= 0.025 + 1e-9, "{lon}");
        }
        assert_eq!(cell_center(-17.8312, 31.0499), (-17.85, 31.05));
        // Across the antimeridian the centre wraps like the key does.
        assert_eq!(cell_center(10.0, 180.0), (10.0, -180.0));
        // A pole stays on the globe.
        assert_eq!(cell_center(90.0, 10.0).0, 90.0);
    }

    #[test]
    fn cell_keys_match_the_shared_vectors() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/weather-cache-keys.json"
        ))
        .unwrap();
        let vectors = fixture["vectors"].as_array().unwrap();
        assert!(vectors.len() >= 5);
        for v in vectors {
            let got = cell_key(v["lat"].as_f64().unwrap(), v["lon"].as_f64().unwrap());
            assert_eq!(got, v["key"].as_str().unwrap(), "{v}");
        }
    }
}
