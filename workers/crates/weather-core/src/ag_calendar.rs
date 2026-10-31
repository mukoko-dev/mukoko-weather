//! Agriculture calendars for a place: crop planting, growing and harvest
//! windows (ported from `api/py/_ag_calendar.py`).
//!
//! Two sources, tried in order: the GEOGLAM Crop Monitor Sub-National Crop
//! Calendars (CM4EW v1.3, Becker-Reshef et al., doi:10.5281/zenodo.15850408,
//! CC BY 4.0: 86 countries, admin-1 regions, wheat, maize, rice, sorghum,
//! millet, beans and teff, five stages as day-of-year starts), compiled in as
//! a gzip table (`data/geoglam_cm4ew_v1_3.json.gz`, built by
//! `scripts/build_geoglam_calendars.py`); and, where no calendar covers the
//! point, a growing window derived from the climate normals that **names no
//! crops** (a derived default must never be stated as a local fact).
//!
//! FAO's crop calendar is not used: FAO content is licensed for
//! non-commercial products and services only.

use std::collections::HashMap;
use std::sync::OnceLock;

use chrono::{Datelike, Duration, NaiveDate};
use serde::{Deserialize, Serialize};

use crate::ag_calendar_tables::{COUNTRY_ISO, SEASON_NAMES};
use crate::climate_normals::MonthlyNormal;

static TABLE_GZ: &[u8] = include_bytes!("../data/geoglam_cm4ew_v1_3.json.gz");

pub const GEOGLAM_SOURCE: &str = "GEOGLAM Crop Monitor Sub-National Crop Calendars (CM4EW) v1.3";
pub const GEOGLAM_LICENCE: &str = "CC-BY-4.0";
pub const GEOGLAM_ATTRIBUTION: &str = "Becker-Reshef, I., Barker, B. et al., GEOGLAM Crop Monitor Sub-National Crop Calendars, v1.3 (2025), doi:10.5281/zenodo.15850408";
pub const GEOGLAM_URL: &str = "https://doi.org/10.5281/zenodo.15850408";

/// A point outside every region outline (a border gap left by
/// simplification, or a city carved out of its province) joins the nearest
/// region of its country within this distance, measured to the bounding box.
pub const NEAREST_REGION_MAX_DEG: f64 = 0.5;

pub const GROWING_MEAN_TEMP_C: f64 = 10.0;
pub const RAINY_MONTH_MM: f64 = 60.0;
pub const DRY_MONTH_MM: f64 = 30.0;
pub const COLD_MONTH_MEAN_C: f64 = 5.0;
pub const TROPICS_LAT: f64 = 23.44;

/// Stage keys in phenological order, with their labels.
pub const STAGES: [(&str, &str); 5] = [
    ("planting", "Planting to early vegetative"),
    ("vegetative", "Vegetative to reproductive"),
    ("harvest", "Ripening through harvest"),
    ("endOfSeason", "End of harvest"),
    ("outOfSeason", "Out of season"),
];

