//! The Africa-weighted multi-model forecast baseline (issue #246).
//!
//! Ported from `api/py/_model_blend.py` (blend maths, regions, weights,
//! request shape) and the serving rules in `api/py/_weather.py` (nowcast
//! trimming, UTC offset estimate). The output is pinned to the Python by
//! `tests/fixtures/model-blend.json`, whose `expected` values the Python
//! functions produced (`scripts/gen_model_blend_fixtures.py`).
//!
//! The baseline is a weighted blend of the global NWP models Open-Meteo
//! serves keyless. Tomorrow.io never provides it (see `enrichment.rs`).
//!
//! Blend rules, per variable and time step:
//!
//! * weighted mean over the members that HAVE a value, weights renormalised
//!   over those present (UV and lifted index, which only GFS publishes, come
//!   from GFS alone);
//! * wind direction: circular (vector) weighted mean;
//! * WMO weather code: weighted vote, ties to the higher (more severe) code;
//! * `is_day`, `sunrise`, `sunset`: first non-null member value;
//! * precipitation probability: `0.5 x ensemble + 0.5 x agreement` when a
//!   member reports one, else agreement alone (agreement = weighted share of
//!   members with at least 0.1 mm an hour, or 1 mm a day).
//!
//! **Floor (owner decision): at least [`MIN_MEMBERS`] members must return
//! data for the answer to be a blend.** Fewer, and the caller falls back to
//! Open-Meteo `best_match` and labels the answer as such. The Python floor was
//! two.

use chrono::{DateTime, Utc};
use serde_json::{json, Map, Value};

use crate::insights;

pub const ECMWF_IFS: &str = "ecmwf_ifs";
pub const ECMWF_IFS025: &str = "ecmwf_ifs025";
pub const ECMWF_AIFS: &str = "ecmwf_aifs025_single";
pub const GFS: &str = "gfs_seamless";
pub const ICON: &str = "icon_global";
pub const GEM: &str = "gem_global";
pub const ARPEGE: &str = "meteofrance_arpege_world";
/// UK Met Office global deterministic, 10 km. Added with the 4-member floor:
/// a bigger blend is a more accurate forecast (owner decision).
pub const UKMO: &str = "ukmo_global_deterministic_10km";
/// CMA GRAPES global (China Meteorological Administration).
pub const CMA: &str = "cma_grapes_global";
/// JMA GSM (Japan Meteorological Agency). Publishes no gusts, visibility or
/// CAPE; the per-variable renormalisation covers that.
pub const JMA: &str = "jma_gsm";

/// The fewest blend members that must return data for an answer to be served
/// as a blend. (Python accepted two; the owner raised it to four.)
pub const MIN_MEMBERS: usize = 4;

/// `X-Weather-Provider` values of the baseline.
pub const PROVIDER_BLEND: &str = "open-meteo:blend";
pub const PROVIDER_BEST_MATCH: &str = "open-meteo:best_match";

/// Legacy or renamed model ids to the current id. `ecmwf_ifs04` is dead
/// upstream (all-null series); it is accepted so stored preferences work.
pub const MODEL_ALIASES: [(&str, &str); 1] = [("ecmwf_ifs04", ECMWF_IFS)];

/// Models that may appear in a blend.
pub const BLENDABLE_MODELS: [&str; 10] = [
    ECMWF_IFS,
    ECMWF_IFS025,
    ECMWF_AIFS,
    GFS,
    ICON,
    GEM,
    ARPEGE,
    UKMO,
    CMA,
    JMA,
];

/// The original six members' starting weights, ECMWF-heavy everywhere (owner
/// direction). They are unchanged; the newer members are added on top and the
/// blend normalises over whoever is present.
const ECMWF_HEAVY: [(&str, f64); 6] = [
    (ECMWF_IFS, 0.35),
    (ECMWF_AIFS, 0.25),
    (GFS, 0.15),
    (ICON, 0.15),
    (GEM, 0.05),
    (ARPEGE, 0.05),
];

/// The newer members' starting weights `(ukmo, cma, jma)` for a region: small
/// (0.03 to 0.08, owner direction) so the established blend barely moves.
/// Where Africa is concerned (and where no better evidence exists) the Met
/// Office, whose 10 km global model is the highest resolution of the three,
/// leads; the Asian regional centres get a little more weight at home.
/// Untuned starting values, to be fitted by skill (`_verification`).
fn newer_members(region: &str) -> (f64, f64, f64) {
    match region {
        "south-asia" | "southeast-asia" | "east-asia" | "oceania" => (0.06, 0.06, 0.05),
        _ => (0.08, 0.05, 0.03),
    }
}

/// Every region key with its own weights entry (all ECMWF-heavy to start;
/// tuned per region once verification data supports fitting by skill).
pub const REGIONS: [&str; 14] = [
    "southern-africa",
    "east-africa",
    "west-africa-sahel",
    "central-africa",
    "north-africa",
    "europe",
    "middle-east",
    "south-asia",
    "southeast-asia",
    "east-asia",
    "oceania",
    "north-america",
    "south-america",
    "default",
];

/// `(lat_min, lat_max, lon_min, lon_max)`.
pub type BoundingBox = (f64, f64, f64, f64);

/// Region bounding boxes `(lat_min, lat_max, lon_min, lon_max)`. First match
/// wins, so order matters where boxes touch; edges are inclusive. The African
/// boxes come first so no African point changed region when the world boxes
/// were added; the carve-outs at the top hold no African land (see the margins
/// documented beside the same table in `api/py/_model_blend.py`).
pub const REGION_BOXES: &[(&str, BoundingBox)] = &[
    ("europe", (36.0, 44.0, -10.0, -1.0)),
    ("europe", (36.5, 38.5, 12.0, 16.0)),
    ("europe", (35.7, 36.2, 14.0, 14.7)),
    ("europe", (34.5, 38.0, 19.0, 34.2)),
    ("middle-east", (34.5, 38.0, 34.2, 37.0)),
    ("middle-east", (31.3, 34.5, 34.2, 37.0)),
    ("middle-east", (29.4, 31.3, 34.9, 37.0)),
    ("middle-east", (15.5, 19.0, 40.5, 52.0)),
    ("middle-east", (13.0, 15.5, 42.8, 52.0)),
    ("middle-east", (12.5, 13.0, 44.0, 52.0)),
    ("north-africa", (19.0, 38.0, -18.0, 37.0)),
    ("west-africa-sahel", (3.0, 19.0, -18.0, 16.0)),
    ("east-africa", (-12.0, 19.0, 28.0, 52.0)),
    ("central-africa", (-12.0, 12.0, 8.0, 31.0)),
    ("southern-africa", (-35.5, -12.0, 10.0, 52.0)),
    ("east-africa", (19.0, 23.0, 36.5, 38.9)),
    ("europe", (34.0, 72.0, -32.0, 45.0)),
    ("middle-east", (12.0, 42.0, 34.0, 63.0)),
    ("south-asia", (5.0, 38.0, 60.0, 92.0)),
    ("southeast-asia", (-11.0, 23.5, 92.0, 141.0)),
    ("east-asia", (18.0, 55.0, 92.0, 150.0)),
    ("oceania", (-50.0, 0.0, 110.0, 180.0)),
    ("north-america", (7.0, 84.0, -170.0, -50.0)),
    ("south-america", (-56.0, 13.0, -82.0, -34.0)),
];

