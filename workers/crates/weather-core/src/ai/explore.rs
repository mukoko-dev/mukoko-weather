//! AI location search (`POST /v1/ai/explore/search`): a natural-language
//! query ("farming areas with low frost risk") answered by the model with two
//! tools, `search_locations` and `get_weather`, and a plain text search when
//! the model cannot answer.
//!
//! Ported from the former `api/py/_explore_search.py` and pinned to it by
//! `tests/fixtures/explore-search.json`, whose `expected` values were produced
//! by the real Python: the two tool executors, the text-search fallback, the
//! system prompt and the whole endpoint with a scripted model. Everything
//! here is pure; the Worker (`workers/ai`) does the I/O: the model call
//! through the `shamwari` AI Gateway, the forecast binding for `get_weather`,
//! the D1 budget.
//!
//! One difference from the Python, on purpose: `get_weather` there read only
//! the MongoDB cache. The Worker asks the forecast Worker (a KV-cached chain),
//! which can fetch on a miss, so a request is limited to
//! [`MAX_WEATHER_LOOKUPS`] lookups.

use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::{json, Map, Value};

use super::completions::Completion;
use crate::locations::{seed_locations, LocationDoc};

/// Longest query accepted.
pub const MAX_QUERY_LEN: usize = 500;
/// Most model calls (tool rounds) for one search.
pub const MAX_TOOL_ITERATIONS: usize = 3;
/// Most `get_weather` lookups for one search, across all rounds.
pub const MAX_WEATHER_LOOKUPS: usize = 8;
/// The answer length asked of the model (`system:explore_search`).
pub const MAX_TOKENS: u32 = 400;
/// Most places in an answer.
pub const MAX_LOCATIONS: usize = 10;
/// Most places one `search_locations` call returns to the model.
const SEARCH_RESULT_CAP: usize = 20;
/// Places named in the system prompt.
const PROMPT_LOCATIONS: usize = 50;
/// Characters of the query put in the system prompt.
const QUERY_IN_PROMPT: usize = 200;

/// The system prompt (`system:explore_search`); `{query}` is the user's query.
pub const SYSTEM: &str =
    "You are Shamwari Weather, helping users find locations based on weather conditions.

The user is searching for: \"{query}\"

Use your tools to find locations that match their criteria. Return a brief summary of your findings.

Rules:
- Search for relevant locations using the available tools
- Fetch weather for the top matches to verify they meet the criteria
- Be concise — summarize in 2-3 sentences
- Never use emoji
- If no locations match, suggest alternatives";

/// What the tool results tell the model.
pub const ERR_INVALID_SLUG: &str = "Invalid location slug";
pub const ERR_UNAVAILABLE: &str = "Weather data unavailable";
const ERR_UNKNOWN_TOOL: &str = "Unknown tool";
const ERR_TOO_MANY_LOOKUPS: &str =
    "Too many weather lookups for one search; answer with what you have";

/// A place the tools can name: what the model is shown and what a weather
/// lookup needs.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Entry {
    pub slug: String,
    pub name: String,
    #[serde(default)]
    pub province: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub country: Option<String>,
    #[serde(default)]
    pub lat: Option<f64>,
    #[serde(default)]
    pub lon: Option<f64>,
}

impl From<&LocationDoc> for Entry {
    fn from(l: &LocationDoc) -> Entry {
        Entry {
            slug: l.slug.clone(),
            name: l.name.clone(),
            province: l.province.clone(),
            tags: l.tags.clone(),
            country: l.country.clone(),
            lat: Some(l.lat),
            lon: Some(l.lon),
        }
    }
}

/// The places the search covers: the app's seed locations, compiled in.
pub fn catalogue() -> &'static [Entry] {
    static CATALOGUE: OnceLock<Vec<Entry>> = OnceLock::new();
    CATALOGUE.get_or_init(|| seed_locations().iter().map(Entry::from).collect())
}

/// Why a query is refused before any work.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Invalid {
    Empty,
    TooLong,
}

impl Invalid {
    pub fn description(self) -> &'static str {
        match self {
            Invalid::Empty => "Query is required",
            Invalid::TooLong => "Query too long (max 500 characters)",
        }
    }
}

