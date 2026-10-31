//! Weather history: what the store holds, what is missing, and the external
//! archives that fill the gap (#268, #245).
//!
//! Owner decision (#268): history reads our own data first and pulls ONLY the
//! missing dates from an external archive API. We never host a reanalysis.
//! The pure parts live here and are tested natively against fixtures made by
//! the real Python functions of PR #285 (`tests/fixtures/history-days.json`,
//! real NASA POWER and Open-Meteo responses): the canonical day mapping, the
//! gap-fills NASA POWER needs (a derived WMO code, Steadman apparent
//! temperature, NOAA sunrise and sunset), the range arithmetic, and the shape
//! of a stored day. `mukoko-weather-places` only does the I/O.
//!
//! The standards rule applies: a provider's names and units never become ours.
//! Both providers are converted at the edge to one canonical day (Open-Meteo
//! daily variable names, km/h, hPa, degrees Celsius, ISO 8601 dates), and only
//! that form is stored or served.
//!
//! Sources of a day (`source`): `recorded` (our own forecast jobs, never
//! overwritten), `nasa-power`, `open-meteo-archive`. Recorded beats archive on
//! a date; archive days are written insert-only.

use std::collections::BTreeSet;

use chrono::{Datelike, Duration, NaiveDate};
use serde_json::{json, Map, Value};

pub const SOURCE_RECORDED: &str = "recorded";
pub const SOURCE_NASA_POWER: &str = "nasa-power";
pub const SOURCE_OPEN_METEO_ARCHIVE: &str = "open-meteo-archive";

/// Earliest date a request may ask for (ERA5 starts in 1940).
pub const EARLIEST_DATE: &str = "1940-01-01";
/// Widest range one request may ask for (about ten years).
pub const MAX_RANGE_DAYS: i64 = 3660;
/// Widest window a bare coordinate may ask for (clamped to the newest year).
pub const COORD_MAX_RANGE_DAYS: i64 = 366;
/// Upstream calls one request may make, across providers and chunks.
pub const MAX_FETCHES_PER_CALL: usize = 6;
/// Missing runs closer than this are fetched as one span.
pub const RUN_MERGE_GAP_DAYS: i64 = 31;
/// Days one bridge write carries (the bridge accepts 800; at about 0.8 KB a day
/// 500 stays far inside its 1 MiB body cap).
pub const MAX_DAYS_PER_WRITE: usize = 500;

/// The canonical daily fields a provider may supply (Open-Meteo names).
pub const CANONICAL_DAILY_FIELDS: [&str; 19] = [
    "weather_code",
    "temperature_2m_max",
    "temperature_2m_min",
    "temperature_2m_mean",
    "apparent_temperature_max",
    "apparent_temperature_min",
    "apparent_temperature_mean",
    "precipitation_sum",
    "sunrise",
    "sunset",
    "wind_speed_10m_max",
    "wind_gusts_10m_max",
    "wind_direction_10m_dominant",
    "wind_speed_10m_mean",
    "relative_humidity_2m_mean",
    "cloud_cover_mean",
    "surface_pressure_mean",
    "dew_point_2m_mean",
    "et0_fao_evapotranspiration",
];

/// One canonical day: `date` plus the fields a provider supplied.
pub type Day = Map<String, Value>;

// --- numbers and dates -------------------------------------------------------

/// Python's `round(x, n)`: correctly rounded from the exact binary value, ties
/// to even, which is what Rust's `{:.n}` formatting does too.
pub fn round_py(x: f64, n: usize) -> f64 {
    format!("{x:.n$}").parse().unwrap_or(x)
}

fn parse_date(d: &str) -> Option<NaiveDate> {
    if d.len() != 10 {
        return None;
    }
    NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()
}

/// A valid `YYYY-MM-DD` calendar date, else `None`.
pub fn valid_date(d: &str) -> Option<String> {
    parse_date(d).map(|d| d.format("%Y-%m-%d").to_string())
}

