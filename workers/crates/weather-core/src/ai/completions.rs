//! The OpenAI-style `chat/completions` passthrough the Python backend uses.
//!
//! `POST weather-internal.mukoko.com/internal/ai/chat/completions` (service
//! key) is forwarded over a service binding to `mukoko-weather-ai`, which
//! runs it on Workers AI through the `shamwari` AI Gateway. The Python
//! backend (`api/py/_ai_gateway.py`) keeps its own prompts and tool loops;
//! this module is the pure half of the Worker side:
//!
//! - [`parse`] validates and rebuilds the request (roles, sizes, tools), and
//!   refuses user turns that carry personal data;
//! - [`build_input`] puts the Nyuchi guardrails first in the one system
//!   message, picks the token budget, and sets a low reasoning effort for
//!   reasoning models;
//! - [`completion`] reads the model's answer from either Workers AI output
//!   shape (OpenAI `choices`, or the older `{response, tool_calls}`), taking
//!   `content` only, never `reasoning_content`;
//! - [`response`] writes it back as an OpenAI chat completion, so the Python
//!   client parses it exactly as before.

use serde_json::{json, Map, Value};

use super::{allowed_model, pii, DEFAULT_MODEL};

/// Most messages in one request. A tool loop of 5 rounds with a few calls
/// each stays well under this.
pub const MAX_MESSAGES: usize = 48;
/// Longest single message. Tool results (a forecast as JSON) are the big ones.
pub const MAX_CONTENT_CHARS: usize = 24_000;
/// Most tools offered in one request.
pub const MAX_TOOLS: usize = 16;
/// Most output tokens a caller may ask for.
pub const MAX_OUTPUT_TOKENS: u32 = 4_096;
/// Output tokens when the caller names none.
pub const DEFAULT_OUTPUT_TOKENS: u32 = 1_024;
/// Added to a reasoning model's budget: its reasoning is billed from
/// `max_tokens` too, and an answer starved of tokens comes back empty.
/// GLM at `reasoning_effort: low` used ~360 tokens on a 600-token summary.
pub const REASONING_HEADROOM: u32 = 1_024;
/// The reasoning effort asked of reasoning models (GLM: low, high or max;
/// reasoning cannot be switched off).
pub const REASONING_EFFORT: &str = "low";

/// A validated request.
#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    /// A model the caller asked for, if it is allowed (`@cf/` only).
    pub model: Option<String>,
    pub max_tokens: u32,
    /// Rebuilt messages (only the known keys), system messages included.
    pub messages: Vec<Value>,
    pub tools: Vec<Value>,
}

/// Why a request was refused before any model call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rejected {
    NotAnObject,
    NoMessages,
    TooManyMessages,
    BadMessage,
    BadRole,
    TooLong,
    TooManyTools,
    BadTool,
    PersonalData,
}

impl Rejected {
    pub fn status(self) -> u16 {
        match self {
            Rejected::PersonalData => 422,
            _ => 400,
        }
    }
    pub fn code(self) -> &'static str {
        match self {
            Rejected::PersonalData => "personal_data_detected",
            _ => "invalid_request",
        }
    }
    pub fn description(self) -> &'static str {
        match self {
            Rejected::NotAnObject => "The body must be a JSON object.",
            Rejected::NoMessages => "`messages` must be a non-empty array.",
            Rejected::TooManyMessages => "Too many messages.",
            Rejected::BadMessage => "Each message needs a role and string content.",
            Rejected::BadRole => "Roles must be system, user, assistant or tool.",
            Rejected::TooLong => "A message is too long.",
            Rejected::TooManyTools => "Too many tools.",
            Rejected::BadTool => "Each tool must be {type: function, function: {name, parameters}}.",
            Rejected::PersonalData => {
                "Please remove personal details (email addresses, phone numbers or card numbers) and ask again."
            }
        }
    }
}

fn content_of(m: &Map<String, Value>) -> Result<Option<String>, Rejected> {
    match m.get("content") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => {
            if s.chars().count() > MAX_CONTENT_CHARS {
                Err(Rejected::TooLong)
            } else {
                Ok(Some(s.clone()))
            }
        }
        _ => Err(Rejected::BadMessage),
    }
}