/// The trimmed query, or why it is refused.
pub fn query(raw: &str) -> Result<String, Invalid> {
    let q = raw.trim();
    if q.is_empty() {
        Err(Invalid::Empty)
    } else if q.chars().count() > MAX_QUERY_LEN {
        Err(Invalid::TooLong)
    } else {
        Ok(q.to_owned())
    }
}

/// The system prompt for a query: the template with the query (first 200
/// characters) and the first 50 places.
pub fn system_prompt(query: &str, catalogue: &[Entry]) -> String {
    let q: String = query.chars().take(QUERY_IN_PROMPT).collect();
    let list: Vec<String> = catalogue
        .iter()
        .take(PROMPT_LOCATIONS)
        .map(|l| format!("{} ({})", l.name, l.slug))
        .collect();
    format!(
        "{}\n\nAvailable locations include: {}",
        SYSTEM.replace("{query}", &q),
        list.join(", ")
    )
}

/// The tools offered to the model (OpenAI function format).
pub fn tools() -> Vec<Value> {
    vec![
        json!({"type": "function", "function": {
            "name": "search_locations",
            "description": "Search for locations by name, tag, or province. Returns matching locations.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query (location name, province, or keyword)"
                    },
                    "tag": {
                        "type": "string",
                        "description": "Filter by tag (city, farming, mining, tourism, etc.)"
                    }
                },
                "required": []
            }
        }}),
        json!({"type": "function", "function": {
            "name": "get_weather",
            "description": "Get current weather for a specific location by slug.",
            "parameters": {
                "type": "object",
                "properties": {
                    "slug": {
                        "type": "string",
                        "description": "Location slug (e.g. 'harare', 'victoria-falls')"
                    }
                },
                "required": ["slug"]
            }
        }}),
    ]
}

fn text_arg(args: &Value, key: &str) -> String {
    args.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// `search_locations`: places whose name or province contains the query, or
/// that carry the tag; everything when neither is given. At most 20.
pub fn search_locations(args: &Value, catalogue: &[Entry]) -> Value {
    let q = text_arg(args, "query").trim().to_lowercase();
    let t = text_arg(args, "tag").trim().to_lowercase();
    let hits: Vec<Value> = catalogue
        .iter()
        .filter(|l| {
            let by_text = !q.is_empty()
                && (l.name.to_lowercase().contains(&q) || l.province.to_lowercase().contains(&q));
            let by_tag = !t.is_empty() && l.tags.contains(&t);
            by_text || by_tag || (q.is_empty() && t.is_empty())
        })
        .take(SEARCH_RESULT_CAP)
        .map(|l| {
            json!({
                "slug": l.slug,
                "name": l.name,
                "province": l.province,
                "country": l.country.clone().unwrap_or_default(),
                "tags": l.tags,
            })
        })
        .collect();
    Value::Array(hits)
}

/// A slug the weather tool accepts: `^[a-z0-9-]{1,80}$`.
pub fn valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 80
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// `{"error": ...}` for a tool the model should not retry.
pub fn tool_error(message: &str) -> Value {
    json!({ "error": message })
}

/// The error for a slug with no weather to show.
pub fn no_weather(slug: &str) -> Value {
    tool_error(&format!("No weather data for {slug}"))
}

/// `get_weather`'s answer from a forecast's `current` block.
pub fn weather_result(slug: &str, current: &Value, provider: &str) -> Value {
    json!({
        "slug": slug,
        "temperature": current["temperature_2m"],
        "humidity": current["relative_humidity_2m"],
        "windSpeed": current["wind_speed_10m"],
        "weatherCode": current["weather_code"],
        "precipitation": current["precipitation"],
        "uvIndex": current["uv_index"],
        "cloudCover": current["cloud_cover"],
        "provider": provider,
    })
}

/// One tool call the model asked for.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub args: Value,
}

impl ToolCall {
    /// From an OpenAI-shaped call (`arguments` a JSON string). Arguments that
    /// are blank, not JSON or not an object are `{}`.
    pub fn from_value(raw: &Value) -> Option<ToolCall> {
        let f = &raw["function"];
        let name = f["name"].as_str()?.to_owned();
        let args = match &f["arguments"] {
            Value::String(s) if !s.trim().is_empty() => {
                serde_json::from_str::<Value>(s).unwrap_or(Value::Null)
            }
            Value::Object(_) => f["arguments"].clone(),
            _ => Value::Null,
        };
        Some(ToolCall {
            id: raw["id"].as_str().unwrap_or_default().to_owned(),
            name,
            args: if args.is_object() { args } else { json!({}) },
        })
    }
}