/// A member's weight, in the order members are listed.
pub type Weights = Vec<(String, f64)>;

/// Blend-weight region key for a coordinate (`default` where no box matches).
pub fn region_for(lat: f64, lon: f64) -> &'static str {
    for (key, (lat_min, lat_max, lon_min, lon_max)) in REGION_BOXES.iter().copied() {
        if lat_min <= lat && lat <= lat_max && lon_min <= lon && lon <= lon_max {
            return key;
        }
    }
    "default"
}

/// The compiled-in weights for a region (an unknown region gets the default).
/// The Python also reads a `weather.modelBlendConfig` override from MongoDB;
/// the Worker applies it in `workers/forecast/src/blend_config.rs`, with
/// [`sanitize_override`] deciding what counts as a usable one.
pub fn weights_for(region: &str) -> Weights {
    let region = if REGIONS.contains(&region) {
        region
    } else {
        "default"
    };
    let (ukmo, cma, jma) = newer_members(region);
    ECMWF_HEAVY
        .iter()
        .copied()
        .chain([(UKMO, ukmo), (CMA, cma), (JMA, jma)])
        .map(|(m, w)| (m.to_owned(), w))
        .collect()
}

/// The weights in a `weather.modelBlendConfig` override document
/// (`{_id: region, weights: {model: weight}}`), or `None` when the document has
/// no usable weights. As in the Python: unknown model ids and non-positive or
/// non-numeric weights are dropped, and the override REPLACES the compiled-in
/// set (a model it does not list is not requested). JSON `true` is not a weight
/// here (Python's `isinstance(True, int)` would take it as 1.0).
pub fn sanitize_override(weights: &Value) -> Option<Weights> {
    let cleaned: Weights = weights
        .as_object()?
        .iter()
        .filter(|(m, _)| BLENDABLE_MODELS.contains(&m.as_str()))
        .filter_map(|(m, w)| match w {
            Value::Number(n) => n.as_f64().filter(|w| *w > 0.0).map(|w| (m.clone(), w)),
            _ => None,
        })
        .collect();
    (!cleaned.is_empty()).then_some(cleaned)
}

/// An override the Worker will actually use: [`sanitize_override`] plus at
/// least [`MIN_MEMBERS`] members, since an override naming fewer could never
/// satisfy the floor and would turn every answer into `best_match`.
pub fn usable_override(weights: &Value) -> Option<Weights> {
    sanitize_override(weights).filter(|w| w.len() >= MIN_MEMBERS)
}

/// Members sorted by weight, highest first (the first supplies `current`),
/// ties by name.
pub fn order_members(weights: &[(String, f64)]) -> Vec<String> {
    let mut v: Vec<&(String, f64)> = weights.iter().collect();
    v.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });
    v.into_iter().map(|(m, _)| m.clone()).collect()
}

fn weight_of(weights: &[(String, f64)], model: &str) -> f64 {
    weights
        .iter()
        .find(|(m, _)| m == model)
        .map(|(_, w)| *w)
        .unwrap_or(0.0)
}

/// `X-Weather-Blend`: region and normalised weights, e.g.
/// `southern-africa; ecmwf_ifs=0.35,ecmwf_aifs025_single=0.25,...`.
pub fn format_weights(region: &str, weights: &[(String, f64)]) -> String {
    let members = order_members(weights);
    let mut total: f64 = members.iter().map(|m| weight_of(weights, m)).sum();
    if total == 0.0 {
        total = 1.0;
    }
    let parts: Vec<String> = members
        .iter()
        .map(|m| format!("{m}={:.2}", weight_of(weights, m) / total))
        .collect();
    format!("{region}; {}", parts.join(","))
}

// ---------------------------------------------------------------------------
// Open-Meteo request shape
// ---------------------------------------------------------------------------

pub const CURRENT_VARS: &str = "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,surface_pressure,cloud_cover,uv_index,is_day";
pub const HOURLY_VARS: &str = "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,surface_pressure,cloud_cover,uv_index,visibility,is_day,dew_point_2m,cape,lifted_index";
pub const DAILY_VARS: &str = "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,sunrise,sunset,uv_index_max,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,et0_fao_evapotranspiration";

/// Minutely steps requested; the answer is trimmed to the next four at serve
/// time so a cached row's nowcast never starts in the past.
pub const MINUTELY_STEPS_FETCHED: usize = 8;

/// The Open-Meteo forecast URL for the blend (`models` set) or `best_match`
/// (`models` empty): current, hourly and daily variables plus the insight
/// inputs (CAPE, lifted index, dew point, ET0), the nowcast, 7 days.
pub fn open_meteo_url(lat: f64, lon: f64, models: &[String]) -> String {
    let mut pairs: Vec<(&str, String)> = vec![
        ("latitude", lat.to_string()),
        ("longitude", lon.to_string()),
        ("current", CURRENT_VARS.into()),
        ("hourly", HOURLY_VARS.into()),
        ("daily", DAILY_VARS.into()),
        ("minutely_15", "precipitation".into()),
        ("forecast_minutely_15", MINUTELY_STEPS_FETCHED.to_string()),
        ("timezone", "auto".into()),
        ("forecast_days", "7".into()),
    ];
    if !models.is_empty() {
        pairs.push(("models", models.join(",")));
    }
    format!(
        "{}?{}",
        crate::normalize::OPEN_METEO_FORECAST_URL,
        crate::normalize::query_string(&pairs)
    )
}

/// The models to request for a blend over `weights`: every member, the
/// highest-weight first. A single-member request would come back unsuffixed,
/// so `best_match` is added to keep the response suffixed.
pub fn request_models(weights: &[(String, f64)]) -> Vec<String> {
    let mut members = order_members(weights);
    if members.len() <= 1 {
        members.push("best_match".to_owned());
    }
    members
}

// ---------------------------------------------------------------------------
// Rounding and means
// ---------------------------------------------------------------------------

/// Python's `round(x, nd)`: the correctly rounded decimal of the exact binary
/// value, ties to even (Rust's float formatting rounds the same way).
pub fn pyround(x: f64, nd: usize) -> f64 {
    format!("{x:.nd$}").parse().unwrap_or(x)
}

fn num(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64().filter(|f| !f.is_nan()),
        _ => None,
    }
}

fn weighted_mean(pairs: &[(f64, f64)]) -> Option<f64> {
    let mut total_w = 0.0;
    let mut total = 0.0;
    for (value, w) in pairs {
        total += value * w;
        total_w += w;
    }
    if total_w <= 0.0 {
        None
    } else {
        Some(total / total_w)
    }
}

fn circular_mean(pairs: &[(f64, f64)]) -> Option<i64> {
    let (mut x, mut y, mut total_w) = (0.0_f64, 0.0_f64, 0.0_f64);
    for (deg, w) in pairs {
        let rad = deg.to_radians();
        x += rad.cos() * w;
        y += rad.sin() * w;
        total_w += w;
    }
    if total_w <= 0.0 || (x.abs() < 1e-9 && y.abs() < 1e-9) {
        return None;
    }
    let deg = y.atan2(x).to_degrees();
    Some(pyround((deg + 360.0).rem_euclid(360.0), 0) as i64)
}

