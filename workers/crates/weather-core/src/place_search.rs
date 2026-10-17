//! Search, bare-name resolve and find-only decisions for `mukoko-weather-places`.
//!
//! Pure and native-testable: the Worker passes in what it fetched (seed rows
//! are compiled in; geocoder and Nominatim answers arrive as parsed hits) and
//! gets back the answer to serve. Ported from `api/py/_locations.py`
//! (`/api/py/search`, `/api/py/geo`) and from `mode=resolve` of
//! mukoko-dev/mukoko-weather#318, with the same constants. The decision
//! vectors shared with the Python tests are in
//! `tests/fixtures/places-contract.json`.
//!
//! What the Python backend answered from `places.placesGeo` is answered here
//! from the compiled seed catalogue, because a Worker reads no database and
//! the Nyuchi API does not expose `placesGeo` yet (mukoko-weather#148, ask 1).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::geo::{haversine_km, valid_coordinates};
use crate::locations::{
    build_smart_slug, location_name, normalize_admin1, seed_in_country, seed_locations,
    slugify_name, LocationDoc,
};
use crate::places::slugify;

/// Below this many catalogue matches, search adds geocoded candidates.
pub const GEOCODE_TOP_UP_BELOW: usize = 3;
/// The geocoder is asked for this many times the wanted results, because
/// area hits are dropped afterwards and must not eat a slot.
pub const GEOCODE_OVERFETCH: usize = 3;
pub const GEOCODE_MAX_COUNT: usize = 100;
/// A geocoded candidate this close to a same-named match is the same place.
pub const GEOCODE_DUPLICATE_KM: f64 = 25.0;
/// Longest accepted search query (longer is not a place name).
pub const MAX_SEARCH_QUERY_LENGTH: usize = 100;
/// Geocoder top-ups an hour per client (`search-geocode`).
pub const GEOCODE_TOP_UP_PER_IP: u32 = 120;

/// How many results to ask the geocoder for when `wanted` are wanted.
pub fn geocode_fetch_count(wanted: usize) -> usize {
    (wanted * GEOCODE_OVERFETCH)
        .max(10)
        .clamp(1, GEOCODE_MAX_COUNT)
}

/// GeoNames feature codes for areas: their coordinate is a centroid.
const AREA_FEATURE_CODES: [&str; 11] = [
    "TERR", "CONT", "OCN", "SEA", "RGN", "RGNE", "PRSH", "ADM1", "ADM2", "ADM1H", "ADM2H",
];

/// True for a geocoder hit that names an area, not a place: countries
/// (`PCL*`), territories, continents, seas, regions and first- and
/// second-order divisions. `ADM3`, `ADM4` and `ADMD` are often real towns.
pub fn is_area_feature(feature_code: &str) -> bool {
    let code = feature_code.trim().to_uppercase();
    code.starts_with("PCL") || AREA_FEATURE_CODES.contains(&code.as_str())
}

/// One Open-Meteo geocoding hit: the search result and its GeoNames feature.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GeocodeHit {
    pub doc: LocationDoc,
    pub feature_code: String,
}

impl GeocodeHit {
    /// A hit from the geocoder's `results` array; `None` when it has no name
    /// or a usable coordinate.
    pub fn from_open_meteo(r: &Value) -> Option<GeocodeHit> {
        Some(GeocodeHit {
            doc: LocationDoc::from_open_meteo(r)?,
            feature_code: r
                .get("feature_code")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        })
    }
}

/// Lower-cased, whitespace-collapsed query (the cache key).
pub fn normalise_query(q: &str) -> String {
    q.to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// ISO codes of the countries a geocoder answer named (`PCL*` hits).
pub fn country_hit_codes(hits: &[GeocodeHit]) -> Vec<String> {
    let mut codes: Vec<String> = vec![];
    for h in hits {
        let cc = h.doc.country.clone().unwrap_or_default().to_uppercase();
        if h.feature_code.to_uppercase().starts_with("PCL")
            && cc.len() == 2
            && cc.chars().all(|c| c.is_ascii_uppercase())
            && !codes.contains(&cc)
        {
            codes.push(cc);
        }
    }
    codes
}

/// A candidate that repeats an existing result: same normalised name within
/// [`GEOCODE_DUPLICATE_KM`].
pub fn duplicates_any(candidate: &LocationDoc, existing: &[LocationDoc]) -> bool {
    let name = slugify(&candidate.name);
    existing.iter().any(|e| {
        slugify(&e.name) == name
            && haversine_km(candidate.lat, candidate.lon, e.lat, e.lon) <= GEOCODE_DUPLICATE_KM
    })
}

fn collapse(name: &str) -> String {
    name.to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// The seed place with this name (case-insensitive) within `max_km` of the
/// point, nearest first: a geocoder hit for a shipped city is that city.
pub fn seed_matching(name: &str, lat: f64, lon: f64, max_km: f64) -> Option<LocationDoc> {
    let wanted = collapse(name);
    if wanted.is_empty() {
        return None;
    }
    seed_locations()
        .iter()
        .filter(|s| collapse(&s.name) == wanted)
        .map(|s| (haversine_km(lat, lon, s.lat, s.lon), s))
        .filter(|(km, _)| *km <= max_km)
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, s)| s.clone())
}

