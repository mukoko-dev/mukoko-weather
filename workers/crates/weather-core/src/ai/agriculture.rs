//! The agriculture explanation: the AI Worker turns the deterministic farm
//! data (`weather_core::agriculture`, the forecast Worker's `/agriculture`)
//! into a sentence for the snapshot card (`snapshot`) or an agronomy briefing
//! (`briefing`). The model explains the numbers; it never produces them.
//!
//! Ported from `api/py/_agriculture.py` (`data_brief`, `fallback_text`,
//! `farming_activities`, the user prompt of `agriculture_ai`) and pinned to it
//! by `tests/fixtures/ai-agriculture.json`, whose `expected` values
//! `scripts/gen_ai_agriculture_fixtures.py` produced by running that Python
//! over the answers pinned in `tests/fixtures/agriculture-analysis.json`.
//!
//! The farm data is handled as JSON (`serde_json::Value`): it is the forecast
//! Worker's own answer, and only a few fields are read.

use serde_json::Value;

use crate::reference;

/// A real answer stays cached an hour; the fallback text a minute.
pub const AI_CACHE_TTL: u64 = 3_600;
pub const FALLBACK_TTL: u64 = 60;
/// Most crops (farming activities) one explanation is written for.
pub const MAX_CROPS: usize = 5;
/// Most activity ids read from a request.
pub const MAX_REQUEST_ACTIVITIES: usize = 20;

/// The capability the billing work (nyuchi/nyuchi-api) will check before paid
/// AI features. Not enforced yet: see [`entitled`].
pub const CAPABILITY: &str = "weather.agri_insights";

/// Which text is wanted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// One sentence of at most 30 words for the card on the location page.
    Snapshot,
    /// A longer briefing for the agriculture page.
    Briefing,
}

impl Mode {
    pub fn parse(raw: &str) -> Option<Mode> {
        match raw {
            "snapshot" => Some(Mode::Snapshot),
            "briefing" => Some(Mode::Briefing),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Snapshot => "snapshot",
            Mode::Briefing => "briefing",
        }
    }

    fn prompt_key(self) -> &'static str {
        match self {
            Mode::Snapshot => "system:agriculture_snapshot",
            Mode::Briefing => "system:agriculture_briefing",
        }
    }

    fn default_max_tokens(self) -> u32 {
        match self {
            Mode::Snapshot => 120,
            Mode::Briefing => 700,
        }
    }
}

/// The system prompt and its output budget for a mode (the seed documents in
/// `data/reference/ai-prompts.json`, as the Python read them from MongoDB).
pub fn system_prompt(mode: Mode) -> Option<(&'static str, u32)> {
    let (template, max_tokens) = reference::ai_prompt(mode.prompt_key())?;
    Some((
        template,
        max_tokens.unwrap_or_else(|| mode.default_max_tokens()),
    ))
}

/// Entitlement hook for the paid agriculture AI ([`CAPABILITY`]). The billing
/// service is not built yet, so every signed-in caller is allowed. When it
/// ships, check the person's capability here and return `false` to serve the
/// deterministic fallback instead of model text. The caller runs this BEFORE
/// the AI cache is read, so cached model text can never reach an unentitled
/// caller.
pub fn entitled(_person: Option<&str>) -> bool {
    true
}

/// Known activity ids in the farming category, de-duplicated, in the user's
/// order, at most [`MAX_CROPS`]. Read from the first
/// [`MAX_REQUEST_ACTIVITIES`] entries of the request.
pub fn farming_activities(ids: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids.iter().take(MAX_REQUEST_ACTIVITIES) {
        let is_farming = reference::activity_brief(id).is_some_and(|b| b.category == "farming");
        if is_farming && !out.iter().any(|o| o == id) {
            out.push(id.clone());
        }
        if out.len() == MAX_CROPS {
            break;
        }
    }
    out
}

/// The cache key of an explanation: the place (`place_identity`'s key part),
/// the mode and the sorted crops.
pub fn cache_key(place: &str, mode: Mode, crops: &[String]) -> String {
    let mut sorted = crops.to_vec();
    sorted.sort();
    format!("agri-ai:v1:{place}:{}:{}", mode.as_str(), sorted.join(","))
}

// ---------------------------------------------------------------------------
// Reading the farm data
// ---------------------------------------------------------------------------

fn text<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn number(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}

/// `_fmt`: `n/a` for a missing value, else the number to `digits` places and
/// the unit.
fn fmt(value: Option<f64>, unit: &str, digits: usize) -> String {
    match value {
        Some(v) => format!("{v:.digits$}{unit}"),
        None => "n/a".to_owned(),
    }
}

/// Python's `str(None)` for a field the model always fills when the data is
/// available.
fn or_none(v: Option<&str>) -> &str {
    v.unwrap_or("None")
}

