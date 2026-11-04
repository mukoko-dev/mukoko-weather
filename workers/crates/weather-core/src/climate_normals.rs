//! Climate normals from the ERA5 reanalysis (ported from `api/py/_normals.py`).
//!
//! One Open-Meteo Historical Weather request per 0.25° cell covers the whole
//! 1991–2020 period (about 11,000 daily rows). It is reduced to two 366-entry
//! day-of-year tables (mean daily maximum and minimum over a ±7-day window
//! that wraps the year end) and twelve monthly normals (mean, high, low,
//! rainfall, rainy days of 1 mm or more), plus the cell's IANA time zone and
//! model elevation. Day-of-year slots use a leap-year calendar: slot 59 is
//! Feb 29, and every other date keeps its month/day position.
//!
//! Pure: the Worker fetches, this reduces. Pinned to the Python by
//! `tests/fixtures/place-profile.json` (and, for a mean on a rounding tie,
//! `tests/fixtures/monthly-normals.json`). The means and totals are summed with
//! [`crate::normals::sum_like_python`], because the Python's builtin `sum` is
//! compensated and a plain sum differs from it in the last bit.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::normals::sum_like_python;

pub const ARCHIVE_URL: &str = "https://archive-api.open-meteo.com/v1/archive";
pub const NORMALS_START: &str = "1991-01-01";
pub const NORMALS_END: &str = "2020-12-31";
pub const NORMALS_PERIOD: &str = "1991–2020";
pub const NORMALS_SOURCE: &str = "ERA5 via Open-Meteo, 1991–2020";
/// ERA5 grid spacing; coordinates are snapped to it before fetch and cache.
pub const GRID_STEP_DEG: f64 = 0.25;
pub const HALF_WINDOW_DAYS: i64 = 7;
pub const SLOTS: usize = 366;
const DAILY_VARS: &str =
    "temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum";
/// A day with at least this much rain counts as a rainy day (WMO convention).
pub const RAINY_DAY_MM: f64 = 1.0;
/// A (year, month) needs this many days with data to enter the monthly normal.
pub const MIN_DAYS_PER_MONTH: usize = 25;

/// Python's `round(x, digits)` (round-half-even on the exact binary value),
/// through Rust's correctly rounded formatting.
pub fn round_to(x: f64, digits: usize) -> f64 {
    format!("{x:.digits$}").parse().unwrap_or(x)
}

/// Snap a coordinate to the nearest ERA5 grid cell (0.25°, half-up).
pub fn snap_to_grid(value: f64) -> f64 {
    (value / GRID_STEP_DEG + 0.5).floor() * GRID_STEP_DEG
}

/// Deterministic cache id for a snapped cell: `{lat:.2}_{lon:.2}`.
pub fn cache_key(glat: f64, glon: f64) -> String {
    format!("{glat:.2}_{glon:.2}")
}

/// Cumulative days before each month in a leap year.
const LEAP_OFFSETS: [usize; 12] = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
const LEAP_DAYS: [usize; 12] = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/// 0-based slot of a calendar month/day in the leap-year calendar.
pub fn day_slot(month: u32, day: u32) -> Option<usize> {
    let m = usize::try_from(month)
        .ok()
        .filter(|m| (1..=12).contains(m))?;
    let d = usize::try_from(day)
        .ok()
        .filter(|d| *d >= 1 && *d <= LEAP_DAYS[m - 1])?;
    Some(LEAP_OFFSETS[m - 1] + d - 1)
}

fn parse_iso(iso: &str) -> Option<(i32, u32, u32)> {
    let b = iso.as_bytes();
    if b.len() < 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    Some((
        iso.get(0..4)?.parse().ok()?,
        iso.get(5..7)?.parse().ok()?,
        iso.get(8..10)?.parse().ok()?,
    ))
}

pub fn slot_for_iso(iso: &str) -> Option<usize> {
    let (_, m, d) = parse_iso(iso)?;
    day_slot(m, d)
}

/// The archive request for a snapped cell.
pub fn archive_url(glat: f64, glon: f64) -> String {
    // Python formats the floats with `f"{x}"` (`-17.75`, `31.0`): Debug here.
    format!(
        "{ARCHIVE_URL}?latitude={glat:?}&longitude={glon:?}&start_date={NORMALS_START}&end_date={NORMALS_END}&daily={}&timezone=auto",
        DAILY_VARS.replace(',', "%2C")
    )
}