/// The closest seed place within `max_km`, with its distance (rounded to
/// 0.1 km), as `nearest_seed` in `api/py/_seed_locations.py`.
pub fn nearest_seed(lat: f64, lon: f64, max_km: f64) -> Option<LocationDoc> {
    seed_locations()
        .iter()
        .map(|s| (haversine_km(lat, lon, s.lat, s.lon), s))
        .filter(|(km, _)| *km <= max_km)
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(km, s)| {
            let mut doc = s.clone();
            doc.distance_km = Some((km * 10.0).round() / 10.0);
            doc
        })
}

/// Seed places of a country, cities first and then by name.
pub fn seed_in_country_ranked(country: &str, limit: usize) -> Vec<LocationDoc> {
    let mut rows: Vec<LocationDoc> = seed_in_country(country).into_iter().cloned().collect();
    rows.sort_by_key(|l| !l.tags.iter().any(|t| t == "city"));
    rows.truncate(limit.max(1));
    rows
}

/// The geocoded top-up of a thin catalogue answer: the places of a named
/// country (cities first), then each non-area hit, a shipped seed where one
/// matches. Returns the extra rows (at most the free slots) and the answer's
/// `source`: `places` (nothing geocoded), `geocoded` or `mixed`.
pub fn top_up(
    results: &[LocationDoc],
    hits: &[GeocodeHit],
    limit: usize,
) -> (Vec<LocationDoc>, &'static str) {
    let mut extra: Vec<LocationDoc> = vec![];
    let listed = |extra: &[LocationDoc], slug: &str| {
        results.iter().chain(extra.iter()).any(|r| r.slug == slug)
    };
    for cc in country_hit_codes(hits) {
        for loc in seed_in_country_ranked(&cc, limit) {
            if !listed(&extra, &loc.slug) {
                extra.push(loc);
            }
        }
    }
    for hit in hits.iter().filter(|h| !is_area_feature(&h.feature_code)) {
        let mut c = hit.doc.clone();
        if let Some(seed) = seed_matching(&c.name, c.lat, c.lon, GEOCODE_DUPLICATE_KM) {
            c = seed;
        }
        if listed(&extra, &c.slug) {
            continue;
        }
        let all: Vec<LocationDoc> = results.iter().chain(extra.iter()).cloned().collect();
        if !duplicates_any(&c, &all) {
            extra.push(c);
        }
    }
    extra.truncate(limit.saturating_sub(results.len()));
    let source = if extra.iter().any(|e| e.source == "geocoded") {
        if results.is_empty() {
            "geocoded"
        } else {
            "mixed"
        }
    } else {
        "places"
    };
    (extra, source)
}

// --- mode=resolve: a bare place name in a URL (PR #318) -------------------

pub const RESOLVE_GEOCODE_COUNT: usize = 10;
/// Uncached resolves an hour per client / service-wide.
pub const RESOLVE_PER_IP: u32 = 15;
pub const RESOLVE_GLOBAL: u32 = 300;
pub const RESOLVE_CACHE_TTL_S: u64 = 6 * 3600;
/// A miss is kept briefly: an empty answer can also be a geocoder hiccup.
pub const RESOLVE_MISS_TTL_S: u64 = 600;
/// The best hit must resemble the typed name.
pub const RESOLVE_MIN_SIMILARITY: f64 = 0.6;
pub const RESOLVE_MIN_LENGTH: usize = 3;
pub const RESOLVE_MAX_LENGTH: usize = 60;

/// How a `mode=resolve` request ended; the wire value is `resolve`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolveStatus {
    Ok,
    NoMatch,
    OverBudget,
    Unavailable,
}

