//! Deterministic farm-weather analysis: spray / plant / harvest / irrigate
//! windows, rain totals, soil band, water balance, growing degree days, frost
//! and heat risk, and the daily series for the charts. Ported from
//! `api/py/_agriculture.py` (`analyse` and everything it calls); the Python
//! functions produced `tests/fixtures/agriculture-analysis.json`, which pins
//! this module.
//!
//! No I/O: the Worker fetches the Open-Meteo payload (one batched request,
//! [`forecast_url`]) and the location profile and passes them in with the
//! current instant. Thresholds are agronomic rules of thumb (FAO-56,
//! extension-service guidance), tuned here in one place. Soil-moisture bands
//! are approximate: real field capacity depends on soil texture, which the
//! models do not know.

use std::collections::BTreeMap;

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, SecondsFormat, Utc};
use serde::Serialize;
use serde_json::Value;

pub const FORECAST_URL: &str = "https://api.open-meteo.com/v1/forecast";

pub const SOIL_MOISTURE_FIELDS: [&str; 5] = [
    "soil_moisture_0_to_1cm",
    "soil_moisture_1_to_3cm",
    "soil_moisture_3_to_9cm",
    "soil_moisture_9_to_27cm",
    "soil_moisture_27_to_81cm",
];
/// The forecast API's soil-temperature levels (it publishes these four).
pub const SOIL_TEMPERATURE_FIELDS: [&str; 4] = [
    "soil_temperature_0cm",
    "soil_temperature_6cm",
    "soil_temperature_18cm",
    "soil_temperature_54cm",
];
const OTHER_HOURLY: [&str; 9] = [
    "vapour_pressure_deficit",
    "leaf_wetness_probability",
    "precipitation",
    "precipitation_probability",
    "wind_speed_10m",
    "wind_gusts_10m",
    "relative_humidity_2m",
    "temperature_2m",
    "is_day",
];
pub const DAILY_FIELDS: [&str; 7] = [
    "et0_fao_evapotranspiration",
    "precipitation_sum",
    "precipitation_probability_max",
    "temperature_2m_max",
    "temperature_2m_min",
    "wind_speed_10m_max",
    "wind_gusts_10m_max",
];
pub const PAST_DAYS: u32 = 30;
pub const FORECAST_DAYS: u32 = 16;
/// The raw Open-Meteo payload is cached this long per 0.05° cell.
pub const DATA_CACHE_TTL_SECONDS: u64 = 3600;
pub const ATTRIBUTION: &str = "Soil, evapotranspiration and forecast data: Open-Meteo (ECMWF, NOAA, DWD and others; CC BY 4.0). Windows and risks are rules of thumb computed by mukoko weather, not agronomic prescriptions.";

// Spraying: drift below 3 km/h (inversions) and above 15 km/h; rain within
// 2 h washes product off; hot dry air volatilises it.
const SPRAY_WIND_MIN_KMH: f64 = 3.0;
const SPRAY_WIND_MAX_KMH: f64 = 15.0;
const SPRAY_GUST_MAX_KMH: f64 = 25.0;
const SPRAY_TEMP_MIN_C: f64 = 8.0;
const SPRAY_TEMP_MAX_C: f64 = 30.0;
const SPRAY_RH_MIN: f64 = 35.0;
const SPRAY_RAIN_FREE_HOURS: usize = 2;
const SPRAY_RAIN_MM: f64 = 0.1;
const SPRAY_RAIN_PROB: f64 = 30.0;
const SPRAY_MIN_WINDOW_HOURS: usize = 2;
const SPRAY_LOOKAHEAD_HOURS: usize = 48;

// Planting: soil warm enough to germinate and moist enough, or an effective
// planting rain (25 mm across a few days).
const PLANT_SOIL_TEMP_MIN_C: f64 = 12.0;
const PLANT_MOISTURE_MIN: f64 = 0.20;
const PLANT_RAIN_MM: f64 = 25.0;
const PLANT_WASHOUT_MM: f64 = 40.0;

// Harvest / drying: dry days ahead.
const HARVEST_DRY_DAYS: usize = 3;
const HARVEST_RAIN_MM: f64 = 2.0;
const HARVEST_RAIN_PROB: f64 = 40.0;

// Irrigation: deficit of ET0 minus rain over the next 3 days.
const IRRIGATE_DEFICIT_GO_MM: f64 = 10.0;
const IRRIGATE_DEFICIT_WATCH_MM: f64 = 4.0;
const IRRIGATE_DRY_TOPSOIL: f64 = 0.15;

// Water balance over the next 7 days (rain - ET0, mm).
const BALANCE_DEFICIT_MM: f64 = -10.0;
const BALANCE_SURPLUS_MM: f64 = 10.0;

/// Volumetric soil water (m3/m3). Approximate: texture dependent.
const MOISTURE_BANDS: [(f64, &str); 4] = [
    (0.38, "saturated"),
    (0.25, "moist"),
    (0.15, "adequate"),
    (0.0, "dry"),
];

const FROST_HIGH_C: f64 = 2.0;
const FROST_POSSIBLE_C: f64 = 4.0;
const HEAT_HIGH_C: f64 = 35.0;
const HEAT_MODERATE_C: f64 = 32.0;

pub const GDD_BASE_C: f64 = 10.0;
pub const GDD_CAP_C: f64 = 30.0;

/// Farming activity ids that are crops (used to ask the profile for them).
pub const CALENDAR_CROPS: [&str; 5] = [
    "crop-farming",
    "tobacco-farming",
    "cotton-farming",
    "horticulture",
    "gardening",
];
pub const DEFAULT_CROP: &str = "crop-farming";
const STAGES: [&str; 4] = ["nursery", "plant", "grow", "harvest"];

/// The one batched Open-Meteo request (past 30 days, next 16, hourly block
/// trimmed to now to +16 d).
pub fn forecast_url(base: &str, lat: f64, lon: f64) -> String {
    let hourly: Vec<&str> = SOIL_MOISTURE_FIELDS
        .iter()
        .chain(SOIL_TEMPERATURE_FIELDS.iter())
        .chain(OTHER_HOURLY.iter())
        .copied()
        .collect();
    format!(
        "{base}/v1/forecast?latitude={lat}&longitude={lon}&hourly={}&daily={}&past_days={PAST_DAYS}&forecast_days={FORECAST_DAYS}&past_hours=1&forecast_hours={}&timezone=auto",
        hourly.join(","),
        DAILY_FIELDS.join(","),
        FORECAST_DAYS * 24
    )
}