fn present(v: &Value) -> bool {
    v.is_object()
}

/// Compact, numbers-only description of the farm data for the prompt.
pub fn data_brief(data: &Value) -> String {
    let mut lines = vec![format!("Verdict: {}", or_none(text(data, "headline")))];
    let w = &data["windows"];
    if present(w) {
        for (key, name) in [
            ("spray", "Spray"),
            ("plant", "Plant"),
            ("harvest", "Harvest"),
            ("irrigate", "Irrigate"),
        ] {
            let fw = &w[key];
            lines.push(format!(
                "{name}: {} — {}. {}",
                or_none(text(fw, "status")),
                or_none(text(fw, "label")),
                or_none(text(fw, "detail"))
            ));
        }
    }
    let r = &data["rain"];
    if present(r) {
        lines.push(format!(
            "Rain: next 24h {}, next 7 days {} ({} rainy days), past 30 days {}.",
            fmt(number(r, "next24hMm"), " mm", 1),
            fmt(number(r, "next7dMm"), " mm", 1),
            r.get("rainyDaysNext7").and_then(Value::as_i64).unwrap_or(0),
            fmt(number(r, "past30dMm"), " mm", 1)
        ));
    }
    let s = &data["soil"];
    if present(s) {
        lines.push(format!(
            "Soil: topsoil moisture {} ({}), root zone {}, seed-depth temperature {}.",
            fmt(number(s, "moistureTopsoil"), " m3/m3", 2),
            text(s, "moistureBand").unwrap_or("n/a"),
            fmt(number(s, "moistureRootZone"), " m3/m3", 2),
            fmt(number(s, "temperatureSeedDepth"), " C", 1)
        ));
    }
    let wb = &data["waterBalance"];
    if present(wb) {
        lines.push(format!(
            "Water balance next 7 days: ET0 {} vs rain {} = {} ({}).",
            fmt(number(wb, "et0Next7dMm"), " mm", 0),
            fmt(number(wb, "rainNext7dMm"), " mm", 0),
            fmt(number(wb, "balanceNext7dMm"), " mm", 0),
            text(wb, "status").unwrap_or("n/a")
        ));
    }
    let g = &data["gdd"];
    if present(g) {
        lines.push(format!(
            "GDD (base 10): past 30 days {}, next 7 days {}.",
            fmt(number(g, "past30d"), "", 0),
            fmt(number(g, "next7d"), "", 0)
        ));
    }
    let rk = &data["risks"];
    if present(rk) {
        lines.push(format!(
            "Frost: {} — {} Heat: {} — {}",
            or_none(text(&rk["frost"], "level")),
            or_none(text(&rk["frost"], "detail")),
            or_none(text(&rk["heat"], "level")),
            or_none(text(&rk["heat"], "detail"))
        ));
    }
    if let Some(calendar) = data["calendar"].as_array() {
        for c in calendar {
            lines.push(format!(
                "Crop calendar: {} is in its {} phase.",
                or_none(text(c, "label")),
                text(c, "phase")
                    .filter(|p| !p.is_empty())
                    .unwrap_or("unknown")
            ));
        }
    }
    let p = &data["profile"];
    if present(p) {
        lines.push(format!(
            "Climate: Koppen {}, normal high/low for this time of year {}/{}, ENSO {}.",
            text(p, "koppen").filter(|k| !k.is_empty()).unwrap_or("n/a"),
            fmt(number(p, "normalHigh"), " C", 0),
            fmt(number(p, "normalLow"), " C", 0),
            text(p, "ensoPhase")
                .filter(|k| !k.is_empty())
                .unwrap_or("n/a")
        ));
    }
    let wet: Vec<String> = data["daily"]
        .as_array()
        .map(|days| {
            days.iter()
                .filter(|d| d["forecast"].as_bool() == Some(true))
                .filter_map(|d| d.get("leafWetHours").and_then(Value::as_i64))
                .take(3)
                .map(|h| h.to_string())
                .collect()
        })
        .unwrap_or_default();
    if !wet.is_empty() {
        lines.push(format!("Leaf-wet hours next 3 days: {}.", wet.join(", ")));
    }
    lines.join("\n")
}

