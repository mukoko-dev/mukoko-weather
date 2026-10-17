//! Any place on Earth renders weather: names in URLs (tracking issue #317).
//!
//! The coordinate is the identity and the name in a URL is cosmetic. This
//! module is the pure half of that rule, used by `mukoko-weather-places`
//! (the Worker fetches, this decides):
//!
//! - [`bare_query`] and [`pick_resolution`]: a bare name from a URL
//!   (`/koh-samui`) becomes the best geocoder hit, as a spot slug;
//! - [`coordinate_spot`]: a point nothing names (open water, polar ice, empty
//!   desert) becomes a spot labelled by its coordinates;
//! - [`compose_search`]: a country, region or continent query still lists the
//!   best cities, and also offers the area itself as the last results.
//!
//! Nothing here stores anything: every answer is a name and a coordinate.

use crate::geo::{haversine_km, valid_coordinates};
use crate::locations::{
    build_smart_slug, encode_geohash, nearest_seeds, seed_in_country, LocationDoc,
    GEOHASH_PRECISION,
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
pub const MIN_SIMILARITY: f64 = 0.85;
/// Score of a name whose words all appear in the other (`lake kariba` vs
/// `Kariba`): a qualifier, not a different place.
const CONTAINED_SIMILARITY: f64 = 0.9;
/// A typed name this short (after slugifying) must match EXACTLY: with so few
/// letters, one edit is a different word (`abc`/`Abu` 0.67, `home`/`hope`
/// 0.75, `blog`/`blob` 0.75).
pub const SHORT_NAME_LEN: usize = 5;

/// The similarity a hit needs for this typed name.
pub fn required_similarity(query: &str) -> f64 {
    if slugify(query).chars().count() <= SHORT_NAME_LEN {
        1.0
    } else {
        MIN_SIMILARITY
    }
}
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
/// edit-distance ratio, or 0.9 when every word of the shorter name is a word
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
        ratio.max(CONTAINED_SIMILARITY)
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
    let need = required_similarity(query);
    // The most similar hit, not the first usable one; at equal similarity a
    // place before an area, then the geocoder's own order.
    let mut best: Option<(f64, &LocationDoc)> = None;
    for h in hits.iter().filter(|h| valid_coordinates(h.lat, h.lon)) {
        let sim = name_similarity(query, &h.name);
        if sim < need {
            continue;
        }
        let better = match best {
            None => true,
            Some((bs, bh)) => {
                sim > bs + f64::EPSILON
                    || ((sim - bs).abs() <= f64::EPSILON && bh.area.is_some() && h.area.is_none())
            }
        };
        if better {
            best = Some((sim, h));
        }
    }
    let best = best?.1.clone();
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

// --- What a point answers: naming outcomes ---------------------------------

/// A seed this close to a point is "the same area" when naming is skipped
/// (budget or outage), so a skipped naming never shows a coordinate label
/// where a real place was available.
pub const SEED_NEAR_KM: f64 = 50.0;

/// What naming a point came back with.
#[derive(Debug, Clone, PartialEq)]
pub enum Naming {
    /// A name (city level for find-only, exact for GPS create).
    Named(LocationDoc),
    /// A definitive "nothing here": open water, polar ice, empty desert.
    NothingHere,
    /// Not asked or not answered: over budget, the geocoder is down or timed
    /// out, or the caller asked not to spend a lookup. NOT a statement about
    /// the point.
    Skipped,
}

/// How a spot answer came about; the JSON flags follow it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpotKind {
    /// Named by the geocoder.
    Named,
    /// Definitive nothing: `named: false`.
    NothingHere,
    /// Naming skipped: `namingSkipped: true`, and NOT `named: false`.
    NamingSkipped,
}

/// The answer for a point with no stored place near it.
#[derive(Debug, Clone, PartialEq)]
pub enum PointAnswer {
    /// A stored seed place (not a synthesized spot).
    Seed(LocationDoc),
    /// A newly named place (GPS create): the caller treats it as new.
    Created(LocationDoc),
    /// A spot that renders from its slug alone; nothing is stored.
    Spot { spot: LocationDoc, kind: SpotKind },
}

