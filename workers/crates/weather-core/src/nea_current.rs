//! Singapore's `current` conditions from NEA's real-time open data on
//! data.gov.sg (Singapore Open Data Licence v1.0, no key; mukoko-dev/mukoko-weather#596).
//!
//! Open-Meteo's `current` is a model grid-cell value. In Singapore there is no
//! StationKit station, so nothing corrected it: on 2026-11-17 the app showed
//! clear sky in a downpour, and at 23:00 it read 24.0 C, fog and 100 % humidity
//! while NEA's stations read 25.5 to 27.8 C and NEA's own 2-hour forecast said
//! "Cloudy". This module is the DECISION side of the fix; it does no I/O, so it
//! builds for wasm32 and is tested on recorded NEA payloads. The forecast
//! Worker (`workers/forecast/src/sg_nea.rs`) only fetches, caches and calls it.
//!
//! What it overlays on `current`, each field from the nearest official source:
//!
//! - `temperature_2m`, `relative_humidity_2m`, `wind_speed_10m`,
//!   `wind_direction_10m`: the nearest station of that dataset within
//!   [`MAX_STATION_KM`], reading no older than [`MAX_READING_AGE_MS`]. Values go
//!   through the same QC ranges as a StationKit upload (`station::qc_filter`) and
//!   are written by the same merge (`station::station_current`,
//!   `normalize::blend_station_current`). `apparent_temperature` is recomputed
//!   from the observed temperature (Steadman, the formula Open-Meteo uses), and
//!   `wind_gusts_10m` is raised to the observed wind if the model's gust is lighter.
//! - `precipitation`: the latest 5-minute total (mm) of the nearest rain gauge
//!   within [`MAX_GAUGE_KM`]. Rain falls in cells a few kilometres wide, so the
//!   gauge radius is tighter than the station radius.
//! - `weather_code`: NEA's 2-hour forecast phrase for the nearest forecast area
//!   (one table, [`PHRASES`]), raised to a rain, shower or thunderstorm code
//!   when the gauge shows rain now ([`weather_code`]). The model's fog code
//!   never survives an NEA answer that is not fog or mist.
//!
//! Nothing here guesses: a dataset that is missing, stale, junk or too far away
//! leaves that part of `current` as the model had it, and when nothing applies
//! [`apply`] returns `false` and the forecast is served exactly as before.
//!
//! "Inside Singapore" is a bounding box ([`in_singapore`]), cheap enough to run
//! before any fetch so no request outside the island ever touches NEA. The box
//! is generous at its edges (a strip of Johor's shore, Batam's north coast);
//! the distance cut-offs above are what keep those points from being given a
//! Singapore reading: no NEA station or gauge is within them.

use std::collections::BTreeMap;

use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::geo::haversine_km;
use crate::history::apparent_temperature;
use crate::{normalize, station};

/// `current_overlay.source` in the payload, and the client's key for the credit.
pub const SOURCE_ID: &str = "nea";

/// The Singapore Open Data Licence v1.0 asks for a conspicuous notice
/// acknowledging the source with a link to the licence. The client shows this
/// exact wording only when the overlay was used (`src/lib/forecast-sources.ts`
/// pins it to this constant).
pub const ATTRIBUTION: &str = "Contains information from the National Environment Agency's real-time weather datasets accessed from data.gov.sg, which is made available under the terms of the Singapore Open Data Licence version 1.0.";
/// The licence, linked from the credit.
pub const LICENCE_URL: &str = "https://data.gov.sg/open-data-licence";

/// The v2 real-time API (`api-open.data.gov.sg`). The old
/// `api.data.gov.sg/v1/environment/*` still answers but is the legacy host
/// (its rainfall endpoint returned 4 of 87 gauges on 2026-11-17), and
/// `sg_air` already uses this host. Without an API key the limit is 6 calls per
/// 10 seconds, so the Worker makes one refresh (these six calls) at most every
/// [`SNAPSHOT_FRESH_MS`].
pub const AIR_TEMPERATURE_URL: &str =
    "https://api-open.data.gov.sg/v2/real-time/api/air-temperature";
