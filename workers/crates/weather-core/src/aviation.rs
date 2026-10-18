//! Aviation weather: METAR and TAF decoding, flight categories, and the
//! nearest airports.
//!
//! Ported from `api/py/_metar.py` and `api/py/_airports.py`. METARs come from
//! the Aviation Weather Center (aviationweather.gov, free, no key), with
//! CheckWX as a fallback when a key is configured. The airport catalogue is
//! the app's (`src/lib/icao-codes.ts`), compiled in from
//! `data/airports.json`; regenerate it with
//! `workers/scripts/gen-seed-locations.mjs`.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::geo::haversine_km;

pub const AWC_METAR_URL: &str = "https://aviationweather.gov/api/data/metar";
pub const AWC_TAF_URL: &str = "https://aviationweather.gov/api/data/taf";
pub const CHECKWX_URL: &str = "https://api.checkwx.com/metar";

/// Cache lifetime for a METAR answer, as in Python: 30 minutes.
pub const METAR_CACHE_TTL_SECONDS: u64 = 1800;
/// Most airports one nearest-airports request may ask for.
pub const MAX_NEAREST: usize = 20;
/// The default nearest-airports radius, in km.
pub const DEFAULT_MAX_DISTANCE_KM: f64 = 500.0;

/// A four-letter ICAO code, upper-cased, or `None`.
pub fn normalize_icao(raw: &str) -> Option<String> {
    let code = raw.trim().to_ascii_uppercase();
    (code.len() == 4 && code.bytes().all(|b| b.is_ascii_uppercase())).then_some(code)
}

pub fn awc_metar_url(icao: &str) -> String {
    format!("{AWC_METAR_URL}?ids={icao}&format=json&hours=12")
}

pub fn awc_taf_url(icao: &str) -> String {
    format!("{AWC_TAF_URL}?ids={icao}&format=json")
}

pub fn checkwx_url(icao: &str) -> String {
    format!("{CHECKWX_URL}/{icao}/decoded")
}