fn weighted_vote(pairs: &[(f64, f64)]) -> Option<i64> {
    // Per code, weights summed in member order (as the Python dict does).
    let mut tally: Vec<(i64, f64)> = Vec::new();
    for (code, w) in pairs {
        let code = *code as i64; // Python int(): truncates toward zero
        match tally.iter_mut().find(|(c, _)| *c == code) {
            Some(t) => t.1 += w,
            None => tally.push((code, *w)),
        }
    }
    tally
        .into_iter()
        .max_by(|a, b| {
            a.1.partial_cmp(&b.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.0.cmp(&b.0))
        })
        .map(|(c, _)| c)
}

fn round_var(var: &str, v: Option<f64>) -> Value {
    match v {
        None => Value::Null,
        Some(v)
            if matches!(
                var,
                "relative_humidity_2m" | "cloud_cover" | "visibility" | "cape"
            ) =>
        {
            json!(pyround(v, 0) as i64)
        }
        Some(v) => {
            let nd = if matches!(var, "precipitation" | "precipitation_sum" | "lifted_index") {
                2
            } else {
                1
            };
            json!(pyround(v, nd))
        }
    }
}

fn member_value<'a>(
    section: &'a Value,
    var: &str,
    model: &str,
    i: usize,
    single: bool,
) -> Option<&'a Value> {
    let key = if single {
        var.to_owned()
    } else {
        format!("{var}_{model}")
    };
    section
        .get(&key)
        .and_then(Value::as_array)
        .and_then(|a| a.get(i))
        .filter(|v| !v.is_null())
}

/// Options for [`blend_section`].
#[derive(Debug, Clone)]
pub struct SectionOptions<'a> {
    /// Read unsuffixed keys (a single-model response).
    pub single: bool,
    /// Rain amount at or above which a member "agrees" it rains.
    pub agreement_threshold: f64,
    /// The amount variable agreement is judged on.
    pub precip_var: &'a str,
}

impl Default for SectionOptions<'_> {
    fn default() -> Self {
        SectionOptions {
            single: false,
            agreement_threshold: 0.1,
            precip_var: "precipitation",
        }
    }
}

/// Blend one Open-Meteo section (`hourly` or `daily`) across members.
/// `section` holds model-suffixed arrays plus the shared `time` axis; the
/// result is an unsuffixed section in the canonical WeatherData shape.
pub fn blend_section(
    section: &Value,
    variables: &[&str],
    weights: &[(String, f64)],
    opts: &SectionOptions,
) -> Value {
    let times: Vec<Value> = section
        .get("time")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let n = times.len();
    let members = order_members(weights);
    let mut out = Map::new();
    out.insert("time".into(), Value::Array(times));

    for var in variables.iter().copied().filter(|v| *v != "time") {
        let mut series: Vec<Value> = Vec::with_capacity(n);
        for i in 0..n {
            if matches!(var, "is_day" | "sunrise" | "sunset") {
                let first = members
                    .iter()
                    .find_map(|m| member_value(section, var, m, i, opts.single))
                    .cloned()
                    .unwrap_or(Value::Null);
                series.push(first);
                continue;
            }

            let pairs: Vec<(f64, f64)> = members
                .iter()
                .filter_map(|m| {
                    num(member_value(section, var, m, i, opts.single))
                        .map(|v| (v, weight_of(weights, m)))
                })
                .collect();

            let value = match var {
                "wind_direction_10m" | "wind_direction_10m_dominant" => {
                    circular_mean(&pairs).map_or(Value::Null, |d| json!(d))
                }
                "weather_code" => weighted_vote(&pairs).map_or(Value::Null, |c| json!(c)),
                "precipitation_probability" | "precipitation_probability_max" => {
                    let ensemble = weighted_mean(&pairs);
                    let agree: Vec<(f64, f64)> = members
                        .iter()
                        .filter_map(|m| {
                            num(member_value(section, opts.precip_var, m, i, opts.single)).map(
                                |p| {
                                    (
                                        if p >= opts.agreement_threshold {
                                            1.0
                                        } else {
                                            0.0
                                        },
                                        weight_of(weights, m),
                                    )
                                },
                            )
                        })
                        .collect();
                    let agreement = weighted_mean(&agree);
                    match (ensemble, agreement) {
                        (None, None) => Value::Null,
                        (None, Some(a)) => json!(pyround(a * 100.0, 0) as i64),
                        (Some(e), None) => json!(pyround(e, 0) as i64),
                        (Some(e), Some(a)) => {
                            json!(pyround(0.5 * e + 0.5 * a * 100.0, 0) as i64)
                        }
                    }
                }
                _ => round_var(var, weighted_mean(&pairs)),
            };
            series.push(value);
        }
        out.insert(var.to_owned(), Value::Array(series));
    }
    Value::Object(out)
}

/// Open-Meteo's top-level `elevation` (metres) when it is a real value;
/// `None` for a missing, non-numeric or out-of-range value (`-9999` means "no
/// data"; real land spans about -430 m to 8 849 m).
pub fn forecast_elevation(raw: &Value) -> Option<f64> {
    let v = num(raw.get("elevation"))?;
    if v > -1000.0 && v < 9000.0 {
        Some(v)
    } else {
        None
    }
}

/// Turn a multi-model Open-Meteo response into one canonical payload:
/// `current`, `hourly`, `daily`, `current_units`, plus `utc_offset_seconds`,
/// `timezone` and `elevation` when reported. Intermediate fields (CAPE, lifted
/// index, dew point, ET0) are kept; the caller derives insights from them and
/// strips them ([`finalize_baseline`]).
pub fn blend_payload(raw: &Value, weights: &[(String, f64)], single: bool) -> Value {
    let empty = json!({});
    let hourly_vars: Vec<&str> = HOURLY_VARS.split(',').collect();
    let daily_vars: Vec<&str> = DAILY_VARS.split(',').collect();
    let hourly = blend_section(
        raw.get("hourly")
            .filter(|v| v.is_object())
            .unwrap_or(&empty),
        &hourly_vars,
        weights,
        &SectionOptions {
            single,
            ..SectionOptions::default()
        },
    );
    let daily = blend_section(
        raw.get("daily").filter(|v| v.is_object()).unwrap_or(&empty),
        &daily_vars,
        weights,
        &SectionOptions {
            single,
            agreement_threshold: 1.0,
            precip_var: "precipitation_sum",
        },
    );

    let mut current: Map<String, Value> = raw
        .get("current")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    current.remove("interval");
    let idx = insights::current_hour_index(&hourly, current.get("time").and_then(Value::as_str));
    for var in CURRENT_VARS.split(',') {
        if current.get(var).is_none_or(Value::is_null) {
            if let Some(v) = hourly
                .get(var)
                .and_then(Value::as_array)
                .and_then(|a| a.get(idx))
                .filter(|v| !v.is_null())
            {
                current.insert(var.to_owned(), v.clone());
            }
        }
    }

    let mut out = Map::new();
    out.insert("current".into(), Value::Object(current));
    out.insert("hourly".into(), hourly);
    out.insert("daily".into(), daily);
    out.insert(
        "current_units".into(),
        raw.get("current_units")
            .filter(|v| v.as_object().is_some_and(|o| !o.is_empty()))
            .cloned()
            .unwrap_or_else(|| json!({})),
    );
    if let Some(Value::Number(n)) = raw.get("utc_offset_seconds") {
        if let Some(f) = n.as_f64() {
            out.insert("utc_offset_seconds".into(), json!(f as i64));
        }
    }
    if let Some(zone) = raw
        .get("timezone")
        .and_then(Value::as_str)
        .filter(|z| !z.is_empty())
    {
        out.insert("timezone".into(), json!(zone));
    }
    if let Some(e) = forecast_elevation(raw) {
        out.insert("elevation".into(), json!(e));
    }
    Value::Object(out)
}