/// What a tool call needs done.
#[derive(Debug, Clone, PartialEq)]
pub enum Work {
    /// Answered without I/O: the text for the model.
    Done(String),
    /// A forecast for a place: ask the forecast Worker for `lat`, `lon` and
    /// pass its `current` block to [`weather_result`] (or [`ERR_UNAVAILABLE`]).
    Weather { slug: String, lat: f64, lon: f64 },
}

/// What step a model answer leads to.
#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    /// No tool calls: the text is the summary.
    Done,
    /// Run these, [`Session::record`] each result, and call the model again.
    Tools(Vec<ToolCall>),
}

/// One search: the conversation with the model and the places found.
#[derive(Debug, Clone)]
pub struct Session {
    messages: Vec<Value>,
    collected: Vec<Value>,
    rounds: usize,
    weather_lookups: usize,
    text: String,
}

impl Session {
    pub fn new(query: &str) -> Session {
        Session {
            messages: vec![json!({"role": "user", "content": query})],
            collected: Vec::new(),
            rounds: 0,
            weather_lookups: 0,
            text: String::new(),
        }
    }

    /// The conversation so far, without the system prompt.
    pub fn messages(&self) -> &[Value] {
        &self.messages
    }

    /// Start a model round; `false` once [`MAX_TOOL_ITERATIONS`] have run.
    pub fn begin_round(&mut self) -> bool {
        if self.rounds >= MAX_TOOL_ITERATIONS {
            return false;
        }
        self.rounds += 1;
        true
    }

    /// Take the model's answer. Its text is kept (the last one is the
    /// summary); with tool calls it joins the conversation.
    pub fn accept(&mut self, c: &Completion) -> Step {
        self.text = c.content.clone();
        let calls: Vec<ToolCall> = c
            .tool_calls
            .iter()
            .filter_map(ToolCall::from_value)
            .collect();
        if calls.is_empty() {
            return Step::Done;
        }
        self.messages.push(json!({
            "role": "assistant",
            "content": c.content,
            "tool_calls": c.tool_calls,
        }));
        Step::Tools(calls)
    }

    /// What a tool call needs. `search_locations` and the refusals are
    /// answered here; `get_weather` for a known place is I/O.
    pub fn plan(&mut self, call: &ToolCall, catalogue: &[Entry]) -> Work {
        match call.name.as_str() {
            "search_locations" => Work::Done(search_locations(&call.args, catalogue).to_string()),
            "get_weather" => {
                let slug = text_arg(&call.args, "slug");
                if !valid_slug(&slug) {
                    return Work::Done(tool_error(ERR_INVALID_SLUG).to_string());
                }
                let Some((lat, lon)) = catalogue
                    .iter()
                    .find(|l| l.slug == slug)
                    .and_then(|l| l.lat.zip(l.lon))
                else {
                    return Work::Done(no_weather(&slug).to_string());
                };
                if self.weather_lookups >= MAX_WEATHER_LOOKUPS {
                    return Work::Done(tool_error(ERR_TOO_MANY_LOOKUPS).to_string());
                }
                self.weather_lookups += 1;
                Work::Weather { slug, lat, lon }
            }
            _ => Work::Done(tool_error(ERR_UNKNOWN_TOOL).to_string()),
        }
    }