/// KV key of the raw payload: the 0.05° cell, as `weather_cache_key` did.
pub fn cache_key(lat: f64, lon: f64) -> String {
    format!("agri:v1:{}", crate::geo::cell_key(lat, lon))
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/// `round(x, n)` as Python does it (correctly rounded, ties to even on the
/// exact binary value).
pub fn round_py(v: f64, n: usize) -> f64 {
    format!("{v:.n$}").parse().unwrap_or(v)
}

fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        _ => None,
    }
}

fn series(block: &Value, name: &str) -> Vec<Option<f64>> {
    block[name]
        .as_array()
        .map(|a| a.iter().map(num).collect())
        .unwrap_or_default()
}

fn at(seq: &[Option<f64>], i: usize) -> Option<f64> {
    seq.get(i).copied().flatten()
}

/// Python 3.12's `sum()` of floats: Neumaier compensated summation.
pub fn py_sum(values: &[f64]) -> f64 {
    let (mut total, mut c) = (0.0f64, 0.0f64);
    for &x in values {
        let t = total + x;
        if total.abs() >= x.abs() {
            c += (total - t) + x;
        } else {
            c += (x - t) + total;
        }
        total = t;
    }
    if c != 0.0 && c.is_finite() {
        total += c;
    }
    total
}

fn sum(values: impl IntoIterator<Item = Option<f64>>) -> Option<f64> {
    let clean: Vec<f64> = values.into_iter().flatten().collect();
    if clean.is_empty() {
        None
    } else {
        Some(round_py(py_sum(&clean), 1))
    }
}

fn mean(values: &[Option<f64>], digits: usize) -> Option<f64> {
    let clean: Vec<f64> = values.iter().flatten().copied().collect();
    if clean.is_empty() {
        None
    } else {
        Some(round_py(py_sum(&clean) / clean.len() as f64, digits))
    }
}

pub fn moisture_band(value: Option<f64>) -> Option<&'static str> {
    let v = value?;
    for (floor, band) in MOISTURE_BANDS {
        if v >= floor {
            return Some(band);
        }
    }
    Some("dry")
}

fn hhmm(iso: &str) -> &str {
    if iso.len() >= 16 {
        iso.get(11..16).unwrap_or(iso)
    } else {
        iso
    }
}

fn date_part(iso: &str) -> &str {
    iso.get(..10).unwrap_or(iso)
}

fn day_label(iso: &str, today: &str) -> String {
    let date = date_part(iso);
    if date == today {
        return "today".into();
    }
    let (Ok(d), Ok(t)) = (
        NaiveDate::parse_from_str(date, "%Y-%m-%d"),
        NaiveDate::parse_from_str(today, "%Y-%m-%d"),
    ) else {
        return date.to_owned();
    };
    if (d - t).num_days() == 1 {
        return "tomorrow".into();
    }
    d.format("%a %d").to_string().replace(" 0", " ")
}

/// GDD for one day: both extremes clamped into `[base, cap]` before
/// averaging (the standard maize method).
pub fn growing_degree_days(
    tmax: Option<f64>,
    tmin: Option<f64>,
    base: f64,
    cap: f64,
) -> Option<f64> {
    let (tmax, tmin) = (tmax?, tmin?);
    let hi = tmax.max(base).min(cap);
    let lo = tmin.max(base).min(cap);
    Some(round_py(((hi + lo) / 2.0 - base).max(0.0), 1))
}

// ---------------------------------------------------------------------------
// Output shapes (the Pydantic `AgricultureResponse`, field for field)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TimeWindow {
    pub start: String,
    pub end: String,
    pub hours: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FarmWindow {
    pub status: &'static str,
    pub label: String,
    pub detail: String,
    pub window: Option<TimeWindow>,
}