/// A tool call as sent back to the model: `arguments` always a JSON string.
fn tool_call(raw: &Value, index: usize) -> Option<Value> {
    let f = raw.get("function").unwrap_or(raw);
    let name = f.get("name")?.as_str()?.trim();
    if name.is_empty() {
        return None;
    }
    let arguments = match f.get("arguments") {
        Some(Value::String(s)) => s.clone(),
        None | Some(Value::Null) => "{}".to_owned(),
        Some(other) => other.to_string(),
    };
    let id = raw
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("call_{index}"));
    Some(json!({
        "id": id,
        "type": "function",
        "function": {"name": name, "arguments": arguments},
    }))
}

fn message(raw: &Value) -> Result<Value, Rejected> {
    let m = raw.as_object().ok_or(Rejected::BadMessage)?;
    let role = m
        .get("role")
        .and_then(Value::as_str)
        .ok_or(Rejected::BadMessage)?;
    let content = content_of(m)?;
    match role {
        "system" | "user" => {
            let content = content.ok_or(Rejected::BadMessage)?;
            // Shamwari's rule: personal content never reaches cloud
            // inference. Only what a person typed is checked; tool results
            // and system prompts carry readings, times and ids.
            if role == "user" && pii::contains_personal_data(&content) {
                return Err(Rejected::PersonalData);
            }
            Ok(json!({"role": role, "content": content}))
        }
        "assistant" => {
            let calls: Vec<Value> = m
                .get("tool_calls")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .enumerate()
                        .filter_map(|(i, c)| tool_call(c, i))
                        .collect()
                })
                .unwrap_or_default();
            if content.is_none() && calls.is_empty() {
                return Err(Rejected::BadMessage);
            }
            let mut out = json!({"role": "assistant", "content": content.unwrap_or_default()});
            if !calls.is_empty() {
                out["tool_calls"] = Value::Array(calls);
            }
            Ok(out)
        }
        "tool" => {
            let id = m
                .get("tool_call_id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or(Rejected::BadMessage)?;
            Ok(json!({"role": "tool", "tool_call_id": id, "content": content.unwrap_or_default()}))
        }
        _ => Err(Rejected::BadRole),
    }
}

fn tool(raw: &Value) -> Result<Value, Rejected> {
    let f = raw.get("function").ok_or(Rejected::BadTool)?;
    if raw
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("function")
        != "function"
    {
        return Err(Rejected::BadTool);
    }
    let name = f
        .get("name")
        .and_then(Value::as_str)
        .filter(|n| {
            !n.is_empty()
                && n.len() <= 64
                && n.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
        .ok_or(Rejected::BadTool)?;
    let parameters = f
        .get("parameters")
        .cloned()
        .unwrap_or_else(|| json!({"type": "object", "properties": {}}));
    if !parameters.is_object() {
        return Err(Rejected::BadTool);
    }
    let mut function = json!({"name": name, "parameters": parameters});
    if let Some(d) = f.get("description").and_then(Value::as_str) {
        function["description"] = Value::String(d.chars().take(1_000).collect());
    }
    Ok(json!({"type": "function", "function": function}))
}

/// Validate a request body and rebuild it from the known keys only.
pub fn parse(body: &Value) -> Result<Request, Rejected> {
    let obj = body.as_object().ok_or(Rejected::NotAnObject)?;
    let raw = obj
        .get("messages")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
        .ok_or(Rejected::NoMessages)?;
    if raw.len() > MAX_MESSAGES {
        return Err(Rejected::TooManyMessages);
    }
    let messages = raw.iter().map(message).collect::<Result<Vec<_>, _>>()?;
    if !messages.iter().any(|m| m["role"] != "system") {
        return Err(Rejected::NoMessages);
    }
    let tools = match obj.get("tools") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) if a.len() > MAX_TOOLS => return Err(Rejected::TooManyTools),
        Some(Value::Array(a)) => a.iter().map(tool).collect::<Result<Vec<_>, _>>()?,
        Some(_) => return Err(Rejected::BadTool),
    };
    let max_tokens = obj
        .get("max_tokens")
        .and_then(Value::as_u64)
        .map(|n| n.clamp(1, MAX_OUTPUT_TOKENS as u64) as u32)
        .unwrap_or(DEFAULT_OUTPUT_TOKENS);
    let model = obj
        .get("model")
        .and_then(Value::as_str)
        .map(|m| m.trim().trim_start_matches("workers-ai/").to_owned())
        .filter(|m| allowed_model(m));
    Ok(Request {
        model,
        max_tokens,
        messages,
        tools,
    })
}