/// The `daily` block of an archive response.
#[derive(Debug, Clone, Default)]
pub struct Daily {
    pub time: Vec<String>,
    pub max: Vec<Option<f64>>,
    pub min: Vec<Option<f64>>,
    pub mean: Vec<Option<f64>>,
    pub precip: Vec<Option<f64>>,
}

/// What the response says about the cell.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ArchiveMeta {
    pub timezone: Option<String>,
    pub utc_offset_seconds: Option<i64>,
    pub elevation: Option<f64>,
}

fn series(v: Option<&Value>) -> Vec<Option<f64>> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().map(Value::as_f64).collect())
        .unwrap_or_default()
}

/// The daily block and meta of an archive response, or `None` when it has no
/// daily times.
pub fn parse_archive(data: &Value) -> Option<(Daily, ArchiveMeta)> {
    let daily = data.get("daily")?.as_object()?;
    let time: Vec<String> = daily
        .get("time")?
        .as_array()?
        .iter()
        .map(|t| t.as_str().unwrap_or("").to_owned())
        .collect();
    if time.is_empty() {
        return None;
    }
    let get = |k: &str| series(daily.get(k));
    Some((
        Daily {
            time,
            max: get("temperature_2m_max"),
            min: get("temperature_2m_min"),
            mean: get("temperature_2m_mean"),
            precip: get("precipitation_sum"),
        },
        ArchiveMeta {
            timezone: data
                .get("timezone")
                .and_then(Value::as_str)
                .map(str::to_owned),
            utc_offset_seconds: data.get("utc_offset_seconds").and_then(Value::as_i64),
            elevation: data.get("elevation").and_then(Value::as_f64),
        },
    ))
}

fn at(v: &[Option<f64>], i: usize) -> Option<f64> {
    v.get(i).copied().flatten()
}

/// Two 366-entry day-of-year tables, `(max, min)`: each slot is the mean over
/// a ±7-day circular window using every observation across all years.
pub fn compute_normal_tables(daily: &Daily) -> (Vec<Option<f64>>, Vec<Option<f64>>) {
    let mut sum_hi = [0.0_f64; SLOTS];
    let mut sum_lo = [0.0_f64; SLOTS];
    let mut cnt_hi = [0_u32; SLOTS];
    let mut cnt_lo = [0_u32; SLOTS];
    for (i, iso) in daily.time.iter().enumerate() {
        let Some(slot) = slot_for_iso(iso) else {
            continue;
        };
        if let Some(hi) = at(&daily.max, i) {
            sum_hi[slot] += hi;
            cnt_hi[slot] += 1;
        }
        if let Some(lo) = at(&daily.min, i) {
            sum_lo[slot] += lo;
            cnt_lo[slot] += 1;
        }
    }
    let mut max_table = Vec::with_capacity(SLOTS);
    let mut min_table = Vec::with_capacity(SLOTS);
    for s in 0..SLOTS as i64 {
        let (mut hi_sum, mut lo_sum) = (0.0, 0.0);
        let (mut hi_n, mut lo_n) = (0_u32, 0_u32);
        for k in -HALF_WINDOW_DAYS..=HALF_WINDOW_DAYS {
            let idx = (s + k).rem_euclid(SLOTS as i64) as usize;
            hi_sum += sum_hi[idx];
            hi_n += cnt_hi[idx];
            lo_sum += sum_lo[idx];
            lo_n += cnt_lo[idx];
        }
        max_table.push((hi_n > 0).then(|| round_to(hi_sum / f64::from(hi_n), 2)));
        min_table.push((lo_n > 0).then(|| round_to(lo_sum / f64::from(lo_n), 2)));
    }
    (max_table, min_table)
}

/// One calendar month's normals.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthlyNormal {
    pub month: u32,
    pub mean_temp_c: Option<f64>,
    pub mean_high_c: Option<f64>,
    pub mean_low_c: Option<f64>,
    pub precip_mm: Option<f64>,
    pub rainy_days: Option<f64>,
}

