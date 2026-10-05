//! The app's location documents: search, lookup and naming.
//!
//! Ported from `api/py/_locations.py` and `api/py/_geohash.py` for
//! `mukoko-weather-places`. The Python backend read `places.placesGeo` in
//! MongoDB; the Worker never reads a database, so a location comes from, in
//! order:
//!
//! 1. the app's seed locations (compiled in, with their tags);
//! 2. a `{name}--{geohash}` slug, which carries its own coordinate (the app's
//!    `src/lib/smart-slug.ts`), so a spot needs no record to exist;
//! 3. the Nyuchi API's canonical places (`/v1/places`), adapted here;
//! 4. geocoding (Open-Meteo forward, Nominatim reverse), adapted here.
//!
//! The JSON shape is the app's `LocationDoc` (`src/lib/locations.ts`).

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::geo::{haversine_km, valid_coordinates};
use crate::places::{slugify, Place};

/// One location, in the app's `LocationDoc` shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationDoc {
    pub slug: String,
    pub name: String,
    pub province: String,
    pub lat: f64,
    pub lon: f64,
    pub elevation: f64,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub country: Option<String>,
    /// `seed`, `places` (the Nyuchi API), `geocoded` or `geolocation`.
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub province_slug: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nominatim_address: Option<Value>,
}

#[derive(Deserialize)]
struct SeedRow {
    slug: String,
    name: String,
    province: String,
    country: Option<String>,
    lat: f64,
    lon: f64,
    elevation: f64,
    #[serde(default)]
    tags: Vec<String>,
}

static SEED_JSON: &str = include_str!("../data/seed-locations.json");

/// The compiled-in seed locations, with their tags.
pub fn seed_locations() -> &'static [LocationDoc] {
    static SEED: OnceLock<Vec<LocationDoc>> = OnceLock::new();
    SEED.get_or_init(|| {
        let rows: Vec<SeedRow> =
            serde_json::from_str(SEED_JSON).expect("seed-locations.json is valid (checked in CI)");
        rows.into_iter()
            .map(|r| LocationDoc {
                province_slug: Some(province_slug(
                    &r.province,
                    r.country.as_deref().unwrap_or(""),
                )),
                slug: r.slug,
                name: r.name,
                province: r.province,
                lat: r.lat,
                lon: r.lon,
                elevation: r.elevation,
                tags: r.tags,
                country: r.country,
                source: "seed".into(),
                nominatim_address: None,
            })
            .collect()
    })
}

/// A seed location by exact slug.
pub fn find_seed(slug: &str) -> Option<&'static LocationDoc> {
    seed_locations().iter().find(|l| l.slug == slug)
}

/// Seed locations matching `q` (name, slug or province, case-insensitive),
/// best matches first, optionally only those carrying `tag`.
pub fn search_seed(q: &str, tag: Option<&str>) -> Vec<&'static LocationDoc> {
    let q = q.trim().to_lowercase();
    let qs = slugify(&q);
    let mut hits: Vec<(u8, &LocationDoc)> = seed_locations()
        .iter()
        .filter(|l| tag.is_none_or(|t| l.tags.iter().any(|x| x == t)))
        .filter_map(|l| {
            let name = l.name.to_lowercase();
            let rank = if q.is_empty() {
                3
            } else if name == q || l.slug == qs {
                0
            } else if name.starts_with(&q) || (!qs.is_empty() && l.slug.starts_with(&qs)) {
                1
            } else if name.contains(&q) {
                2
            } else if l.province.to_lowercase().contains(&q) {
                3
            } else {
                return None;
            };
            Some((rank, l))
        })
        .collect();
    hits.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.name.cmp(&b.1.name)));
    hits.into_iter().map(|(_, l)| l).collect()
}

/// Seed locations in a country (ISO alpha-2, any case), by name.
pub fn seed_in_country(country: &str) -> Vec<&'static LocationDoc> {
    let cc = country.trim().to_uppercase();
    let mut out: Vec<_> = seed_locations()
        .iter()
        .filter(|l| l.country.as_deref() == Some(cc.as_str()))
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// How many seed locations carry each tag.
pub fn tag_counts() -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    for t in seed_locations().iter().flat_map(|l| &l.tags) {
        *counts.entry(t.clone()).or_insert(0) += 1;
    }
    counts
}