    /// Return a tool's result to the model, and keep the places it found.
    pub fn record(&mut self, call: &ToolCall, result: &str) {
        self.messages
            .push(json!({"role": "tool", "tool_call_id": call.id, "content": result}));
        let Ok(parsed) = serde_json::from_str::<Value>(result) else {
            return;
        };
        match call.name.as_str() {
            "search_locations" => {
                for loc in parsed.as_array().into_iter().flatten() {
                    let Some(slug) = loc["slug"].as_str().filter(|s| !s.is_empty()) else {
                        continue;
                    };
                    if !self.collected.iter().any(|c| c["slug"] == slug) {
                        self.collected.push(loc.clone());
                    }
                }
            }
            "get_weather" => {
                let slug = parsed["slug"].as_str().unwrap_or_default();
                if slug.is_empty() || !parsed["error"].is_null() {
                    return;
                }
                if let Some(Value::Object(place)) =
                    self.collected.iter_mut().find(|c| c["slug"] == slug)
                {
                    for (to, from) in [
                        ("temperature", "temperature"),
                        ("weatherCode", "weatherCode"),
                        ("humidity", "humidity"),
                        ("windSpeed", "windSpeed"),
                    ] {
                        place.insert(to.into(), parsed[from].clone());
                    }
                }
            }
            _ => {}
        }
    }

    /// The answer: up to ten places and the model's last text, or a count
    /// when it said nothing.
    pub fn finish(self) -> Value {
        let summary = if self.text.is_empty() {
            format!(
                "Found {} locations matching your search.",
                self.collected.len()
            )
        } else {
            self.text
        };
        json!({
            "locations": self.collected.into_iter().take(MAX_LOCATIONS).collect::<Vec<_>>(),
            "summary": summary,
        })
    }
}

/// The weather a text-search result carries.
#[derive(Debug, Clone, PartialEq)]
pub struct Brief {
    pub temperature: Value,
    pub weather_code: Value,
}

impl Brief {
    /// From a forecast's `current` block; `None` when it is empty.
    pub fn of(current: &Value) -> Option<Brief> {
        let has_any = current.as_object().is_some_and(|o| !o.is_empty());
        has_any.then(|| Brief {
            temperature: current["temperature_2m"].clone(),
            weather_code: current["weather_code"].clone(),
        })
    }
}

/// The places whose name, province or tags contain the whole query: the
/// fallback when the model cannot answer.
pub fn text_matches<'a>(query: &str, catalogue: &'a [Entry]) -> Vec<&'a Entry> {
    let q = query.trim().to_lowercase();
    catalogue
        .iter()
        .filter(|l| {
            l.name.to_lowercase().contains(&q)
                || l.province.to_lowercase().contains(&q)
                || l.tags.join(" ").contains(&q)
        })
        .collect()
}