pub const RELATIVE_HUMIDITY_URL: &str =
    "https://api-open.data.gov.sg/v2/real-time/api/relative-humidity";
pub const RAINFALL_URL: &str = "https://api-open.data.gov.sg/v2/real-time/api/rainfall";
pub const WIND_SPEED_URL: &str = "https://api-open.data.gov.sg/v2/real-time/api/wind-speed";
pub const WIND_DIRECTION_URL: &str = "https://api-open.data.gov.sg/v2/real-time/api/wind-direction";
pub const TWO_HOUR_FORECAST_URL: &str =
    "https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast";

/// The KV key of the cached [`Snapshot`].
pub const CACHE_KEY: &str = "sgnea:v1";
/// How long a snapshot is reused before NEA is asked again. NEA's 1-minute
/// readings arrive 2 to 8 minutes late and the rain gauges' 5-minute totals 7
/// to 11 (12 polls on 2026-11-17), so asking more often only spends the
/// 6-calls-per-10-seconds limit.
pub const SNAPSHOT_FRESH_MS: i64 = 2 * 60_000;
/// The KV row outlives its freshness: when NEA fails, the last snapshot is
/// still better than nothing, and every reading in it is age-gated anyway.
pub const CACHE_TTL_SECONDS: u64 = 30 * 60;

/// The nearest station of a dataset must be within this. Singapore has 17 air
/// temperature, humidity and wind stations (about 6.5 km apart); 8 km reaches
/// 99 % of the island (measured against the 47 forecast-area points, 2026-11-17).
pub const MAX_STATION_KM: f64 = 8.0;
/// The nearest rain gauge must be within this. 87 gauges (about 3 km apart):
/// 5 km reaches 97 % of the island, and a gauge farther away says little about
/// whether it is raining here.
pub const MAX_GAUGE_KM: f64 = 5.0;
/// The forecast area (by its label point; NEA publishes no boundaries here).
pub const MAX_AREA_KM: f64 = 10.0;
/// A reading older than this is not "now". The newest reading the API held was
/// 2 to 8 minutes old for the 1-minute datasets and 7 to 11 for the rain gauges
/// (12 polls on 2026-11-17); 20 minutes keeps a missed update or two from
/// switching the overlay off, and stops a stalled feed from standing in for the
/// present.
pub const MAX_READING_AGE_MS: i64 = 20 * 60_000;
/// A reading stamped in the future by more than this is junk (clock skew).
const MAX_FUTURE_MS: i64 = 5 * 60_000;
/// The 2-hour forecast is used from a little before its period starts.
const FORECAST_EARLY_MS: i64 = 5 * 60_000;

/// Singapore's extent with its nearby islands (Tuas, Jurong Island, Semakau,
/// Sentosa, Pulau Ubin and Pulau Tekong): latitude 1.15 to 1.475, longitude
/// 103.58 to 104.085.
const LAT_RANGE: (f64, f64) = (1.15, 1.475);
const LON_RANGE: (f64, f64) = (103.58, 104.085);

/// Whether a point is in Singapore's bounding box. Johor Bahru (1.49 N) and
/// Batam Centre (1.13 N) are outside it; a strip of Johor's shore and Batam's
/// north-east coast are inside, and get nothing from NEA because no station
/// is within the cut-offs of them.
pub fn in_singapore(lat: f64, lon: f64) -> bool {
    lat.is_finite()
        && lon.is_finite()
        && (LAT_RANGE.0..=LAT_RANGE.1).contains(&lat)
        && (LON_RANGE.0..=LON_RANGE.1).contains(&lon)
}

// ---------------------------------------------------------------------------
// The snapshot: what a refresh keeps of NEA's six answers.
// ---------------------------------------------------------------------------

/// One station's latest value of one dataset.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Reading {
    pub station: String,
    pub lat: f64,
    pub lon: f64,
    /// As NEA publishes it: C, %, knots, degrees or mm in 5 minutes.
    pub value: f64,
    /// The reading's own timestamp, ms since the epoch.
    pub at_ms: i64,
}

/// One forecast area's phrase.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Area {
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    pub phrase: String,
}

/// The 2-hour forecast and the period it is valid for.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Forecast {
    pub valid_from_ms: i64,
    pub valid_to_ms: i64,
    pub areas: Vec<Area>,
}

