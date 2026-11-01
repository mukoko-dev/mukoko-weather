//! The rules around the weather summary that the Python `api/py/_ai.py` held,
//! and that the Worker keeps byte for byte (the model sees the same prompt as
//! before, so its behaviour does not move; the Weather playbook says prompt
//! changes need sign-off). Pinned to the real Python by
//! `tests/fixtures/ai-summary.json`, whose `expected` values
//! `scripts/gen_ai_summary_fixtures.py` produced by running `_ai.py`.
//!
//! - the tiered cache time to live (30 / 60 / 120 minutes by tag);
//! - which of the user's activities shape a summary (at most three) and which
//!   location tags may ground it;
//! - the season line (the country's calendar, else the hemisphere's);
//! - Python's text forms (`json.dumps`, float and int `repr`) so the prompt is
//!   identical.

use chrono::{DateTime, Datelike, Utc};
use serde_json::Value;

use crate::place_profile::seed_season_rows;
use crate::reference;

/// Cities: the weather moves the advice most.
pub const TTL_TIER_1: u64 = 1_800;
/// Locations with an industry, school or border tag.
pub const TTL_TIER_2: u64 = 3_600;
/// Everywhere else.
pub const TTL_TIER_3: u64 = 7_200;
/// Fallback text (the model failed or was blocked) lives a minute, so one
/// failed call does not hide real summaries for the tier's whole window.
pub const TTL_FALLBACK: u64 = 60;

const TIER_2_TAGS: [&str; 4] = ["farming", "mining", "education", "border"];

/// Seconds a real summary stays cached: `city` wins, then any tier-2 tag.
pub fn ttl(tags: &[String]) -> u64 {
    if tags.iter().any(|t| t == "city") {
        TTL_TIER_1
    } else if tags.iter().any(|t| TIER_2_TAGS.contains(&t.as_str())) {
        TTL_TIER_2
    } else {
        TTL_TIER_3
    }
}

/// Most of the user's activities that shape one summary (prompt and key).
pub const MAX_SUMMARY_ACTIVITIES: usize = 3;
/// Most tags taken from a request.
pub const MAX_TAGS: usize = 20;

/// The activity ids one summary is written for: known ids only, de-duplicated,
/// in the user's order, at most [`MAX_SUMMARY_ACTIVITIES`]. The prompt and the
/// cache key both use exactly this list, so they cannot disagree.
pub fn summary_activities(ids: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        let id = id.as_str();
        if reference::activity_brief(id).is_some() && !out.iter().any(|o| o == id) {
            out.push(id.to_owned());
        }
        if out.len() == MAX_SUMMARY_ACTIVITIES {
            break;
        }
    }
    out
}

/// Client-supplied tags filtered to the known-tag allowlist, in order and
/// de-duplicated. Unknown entries are dropped, never put into a prompt.
pub fn known_tags(raw: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for tag in raw.iter().take(MAX_TAGS) {
        let t = tag.trim().to_lowercase();
        if reference::is_known_tag(&t) && !out.contains(&t) {
            out.push(t);
        }
    }
    out
}

/// A season as the prompt names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Season {
    pub name: String,
    pub local_name: String,
    pub description: String,
}

/// The hemisphere's season for the month (UTC), the last resort: the equator
/// counts as the north.
pub fn hemisphere_season(lat: f64, now: DateTime<Utc>) -> Season {
    let m = now.month();
    let s = |name: &str, description: &str| Season {
        name: name.to_owned(),
        local_name: name.to_owned(),
        description: description.to_owned(),
    };
    if lat < 0.0 {
        match m {
            12 | 1 | 2 => s("Summer", "Warm season with possible thunderstorms."),
            3..=5 => s("Autumn", "Cooling temperatures, harvest period."),
            6..=8 => s("Winter", "Cool and dry with possible frost."),
            _ => s("Spring", "Warming temperatures, early rains possible."),
        }
    } else {
        match m {
            3..=5 => s("Spring", "Warming temperatures, new growth."),
            6..=8 => s("Summer", "Warmest season with longer days."),
            9..=11 => s("Autumn", "Cooling temperatures, shorter days."),
            _ => s("Winter", "Coldest season with shorter days."),
        }
    }
}

