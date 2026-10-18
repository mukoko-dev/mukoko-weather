//! Place knowledge: what we know about a place that changes slowly, and what
//! is true of it today (ported from `api/py/_place_knowledge.py`;
//! mukoko-dev/mukoko-weather#277). Pure: the Worker fetches the normals, the
//! soil and the country's season rows, this builds the profile.
//!
//! Stored per place (each group with a provenance entry): static facts,
//! `climate` (twelve monthly ERA5 normals and a Köppen–Geiger class derived
//! from them), `seasons` (the local calendar, or a derived default),
//! `agriculture` (GEOGLAM crop windows, or a derived growing window that names
//! no crops, plus grazing notes) and `soil` (SoilGrids WRB class and texture).
//! Never stored, always computed at read time ([`compute_current`]): the
//! current and next season, each crop's phase, the moon, ENSO, day length and
//! its trend.
//!
//! The Workers have no `places.placeKnowledge` collection to write (the
//! Mongo client is read-only, and the collection does not exist yet), so a
//! profile is built from cached normals and soil on every read, exactly as the
//! Python did while the collection was missing. The JSON is pinned to the
//! Python by `tests/fixtures/place-profile.json`.

use std::collections::HashSet;

use chrono::{DateTime, Datelike, Duration, NaiveDate, SecondsFormat, Utc};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;

use crate::ag_calendar::{
    self as ag, AgCalendar, CropPhase, CropWindow, DerivedGrowingWindow, GrazingNotes,
};
use crate::locations::encode_geohash;
use crate::normals::{round_to, MonthlyNormal, NORMALS_PERIOD, NORMALS_SOURCE};

pub const SCHEMA_VERSION: &str = "v3.2";
/// Geohash length of `regionCell` (~4.9 km): nearby spots share region facts.
pub const REGION_CELL_PRECISION: usize = 5;
/// A coordinate within this distance of a known place uses that place.
pub const NEAREST_PLACE_KM: f64 = 3.0;
const RETRY_DAYS: i64 = 1;
const AI_SEASONS_REFRESH_DAYS: i64 = 7;
/// Within this many degrees of the equator the dry-summer test is skipped.
pub const EQUATORIAL_BAND_DEG: f64 = 10.0;

pub const SOILGRIDS_URL: &str = "https://rest.isric.org/soilgrids/v2.0";

const MOON_NAMES: [&str; 8] = [
    "new moon",
    "waxing crescent",
    "first quarter",
    "waxing gibbous",
    "full moon",
    "waning gibbous",
    "last quarter",
    "waning crescent",
];

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

pub fn koppen_label(code: &str) -> String {
    match code {
        "Af" => "tropical rainforest",
        "Am" => "tropical monsoon",
        "Aw" => "tropical savanna",
        "BWh" => "hot desert",
        "BWk" => "cold desert",
        "BSh" => "hot semi-arid",
        "BSk" => "cold semi-arid",
        "Csa" => "Mediterranean, hot summer",
        "Csb" => "Mediterranean, warm summer",
        "Csc" => "Mediterranean, cold summer",
        "Cwa" => "humid subtropical, dry winter",
        "Cwb" => "subtropical highland, dry winter",
        "Cwc" => "subtropical highland, cold summer, dry winter",
        "Cfa" => "humid subtropical",
        "Cfb" => "temperate oceanic",
        "Cfc" => "subpolar oceanic",
        "Dsa" => "continental, hot dry summer",
        "Dsb" => "continental, warm dry summer",
        "Dsc" => "subarctic, dry summer",
        "Dsd" => "subarctic, very cold winter, dry summer",
        "Dwa" => "continental, hot summer, dry winter",
        "Dwb" => "continental, warm summer, dry winter",
        "Dwc" => "subarctic, dry winter",
        "Dwd" => "subarctic, very cold winter, dry winter",
        "Dfa" => "continental, hot summer",
        "Dfb" => "continental, warm summer",
        "Dfc" => "subarctic",
        "Dfd" => "subarctic, very cold winter",
        "ET" => "tundra",
        "EF" => "ice cap",
        other => other,
    }
    .to_owned()
}