/// The model to run: the caller's (if allowed), else the Worker's
/// `AI_MODEL` (if allowed), else [`DEFAULT_MODEL`].
pub fn pick_model(requested: Option<&str>, configured: Option<&str>) -> String {
    requested
        .filter(|m| allowed_model(m))
        .or(configured.filter(|m| allowed_model(m)))
        .unwrap_or(DEFAULT_MODEL)
        .trim()
        .to_owned()
}

/// Models that reason before answering, and bill that reasoning from
/// `max_tokens`.
pub fn is_reasoning_model(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    [
        "zai-org/glm",
        "qwen/qwq",
        "qwen/qwen3",
        "openai/gpt-oss",
        "deepseek-r1",
        "moonshotai/kimi",
    ]
    .iter()
    .any(|f| m.contains(f))
}

/// The output budget for a model: what was asked, plus
/// [`REASONING_HEADROOM`] for a reasoning model.
pub fn token_budget(model: &str, requested: u32) -> u32 {
    let base = requested.clamp(1, MAX_OUTPUT_TOKENS);
    if is_reasoning_model(model) {
        base + REASONING_HEADROOM
    } else {
        base
    }
}

/// The Workers AI input: one system message, `guard(app_system)` first
/// (the guardrails, then the caller's system prompts joined), then the rest
/// of the conversation in order.
pub fn build_input(req: &Request, model: &str, guard: impl Fn(&str) -> String) -> Value {
    let app_system: Vec<&str> = req
        .messages
        .iter()
        .filter(|m| m["role"] == "system")
        .filter_map(|m| m["content"].as_str())
        .collect();
    let mut messages = vec![json!({"role": "system", "content": guard(&app_system.join("\n\n"))})];
    messages.extend(
        req.messages
            .iter()
            .filter(|m| m["role"] != "system")
            .cloned(),
    );
    let mut input = json!({
        "messages": messages,
        "max_tokens": token_budget(model, req.max_tokens),
    });
    if is_reasoning_model(model) {
        input["reasoning_effort"] = Value::String(REASONING_EFFORT.to_owned());
    }
    if !req.tools.is_empty() {
        input["tools"] = Value::Array(req.tools.clone());
    }
    input
}

/// The model's answer.
#[derive(Debug, Clone, PartialEq)]
pub struct Completion {
    pub content: String,
    /// OpenAI-shaped tool calls (`arguments` a JSON string).
    pub tool_calls: Vec<Value>,
    pub finish_reason: String,
}

/// Drop a leading `<think>…</think>` block some models put in `content`.
fn without_thinking(text: &str) -> &str {
    let t = text.trim_start();
    if let Some(rest) = t.strip_prefix("<think>") {
        return match rest.find("</think>") {
            Some(end) => rest[end + "</think>".len()..].trim(),
            // Unclosed: all of it was reasoning.
            None => "",
        };
    }
    text.trim()
}