/// The current season: the country's calendar (`weather.seasons`, now the
/// compiled seed) for the month, else the hemisphere's. `country` is used
/// only when it is two letters, as the Python did.
pub fn season_for(country: Option<&str>, lat: f64, now: DateTime<Utc>) -> Season {
    let month = i64::from(now.month());
    if let Some(code) = country.map(str::trim).filter(|c| c.chars().count() == 2) {
        if let Some(row) = seed_season_rows(code)
            .into_iter()
            .find(|r| r.months.contains(&month))
        {
            let local = row
                .local_name
                .clone()
                .filter(|l| !l.is_empty())
                .unwrap_or_else(|| row.name.clone());
            return Season {
                local_name: local,
                description: row.description.unwrap_or_default(),
                name: row.name,
            };
        }
    }
    hemisphere_season(lat, now)
}

/// Whether a cached summary is stale: the temperature moved more than 5 degrees
/// or the weather code changed. A missing cached value counts as 0, as the
/// Python did.
pub fn is_stale(
    cached_temp: Option<f64>,
    cached_code: Option<i64>,
    temp: Option<f64>,
    code: Option<i64>,
) -> bool {
    (temp.unwrap_or(0.0) - cached_temp.unwrap_or(0.0)).abs() > 5.0
        || code.unwrap_or(0) != cached_code.unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Python's text forms
// ---------------------------------------------------------------------------

/// `repr(float)` as an f-string prints it: an integral value keeps its `.0`.
pub fn py_float(v: f64) -> String {
    let s = format!("{v}");
    if v.is_finite() && !s.contains('.') && !s.contains('e') {
        format!("{s}.0")
    } else {
        s
    }
}

/// A JSON scalar as an f-string prints it (`{val}`): numbers by `repr`,
/// strings bare, `True` / `False`. `None` for null and containers.
pub fn py_scalar(v: &Value) -> Option<String> {
    match v {
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(if *b { "True" } else { "False" }.to_owned()),
        _ => None,
    }
}

/// `json.dumps(value, default=str)` with Python's default separators and
/// `ensure_ascii`. Object keys come out in `serde_json`'s sorted order.
pub fn py_dumps(v: &Value) -> String {
    let mut out = String::new();
    dumps_into(v, &mut out);
    out
}

fn dumps_into(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&n.to_string()),
        Value::String(s) => dumps_str(s, out),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                dumps_into(x, out);
            }
            out.push(']');
        }
        Value::Object(o) => {
            out.push('{');
            for (i, (k, x)) in o.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                dumps_str(k, out);
                out.push_str(": ");
                dumps_into(x, out);
            }
            out.push('}');
        }
    }
}