/// `{totalLocations, totalProvinces, totalCountries}` over the seed list.
pub fn stats() -> Value {
    let all = seed_locations();
    let provinces: std::collections::BTreeSet<_> = all
        .iter()
        .map(|l| (l.country.as_deref(), l.province.as_str()))
        .collect();
    let countries: std::collections::BTreeSet<_> =
        all.iter().filter_map(|l| l.country.as_deref()).collect();
    json!({
        "totalLocations": all.len(),
        "totalProvinces": provinces.len(),
        "totalCountries": countries.len(),
    })
}

/// Seed locations within `max_km` of a point, nearest first.
pub fn nearest_seeds(lat: f64, lon: f64, max_km: f64, limit: usize) -> Vec<&'static LocationDoc> {
    let mut near: Vec<_> = seed_locations()
        .iter()
        .map(|l| (haversine_km(lat, lon, l.lat, l.lon), l))
        .filter(|(d, _)| *d <= max_km)
        .collect();
    near.sort_by(|a, b| a.0.total_cmp(&b.0));
    near.into_iter().take(limit).map(|(_, l)| l).collect()
}

/// The Python backend's `_generate_slug`: the name, then the country code.
pub fn generate_slug(name: &str, country: &str) -> String {
    let mut slug = slugify(name);
    if !country.is_empty() {
        slug.push('-');
        slug.push_str(&country.to_lowercase());
    }
    slug.chars().take(80).collect()
}

/// The Python backend's `_generate_province_slug`.
pub fn province_slug(province: &str, country: &str) -> String {
    format!("{}-{}", slugify(province), country.to_lowercase())
        .chars()
        .take(80)
        .collect()
}

// --- Geohash and `{name}--{geohash}` slugs (src/lib/geohash.ts) ---------

const BASE32: &[u8; 32] = b"0123456789bcdefghjkmnpqrstuvwxyz";
/// 7 characters is a cell of about 153 m, the app's default.
pub const GEOHASH_PRECISION: usize = 7;
const MAX_GEOHASH_LEN: usize = 12;
const SMART_SLUG_DELIMITER: &str = "--";
const MAX_NAME_LEN: usize = 60;

/// Encode a coordinate; `""` for an unusable one.
pub fn encode_geohash(lat: f64, lon: f64, precision: usize) -> String {
    if !valid_coordinates(lat, lon) {
        return String::new();
    }
    let len = precision.clamp(1, MAX_GEOHASH_LEN);
    let (mut lat_r, mut lon_r) = ((-90.0f64, 90.0f64), (-180.0f64, 180.0f64));
    let (mut out, mut bits, mut n, mut is_lon) = (String::new(), 0usize, 0, true);
    while out.len() < len {
        let (r, v) = if is_lon {
            (&mut lon_r, lon)
        } else {
            (&mut lat_r, lat)
        };
        let mid = (r.0 + r.1) / 2.0;
        if v >= mid {
            bits = (bits << 1) | 1;
            r.0 = mid;
        } else {
            bits <<= 1;
            r.1 = mid;
        }
        is_lon = !is_lon;
        n += 1;
        if n == 5 {
            out.push(BASE32[bits] as char);
            bits = 0;
            n = 0;
        }
    }
    out
}

/// The centre of a geohash cell, or `None` when it is not one.
pub fn decode_geohash(hash: &str) -> Option<(f64, f64)> {
    if hash.is_empty() || hash.len() > MAX_GEOHASH_LEN {
        return None;
    }
    let (mut lat_r, mut lon_r) = ((-90.0f64, 90.0f64), (-180.0f64, 180.0f64));
    let mut is_lon = true;
    for c in hash.to_ascii_lowercase().bytes() {
        let value = BASE32.iter().position(|b| *b == c)?;
        for shift in (0..5).rev() {
            let r = if is_lon { &mut lon_r } else { &mut lat_r };
            let mid = (r.0 + r.1) / 2.0;
            if value >> shift & 1 == 1 {
                r.0 = mid;
            } else {
                r.1 = mid;
            }
            is_lon = !is_lon;
        }
    }
    Some(((lat_r.0 + lat_r.1) / 2.0, (lon_r.0 + lon_r.1) / 2.0))
}