/// Everything the overlay reads, parsed once per refresh and cached whole. A
/// dataset that did not parse is empty (or `None`); the rest still work.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Snapshot {
    /// When the refresh ran, ms since the epoch.
    pub fetched_at_ms: i64,
    pub temperature: Vec<Reading>,
    pub humidity: Vec<Reading>,
    pub wind_speed: Vec<Reading>,
    pub wind_direction: Vec<Reading>,
    pub rainfall: Vec<Reading>,
    pub forecast: Option<Forecast>,
}

impl Snapshot {
    /// Nothing usable in it.
    pub fn is_empty(&self) -> bool {
        self.temperature.is_empty()
            && self.humidity.is_empty()
            && self.wind_speed.is_empty()
            && self.wind_direction.is_empty()
            && self.rainfall.is_empty()
            && self.forecast.is_none()
    }

    /// Within [`SNAPSHOT_FRESH_MS`] of `now_ms`, so NEA need not be asked yet.
    pub fn is_fresh(&self, now_ms: i64) -> bool {
        (-MAX_FUTURE_MS..SNAPSHOT_FRESH_MS).contains(&(now_ms - self.fetched_at_ms))
    }

    /// Keep what an older snapshot had for every dataset this one lacks (one
    /// call out of six failed). The carried readings keep their own timestamps,
    /// so a stale one is still refused when it is read.
    pub fn fill_missing_from(&mut self, older: &Snapshot) {
        let fill = |mine: &mut Vec<Reading>, theirs: &Vec<Reading>| {
            if mine.is_empty() {
                mine.clone_from(theirs);
            }
        };
        fill(&mut self.temperature, &older.temperature);
        fill(&mut self.humidity, &older.humidity);
        fill(&mut self.wind_speed, &older.wind_speed);
        fill(&mut self.wind_direction, &older.wind_direction);
        fill(&mut self.rainfall, &older.rainfall);
        if self.forecast.is_none() {
            self.forecast.clone_from(&older.forecast);
        }
    }
}

fn parse_ms(v: &Value) -> Option<i64> {
    DateTime::parse_from_rfc3339(v.as_str()?)
        .ok()
        .map(|t| t.timestamp_millis())
}

fn number(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.trim().parse::<f64>().ok()))
        .filter(|x| x.is_finite())
}

/// A v2 payload with `code` 0 (or none) and a `data` object.
fn ok(payload: &Value) -> bool {
    payload["code"].as_i64().unwrap_or(0) == 0 && payload["data"].is_object()
}

/// A station dataset (air temperature, humidity, rainfall, wind speed or wind
/// direction) as one latest [`Reading`] per station. Junk gives an empty list.
pub fn parse_readings(payload: &Value) -> Vec<Reading> {
    if !ok(payload) {
        return Vec::new();
    }
    let data = &payload["data"];
    // The newest value per station (a dated query returns several timestamps).
    let mut latest: BTreeMap<&str, (i64, f64)> = BTreeMap::new();
    for group in data["readings"].as_array().into_iter().flatten() {
        let Some(at) = parse_ms(&group["timestamp"]) else {
            continue;
        };
        for item in group["data"].as_array().into_iter().flatten() {
            let (Some(id), Some(value)) = (item["stationId"].as_str(), number(&item["value"]))
            else {
                continue;
            };
            if latest.get(id).is_none_or(|(t, _)| at > *t) {
                latest.insert(id, (at, value));
            }
        }
    }
    data["stations"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| {
            let id = s["id"].as_str()?;
            let (at_ms, value) = *latest.get(id)?;
            Some(Reading {
                station: s["name"].as_str().unwrap_or(id).chars().take(80).collect(),
                lat: number(&s["location"]["latitude"])?,
                lon: number(&s["location"]["longitude"])?,
                value,
                at_ms,
            })
        })
        .collect()
}

