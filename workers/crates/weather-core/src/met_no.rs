//! MET Norway Locationforecast 2.0 as the failover forecast (mukoko-dev/mukoko-weather#434).
//!
//! When Open-Meteo refuses (HTTP 429 to the Workers' shared egress, an open
//! circuit breaker) and no stored forecast is fresh, the forecast Worker asks
//! MET Norway instead of answering the seasonal estimate. This module is the
//! pure part: the request, the HTTP caching rules, and the conversion of
//! MET Norway's GeoJSON to the app's `WeatherData` shape (the standards rule:
//! a provider's schema, names and units never become ours, so everything is
//! converted at the edge and only the canonical form is stored or served). The
//! Worker (`workers/forecast/src/met_no.rs`) only fetches and stores.
//!
//! # Terms of use (api.met.no/doc/TermsOfService, read 2026-11-02)
//!
//! * Data is CC BY 4.0 (and NLOD 2.0): credit "MET Norway", link the licence,
//!   say that changes were made ([`ATTRIBUTION`]). Do not call the service "Yr".
//! * Every request carries an identifying `User-Agent` with a contact
//!   ([`USER_AGENT`]); a fake one is abuse and gets a permanent ban.
//! * Coordinates are truncated to at most four decimals; five or more is a
//!   `403` ([`coordinate`]).
//! * Do not repeat a request before the `Expires` header, and send
//!   `If-Modified-Since` with the previous `Last-Modified` ([`Memo`]).
//! * No more than 20 requests a second per application, a `429` means stop at
//!   once ([`RateWindow`], `breaker::MET_NO`, `Breaker::trip`).
//! * Browsers must not call it: only the Worker does. No SLA.
//!
//! # The `complete` product, not `compact`
//!
//! `compact` has no dew point, apparent temperature, UV index or cloud layers
//! (checked against a live response, 2026-11-02), and the activity rules and
//! the hero read them. `complete` has them, and the 6-hourly extremes. The
//! wind gust and the probability of precipitation exist only inside MET
//! Norway's Nordic model domain (Oslo has them, Singapore does not); where
//! absent they stay `null`, never invented.
//!
//! # Conversion rules
//!
//! | Our field                  | MET Norway field                          | Conversion |
//! | -------------------------- | ----------------------------------------- | ---------- |
//! | `temperature_2m` (degC)    | `air_temperature` (celsius)               | none |
//! | `relative_humidity_2m` (%) | `relative_humidity` (%)                   | rounded to a whole number |
//! | `apparent_temperature`     | `apparent_air_temperature`                | else Steadman from temperature, humidity and wind |
//! | `dew_point_2m`             | `dew_point_temperature`                   | else Magnus |
//! | `wind_speed_10m` (km/h)    | `wind_speed` (m/s)                        | x 3.6 |
//! | `wind_gusts_10m` (km/h)    | `wind_speed_of_gust` (m/s)                | x 3.6; `null` outside the Nordic domain |
//! | `wind_direction_10m` (deg) | `wind_from_direction`                     | none, whole degrees |
//! | `surface_pressure` (hPa)   | `air_pressure_at_sea_level`               | reduced to the point's height ([`surface_pressure_hpa`]) |
//! | `cloud_cover` (%)          | `cloud_area_fraction`                     | whole number |
//! | `uv_index`                 | `ultraviolet_index_clear_sky`             | **clear-sky**: an upper bound under cloud |
//! | `precipitation` (mm)       | `next_1_hours.precipitation_amount`       | none |
//! | `precipitation_probability`| `next_1_hours.probability_of_precipitation` | `null` outside the Nordic domain |
//! | `weather_code` (WMO 4677)  | `next_1_hours.summary.symbol_code`        | [`wmo_code`] |
//! | `is_day`                   | the symbol's `_day` / `_night` suffix     | else the Sun's elevation ([`is_day`]) |
//! | `visibility`, `cape`, `lifted_index`, `et0` | not published            | `null` / absent, never invented |
//! | `sunrise`, `sunset`        | not published                             | computed from the position (`history::sun_times`) |
//!
//! `time` is MET Norway's UTC instant shifted to the place's wall clock
//! (`YYYY-MM-DDTHH:MM`, as Open-Meteo sends it). MET Norway sends no time zone,
//! so the offset is the caller's hint (a stored forecast of the same point, or
//! of the nearest seed place) or, failing that, the longitude estimate marked
//! `utc_offset_estimated`. A step describes the interval that BEGINS at its
//! time: `precipitation` and `weather_code` at 15:00 are for 15:00 to 16:00
//! (Open-Meteo's `precipitation` is the preceding hour, at most an hour apart).
//!
//! # Limits of this provider, stated in the payload and the docs
//!
//! * MET Norway returns no past hours. The first step is the current hour, so
//!   the first day's high, low, rain total and UV maximum cover the hours still
//!   ahead only (`baseline.coversFrom` says where they start).
//! * Hourly steps run about 2.7 days, then every 6 hours. `hourly` holds only
//!   the hourly part (never interpolated); `daily` uses all steps, with the
//!   6-hour windows' own extremes beyond the hourly part. Rain in a 6-hour
//!   window is counted on the local day the window starts in.
//! * No nowcast (`minutely` is `null`) and no model comparison.

use chrono::{DateTime, Datelike, Duration, Timelike, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::blend::{self, pyround};
use crate::{history, insights, normalize};

/// `X-Weather-Provider` for an answer from this provider.
pub const PROVIDER: &str = "met-no";
/// The name the licence asks us to credit.
pub const SOURCE_NAME: &str = "MET Norway";
pub const LICENSE: &str = "CC BY 4.0";
/// The credit line (the licence asks for the source, a link to the licence and
/// a note that changes were made; the page footer carries the links).
pub const ATTRIBUTION: &str =
    "Weather data from MET Norway (CC BY 4.0), converted to the Mukoko Weather format.";
/// Identifies the application and a contact, as the terms require. Never a
/// made-up string.
pub const USER_AGENT: &str = "mukoko-weather/1 weather.mukoko.com hi@mukoko.com";
pub const FORECAST_URL: &str = "https://api.met.no/weatherapi/locationforecast/2.0/complete";

/// Fewer hourly steps than this is not a forecast worth serving.
pub const MIN_HOURLY_STEPS: usize = 24;
/// Days in the daily block (as Open-Meteo's `forecast_days=7`).
pub const FORECAST_DAYS: usize = 7;
/// How long the converted forecast is kept for conditional requests.
pub const MEMO_TTL_SECONDS: u64 = 3 * 3600;
/// Used when MET Norway sends no usable `Expires`.
pub const DEFAULT_EXPIRES_MS: u64 = 10 * 60_000;
/// A past or imminent `Expires` is still honoured for this long, so a clock
/// skew cannot turn into a request on every call.
pub const MIN_EXPIRES_MS: u64 = 60_000;
/// A far-future `Expires` cannot pin old data.
pub const MAX_EXPIRES_MS: u64 = 3 * 3_600_000;
/// Requests one isolate may make in [`RATE_WINDOW_MS`]: half of MET Norway's
/// 20 a second, which is a limit on the whole application. Isolates do not
/// share this count, so it is a brake and not a guarantee; what bounds the
/// total is that only a point no provider could serve and no stored forecast
/// covers gets here, once per `Expires` window.
pub const MAX_REQUESTS_PER_WINDOW: usize = 10;
pub const RATE_WINDOW_MS: u64 = 1_000;

// ---------------------------------------------------------------------------
// The request and HTTP caching
// ---------------------------------------------------------------------------

/// A coordinate with exactly four decimals (MET Norway answers `403` to five or
/// more). `-0.0000` is written `0.0000`, so one point has one spelling.
pub fn coordinate(v: f64) -> String {
    let s = format!("{v:.4}");
    if s == "-0.0000" {
        "0.0000".to_owned()
    } else {
        s
    }
}

/// The Locationforecast URL for a point.
pub fn request_url(lat: f64, lon: f64) -> String {
    format!(
        "{FORECAST_URL}?lat={}&lon={}",
        coordinate(lat),
        coordinate(lon)
    )
}

/// The KV key of the converted forecast of a point, at the four decimals MET
/// Norway is asked for.
pub fn memo_key(lat: f64, lon: f64) -> String {
    format!("metno:v1:{}_{}", coordinate(lat), coordinate(lon))
}

/// An HTTP date (`Expires`, `Last-Modified`), e.g. `Mon, 02 Nov 2026 14:54:36
/// GMT`.
pub fn parse_http_date(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc2822(value.trim())
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

/// When a response may be asked for again: its `Expires`, kept between
/// [`MIN_EXPIRES_MS`] and [`MAX_EXPIRES_MS`] from now; [`DEFAULT_EXPIRES_MS`]
/// when the header is missing or unreadable.
pub fn expiry_ms(expires: Option<&str>, now_ms: u64) -> u64 {
    match expires.and_then(parse_http_date) {
        Some(at) => {
            let at = at.timestamp_millis().max(0) as u64;
            at.clamp(now_ms + MIN_EXPIRES_MS, now_ms + MAX_EXPIRES_MS)
        }
        None => now_ms + DEFAULT_EXPIRES_MS,
    }
}

/// The converted forecast of a point, kept in KV with what the next request
/// needs: when it may be asked for again and the `Last-Modified` to send back
/// as `If-Modified-Since` (verbatim, as the terms ask).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Memo {
    /// [`convert`]'s output (served through [`finish`]).
    pub payload: Value,
    pub expires_ms: u64,
    #[serde(default)]
    pub last_modified: Option<String>,
}

impl Memo {
    pub fn new(
        payload: Value,
        expires: Option<&str>,
        last_modified: Option<&str>,
        now_ms: u64,
    ) -> Memo {
        Memo {
            payload,
            expires_ms: expiry_ms(expires, now_ms),
            last_modified: last_modified
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_owned),
        }
    }

    /// Still inside the `Expires` window: no request may be made.
    pub fn is_fresh(&self, now_ms: u64) -> bool {
        now_ms < self.expires_ms
    }

    /// A `304 Not Modified`: the same forecast, asked for again after the new
    /// `Expires`.
    pub fn revalidated(mut self, expires: Option<&str>, now_ms: u64) -> Memo {
        self.expires_ms = expiry_ms(expires, now_ms);
        self
    }
}