impl ResolveStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ResolveStatus::Ok => "ok",
            ResolveStatus::NoMatch => "no_match",
            ResolveStatus::OverBudget => "over_budget",
            ResolveStatus::Unavailable => "unavailable",
        }
    }
}

/// The name to geocode for a typed `q`, or `None` when it cannot be a place
/// name (too short or long, digits only, characters outside `[a-z0-9 '-]`).
/// Such a request is a definitive `no_match` and never reaches the geocoder.
pub fn resolve_name(q: &str) -> Option<String> {
    let name = normalise_query(q).replace('-', " ");
    let squashed: String = name.chars().filter(|c| *c != ' ').collect();
    let len = name.chars().count();
    let shape_ok = squashed
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && squashed
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '\'' || c == '-');
    (!name.is_empty()
        && (RESOLVE_MIN_LENGTH..=RESOLVE_MAX_LENGTH).contains(&len)
        && shape_ok
        && !squashed.chars().all(|c| c.is_ascii_digit()))
    .then_some(name)
}

/// `difflib.SequenceMatcher(None, a, b).ratio()`: twice the characters in
/// matching blocks over the total length.
pub fn sequence_ratio(a: &str, b: &str) -> f64 {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let total = a.len() + b.len();
    if total == 0 {
        return 1.0;
    }
    let mut matched = 0usize;
    let mut stack = vec![(0usize, a.len(), 0usize, b.len())];
    while let Some((alo, ahi, blo, bhi)) = stack.pop() {
        let (i, j, k) = longest_match(&a, &b, alo, ahi, blo, bhi);
        if k > 0 {
            matched += k;
            if alo < i && blo < j {
                stack.push((alo, i, blo, j));
            }
            if i + k < ahi && j + k < bhi {
                stack.push((i + k, ahi, j + k, bhi));
            }
        }
    }
    2.0 * matched as f64 / total as f64
}

/// Longest common block in `a[alo..ahi]`, `b[blo..bhi]`; the earliest one
/// among equals (difflib's tie-break).
#[allow(clippy::needless_range_loop)]
fn longest_match(
    a: &[char],
    b: &[char],
    alo: usize,
    ahi: usize,
    blo: usize,
    bhi: usize,
) -> (usize, usize, usize) {
    let (mut best_i, mut best_j, mut best_k) = (alo, blo, 0usize);
    let mut prev = vec![0usize; bhi - blo + 1];
    for i in alo..ahi {
        let mut cur = vec![0usize; bhi - blo + 1];
        for j in blo..bhi {
            if a[i] == b[j] {
                let k = prev[j - blo] + 1;
                cur[j - blo + 1] = k;
                if k > best_k {
                    best_i = i + 1 - k;
                    best_j = j + 1 - k;
                    best_k = k;
                }
            }
        }
        prev = cur;
    }
    (best_i, best_j, best_k)
}

/// 0..1 similarity of two names after slugifying (case, accents, spacing).
pub fn name_similarity(a: &str, b: &str) -> f64 {
    let (sa, sb) = (slugify_name(a), slugify_name(b));
    if sa.is_empty() || sb.is_empty() {
        return 0.0;
    }
    sequence_ratio(&sa, &sb)
}

/// The best geocoded place for a typed name: it must resemble the name, a
/// place beats an area (an area centre still beats a 404), and a shipped seed
/// city is the same place as its hit.
pub fn pick_resolve(name: &str, hits: &[GeocodeHit]) -> Option<LocationDoc> {
    let mut usable: Vec<&GeocodeHit> = hits
        .iter()
        .filter(|h| {
            !h.doc.name.is_empty()
                && name_similarity(name, &h.doc.name) >= RESOLVE_MIN_SIMILARITY
                && valid_coordinates(h.doc.lat, h.doc.lon)
        })
        .collect();
    usable.sort_by_key(|h| is_area_feature(&h.feature_code));
    let best = usable.first()?;
    let mut cand = best.doc.clone();
    if is_area_feature(&best.feature_code) {
        cand.area = Some(true);
    } else if let Some(seed) = seed_matching(&cand.name, cand.lat, cand.lon, GEOCODE_DUPLICATE_KM) {
        cand = seed;
    }
    Some(cand)
}

// --- find-only geo --------------------------------------------------------

