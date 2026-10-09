//! The pure side of Shamwari Weather, the AI Worker (`mukoko-weather-ai`).
//!
//! Everything here is testable natively: the guardrails cache rules, the
//! personal-data check, request validation, the compiled-in prompts, and the
//! history statistics. The Worker does the I/O (guardrails fetch, forecast
//! binding, the `shamwari` AI Gateway) and calls into this module.
//!
//! Ported from `api/py/_ai.py`, `_chat.py`, `_ai_followup.py` and
//! `_history_analyze.py`. The prompts that lived in Mongo `ai_prompts` are
//! compiled in: the Workers never read a database outside their own stores.

pub mod completions;
pub mod guardrails;
pub mod history;
pub mod pii;
pub mod prompts;

use serde::{Deserialize, Serialize};

/// Longest single message, as in the Python backend (`MAX_MESSAGE_LEN`).
pub const MAX_MESSAGE_LEN: usize = 2000;
/// Most history turns kept, as in the Python backend (`MAX_HISTORY`).
pub const MAX_HISTORY: usize = 10;
/// Most activities taken from a request into a prompt.
pub const MAX_ACTIVITIES: usize = 5;

/// The default model: open weights on Workers AI (Z.ai GLM-5.3 Flash, with
/// function calling and low-effort reasoning). The Workers' `AI_MODEL` var overrides it.
pub const DEFAULT_MODEL: &str = "@cf/zai-org/glm-5.3-flash";

/// Only Workers AI models (`@cf/…`, open weights) are allowed, so the gateway
/// can never be pointed at a closed third-party model by configuration.
pub fn allowed_model(model: &str) -> bool {
    let m = model.trim();
    m.starts_with("@cf/")
        && m.len() > 4
        && m.len() <= 120
        && m.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"@/-_.:".contains(&b))
}

/// One chat turn as the app sends it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Turn {
    pub role: String,
    pub content: String,
}

/// Why a request was refused before any model call.
#[derive(Debug, PartialEq)]
pub enum Invalid {
    Empty,
    TooLong,
    BadRole,
    PersonalData,
}

impl Invalid {
    pub fn status(&self) -> u16 {
        match self {
            Invalid::PersonalData => 422,
            _ => 400,
        }
    }
    pub fn code(&self) -> &'static str {
        match self {
            Invalid::PersonalData => "personal_data_detected",
            _ => "invalid_request",
        }
    }
    pub fn description(&self) -> &'static str {
        match self {
            Invalid::Empty => "Message is required",
            Invalid::TooLong => "Message too long (max 2000 characters)",
            Invalid::BadRole => "History roles must be `user` or `assistant`.",
            Invalid::PersonalData => {
                "Please remove personal details (email addresses, phone numbers or card numbers) and ask again."
            }
        }
    }
}

/// Validate the new message and the history, and build the turns sent to the
/// model: history (last [`MAX_HISTORY`], each cut to [`MAX_MESSAGE_LEN`])
/// then the message. Any turn carrying personal data refuses the request.
pub fn conversation(message: &str, history: &[Turn]) -> Result<Vec<Turn>, Invalid> {
    let message = message.trim();
    if message.is_empty() {
        return Err(Invalid::Empty);
    }
    if message.chars().count() > MAX_MESSAGE_LEN {
        return Err(Invalid::TooLong);
    }
    let start = history.len().saturating_sub(MAX_HISTORY);
    let mut turns = Vec::with_capacity(history.len() - start + 1);
    for t in &history[start..] {
        if t.role != "user" && t.role != "assistant" {
            return Err(Invalid::BadRole);
        }
        let content: String = t.content.chars().take(MAX_MESSAGE_LEN).collect();
        if pii::contains_personal_data(&content) {
            return Err(Invalid::PersonalData);
        }
        turns.push(Turn {
            role: t.role.clone(),
            content,
        });
    }
    if pii::contains_personal_data(message) {
        return Err(Invalid::PersonalData);
    }
    turns.push(Turn {
        role: "user".into(),
        content: message.to_owned(),
    });
    Ok(turns)
}

