//! The compiled AI guardrails from the Nyuchi API, and when to refresh them.
//!
//! `GET {NYUCHI_API_URL}/v1/ai/guardrails/compiled?applies_to=weather` answers
//! `{format: "nyuchi-guardrails/v1", appliesTo, ruleIds, systemPrompt}`.
//! `systemPrompt` goes first in every system prompt, verbatim.
//!
//! The rules (nyuchi/api-gateway `docs/architecture/ai-guardrails.md`):
//!
//! - keep the last block and its `ETag`, and revalidate with `If-None-Match`
//!   once it is older than 60 seconds;
//! - if the API cannot be reached, keep using the cached block for up to
//!   24 hours (`stale-if-error`);
//! - with no usable block, refuse to run the AI (fail closed). Never fall
//!   back to built-in or empty rules.

use serde_json::Value;

/// The format this Worker understands.
pub const FORMAT: &str = "nyuchi-guardrails/v1";
/// The surface slug for Mukoko Weather.
pub const SURFACE: &str = "weather";
/// Revalidate after this long.
pub const FRESH_MS: u64 = 60_000;
/// Use a cached block for at most this long when the API is unreachable.
pub const STALE_IF_ERROR_MS: u64 = 86_400_000;

/// A compiled guardrails block.
#[derive(Debug, Clone, PartialEq)]
pub struct Compiled {
    pub system_prompt: String,
    pub etag: Option<String>,
    /// When the API last confirmed this block (200 or 304), epoch ms.
    pub confirmed_at: u64,
}

/// What to do with the cached block now.
#[derive(Debug, PartialEq, Eq)]
pub enum Freshness {
    /// Use it as is.
    Fresh,
    /// Revalidate; on failure it may still be used.
    Revalidate,
    /// Revalidate; on failure refuse (no block, or older than 24 h).
    Required,
}

pub fn freshness(cached: Option<&Compiled>, now_ms: u64) -> Freshness {
    match cached {
        None => Freshness::Required,
        Some(c) => {
            let age = now_ms.saturating_sub(c.confirmed_at);
            if age < FRESH_MS {
                Freshness::Fresh
            } else if age < STALE_IF_ERROR_MS {
                Freshness::Revalidate
            } else {
                Freshness::Required
            }
        }
    }
}

/// Parse a `200` body. `None` when the format is unknown or the prompt is
/// empty: an unusable block is treated like no block (fail closed).
pub fn parse(body: &Value, etag: Option<String>, now_ms: u64) -> Option<Compiled> {
    if body.get("format").and_then(Value::as_str) != Some(FORMAT) {
        return None;
    }
    let prompt = body.get("systemPrompt").and_then(Value::as_str)?;
    if prompt.trim().is_empty() {
        return None;
    }
    Some(Compiled {
        system_prompt: prompt.to_owned(),
        etag,
        confirmed_at: now_ms,
    })
}

/// The result of a revalidation attempt.
pub enum Fetched {
    /// `200` with a usable block.
    New(Compiled),
    /// `304 Not Modified`.
    NotModified,
    /// Anything else: network error, timeout, 5xx, 401/403, a bad body.
    Failed,
}

/// Decide which block to use after a fetch (or none: refuse).
pub fn settle(cached: Option<Compiled>, fetched: Fetched, now_ms: u64) -> Option<Compiled> {
    match fetched {
        Fetched::New(c) => Some(c),
        Fetched::NotModified => cached.map(|mut c| {
            c.confirmed_at = now_ms;
            c
        }),
        Fetched::Failed => cached.filter(|c| freshness(Some(c), now_ms) != Freshness::Required),
    }
}

/// The full system prompt: the guardrails block first, verbatim, then the
/// app's own instructions.
pub fn system_prompt(guardrails: &Compiled, app_prompt: &str) -> String {
    let mut out = String::with_capacity(guardrails.system_prompt.len() + app_prompt.len() + 2);
    out.push_str(&guardrails.system_prompt);
    out.push_str("\n\n");
    out.push_str(app_prompt);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn block(at: u64) -> Compiled {
        Compiled {
            system_prompt: "### Guardrails\nrules\n### End of guardrails".into(),
            etag: Some("\"abc\"".into()),
            confirmed_at: at,
        }
    }

    #[test]
    fn freshness_windows() {
        assert_eq!(freshness(None, 5), Freshness::Required);
        let b = block(1_000);
        assert_eq!(freshness(Some(&b), 1_000 + FRESH_MS - 1), Freshness::Fresh);
        assert_eq!(freshness(Some(&b), 1_000 + FRESH_MS), Freshness::Revalidate);
        assert_eq!(
            freshness(Some(&b), 1_000 + STALE_IF_ERROR_MS),
            Freshness::Required
        );
    }

    #[test]
    fn parse_requires_the_known_format_and_a_prompt() {
        let ok = json!({"format": FORMAT, "appliesTo": "weather", "systemPrompt": "rules"});
        assert_eq!(parse(&ok, None, 7).unwrap().system_prompt, "rules");
        assert!(parse(&json!({"format": "v2", "systemPrompt": "x"}), None, 0).is_none());
        assert!(parse(&json!({"format": FORMAT, "systemPrompt": "  "}), None, 0).is_none());
        assert!(parse(&json!({"format": FORMAT}), None, 0).is_none());
    }

    #[test]
    fn settle_fails_closed() {
        // No cache and the API failed: refuse.
        assert!(settle(None, Fetched::Failed, 10).is_none());
        // 304 renews the cached block.
        let renewed = settle(Some(block(0)), Fetched::NotModified, 90_000).unwrap();
        assert_eq!(renewed.confirmed_at, 90_000);
        // 304 with nothing cached cannot produce rules.
        assert!(settle(None, Fetched::NotModified, 10).is_none());
        // API down: a stale block is used within 24 h, refused after.
        assert!(settle(Some(block(0)), Fetched::Failed, 3_600_000).is_some());
        assert!(settle(Some(block(0)), Fetched::Failed, STALE_IF_ERROR_MS).is_none());
        // A new block wins.
        let fresh = block(5);
        assert_eq!(
            settle(Some(block(0)), Fetched::New(fresh.clone()), 5),
            Some(fresh)
        );
    }

    #[test]
    fn guardrails_come_first_verbatim() {
        let b = block(0);
        let p = system_prompt(&b, "You are Shamwari Weather.");
        assert!(p.starts_with(&b.system_prompt));
        assert!(p.ends_with("You are Shamwari Weather."));
    }
}