pub fn cache_key(icao: &str) -> String {
    format!("avn:metar:v1:{icao}")
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CloudLayer {
    /// FEW, SCT, BKN, OVC, CLR or SKC.
    pub cover: String,
    pub base_ft: Option<i64>,
}

/// One decoded observation, in the shape `/api/py/metar` serves.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MetarObs {
    pub time: String,
    pub temp: Option<f64>,
    pub dewp: Option<f64>,
    pub wind_dir: Option<i64>,
    pub wind_speed: Option<i64>,
    pub wind_variable: bool,
    pub visibility: Option<String>,
    pub clouds: Vec<CloudLayer>,
    pub weather: Option<String>,
    pub pressure_hpa: Option<f64>,
    pub flight_category: String,
    pub change: Option<String>,
    pub raw: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MetarResponse {
    pub icao: String,
    pub metar: Vec<MetarObs>,
    pub taf: Option<String>,
    /// `awc` or `checkwx`.
    pub source: String,
}

const WX_LABELS: [(&str, &str); 26] = [
    ("DZ", "Drizzle"),
    ("RA", "Rain"),
    ("SN", "Snow"),
    ("GR", "Hail"),
    ("GS", "Small Hail"),
    ("FG", "Fog"),
    ("BR", "Mist"),
    ("HZ", "Haze"),
    ("DU", "Dust"),
    ("SA", "Sand"),
    ("TS", "Thunderstorm"),
    ("SQ", "Squall"),
    ("FC", "Funnel Cloud"),
    ("SS", "Sandstorm"),
    ("DS", "Dust Storm"),
    ("UP", "Unknown Precip"),
    ("FZRA", "Freezing Rain"),
    ("FZDZ", "Freezing Drizzle"),
    ("RASN", "Rain/Snow"),
    ("SNRA", "Snow/Rain"),
    ("SHRA", "Rain Showers"),
    ("SHSN", "Snow Showers"),
    ("TSRA", "Thunderstorm Rain"),
    ("TSSN", "Thunderstorm Snow"),
    ("VCSH", "Showers Nearby"),
    ("VCTS", "TS Nearby"),
];

const INTENSITY: [(&str, &str); 3] = [("-", "Light "), ("+", "Heavy "), ("VC", "Nearby ")];

/// `-RA` to `Light Rain`; unknown codes pass through. `None` when empty.
pub fn decode_wx(wx: Option<&str>) -> Option<String> {
    let wx = wx.filter(|s| !s.is_empty())?;
    let parts: Vec<String> = wx
        .split_whitespace()
        .map(|token| {
            let (prefix, code) = INTENSITY
                .iter()
                .find_map(|(p, label)| token.strip_prefix(p).map(|rest| (*label, rest)))
                .unwrap_or(("", token));
            let label = WX_LABELS
                .iter()
                .find(|(c, _)| *c == code)
                .map_or(code, |(_, l)| l);
            format!("{prefix}{label}").trim().to_owned()
        })
        .collect();
    Some(if parts.is_empty() {
        wx.to_owned()
    } else {
        parts.join(", ")
    })
}

/// Statute miles to the app's km string: `>10km`, or one decimal.
pub fn format_visibility(statute_miles: Option<f64>) -> Option<String> {
    let km = statute_miles? * 1.60934;
    Some(if km >= 10.0 {
        ">10km".to_owned()
    } else {
        format!("{km:.1}km")
    })
}

/// Parses a statute-mile fraction: `"3"`, `"1/2"`, `"1 1/2"`.
fn parse_fraction(s: &str) -> Option<f64> {
    let s = s.trim();
    if let Some((whole, frac)) = s.split_once(' ') {
        return Some(whole.parse::<f64>().ok()? + parse_fraction(frac)?);
    }
    if let Some((num, den)) = s.split_once('/') {
        let den: f64 = den.parse().ok()?;
        if den == 0.0 {
            return None;
        }
        return Some(num.parse::<f64>().ok()? / den);
    }
    s.parse::<f64>().ok()
}

/// AWC's `visib` is statute miles, usually a STRING: `"6+"`, `"10"`, `"1 1/2"`.
/// Returns the miles and whether it is the open-ended `N+` form.
pub fn parse_statute_miles(v: &Value) -> Option<(f64, bool)> {
    if let Some(x) = v.as_f64() {
        return x.is_finite().then_some((x, false));
    }
    let upper = v.as_str()?.trim().to_ascii_uppercase();
    let body = upper.strip_suffix("SM").unwrap_or(&upper).trim();
    let (body, plus) = match body.strip_suffix('+') {
        Some(rest) => (rest.trim(), true),
        None => (body, false),
    };
    parse_fraction(body)
        .filter(|m| m.is_finite())
        .map(|m| (m, plus))
}

/// AWC visibility to the app's km string. `"6+"` is more than 6 SM (~9.7 km)
/// and renders as `>9.7km`; anything at or beyond 10 km renders as `>10km`.
pub fn format_awc_visibility(v: &Value) -> Option<String> {
    let (miles, plus) = parse_statute_miles(v)?;
    let km = miles * 1.60934;
    Some(if km >= 10.0 {
        ">10km".to_owned()
    } else if plus {
        format!(">{km:.1}km")
    } else {
        format!("{km:.1}km")
    })
}

/// VFR, MVFR, IFR or LIFR from the ceiling (lowest BKN/OVC) and visibility.
pub fn flight_category(clouds: &[CloudLayer], visibility: Option<&str>) -> &'static str {
    let vis_km = visibility.and_then(|v| {
        v.trim_start_matches('>')
            .replace("km", "")
            .trim()
            .parse::<f64>()
            .ok()
    });
    let ceiling = clouds
        .iter()
        .filter(|c| c.cover == "BKN" || c.cover == "OVC")
        .filter_map(|c| c.base_ft)
        .min();
    let below =
        |ft: i64, km: f64| ceiling.is_some_and(|c| c < ft) || vis_km.is_some_and(|v| v < km);
    if below(500, 1.6) {
        "LIFR"
    } else if below(1000, 4.8) {
        "IFR"
    } else if below(3000, 8.0) {
        "MVFR"
    } else {
        "VFR"
    }
}

fn num(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
        .filter(|x: &f64| x.is_finite())
}

/// AWC's `obsTime` is epoch seconds; older answers carried ISO text. Either
/// way the app gets ISO 8601 with `+00:00`, as Python's `isoformat()` gave.
fn awc_time(obs: &Value) -> String {
    let t = if obs["obsTime"].is_null() {
        &obs["receiptTime"]
    } else {
        &obs["obsTime"]
    };
    if let Some(secs) = t.as_i64() {
        if let Some(dt) = chrono::DateTime::from_timestamp(secs, 0) {
            return dt.format("%Y-%m-%dT%H:%M:%S+00:00").to_string();
        }
    }
    let s = t.as_str().unwrap_or_default();
    match chrono::DateTime::parse_from_rfc3339(s) {
        Ok(dt) => dt
            .with_timezone(&chrono::Utc)
            .format("%Y-%m-%dT%H:%M:%S+00:00")
            .to_string(),
        Err(_) => s.to_owned(),
    }
}