/// `slugifyName` in src/lib/smart-slug.ts.
pub fn slugify_name(name: &str) -> String {
    let s: String = slugify(name).chars().take(MAX_NAME_LEN).collect();
    s.trim_end_matches('-').to_owned()
}

/// `{name}--{geohash}`: deterministic for a name at a coordinate.
pub fn build_smart_slug(name: &str, lat: f64, lon: f64) -> String {
    let hash = encode_geohash(lat, lon, GEOHASH_PRECISION);
    if hash.is_empty() {
        return String::new();
    }
    let prefix = slugify_name(name);
    let prefix = if prefix.is_empty() { "place" } else { &prefix };
    format!("{prefix}{SMART_SLUG_DELIMITER}{hash}")
}

/// A `{name}--{geohash}` slug: its name (title-cased from the slug) and the
/// centre of its cell. `None` for any other slug, including map-feature slugs
/// (`{name}--osm-w123`), which carry no coordinate.
pub fn parse_spot_slug(slug: &str) -> Option<(String, f64, f64)> {
    let idx = slug.rfind(SMART_SLUG_DELIMITER)?;
    let (name_slug, hash) = (&slug[..idx], &slug[idx + SMART_SLUG_DELIMITER.len()..]);
    let (lat, lon) = decode_geohash(hash)?;
    let name = name_slug
        .split('-')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let mut c = p.chars();
            c.next()
                .map(|f| f.to_uppercase().chain(c).collect::<String>())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ");
    Some((name, lat, lon))
}

impl LocationDoc {
    /// A spot named only by its slug (no reverse geocode to hand).
    pub fn spot(slug: &str) -> Option<LocationDoc> {
        let (name, lat, lon) = parse_spot_slug(slug)?;
        Some(LocationDoc {
            slug: slug.to_owned(),
            name: if name.is_empty() {
                "Place".into()
            } else {
                name
            },
            province: String::new(),
            lat,
            lon,
            elevation: 0.0,
            tags: vec![],
            country: None,
            source: "geolocation".into(),
            province_slug: None,
            nominatim_address: None,
        })
    }

    /// A Nyuchi API place record (`{"place": {...}}` or a list item).
    pub fn from_nyuchi_place(doc: &Value) -> Option<LocationDoc> {
        let place = Place::from_nyuchi_place(doc)?;
        let doc = doc.get("place").unwrap_or(doc);
        let text = |p: &str| doc.pointer(p).and_then(Value::as_str).map(str::to_owned);
        let country = place.country.clone().map(|c| c.to_uppercase());
        let province = text("/address/addressRegion")
            .or_else(|| text("/address/city"))
            .or_else(|| text("/address/addressLocality"))
            .unwrap_or_default();
        Some(LocationDoc {
            name: place.name.clone().unwrap_or_else(|| place.slug.clone()),
            province_slug: (!province.is_empty())
                .then(|| province_slug(&province, country.as_deref().unwrap_or(""))),
            province,
            slug: place.slug,
            lat: place.lat,
            lon: place.lon,
            elevation: place.elevation.unwrap_or(0.0),
            tags: vec![],
            country,
            source: "places".into(),
            nominatim_address: None,
        })
    }

    /// One Open-Meteo geocoding result (`/v1/search`), as the Python search
    /// fallback built it.
    pub fn from_open_meteo(r: &Value) -> Option<LocationDoc> {
        let name = r.get("name")?.as_str()?.trim();
        let (lat, lon) = (r.get("latitude")?.as_f64()?, r.get("longitude")?.as_f64()?);
        if name.is_empty() || !valid_coordinates(lat, lon) {
            return None;
        }
        let country = r
            .get("country_code")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_uppercase();
        Some(LocationDoc {
            slug: generate_slug(name, &country),
            name: name.to_owned(),
            province: r
                .get("admin1")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            lat,
            lon,
            elevation: r.get("elevation").and_then(Value::as_f64).unwrap_or(0.0),
            tags: vec![],
            country: (!country.is_empty()).then_some(country),
            source: "geocoded".into(),
            province_slug: None,
            nominatim_address: None,
        })
    }

