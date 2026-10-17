//! Any place on Earth renders weather: names in URLs (tracking issue #317).
//!
//! The coordinate is the identity and the name in a URL is cosmetic. This
//! module is the pure half of that rule, used by `mukoko-weather-places`
//! (the Worker fetches, this decides):
//!
//! - [`bare_query`] and [`pick_resolution`]: a bare name from a URL
//!   (`/koh-samui`) becomes the best geocoder hit, as a spot slug;
//! - [`coordinate_spot`]: a point nothing names (open water, polar ice, empty
//!   desert) becomes a spot labelled by its coordinates.
//!
//! Nothing here stores anything: every answer is a name and a coordinate.

use crate::geo::valid_coordinates;
use crate::locations::{
    build_smart_slug, encode_geohash, nearest_seeds, LocationDoc, GEOHASH_PRECISION,
};
use crate::places::slugify;

/// `country` for a GeoNames political entity (`PCL*`), `region` for another
/// area (territory, continent, ocean, sea, region, first- and second-order
/// divisions and their historical forms, parish), `None` for a place. Lower
/// orders (`ADM3`, `ADM4`, `ADMD`) are often real towns and stay places.
pub fn area_kind(feature_code: &str) -> Option<&'static str> {
    let code = feature_code.trim().to_uppercase();
    if code.starts_with("PCL") {
        return Some("country");
    }
    matches!(
        code.as_str(),
        "TERR"
            | "CONT"
            | "OCN"
            | "SEA"
            | "RGN"
            | "RGNE"
            | "PRSH"
            | "ADM1"
            | "ADM2"
            | "ADM1H"
            | "ADM2H"
    )
    .then_some("region")
}

// --- Bare names (/koh-samui) ----------------------------------------------

/// Shortest and longest name worth a geocoder request.
pub const BARE_MIN: usize = 3;
pub const BARE_MAX: usize = 60;
/// The best hit must resemble the name that was typed: the geocoder matches
/// loosely, and `/admin` must not become a village called Adamu.
pub const MIN_SIMILARITY: f64 = 0.6;
/// A geocoder hit for a shipped city within this distance is that city.
pub const SEED_DUPLICATE_KM: f64 = 25.0;

/// The geocoder query for a URL name (`koh-samui` -> `koh samui`), or `None`
/// when it is not worth a request: outside 3..=60 characters, anything but
/// lowercase letters, digits, spaces, dashes and apostrophes, or only digits.
pub fn bare_query(raw: &str) -> Option<String> {
    let name = raw.to_lowercase().replace('-', " ");
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    let name = name.as_str();
    let compact: String = name.chars().filter(|c| *c != ' ').collect();
    let ok = (BARE_MIN..=BARE_MAX).contains(&name.chars().count())
        && compact
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '\'')
        && !compact.chars().all(|c| c.is_ascii_digit());
    ok.then(|| name.to_owned())
}

fn levenshtein(a: &[char], b: &[char]) -> usize {
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut cur = vec![i + 1];
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            cur.push((prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1));
        }
        prev = cur;
    }
    prev[b.len()]
}

/// 0..=1 similarity of two names after slugifying (case, accents, spacing):
/// edit-distance ratio, or 0.8 when every word of the shorter name is a word
/// of the longer one (`lake kariba` vs `Kariba`).
pub fn name_similarity(a: &str, b: &str) -> f64 {
    let (sa, sb) = (slugify(a), slugify(b));
    if sa.is_empty() || sb.is_empty() {
        return 0.0;
    }
    let (ca, cb): (Vec<char>, Vec<char>) = (sa.chars().collect(), sb.chars().collect());
    let ratio = 1.0 - levenshtein(&ca, &cb) as f64 / ca.len().max(cb.len()) as f64;
    let words = |s: &str| s.split('-').map(str::to_owned).collect::<Vec<_>>();
    let (wa, wb) = (words(&sa), words(&sb));
    let (short, long) = if wa.len() <= wb.len() {
        (&wa, &wb)
    } else {
        (&wb, &wa)
    };
    let contained = short.iter().all(|w| long.contains(w));
    if contained {
        ratio.max(0.8)
    } else {
        ratio
    }
}

