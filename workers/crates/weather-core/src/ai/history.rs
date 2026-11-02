//! The history statistics the analysis prompt is built on, ported from
//! `_aggregate_stats` in the former `api/py/_history_analyze.py`.
//!
//! The model gets this compact text, never the raw rows, which keeps the
//! prompt to a few hundred tokens whatever the period.
//!
//! A record's `daily` comes in two shapes: the D1 `place_daily` row has one
//! day with camelCase fields (`tempMax`, `precipSum`, …), while the Python
//! records had Open-Meteo arrays (`temperature_2m_max[0]`). Both are read.
//!
//! The text is pinned to the real Python by
//! `tests/fixtures/history-analysis-stats.json`, whose `expected` strings were
//! produced by `_aggregate_stats` itself. That includes how Python writes a
//! number: a JSON integer stays an integer (`0`, `20`) while a float always
//! shows its decimal (`0.0`, `20.0`), `round(x, 1)` rounds the exact binary
//! value half to even, and `sum` of floats is compensated. [`Num`] carries the
//! distinction so the prompt reads the same as it did.

use serde_json::Value;

use crate::history::round_py;
use crate::wmo;

/// One day of history.
#[derive(Debug, Clone, Default)]
pub struct Record {
    pub date: String,
    pub current: Value,
    pub daily: Value,
    pub insights: Value,
    /// Where the day came from (`recorded`, `open-meteo-archive`,
    /// `nasa-power`). `None` is treated as recorded.
    pub source: Option<String>,
}

/// A JSON number the way Python holds it.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Num {
    Int(i64),
    Float(f64),
}

impl Num {
    fn of(v: &Value) -> Option<Num> {
        let n = v.as_number()?;
        match n.as_i64() {
            Some(i) => Some(Num::Int(i)),
            None => n.as_f64().map(Num::Float),
        }
    }

    fn f(self) -> f64 {
        match self {
            Num::Int(i) => i as f64,
            Num::Float(x) => x,
        }
    }

    /// `round(x, 1)`: an int stays an int.
    fn round1(self) -> Num {
        match self {
            Num::Int(i) => Num::Int(i),
            Num::Float(x) => Num::Float(round_py(x, 1)),
        }
    }

    /// `str(x)`: `20` for an int, `20.0` for a float.
    fn show(self) -> String {
        match self {
            Num::Int(i) => i.to_string(),
            Num::Float(x) => format!("{x:?}"),
        }
    }
}

/// A daily value: the camelCase field, else the first entry of the
/// Open-Meteo array.
fn daily(d: &Value, camel: &str, open_meteo: &str) -> Option<Num> {
    Num::of(&d[camel]).or_else(|| Num::of(&d[open_meteo][0]))
}

/// Python's builtin `sum` of ints and floats: exact while everything is an
/// int; from the first float on, a compensated (Neumaier) sum of floats, with
/// an int added plainly. The compensation is added once at the end when it is
/// finite (CPython 3.12+).
fn py_sum(v: &[Num]) -> Num {
    let mut ints: i64 = 0;
    let mut i = 0;
    while let Some(Num::Int(n)) = v.get(i) {
        match ints.checked_add(*n) {
            Some(s) => ints = s,
            // Past i64 Python would use a big int; the values here never get
            // near it, so continue as floats instead of panicking.
            None => break,
        }
        i += 1;
    }
    let Some(first) = v.get(i) else {
        return Num::Int(ints);
    };
    let mut sum = ints as f64 + first.f();
    let mut compensation = 0.0_f64;
    for item in &v[i + 1..] {
        match item {
            Num::Float(x) => {
                let t = sum + x;
                if sum.abs() >= x.abs() {
                    compensation += (sum - t) + x;
                } else {
                    compensation += (x - t) + sum;
                }
                sum = t;
            }
            Num::Int(n) => sum += *n as f64,
        }
    }
    if compensation != 0.0 && compensation.is_finite() {
        sum += compensation;
    }
    Num::Float(sum)
}

/// `round(sum(v) / len(v), 1)` — always a float — or the int `0` when empty.
fn avg(v: &[Num]) -> Num {
    if v.is_empty() {
        Num::Int(0)
    } else {
        Num::Float(round_py(py_sum(v).f() / v.len() as f64, 1))
    }
}