    /// A Nominatim reverse-geocode answer (`format=jsonv2`) for the point the
    /// person asked about. The slug is `{name}--{geohash}` of that point, so
    /// it resolves later with no record.
    pub fn from_nominatim(data: &Value, lat: f64, lon: f64) -> Option<LocationDoc> {
        let empty = Map::new();
        let address = data
            .get("address")
            .and_then(Value::as_object)
            .unwrap_or(&empty);
        let a = |k: &str| address.get(k).and_then(Value::as_str).unwrap_or("");
        let country = a("country_code").to_uppercase();
        let country_name = a("country");
        let name = location_name(data, address, country_name);
        if name.is_empty() {
            return None;
        }
        let admin1 = normalize_admin1(address, &country, country_name);
        let display = data
            .get("display_name")
            .and_then(Value::as_str)
            .unwrap_or("");
        let mut nominatim = Map::new();
        for (key, field) in [
            ("road", "road"),
            ("suburb", "suburb"),
            ("cityDistrict", "city_district"),
            ("city", "city"),
            ("state", "state"),
            ("stateDistrict", "state_district"),
            ("county", "county"),
            ("postcode", "postcode"),
            ("country", "country"),
        ] {
            if !a(field).is_empty() {
                nominatim.insert(key.into(), a(field).into());
            }
        }
        if !country.is_empty() {
            nominatim.insert("countryCode".into(), country.clone().into());
        }
        if !display.is_empty() {
            nominatim.insert("displayName".into(), display.into());
        }
        let num = |k: &str, d: f64| {
            data.get(k)
                .and_then(|v| v.as_f64().or_else(|| v.as_str()?.parse().ok()))
                .unwrap_or(d)
        };
        Some(LocationDoc {
            slug: build_smart_slug(&name, lat, lon),
            province_slug: Some(province_slug(&admin1, &country)),
            name,
            province: admin1,
            lat: num("lat", lat),
            lon: num("lon", lon),
            elevation: 0.0,
            tags: vec!["city".into()],
            country: (!country.is_empty()).then_some(country),
            source: "geolocation".into(),
            nominatim_address: Some(Value::Object(nominatim)),
        })
    }
}

/// City-states, where a state field is a postal code or the country itself.
const CITY_STATES: [&str; 13] = [
    "SG", "MC", "VA", "GI", "SM", "AD", "LI", "MT", "BN", "DJ", "BH", "QA", "KW",
];

/// `_extract_location_name`: a POI, then a suburb, then a road, then the city.
fn location_name(data: &Value, address: &Map<String, Value>, country_name: &str) -> String {
    let a = |k: &str| address.get(k).and_then(Value::as_str).unwrap_or("");
    let city = if a("city").is_empty() {
        a("town")
    } else {
        a("city")
    };
    let poi = data.get("name").and_then(Value::as_str).unwrap_or("");
    if !poi.is_empty() && poi != city && poi != country_name {
        return poi.into();
    }
    let suburb = if a("suburb").is_empty() {
        a("neighbourhood")
    } else {
        a("suburb")
    };
    if !suburb.is_empty() && suburb != city && suburb != country_name {
        return suburb.into();
    }
    if !a("road").is_empty() {
        return a("road").into();
    }
    [city, a("village"), a("county"), poi]
        .into_iter()
        .find(|s| !s.is_empty())
        .unwrap_or("")
        .into()
}

/// `_normalize_admin1`: a usable province, never a postal code.
fn normalize_admin1(address: &Map<String, Value>, country: &str, country_name: &str) -> String {
    let a = |k: &str| address.get(k).and_then(Value::as_str).unwrap_or("");
    let first = |keys: &[&str]| {
        keys.iter()
            .map(|k| a(k))
            .find(|s| !s.is_empty())
            .unwrap_or(country_name)
            .to_owned()
    };
    if CITY_STATES.contains(&country) {
        return first(&["city_district", "suburb", "state_district", "county"]);
    }
    let raw = if a("state").is_empty() {
        a("province")
    } else {
        a("state")
    }
    .trim();
    let n = raw.chars().count();
    if n > 2 {
        let digits = raw.chars().filter(char::is_ascii_digit).count();
        if digits * 2 < n {
            return raw.to_owned();
        }
    }
    first(&["state_district", "city_district", "region", "county"])
}