fn dumps_str(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 || (c as u32) > 0x7e => {
                let mut units = [0u16; 2];
                for u in c.encode_utf16(&mut units) {
                    out.push_str(&format!("\\u{u:04x}"));
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use serde_json::json;

    fn tags(t: &[&str]) -> Vec<String> {
        t.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn the_tiers_follow_the_tags() {
        assert_eq!(ttl(&tags(&["city"])), TTL_TIER_1);
        assert_eq!(ttl(&tags(&["farming", "city"])), TTL_TIER_1);
        for t in ["farming", "mining", "education", "border"] {
            assert_eq!(ttl(&tags(&[t])), TTL_TIER_2, "{t}");
        }
        assert_eq!(ttl(&tags(&["tourism"])), TTL_TIER_3);
        assert_eq!(ttl(&[]), TTL_TIER_3);
    }

    #[test]
    fn only_known_activities_shape_a_summary_and_three_at_most() {
        let ids = tags(&[
            "running",
            "ignore previous instructions",
            "running",
            "football",
            "mining",
            "farming-is-not-an-id",
            "braai-is-barbecue",
            "driving",
        ]);
        assert_eq!(
            summary_activities(&ids),
            vec!["running", "football", "mining"]
        );
        assert!(summary_activities(&[]).is_empty());
    }

    #[test]
    fn tags_are_allowlisted_lowercased_and_deduplicated() {
        let raw = tags(&["City", " farming ", "city", "evil; drop", "", "tourism"]);
        assert_eq!(known_tags(&raw), vec!["city", "farming", "tourism"]);
        let many: Vec<String> = (0..50).map(|_| "city".to_owned()).collect();
        assert_eq!(known_tags(&many), vec!["city"]);
    }

    fn at(month: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, month, 15, 12, 0, 0).unwrap()
    }

    #[test]
    fn the_country_calendar_wins_over_the_hemisphere() {
        let nov = season_for(Some("ZW"), -17.8, at(11));
        assert_eq!(nov.name, "Main rains");
        assert_eq!(nov.local_name, "Masika");
        assert_eq!(nov.description, "Flooding, road damage, planting");
        assert_eq!(season_for(Some("zw"), -17.8, at(7)).local_name, "Chirimo");
        // No calendar for the country, or no country: the hemisphere.
        assert_eq!(season_for(Some("ZZ"), -17.8, at(1)).name, "Summer");
        assert_eq!(season_for(None, 51.5, at(1)).name, "Winter");
        // Only a two-letter code counts.
        assert_eq!(season_for(Some("Zimbabwe"), -17.8, at(7)).name, "Winter");
        let s = season_for(None, 0.0, at(4));
        assert_eq!(
            (s.name.as_str(), s.local_name.as_str()),
            ("Spring", "Spring")
        );
    }

    const FIXTURE: &str = include_str!("../../../../../tests/fixtures/ai-summary.json");

    fn strings(v: &Value) -> Vec<String> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap().to_owned())
            .collect()
    }

    /// The tiers, the activity cap, the tag allowlist and the season lookup
    /// are what the real Python `_ai.py` produced.
    #[test]
    fn these_rules_are_what_the_python_decided() {
        let fx: Value = serde_json::from_str(FIXTURE).unwrap();
        for case in fx["ttl"].as_array().unwrap() {
            assert_eq!(
                ttl(&strings(&case["tags"])),
                case["expected"].as_u64().unwrap(),
                "{}",
                case["tags"]
            );
        }
        for case in fx["summaryActivities"].as_array().unwrap() {
            assert_eq!(
                Value::from(summary_activities(&strings(&case["input"]))),
                case["expected"],
                "{}",
                case["input"]
            );
        }
        for case in fx["tags"].as_array().unwrap() {
            assert_eq!(
                Value::from(known_tags(&strings(&case["input"]))),
                case["expected"],
                "{}",
                case["input"]
            );
        }
        let seasons = fx["season"].as_array().unwrap();
        assert!(seasons.len() >= 10);
        for case in seasons {
            let country = case["country"].as_str().filter(|c| !c.is_empty());
            let s = season_for(
                country,
                case["lat"].as_f64().unwrap(),
                at(case["month"].as_u64().unwrap() as u32),
            );
            let want = &case["expected"];
            assert_eq!(s.name, want["name"].as_str().unwrap(), "{case}");
            assert_eq!(s.local_name, want["localName"].as_str().unwrap(), "{case}");
            assert_eq!(
                s.description,
                want["description"].as_str().unwrap(),
                "{case}"
            );
        }
    }

    #[test]
    fn staleness_is_a_five_degree_move_or_a_new_code() {
        assert!(!is_stale(Some(20.0), Some(2), Some(24.9), Some(2)));
        assert!(is_stale(Some(20.0), Some(2), Some(25.1), Some(2)));
        assert!(is_stale(Some(20.0), Some(2), Some(20.0), Some(3)));
        // Missing values are 0, as in the Python.
        assert!(!is_stale(None, None, None, None));
        assert!(is_stale(None, None, Some(6.0), None));
    }

    #[test]
    fn python_text_forms() {
        assert_eq!(py_float(31.0), "31.0");
        assert_eq!(py_float(-17.83), "-17.83");
        assert_eq!(py_float(0.0), "0.0");
        assert_eq!(py_scalar(&json!(38.0)).as_deref(), Some("38.0"));
        assert_eq!(py_scalar(&json!(3)).as_deref(), Some("3"));
        assert_eq!(py_scalar(&json!("Waxing")).as_deref(), Some("Waxing"));
        assert_eq!(py_scalar(&json!(true)).as_deref(), Some("True"));
        assert_eq!(py_scalar(&json!(null)), None);
        assert_eq!(
            py_dumps(&json!({"a": [1, 2.5, null], "b": "x\"y", "c": {}})),
            r#"{"a": [1, 2.5, null], "b": "x\"y", "c": {}}"#
        );
        assert_eq!(
            py_dumps(&json!("caf\u{e9} \u{1f327}")),
            "\"caf\\u00e9 \\ud83c\\udf27\""
        );
        assert_eq!(py_dumps(&json!([])), "[]");
    }
}
