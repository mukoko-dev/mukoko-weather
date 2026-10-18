//! Climate normals: the average daily high/low for a calendar day at a place
//! (ported from `api/py/_normals.py`). ERA5 via Open-Meteo's Historical
//! Weather API over 1991–2020, snapped to a 0.25° cell, reduced to two
//! 366-entry day-of-year tables (±7-day circular window).

use chrono::{Datelike, NaiveDate};
use serde_json::{json, Value};

pub const ARCHIVE_URL: &str = "https://archive-api.open-meteo.com/v1/archive";
pub const NORMALS_START: &str = "1991-01-01";
pub const NORMALS_END: &str = "2020-12-31";
pub const NORMALS_PERIOD: &str = "1991–2020";
pub const NORMALS_SOURCE: &str = "ERA5 via Open-Meteo, 1991–2020";
pub const GRID_STEP_DEG: f64 = 0.25;
pub const HALF_WINDOW_DAYS: i64 = 7;
pub const SLOTS: usize = 366;
pub const DAILY_VARS: &str = "temperature_2m_max,temperature_2m_min";

/// Snap a coordinate to the nearest ERA5 cell (0.25°, half up).
pub fn snap_to_grid(v: f64) -> f64 {
    (v / GRID_STEP_DEG + 0.5).floor() * GRID_STEP_DEG
}

/// `{lat:.2f}_{lon:.2f}` of the snapped cell.
pub fn cache_key(glat: f64, glon: f64) -> String {
    format!("normals:v1:{glat:.2}_{glon:.2}")
}

/// 0-based slot in the leap-year calendar: Jan 1 is 0, Feb 29 is 59,
/// Mar 1 is 60 in every year, Dec 31 is 365.
pub fn day_slot(month: u32, day: u32) -> Option<usize> {
    NaiveDate::from_ymd_opt(2000, month, day).map(|d| d.ordinal0() as usize)
}

pub fn slot_for_iso(iso: &str) -> Option<usize> {
    let d = NaiveDate::parse_from_str(iso.get(..10)?, "%Y-%m-%d").ok()?;
    day_slot(d.month(), d.day())
}

fn round_to(v: f64, places: i32) -> f64 {
    let f = 10f64.powi(places);
    (v * f).round_ties_even() / f
}

/// Reduce an Open-Meteo `daily` block to `(max_table, min_table)`: the mean
/// over a ±`HALF_WINDOW_DAYS` circular window using every observation in it,
/// `None` values skipped, a slot with no observation `None`.
pub fn compute_normal_tables(daily: &Value) -> (Vec<Option<f64>>, Vec<Option<f64>>) {
    let empty = Vec::new();
    let times = daily["time"].as_array().unwrap_or(&empty);
    let highs = daily["temperature_2m_max"].as_array().unwrap_or(&empty);
    let lows = daily["temperature_2m_min"].as_array().unwrap_or(&empty);
    let (mut sum_hi, mut sum_lo) = (vec![0.0f64; SLOTS], vec![0.0f64; SLOTS]);
    let (mut cnt_hi, mut cnt_lo) = (vec![0u32; SLOTS], vec![0u32; SLOTS]);
    for (i, t) in times.iter().enumerate() {
        let Some(slot) = t.as_str().and_then(slot_for_iso) else {
            continue;
        };
        if let Some(h) = highs.get(i).and_then(Value::as_f64) {
            sum_hi[slot] += h;
            cnt_hi[slot] += 1;
        }
        if let Some(l) = lows.get(i).and_then(Value::as_f64) {
            sum_lo[slot] += l;
            cnt_lo[slot] += 1;
        }
    }
    let (mut max_t, mut min_t) = (Vec::with_capacity(SLOTS), Vec::with_capacity(SLOTS));
    for s in 0..SLOTS as i64 {
        let (mut hs, mut ls, mut hn, mut ln) = (0.0, 0.0, 0u32, 0u32);
        for k in -HALF_WINDOW_DAYS..=HALF_WINDOW_DAYS {
            let idx = (s + k).rem_euclid(SLOTS as i64) as usize;
            hs += sum_hi[idx];
            hn += cnt_hi[idx];
            ls += sum_lo[idx];
            ln += cnt_lo[idx];
        }
        max_t.push((hn > 0).then(|| round_to(hs / f64::from(hn), 2)));
        min_t.push((ln > 0).then(|| round_to(ls / f64::from(ln), 2)));
    }
    (max_t, min_t)
}