/// Read the answer from a Workers AI output: the OpenAI shape (`choices`)
/// or the older one (`response`, `tool_calls`). Only `content` is the
/// answer; `reasoning_content` / `reasoning` are never returned. `None`
/// when there is neither text nor a tool call (for a reasoning model, often
/// a budget spent entirely on reasoning).
pub fn completion(out: &Value) -> Option<Completion> {
    let (content, calls, finish) = if let Some(choice) = out.get("choices").and_then(|c| c.get(0)) {
        let msg = &choice["message"];
        (
            msg["content"].as_str().unwrap_or(""),
            msg["tool_calls"].as_array(),
            choice["finish_reason"].as_str(),
        )
    } else {
        (
            out["response"].as_str().unwrap_or(""),
            out["tool_calls"].as_array(),
            None,
        )
    };
    let tool_calls: Vec<Value> = calls
        .map(|a| {
            a.iter()
                .enumerate()
                .filter_map(|(i, c)| tool_call(c, i))
                .collect()
        })
        .unwrap_or_default();
    let content = without_thinking(content).to_owned();
    if content.is_empty() && tool_calls.is_empty() {
        return None;
    }
    let finish_reason = match finish {
        Some(f) if !f.is_empty() => f.to_owned(),
        _ if !tool_calls.is_empty() => "tool_calls".to_owned(),
        _ => "stop".to_owned(),
    };
    Some(Completion {
        content,
        tool_calls,
        finish_reason,
    })
}