/// Members whose suffixed hourly temperature has at least one value.
pub fn members_with_data(raw: &Value, models: &[String]) -> Vec<String> {
    let hourly = raw.get("hourly");
    models
        .iter()
        .filter(|m| {
            hourly
                .and_then(|h| h.get(format!("temperature_2m_{m}")))
                .and_then(Value::as_array)
                .is_some_and(|a| a.iter().any(|v| !v.is_null()))
        })
        .cloned()
        .collect()
}

/// Whether `present` members are enough for a blend: at least
/// [`MIN_MEMBERS`], however many are configured (the Python judged against
/// `min(2, configured)`).
pub fn meets_floor(present: usize) -> bool {
    present >= MIN_MEMBERS
}

/// The nowcast from `minutely_15`, unsuffixed or the first member that has
/// data; keeps `steps` 15-minute steps (the serving path trims to the next
/// hour, [`fresh_minutely`]).
pub fn parse_minutely_any(raw: &Value, models: &[String], steps: usize) -> Option<Value> {
    let minutely = raw.get("minutely_15")?;
    let times = minutely.get("time").and_then(Value::as_array)?;
    if times.is_empty() {
        return None;
    }
    let get = |key: &str| minutely.get(key).filter(|v| !v.is_null());
    let mut precip: Option<&Value> = get("precipitation");
    if precip.is_none() {
        for m in models {
            precip = get(&format!("precipitation_{m}"));
            if precip
                .and_then(Value::as_array)
                .is_some_and(|a| a.iter().any(|v| !v.is_null()))
            {
                break;
            }
        }
    }
    let precip: Vec<&Value> = precip
        .and_then(Value::as_array)
        .map(|a| a.iter().collect())
        .unwrap_or_default();
    Some(json!({
        "time": times.iter().take(steps).cloned().collect::<Vec<_>>(),
        "precipitation": precip.iter().take(steps)
            .map(|p| if p.is_null() { json!(0) } else { (*p).clone() })
            .collect::<Vec<_>>(),
    }))
}

/// Derive insights from a baseline payload, then strip the intermediate
/// fields so the cached shape is the one the UI and history writer always saw.
pub fn finalize_baseline(payload: &Value, now: DateTime<Utc>) -> Value {
    let mut out = payload.clone();
    if out
        .get("current_units")
        .and_then(Value::as_object)
        .is_none_or(|o| o.is_empty())
    {
        out["current_units"] = crate::normalize::current_units();
    }
    let derived = insights::derive_insights(payload, now);
    out["insights"] = if derived.is_empty() {
        Value::Null
    } else {
        Value::Object(derived)
    };
    insights::strip_intermediate(&out)
}

/// The blended baseline from a multi-model response: blend, finalize, carry
/// the members' comparison series and the nowcast. `None` when fewer than
/// [`MIN_MEMBERS`] have data (the caller falls back to `best_match` without
/// recording a provider failure).
pub fn build_blend(
    raw: &Value,
    region: &str,
    weights: &[(String, f64)],
    now: DateTime<Utc>,
) -> Option<BlendOutcome> {
    let members = order_members(weights);
    let present = members_with_data(raw, &members);
    if !meets_floor(present.len()) {
        return None;
    }
    let used: Weights = present
        .iter()
        .map(|m| (m.clone(), weight_of(weights, m)))
        .collect();
    let payload = blend_payload(raw, &used, false);
    let mut payload = finalize_baseline(&payload, now);
    let (series, available) = crate::normalize::parse_models(raw, &present);
    payload["minutely"] =
        parse_minutely_any(raw, &members, MINUTELY_STEPS_FETCHED).unwrap_or(Value::Null);
    payload["models"] = Value::Array(series);
    payload["models_available"] = json!(available);
    payload["models_time"] = Value::Array(
        raw.pointer("/hourly/time")
            .and_then(Value::as_array)
            .map(|t| t.iter().take(24).cloned().collect())
            .unwrap_or_default(),
    );
    payload["baseline"] = json!({
        "provider": PROVIDER_BLEND,
        "blend": true,
        "region": region,
        "members": present,
        "membersConfigured": members.len(),
        "floor": MIN_MEMBERS,
    });
    let header = format_weights(region, &used);
    Some(BlendOutcome {
        payload,
        header,
        present: present.len(),
    })
}

/// A served blend and what it was made of.
#[derive(Debug, Clone)]
pub struct BlendOutcome {
    pub payload: Value,
    /// The `X-Weather-Blend` header value.
    pub header: String,
    pub present: usize,
}

/// Why the answer is `best_match` and not a blend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotBlended {
    /// Fewer than [`MIN_MEMBERS`] members returned data.
    TooFewMembers(usize),
    /// The multi-model request failed (5xx, 429, timeout, unreadable body).
    UpstreamError,
    /// The Open-Meteo circuit breaker was open for the multi-model request.
    CircuitOpen,
    /// The request was rejected (4xx): our request, not an outage.
    Rejected,
}

impl NotBlended {
    pub fn reason(self) -> &'static str {
        match self {
            NotBlended::TooFewMembers(_) => "too_few_members",
            NotBlended::UpstreamError => "upstream_error",
            NotBlended::CircuitOpen => "circuit_open",
            NotBlended::Rejected => "request_rejected",
        }
    }
}

/// What the multi-model Open-Meteo request came to (the Worker's fetch
/// result, without the transport).
#[derive(Debug, Clone, Copy)]
pub enum Upstream<'a> {
    /// A 200 with a readable body.
    Body(&'a Value),
    /// A 4xx: our request was rejected. Not an outage.
    Rejected,
    /// A 5xx, 429, timeout, transport error or unreadable body: an outage.
    Failed,
    /// The Open-Meteo circuit breaker would not let the request go out.
    BreakerOpen,
}

/// The decision for one blend attempt.
#[derive(Debug, Clone)]
pub enum Attempt {
    /// Serve this blend; the breaker records a success.
    Blended(BlendOutcome),
    /// Fall back to `best_match`, marked with `why`. `breaker_failure` is true
    /// ONLY for an outage: "too few members", "no data here" and a rejected
    /// request must not count against the shared breaker (they would open it
    /// for everyone).
    Fallback {
        why: NotBlended,
        breaker_failure: bool,
    },
}