/// The 2-hour weather forecast: the newest period and each area's phrase.
pub fn parse_forecast(payload: &Value) -> Option<Forecast> {
    if !ok(payload) {
        return None;
    }
    let data = &payload["data"];
    let (item, valid_from_ms, valid_to_ms) = data["items"]
        .as_array()?
        .iter()
        .filter_map(|i| {
            Some((
                i,
                parse_ms(&i["valid_period"]["start"])?,
                parse_ms(&i["valid_period"]["end"])?,
            ))
        })
        .max_by_key(|(_, _, to)| *to)?;
    let points: BTreeMap<&str, (f64, f64)> = data["area_metadata"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| {
            Some((
                a["name"].as_str()?,
                (
                    number(&a["label_location"]["latitude"])?,
                    number(&a["label_location"]["longitude"])?,
                ),
            ))
        })
        .collect();
    let areas: Vec<Area> = item["forecasts"]
        .as_array()?
        .iter()
        .filter_map(|f| {
            let name = f["area"].as_str()?;
            let phrase = f["forecast"].as_str()?.trim();
            let (lat, lon) = *points.get(name)?;
            (!phrase.is_empty()).then(|| Area {
                name: name.chars().take(80).collect(),
                lat,
                lon,
                phrase: phrase.chars().take(80).collect(),
            })
        })
        .collect();
    (!areas.is_empty()).then_some(Forecast {
        valid_from_ms,
        valid_to_ms,
        areas,
    })
}

// ---------------------------------------------------------------------------
// The sky: NEA's phrases as WMO codes.
// ---------------------------------------------------------------------------

/// Every phrase NEA publishes in the 2-hour forecast (the data.gov.sg dataset
/// "2-hour Weather Forecast", API spec v1.0.11, checked 2026-11-17) and the WMO
/// 4677 code the app shows for it. THE one table.
///
/// `None` is a phrase that says nothing about cloud or rain (haze is
/// visibility, windy is wind): it leaves the model's code alone. Fair is "mainly
/// clear" (1) and not "clear sky" (0): NEA keeps "Fair" for few to scattered
/// cloud. "Mist" is shown as fog (45), the nearest code the app has. NEA's
/// thundery phrases are all 95: the app labels 96 and 99 as hail, which NEA
/// does not forecast. Showers are 80 (light, passing) and 81 (showers, heavy
/// showers); how hard it is raining here comes from the gauge ([`weather_code`]).
pub const PHRASES: [(&str, Option<i64>); 23] = [
    ("Fair", Some(1)),
    ("Fair (Day)", Some(1)),
    ("Fair (Night)", Some(1)),
    ("Fair and Warm", Some(1)),
    ("Partly Cloudy", Some(2)),
    ("Partly Cloudy (Day)", Some(2)),
    ("Partly Cloudy (Night)", Some(2)),
    ("Cloudy", Some(3)),
    ("Hazy", None),
    ("Slightly Hazy", None),
    ("Windy", None),
    ("Mist", Some(45)),
    ("Fog", Some(45)),
    ("Light Rain", Some(61)),
    ("Moderate Rain", Some(63)),
    ("Heavy Rain", Some(65)),
    ("Passing Showers", Some(80)),
    ("Light Showers", Some(80)),
    ("Showers", Some(81)),
    ("Heavy Showers", Some(81)),
    ("Thundery Showers", Some(95)),
    ("Heavy Thundery Showers", Some(95)),
    ("Heavy Thundery Showers with Gusty Winds", Some(95)),
];

/// What a phrase says about the sky.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sky {
    /// A WMO code.
    Code(i64),
    /// A phrase NEA publishes that does not describe cloud or rain.
    NotStated,
    /// Not in [`PHRASES`] (or no phrase at all): the model's code stands.
    Unknown,
}

/// Case, spacing and `&` do not matter ("Fair & Warm" is "Fair and Warm").
fn normalise(phrase: &str) -> String {
    phrase
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
        .replace('&', "and")
}

/// [`PHRASES`] looked up; never panics, and never guesses at an unknown phrase.
pub fn sky_for_phrase(phrase: &str) -> Sky {
    let wanted = normalise(phrase);
    PHRASES
        .iter()
        .find(|(p, _)| normalise(p) == wanted)
        .map_or(Sky::Unknown, |(_, code)| {
            code.map_or(Sky::NotStated, Sky::Code)
        })
}