/// A sliding window of request times: at most `max` in `window_ms`.
#[derive(Debug, Clone, Default)]
pub struct RateWindow {
    stamps: Vec<u64>,
}

impl RateWindow {
    pub const fn new() -> Self {
        RateWindow { stamps: Vec::new() }
    }

    /// Take a slot for a request at `now_ms`, or `false` when the window is
    /// full.
    pub fn try_acquire(&mut self, now_ms: u64, max: usize, window_ms: u64) -> bool {
        self.stamps
            .retain(|t| now_ms.saturating_sub(*t) < window_ms);
        if self.stamps.len() >= max {
            return false;
        }
        self.stamps.push(now_ms);
        true
    }
}

// ---------------------------------------------------------------------------
// The place's UTC offset
// ---------------------------------------------------------------------------

/// What is known of the place's UTC offset before MET Norway answers (it sends
/// none). `estimated` is true when the offset is not the place's own.
#[derive(Debug, Clone, PartialEq)]
pub struct OffsetHint {
    pub seconds: i64,
    pub timezone: Option<String>,
    pub estimated: bool,
}

/// The offset a stored forecast payload carries. `same_place` is true for a
/// forecast of this very point (its zone name and its own estimated flag are
/// kept); a forecast of a neighbouring seed place lends only the number, and it
/// is always an estimate (a border can lie between the two).
pub fn hint_from_payload(payload: &Value, same_place: bool) -> Option<OffsetHint> {
    let seconds = payload.get("utc_offset_seconds")?.as_f64()? as i64;
    // Real offsets run from UTC-12 to UTC+14.
    if !(-12 * 3600..=14 * 3600).contains(&seconds) {
        return None;
    }
    let estimated = !same_place
        || payload
            .get("utc_offset_estimated")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    let timezone = if same_place {
        payload
            .get("timezone")
            .and_then(Value::as_str)
            .filter(|z| !z.is_empty())
            .map(str::to_owned)
    } else {
        None
    };
    Some(OffsetHint {
        seconds,
        timezone,
        estimated,
    })
}

// ---------------------------------------------------------------------------
// Symbols, the Sun and pressure
// ---------------------------------------------------------------------------

/// The symbol without its `_day` / `_night` / `_polartwilight` variant.
fn base_symbol(symbol: &str) -> &str {
    let s = symbol.trim();
    ["_day", "_night", "_polartwilight"]
        .iter()
        .find_map(|suffix| s.strip_suffix(suffix))
        .unwrap_or(s)
}

/// WMO 4677 code of a precipitation symbol stem (no thunder). Sleet has no
/// code in the set the app labels (the Open-Meteo subset has no 68, 69, 83 or
/// 84), so sleet takes the snow code of the same intensity: a wintry-mix hour
/// is never labelled plain rain. The legend spells two stems with a stray
/// extra `s` (`lightssleetshowers`, `lightssnowshowers`); both spellings map.
fn precipitation_code(stem: &str) -> Option<i64> {
    Some(match stem {
        "lightrain" => 61,
        "rain" => 63,
        "heavyrain" => 65,
        "lightrainshowers" => 80,
        "rainshowers" => 81,
        "heavyrainshowers" => 82,
        "lightsnow" | "lightsleet" => 71,
        "snow" | "sleet" => 73,
        "heavysnow" | "heavysleet" => 75,
        "lightsnowshowers" | "lightssnowshowers" | "lightsleetshowers" | "lightssleetshowers"
        | "snowshowers" | "sleetshowers" => 85,
        "heavysnowshowers" | "heavysleetshowers" => 86,
        _ => return None,
    })
}

/// WMO 4677 weather code of a MET Norway `symbol_code`
/// (github.com/metno/weathericons, `weather/legend.csv`: 40 symbols, most with
/// `_day`, `_night` and `_polartwilight` variants). `None` for a symbol this
/// table does not know: no code is guessed.
///
/// | MET Norway | WMO | | MET Norway | WMO |
/// | --- | --- | --- | --- | --- |
/// | clearsky | 0 | | lightsnow, lightsleet | 71 |
/// | fair | 1 | | snow, sleet | 73 |
/// | partlycloudy | 2 | | heavysnow, heavysleet | 75 |
/// | cloudy | 3 | | lightsnowshowers, snowshowers, light/sleetshowers | 85 |
/// | fog | 45 | | heavysnowshowers, heavysleetshowers | 86 |
/// | lightrain, rain, heavyrain | 61, 63, 65 | | any `...andthunder` | 95 |
/// | lightrainshowers, rainshowers, heavyrainshowers | 80, 81, 82 | | | |
///
/// Thunder symbols are all 95 (thunderstorm): MET Norway does not say whether
/// there is hail, so 96 and 99 are never chosen.
pub fn wmo_code(symbol: &str) -> Option<i64> {
    let base = base_symbol(symbol);
    match base {
        "clearsky" => Some(0),
        "fair" => Some(1),
        "partlycloudy" => Some(2),
        "cloudy" => Some(3),
        "fog" => Some(45),
        _ => match base.strip_suffix("andthunder") {
            Some(stem) => precipitation_code(stem).map(|_| 95),
            None => precipitation_code(base),
        },
    }
}

/// Day or night from a symbol's variant suffix; `None` for a symbol without
/// one (`cloudy`, `rain`, `fog`, ...). Polar twilight is not day: the Sun is
/// below the horizon.
pub fn symbol_is_day(symbol: &str) -> Option<bool> {
    let s = symbol.trim();
    if s.ends_with("_day") {
        Some(true)
    } else if s.ends_with("_night") || s.ends_with("_polartwilight") {
        Some(false)
    } else {
        None
    }
}

/// The Sun's elevation above the horizon in degrees (NOAA solar equations, the
/// series `history::sun_times` uses).
pub fn sun_elevation_deg(lat: f64, lon: f64, at: DateTime<Utc>) -> f64 {
    use std::f64::consts::PI;
    let hour =
        f64::from(at.hour()) + f64::from(at.minute()) / 60.0 + f64::from(at.second()) / 3600.0;
    let g = 2.0 * PI / 365.0 * (f64::from(at.ordinal()) - 1.0 + (hour - 12.0) / 24.0);
    let eqtime = 229.18
        * (0.000075 + 0.001868 * g.cos()
            - 0.032077 * g.sin()
            - 0.014615 * (2.0 * g).cos()
            - 0.040849 * (2.0 * g).sin());
    let decl = 0.006918 - 0.399912 * g.cos() + 0.070257 * g.sin() - 0.006758 * (2.0 * g).cos()
        + 0.000907 * (2.0 * g).sin()
        - 0.002697 * (3.0 * g).cos()
        + 0.00148 * (3.0 * g).sin();
    let solar_minutes = hour * 60.0 + eqtime + 4.0 * lon;
    let hour_angle = (solar_minutes / 4.0 - 180.0).to_radians();
    let phi = lat.to_radians();
    let cos_zenith = phi.sin() * decl.sin() + phi.cos() * decl.cos() * hour_angle.cos();
    90.0 - cos_zenith.clamp(-1.0, 1.0).acos().to_degrees()
}