fn spot_for(lat: f64, lon: f64, naming: &Naming) -> Option<PointAnswer> {
    if let Naming::Named(doc) = naming {
        if let Some(spot) = named_cell_spot(&doc.name, &doc.province, doc.country.clone(), lat, lon)
        {
            return Some(PointAnswer::Spot {
                spot,
                kind: SpotKind::Named,
            });
        }
    }
    let kind = match naming {
        // A "name" that is empty or `Unknown` is the geocoder naming nothing.
        Naming::Named(_) | Naming::NothingHere => SpotKind::NothingHere,
        Naming::Skipped => SpotKind::NamingSkipped,
    };
    coordinate_spot(lat, lon).map(|spot| PointAnswer::Spot { spot, kind })
}

/// Find-only (an IP position, or a GPS fix before it is stored): a seed within
/// 150 km, else the point's named cell, else a coordinate spot. `None` only
/// for an invalid coordinate. A skipped naming is `NamingSkipped`, never the
/// definitive `NothingHere`.
pub fn find_only_answer(lat: f64, lon: f64, naming: &Naming) -> Option<PointAnswer> {
    if !valid_coordinates(lat, lon) {
        return None;
    }
    if let Some(seed) = nearest_seeds(lat, lon, 150.0, 1).first() {
        return Some(PointAnswer::Seed((*seed).clone()));
    }
    spot_for(lat, lon, naming)
}

/// GPS create: the exact name when there is one (a seed of the same name
/// within 1 km is that seed, not a new place); a definitive nothing is a
/// coordinate spot; a skipped naming returns a seed within [`SEED_NEAR_KM`]
/// when there is one (never a coordinate label over a real place) and else a
/// coordinate spot flagged `NamingSkipped`.
pub fn create_answer(lat: f64, lon: f64, naming: &Naming) -> Option<PointAnswer> {
    if !valid_coordinates(lat, lon) {
        return None;
    }
    match naming {
        Naming::Named(doc) => {
            let existing = nearest_seeds(lat, lon, 1.0, 1)
                .into_iter()
                .find(|s| s.name.eq_ignore_ascii_case(&doc.name));
            Some(match existing {
                Some(seed) => PointAnswer::Seed(seed.clone()),
                None => PointAnswer::Created(doc.clone()),
            })
        }
        Naming::NothingHere => spot_for(lat, lon, naming),
        Naming::Skipped => match nearest_seeds(lat, lon, SEED_NEAR_KM, 1).first() {
            Some(seed) => Some(PointAnswer::Seed((*seed).clone())),
            None => spot_for(lat, lon, naming),
        },
    }
}

// --- Search -----------------------------------------------------------------

/// Below this many catalogue matches, search tops up from the geocoder.
pub const TOP_UP_BELOW: usize = 3;
const OVERFETCH: usize = 3;
const MAX_COUNT: usize = 100;

/// How many geocoder results to ask for: area hits are not dropped any more,
/// but a country query lists its cities too, so ask for a margin.
pub fn geocode_count(wanted: usize) -> usize {
    (wanted * OVERFETCH).clamp(10, MAX_COUNT)
}

fn same_place(a: &LocationDoc, b: &LocationDoc) -> bool {
    a.slug == b.slug
        || (slugify(&a.name) == slugify(&b.name)
            && haversine_km(a.lat, a.lon, b.lat, b.lon) <= SEED_DUPLICATE_KM)
}

fn push_new(into: &mut Vec<LocationDoc>, doc: LocationDoc) {
    if !into.iter().any(|x| same_place(x, &doc)) {
        into.push(doc);
    }
}

