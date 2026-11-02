//! The report wizard's follow-up questions (`POST /v1/reports/clarify`): when a
//! visitor picks what they see ("heavy rain"), the model asks one or two short
//! questions about it, and a fixed pair of questions answers when it cannot.
//!
//! Ported from `clarify_report` in the former `api/py/_reports.py` and pinned to
//! it by `tests/fixtures/report-clarify.json`, whose `expected` values were
//! produced by running the real Python (`scripts/gen_report_clarify_fixtures.py`,
//! from a pinned commit): the system prompt and messages handed to the model
//! for every report type, the questions parsed from a range of model answers,
//! the fallback pair for every type, and the refusal of an unknown type.
//! Everything here is pure; the AI Worker (`workers/ai`) does the I/O.
//!
//! The differences from the Python, on purpose, each pinned by a test:
//!
//! - **No client text reaches the prompt.** The Python put the name of the
//!   place into the prompt after a database lookup, and the raw slug when it
//!   found none. The Worker takes only a validated slug (`[a-z0-9-]{1,80}`) and
//!   a report type from a list of 13, and names the place itself ([`place_name`]:
//!   the seed catalogue's name, else the name part of a `{name}--{geohash}`
//!   spot, else the slug's words). Nothing a visitor types can say anything to
//!   the model.
//! - **A question is cleaned.** The Python kept whatever followed the number:
//!   an empty question (`1.` alone) and the bracket of `1)`. The Worker drops
//!   empty questions, strips the bracket, removes emoji (the prompt says never
//!   to use any, a model sometimes does) and drops a question longer than
//!   [`MAX_QUESTION_CHARS`] (the prompt asks for under 15 words). With nothing
//!   left, the fixed pair answers.
//! - **The answer says where it came from** (`source`: `ai` or `fallback`).

use serde::Serialize;
use serde_json::Value;

use crate::community::{fallback_questions, parse_questions, valid_report_type, CLARIFY_PROMPT};
use crate::locations::parse_spot_slug;
use crate::places::resolve_seed;
use crate::reference;
use crate::slug::valid_slug;

/// The public route (`mukoko-weather-api` forwards it to the AI Worker).
pub const PATH: &str = "/v1/reports/clarify";
/// A request body is a slug and a report type: well under a kilobyte.
pub const MAX_BODY_BYTES: usize = 1024;
/// The stored prompt (`system:report_clarification`).
pub const PROMPT_KEY: &str = "system:report_clarification";
/// The answer length asked of the model when the stored prompt names none, as
/// in the Python.
pub const DEFAULT_MAX_TOKENS: u32 = 150;
/// Most questions in an answer.
pub const MAX_QUESTIONS: usize = 2;
/// A question longer than this is not used (the prompt asks for under 15
/// words, and a reasoning model that rambles should not fill the wizard).
pub const MAX_QUESTION_CHARS: usize = 200;
/// Longest place name put in the prompt (a slug is at most 80 characters).
const MAX_NAME_CHARS: usize = 80;

/// Why a request is refused before anything else happens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// Not a JSON object with two strings.
    Body,
    /// `locationSlug` is not a slug.
    Slug,
    /// `reportType` is not one of the 13 report types.
    ReportType,
}

impl Refusal {
    /// The Python's words for an unknown type; the others are new.
    pub fn description(self) -> &'static str {
        match self {
            Refusal::Body => "The body must be {\"locationSlug\", \"reportType\"}.",
            Refusal::Slug => "`locationSlug` must be a location slug.",
            Refusal::ReportType => "Invalid report type",
        }
    }
}

/// A request that passed [`validate`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Valid {
    pub slug: String,
    pub report_type: String,
}

/// `{locationSlug, reportType}`: a slug and one of the 13 report types. Any
/// other field is ignored (never read).
pub fn validate(body: &Value) -> Result<Valid, Refusal> {
    let (Some(slug), Some(report_type)) = (
        body.get("locationSlug").and_then(Value::as_str),
        body.get("reportType").and_then(Value::as_str),
    ) else {
        return Err(Refusal::Body);
    };
    if !valid_report_type(report_type) {
        return Err(Refusal::ReportType);
    }
    if !valid_slug(slug) {
        return Err(Refusal::Slug);
    }
    Ok(Valid {
        slug: slug.to_owned(),
        report_type: report_type.to_owned(),
    })
}

/// The place's name for the prompt, from the slug alone: the seed
/// catalogue's name; else the name part of a `{name}--{geohash}` spot; else
/// the slug's words, capitalised. Only letters and digits (a slug has no
/// other characters), so it is safe to place in a prompt.
pub fn place_name(slug: &str) -> String {
    let named = resolve_seed(slug)
        .and_then(|p| p.name.clone())
        .or_else(|| parse_spot_slug(slug).map(|(name, _, _)| name))
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| words(slug));
    named.chars().take(MAX_NAME_CHARS).collect()
}

