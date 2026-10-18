//! Haze: a heuristic classifier over free, keyless data (ported from
//! `api/py/_haze.py`). Open-Meteo Air Quality (PM2.5, PM10, dust, AOD, US
//! AQI) and Open-Meteo Forecast (visibility, humidity) in, a level, a type,
//! advice and the local haze season out. Thresholds are design constants:
//! tune them here, in one place, and in the Python until it is deleted.

use serde_json::{json, Value};

pub const AQ_URL: &str = "https://air-quality-api.open-meteo.com/v1/air-quality";
pub const FORECAST_URL: &str = "https://api.open-meteo.com/v1/forecast";
pub const AQ_QUERY: &str = "current=pm2_5,pm10,dust,aerosol_optical_depth,us_aqi&hourly=pm2_5,dust,aerosol_optical_depth,us_aqi&forecast_days=2&timezone=auto";
pub const FORECAST_QUERY: &str =
    "current=relative_humidity_2m,visibility&hourly=visibility,relative_humidity_2m&forecast_days=2&timezone=auto";
pub const PSI_URL: &str = "https://api-open.data.gov.sg/v2/real-time/api/psi";
/// Cached 30 minutes.
pub const CACHE_TTL_SECONDS: u64 = 1800;
pub const ATTRIBUTION: &str = "Air quality and visibility: Open-Meteo (CAMS aerosol model, free, no key). Heuristic classification by mukoko weather; not an official alert.";

pub const LEVELS: [&str; 5] = ["none", "light", "moderate", "heavy", "hazardous"];

const PM25_FLOORS: [(f64, &str); 4] = [
    (150.5, "hazardous"),
    (55.5, "heavy"),
    (35.5, "moderate"),
    (12.1, "light"),
];
const VIS_BANDS_KM: [(f64, &str); 3] = [(2.0, "heavy"), (5.0, "moderate"), (10.0, "light")];
const MIST_RH_PERCENT: f64 = 90.0;
const MIST_VIS_KM: f64 = 10.0;
const MIST_MAX_PM25: f64 = 35.5;
const DUST_SIGNIFICANT_UGM3: f64 = 10.0;
const DUST_MIN_UGM3: f64 = 15.0;
const DUST_SHARE_MIN: f64 = 0.3;
const COARSE_FINE_RATIO: f64 = 0.4;
const COARSE_PM10_MIN: f64 = 50.0;
const AOD_SMOKE_HIGH: f64 = 0.6;
const AOD_SMOKE_SEASON: f64 = 0.3;
const MEAN_WINDOW_HOURS: usize = 12;

pub fn level_rank(level: &str) -> usize {
    LEVELS.iter().position(|l| *l == level).unwrap_or(0)
}

struct HazeSeason {
    name: &'static str,
    haze_type: &'static str,
    lat: (f64, f64),
    lon: (f64, f64),
    start: u32,
    end: u32,
}

macro_rules! season {
    ($n:expr, $t:expr, $la:expr, $lb:expr, $oa:expr, $ob:expr, $s:expr, $e:expr) => {
        HazeSeason { name: $n, haze_type: $t, lat: ($la as f64, $lb as f64), lon: ($oa as f64, $ob as f64), start: $s, end: $e }
    };
}