/// The search answer: the catalogue's matches first, then (when there are
/// fewer than [`TOP_UP_BELOW`]) the best cities of any country the query
/// named, then the geocoder's places, then the areas themselves as spots at
/// their centres. So nothing a person types is a dead end, while a shipped
/// city is always its canonical slug (`phuket-th`, not a spot beside it) and
/// nothing appears twice (same slug, or same name within 25 km).
pub fn compose_search(
    catalogue: Vec<LocationDoc>,
    geocoded: &[LocationDoc],
    limit: usize,
) -> Vec<LocationDoc> {
    let mut out: Vec<LocationDoc> = Vec::new();
    for c in catalogue {
        push_new(&mut out, c);
    }
    // A country is also its best cities.
    for country in geocoded
        .iter()
        .filter(|g| g.area.as_deref() == Some("country"))
    {
        let Some(cc) = country.country.as_deref() else {
            continue;
        };
        let mut cities: Vec<&LocationDoc> = seed_in_country(cc);
        cities.sort_by_key(|l| !l.tags.iter().any(|t| t == "city"));
        for city in cities {
            push_new(&mut out, city.clone());
        }
    }
    for g in geocoded.iter().filter(|g| g.area.is_none()) {
        let doc =
            seed_matching(&g.name, g.lat, g.lon, SEED_DUPLICATE_KM).unwrap_or_else(|| g.clone());
        push_new(&mut out, doc);
    }
    // The areas come last, but a country with many seeds (Zimbabwe has 98)
    // must not push the country itself past the limit: reserve its slot.
    let mut areas: Vec<LocationDoc> = Vec::new();
    for g in geocoded.iter().filter(|g| g.area.is_some()) {
        push_new(&mut areas, g.clone());
    }
    out.truncate(limit.saturating_sub(reserve_area_slots(limit, areas.len())));
    for area in areas {
        if out.len() >= limit {
            break;
        }
        push_new(&mut out, area);
    }
    out
}