/// One `/api/py/history` record from a `place_daily` row.
pub fn history_record(
    slug: &str,
    recorded_at_ms: i64,
    current: Option<&str>,
    daily: Option<&str>,
    insights: Option<&str>,
) -> Value {
    let parse = |s: Option<&str>| s.and_then(|s| serde_json::from_str::<Value>(s).ok());
    let at = chrono::DateTime::from_timestamp_millis(recorded_at_ms)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let mut rec = json!({
        "locationSlug": slug,
        "recordedAt": at,
        "current": parse(current).unwrap_or_else(|| json!({})),
    });
    if let Some(d) = parse(daily) {
        rec["daily"] = d;
    }
    if let Some(i) = parse(insights).filter(|v| !v.is_null()) {
        rec["insights"] = i;
    }
    rec
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_locations_carry_tags_and_provinces() {
        let h = find_seed("harare").unwrap();
        assert_eq!(h.province, "Harare");
        assert!(h.tags.iter().any(|t| t == "city"));
        assert_eq!(h.province_slug.as_deref(), Some("harare-zw"));
        assert_eq!(h.source, "seed");
        assert!(tag_counts().get("city").copied().unwrap_or(0) > 10);
        assert!(stats()["totalCountries"].as_u64().unwrap() > 1);
    }

    #[test]
    fn search_ranks_exact_then_prefix_then_contains() {
        let hits = search_seed("harare", None);
        assert_eq!(hits[0].slug, "harare");
        assert!(search_seed("BULAW", None)[0].slug.starts_with("bulawayo"));
        assert!(search_seed("zzzz-nowhere", None).is_empty());
        let farming = search_seed("", Some("farming"));
        assert!(!farming.is_empty());
        assert!(farming
            .iter()
            .all(|l| l.tags.iter().any(|t| t == "farming")));
    }

    #[test]
    fn country_and_nearest_filters() {
        assert!(seed_in_country("zw")
            .iter()
            .all(|l| l.country.as_deref() == Some("ZW")));
        let near = nearest_seeds(-17.84, 31.04, 100.0, 5);
        assert_eq!(near[0].slug, "harare");
        assert!(nearest_seeds(-60.0, -120.0, 150.0, 5).is_empty());
    }

    #[test]
    fn geohash_matches_the_published_vectors() {
        assert_eq!(encode_geohash(57.64911, 10.40744, 11), "u4pruydqqvj");
        assert_eq!(encode_geohash(42.6, -5.6, 5), "ezs42");
        assert_eq!(encode_geohash(51.5074, -0.1278, 6), "gcpvj0");
        assert_eq!(encode_geohash(-33.8688, 151.2093, 6), "r3gx2f");
        assert_eq!(encode_geohash(91.0, 0.0, 7), "");
        let (lat, lon) = decode_geohash("gcpvj0").unwrap();
        assert!((lat - 51.5074).abs() < 0.01 && (lon + 0.1278).abs() < 0.01);
        assert!(decode_geohash("abc").is_none()); // a is not in the alphabet
    }

    #[test]
    fn smart_slugs_round_trip() {
        let slug = build_smart_slug("Mbare Musika", -17.8578, 31.0389);
        assert!(slug.starts_with("mbare-musika--"));
        let (name, lat, lon) = parse_spot_slug(&slug).unwrap();
        assert_eq!(name, "Mbare Musika");
        assert!((lat + 17.8578).abs() < 0.002 && (lon - 31.0389).abs() < 0.002);
        assert_eq!(
            build_smart_slug("", -17.8, 31.0).split("--").next(),
            Some("place")
        );
        assert!(parse_spot_slug("harare").is_none());
        assert!(parse_spot_slug("visionaire--osm-w890123").is_none());
        assert_eq!(LocationDoc::spot(&slug).unwrap().name, "Mbare Musika");
    }

    #[test]
    fn slugs_match_the_python_backend() {
        assert_eq!(generate_slug("Nairobi", "KE"), "nairobi-ke");
        assert_eq!(generate_slug("São Tomé", ""), "sao-tome");
        assert_eq!(
            province_slug("Mashonaland East", "ZW"),
            "mashonaland-east-zw"
        );
    }

    #[test]
    fn open_meteo_results_become_geocoded_locations() {
        let r = json!({"name": "Nairobi", "latitude": -1.28, "longitude": 36.82,
            "elevation": 1661.0, "country_code": "KE", "admin1": "Nairobi Area"});
        let l = LocationDoc::from_open_meteo(&r).unwrap();
        assert_eq!(
            (l.slug.as_str(), l.source.as_str()),
            ("nairobi-ke", "geocoded")
        );
        assert_eq!(l.country.as_deref(), Some("KE"));
        assert!(LocationDoc::from_open_meteo(&json!({"name": "x"})).is_none());
    }

    #[test]
    fn nominatim_names_prefer_the_most_specific_feature() {
        let poi = json!({"name": "Meikles Hotel", "lat": "-17.83", "lon": "31.05",
            "display_name": "Meikles Hotel, Harare",
            "address": {"city": "Harare", "state": "Harare Province", "country": "Zimbabwe",
                        "country_code": "zw", "road": "Jason Moyo Avenue"}});
        let l = LocationDoc::from_nominatim(&poi, -17.83, 31.05).unwrap();
        assert_eq!(l.name, "Meikles Hotel");
        assert_eq!(l.province, "Harare Province");
        assert_eq!(l.country.as_deref(), Some("ZW"));
        assert!(l.slug.starts_with("meikles-hotel--"));
        assert_eq!(
            l.nominatim_address.as_ref().unwrap()["road"],
            "Jason Moyo Avenue"
        );

        let road = json!({"name": "Harare", "address": {"city": "Harare", "road": "Samora Machel",
            "state": "12345", "state_district": "Central", "country": "Zimbabwe", "country_code": "zw"}});
        let l = LocationDoc::from_nominatim(&road, -17.8, 31.0).unwrap();
        assert_eq!(l.name, "Samora Machel");
        assert_eq!(l.province, "Central"); // a numeric state is rejected

        let sg = json!({"address": {"suburb": "Woodlands", "city": "Singapore",
            "state": "738099", "country": "Singapore", "country_code": "sg"}});
        let l = LocationDoc::from_nominatim(&sg, 1.43, 103.78).unwrap();
        assert_eq!(
            (l.name.as_str(), l.province.as_str()),
            ("Woodlands", "Woodlands")
        );

        assert!(LocationDoc::from_nominatim(&json!({}), 0.0, 0.0).is_none());
    }

    #[test]
    fn nyuchi_places_become_locations() {
        let doc = json!({"place": {"slug": "chimanimani-hut", "name": "Chimanimani Hut",
            "geo": {"latitude": -19.8, "longitude": 32.85},
            "address": {"addressRegion": "Manicaland", "addressCountry": "zw"}}});
        let l = LocationDoc::from_nyuchi_place(&doc).unwrap();
        assert_eq!(
            (l.slug.as_str(), l.province.as_str()),
            ("chimanimani-hut", "Manicaland")
        );
        assert_eq!(l.country.as_deref(), Some("ZW"));
        assert_eq!(l.source, "places");
    }

    #[test]
    fn history_rows_keep_the_python_shape() {
        let r = history_record(
            "harare",
            1_759_622_400_000,
            Some(r#"{"temperature_2m": 25}"#),
            Some(r#"{"date": "2025-10-05", "tempMax": 29}"#),
            None,
        );
        assert_eq!(r["locationSlug"], "harare");
        assert_eq!(r["recordedAt"], "2025-10-05T00:00:00Z");
        assert_eq!(r["current"]["temperature_2m"], 25);
        assert_eq!(r["daily"]["tempMax"], 29);
        assert!(r.get("insights").is_none());
    }
}
