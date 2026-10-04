//! Provider requests and responses, normalised to the app's `WeatherData`
//! shape (`current`, `hourly`, `daily`, `current_units`, `insights`, and the
//! optional `minutely`/`models` extras).
//!
//! Ported from `api/py/_weather.py`. The shape is unchanged so the app can
//! switch from `/api/py/weather` to the Worker without touching a component.

use chrono::{DateTime, Datelike, Duration, FixedOffset, Timelike, Utc};
use serde_json::{json, Map, Value};

use crate::wmo::tomorrow_to_wmo;

pub const TOMORROW_FORECAST_URL: &str = "https://api.tomorrow.io/v4/weather/forecast";
pub const OPEN_METEO_FORECAST_URL: &str = "https://api.open-meteo.com/v1/forecast";

/// Open-Meteo models compared by default (Windy-style).
pub const DEFAULT_FORECAST_MODELS: [&str; 3] = ["gfs_seamless", "ecmwf_ifs04", "icon_seamless"];
/// Models we forward to Open-Meteo; anything else a caller sends is dropped.
pub const KNOWN_FORECAST_MODELS: [&str; 5] = [
    "best_match",
    "gfs_seamless",
    "ecmwf_ifs04",
    "icon_seamless",
    "meteofrance_seamless",
];

const OPEN_METEO_CURRENT: &str = "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,surface_pressure,cloud_cover,uv_index,is_day";
const OPEN_METEO_HOURLY: &str = "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,surface_pressure,cloud_cover,uv_index,visibility,is_day";
const OPEN_METEO_DAILY: &str = "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,sunrise,sunset,uv_index_max,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant";

/// Units of the `current` block, the same for every provider.
pub fn current_units() -> Value {
    json!({
        "temperature_2m": "°C",
        "relative_humidity_2m": "%",
        "apparent_temperature": "°C",
        "precipitation": "mm",
        "wind_speed_10m": "km/h",
        "wind_gusts_10m": "km/h",
        "uv_index": "",
        "surface_pressure": "hPa",
        "cloud_cover": "%",
    })
}

fn query_string(pairs: &[(&str, String)]) -> String {
    let mut out = String::new();
    for (i, (k, v)) in pairs.iter().enumerate() {
        if i > 0 {
            out.push('&');
        }
        out.push_str(k);
        out.push('=');
        out.push_str(&encode(v));
    }
    out
}