/// An OpenAI chat completion for the caller.
pub fn response(c: &Completion, model: &str, created: i64) -> Value {
    let mut message = json!({"role": "assistant", "content": c.content});
    if !c.tool_calls.is_empty() {
        message["tool_calls"] = Value::Array(c.tool_calls.clone());
    }
    json!({
        "object": "chat.completion",
        "created": created,
        "model": model,
        "choices": [{"index": 0, "message": message, "finish_reason": c.finish_reason}],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(messages: Value) -> Value {
        json!({"messages": messages, "max_tokens": 600})
    }

    #[test]
    fn parse_rebuilds_known_keys_only() {
        let req = parse(&json!({
            "model": "claude-haiku",
            "max_tokens": 600,
            "messages": [
                {"role": "system", "content": "You are Shamwari.", "extra": 1},
                {"role": "user", "content": "Rain in Harare?", "name": "x"},
            ],
        }))
        .unwrap();
        assert_eq!(req.model, None, "non-@cf models are ignored");
        assert_eq!(req.max_tokens, 600);
        assert_eq!(
            req.messages[0],
            json!({"role": "system", "content": "You are Shamwari."})
        );
        assert_eq!(
            req.messages[1],
            json!({"role": "user", "content": "Rain in Harare?"})
        );
        assert!(req.tools.is_empty());
    }

    #[test]
    fn parse_keeps_an_allowed_model_and_strips_the_provider_prefix() {
        let req = parse(&json!({
            "model": "workers-ai/@cf/zai-org/glm-5.3",
            "messages": [{"role": "user", "content": "hi"}],
        }))
        .unwrap();
        assert_eq!(req.model.as_deref(), Some("@cf/zai-org/glm-5.3"));
        assert_eq!(req.max_tokens, DEFAULT_OUTPUT_TOKENS);
    }

    #[test]
    fn parse_refuses_bad_requests() {
        assert_eq!(parse(&json!([])), Err(Rejected::NotAnObject));
        assert_eq!(parse(&json!({"messages": []})), Err(Rejected::NoMessages));
        assert_eq!(
            parse(&body(json!([{"role": "system", "content": "only system"}]))),
            Err(Rejected::NoMessages)
        );
        assert_eq!(
            parse(&body(json!([{"role": "developer", "content": "x"}]))),
            Err(Rejected::BadRole)
        );
        assert_eq!(
            parse(&body(json!([{"role": "user", "content": 5}]))),
            Err(Rejected::BadMessage)
        );
        assert_eq!(
            parse(&body(json!([{"role": "tool", "content": "x"}]))),
            Err(Rejected::BadMessage),
            "a tool result needs its tool_call_id"
        );
        assert_eq!(
            parse(&body(
                json!([{"role": "user", "content": "a".repeat(MAX_CONTENT_CHARS + 1)}])
            )),
            Err(Rejected::TooLong)
        );
        let many: Vec<Value> = (0..=MAX_MESSAGES)
            .map(|_| json!({"role": "user", "content": "x"}))
            .collect();
        assert_eq!(
            parse(&body(Value::Array(many))),
            Err(Rejected::TooManyMessages)
        );
        assert_eq!(Rejected::BadRole.status(), 400);
    }

    #[test]
    fn personal_data_in_user_turns_is_refused_but_not_in_tool_results() {
        let r = parse(&body(
            json!([{"role": "user", "content": "text me on +263 77 123 4567"}]),
        ));
        assert_eq!(r, Err(Rejected::PersonalData));
        assert_eq!(Rejected::PersonalData.status(), 422);
        assert_eq!(Rejected::PersonalData.code(), "personal_data_detected");
        // A forecast as JSON carries long numbers (unix times); that is fine.
        let ok = parse(&body(json!([
            {"role": "user", "content": "Weather in Harare?"},
            {"role": "assistant", "content": null, "tool_calls": [
                {"id": "c1", "type": "function", "function": {"name": "get_weather", "arguments": "{\"slug\":\"harare\"}"}}
            ]},
            {"role": "tool", "tool_call_id": "c1", "content": "{\"time\": 1696000000123}"},
        ])));
        assert!(ok.is_ok());
    }

    #[test]
    fn tools_pass_through_and_are_checked() {
        let tools = json!([{"type": "function", "function": {
            "name": "search_locations", "description": "Find places",
            "parameters": {"type": "object", "properties": {"query": {"type": "string"}}}
        }}]);
        let req = parse(&json!({"messages": [{"role": "user", "content": "x"}], "tools": tools}))
            .unwrap();
        assert_eq!(req.tools, tools.as_array().unwrap().clone());

        let bad_name = json!([{"type": "function", "function": {"name": "a b"}}]);
        assert_eq!(
            parse(&json!({"messages": [{"role": "user", "content": "x"}], "tools": bad_name})),
            Err(Rejected::BadTool)
        );
        let too_many: Vec<Value> = (0..=MAX_TOOLS)
            .map(|i| json!({"type": "function", "function": {"name": format!("t{i}")}}))
            .collect();
        assert_eq!(
            parse(&json!({"messages": [{"role": "user", "content": "x"}], "tools": too_many})),
            Err(Rejected::TooManyTools)
        );
    }

    #[test]
    fn assistant_tool_call_arguments_become_strings() {
        let req = parse(&body(json!([
            {"role": "user", "content": "x"},
            {"role": "assistant", "tool_calls": [{"function": {"name": "get_weather", "arguments": {"slug": "harare"}}}]},
            {"role": "tool", "tool_call_id": "call_0", "content": "{}"},
        ])))
        .unwrap();
        let call = &req.messages[1]["tool_calls"][0];
        assert_eq!(call["id"], "call_0");
        assert_eq!(call["function"]["arguments"], "{\"slug\":\"harare\"}");
        assert_eq!(req.messages[1]["content"], "");
    }

    #[test]
    fn the_model_is_allowlisted() {
        let glm = "@cf/zai-org/glm-5.3";
        assert_eq!(pick_model(None, Some(glm)), glm);
        assert_eq!(
            pick_model(Some("@cf/qwen/qwen3.8-27b"), Some(glm)),
            "@cf/qwen/qwen3.8-27b"
        );
        assert_eq!(pick_model(Some("gpt-4o"), Some(glm)), glm);
        assert_eq!(pick_model(None, Some("anthropic/claude")), DEFAULT_MODEL);
        assert_eq!(pick_model(None, None), DEFAULT_MODEL);
    }

    #[test]
    fn reasoning_models_get_headroom_and_low_effort() {
        assert!(is_reasoning_model("@cf/zai-org/glm-5.3"));
        assert!(!is_reasoning_model(
            "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
        ));
        assert_eq!(
            token_budget("@cf/zai-org/glm-5.3", 600),
            600 + REASONING_HEADROOM
        );
        assert_eq!(
            token_budget("@cf/meta/llama-3.3-70b-instruct-fp8-fast", 600),
            600
        );
        assert_eq!(
            token_budget("@cf/zai-org/glm-5.3", 1_000_000),
            MAX_OUTPUT_TOKENS + REASONING_HEADROOM
        );

        let req = parse(&body(json!([
            {"role": "system", "content": "App prompt A"},
            {"role": "user", "content": "hi"},
            {"role": "system", "content": "App prompt B"},
        ])))
        .unwrap();
        let input = build_input(&req, "@cf/zai-org/glm-5.3", |app| {
            format!("GUARDRAILS\n\n{app}")
        });
        let msgs = input["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2, "one system message, then the conversation");
        assert_eq!(
            msgs[0]["content"],
            "GUARDRAILS\n\nApp prompt A\n\nApp prompt B"
        );
        assert_eq!(msgs[1]["role"], "user");
        assert_eq!(input["reasoning_effort"], REASONING_EFFORT);
        assert_eq!(input["max_tokens"], 600 + REASONING_HEADROOM);
        assert!(input.get("tools").is_none());

        let llama = build_input(&req, "@cf/meta/llama-3.3-70b-instruct-fp8-fast", |a| {
            a.to_owned()
        });
        assert!(llama.get("reasoning_effort").is_none());
    }

    #[test]
    fn guardrails_lead_even_without_an_app_system_prompt() {
        let req = parse(&body(json!([{"role": "user", "content": "hi"}]))).unwrap();
        let input = build_input(&req, DEFAULT_MODEL, |app| format!("G|{app}"));
        assert_eq!(
            input["messages"][0],
            json!({"role": "system", "content": "G|"})
        );
    }

    #[test]
    fn content_not_reasoning_is_the_answer() {
        let out = json!({"choices": [{"message": {
            "role": "assistant",
            "reasoning_content": "Let me think about Harare...",
            "content": "**Dry and warm** today."
        }, "finish_reason": "stop"}]});
        let c = completion(&out).unwrap();
        assert_eq!(c.content, "**Dry and warm** today.");
        assert_eq!(c.finish_reason, "stop");

        // Budget spent on reasoning: no answer at all.
        let starved = json!({"choices": [{"message": {
            "reasoning_content": "thinking...", "content": null
        }, "finish_reason": "length"}]});
        assert_eq!(completion(&starved), None);

        let inline = json!({"response": "<think>hmm</think>\n\nClear skies."});
        assert_eq!(completion(&inline).unwrap().content, "Clear skies.");
        assert_eq!(
            completion(&json!({"response": "<think>never closed"})),
            None
        );
    }

    #[test]
    fn tool_calls_come_back_in_openai_shape() {
        let openai = json!({"choices": [{"message": {"content": null, "tool_calls": [
            {"id": "call_abc", "type": "function", "function": {"name": "get_weather", "arguments": "{\"slug\":\"harare\"}"}}
        ]}, "finish_reason": "tool_calls"}]});
        let c = completion(&openai).unwrap();
        assert_eq!(c.content, "");
        assert_eq!(c.tool_calls[0]["id"], "call_abc");
        assert_eq!(c.finish_reason, "tool_calls");

        // The older Workers AI shape: [{name, arguments: object}].
        let legacy = json!({"response": "", "tool_calls": [{"name": "search_locations", "arguments": {"query": "Mutare"}}]});
        let c = completion(&legacy).unwrap();
        assert_eq!(
            c.tool_calls[0],
            json!({"id": "call_0", "type": "function", "function": {"name": "search_locations", "arguments": "{\"query\":\"Mutare\"}"}})
        );
        assert_eq!(c.finish_reason, "tool_calls");

        let r = response(&c, "@cf/zai-org/glm-5.3", 1);
        assert_eq!(r["object"], "chat.completion");
        assert_eq!(r["model"], "@cf/zai-org/glm-5.3");
        assert_eq!(
            r["choices"][0]["message"]["tool_calls"],
            Value::Array(c.tool_calls.clone())
        );
        assert_eq!(r["choices"][0]["finish_reason"], "tool_calls");
    }

    #[test]
    fn a_plain_response_has_no_tool_calls_key() {
        let c = completion(&json!({"response": "Hello"})).unwrap();
        let r = response(&c, DEFAULT_MODEL, 0);
        assert!(r["choices"][0]["message"].get("tool_calls").is_none());
        assert_eq!(r["choices"][0]["message"]["content"], "Hello");
    }
}
