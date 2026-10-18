//! ENSO outlook: the El Niño / La Niña phase from NOAA CPC's Oceanic Niño
//! Index (ported from `api/py/_enso.py`).
//!
//! The upstream file is a plain-text table `SEAS YR TOTAL ANOM`; `ANOM` is the
//! ONI. Phase thresholds follow the CPC convention (ONI >= +0.5 El Niño,
//! <= -0.5 La Niña); strength buckets use the absolute ONI value.

use serde_json::{json, Value};

pub const ONI_URL: &str = "https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt";
/// The parsed table is cached for 12 hours (the file changes monthly).
pub const CACHE_TTL_SECONDS: u64 = 12 * 60 * 60;
pub const CACHE_KEY: &str = "enso:v1";
pub const SERIES_LENGTH: usize = 6;
pub const SOURCE_LABEL: &str = "NOAA CPC ONI";

const SEASON_CODES: [&str; 12] = [
    "DJF", "JFM", "FMA", "MAM", "AMJ", "MJJ", "JJA", "JAS", "ASO", "SON", "OND", "NDJ",
];

#[derive(Debug, Clone, PartialEq)]
pub struct Season {
    pub season: String,
    pub year: i64,
    pub oni: f64,
}

pub fn phase_for(oni: f64) -> &'static str {
    if oni >= 0.5 {
        "El Niño"
    } else if oni <= -0.5 {
        "La Niña"
    } else {
        "Neutral"
    }
}

/// `None` when the phase is Neutral.
pub fn strength_for(oni: f64) -> Option<&'static str> {
    let m = oni.abs();
    if m >= 2.0 {
        Some("very strong")
    } else if m >= 1.5 {
        Some("strong")
    } else if m >= 1.0 {
        Some("moderate")
    } else if m >= 0.5 {
        Some("weak")
    } else {
        None
    }
}

/// Parse the CPC table into chronological seasons. Header and malformed
/// lines are skipped; `Err` when no row is valid (an HTML error page or an
/// empty body is a failure, not an empty series).
pub fn parse_oni_text(text: &str) -> Result<Vec<Season>, &'static str> {
    let mut out = Vec::new();
    for line in text.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() != 4 || !SEASON_CODES.contains(&parts[0]) {
            continue;
        }
        let (Ok(year), Ok(oni)) = (parts[1].parse::<i64>(), parts[3].parse::<f64>()) else {
            continue;
        };
        out.push(Season {
            season: parts[0].to_owned(),
            year,
            oni,
        });
    }
    if out.is_empty() {
        Err("No ONI rows found in NOAA CPC response")
    } else {
        Ok(out)
    }
}

fn season_json(s: &Season) -> Value {
    json!({"season": s.season, "year": s.year, "oni": s.oni})
}

/// The response payload: the latest season plus the tail as a series.
pub fn build_outlook(seasons: &[Season], fetched_at: &str) -> Value {
    let latest = &seasons[seasons.len() - 1];
    let tail = &seasons[seasons.len().saturating_sub(SERIES_LENGTH)..];
    json!({
        "available": true,
        "season": latest.season,
        "year": latest.year,
        "oni": latest.oni,
        "phase": phase_for(latest.oni),
        "strength": strength_for(latest.oni),
        "series": tail.iter().map(season_json).collect::<Vec<_>>(),
        "source": SOURCE_LABEL,
        "fetchedAt": fetched_at,
    })
}

/// `{"available": false, ...}` with every other field null, as FastAPI sends it.
pub fn unavailable() -> Value {
    json!({
        "available": false,
        "season": null,
        "year": null,
        "oni": null,
        "phase": null,
        "strength": null,
        "series": [],
        "source": SOURCE_LABEL,
        "fetchedAt": null,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TABLE: &str = "  SEAS  YR   TOTAL   ANOM\n  DJF 2024  27.00  1.70\n  JFM 2024  27.20  1.50\n  FMA 2024  27.50  1.10\n  MAM 2024  27.80  0.60\n  AMJ 2024  28.00  0.30\n  MJJ 2024  28.00 -0.10\n  JJA 2024  27.00 -0.50\n  garbage line\n";

    #[test]
    fn phases_and_strengths() {
        assert_eq!(phase_for(0.5), "El Niño");
        assert_eq!(phase_for(-0.5), "La Niña");
        assert_eq!(phase_for(0.49), "Neutral");
        assert_eq!(strength_for(2.0), Some("very strong"));
        assert_eq!(strength_for(-1.5), Some("strong"));
        assert_eq!(strength_for(1.0), Some("moderate"));
        assert_eq!(strength_for(0.5), Some("weak"));
        assert_eq!(strength_for(0.2), None);
    }

    #[test]
    fn parses_and_builds() {
        let seasons = parse_oni_text(TABLE).unwrap();
        assert_eq!(seasons.len(), 7);
        let out = build_outlook(&seasons, "t");
        assert_eq!(out["season"], "JJA");
        assert_eq!(out["phase"], "La Niña");
        assert_eq!(out["strength"], "weak");
        assert_eq!(out["series"].as_array().unwrap().len(), 6);
        assert_eq!(out["series"][0]["season"], "JFM");
    }

    #[test]
    fn html_is_a_failure() {
        assert!(parse_oni_text("<html>nope</html>").is_err());
        assert!(parse_oni_text("").is_err());
    }
}