fn fw(status: &'static str, label: impl Into<String>, detail: impl Into<String>) -> FarmWindow {
    FarmWindow {
        status,
        label: label.into(),
        detail: detail.into(),
        window: None,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct FarmWindows {
    pub spray: FarmWindow,
    pub plant: FarmWindow,
    pub harvest: FarmWindow,
    pub irrigate: FarmWindow,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RainSummary {
    #[serde(rename = "next24hMm")]
    pub next24h_mm: Option<f64>,
    #[serde(rename = "next7dMm")]
    pub next7d_mm: Option<f64>,
    #[serde(rename = "next16dMm")]
    pub next16d_mm: Option<f64>,
    #[serde(rename = "past7dMm")]
    pub past7d_mm: Option<f64>,
    #[serde(rename = "past30dMm")]
    pub past30d_mm: Option<f64>,
    pub rainy_days_next7: usize,
    pub next_rain_date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoilSummary {
    pub moisture_topsoil: Option<f64>,
    pub moisture_root_zone: Option<f64>,
    pub moisture_band: Option<&'static str>,
    pub temperature_surface: Option<f64>,
    pub temperature_seed_depth: Option<f64>,
    pub temperature_root_zone: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WaterBalance {
    #[serde(rename = "et0Next7dMm")]
    pub et0_next7d_mm: Option<f64>,
    #[serde(rename = "rainNext7dMm")]
    pub rain_next7d_mm: Option<f64>,
    #[serde(rename = "balanceNext7dMm")]
    pub balance_next7d_mm: Option<f64>,
    #[serde(rename = "et0Past7dMm")]
    pub et0_past7d_mm: Option<f64>,
    #[serde(rename = "rainPast7dMm")]
    pub rain_past7d_mm: Option<f64>,
    #[serde(rename = "balancePast7dMm")]
    pub balance_past7d_mm: Option<f64>,
    pub status: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GddSummary {
    pub base: f64,
    pub cap: f64,
    pub today: Option<f64>,
    #[serde(rename = "past30d")]
    pub past30d: Option<f64>,
    #[serde(rename = "next7d")]
    pub next7d: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Risk {
    pub level: &'static str,
    pub days: Vec<String>,
    pub extreme_c: Option<f64>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Risks {
    pub frost: Risk,
    pub heat: Risk,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindSummary {
    pub speed_kmh: Option<f64>,
    pub gust_kmh: Option<f64>,
    pub sprayable: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgriDay {
    pub date: String,
    pub forecast: bool,
    pub rain_mm: Option<f64>,
    pub rain_probability: Option<f64>,
    pub et0_mm: Option<f64>,
    pub balance_mm: Option<f64>,
    pub t_max: Option<f64>,
    pub t_min: Option<f64>,
    pub wind_max_kmh: Option<f64>,
    pub gdd: Option<f64>,
    pub gdd_cumulative: Option<f64>,
    #[serde(rename = "soilMoisture0to1")]
    pub soil_moisture_0to1: Option<f64>,
    #[serde(rename = "soilMoisture1to3")]
    pub soil_moisture_1to3: Option<f64>,
    #[serde(rename = "soilMoisture3to9")]
    pub soil_moisture_3to9: Option<f64>,
    #[serde(rename = "soilMoisture9to27")]
    pub soil_moisture_9to27: Option<f64>,
    #[serde(rename = "soilMoisture27to81")]
    pub soil_moisture_27to81: Option<f64>,
    pub soil_temp0: Option<f64>,
    pub soil_temp6: Option<f64>,
    pub soil_temp18: Option<f64>,
    pub soil_temp54: Option<f64>,
    pub vpd_max_kpa: Option<f64>,
    pub leaf_wet_hours: Option<usize>,
    pub spray_hours: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeasonModel {
    pub name: String,
    pub local_name: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CropCalendar {
    pub id: String,
    pub label: String,
    pub phase: Option<String>,
    pub months: BTreeMap<String, Vec<i64>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileContext {
    pub koppen: Option<String>,
    pub normal_high: Option<f64>,
    pub normal_low: Option<f64>,
    pub enso_phase: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgricultureResponse {
    pub available: bool,
    pub reason: Option<String>,
    pub headline: Option<String>,
    pub verdict: Option<&'static str>,
    pub windows: Option<FarmWindows>,
    pub rain: Option<RainSummary>,
    pub soil: Option<SoilSummary>,
    pub water_balance: Option<WaterBalance>,
    pub gdd: Option<GddSummary>,
    pub risks: Option<Risks>,
    pub wind: Option<WindSummary>,
    pub spray_windows: Vec<TimeWindow>,
    pub daily: Vec<AgriDay>,
    pub season: Option<SeasonModel>,
    pub calendar: Vec<CropCalendar>,
    pub profile: Option<ProfileContext>,
    pub crops: Vec<String>,
    pub timezone: Option<String>,
    pub utc_offset_seconds: Option<i64>,
    pub elevation: Option<f64>,
    pub attribution: &'static str,
    pub fetched_at: String,
}

/// `available: false` with a reason (provider_unavailable, provider_error,
/// insufficient_data, analysis_error).
pub fn unavailable(reason: &str, now: DateTime<Utc>) -> AgricultureResponse {
    AgricultureResponse {
        available: false,
        reason: Some(reason.to_owned()),
        headline: None,
        verdict: None,
        windows: None,
        rain: None,
        soil: None,
        water_balance: None,
        gdd: None,
        risks: None,
        wind: None,
        spray_windows: vec![],
        daily: vec![],
        season: None,
        calendar: vec![],
        profile: None,
        crops: vec![],
        timezone: None,
        utc_offset_seconds: None,
        elevation: None,
        attribution: ATTRIBUTION,
        fetched_at: iso(now),
    }
}

/// `datetime.isoformat()` of a UTC instant.
pub fn iso(now: DateTime<Utc>) -> String {
    let s = now.to_rfc3339_opts(SecondsFormat::Micros, false);
    // Python omits the fraction when it is zero.
    s.replace(".000000+", "+")
}

// ---------------------------------------------------------------------------
// Hourly spraying
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Hour {
    time: String,
    temp: Option<f64>,
    rh: Option<f64>,
    wind: Option<f64>,
    gust: Option<f64>,
    rain: Option<f64>,
    rain_prob: Option<f64>,
    is_day: bool,
    #[allow(dead_code)]
    leaf_wet: Option<f64>,
}

fn hours_from(hourly: &Value) -> Vec<Hour> {
    let times: Vec<String> = hourly["time"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|t| t.as_str().map_or_else(|| t.to_string(), str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let temp = series(hourly, "temperature_2m");
    let rh = series(hourly, "relative_humidity_2m");
    let wind = series(hourly, "wind_speed_10m");
    let gust = series(hourly, "wind_gusts_10m");
    let rain = series(hourly, "precipitation");
    let prob = series(hourly, "precipitation_probability");
    let day = series(hourly, "is_day");
    let wet = series(hourly, "leaf_wetness_probability");
    times
        .into_iter()
        .enumerate()
        .map(|(i, t)| Hour {
            time: t,
            temp: at(&temp, i),
            rh: at(&rh, i),
            wind: at(&wind, i),
            gust: at(&gust, i),
            rain: at(&rain, i),
            rain_prob: at(&prob, i),
            is_day: at(&day, i).unwrap_or(0.0) >= 1.0,
            leaf_wet: at(&wet, i),
        })
        .collect()
}

fn wet_hour(h: &Hour) -> bool {
    h.rain.is_some_and(|r| r >= SPRAY_RAIN_MM) || h.rain_prob.is_some_and(|p| p >= SPRAY_RAIN_PROB)
}

fn spray_hour_ok(hours: &[Hour], i: usize) -> bool {
    let h = &hours[i];
    let (Some(wind), Some(temp)) = (h.wind, h.temp) else {
        return false;
    };
    if !h.is_day {
        return false;
    }
    if !(SPRAY_WIND_MIN_KMH..=SPRAY_WIND_MAX_KMH).contains(&wind) {
        return false;
    }
    if h.gust.is_some_and(|g| g > SPRAY_GUST_MAX_KMH) {
        return false;
    }
    if !(SPRAY_TEMP_MIN_C..=SPRAY_TEMP_MAX_C).contains(&temp) {
        return false;
    }
    if h.rh.is_some_and(|r| r < SPRAY_RH_MIN) {
        return false;
    }
    let end = (i + SPRAY_RAIN_FREE_HOURS + 1).min(hours.len());
    !hours[i..end].iter().any(wet_hour)
}

fn add_hour(iso: &str) -> String {
    match iso
        .get(..16)
        .and_then(|s| NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M").ok())
    {
        Some(d) => (d + Duration::hours(1))
            .format("%Y-%m-%dT%H:%M")
            .to_string(),
        None => iso.to_owned(),
    }
}

fn spray_windows(hours: &[Hour], start: usize) -> Vec<TimeWindow> {
    let mut out = Vec::new();
    let mut run_start: Option<usize> = None;
    let end = hours.len().min(start + SPRAY_LOOKAHEAD_HOURS);
    for i in start..=end {
        let ok = i < end && spray_hour_ok(hours, i);
        if ok && run_start.is_none() {
            run_start = Some(i);
        } else if !ok {
            if let Some(rs) = run_start.take() {
                let length = i - rs;
                if length >= SPRAY_MIN_WINDOW_HOURS {
                    out.push(TimeWindow {
                        start: hours[rs].time.clone(),
                        end: add_hour(&hours[i - 1].time),
                        hours: length,
                    });
                }
            }
        }
    }
    out
}

fn spray_window(windows: &[TimeWindow], today: &str, hours: &[Hour], start: usize) -> FarmWindow {
    if let Some(first) = windows.first() {
        let when = day_label(&first.start, today);
        let label = format!("Spray {when} {}–{}", hhmm(&first.start), hhmm(&first.end));
        let status = if date_part(&first.start) == today {
            "go"
        } else {
            "wait"
        };
        let detail = format!(
            "Light, steady wind and no rain for at least {SPRAY_RAIN_FREE_HOURS} h after. Next good window: {when}, {} h.",
            first.hours
        );
        return FarmWindow {
            status,
            label,
            detail,
            window: Some(first.clone()),
        };
    }
    let upper = hours.len().min(start + SPRAY_LOOKAHEAD_HOURS);
    let ahead: Vec<&Hour> = hours
        .get(start..upper)
        .unwrap_or(&[])
        .iter()
        .filter(|h| h.is_day)
        .collect();
    let reason = if ahead.iter().any(|h| wet_hour(h)) {
        "rain is likely to wash product off".to_owned()
    } else if ahead
        .iter()
        .any(|h| h.wind.is_some_and(|w| w > SPRAY_WIND_MAX_KMH))
    {
        format!("wind above {SPRAY_WIND_MAX_KMH:.0} km/h will cause drift")
    } else if ahead
        .iter()
        .any(|h| h.temp.is_some_and(|t| t > SPRAY_TEMP_MAX_C))
    {
        "heat will volatilise product".to_owned()
    } else {
        "conditions stay outside the safe range".to_owned()
    };
    fw(
        "avoid",
        "No spray window in 48 h",
        format!("Hold off: {reason}."),
    )
}

// ---------------------------------------------------------------------------
// Daily aggregation
// ---------------------------------------------------------------------------

fn hourly_by_date(hourly: &Value, field: &str) -> BTreeMap<String, Vec<Option<f64>>> {
    let times: Vec<String> = hourly["time"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|t| t.as_str().map_or_else(|| t.to_string(), str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let values = series(hourly, field);
    let mut out: BTreeMap<String, Vec<Option<f64>>> = BTreeMap::new();
    for (i, t) in times.iter().enumerate() {
        out.entry(date_part(t).to_owned())
            .or_default()
            .push(at(&values, i));
    }
    out
}

fn build_daily(raw: &Value, today: &str, hours: &[Hour], start: usize) -> Vec<AgriDay> {
    let daily = &raw["daily"];
    let hourly = &raw["hourly"];
    let dates: Vec<String> = daily["time"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|t| t.as_str().map_or_else(|| t.to_string(), str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let rain = series(daily, "precipitation_sum");
    let prob = series(daily, "precipitation_probability_max");
    let et0 = series(daily, "et0_fao_evapotranspiration");
    let tmax = series(daily, "temperature_2m_max");
    let tmin = series(daily, "temperature_2m_min");
    let wmax = series(daily, "wind_speed_10m_max");

    let moisture: Vec<_> = SOIL_MOISTURE_FIELDS
        .iter()
        .map(|f| hourly_by_date(hourly, f))
        .collect();
    let soil_t: Vec<_> = SOIL_TEMPERATURE_FIELDS
        .iter()
        .map(|f| hourly_by_date(hourly, f))
        .collect();
    let vpd = hourly_by_date(hourly, "vapour_pressure_deficit");
    let wet = hourly_by_date(hourly, "leaf_wetness_probability");

    let mut spray_by_date: BTreeMap<String, usize> = BTreeMap::new();
    for i in start..hours.len() {
        if spray_hour_ok(hours, i) {
            *spray_by_date
                .entry(date_part(&hours[i].time).to_owned())
                .or_default() += 1;
        }
    }

    let empty: Vec<Option<f64>> = Vec::new();
    let mut out = Vec::new();
    let mut cumulative = 0.0;
    for (i, date) in dates.iter().enumerate() {
        let is_forecast = date.as_str() >= today;
        let (r, e) = (at(&rain, i), at(&et0, i));
        let gdd = growing_degree_days(at(&tmax, i), at(&tmin, i), GDD_BASE_C, GDD_CAP_C);
        if let Some(g) = gdd {
            cumulative += g;
        }
        let vpd_vals: Vec<f64> = vpd
            .get(date)
            .unwrap_or(&empty)
            .iter()
            .flatten()
            .copied()
            .collect();
        let wet_vals = wet.get(date).unwrap_or(&empty);
        let hourly_seen = vpd.contains_key(date) || wet.contains_key(date);
        let m = |k: usize| mean(moisture[k].get(date).unwrap_or(&empty), 3);
        let st = |k: usize| mean(soil_t[k].get(date).unwrap_or(&empty), 1);
        out.push(AgriDay {
            date: date.clone(),
            forecast: is_forecast,
            rain_mm: r,
            rain_probability: at(&prob, i),
            et0_mm: e,
            balance_mm: match (r, e) {
                (Some(r), Some(e)) => Some(round_py(r - e, 1)),
                _ => None,
            },
            t_max: at(&tmax, i),
            t_min: at(&tmin, i),
            wind_max_kmh: at(&wmax, i),
            gdd,
            gdd_cumulative: gdd.map(|_| round_py(cumulative, 1)),
            soil_moisture_0to1: m(0),
            soil_moisture_1to3: m(1),
            soil_moisture_3to9: m(2),
            soil_moisture_9to27: m(3),
            soil_moisture_27to81: m(4),
            soil_temp0: st(0),
            soil_temp6: st(1),
            soil_temp18: st(2),
            soil_temp54: st(3),
            vpd_max_kpa: vpd_vals
                .iter()
                .copied()
                .reduce(f64::max)
                .map(|v| round_py(v, 2)),
            leaf_wet_hours: hourly_seen.then(|| {
                wet_vals
                    .iter()
                    .filter(|v| v.is_some_and(|x| x >= 50.0))
                    .count()
            }),
            spray_hours: hourly_seen.then(|| spray_by_date.get(date).copied().unwrap_or(0)),
        });
    }
    out
}

// ---------------------------------------------------------------------------
// Summaries and windows
// ---------------------------------------------------------------------------

fn split<'a>(days: &'a [AgriDay], today: &str) -> (Vec<&'a AgriDay>, Vec<&'a AgriDay>) {
    let past = days.iter().filter(|d| d.date.as_str() < today).collect();
    let ahead = days.iter().filter(|d| d.date.as_str() >= today).collect();
    (past, ahead)
}

fn tail<T>(v: &[T], n: usize) -> &[T] {
    &v[v.len().saturating_sub(n)..]
}

fn head<T>(v: &[T], n: usize) -> &[T] {
    &v[..v.len().min(n)]
}

fn rain_summary(days: &[AgriDay], hours: &[Hour], start: usize, today: &str) -> RainSummary {
    let (past, ahead) = split(days, today);
    let upper = hours.len().min(start + 24);
    let next24 = sum(hours
        .get(start..upper)
        .unwrap_or(&[])
        .iter()
        .map(|h| h.rain));
    let next_rain = ahead
        .iter()
        .find(|d| d.rain_mm.unwrap_or(0.0) >= 1.0)
        .map(|d| d.date.clone());
    RainSummary {
        next24h_mm: next24,
        next7d_mm: sum(head(&ahead, 7).iter().map(|d| d.rain_mm)),
        next16d_mm: sum(ahead.iter().map(|d| d.rain_mm)),
        past7d_mm: sum(tail(&past, 7).iter().map(|d| d.rain_mm)),
        past30d_mm: sum(tail(&past, 30).iter().map(|d| d.rain_mm)),
        rainy_days_next7: head(&ahead, 7)
            .iter()
            .filter(|d| d.rain_mm.unwrap_or(0.0) >= 1.0)
            .count(),
        next_rain_date: next_rain,
    }
}

fn soil_summary(hourly: &Value, start: usize) -> SoilSummary {
    let now = |field: &str| -> Option<f64> {
        let values = series(hourly, field);
        let upper = values.len().min(start + 6);
        values
            .get(start..upper)
            .unwrap_or(&[])
            .iter()
            .flatten()
            .next()
            .copied()
    };
    let top = mean(
        &[
            now("soil_moisture_0_to_1cm"),
            now("soil_moisture_1_to_3cm"),
            now("soil_moisture_3_to_9cm"),
        ],
        3,
    );
    let root = mean(
        &[
            now("soil_moisture_9_to_27cm"),
            now("soil_moisture_27_to_81cm"),
        ],
        3,
    );
    SoilSummary {
        moisture_topsoil: top,
        moisture_root_zone: root,
        moisture_band: moisture_band(top),
        temperature_surface: now("soil_temperature_0cm"),
        temperature_seed_depth: now("soil_temperature_6cm"),
        temperature_root_zone: now("soil_temperature_18cm"),
    }
}

fn water_balance(days: &[AgriDay], today: &str) -> WaterBalance {
    let (past, ahead) = split(days, today);
    let et_next = sum(head(&ahead, 7).iter().map(|d| d.et0_mm));
    let rain_next = sum(head(&ahead, 7).iter().map(|d| d.rain_mm));
    let et_past = sum(tail(&past, 7).iter().map(|d| d.et0_mm));
    let rain_past = sum(tail(&past, 7).iter().map(|d| d.rain_mm));
    let bal = |r: Option<f64>, e: Option<f64>| match (r, e) {
        (Some(r), Some(e)) => Some(round_py(r - e, 1)),
        _ => None,
    };
    let bal_next = bal(rain_next, et_next);
    let status = bal_next.map(|b| {
        if b < BALANCE_DEFICIT_MM {
            "deficit"
        } else if b > BALANCE_SURPLUS_MM {
            "surplus"
        } else {
            "balanced"
        }
    });
    WaterBalance {
        et0_next7d_mm: et_next,
        rain_next7d_mm: rain_next,
        balance_next7d_mm: bal_next,
        et0_past7d_mm: et_past,
        rain_past7d_mm: rain_past,
        balance_past7d_mm: bal(rain_past, et_past),
        status,
    }
}

fn gdd_summary(days: &[AgriDay], today: &str) -> GddSummary {
    let (past, ahead) = split(days, today);
    GddSummary {
        base: GDD_BASE_C,
        cap: GDD_CAP_C,
        today: ahead.first().and_then(|d| d.gdd),
        past30d: sum(tail(&past, 30).iter().map(|d| d.gdd)),
        next7d: sum(head(&ahead, 7).iter().map(|d| d.gdd)),
    }
}

fn f0(x: f64) -> String {
    format!("{x:.0}")
}

fn plant_window(soil: &SoilSummary, days: &[AgriDay], today: &str) -> FarmWindow {
    let (past, ahead) = split(days, today);
    let temp = soil.temperature_seed_depth;
    let moisture = soil.moisture_topsoil;
    let rain_around = sum(tail(&past, 3).iter().map(|d| d.rain_mm)).unwrap_or(0.0)
        + sum(head(&ahead, 3).iter().map(|d| d.rain_mm)).unwrap_or(0.0);
    let washout = head(&ahead, 2)
        .iter()
        .find(|d| d.rain_mm.unwrap_or(0.0) >= PLANT_WASHOUT_MM);
    let warm = temp.is_some_and(|t| t >= PLANT_SOIL_TEMP_MIN_C);
    let moist = moisture.is_some_and(|m| m >= PLANT_MOISTURE_MIN) || rain_around >= PLANT_RAIN_MM;

    if temp.is_none() && moisture.is_none() {
        return fw(
            "wait",
            "Soil data unavailable",
            "Check soil by hand before planting.",
        );
    }
    if let Some(w) = washout {
        return fw(
            "wait",
            "Wait: heavy rain coming",
            format!(
                "{} mm expected {} could wash out seed.",
                f0(w.rain_mm.unwrap_or(0.0)),
                day_label(&w.date, today)
            ),
        );
    }
    if warm && moist {
        return fw(
            "go",
            "Good planting conditions",
            format!(
                "Soil at seed depth {} °C and moisture adequate.",
                f0(temp.unwrap_or(0.0))
            ),
        );
    }
    if temp.is_none() && moist {
        return fw(
            "wait",
            "Moist soil, temperature unknown",
            "Moisture is adequate; check the soil is warm at seed depth before planting.",
        );
    }
    if let (false, Some(t)) = (warm, temp) {
        return fw(
            "avoid",
            "Soil too cold to plant",
            format!(
                "Seed-depth soil is {} °C; wait for {} °C.",
                f0(t),
                f0(PLANT_SOIL_TEMP_MIN_C)
            ),
        );
    }
    let nxt = head(&ahead, 7)
        .iter()
        .find(|d| d.rain_mm.unwrap_or(0.0) >= 10.0);
    let when = nxt
        .map(|d| format!(" Next useful rain: {}.", day_label(&d.date, today)))
        .unwrap_or_default();
    fw(
        "wait",
        "Wait for planting rains",
        format!(
            "Topsoil is dry; dry planting risks poor emergence (about {} mm needed).{when}",
            f0(PLANT_RAIN_MM)
        ),
    )
}

fn harvest_window(days: &[AgriDay], today: &str) -> FarmWindow {
    let (_, ahead) = split(days, today);
    let nxt = head(&ahead, HARVEST_DRY_DAYS);
    if nxt.is_empty() {
        return fw(
            "wait",
            "Forecast unavailable",
            "No daily forecast to judge drying.",
        );
    }
    let dry = |d: &AgriDay| {
        d.rain_mm.unwrap_or(0.0) < HARVEST_RAIN_MM
            && d.rain_probability.unwrap_or(0.0) < HARVEST_RAIN_PROB
    };
    let mut dry_run = 0;
    for d in nxt {
        if !dry(d) {
            break;
        }
        dry_run += 1;
    }
    if dry_run >= HARVEST_DRY_DAYS {
        return fw(
            "go",
            format!("{HARVEST_DRY_DAYS} dry days ahead"),
            "Good for harvesting and drying grain or curing.",
        );
    }
    if dry_run >= nxt.len() {
        return fw("go", "Dry days ahead", "Good for harvesting and drying.");
    }
    if dry_run >= 1 {
        let wet = nxt[dry_run];
        return fw(
            "wait",
            format!("Dry until {}", day_label(&wet.date, today)),
            "Harvest what you can and cover drying crops before the rain.",
        );
    }
    fw(
        "avoid",
        "Rain today",
        "Keep harvested crops covered; wait for a dry spell.",
    )
}

fn irrigate_window(soil: &SoilSummary, days: &[AgriDay], today: &str) -> FarmWindow {
    let (_, ahead) = split(days, today);
    let et3 = sum(head(&ahead, 3).iter().map(|d| d.et0_mm));
    let rain3 = sum(head(&ahead, 3).iter().map(|d| d.rain_mm)).unwrap_or(0.0);
    let Some(et3) = et3 else {
        return fw(
            "wait",
            "ET₀ unavailable",
            "Water by soil feel until data returns.",
        );
    };
    let deficit = round_py(et3 - rain3, 1);
    let dry_top = soil
        .moisture_topsoil
        .is_some_and(|m| m < IRRIGATE_DRY_TOPSOIL);
    if deficit >= IRRIGATE_DEFICIT_GO_MM || (dry_top && deficit > 0.0) {
        return fw(
            "go",
            format!("Irrigate: {} mm deficit", f0(deficit)),
            format!(
                "Crops lose about {} mm over 3 days and rain adds {} mm. Water early morning.",
                f0(et3),
                f0(rain3)
            ),
        );
    }
    if deficit >= IRRIGATE_DEFICIT_WATCH_MM {
        return fw(
            "wait",
            format!("Light deficit ({} mm)", f0(deficit)),
            "Irrigate sensitive crops; field crops can wait a day.",
        );
    }
    fw(
        "avoid",
        "No irrigation needed",
        format!("Rain ({} mm) covers crop water use over 3 days.", f0(rain3)),
    )
}

fn frost_risk(days: &[AgriDay], today: &str) -> Risk {
    let (_, ahead) = split(days, today);
    let week: Vec<&AgriDay> = head(&ahead, 7)
        .iter()
        .copied()
        .filter(|d| d.t_min.is_some())
        .collect();
    if week.is_empty() {
        return Risk {
            level: "none",
            days: vec![],
            extreme_c: None,
            detail: "No temperature forecast.".into(),
        };
    }
    let t = |d: &AgriDay| d.t_min.unwrap_or(0.0);
    let mut coldest = week[0];
    for d in &week {
        if t(d) < t(coldest) {
            coldest = d;
        }
    }
    let ct = coldest.t_min;
    let high: Vec<&AgriDay> = week
        .iter()
        .copied()
        .filter(|d| t(d) <= FROST_HIGH_C)
        .collect();
    let possible: Vec<&AgriDay> = week
        .iter()
        .copied()
        .filter(|d| t(d) <= FROST_POSSIBLE_C)
        .collect();
    if let Some(first) = high.first() {
        return Risk {
            level: "high",
            days: high.iter().map(|d| d.date.clone()).collect(),
            extreme_c: ct,
            detail: format!(
                "Frost likely {} (low {} °C). Cover seedlings and irrigate the evening before.",
                day_label(&first.date, today),
                f0(t(first))
            ),
        };
    }
    if let Some(first) = possible.first() {
        return Risk {
            level: "moderate",
            days: possible.iter().map(|d| d.date.clone()).collect(),
            extreme_c: ct,
            detail: format!(
                "Ground frost possible in low-lying fields {} (low {} °C).",
                day_label(&first.date, today),
                f0(t(first))
            ),
        };
    }
    Risk {
        level: "none",
        days: vec![],
        extreme_c: ct,
        detail: format!(
            "No frost expected this week (lowest {} °C).",
            f0(ct.unwrap_or(0.0))
        ),
    }
}

fn heat_risk(days: &[AgriDay], today: &str) -> Risk {
    let (_, ahead) = split(days, today);
    let week: Vec<&AgriDay> = head(&ahead, 7)
        .iter()
        .copied()
        .filter(|d| d.t_max.is_some())
        .collect();
    if week.is_empty() {
        return Risk {
            level: "none",
            days: vec![],
            extreme_c: None,
            detail: "No temperature forecast.".into(),
        };
    }
    let t = |d: &AgriDay| d.t_max.unwrap_or(0.0);
    let mut hottest = week[0];
    for d in &week {
        if t(d) > t(hottest) {
            hottest = d;
        }
    }
    let ht = hottest.t_max;
    let high: Vec<&AgriDay> = week
        .iter()
        .copied()
        .filter(|d| t(d) >= HEAT_HIGH_C)
        .collect();
    let moderate: Vec<&AgriDay> = week
        .iter()
        .copied()
        .filter(|d| t(d) >= HEAT_MODERATE_C)
        .collect();
    if let Some(first) = high.first() {
        return Risk {
            level: "high",
            days: high.iter().map(|d| d.date.clone()).collect(),
            extreme_c: ht,
            detail: format!(
                "Crop heat stress {} (high {} °C). Irrigate early and shade livestock.",
                day_label(&first.date, today),
                f0(t(first))
            ),
        };
    }
    if let Some(first) = moderate.first() {
        return Risk {
            level: "moderate",
            days: moderate.iter().map(|d| d.date.clone()).collect(),
            extreme_c: ht,
            detail: format!(
                "Hot spell from {} (high {} °C); watch flowering crops and water stock.",
                day_label(&first.date, today),
                f0(t(first))
            ),
        };
    }
    Risk {
        level: "none",
        days: vec![],
        extreme_c: ht,
        detail: format!(
            "No heat stress this week (highest {} °C).",
            f0(ht.unwrap_or(0.0))
        ),
    }
}

fn wind_summary(hours: &[Hour], start: usize) -> WindSummary {
    let Some(h) = hours.get(start) else {
        return WindSummary {
            speed_kmh: None,
            gust_kmh: None,
            sprayable: false,
            detail: "No wind data.".into(),
        };
    };
    let ok = spray_hour_ok(hours, start);
    let detail = match h.wind {
        None => "No wind data.",
        Some(w) if w < SPRAY_WIND_MIN_KMH => "Calm: risk of temperature inversion and drift.",
        Some(w) if w > SPRAY_WIND_MAX_KMH => "Too windy to spray.",
        Some(_) if ok => "Wind in the spraying range.",
        Some(_) => "Wind is fine, but other conditions are not.",
    };
    WindSummary {
        speed_kmh: h.wind,
        gust_kmh: h.gust,
        sprayable: ok,
        detail: detail.into(),
    }
}

/// One deterministic sentence for the day and an overall go/wait/avoid.
fn headline_for(w: &FarmWindows, r: &Risks) -> (String, &'static str) {
    if r.frost.level == "high" {
        return ("Frost risk this week: protect seedlings.".into(), "avoid");
    }
    if r.heat.level == "high" {
        return ("Crop heat stress this week: irrigate early.".into(), "wait");
    }
    let mut go: Vec<&str> = Vec::new();
    for (k, win) in [
        ("spray", &w.spray),
        ("plant", &w.plant),
        ("harvest", &w.harvest),
    ] {
        if win.status == "go" {
            go.push(k);
        }
    }
    if w.irrigate.status == "go" {
        go.push("irrigate");
    }
    if let Some((last, rest)) = go.split_last() {
        let jobs = rest.join(", ");
        let jobs = if jobs.is_empty() {
            (*last).to_owned()
        } else {
            format!("{jobs} and {last}")
        };
        return (format!("Good day to {jobs}."), "go");
    }
    if [&w.spray, &w.plant, &w.harvest]
        .iter()
        .any(|win| win.status == "wait")
    {
        return (
            "Mixed day: check the windows before field work.".into(),
            "wait",
        );
    }
    ("Poor day for field work.".into(), "avoid")
}

// ---------------------------------------------------------------------------
// Season + calendar (mapped from the location profile's flat view)
// ---------------------------------------------------------------------------

/// Calendar crops from the user's activities, in order; maize by default.
pub fn normalise_crops(ids: &[String]) -> Vec<String> {
    let mut crops: Vec<String> = Vec::new();
    for id in ids {
        if CALENDAR_CROPS.contains(&id.as_str()) && !crops.contains(id) {
            crops.push(id.clone());
        }
    }
    if crops.is_empty() {
        crops.push(DEFAULT_CROP.to_owned());
    }
    crops
}

fn months(v: &Value) -> Vec<i64> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| m.as_i64().filter(|m| (1..=12).contains(m)))
                .collect()
        })
        .unwrap_or_default()
}

fn str_of(v: &Value) -> Option<String> {
    v.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

fn calendar_from_profile(profile: Option<&Value>, crops: &[String]) -> Vec<CropCalendar> {
    let entries = profile
        .and_then(|p| p["crops"].as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for crop in crops {
        let Some(e) = entries
            .iter()
            .rev()
            .find(|e| e["id"].as_str() == Some(crop.as_str()))
        else {
            continue;
        };
        let cal = &e["calendar"];
        let mut m = BTreeMap::new();
        for st in STAGES {
            let ms = months(&cal[st]);
            if !ms.is_empty() {
                m.insert(st.to_owned(), ms);
            }
        }
        out.push(CropCalendar {
            id: crop.clone(),
            label: str_of(&e["label"]).unwrap_or_else(|| crop.clone()),
            phase: str_of(&e["phase"]),
            months: m,
        });
    }
    out
}

/// Last-resort hemisphere season (the Python `_ai._hemisphere_fallback`).
pub fn hemisphere_season(lat: f64, month: u32) -> SeasonModel {
    let (name, desc) = if lat < 0.0 {
        match month {
            12 | 1 | 2 => ("Summer", "Warm season with possible thunderstorms."),
            3..=5 => ("Autumn", "Cooling temperatures, harvest period."),
            6..=8 => ("Winter", "Cool and dry with possible frost."),
            _ => ("Spring", "Warming temperatures, early rains possible."),
        }
    } else {
        match month {
            3..=5 => ("Spring", "Warming temperatures, new growth."),
            6..=8 => ("Summer", "Warmest season with longer days."),
            9..=11 => ("Autumn", "Cooling temperatures, shorter days."),
            _ => ("Winter", "Coldest season with shorter days."),
        }
    };
    SeasonModel {
        name: name.into(),
        local_name: name.into(),
        description: desc.into(),
    }
}

fn season_for(profile: Option<&Value>, lat: f64, month: u32) -> SeasonModel {
    if let Some(s) = profile.map(|p| &p["season"]) {
        if let Some(name) = str_of(&s["name"]) {
            return SeasonModel {
                local_name: str_of(&s["localName"]).unwrap_or_else(|| name.clone()),
                description: str_of(&s["description"]).unwrap_or_default(),
                name,
            };
        }
    }
    hemisphere_season(lat, month)
}

fn profile_context(profile: Option<&Value>) -> Option<ProfileContext> {
    let p = profile?;
    if p.is_null() || p.as_object().is_some_and(|o| o.is_empty()) {
        return None;
    }
    let ctx = ProfileContext {
        koppen: str_of(&p["koppen"]),
        normal_high: num(&p["normals"]["high"]),
        normal_low: num(&p["normals"]["low"]),
        enso_phase: str_of(&p["enso"]["phase"]),
    };
    (ctx.koppen.is_some()
        || ctx.normal_high.is_some()
        || ctx.normal_low.is_some()
        || ctx.enso_phase.is_some())
    .then_some(ctx)
}

// ---------------------------------------------------------------------------
// Analysis (pure)
// ---------------------------------------------------------------------------

fn start_index(hours: &[Hour], local_now: NaiveDateTime) -> usize {
    let key = local_now.format("%Y-%m-%dT%H").to_string();
    for (i, h) in hours.iter().enumerate() {
        if h.time.get(..13).unwrap_or(h.time.as_str()) >= key.as_str() {
            return i;
        }
    }
    0
}

/// Raw Open-Meteo payload to [`AgricultureResponse`]. No I/O.
pub fn analyse(
    raw: &Value,
    lat: f64,
    crops: &[String],
    profile: Option<&Value>,
    now: DateTime<Utc>,
) -> AgricultureResponse {
    let hourly = &raw["hourly"];
    let hours = hours_from(hourly);
    let daily = &raw["daily"];
    if hours.is_empty() || !daily["time"].as_array().is_some_and(|a| !a.is_empty()) {
        return unavailable("insufficient_data", now);
    }
    let offset = num(&raw["utc_offset_seconds"]).map_or(0, |o| o as i64);
    let local_now = now.naive_utc() + Duration::seconds(offset);
    let today = local_now.format("%Y-%m-%d").to_string();
    let start = start_index(&hours, local_now);

    let days = build_daily(raw, &today, &hours, start);
    let windows_list = spray_windows(&hours, start);
    let soil = soil_summary(hourly, start);
    let windows = FarmWindows {
        spray: spray_window(&windows_list, &today, &hours, start),
        plant: plant_window(&soil, &days, &today),
        harvest: harvest_window(&days, &today),
        irrigate: irrigate_window(&soil, &days, &today),
    };
    let risks = Risks {
        frost: frost_risk(&days, &today),
        heat: heat_risk(&days, &today),
    };
    let (headline, verdict) = headline_for(&windows, &risks);
    let crops = normalise_crops(crops);

    AgricultureResponse {
        available: true,
        reason: None,
        headline: Some(headline),
        verdict: Some(verdict),
        windows: Some(windows),
        rain: Some(rain_summary(&days, &hours, start, &today)),
        soil: Some(soil),
        water_balance: Some(water_balance(&days, &today)),
        gdd: Some(gdd_summary(&days, &today)),
        risks: Some(risks),
        wind: Some(wind_summary(&hours, start)),
        spray_windows: windows_list,
        daily: days,
        season: Some(season_for(profile, lat, now.month())),
        calendar: calendar_from_profile(profile, &crops),
        profile: profile_context(profile),
        crops,
        timezone: raw["timezone"].as_str().map(str::to_owned),
        utc_offset_seconds: num(&raw["utc_offset_seconds"]).map(|o| o as i64),
        elevation: num(&raw["elevation"]),
        attribution: ATTRIBUTION,
        fetched_at: iso(now),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rounds_like_python() {
        assert_eq!(round_py(2.675, 2), 2.67);
        assert_eq!(round_py(0.25, 1), 0.2);
        assert_eq!(round_py(0.35, 1), 0.3);
        assert_eq!(f0(2.5), "2");
        assert_eq!(f0(3.5), "4");
        assert_eq!(f0(-0.4), "-0");
    }

    #[test]
    fn gdd_clamps() {
        assert_eq!(
            growing_degree_days(Some(35.0), Some(5.0), 10.0, 30.0),
            Some(10.0)
        );
        assert_eq!(
            growing_degree_days(Some(8.0), Some(2.0), 10.0, 30.0),
            Some(0.0)
        );
        assert_eq!(growing_degree_days(None, Some(2.0), 10.0, 30.0), None);
    }

    #[test]
    fn day_labels() {
        assert_eq!(day_label("2026-10-31T08:00", "2026-10-31"), "today");
        assert_eq!(day_label("2026-11-01", "2026-10-31"), "tomorrow");
        assert_eq!(day_label("2026-11-05", "2026-10-31"), "Thu 5");
        assert_eq!(day_label("2026-11-12", "2026-10-31"), "Thu 12");
        assert_eq!(day_label("nonsense", "2026-10-31"), "nonsense");
    }

    #[test]
    fn empty_payload_is_insufficient() {
        let now = DateTime::from_timestamp(1_793_000_000, 0).unwrap();
        let r = analyse(&json!({}), -17.8, &[], None, now);
        assert!(!r.available);
        assert_eq!(r.reason.as_deref(), Some("insufficient_data"));
    }

    #[test]
    fn crops_default_to_maize() {
        assert_eq!(normalise_crops(&[]), vec!["crop-farming"]);
        assert_eq!(
            normalise_crops(&[
                "cotton-farming".into(),
                "cotton-farming".into(),
                "soccer".into()
            ]),
            vec!["cotton-farming"]
        );
    }

    #[test]
    fn url_has_every_field() {
        let u = forecast_url("https://api.open-meteo.com", -17.8, 31.05);
        assert!(u.contains("soil_moisture_27_to_81cm"));
        assert!(u.contains("soil_temperature_54cm"));
        assert!(u.contains("past_days=30&forecast_days=16&past_hours=1&forecast_hours=384"));
    }

    /// Value equality that does not care whether a whole number was written as
    /// `5` or `5.0`.
    pub(crate) fn same(a: &Value, b: &Value, path: &str) -> Result<(), String> {
        match (a, b) {
            (Value::Number(x), Value::Number(y)) => {
                if x.as_f64() == y.as_f64() {
                    Ok(())
                } else {
                    Err(format!("{path}: {x} != {y}"))
                }
            }
            (Value::Array(x), Value::Array(y)) => {
                if x.len() != y.len() {
                    return Err(format!("{path}: length {} != {}", x.len(), y.len()));
                }
                for (i, (p, q)) in x.iter().zip(y).enumerate() {
                    same(p, q, &format!("{path}[{i}]"))?;
                }
                Ok(())
            }
            (Value::Object(x), Value::Object(y)) => {
                for k in x.keys().chain(y.keys()) {
                    match (x.get(k), y.get(k)) {
                        (Some(p), Some(q)) => same(p, q, &format!("{path}.{k}"))?,
                        _ => return Err(format!("{path}: key {k} on one side only")),
                    }
                }
                Ok(())
            }
            _ if a == b => Ok(()),
            _ => Err(format!("{path}: {a} != {b}")),
        }
    }

    /// The Python `analyse()` produced every `expected` in the fixture.
    #[test]
    fn matches_the_python_oracle() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/agriculture-analysis.json"
        ))
        .unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() >= 8);
        for c in cases {
            let now = DateTime::from_timestamp(c["nowEpoch"].as_i64().unwrap(), 0).unwrap();
            let crops: Vec<String> = c["crops"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_owned())
                .collect();
            let profile = (!c["profile"].is_null()).then_some(&c["profile"]);
            let got = analyse(&c["raw"], c["lat"].as_f64().unwrap(), &crops, profile, now);
            let got = serde_json::to_value(&got).unwrap();
            let name = c["name"].as_str().unwrap();
            if let Err(e) = same(&got, &c["expected"], name) {
                panic!("{e}");
            }
        }
    }
}
