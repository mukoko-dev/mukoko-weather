//! Places a forecast can be asked for.
//!
//! The app's seed locations (`src/lib/locations.ts`) are compiled in, so the
//! common slugs resolve with no subrequest. Anything else is a canonical place
//! record, which belongs to the Nyuchi API (`GET /v1/places/{slug}`); the
//! forecast Worker asks it and [`Place::from_nyuchi_place`] reads the answer.
//! Regenerate the seed file with `workers/scripts/gen-seed-locations.mjs`.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::geo::haversine_km;

/// A resolved place.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Place {
    pub slug: String,
    pub name: Option<String>,
    pub lat: f64,
    pub lon: f64,
    /// Metres above sea level, when known.
    #[serde(default)]
    pub elevation: Option<f64>,
    #[serde(default)]
    pub country: Option<String>,
}

#[derive(Deserialize)]
struct SeedRow {
    slug: String,
    name: String,
    #[allow(dead_code)]
    province: String,
    country: Option<String>,
    lat: f64,
    lon: f64,
    elevation: f64,
}

static SEED_JSON: &str = include_str!("../data/seed-locations.json");

/// The compiled-in seed locations.
pub fn seed() -> &'static [Place] {
    static SEED: OnceLock<Vec<Place>> = OnceLock::new();
    SEED.get_or_init(|| {
        let rows: Vec<SeedRow> =
            serde_json::from_str(SEED_JSON).expect("seed-locations.json is valid (checked in CI)");
        rows.into_iter()
            .map(|r| Place {
                slug: r.slug,
                name: Some(r.name),
                lat: r.lat,
                lon: r.lon,
                elevation: Some(r.elevation),
                country: r.country,
            })
            .collect()
    })
}

/// Lower-case, ASCII-fold the common accents, and join words with `-`, the
/// way the app builds slugs.
pub fn slugify(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut dash = false;
    for ch in text.trim().chars().flat_map(char::to_lowercase) {
        let ch = match ch {
            'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => 'a',
            'è' | 'é' | 'ê' | 'ë' => 'e',
            'ì' | 'í' | 'î' | 'ï' => 'i',
            'ò' | 'ó' | 'ô' | 'õ' | 'ö' => 'o',
            'ù' | 'ú' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            'ñ' => 'n',
            c => c,
        };
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

/// Resolve a slug or a name against the seed locations: an exact slug first,
/// then a case-insensitive name, then the slug of the name.
pub fn resolve_seed(query: &str) -> Option<&'static Place> {
    let q = query.trim();
    if q.is_empty() {
        return None;
    }
    let places = seed();
    if let Some(p) = places.iter().find(|p| p.slug == q) {
        return Some(p);
    }
    let lower = q.to_lowercase();
    if let Some(p) = places
        .iter()
        .find(|p| p.name.as_deref().is_some_and(|n| n.to_lowercase() == lower))
    {
        return Some(p);
    }
    let slug = slugify(q);
    places.iter().find(|p| p.slug == slug)
}

/// The nearest seed location within `max_km`, if any.
pub fn nearest_seed(lat: f64, lon: f64, max_km: f64) -> Option<&'static Place> {
    seed()
        .iter()
        .map(|p| (p, haversine_km(lat, lon, p.lat, p.lon)))
        .filter(|(_, d)| *d <= max_km)
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(p, _)| p)
}

/// The place for a bare coordinate request: the nearest seed location within
/// 10 km lends its slug and name; otherwise the slug is the rounded point and
/// there is no name.
pub fn place_for_point(lat: f64, lon: f64) -> Place {
    match nearest_seed(lat, lon, 10.0) {
        Some(p) => Place {
            lat,
            lon,
            ..p.clone()
        },
        None => Place {
            slug: crate::geo::cache_key(lat, lon),
            name: None,
            lat,
            lon,
            elevation: None,
            country: None,
        },
    }
}