fn iso(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

/// Every date from `start` to `end` inclusive (empty when start > end).
pub fn date_span(start: &str, end: &str) -> Vec<String> {
    let (Some(s), Some(e)) = (parse_date(start), parse_date(end)) else {
        return Vec::new();
    };
    let n = (e - s).num_days();
    (0..=n).map(|i| iso(s + Duration::days(i))).collect()
}

/// The span of a range in days (inclusive), 0 when malformed or reversed.
pub fn span_days(start: &str, end: &str) -> i64 {
    match (parse_date(start), parse_date(end)) {
        (Some(s), Some(e)) if e >= s => (e - s).num_days() + 1,
        _ => 0,
    }
}

/// Solar-meridian UTC offset in seconds (15 degrees per hour, quarter-hour
/// steps). The same estimator as `/api/py/weather` and `location-time.ts`.
pub fn estimate_utc_offset_seconds(lon: f64) -> i64 {
    if !lon.is_finite() {
        return 0;
    }
    (lon / 15.0 * 4.0).round_ties_even() as i64 * 900
}

/// The place's local calendar date at `now_ms` (epoch milliseconds).
pub fn local_today(lon: f64, now_ms: u64) -> String {
    let secs = (now_ms / 1000) as i64 + estimate_utc_offset_seconds(lon);
    chrono::DateTime::from_timestamp(secs, 0)
        .unwrap_or_default()
        .format("%Y-%m-%d")
        .to_string()
}

/// `(start, end)` for "the last `days` local days, today included".
pub fn window_for_days(days: i64, today: &str) -> (String, String) {
    let t = parse_date(today).unwrap_or_default();
    (iso(t - Duration::days(days.max(1) - 1)), iso(t))
}

/// Validate the requested window and return `(start, end)` inclusive.
/// `start`/`end` win over `days`; `end` defaults to today and is clamped to
/// it. The error strings are the 400 details (those of the Python route).
pub fn resolve_range(
    days: Option<i64>,
    start: Option<&str>,
    end: Option<&str>,
    today: &str,
) -> Result<(String, String), String> {
    if start.is_some() || end.is_some() {
        let Some(start) = start else {
            return Err("start is required when end is given".into());
        };
        let s = valid_date(start).ok_or("start must be YYYY-MM-DD")?;
        let e = match end {
            Some(e) => valid_date(e).ok_or("end must be YYYY-MM-DD")?,
            None => today.to_owned(),
        };
        let e = if e.as_str() > today {
            today.to_owned()
        } else {
            e
        };
        if s.as_str() < EARLIEST_DATE {
            return Err(format!("start must be on or after {EARLIEST_DATE}"));
        }
        if s > e {
            return Err("start must be on or before end (and not in the future)".into());
        }
        if span_days(&s, &e) > MAX_RANGE_DAYS {
            return Err(format!("range must be at most {MAX_RANGE_DAYS} days"));
        }
        return Ok((s, e));
    }
    let n = days.unwrap_or(30);
    if !(1..=MAX_RANGE_DAYS).contains(&n) {
        return Err(format!("days must be between 1 and {MAX_RANGE_DAYS}"));
    }
    Ok(window_for_days(n, today))
}

/// Past dates in `start..end` with no stored day, oldest first. Today and the
/// future are excluded: no archive has them, and today is recorded live.
pub fn missing_dates(
    existing: &[String],
    start: &str,
    end: &str,
    lon: f64,
    now_ms: u64,
) -> Vec<String> {
    let today = parse_date(&local_today(lon, now_ms)).unwrap_or_default();
    let yesterday = iso(today - Duration::days(1));
    let last = if end < yesterday.as_str() {
        end.to_owned()
    } else {
        yesterday
    };
    let first = if start > EARLIEST_DATE {
        start.to_owned()
    } else {
        EARLIEST_DATE.to_owned()
    };
    if first > last {
        return Vec::new();
    }
    let have: BTreeSet<&str> = existing.iter().map(String::as_str).collect();
    date_span(&first, &last)
        .into_iter()
        .filter(|d| !have.contains(d.as_str()))
        .collect()
}

/// Sorted dates to `(start, end)` spans. Spans closer than `max_gap_days` are
/// merged, so a few stored days in the middle do not split one fetch.
pub fn group_runs(dates: &[String], max_gap_days: i64) -> Vec<(String, String)> {
    let sorted: BTreeSet<&String> = dates.iter().collect();
    let mut runs: Vec<(String, String)> = Vec::new();
    for d in sorted {
        let Some(date) = parse_date(d) else { continue };
        if let Some(last) = runs.last_mut() {
            let prev = parse_date(&last.1).unwrap_or_default();
            if (date - prev).num_days() <= max_gap_days {
                last.1 = d.clone();
                continue;
            }
        }
        runs.push((d.clone(), d.clone()));
    }
    runs
}

/// Split `start..end` into chunks of at most `max_days`, NEWEST first, so a
/// request that runs out of budget has filled the most recent days.
pub fn split_span(start: &str, end: &str, max_days: i64) -> Vec<(String, String)> {
    let (Some(s), Some(e)) = (parse_date(start), parse_date(end)) else {
        return Vec::new();
    };
    let max_days = max_days.max(1);
    let mut chunks = Vec::new();
    let mut hi = e;
    while hi >= s {
        let lo = std::cmp::max(s, hi - Duration::days(max_days - 1));
        chunks.push((iso(lo), iso(hi)));
        hi = lo - Duration::days(1);
    }
    chunks
}

/// The coordinate-grid key a bare coordinate's history is stored under
/// (`weather_cache_key`: 0.05 degree cells, integer arithmetic).
pub fn cell_key(lat: f64, lon: f64) -> String {
    const CELLS_PER_DEG: f64 = 20.0;
    const LAT_MAX: i64 = 90 * 20;
    const LON_MAX: i64 = 180 * 20;
    let idx = |v: f64| (v * CELLS_PER_DEG + 0.5).floor() as i64;
    let fmt = |i: i64| {
        let h = i * 5;
        let sign = if h < 0 { "-" } else { "" };
        let a = h.abs();
        format!("{sign}{}.{:02}", a / 100, a % 100)
    };
    let lat_i = idx(lat).clamp(-LAT_MAX, LAT_MAX);
    let mut lon_i = idx(lon);
    if lon_i >= LON_MAX {
        lon_i -= 2 * LON_MAX;
    } else if lon_i < -LON_MAX {
        lon_i += 2 * LON_MAX;
    }
    format!("cell:{}_{}", fmt(lat_i), fmt(lon_i))
}

// --- gap-fills ----------------------------------------------------------------

/// A coarse WMO code for a day from its rain total and mean cloud cover.
/// NASA POWER publishes no present-weather code: rain first, then cloud. A
/// dry day with unknown cloud has no code (never a guessed "clear").
pub fn derive_weather_code(precip_mm: Option<f64>, cloud_pct: Option<f64>) -> Option<i64> {
    if let Some(p) = precip_mm {
        if p >= 10.0 {
            return Some(63);
        }
        if p >= 2.5 {
            return Some(61);
        }
        if p >= 1.0 {
            return Some(51);
        }
    }
    let c = cloud_pct?;
    Some(if c >= 85.0 {
        3
    } else if c >= 50.0 {
        2
    } else if c >= 20.0 {
        1
    } else {
        0
    })
}

/// Steadman apparent temperature (the formula Open-Meteo uses):
/// `AT = T + 0.33e - 0.70v - 4.00`, `e` the vapour pressure (hPa), `v` the
/// wind speed (m/s). `None` when an input is missing.
pub fn apparent_temperature(
    temp_c: Option<f64>,
    rh_pct: Option<f64>,
    wind_kmh: Option<f64>,
) -> Option<f64> {
    let (t, rh, w) = (temp_c?, rh_pct?, wind_kmh?);
    let e = (rh / 100.0) * 6.105 * (17.27 * t / (237.7 + t)).exp();
    Some(round_py(t + 0.33 * e - 0.70 * (w / 3.6) - 4.00, 1))
}

/// Sunrise and sunset for `day` as local wall-clock `YYYY-MM-DDTHH:MM`
/// strings (the format Open-Meteo returns), from the NOAA solar equations.
/// `(None, None)` in polar day or night.
pub fn sun_times(
    lat: f64,
    lon: f64,
    day: &str,
    utc_offset_seconds: i64,
) -> (Option<String>, Option<String>) {
    use std::f64::consts::PI;
    let Some(d) = parse_date(day) else {
        return (None, None);
    };
    let n = d.ordinal() as f64;
    let g = 2.0 * PI / 365.0 * (n - 1.0);
    let eqtime = 229.18
        * (0.000075 + 0.001868 * g.cos()
            - 0.032077 * g.sin()
            - 0.014615 * (2.0 * g).cos()
            - 0.040849 * (2.0 * g).sin());
    let decl = 0.006918 - 0.399912 * g.cos() + 0.070257 * g.sin() - 0.006758 * (2.0 * g).cos()
        + 0.000907 * (2.0 * g).sin()
        - 0.002697 * (3.0 * g).cos()
        + 0.00148 * (3.0 * g).sin();
    let phi = lat.to_radians();
    let arg = 90.833_f64.to_radians().cos() / (phi.cos() * decl.cos()) - phi.tan() * decl.tan();
    if !(-1.0..=1.0).contains(&arg) {
        return (None, None);
    }
    let ha = arg.acos().to_degrees();
    let at = |minutes_utc: f64| -> String {
        // timedelta(minutes=x) is exact to the microsecond, then the offset;
        // strftime drops the seconds.
        let micros =
            (minutes_utc * 60_000_000.0).round_ties_even() as i64 + utc_offset_seconds * 1_000_000;
        let minutes = micros.div_euclid(60_000_000);
        let t = d.and_hms_opt(0, 0, 0).unwrap_or_default() + Duration::minutes(minutes);
        t.format("%Y-%m-%dT%H:%M").to_string()
    };
    (
        Some(at(720.0 - 4.0 * (lon + ha) - eqtime)),
        Some(at(720.0 - 4.0 * (lon - ha) - eqtime)),
    )
}

// --- providers ---------------------------------------------------------------

pub const NASA_POWER_URL: &str = "https://power.larc.nasa.gov/api/temporal/daily/point";
pub const NASA_POWER_FILL: f64 = -999.0;
pub const ARCHIVE_URL: &str = "https://archive-api.open-meteo.com/v1/archive";
/// The commercial (paid plan) host, used with an `apikey`.
pub const ARCHIVE_URL_COMMERCIAL: &str = "https://customer-archive-api.open-meteo.com/v1/archive";

/// POWER parameter, canonical field, multiplier. Wind is m/s and pressure kPa
/// upstream; we store km/h and hPa.
const NASA_PARAMS: [(&str, &str, f64); 11] = [
    ("T2M_MAX", "temperature_2m_max", 1.0),
    ("T2M_MIN", "temperature_2m_min", 1.0),
    ("T2M", "temperature_2m_mean", 1.0),
    ("PRECTOTCORR", "precipitation_sum", 1.0),
    ("RH2M", "relative_humidity_2m_mean", 1.0),
    ("WS10M", "wind_speed_10m_mean", 3.6),
    ("WS10M_MAX", "wind_speed_10m_max", 3.6),
    ("WD10M", "wind_direction_10m_dominant", 1.0),
    ("PS", "surface_pressure_mean", 10.0),
    ("T2MDEW", "dew_point_2m_mean", 1.0),
    ("CLOUD_AMT", "cloud_cover_mean", 1.0),
];

/// Who supplied an archive day and how they must be credited.
#[derive(Debug, Clone, Copy)]
pub struct ProviderSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub attribution: &'static str,
    pub url: &'static str,
    pub licence: &'static str,
    pub licence_url: &'static str,
    /// Widest span one upstream request may cover.
    pub max_span_days: i64,
    /// Earliest date the provider has data for.
    pub earliest: &'static str,
    /// Upstream calls allowed per hour for the whole service.
    pub budget_per_hour: u32,
    /// Seconds an upstream call may take.
    pub timeout_s: u64,
}