/// Deterministic text for when the model is unavailable, empty or not
/// entitled.
pub fn fallback_text(data: &Value, mode: Mode) -> String {
    let available = data["available"].as_bool() == Some(true);
    if !available || !present(&data["windows"]) {
        return "Farm data is unavailable right now. Check back shortly.".to_owned();
    }
    let first = text(data, "headline").unwrap_or("");
    let w = &data["windows"];
    let field = |window: &str, key: &str| text(&w[window], key).unwrap_or("None").to_owned();
    if mode == Mode::Snapshot {
        return format!(
            "{first} {}; {}.",
            field("spray", "label"),
            field("irrigate", "label").to_lowercase()
        );
    }
    let mut lines = vec![
        format!("**{first}**"),
        format!(
            "- **Spraying:** {}. {}",
            field("spray", "label"),
            field("spray", "detail")
        ),
        format!(
            "- **Planting:** {}. {}",
            field("plant", "label"),
            field("plant", "detail")
        ),
        format!(
            "- **Harvest:** {}. {}",
            field("harvest", "label"),
            field("harvest", "detail")
        ),
        format!(
            "- **Irrigation:** {}. {}",
            field("irrigate", "label"),
            field("irrigate", "detail")
        ),
    ];
    let rk = &data["risks"];
    if present(rk) {
        lines.push(format!(
            "- **Frost:** {}",
            or_none(text(&rk["frost"], "detail"))
        ));
        lines.push(format!(
            "- **Heat:** {}",
            or_none(text(&rk["heat"], "detail"))
        ));
    }
    lines.join("\n")
}

/// The place the explanation is written for, as the prompt names it.
#[derive(Debug, Clone)]
pub struct PromptPlace<'a> {
    /// The place's name (`this location` when there is none).
    pub name: &'a str,
    /// An ISO 3166-1 alpha-2 code, or `""`.
    pub country: &'a str,
    pub lat: f64,
    pub lon: f64,
    /// Metres; `None` prints `n/a`.
    pub elevation: Option<f64>,
}

