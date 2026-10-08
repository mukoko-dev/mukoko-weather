//! The history statistics the analysis prompt is built on, ported from
//! `_aggregate_stats` in `api/py/_history_analyze.py`.
//!
//! The model gets this compact text, never the raw rows, which keeps the
//! prompt to a few hundred tokens whatever the period.
//!
//! A record's `daily` comes in two shapes: the D1 `place_daily` row has one
//! day with camelCase fields (`tempMax`, `precipSum`, …), while the Python
//! records had Open-Meteo arrays (`temperature_2m_max[0]`). Both are read.

use serde_json::Value;

/// One day of history.
#[derive(Debug, Clone, Default)]
pub struct Record {
    pub date: String,
    pub current: Value,
    pub daily: Value,
    pub insights: Value,
}

/// A daily value: the camelCase field, else the first entry of the
/// Open-Meteo array.
fn daily(d: &Value, camel: &str, open_meteo: &str) -> Option<f64> {
    d[camel].as_f64().or_else(|| d[open_meteo][0].as_f64())
}

fn avg(v: &[f64]) -> f64 {
    if v.is_empty() {
        0.0
    } else {
        round1(v.iter().sum::<f64>() / v.len() as f64)
    }
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

fn max(v: &[f64]) -> f64 {
    v.iter().copied().fold(f64::NEG_INFINITY, f64::max)
}

fn min(v: &[f64]) -> f64 {
    v.iter().copied().fold(f64::INFINITY, f64::min)
}

fn rng(v: &[f64]) -> String {
    if v.is_empty() {
        "N/A".into()
    } else {
        format!("{}-{}", round1(min(v)), round1(max(v)))
    }
}

fn condition(code: i64) -> String {
    let name = match code {
        0 => "Clear",
        1 => "Mainly clear",
        2 => "Partly cloudy",
        3 => "Overcast",
        45 | 48 => "Fog",
        51 => "Light drizzle",
        53 => "Moderate drizzle",
        55 => "Dense drizzle",
        61 => "Slight rain",
        63 => "Moderate rain",
        65 => "Heavy rain",
        71 => "Slight snow",
        73 => "Moderate snow",
        75 => "Heavy snow",
        80 => "Slight showers",
        81 => "Moderate showers",
        82 => "Violent showers",
        95 => "Thunderstorm",
        96 => "Thunderstorm+hail",
        99 => "Thunderstorm+heavy hail",
        _ => return format!("Code {code}"),
    };
    name.to_owned()
}

/// The statistical summary of the records, oldest first.
pub fn aggregate(records: &[Record]) -> String {
    if records.is_empty() {
        return "No data available for the selected period.".into();
    }

    let mut highs = Vec::new();
    let mut lows = Vec::new();
    let mut feels_high = Vec::new();
    let mut feels_low = Vec::new();
    let mut precip = Vec::new();
    let mut rainy = 0usize;
    let mut humidity = Vec::new();
    let mut wind = Vec::new();
    let mut gusts = Vec::new();
    let mut uv = Vec::new();
    let mut pressure = Vec::new();
    let mut cloud = Vec::new();
    let mut codes: Vec<(i64, usize)> = Vec::new();
    let mut heat = Vec::new();
    let mut storms = Vec::new();
    let mut gdd = Vec::new();

    for r in records {
        let c = &r.current;
        let d = &r.daily;

        if let Some(t) =
            daily(d, "tempMax", "temperature_2m_max").or_else(|| c["temperature_2m"].as_f64())
        {
            highs.push(t);
        }
        if let Some(t) = daily(d, "tempMin", "temperature_2m_min") {
            lows.push(t);
        }
        if let Some(t) = daily(d, "apparentTempMax", "apparent_temperature_max") {
            feels_high.push(t);
        }
        if let Some(t) = daily(d, "apparentTempMin", "apparent_temperature_min") {
            feels_low.push(t);
        }
        if let Some(p) = daily(d, "precipSum", "precipitation_sum") {
            precip.push(p);
            if p > 0.1 {
                rainy += 1;
            }
        }
        let push = |v: &mut Vec<f64>, key: &str| {
            if let Some(x) = c[key].as_f64() {
                v.push(x);
            }
        };
        push(&mut humidity, "relative_humidity_2m");
        push(&mut wind, "wind_speed_10m");
        push(&mut gusts, "wind_gusts_10m");
        push(&mut pressure, "surface_pressure");
        push(&mut cloud, "cloud_cover");
        if let Some(u) = daily(d, "uvIndexMax", "uv_index_max").or_else(|| c["uv_index"].as_f64()) {
            uv.push(u);
        }

        let code = c["weather_code"].as_i64().unwrap_or(0);
        match codes.iter_mut().find(|(k, _)| *k == code) {
            Some((_, n)) => *n += 1,
            None => codes.push((code, 1)),
        }

        let i = &r.insights;
        if let Some(x) = i["heatStressIndex"].as_f64() {
            heat.push(x);
        }
        if let Some(x) = i["thunderstormProbability"].as_f64() {
            storms.push(x);
        }
        if let Some(x) = i["gdd10To30"].as_f64() {
            gdd.push(x);
        }
    }

    let first = &records[0].date;
    let last = &records[records.len() - 1].date;
    let mut lines = vec![format!(
        "Period: {first} to {last} ({} data points)",
        records.len()
    )];

    if !highs.is_empty() {
        lines.push(format!(
            "Temperature: avg high {}°C (range {}), avg low {}°C (range {})",
            avg(&highs),
            rng(&highs),
            avg(&lows),
            rng(&lows)
        ));
    }
    if !feels_high.is_empty() {
        lines.push(format!(
            "Feels like: high {}°C, low {}°C",
            avg(&feels_high),
            avg(&feels_low)
        ));
    }
    // Trend: the first quarter against the last.
    if highs.len() >= 8 {
        let q = highs.len() / 4;
        let diff = round1(avg(&highs[highs.len() - q..]) - avg(&highs[..q]));
        if diff.abs() > 1.0 {
            let dir = if diff > 0.0 { "warming" } else { "cooling" };
            lines.push(format!(
                "Temperature trend: {dir} ({diff:+.1}°C from start to end)"
            ));
        }
    }
    if !precip.is_empty() {
        lines.push(format!(
            "Precipitation: total {}mm, {rainy} rainy days out of {}",
            round1(precip.iter().sum()),
            precip.len()
        ));
    }
    if !humidity.is_empty() {
        lines.push(format!(
            "Humidity: avg {}% (range {})",
            avg(&humidity),
            rng(&humidity)
        ));
    }
    if !wind.is_empty() {
        let g = if gusts.is_empty() {
            "N/A".to_owned()
        } else {
            round1(max(&gusts)).to_string()
        };
        lines.push(format!("Wind: avg {} km/h, max gusts {g} km/h", avg(&wind)));
    }
    if !uv.is_empty() {
        lines.push(format!(
            "UV index: avg {}, max {}",
            avg(&uv),
            round1(max(&uv))
        ));
    }
    if !pressure.is_empty() {
        lines.push(format!(
            "Pressure: avg {} hPa (range {})",
            avg(&pressure),
            rng(&pressure)
        ));
    }
    if !cloud.is_empty() {
        lines.push(format!("Cloud cover: avg {}%", avg(&cloud)));
    }

    // Most common first; ties keep first-seen order, as Python's stable sort.
    codes.sort_by_key(|a| std::cmp::Reverse(a.1));
    let conds: Vec<String> = codes
        .iter()
        .take(3)
        .map(|(c, n)| format!("{} ({n}d)", condition(*c)))
        .collect();
    lines.push(format!("Most common conditions: {}", conds.join(", ")));

    if !heat.is_empty() {
        let high = heat.iter().filter(|&&h| h >= 28.0).count();
        lines.push(format!(
            "Heat stress: avg {}, {high} high-stress days",
            avg(&heat)
        ));
    }
    if !storms.is_empty() {
        let risky = storms.iter().filter(|&&t| t > 30.0).count();
        lines.push(format!(
            "Thunderstorm risk: avg {}%, {risky} high-risk days",
            avg(&storms)
        ));
    }
    if !gdd.is_empty() {
        lines.push(format!(
            "Growing degree days (maize): avg {}, total {}",
            avg(&gdd),
            round1(gdd.iter().sum())
        ));
    }

    lines.join("\n")
}

/// A short fingerprint of the records, so a cached analysis is reused only
/// while the data underneath is unchanged (FNV-1a over date and high).
pub fn fingerprint(records: &[Record]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |bytes: &[u8]| {
        for b in bytes {
            h ^= u64::from(*b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    };
    for r in records {
        eat(r.date.as_bytes());
        let t = daily(&r.daily, "tempMax", "temperature_2m_max")
            .or_else(|| r.current["temperature_2m"].as_f64());
        eat(&t.unwrap_or(f64::NAN).to_bits().to_le_bytes());
    }
    format!("{h:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn d1_row(date: &str, hi: f64, rain: f64, code: i64) -> Record {
        Record {
            date: date.into(),
            current: json!({"temperature_2m": hi - 3.0, "relative_humidity_2m": 50,
                            "wind_speed_10m": 10, "wind_gusts_10m": 25, "weather_code": code}),
            daily: json!({"tempMax": hi, "tempMin": hi - 12.0, "precipSum": rain, "uvIndexMax": 9}),
            insights: json!({"heatStressIndex": 29, "thunderstormProbability": 40}),
        }
    }

    #[test]
    fn empty_history() {
        assert_eq!(aggregate(&[]), "No data available for the selected period.");
    }

    #[test]
    fn d1_rows_are_summarised() {
        let rows: Vec<Record> = (0..8)
            .map(|i| {
                d1_row(
                    &format!("2026-09-{:02}", i + 1),
                    20.0 + i as f64,
                    if i % 2 == 0 { 2.5 } else { 0.0 },
                    if i < 5 { 2 } else { 61 },
                )
            })
            .collect();
        let s = aggregate(&rows);
        assert!(s.starts_with("Period: 2026-09-01 to 2026-09-08 (8 data points)"));
        assert!(s.contains("Temperature: avg high 23.5°C (range 20-27)"));
        assert!(s.contains("Temperature trend: warming (+6.0°C from start to end)"));
        assert!(s.contains("Precipitation: total 10mm, 4 rainy days out of 8"));
        assert!(s.contains("Wind: avg 10 km/h, max gusts 25 km/h"));
        assert!(s.contains("UV index: avg 9, max 9"));
        assert!(s.contains("Most common conditions: Partly cloudy (5d), Slight rain (3d)"));
        assert!(s.contains("Heat stress: avg 29, 8 high-stress days"));
        assert!(s.contains("Thunderstorm risk: avg 40%, 8 high-risk days"));
    }

    #[test]
    fn python_records_are_read_too() {
        let r = Record {
            date: "2026-01-01".into(),
            current: json!({"weather_code": 95}),
            daily: json!({"temperature_2m_max": [31.24], "temperature_2m_min": [18.0],
                          "precipitation_sum": [12.0]}),
            insights: Value::Null,
        };
        let s = aggregate(&[r]);
        assert!(s.contains("avg high 31.2°C"));
        assert!(s.contains("total 12mm, 1 rainy days out of 1"));
        assert!(s.contains("Thunderstorm (1d)"));
    }

    #[test]
    fn fingerprint_changes_with_the_data() {
        let a = vec![d1_row("2026-09-01", 20.0, 0.0, 0)];
        let b = vec![d1_row("2026-09-01", 21.0, 0.0, 0)];
        assert_eq!(fingerprint(&a), fingerprint(&a.clone()));
        assert_ne!(fingerprint(&a), fingerprint(&b));
        assert_eq!(fingerprint(&a).len(), 16);
    }
}