/// Radius of "a stored place is near" for IP-based points.
pub const FIND_ONLY_STORED_KM: f64 = 150.0;
/// A seed this close is "the same city", so one city has one URL.
pub const FIND_ONLY_SEED_KM: f64 = 50.0;
/// Find-only answers are snapped to this grid (~1.1 km) before naming.
pub const FIND_ONLY_SNAP_DEG: f64 = 0.01;
/// Reverse geocodes an hour per client / service-wide (OSM's policy).
pub const FIND_ONLY_GEOCODE_PER_IP: u32 = 30;
pub const FIND_ONLY_GEOCODE_GLOBAL: u32 = 900;
pub const FIND_ONLY_CACHE_TTL_S: u64 = 6 * 3600;
pub const FIND_ONLY_MISS_TTL_S: u64 = 600;
/// Nominatim zoom for the find-only name (city level).
pub const FIND_ONLY_ZOOM: u8 = 10;

/// The 54 African countries `places.placesGeo` holds cities for. Until the
/// Nyuchi API exposes placesGeo, a seed in one of them stands for "stored".
const STORED_COVERAGE: [&str; 54] = [
    "DZ", "AO", "BJ", "BW", "BF", "BI", "CV", "CM", "CF", "TD", "KM", "CG", "CD", "CI", "DJ", "EG",
    "GQ", "ER", "SZ", "ET", "GA", "GM", "GH", "GN", "GW", "KE", "LS", "LR", "LY", "MG", "MW", "ML",
    "MR", "MU", "MA", "MZ", "NA", "NE", "NG", "RW", "ST", "SN", "SC", "SL", "SO", "ZA", "SS", "SD",
    "TZ", "TG", "TN", "UG", "ZM", "ZW",
];

/// Snap a coordinate to the find-only grid.
pub fn snap(value: f64) -> f64 {
    let s = (value / FIND_ONLY_SNAP_DEG).round() * FIND_ONLY_SNAP_DEG;
    (s * 100.0).round() / 100.0
}

/// What find-only answers without a network call: the nearest stored place
/// within 150 km (a seed where the platform geography holds places), else the
/// nearest seed within 50 km. `None` means a named spot is needed.
pub fn find_only_known(lat: f64, lon: f64) -> Option<LocationDoc> {
    if let Some(stored) = seed_locations()
        .iter()
        .filter(|s| {
            s.country
                .as_deref()
                .is_some_and(|c| STORED_COVERAGE.contains(&c))
        })
        .map(|s| (haversine_km(lat, lon, s.lat, s.lon), s))
        .filter(|(km, _)| *km <= FIND_ONLY_STORED_KM)
        .min_by(|a, b| a.0.total_cmp(&b.0))
    {
        return Some(stored.1.clone());
    }
    nearest_seed(lat, lon, FIND_ONLY_SEED_KM)
}