/// The shipped seed city with this name (case-insensitive) within `max_km`
/// of the point, if any: a geocoder hit for a shipped city is that city.
pub fn seed_matching(name: &str, lat: f64, lon: f64, max_km: f64) -> Option<LocationDoc> {
    let wanted = name
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if wanted.is_empty() {
        return None;
    }
    nearest_seeds(lat, lon, max_km, usize::MAX)
        .into_iter()
        .find(|s| {
            s.name
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase()
                == wanted
        })
        .cloned()
}

/// The place a bare URL name means, from the geocoder's hits: the best hit
/// that resembles `query`, a place before an area (an area's centre still
/// beats a 404), and a shipped seed's own slug when the hit is that city.
pub fn pick_resolution(hits: &[LocationDoc], query: &str) -> Option<LocationDoc> {
    let mut usable: Vec<&LocationDoc> = hits
        .iter()
        .filter(|h| valid_coordinates(h.lat, h.lon))
        .filter(|h| name_similarity(query, &h.name) >= MIN_SIMILARITY)
        .collect();
    usable.sort_by_key(|h| h.area.is_some()); // stable: a place first
    let best = (*usable.first()?).clone();
    if best.area.is_none() {
        if let Some(seed) = seed_matching(&best.name, best.lat, best.lon, SEED_DUPLICATE_KM) {
            return Some(seed);
        }
    }
    Some(best)
}

// --- Unnamed points ---------------------------------------------------------

/// Find-only answers are snapped to this grid (about 1.1 km): the answer
/// stands for "around here", one cell has one URL and one upstream lookup, and
/// an exact position never leaves the request.
pub const SNAP_DEG: f64 = 0.01;

/// A coordinate snapped to the [`SNAP_DEG`] grid.
pub fn snap(v: f64) -> f64 {
    let r = ((v / SNAP_DEG).round() * SNAP_DEG * 100.0).round() / 100.0;
    if r == 0.0 {
        0.0
    } else {
        r
    }
}

fn coordinate_parts(lat: f64, lon: f64) -> (String, char, String, char) {
    let (la, lo) = ((lat * 100.0).round() / 100.0, (lon * 100.0).round() / 100.0);
    (
        format!("{:.2}", la.abs()),
        if la >= 0.0 { 'N' } else { 'S' },
        format!("{:.2}", lo.abs()),
        if lo >= 0.0 { 'E' } else { 'W' },
    )
}

/// Plain label for an unnamed point: `12.35°N 45.62°E`. Mirrors
/// `coordinateLabel` in `src/lib/smart-slug.ts`.
pub fn coordinate_label(lat: f64, lon: f64) -> String {
    let (la, ns, lo, ew) = coordinate_parts(lat, lon);
    format!("{la}°{ns} {lo}°{ew}")
}

/// The name half of a coordinate spot's slug: `12-35n-45-62e`. Mirrors
/// `COORDINATE_NAME_RE` in `src/lib/smart-slug.ts`.
pub fn coordinate_slug_name(lat: f64, lon: f64) -> String {
    let (la, ns, lo, ew) = coordinate_parts(lat, lon);
    format!(
        "{}{}-{}{}",
        la.replace('.', "-"),
        ns.to_ascii_lowercase(),
        lo.replace('.', "-"),
        ew.to_ascii_lowercase()
    )
}

/// A spot for a point nothing names: any valid coordinate renders weather.
/// The name is the coordinate label, the slug `{12-35n-45-62e}--{geohash}`;
/// nothing is stored. `None` only for an invalid coordinate.
pub fn coordinate_spot(lat: f64, lon: f64) -> Option<LocationDoc> {
    if !valid_coordinates(lat, lon) {
        return None;
    }
    let (la, lo) = (snap(lat), snap(lon));
    let hash = encode_geohash(la, lo, GEOHASH_PRECISION);
    if hash.is_empty() {
        return None;
    }
    Some(LocationDoc {
        slug: format!("{}--{hash}", coordinate_slug_name(la, lo)),
        name: coordinate_label(la, lo),
        province: String::new(),
        lat: la,
        lon: lo,
        elevation: 0.0,
        tags: vec![],
        country: None,
        source: "geolocation".into(),
        province_slug: None,
        nominatim_address: None,
        area: None,
    })
}