/// The ISO codes of every GEOGLAM country.
pub fn geoglam_iso_codes() -> impl Iterator<Item = &'static str> {
    COUNTRY_ISO.iter().map(|(_, iso)| *iso)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CropStages {
    pub planting: i64,
    pub vegetative: i64,
    pub harvest: i64,
    pub end_of_season: i64,
    pub out_of_season: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CropWindow {
    pub crop: String,
    pub crop_label: String,
    pub season: Option<String>,
    pub stages: CropStages,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DerivedGrowingWindow {
    pub months: Vec<u32>,
    pub basis: String,
    pub method: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrazingNotes {
    pub dry_months: Vec<u32>,
    pub cold_months: Vec<u32>,
    pub note: Option<String>,
    pub method: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgCalendar {
    pub source: String,
    pub licence: Option<String>,
    pub attribution: Option<String>,
    pub url: Option<String>,
    /// `seed` (a published calendar) or `derived`.
    pub method: String,
    pub country: Option<String>,
    pub region: Option<String>,
    pub crops: Vec<CropWindow>,
    pub derived: Option<DerivedGrowingWindow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CropPhase {
    pub crop: String,
    pub crop_label: String,
    pub season: Option<String>,
    pub phase: String,
    pub phase_label: String,
    pub next_phase: String,
    pub next_phase_label: String,
    /// ISO date.
    pub next_phase_on: String,
}

// ---------------------------------------------------------------------------
// The compiled-in table
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct Region {
    bbox: [f64; 4],
    country: String,
    region: String,
    rings: Vec<Vec<[f64; 2]>>,
}

#[derive(Deserialize)]
struct Row {
    crop: String,
    doy: Vec<i64>,
    key: String,
}

#[derive(Deserialize)]
struct Table {
    regions: Vec<Region>,
    calendars: Vec<Row>,
}

struct Loaded {
    regions: HashMap<String, Vec<Region>>,
    calendars: HashMap<String, Vec<Row>>,
}

/// Inflate a gzip member (header flags honoured, trailer ignored).
fn gunzip(b: &[u8]) -> Option<Vec<u8>> {
    if b.len() < 18 || b[0] != 0x1f || b[1] != 0x8b || b[2] != 8 {
        return None;
    }
    let flags = b[3];
    let mut i = 10;
    if flags & 4 != 0 {
        let xlen = usize::from(u16::from_le_bytes([*b.get(i)?, *b.get(i + 1)?]));
        i += 2 + xlen;
    }
    for bit in [8, 16] {
        if flags & bit != 0 {
            i += b.get(i..)?.iter().position(|c| *c == 0)? + 1;
        }
    }
    if flags & 2 != 0 {
        i += 2;
    }
    miniz_oxide::inflate::decompress_to_vec(b.get(i..b.len() - 8)?).ok()
}

fn iso_for(country: &str) -> Option<&'static str> {
    COUNTRY_ISO
        .iter()
        .find(|(name, _)| *name == country)
        .map(|(_, iso)| *iso)
}

fn loaded() -> Option<&'static Loaded> {
    static LOADED: OnceLock<Option<Loaded>> = OnceLock::new();
    LOADED
        .get_or_init(|| {
            let table: Table = serde_json::from_slice(&gunzip(TABLE_GZ)?).ok()?;
            let mut out = Loaded {
                regions: HashMap::new(),
                calendars: HashMap::new(),
            };
            for region in table.regions {
                if let Some(iso) = iso_for(&region.country) {
                    out.regions.entry(iso.to_owned()).or_default().push(region);
                }
            }
            for row in table.calendars {
                out.calendars.entry(row.key.clone()).or_default().push(row);
            }
            Some(out)
        })
        .as_ref()
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/// Even-odd ray casting over every ring (holes included).
pub fn point_in_rings(lon: f64, lat: f64, rings: &[Vec<[f64; 2]>]) -> bool {
    let mut inside = false;
    for ring in rings {
        let n = ring.len();
        if n == 0 {
            continue;
        }
        let mut j = n - 1;
        for i in 0..n {
            let (xi, yi) = (ring[i][0], ring[i][1]);
            let (xj, yj) = (ring[j][0], ring[j][1]);
            if (yi > lat) != (yj > lat) {
                let x_cross = (xj - xi) * (lat - yi) / (yj - yi) + xi;
                if lon < x_cross {
                    inside = !inside;
                }
            }
            j = i;
        }
    }
    inside
}

fn bbox_distance(lon: f64, lat: f64, b: &[f64; 4]) -> f64 {
    let dx = (b[0] - lon).max(0.0).max(lon - b[2]);
    let dy = (b[1] - lat).max(0.0).max(lat - b[3]);
    (dx * dx + dy * dy).sqrt()
}

fn region_for(lat: f64, lon: f64, country: &str) -> Option<&'static Region> {
    let candidates = loaded()?.regions.get(&country.to_uppercase())?;
    for region in candidates {
        let b = &region.bbox;
        if b[0] <= lon
            && lon <= b[2]
            && b[1] <= lat
            && lat <= b[3]
            && point_in_rings(lon, lat, &region.rings)
        {
            return Some(region);
        }
    }
    let best = candidates.iter().min_by(|a, b| {
        bbox_distance(lon, lat, &a.bbox)
            .partial_cmp(&bbox_distance(lon, lat, &b.bbox))
            .unwrap_or(std::cmp::Ordering::Equal)
    })?;
    (bbox_distance(lon, lat, &best.bbox) <= NEAREST_REGION_MAX_DEG).then_some(best)
}

/// `"Maize 1"` splits to (`"Maize"`, `Some('1')`); a name without a trailing
/// single digit after whitespace is its own base.
fn split_crop(crop: &str) -> (&str, Option<char>) {
    let s = crop.trim();
    let mut chars = s.char_indices().rev();
    if let Some((di, d)) = chars.next() {
        if d.is_ascii_digit() {
            let before = &s[..di];
            let trimmed = before.trim_end();
            if trimmed.len() < before.len() && !trimmed.is_empty() {
                return (trimmed, Some(d));
            }
        }
    }
    (s, None)
}

/// `"Maize 1"` to (`"maize"`, `"Maize"`); `"Winter Wheat"` to
/// (`"winter-wheat"`, `"Winter wheat"`).
fn crop_ids(crop: &str) -> (String, String) {
    let (base, _) = split_crop(crop);
    let mut chars = base.chars();
    let label = match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase(),
        None => String::new(),
    };
    let mut id = String::new();
    let mut dash = false;
    for c in base.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if dash && !id.is_empty() {
                id.push('-');
            }
            dash = false;
            id.push(c);
        } else {
            dash = true;
        }
    }
    (id, label)
}