/// The first greatest element, as Python's `max`.
fn max(v: &[Num]) -> Num {
    v.iter()
        .copied()
        .reduce(|a, b| if b.f() > a.f() { b } else { a })
        .unwrap_or(Num::Int(0))
}

/// The first least element, as Python's `min`.
fn min(v: &[Num]) -> Num {
    v.iter()
        .copied()
        .reduce(|a, b| if b.f() < a.f() { b } else { a })
        .unwrap_or(Num::Int(0))
}

fn rng(v: &[Num]) -> String {
    if v.is_empty() {
        "N/A".into()
    } else {
        format!("{}-{}", min(v).round1().show(), max(v).round1().show())
    }
}

/// A weather code as a dictionary key: a whole number, or `None` for a
/// `null`. (A missing key is code 0.)
fn code_of(c: &Value) -> Option<i64> {
    match c {
        Value::Null => None,
        v => v
            .as_i64()
            .or_else(|| v.as_f64().filter(|x| x.fract() == 0.0).map(|x| x as i64)),
    }
}

fn condition(code: Option<i64>) -> String {
    match code {
        Some(c) => wmo::known_description(c).map_or_else(|| format!("Code {c}"), str::to_owned),
        None => "Code None".into(),
    }
}

/// Where the days came from, as one line, when any did not come from a live
/// recording: archive days carry 24-hour means for humidity, wind, pressure and
/// cloud (and no UV), recorded days a point-in-time snapshot, and the model
/// must not read the mix as a trend.
fn provenance(records: &[Record]) -> Option<String> {
    let count = |id: &str| {
        records
            .iter()
            .filter(|r| r.source.as_deref() == Some(id))
            .count()
    };
    let era5 = count(crate::history::SOURCE_OPEN_METEO_ARCHIVE);
    let power = count(crate::history::SOURCE_NASA_POWER);
    let archive = era5 + power;
    if archive == 0 {
        return None;
    }
    let from = match (era5 > 0, power > 0) {
        (true, false) => "the ERA5 climate archive",
        (false, true) => "NASA POWER",
        _ => "the ERA5 climate archive and NASA POWER",
    };
    Some(format!(
        "Data sources: {} days recorded live (point-in-time humidity/wind/pressure/cloud), \
         {archive} days from {from} (24h daily means, no UV). \
         Do not treat differences between the two as a trend.",
        records.len() - archive
    ))
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
    let mut codes: Vec<(Option<i64>, usize)> = Vec::new();
    let mut heat = Vec::new();
    let mut storms = Vec::new();
    let mut gdd = Vec::new();

    for r in records {
        let c = &r.current;
        let d = &r.daily;

        if let Some(t) =
            daily(d, "tempMax", "temperature_2m_max").or_else(|| Num::of(&c["temperature_2m"]))
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
            if p.f() > 0.1 {
                rainy += 1;
            }
        }
        let push = |v: &mut Vec<Num>, key: &str| {
            if let Some(x) = Num::of(&c[key]) {
                v.push(x);
            }
        };
        push(&mut humidity, "relative_humidity_2m");
        push(&mut wind, "wind_speed_10m");
        push(&mut gusts, "wind_gusts_10m");
        push(&mut pressure, "surface_pressure");
        push(&mut cloud, "cloud_cover");
        if let Some(u) = daily(d, "uvIndexMax", "uv_index_max").or_else(|| Num::of(&c["uv_index"]))
        {
            uv.push(u);
        }

        // A missing key is code 0; a present `null` is its own key.
        let code = match c.get("weather_code") {
            None => Some(0),
            Some(v) => code_of(v),
        };
        match codes.iter_mut().find(|(k, _)| *k == code) {
            Some((_, n)) => *n += 1,
            None => codes.push((code, 1)),
        }

        // Only a non-empty object counts, as Python's `if ins and isinstance(ins, dict)`.
        if let Some(i) = r.insights.as_object().filter(|o| !o.is_empty()) {
            if let Some(x) = i.get("heatStressIndex").and_then(Num::of) {
                heat.push(x);
            }
            if let Some(x) = i.get("thunderstormProbability").and_then(Num::of) {
                storms.push(x);
            }
            if let Some(x) = i.get("gdd10To30").and_then(Num::of) {
                gdd.push(x);
            }
        }
    }

    let first = &records[0].date;
    let last = &records[records.len() - 1].date;
    let mut lines = vec![format!(
        "Period: {first} to {last} ({} data points)",
        records.len()
    )];
    lines.extend(provenance(records));

    if !highs.is_empty() {
        lines.push(format!(
            "Temperature: avg high {}°C (range {}), avg low {}°C (range {})",
            avg(&highs).show(),
            rng(&highs),
            avg(&lows).show(),
            rng(&lows)
        ));
    }
    if !feels_high.is_empty() {
        lines.push(format!(
            "Feels like: high {}°C, low {}°C",
            avg(&feels_high).show(),
            avg(&feels_low).show()
        ));
    }
    // Trend: the first quarter against the last.
    if highs.len() >= 8 {
        let q = highs.len() / 4;
        let diff = round_py(avg(&highs[highs.len() - q..]).f() - avg(&highs[..q]).f(), 1);
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
            py_sum(&precip).round1().show(),
            precip.len()
        ));
    }
    if !humidity.is_empty() {
        lines.push(format!(
            "Humidity: avg {}% (range {})",
            avg(&humidity).show(),
            rng(&humidity)
        ));
    }
    if !wind.is_empty() {
        let g = if gusts.is_empty() {
            "N/A".to_owned()
        } else {
            max(&gusts).round1().show()
        };
        lines.push(format!(
            "Wind: avg {} km/h, max gusts {g} km/h",
            avg(&wind).show()
        ));
    }
    if !uv.is_empty() {
        lines.push(format!(
            "UV index: avg {}, max {}",
            avg(&uv).show(),
            max(&uv).round1().show()
        ));
    }
    if !pressure.is_empty() {
        lines.push(format!(
            "Pressure: avg {} hPa (range {})",
            avg(&pressure).show(),
            rng(&pressure)
        ));
    }
    if !cloud.is_empty() {
        lines.push(format!("Cloud cover: avg {}%", avg(&cloud).show()));
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
        let high = heat.iter().filter(|h| h.f() >= 28.0).count();
        lines.push(format!(
            "Heat stress: avg {}, {high} high-stress days",
            avg(&heat).show()
        ));
    }
    if !storms.is_empty() {
        let risky = storms.iter().filter(|t| t.f() > 30.0).count();
        lines.push(format!(
            "Thunderstorm risk: avg {}%, {risky} high-risk days",
            avg(&storms).show()
        ));
    }
    if !gdd.is_empty() {
        lines.push(format!(
            "Growing degree days (maize): avg {}, total {}",
            avg(&gdd).show(),
            py_sum(&gdd).round1().show()
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
            .or_else(|| Num::of(&r.current["temperature_2m"]))
            .map(Num::f);
        eat(&t.unwrap_or(f64::NAN).to_bits().to_le_bytes());
    }
    format!("{h:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// `tests/fixtures/history-analysis-stats.json`: the `expected` text was
    /// produced by the real Python `_aggregate_stats`.
    const FIXTURE: &str = include_str!("../../../../../tests/fixtures/history-analysis-stats.json");

    fn record(r: &Value) -> Record {
        Record {
            date: r["date"].as_str().unwrap_or_default().to_owned(),
            current: r["current"].clone(),
            daily: r["daily"].clone(),
            insights: r["insights"].clone(),
            source: r["source"].as_str().map(str::to_owned),
        }
    }

    #[test]
    fn the_text_matches_the_python_for_every_case() {
        let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() >= 30, "the fixture holds the Python's cases");
        for case in cases {
            let records: Vec<Record> = case["records"]
                .as_array()
                .unwrap()
                .iter()
                .map(record)
                .collect();
            assert_eq!(
                aggregate(&records),
                case["expected"].as_str().unwrap(),
                "{}",
                case["name"]
            );
        }
    }

    fn d1_row(date: &str, hi: f64, rain: f64, code: i64) -> Record {
        Record {
            date: date.into(),
            current: json!({"temperature_2m": hi - 3.0, "relative_humidity_2m": 50,
                            "wind_speed_10m": 10, "wind_gusts_10m": 25, "weather_code": code}),
            daily: json!({"tempMax": hi, "tempMin": hi - 12.0, "precipSum": rain, "uvIndexMax": 9}),
            insights: json!({"heatStressIndex": 29, "thunderstormProbability": 40}),
            source: None,
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
        // Floats print their decimal, ints do not: as the Python did.
        assert!(s.contains("Temperature: avg high 23.5°C (range 20.0-27.0)"));
        assert!(s.contains("Temperature trend: warming (+6.0°C from start to end)"));
        assert!(s.contains("Precipitation: total 10.0mm, 4 rainy days out of 8"));
        assert!(s.contains("Humidity: avg 50.0% (range 50-50)"));
        assert!(s.contains("Wind: avg 10.0 km/h, max gusts 25 km/h"));
        assert!(s.contains("UV index: avg 9.0, max 9"));
        assert!(s.contains("Most common conditions: Partly cloudy (5d), Slight rain (3d)"));
        assert!(s.contains("Heat stress: avg 29.0, 8 high-stress days"));
        assert!(s.contains("Thunderstorm risk: avg 40.0%, 8 high-risk days"));
    }

    #[test]
    fn python_records_are_read_too() {
        let r = Record {
            date: "2026-01-01".into(),
            current: json!({"weather_code": 95}),
            daily: json!({"temperature_2m_max": [31.24], "temperature_2m_min": [18.0],
                          "precipitation_sum": [12.0]}),
            insights: Value::Null,
            source: None,
        };
        let s = aggregate(&[r]);
        assert!(s.contains("avg high 31.2°C"));
        assert!(s.contains("total 12.0mm, 1 rainy days out of 1"));
        assert!(s.contains("Thunderstorm (1d)"));
    }

    #[test]
    fn python_rounding_and_sums_are_reproduced() {
        // Exact binary ties go to even, as `round(20.25, 1)`.
        assert_eq!(Num::Float(20.25).round1().show(), "20.2");
        assert_eq!(Num::Float(20.35).round1().show(), "20.4");
        assert_eq!(Num::Int(7).round1().show(), "7");
        assert_eq!(Num::Float(7.0).round1().show(), "7.0");
        // Ints sum to an int; one float makes the whole a float.
        assert_eq!(py_sum(&[Num::Int(1), Num::Int(2)]), Num::Int(3));
        assert_eq!(py_sum(&[Num::Int(1), Num::Float(2.0)]), Num::Float(3.0));
        assert_eq!(py_sum(&[]), Num::Int(0));
        // The compensated float sum: ten tenths are exactly one.
        assert_eq!(py_sum(&[Num::Float(0.1); 10]), Num::Float(1.0));
        // An empty list averages to the int 0, not 0.0.
        assert_eq!(avg(&[]).show(), "0");
        // max keeps the first of equal values (a 5 before a 5.0 prints "5").
        assert_eq!(max(&[Num::Int(5), Num::Float(5.0)]).show(), "5");
        assert_eq!(rng(&[]), "N/A");
    }

    #[test]
    fn archive_and_power_days_are_named_so_they_are_not_read_as_a_trend() {
        let mut rows: Vec<Record> = (0..4)
            .map(|i| d1_row(&format!("2026-09-0{}", i + 1), 20.0, 0.0, 0))
            .collect();
        assert!(!aggregate(&rows).contains("Data sources"));
        rows[0].source = Some("recorded".into());
        assert!(!aggregate(&rows).contains("Data sources"));
        rows[1].source = Some("open-meteo-archive".into());
        assert!(aggregate(&rows).contains(
            "Data sources: 3 days recorded live (point-in-time humidity/wind/pressure/cloud), \
             1 days from the ERA5 climate archive (24h daily means, no UV)."
        ));
        rows[2].source = Some("nasa-power".into());
        assert!(aggregate(&rows).contains("2 days from the ERA5 climate archive and NASA POWER"));
        rows[1].source = None;
        assert!(aggregate(&rows).contains("1 days from NASA POWER"));
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