/// Whether the hour that begins at `start` is day. A step is judged in the
/// middle of its hour, the way MET Norway's own `_day` / `_night` suffix is
/// (checked on 58 hourly steps of two live responses: no disagreement), with
/// the Sun's upper limb on the horizon (-0.833 degrees).
pub fn is_day(symbol: &str, lat: f64, lon: f64, start: DateTime<Utc>) -> bool {
    symbol_is_day(symbol)
        .unwrap_or_else(|| sun_elevation_deg(lat, lon, start + Duration::minutes(30)) > -0.833)
}

/// Station pressure from sea-level pressure: MET Norway publishes only
/// `air_pressure_at_sea_level`, our `surface_pressure` is the pressure at the
/// point (Open-Meteo's, ~850 hPa in Harare). The standard-atmosphere reduction
/// `p = p0 (1 - 0.0065 h / (T + 0.0065 h + 273.15)) ^ 5.257`, with `h` the
/// height of the point as MET Norway reports it.
pub fn surface_pressure_hpa(msl_hpa: f64, temp_c: f64, altitude_m: f64) -> f64 {
    msl_hpa * (1.0 - 0.0065 * altitude_m / (temp_c + 0.0065 * altitude_m + 273.15)).powf(5.257)
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|f| f.is_finite())
}

fn jn(v: Option<f64>) -> Value {
    v.map_or(Value::Null, |f| json!(f))
}

fn ji(v: Option<i64>) -> Value {
    v.map_or(Value::Null, |i| json!(i))
}

fn whole(v: f64) -> i64 {
    pyround(v, 0) as i64
}

/// One entry of MET Norway's `timeseries`.
struct Step {
    time: DateTime<Utc>,
    temp: f64,
    msl: Option<f64>,
    humidity: Option<f64>,
    cloud: Option<f64>,
    wind_ms: Option<f64>,
    wind_dir: Option<f64>,
    gust_ms: Option<f64>,
    apparent: Option<f64>,
    dew: Option<f64>,
    uv: Option<f64>,
    /// Hours the step's forecast block covers: 1, 6, or 0 (instant only).
    span: u8,
    symbol: Option<String>,
    precip: Option<f64>,
    pop: Option<f64>,
    /// The 6-hour window's own extremes (6-hourly steps only).
    temp_max_6h: Option<f64>,
    temp_min_6h: Option<f64>,
}

fn parse_step(entry: &Value) -> Option<Step> {
    let time = DateTime::parse_from_rfc3339(entry.get("time")?.as_str()?)
        .ok()?
        .with_timezone(&Utc);
    let data = entry.get("data")?;
    let instant = data.pointer("/instant/details")?;
    let temp = num(instant.get("air_temperature"))?;
    let (span, block) = match (data.get("next_1_hours"), data.get("next_6_hours")) {
        (Some(b), _) if b.is_object() => (1, Some(b)),
        (_, Some(b)) if b.is_object() => (6, Some(b)),
        _ => (0, None),
    };
    let detail = |key: &str| num(block.and_then(|b| b.pointer(&format!("/details/{key}"))));
    Some(Step {
        time,
        temp,
        msl: num(instant.get("air_pressure_at_sea_level")),
        humidity: num(instant.get("relative_humidity")),
        cloud: num(instant.get("cloud_area_fraction")),
        wind_ms: num(instant.get("wind_speed")),
        wind_dir: num(instant.get("wind_from_direction")),
        gust_ms: num(instant.get("wind_speed_of_gust")),
        apparent: num(instant.get("apparent_air_temperature")),
        dew: num(instant.get("dew_point_temperature")),
        uv: num(instant.get("ultraviolet_index_clear_sky")),
        span,
        symbol: block
            .and_then(|b| b.pointer("/summary/symbol_code"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        precip: detail("precipitation_amount"),
        pop: detail("probability_of_precipitation"),
        temp_max_6h: if span == 6 {
            detail("air_temperature_max")
        } else {
            None
        },
        temp_min_6h: if span == 6 {
            detail("air_temperature_min")
        } else {
            None
        },
    })
}

fn local_string(t: DateTime<Utc>, offset: i64, format: &str) -> String {
    (t + Duration::seconds(offset)).format(format).to_string()
}

fn max_of(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.max(y)),
        (x, None) => x,
        (None, y) => y,
    }
}

fn min_of(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.min(y)),
        (x, None) => x,
        (None, y) => y,
    }
}

/// One local day, built up step by step.
#[derive(Default)]
struct Day {
    temp_max: Option<f64>,
    temp_min: Option<f64>,
    apparent_max: Option<f64>,
    apparent_min: Option<f64>,
    precip: Option<f64>,
    code: Option<i64>,
    pop: Option<f64>,
    wind: Option<f64>,
    gust: Option<f64>,
    uv: Option<f64>,
    /// Wind vector (east, north) weighted by speed, for the dominant direction.
    east: f64,
    north: f64,
}

impl Day {
    fn add(&mut self, s: &Step) {
        self.temp_max = max_of(self.temp_max, max_of(Some(s.temp), s.temp_max_6h));
        self.temp_min = min_of(self.temp_min, min_of(Some(s.temp), s.temp_min_6h));
        self.apparent_max = max_of(self.apparent_max, s.apparent);
        self.apparent_min = min_of(self.apparent_min, s.apparent);
        if let Some(p) = s.precip {
            self.precip = Some(self.precip.unwrap_or(0.0) + p);
        }
        // The most severe condition of the day: WMO codes rise with severity
        // (the blend breaks ties the same way).
        let code = s.symbol.as_deref().and_then(wmo_code);
        self.code = match (self.code, code) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, None) => a,
            (None, b) => b,
        };
        self.pop = max_of(self.pop, s.pop);
        let wind_kmh = s.wind_ms.map(|w| w * 3.6);
        self.wind = max_of(self.wind, wind_kmh);
        self.gust = max_of(self.gust, s.gust_ms.map(|g| g * 3.6));
        self.uv = max_of(self.uv, s.uv);
        if let (Some(w), Some(d)) = (s.wind_ms, s.wind_dir) {
            self.east += d.to_radians().sin() * w;
            self.north += d.to_radians().cos() * w;
        }
    }

    /// The direction the wind blows from, averaged over the day by speed;
    /// `None` when it was calm throughout.
    fn dominant_direction(&self) -> Option<i64> {
        if self.east.abs() < 1e-9 && self.north.abs() < 1e-9 {
            return None;
        }
        let deg = self.east.atan2(self.north).to_degrees();
        Some(whole((deg + 360.0).rem_euclid(360.0)) % 360)
    }
}

/// The usable entries of the `timeseries`, oldest first.
fn steps_of(raw: &Value) -> Vec<Step> {
    let mut steps: Vec<Step> = raw
        .pointer("/properties/timeseries")
        .and_then(Value::as_array)
        .map(|series| series.iter().filter_map(parse_step).collect())
        .unwrap_or_default();
    steps.sort_by_key(|s| s.time);
    steps.dedup_by_key(|s| s.time);
    steps
}

/// The leading run of hourly steps: each covers exactly one hour and follows
/// the one before by one hour.
fn hourly_run(steps: &[Step]) -> &[Step] {
    let mut end = 0;
    for (i, s) in steps.iter().enumerate() {
        let contiguous = i == 0 || s.time - steps[i - 1].time == Duration::hours(1);
        if s.span == 1 && contiguous {
            end = i + 1;
        } else {
            break;
        }
    }
    &steps[..end]
}