/// How many of `limit` slots the areas keep, however many places there are:
/// none for a one-result answer, one up to nine, two from ten.
pub fn reserve_area_slots(limit: usize, areas: usize) -> usize {
    if limit < 2 {
        0
    } else {
        areas.min(if limit >= 10 { 2 } else { 1 })
    }
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
        // The review's near misses: each is below the bar.
        assert!(name_similarity("abc", "Abu") < 1.0);
        assert!(name_similarity("home", "Hope") < 1.0);
        assert!(name_similarity("blog", "Blob") < 1.0);
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

    #[test]
    fn short_names_need_an_exact_match() {
        assert_eq!(required_similarity("abc"), 1.0);
        assert_eq!(required_similarity("harar"), 1.0);
        assert_eq!(required_similarity("koh samui"), MIN_SIMILARITY);
        for (q, near) in [
            ("abc", "Abu"),
            ("home", "Hope"),
            ("blog", "Blob"),
            ("news", "Nevis"),
        ] {
            let hits = [hit(near, 1.0, 2.0, "PPL", "XX")];
            assert!(
                pick_resolution(&hits, q).is_none(),
                "{q} must not become {near}"
            );
        }
        // Exact still resolves, in any case or spacing.
        let hits = [hit("Kano", 12.0, 8.5, "PPLA", "NG")];
        assert!(pick_resolution(&hits, "KANO").is_some());
    }

    #[test]
    fn the_most_similar_hit_wins_not_the_first_usable() {
        let hits = [
            hit("Samui Town", 9.0, 100.0, "PPL", "TH"),
            hit("Ko Samui", 9.5, 100.0, "PPLA", "TH"),
        ];
        let got = pick_resolution(&hits, "koh samui").unwrap();
        assert_eq!(got.name, "Ko Samui");
    }

    #[test]
    fn the_exact_name_beats_a_near_neighbour() {
        // One edit apart (0.9): edit distance alone cannot tell them apart, so
        // the highest similarity must win whatever order the geocoder used.
        let hits = [
            hit("Chiang Mai", 18.8, 98.98, "PPLA", "TH"),
            hit("Chiang Rai", 19.9, 99.8, "PPLA", "TH"),
        ];
        assert_eq!(
            pick_resolution(&hits, "chiang rai").unwrap().name,
            "Chiang Rai"
        );
    }

    fn spot_kind(a: Option<PointAnswer>) -> SpotKind {
        match a {
            Some(PointAnswer::Spot { kind, .. }) => kind,
            other => panic!("expected a spot, got {other:?}"),
        }
    }

    #[test]
    fn a_definitive_nothing_is_named_false_and_a_skip_is_not() {
        // Mid-Atlantic, no seed within 150 km.
        let (lat, lon) = (0.0, -30.0);
        assert_eq!(
            spot_kind(find_only_answer(lat, lon, &Naming::NothingHere)),
            SpotKind::NothingHere
        );
        assert_eq!(
            spot_kind(find_only_answer(lat, lon, &Naming::Skipped)),
            SpotKind::NamingSkipped
        );
        assert_eq!(
            spot_kind(create_answer(lat, lon, &Naming::NothingHere)),
            SpotKind::NothingHere
        );
        assert_eq!(
            spot_kind(create_answer(lat, lon, &Naming::Skipped)),
            SpotKind::NamingSkipped
        );
    }

    #[test]
    fn find_only_prefers_a_seed_within_150_km() {
        let a = find_only_answer(-17.83, 31.05, &Naming::Skipped);
        assert!(matches!(a, Some(PointAnswer::Seed(s)) if s.slug == "harare"));
    }

    #[test]
    fn a_skipped_create_returns_the_seed_within_50_km_never_a_label() {
        // 10 km from Harare: naming failed, but a real place is right there.
        let a = create_answer(-17.9, 31.05, &Naming::Skipped);
        assert!(matches!(a, Some(PointAnswer::Seed(s)) if s.slug == "harare"));
        // No seed within 50 km (mid-Atlantic): a skipped spot, not named:false.
        let far = create_answer(0.0, -30.0, &Naming::Skipped);
        assert_eq!(spot_kind(far), SpotKind::NamingSkipped);
    }

    #[test]
    fn a_definitive_nothing_is_not_rewritten_to_a_seed_on_create() {
        // The geocoder answered: nothing here. That is a statement about the
        // point, so it stays a coordinate spot even beside a seed.
        let a = create_answer(-17.9, 31.05, &Naming::NothingHere);
        assert_eq!(spot_kind(a), SpotKind::NothingHere);
    }

    #[test]
    fn a_named_point_is_created_or_is_the_seed_of_the_same_name() {
        let named = LocationDoc::from_nominatim(
            &serde_json::json!({"name": "Mbare Musika", "lat": "-17.8578", "lon": "31.0389",
                "address": {"suburb": "Mbare", "country": "Zimbabwe", "country_code": "zw"}}),
            -17.8578,
            31.0389,
        )
        .unwrap();
        assert!(matches!(
            create_answer(-17.8578, 31.0389, &Naming::Named(named)),
            Some(PointAnswer::Created(d)) if d.name == "Mbare Musika"
        ));
        let harare = find_seed_doc("harare");
        let a = create_answer(harare.lat, harare.lon, &Naming::Named(harare.clone()));
        assert!(matches!(a, Some(PointAnswer::Seed(s)) if s.slug == "harare"));
    }

    fn find_seed_doc(slug: &str) -> LocationDoc {
        crate::locations::find_seed(slug).unwrap().clone()
    }

    #[test]
    fn a_blank_or_unknown_name_is_nothing_here() {
        let mut named = find_seed_doc("harare");
        named.name = "Unknown".into();
        let (lat, lon) = (0.0, -30.0);
        assert_eq!(
            spot_kind(find_only_answer(lat, lon, &Naming::Named(named))),
            SpotKind::NothingHere
        );
    }

    #[test]
    fn a_named_cell_is_a_named_spot() {
        let mut named = find_seed_doc("harare");
        named.name = "Ténéré".into();
        named.province = "Agadez".into();
        let a = find_only_answer(17.0, 10.0, &Naming::Named(named));
        assert!(
            matches!(&a, Some(PointAnswer::Spot { spot, kind: SpotKind::Named })
            if spot.slug.starts_with("tenere--"))
        );
    }

    #[test]
    fn invalid_coordinates_answer_nothing() {
        assert!(find_only_answer(91.0, 0.0, &Naming::Skipped).is_none());
        assert!(create_answer(0.0, 181.0, &Naming::Skipped).is_none());
    }

    #[test]
    fn a_country_query_lists_its_cities_then_the_country_itself() {
        let thailand = hit("Thailand", 15.5, 101.0, "PCLI", "TH");
        let got = compose_search(vec![], &[thailand], 50);
        let slugs: Vec<&str> = got.iter().map(|l| l.slug.as_str()).collect();
        assert!(slugs.contains(&"bangkok-th") && slugs.contains(&"phuket-th"));
        let last = got.last().unwrap();
        assert_eq!(last.area.as_deref(), Some("country"));
        assert!(last.slug.starts_with("thailand--"));
        // Cities first: every place precedes the area.
        assert!(got[..got.len() - 1].iter().all(|l| l.area.is_none()));
        assert_eq!(slugs.iter().filter(|s| **s == "phuket-th").count(), 1);
    }

    #[test]
    fn a_region_is_offered_after_places_and_never_twice() {
        let province = hit("Phuket", 7.95, 98.35, "ADM1", "TH");
        let city = hit("Phuket", 7.89059, 98.3981, "PPLA", "TH");
        let got = compose_search(vec![], &[province, city], 20);
        // The province centre is the same name within 25 km of the seed city.
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].slug, "phuket-th");

        let krabi = hit("Krabi Province", 8.1, 98.9, "ADM1", "TH");
        let got = compose_search(vec![], &[krabi], 20);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].area.as_deref(), Some("region"));
    }

    #[test]
    fn a_continent_is_offered_as_a_spot() {
        let europe = hit("Europe", 48.7, 9.1, "CONT", "");
        let got = compose_search(vec![], &[europe], 20);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].area.as_deref(), Some("region"));
    }

    #[test]
    fn the_catalogue_stays_first_and_the_limit_holds() {
        let harare = crate::locations::find_seed("harare").unwrap().clone();
        let thailand = hit("Thailand", 15.5, 101.0, "PCLI", "TH");
        let got = compose_search(vec![harare], &[thailand], 3);
        assert_eq!(got.len(), 3);
        assert_eq!(got[0].slug, "harare");
    }

    #[test]
    fn geocode_count_has_a_floor_and_a_ceiling() {
        assert_eq!(geocode_count(1), 10);
        assert_eq!(geocode_count(20), 60);
        assert_eq!(geocode_count(50), 100);
    }

    #[test]
    fn a_country_with_many_seeds_still_shows_the_country_within_the_limit() {
        // Zimbabwe ships 98 seed places: at limit 10 the cities used to fill
        // every slot and the country itself never appeared.
        assert!(seed_in_country("ZW").len() > 50);
        let zimbabwe = hit("Zimbabwe", -19.0, 29.15, "PCLI", "ZW");
        for limit in [2usize, 5, 10, 20, 50] {
            let got = compose_search(vec![], &[zimbabwe.clone()], limit);
            assert_eq!(got.len(), limit, "limit {limit}");
            let areas = got.iter().filter(|l| l.area.is_some()).count();
            assert_eq!(areas, 1, "limit {limit} keeps the country spot");
            assert!(got.last().unwrap().area.is_some(), "and it is last");
            assert!(got[..got.len() - 1].iter().all(|l| l.area.is_none()));
        }
    }

    #[test]
    fn slots_reserved_for_areas() {
        assert_eq!(reserve_area_slots(1, 3), 0);
        assert_eq!(reserve_area_slots(5, 3), 1);
        assert_eq!(reserve_area_slots(10, 3), 2);
        assert_eq!(reserve_area_slots(10, 1), 1);
        assert_eq!(reserve_area_slots(10, 0), 0);
    }

    #[test]
    fn a_limit_of_one_stays_a_place() {
        let zimbabwe = hit("Zimbabwe", -19.0, 29.15, "PCLI", "ZW");
        let got = compose_search(vec![], &[zimbabwe], 1);
        assert_eq!(got.len(), 1);
        assert!(got[0].area.is_none());
    }
}