fn season_name(iso: &str, crop: &str) -> Option<&'static str> {
    SEASON_NAMES
        .iter()
        .find(|(code, _)| *code == iso)?
        .1
        .iter()
        .find(|(c, _)| *c == crop)
        .map(|(_, n)| *n)
}

fn geoglam_calendar(lat: f64, lon: f64, country: Option<&str>) -> Option<AgCalendar> {
    let iso = country.unwrap_or("").to_uppercase();
    let region = region_for(lat, lon, &iso)?;
    let key = format!("{}|{}", region.country, region.region);
    let mut rows: Vec<&Row> = loaded()?.calendars.get(&key)?.iter().collect();
    rows.sort_by(|a, b| a.crop.cmp(&b.crop));
    let mut per_crop: HashMap<String, usize> = HashMap::new();
    for row in &rows {
        *per_crop.entry(crop_ids(&row.crop).0).or_default() += 1;
    }
    let mut crops = Vec::new();
    for row in rows {
        let at = |i: usize| row.doy.get(i).copied().unwrap_or(0);
        let (p, v, h, e, o) = (at(0), at(1), at(2), at(3), at(4));
        if p == 0 || v == 0 || h == 0 || e == 0 {
            continue;
        }
        let (crop_id, label) = crop_ids(&row.crop);
        let mut season = season_name(&iso, &row.crop).map(str::to_owned);
        let number = split_crop(&row.crop).1;
        if season.is_none() && per_crop.get(&crop_id).copied().unwrap_or(0) > 1 {
            // The dataset numbers seasons by size: 1 is the largest. A lone
            // season needs no name.
            if let Some(n) = number {
                season = Some(if n == '1' {
                    "Main season".to_owned()
                } else {
                    format!("Season {n}")
                });
            }
        }
        crops.push(CropWindow {
            crop: crop_id,
            crop_label: label,
            season,
            stages: CropStages {
                planting: p,
                vegetative: v,
                harvest: h,
                end_of_season: e,
                out_of_season: (o != 0).then_some(o),
            },
        });
    }
    if crops.is_empty() {
        return None;
    }
    Some(AgCalendar {
        source: GEOGLAM_SOURCE.to_owned(),
        licence: Some(GEOGLAM_LICENCE.to_owned()),
        attribution: Some(GEOGLAM_ATTRIBUTION.to_owned()),
        url: Some(GEOGLAM_URL.to_owned()),
        method: "seed".to_owned(),
        country: Some(iso),
        region: Some(region.region.clone()),
        crops,
        derived: None,
    })
}