/// A named spot for the snapped cell around a point, from a city-level
/// reverse geocode's name and region. Same slug form as any smart slug.
pub fn named_cell_spot(
    name: &str,
    province: &str,
    country: Option<String>,
    lat: f64,
    lon: f64,
) -> Option<LocationDoc> {
    let name = name.trim();
    if name.is_empty() || name.eq_ignore_ascii_case("unknown") {
        return None;
    }
    let (la, lo) = (snap(lat), snap(lon));
    let slug = build_smart_slug(name, la, lo);
    if slug.is_empty() {
        return None;
    }
    Some(LocationDoc {
        slug,
        name: name.to_owned(),
        province: province.to_owned(),
        lat: la,
        lon: lo,
        elevation: 0.0,
        tags: vec![],
        country,
        source: "geolocation".into(),
        province_slug: None,
        nominatim_address: None,
        area: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn hit(name: &str, lat: f64, lon: f64, code: &str, cc: &str) -> LocationDoc {
        LocationDoc::from_open_meteo(&json!({
            "name": name, "latitude": lat, "longitude": lon,
            "country_code": cc, "feature_code": code, "admin1": "X"
        }))
        .unwrap()
    }

    #[test]
    fn area_kinds() {
        for c in ["PCLI", "pclix", "PCLD", "PCL"] {
            assert_eq!(area_kind(c), Some("country"), "{c}");
        }
        for c in [
            "TERR", "CONT", "OCN", "SEA", "RGN", "rgn", "ADM1", "ADM2", "ADM1H", "PRSH",
        ] {
            assert_eq!(area_kind(c), Some("region"), "{c}");
        }
        for c in [
            "PPL", "PPLA", "PPLC", "ISL", "AIRP", "ADM3", "ADM4", "ADMD", "",
        ] {
            assert_eq!(area_kind(c), None, "{c}");
        }
    }

    #[test]
    fn bare_queries_are_validated() {
        assert_eq!(bare_query("koh-samui").as_deref(), Some("koh samui"));
        assert_eq!(bare_query("  Chiang--Rai ").as_deref(), Some("chiang rai"));
        assert_eq!(bare_query("o'brien-bay").as_deref(), Some("o'brien bay"));
        for bad in [
            "",
            "ab",
            "12345",
            "1-2-3",
            "a/b",
            "caf\u{e9}",
            "../etc",
            &"x".repeat(61),
            "a%20b",
        ] {
            assert_eq!(bare_query(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn similarity_tolerates_spelling_and_qualifiers_but_not_strangers() {
        assert!(name_similarity("koh samui", "Ko Samui") >= MIN_SIMILARITY);
        assert!(name_similarity("lake kariba", "Kariba") >= MIN_SIMILARITY);
        assert!(name_similarity("chiang rai", "Chiang Rai") > 0.99);
        assert!(name_similarity("sandwich", "Kariba") < MIN_SIMILARITY);
        assert!(name_similarity("admin", "Adamu") < MIN_SIMILARITY);
        assert_eq!(name_similarity("", "x"), 0.0);
    }

    #[test]
    fn a_bare_name_resolves_to_a_spot_at_the_hit() {
        let hits = [hit("Ko Samui", 9.512, 100.0136, "PPLA2", "TH")];
        let got = pick_resolution(&hits, "koh samui").unwrap();
        assert!(got.slug.starts_with("ko-samui--"));
        assert_eq!((got.lat, got.lon), (9.512, 100.0136));
        assert_eq!(got.area, None);
    }

    #[test]
    fn a_dissimilar_hit_is_no_match() {
        let hits = [hit("Kariba Town", -16.5, 28.8, "PPL", "ZW")];
        assert!(pick_resolution(&hits, "sandwich").is_none());
        assert!(pick_resolution(&[], "koh samui").is_none());
    }

    #[test]
    fn a_place_beats_an_area_but_an_area_beats_nothing() {
        let area = hit("Thailand", 15.5, 101.0, "PCLI", "TH");
        let place = hit("Thailand", 9.0, 99.0, "PPL", "TH");
        let got = pick_resolution(&[area.clone(), place], "thailand").unwrap();
        assert_eq!(got.area, None);
        let got = pick_resolution(&[area], "thailand").unwrap();
        assert_eq!(got.area.as_deref(), Some("country"));
        assert!(got.slug.starts_with("thailand--"));
    }

    #[test]
    fn a_shipped_city_keeps_its_canonical_slug() {
        let hits = [hit("Phuket", 7.89, 98.4, "PPLA", "TH")];
        assert_eq!(pick_resolution(&hits, "phuket").unwrap().slug, "phuket-th");
        // The same name far away is another place.
        let far = [hit("Phuket", 40.0, -100.0, "PPL", "US")];
        assert!(pick_resolution(&far, "phuket")
            .unwrap()
            .slug
            .starts_with("phuket--"));
    }

    #[test]
    fn labels_and_slug_names_match_the_front_end() {
        for (lat, lon, label, slug) in [
            (12.3456, 45.6789, "12.35°N 45.68°E", "12-35n-45-68e"),
            (-40.0, -20.0, "40.00°S 20.00°W", "40-00s-20-00w"),
            (0.0, 0.0, "0.00°N 0.00°E", "0-00n-0-00e"),
            (-0.004, 0.004, "0.00°N 0.00°E", "0-00n-0-00e"),
            (90.0, 180.0, "90.00°N 180.00°E", "90-00n-180-00e"),
            (-90.0, -180.0, "90.00°S 180.00°W", "90-00s-180-00w"),
        ] {
            assert_eq!(coordinate_label(lat, lon), label);
            assert_eq!(coordinate_slug_name(lat, lon), slug);
        }
    }

    #[test]
    fn every_valid_coordinate_is_a_spot() {
        let s = coordinate_spot(12.3456, 45.6789).unwrap();
        assert_eq!(s.name, "12.35°N 45.68°E");
        assert!(s.slug.starts_with("12-35n-45-68e--"));
        assert_eq!((s.lat, s.lon), (12.35, 45.68));
        assert_eq!(s.source, "geolocation");
        // One cell, one slug.
        assert_eq!(
            coordinate_spot(12.3401, 45.6701).unwrap().slug,
            coordinate_spot(12.3449, 45.6749).unwrap().slug
        );
        for (lat, lon) in [
            (89.999, 179.999),
            (-89.999, -179.999),
            (0.0, 0.0),
            (-77.85, 166.67),
        ] {
            let s = coordinate_spot(lat, lon).unwrap();
            assert!(s
                .slug
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'));
            assert!(crate::locations::parse_spot_slug(&s.slug).is_some());
        }
        for (lat, lon) in [(91.0, 0.0), (0.0, 181.0), (f64::NAN, 0.0)] {
            assert!(coordinate_spot(lat, lon).is_none());
        }
    }

    #[test]
    fn a_named_cell_spot_needs_a_real_name() {
        let s = named_cell_spot("Ténéré", "Agadez", Some("NE".into()), 17.0, 10.0).unwrap();
        assert!(s.slug.starts_with("tenere--"));
        assert!(named_cell_spot("  ", "", None, 1.0, 1.0).is_none());
        assert!(named_cell_spot("Unknown", "", None, 1.0, 1.0).is_none());
    }

    #[test]
    fn snapping_is_stable() {
        assert_eq!(snap(12.3449), 12.34);
        assert_eq!(snap(-0.004), 0.0);
        assert_eq!(snap(179.996), 180.0);
    }
}