fn mean1(values: &[f64]) -> Option<f64> {
    (!values.is_empty()).then(|| {
        round_to(
            sum_like_python(values.iter().copied()) / values.len() as f64,
            1,
        )
    })
}

#[derive(Default)]
struct Bucket {
    t: Vec<f64>,
    hi: Vec<f64>,
    lo: Vec<f64>,
    p: Vec<f64>,
    days: usize,
}

fn avg(v: &[f64]) -> f64 {
    sum_like_python(v.iter().copied()) / v.len() as f64
}

/// Twelve monthly normals, January first. For each month: the mean of the
/// yearly means of the daily mean, high and low, and the mean yearly rainfall
/// total and rainy-day count. A (year, month) with fewer than
/// [`MIN_DAYS_PER_MONTH`] days of data is left out; the daily mean falls back
/// to (max + min) / 2. A month with no data has `None` values.
pub fn compute_monthly_normals(daily: &Daily) -> Vec<MonthlyNormal> {
    let mut buckets: BTreeMap<(i32, u32), Bucket> = BTreeMap::new();
    for (i, iso) in daily.time.iter().enumerate() {
        let Some((year, month, _)) = parse_iso(iso) else {
            continue;
        };
        let b = buckets.entry((year, month)).or_default();
        let (hi, lo, pr) = (at(&daily.max, i), at(&daily.min, i), at(&daily.precip, i));
        let mut mean = at(&daily.mean, i);
        if mean.is_none() {
            if let (Some(h), Some(l)) = (hi, lo) {
                mean = Some((h + l) / 2.0);
            }
        }
        if mean.is_none() && pr.is_none() {
            continue;
        }
        b.days += 1;
        if let Some(m) = mean {
            b.t.push(m);
        }
        if let Some(h) = hi {
            b.hi.push(h);
        }
        if let Some(l) = lo {
            b.lo.push(l);
        }
        if let Some(p) = pr {
            b.p.push(p);
        }
    }
    #[derive(Default)]
    struct Acc {
        t: Vec<f64>,
        hi: Vec<f64>,
        lo: Vec<f64>,
        p: Vec<f64>,
        rd: Vec<f64>,
    }
    let mut per_month: Vec<Acc> = (0..12).map(|_| Acc::default()).collect();
    for ((_, month), b) in &buckets {
        if b.days < MIN_DAYS_PER_MONTH {
            continue;
        }
        let acc = &mut per_month[(*month - 1) as usize];
        if !b.t.is_empty() {
            acc.t.push(avg(&b.t));
        }
        if !b.hi.is_empty() {
            acc.hi.push(avg(&b.hi));
        }
        if !b.lo.is_empty() {
            acc.lo.push(avg(&b.lo));
        }
        if b.p.len() >= MIN_DAYS_PER_MONTH {
            acc.p.push(sum_like_python(b.p.iter().copied()));
            acc.rd
                .push(b.p.iter().filter(|v| **v >= RAINY_DAY_MM).count() as f64);
        }
    }
    per_month
        .iter()
        .enumerate()
        .map(|(i, a)| MonthlyNormal {
            month: i as u32 + 1,
            mean_temp_c: mean1(&a.t),
            mean_high_c: mean1(&a.hi),
            mean_low_c: mean1(&a.lo),
            precip_mm: mean1(&a.p),
            rainy_days: mean1(&a.rd),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../../../tests/fixtures/place-profile.json");

    fn fx() -> Value {
        serde_json::from_str(FIXTURE).unwrap()
    }

    fn f(v: &Value) -> f64 {
        v.as_f64().unwrap()
    }

    fn daily_from(v: &Value) -> Daily {
        let col = |k: &str| series(v.get(k));
        Daily {
            time: v["time"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| t.as_str().unwrap().to_owned())
                .collect(),
            max: col("temperature_2m_max"),
            min: col("temperature_2m_min"),
            mean: col("temperature_2m_mean"),
            precip: col("precipitation_sum"),
        }
    }

    #[test]
    fn cells_snap_and_key_like_python() {
        for c in fx()["snap"].as_array().unwrap() {
            let s = snap_to_grid(f(&c["in"]));
            assert_eq!(s, f(&c["out"]), "{c}");
            assert_eq!(cache_key(s, s), c["key"].as_str().unwrap());
        }
    }

    #[test]
    fn slots_use_the_leap_year_calendar() {
        for c in fx()["slots"].as_array().unwrap() {
            let slot = day_slot(
                c["m"].as_u64().unwrap() as u32,
                c["d"].as_u64().unwrap() as u32,
            );
            assert_eq!(slot, Some(c["slot"].as_u64().unwrap() as usize), "{c}");
        }
        assert_eq!(day_slot(2, 30), None);
        assert_eq!(day_slot(13, 1), None);
        assert_eq!(slot_for_iso("2021-02-28"), Some(58));
        assert_eq!(slot_for_iso("not a date"), None);
    }

    #[test]
    fn the_day_of_year_tables_match_python() {
        let x = fx();
        let (max, min) = compute_normal_tables(&daily_from(&x["daily"]));
        for (got, want) in [(&max, &x["tables"]["max"]), (&min, &x["tables"]["min"])] {
            let want = want.as_array().unwrap();
            assert_eq!(got.len(), want.len());
            for (g, w) in got.iter().zip(want) {
                assert_eq!(*g, w.as_f64());
            }
        }
    }

    #[test]
    fn the_monthly_normals_match_python() {
        let x = fx();
        let got = compute_monthly_normals(&daily_from(&x["daily"]));
        assert_eq!(serde_json::to_value(&got).unwrap(), x["monthly"]);
        // Max and min only: the daily mean is (max + min) / 2.
        let d = &x["monthlyNoMean"];
        let got = compute_monthly_normals(&daily_from(&d["daily"]));
        assert_eq!(serde_json::to_value(&got).unwrap(), d["out"]);
    }

    /// The same tie payload `normals::compute_monthly_normals` is pinned to
    /// (`tests/fixtures/monthly-normals.json`, generated by the Python): the
    /// mean January rainfall is 231.6 with the Python's compensated `sum()`,
    /// 231.5 with a plain sum.
    #[test]
    fn a_mean_on_a_rounding_tie_matches_python() {
        let x: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/monthly-normals.json"
        ))
        .unwrap();
        let tie = &x["tie"];
        let got = compute_monthly_normals(&daily_from(&tie["daily"]));
        assert_eq!(got[0].precip_mm, Some(231.6));
        assert_eq!(serde_json::to_value(&got).unwrap(), tie["expected"]);
    }

    #[test]
    fn the_archive_request_names_the_cell_and_the_period() {
        let url = archive_url(-17.75, 31.0);
        assert!(url.starts_with("https://archive-api.open-meteo.com/v1/archive?"));
        for part in [
            "latitude=-17.75",
            "longitude=31.0",
            "start_date=1991-01-01",
            "end_date=2020-12-31",
            "daily=temperature_2m_max%2Ctemperature_2m_min%2Ctemperature_2m_mean%2Cprecipitation_sum",
            "timezone=auto",
        ] {
            assert!(url.contains(part), "{part} in {url}");
        }
        assert!(archive_url(0.0, -0.25).contains("latitude=0.0&longitude=-0.25"));
    }

    #[test]
    fn an_archive_response_parses_with_its_meta() {
        let body = serde_json::json!({
            "timezone": "Africa/Harare", "utc_offset_seconds": 7200, "elevation": 1490.0,
            "daily": {"time": ["2000-01-01"], "temperature_2m_max": [30.1],
                      "temperature_2m_min": [null], "temperature_2m_mean": [], "precipitation_sum": [0.0]}
        });
        let (daily, meta) = parse_archive(&body).unwrap();
        assert_eq!(daily.time, ["2000-01-01"]);
        assert_eq!(daily.max, [Some(30.1)]);
        assert_eq!(daily.min, [None]);
        assert!(daily.mean.is_empty());
        assert_eq!(meta.timezone.as_deref(), Some("Africa/Harare"));
        assert_eq!(meta.utc_offset_seconds, Some(7200));
        assert_eq!(meta.elevation, Some(1490.0));
        assert!(parse_archive(&serde_json::json!({"daily": {"time": []}})).is_none());
        assert!(parse_archive(&serde_json::json!({})).is_none());
    }
}