pub const NASA_POWER: ProviderSpec = ProviderSpec {
    id: SOURCE_NASA_POWER,
    name: "NASA POWER",
    attribution: "Data obtained from the NASA Langley Research Center (LaRC) POWER Project, funded through the NASA Earth Science/Applied Science Program",
    url: "https://power.larc.nasa.gov",
    licence: "NASA open data (no restrictions on use)",
    licence_url: "https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-information-policy",
    max_span_days: 3660,
    earliest: "1981-01-01",
    budget_per_hour: 600,
    timeout_s: 12,
};

pub const OPEN_METEO_ARCHIVE: ProviderSpec = ProviderSpec {
    id: SOURCE_OPEN_METEO_ARCHIVE,
    name: "Open-Meteo (ERA5)",
    attribution:
        "Weather data by Open-Meteo.com, from ERA5 (Copernicus Climate Change Service / ECMWF)",
    url: "https://open-meteo.com",
    licence: "CC BY 4.0",
    licence_url: "https://creativecommons.org/licenses/by/4.0/",
    max_span_days: 366,
    earliest: EARLIEST_DATE,
    // The free tier is 5,000 an hour shared with the forecast, air quality and
    // haze; history keeps a small share.
    budget_per_hour: 200,
    timeout_s: 8,
};

/// The default chain: NASA POWER (commercial use is open) then Open-Meteo.
pub const DEFAULT_CHAIN: [&str; 2] = [SOURCE_NASA_POWER, SOURCE_OPEN_METEO_ARCHIVE];

pub fn provider(id: &str) -> Option<&'static ProviderSpec> {
    match id {
        SOURCE_NASA_POWER => Some(&NASA_POWER),
        SOURCE_OPEN_METEO_ARCHIVE => Some(&OPEN_METEO_ARCHIVE),
        _ => None,
    }
}

/// Providers in configured order. `config` is the `HISTORY_PROVIDERS` comma
/// list; unknown ids are ignored and an empty or unusable value falls back to
/// the default chain. With `commercial_only` (`HISTORY_COMMERCIAL_ONLY`) the
/// free Open-Meteo host is dropped unless `open_meteo_commercial` (a paid key
/// is configured): its free tier is non-commercial.
pub fn provider_chain(
    config: Option<&str>,
    commercial_only: bool,
    open_meteo_commercial: bool,
) -> Vec<&'static ProviderSpec> {
    let mut chain: Vec<&'static ProviderSpec> = Vec::new();
    for id in config.unwrap_or("").split(',') {
        if let Some(p) = provider(id.trim()) {
            if !chain.iter().any(|c| c.id == p.id) {
                chain.push(p);
            }
        }
    }
    if chain.is_empty() {
        chain = DEFAULT_CHAIN.iter().filter_map(|id| provider(id)).collect();
    }
    if commercial_only {
        chain.retain(|p| p.id != SOURCE_OPEN_METEO_ARCHIVE || open_meteo_commercial);
    }
    chain
}

/// The attribution entry for a stored `source`, `None` for recorded/unknown.
pub fn provider_info(source: &str) -> Option<Value> {
    let p = provider(source)?;
    Some(json!({
        "id": p.id,
        "name": p.name,
        "attribution": p.attribution,
        "url": p.url,
        "licence": p.licence,
        "licenceUrl": p.licence_url,
    }))
}