impl Place {
    /// Read a place record from the Nyuchi API (`GET /v1/places/{id}`, which
    /// answers `{"place": {...}}`). Coordinates may be Schema.org `geo`
    /// (`latitude`/`longitude`), a GeoJSON `location` point, or flat
    /// `lat`/`lon`. Returns `None` when the record has no usable point.
    pub fn from_nyuchi_place(body: &Value) -> Option<Place> {
        let doc = body.get("place").unwrap_or(body);
        let num = |v: Option<&Value>| v.and_then(Value::as_f64);
        let (lat, lon) = if let (Some(lat), Some(lon)) = (
            num(doc.pointer("/geo/latitude")),
            num(doc.pointer("/geo/longitude")),
        ) {
            (lat, lon)
        } else if let Some(coords) = doc
            .pointer("/location/coordinates")
            .and_then(Value::as_array)
        {
            (num(coords.get(1))?, num(coords.first())?)
        } else {
            (
                num(doc.get("lat"))?,
                num(doc.get("lon")).or(num(doc.get("lng")))?,
            )
        };
        if !crate::geo::valid_coordinates(lat, lon) {
            return None;
        }
        let text = |p: &str| doc.pointer(p).and_then(Value::as_str).map(str::to_owned);
        let name = text("/name");
        let slug = text("/slug")
            .or_else(|| name.as_deref().map(slugify))
            .unwrap_or_else(|| crate::geo::cache_key(lat, lon));
        Some(Place {
            slug,
            name,
            lat,
            lon,
            elevation: num(doc.pointer("/geo/elevation")).or(num(doc.get("elevation"))),
            country: text("/address/addressCountry").or_else(|| text("/country")),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_seed_list_loads_and_has_harare() {
        assert!(seed().len() > 200);
        let h = resolve_seed("harare").unwrap();
        assert_eq!(h.name.as_deref(), Some("Harare"));
        assert_eq!(h.country.as_deref(), Some("ZW"));
    }

    #[test]
    fn slugs_are_unique() {
        let mut slugs: Vec<_> = seed().iter().map(|p| p.slug.as_str()).collect();
        slugs.sort_unstable();
        let n = slugs.len();
        slugs.dedup();
        assert_eq!(n, slugs.len());
    }

    #[test]
    fn names_resolve_case_insensitively() {
        assert_eq!(resolve_seed("  BULAWAYO ").unwrap().slug, "bulawayo");
        assert_eq!(
            resolve_seed("Nairobi").map(|p| p.slug.as_str()),
            Some("nairobi-ke")
        );
        assert!(resolve_seed("atlantis").is_none());
        assert!(resolve_seed("").is_none());
    }

    #[test]
    fn slugify_matches_the_app() {
        assert_eq!(slugify("Victoria Falls"), "victoria-falls");
        assert_eq!(slugify("  São Tomé "), "sao-tome");
        assert_eq!(slugify("a -- b"), "a-b");
    }

    #[test]
    fn a_point_near_harare_borrows_its_name() {
        let p = place_for_point(-17.84, 31.04);
        assert_eq!(p.slug, "harare");
        assert_eq!(p.lat, -17.84);
        let far = place_for_point(-60.0, -120.0);
        assert_eq!(far.slug, "-60.00_-120.00");
        assert_eq!(far.name, None);
    }

    #[test]
    fn nyuchi_place_records_are_read_in_each_shape() {
        let geo = json!({"place": {"slug": "mutare-market", "name": "Mutare Market",
            "geo": {"latitude": -18.97, "longitude": 32.67}}});
        let p = Place::from_nyuchi_place(&geo).unwrap();
        assert_eq!(
            (p.slug.as_str(), p.lat, p.lon),
            ("mutare-market", -18.97, 32.67)
        );

        let geojson = json!({"place": {"name": "Chimanimani Hut",
            "location": {"type": "Point", "coordinates": [32.85, -19.8]}}});
        let p = Place::from_nyuchi_place(&geojson).unwrap();
        assert_eq!(
            (p.slug.as_str(), p.lat, p.lon),
            ("chimanimani-hut", -19.8, 32.85)
        );

        assert!(Place::from_nyuchi_place(&json!({"place": {"name": "No point"}})).is_none());
        assert!(Place::from_nyuchi_place(&json!({"lat": 120.0, "lon": 0.0})).is_none());
    }
}