/// The synthesized spot for a snapped cell from a Nominatim answer, or
/// `None` when it names nothing (an `error` body, no `address`, or the
/// placeholder `Unknown`). Nothing is stored: the slug carries the point.
pub fn spot_from_nominatim(body: &Value, cell_lat: f64, cell_lon: f64) -> Option<LocationDoc> {
    let obj = body.as_object()?;
    if obj.get("error").is_some_and(|e| !e.is_null()) {
        return None;
    }
    let address = obj.get("address").and_then(Value::as_object)?;
    if address.is_empty() {
        return None;
    }
    let a = |k: &str| address.get(k).and_then(Value::as_str).unwrap_or("");
    let country = a("country_code").to_uppercase();
    let mut name = location_name(body, address, a("country"));
    if name.trim().eq_ignore_ascii_case("unknown") {
        name.clear();
    }
    let name = name.trim().to_owned();
    let slug = if name.is_empty() {
        String::new()
    } else {
        build_smart_slug(&name, cell_lat, cell_lon)
    };
    if slug.is_empty() {
        return None;
    }
    Some(LocationDoc {
        slug,
        province: normalize_admin1(address, &country, a("country")),
        name,
        lat: cell_lat,
        lon: cell_lon,
        elevation: None,
        elevation_approximate: Some(true),
        tags: vec![],
        country: (!country.is_empty()).then_some(country),
        source: "geolocation".into(),
        synthesized: Some(true),
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const FIXTURE: &str = include_str!("../../../../tests/fixtures/places-contract.json");

    fn fixture() -> Value {
        serde_json::from_str(FIXTURE).expect("places-contract.json is valid")
    }

    fn hit(name: &str, lat: f64, lon: f64, cc: &str, code: &str) -> GeocodeHit {
        GeocodeHit::from_open_meteo(&json!({"name": name, "latitude": lat, "longitude": lon,
            "country_code": cc, "feature_code": code, "admin1": "X"}))
        .unwrap()
    }

    #[test]
    fn area_features_follow_the_shared_vectors() {
        for case in fixture()["area_features"].as_array().unwrap() {
            let code = case["code"].as_str().unwrap();
            assert_eq!(
                is_area_feature(code),
                case["area"].as_bool().unwrap(),
                "{code}"
            );
        }
    }

    #[test]
    fn fetch_counts_follow_the_shared_vectors() {
        for case in fixture()["geocode_fetch_count"].as_array().unwrap() {
            assert_eq!(
                geocode_fetch_count(case["wanted"].as_u64().unwrap() as usize),
                case["count"].as_u64().unwrap() as usize
            );
        }
    }

    #[test]
    fn similarity_matches_difflib() {
        for case in fixture()["similarity"].as_array().unwrap() {
            let (a, b) = (case["a"].as_str().unwrap(), case["b"].as_str().unwrap());
            let want = case["ratio"].as_f64().unwrap();
            assert!((sequence_ratio(a, b) - want).abs() < 1e-9, "{a} / {b}");
        }
    }

    #[test]
    fn resolve_names_follow_the_shared_vectors() {
        for case in fixture()["resolve_names"].as_array().unwrap() {
            let q = case["q"].as_str().unwrap();
            let want = case["name"].as_str();
            assert_eq!(resolve_name(q).as_deref(), want, "{q}");
        }
        assert!(resolve_name(&"a".repeat(61)).is_none());
    }

    #[test]
    fn seed_matching_and_nearest_follow_the_shared_vectors() {
        for case in fixture()["seed_matching"].as_array().unwrap() {
            let got = seed_matching(
                case["name"].as_str().unwrap(),
                case["lat"].as_f64().unwrap(),
                case["lon"].as_f64().unwrap(),
                25.0,
            );
            assert_eq!(
                got.map(|l| l.slug).as_deref(),
                case["slug"].as_str(),
                "{}",
                case["name"]
            );
        }
        for case in fixture()["nearest_seed"].as_array().unwrap() {
            let got = nearest_seed(
                case["lat"].as_f64().unwrap(),
                case["lon"].as_f64().unwrap(),
                case["max_km"].as_f64().unwrap(),
            );
            assert_eq!(got.map(|l| l.slug).as_deref(), case["slug"].as_str());
        }
    }

    #[test]
    fn find_only_order_is_stored_then_seed_then_spot() {
        // Zimbabwe: the platform geography holds places, so a seed 100 km
        // away still counts as stored (Python answered with placesGeo).
        let near_harare = find_only_known(-18.7, 31.05).unwrap();
        assert_eq!(near_harare.country.as_deref(), Some("ZW"));
        assert!(near_harare.distance_km.is_none());
        // Thailand: nothing stored, so only a seed within 50 km answers.
        let phuket = find_only_known(7.9, 98.4).unwrap();
        assert_eq!(phuket.slug, "phuket-th");
        assert!(phuket.distance_km.is_some());
        // 100 km from the nearest seed outside the geography: a spot is needed.
        assert!(find_only_known(8.9, 98.4).is_none());
        // The open ocean.
        assert!(find_only_known(-45.0, -120.0).is_none());
    }

    #[test]
    fn snapping_rounds_to_the_cell() {
        assert_eq!(snap(51.5074), 51.51);
        assert_eq!(snap(-0.1278), -0.13);
        assert_eq!(snap(7.884), 7.88);
    }

    #[test]
    fn a_named_spot_is_synthesized_not_stored() {
        let body = json!({"name": "Phuket", "address": {"city": "Phuket", "state": "Phuket",
            "country": "Thailand", "country_code": "th"}});
        let spot = spot_from_nominatim(&body, 7.88, 98.39).unwrap();
        assert_eq!(spot.name, "Phuket");
        assert!(spot.slug.starts_with("phuket--"));
        assert_eq!(spot.elevation, None);
        assert_eq!(spot.elevation_approximate, Some(true));
        assert_eq!(spot.synthesized, Some(true));
        assert_eq!(spot.source, "geolocation");
        assert_eq!(spot.country.as_deref(), Some("TH"));
        assert!(spot.tags.is_empty());
        // The wire shape: elevation is null, the flags are present.
        let wire = serde_json::to_value(&spot).unwrap();
        assert!(wire["elevation"].is_null());
        assert_eq!(wire["synthesized"], true);
        assert_eq!(wire["elevationApproximate"], true);
    }

    #[test]
    fn nominatim_answers_that_name_nothing_make_no_spot() {
        assert!(spot_from_nominatim(&json!({"error": "Unable to geocode"}), 1.0, 1.0).is_none());
        assert!(spot_from_nominatim(&json!({"name": "x"}), 1.0, 1.0).is_none());
        assert!(spot_from_nominatim(&json!({"address": {}}), 1.0, 1.0).is_none());
        let unknown = json!({"address": {"country": "Unknown", "country_code": "xx"}});
        assert!(spot_from_nominatim(&unknown, 1.0, 1.0).is_none());
    }

    #[test]
    fn top_up_drops_areas_and_offers_places_as_spots() {
        let hits = vec![
            hit("Thailand", 15.5, 101.0, "TH", "PCLI"),
            hit("Phuket Province", 7.95, 98.3, "TH", "ADM1"),
            hit("Koh Samui", 9.51, 100.0, "TH", "ISL"),
        ];
        let (extra, source) = top_up(&[], &hits, 20);
        // A country hit lists its seed places; the province is dropped.
        assert!(extra.iter().any(|l| l.slug == "phuket-th"));
        assert!(extra.iter().all(|l| l.name != "Phuket Province"));
        let samui = extra.iter().find(|l| l.name == "Koh Samui").unwrap();
        assert!(samui.slug.starts_with("koh-samui--"), "{}", samui.slug);
        assert_eq!(source, "geocoded");
    }

    #[test]
    fn top_up_prefers_the_seed_and_skips_duplicates() {
        let existing = seed_locations()
            .iter()
            .find(|l| l.slug == "harare")
            .unwrap()
            .clone();
        let hits = vec![hit("Harare", -17.83, 31.05, "ZW", "PPLC")];
        let (extra, source) = top_up(std::slice::from_ref(&existing), &hits, 5);
        assert!(extra.is_empty());
        assert_eq!(source, "places");
        // With no existing result the seed itself is offered, not a spot.
        let (extra, _) = top_up(&[], &hits, 5);
        assert_eq!(extra[0].slug, "harare");
        assert_eq!(extra[0].source, "seed");
    }

    #[test]
    fn top_up_fills_only_the_free_slots() {
        let hits = vec![
            hit("Alpha", 10.0, 10.0, "XX", "PPL"),
            hit("Beta", 20.0, 20.0, "XX", "PPL"),
            hit("Gamma", 30.0, 30.0, "XX", "PPL"),
        ];
        let have: Vec<LocationDoc> = seed_locations().iter().take(2).cloned().collect();
        let (extra, source) = top_up(&have, &hits, 3);
        assert_eq!(extra.len(), 1);
        assert_eq!(source, "mixed");
    }

    #[test]
    fn resolve_prefers_a_place_to_an_area_and_needs_a_resemblance() {
        let hits = vec![
            hit("Chiang Rai", 19.9, 99.8, "TH", "ADM1"),
            hit("Chiang Rai", 19.91, 99.83, "TH", "PPLA"),
        ];
        let best = pick_resolve("chiang rai", &hits).unwrap();
        assert!(best.area.is_none());
        assert!((best.lat - 19.91).abs() < 1e-9);
        // Only an area: still offered, flagged.
        let only_area = pick_resolve("chiang rai", &hits[..1]).unwrap();
        assert_eq!(only_area.area, Some(true));
        // Nothing alike: no match.
        assert!(pick_resolve("kariba", &[hit("Zzyzx", 1.0, 1.0, "US", "PPL")]).is_none());
        // A shipped city is its seed.
        let seed = pick_resolve("harare", &[hit("Harare", -17.83, 31.05, "ZW", "PPLC")]).unwrap();
        assert_eq!(seed.slug, "harare");
    }

    #[test]
    fn country_hits_name_their_iso_codes_once() {
        let hits = vec![
            hit("Thailand", 15.0, 101.0, "TH", "PCLI"),
            hit("Thailand", 15.0, 101.0, "TH", "PCLI"),
            hit("Bangkok", 13.7, 100.5, "TH", "PPLC"),
        ];
        assert_eq!(country_hit_codes(&hits), vec!["TH".to_string()]);
    }
}