/// WMO rain intensity from a rate in mm/h: slight under 2.5, moderate under
/// 7.6, heavy under 50, violent from 50.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Intensity {
    Slight,
    Moderate,
    Heavy,
    Violent,
}

/// The intensity of a gauge's 5-minute total in mm, or `None` when it is dry
/// (or not a number). The gauges tip at 0.2 mm, which is 2.4 mm/h.
pub fn rain_intensity(five_minute_mm: f64) -> Option<Intensity> {
    if !five_minute_mm.is_finite() || five_minute_mm <= 0.0 {
        return None;
    }
    let rate = five_minute_mm * 12.0;
    Some(if rate < 2.5 {
        Intensity::Slight
    } else if rate < 7.6 {
        Intensity::Moderate
    } else if rate < 50.0 {
        Intensity::Heavy
    } else {
        Intensity::Violent
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Family {
    Rain,
    Shower,
    Thunder,
}

fn family(code: Option<i64>) -> Family {
    match code {
        Some(95..=99) => Family::Thunder,
        Some(80..=82) => Family::Shower,
        _ => Family::Rain,
    }
}

/// The code for rain at the gauge, in the family NEA's phrase chose (the
/// tropics' rain is mostly showers and storms; a gauge under a "Cloudy" phrase
/// gets plain rain).
fn rain_code(intensity: Intensity, family: Family) -> i64 {
    match (family, intensity) {
        (Family::Thunder, _) => 95,
        (Family::Shower, Intensity::Slight) => 80,
        (Family::Shower, Intensity::Moderate | Intensity::Heavy) => 81,
        (Family::Shower, Intensity::Violent) => 82,
        (Family::Rain, Intensity::Slight) => 61,
        (Family::Rain, Intensity::Moderate) => 63,
        (Family::Rain, Intensity::Heavy | Intensity::Violent) => 65,
    }
}

/// How bad a WMO code is, for choosing the stronger of two.
fn severity(code: i64) -> u8 {
    match code {
        0 => 0,
        1 => 1,
        2 => 2,
        3 => 3,
        45 | 48 => 4,
        51 => 10,
        53 => 11,
        55 => 12,
        61 => 20,
        80 => 21,
        63 => 22,
        81 => 23,
        65 => 24,
        82 => 25,
        95 => 30,
        96 => 31,
        99 => 32,
        _ => 0,
    }
}

fn stronger(a: i64, b: i64) -> i64 {
    if severity(b) > severity(a) {
        b
    } else {
        a
    }
}

/// The `weather_code` to serve, or `None` to leave the model's.
///
/// - NEA's phrase for the area is the sky (a code, or nothing to say).
/// - A gauge that shows rain now lifts it to a rain, shower or thunderstorm
///   code of that intensity, never below what NEA's phrase already said. So
///   "Cloudy" over a gauge reading 9 mm in 5 minutes is heavy rain, and "Heavy
///   Thundery Showers" is a thunderstorm whatever the gauge reads.
/// - A dry gauge never removes a phrase's rain: NEA's forecast covers the area,
///   the gauge one point in it.
/// - The model's fog (45, 48) is dropped whenever NEA answered with anything
///   but fog or mist: overcast (3) when the phrase has no sky of its own. An
///   unknown phrase changes nothing.
pub fn weather_code(model_code: Option<i64>, sky: Sky, gauge_mm: Option<f64>) -> Option<i64> {
    let phrase = match sky {
        Sky::Code(c) => Some(c),
        _ => None,
    };
    let rain = gauge_mm
        .and_then(rain_intensity)
        .map(|i| rain_code(i, family(phrase)));
    match (rain, phrase) {
        (Some(r), Some(p)) => Some(stronger(r, p)),
        (Some(r), None) => Some(r),
        (None, Some(p)) => Some(p),
        (None, None) => (sky == Sky::NotStated && matches!(model_code, Some(45 | 48))).then_some(3),
    }
}

// ---------------------------------------------------------------------------
// Choosing the readings.
// ---------------------------------------------------------------------------

/// A reading is "now" when it is not older than [`MAX_READING_AGE_MS`] and not
/// from the future.
fn is_current(at_ms: i64, now_ms: i64) -> bool {
    (-MAX_FUTURE_MS..=MAX_READING_AGE_MS).contains(&(now_ms - at_ms))
}

/// The nearest current reading within `max_km`, and its distance. A nearer
/// station with a stale reading is skipped for a farther one that is current.
pub fn nearest_reading(
    readings: &[Reading],
    lat: f64,
    lon: f64,
    now_ms: i64,
    max_km: f64,
) -> Option<(&Reading, f64)> {
    readings
        .iter()
        .filter(|r| is_current(r.at_ms, now_ms))
        .map(|r| (r, haversine_km(lat, lon, r.lat, r.lon)))
        .filter(|(_, d)| *d <= max_km)
        .min_by(|a, b| {
            a.1.total_cmp(&b.1)
                .then_with(|| a.0.station.cmp(&b.0.station))
        })
}

/// The forecast area whose label point is nearest, while its period is on.
fn nearest_area(f: &Forecast, lat: f64, lon: f64, now_ms: i64) -> Option<(&Area, f64)> {
    if now_ms < f.valid_from_ms - FORECAST_EARLY_MS || now_ms > f.valid_to_ms {
        return None;
    }
    f.areas
        .iter()
        .map(|a| (a, haversine_km(lat, lon, a.lat, a.lon)))
        .filter(|(_, d)| *d <= MAX_AREA_KM)
        .min_by(|a, b| a.1.total_cmp(&b.1).then_with(|| a.0.name.cmp(&b.0.name)))
}

fn knots_to_kph(knots: f64) -> f64 {
    knots * 1.852
}

fn rfc3339(ms: i64) -> Option<String> {
    DateTime::from_timestamp_millis(ms)
        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

fn km(d: f64) -> f64 {
    (d * 10.0).round() / 10.0
}

// ---------------------------------------------------------------------------
// The overlay.
// ---------------------------------------------------------------------------

/// What [`overlay`] decided: the fields to merge into `current` and where each
/// came from.
#[derive(Debug, Clone, PartialEq)]
pub struct Overlay {
    /// Merged with `normalize::blend_station_current`; null fields erase nothing.
    pub current: Value,
    /// The payload's `current_overlay` block.
    pub provenance: Value,
}

/// Decide the overlay for a point, or `None` when NEA has nothing usable for
/// it. `model_current` is the forecast's own `current`: it supplies the
/// humidity and wind for the apparent temperature when NEA has only one of them,
/// and the model's `weather_code`.
pub fn overlay(
    snapshot: &Snapshot,
    lat: f64,
    lon: f64,
    now_ms: i64,
    model_current: &Value,
) -> Option<Overlay> {
    if !in_singapore(lat, lon) {
        return None;
    }
    let temperature = nearest_reading(&snapshot.temperature, lat, lon, now_ms, MAX_STATION_KM);
    let humidity = nearest_reading(&snapshot.humidity, lat, lon, now_ms, MAX_STATION_KM);
    let wind_speed = nearest_reading(&snapshot.wind_speed, lat, lon, now_ms, MAX_STATION_KM);
    let wind_direction =
        nearest_reading(&snapshot.wind_direction, lat, lon, now_ms, MAX_STATION_KM);
    let rainfall = nearest_reading(&snapshot.rainfall, lat, lon, now_ms, MAX_GAUGE_KM);
    let area = snapshot
        .forecast
        .as_ref()
        .and_then(|f| nearest_area(f, lat, lon, now_ms).map(|(a, d)| (a, d, f.valid_to_ms)));

    // The measured fields, through the StationKit QC ranges.
    type Measured<'a> = (
        &'static str,
        &'static str,
        Option<(&'a Reading, f64)>,
        fn(f64) -> f64,
    );
    let measured: [Measured; 5] = [
        (
            "airTemperatureCelsius",
            "temperature_2m",
            temperature,
            |v| v,
        ),
        (
            "relativeHumidityPercent",
            "relative_humidity_2m",
            humidity,
            |v| v,
        ),
        ("windSpeedKph", "wind_speed_10m", wind_speed, knots_to_kph),
        (
            "windDirectionDegrees",
            "wind_direction_10m",
            wind_direction,
            |v| v,
        ),
        ("precipitationMillimeters", "precipitation", rainfall, |v| v),
    ];
    let mut metrics = station::Metrics::new();
    let mut used: Vec<(&'static str, &'static str, &Reading, f64)> = Vec::new();
    for (metric, field, hit, convert) in measured {
        if let Some((r, d)) = hit {
            metrics.insert(metric, Some(convert(r.value)));
            used.push((metric, field, r, d));
        }
    }
    let kept = station::qc_filter(&metrics);
    used.retain(|(metric, ..)| kept.contains_key(metric));

    // The sky and the rain code.
    let sky = area.map_or(Sky::Unknown, |(a, ..)| sky_for_phrase(&a.phrase));
    let model_code = model_current["weather_code"]
        .as_f64()
        .filter(|c| c.is_finite())
        .map(|c| c.round() as i64);
    let code = weather_code(
        model_code,
        sky,
        kept.get("precipitationMillimeters").copied(),
    );

    // Nothing measured and no code: NEA has nothing for this point.
    if kept.is_empty() && code.is_none() {
        return None;
    }

    let mut current = if let Some(observed_ms) = used.iter().map(|(_, _, r, _)| r.at_ms).max() {
        let measured: Map<String, Value> = kept
            .iter()
            .map(|(k, v)| ((*k).to_owned(), json!(v)))
            .collect();
        station::station_current(&measured, &rfc3339(observed_ms)?)
    } else {
        json!({})
    };
    if let Some(code) = code {
        current["weather_code"] = json!(code);
    }
    // "Feels like" follows the observed temperature, with the observed humidity
    // and wind where NEA has them and the model's where it has not.
    if let Some(t) = kept.get("airTemperatureCelsius") {
        let rh = kept
            .get("relativeHumidityPercent")
            .copied()
            .or_else(|| model_current["relative_humidity_2m"].as_f64());
        let wind = kept
            .get("windSpeedKph")
            .copied()
            .or_else(|| model_current["wind_speed_10m"].as_f64());
        if let Some(a) = apparent_temperature(Some(*t), rh, wind) {
            current["apparent_temperature"] = json!(a);
        }
    }
    // A gust is never lighter than the mean wind: the model's gust stands
    // unless the observed wind is already above it.
    if let (Some(wind), Some(gust)) = (
        kept.get("windSpeedKph"),
        model_current["wind_gusts_10m"].as_f64(),
    ) {
        if gust < *wind {
            current["wind_gusts_10m"] = json!(wind);
        }
    }

    let mut fields = Map::new();
    for (_, field, r, d) in &used {
        fields.insert(
            (*field).to_owned(),
            json!({
                "station": r.station,
                "distanceKm": km(*d),
                "observedAt": rfc3339(r.at_ms),
            }),
        );
    }
    let sky_info = area.map(|(a, d, valid_to)| {
        json!({
            "area": a.name,
            "distanceKm": km(d),
            "phrase": a.phrase,
            "validUntil": rfc3339(valid_to),
        })
    });
    let provenance = json!({
        "source": SOURCE_ID,
        "attribution": ATTRIBUTION,
        "licenceUrl": LICENCE_URL,
        "observedAt": used.iter().map(|(_, _, r, _)| r.at_ms).max().and_then(rfc3339),
        "fields": fields,
        "sky": sky_info,
        "weatherCode": code,
    });
    Some(Overlay {
        current,
        provenance,
    })
}

/// Overlay NEA's observations onto a forecast payload: `data["current"]` gets
/// the fields of [`overlay`], and `data["current_overlay"]` says where they
/// came from (the client shows the licence credit only when it is there).
/// Returns whether anything was applied; `false` leaves `data` untouched.
pub fn apply(data: &mut Value, snapshot: &Snapshot, lat: f64, lon: f64, now_ms: i64) -> bool {
    if !data.is_object() {
        return false;
    }
    let Some(o) = overlay(snapshot, lat, lon, now_ms, &data["current"]) else {
        return false;
    };
    normalize::blend_station_current(data, &o.current);
    if let Some(root) = data.as_object_mut() {
        root.insert("current_overlay".to_owned(), o.provenance);
    }
    true
}

#[cfg(test)]
mod tests;