/// Decide a blend attempt: every member that returned data is used, weights
/// renormalised over those present; fewer than [`MIN_MEMBERS`] (or an outage)
/// is a labelled `best_match`, never a blend.
pub fn attempt_blend(
    upstream: Upstream,
    region: &str,
    weights: &[(String, f64)],
    now: DateTime<Utc>,
) -> Attempt {
    match upstream {
        Upstream::BreakerOpen => Attempt::Fallback {
            why: NotBlended::CircuitOpen,
            breaker_failure: false,
        },
        Upstream::Rejected => Attempt::Fallback {
            why: NotBlended::Rejected,
            breaker_failure: false,
        },
        Upstream::Failed => Attempt::Fallback {
            why: NotBlended::UpstreamError,
            breaker_failure: true,
        },
        Upstream::Body(raw) => match build_blend(raw, region, weights, now) {
            Some(out) => Attempt::Blended(out),
            None => Attempt::Fallback {
                why: NotBlended::TooFewMembers(
                    members_with_data(raw, &order_members(weights)).len(),
                ),
                breaker_failure: false,
            },
        },
    }
}

/// The `best_match` baseline from a single-request Open-Meteo response
/// (current, hourly, daily as returned), marked as NOT a blend. `None` when it
/// carries no hourly temperature (no data here).
pub fn best_match_payload(raw: &Value, why: NotBlended, now: DateTime<Utc>) -> Option<Value> {
    let has_temps = raw
        .pointer("/hourly/temperature_2m")
        .and_then(Value::as_array)
        .is_some_and(|a| a.iter().any(|v| !v.is_null()));
    if !has_temps || !raw.get("daily").is_some_and(Value::is_object) {
        return None;
    }
    let mut current: Map<String, Value> = raw
        .get("current")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    current.remove("interval");
    let mut result = json!({
        "current": current,
        "hourly": raw.get("hourly").cloned().unwrap_or_else(|| json!({})),
        "daily": raw.get("daily").cloned().unwrap_or_else(|| json!({})),
        "current_units": raw.get("current_units").cloned().unwrap_or_else(crate::normalize::current_units),
    });
    result = finalize_baseline(&result, now);
    result["minutely"] =
        parse_minutely_any(raw, &[], MINUTELY_STEPS_FETCHED).unwrap_or(Value::Null);
    if let Some(Value::Number(n)) = raw.get("utc_offset_seconds") {
        if let Some(f) = n.as_f64() {
            result["utc_offset_seconds"] = json!(f as i64);
        }
    }
    if let Some(zone) = raw
        .get("timezone")
        .and_then(Value::as_str)
        .filter(|z| !z.is_empty())
    {
        result["timezone"] = json!(zone);
    }
    if let Some(e) = forecast_elevation(raw) {
        result["elevation"] = json!(e);
    }
    let mut baseline = json!({
        "provider": PROVIDER_BEST_MATCH,
        "blend": false,
        "reason": why.reason(),
        "floor": MIN_MEMBERS,
    });
    if let NotBlended::TooFewMembers(n) = why {
        baseline["membersPresent"] = json!(n);
    }
    result["baseline"] = baseline;
    Some(result)
}

// ---------------------------------------------------------------------------
// Serving rules (api/py/_weather.py)
// ---------------------------------------------------------------------------

/// Solar-meridian UTC offset estimate (15 degrees an hour, quarter-hour
/// steps). A last resort for payloads no provider gave an offset for.
pub fn estimate_utc_offset(lon: f64) -> i64 {
    if !lon.is_finite() {
        return 0;
    }
    pyround(lon / 15.0 * 4.0, 0) as i64 * 900
}

/// Guarantee `utc_offset_seconds`: every consumer reads "now" and hour labels
/// in the LOCATION's time zone, so the offset must always be present. A
/// provider value wins; otherwise a longitude estimate is stamped with
/// `utc_offset_estimated: true`.
pub fn ensure_utc_offset(data: &mut Value, lon: f64) {
    let has = matches!(data.get("utc_offset_seconds"), Some(Value::Number(_)));
    if !has {
        data["utc_offset_seconds"] = json!(estimate_utc_offset(lon));
        data["utc_offset_estimated"] = json!(true);
    }
}