/// One attribution entry per archive source present in `docs`, in first-seen
/// order.
pub fn attributions_for(docs: &[Value]) -> Vec<Value> {
    let mut seen: Vec<&str> = Vec::new();
    for d in docs {
        if let Some(s) = d["source"].as_str() {
            if s != SOURCE_RECORDED && !seen.contains(&s) {
                seen.push(s);
            }
        }
    }
    seen.into_iter().filter_map(provider_info).collect()
}

/// The NASA POWER request. Parameters are fixed; coordinates are sent to four
/// decimals (about 11 m, finer than the 0.5 degree source cell).
pub fn nasa_power_url(lat: f64, lon: f64, start: &str, end: &str) -> String {
    let params: Vec<&str> = NASA_PARAMS.iter().map(|p| p.0).collect();
    format!(
        "{NASA_POWER_URL}?parameters={}&community=AG&latitude={lat:.4}&longitude={lon:.4}&start={}&end={}&format=JSON",
        params.join(","),
        start.replace('-', ""),
        end.replace('-', ""),
    )
}

/// The Open-Meteo archive request. With a key the commercial host is used;
/// the key is a query parameter (the only way Open-Meteo accepts it), so the
/// URL must never be logged.
pub fn open_meteo_archive_url(
    lat: f64,
    lon: f64,
    start: &str,
    end: &str,
    api_key: Option<&str>,
) -> String {
    let base = if api_key.is_some() {
        ARCHIVE_URL_COMMERCIAL
    } else {
        ARCHIVE_URL
    };
    let mut url = format!(
        "{base}?latitude={lat}&longitude={lon}&start_date={start}&end_date={end}&timezone=auto&daily={}",
        CANONICAL_DAILY_FIELDS.join(",")
    );
    if let Some(k) = api_key {
        url.push_str("&apikey=");
        url.push_str(k);
    }
    url
}

/// Whether an upstream HTTP status counts against the provider's breaker:
/// only 5xx and 429 (a 4xx is OUR request).
pub fn status_is_transient(status: u16) -> bool {
    status >= 500 || status == 429
}

fn number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn put(day: &mut Day, key: &str, v: f64) {
    day.insert(key.to_owned(), json!(v));
}

/// Turn a NASA POWER daily point payload into canonical days, oldest first.
/// With `lat`/`lon` each day also gets computed sunrise and sunset.
pub fn parse_nasa_power(payload: &Value, coords: Option<(f64, f64)>) -> Vec<Day> {
    let Some(params) = payload["properties"]["parameter"].as_object() else {
        return Vec::new();
    };
    let fill = payload["header"]["fill_value"]
        .as_f64()
        .unwrap_or(NASA_POWER_FILL);
    let dates: BTreeSet<&String> = params
        .values()
        .filter_map(Value::as_object)
        .flat_map(|series| series.keys())
        .collect();

    let mut out = Vec::new();
    for raw in dates {
        if raw.len() != 8 || !raw.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let date = format!("{}-{}-{}", &raw[..4], &raw[4..6], &raw[6..]);
        let mut day = Day::new();
        day.insert("date".into(), json!(date));
        for (param, field, factor) in NASA_PARAMS {
            let Some(n) = params
                .get(param)
                .and_then(|s| s.get(raw.as_str()))
                .and_then(number)
            else {
                continue;
            };
            if n == fill || n == NASA_POWER_FILL {
                continue;
            }
            // POWER's daily wind direction was out of range at times; drop it.
            if param == "WD10M" && !(0.0..=360.0).contains(&n) {
                continue;
            }
            put(&mut day, field, round_py(n * factor, 2));
        }
        let get = |d: &Day, k: &str| d.get(k).and_then(Value::as_f64);
        if get(&day, "temperature_2m_max").is_none() || get(&day, "temperature_2m_min").is_none() {
            continue; // not published yet (a few days' lag) or a fill value
        }
        if let Some(code) = derive_weather_code(
            get(&day, "precipitation_sum"),
            get(&day, "cloud_cover_mean"),
        ) {
            day.insert("weather_code".into(), json!(code));
        }
        let (rh, wind) = (
            get(&day, "relative_humidity_2m_mean"),
            get(&day, "wind_speed_10m_mean"),
        );
        for (src, dst) in [
            ("temperature_2m_max", "apparent_temperature_max"),
            ("temperature_2m_min", "apparent_temperature_min"),
            ("temperature_2m_mean", "apparent_temperature_mean"),
        ] {
            if let Some(at) = apparent_temperature(get(&day, src), rh, wind) {
                put(&mut day, dst, at);
            }
        }
        if let Some((lat, lon)) = coords {
            if let (Some(rise), Some(set)) =
                sun_times(lat, lon, &date, estimate_utc_offset_seconds(lon))
            {
                day.insert("sunrise".into(), json!(rise));
                day.insert("sunset".into(), json!(set));
            }
        }
        out.push(day);
    }
    out
}

/// Turn an Open-Meteo archive payload into canonical days, oldest first.
pub fn parse_open_meteo_daily(payload: &Value) -> Vec<Day> {
    let daily = &payload["daily"];
    let Some(times) = daily["time"].as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (i, t) in times.iter().enumerate() {
        let Some(date) = t.as_str() else { continue };
        let mut day = Day::new();
        day.insert("date".into(), json!(date));
        for field in CANONICAL_DAILY_FIELDS {
            let v = &daily[field][i];
            if !v.is_null() {
                day.insert(field.into(), v.clone());
            }
        }
        // Archive lag: the newest days come back as nulls. Skip and retry later.
        if day.get("temperature_2m_max").is_none() || day.get("temperature_2m_min").is_none() {
            continue;
        }
        out.push(day);
    }
    out
}

/// The cell metadata an Open-Meteo archive answer carries.
pub fn open_meteo_meta(payload: &Value) -> Value {
    json!({
        "timezone": payload["timezone"],
        "utc_offset_seconds": payload["utc_offset_seconds"],
        "elevation": payload["elevation"],
    })
}

/// Parse a provider's raw payload into canonical days.
pub fn parse_provider(id: &str, payload: &Value, lat: f64, lon: f64) -> Vec<Day> {
    match id {
        SOURCE_NASA_POWER => parse_nasa_power(payload, Some((lat, lon))),
        SOURCE_OPEN_METEO_ARCHIVE => parse_open_meteo_daily(payload),
        _ => Vec::new(),
    }
}

// --- stored days -------------------------------------------------------------