/// The fallback answer: the first ten matches, each with the weather it has a
/// [`Brief`] for (`briefs` lines up with `matches`; missing entries are none).
pub fn text_result(query: &str, matches: &[&Entry], briefs: &[Option<Brief>]) -> Value {
    let places: Vec<Value> = matches
        .iter()
        .take(MAX_LOCATIONS)
        .enumerate()
        .map(|(i, l)| {
            let mut place = Map::new();
            place.insert("slug".into(), json!(l.slug));
            place.insert("name".into(), json!(l.name));
            place.insert("province".into(), json!(l.province));
            place.insert(
                "country".into(),
                json!(l.country.clone().unwrap_or_default()),
            );
            place.insert("tags".into(), json!(l.tags));
            if let Some(Some(b)) = briefs.get(i) {
                place.insert("temperature".into(), b.temperature.clone());
                place.insert("weatherCode".into(), b.weather_code.clone());
            }
            Value::Object(place)
        })
        .collect();
    let summary = if matches.is_empty() {
        format!("No locations found matching \"{query}\". Try a different search term.")
    } else {
        format!("Found {} locations matching \"{query}\".", matches.len())
    };
    json!({"locations": places, "summary": summary})
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    /// `tests/fixtures/explore-search.json`: every `expected` was produced by
    /// the real Python `_explore_search.py`.
    const FIXTURE: &str = include_str!("../../../../../tests/fixtures/explore-search.json");

    fn fixture() -> Value {
        serde_json::from_str(FIXTURE).unwrap()
    }

    fn context(f: &Value) -> Vec<Entry> {
        serde_json::from_value(f["context"].clone()).unwrap()
    }

    fn currents(f: &Value) -> BTreeMap<String, Value> {
        serde_json::from_value(f["currents"].clone()).unwrap()
    }

    #[test]
    fn the_tools_are_the_pythons() {
        assert_eq!(Value::Array(tools()), fixture()["tools"]);
    }

    #[test]
    fn search_locations_matches_the_python() {
        let f = fixture();
        let ctx = context(&f);
        for case in f["searchCases"].as_array().unwrap() {
            assert_eq!(
                search_locations(&case["args"], &ctx),
                case["expected"],
                "{}",
                case["args"]
            );
        }
    }

    #[test]
    fn get_weather_results_match_the_python() {
        let f = fixture();
        for case in f["weatherCases"].as_array().unwrap() {
            let slug = case["slug"].as_str().unwrap();
            let got = if !valid_slug(slug) {
                tool_error(ERR_INVALID_SLUG)
            } else if case["current"].is_null() {
                no_weather(slug)
            } else {
                weather_result(
                    slug,
                    &case["current"],
                    case["provider"].as_str().unwrap_or("unknown"),
                )
            };
            assert_eq!(got, case["expected"], "{slug}");
        }
    }

    #[test]
    fn the_text_search_matches_the_python() {
        let f = fixture();
        let (ctx, current) = (context(&f), currents(&f));
        for case in f["fallbackCases"].as_array().unwrap() {
            let q = case["query"].as_str().unwrap();
            let matches = text_matches(q, &ctx);
            let briefs: Vec<Option<Brief>> = matches
                .iter()
                .map(|l| current.get(&l.slug).and_then(Brief::of))
                .collect();
            assert_eq!(text_result(q, &matches, &briefs), case["expected"], "{q:?}");
        }
    }

    #[test]
    fn the_system_prompt_matches_the_python() {
        let f = fixture();
        let ctx = context(&f);
        for case in f["promptCases"].as_array().unwrap() {
            let q = case["query"].as_str().unwrap();
            let got = system_prompt(q, &[]);
            // The Python's endpoint appends the place list after this text.
            assert_eq!(
                got.trim_end_matches("\n\nAvailable locations include: "),
                case["expected"].as_str().unwrap(),
                "{q:?}"
            );
        }
        let full = system_prompt("farming", &ctx);
        let first = f["loopCases"][0]["calls"][0]["system"].as_str().unwrap();
        assert!(first.contains("\n\nAvailable locations include: "));
        assert_eq!(
            full.split("\n\nAvailable locations include: ").nth(1),
            first.split("\n\nAvailable locations include: ").nth(1),
            "the same fifty places, in the same order"
        );
    }

    /// The model, scripted: `{"text", "toolCalls": [{id, name, arguments}]}`
    /// as a completion, or `{"error"}`.
    fn completion(step: &Value) -> Completion {
        let calls: Vec<Value> = step["toolCalls"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|t| {
                        json!({"id": t["id"], "type": "function", "function": {
                            "name": t["name"],
                            "arguments": serde_json::to_string(&t["arguments"]).unwrap(),
                        }})
                    })
                    .collect()
            })
            .unwrap_or_default();
        Completion {
            content: step["text"].as_str().unwrap_or_default().to_owned(),
            finish_reason: if calls.is_empty() {
                "stop"
            } else {
                "tool_calls"
            }
            .into(),
            tool_calls: calls,
        }
    }

    /// Tool messages are compared as JSON (the Python's text has other spacing).
    fn normalised(messages: &[Value]) -> Vec<Value> {
        messages
            .iter()
            .map(|m| {
                let mut m = m.clone();
                if m["role"] == "tool" {
                    let parsed: Value =
                        serde_json::from_str(m["content"].as_str().unwrap()).unwrap();
                    m["content"] = parsed;
                }
                if let Some(calls) = m["tool_calls"].as_array_mut() {
                    for c in calls {
                        let parsed: Value =
                            serde_json::from_str(c["function"]["arguments"].as_str().unwrap())
                                .unwrap();
                        c["function"]["arguments"] = parsed;
                    }
                }
                m
            })
            .collect()
    }

    #[test]
    fn the_whole_search_matches_the_python() {
        let f = fixture();
        let (ctx, current) = (context(&f), currents(&f));
        let text_fallback = |q: &str| {
            let matches = text_matches(q, &ctx);
            let briefs: Vec<Option<Brief>> = matches
                .iter()
                .map(|l| current.get(&l.slug).and_then(Brief::of))
                .collect();
            text_result(q, &matches, &briefs)
        };
        for case in f["loopCases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let q = case["query"].as_str().unwrap();
            let mut seen: Vec<Value> = Vec::new();
            let got = if case["breakerOpen"] == true {
                text_fallback(q)
            } else {
                let mut session = Session::new(q);
                let mut script = case["script"].as_array().unwrap().iter();
                let mut failed = false;
                while session.begin_round() {
                    seen.push(json!({"messages": normalised(session.messages())}));
                    let step = script.next().unwrap();
                    if step.get("error").is_some() {
                        failed = true;
                        break;
                    }
                    match session.accept(&completion(step)) {
                        Step::Done => break,
                        Step::Tools(calls) => {
                            for call in calls {
                                let result = match session.plan(&call, &ctx) {
                                    Work::Done(text) => text,
                                    Work::Weather { slug, .. } => match current.get(&slug) {
                                        Some(c) => {
                                            weather_result(&slug, c, "open-meteo:blend").to_string()
                                        }
                                        None => no_weather(&slug).to_string(),
                                    },
                                };
                                session.record(&call, &result);
                            }
                        }
                    }
                }
                if failed {
                    text_fallback(q)
                } else {
                    session.finish()
                }
            };
            assert_eq!(got, case["expected"], "{name}");
            // The conversation the model saw in each round is the Python's.
            if case["breakerOpen"] != true {
                let want: Vec<Value> = case["calls"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|c| json!({"messages": normalised(c["messages"].as_array().unwrap())}))
                    .collect();
                assert_eq!(seen, want, "{name}: messages");
            }
        }
    }

    #[test]
    fn a_search_makes_at_most_three_rounds_and_eight_weather_lookups() {
        let ctx = catalogue();
        let mut s = Session::new("q");
        assert!(s.begin_round() && s.begin_round() && s.begin_round());
        assert!(!s.begin_round());
        let call = |slug: &str| ToolCall {
            id: "c".into(),
            name: "get_weather".into(),
            args: json!({"slug": slug}),
        };
        for _ in 0..MAX_WEATHER_LOOKUPS {
            assert!(matches!(s.plan(&call("harare"), ctx), Work::Weather { .. }));
        }
        match s.plan(&call("harare"), ctx) {
            Work::Done(t) => assert!(t.contains("Too many weather lookups")),
            other => panic!("{other:?}"),
        }
        // Refusals do not use a lookup.
        match s.plan(&call("Not A Slug"), ctx) {
            Work::Done(t) => assert!(t.contains("Invalid location slug")),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn queries_are_trimmed_and_bounded() {
        assert_eq!(query("  warm places  ").unwrap(), "warm places");
        assert_eq!(query("   "), Err(Invalid::Empty));
        assert_eq!(
            query(&"a".repeat(MAX_QUERY_LEN)).map(|q| q.len()),
            Ok(MAX_QUERY_LEN)
        );
        assert_eq!(query(&"a".repeat(MAX_QUERY_LEN + 1)), Err(Invalid::TooLong));
        assert_eq!(Invalid::Empty.description(), "Query is required");
    }

    #[test]
    fn tool_arguments_that_are_not_an_object_are_empty() {
        let call = |args: Value| {
            ToolCall::from_value(&json!({"id": "c", "function": {"name": "t", "arguments": args}}))
                .unwrap()
                .args
        };
        assert_eq!(call(json!("{\"tag\": \"city\"}")), json!({"tag": "city"}));
        assert_eq!(call(json!("")), json!({}));
        assert_eq!(call(json!("  ")), json!({}));
        assert_eq!(call(json!("not json")), json!({}));
        assert_eq!(call(json!("[1]")), json!({}));
        assert_eq!(call(json!({"tag": "city"})), json!({"tag": "city"}));
        assert_eq!(call(Value::Null), json!({}));
        assert!(ToolCall::from_value(&json!({"function": {}})).is_none());
    }

    #[test]
    fn the_compiled_catalogue_is_the_seed() {
        let c = catalogue();
        assert_eq!(c.len(), seed_locations().len());
        assert!(c.iter().any(|l| l.slug == "harare" && l.lat.is_some()));
        // The shipped list always contains the places the prompt names first.
        assert!(system_prompt("x", c).contains("Harare (harare)"));
    }
}