/// Trim a (possibly cached) nowcast to the next four 15-minute steps. Minutely
/// times are the location's naive wall clock; anything before the current
/// quarter-hour is dropped. `None` (JSON null) when nothing is left.
pub fn fresh_minutely(minutely: &Value, offset_seconds: i64, now: DateTime<Utc>) -> Value {
    let Some(times) = minutely.get("time").and_then(Value::as_array) else {
        return minutely.clone();
    };
    if times.is_empty() {
        return minutely.clone();
    }
    let local = now + chrono::Duration::seconds(offset_seconds);
    let cutoff = {
        use chrono::Timelike;
        let m = (local.minute() / 15) * 15;
        local
            .with_minute(m)
            .and_then(|t| t.with_second(0))
            .map(|t| t.format("%Y-%m-%dT%H:%M").to_string())
            .unwrap_or_default()
    };
    let precip = minutely
        .get("precipitation")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let keep: Vec<usize> = times
        .iter()
        .enumerate()
        .filter(|(_, t)| {
            let s = t.as_str().unwrap_or("");
            let s16: String = s.chars().take(16).collect();
            s16 >= cutoff
        })
        .map(|(i, _)| i)
        .take(4)
        .collect();
    if keep.is_empty() {
        return Value::Null;
    }
    json!({
        "time": keep.iter().map(|i| times[*i].clone()).collect::<Vec<_>>(),
        "precipitation": keep.iter().map(|i| precip.get(*i).cloned().unwrap_or(json!(0))).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn fx() -> Value {
        serde_json::from_str(include_str!("../../../../tests/fixtures/model-blend.json")).unwrap()
    }

    fn weights_from(v: &Value) -> Weights {
        v.as_object()
            .unwrap()
            .iter()
            .map(|(k, w)| (k.clone(), w.as_f64().unwrap()))
            .collect()
    }

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(fx()["now"].as_str().unwrap())
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn regions_match_the_python() {
        let fx = fx();
        let rows = fx["regions"].as_array().unwrap();
        assert!(rows.len() >= 25);
        for r in rows {
            let got = region_for(r["lat"].as_f64().unwrap(), r["lon"].as_f64().unwrap());
            assert_eq!(got, r["expected"], "{}", r["name"]);
        }
    }

    #[test]
    fn the_named_cities_are_in_the_expected_regions() {
        assert_eq!(region_for(-17.83, 31.05), "southern-africa"); // Harare
        assert_eq!(region_for(-1.29, 36.82), "east-africa"); // Nairobi
        assert_eq!(region_for(6.52, 3.38), "west-africa-sahel"); // Lagos
        assert_eq!(region_for(30.04, 31.24), "north-africa"); // Cairo
        assert_eq!(region_for(51.5, -0.12), "europe"); // London
        assert_eq!(region_for(1.35, 103.82), "southeast-asia"); // Singapore
        assert_eq!(region_for(0.0, -30.0), "default"); // open ocean
    }

    #[test]
    fn weights_orders_and_headers_match_the_python() {
        let fx = fx();
        for w in fx["weights"].as_array().unwrap() {
            let region = w["region"].as_str().unwrap();
            let got = weights_for(region);
            let want = weights_from(&w["expected"]);
            let mut got_sorted = got.clone();
            got_sorted.sort_by(|a, b| a.0.cmp(&b.0));
            let mut want_sorted = want.clone();
            want_sorted.sort_by(|a, b| a.0.cmp(&b.0));
            assert_eq!(got_sorted, want_sorted, "{region}");
            let order: Vec<String> = w["order"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_owned())
                .collect();
            assert_eq!(order_members(&got), order, "{region}");
            assert_eq!(
                format_weights(region, &got),
                w["header"].as_str().unwrap(),
                "{region}"
            );
        }
        for f in fx["format_weights"].as_array().unwrap() {
            let w = weights_from(&f["weights"]);
            assert_eq!(
                format_weights(f["region"].as_str().unwrap(), &w),
                f["expected"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn every_region_has_a_weights_entry_and_the_table_matches() {
        for r in REGIONS {
            let w = weights_for(r);
            assert_eq!(w.len(), 9, "{r}: the original six plus three newer members");
            let get = |m: &str| w.iter().find(|(k, _)| k == m).unwrap().1;
            // The original six are exactly as they were.
            for (m, want) in [
                (ECMWF_IFS, 0.35),
                (ECMWF_AIFS, 0.25),
                (GFS, 0.15),
                (ICON, 0.15),
                (GEM, 0.05),
                (ARPEGE, 0.05),
            ] {
                assert_eq!(get(m), want, "{r} {m}");
            }
            // The newer ones start small (0.03 to 0.08), and ECMWF still leads.
            for m in [UKMO, CMA, JMA] {
                assert!((0.03..=0.08).contains(&get(m)), "{r} {m}");
            }
            assert_eq!(order_members(&w)[0], ECMWF_IFS, "{r}");
            let total: f64 = w.iter().map(|(_, x)| x).sum();
            let ecmwf = (get(ECMWF_IFS) + get(ECMWF_AIFS)) / total;
            assert!(ecmwf >= 0.5, "{r}: ECMWF share {ecmwf}");
            assert!(w
                .iter()
                .all(|(m, _)| BLENDABLE_MODELS.contains(&m.as_str())));
        }
        // Every box names a known region.
        for (r, _) in REGION_BOXES.iter() {
            assert!(REGIONS.contains(r), "{r}");
        }
        // Africa leads with the Met Office; the Asian regional centres get a little more at home.
        let africa = weights_for("southern-africa");
        let asia = weights_for("east-asia");
        let w = |ws: &Weights, m: &str| ws.iter().find(|(k, _)| k == m).unwrap().1;
        assert_eq!(w(&africa, UKMO), 0.08);
        assert_eq!(w(&asia, JMA), 0.05);
        // An unknown region gets the default.
        assert_eq!(weights_for("atlantis"), weights_for("default"));
    }

    #[test]
    fn blend_sections_match_the_python() {
        let fx = fx();
        for case in fx["blend_section"].as_array().unwrap() {
            let vars: Vec<&str> = case["variables"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap())
                .collect();
            let opts = SectionOptions {
                single: case["single"].as_bool().unwrap_or(false),
                agreement_threshold: case["agreement_threshold"].as_f64().unwrap_or(0.1),
                precip_var: case["precip_var"].as_str().unwrap_or("precipitation"),
            };
            let got = blend_section(
                &case["section"],
                &vars,
                &weights_from(&case["weights"]),
                &opts,
            );
            assert_eq!(got, case["expected"], "{}", case["name"]);
        }
    }

    #[test]
    fn wind_direction_wraps_through_north() {
        let w = vec![("a".to_owned(), 1.0), ("b".to_owned(), 1.0)];
        let s = json!({"time": ["t"], "wind_direction_10m_a": [350], "wind_direction_10m_b": [10]});
        let out = blend_section(&s, &["wind_direction_10m"], &w, &SectionOptions::default());
        // The mean of 350 and 10 degrees is north, not south (180).
        let d = out["wind_direction_10m"][0].as_i64().unwrap();
        assert!(d == 0 || d == 360, "{d}");
    }

    #[test]
    fn tied_codes_go_to_the_more_severe() {
        let w = vec![("a".to_owned(), 0.5), ("b".to_owned(), 0.5)];
        let s = json!({"time": ["t"], "weather_code_a": [3], "weather_code_b": [61]});
        let out = blend_section(&s, &["weather_code"], &w, &SectionOptions::default());
        assert_eq!(out["weather_code"][0], 61);
    }

    #[test]
    fn full_payloads_match_the_python() {
        let fx = fx();
        let now = now();
        let mut checked = 0;
        for case in fx["blend_payload"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let present: Vec<String> = case["present"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_owned())
                .collect();
            let region = case["region"].as_str().unwrap();
            let all = order_members(&weights_for(region));
            assert_eq!(members_with_data(&case["raw"], &all), present, "{name}");
            assert_eq!(
                parse_minutely_any(&case["raw"], &all, 8).unwrap_or(Value::Null),
                case["minutely"],
                "{name}"
            );
            assert_eq!(
                forecast_elevation(&case["raw"])
                    .map(|e| json!(e))
                    .unwrap_or(Value::Null),
                case["elevation"],
                "{name}"
            );
            if case.get("expected").is_none() {
                continue;
            }
            let used = weights_from(&case["weights_used"]);
            let got = blend_payload(&case["raw"], &used, false);
            assert_eq!(got, case["expected"], "{name}");
            let derived = insights::derive_insights(&got, now);
            assert_eq!(Value::Object(derived), case["insights"], "{name}");
            let used_ordered: Weights = present
                .iter()
                .map(|m| (m.clone(), weight_of(&used, m)))
                .collect();
            assert_eq!(
                format_weights(region, &used_ordered),
                case["header"].as_str().unwrap(),
                "{name}"
            );
            checked += 1;
        }
        assert!(checked >= 3);
    }

    #[test]
    fn the_floor_is_four_members() {
        let fx = fx();
        let now = now();
        // (fixture case name, expected present, served as a blend?)
        for (name, present, blended) in [
            ("nine members, seed 1", 9, true),
            (
                "the original six present, the three newer members absent",
                6,
                true,
            ),
            (
                "eight present, one member all-null (dropped, weights renormalised)",
                8,
                true,
            ),
            ("four members present (floor)", 4, true),
            ("three members present (below the new floor)", 3, false),
            ("one member present", 1, false),
        ] {
            let case = fx["blend_payload"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["name"] == name)
                .unwrap();
            assert_eq!(case["expected_present_count"], present, "{name}");
            let region = case["region"].as_str().unwrap();
            let out = build_blend(&case["raw"], region, &weights_for(region), now);
            assert_eq!(out.is_some(), blended, "{name}");
            if let Some(out) = out {
                assert_eq!(out.present, present as usize);
                assert_eq!(out.payload["baseline"]["blend"], true);
                assert_eq!(out.payload["baseline"]["provider"], PROVIDER_BLEND);
                assert_eq!(
                    out.payload["models_available"].as_array().unwrap().len(),
                    present as usize
                );
            }
        }
        assert!(meets_floor(4) && !meets_floor(3) && meets_floor(9));
        // However few members are configured, fewer than four present is never a blend.
        assert!(!meets_floor(2) && !meets_floor(0));
        assert_eq!(MIN_MEMBERS, 4);
    }

    fn fixture_case(name: &str) -> Value {
        fx()["blend_payload"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == name)
            .unwrap()
            .clone()
    }

    #[test]
    fn more_members_than_the_floor_are_all_used() {
        let case = fixture_case("nine members, seed 1");
        let region = case["region"].as_str().unwrap();
        let out = build_blend(&case["raw"], region, &weights_for(region), now()).unwrap();
        assert_eq!(
            out.present, 9,
            "the floor is a minimum, not the size of the blend"
        );
        assert_eq!(
            out.payload["baseline"]["members"].as_array().unwrap().len(),
            9
        );
        assert_eq!(out.payload["baseline"]["membersConfigured"], 9);
        for m in [UKMO, CMA, JMA] {
            assert!(
                out.header.contains(&format!("{m}=")),
                "{m} is in {}",
                out.header
            );
        }
        // The nine-member blend differs from what the original six give: the
        // newer members really contribute.
        let six: Weights = weights_for(region)
            .into_iter()
            .filter(|(m, _)| ![UKMO, CMA, JMA].contains(&m.as_str()))
            .collect();
        let with_six = build_blend(&case["raw"], region, &six, now()).unwrap();
        assert_ne!(
            out.payload["hourly"]["temperature_2m"],
            with_six.payload["hourly"]["temperature_2m"]
        );
    }

    #[test]
    fn a_member_with_no_data_is_dropped_and_the_weights_renormalise() {
        let case =
            fixture_case("eight present, one member all-null (dropped, weights renormalised)");
        let region = case["region"].as_str().unwrap();
        let all = weights_for(region);
        let out = build_blend(&case["raw"], region, &all, now()).unwrap();
        assert_eq!(out.present, 8);
        let members = out.payload["baseline"]["members"].as_array().unwrap();
        assert!(
            !members.iter().any(|m| m == JMA),
            "the all-null member is dropped"
        );
        assert_eq!(out.payload["models_available"].as_array().unwrap().len(), 8);
        assert!(!out.header.contains(JMA), "{}", out.header);

        // The header weights are normalised over the eight present and add up to 1.
        let shares: Vec<f64> = out
            .header
            .split("; ")
            .nth(1)
            .unwrap()
            .split(',')
            .map(|p| p.split('=').nth(1).unwrap().parse().unwrap())
            .collect();
        assert_eq!(shares.len(), 8);
        assert!(
            (shares.iter().sum::<f64>() - 1.0).abs() <= 8.0 * 0.005 + 1e-9,
            "{shares:?}"
        );
        // East Asia: 0.35 of (1.17 - 0.05 for JMA) = 0.3125; with all nine it would be 0.299.
        assert!(out.header.contains("ecmwf_ifs=0.31"), "{}", out.header);

        // Exactly the blend over the eight present, not a blend that still
        // counts the missing member's weight.
        let eight: Weights = all.into_iter().filter(|(m, _)| m != JMA).collect();
        assert_eq!(
            out.payload["hourly"]["temperature_2m"],
            blend_payload(&case["raw"], &eight, false)["hourly"]["temperature_2m"]
        );
    }

    #[test]
    fn an_outage_is_a_labelled_best_match_and_only_an_outage_counts_against_the_breaker() {
        let region = "southern-africa";
        let w = weights_for(region);
        let nine = fixture_case("nine members, seed 1");
        let three = fixture_case("three members present (below the new floor)");
        let empty = json!({"hourly": {}});

        // The provider is down (5xx, 429, timeout, unreadable body).
        assert!(matches!(
            attempt_blend(Upstream::Failed, region, &w, now()),
            Attempt::Fallback {
                why: NotBlended::UpstreamError,
                breaker_failure: true
            }
        ));
        // A rejected request, an open breaker, too few members: not outages.
        for (up, why) in [
            (Upstream::Rejected, NotBlended::Rejected),
            (Upstream::BreakerOpen, NotBlended::CircuitOpen),
            (Upstream::Body(&three["raw"]), NotBlended::TooFewMembers(3)),
            (Upstream::Body(&empty), NotBlended::TooFewMembers(0)),
        ] {
            match attempt_blend(up, region, &w, now()) {
                Attempt::Fallback {
                    why: got,
                    breaker_failure,
                } => {
                    assert_eq!(got, why);
                    assert!(
                        !breaker_failure,
                        "{why:?} must not open the breaker for everyone"
                    );
                }
                Attempt::Blended(_) => panic!("{why:?} was served as a blend"),
            }
        }
        match attempt_blend(Upstream::Body(&nine["raw"]), region, &w, now()) {
            Attempt::Blended(out) => assert_eq!(out.present, 9),
            Attempt::Fallback { .. } => panic!("nine members is a blend"),
        }
        // Every fallback is labelled as such in the answer.
        let raw = json!({
            "hourly": {"time": ["2026-10-31T10:00"], "temperature_2m": [24.0]},
            "daily": {"time": ["2026-10-31"]},
        });
        for why in [
            NotBlended::UpstreamError,
            NotBlended::CircuitOpen,
            NotBlended::TooFewMembers(2),
        ] {
            let p = best_match_payload(&raw, why, now()).unwrap();
            assert_eq!(p["baseline"]["blend"], false);
            assert_eq!(p["baseline"]["provider"], PROVIDER_BEST_MATCH);
            assert_eq!(p["baseline"]["reason"], why.reason());
        }
    }

    #[test]
    fn the_db_override_matches_the_python_and_cannot_break_the_floor() {
        for c in fx()["weights_override"].as_array().unwrap() {
            let region = c["region"].as_str().unwrap();
            let mut got = c["doc"]
                .get("weights")
                .and_then(sanitize_override)
                .unwrap_or_else(|| weights_for(region));
            got.sort_by(|a, b| a.0.cmp(&b.0));
            let mut want = weights_from(&c["expected"]);
            want.sort_by(|a, b| a.0.cmp(&b.0));
            assert_eq!(got, want, "{}", c["name"]);
        }
        // An override naming fewer than four models could never make a blend.
        assert!(usable_override(&json!({"ecmwf_ifs": 0.6, "gfs_seamless": 0.4})).is_none());
        let four = json!({"ecmwf_ifs": 0.4, "gfs_seamless": 0.2, "icon_global": 0.2, UKMO: 0.2});
        assert_eq!(usable_override(&four).unwrap().len(), 4);
        // A tuned newer member is honoured, and the override replaces the set.
        let tuned = usable_override(&json!({
            "ecmwf_ifs": 0.3, "ecmwf_aifs025_single": 0.2, "gfs_seamless": 0.1, UKMO: 0.4
        }))
        .unwrap();
        assert_eq!(order_members(&tuned)[0], UKMO);
        let case = fixture_case("nine members, seed 1");
        let out = build_blend(&case["raw"], "southern-africa", &tuned, now()).unwrap();
        assert_eq!(out.present, 4, "only the overridden members are used");
    }

    #[test]
    fn a_blend_is_finalized_without_intermediate_fields() {
        let fx = fx();
        let case = &fx["blend_payload"][0];
        let region = case["region"].as_str().unwrap();
        let out = build_blend(&case["raw"], region, &weights_for(region), now()).unwrap();
        let hourly = out.payload["hourly"].as_object().unwrap();
        for k in ["cape", "lifted_index", "dew_point_2m"] {
            assert!(!hourly.contains_key(k), "{k}");
        }
        assert!(!out.payload["daily"]
            .as_object()
            .unwrap()
            .contains_key("et0_fao_evapotranspiration"));
        assert_eq!(out.payload["insights"], case["insights"]);
        assert_eq!(out.payload["minutely"]["time"].as_array().unwrap().len(), 8);
        // Normalised over the nine: 0.35 of 1.16.
        assert!(out
            .header
            .starts_with("southern-africa; ecmwf_ifs=0.30,ecmwf_aifs025_single=0.22,"));
        assert_eq!(out.payload["utc_offset_seconds"], 7200);
        assert_eq!(out.payload["timezone"], "Africa/Harare");
    }

    #[test]
    fn best_match_is_marked_as_not_a_blend() {
        let raw = json!({
            "current": {"time": "2026-10-31T10:15", "interval": 900, "temperature_2m": 24.0,
                        "relative_humidity_2m": 50, "weather_code": 3, "cloud_cover": 60},
            "hourly": {"time": ["2026-10-31T10:00"], "temperature_2m": [24.0], "dew_point_2m": [12.0], "cape": [0]},
            "daily": {"time": ["2026-10-31"], "temperature_2m_max": [30.0], "temperature_2m_min": [14.0],
                      "et0_fao_evapotranspiration": [5.0]},
            "minutely_15": {"time": ["a", "b"], "precipitation": [0.0, null]},
            "utc_offset_seconds": 7200, "timezone": "Africa/Harare", "elevation": 1490.0,
        });
        let out = best_match_payload(&raw, NotBlended::TooFewMembers(3), now()).unwrap();
        assert_eq!(out["baseline"]["blend"], false);
        assert_eq!(out["baseline"]["provider"], PROVIDER_BEST_MATCH);
        assert_eq!(out["baseline"]["reason"], "too_few_members");
        assert_eq!(out["baseline"]["membersPresent"], 3);
        assert_eq!(out["insights"]["dewPoint"], 12.0);
        assert!(out["current"].get("interval").is_none());
        assert!(
            out["hourly"].get("cape").is_none(),
            "intermediates stripped"
        );
        assert_eq!(out["minutely"]["precipitation"], json!([0.0, 0]));
        assert_eq!(out["timezone"], "Africa/Harare");
        // No hourly temperature is "no data here", not a forecast.
        assert!(best_match_payload(
            &json!({"hourly": {"temperature_2m": [null]}, "daily": {}}),
            NotBlended::UpstreamError,
            now()
        )
        .is_none());
    }

    #[test]
    fn urls_request_every_member_and_the_insight_inputs() {
        let w = weights_for("default");
        let models = request_models(&w);
        assert_eq!(models.len(), 9);
        assert_eq!(
            models[0], ECMWF_IFS,
            "the heaviest member is first: it supplies current"
        );
        let url = open_meteo_url(-17.83, 31.05, &models);
        assert!(url.contains("latitude=-17.83&longitude=31.05"));
        assert!(url.contains("models=ecmwf_ifs,ecmwf_aifs025_single,gfs_seamless,icon_global,ukmo_global_deterministic_10km,cma_grapes_global,gem_global,meteofrance_arpege_world,jma_gsm"));
        assert!(url.contains("cape,lifted_index"));
        assert!(url.contains("et0_fao_evapotranspiration"));
        assert!(url.contains("forecast_minutely_15=8"));
        assert!(!open_meteo_url(1.0, 2.0, &[]).contains("models="));
        assert_eq!(
            request_models(&[("gfs_seamless".to_owned(), 1.0)]),
            vec!["gfs_seamless", "best_match"]
        );
    }

    #[test]
    fn forecast_elevation_matches_the_python() {
        for c in fx()["forecast_elevation"].as_array().unwrap() {
            let got = forecast_elevation(&c["raw"])
                .map(|e| json!(e))
                .unwrap_or(Value::Null);
            assert_eq!(got, c["expected"], "{}", c["raw"]);
        }
    }

    #[test]
    fn minutely_any_matches_the_python() {
        for c in fx()["minutely_any"].as_array().unwrap() {
            let models: Vec<String> = c["models"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_owned())
                .collect();
            let got = parse_minutely_any(&c["raw"], &models, c["steps"].as_u64().unwrap() as usize)
                .unwrap_or(Value::Null);
            assert_eq!(got, c["expected"], "{}", c["name"]);
        }
    }

    #[test]
    fn python_rounding_is_reproduced() {
        assert_eq!(pyround(2.5, 0), 2.0);
        assert_eq!(pyround(3.5, 0), 4.0);
        assert_eq!(pyround(0.5, 0), 0.0);
        assert_eq!(pyround(2.675, 2), 2.67); // the binary value is below the tie
        assert_eq!(pyround(-1.25, 1), -1.2);
    }

    #[test]
    fn the_utc_offset_is_always_present() {
        let mut d = json!({"utc_offset_seconds": 7200});
        ensure_utc_offset(&mut d, 100.0);
        assert_eq!(d["utc_offset_seconds"], 7200);
        assert!(d.get("utc_offset_estimated").is_none());
        let mut d = json!({});
        ensure_utc_offset(&mut d, 31.05);
        assert_eq!(d["utc_offset_seconds"], 7200);
        assert_eq!(d["utc_offset_estimated"], true);
        assert_eq!(estimate_utc_offset(-77.0), -18900);
        assert_eq!(estimate_utc_offset(f64::NAN), 0);
    }

    #[test]
    fn a_cached_nowcast_never_starts_in_the_past() {
        let m = json!({
            "time": ["2026-10-31T11:45", "2026-10-31T12:00", "2026-10-31T12:15", "2026-10-31T12:30",
                     "2026-10-31T12:45", "2026-10-31T13:00", "2026-10-31T13:15", "2026-10-31T13:30"],
            "precipitation": [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
        });
        // 10:20 UTC at +2:00 is 12:20 local: the floor is 12:15.
        let now = Utc.with_ymd_and_hms(2026, 10, 31, 10, 20, 0).unwrap();
        let out = fresh_minutely(&m, 7200, now);
        assert_eq!(out["time"][0], "2026-10-31T12:15");
        assert_eq!(out["precipitation"], json!([0.3, 0.4, 0.5, 0.6]));
        // Everything is in the past.
        let later = Utc.with_ymd_and_hms(2026, 10, 31, 14, 0, 0).unwrap();
        assert_eq!(fresh_minutely(&m, 7200, later), Value::Null);
        assert_eq!(fresh_minutely(&Value::Null, 0, now), Value::Null);
    }
}