/// A `weather.weather_history` document for one canonical archive day, the
/// shape `HistoryDashboard` and the AI analysis read: `current` holds DAILY
/// MEANS for an archive day (there is no "current" for a past day),
/// `aggregation` says so, and there is no UV.
pub fn build_history_doc(slug: &str, day: &Day, source: &str, now_rfc3339: &str) -> Value {
    let date = day.get("date").and_then(Value::as_str).unwrap_or_default();
    let v = |k: &str| day.get(k).cloned().unwrap_or(Value::Null);
    let one = |k: &str| json!([v(k)]);
    let daily = json!({
        "time": [date],
        "weather_code": one("weather_code"),
        "temperature_2m_max": one("temperature_2m_max"),
        "temperature_2m_min": one("temperature_2m_min"),
        "apparent_temperature_max": one("apparent_temperature_max"),
        "apparent_temperature_min": one("apparent_temperature_min"),
        "precipitation_sum": one("precipitation_sum"),
        "sunrise": one("sunrise"),
        "sunset": one("sunset"),
        "wind_speed_10m_max": one("wind_speed_10m_max"),
        "wind_gusts_10m_max": one("wind_gusts_10m_max"),
        "wind_direction_10m_dominant": one("wind_direction_10m_dominant"),
    });
    let current = json!({
        "temperature_2m": v("temperature_2m_mean"),
        "apparent_temperature": v("apparent_temperature_mean"),
        "relative_humidity_2m": v("relative_humidity_2m_mean"),
        "cloud_cover": v("cloud_cover_mean"),
        "surface_pressure": v("surface_pressure_mean"),
        "wind_speed_10m": v("wind_speed_10m_mean"),
        "wind_direction_10m": v("wind_direction_10m_dominant"),
        "wind_gusts_10m": v("wind_gusts_10m_max"),
        "precipitation": v("precipitation_sum"),
        "weather_code": v("weather_code"),
        "uv_index": null,
        "is_day": 1,
    });
    let mut insights = Map::new();
    for (k, f) in [
        ("dewPoint", "dew_point_2m_mean"),
        ("evapotranspiration", "et0_fao_evapotranspiration"),
    ] {
        if let Some(x) = day.get(f).filter(|x| !x.is_null()) {
            insights.insert(k.into(), x.clone());
        }
    }
    let mut doc = json!({
        "locationSlug": slug,
        "date": date,
        "source": source,
        "provider": source,
        "aggregation": "daily-mean",
        "current": current,
        "daily": daily,
        "recordedAt": now_rfc3339,
        "createdAt": now_rfc3339,
    });
    if !insights.is_empty() {
        doc["insights"] = Value::Object(insights);
    }
    doc
}

/// The body the bridge accepts for one archive day: only what a stored day
/// carries (`POST /history/days`), never the whole document.
pub fn to_archive_day(doc: &Value) -> Value {
    let mut out = json!({
        "date": doc["date"],
        "source": doc["source"],
        "current": doc["current"],
        "daily": doc["daily"],
    });
    if let Some(i) = doc.get("insights").filter(|i| !i.is_null()) {
        out["insights"] = i.clone();
    }
    out
}

/// The camelCase `daily` record of a D1 `place_daily` row, mapped to the
/// canonical Open-Meteo field names.
const D1_DAILY: [(&str, &str); 13] = [
    ("weatherCode", "weather_code"),
    ("tempMax", "temperature_2m_max"),
    ("tempMin", "temperature_2m_min"),
    ("apparentTempMax", "apparent_temperature_max"),
    ("apparentTempMin", "apparent_temperature_min"),
    ("precipSum", "precipitation_sum"),
    ("precipProbMax", "precipitation_probability_max"),
    ("windSpeedMax", "wind_speed_10m_max"),
    ("windGustMax", "wind_gusts_10m_max"),
    ("windDirDominant", "wind_direction_10m_dominant"),
    ("uvIndexMax", "uv_index_max"),
    ("sunrise", "sunrise"),
    ("sunset", "sunset"),
];

/// A recorded day from a D1 `place_daily` row, in the same shape as every
/// other day: `daily` as one-element Open-Meteo arrays (the row stores one flat
/// camelCase record), the day's `date`, `source: "recorded"`, and the data
/// provider kept as `provider`.
pub fn recorded_from_d1(
    slug: &str,
    date: &str,
    recorded_at_ms: i64,
    provider: &str,
    current: Option<&str>,
    daily: Option<&str>,
    insights: Option<&str>,
) -> Value {
    let parse = |s: Option<&str>| s.and_then(|s| serde_json::from_str::<Value>(s).ok());
    let at = chrono::DateTime::from_timestamp_millis(recorded_at_ms)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let daily = match parse(daily) {
        // An Open-Meteo-shaped record already.
        Some(d) if d.get("time").is_some() => d,
        Some(d) => {
            let mut out = Map::new();
            out.insert("time".into(), json!([date]));
            for (camel, canon) in D1_DAILY {
                if let Some(x) = d.get(camel).filter(|x| !x.is_null()) {
                    out.insert(canon.into(), json!([x]));
                }
            }
            Value::Object(out)
        }
        None => json!({"time": [date]}),
    };
    let mut rec = json!({
        "locationSlug": slug,
        "date": date,
        "source": SOURCE_RECORDED,
        "provider": provider,
        "recordedAt": at,
        "current": parse(current).unwrap_or_else(|| json!({})),
        "daily": daily,
    });
    if let Some(i) = parse(insights).filter(|v| !v.is_null()) {
        rec["insights"] = i;
    }
    rec
}

fn source_rank(doc: &Value) -> u8 {
    match doc["source"].as_str() {
        None | Some(SOURCE_RECORDED) => 0,
        Some(_) => 1,
    }
}

/// One doc per date (recorded beats archive, an earlier slug beats a later
/// one), newest first, every doc presented under the canonical slug
/// (`slug_order[0]`). Docs without a `date` are dropped.
pub fn merge_by_date(docs: Vec<Value>, slug_order: &[String]) -> Vec<Value> {
    use std::collections::BTreeMap;
    let rank_of = |d: &Value| {
        let slug_rank = slug_order
            .iter()
            .position(|s| Some(s.as_str()) == d["locationSlug"].as_str())
            .unwrap_or(slug_order.len());
        (source_rank(d), slug_rank)
    };
    let mut best: BTreeMap<String, ((u8, usize), Value)> = BTreeMap::new();
    for doc in docs {
        let Some(date) = doc["date"].as_str().map(str::to_owned) else {
            continue;
        };
        let rank = rank_of(&doc);
        match best.get(&date) {
            Some((cur, _)) if *cur <= rank => {}
            _ => {
                best.insert(date, (rank, doc));
            }
        }
    }
    let mut out: Vec<Value> = best.into_values().map(|(_, d)| d).collect();
    if let Some(canonical) = slug_order.first() {
        for d in &mut out {
            d["locationSlug"] = json!(canonical);
        }
    }
    out.reverse(); // BTreeMap order is ascending by date
    out
}