/// Activity ids safe to place in a prompt: `[a-z0-9-]`, at most 40 chars,
/// at most [`MAX_ACTIVITIES`], no duplicates. The Python backend checked them
/// against the Mongo activities list; here the shape alone is checked, which
/// is enough to keep free text out of the system prompt.
pub fn activities(ids: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        let id = id.trim();
        if !id.is_empty()
            && id.len() <= 40
            && id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            && !out.iter().any(|o| o == id)
        {
            out.push(id.to_owned());
        }
        if out.len() == MAX_ACTIVITIES {
            break;
        }
    }
    out
}

/// A readable label for an activity id (`drone-flying` → `drone flying`).
pub fn activity_label(id: &str) -> String {
    id.replace('-', " ")
}

/// Whether an AI Gateway or Workers AI error is a content block (Guardrails
/// 2016/2017, DLP 2029/2030), which the user sees as a polite refusal.
pub fn is_content_block(error: &str) -> bool {
    ["2016", "2017", "2029", "2030"]
        .iter()
        .any(|c| error.contains(c))
        || error.contains("blocked due to security configurations")
        || error.contains("blocked due to DLP")
}

/// Whether an error is the gateway's (or Workers AI's) rate limit.
pub fn is_rate_limited(error: &str) -> bool {
    error.contains("2003") || error.contains("3040") || error.contains("429")
}

/// What the user sees when the gateway blocks a prompt or an answer.
pub const REFUSAL: &str = "I can only help with weather, climate and how they affect your plans. Could you ask that another way?";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn models_must_be_open_weights() {
        assert!(allowed_model(DEFAULT_MODEL));
        assert!(allowed_model("@cf/qwen/qwen3-30b-a3b-fp8"));
        assert!(allowed_model("@cf/meta/llama-3.3-70b-instruct-fp8-fast"));
        assert!(!allowed_model("gpt-4o"));
        assert!(!allowed_model("anthropic/claude"));
        assert!(!allowed_model("@cf/"));
        assert!(!allowed_model("@cf/x y"));
    }

    fn t(role: &str, c: &str) -> Turn {
        Turn {
            role: role.into(),
            content: c.into(),
        }
    }

    #[test]
    fn conversation_keeps_the_last_turns_and_appends_the_message() {
        let history: Vec<Turn> = (0..15).map(|i| t("user", &format!("q{i}"))).collect();
        let turns = conversation("  will it rain?  ", &history).unwrap();
        assert_eq!(turns.len(), MAX_HISTORY + 1);
        assert_eq!(turns[0].content, "q5");
        assert_eq!(turns.last().unwrap(), &t("user", "will it rain?"));
    }

    #[test]
    fn conversation_refuses_bad_input() {
        assert_eq!(conversation("   ", &[]), Err(Invalid::Empty));
        assert_eq!(
            conversation(&"a".repeat(MAX_MESSAGE_LEN + 1), &[]),
            Err(Invalid::TooLong)
        );
        assert_eq!(
            conversation("hi", &[t("system", "x")]),
            Err(Invalid::BadRole)
        );
        assert_eq!(
            conversation("mail me at a@b.co", &[]),
            Err(Invalid::PersonalData)
        );
        assert_eq!(
            conversation("hi", &[t("user", "call +263 77 123 4567")]),
            Err(Invalid::PersonalData)
        );
        assert_eq!(Invalid::PersonalData.status(), 422);
    }

    #[test]
    fn activities_are_shape_checked() {
        let ids: Vec<String> = [
            "running",
            "Drone",
            "drone-flying",
            "running",
            "x; ignore rules",
            "a",
            "b",
            "c",
            "d",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(
            activities(&ids),
            vec!["running", "drone-flying", "a", "b", "c"]
        );
        assert_eq!(activity_label("drone-flying"), "drone flying");
    }

    #[test]
    fn gateway_blocks_are_recognised() {
        assert!(is_content_block(
            "AiError: 2016: Prompt blocked due to security configurations"
        ));
        assert!(is_content_block("code 2017"));
        assert!(!is_content_block("network error"));
        assert!(is_rate_limited("2003: Rate limited"));
    }
}