/// Regional burning / dust / smog seasons. Boxes are deliberately loose; the
/// first active match wins, otherwise the first geographic match is reported.
const SEASONS: [HazeSeason; 11] = [
    season!(
        "Southeast Asian haze season",
        "smoke",
        -11,
        10,
        94,
        125,
        6,
        10
    ),
    season!("South Asian winter smog", "smog", 20, 33, 67, 92, 10, 2),
    season!(
        "Northern China winter smog",
        "smog",
        30,
        42,
        105,
        122,
        11,
        2
    ),
    season!(
        "Southern African burning season",
        "smoke",
        -27,
        -8,
        12,
        42,
        6,
        10
    ),
    season!("Harmattan dust season", "dust", 4, 20, -18, 16, 11, 3),
    season!("Gulf dust season", "dust", 15, 32, 34, 60, 5, 8),
    season!(
        "East Asian spring dust season",
        "dust",
        36,
        50,
        100,
        125,
        3,
        5
    ),
    season!("Amazon fire season", "smoke", -18, 5, -74, -50, 8, 10),
    season!(
        "Australian bushfire season",
        "smoke",
        -44,
        -10,
        112,
        154,
        11,
        3
    ),
    season!(
        "Western North American fire season",
        "smoke",
        32,
        60,
        -125,
        -104,
        7,
        10
    ),
    season!("Siberian fire season", "smoke", 50, 70, 60, 140, 4, 9),
];

fn month_in_window(month: u32, start: u32, end: u32) -> bool {
    if start <= end {
        start <= month && month <= end
    } else {
        month >= start || month <= end
    }
}

fn window_months(start: u32, end: u32) -> Vec<u32> {
    if start <= end {
        (start..=end).collect()
    } else {
        (start..=12).chain(1..=end).collect()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SeasonInfo {
    pub name: &'static str,
    pub active: bool,
    pub typical_months: Vec<u32>,
    pub typical_type: &'static str,
}

/// The season covering (lat, lon), preferring one active in `month`.
pub fn active_season(lat: f64, lon: f64, month: u32) -> Option<SeasonInfo> {
    let matches: Vec<&HazeSeason> = SEASONS
        .iter()
        .filter(|s| s.lat.0 <= lat && lat <= s.lat.1 && s.lon.0 <= lon && lon <= s.lon.1)
        .collect();
    let chosen = matches
        .iter()
        .find(|s| month_in_window(month, s.start, s.end))
        .or_else(|| matches.first())?;
    Some(SeasonInfo {
        name: chosen.name,
        active: month_in_window(month, chosen.start, chosen.end),
        typical_months: window_months(chosen.start, chosen.end),
        typical_type: chosen.haze_type,
    })
}

// ---------------------------------------------------------------------------
// Official sources
// ---------------------------------------------------------------------------

fn psi_band_label(v: f64) -> &'static str {
    if v <= 50.0 {
        "Good"
    } else if v <= 100.0 {
        "Moderate"
    } else if v <= 200.0 {
        "Unhealthy"
    } else if v <= 300.0 {
        "Very unhealthy"
    } else {
        "Hazardous"
    }
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + &c.as_str().to_lowercase(),
        None => String::new(),
    }
}

/// Singapore NEA PSI (v2): no `national` key, the headline is the highest
/// regional 24-h PSI.
pub fn parse_sg_psi(payload: &Value) -> Option<Value> {
    let item = payload["data"]["items"].as_array()?.first()?;
    let readings = item["readings"]["psi_twenty_four_hourly"].as_object()?;
    let (region, value) = readings
        .iter()
        .filter(|(k, _)| k.as_str() != "national")
        .filter_map(|(k, v)| v.as_f64().map(|n| (k, n)))
        .fold(None::<(&String, f64)>, |best, cur| match best {
            Some(b) if b.1 >= cur.1 => Some(b),
            _ => Some(cur),
        })?;
    Some(json!({
        "source": "NEA Singapore",
        "metric": "PSI",
        "value": value as i64,
        "band": psi_band_label(value),
        "region": capitalize(region),
        "observedAt": item["timestamp"].as_str().or_else(|| item["updatedTimestamp"].as_str()),
    }))
}

/// Is the point inside Singapore's official-source box?
pub fn sg_applies(lat: f64, lon: f64) -> bool {
    (1.15..=1.48).contains(&lat) && (103.59..=104.10).contains(&lon)
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

pub fn pm_level(pm25_mean: Option<f64>) -> &'static str {
    let Some(m) = pm25_mean else { return "none" };
    PM25_FLOORS
        .iter()
        .find(|(floor, _)| m >= *floor)
        .map_or("none", |(_, l)| l)
}