/// The dates of docs, as owned strings.
pub fn dates_of(docs: &[Value]) -> Vec<String> {
    docs.iter()
        .filter_map(|d| d["date"].as_str().map(str::to_owned))
        .collect()
}

/// Chunks to fetch from `provider` for the `remaining` missing dates, newest
/// first: the provider's coverage clipped to its earliest date and split to
/// its widest span, keeping only chunks that hold a missing date.
pub fn chunks_for(provider: &ProviderSpec, remaining: &BTreeSet<String>) -> Vec<(String, String)> {
    let (Some(min), Some(max)) = (remaining.first(), remaining.last()) else {
        return Vec::new();
    };
    let lo = if min.as_str() > provider.earliest {
        min.as_str()
    } else {
        provider.earliest
    };
    if lo > max.as_str() {
        return Vec::new();
    }
    split_span(lo, max, provider.max_span_days)
        .into_iter()
        .filter(|(s, e)| remaining.iter().any(|d| d >= s && d <= e))
        .collect()
}

/// The response envelope.
#[allow(clippy::too_many_arguments)]
pub fn response(
    location: &str,
    start: &str,
    end: &str,
    data: Vec<Value>,
    backfilled: usize,
    clamped: bool,
    saved: Option<bool>,
) -> Value {
    let sources = attributions_for(&data);
    let mut body = json!({
        "location": location,
        "start": start,
        "end": end,
        "days": span_days(start, end),
        "records": data.len(),
        "backfilled": backfilled,
        "clamped": clamped,
        "sources": sources,
        "data": data,
    });
    if let Some(saved) = saved {
        body["saved"] = json!(saved);
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../../../tests/fixtures/history-days.json");

    fn fx() -> Value {
        serde_json::from_str(FIXTURE).unwrap()
    }

    /// Numbers compare by value (Python wrote `0.0` and `3` where serde reads
    /// a float or an integer); everything else is exact.
    fn same(a: &Value, b: &Value) -> bool {
        match (a, b) {
            (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
            (Value::Array(x), Value::Array(y)) => {
                x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same(a, b))
            }
            (Value::Object(x), Value::Object(y)) => {
                x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
            }
            _ => a == b,
        }
    }

    fn days_value(days: Vec<Day>) -> Value {
        Value::Array(days.into_iter().map(Value::Object).collect())
    }

    fn strings(v: &Value) -> Vec<String> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_owned())
            .collect()
    }

    fn opt(v: &Value) -> Option<f64> {
        v.as_f64()
    }

    #[test]
    fn nasa_power_parses_like_the_python_oracle() {
        let f = fx();
        for case in f["nasa"].as_array().unwrap() {
            let coords = match (opt(&case["lat"]), opt(&case["lon"])) {
                (Some(a), Some(b)) => Some((a, b)),
                _ => None,
            };
            let got = days_value(parse_nasa_power(&case["payload"], coords));
            assert!(
                same(&got, &case["expected"]),
                "case {}: {got:#?}\n!=\n{:#?}",
                case["name"],
                case["expected"]
            );
        }
    }

    #[test]
    fn nasa_power_drops_unpublished_days_and_a_broken_wind_direction() {
        let f = fx();
        let case = f["nasa"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == "synthetic-arctic")
            .unwrap();
        let days = parse_nasa_power(&case["payload"], Some((69.6, 18.9)));
        // 2026-01-03 is all fill values: not a day.
        assert!(!days.iter().any(|d| d["date"] == "2026-01-03"));
        // -85.3 and 361 are out of range; 360 is kept.
        assert!(days[0].get("wind_direction_10m_dominant").is_none());
        assert_eq!(days[2]["wind_direction_10m_dominant"], json!(360.0));
        assert!(days[3].get("wind_direction_10m_dominant").is_none());
        // Polar night in Tromso on 2026-01-01: no sunrise, never a made-up one.
        assert!(days[0].get("sunrise").is_none());
    }

    #[test]
    fn open_meteo_parses_like_the_python_oracle() {
        let f = fx();
        for case in f["openMeteo"].as_array().unwrap() {
            let got = days_value(parse_open_meteo_daily(&case["payload"]));
            assert!(same(&got, &case["expected"]), "case {}", case["name"]);
        }
        let case = &f["openMeteo"][0];
        let meta = open_meteo_meta(&case["payload"]);
        assert_eq!(meta["utc_offset_seconds"], json!(7200));
        assert_eq!(meta["timezone"], json!("Africa/Harare"));
    }

    #[test]
    fn open_meteo_skips_null_days_from_archive_lag() {
        let payload = json!({"daily": {
            "time": ["2026-10-29", "2026-10-30"],
            "temperature_2m_max": [30.0, null],
            "temperature_2m_min": [15.0, null],
        }});
        let days = parse_open_meteo_daily(&payload);
        assert_eq!(days.len(), 1);
        assert_eq!(days[0]["date"], json!("2026-10-29"));
    }

    #[test]
    fn derived_code_and_apparent_temperature_match_the_oracle() {
        let f = fx();
        for c in f["deriveWeatherCode"].as_array().unwrap() {
            let got = derive_weather_code(opt(&c["precip"]), opt(&c["cloud"]));
            assert_eq!(got, c["code"].as_i64(), "{c}");
        }
        for c in f["apparentTemperature"].as_array().unwrap() {
            let got = apparent_temperature(opt(&c["t"]), opt(&c["rh"]), opt(&c["wind"]));
            assert_eq!(got, opt(&c["at"]), "{c}");
        }
    }

    #[test]
    fn sun_times_match_the_oracle() {
        let f = fx();
        for c in f["sunTimes"].as_array().unwrap() {
            let (rise, set) = sun_times(
                c["lat"].as_f64().unwrap(),
                c["lon"].as_f64().unwrap(),
                c["day"].as_str().unwrap(),
                c["offset"].as_i64().unwrap(),
            );
            assert_eq!(rise.as_deref(), c["sunrise"].as_str(), "{c}");
            assert_eq!(set.as_deref(), c["sunset"].as_str(), "{c}");
        }
    }

    #[test]
    fn stored_day_matches_the_oracle_shape() {
        let f = fx();
        for c in f["docs"].as_array().unwrap() {
            let day = c["day"].as_object().unwrap().clone();
            let mut got = build_history_doc(
                "geo:gcpvj0e",
                &day,
                c["source"].as_str().unwrap(),
                "2026-10-31T12:00:00Z",
            );
            let mut want = c["doc"].clone();
            for k in ["recordedAt", "createdAt"] {
                got.as_object_mut().unwrap().remove(k);
                want.as_object_mut().unwrap().remove(k);
            }
            assert!(same(&got, &want), "{got:#?}\n!=\n{want:#?}");
        }
    }

    #[test]
    fn ranges_match_the_oracle() {
        let f = fx();
        for c in f["groupRuns"].as_array().unwrap() {
            let runs = group_runs(&strings(&c["dates"]), RUN_MERGE_GAP_DAYS);
            let want: Vec<(String, String)> = c["runs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| {
                    (
                        r[0].as_str().unwrap().to_owned(),
                        r[1].as_str().unwrap().to_owned(),
                    )
                })
                .collect();
            assert_eq!(runs, want, "{c}");
        }
        for c in f["splitSpan"].as_array().unwrap() {
            let got = split_span(
                c["start"].as_str().unwrap(),
                c["end"].as_str().unwrap(),
                c["max"].as_i64().unwrap(),
            );
            let want: Vec<(String, String)> = c["chunks"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| {
                    (
                        r[0].as_str().unwrap().to_owned(),
                        r[1].as_str().unwrap().to_owned(),
                    )
                })
                .collect();
            assert_eq!(got, want, "{c}");
        }
        for c in f["missingDates"].as_array().unwrap() {
            let now = chrono::DateTime::parse_from_rfc3339(c["now"].as_str().unwrap())
                .unwrap()
                .timestamp_millis() as u64;
            let got = missing_dates(
                &strings(&c["existing"]),
                c["start"].as_str().unwrap(),
                c["end"].as_str().unwrap(),
                c["lon"].as_f64().unwrap(),
                now,
            );
            assert_eq!(got, strings(&c["missing"]), "{c}");
        }
        for c in f["windowForDays"].as_array().unwrap() {
            let now = chrono::DateTime::parse_from_rfc3339("2026-10-31T12:00:00Z")
                .unwrap()
                .timestamp_millis() as u64;
            let lon = c["lon"].as_f64().unwrap();
            let (s, e) = window_for_days(c["days"].as_i64().unwrap(), &local_today(lon, now));
            assert_eq!(
                [s.as_str(), e.as_str()],
                [
                    c["range"][0].as_str().unwrap(),
                    c["range"][1].as_str().unwrap()
                ],
                "{c}"
            );
        }
    }

    #[test]
    fn resolve_range_validates_like_the_python_route() {
        let today = "2026-10-31";
        assert_eq!(
            resolve_range(None, None, None, today).unwrap(),
            ("2026-10-02".into(), today.into())
        );
        assert_eq!(
            resolve_range(Some(7), None, None, today).unwrap().0,
            "2026-10-25"
        );
        assert!(resolve_range(Some(0), None, None, today).is_err());
        assert!(resolve_range(Some(3661), None, None, today).is_err());
        assert!(resolve_range(Some(3660), None, None, today).is_ok());
        // start/end win over days; end is clamped to today.
        assert_eq!(
            resolve_range(Some(7), Some("2026-10-01"), Some("2027-01-01"), today).unwrap(),
            ("2026-10-01".into(), today.into())
        );
        assert_eq!(
            resolve_range(None, Some("2026-10-01"), None, today)
                .unwrap()
                .1,
            today
        );
        let err = |s: Option<&str>, e: Option<&str>| resolve_range(None, s, e, today).unwrap_err();
        assert_eq!(
            err(None, Some("2026-10-01")),
            "start is required when end is given"
        );
        assert_eq!(err(Some("nope"), None), "start must be YYYY-MM-DD");
        assert_eq!(err(Some("2026-02-30"), None), "start must be YYYY-MM-DD");
        assert_eq!(err(Some("2026-10-01"), Some("x")), "end must be YYYY-MM-DD");
        assert!(err(Some("1939-12-31"), None).starts_with("start must be on or after"));
        assert!(err(Some("2026-11-05"), None).starts_with("start must be on or before end"));
        assert!(err(Some("2010-01-01"), Some("2026-10-01")).starts_with("range must be at most"));
        // Exactly ten years of days is allowed.
        assert!(resolve_range(None, Some("2016-11-01"), Some(today), today).is_ok());
    }

    #[test]
    fn cell_key_matches_the_shared_vectors() {
        let v: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/weather-cache-keys.json"
        ))
        .unwrap();
        for c in v["vectors"].as_array().unwrap() {
            assert_eq!(
                cell_key(c["lat"].as_f64().unwrap(), c["lon"].as_f64().unwrap()),
                c["key"].as_str().unwrap(),
                "{c}"
            );
        }
    }

    #[test]
    fn chain_follows_config_and_the_commercial_switch() {
        let ids = |c: Vec<&ProviderSpec>| c.iter().map(|p| p.id).collect::<Vec<_>>();
        assert_eq!(
            ids(provider_chain(None, false, false)),
            ["nasa-power", "open-meteo-archive"]
        );
        assert_eq!(
            ids(provider_chain(
                Some("open-meteo-archive, nasa-power, junk, nasa-power"),
                false,
                false
            )),
            ["open-meteo-archive", "nasa-power"]
        );
        assert_eq!(
            ids(provider_chain(Some("junk"), false, false)),
            ["nasa-power", "open-meteo-archive"]
        );
        // The free Open-Meteo host is non-commercial.
        assert_eq!(ids(provider_chain(None, true, false)), ["nasa-power"]);
        assert_eq!(
            ids(provider_chain(None, true, true)),
            ["nasa-power", "open-meteo-archive"]
        );
    }

    #[test]
    fn urls_and_failure_classes() {
        let u = nasa_power_url(-17.83, 31.05, "2026-10-01", "2026-10-30");
        assert!(u.contains("latitude=-17.8300&longitude=31.0500"));
        assert!(u.contains("start=20261001&end=20261030"));
        assert!(u.contains("community=AG") && u.contains("T2M_MAX"));
        let free = open_meteo_archive_url(1.5, 2.5, "2026-01-01", "2026-01-31", None);
        assert!(free.starts_with(ARCHIVE_URL) && !free.contains("apikey"));
        let paid = open_meteo_archive_url(1.5, 2.5, "2026-01-01", "2026-01-31", Some("K"));
        assert!(paid.starts_with(ARCHIVE_URL_COMMERCIAL) && paid.ends_with("&apikey=K"));
        // Only 5xx and 429 say the provider is unwell; a 4xx is our request.
        assert!(status_is_transient(500) && status_is_transient(503) && status_is_transient(429));
        assert!(
            !status_is_transient(400) && !status_is_transient(404) && !status_is_transient(422)
        );
    }

    fn doc(date: &str, source: &str, slug: &str) -> Value {
        json!({"date": date, "source": source, "locationSlug": slug})
    }

    #[test]
    fn merge_prefers_recorded_then_the_canonical_slug() {
        let order = vec!["harare".to_owned(), "harare-35c223".to_owned()];
        let merged = merge_by_date(
            vec![
                doc("2026-10-28", SOURCE_NASA_POWER, "harare"),
                doc("2026-10-28", SOURCE_RECORDED, "harare-35c223"),
                doc("2026-10-29", SOURCE_NASA_POWER, "harare-35c223"),
                doc("2026-10-29", SOURCE_OPEN_METEO_ARCHIVE, "harare"),
                json!({"source": "recorded"}),
            ],
            &order,
        );
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0]["date"], "2026-10-29"); // newest first
        assert_eq!(merged[0]["source"], SOURCE_OPEN_METEO_ARCHIVE); // canonical slug wins a tie
        assert_eq!(merged[1]["source"], SOURCE_RECORDED); // recorded beats archive
        assert!(merged.iter().all(|d| d["locationSlug"] == "harare"));
    }

    #[test]
    fn attribution_lists_each_archive_source_once() {
        let docs = vec![
            doc("2026-10-28", SOURCE_RECORDED, "x"),
            doc("2026-10-27", SOURCE_NASA_POWER, "x"),
            doc("2026-10-26", SOURCE_NASA_POWER, "x"),
            doc("2026-10-25", SOURCE_OPEN_METEO_ARCHIVE, "x"),
        ];
        let a = attributions_for(&docs);
        assert_eq!(a.len(), 2);
        assert_eq!(a[0]["id"], "nasa-power");
        assert!(a[0]["attribution"].as_str().unwrap().contains("NASA"));
        assert_eq!(a[1]["id"], "open-meteo-archive");
        assert!(attributions_for(&docs[..1]).is_empty());
        assert!(provider_info("recorded").is_none());
    }

    #[test]
    fn d1_rows_become_canonical_days() {
        let r = recorded_from_d1(
            "harare",
            "2026-10-30",
            1_793_395_846_356,
            "open-meteo",
            Some(r#"{"temperature_2m":24.1}"#),
            Some(
                r#"{"date":"2026-10-30","weatherCode":3,"tempMax":31.2,"tempMin":17.0,"uvIndexMax":11.0,"sunrise":"2026-10-30T05:17","precipProbMax":null}"#,
            ),
            Some("null"),
        );
        assert_eq!(r["source"], "recorded");
        assert_eq!(r["provider"], "open-meteo");
        assert_eq!(r["date"], "2026-10-30");
        assert_eq!(r["recordedAt"], "2026-10-30T21:30:46Z");
        assert_eq!(r["daily"]["time"], json!(["2026-10-30"]));
        assert_eq!(r["daily"]["temperature_2m_max"], json!([31.2]));
        assert_eq!(r["daily"]["uv_index_max"], json!([11.0]));
        assert!(r["daily"].get("precipitation_probability_max").is_none());
        assert!(r.get("insights").is_none());
        // A legacy Open-Meteo-shaped daily passes through; garbage degrades.
        let legacy = recorded_from_d1(
            "h",
            "2026-10-01",
            0,
            "x",
            None,
            Some(r#"{"time":["2026-10-01"]}"#),
            None,
        );
        assert_eq!(legacy["daily"]["time"], json!(["2026-10-01"]));
        assert_eq!(
            recorded_from_d1("h", "2026-10-01", 0, "x", None, Some("{{"), None)["daily"]["time"],
            json!(["2026-10-01"])
        );
    }

    #[test]
    fn chunks_respect_coverage_span_and_newest_first() {
        let rem = |d: &[&str]| d.iter().map(|s| s.to_string()).collect::<BTreeSet<_>>();
        // POWER starts in 1981: 1970 dates have no chunk there, Open-Meteo has them.
        let old = rem(&["1970-05-01", "1970-05-02"]);
        assert!(chunks_for(&NASA_POWER, &old).is_empty());
        assert_eq!(
            chunks_for(&OPEN_METEO_ARCHIVE, &old),
            [("1970-05-01".to_owned(), "1970-05-02".to_owned())]
        );
        // Two years at 366 days a call: three chunks, newest first, none empty.
        let wide = rem(&["2024-01-01", "2026-10-01"]);
        let chunks = chunks_for(&OPEN_METEO_ARCHIVE, &wide);
        assert_eq!(chunks[0].1, "2026-10-01");
        assert!(chunks.iter().all(|(s, e)| span_days(s, e) <= 366));
        // The middle chunk holds no missing date and is skipped.
        assert_eq!(chunks.len(), 2);
        assert!(chunks_for(&NASA_POWER, &BTreeSet::new()).is_empty());
    }

    #[test]
    fn the_response_carries_sources_and_the_saved_flag() {
        let data = vec![doc("2026-10-28", SOURCE_NASA_POWER, "geo:abc1234")];
        let r = response(
            "geo:abc1234",
            "2026-10-25",
            "2026-10-31",
            data,
            1,
            false,
            Some(false),
        );
        assert_eq!(r["days"], 7);
        assert_eq!(r["records"], 1);
        assert_eq!(r["backfilled"], 1);
        assert_eq!(r["saved"], false);
        assert_eq!(r["sources"][0]["id"], "nasa-power");
        assert!(
            response("x", "2026-10-25", "2026-10-31", vec![], 0, false, None)
                .get("saved")
                .is_none()
        );
    }

    #[test]
    fn python_rounding_is_reproduced() {
        assert_eq!(round_py(2.675, 2), 2.67); // exact binary value is below the tie
        assert_eq!(round_py(0.125, 2), 0.12); // exact tie goes to even
        assert_eq!(round_py(-1.25, 1), -1.2);
        assert_eq!(estimate_utc_offset_seconds(139.7), 33_300);
        assert_eq!(estimate_utc_offset_seconds(31.05), 7_200);
        assert_eq!(estimate_utc_offset_seconds(f64::NAN), 0);
    }
}