// ---------------------------------------------------------------------------
// Derived default
// ---------------------------------------------------------------------------

fn months_where(
    monthly: &[MonthlyNormal],
    value: fn(&MonthlyNormal) -> Option<f64>,
    test: impl Fn(f64) -> bool,
) -> Vec<u32> {
    monthly
        .iter()
        .filter(|r| value(r).is_some_and(&test))
        .map(|r| r.month)
        .collect()
}

fn precip(r: &MonthlyNormal) -> Option<f64> {
    r.precip_mm
}

fn mean_temp(r: &MonthlyNormal) -> Option<f64> {
    r.mean_temp_c
}

/// The likely growing window from the normals, or `None` without them.
pub fn derived_growing_window(lat: f64, monthly: &[MonthlyNormal]) -> Option<DerivedGrowingWindow> {
    if monthly.is_empty() {
        return None;
    }
    let (months, basis) = if lat.abs() < TROPICS_LAT {
        (
            months_where(monthly, precip, |v| v >= RAINY_MONTH_MM),
            format!("months with {RAINY_MONTH_MM:.0} mm or more of normal rainfall"),
        )
    } else {
        (
            months_where(monthly, mean_temp, |v| v >= GROWING_MEAN_TEMP_C),
            format!("months with a mean temperature of {GROWING_MEAN_TEMP_C:.0} °C or more"),
        )
    };
    Some(DerivedGrowingWindow {
        months,
        basis,
        method: "derived".to_owned(),
    })
}

/// Dry and cold months from the normals, for livestock and grazing context.
pub fn grazing_notes(monthly: &[MonthlyNormal]) -> Option<GrazingNotes> {
    if monthly.is_empty() {
        return None;
    }
    let dry = months_where(monthly, precip, |v| v < DRY_MONTH_MM);
    let cold = months_where(monthly, mean_temp, |v| v < COLD_MONTH_MEAN_C);
    let mut parts = Vec::new();
    if !dry.is_empty() && dry.len() < 12 {
        parts.push(format!(
            "normal rain under {DRY_MONTH_MM:.0} mm in {} months, when forage and surface water are usually scarcer",
            dry.len()
        ));
    }
    if !cold.is_empty() {
        parts.push(format!(
            "mean temperature under {COLD_MONTH_MEAN_C:.0} °C in {} months, with little pasture growth",
            cold.len()
        ));
    }
    Some(GrazingNotes {
        dry_months: if dry.len() < 12 { dry } else { Vec::new() },
        cold_months: cold,
        note: (!parts.is_empty()).then(|| parts.join("; ")),
        method: "derived".to_owned(),
    })
}

fn derived_calendar(
    lat: f64,
    country: Option<&str>,
    monthly: &[MonthlyNormal],
) -> Option<AgCalendar> {
    let window = derived_growing_window(lat, monthly)?;
    let iso = country.unwrap_or("").to_uppercase();
    Some(AgCalendar {
        source: "Derived from ERA5 1991–2020 climate normals".to_owned(),
        licence: Some("CC-BY-4.0".to_owned()),
        attribution: Some("Copernicus Climate Change Service ERA5, via Open-Meteo".to_owned()),
        url: Some("https://open-meteo.com/en/docs/historical-weather-api".to_owned()),
        method: "derived".to_owned(),
        country: (!iso.is_empty()).then_some(iso),
        region: None,
        crops: Vec::new(),
        derived: Some(window),
    })
}