/// The model's user message: the place, the season, the user's crops with the
/// guidance for each, and [`data_brief`].
pub fn user_prompt(place: &PromptPlace<'_>, crops: &[String], data: &Value) -> String {
    let country = if place.country.is_empty() {
        String::new()
    } else {
        format!(", {}", place.country)
    };
    let mut parts = vec![format!(
        "Place: {}{country} (lat {:.2}, lon {:.2}; elevation {}).",
        place.name,
        place.lat,
        place.lon,
        fmt(place.elevation, " m", 0)
    )];
    let season = &data["season"];
    if present(season) {
        parts.push(format!(
            "Season: {} ({}) — {}",
            or_none(text(season, "localName")),
            or_none(text(season, "name")),
            text(season, "description").unwrap_or("")
        ));
    }
    let crop_lines: Vec<String> = crops
        .iter()
        .map(|id| {
            let (label, guidance) = match reference::activity_brief(id) {
                Some(b) => (b.label.to_owned(), b.guidance),
                None => (id.clone(), None),
            };
            // "Tobacco Farming Guidance: …" reads oddly, but it is the text
            // the model has always been given.
            let guidance = guidance
                .map(|g| format!(" Guidance: {g}"))
                .unwrap_or_default();
            format!("- {label}{guidance}")
        })
        .collect();
    let crops_block = if crop_lines.is_empty() {
        "- Not specified (assume the main staple crop of this area).".to_owned()
    } else {
        crop_lines.join("\n")
    };
    parts.push(format!("The user's farming:\n{crops_block}"));
    parts.push(String::new());
    parts.push(format!(
        "Deterministic farm data (computed from the forecast; explain it, do not change it):\n{}",
        data_brief(data)
    ));
    parts.push(String::new());
    parts.push(
        "Ground the advice in this place, its country and season, and the user's crops — never generic global advice."
            .to_owned(),
    );
    parts.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const FIXTURE: &str = include_str!("../../../../../tests/fixtures/ai-agriculture.json");
    const ANALYSES: &str = include_str!("../../../../../tests/fixtures/agriculture-analysis.json");

    fn analysis(name: &str) -> Value {
        let fx: Value = serde_json::from_str(ANALYSES).unwrap();
        fx["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == name)
            .unwrap_or_else(|| panic!("no analysis {name}"))["expected"]
            .clone()
    }

    fn strings(v: &Value) -> Vec<String> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap().to_owned())
            .collect()
    }

    fn mode(v: &Value) -> Mode {
        Mode::parse(v.as_str().unwrap()).unwrap()
    }

    fn fx() -> Value {
        serde_json::from_str(FIXTURE).unwrap()
    }

    #[test]
    fn the_brief_and_the_fallbacks_are_what_the_python_wrote() {
        let fx = fx();
        let briefs = fx["brief"].as_array().unwrap();
        assert!(briefs.len() >= 8);
        for case in briefs {
            let name = case["analysis"].as_str().unwrap();
            assert_eq!(
                data_brief(&analysis(name)),
                case["expected"].as_str().unwrap(),
                "brief of {name}"
            );
        }
        let fallbacks = fx["fallback"].as_array().unwrap();
        assert!(fallbacks.len() >= 16);
        for case in fallbacks {
            let name = case["analysis"].as_str().unwrap();
            assert_eq!(
                fallback_text(&analysis(name), mode(&case["mode"])),
                case["expected"].as_str().unwrap(),
                "fallback of {name} ({})",
                case["mode"]
            );
        }
    }

    #[test]
    fn the_farming_activities_are_what_the_python_chose() {
        for case in fx()["farmingActivities"].as_array().unwrap() {
            assert_eq!(
                Value::from(farming_activities(&strings(&case["input"]))),
                case["expected"],
                "{}",
                case["input"]
            );
        }
    }

    #[test]
    fn the_model_request_is_what_the_python_built() {
        let fx = fx();
        let cases = fx["prompt"].as_array().unwrap();
        assert!(cases.len() >= 10);
        for case in cases {
            let id = case["id"].as_str().unwrap();
            let input = &case["input"];
            let expected = &case["expected"];
            let data = analysis(input["analysis"].as_str().unwrap());
            let mode = mode(&input["mode"]);
            if expected["user"].is_null() {
                // No farm data: the model is not asked; the fallback is served.
                assert!(data["available"] == false, "{id}");
                assert_eq!(
                    fallback_text(&data, mode),
                    expected["text"].as_str().unwrap(),
                    "{id}"
                );
                continue;
            }
            let crops = farming_activities(&strings(&input["activities"]));
            let l = &input["location"];
            // Python: the explicit country when it is two letters, upper-cased.
            let country = l["country"]
                .as_str()
                .filter(|c| c.len() == 2 && c.chars().all(|ch| ch.is_ascii_alphabetic()))
                .map(str::to_uppercase)
                .unwrap_or_default();
            let place = PromptPlace {
                name: l["name"]
                    .as_str()
                    .filter(|n| !n.is_empty())
                    .unwrap_or("this location"),
                country: &country,
                lat: l["lat"].as_f64().unwrap(),
                lon: l["lon"].as_f64().unwrap(),
                elevation: l["elevation"]
                    .as_f64()
                    .or_else(|| data["elevation"].as_f64()),
            };
            assert_eq!(
                user_prompt(&place, &crops, &data),
                expected["user"].as_str().unwrap(),
                "{id}: user prompt"
            );
            let (system, max_tokens) = system_prompt(mode).unwrap();
            assert_eq!(system, expected["system"].as_str().unwrap(), "{id}: system");
            assert_eq!(
                u64::from(max_tokens),
                expected["maxTokens"].as_u64().unwrap(),
                "{id}: tokens"
            );
        }
    }

    #[test]
    fn a_half_metre_rounds_to_even_like_pythons_format() {
        // 612.5 m: Python's "{:.0f}" gives 612.
        assert_eq!(fmt(Some(612.5), " m", 0), "612 m");
        assert_eq!(fmt(Some(613.5), " m", 0), "614 m");
        assert_eq!(fmt(None, " m", 0), "n/a");
    }

    #[test]
    fn modes_cache_keys_and_the_entitlement_hook() {
        assert_eq!(Mode::parse("snapshot"), Some(Mode::Snapshot));
        assert_eq!(Mode::parse("briefing"), Some(Mode::Briefing));
        assert_eq!(Mode::parse("essay"), None);
        let a = cache_key(
            "harare",
            Mode::Snapshot,
            &["tobacco-farming".into(), "crop-farming".into()],
        );
        let b = cache_key(
            "harare",
            Mode::Snapshot,
            &["crop-farming".into(), "tobacco-farming".into()],
        );
        assert_eq!(a, b);
        assert_eq!(a, "agri-ai:v1:harare:snapshot:crop-farming,tobacco-farming");
        assert_ne!(a, cache_key("harare", Mode::Briefing, &[]));
        assert_ne!(
            cache_key("harare", Mode::Snapshot, &[]),
            cache_key("kariba", Mode::Snapshot, &[])
        );
        // Everyone is entitled until the billing service exists.
        assert!(entitled(None) && entitled(Some("user_1")));
        assert_eq!(CAPABILITY, "weather.agri_insights");
    }

    #[test]
    fn only_a_complete_prompt_pair_exists_for_both_modes() {
        for m in [Mode::Snapshot, Mode::Briefing] {
            let (template, tokens) = system_prompt(m).expect("seeded");
            assert!(template.contains("Shamwari Weather"));
            assert!(tokens >= 100);
        }
        assert_eq!(system_prompt(Mode::Snapshot).unwrap().1, 120);
        assert_eq!(system_prompt(Mode::Briefing).unwrap().1, 700);
    }

    #[test]
    fn missing_pieces_never_panic() {
        let bare = json!({"available": true, "headline": "ok"});
        assert_eq!(data_brief(&bare), "Verdict: ok");
        assert!(fallback_text(&bare, Mode::Snapshot).contains("unavailable"));
        assert!(fallback_text(&json!({}), Mode::Briefing).contains("unavailable"));
    }
}