/// Convert a Locationforecast 2.0 `complete` response (GeoJSON) for the point
/// (`lat`, `lon`) to the app's `WeatherData` shape, before insights are
/// derived and `current` is chosen ([`finish`] does those, at serve time).
///
/// `hint` is the place's UTC offset when known; without it the longitude
/// estimate is used and marked `utc_offset_estimated`. `None` when the response
/// is not a usable forecast: no height for the point, or fewer than
/// [`MIN_HOURLY_STEPS`] hourly steps.
pub fn convert(raw: &Value, lat: f64, lon: f64, hint: Option<&OffsetHint>) -> Option<Value> {
    let altitude = num(raw.pointer("/geometry/coordinates/2"))?;
    let steps = steps_of(raw);
    let hourly = hourly_run(&steps);
    if hourly.len() < MIN_HOURLY_STEPS {
        return None;
    }
    let (offset, estimated, timezone) = match hint {
        Some(h) => (h.seconds, h.estimated, h.timezone.clone()),
        None => (blend::estimate_utc_offset(lon), true, None),
    };

    // --- hourly ------------------------------------------------------------
    let mut cols: Vec<(&str, Vec<Value>)> = [
        "time",
        "temperature_2m",
        "relative_humidity_2m",
        "apparent_temperature",
        "precipitation_probability",
        "precipitation",
        "weather_code",
        "wind_speed_10m",
        "wind_direction_10m",
        "wind_gusts_10m",
        "surface_pressure",
        "cloud_cover",
        "uv_index",
        "visibility",
        "is_day",
        "dew_point_2m",
    ]
    .into_iter()
    .map(|k| (k, Vec::with_capacity(hourly.len())))
    .collect();
    for s in hourly {
        let wind_kmh = s.wind_ms.map(|w| pyround(w * 3.6, 1));
        let humidity = s.humidity.map(|h| h.clamp(0.0, 100.0));
        let apparent = s.apparent.or_else(|| {
            history::apparent_temperature(Some(s.temp), humidity, s.wind_ms.map(|w| w * 3.6))
        });
        let dew = s
            .dew
            .or_else(|| insights::dew_point_c(Some(s.temp), humidity));
        let symbol = s.symbol.as_deref().unwrap_or("");
        let row: [Value; 16] = [
            json!(local_string(s.time, offset, "%Y-%m-%dT%H:%M")),
            json!(pyround(s.temp, 1)),
            ji(humidity.map(whole)),
            jn(apparent.map(|a| pyround(a, 1))),
            ji(s.pop.map(whole)),
            jn(s.precip.map(|p| pyround(p, 2))),
            ji(s.symbol.as_deref().and_then(wmo_code)),
            jn(wind_kmh),
            ji(s.wind_dir.map(|d| whole(d).rem_euclid(360))),
            jn(s.gust_ms.map(|g| pyround(g * 3.6, 1))),
            jn(s.msl
                .map(|p| pyround(surface_pressure_hpa(p, s.temp, altitude), 1))),
            ji(s.cloud.map(whole)),
            jn(s.uv.map(|u| pyround(u, 1))),
            Value::Null,
            json!(i64::from(is_day(symbol, lat, lon, s.time))),
            jn(dew.map(|d| pyround(d, 1))),
        ];
        for ((_, col), value) in cols.iter_mut().zip(row) {
            col.push(value);
        }
    }
    let hourly_json: Map<String, Value> = cols
        .into_iter()
        .map(|(k, v)| (k.to_owned(), Value::Array(v)))
        .collect();

    // --- daily -------------------------------------------------------------
    let mut days: Vec<(String, Day)> = Vec::new();
    for s in &steps {
        let date = local_string(s.time, offset, "%Y-%m-%d");
        if days.last().is_none_or(|(d, _)| *d != date) {
            days.push((date, Day::default()));
        }
        if let Some((_, day)) = days.last_mut() {
            day.add(s);
        }
    }
    days.truncate(FORECAST_DAYS);
    let mut daily: Vec<(&str, Vec<Value>)> = [
        "time",
        "weather_code",
        "temperature_2m_max",
        "temperature_2m_min",
        "apparent_temperature_max",
        "apparent_temperature_min",
        "sunrise",
        "sunset",
        "uv_index_max",
        "precipitation_sum",
        "precipitation_probability_max",
        "wind_speed_10m_max",
        "wind_gusts_10m_max",
        "wind_direction_10m_dominant",
    ]
    .into_iter()
    .map(|k| (k, Vec::with_capacity(days.len())))
    .collect();
    for (date, day) in &days {
        let (rise, set) = history::sun_times(lat, lon, date, offset);
        let row: [Value; 14] = [
            json!(date),
            ji(day.code),
            jn(day.temp_max.map(|t| pyround(t, 1))),
            jn(day.temp_min.map(|t| pyround(t, 1))),
            jn(day.apparent_max.map(|t| pyround(t, 1))),
            jn(day.apparent_min.map(|t| pyround(t, 1))),
            rise.map_or(Value::Null, Value::from),
            set.map_or(Value::Null, Value::from),
            jn(day.uv.map(|u| pyround(u, 1))),
            jn(day.precip.map(|p| pyround(p, 2))),
            ji(day.pop.map(whole)),
            jn(day.wind.map(|w| pyround(w, 1))),
            jn(day.gust.map(|g| pyround(g, 1))),
            ji(day.dominant_direction()),
        ];
        for ((_, col), value) in daily.iter_mut().zip(row) {
            col.push(value);
        }
    }
    let daily_json: Map<String, Value> = daily
        .into_iter()
        .map(|(k, v)| (k.to_owned(), Value::Array(v)))
        .collect();

    // --- the rest ----------------------------------------------------------
    let mut baseline = json!({
        "provider": PROVIDER,
        "blend": false,
        "reason": "failover",
        "source": SOURCE_NAME,
        "license": LICENSE,
        // Not a measurement: the index under a cloudless sky.
        "uvIndex": "clear-sky",
        // MET Norway returns no past hours: the first day's values start here.
        "coversFrom": hourly_json.get("time").and_then(|t| t.get(0)).cloned().unwrap_or(Value::Null),
    });
    if let Some(updated) = raw
        .pointer("/properties/meta/updated_at")
        .and_then(Value::as_str)
    {
        baseline["updatedAt"] = json!(updated);
    }

    let mut payload = json!({
        "current": {},
        "hourly": hourly_json,
        "daily": daily_json,
        "current_units": normalize::current_units(),
        "utc_offset_seconds": offset,
        "baseline": baseline,
    });
    if estimated {
        payload["utc_offset_estimated"] = json!(true);
    }
    if let Some(zone) = timezone {
        payload["timezone"] = json!(zone);
    }
    if altitude > -1000.0 && altitude < 9000.0 {
        payload["elevation"] = json!(altitude);
    }
    Some(payload)
}

