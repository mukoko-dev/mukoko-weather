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

/// Whether a coordinate pair is on the globe.
pub fn valid_coordinates(lat: f64, lon: f64) -> bool {
    lat.is_finite()
        && lon.is_finite()
        && (-90.0..=90.0).contains(&lat)
        && (-180.0..=180.0).contains(&lon)
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
}