pub fn vis_level(vis_km: Option<f64>, rh: Option<f64>) -> &'static str {
    let Some(v) = vis_km else { return "none" };
    if rh.is_some_and(|r| r >= MIST_RH_PERCENT) {
        return "none";
    }
    VIS_BANDS_KM
        .iter()
        .find(|(ceiling, _)| v < *ceiling)
        .map_or("none", |(_, l)| l)
}

pub fn classify_level(
    pm25_mean: Option<f64>,
    vis_km: Option<f64>,
    rh: Option<f64>,
    dust: Option<f64>,
) -> &'static str {
    let pm = pm_level(pm25_mean);
    let supported =
        level_rank(pm) >= level_rank("light") || dust.is_some_and(|d| d >= DUST_SIGNIFICANT_UGM3);
    let vis = if supported {
        vis_level(vis_km, rh)
    } else {
        "none"
    };
    // Python's max() keeps the first on a tie.
    if level_rank(vis) > level_rank(pm) {
        vis
    } else {
        pm
    }
}

pub fn is_mist(pm25_mean: Option<f64>, vis_km: Option<f64>, rh: Option<f64>) -> bool {
    rh.is_some_and(|r| r >= MIST_RH_PERCENT)
        && vis_km.is_some_and(|v| v < MIST_VIS_KM)
        && pm25_mean.is_none_or(|m| m < MIST_MAX_PM25)
}

pub struct TypeInputs {
    pub pm25_mean: Option<f64>,
    pub pm25: Option<f64>,
    pub pm10: Option<f64>,
    pub dust: Option<f64>,
    pub aod: Option<f64>,
    pub rh: Option<f64>,
    pub vis_km: Option<f64>,
    pub fire_season_active: bool,
}

pub fn classify_type(level: &str, i: &TypeInputs) -> &'static str {
    if is_mist(i.pm25_mean, i.vis_km, i.rh) {
        return "mist";
    }
    if level == "none" {
        return "clear";
    }
    let dust_value = i.dust.unwrap_or(0.0);
    let pm10_nonzero = i.pm10.filter(|p| *p != 0.0);
    let dust_share = pm10_nonzero.map_or(0.0, |p| dust_value / p);
    let fine_ratio = match (i.pm25, pm10_nonzero) {
        (Some(a), Some(b)) => Some(a / b),
        _ => None,
    };
    let coarse = fine_ratio.is_some_and(|r| r < COARSE_FINE_RATIO);
    if (dust_value >= DUST_MIN_UGM3 && dust_share >= DUST_SHARE_MIN)
        || (coarse && i.pm10.is_some_and(|p| p >= COARSE_PM10_MIN))
    {
        return "dust";
    }
    if i.aod.is_some_and(|a| a >= AOD_SMOKE_HIGH) {
        return "smoke";
    }
    if i.fire_season_active && i.aod.is_none_or(|a| a >= AOD_SMOKE_SEASON) {
        return "smoke";
    }
    "smog"
}

fn level_word(level: &str) -> String {
    match level {
        "light" => "Light".into(),
        "moderate" => "Moderate".into(),
        "heavy" => "Heavy".into(),
        "hazardous" => "Hazardous".into(),
        other => capitalize(other),
    }
}

pub fn headline_for(level: &str, htype: &str) -> String {
    match htype {
        "clear" => "Clear air".into(),
        "mist" => "Mist, not pollution".into(),
        t => {
            let noun = match t {
                "smoke" => "smoke haze",
                "dust" => "dust haze",
                _ => "smog",
            };
            format!("{} {noun}", level_word(level))
        }
    }
}

