//! The daily forecast contract served at `GET /internal/forecast` and proxied
//! by the Nyuchi API as `GET /v1/weather/forecast` (nyuchi/api-gateway#154).
//!
//! ```text
//! {location: {slug, name, lat, lon},
//!  data: [{date, description, weather_code, high, low, precipitation_probability}],
//!  source, fetched_at, attribution}
//! ```

use std::fmt;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::places::Place;
use crate::wmo;

/// Where a forecast came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Source {
    #[serde(rename = "stationkit")]
    StationKit,
    #[serde(rename = "tomorrow")]
    Tomorrow,
    #[serde(rename = "open-meteo")]
    OpenMeteo,
    /// Seasonal estimates. Never served by the internal API.
    #[serde(rename = "fallback")]
    Fallback,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::StationKit => "stationkit",
            Source::Tomorrow => "tomorrow",
            Source::OpenMeteo => "open-meteo",
            Source::Fallback => "fallback",
        }
    }

    pub fn parse(s: &str) -> Option<Source> {
        match s {
            "stationkit" => Some(Source::StationKit),
            "tomorrow" => Some(Source::Tomorrow),
            "open-meteo" => Some(Source::OpenMeteo),
            "fallback" => Some(Source::Fallback),
            _ => None,
        }
    }

    /// The credit line each provider's terms ask for.
    pub fn attribution(self) -> &'static str {
        match self {
            Source::StationKit => {
                "Current conditions from the Nyuchi StationKit network; forecast by Mukoko Weather."
            }
            Source::Tomorrow => "Powered by Tomorrow.io.",
            Source::OpenMeteo => "Weather data by Open-Meteo.com (CC BY 4.0).",
            Source::Fallback => {
                "Seasonal estimate by Mukoko Weather; no live forecast was available."
            }
        }
    }
}