fn words(slug: &str) -> String {
    slug.split('-')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            c.next()
                .map(|f| f.to_uppercase().chain(c).collect::<String>())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// What the model is asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prompt {
    pub system: String,
    pub user: String,
    pub max_tokens: u32,
}

/// The system prompt and user message for a place and a report type. The
/// template is the stored `system:report_clarification` (the seed db-init
/// wrote, compiled in), else the short built-in one, as in the Python.
pub fn prompt(place: &str, report_type: &str) -> Prompt {
    let (template, max_tokens) = reference::ai_prompt(PROMPT_KEY).unwrap_or((CLARIFY_PROMPT, None));
    Prompt {
        system: template
            .replace("{locationName}", place)
            .replace("{reportType}", report_type),
        user: format!("I'm reporting: {report_type}"),
        max_tokens: max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
    }
}

/// Where the questions came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// The model wrote them.
    Ai,
    /// The fixed pair for the report type.
    Fallback,
}

/// The response body of `POST /v1/reports/clarify`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Answer {
    pub questions: Vec<String>,
    pub source: Source,
}

/// The fixed pair of questions for a report type.
pub fn fallback(report_type: &str) -> Answer {
    Answer {
        questions: fallback_questions(report_type)
            .iter()
            .map(|q| (*q).to_owned())
            .collect(),
        source: Source::Fallback,
    }
}

/// The questions in a model's answer: the numbered lines, at most two,
/// cleaned ([`clean`]); the fixed pair when there are none.
pub fn from_model(text: &str, report_type: &str) -> Answer {
    let questions: Vec<String> = parse_questions(text)
        .iter()
        .filter_map(|q| clean(q))
        .take(MAX_QUESTIONS)
        .collect();
    if questions.is_empty() {
        fallback(report_type)
    } else {
        Answer {
            questions,
            source: Source::Ai,
        }
    }
}

/// One question as the wizard shows it: no leftover bracket from `1)`, no
/// emoji, one space between words. `None` when nothing is left or it is too
/// long.
fn clean(question: &str) -> Option<String> {
    let text = question.trim_start_matches(|c: char| c == ')' || c.is_whitespace());
    let text = text
        .chars()
        .filter(|c| !is_pictograph(*c))
        .collect::<String>();
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    (!text.is_empty() && text.chars().count() <= MAX_QUESTION_CHARS).then_some(text)
}