/// The archive request for a snapped cell.
pub fn archive_url(glat: f64, glon: f64) -> String {
    format!(
        "{ARCHIVE_URL}?latitude={glat}&longitude={glon}&start_date={NORMALS_START}&end_date={NORMALS_END}&daily={DAILY_VARS}&timezone=auto"
    )
}

/// A target date (`YYYY-MM-DD`); `None` for malformed input.
pub fn parse_target_date(raw: &str) -> Option<String> {
    NaiveDate::parse_from_str(raw, "%Y-%m-%d")
        .ok()
        .map(|d| d.format("%Y-%m-%d").to_string())
}

pub fn unavailable(lat: f64, lon: f64, date: &str, reason: &str) -> Value {
    json!({
        "available": false,
        "lat": lat,
        "lon": lon,
        "date": date,
        "normalHigh": null,
        "normalLow": null,
        "period": NORMALS_PERIOD,
        "source": NORMALS_SOURCE,
        "computedAt": null,
        "reason": reason,
    })
}

/// The answer for one day from the two tables.
pub fn respond(
    lat: f64,
    lon: f64,
    date: &str,
    slot: usize,
    max_t: &[Option<f64>],
    min_t: &[Option<f64>],
    computed_at: Option<&str>,
) -> Value {
    let hi = max_t.get(slot).copied().flatten();
    let lo = min_t.get(slot).copied().flatten();
    let (Some(hi), Some(lo)) = (hi, lo) else {
        return unavailable(lat, lon, date, "no_data");
    };
    json!({
        "available": true,
        "lat": lat,
        "lon": lon,
        "date": date,
        "normalHigh": round_to(hi, 1),
        "normalLow": round_to(lo, 1),
        "period": NORMALS_PERIOD,
        "source": NORMALS_SOURCE,
        "computedAt": computed_at,
        "reason": null,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snaps_half_up() {
        assert_eq!(snap_to_grid(-17.83), -17.75);
        assert_eq!(snap_to_grid(31.05), 31.0);
        assert_eq!(snap_to_grid(0.125), 0.25);
        assert_eq!(snap_to_grid(-0.125), 0.0);
    }

    #[test]
    fn slots_use_the_leap_calendar() {
        assert_eq!(day_slot(1, 1), Some(0));
        assert_eq!(day_slot(2, 28), Some(58));
        assert_eq!(day_slot(2, 29), Some(59));
        assert_eq!(day_slot(3, 1), Some(60));
        assert_eq!(day_slot(12, 31), Some(365));
        assert_eq!(slot_for_iso("2021-03-01"), Some(60));
        assert_eq!(slot_for_iso("nope"), None);
    }

    #[test]
    fn windowed_means_wrap_the_year_end() {
        let daily = json!({
            "time": ["1991-01-01", "1991-12-31"],
            "temperature_2m_max": [30.0, 20.0],
            "temperature_2m_min": [10.0, null],
        });
        let (hi, lo) = compute_normal_tables(&daily);
        // Dec 31 and Jan 1 are neighbours, so each slot averages both highs.
        assert_eq!(hi[0], Some(25.0));
        assert_eq!(hi[365], Some(25.0));
        assert_eq!(lo[0], Some(10.0));
        assert_eq!(hi[180], None);
        assert_eq!(hi.len(), SLOTS);
    }

    #[test]
    fn responds_or_reports_no_data() {
        let t = vec![Some(25.04); SLOTS];
        let ok = respond(1.0, 2.0, "2026-10-18", 290, &t, &t, Some("c"));
        assert_eq!(ok["normalHigh"], 25.0);
        let none = respond(1.0, 2.0, "2026-10-18", 290, &vec![None; SLOTS], &t, None);
        assert_eq!(none["reason"], "no_data");
        assert_eq!(parse_target_date("2026-02-30"), None);
    }
}