// ---------------------------------------------------------------------------
// Response models (schema.org Place with additionalProperty facts)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvenanceEntry {
    pub field: String,
    pub source: String,
    pub licence: Option<String>,
    pub attribution: Option<String>,
    pub url: Option<String>,
    /// `observed`, `modelled`, `derived`, `seed` or `ai`.
    pub method: String,
    pub retrieved_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Koppen {
    pub code: String,
    pub label: String,
    pub method: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Normals {
    pub period: String,
    pub cell: Option<String>,
    pub monthly: Vec<MonthlyNormal>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Climate {
    pub koppen: Option<Koppen>,
    pub normals: Option<Normals>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeasonDef {
    pub name: String,
    pub local_name: Option<String>,
    pub months: Vec<u32>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Seasons {
    pub calendar: Vec<SeasonDef>,
    pub verified: bool,
    /// `seed`, `ai` or `derived`.
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarRef {
    pub source: String,
    pub country: Option<String>,
    pub region: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agriculture {
    pub calendar_ref: Option<CalendarRef>,
    pub crops: Vec<CropWindow>,
    pub derived: Option<DerivedGrowingWindow>,
    pub grazing: Option<GrazingNotes>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Soil {
    pub wrb_class: Option<String>,
    pub wrb_probability: Option<i64>,
    pub texture: Option<String>,
    pub clay_pct: Option<f64>,
    pub sand_pct: Option<f64>,
    pub silt_pct: Option<f64>,
    pub depth: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeasonNow {
    pub name: String,
    pub local_name: Option<String>,
    pub description: Option<String>,
    pub verified: bool,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NextSeason {
    pub name: String,
    pub local_name: Option<String>,
    /// ISO date, the first day of its first month.
    pub starts_on: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Astronomy {
    pub day_length_hours: f64,
    pub day_length_change_minutes7d: f64,
    /// `lengthening`, `shortening` or `steady`.
    pub trend: String,
    pub sunrise: Option<String>,
    pub sunset: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MoonNow {
    pub phase: i64,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EnsoNow {
    pub phase: String,
    pub strength: Option<String>,
    pub oni: Option<f64>,
    pub season: Option<String>,
    pub source: String,
}

impl EnsoNow {
    pub fn new(
        phase: &str,
        strength: Option<&str>,
        oni: Option<f64>,
        season: Option<&str>,
    ) -> Self {
        EnsoNow {
            phase: phase.to_owned(),
            strength: strength.map(str::to_owned),
            oni,
            season: season.map(str::to_owned),
            source: "NOAA CPC ONI".to_owned(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentContext {
    pub date: String,
    pub month: u32,
    pub season: Option<SeasonNow>,
    pub next_season: Option<NextSeason>,
    pub normals_this_month: Option<MonthlyNormal>,
    pub crop_phases: Vec<CropPhase>,
    pub in_derived_growing_window: Option<bool>,
    pub moon: MoonNow,
    pub enso: Option<EnsoNow>,
    pub astronomy: Option<Astronomy>,
}

/// A crop's stage-to-months map, in the order plant, grow, harvest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CropCalendar {
    pub plant: Vec<u32>,
    pub grow: Vec<u32>,
    pub harvest: Vec<u32>,
}

/// One crop in the flat consumer view: `id` is a mukoko activity id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CropView {
    pub id: String,
    pub label: String,
    pub season: Option<String>,
    pub phase: Option<String>,
    pub calendar: CropCalendar,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NormalsView {
    pub high: Option<f64>,
    pub low: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EnsoView {
    pub phase: String,
    pub oni: Option<f64>,
}

/// `refreshAfter`: a JSON object that keeps its keys in the order they were
/// added.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct RefreshAfter(pub Vec<(String, String)>);

impl Serialize for RefreshAfter {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut m = s.serialize_map(Some(self.0.len()))?;
        for (k, v) in &self.0 {
            m.serialize_entry(k, v)?;
        }
        m.end()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationProfile {
    pub place_id: Option<String>,
    pub place_collection: Option<String>,
    pub slug: Option<String>,
    pub name: Option<String>,
    pub lat: f64,
    pub lon: f64,
    pub country_code: Option<String>,
    pub admin1: Option<String>,
    pub elevation_meters: Option<f64>,
    pub hemisphere: String,
    pub time_zone: Option<String>,
    pub region_cell: String,
    pub climate: Climate,
    pub seasons: Option<Seasons>,
    pub agriculture: Option<Agriculture>,
    pub soil: Option<Soil>,
    pub provenance: Vec<ProvenanceEntry>,
    pub refresh_after: RefreshAfter,
    pub stored: bool,
    pub built_at: Option<String>,
    pub complete: bool,
    pub current: Option<CurrentContext>,
    // The flat consumer view of `current` and the stored groups, filled by
    // `apply_consumer_view`: what the agriculture code reads.
    pub season: Option<SeasonNow>,
    pub crops: Vec<CropView>,
    pub normals: Option<NormalsView>,
    pub koppen: Option<String>,
    pub enso: Option<EnsoView>,
}

// ---------------------------------------------------------------------------
// Climate: Köppen–Geiger from monthly normals
// ---------------------------------------------------------------------------

/// Köppen–Geiger class from twelve monthly normals, with the definitions of
/// Beck et al. (2018, Table 1; after Peel et al. 2007): 0 °C between C and D,
/// and summer = Apr–Sep in the north, Oct–Mar in the south. When a climate
/// meets both the dry-summer and dry-winter tests the drier half wins. One
/// deliberate exception: within [`EQUATORIAL_BAND_DEG`] of the equator the
/// dry-summer test is not applied, because the north/south half-year split is
/// arbitrary there. `None` unless every month has a mean temperature and
/// rainfall.
pub fn derive_koppen(monthly: &[MonthlyNormal], lat: f64) -> Option<String> {
    if monthly.len() != 12 {
        return None;
    }
    let mut rows: Vec<&MonthlyNormal> = monthly.iter().collect();
    rows.sort_by_key(|r| r.month);
    let t: Option<Vec<f64>> = rows.iter().map(|r| r.mean_temp_c).collect();
    let p: Option<Vec<f64>> = rows.iter().map(|r| r.precip_mm).collect();
    let (t, p) = (t?, p?);
    let summer: Vec<usize> = if lat >= 0.0 {
        (3..9).collect()
    } else {
        vec![9, 10, 11, 0, 1, 2]
    };
    let winter: Vec<usize> = (0..12).filter(|i| !summer.contains(i)).collect();
    let mat = t.iter().sum::<f64>() / 12.0;
    let map = p.iter().sum::<f64>();
    let t_cold = t.iter().copied().fold(f64::INFINITY, f64::min);
    let t_hot = t.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let t_mon10 = t.iter().filter(|v| **v > 10.0).count();
    let p_dry = p.iter().copied().fold(f64::INFINITY, f64::min);
    let ps: f64 = summer.iter().map(|i| p[*i]).sum();
    let pw: f64 = winter.iter().map(|i| p[*i]).sum();
    let min_of = |idx: &[usize]| idx.iter().map(|i| p[*i]).fold(f64::INFINITY, f64::min);
    let max_of = |idx: &[usize]| idx.iter().map(|i| p[*i]).fold(f64::NEG_INFINITY, f64::max);
    let (p_sdry, p_swet) = (min_of(&summer), max_of(&summer));
    let (p_wdry, p_wwet) = (min_of(&winter), max_of(&winter));

    let p_th = if pw >= 0.7 * map {
        2.0 * mat
    } else if ps >= 0.7 * map {
        2.0 * mat + 28.0
    } else {
        2.0 * mat + 14.0
    };

    if t_hot < 10.0 {
        return Some(if t_hot < 0.0 { "EF" } else { "ET" }.to_owned());
    }
    if map < 10.0 * p_th {
        let first = if map < 5.0 * p_th { "BW" } else { "BS" };
        return Some(format!("{first}{}", if mat >= 18.0 { "h" } else { "k" }));
    }
    if t_cold >= 18.0 {
        return Some(
            if p_dry >= 60.0 {
                "Af"
            } else if p_dry >= 100.0 - map / 25.0 {
                "Am"
            } else {
                "Aw"
            }
            .to_owned(),
        );
    }
    let mut dry_summer = p_sdry < 40.0 && p_sdry < p_wwet / 3.0;
    // Near the equator the northern/southern half-year split is arbitrary: a
    // place like Nairobi would otherwise read as dry-summer.
    if lat.abs() < EQUATORIAL_BAND_DEG {
        dry_summer = false;
    }
    let dry_winter = p_wdry < p_swet / 10.0;
    let second = if dry_summer && dry_winter {
        if ps < pw {
            "s"
        } else {
            "w"
        }
    } else if dry_summer {
        "s"
    } else if dry_winter {
        "w"
    } else {
        "f"
    };
    let group = if t_cold > 0.0 { "C" } else { "D" };
    let third = if t_hot >= 22.0 {
        "a"
    } else if t_mon10 >= 4 {
        "b"
    } else if group == "D" && t_cold < -38.0 {
        "d"
    } else {
        "c"
    };
    Some(format!("{group}{second}{third}"))
}

// ---------------------------------------------------------------------------
// Seasons
// ---------------------------------------------------------------------------

/// One row of the season calendar, as `weather.seasons` (or the compiled seed)
/// holds it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeasonRow {
    #[serde(default)]
    pub country_code: String,
    #[serde(default)]
    pub name: String,
    pub local_name: Option<String>,
    #[serde(default)]
    pub months: Vec<i64>,
    pub description: Option<String>,
    pub source: Option<String>,
    pub verified: Option<bool>,
}

static SEASONS_JSON: &str = include_str!("../data/seasons.json");

/// The compiled-in season rows of one country (the `weather.seasons` seed,
/// regenerated by `workers/scripts/gen-seasons.mjs`).
pub fn seed_season_rows(country: &str) -> Vec<SeasonRow> {
    static ALL: std::sync::OnceLock<Vec<SeasonRow>> = std::sync::OnceLock::new();
    let all = ALL.get_or_init(|| {
        serde_json::from_str(SEASONS_JSON).expect("seasons.json is valid (checked in CI)")
    });
    let code = country.to_uppercase();
    all.iter()
        .filter(|r| r.country_code == code)
        .cloned()
        .collect()
}

/// Is `iso` a country the season seed covers?
pub fn season_seed_has(iso: &str) -> bool {
    !seed_season_rows(iso).is_empty()
}

/// The first month of a (possibly year-wrapping) season.
pub fn season_start_month(months: &[u32]) -> u32 {
    let set: HashSet<u32> = months.iter().copied().collect();
    let mut sorted: Vec<u32> = set.iter().copied().collect();
    sorted.sort_unstable();
    for m in &sorted {
        if !set.contains(&((m + 10) % 12 + 1)) {
            return *m;
        }
    }
    sorted.first().copied().unwrap_or(1)
}

/// The country's calendar from its season rows (seed or AI).
pub fn seasons_from_rows(rows: &[SeasonRow]) -> Option<Seasons> {
    if rows.is_empty() {
        return None;
    }
    let ai_made = rows
        .iter()
        .any(|d| d.source.as_deref() == Some("ai") || d.verified == Some(false));
    let mut calendar: Vec<SeasonDef> = rows
        .iter()
        .filter(|d| !d.name.is_empty())
        .map(|d| SeasonDef {
            name: d.name.clone(),
            local_name: d
                .local_name
                .clone()
                .filter(|l| !l.is_empty())
                .or_else(|| Some(d.name.clone())),
            months: d
                .months
                .iter()
                .filter(|m| (1..=12).contains(*m))
                .map(|m| *m as u32)
                .collect(),
            description: d.description.clone().filter(|s| !s.is_empty()),
        })
        .filter(|s| !s.months.is_empty())
        .collect();
    if calendar.is_empty() {
        return None;
    }
    calendar.sort_by_key(|s| season_start_month(&s.months));
    Some(Seasons {
        calendar,
        verified: !ai_made,
        source: if ai_made { "ai" } else { "seed" }.to_owned(),
    })
}

/// Runs of equal flags over a circular year, as 1-based month lists.
pub fn contiguous_runs(flags: &[bool]) -> Vec<Vec<u32>> {
    if flags.iter().all(|f| *f) || !flags.iter().any(|f| *f) {
        return vec![(1..=12).collect()];
    }
    let start = (0..12)
        .find(|i| flags[*i] != flags[(*i + 11) % 12])
        .expect("mixed flags have a boundary");
    let mut runs = Vec::new();
    let mut current = vec![start as u32 + 1];
    for k in 1..12 {
        let i = (start + k) % 12;
        if flags[i] == flags[(i + 11) % 12] {
            current.push(i as u32 + 1);
        } else {
            runs.push(current);
            current = vec![i as u32 + 1];
        }
    }
    runs.push(current);
    runs
}

fn sorted_rows(monthly: &[MonthlyNormal]) -> Vec<&MonthlyNormal> {
    let mut rows: Vec<&MonthlyNormal> = monthly.iter().collect();
    rows.sort_by_key(|r| r.month);
    rows
}

/// A default calendar where no local one exists: inside the tropics wet and
/// dry seasons from the normals (60 mm a month), elsewhere the meteorological
/// seasons of the hemisphere. Always unverified.
pub fn derived_seasons(lat: f64, monthly: &[MonthlyNormal]) -> Seasons {
    if lat.abs() < ag::TROPICS_LAT && monthly.len() == 12 {
        let rows = sorted_rows(monthly);
        let wet: Vec<bool> = rows
            .iter()
            .map(|r| r.precip_mm.unwrap_or(0.0) >= ag::RAINY_MONTH_MM)
            .collect();
        let calendar: Vec<SeasonDef> = contiguous_runs(&wet)
            .into_iter()
            .map(|run| {
                let is_wet = wet[run[0] as usize - 1];
                SeasonDef {
                    name: if is_wet { "Wet season" } else { "Dry season" }.to_owned(),
                    local_name: None,
                    months: run,
                    description: Some(if is_wet {
                        format!(
                            "Normal rainfall {:.0} mm or more a month",
                            ag::RAINY_MONTH_MM
                        )
                    } else {
                        format!("Normal rainfall under {:.0} mm a month", ag::RAINY_MONTH_MM)
                    }),
                }
            })
            .collect();
        if calendar.len() > 1 || calendar[0].name == "Wet season" {
            return Seasons {
                calendar,
                verified: false,
                source: "derived".to_owned(),
            };
        }
    }
    let quarters: [(&str, [u32; 3]); 4] = if lat >= 0.0 {
        [
            ("Winter", [12, 1, 2]),
            ("Spring", [3, 4, 5]),
            ("Summer", [6, 7, 8]),
            ("Autumn", [9, 10, 11]),
        ]
    } else {
        [
            ("Summer", [12, 1, 2]),
            ("Autumn", [3, 4, 5]),
            ("Winter", [6, 7, 8]),
            ("Spring", [9, 10, 11]),
        ]
    };
    Seasons {
        calendar: quarters
            .iter()
            .map(|(n, m)| SeasonDef {
                name: (*n).to_owned(),
                local_name: None,
                months: m.to_vec(),
                description: Some("Meteorological season".to_owned()),
            })
            .collect(),
        verified: false,
        source: "derived".to_owned(),
    }
}

fn ymd(year: i32, month: u32, day: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(year, month, day).expect("valid date")
}

pub fn season_now(
    seasons: Option<&Seasons>,
    today: NaiveDate,
) -> (Option<SeasonNow>, Option<NextSeason>) {
    let Some(seasons) = seasons.filter(|s| !s.calendar.is_empty()) else {
        return (None, None);
    };
    let month = today.month();
    let Some(current) = seasons.calendar.iter().find(|s| s.months.contains(&month)) else {
        return (None, None);
    };
    let now = SeasonNow {
        name: current.name.clone(),
        local_name: current.local_name.clone(),
        description: current.description.clone(),
        verified: seasons.verified,
        source: seasons.source.clone(),
    };
    let mut next = None;
    for k in 1..=12_u32 {
        let m = (month - 1 + k) % 12 + 1;
        if current.months.contains(&m) {
            continue;
        }
        if let Some(cand) = seasons.calendar.iter().find(|s| s.months.contains(&m)) {
            if cand.name != current.name {
                let year = today.year() + i32::from(m <= month);
                next = Some(NextSeason {
                    name: cand.name.clone(),
                    local_name: cand.local_name.clone(),
                    starts_on: ymd(year, m, 1).format("%Y-%m-%d").to_string(),
                });
                break;
            }
        }
    }
    (Some(now), next)
}

// ---------------------------------------------------------------------------
// Astronomy (computed; no network)
// ---------------------------------------------------------------------------

fn declination_rad(day: NaiveDate) -> f64 {
    23.44_f64.to_radians()
        * (2.0 * std::f64::consts::PI * (284.0 + f64::from(day.ordinal())) / 365.0).sin()
}

/// Sunrise-to-sunset hours with standard refraction (−0.833°).
pub fn day_length_hours(lat: f64, day: NaiveDate) -> f64 {
    let phi = lat.clamp(-89.9, 89.9).to_radians();
    let dec = declination_rad(day);
    let cos_h = ((-0.833_f64).to_radians().sin() - phi.sin() * dec.sin()) / (phi.cos() * dec.cos());
    if cos_h <= -1.0 {
        24.0
    } else if cos_h >= 1.0 {
        0.0
    } else {
        round_to(2.0 * cos_h.acos().to_degrees() / 15.0, 2)
    }
}

fn equation_of_time_min(day: NaiveDate) -> f64 {
    let b = 2.0 * std::f64::consts::PI * (f64::from(day.ordinal()) - 81.0) / 364.0;
    9.87 * (2.0 * b).sin() - 7.53 * b.cos() - 1.5 * b.sin()
}

fn hhmm(minutes: f64) -> String {
    let m = (minutes.round_ties_even() as i64).rem_euclid(1440);
    format!("{:02}:{:02}", m / 60, m % 60)
}

pub fn astronomy(lat: f64, lon: f64, day: NaiveDate, utc_offset_s: Option<i64>) -> Astronomy {
    let length = day_length_hours(lat, day);
    let before = day_length_hours(lat, day - Duration::days(7));
    let change = round_to((length - before) * 60.0, 1);
    let trend = if change.abs() < 1.0 {
        "steady"
    } else if change > 0.0 {
        "lengthening"
    } else {
        "shortening"
    };
    let (mut sunrise, mut sunset) = (None, None);
    if let Some(offset) = utc_offset_s {
        if length > 0.0 && length < 24.0 {
            let noon_utc_min = 720.0 - 4.0 * lon - equation_of_time_min(day);
            let half = length * 30.0;
            let offset_min = offset as f64 / 60.0;
            sunrise = Some(hhmm(noon_utc_min - half + offset_min));
            sunset = Some(hhmm(noon_utc_min + half + offset_min));
        }
    }
    Astronomy {
        day_length_hours: length,
        day_length_change_minutes7d: change,
        trend: trend.to_owned(),
        sunrise,
        sunset,
    }
}

const SYNODIC_DAYS: f64 = 29.530_588_853;

/// Moon phase on Tomorrow.io's 0–7 scale (0 new … 4 full … 7 waning crescent).
pub fn moon_phase(when: DateTime<Utc>) -> i64 {
    // The reference new moon: 2000-01-06 18:14 UTC.
    let reference = ymd(2000, 1, 6)
        .and_hms_opt(18, 14, 0)
        .expect("valid")
        .and_utc();
    let secs = (when - reference).num_milliseconds() as f64 / 1000.0;
    let age = (secs / 86_400.0).rem_euclid(SYNODIC_DAYS);
    ((age / SYNODIC_DAYS * 8.0).round_ties_even() as i64).rem_euclid(8)
}

// ---------------------------------------------------------------------------
// Soil (SoilGrids 2.0)
// ---------------------------------------------------------------------------

/// USDA soil-texture triangle (NRCS) from percentages.
pub fn texture_class(s: f64, si: f64, c: f64) -> &'static str {
    if si + 1.5 * c < 15.0 {
        "sand"
    } else if si + 1.5 * c >= 15.0 && si + 2.0 * c < 30.0 {
        "loamy sand"
    } else if ((7.0..20.0).contains(&c) && s > 52.0 && si + 2.0 * c >= 30.0)
        || (c < 7.0 && si < 50.0 && si + 2.0 * c >= 30.0)
    {
        "sandy loam"
    } else if (7.0..27.0).contains(&c) && (28.0..50.0).contains(&si) && s <= 52.0 {
        "loam"
    } else if (si >= 50.0 && (12.0..27.0).contains(&c)) || ((50.0..80.0).contains(&si) && c < 12.0)
    {
        "silt loam"
    } else if si >= 80.0 && c < 12.0 {
        "silt"
    } else if (20.0..35.0).contains(&c) && si < 28.0 && s > 45.0 {
        "sandy clay loam"
    } else if (27.0..40.0).contains(&c) && 20.0 < s && s <= 45.0 {
        "clay loam"
    } else if (27.0..40.0).contains(&c) && s <= 20.0 {
        "silty clay loam"
    } else if c >= 35.0 && s > 45.0 {
        "sandy clay"
    } else if c >= 40.0 && si >= 40.0 {
        "silty clay"
    } else {
        "clay"
    }
}

/// The classification request for a point.
pub fn soil_classification_url(lat: f64, lon: f64) -> String {
    format!("{SOILGRIDS_URL}/classification/query?lon={lon:.4}&lat={lat:.4}&number_classes=1")
}

/// The properties request for a point (clay, sand, silt over 0–30 cm).
pub fn soil_properties_url(lat: f64, lon: f64) -> String {
    format!(
        "{SOILGRIDS_URL}/properties/query?lon={lon:.4}&lat={lat:.4}&property=clay&property=sand&property=silt&depth=0-5cm&depth=5-15cm&depth=15-30cm&value=mean"
    )
}

/// A real number, never a bool, a string or null.
fn number(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
}

/// A SoilGrids payload whose shape is not understood.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SoilAnomaly;

/// The soil from the two SoilGrids answers, or `None` when neither a class nor
/// a texture could be read. `Err` for a payload whose shape is not understood
/// (an anomaly, retried tomorrow rather than waiting a year).
pub fn parse_soil(c: &Value, p: &Value) -> Result<Option<Soil>, SoilAnomaly> {
    let mut soil = Soil {
        wrb_class: c
            .get("wrb_class_name")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
        ..Soil::default()
    };
    if let Some(probs) = c.get("wrb_class_probability").and_then(Value::as_array) {
        if let Some(first) = probs.first().and_then(Value::as_array) {
            if let Some(prob) = number(first.get(1)).filter(|v| v.is_finite()) {
                soil.wrb_probability = Some(prob as i64);
            }
        }
    }
    let weights = [("0-5cm", 5.0), ("5-15cm", 10.0), ("15-30cm", 15.0)];
    let mut fractions: Vec<(String, f64)> = Vec::new();
    let layers = match p.get("properties").and_then(|v| v.get("layers")) {
        Some(Value::Array(a)) => a.as_slice(),
        Some(Value::Null) | None => &[],
        Some(_) => return Err(SoilAnomaly),
    };
    for layer in layers {
        let layer = layer.as_object().ok_or(SoilAnomaly)?;
        let factor = number(layer.get("unit_measure").and_then(|u| u.get("d_factor")))
            .filter(|f| *f != 0.0)
            .unwrap_or(10.0);
        let (mut total, mut wsum) = (0.0, 0.0);
        let depths = match layer.get("depths") {
            Some(Value::Array(a)) => a.as_slice(),
            Some(Value::Null) | None => &[],
            Some(_) => return Err(SoilAnomaly),
        };
        for depth in depths {
            let depth = depth.as_object().ok_or(SoilAnomaly)?;
            let value = number(depth.get("values").and_then(|v| v.get("mean")));
            let w = depth
                .get("label")
                .and_then(Value::as_str)
                .and_then(|l| weights.iter().find(|(k, _)| *k == l))
                .map(|(_, w)| *w);
            if let (Some(value), Some(w)) = (value, w) {
                total += value / factor * w;
                wsum += w;
            }
        }
        if wsum > 0.0 {
            if let Some(name) = layer.get("name").and_then(Value::as_str) {
                let frac = round_to(total / wsum, 1);
                match fractions.iter_mut().find(|(n, _)| n == name) {
                    Some(slot) => slot.1 = frac,
                    None => fractions.push((name.to_owned(), frac)),
                }
            }
        }
    }
    let frac = |n: &str| fractions.iter().find(|(k, _)| k == n).map(|(_, v)| *v);
    if let (Some(clay), Some(sand), Some(silt)) = (frac("clay"), frac("sand"), frac("silt")) {
        soil.clay_pct = Some(clay);
        soil.sand_pct = Some(sand);
        soil.silt_pct = Some(silt);
        soil.texture = Some(texture_class(sand, silt, clay).to_owned());
        soil.depth = Some("0-30cm".to_owned());
    }
    if soil.wrb_class.is_none() && soil.texture.is_none() {
        return Ok(None);
    }
    Ok(Some(soil))
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/// The place a profile is about.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PlaceIn {
    /// A stable id (a real, catalogued place); `None` for a bare coordinate.
    pub id: Option<String>,
    pub collection: Option<String>,
    pub slug: Option<String>,
    pub name: Option<String>,
    pub lat: f64,
    pub lon: f64,
    pub country: Option<String>,
    pub admin1: Option<String>,
    pub elevation: Option<f64>,
    /// The country came from the request or the slug, not the place record.
    pub country_hint: bool,
}

/// The cell's normals with their metadata.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalsBundle {
    pub cell: Option<String>,
    pub period: String,
    pub source: String,
    pub monthly: Vec<MonthlyNormal>,
    pub time_zone: Option<String>,
    pub utc_offset_seconds: Option<i64>,
    pub elevation: Option<f64>,
}

/// What `build_knowledge` produces (the stored-shape document).
#[derive(Debug, Clone, PartialEq)]
pub struct Knowledge {
    pub place_collection: String,
    pub name: Option<String>,
    pub lat: f64,
    pub lon: f64,
    pub region_cell: String,
    pub address_country: Option<String>,
    pub address_region: Option<String>,
    pub elevation_meters: Option<f64>,
    pub hemisphere: String,
    pub time_zone: Option<String>,
    pub climate: Option<Climate>,
    pub seasons: Seasons,
    pub agriculture: Option<Agriculture>,
    pub soil: Option<Soil>,
    pub provenance: Vec<ProvenanceEntry>,
    pub refresh_after: RefreshAfter,
    pub utc_offset_seconds: Option<i64>,
}

/// Python's `datetime.isoformat()` for a UTC instant: no fraction on a whole
/// second, else six digits.
fn iso(now: DateTime<Utc>) -> String {
    let fmt = if now.timestamp_subsec_nanos() == 0 {
        SecondsFormat::Secs
    } else {
        SecondsFormat::Micros
    };
    now.to_rfc3339_opts(fmt, false)
}

fn prov(
    field: &str,
    source: &str,
    method: &str,
    now: DateTime<Utc>,
    licence: Option<&str>,
    attribution: Option<&str>,
    url: Option<&str>,
) -> ProvenanceEntry {
    let some = |s: Option<&str>| s.filter(|s| !s.is_empty()).map(str::to_owned);
    ProvenanceEntry {
        field: field.to_owned(),
        source: source.to_owned(),
        licence: some(licence),
        attribution: some(attribution),
        url: some(url),
        method: method.to_owned(),
        retrieved_at: Some(iso(now)),
    }
}

/// The knowledge document for `place`, from what was fetched: the cell's
/// normals, the country's season calendar (`None` for a derived default) and
/// the soil answer `(soil, answered)` (`(None, false)` when it was not asked).
pub fn build_knowledge(
    place: &PlaceIn,
    normals: Option<&NormalsBundle>,
    seed_seasons: Option<Seasons>,
    soil: (Option<Soil>, bool),
    now: DateTime<Utc>,
) -> Knowledge {
    let (lat, lon) = (place.lat, place.lon);
    let country = place
        .country
        .as_deref()
        .map(str::to_uppercase)
        .filter(|c| !c.is_empty());
    let region_cell = encode_geohash(lat, lon, REGION_CELL_PRECISION);
    let mut provenance = Vec::new();
    let mut refresh: Vec<(String, String)> = Vec::new();
    let mut due = |group: &str, ok: bool, days: i64| {
        let d = if ok { days } else { RETRY_DAYS };
        refresh.push((group.to_owned(), iso(now + Duration::days(d))));
    };

    let monthly: &[MonthlyNormal] = normals.map(|n| n.monthly.as_slice()).unwrap_or(&[]);
    let mut climate = None;
    if let Some(n) = normals.filter(|n| !n.monthly.is_empty()) {
        let code = derive_koppen(&n.monthly, lat);
        climate = Some(Climate {
            normals: Some(Normals {
                period: if n.period.is_empty() {
                    NORMALS_PERIOD.to_owned()
                } else {
                    n.period.clone()
                },
                cell: n.cell.clone(),
                monthly: n.monthly.clone(),
            }),
            koppen: code.as_ref().map(|c| Koppen {
                code: c.clone(),
                label: koppen_label(c),
                method: "derived".to_owned(),
            }),
        });
        provenance.push(prov(
            "climate.normals",
            if n.source.is_empty() {
                NORMALS_SOURCE
            } else {
                &n.source
            },
            "modelled",
            now,
            Some("CC-BY-4.0"),
            Some("Copernicus Climate Change Service ERA5 reanalysis, via Open-Meteo"),
            Some("https://open-meteo.com/en/docs/historical-weather-api"),
        ));
        if code.is_some() {
            provenance.push(prov(
                "climate.koppen",
                "Köppen–Geiger rules applied to the ERA5 normals of the 0.25° cell",
                "derived",
                now,
                None,
                Some("Classification definitions: Beck et al. (2018), Scientific Data 5, 180214"),
                Some("https://doi.org/10.1038/sdata.2018.214"),
            ));
        }
    }
    due("normals", !monthly.is_empty(), 365);

    // Static facts.
    let tz = normals.and_then(|n| n.time_zone.clone());
    let mut elevation = place.elevation.filter(|e| *e != 0.0);
    let mut elevation_src = "place record";
    if elevation.is_none() {
        if let Some(e) = normals.and_then(|n| n.elevation) {
            elevation = Some(e);
            elevation_src = "Open-Meteo elevation (Copernicus DEM, 90 m) at the cell centre";
        }
    }
    let collection = place
        .collection
        .clone()
        .unwrap_or_else(|| "placesGeo".to_owned());
    provenance.push(prov(
        "addressCountry,addressRegion",
        &format!("places.{collection}"),
        "observed",
        now,
        None,
        None,
        None,
    ));
    if elevation.filter(|e| *e != 0.0).is_some() {
        provenance.push(prov(
            "elevationMeters",
            elevation_src,
            if elevation_src == "place record" {
                "observed"
            } else {
                "modelled"
            },
            now,
            None,
            None,
            None,
        ));
    }
    if tz.is_some() {
        provenance.push(prov(
            "timeZone",
            "Open-Meteo time-zone lookup (IANA tz database)",
            "observed",
            now,
            None,
            None,
            None,
        ));
    }

    // Seasons.
    let seasons = seed_seasons.unwrap_or_else(|| derived_seasons(lat, monthly));
    let (season_source, season_method) = match seasons.source.as_str() {
        "seed" => (
            "mukoko season calendar (weather.seasons, seed-seasons.ts)",
            "seed",
        ),
        "ai" => ("AI-generated season calendar (unverified)", "ai"),
        _ => ("Derived from hemisphere and ERA5 normals", "derived"),
    };
    provenance.push(prov(
        "seasons",
        season_source,
        season_method,
        now,
        None,
        None,
        None,
    ));
    if seasons.source == "ai" {
        due("seasons", true, AI_SEASONS_REFRESH_DAYS);
    } else {
        // A derived calendar without normals is the bare hemisphere default:
        // retry soon, when the normals may be available.
        due(
            "seasons",
            seasons.source == "seed" || !monthly.is_empty(),
            30,
        );
    }

    // Agriculture.
    let cal: Option<AgCalendar> = ag::calendar_for(lat, lon, country.as_deref(), monthly);
    let grazing = ag::grazing_notes(monthly);
    let mut agriculture = None;
    if cal.is_some() || grazing.is_some() {
        let seed = cal.as_ref().filter(|c| c.method == "seed");
        let a = Agriculture {
            calendar_ref: seed.map(|c| CalendarRef {
                source: c.source.clone(),
                country: c.country.clone(),
                region: c.region.clone(),
            }),
            crops: cal.as_ref().map(|c| c.crops.clone()).unwrap_or_default(),
            derived: cal.as_ref().and_then(|c| c.derived.clone()),
            grazing: grazing.clone(),
        };
        if let Some(c) = seed {
            provenance.push(prov(
                "agriculture.crops",
                &c.source,
                "seed",
                now,
                c.licence.as_deref(),
                c.attribution.as_deref(),
                c.url.as_deref(),
            ));
        }
        if a.derived.is_some() || grazing.is_some() {
            provenance.push(prov(
                "agriculture.derived,agriculture.grazing",
                "Derived from ERA5 1991–2020 normals",
                "derived",
                now,
                None,
                None,
                None,
            ));
        }
        agriculture = Some(a);
    }
    due("agriculture", cal.is_some(), 180);

    // Soil (best effort).
    let (soil, soil_answered) = soil;
    if soil.is_some() {
        provenance.push(prov(
            "soil",
            "ISRIC SoilGrids 2.0",
            "modelled",
            now,
            Some("CC-BY-4.0"),
            Some("Poggio et al. (2021), SOIL 7, 217–240, doi:10.5194/soil-7-217-2021"),
            Some("https://soilgrids.org"),
        ));
    }
    due("soil", soil_answered, 365);

    Knowledge {
        place_collection: collection,
        name: place.name.clone(),
        lat,
        lon,
        region_cell,
        address_country: country,
        address_region: place.admin1.clone().filter(|a| !a.is_empty()),
        elevation_meters: elevation.filter(|e| *e != 0.0),
        hemisphere: if lat >= 0.0 { "north" } else { "south" }.to_owned(),
        time_zone: tz,
        climate,
        seasons,
        agriculture,
        soil,
        provenance,
        refresh_after: RefreshAfter(refresh),
        utc_offset_seconds: normals.and_then(|n| n.utc_offset_seconds),
    }
}

/// The profile for a knowledge document (before `current`).
pub fn to_profile(
    doc: &Knowledge,
    place: &PlaceIn,
    stored: bool,
    now: DateTime<Utc>,
) -> LocationProfile {
    LocationProfile {
        place_id: place.id.clone(),
        place_collection: place.id.as_ref().map(|_| doc.place_collection.clone()),
        slug: place.slug.clone(),
        name: doc.name.clone().or_else(|| place.name.clone()),
        lat: doc.lat,
        lon: doc.lon,
        country_code: doc.address_country.clone(),
        admin1: doc.address_region.clone(),
        elevation_meters: doc.elevation_meters,
        hemisphere: doc.hemisphere.clone(),
        time_zone: doc.time_zone.clone(),
        region_cell: doc.region_cell.clone(),
        climate: doc.climate.clone().unwrap_or_default(),
        seasons: Some(doc.seasons.clone()),
        agriculture: doc.agriculture.clone(),
        soil: doc.soil.clone(),
        provenance: doc.provenance.clone(),
        refresh_after: doc.refresh_after.clone(),
        stored,
        built_at: Some(iso(now)),
        complete: doc.climate.is_some(),
        current: None,
        season: None,
        crops: Vec::new(),
        normals: None,
        koppen: None,
        enso: None,
    }
}

// ---------------------------------------------------------------------------
// The current context (read time, never stored)
// ---------------------------------------------------------------------------

/// The local date and context at `when`, for a place whose UTC offset at
/// `when` is `offset_s` (the caller resolves the time zone).
pub fn compute_current(
    profile: &LocationProfile,
    when: DateTime<Utc>,
    offset_s: i64,
    enso: Option<EnsoNow>,
) -> CurrentContext {
    let local = (when + Duration::seconds(offset_s)).date_naive();
    let (season, next) = season_now(profile.seasons.as_ref(), local);
    let normals_now = profile
        .climate
        .normals
        .as_ref()
        .and_then(|n| n.monthly.iter().find(|m| m.month == local.month()).cloned());
    let phases: Vec<CropPhase> = profile
        .agriculture
        .as_ref()
        .map(|a| a.crops.iter().map(|w| ag::crop_phase(w, local)).collect())
        .unwrap_or_default();
    let in_window = profile
        .agriculture
        .as_ref()
        .and_then(|a| a.derived.as_ref())
        .map(|d| d.months.contains(&local.month()));
    let m = moon_phase(when);
    CurrentContext {
        date: local.format("%Y-%m-%d").to_string(),
        month: local.month(),
        season,
        next_season: next,
        normals_this_month: normals_now,
        crop_phases: phases,
        in_derived_growing_window: in_window,
        moon: MoonNow {
            phase: m,
            name: MOON_NAMES[m as usize].to_owned(),
        },
        enso,
        astronomy: Some(astronomy(profile.lat, profile.lon, local, Some(offset_s))),
    }
}

/// The mukoko activity id a published staple-crop calendar answers for.
pub const CROP_ACTIVITY_ID: &str = "crop-farming";

/// Staples in the order a calendar entry is preferred for `crop-farming`.
const STAPLE_ORDER: [&str; 8] = [
    "maize",
    "rice",
    "sorghum",
    "millet",
    "winter-wheat",
    "spring-wheat",
    "beans",
    "teff",
];

fn phase_word(phase: &str) -> Option<&'static str> {
    match phase {
        "planting" => Some("planting"),
        "vegetative" => Some("growing"),
        "harvest" => Some("harvest"),
        "endOfSeason" => Some("post-harvest"),
        "outOfSeason" => Some("off-season"),
        _ => None,
    }
}

fn doy_month(doy: i64) -> u32 {
    (ymd(2001, 1, 1) + Duration::days(doy - 1)).month()
}

/// Months covered from day-of-year `start` up to (not including) `end`,
/// wrapping the year end.
pub fn stage_months(start: i64, end: i64) -> Vec<u32> {
    let first = doy_month(start);
    let last = doy_month((end - 2).rem_euclid(365) + 1);
    let mut months = vec![first];
    while *months.last().expect("one month") != last && months.len() < 12 {
        months.push(months.last().expect("one month") % 12 + 1);
    }
    months
}

/// The calendar crops in the consumer shape: only `crop-farming` is answered,
/// with the best published staple (maize first, its largest season).
pub fn crop_views(agriculture: Option<&Agriculture>, phases: &[CropPhase]) -> Vec<CropView> {
    let Some(a) = agriculture.filter(|a| !a.crops.is_empty()) else {
        return Vec::new();
    };
    let rank = |w: &CropWindow| {
        STAPLE_ORDER
            .iter()
            .position(|c| *c == w.crop)
            .unwrap_or(STAPLE_ORDER.len())
    };
    // `min_by_key` keeps the first of equal ranks: the largest season.
    let window = a.crops.iter().min_by_key(|w| rank(w)).expect("non-empty");
    let st = &window.stages;
    let phase = phases
        .iter()
        .find(|p| p.crop == window.crop && p.season == window.season);
    let label = match &window.season {
        Some(s) => format!("{} ({s})", window.crop_label),
        None => window.crop_label.clone(),
    };
    vec![CropView {
        id: CROP_ACTIVITY_ID.to_owned(),
        label,
        season: window.season.clone(),
        phase: phase.and_then(|p| phase_word(&p.phase)).map(str::to_owned),
        calendar: CropCalendar {
            plant: stage_months(st.planting, st.vegetative),
            grow: stage_months(st.vegetative, st.harvest),
            harvest: stage_months(st.harvest, st.end_of_season),
        },
        source: ag::GEOGLAM_SOURCE.to_owned(),
    }]
}

/// Fill the flat consumer fields from the stored groups and `current`.
pub fn apply_consumer_view(profile: &mut LocationProfile) {
    let Some(cur) = profile.current.clone() else {
        return;
    };
    profile.season = cur.season.clone();
    profile.crops = crop_views(profile.agriculture.as_ref(), &cur.crop_phases);
    if let Some(n) = &cur.normals_this_month {
        if n.mean_high_c.is_some() || n.mean_low_c.is_some() {
            profile.normals = Some(NormalsView {
                high: n.mean_high_c,
                low: n.mean_low_c,
            });
        }
    }
    profile.koppen = profile.climate.koppen.as_ref().map(|k| k.code.clone());
    if let Some(e) = &cur.enso {
        profile.enso = Some(EnsoView {
            phase: e.phase.clone(),
            oni: e.oni,
        });
    }
}

// ---------------------------------------------------------------------------
// Slugs and countries
// ---------------------------------------------------------------------------

/// The ISO code in a `{city}-{cc}` slug, accepted only when `is_known` says
/// it is a country we know.
pub fn country_from_slug(slug: &str, is_known: impl Fn(&str) -> bool) -> Option<String> {
    let lower = slug.to_lowercase();
    let tail = lower.rsplit_once('-')?.1;
    if tail.len() != 2 || !tail.chars().all(|c| c.is_ascii_lowercase()) {
        return None;
    }
    let iso = tail.to_uppercase();
    is_known(&iso).then_some(iso)
}

// ---------------------------------------------------------------------------
// Time zones and neighbours
// ---------------------------------------------------------------------------

/// The UTC offset in seconds from an `Intl` `timeZoneName` label: `GMT`,
/// `GMT+2`, `GMT+02:00`, `GMT-05:30`, `UTC`.
pub fn parse_offset_label(label: &str) -> Option<i64> {
    let rest = label
        .trim()
        .strip_prefix("GMT")
        .or_else(|| label.trim().strip_prefix("UTC"))?;
    if rest.is_empty() {
        return Some(0);
    }
    let (sign, body) = match rest.chars().next()? {
        '+' => (1, &rest[1..]),
        '-' | '\u{2212}' => (-1, &rest[rest.chars().next()?.len_utf8()..]),
        _ => return None,
    };
    let (h, m) = body.split_once(':').unwrap_or((body, "0"));
    let (h, m): (i64, i64) = (h.parse().ok()?, m.parse().ok()?);
    ((0..=18).contains(&h) && (0..60).contains(&m)).then_some(sign * (h * 3600 + m * 60))
}

/// The offset a profile's local date is read at: the zone's own offset at
/// that instant when the caller could resolve it, else the cell's archive
/// offset, else the longitude's nominal hour.
pub fn utc_offset_seconds(zone_offset: Option<i64>, fallback: Option<i64>, lon: f64) -> i64 {
    zone_offset
        .or(fallback)
        .unwrap_or_else(|| (lon / 15.0).round_ties_even() as i64 * 3600)
}

/// A stored neighbour's climate, soil and zone for a bare spot with none of
/// its own (the same 5-character geohash cell). The provenance entries it
/// brings are labelled "(nearby place)".
pub fn merge_neighbour(doc: &mut Knowledge, neighbour: &Value) {
    if let Some(c) = neighbour
        .get("climate")
        .and_then(|c| serde_json::from_value::<Climate>(c.clone()).ok())
    {
        doc.climate = Some(c);
    }
    if doc.soil.is_none() {
        doc.soil = neighbour
            .get("soil")
            .and_then(|s| serde_json::from_value::<Soil>(s.clone()).ok());
    }
    if doc.time_zone.is_none() {
        doc.time_zone = neighbour
            .get("timeZone")
            .and_then(Value::as_str)
            .map(str::to_owned);
    }
    for p in neighbour
        .get("provenance")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let field = p.get("field").and_then(Value::as_str).unwrap_or("");
        if !(field.starts_with("climate") || field.starts_with("soil")) {
            continue;
        }
        let text = |k: &str| p.get(k).and_then(Value::as_str).map(str::to_owned);
        doc.provenance.push(ProvenanceEntry {
            field: format!("{field} (nearby place)"),
            source: text("source").unwrap_or_default(),
            licence: text("licence"),
            attribution: text("attribution"),
            url: text("url"),
            method: text("method").unwrap_or_default(),
            // A stored date arrives as extended JSON; only a string is kept.
            retrieved_at: text("retrievedAt"),
        });
    }
}

// ---------------------------------------------------------------------------
// Resolving the place a request is about
// ---------------------------------------------------------------------------

/// Slugs the endpoint accepts (`SLUG_RE` in the Python backend).
pub fn valid_slug(slug: &str) -> bool {
    (1..=80).contains(&slug.len())
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Is `iso` a country this backend has facts for: a season calendar, a crop
/// calendar or a seed place?
pub fn known_country(iso: &str) -> bool {
    let iso = iso.to_uppercase();
    season_seed_has(&iso)
        || ag::geoglam_iso_codes().any(|c| c == iso)
        || crate::locations::seed_locations()
            .iter()
            .any(|l| l.country.as_deref() == Some(iso.as_str()))
}

/// A seed (catalogue) place as the profile's place.
pub fn place_from_seed(doc: &crate::locations::LocationDoc) -> PlaceIn {
    PlaceIn {
        id: Some(format!("seed:{}", doc.slug)),
        collection: Some("seed".to_owned()),
        slug: Some(doc.slug.clone()),
        name: Some(doc.name.clone()),
        lat: doc.lat,
        lon: doc.lon,
        country: doc.country.clone().filter(|c| !c.is_empty()),
        admin1: Some(doc.province.clone()).filter(|p| !p.is_empty()),
        elevation: Some(doc.elevation).filter(|e| *e != 0.0),
        country_hint: false,
    }
}

/// Fill a missing country from the request's `country` or the slug's `-cc`
/// suffix. Such a value is a hint: good enough to compute this response, never
/// stored.
pub fn apply_country_hint(place: &mut PlaceIn, country: Option<&str>, slug: Option<&str>) {
    if place.country.is_some() {
        return;
    }
    let hint = country
        .map(str::to_uppercase)
        .or_else(|| slug.and_then(|s| country_from_slug(s, known_country)));
    if let Some(h) = hint {
        place.country = Some(h);
        place.country_hint = true;
    }
}

/// What the slug alone settles.
pub enum FromSlug {
    /// A catalogue place.
    Place(Box<PlaceIn>),
    /// A smart-slug spot: its own point (and name) stand in for a missing
    /// coordinate, and the coordinate is then matched to a nearby place.
    Spot {
        name: Option<String>,
        lat: f64,
        lon: f64,
    },
    /// Not ours to say: the canonical place directory may know it.
    Unknown,
}

pub fn from_slug(slug: &str) -> FromSlug {
    if let Some(doc) = crate::locations::find_seed(slug) {
        return FromSlug::Place(Box::new(place_from_seed(doc)));
    }
    if let Some((name, lat, lon)) = crate::locations::parse_spot_slug(slug) {
        return FromSlug::Spot {
            name: Some(name).filter(|n| !n.is_empty()),
            lat,
            lon,
        };
    }
    FromSlug::Unknown
}

/// The known place within [`NEAREST_PLACE_KM`] of a coordinate, else a bare
/// spot (never stored, no id).
pub fn place_near(lat: f64, lon: f64, slug: Option<&str>, name: Option<String>) -> PlaceIn {
    match crate::locations::nearest_seeds(lat, lon, NEAREST_PLACE_KM, 1).first() {
        Some(doc) => place_from_seed(doc),
        None => PlaceIn {
            slug: slug.map(str::to_owned),
            name,
            lat,
            lon,
            ..PlaceIn::default()
        },
    }
}

// ---------------------------------------------------------------------------
// AI prompt block
// ---------------------------------------------------------------------------

/// The block must stay under ~250 tokens; ~4 characters a token.
pub const PROMPT_BLOCK_MAX_CHARS: usize = 1000;

/// Contiguous runs of months over a circular year.
pub fn month_runs(months: &[u32]) -> Vec<Vec<u32>> {
    let present: HashSet<u32> = months.iter().copied().collect();
    if present.is_empty() {
        return Vec::new();
    }
    if present.len() == 12 {
        return vec![(1..=12).collect()];
    }
    let mut sorted: Vec<u32> = present.iter().copied().collect();
    sorted.sort_unstable();
    sorted
        .into_iter()
        .filter(|m| !present.contains(&((m + 10) % 12 + 1)))
        .map(|start| {
            let mut run = vec![start];
            let mut m = start;
            while present.contains(&(m % 12 + 1)) {
                m = m % 12 + 1;
                run.push(m);
            }
            run
        })
        .collect()
}

/// "May–Oct", or "Mar–May, Oct–Dec" for a window with a gap: a dry gap
/// between two rainy seasons is never reported as growing season.
pub fn month_list(months: &[u32]) -> String {
    month_runs(months)
        .iter()
        .map(|run| {
            let a = MONTHS[run[0] as usize - 1];
            let b = MONTHS[run[run.len() - 1] as usize - 1];
            if run.len() == 1 {
                a.to_owned()
            } else {
                format!("{a}–{b}")
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn short_date(iso: &str) -> String {
    match NaiveDate::parse_from_str(iso, "%Y-%m-%d") {
        Ok(d) => format!("{} {}", d.day(), MONTHS[d.month0() as usize]),
        Err(_) => iso.to_owned(),
    }
}

fn py_round(v: f64) -> i64 {
    v.round_ties_even() as i64
}

/// A compact, factual block for an AI prompt (under ~250 tokens). Lines marked
/// `~` are derived or unverified estimates, and the prompt rule is that the
/// model must present them as approximate. `""` without a current context.
pub fn profile_prompt_block(profile: &LocationProfile) -> String {
    let Some(cur) = &profile.current else {
        return String::new();
    };
    let mut lines = vec![
        "Place profile (stored facts about this place; lines marked ~ are derived estimates — present them as approximate, never as fact):"
            .to_owned(),
    ];
    let where_ = [profile.admin1.as_deref(), profile.country_code.as_deref()]
        .into_iter()
        .flatten()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    let mut facts: Vec<String> = Vec::new();
    if !where_.is_empty() {
        facts.push(where_);
    }
    if let Some(e) = profile.elevation_meters.filter(|e| *e != 0.0) {
        facts.push(format!("{} m", py_round(e)));
    }
    facts.push(format!("{}ern hemisphere", profile.hemisphere));
    if let Some(tz) = &profile.time_zone {
        facts.push(tz.clone());
    }
    lines.push(format!("- {}", facts.join("; ")));
    if let Some(k) = &profile.climate.koppen {
        lines.push(format!("- ~Climate zone {} ({})", k.code, k.label));
    }
    if let Some(n) = &cur.normals_this_month {
        if n.mean_high_c.is_some() || n.mean_low_c.is_some() {
            let temps = [("high", n.mean_high_c), ("low", n.mean_low_c)]
                .into_iter()
                .filter_map(|(l, v)| v.map(|v| format!("{l} {}°C", py_round(v))))
                .collect::<Vec<_>>()
                .join(", ");
            let rain = match n.precip_mm {
                Some(p) => format!(
                    ", rain {} mm on {} days",
                    py_round(p),
                    py_round(n.rainy_days.unwrap_or(0.0))
                ),
                None => String::new(),
            };
            lines.push(format!(
                "- {} normals (ERA5 1991–2020): {temps}{rain}",
                MONTHS[cur.month as usize - 1]
            ));
        }
    }
    if let Some(s) = &cur.season {
        let mark = if s.verified { "" } else { "~" };
        let differs = |l: &Option<String>, n: &str| {
            l.as_deref().filter(|l| *l != n).map(|l| format!(" ({l})"))
        };
        let local = differs(&s.local_name, &s.name).unwrap_or_default();
        let next = cur
            .next_season
            .as_ref()
            .map(|n| {
                let nloc = differs(&n.local_name, &n.name).unwrap_or_default();
                format!("; next {}{nloc} from {}", n.name, short_date(&n.starts_on))
            })
            .unwrap_or_default();
        lines.push(format!("- {mark}Season: {}{local}{next}", s.name));
    }
    if !cur.crop_phases.is_empty() {
        let parts: Vec<String> = cur
            .crop_phases
            .iter()
            .take(4)
            .map(|ph| {
                let season = ph
                    .season
                    .as_ref()
                    .map(|s| format!(" ({s})"))
                    .unwrap_or_default();
                format!(
                    "{}{season} {}, {} from {}",
                    ph.crop_label.to_lowercase(),
                    ph.phase_label.to_lowercase(),
                    ph.next_phase_label.to_lowercase(),
                    short_date(&ph.next_phase_on)
                )
            })
            .collect();
        let region = profile
            .agriculture
            .as_ref()
            .and_then(|a| a.calendar_ref.as_ref())
            .and_then(|r| r.region.clone());
        let region = region.map(|r| format!(", {r}")).unwrap_or_default();
        lines.push(format!(
            "- Crop calendar (GEOGLAM{region}): {}",
            parts.join("; ")
        ));
    } else if let Some(d) = profile
        .agriculture
        .as_ref()
        .and_then(|a| a.derived.as_ref())
        .filter(|d| !d.months.is_empty())
    {
        let state = if cur.in_derived_growing_window == Some(true) {
            "inside"
        } else {
            "outside"
        };
        lines.push(format!(
            "- ~Likely growing window {} ({}); now {state} it. No local crop calendar on file.",
            month_list(&d.months),
            d.basis
        ));
    }
    if let Some(note) = profile
        .agriculture
        .as_ref()
        .and_then(|a| a.grazing.as_ref())
        .and_then(|g| g.note.as_ref())
        .filter(|n| !n.is_empty())
    {
        lines.push(format!("- ~Grazing: {note}"));
    }
    if let Some(soil) = profile
        .soil
        .as_ref()
        .filter(|s| s.wrb_class.is_some() || s.texture.is_some())
    {
        let parts: Vec<&str> = [soil.wrb_class.as_deref(), soil.texture.as_deref()]
            .into_iter()
            .flatten()
            .filter(|s| !s.is_empty())
            .collect();
        lines.push(format!("- Soil (SoilGrids model): {}", parts.join(", ")));
    }
    let mut ctx = vec![format!("moon {}", cur.moon.name)];
    if let Some(e) = &cur.enso {
        let strength = e
            .strength
            .as_ref()
            .map(|s| format!(" ({s})"))
            .unwrap_or_default();
        ctx.insert(0, format!("ENSO {}{strength}", e.phase));
    }
    if let Some(a) = &cur.astronomy {
        ctx.push(format!(
            "day length {:.1} h, {}",
            a.day_length_hours, a.trend
        ));
    }
    lines.push(format!("- {}", ctx.join("; ")));
    let block = lines.join("\n");
    if block.chars().count() > PROMPT_BLOCK_MAX_CHARS {
        let cut: String = block.chars().take(PROMPT_BLOCK_MAX_CHARS - 1).collect();
        return cut
            .rsplit_once('\n')
            .map_or(cut.clone(), |(head, _)| head.to_owned());
    }
    block
}

/// The rule every prompt that carries a profile block adds beside it.
pub const PROFILE_GROUNDING_RULE: &str = "Use the place profile to ground timing and local practice (season, crop stage, climate). Lines marked ~ are derived estimates: say \"typically\" or \"around\", never state them as fact. If the profile has no crop calendar, do not name local crops.";

/// The block plus its grounding rule, ready to splice into a prompt.
pub fn with_profile(block: &str) -> String {
    if block.is_empty() {
        String::new()
    } else {
        format!("\n{block}\n{PROFILE_GROUNDING_RULE}\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

    fn day(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    fn when(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    fn j<T: Serialize>(v: &T) -> Value {
        serde_json::to_value(v).unwrap()
    }

    #[test]
    fn koppen_classes_match_python_in_both_hemispheres() {
        let x = fx();
        for c in x["koppen"].as_array().unwrap() {
            let m = monthly(&c["monthly"]);
            let lat = c["lat"].as_f64().unwrap();
            assert_eq!(
                derive_koppen(&m, lat).as_deref(),
                c["out"].as_str(),
                "{}",
                c["name"]
            );
            let south = if lat > 0.0 { -lat } else { lat.abs() };
            assert_eq!(
                derive_koppen(&m, south).as_deref(),
                c["outSouth"].as_str(),
                "{} south",
                c["name"]
            );
        }
        for (code, label) in x["labels"].as_object().unwrap() {
            assert_eq!(koppen_label(code), label.as_str().unwrap(), "{code}");
        }
        assert_eq!(koppen_label("Zz"), "Zz");
    }

    #[test]
    fn derived_seasons_match_python() {
        for c in fx()["derivedSeasons"].as_array().unwrap() {
            let lat = c["lat"].as_f64().unwrap();
            assert_eq!(
                j(&derived_seasons(lat, &monthly(&c["monthly"]))),
                c["out"],
                "{}",
                c["name"]
            );
        }
    }

    #[test]
    fn runs_and_start_months_match_python() {
        let x = fx();
        for c in x["runs"].as_array().unwrap() {
            let flags: Vec<bool> = c["flags"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| b.as_bool().unwrap())
                .collect();
            assert_eq!(j(&contiguous_runs(&flags)), c["out"]);
        }
        for c in x["startMonth"].as_array().unwrap() {
            let months: Vec<u32> = c["months"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| m.as_u64().unwrap() as u32)
                .collect();
            assert_eq!(
                u64::from(season_start_month(&months)),
                c["out"].as_u64().unwrap(),
                "{months:?}"
            );
        }
    }

    #[test]
    fn country_calendars_match_python_including_ai_rows_and_bad_rows() {
        for c in fx()["countrySeasons"].as_array().unwrap() {
            // The Python read `weather.seasons` by upper-cased country code.
            let rows: Vec<SeasonRow> = match c["country"].as_str() {
                Some("XX") => serde_json::from_value(c["rows"].clone()).unwrap(),
                Some(iso) => seed_season_rows(iso),
                None => Vec::new(),
            };
            let got = seasons_from_rows(&rows);
            assert_eq!(j(&got), c["out"], "{}", c["country"]);
        }
        assert!(season_seed_has("ZW") && season_seed_has("zw") && !season_seed_has("XX"));
        // The compiled seed gives the same rows the Python read for a seed country.
        let zw = seasons_from_rows(&seed_season_rows("ZW")).unwrap();
        assert_eq!(zw.source, "seed");
        assert!(zw.verified);
    }

    #[test]
    fn the_current_and_next_season_match_python_across_the_year() {
        for c in fx()["seasonNow"].as_array().unwrap() {
            let seasons = match c["country"].as_str().unwrap() {
                "none" => None,
                "derived-n" => Some(derived_seasons(51.0, &[])),
                iso => seasons_from_rows(&seed_season_rows(iso)),
            };
            let (now, next) = season_now(seasons.as_ref(), day(c["day"].as_str().unwrap()));
            assert_eq!(json!([j(&now), j(&next)]), c["out"], "{c}");
        }
    }

    #[test]
    fn day_length_sun_times_and_the_trend_match_python() {
        let cases = fx()["astronomy"].as_array().unwrap().clone();
        assert!(cases.len() > 60);
        for c in cases {
            let d = day(c["day"].as_str().unwrap());
            let lat = c["lat"].as_f64().unwrap();
            assert_eq!(day_length_hours(lat, d), c["len"].as_f64().unwrap(), "{c}");
            let got = astronomy(lat, c["lon"].as_f64().unwrap(), d, c["offset"].as_i64());
            assert_eq!(j(&got), c["out"], "{c}");
        }
    }

    #[test]
    fn the_moon_phase_matches_python() {
        for c in fx()["moon"].as_array().unwrap() {
            assert_eq!(
                moon_phase(when(c["when"].as_str().unwrap())),
                c["out"].as_i64().unwrap(),
                "{c}"
            );
        }
    }

    #[test]
    fn soil_texture_classes_match_python() {
        let cases = fx()["texture"].as_array().unwrap().clone();
        assert!(cases.len() > 60);
        for c in cases {
            let f = |k: &str| c[k].as_f64().unwrap();
            assert_eq!(
                texture_class(f("s"), f("si"), f("c")),
                c["out"].as_str().unwrap(),
                "{c}"
            );
        }
    }

    #[test]
    fn soilgrids_answers_parse_like_python() {
        for c in fx()["soil"].as_array().unwrap() {
            let got = parse_soil(&c["c"], &c["p"]);
            if c["err"].as_bool().unwrap() {
                assert!(got.is_err(), "{}", c["name"]);
            } else {
                assert_eq!(j(&got.expect("understood")), c["out"], "{}", c["name"]);
            }
        }
    }

    #[test]
    fn soil_requests_name_the_point_and_the_layers() {
        let u = soil_classification_url(-17.83, 31.05);
        assert_eq!(
            u,
            "https://rest.isric.org/soilgrids/v2.0/classification/query?lon=31.0500&lat=-17.8300&number_classes=1"
        );
        let p = soil_properties_url(-17.83, 31.05);
        for part in [
            "property=clay",
            "property=sand",
            "property=silt",
            "depth=0-5cm",
            "depth=15-30cm",
            "value=mean",
        ] {
            assert!(p.contains(part), "{part}");
        }
    }

    #[test]
    fn stage_months_and_month_lists_match_python() {
        let x = fx();
        for c in x["stageMonths"].as_array().unwrap() {
            let got = stage_months(c["start"].as_i64().unwrap(), c["end"].as_i64().unwrap());
            assert_eq!(j(&got), c["out"], "{c}");
        }
        for c in x["monthList"].as_array().unwrap() {
            let months: Vec<u32> = c["months"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| m.as_u64().unwrap() as u32)
                .collect();
            assert_eq!(
                month_list(&months),
                c["out"].as_str().unwrap(),
                "{months:?}"
            );
        }
    }

    fn place_in(v: &Value) -> PlaceIn {
        PlaceIn {
            id: v["id"].as_str().map(str::to_owned),
            collection: v["collection"].as_str().map(str::to_owned),
            slug: v["slug"].as_str().map(str::to_owned),
            name: v["name"].as_str().map(str::to_owned),
            lat: v["lat"].as_f64().unwrap(),
            lon: v["lon"].as_f64().unwrap(),
            country: v["country"].as_str().map(str::to_owned),
            admin1: v["admin1"].as_str().map(str::to_owned),
            elevation: v["elevation"].as_f64(),
            country_hint: v["country_hint"].as_bool().unwrap_or(false),
        }
    }

    /// Everything but the timestamps, which depend on the clock the fixture was
    /// built with (a fixed 2026-10-18 12:00 UTC `now`).
    fn same_profile(got: &LocationProfile, want: &Value, label: &str) {
        let got = j(got);
        for key in want.as_object().unwrap().keys() {
            assert_eq!(got[key], want[key], "{label}: {key}");
        }
        assert_eq!(
            got.as_object().unwrap().len(),
            want.as_object().unwrap().len(),
            "{label}: same fields"
        );
    }

    #[test]
    fn whole_profiles_match_python_field_for_field_and_so_do_their_prompt_blocks() {
        let now = when("2026-10-18T12:00:00+00:00");
        let cases = fx()["profiles"].as_array().unwrap().clone();
        assert!(cases.len() >= 10);
        for c in cases {
            let label = format!("{} @ {}", c["name"], c["when"]);
            let place = place_in(&c["place"]);
            let normals: Option<NormalsBundle> = (!c["normals"].is_null())
                .then(|| serde_json::from_value(c["normals"].clone()).unwrap());
            let rows: Vec<SeasonRow> = match place.country.as_deref() {
                Some(iso) => match c["seasonRows"].get(iso) {
                    Some(r) => serde_json::from_value(r.clone()).unwrap(),
                    None => seed_season_rows(iso),
                },
                None => Vec::new(),
            };
            let soil: Option<Soil> =
                (!c["soil"].is_null()).then(|| serde_json::from_value(c["soil"].clone()).unwrap());
            let soil_arg = if place.id.is_some() {
                (soil, c["soilAnswered"].as_bool().unwrap())
            } else {
                (None, false)
            };
            let doc = build_knowledge(
                &place,
                normals.as_ref(),
                seasons_from_rows(&rows),
                soil_arg,
                now,
            );
            let mut profile = to_profile(&doc, &place, false, now);
            let enso = (!c["enso"].is_null()).then(|| {
                let e = &c["enso"];
                EnsoNow::new(
                    e["phase"].as_str().unwrap(),
                    e["strength"].as_str(),
                    e["oni"].as_f64(),
                    e["season"].as_str(),
                )
            });
            profile.current = Some(compute_current(
                &profile,
                when(c["when"].as_str().unwrap()),
                c["offset"].as_i64().unwrap(),
                enso,
            ));
            apply_consumer_view(&mut profile);
            // `builtAt` is the wall clock.
            let mut want = c["out"].clone();
            want["builtAt"] = j(&profile.built_at);
            same_profile(&profile, &want, &label);
            assert_eq!(
                profile_prompt_block(&profile),
                c["block"].as_str().unwrap(),
                "{label}: block"
            );
        }
    }

    #[test]
    fn a_profile_without_a_current_context_has_no_block() {
        let place = PlaceIn {
            lat: 1.0,
            lon: 1.0,
            ..PlaceIn::default()
        };
        let now = when("2026-10-18T12:00:00+00:00");
        let doc = build_knowledge(&place, None, None, (None, false), now);
        let profile = to_profile(&doc, &place, false, now);
        assert_eq!(profile_prompt_block(&profile), "");
        assert_eq!(with_profile(""), "");
        assert!(with_profile("x").contains(PROFILE_GROUNDING_RULE));
    }

    #[test]
    fn slug_suffixes_name_a_country_only_when_it_is_known() {
        let known = |iso: &str| iso == "KE" || iso == "TH";
        assert_eq!(
            country_from_slug("nairobi-ke", known).as_deref(),
            Some("KE")
        );
        assert_eq!(
            country_from_slug("Bangkok-TH", known).as_deref(),
            Some("TH")
        );
        assert_eq!(country_from_slug("london-gb", known), None);
        assert_eq!(country_from_slug("harare", known), None);
        assert_eq!(country_from_slug("x--ezs42", known), None);
        assert_eq!(country_from_slug("a-b1", known), None);
    }

    #[test]
    fn a_long_block_is_cut_at_a_line() {
        let now = when("2026-10-18T12:00:00+00:00");
        let place = PlaceIn {
            lat: -17.8,
            lon: 31.0,
            country: Some("ZW".into()),
            elevation: Some(1490.0),
            ..PlaceIn::default()
        };
        let doc = build_knowledge(
            &place,
            None,
            seasons_from_rows(&seed_season_rows("ZW")),
            (None, false),
            now,
        );
        let mut profile = to_profile(&doc, &place, false, now);
        profile.current = Some(compute_current(&profile, now, 7200, None));
        let block = profile_prompt_block(&profile);
        assert!(block.chars().count() <= PROMPT_BLOCK_MAX_CHARS);
        assert!(block.starts_with("Place profile"));
    }

    #[test]
    fn slugs_are_validated_like_the_python() {
        assert!(valid_slug("harare") && valid_slug("a-b-c1") && valid_slug(&"a".repeat(80)));
        assert!(
            !valid_slug("")
                && !valid_slug("Harare")
                && !valid_slug("a_b")
                && !valid_slug(&"a".repeat(81))
        );
        assert!(!valid_slug("a b"));
    }

    #[test]
    fn a_seed_slug_is_a_catalogue_place_and_a_smart_slug_is_a_spot() {
        let FromSlug::Place(p) = from_slug("harare") else {
            panic!("a catalogue place");
        };
        assert_eq!(p.id.as_deref(), Some("seed:harare"));
        assert_eq!(p.country.as_deref(), Some("ZW"));
        assert!(p.admin1.is_some() && p.elevation.is_some());
        let FromSlug::Spot { name, lat, lon } = from_slug("west-paddock--ksy4dd7") else {
            panic!("a spot");
        };
        assert_eq!(name.as_deref(), Some("West Paddock"));
        assert!((lat + 17.8).abs() < 1.0 && (lon - 31.0).abs() < 1.0);
        assert!(matches!(
            from_slug("canberra-residences-ab12cd"),
            FromSlug::Unknown
        ));
    }

    #[test]
    fn a_coordinate_joins_a_place_within_three_km_else_stays_bare() {
        let h = crate::locations::find_seed("harare").unwrap();
        let near = place_near(h.lat + 0.01, h.lon, Some("x--ksy4dd7"), None);
        assert_eq!(near.id.as_deref(), Some("seed:harare"));
        let bare = place_near(24.0, 10.0, Some("x--ezs42"), Some("Spot".into()));
        assert_eq!(bare.id, None);
        assert_eq!(bare.name.as_deref(), Some("Spot"));
        assert_eq!(bare.slug.as_deref(), Some("x--ezs42"));
    }

    #[test]
    fn a_country_hint_fills_only_a_missing_country() {
        let mut bare = PlaceIn {
            lat: 1.0,
            lon: 1.0,
            ..PlaceIn::default()
        };
        apply_country_hint(&mut bare, Some("ke"), None);
        assert_eq!(
            (bare.country.as_deref(), bare.country_hint),
            (Some("KE"), true)
        );
        let mut from_slug_hint = PlaceIn {
            lat: 1.0,
            lon: 1.0,
            ..PlaceIn::default()
        };
        apply_country_hint(&mut from_slug_hint, None, Some("somewhere-th"));
        assert_eq!(from_slug_hint.country.as_deref(), Some("TH"));
        let mut unknown = PlaceIn {
            lat: 1.0,
            lon: 1.0,
            ..PlaceIn::default()
        };
        apply_country_hint(&mut unknown, None, Some("somewhere-xx"));
        assert_eq!(unknown.country, None);
        let mut known = PlaceIn {
            country: Some("ZW".into()),
            lat: 1.0,
            lon: 1.0,
            ..PlaceIn::default()
        };
        apply_country_hint(&mut known, Some("KE"), None);
        assert_eq!(
            (known.country.as_deref(), known.country_hint),
            (Some("ZW"), false)
        );
        assert!(known_country("zw") && known_country("TH") && !known_country("XX"));
    }

    #[test]
    fn offset_labels_parse() {
        assert_eq!(parse_offset_label("GMT"), Some(0));
        assert_eq!(parse_offset_label("GMT+02:00"), Some(7200));
        assert_eq!(parse_offset_label("GMT+2"), Some(7200));
        assert_eq!(parse_offset_label("GMT-05:30"), Some(-19_800));
        assert_eq!(parse_offset_label("GMT\u{2212}03:00"), Some(-10_800));
        assert_eq!(parse_offset_label("UTC+05:45"), Some(20_700));
        assert_eq!(parse_offset_label("CET"), None);
        assert_eq!(parse_offset_label("GMT+99:00"), None);
        assert_eq!(parse_offset_label("GMT+x"), None);
    }

    #[test]
    fn the_offset_falls_back_zone_then_archive_then_longitude() {
        assert_eq!(utc_offset_seconds(Some(7200), Some(3600), 31.0), 7200);
        assert_eq!(utc_offset_seconds(None, Some(3600), 31.0), 3600);
        assert_eq!(utc_offset_seconds(None, None, 31.0), 2 * 3600);
        assert_eq!(utc_offset_seconds(None, None, -37.5), -2 * 3600);
        // Python rounds half to even: 22.5 / 15 = 1.5 -> 2.
        assert_eq!(utc_offset_seconds(None, None, 22.5), 2 * 3600);
    }

    #[test]
    fn a_neighbours_climate_fills_a_bare_spot_and_is_labelled() {
        let now = when("2026-10-18T12:00:00+00:00");
        let place = PlaceIn {
            lat: 24.0,
            lon: 10.0,
            ..PlaceIn::default()
        };
        let mut doc = build_knowledge(&place, None, None, (None, false), now);
        assert!(doc.climate.is_none());
        let sahara = fx()["koppen"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == "sahara")
            .unwrap()["monthly"]
            .clone();
        merge_neighbour(
            &mut doc,
            &json!({
                "climate": {"koppen": {"code": "BWh", "label": "hot desert", "method": "derived"},
                             "normals": {"period": "1991–2020", "cell": "c", "monthly": sahara}},
                "soil": {"wrbClass": "Arenosols"},
                "timeZone": "Africa/Tripoli",
                "provenance": [
                    {"field": "climate.normals", "source": "ERA5", "method": "modelled", "retrievedAt": {"$date": 1}},
                    {"field": "elevationMeters", "source": "x", "method": "observed"},
                    {"field": "soil", "source": "SoilGrids", "method": "modelled", "retrievedAt": "2026-01-01T00:00:00+00:00"}
                ]
            }),
        );
        assert_eq!(
            doc.climate.as_ref().unwrap().koppen.as_ref().unwrap().code,
            "BWh"
        );
        assert_eq!(
            doc.soil.as_ref().unwrap().wrb_class.as_deref(),
            Some("Arenosols")
        );
        assert_eq!(doc.time_zone.as_deref(), Some("Africa/Tripoli"));
        let fields: Vec<&str> = doc.provenance.iter().map(|p| p.field.as_str()).collect();
        assert!(fields.contains(&"climate.normals (nearby place)"));
        assert!(fields.contains(&"soil (nearby place)"));
        assert!(!fields.iter().any(|f| f.starts_with("elevationMeters (")));
        // Its own zone and soil are kept.
        let mut own = build_knowledge(
            &place,
            None,
            None,
            (
                Some(Soil {
                    wrb_class: Some("Mine".into()),
                    ..Soil::default()
                }),
                true,
            ),
            now,
        );
        own.time_zone = Some("Own/Zone".into());
        merge_neighbour(
            &mut own,
            &json!({"soil": {"wrbClass": "Theirs"}, "timeZone": "Other/Zone"}),
        );
        assert_eq!(own.soil.unwrap().wrb_class.as_deref(), Some("Mine"));
        assert_eq!(own.time_zone.as_deref(), Some("Own/Zone"));
    }
}