/// Serve a converted forecast at `now`: `current` is the hourly step of the
/// place's current hour, then the insights are derived from it and the
/// intermediate fields stripped, exactly as for the Open-Meteo baseline. It is
/// done at every serve (not once at conversion) so a forecast kept for its
/// `Expires` window never shows an hour that has gone by. `None` when the
/// hourly steps no longer reach `now`.
pub fn finish(converted: &Value, now: DateTime<Utc>) -> Option<Value> {
    let mut payload = converted.clone();
    let offset = payload.get("utc_offset_seconds")?.as_i64()?;
    let times: Vec<String> = payload
        .pointer("/hourly/time")?
        .as_array()?
        .iter()
        .filter_map(|t| t.as_str().map(str::to_owned))
        .collect();
    let last = times.last()?;
    let local_now = local_string(now, offset, "%Y-%m-%dT%H:%M");
    // Past the last hourly step's hour: this forecast has run out.
    let last_end = chrono::NaiveDateTime::parse_from_str(last, "%Y-%m-%dT%H:%M")
        .ok()?
        .checked_add_signed(Duration::hours(1))?
        .format("%Y-%m-%dT%H:%M")
        .to_string();
    if local_now >= last_end {
        return None;
    }
    // The last step whose hour has begun (the first, if none has).
    let idx = times
        .iter()
        .rposition(|t| t.as_str() <= local_now.as_str())
        .unwrap_or(0);

    let mut current = Map::new();
    current.insert("time".into(), json!(times[idx]));
    for var in blend::CURRENT_VARS.split(',') {
        let v = payload
            .pointer(&format!("/hourly/{var}/{idx}"))
            .cloned()
            .unwrap_or(Value::Null);
        current.insert(var.to_owned(), v);
    }
    payload["current"] = Value::Object(current);

    let mut out = blend::finalize_baseline(&payload, now);
    out["minutely"] = Value::Null;
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    /// A real response for Sembawang, Singapore (`complete`, fetched
    /// 2026-11-02; outside MET Norway's Nordic domain: no gusts, no rain
    /// probability), with the headers it came with.
    fn singapore_fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../../tests/fixtures/met-no-locationforecast-singapore.json"
        ))
        .unwrap()
    }

    /// A real response for Oslo (inside the Nordic domain), first 36 entries.
    fn oslo_fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../../tests/fixtures/met-no-locationforecast-oslo.json"
        ))
        .unwrap()
    }

    const SG: (f64, f64) = (1.4440, 103.8240);
    const OSLO: (f64, f64) = (59.9139, 10.7522);

    fn singapore_hint() -> OffsetHint {
        OffsetHint {
            seconds: 8 * 3600,
            timezone: Some("Asia/Singapore".into()),
            estimated: false,
        }
    }

    fn oslo_hint() -> OffsetHint {
        // Norway left summer time on 2026-10-25: UTC+1.
        OffsetHint {
            seconds: 3600,
            timezone: Some("Europe/Oslo".into()),
            estimated: false,
        }
    }

    fn singapore() -> Value {
        convert(
            &singapore_fixture()["response"],
            SG.0,
            SG.1,
            Some(&singapore_hint()),
        )
        .expect("a usable forecast")
    }

    fn oslo() -> Value {
        convert(
            &oslo_fixture()["response"],
            OSLO.0,
            OSLO.1,
            Some(&oslo_hint()),
        )
        .expect("a usable forecast")
    }

    /// When the fixtures were fetched.
    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 2, 14, 30, 0).unwrap()
    }

    // ---- the request and HTTP caching -----------------------------------

    #[test]
    fn coordinates_are_sent_with_exactly_four_decimals() {
        assert_eq!(coordinate(1.444), "1.4440");
        assert_eq!(coordinate(-17.83), "-17.8300");
        assert_eq!(coordinate(103.824_012_34), "103.8240");
        assert_eq!(coordinate(-0.000_01), "0.0000", "one spelling for zero");
        assert_eq!(
            request_url(1.444, 103.824),
            "https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=1.4440&lon=103.8240"
        );
        assert_eq!(memo_key(-17.83, 31.05), "metno:v1:-17.8300_31.0500");
        // Five decimals would be a 403: never more than four, whatever the
        // input.
        for v in [0.123_456_789, -89.999_999, 179.999_999_9, 12.345_65, 1e-9] {
            let s = coordinate(v);
            let decimals = s.split('.').nth(1).map_or(0, str::len);
            assert!(decimals <= 4, "{s}");
        }
    }

    #[test]
    fn the_user_agent_names_the_app_and_a_contact() {
        assert_eq!(
            USER_AGENT,
            "mukoko-weather/1 weather.mukoko.com hi@mukoko.com"
        );
    }

    #[test]
    fn expiry_follows_the_expires_header_within_bounds() {
        let fx = singapore_fixture();
        let expires = fx["request"]["expires"].as_str().unwrap();
        let fetched = parse_http_date(fx["request"]["date"].as_str().unwrap()).unwrap();
        let expected = parse_http_date(expires).unwrap();
        assert_eq!(expected.to_rfc3339(), "2026-11-02T14:54:36+00:00");
        let now_ms = fetched.timestamp_millis() as u64;
        // 31 minutes 17 seconds after the response, as sent.
        assert_eq!(
            expiry_ms(Some(expires), now_ms),
            expected.timestamp_millis() as u64
        );
        // Already past (clock skew): still not a request on every call.
        let late = expected.timestamp_millis() as u64 + 10 * 60_000;
        assert_eq!(expiry_ms(Some(expires), late), late + MIN_EXPIRES_MS);
        // A far-future header cannot pin the data for a day.
        assert_eq!(
            expiry_ms(Some("Mon, 02 Nov 2037 14:54:36 GMT"), now_ms),
            now_ms + MAX_EXPIRES_MS
        );
        // Missing or unreadable: a short default.
        assert_eq!(expiry_ms(None, now_ms), now_ms + DEFAULT_EXPIRES_MS);
        assert_eq!(
            expiry_ms(Some("tomorrow"), now_ms),
            now_ms + DEFAULT_EXPIRES_MS
        );
    }

    #[test]
    fn a_memo_is_fresh_until_expires_and_keeps_last_modified_verbatim() {
        let fx = singapore_fixture();
        let fetched = parse_http_date(fx["request"]["date"].as_str().unwrap())
            .unwrap()
            .timestamp_millis() as u64;
        let memo = Memo::new(
            json!({"hourly": {}}),
            fx["request"]["expires"].as_str(),
            fx["request"]["lastModified"].as_str(),
            fetched,
        );
        assert_eq!(
            memo.last_modified.as_deref(),
            Some("Mon, 02 Nov 2026 14:23:19 GMT"),
            "sent back as If-Modified-Since exactly as received"
        );
        assert!(memo.is_fresh(fetched));
        assert!(memo.is_fresh(memo.expires_ms - 1));
        assert!(!memo.is_fresh(memo.expires_ms));
        // A 304 asks again after the new Expires, with the same forecast and
        // the same Last-Modified.
        let again = memo
            .clone()
            .revalidated(Some("Mon, 02 Nov 2026 15:25:00 GMT"), memo.expires_ms);
        assert!(again.expires_ms > memo.expires_ms);
        assert_eq!(again.last_modified, memo.last_modified);
        assert_eq!(again.payload, memo.payload);
        // It survives KV.
        let stored: Memo = serde_json::from_str(&serde_json::to_string(&memo).unwrap()).unwrap();
        assert_eq!(stored.expires_ms, memo.expires_ms);
        assert_eq!(stored.last_modified, memo.last_modified);
        // An empty Last-Modified is none.
        assert_eq!(
            Memo::new(json!({}), None, Some("  "), 0).last_modified,
            None
        );
    }

    #[test]
    fn one_isolate_makes_a_bounded_number_of_requests_a_second() {
        let mut w = RateWindow::new();
        for _ in 0..MAX_REQUESTS_PER_WINDOW {
            assert!(w.try_acquire(5_000, MAX_REQUESTS_PER_WINDOW, RATE_WINDOW_MS));
        }
        assert!(!w.try_acquire(5_999, MAX_REQUESTS_PER_WINDOW, RATE_WINDOW_MS));
        // A request that has aged out of the window gives its slot back.
        assert!(w.try_acquire(6_000, MAX_REQUESTS_PER_WINDOW, RATE_WINDOW_MS));
        const { assert!(MAX_REQUESTS_PER_WINDOW as u64 * 1000 / RATE_WINDOW_MS <= 20) };
    }

    #[test]
    fn an_offset_is_borrowed_with_the_right_caveats() {
        let own = json!({"utc_offset_seconds": 28800, "timezone": "Asia/Singapore"});
        assert_eq!(
            hint_from_payload(&own, true),
            Some(OffsetHint {
                seconds: 28800,
                timezone: Some("Asia/Singapore".into()),
                estimated: false
            })
        );
        // The same point's own estimate stays an estimate.
        let est = json!({"utc_offset_seconds": 25200, "utc_offset_estimated": true});
        assert!(hint_from_payload(&est, true).unwrap().estimated);
        // A neighbour lends the number only: no zone name (it would name the
        // country), and always an estimate.
        let borrowed = hint_from_payload(&own, false).unwrap();
        assert_eq!(borrowed.seconds, 28800);
        assert_eq!(borrowed.timezone, None);
        assert!(borrowed.estimated);
        // Nonsense is refused.
        assert_eq!(
            hint_from_payload(&json!({"utc_offset_seconds": 99999}), true),
            None
        );
        assert_eq!(hint_from_payload(&json!({}), true), None);
    }

    // ---- symbols, the Sun, pressure ---------------------------------------

    /// Every symbol in MET Norway's legend (github.com/metno/weathericons,
    /// `weather/legend.csv`; the two stems with a stray `s` are spelled as the
    /// legend spells them), without `fog`, the 41st row.
    const LEGEND: [&str; 40] = [
        "clearsky",
        "fair",
        "partlycloudy",
        "cloudy",
        "lightrainshowers",
        "rainshowers",
        "heavyrainshowers",
        "lightrainshowersandthunder",
        "rainshowersandthunder",
        "heavyrainshowersandthunder",
        "lightsleetshowers",
        "sleetshowers",
        "heavysleetshowers",
        "lightssleetshowersandthunder",
        "sleetshowersandthunder",
        "heavysleetshowersandthunder",
        "lightsnowshowers",
        "snowshowers",
        "heavysnowshowers",
        "lightssnowshowersandthunder",
        "snowshowersandthunder",
        "heavysnowshowersandthunder",
        "lightrain",
        "rain",
        "heavyrain",
        "lightrainandthunder",
        "rainandthunder",
        "heavyrainandthunder",
        "lightsleet",
        "sleet",
        "heavysleet",
        "lightsleetandthunder",
        "sleetandthunder",
        "heavysleetandthunder",
        "lightsnow",
        "snow",
        "heavysnow",
        "lightsnowandthunder",
        "snowandthunder",
        "heavysnowandthunder",
    ];

    #[test]
    fn every_met_norway_symbol_has_a_wmo_code_the_app_can_label() {
        for base in LEGEND.into_iter().chain(["fog"]) {
            // All three variants are the same condition.
            for symbol in [
                base.to_owned(),
                format!("{base}_day"),
                format!("{base}_night"),
                format!("{base}_polartwilight"),
            ] {
                let code = wmo_code(&symbol).unwrap_or_else(|| panic!("{symbol}"));
                assert!(
                    crate::wmo::known_description(code).is_some(),
                    "{symbol} -> {code} has no label"
                );
            }
        }
    }

    #[test]
    fn symbols_map_to_the_documented_codes() {
        for (symbol, code) in [
            ("clearsky_day", 0),
            ("clearsky_night", 0),
            ("fair_polartwilight", 1),
            ("partlycloudy_day", 2),
            ("cloudy", 3),
            ("fog", 45),
            ("lightrain", 61),
            ("rain", 63),
            ("heavyrain", 65),
            ("lightrainshowers_day", 80),
            ("rainshowers_night", 81),
            ("heavyrainshowers_day", 82),
            ("lightsnow", 71),
            ("snow", 73),
            ("heavysnow", 75),
            ("lightsnowshowers_day", 85),
            ("heavysnowshowers_night", 86),
            // Sleet takes the snow code of the same intensity.
            ("lightsleet", 71),
            ("sleet", 73),
            ("heavysleet", 75),
            ("sleetshowers_day", 85),
            ("heavysleetshowers_day", 86),
            // Thunder is always 95: MET Norway does not say whether there is hail.
            ("rainandthunder", 95),
            ("heavyrainshowersandthunder_day", 95),
            ("lightssleetshowersandthunder_night", 95),
            ("lightssnowshowersandthunder_day", 95),
            ("snowandthunder", 95),
        ] {
            assert_eq!(wmo_code(symbol), Some(code), "{symbol}");
        }
        // No guessing.
        for unknown in [
            "",
            "tornado",
            "hail",
            "rainandthunder_x",
            "andthunder",
            "x_day",
        ] {
            assert_eq!(wmo_code(unknown), None, "{unknown:?}");
        }
    }

    #[test]
    fn the_symbol_suffix_says_day_or_night() {
        assert_eq!(symbol_is_day("clearsky_day"), Some(true));
        assert_eq!(symbol_is_day("clearsky_night"), Some(false));
        assert_eq!(symbol_is_day("fair_polartwilight"), Some(false));
        assert_eq!(symbol_is_day("cloudy"), None);
        assert_eq!(symbol_is_day("rain"), None);
    }

    #[test]
    fn without_a_suffix_the_sun_decides_and_agrees_with_met_norways_own_suffix() {
        // Singapore, 22:00 local: night. 10:00 local: day.
        let night = Utc.with_ymd_and_hms(2026, 11, 2, 14, 0, 0).unwrap();
        let day = Utc.with_ymd_and_hms(2026, 11, 3, 2, 0, 0).unwrap();
        assert!(!is_day("cloudy", SG.0, SG.1, night));
        assert!(is_day("cloudy", SG.0, SG.1, day));
        // The suffix wins when there is one.
        assert!(is_day("clearsky_day", SG.0, SG.1, night));
        // Polar night and polar day (Longyearbyen, 78.2 N).
        let winter = Utc.with_ymd_and_hms(2026, 12, 21, 12, 0, 0).unwrap();
        let summer = Utc.with_ymd_and_hms(2026, 6, 21, 0, 0, 0).unwrap();
        assert!(!is_day("cloudy", 78.22, 15.65, winter));
        assert!(is_day("cloudy", 78.22, 15.65, summer));
        // The same Sun math reproduces every `_day` / `_night` suffix MET
        // Norway sent in both fixtures (judged mid-hour), on 58 hourly steps.
        let mut checked = 0;
        for (fx, (lat, lon)) in [(singapore_fixture(), SG), (oslo_fixture(), OSLO)] {
            for entry in fx["response"]["properties"]["timeseries"]
                .as_array()
                .unwrap()
            {
                let symbol = entry
                    .pointer("/data/next_1_hours/summary/symbol_code")
                    .and_then(Value::as_str);
                let Some(want) = symbol.and_then(symbol_is_day) else {
                    continue;
                };
                let t = DateTime::parse_from_rfc3339(entry["time"].as_str().unwrap())
                    .unwrap()
                    .with_timezone(&Utc);
                let sun = sun_elevation_deg(lat, lon, t + Duration::minutes(30)) > -0.833;
                assert_eq!(sun, want, "{} {symbol:?}", entry["time"]);
                checked += 1;
            }
        }
        assert_eq!(checked, 58);
    }

    #[test]
    fn station_pressure_is_sea_level_pressure_reduced_to_the_height_of_the_point() {
        assert!((surface_pressure_hpa(1013.25, 15.0, 0.0) - 1013.25).abs() < 1e-9);
        // Harare, 1490 m, 20 C, sea-level 1000 hPa: about 843 hPa (worked by
        // hand: (1 - 9.685 / 302.835) ^ 5.257 = 0.84293).
        let p = surface_pressure_hpa(1000.0, 20.0, 1490.0);
        assert!((p - 842.93).abs() < 0.01, "{p}");
    }

    // ---- the Singapore forecast (hand-checked against the raw fixture) ----

    #[test]
    fn the_hourly_block_is_the_leading_hourly_run_in_the_place_wall_clock() {
        let p = singapore();
        let times = p["hourly"]["time"].as_array().unwrap();
        // 14:00Z on 2 Nov to 05:00Z on 5 Nov, hourly; the step at 06:00Z
        // covers six hours and starts the 6-hourly part.
        assert_eq!(times.len(), 64);
        assert_eq!(times[0], "2026-11-02T22:00");
        assert_eq!(times[63], "2026-11-05T13:00");
        for var in [
            "temperature_2m",
            "relative_humidity_2m",
            "apparent_temperature",
            "precipitation_probability",
            "precipitation",
            "weather_code",
            "wind_speed_10m",
            "wind_direction_10m",
            "wind_gusts_10m",
            "surface_pressure",
            "cloud_cover",
            "uv_index",
            "visibility",
            "is_day",
            "dew_point_2m",
        ] {
            assert_eq!(p["hourly"][var].as_array().unwrap().len(), 64, "{var}");
        }
        assert_eq!(p["utc_offset_seconds"], 28800);
        assert_eq!(p["timezone"], "Asia/Singapore");
        assert!(p.get("utc_offset_estimated").is_none());
        // MET Norway's own terrain height for the point.
        assert_eq!(p["elevation"], 17.0);
    }

    #[test]
    fn hourly_values_are_converted_to_our_units() {
        let h = &singapore()["hourly"];
        // Entry 0 (14:00Z): air_temperature 25.0, relative_humidity 99.5,
        // apparent 25.0, wind_speed 1.6 m/s, wind_from_direction 210.3,
        // pressure 1013.7 hPa at sea level, cloud 100, UV 0.0, dew 24.9, symbol
        // `fog`, precipitation 0.0.
        assert_eq!(h["temperature_2m"][0], 25.0);
        assert_eq!(h["relative_humidity_2m"][0], 100);
        assert_eq!(h["apparent_temperature"][0], 25.0);
        assert_eq!(h["wind_speed_10m"][0], 5.8, "1.6 m/s = 5.76 km/h");
        assert_eq!(h["wind_direction_10m"][0], 210);
        // 1013.7 * (1 - 0.0065*17 / (25 + 0.0065*17 + 273.15)) ^ 5.257 = 1011.73
        assert_eq!(h["surface_pressure"][0], 1011.7);
        assert_eq!(h["cloud_cover"][0], 100);
        assert_eq!(h["uv_index"][0], 0.0);
        assert_eq!(h["dew_point_2m"][0], 24.9);
        assert_eq!(h["weather_code"][0], 45);
        assert_eq!(h["precipitation"][0], 0.0);
        // `fog` has no day/night suffix and it is 22:00 there.
        assert_eq!(h["is_day"][0], 0);
        // Entry 10 (00:00Z on 3 Nov = 08:00 local): fog again, but daylight.
        assert_eq!(h["time"][10], "2026-11-03T08:00");
        assert_eq!(h["is_day"][10], 1);
        assert_eq!(h["relative_humidity_2m"][10], 99);
        assert_eq!(h["uv_index"][10], 0.8);
        assert_eq!(h["surface_pressure"][10], 1010.5);
        // Entry 20 (10:00Z = 18:00 local): `lightrainshowers_day`, 0.2 mm.
        assert_eq!(h["time"][20], "2026-11-03T18:00");
        assert_eq!(h["weather_code"][20], 80);
        assert_eq!(h["is_day"][20], 1);
        assert_eq!(h["precipitation"][20], 0.2);
        assert_eq!(h["temperature_2m"][20], 29.2);
        assert_eq!(h["apparent_temperature"][20], 33.4);
        assert_eq!(h["wind_speed_10m"][20], 11.9);
        assert_eq!(h["wind_direction_10m"][20], 110);
        // Entry 63 (05:00Z on 5 Nov): `heavyrain`, 6.4 mm.
        assert_eq!(h["weather_code"][63], 65);
        assert_eq!(h["precipitation"][63], 6.4);
    }

    #[test]
    fn what_this_provider_does_not_publish_stays_null() {
        let p = singapore();
        let h = &p["hourly"];
        // Singapore is outside the Nordic domain: no gusts, no rain
        // probability. Visibility is published nowhere.
        for var in ["wind_gusts_10m", "precipitation_probability", "visibility"] {
            assert!(
                h[var].as_array().unwrap().iter().all(Value::is_null),
                "{var}"
            );
        }
        assert!(p["daily"]["wind_gusts_10m_max"][0].is_null());
        assert!(p["daily"]["precipitation_probability_max"][0].is_null());
        // No evapotranspiration, CAPE or lifted index at all.
        assert!(p["daily"].get("et0_fao_evapotranspiration").is_none());
        assert!(h.get("cape").is_none() && h.get("lifted_index").is_none());
    }

    #[test]
    fn daily_values_come_from_the_hourly_steps_then_the_six_hour_windows() {
        let d = &singapore()["daily"];
        let days = d["time"].as_array().unwrap();
        assert_eq!(days.len(), 7);
        assert_eq!(days[0], "2026-11-02");
        assert_eq!(days[6], "2026-11-08");
        // 2 Nov: only 22:00 and 23:00 local are still ahead, so the "day" is
        // those two hours: temperatures 25.0 and 24.7, fog, no rain, UV 0.
        assert_eq!(d["temperature_2m_max"][0], 25.0);
        assert_eq!(d["temperature_2m_min"][0], 24.7);
        assert_eq!(d["weather_code"][0], 45);
        assert_eq!(d["precipitation_sum"][0], 0.0);
        assert_eq!(d["uv_index_max"][0], 0.0);
        assert_eq!(d["wind_speed_10m_max"][0], 5.8);
        // 3 Nov is a whole local day of hourly steps (16:00Z to 15:00Z): highest
        // temperature 32.4, lowest 23.2, feels-like 37.1 / 23.2, 3.4 mm of rain,
        // the worst condition `rainshowers` (81), strongest wind 15.8 km/h and a
        // clear-sky UV maximum of 10.7.
        assert_eq!(d["time"][1], "2026-11-03");
        assert_eq!(d["temperature_2m_max"][1], 32.4);
        assert_eq!(d["temperature_2m_min"][1], 23.2);
        assert_eq!(d["apparent_temperature_max"][1], 37.1);
        assert_eq!(d["apparent_temperature_min"][1], 23.2);
        assert_eq!(d["precipitation_sum"][1], 3.4);
        assert_eq!(d["weather_code"][1], 81);
        assert_eq!(d["wind_speed_10m_max"][1], 15.8);
        assert_eq!(d["uv_index_max"][1], 10.7);
        assert_eq!(d["wind_direction_10m_dominant"][1], 67);
        // 6 Nov is four 6-hour windows (raw: 18:00Z next_6_hours max 23.3 min
        // 22.6 / 00:00Z max 30.3 min 23.3, 1.4 mm / 06:00Z max 29.4, 10.0 mm
        // `heavyrain` / 12:00Z max 23.5 min 23.1): extremes come from the
        // windows, rain adds up to 11.4 mm, the worst condition is heavy rain.
        assert_eq!(d["time"][4], "2026-11-06");
        assert_eq!(d["temperature_2m_max"][4], 30.3);
        assert_eq!(d["temperature_2m_min"][4], 22.6);
        assert_eq!(d["apparent_temperature_max"][4], 33.3);
        assert_eq!(d["apparent_temperature_min"][4], 23.1);
        assert_eq!(d["precipitation_sum"][4], 11.4);
        assert_eq!(d["weather_code"][4], 65);
        assert_eq!(d["wind_speed_10m_max"][4], 6.1, "1.7 m/s");
        // The instants of 6-hourly steps carry no UV in this response.
        assert!(d["uv_index_max"][4].is_null());
        // Every day has the same number of values in every array.
        for (key, values) in d.as_object().unwrap() {
            assert_eq!(values.as_array().unwrap().len(), 7, "{key}");
        }
    }

    #[test]
    fn sunrise_and_sunset_are_computed_for_the_place_not_taken_from_the_provider() {
        let d = &singapore()["daily"];
        // Independent NOAA computation for 1.444 N, 103.824 E at UTC+8.
        assert_eq!(d["sunrise"][0], "2026-11-02T06:46");
        assert_eq!(d["sunset"][0], "2026-11-02T18:50");
        assert_eq!(d["sunrise"][6], "2026-11-08T06:46");
        assert_eq!(d["sunset"][6], "2026-11-08T18:50");
    }

    #[test]
    fn without_a_hint_the_offset_is_estimated_from_longitude_and_says_so() {
        let p = convert(&singapore_fixture()["response"], SG.0, SG.1, None).unwrap();
        // 103.824 E is 6.92 hours of sun time: 7 hours, though the place keeps
        // UTC+8. The values are right for their instants; only the wall-clock
        // labels carry the error, and the payload is marked.
        assert_eq!(p["utc_offset_seconds"], 25200);
        assert_eq!(p["utc_offset_estimated"], true);
        assert!(p.get("timezone").is_none());
        assert_eq!(p["hourly"]["time"][0], "2026-11-02T21:00");
        assert_eq!(p["hourly"]["temperature_2m"][0], 25.0);
        // A borrowed offset is an estimate too.
        let borrowed = OffsetHint {
            seconds: 28800,
            timezone: None,
            estimated: true,
        };
        let p = convert(
            &singapore_fixture()["response"],
            SG.0,
            SG.1,
            Some(&borrowed),
        )
        .unwrap();
        assert_eq!(p["utc_offset_estimated"], true);
        assert_eq!(p["hourly"]["time"][0], "2026-11-02T22:00");
    }

    #[test]
    fn the_baseline_says_where_the_forecast_came_from_and_what_it_is_not() {
        let b = &singapore()["baseline"];
        assert_eq!(b["provider"], "met-no");
        assert_eq!(b["blend"], false);
        assert_eq!(b["reason"], "failover");
        assert_eq!(b["source"], "MET Norway");
        assert_eq!(b["license"], "CC BY 4.0");
        assert_eq!(b["uvIndex"], "clear-sky");
        assert_eq!(b["updatedAt"], "2026-11-02T13:17:21Z");
        // Today's values start with the first step: no past hours exist.
        assert_eq!(b["coversFrom"], "2026-11-02T22:00");
        assert!(ATTRIBUTION.contains("MET Norway") && ATTRIBUTION.contains("CC BY 4.0"));
        assert!(
            ATTRIBUTION.contains("converted"),
            "the licence asks for a note of changes"
        );
    }

    // ---- the Oslo forecast: the Nordic fields ---------------------------

    #[test]
    fn inside_the_nordic_domain_gusts_and_rain_probability_are_kept() {
        let p = oslo();
        let h = &p["hourly"];
        assert_eq!(h["time"].as_array().unwrap().len(), 36);
        assert_eq!(h["time"][0], "2026-11-02T15:00");
        // Raw entry 0: temperature 9.6, humidity 57.6, wind 1.8 m/s from 1.0,
        // gust 3.6 m/s, pressure 1035.6 hPa at sea level (5 m), cloud 1, UV
        // 0.1, dew point 1.8, `clearsky_day`, probability of precipitation 0.
        assert_eq!(h["temperature_2m"][0], 9.6);
        assert_eq!(h["relative_humidity_2m"][0], 58);
        assert_eq!(h["wind_speed_10m"][0], 6.5, "1.8 m/s = 6.48 km/h");
        assert_eq!(h["wind_gusts_10m"][0], 13.0, "3.6 m/s = 12.96 km/h");
        assert_eq!(h["wind_direction_10m"][0], 1);
        assert_eq!(h["surface_pressure"][0], 1035.0);
        assert_eq!(h["cloud_cover"][0], 1);
        assert_eq!(h["uv_index"][0], 0.1);
        assert_eq!(h["dew_point_2m"][0], 1.8);
        assert_eq!(h["weather_code"][0], 0);
        assert_eq!(h["is_day"][0], 1);
        assert_eq!(h["precipitation_probability"][0], 0);
        assert_eq!(p["elevation"], 5.0);
        // The suffix says night an hour later.
        assert_eq!(h["is_day"][1], 0);
        // Daily: 2 Nov covers 15:00 to 23:00 local (nine steps).
        let d = &p["daily"];
        assert_eq!(d["time"].as_array().unwrap().len(), 3);
        assert_eq!(d["temperature_2m_max"][0], 9.6);
        assert_eq!(d["temperature_2m_min"][0], 3.6);
        assert_eq!(d["wind_gusts_10m_max"][0], 13.0);
        assert_eq!(d["precipitation_probability_max"][0], 0);
        assert_eq!(d["wind_direction_10m_dominant"][0], 68);
        assert_eq!(d["weather_code"][1], 2);
        assert_eq!(d["temperature_2m_max"][1], 8.0);
        assert_eq!(d["temperature_2m_min"][1], 3.1);
        assert_eq!(d["wind_gusts_10m_max"][1], 7.2);
        assert_eq!(d["uv_index_max"][1], 0.5);
    }

    // ---- serving a converted forecast -----------------------------------

    #[test]
    fn the_current_block_is_the_hourly_step_of_the_places_current_hour() {
        let converted = singapore();
        // 14:30Z is 22:30 local: the 22:00 step.
        let p = finish(&converted, now()).unwrap();
        assert_eq!(p["current"]["time"], "2026-11-02T22:00");
        assert_eq!(p["current"]["temperature_2m"], 25.0);
        assert_eq!(p["current"]["weather_code"], 45);
        assert_eq!(p["current"]["surface_pressure"], 1011.7);
        // Served again later from the same stored forecast (it is kept for its
        // Expires window): 17:10Z is 01:10 local, the 01:00 step (entry 3).
        let later = Utc.with_ymd_and_hms(2026, 11, 2, 17, 10, 0).unwrap();
        let p = finish(&converted, later).unwrap();
        assert_eq!(p["current"]["time"], "2026-11-03T01:00");
        assert_eq!(p["current"]["temperature_2m"], 24.2);
        assert_eq!(p["current"]["wind_speed_10m"], 5.0);
        assert_eq!(p["current"]["wind_direction_10m"], 355);
        // The stored forecast itself is not changed by serving it.
        assert_eq!(converted["current"], json!({}));
    }

    #[test]
    fn a_forecast_that_no_longer_reaches_now_is_not_served() {
        let converted = singapore();
        // The last hourly step is 13:00 local on 5 Nov (05:00Z); its hour ends
        // at 14:00 local = 06:00Z.
        let last = Utc.with_ymd_and_hms(2026, 11, 5, 5, 59, 0).unwrap();
        assert!(finish(&converted, last).is_some());
        let over = Utc.with_ymd_and_hms(2026, 11, 5, 6, 0, 0).unwrap();
        assert!(finish(&converted, over).is_none());
        // Before the first step (a clock a little behind): the first step.
        let early = Utc.with_ymd_and_hms(2026, 11, 2, 13, 50, 0).unwrap();
        assert_eq!(
            finish(&converted, early).unwrap()["current"]["time"],
            "2026-11-02T22:00"
        );
        assert!(finish(&json!({}), now()).is_none());
    }

    #[test]
    fn insights_are_derived_so_the_activity_rules_work() {
        let later = Utc.with_ymd_and_hms(2026, 11, 2, 17, 10, 0).unwrap();
        let p = finish(&singapore(), later).unwrap();
        let i = &p["insights"];
        // From the 01:00 step: wind 5.0 km/h, dew point 24.2, 24.2 C (below
        // 27 C the heat index is the temperature), UV 0.0, fog is not
        // precipitation, no thunder.
        assert_eq!(i["windSpeed"], 5.0);
        assert_eq!(i["dewPoint"], 24.2);
        assert_eq!(i["heatStressIndex"], 24.2);
        assert_eq!(i["uvHealthConcern"], 0.0);
        assert_eq!(i["precipitationType"], 0);
        assert_eq!(i["thunderstormProbability"], 0);
        assert!(i["moonPhase"].is_i64());
        // Cloud base from temperature, dew point and cover (T - Td = 0).
        assert_eq!(i["cloudBase"], 0.0);
        // Visibility and evapotranspiration are not published: not invented.
        assert!(i.get("visibility").is_none());
        assert!(i.get("evapotranspiration").is_none());
        assert!(i.get("windGust").is_none());
        // The intermediate fields are stripped, as for the Open-Meteo baseline.
        assert!(p["hourly"].get("dew_point_2m").is_none());
        assert!(p["minutely"].is_null());
        // Oslo has gusts: they reach the insights.
        let oslo = finish(&oslo(), now()).unwrap();
        assert_eq!(oslo["insights"]["windGust"], 13.0);
    }

    #[test]
    fn the_served_payload_has_the_shape_the_app_and_the_open_meteo_baseline_have() {
        for p in [
            finish(&singapore(), now()).unwrap(),
            finish(&oslo(), now()).unwrap(),
        ] {
            let keys = |v: &Value| -> std::collections::BTreeSet<String> {
                v.as_object().unwrap().keys().cloned().collect()
            };
            let want = |vars: &str, stripped: &[&str]| -> std::collections::BTreeSet<String> {
                std::iter::once("time")
                    .chain(vars.split(',').filter(|v| !stripped.contains(v)))
                    .map(str::to_owned)
                    .collect()
            };
            // Exactly the variables the Open-Meteo baseline serves, so no
            // consumer can find a missing array.
            assert_eq!(
                keys(&p["hourly"]),
                want(blend::HOURLY_VARS, &insights::INTERMEDIATE_HOURLY)
            );
            assert_eq!(
                keys(&p["daily"]),
                want(blend::DAILY_VARS, &insights::INTERMEDIATE_DAILY)
            );
            assert_eq!(keys(&p["current"]), want(blend::CURRENT_VARS, &[]));
            // `isRenderableWeather` in src/lib/home-weather.ts.
            assert!(p["current"]["temperature_2m"].is_number());
            assert!(p["hourly"]["time"].is_array());
            assert!(p["daily"]["time"].is_array());
            assert_eq!(p["current_units"]["wind_speed_10m"], "km/h");
            assert_eq!(p["current_units"]["surface_pressure"], "hPa");
            assert!(p["utc_offset_seconds"].is_i64());
        }
    }

    #[test]
    fn a_response_that_is_not_a_usable_forecast_is_refused() {
        let good = singapore_fixture()["response"].clone();
        assert!(convert(&good, SG.0, SG.1, None).is_some());
        assert!(convert(&json!({}), 0.0, 0.0, None).is_none());
        assert!(convert(&json!(null), 0.0, 0.0, None).is_none());
        // No height for the point: the pressure cannot be reduced.
        let mut no_height = good.clone();
        no_height["geometry"]["coordinates"] = json!([103.824, 1.444]);
        assert!(convert(&no_height, SG.0, SG.1, None).is_none());
        // Too few hourly steps to be worth serving.
        let mut short = good.clone();
        let series = short["properties"]["timeseries"].as_array().unwrap()[..10].to_vec();
        short["properties"]["timeseries"] = Value::Array(series);
        assert!(convert(&short, SG.0, SG.1, None).is_none());
        // A series with no hourly steps at all (only 6-hourly windows).
        let mut six = good;
        let series = six["properties"]["timeseries"].as_array().unwrap()[64..].to_vec();
        six["properties"]["timeseries"] = Value::Array(series);
        assert!(convert(&six, SG.0, SG.1, None).is_none());
    }

    #[test]
    fn a_gap_in_the_hours_ends_the_hourly_run() {
        let mut raw = singapore_fixture()["response"].clone();
        let series = raw["properties"]["timeseries"].as_array_mut().unwrap();
        // Drop the entry at index 30: the run stops before it.
        series.remove(30);
        let p = convert(&raw, SG.0, SG.1, Some(&singapore_hint())).unwrap();
        assert_eq!(p["hourly"]["time"].as_array().unwrap().len(), 30);
    }

    /// The converted and served forecast of the Singapore fixture, kept as a
    /// golden file so the TypeScript side (`isRenderableWeather`, the
    /// provider rules) is tested on the real shape. Regenerate with
    /// `UPDATE_MET_NO_GOLDEN=1 cargo test -p weather-core met_no` and format
    /// the file with prettier; the hand-checked tests above are what vouch for
    /// the values.
    #[test]
    fn the_served_singapore_forecast_matches_the_golden_file() {
        let served = finish(&singapore(), now()).unwrap();
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../tests/fixtures/met-no-forecast-singapore.json"
        );
        if std::env::var_os("UPDATE_MET_NO_GOLDEN").is_some() {
            let text = serde_json::to_string_pretty(&served).unwrap();
            std::fs::write(path, text + "\n").unwrap();
        }
        let golden: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/met-no-forecast-singapore.json"
        ))
        .unwrap();
        assert_eq!(served, golden);
        assert_eq!(golden["baseline"]["provider"], "met-no");
    }
}