/// The first source that knows this point wins. A published calendar also
/// carries the derived growing window when normals are available.
pub fn calendar_for(
    lat: f64,
    lon: f64,
    country: Option<&str>,
    monthly: &[MonthlyNormal],
) -> Option<AgCalendar> {
    let mut cal =
        geoglam_calendar(lat, lon, country).or_else(|| derived_calendar(lat, country, monthly))?;
    if cal.derived.is_none() {
        cal.derived = derived_growing_window(lat, monthly);
    }
    Some(cal)
}

// ---------------------------------------------------------------------------
// Current phase (computed at read time, never stored)
// ---------------------------------------------------------------------------

/// Day of year on GEOGLAM's 365-day scale (Dec 31 of a leap year is 365).
fn doy(day: NaiveDate) -> i64 {
    i64::from(day.ordinal().min(365))
}

/// The next date on or after `today` whose day of year is `doy`.
fn date_for_doy(today: NaiveDate, doy: i64) -> NaiveDate {
    for year in [today.year(), today.year() + 1] {
        let jan1 = NaiveDate::from_ymd_opt(year, 1, 1).expect("valid");
        let candidate = jan1 + Duration::days(doy - 1);
        if candidate >= today {
            return candidate;
        }
    }
    NaiveDate::from_ymd_opt(today.year() + 1, 1, 1).expect("valid") + Duration::days(doy - 1)
}

fn stage_start(stages: &CropStages, key: &str) -> Option<i64> {
    match key {
        "planting" => Some(stages.planting),
        "vegetative" => Some(stages.vegetative),
        "harvest" => Some(stages.harvest),
        "endOfSeason" => Some(stages.end_of_season),
        "outOfSeason" => stages.out_of_season,
        _ => None,
    }
    .filter(|s| *s != 0)
}

fn stage_label(key: &str) -> &'static str {
    STAGES
        .iter()
        .find(|(k, _)| *k == key)
        .map_or("", |(_, l)| *l)
}