/// Percent-encode a query value (RFC 3986 unreserved characters kept, plus
/// `,` which every provider reads as a list separator).
fn encode(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    for b in v.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b',' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// The Tomorrow.io forecast URL. It carries the API key, so it must never be
/// logged.
pub fn tomorrow_url(lat: f64, lon: f64, api_key: &str) -> String {
    format!(
        "{TOMORROW_FORECAST_URL}?{}",
        query_string(&[
            ("location", format!("{lat},{lon}")),
            ("apikey", api_key.to_owned()),
            ("timesteps", "1h,1d".into()),
            ("units", "metric".into()),
        ])
    )
}

/// The Open-Meteo forecast URL (keyless), 7 days with the next-hour nowcast.
pub fn open_meteo_url(lat: f64, lon: f64) -> String {
    format!(
        "{OPEN_METEO_FORECAST_URL}?{}",
        query_string(&[
            ("latitude", lat.to_string()),
            ("longitude", lon.to_string()),
            ("current", OPEN_METEO_CURRENT.into()),
            ("hourly", OPEN_METEO_HOURLY.into()),
            ("daily", OPEN_METEO_DAILY.into()),
            ("minutely_15", "precipitation".into()),
            ("forecast_minutely_15", "4".into()),
            ("timezone", "auto".into()),
            ("forecast_days", "7".into()),
        ])
    )
}

/// Keep only known models, without duplicates or `best_match` (Open-Meteo
/// always returns that unsuffixed). Falls back to the default set.
pub fn sanitize_models(models: &[&str]) -> Vec<String> {
    let mut cleaned: Vec<String> = Vec::new();
    for m in models.iter().map(|m| m.trim()) {
        if KNOWN_FORECAST_MODELS.contains(&m)
            && m != "best_match"
            && !cleaned.iter().any(|c| c == m)
        {
            cleaned.push(m.to_owned());
        }
    }
    if cleaned.is_empty() {
        DEFAULT_FORECAST_MODELS
            .iter()
            .map(|m| (*m).to_owned())
            .collect()
    } else {
        cleaned
    }
}

/// The Open-Meteo URL for the multi-model comparison and nowcast extras.
pub fn open_meteo_extras_url(lat: f64, lon: f64, models: &[String]) -> String {
    format!(
        "{OPEN_METEO_FORECAST_URL}?{}",
        query_string(&[
            ("latitude", lat.to_string()),
            ("longitude", lon.to_string()),
            ("hourly", "temperature_2m,precipitation".into()),
            ("models", models.join(",")),
            ("minutely_15", "precipitation".into()),
            ("forecast_minutely_15", "4".into()),
            ("timezone", "auto".into()),
            ("forecast_days", "2".into()),
        ])
    )
}

fn parse_time(s: &str) -> Option<DateTime<FixedOffset>> {
    DateTime::parse_from_rfc3339(s).ok()
}

/// Whether an hour is daytime, from the daily sunrise and sunset. Tomorrow.io
/// has no `is_day`, so it is derived; a 06:00 to 18:00 rule is the fallback.
fn compute_is_day(time: &str, daily_raw: &[Value]) -> i64 {
    let Some(t) = parse_time(time) else {
        return 1;
    };
    for day in daily_raw {
        let v = &day["values"];
        let (Some(rise), Some(set)) = (
            v["sunriseTime"].as_str().and_then(parse_time),
            v["sunsetTime"].as_str().and_then(parse_time),
        ) else {
            continue;
        };
        if rise <= t && t <= set {
            return 1;
        }
        if (t - rise).num_seconds().abs() < 24 * 3600 {
            return 0;
        }
    }
    i64::from((6..18).contains(&t.hour()))
}

fn opt(v: &Value) -> Value {
    if v.is_null() {
        Value::Null
    } else {
        v.clone()
    }
}

fn or_zero(v: &Value) -> Value {
    if v.is_null() {
        json!(0)
    } else {
        v.clone()
    }
}

fn code(v: &Value) -> Value {
    json!(tomorrow_to_wmo(v.as_i64().unwrap_or(0)))
}

/// Normalise a Tomorrow.io `/v4/weather/forecast` response.
///
/// `current` is `{}` when Tomorrow.io returned no hourly data; callers must
/// treat that as a failure and fall through to Open-Meteo.
pub fn normalize_tomorrow(raw: &Value) -> Value {
    let empty = Vec::new();
    let hourly_raw = raw
        .pointer("/timelines/hourly")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    let daily_raw = raw
        .pointer("/timelines/daily")
        .and_then(Value::as_array)
        .unwrap_or(&empty);

    let mut current = Map::new();
    if let Some(first) = hourly_raw.first() {
        let v = &first["values"];
        let time = first["time"].as_str().unwrap_or("");
        current = json!({
            "time": time,
            "temperature_2m": opt(&v["temperature"]),
            "relative_humidity_2m": opt(&v["humidity"]),
            "apparent_temperature": opt(&v["temperatureApparent"]),
            "precipitation": or_zero(&v["precipitationIntensity"]),
            "weather_code": code(&v["weatherCode"]),
            "wind_speed_10m": opt(&v["windSpeed"]),
            "wind_direction_10m": opt(&v["windDirection"]),
            "wind_gusts_10m": opt(&v["windGust"]),
            "surface_pressure": opt(&v["pressureSurfaceLevel"]),
            "cloud_cover": opt(&v["cloudCover"]),
            "uv_index": opt(&v["uvIndex"]),
            "is_day": compute_is_day(time, daily_raw),
        })
        .as_object()
        .cloned()
        .unwrap_or_default();
    }

    let hourly_keys = [
        "time",
        "temperature_2m",
        "relative_humidity_2m",
        "apparent_temperature",
        "precipitation",
        "precipitation_probability",
        "weather_code",
        "wind_speed_10m",
        "wind_direction_10m",
        "wind_gusts_10m",
        "surface_pressure",
        "cloud_cover",
        "uv_index",
        "visibility",
        "is_day",
    ];
    let mut hourly: Map<String, Value> = hourly_keys
        .iter()
        .map(|k| ((*k).to_owned(), json!([])))
        .collect();
    let push = |m: &mut Map<String, Value>, k: &str, v: Value| {
        if let Some(Value::Array(a)) = m.get_mut(k) {
            a.push(v);
        }
    };
    for h in hourly_raw.iter().take(24) {
        let v = &h["values"];
        let time = h["time"].as_str().unwrap_or("");
        push(&mut hourly, "time", json!(time));
        push(&mut hourly, "temperature_2m", opt(&v["temperature"]));
        push(&mut hourly, "relative_humidity_2m", opt(&v["humidity"]));
        push(
            &mut hourly,
            "apparent_temperature",
            opt(&v["temperatureApparent"]),
        );
        push(
            &mut hourly,
            "precipitation",
            or_zero(&v["precipitationIntensity"]),
        );
        push(
            &mut hourly,
            "precipitation_probability",
            or_zero(&v["precipitationProbability"]),
        );
        push(&mut hourly, "weather_code", code(&v["weatherCode"]));
        push(&mut hourly, "wind_speed_10m", opt(&v["windSpeed"]));
        push(&mut hourly, "wind_direction_10m", opt(&v["windDirection"]));
        push(&mut hourly, "wind_gusts_10m", opt(&v["windGust"]));
        push(
            &mut hourly,
            "surface_pressure",
            opt(&v["pressureSurfaceLevel"]),
        );
        push(&mut hourly, "cloud_cover", opt(&v["cloudCover"]));
        push(&mut hourly, "uv_index", opt(&v["uvIndex"]));
        // Tomorrow.io reports visibility in km; the shared shape uses metres.
        let vis = v["visibility"]
            .as_f64()
            .map(|km| json!(km * 1000.0))
            .unwrap_or(Value::Null);
        push(&mut hourly, "visibility", vis);
        push(
            &mut hourly,
            "is_day",
            json!(compute_is_day(time, daily_raw)),
        );
    }

    let daily_keys: [(&str, &str); 14] = [
        ("time", ""),
        ("weather_code", "weatherCodeMax"),
        ("temperature_2m_max", "temperatureMax"),
        ("temperature_2m_min", "temperatureMin"),
        ("apparent_temperature_max", "temperatureApparentMax"),
        ("apparent_temperature_min", "temperatureApparentMin"),
        ("precipitation_sum", "precipitationIntensityMax"),
        (
            "precipitation_probability_max",
            "precipitationProbabilityMax",
        ),
        ("wind_speed_10m_max", "windSpeedMax"),
        ("wind_gusts_10m_max", "windGustMax"),
        ("wind_direction_10m_dominant", "windDirectionAvg"),
        ("uv_index_max", "uvIndexMax"),
        ("sunrise", "sunriseTime"),
        ("sunset", "sunsetTime"),
    ];
    let mut daily: Map<String, Value> = daily_keys
        .iter()
        .map(|(k, _)| ((*k).to_owned(), json!([])))
        .collect();
    for d in daily_raw.iter().take(7) {
        let v = &d["values"];
        for (key, field) in daily_keys {
            let value = match key {
                "time" => json!(d["time"].as_str().unwrap_or("")),
                "weather_code" => code(&v[field]),
                "precipitation_sum" | "precipitation_probability_max" => or_zero(&v[field]),
                "sunrise" | "sunset" => json!(v[field].as_str().unwrap_or("")),
                _ => opt(&v[field]),
            };
            push(&mut daily, key, value);
        }
    }

    let insights = daily_raw.first().map(|d| {
        let v = &d["values"];
        let pairs = [
            ("heatStressIndex", "heatIndexMax"),
            ("thunderstormProbability", "thunderstormProbability"),
            ("uvHealthConcern", "uvHealthConcernMax"),
            ("visibility", "visibilityAvg"),
            ("windSpeed", "windSpeedMax"),
            ("windGust", "windGustMax"),
            ("dewPoint", "dewPointAvg"),
            ("gdd10To30", "gdd10To30"),
            ("evapotranspiration", "evapotranspirationAvg"),
            ("moonPhase", "moonPhase"),
            ("cloudBase", "cloudBaseAvg"),
            ("cloudCeiling", "cloudCeilingAvg"),
            ("precipitationType", "precipitationTypeMax"),
        ];
        pairs
            .iter()
            .filter(|(_, f)| !v[*f].is_null())
            .map(|(k, f)| ((*k).to_owned(), v[*f].clone()))
            .collect::<Map<String, Value>>()
    });
    let insights = match insights {
        Some(m) if !m.is_empty() => Value::Object(m),
        _ => Value::Null,
    };

    json!({
        "current": current,
        "hourly": hourly,
        "daily": daily,
        "current_units": current_units(),
        "insights": insights,
    })
}

/// The next-hour precipitation nowcast (4 × 15 min) from an Open-Meteo
/// payload, or `null`.
pub fn parse_minutely(data: &Value) -> Value {
    let times = data
        .pointer("/minutely_15/time")
        .and_then(Value::as_array)
        .filter(|t| !t.is_empty());
    let Some(times) = times else {
        return Value::Null;
    };
    let empty = Vec::new();
    let precip = data
        .pointer("/minutely_15/precipitation")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    json!({
        "time": times.iter().take(4).cloned().collect::<Vec<_>>(),
        "precipitation": precip.iter().take(4).map(or_zero).collect::<Vec<_>>(),
    })
}

/// Per-model hourly temperature and precipitation series (first 24 hours).
/// A model counts as available when it has at least one temperature.
pub fn parse_models(data: &Value, models: &[String]) -> (Vec<Value>, Vec<String>) {
    let hourly = &data["hourly"];
    let empty = Vec::new();
    let base_temp = hourly["temperature_2m"].as_array().unwrap_or(&empty);
    let base_precip = hourly["precipitation"].as_array().unwrap_or(&empty);
    let mut series = Vec::new();
    let mut available = Vec::new();
    for model in models {
        let temp = hourly[format!("temperature_2m_{model}")]
            .as_array()
            .unwrap_or(base_temp);
        let precip = hourly[format!("precipitation_{model}")]
            .as_array()
            .unwrap_or(base_precip);
        if temp.iter().any(|v| !v.is_null()) {
            series.push(json!({
                "model": model,
                "temperature_2m": temp.iter().take(24).cloned().collect::<Vec<_>>(),
                "precipitation": precip.iter().take(24).cloned().collect::<Vec<_>>(),
            }));
            available.push(model.clone());
        }
    }
    (series, available)
}

/// The extras block (`minutely`, `models`, `models_available`, `models_time`)
/// from an Open-Meteo extras response.
pub fn open_meteo_extras(data: &Value, models: &[String]) -> Value {
    let (series, available) = parse_models(data, models);
    let times: Vec<Value> = data
        .pointer("/hourly/time")
        .and_then(Value::as_array)
        .map(|t| t.iter().take(24).cloned().collect())
        .unwrap_or_default();
    json!({
        "minutely": parse_minutely(data),
        "models": series,
        "models_available": available,
        "models_time": times,
    })
}

/// Normalise an Open-Meteo forecast response. `None` when it has no daily
/// block (not a usable forecast).
pub fn normalize_open_meteo(data: &Value) -> Option<Value> {
    if !data["daily"].is_object() {
        return None;
    }
    let current = data.get("current").cloned().unwrap_or_else(|| json!({}));
    let mut insights = Map::new();
    for (k, f) in [
        ("windSpeed", "wind_speed_10m"),
        ("windGust", "wind_gusts_10m"),
    ] {
        if !current[f].is_null() {
            insights.insert(k.to_owned(), current[f].clone());
        }
    }
    Some(json!({
        "current": current,
        "hourly": data.get("hourly").cloned().unwrap_or_else(|| json!({})),
        "daily": data["daily"].clone(),
        "current_units": data.get("current_units").cloned().unwrap_or_else(current_units),
        "insights": if insights.is_empty() { Value::Null } else { Value::Object(insights) },
        "minutely": parse_minutely(data),
    }))
}

/// Seasonal estimates for when every provider failed. Only the app's public
/// endpoint serves these (labelled `fallback`); the internal API fails closed
/// instead.
pub fn seasonal_fallback(lat: f64, elevation_m: f64, now: DateTime<Utc>) -> Value {
    let month = now.month();
    let (mut temp, mut code): (f64, i64) = if lat < 0.0 {
        match month {
            12 | 1 | 2 => (28.0, 2),
            3..=5 => (22.0, 2),
            6..=8 => (18.0, 0),
            _ => (25.0, 2),
        }
    } else {
        match month {
            3..=5 => (18.0, 2),
            6..=8 => (28.0, 2),
            9..=11 => (15.0, 2),
            _ => (5.0, 0),
        }
    };
    if lat.abs() < 10.0 {
        temp = 28.0;
        code = 2;
    }
    temp = ((temp - (elevation_m - 1000.0).max(0.0) * 0.006) * 10.0).round() / 10.0;

    let iso = |t: DateTime<Utc>| t.to_rfc3339();
    let is_day = |t: DateTime<Utc>| i64::from((6..18).contains(&t.hour()));
    let hours: Vec<DateTime<Utc>> = (0..24).map(|i| now + Duration::hours(i)).collect();
    let days: Vec<String> = (0..7)
        .map(|i| (now + Duration::days(i)).format("%Y-%m-%d").to_string())
        .collect();
    let rep = |v: Value, n: usize| Value::Array(vec![v; n]);

    json!({
        "current": {
            "time": iso(now),
            "temperature_2m": temp,
            "relative_humidity_2m": 60,
            "apparent_temperature": temp - 1.0,
            "precipitation": 0,
            "weather_code": code,
            "wind_speed_10m": 8,
            "wind_direction_10m": 180,
            "wind_gusts_10m": 15,
            "surface_pressure": 1013,
            "cloud_cover": 30,
            "uv_index": 5,
            "is_day": is_day(now),
        },
        "hourly": {
            "time": hours.iter().map(|t| iso(*t)).collect::<Vec<_>>(),
            "temperature_2m": rep(json!(temp), 24),
            "relative_humidity_2m": rep(json!(60), 24),
            "apparent_temperature": rep(json!(temp - 1.0), 24),
            "precipitation": rep(json!(0), 24),
            "weather_code": rep(json!(code), 24),
            "wind_speed_10m": rep(json!(8), 24),
            "wind_direction_10m": rep(json!(180), 24),
            "wind_gusts_10m": rep(json!(15), 24),
            "surface_pressure": rep(json!(1013), 24),
            "cloud_cover": rep(json!(30), 24),
            "uv_index": rep(json!(5), 24),
            "is_day": hours.iter().map(|t| is_day(*t)).collect::<Vec<_>>(),
        },
        "daily": {
            "time": days,
            "weather_code": rep(json!(code), 7),
            "temperature_2m_max": rep(json!(temp + 5.0), 7),
            "temperature_2m_min": rep(json!(temp - 8.0), 7),
            "apparent_temperature_max": rep(json!(temp + 4.0), 7),
            "apparent_temperature_min": rep(json!(temp - 9.0), 7),
            "precipitation_sum": rep(json!(0), 7),
            "precipitation_probability_max": rep(json!(0), 7),
            "wind_speed_10m_max": rep(json!(15), 7),
            "wind_gusts_10m_max": rep(json!(25), 7),
            "wind_direction_10m_dominant": rep(json!(180), 7),
            "uv_index_max": rep(json!(7), 7),
            "sunrise": rep(json!("06:00"), 7),
            "sunset": rep(json!("18:00"), 7),
        },
        "current_units": current_units(),
        "insights": Value::Null,
    })
}

/// Overlay a station's `current` fields onto a forecast, keeping the
/// forecast-only fields (`is_day`, `weather_code`, …) the hardware does not
/// measure. Station fields that are `null` do not erase forecast values.
pub fn blend_station_current(data: &mut Value, station_current: &Value) {
    let Some(obs) = station_current.as_object() else {
        return;
    };
    if !data["current"].is_object() {
        data["current"] = json!({});
    }
    if let Some(cur) = data["current"].as_object_mut() {
        for (k, v) in obs {
            if !v.is_null() {
                cur.insert(k.clone(), v.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn tomorrow_fixture() -> Value {
        json!({"timelines": {
            "hourly": [
                {"time": "2026-10-04T10:00:00Z", "values": {
                    "temperature": 27.5, "humidity": 30, "temperatureApparent": 26.0,
                    "weatherCode": 1100, "windSpeed": 3.2, "windDirection": 90,
                    "windGust": 6.1, "pressureSurfaceLevel": 850.2, "cloudCover": 10,
                    "uvIndex": 8, "visibility": 16.0, "precipitationProbability": 5}},
                {"time": "2026-10-04T20:00:00Z", "values": {"temperature": 19.0, "weatherCode": 4200}}
            ],
            "daily": [
                {"time": "2026-10-03T22:00:00Z", "values": {
                    "weatherCodeMax": 1101, "temperatureMax": 29.0, "temperatureMin": 14.0,
                    "precipitationProbabilityMax": 10, "sunriseTime": "2026-10-04T03:50:00Z",
                    "sunsetTime": "2026-10-04T16:20:00Z", "windSpeedMax": 7.0,
                    "dewPointAvg": 4.2}}
            ]
        }})
    }

    #[test]
    fn tomorrow_is_normalised_to_the_shared_shape() {
        let d = normalize_tomorrow(&tomorrow_fixture());
        assert_eq!(d["current"]["temperature_2m"], 27.5);
        assert_eq!(d["current"]["weather_code"], 1);
        assert_eq!(
            d["current"]["precipitation"], 0,
            "missing precipitation is 0"
        );
        assert_eq!(
            d["current"]["is_day"], 1,
            "10:00Z is between sunrise and sunset"
        );
        assert_eq!(d["hourly"]["is_day"][1], 0, "20:00Z is after sunset");
        assert_eq!(d["hourly"]["visibility"][0], 16000.0, "km become metres");
        assert_eq!(d["hourly"]["weather_code"][1], 61);
        assert_eq!(d["daily"]["weather_code"][0], 2);
        assert_eq!(d["daily"]["temperature_2m_max"][0], 29.0);
        assert_eq!(d["insights"]["dewPoint"], 4.2);
        assert_eq!(d["insights"]["windSpeed"], 7.0);
        assert!(
            d["insights"].get("moonPhase").is_none(),
            "absent insights are dropped"
        );
        assert_eq!(d["current_units"]["wind_speed_10m"], "km/h");
    }

    #[test]
    fn empty_tomorrow_timelines_give_an_empty_current() {
        let d = normalize_tomorrow(&json!({"timelines": {}}));
        assert!(d["current"].as_object().unwrap().is_empty());
        assert_eq!(d["insights"], Value::Null);
    }

    #[test]
    fn urls_are_built_and_encoded() {
        let t = tomorrow_url(-17.83, 31.05, "k&y");
        assert!(t.starts_with(
            "https://api.tomorrow.io/v4/weather/forecast?location=-17.83,31.05&apikey=k%26y&"
        ));
        let o = open_meteo_url(-17.83, 31.05);
        assert!(o.contains("latitude=-17.83&longitude=31.05"));
        assert!(o.contains("forecast_days=7"));
        let e = open_meteo_extras_url(1.0, 2.0, &sanitize_models(&[]));
        assert!(e.contains("models=gfs_seamless,ecmwf_ifs04,icon_seamless"));
    }

    #[test]
    fn models_are_sanitised() {
        assert_eq!(
            sanitize_models(&["evil", "best_match"]),
            DEFAULT_FORECAST_MODELS
        );
        assert_eq!(
            sanitize_models(&["icon_seamless", " icon_seamless", "gfs_seamless"]),
            vec!["icon_seamless", "gfs_seamless"]
        );
    }

    #[test]
    fn open_meteo_is_normalised_with_nowcast_and_models() {
        let raw = json!({
            "current": {"temperature_2m": 21.0, "wind_speed_10m": 9.0},
            "hourly": {"time": ["a", "b"], "temperature_2m": [1, 2],
                       "temperature_2m_gfs_seamless": [3, 4], "precipitation": [0, 0]},
            "daily": {"time": ["2026-10-04"], "weather_code": [3]},
            "minutely_15": {"time": ["t1", "t2", "t3", "t4", "t5"], "precipitation": [0.1, null, 0, 0, 9]}
        });
        let d = normalize_open_meteo(&raw).unwrap();
        assert_eq!(d["insights"]["windSpeed"], 9.0);
        assert_eq!(d["minutely"]["time"].as_array().unwrap().len(), 4);
        assert_eq!(d["minutely"]["precipitation"][1], 0, "null nowcast is 0");
        assert_eq!(d["current_units"]["temperature_2m"], "°C");

        let models = vec!["gfs_seamless".to_owned(), "icon_seamless".to_owned()];
        let x = open_meteo_extras(&raw, &models);
        assert_eq!(x["models"][0]["temperature_2m"], json!([3, 4]));
        assert_eq!(
            x["models"][1]["temperature_2m"],
            json!([1, 2]),
            "falls back to best_match"
        );
        assert_eq!(
            x["models_available"],
            json!(["gfs_seamless", "icon_seamless"])
        );

        assert!(normalize_open_meteo(&json!({"error": true})).is_none());
    }

    #[test]
    fn seasonal_fallback_is_hemisphere_and_elevation_aware() {
        let jan = Utc.with_ymd_and_hms(2026, 1, 15, 12, 0, 0).unwrap();
        let harare = seasonal_fallback(-17.8, 1490.0, jan);
        // Southern summer 28 °C, minus (1490 - 1000) × 0.006.
        assert_eq!(harare["current"]["temperature_2m"], 25.1);
        assert_eq!(harare["daily"]["time"].as_array().unwrap().len(), 7);
        let london = seasonal_fallback(51.5, 11.0, jan);
        assert_eq!(london["current"]["temperature_2m"], 5.0);
        assert_eq!(
            seasonal_fallback(1.3, 0.0, jan)["current"]["temperature_2m"],
            28.0
        );
    }

    #[test]
    fn station_fields_overlay_without_erasing() {
        let mut d = json!({"current": {"temperature_2m": 20.0, "is_day": 1, "uv_index": 4}});
        blend_station_current(&mut d, &json!({"temperature_2m": 22.4, "uv_index": null}));
        assert_eq!(d["current"]["temperature_2m"], 22.4);
        assert_eq!(d["current"]["uv_index"], 4);
        assert_eq!(d["current"]["is_day"], 1);
    }
}