impl fmt::Display for Source {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ForecastLocation {
    pub slug: String,
    pub name: Option<String>,
    pub lat: f64,
    pub lon: f64,
}

impl From<&Place> for ForecastLocation {
    fn from(p: &Place) -> Self {
        ForecastLocation {
            slug: p.slug.clone(),
            name: p.name.clone(),
            lat: p.lat,
            lon: p.lon,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ForecastDay {
    /// Local date, `YYYY-MM-DD`.
    pub date: String,
    pub description: Option<String>,
    /// WMO 4677.
    pub weather_code: Option<i64>,
    /// Maximum, °C.
    pub high: Option<f64>,
    /// Minimum, °C.
    pub low: Option<f64>,
    /// Maximum, percent.
    pub precipitation_probability: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ForecastResponse {
    pub location: ForecastLocation,
    pub data: Vec<ForecastDay>,
    pub source: Source,
    /// RFC 3339, when the provider was asked.
    pub fetched_at: String,
    pub attribution: String,
}

/// The local calendar date for a provider's daily timestamp.
///
/// Open-Meteo (with `timezone=auto`) already sends `YYYY-MM-DD`. Tomorrow.io
/// sends the start of the local day as a UTC instant (for Harare, 22:00 the
/// day before), so the date is taken after shifting by the longitude's solar
/// offset plus six hours, which lands safely inside the right local day
/// whether Tomorrow.io starts days at midnight or 06:00.
pub fn local_date(time: &str, lon: f64) -> Option<String> {
    let t = time.trim();
    if t.len() == 10 && t.as_bytes().get(4) == Some(&b'-') {
        return Some(t.to_owned());
    }
    let instant = DateTime::parse_from_rfc3339(t).ok()?.with_timezone(&Utc);
    let offset_minutes = (lon / 15.0 * 60.0).round() as i64 + 6 * 60;
    Some(
        (instant + Duration::minutes(offset_minutes))
            .format("%Y-%m-%d")
            .to_string(),
    )
}

/// Project a `WeatherData` daily block into at most `days` forecast days.
pub fn daily_from_weather(data: &Value, lon: f64, days: usize) -> Vec<ForecastDay> {
    let daily = &data["daily"];
    let Some(times) = daily["time"].as_array() else {
        return Vec::new();
    };
    let at = |key: &str, i: usize| daily[key].get(i).and_then(Value::as_f64);
    times
        .iter()
        .enumerate()
        .filter_map(|(i, t)| {
            let date = local_date(t.as_str()?, lon)?;
            let code = daily["weather_code"]
                .get(i)
                .and_then(Value::as_f64)
                .map(|c| c as i64);
            Some(ForecastDay {
                date,
                description: code.map(|c| wmo::description(c).to_owned()),
                weather_code: code,
                high: at("temperature_2m_max", i),
                low: at("temperature_2m_min", i),
                precipitation_probability: at("precipitation_probability_max", i),
            })
        })
        .take(days)
        .collect()
}

/// Build the contract response.
pub fn build_response(
    place: &Place,
    data: &Value,
    source: Source,
    fetched_at: &str,
    days: usize,
) -> ForecastResponse {
    ForecastResponse {
        location: place.into(),
        data: daily_from_weather(data, place.lon, days),
        source,
        fetched_at: fetched_at.to_owned(),
        attribution: source.attribution().to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dates_from_each_provider() {
        assert_eq!(
            local_date("2026-10-04", 31.0).as_deref(),
            Some("2026-10-04")
        );
        // Tomorrow.io: Harare (UTC+2) local midnight is 22:00Z the day before.
        assert_eq!(
            local_date("2026-10-03T22:00:00Z", 31.05).as_deref(),
            Some("2026-10-04")
        );
        // A 06:00-local day start in Harare is 04:00Z.
        assert_eq!(
            local_date("2026-10-04T04:00:00Z", 31.05).as_deref(),
            Some("2026-10-04")
        );
        // New York (UTC-4) midnight is 04:00Z the same day.
        assert_eq!(
            local_date("2026-10-04T04:00:00Z", -74.0).as_deref(),
            Some("2026-10-04")
        );
        assert_eq!(local_date("garbage", 0.0), None);
    }

    #[test]
    fn the_contract_shape_is_exact() {
        let place = Place {
            slug: "harare".into(),
            name: Some("Harare".into()),
            lat: -17.83,
            lon: 31.05,
            elevation: Some(1490.0),
            country: Some("ZW".into()),
        };
        let data = json!({"daily": {
            "time": ["2026-10-04", "2026-10-05", "2026-10-06"],
            "weather_code": [0, 61, null],
            "temperature_2m_max": [30.1, 25.0, 24.0],
            "temperature_2m_min": [14.0, 15.5, null],
            "precipitation_probability_max": [0, 70, 20]
        }});
        let r = build_response(&place, &data, Source::OpenMeteo, "2026-10-04T08:00:00Z", 2);
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(
            v,
            json!({
                "location": {"slug": "harare", "name": "Harare", "lat": -17.83, "lon": 31.05},
                "data": [
                    {"date": "2026-10-04", "description": "Clear sky", "weather_code": 0,
                     "high": 30.1, "low": 14.0, "precipitation_probability": 0.0},
                    {"date": "2026-10-05", "description": "Slight rain", "weather_code": 61,
                     "high": 25.0, "low": 15.5, "precipitation_probability": 70.0}
                ],
                "source": "open-meteo",
                "fetched_at": "2026-10-04T08:00:00Z",
                "attribution": "Weather data by Open-Meteo.com (CC BY 4.0)."
            })
        );
    }

    #[test]
    fn missing_values_stay_null() {
        let data = json!({"daily": {"time": ["2026-10-04"], "weather_code": [null]}});
        let days = daily_from_weather(&data, 0.0, 7);
        assert_eq!(days.len(), 1);
        assert_eq!(days[0].weather_code, None);
        assert_eq!(days[0].description, None);
        assert_eq!(daily_from_weather(&json!({}), 0.0, 7), vec![]);
    }

    #[test]
    fn sources_round_trip() {
        for s in [
            Source::StationKit,
            Source::Tomorrow,
            Source::OpenMeteo,
            Source::Fallback,
        ] {
            assert_eq!(Source::parse(s.as_str()), Some(s));
            assert_eq!(serde_json::to_value(s).unwrap(), json!(s.as_str()));
        }
    }
}