/// The stage `today` falls in, and when the next one starts.
pub fn crop_phase(window: &CropWindow, today: NaiveDate) -> CropPhase {
    let stages: Vec<(&str, i64)> = STAGES
        .iter()
        .filter_map(|(k, _)| stage_start(&window.stages, k).map(|s| (*k, s)))
        .collect();
    let d = doy(today);
    let n = stages.len();
    let mut current = (n - 1, stages[n - 1]);
    for (i, &(key, start)) in stages.iter().enumerate() {
        let next = stages[(i + 1) % n].1;
        let raw = (next - start).rem_euclid(365);
        let span = if raw == 0 { 365 } else { raw };
        if (d - start).rem_euclid(365) < span {
            current = (i, (key, start));
            break;
        }
    }
    let (idx, (key, _)) = current;
    let (next_key, next_start) = stages[(idx + 1) % n];
    CropPhase {
        crop: window.crop.clone(),
        crop_label: window.crop_label.clone(),
        season: window.season.clone(),
        phase: key.to_owned(),
        phase_label: stage_label(key).to_owned(),
        next_phase: next_key.to_owned(),
        next_phase_label: stage_label(next_key).to_owned(),
        next_phase_on: date_for_doy(today + Duration::days(1), next_start)
            .format("%Y-%m-%d")
            .to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const FIXTURE: &str = include_str!("../../../../tests/fixtures/place-profile.json");

    fn fx() -> Value {
        serde_json::from_str(FIXTURE).unwrap()
    }

    fn monthly(v: &Value) -> Vec<MonthlyNormal> {
        v.as_array()
            .map(|a| {
                a.iter()
                    .map(|m| serde_json::from_value(m.clone()).unwrap())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn cal_json(c: &AgCalendar) -> Value {
        json!({
            "source": c.source, "licence": c.licence, "attribution": c.attribution, "url": c.url,
            "method": c.method, "country": c.country, "region": c.region,
            "crops": c.crops, "derived": c.derived,
        })
    }

    #[test]
    fn the_table_loads_and_has_every_country() {
        assert!(loaded().is_some());
        assert_eq!(geoglam_iso_codes().count(), 86);
        assert!(loaded().unwrap().regions.contains_key("ZW"));
    }

    #[test]
    fn calendars_match_python_for_every_case() {
        for c in fx()["calendars"].as_array().unwrap() {
            let got = calendar_for(
                c["lat"].as_f64().unwrap(),
                c["lon"].as_f64().unwrap(),
                c["country"].as_str(),
                &monthly(&c["monthly"]),
            );
            match (&got, &c["out"]) {
                (None, Value::Null) => {}
                (Some(g), want) => assert_eq!(&cal_json(g), want, "{}", c["name"]),
                (None, want) => panic!("{}: no calendar, wanted {want}", c["name"]),
            }
        }
    }

    #[test]
    fn grazing_notes_and_growing_windows_match_python() {
        let x = fx();
        for c in x["grazing"].as_array().unwrap() {
            let got = grazing_notes(&monthly(&c["monthly"]));
            assert_eq!(
                serde_json::to_value(&got).unwrap(),
                c["out"],
                "{}",
                c["name"]
            );
        }
        for c in x["growing"].as_array().unwrap() {
            let got = derived_growing_window(c["lat"].as_f64().unwrap(), &monthly(&c["monthly"]));
            assert_eq!(
                serde_json::to_value(&got).unwrap(),
                c["out"],
                "{}",
                c["name"]
            );
        }
        assert!(grazing_notes(&[]).is_none());
        assert!(derived_growing_window(0.0, &[]).is_none());
    }

    #[test]
    fn crop_phases_match_python_across_the_year_and_leap_days() {
        let cases = fx()["phases"].as_array().unwrap().clone();
        assert!(cases.len() > 100);
        for c in cases {
            let window: CropWindow = serde_json::from_value(c["window"].clone()).unwrap();
            let day = NaiveDate::parse_from_str(c["day"].as_str().unwrap(), "%Y-%m-%d").unwrap();
            assert_eq!(
                serde_json::to_value(crop_phase(&window, day)).unwrap(),
                c["out"],
                "{c}"
            );
        }
    }

    #[test]
    fn crop_names_split_like_the_python_regex() {
        assert_eq!(
            crop_ids("Maize 1"),
            ("maize".to_owned(), "Maize".to_owned())
        );
        assert_eq!(
            crop_ids("Winter Wheat"),
            ("winter-wheat".to_owned(), "Winter wheat".to_owned())
        );
        assert_eq!(split_crop("Rice 12"), ("Rice 12", None));
        assert_eq!(split_crop("Maize 2"), ("Maize", Some('2')));
        assert_eq!(split_crop("Maize2"), ("Maize2", None));
    }

    #[test]
    fn a_point_is_in_a_ring_by_even_odd() {
        let square = vec![vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]]];
        assert!(point_in_rings(5.0, 5.0, &square));
        assert!(!point_in_rings(15.0, 5.0, &square));
        let hole = vec![
            vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]],
            vec![[4.0, 4.0], [6.0, 4.0], [6.0, 6.0], [4.0, 6.0]],
        ];
        assert!(!point_in_rings(5.0, 5.0, &hole));
        assert!(point_in_rings(2.0, 2.0, &hole));
    }

    #[test]
    fn gunzip_honours_the_header_and_refuses_garbage() {
        assert!(gunzip(&[0u8; 20]).is_none());
        assert!(gunzip(b"short").is_none());
        assert!(gunzip(TABLE_GZ).is_some_and(|b| b.starts_with(b"{")));
    }
}