/// One AWC METAR JSON object, decoded.
pub fn decode_awc_metar(obs: &Value) -> MetarObs {
    let clouds: Vec<CloudLayer> = obs["clouds"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|c| {
                    let cover = c["cover"].as_str().filter(|s| !s.is_empty())?;
                    Some(CloudLayer {
                        cover: cover.to_owned(),
                        base_ft: num(&c["base"]).map(|b| b as i64),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let visibility = format_awc_visibility(&obs["visib"]);

    let wdir = &obs["wdir"];
    let wind_variable = wdir.as_str().is_some_and(|s| s.eq_ignore_ascii_case("VRB"));
    let wind_dir = if wind_variable {
        None
    } else {
        num(wdir).map(|d| d as i64)
    };

    // Change indicators live in the raw report text (there is no remarks field).
    let text = format!(
        "{} {}",
        obs["rawOb"].as_str().unwrap_or_default(),
        obs["remarks"].as_str().unwrap_or_default()
    );
    let words: Vec<&str> = text.split(|c: char| !c.is_ascii_alphabetic()).collect();
    let has = |w: &str| words.contains(&w);
    let change = if has("NOSIG") {
        Some("No Significant Change")
    } else if has("BECMG") {
        Some("Becoming")
    } else if has("TEMPO") {
        Some("Temporary")
    } else {
        None
    };

    // AWC reports the altimeter in hPa (1024); legacy answers used inHg (30.2).
    let pressure_hpa = num(&obs["altim"]).filter(|a| *a != 0.0).map(|a| {
        let hpa = if a > 50.0 { a } else { a * 33.8639 };
        (hpa * 10.0).round() / 10.0
    });

    // The category key is `fltCat`; `flightCategory` is the older name.
    let category = match obs["fltCat"]
        .as_str()
        .or_else(|| obs["flightCategory"].as_str())
    {
        Some(c @ ("VFR" | "MVFR" | "IFR" | "LIFR")) => c.to_owned(),
        _ => flight_category(&clouds, visibility.as_deref()).to_owned(),
    };

    MetarObs {
        time: awc_time(obs),
        temp: num(&obs["temp"]),
        dewp: num(&obs["dewp"]),
        wind_dir,
        wind_speed: num(&obs["wspd"]).map(|s| s as i64),
        wind_variable,
        visibility,
        weather: decode_wx(obs["wxString"].as_str()),
        clouds,
        pressure_hpa,
        flight_category: category,
        change: change.map(str::to_owned),
        raw: obs["rawOb"].as_str().unwrap_or_default().to_owned(),
    }
}

/// An AWC METAR answer (a JSON array), decoded. Anything else is empty.
pub fn decode_awc_metars(body: &Value) -> Vec<MetarObs> {
    body.as_array()
        .map(|a| a.iter().map(decode_awc_metar).collect())
        .unwrap_or_default()
}

/// The raw TAF text from an AWC TAF answer.
pub fn awc_taf(body: &Value) -> Option<String> {
    body.as_array()?
        .first()?
        .get("rawTAF")?
        .as_str()
        .map(str::to_owned)
}

/// A CheckWX `/metar/{icao}/decoded` answer, decoded.
pub fn decode_checkwx(body: &Value) -> Vec<MetarObs> {
    let Some(rows) = body["data"].as_array() else {
        return Vec::new();
    };
    rows.iter()
        .map(|obs| {
            let clouds = obs["clouds"]["layers"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|c| CloudLayer {
                            cover: c["code"].as_str().unwrap_or_default().to_owned(),
                            base_ft: num(&c["feet"]).map(|f| f as i64),
                        })
                        .collect()
                })
                .unwrap_or_default();
            let visibility = num(&obs["visibility"]["meters_float"]).map(|m| {
                if m >= 9999.0 {
                    ">10km".to_owned()
                } else {
                    format!("{:.1}km", m / 1000.0)
                }
            });
            let wind = &obs["wind"];
            let wind_dir = num(&wind["degrees"]).map(|d| d as i64);
            MetarObs {
                time: obs["observed"].as_str().unwrap_or_default().to_owned(),
                temp: num(&obs["temperature"]["celsius"]),
                dewp: num(&obs["dewpoint"]["celsius"]),
                wind_dir,
                wind_speed: num(&wind["speed_kts"]).map(|s| s as i64),
                wind_variable: wind_dir.is_none(),
                visibility,
                clouds,
                weather: obs["conditions"][0]["text"].as_str().map(str::to_owned),
                pressure_hpa: num(&obs["barometer"]["hpa"]),
                flight_category: obs["flight_category"].as_str().unwrap_or("VFR").to_owned(),
                change: None,
                raw: obs["raw_text"].as_str().unwrap_or_default().to_owned(),
            }
        })
        .collect()
}

/// An airport in the catalogue.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Airport {
    pub icao: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
}

/// An airport with its distance from the query point.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NearbyAirport {
    pub icao: String,
    pub name: String,
    #[serde(rename = "distanceKm")]
    pub distance_km: f64,
}

static AIRPORTS_JSON: &str = include_str!("../data/airports.json");

/// The compiled-in airport catalogue.
pub fn airports() -> &'static [Airport] {
    static AIRPORTS: OnceLock<Vec<Airport>> = OnceLock::new();
    AIRPORTS.get_or_init(|| {
        serde_json::from_str(AIRPORTS_JSON).expect("airports.json is valid (checked in CI)")
    })
}