pub fn advice_for(level: &str, htype: &str, peak_time: Option<&str>) -> Vec<String> {
    if htype == "clear" {
        return vec!["Air looks clear. No haze precautions needed.".into()];
    }
    if htype == "mist" {
        return vec!["This is mist or fog from humidity, not pollution. Drive with headlights on and reduce speed until it lifts.".into()];
    }
    let moderate_up = level_rank(level) >= level_rank("moderate");
    let mut items: Vec<String> = Vec::new();
    if htype == "dust" {
        items.push(if moderate_up {
            "Keep windows closed and wear eye protection outdoors; rinse eyes if irritated.".into()
        } else {
            "Keep windows closed and wear sunglasses outdoors.".into()
        });
        items.push(
            "Drive with headlights on and reduce speed; visibility can drop suddenly.".into(),
        );
    } else {
        items.push(match level {
            "light" => "Sensitive groups should cut back on prolonged outdoor exertion.".into(),
            "moderate" => "Limit outdoor exertion; wear an N95 or KN95 mask for long time outside.".into(),
            _ => "Stay indoors with windows closed and run an air purifier if you have one; wear an N95 or KN95 mask if you must go out.".into(),
        });
        if htype == "smog" && moderate_up {
            items.push("Avoid busy roads at peak traffic hours.".into());
        }
    }
    if let Some(p) = peak_time.filter(|p| p.chars().count() >= 16) {
        let hhmm: String = p.chars().skip(11).take(5).collect();
        items.push(format!(
            "Air is worst around {hhmm}; plan outdoor work and travel for another time."
        ));
    }
    if moderate_up {
        items.push("Children, older adults, and people with asthma or heart or lung conditions should take extra care.".into());
    }
    items.truncate(3);
    items
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

fn num(v: &Value) -> Option<f64> {
    v.as_f64()
}

fn series(hourly: &Value, field: &str) -> Vec<Option<f64>> {
    hourly[field]
        .as_array()
        .map(|a| a.iter().map(num).collect())
        .unwrap_or_default()
}

fn index_of_hour(times: &[String], now_iso: &str) -> usize {
    let key: String = now_iso.chars().take(13).collect();
    times
        .iter()
        .position(|t| t.chars().take(13).collect::<String>() == key)
        .unwrap_or(0)
}

fn peak_time(times: &[String], series: &[Option<f64>], idx: usize) -> Option<String> {
    let mut best: Option<usize> = None;
    for j in idx..(idx + 24).min(series.len()).min(times.len()) {
        if let Some(v) = series[j] {
            if best.is_none_or(|b| v > series[b].unwrap_or(f64::MIN)) {
                best = Some(j);
            }
        }
    }
    best.map(|b| times[b].clone())
}

fn round_to(v: f64, places: i32) -> f64 {
    let f = 10f64.powi(places);
    (v * f).round_ties_even() / f
}

/// `{available: false, reason, ...}` with the nulls FastAPI sends.
pub fn unavailable(reason: &str, fetched_at: &str) -> Value {
    json!({
        "available": false,
        "reason": reason,
        "level": null,
        "type": null,
        "headline": null,
        "advice": [],
        "visibilityKm": null,
        "pm25": null,
        "pm25Mean": null,
        "dust": null,
        "aod": null,
        "usAqi": null,
        "relativeHumidity": null,
        "peakTime": null,
        "season": null,
        "official": null,
        "attribution": ATTRIBUTION,
        "fetchedAt": fetched_at,
    })
}

/// Pure: raw Open-Meteo payloads (and an optional official reading) in, the
/// haze response out.
pub fn analyse(
    aq: &Value,
    fc: &Value,
    lat: f64,
    lon: f64,
    month: u32,
    official: Option<Value>,
    fetched_at: &str,
) -> Value {
    let cur = &aq["current"];
    let hourly = &aq["hourly"];
    let times: Vec<String> = hourly["time"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|t| t.as_str().map_or_else(|| t.to_string(), str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let idx = index_of_hour(&times, cur["time"].as_str().unwrap_or(""));

    let pm_series = series(hourly, "pm2_5");
    let dust_series = series(hourly, "dust");
    let pm25 = num(&cur["pm2_5"]);
    let pm10 = num(&cur["pm10"]);
    let dust = num(&cur["dust"]);
    let aod = num(&cur["aerosol_optical_depth"]);
    let us_aqi = num(&cur["us_aqi"]);

    let lo = idx.saturating_sub(MEAN_WINDOW_HOURS);
    let hi = (idx + MEAN_WINDOW_HOURS).min(pm_series.len());
    let window: Vec<f64> = pm_series
        .get(lo..hi)
        .unwrap_or(&[])
        .iter()
        .flatten()
        .copied()
        .collect();
    let pm25_mean = if window.is_empty() {
        pm25
    } else {
        Some(window.iter().sum::<f64>() / window.len() as f64)
    };

    let fc_cur = &fc["current"];
    let rh = num(&fc_cur["relative_humidity_2m"]);
    let vis_km = num(&fc_cur["visibility"]).map(|m| m / 1000.0);

    if pm25_mean.is_none() && vis_km.is_none() {
        return unavailable("insufficient_data", fetched_at);
    }

    let season = active_season(lat, lon, month);
    let fire_active = season
        .as_ref()
        .is_some_and(|s| s.active && s.typical_type == "smoke");
    let level = classify_level(pm25_mean, vis_km, rh, dust);
    let htype = classify_type(
        level,
        &TypeInputs {
            pm25_mean,
            pm25,
            pm10,
            dust,
            aod,
            rh,
            vis_km,
            fire_season_active: fire_active,
        },
    );
    let peak = (level != "none" || htype == "mist")
        .then(|| {
            peak_time(
                &times,
                if htype == "dust" {
                    &dust_series
                } else {
                    &pm_series
                },
                idx,
            )
        })
        .flatten();

    json!({
        "available": true,
        "reason": null,
        "level": level,
        "type": htype,
        "headline": headline_for(level, htype),
        "advice": advice_for(level, htype, peak.as_deref()),
        "visibilityKm": vis_km.map(|v| round_to(v, 1)),
        "pm25": pm25.map(|v| round_to(v, 1)),
        "pm25Mean": pm25_mean.map(|v| round_to(v, 1)),
        "dust": dust.map(|v| round_to(v, 1)),
        "aod": aod.map(|v| round_to(v, 2)),
        "usAqi": us_aqi.map(|v| v.round_ties_even() as i64),
        "relativeHumidity": rh,
        "peakTime": peak,
        "season": season.map(|s| json!({
            "name": s.name,
            "active": s.active,
            "typicalMonths": s.typical_months,
            "typicalType": s.typical_type,
        })),
        "official": official,
        "attribution": ATTRIBUTION,
        "fetchedAt": fetched_at,
    })
}

/// The cache key: `{lat:.2f}_{lon:.2f}`.
pub fn cache_key(lat: f64, lon: f64) -> String {
    format!("haze:v1:{lat:.2}_{lon:.2}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_follow_pm25_floors() {
        assert_eq!(pm_level(Some(12.0)), "none");
        assert_eq!(pm_level(Some(12.1)), "light");
        assert_eq!(pm_level(Some(35.5)), "moderate");
        assert_eq!(pm_level(Some(55.5)), "heavy");
        assert_eq!(pm_level(Some(150.5)), "hazardous");
        assert_eq!(pm_level(None), "none");
    }

    #[test]
    fn visibility_only_raises_when_particles_support_it() {
        assert_eq!(
            classify_level(Some(5.0), Some(1.0), Some(50.0), None),
            "none"
        );
        assert_eq!(
            classify_level(Some(13.0), Some(1.0), Some(50.0), None),
            "heavy"
        );
        assert_eq!(
            classify_level(Some(5.0), Some(1.0), Some(50.0), Some(12.0)),
            "heavy"
        );
        assert_eq!(
            classify_level(Some(13.0), Some(1.0), Some(95.0), None),
            "light"
        );
    }

    #[test]
    fn mist_is_not_haze() {
        assert!(is_mist(Some(10.0), Some(3.0), Some(95.0)));
        assert!(!is_mist(Some(40.0), Some(3.0), Some(95.0)));
        assert!(!is_mist(Some(10.0), Some(3.0), Some(60.0)));
    }

    #[test]
    fn types() {
        let base = TypeInputs {
            pm25_mean: Some(40.0),
            pm25: Some(40.0),
            pm10: Some(60.0),
            dust: Some(1.0),
            aod: Some(0.7),
            rh: Some(40.0),
            vis_km: Some(6.0),
            fire_season_active: false,
        };
        assert_eq!(classify_type("moderate", &base), "smoke");
        let smog = TypeInputs {
            aod: Some(0.1),
            ..base
        };
        assert_eq!(classify_type("moderate", &smog), "smog");
        let dusty = TypeInputs {
            dust: Some(30.0),
            pm10: Some(80.0),
            ..smog
        };
        assert_eq!(classify_type("moderate", &dusty), "dust");
        assert_eq!(classify_type("none", &dusty), "clear");
    }

    #[test]
    fn seasons_wrap_the_year_end() {
        let s = active_season(-17.83, 31.05, 8).unwrap();
        assert_eq!(s.name, "Southern African burning season");
        assert!(s.active);
        assert_eq!(s.typical_months, vec![6, 7, 8, 9, 10]);
        let off = active_season(-17.83, 31.05, 1).unwrap();
        assert!(!off.active);
        let wrap = active_season(5.0, 0.0, 12).unwrap();
        assert_eq!(wrap.typical_months, vec![11, 12, 1, 2, 3]);
        assert!(active_season(0.0, -150.0, 6).is_none());
    }

    #[test]
    fn headline_and_advice() {
        assert_eq!(headline_for("heavy", "smoke"), "Heavy smoke haze");
        assert_eq!(headline_for("none", "clear"), "Clear air");
        let a = advice_for("moderate", "smog", Some("2026-10-18T15:00"));
        assert_eq!(a.len(), 3);
        assert!(a[2].contains("15:00") || a.iter().any(|x| x.contains("15:00")));
    }

    #[test]
    fn analyse_end_to_end() {
        let times: Vec<String> = (0..48)
            .map(|h| format!("2026-10-18T{:02}:00", h % 24))
            .collect();
        let aq = json!({
            "current": {"time": "2026-10-18T10:00", "pm2_5": 40.0, "pm10": 60.0, "dust": 1.0, "aerosol_optical_depth": 0.7, "us_aqi": 110.4},
            "hourly": {"time": times, "pm2_5": vec![40.0; 48], "dust": vec![1.0; 48]},
        });
        let fc = json!({"current": {"relative_humidity_2m": 40.0, "visibility": 6000.0}});
        let out = analyse(&aq, &fc, -17.83, 31.05, 8, None, "t");
        assert_eq!(out["available"], true);
        assert_eq!(out["level"], "moderate");
        assert_eq!(out["type"], "smoke");
        assert_eq!(out["visibilityKm"], 6.0);
        assert_eq!(out["usAqi"], 110);
        assert_eq!(out["season"]["active"], true);
        let none = analyse(&json!({}), &json!({}), 0.0, 0.0, 1, None, "t");
        assert_eq!(none["reason"], "insufficient_data");
    }

    #[test]
    fn sg_psi_headline_is_the_highest_region() {
        let p = json!({"data": {"items": [{"timestamp": "ts", "readings": {"psi_twenty_four_hourly": {"national": 90, "west": 55, "east": 62}}}]}});
        let o = parse_sg_psi(&p).unwrap();
        assert_eq!(o["value"], 62);
        assert_eq!(o["region"], "East");
        assert_eq!(o["band"], "Moderate");
        assert!(sg_applies(1.3, 103.8));
        assert!(!sg_applies(1.3, 105.0));
    }
}