/// Emoji and the invisible characters that build them: pictograph blocks,
/// dingbats, variation selectors, the zero-width joiner, the keycap mark and
/// tag characters.
fn is_pictograph(c: char) -> bool {
    matches!(
        c as u32,
        0x1F000..=0x1FAFF
            | 0x2600..=0x27BF
            | 0x2B00..=0x2BFF
            | 0xFE00..=0xFE0F
            | 0x200D
            | 0x20E3
            | 0xE0020..=0xE007F
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::community::REPORT_TYPES;
    use serde_json::json;

    /// `tests/fixtures/report-clarify.json`: every `expected` was produced by
    /// the real Python `clarify_report` (see the module header).
    const FIXTURE: &str = include_str!("../../../../../tests/fixtures/report-clarify.json");

    fn fixture() -> Value {
        serde_json::from_str(FIXTURE).expect("fixture parses")
    }

    #[test]
    fn the_prompt_sent_to_the_model_is_the_pythons_for_every_type() {
        let f = fixture();
        let mut stored = 0;
        for case in f["prompts"].as_array().unwrap() {
            // The Worker always has the stored prompt compiled in; the one
            // case the Python ran without it is the built-in template.
            if case["stored"] == json!(false) {
                let built_in = CLARIFY_PROMPT
                    .replace("{locationName}", case["place"].as_str().unwrap())
                    .replace("{reportType}", case["reportType"].as_str().unwrap());
                assert_eq!(built_in, case["sent"]["system"].as_str().unwrap());
                continue;
            }
            // A place the Python had no record of was named by the raw slug;
            // the Worker names it from the slug (tested below).
            let Some(place) = case["place"].as_str() else {
                continue;
            };
            let got = prompt(place, case["reportType"].as_str().unwrap());
            let sent = &case["sent"];
            assert_eq!(got.system, sent["system"].as_str().unwrap(), "{case}");
            assert_eq!(got.user, sent["messages"][0]["content"].as_str().unwrap());
            assert_eq!(sent["messages"][0]["role"], "user");
            assert_eq!(got.max_tokens, sent["maxTokens"].as_u64().unwrap() as u32);
            stored += 1;
        }
        // All 13 types, and two more places.
        assert!(stored >= REPORT_TYPES.len() + 2, "{stored}");
    }

    #[test]
    fn the_stored_prompt_is_the_one_the_python_read_from_the_database() {
        let f = fixture();
        let (template, max_tokens) = reference::ai_prompt(PROMPT_KEY).expect("seeded");
        assert_eq!(max_tokens, f["maxTokens"].as_u64().map(|t| t as u32));
        assert!(template.contains("{locationName}") && template.contains("{reportType}"));
        assert!(template.contains("Never use emoji"));
        // The model id the Python forwarded is not used: the AI Worker's
        // `AI_MODEL` var picks it.
        assert!(f["model"].as_str().unwrap().starts_with("workers-ai/"));
    }

    #[test]
    fn model_answers_give_the_pythons_questions() {
        let f = fixture();
        let mut ai = 0;
        for case in f["answers"].as_array().unwrap() {
            let report_type = case["reportType"].as_str().unwrap();
            let expected: Vec<&str> = case["expected"]["questions"]
                .as_array()
                .unwrap()
                .iter()
                .map(|q| q.as_str().unwrap())
                .collect();
            let name = case["name"].as_str().unwrap();
            if case.get("modelError").is_some() {
                // The model failed: the fixed pair, exactly.
                let got = fallback(report_type);
                assert_eq!(got.questions, expected, "{name}");
                assert_eq!(got.source, Source::Fallback);
                continue;
            }
            let text = case["modelText"].as_str().unwrap();
            let got = from_model(text, report_type);
            if case.get("rustDiffersBecause").is_some() {
                // Pinned by `the_wizard_gets_clean_questions_only` below.
                continue;
            }
            assert_eq!(got.questions, expected, "{name}");
            if got.source == Source::Ai {
                ai += 1;
            }
        }
        assert!(ai >= 6, "{ai} model answers were read");
    }

    #[test]
    fn an_unknown_report_type_is_refused_with_the_pythons_words() {
        let f = fixture();
        for case in f["refused"].as_array().unwrap() {
            let t = case["reportType"].as_str().unwrap();
            let want = &case["expected"]["error"];
            assert_eq!(want["status"], 400);
            let body = json!({"locationSlug": "harare", "reportType": t});
            let refusal = validate(&body).unwrap_err();
            assert_eq!(refusal, Refusal::ReportType, "{t:?}");
            assert_eq!(refusal.description(), want["detail"].as_str().unwrap());
        }
    }

    #[test]
    fn every_type_has_a_fallback_pair_and_says_so() {
        for t in REPORT_TYPES {
            let a = fallback(t);
            assert_eq!(a.questions.len(), 2, "{t}");
            assert_eq!(a.source, Source::Fallback);
        }
        // The answer's JSON is what the wizard reads, plus `source`.
        let v = serde_json::to_value(fallback("frost")).unwrap();
        assert_eq!(
            v,
            json!({"questions": ["Is the frost visible on surfaces?", "Are your car windows frosted over?"], "source": "fallback"})
        );
        let v = serde_json::to_value(from_model("1. How heavy?\n2. How long?", "hail")).unwrap();
        assert_eq!(
            v,
            json!({"questions": ["How heavy?", "How long?"], "source": "ai"})
        );
    }

    #[test]
    fn the_wizard_gets_clean_questions_only() {
        // The Python returned [""] here, and kept the bracket of "1)".
        let f = fixture();
        let differing: Vec<&Value> = f["answers"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c.get("rustDiffersBecause").is_some())
            .collect();
        assert_eq!(differing.len(), 3, "each difference is documented");

        let bare = from_model("1.", "heavy-rain");
        assert_eq!(bare, fallback("heavy-rain"));
        let first_bare = from_model("1.\n2. How heavy is it?", "heavy-rain");
        assert_eq!(first_bare.questions, vec!["How heavy is it?"]);
        assert_eq!(first_bare.source, Source::Ai);
        let bracket = from_model("1) How heavy is it?\n2) Is it flooding?", "heavy-rain");
        assert_eq!(
            bracket.questions,
            vec!["How heavy is it?", "Is it flooding?"]
        );

        // Emoji go, words stay; a question of only emoji is not a question.
        let emoji = from_model(
            "1. \u{1F327}\u{FE0F} How heavy is the rain? \u{2614}\n2. \u{1F327}",
            "heavy-rain",
        );
        assert_eq!(emoji.questions, vec!["How heavy is the rain?"]);
        // A rambling answer is not shown.
        let long = format!("1. {}?\n2. Is it flooding?", "very ".repeat(60));
        assert_eq!(
            from_model(&long, "flooding").questions,
            vec!["Is it flooding?"]
        );
        let only_long = format!("1. {}?", "very ".repeat(60));
        assert_eq!(from_model(&only_long, "flooding"), fallback("flooding"));
        // Exactly the limit is kept.
        let edge = format!("1. {}", "a".repeat(MAX_QUESTION_CHARS));
        assert_eq!(from_model(&edge, "fog").source, Source::Ai);
        let over = format!("1. {}", "a".repeat(MAX_QUESTION_CHARS + 1));
        assert_eq!(from_model(&over, "fog").source, Source::Fallback);
        // Whitespace inside a question is one space.
        assert_eq!(
            from_model("1.  How   heavy\t is it?", "fog").questions,
            vec!["How heavy is it?"]
        );
        // The same cleaning leaves a plain question untouched.
        assert_eq!(clean("Is it dusty?").as_deref(), Some("Is it dusty?"));
    }

    #[test]
    fn at_most_two_questions_whatever_the_model_says() {
        let text: String = (1..=9).map(|i| format!("{i}. Q{i}?\n")).collect();
        let a = from_model(&text, "mist");
        assert_eq!(a.questions, vec!["Q1?", "Q2?"]);
    }

    #[test]
    fn a_request_is_a_slug_and_one_of_the_thirteen_types() {
        let ok = validate(&json!({"locationSlug": "harare", "reportType": "frost"})).unwrap();
        assert_eq!(
            ok,
            Valid {
                slug: "harare".into(),
                report_type: "frost".into()
            }
        );
        // Extra fields are never read.
        let extra = json!({"locationSlug": "harare", "reportType": "fog", "description": "call me on 0771234567"});
        assert!(validate(&extra).is_ok());

        for body in [
            json!(null),
            json!([]),
            json!("harare"),
            json!({}),
            json!({"locationSlug": "harare"}),
            json!({"reportType": "fog"}),
            json!({"locationSlug": 5, "reportType": "fog"}),
            json!({"locationSlug": "harare", "reportType": 5}),
            json!({"locationSlug": null, "reportType": "fog"}),
        ] {
            assert_eq!(validate(&body), Err(Refusal::Body), "{body}");
        }
        // The type is checked before the slug, as the Python checked it first.
        assert_eq!(
            validate(&json!({"locationSlug": "Not A Slug", "reportType": "sunny"})),
            Err(Refusal::ReportType)
        );
        for slug in [
            "",
            "Harare",
            "ha rare",
            "ha_rare",
            "harare;drop",
            "{reportType}",
            "x\ny",
            &"a".repeat(81),
        ] {
            let body = json!({"locationSlug": slug, "reportType": "fog"});
            assert_eq!(validate(&body), Err(Refusal::Slug), "{slug:?}");
        }
        assert!(validate(&json!({"locationSlug": "a".repeat(80), "reportType": "fog"})).is_ok());
        for t in REPORT_TYPES {
            assert!(validate(&json!({"locationSlug": "harare", "reportType": t})).is_ok());
        }
        // The size cap is far above the largest valid body.
        let largest = json!({"locationSlug": "a".repeat(80), "reportType": "thunderstorm"});
        assert!(largest.to_string().len() * 4 < MAX_BODY_BYTES);
    }

    #[test]
    fn the_place_is_named_from_the_slug_never_from_client_text() {
        assert_eq!(place_name("harare"), "Harare");
        // A seed with a country suffix.
        assert_eq!(place_name("nairobi-ke"), "Nairobi");
        // A spot: the name part of the slug.
        assert_eq!(place_name("koh-samui--w4bd7qz"), "Koh Samui");
        // Anything else: the slug's words.
        assert_eq!(
            place_name("some-small-town-abc123"),
            "Some Small Town Abc123"
        );
        assert_eq!(place_name("x"), "X");
        for slug in ["harare", "koh-samui--w4bd7qz", "some-small-town-abc123"] {
            let n = place_name(slug);
            assert!(
                n.chars().all(|c| c.is_alphanumeric() || c == ' '),
                "{slug} -> {n}"
            );
        }
        assert!(place_name(&"a".repeat(80)).chars().count() <= MAX_NAME_CHARS);

        // The name goes into the prompt and nothing else of the request does.
        let p = prompt(&place_name("koh-samui--w4bd7qz"), "heavy-rain");
        assert!(p
            .system
            .contains("report for Koh Samui. They selected: heavy-rain."));
        assert!(!p.system.contains('{'), "no placeholder is left");
        assert_eq!(p.user, "I'm reporting: heavy-rain");
        assert_eq!(p.max_tokens, 150);
    }

    #[test]
    fn a_pictograph_is_an_emoji_and_a_letter_is_not() {
        for c in [
            '\u{1F600}',
            '\u{1F327}',
            '\u{2614}',
            '\u{2728}',
            '\u{FE0F}',
            '\u{200D}',
            '\u{2B50}',
        ] {
            assert!(is_pictograph(c), "{c:?}");
        }
        for c in [
            'a', 'Z', '7', '?', '\u{e9}', '\u{2013}', '\u{2192}', '\u{b0}',
        ] {
            assert!(!is_pictograph(c), "{c:?}");
        }
    }
}