/// Up to `count` airports within `max_km`, closest first, with distances
/// rounded to 0.1 km.
pub fn nearest_airports(lat: f64, lon: f64, count: usize, max_km: f64) -> Vec<NearbyAirport> {
    let mut found: Vec<(f64, &Airport)> = airports()
        .iter()
        .map(|a| (haversine_km(lat, lon, a.lat, a.lon), a))
        .filter(|(d, _)| *d <= max_km)
        .collect();
    found.sort_by(|a, b| a.0.total_cmp(&b.0));
    found
        .into_iter()
        .take(count.min(MAX_NEAREST))
        .map(|(d, a)| NearbyAirport {
            icao: a.icao.clone(),
            name: a.name.clone(),
            distance_km: (d * 10.0).round() / 10.0,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Nearest airport with a recent report (ported from `api/py/_metar.py`)
// ---------------------------------------------------------------------------

pub const AWC_STATIONINFO_URL: &str = "https://aviationweather.gov/api/data/stationinfo";
pub const DEFAULT_RADIUS_KM: f64 = 150.0;
pub const DEFAULT_MAX_AGE_MIN: i64 = 180;
pub const NEAREST_MAX_COUNT: usize = 10;
/// A silent station is asked again after 2 minutes.
pub const METAR_EMPTY_CACHE_TTL_SECONDS: u64 = 120;
pub const DISCOVERY_CELL_DEG: f64 = 0.5;
/// A surveyed cell that held stations is remembered for 7 days; one that
/// held none for 6 hours.
pub const DISCOVERY_FOUND_TTL_SECONDS: u64 = 7 * 24 * 3600;
pub const DISCOVERY_EMPTY_TTL_SECONDS: u64 = 6 * 3600;
pub const DISCOVERY_RADIUS_BUCKETS_KM: [f64; 6] = [25.0, 50.0, 100.0, 150.0, 250.0, 500.0];

/// One batched AWC METAR request for many stations (last 12 h).
pub fn awc_batch_metar_url(icaos: &[String]) -> String {
    format!(
        "{AWC_METAR_URL}?ids={}&format=json&hours=12",
        icaos.join(",")
    )
}

/// Decode a batched AWC answer into one list per requested station (every
/// requested station appears; an empty list means AWC had no report).
pub fn metars_by_station(
    body: &Value,
    icaos: &[String],
) -> std::collections::HashMap<String, Vec<MetarObs>> {
    let mut grouped: std::collections::HashMap<String, Vec<MetarObs>> =
        icaos.iter().map(|i| (i.clone(), Vec::new())).collect();
    for obs in body.as_array().into_iter().flatten() {
        let id = obs["icaoId"]
            .as_str()
            .or_else(|| obs["stationId"].as_str())
            .unwrap_or_default()
            .to_ascii_uppercase();
        if let Some(list) = grouped.get_mut(&id) {
            list.push(decode_awc_metar(obs));
        }
    }
    grouped
}

/// The discovery grid cell centre a point belongs to.
pub fn discovery_cell(lat: f64, lon: f64) -> (f64, f64) {
    let snap = |v: f64| {
        let r = ((v / DISCOVERY_CELL_DEG).floor() + 0.5) * DISCOVERY_CELL_DEG;
        (r * 10_000.0).round_ties_even() / 10_000.0
    };
    (snap(lat), snap(lon))
}

/// The survey radius: `radius_km` rounded up to a bucket (never above the
/// largest). NaN, infinity and non-positive values take the smallest.
pub fn discovery_radius(radius_km: f64) -> f64 {
    if !radius_km.is_finite() || radius_km <= 0.0 {
        return DISCOVERY_RADIUS_BUCKETS_KM[0];
    }
    DISCOVERY_RADIUS_BUCKETS_KM
        .iter()
        .copied()
        .find(|b| radius_km <= *b)
        .unwrap_or(DISCOVERY_RADIUS_BUCKETS_KM[5])
}

/// `(min lat, min lon, max lat, max lon)` covering `radius_km` around every
/// point of the point's cell, clamped to WGS 84.
pub fn discovery_bbox(lat: f64, lon: f64, radius_km: f64) -> (f64, f64, f64, f64) {
    let (clat, clon) = discovery_cell(lat, lon);
    let half = DISCOVERY_CELL_DEG / 2.0;
    let dlat = radius_km / 111.0 + half;
    let cos_lat = (clat.abs() + half).min(89.0).to_radians().cos().max(0.01);
    let dlon = radius_km / (111.0 * cos_lat) + half;
    let r3 = |v: f64| (v * 1000.0).round_ties_even() / 1000.0;
    (
        r3((clat - dlat).max(-90.0)),
        r3((clon - dlon).max(-180.0)),
        r3((clat + dlat).min(90.0)),
        r3((clon + dlon).min(180.0)),
    )
}

/// The KV key remembering that a cell was surveyed.
pub fn discovery_key(lat: f64, lon: f64, radius_km: f64) -> String {
    let (clat, clon) = discovery_cell(lat, lon);
    format!(
        "avn:disc:v1:{clat:.2}_{clon:.2}_{}",
        discovery_radius(radius_km) as i64
    )
}

/// The AWC station-info request for a bbox.
pub fn awc_stationinfo_url(bbox: (f64, f64, f64, f64)) -> String {
    let g = |v: f64| format!("{v}");
    format!(
        "{AWC_STATIONINFO_URL}?bbox={},{},{},{}&format=json",
        g(bbox.0),
        g(bbox.1),
        g(bbox.2),
        g(bbox.3)
    )
}

/// A discovered METAR station.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Station {
    pub icao: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
}

/// Validated METAR stations from an AWC `stationinfo` answer: a four-letter
/// ICAO id, finite WGS 84 coordinates and `siteType` listing `METAR`.
/// Duplicates keep the first row.
pub fn parse_awc_stations(body: &Value) -> Vec<Station> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for row in body.as_array().into_iter().flatten() {
        let Some(icao) = row["icaoId"].as_str().and_then(normalize_icao) else {
            continue;
        };
        if seen.contains(&icao) {
            continue;
        }
        let has_metar = row["siteType"]
            .as_array()
            .is_some_and(|t| t.iter().any(|x| x.as_str() == Some("METAR")));
        if !has_metar {
            continue;
        }
        let (Some(lat), Some(lon)) = (row["lat"].as_f64(), row["lon"].as_f64()) else {
            continue;
        };
        if !lat.is_finite()
            || !lon.is_finite()
            || !(-90.0..=90.0).contains(&lat)
            || !(-180.0..=180.0).contains(&lon)
        {
            continue;
        }
        let name: String = row["site"]
            .as_str()
            .unwrap_or("")
            .trim()
            .chars()
            .take(120)
            .collect();
        seen.insert(icao.clone());
        out.push(Station {
            name: if name.is_empty() { icao.clone() } else { name },
            icao,
            lat,
            lon,
        });
    }
    out
}

/// The `count` stations nearest the point within `max_km`, closest first.
pub fn nearest_of(
    stations: &[Station],
    lat: f64,
    lon: f64,
    count: usize,
    max_km: f64,
) -> Vec<NearbyAirport> {
    let mut ranked: Vec<(f64, &Station)> = stations
        .iter()
        .map(|s| (haversine_km(lat, lon, s.lat, s.lon), s))
        .collect();
    ranked.sort_by(|a, b| a.0.total_cmp(&b.0));
    ranked
        .into_iter()
        .filter(|(d, _)| *d <= max_km)
        .take(count)
        .map(|(d, s)| NearbyAirport {
            icao: s.icao.clone(),
            name: s.name.clone(),
            distance_km: (d * 10.0).round_ties_even() / 10.0,
        })
        .collect()
}

/// Merge candidates with discovered airports (nearest first, no duplicates)
/// and keep `count`.
pub fn merge_candidates(
    mut candidates: Vec<NearbyAirport>,
    discovered: Vec<NearbyAirport>,
    count: usize,
) -> Vec<NearbyAirport> {
    let known: std::collections::HashSet<String> =
        candidates.iter().map(|c| c.icao.clone()).collect();
    candidates.extend(discovered.into_iter().filter(|d| !known.contains(&d.icao)));
    candidates.sort_by(|a, b| a.distance_km.total_cmp(&b.distance_km));
    candidates.truncate(count);
    candidates
}

/// Python's `{x:g}` for the radii and ages in the messages.
fn fmt_g(x: f64) -> String {
    if x.fract() == 0.0 {
        format!("{}", x as i64)
    } else {
        format!("{x}")
    }
}

/// Whole minutes between an ISO observation time and `now` (floored).
pub fn age_minutes(observed: &str, now: chrono::DateTime<chrono::Utc>) -> Option<i64> {
    let t = chrono::DateTime::parse_from_rfc3339(observed).ok()?;
    Some(now.signed_duration_since(t).num_seconds().div_euclid(60))
}

/// Candidate rows, and the index of the nearest one with a report no older
/// than `max_age_min` (a report up to 5 minutes in the future counts).
pub fn evaluate(
    candidates: &[NearbyAirport],
    reports: &std::collections::HashMap<String, Vec<MetarObs>>,
    now: chrono::DateTime<chrono::Utc>,
    max_age_min: i64,
) -> (Vec<Value>, Option<(usize, Option<i64>)>) {
    let mut rows = Vec::new();
    let mut chosen = None;
    for (i, c) in candidates.iter().enumerate() {
        let latest = reports.get(&c.icao).and_then(|l| l.first());
        let observed = latest.map(|m| m.time.as_str()).filter(|t| !t.is_empty());
        let age = observed.and_then(|t| age_minutes(t, now));
        let reported = age.is_some_and(|a| (-5..=max_age_min).contains(&a));
        rows.push(serde_json::json!({
            "icao": c.icao,
            "name": c.name,
            "distanceKm": c.distance_km,
            "reported": reported,
            "observedAt": observed,
            "ageMinutes": age,
        }));
        if reported && chosen.is_none() {
            chosen = Some((i, age));
        }
    }
    (rows, chosen)
}

/// The `NearestMetarResponse` body for each status.
pub fn nearest_response(
    status: &str,
    radius_km: f64,
    max_age_min: i64,
    fields: serde_json::Map<String, Value>,
) -> Value {
    let mut body = serde_json::json!({
        "status": status,
        "message": null,
        "searchRadiusKm": radius_km,
        "maxAgeMinutes": max_age_min,
        "icao": null,
        "name": null,
        "distanceKm": null,
        "observedAt": null,
        "ageMinutes": null,
        "metar": [],
        "taf": null,
        "source": "awc",
        "candidates": [],
    });
    for (k, v) in fields {
        body[k] = v;
    }
    body
}

pub fn no_airports_message(radius_km: f64) -> String {
    format!(
        "No airport with a METAR feed within {} km of this location.",
        fmt_g(radius_km)
    )
}

pub fn no_recent_message(radius_km: f64, max_age_min: i64) -> String {
    format!(
        "No airport within {} km has reported in the last {} hours.",
        fmt_g(radius_km),
        max_age_min / 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn layers(l: &[(&str, i64)]) -> Vec<CloudLayer> {
        l.iter()
            .map(|(c, b)| CloudLayer {
                cover: (*c).into(),
                base_ft: Some(*b),
            })
            .collect()
    }

    #[test]
    fn icao_codes() {
        assert_eq!(normalize_icao(" fvrg "), Some("FVRG".into()));
        assert_eq!(normalize_icao("FVH"), None);
        assert_eq!(normalize_icao("FV1A"), None);
        assert_eq!(normalize_icao("FVHAX"), None);
    }

    #[test]
    fn decodes_weather_strings() {
        assert_eq!(decode_wx(Some("RA")).as_deref(), Some("Rain"));
        assert_eq!(decode_wx(Some("-RA")).as_deref(), Some("Light Rain"));
        assert_eq!(decode_wx(Some("+RA")).as_deref(), Some("Heavy Rain"));
        assert_eq!(decode_wx(Some("TS")).as_deref(), Some("Thunderstorm"));
        assert_eq!(decode_wx(Some("FG")).as_deref(), Some("Fog"));
        assert_eq!(
            decode_wx(Some("-RA BR")).as_deref(),
            Some("Light Rain, Mist")
        );
        assert_eq!(decode_wx(None), None);
        assert_eq!(decode_wx(Some("")), None);
        assert!(decode_wx(Some("XX")).unwrap().contains("XX"));
    }

    #[test]
    fn parses_awc_visibility_strings() {
        assert_eq!(
            format_awc_visibility(&json!("6+")).as_deref(),
            Some(">9.7km")
        );
        assert_eq!(
            format_awc_visibility(&json!("10+")).as_deref(),
            Some(">10km")
        );
        assert_eq!(format_awc_visibility(&json!("3")).as_deref(), Some("4.8km"));
        assert_eq!(
            format_awc_visibility(&json!("1 1/2")).as_deref(),
            Some("2.4km")
        );
        assert_eq!(
            format_awc_visibility(&json!("1/2")).as_deref(),
            Some("0.8km")
        );
        assert_eq!(
            format_awc_visibility(&json!(6.25)).as_deref(),
            Some(">10km")
        );
        assert_eq!(format_awc_visibility(&json!("n/a")), None);
        assert_eq!(format_awc_visibility(&json!(null)), None);
        assert_eq!(parse_statute_miles(&json!("1/0")), None);
    }

    #[test]
    fn formats_visibility() {
        assert_eq!(format_visibility(Some(9.0)).as_deref(), Some(">10km"));
        assert_eq!(format_visibility(Some(6.25)).as_deref(), Some(">10km"));
        assert_eq!(format_visibility(Some(3.0)).as_deref(), Some("4.8km"));
        assert_eq!(format_visibility(None), None);
    }

    #[test]
    fn flight_categories() {
        assert_eq!(flight_category(&[], Some(">10km")), "VFR");
        assert_eq!(
            flight_category(&layers(&[("FEW", 5000)]), Some(">10km")),
            "VFR"
        );
        assert_eq!(
            flight_category(&layers(&[("BKN", 2500)]), Some(">10km")),
            "MVFR"
        );
        assert_eq!(
            flight_category(&layers(&[("BKN", 800)]), Some(">10km")),
            "IFR"
        );
        assert_eq!(
            flight_category(&layers(&[("OVC", 300)]), Some(">10km")),
            "LIFR"
        );
        assert_eq!(flight_category(&[], Some("3.0km")), "IFR");
        assert_eq!(flight_category(&[], Some("1.0km")), "LIFR");
        assert_eq!(
            flight_category(&layers(&[("FEW", 500), ("SCT", 600)]), Some(">10km")),
            "VFR"
        );
        assert_eq!(
            flight_category(&layers(&[("BKN", 3500), ("BKN", 800)]), Some(">10km")),
            "IFR"
        );
    }

    /// A real AWC METAR record (FVRG, 2026-10-08 15:00Z): epoch `obsTime`,
    /// string `visib`, hPa `altim`, `fltCat`, remarks inside `rawOb`.
    fn sample() -> Value {
        json!({
            "icaoId": "FVRG",
            "obsTime": 1791471600_i64,
            "reportTime": "2026-10-08T15:00:00.000Z",
            "temp": 19, "dewp": 17, "wdir": 100, "wspd": 7,
            "visib": "6+", "altim": 1024,
            "rawOb": "METAR FVRG 081500Z 10007KT 9999 FEW040CB BKN045 19/17 Q1024 RESHRA NOSIG",
            "clouds": [{"cover": "FEW", "base": 4000}, {"cover": "BKN", "base": 4500}],
            "fltCat": "VFR"
        })
    }

    #[test]
    fn decodes_an_awc_metar() {
        let o = decode_awc_metar(&sample());
        assert_eq!(o.temp, Some(19.0));
        assert_eq!(o.dewp, Some(17.0));
        assert_eq!(o.wind_dir, Some(100));
        assert_eq!(o.wind_speed, Some(7));
        assert_eq!(o.flight_category, "VFR");
        assert_eq!(o.visibility.as_deref(), Some(">9.7km"));
        assert_eq!(
            o.raw,
            "METAR FVRG 081500Z 10007KT 9999 FEW040CB BKN045 19/17 Q1024 RESHRA NOSIG"
        );
        assert_eq!(
            o.clouds,
            vec![
                CloudLayer {
                    cover: "FEW".into(),
                    base_ft: Some(4000)
                },
                CloudLayer {
                    cover: "BKN".into(),
                    base_ft: Some(4500)
                },
            ]
        );
        assert_eq!(o.change.as_deref(), Some("No Significant Change"));
        assert_eq!(o.pressure_hpa, Some(1024.0));
        assert_eq!(o.time, "2026-10-08T15:00:00+00:00");
        assert_eq!(o.weather, None);
    }

    #[test]
    fn awc_variants() {
        let mut s = sample();
        s["wdir"] = json!("VRB");
        s["wspd"] = json!(2);
        let o = decode_awc_metar(&s);
        assert!(o.wind_variable);
        assert_eq!(o.wind_dir, None);
        assert_eq!(o.wind_speed, Some(2));

        let mut s = sample();
        s["obsTime"] = json!(1_782_547_200_i64);
        assert!(decode_awc_metar(&s).time.ends_with("+00:00"));

        let mut s = sample();
        s["fltCat"] = json!("UNKNOWN");
        // Ceiling 4500 ft and 9.7 km visibility are VFR-range, so computed VFR.
        assert_eq!(decode_awc_metar(&s).flight_category, "VFR");

        let mut s = sample();
        s["fltCat"] = json!(null);
        s["flightCategory"] = json!("IFR");
        assert_eq!(decode_awc_metar(&s).flight_category, "IFR");

        // Legacy inHg altimeter is still converted.
        let mut s = sample();
        s["altim"] = json!(30.39);
        let p = decode_awc_metar(&s).pressure_hpa.unwrap();
        assert!(1028.0 < p && p < 1030.0);

        // Missing fields never panic.
        let minimal = decode_awc_metar(&json!({"icaoId": "FVRG"}));
        assert_eq!(minimal.visibility, None);
        assert_eq!(minimal.pressure_hpa, None);
        assert_eq!(minimal.flight_category, "VFR");

        assert_eq!(decode_awc_metars(&json!({"error": "x"})), vec![]);
        assert_eq!(decode_awc_metars(&json!([sample()])).len(), 1);
        assert_eq!(
            awc_taf(&json!([{"rawTAF": "TAF FVRG ..."}])).as_deref(),
            Some("TAF FVRG ...")
        );
        assert_eq!(awc_taf(&json!([])), None);
    }

    #[test]
    fn decodes_checkwx() {
        let body = json!({"data": [{
            "observed": "2026-06-27T08:00:00Z",
            "temperature": {"celsius": 16}, "dewpoint": {"celsius": 11},
            "wind": {"degrees": 40, "speed_kts": 4},
            "visibility": {"meters_float": 9999},
            "clouds": {"layers": [{"code": "BKN", "feet": 1800}]},
            "conditions": [{"text": "Light Rain"}],
            "barometer": {"hpa": 1029},
            "flight_category": "MVFR",
            "raw_text": "FVRG ..."
        }]});
        let o = &decode_checkwx(&body)[0];
        assert_eq!(o.visibility.as_deref(), Some(">10km"));
        assert_eq!(o.wind_dir, Some(40));
        assert!(!o.wind_variable);
        assert_eq!(o.weather.as_deref(), Some("Light Rain"));
        assert_eq!(o.flight_category, "MVFR");
        assert_eq!(o.clouds[0].base_ft, Some(1800));
    }

    #[test]
    fn nearest_airports_from_harare() {
        let near = nearest_airports(-17.85, 31.05, 5, 500.0);
        assert_eq!(near.len(), 5);
        assert_eq!(near[0].icao, "FVRG");
        assert!(near
            .windows(2)
            .all(|w| w[0].distance_km <= w[1].distance_km));
        assert!(nearest_airports(-17.85, 31.05, 100, 20_000.0).len() <= MAX_NEAREST);
        assert!(nearest_airports(60.0, -150.0, 5, 50.0).is_empty());
        let body = serde_json::to_value(&near[0]).unwrap();
        assert!(body.get("distanceKm").is_some());
    }

    #[test]
    fn response_shape_round_trips() {
        let r = MetarResponse {
            icao: "FVRG".into(),
            metar: vec![decode_awc_metar(&sample())],
            taf: None,
            source: "awc".into(),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["metar"][0]["flight_category"], "VFR");
        assert!(v["taf"].is_null());
        let back: MetarResponse = serde_json::from_value(v).unwrap();
        assert_eq!(back, r);
    }

    #[test]
    fn discovery_geometry_matches_the_python() {
        assert_eq!(discovery_cell(-17.83, 31.05), (-17.75, 31.25));
        assert_eq!(discovery_radius(100.0), 100.0);
        assert_eq!(discovery_radius(101.0), 150.0);
        assert_eq!(discovery_radius(900.0), 500.0);
        assert_eq!(discovery_radius(f64::NAN), 25.0);
        assert_eq!(discovery_radius(-1.0), 25.0);
        let (a, b, c, d) = discovery_bbox(-17.83, 31.05, 150.0);
        assert!(a < -17.75 && c > -17.75 && b < 31.25 && d > 31.25);
        assert_eq!(
            discovery_key(-17.83, 31.05, 120.0),
            "avn:disc:v1:-17.75_31.25_150"
        );
    }

    #[test]
    fn stations_are_validated() {
        let body = json!([
            {"icaoId": "fvrg", "site": "Harare Intl", "lat": -17.93, "lon": 31.09, "siteType": ["METAR", "TAF"]},
            {"icaoId": "FVRG", "site": "dup", "lat": 1.0, "lon": 1.0, "siteType": ["METAR"]},
            {"icaoId": "FVXX", "site": "No metar", "lat": 1.0, "lon": 1.0, "siteType": ["TAF"]},
            {"icaoId": "FV1X", "site": "Bad id", "lat": 1.0, "lon": 1.0, "siteType": ["METAR"]},
            {"icaoId": "FVBU", "lat": 95.0, "lon": 1.0, "siteType": ["METAR"]},
            {"icaoId": "FVWN", "lat": -18.6, "lon": 26.5, "siteType": ["METAR"]}
        ]);
        let s = parse_awc_stations(&body);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].icao, "FVRG");
        assert_eq!(s[0].name, "Harare Intl");
        assert_eq!(s[1].name, "FVWN");
        let near = nearest_of(&s, -17.83, 31.05, 5, 150.0);
        assert_eq!(near.len(), 1);
        assert_eq!(near[0].icao, "FVRG");
    }

    #[test]
    fn evaluates_candidates_and_picks_the_nearest_recent() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-18T12:00:00+00:00")
            .unwrap()
            .to_utc();
        let c = |i: &str, d: f64| NearbyAirport {
            icao: i.into(),
            name: i.into(),
            distance_km: d,
        };
        let cands = vec![c("AAAA", 10.0), c("BBBB", 20.0), c("CCCC", 30.0)];
        let obs = |t: &str| {
            let mut o = decode_awc_metar(&json!({"rawOb": "x"}));
            o.time = t.into();
            o
        };
        let mut reports = std::collections::HashMap::new();
        reports.insert("AAAA".to_owned(), vec![obs("2026-10-18T08:00:00+00:00")]);
        reports.insert("BBBB".to_owned(), vec![obs("2026-10-18T11:30:00+00:00")]);
        reports.insert("CCCC".to_owned(), vec![]);
        let (rows, chosen) = evaluate(&cands, &reports, now, 180);
        assert_eq!(chosen, Some((1, Some(30))));
        assert_eq!(rows[0]["reported"], false);
        assert_eq!(rows[0]["ageMinutes"], 240);
        assert_eq!(rows[2]["observedAt"], Value::Null);
        let (_, none) = evaluate(&cands, &reports, now, 30);
        assert_eq!(none, Some((1, Some(30))));
        assert_eq!(age_minutes("2026-10-18T12:03:00+00:00", now), Some(-3));
    }

    #[test]
    fn messages_format_like_python_g() {
        assert_eq!(
            no_airports_message(150.0),
            "No airport with a METAR feed within 150 km of this location."
        );
        assert_eq!(
            no_airports_message(25.5),
            "No airport with a METAR feed within 25.5 km of this location."
        );
        assert_eq!(
            no_recent_message(150.0, 180),
            "No airport within 150 km has reported in the last 3 hours."
        );
    }

    #[test]
    fn batches_group_by_station() {
        let body = json!([
            {"icaoId": "FVRG", "obsTime": 1_760_000_000, "rawOb": "a"},
            {"icaoId": "FVRG", "obsTime": 1_760_003_600, "rawOb": "b"},
            {"stationId": "FVWN", "obsTime": 1_760_000_000, "rawOb": "c"},
            {"icaoId": "ZZZZ", "rawOb": "ignored"}
        ]);
        let ids = vec!["FVRG".to_owned(), "FVWN".to_owned(), "FVBU".to_owned()];
        let g = metars_by_station(&body, &ids);
        assert_eq!(g["FVRG"].len(), 2);
        assert_eq!(g["FVWN"].len(), 1);
        assert!(g["FVBU"].is_empty());
        assert!(!g.contains_key("ZZZZ"));
    }
}
