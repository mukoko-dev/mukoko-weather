//! The app's reference data: activities, categories, suitability rules, tags,
//! regions, AI prompts and the suggested prompt rules.
//!
//! Ported from `api/py/_data.py`, `_suitability.py` and `_ai_prompts.py`. The
//! Python backend read these from MongoDB, where `/api/db-init` had copied the
//! app's seed files (`src/lib/activities.ts`, `seed-*.ts`). The Workers keep no
//! database connection (#150), so the same documents are compiled in from
//! `data/reference/*.json`, which `workers/scripts/gen-reference-data.mjs`
//! regenerates from those seed files (CI fails when they are stale).
//!
//! The one thing MongoDB held that the seed files do not is the data-managed
//! `aiInstructions` on an activity. They are compiled in from
//! `data/reference/activity-guidance.json` (a snapshot of the 55 production
//! documents, 2026-11-01) and used only by the AI Worker's prompts
//! ([`activity_brief`]); `/v1/activities` does not serve them.
//!
//! Every function takes the parsed query and returns a [`Reply`]: status, JSON
//! body and `Cache-Control`, in the shapes the Python routes answered.

use std::sync::OnceLock;

use serde_json::{json, Map, Value};

const ACTIVITIES: &str = include_str!("../data/reference/activities.json");
const CATEGORIES: &str = include_str!("../data/reference/categories.json");
const SUITABILITY: &str = include_str!("../data/reference/suitability-rules.json");
const TAGS: &str = include_str!("../data/reference/tags.json");
const REGIONS: &str = include_str!("../data/reference/regions.json");
const AI_PROMPTS: &str = include_str!("../data/reference/ai-prompts.json");
const AI_RULES: &str = include_str!("../data/reference/ai-suggested-rules.json");
const ACTIVITY_GUIDANCE: &str = include_str!("../data/reference/activity-guidance.json");

const REF_CACHE: &str = "public, max-age=3600, stale-while-revalidate=86400";
const RULES_CACHE: &str = "s-maxage=300, stale-while-revalidate=60";
const PROMPTS_CACHE: &str = "public, max-age=300";

/// What a route answers.
#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    pub status: u16,
    pub body: Value,
    pub cache: &'static str,
}

fn ok(body: Value, cache: &'static str) -> Reply {
    Reply {
        status: 200,
        body,
        cache,
    }
}

fn err(status: u16, code: &str, description: &str) -> Reply {
    Reply {
        status,
        body: json!({"error": code, "error_description": description}),
        cache: "no-store",
    }
}

fn parse(cell: &'static OnceLock<Vec<Value>>, raw: &str) -> &'static [Value] {
    cell.get_or_init(|| serde_json::from_str(raw).expect("reference JSON is valid"))
}

fn activities() -> &'static [Value] {
    static CELL: OnceLock<Vec<Value>> = OnceLock::new();
    parse(&CELL, ACTIVITIES)
}

/// Whether `id` is one of the app's activity ids (the allowlist that
/// replaces `filter_known_activities`' database lookup).
pub fn is_known_activity(id: &str) -> bool {
    activities().iter().any(|a| text(a, "id") == id)
}

/// An activity as an AI prompt names it: the label the user sees, its
/// category, and the per-activity guidance the model is told to follow.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActivityBrief {
    pub id: &'static str,
    pub label: &'static str,
    pub category: &'static str,
    /// What weather factors matter for this activity and what regional
    /// framing to use (`aiInstructions`).
    pub guidance: Option<&'static str>,
}

fn guidance() -> &'static Map<String, Value> {
    static CELL: OnceLock<Map<String, Value>> = OnceLock::new();
    CELL.get_or_init(|| {
        serde_json::from_str(ACTIVITY_GUIDANCE).expect("activity-guidance.json is valid")
    })
}

/// The label, category and guidance of a known activity id; `None` for an id
/// the app does not ship.
pub fn activity_brief(id: &str) -> Option<ActivityBrief> {
    let doc = activities().iter().find(|a| text(a, "id") == id)?;
    Some(ActivityBrief {
        id: text(doc, "id"),
        label: text(doc, "label"),
        category: text(doc, "category"),
        guidance: guidance()
            .get(id)
            .and_then(Value::as_str)
            .filter(|g| !g.trim().is_empty()),
    })
}

/// Whether `slug` is one of the app's location tags (the allowlist that
/// replaces `get_known_tags`' database lookup).
pub fn is_known_tag(slug: &str) -> bool {
    tags().iter().any(|t| text(t, "slug") == slug)
}

fn categories() -> &'static [Value] {
    static CELL: OnceLock<Vec<Value>> = OnceLock::new();
    parse(&CELL, CATEGORIES)
}

fn rules() -> &'static [Value] {
    static CELL: OnceLock<Vec<Value>> = OnceLock::new();
    parse(&CELL, SUITABILITY)
}

fn tags() -> &'static [Value] {
    static CELL: OnceLock<Vec<Value>> = OnceLock::new();
    parse(&CELL, TAGS)
}

fn regions() -> &'static [Value] {
    static CELL: OnceLock<Vec<Value>> = OnceLock::new();
    parse(&CELL, REGIONS)
}

fn prompts() -> &'static [Value] {
    static CELL: OnceLock<Vec<Value>> = OnceLock::new();
    parse(&CELL, AI_PROMPTS)
}

fn suggested_rules() -> &'static [Value] {
    static CELL: OnceLock<Vec<Value>> = OnceLock::new();
    parse(&CELL, AI_RULES)
}

fn text<'a>(doc: &'a Value, field: &str) -> &'a str {
    doc.get(field).and_then(Value::as_str).unwrap_or("")
}

fn get<'a>(query: &'a [(String, String)], name: &str) -> Option<&'a str> {
    query
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
        .filter(|v| !v.is_empty())
}

/// FastAPI's boolean query parsing.
fn truthy(value: Option<&str>) -> bool {
    matches!(
        value.map(str::to_ascii_lowercase).as_deref(),
        Some("true" | "1" | "yes" | "on" | "t" | "y")
    )
}

/// MongoDB's default string sort is byte order, which is `str`'s order.
fn sorted_by(mut docs: Vec<&Value>, key: impl Fn(&Value) -> (String, String)) -> Vec<&Value> {
    docs.sort_by_key(|d| key(d));
    docs
}

const STOP_WORDS: &[&str] = &[
    "a", "an", "and", "the", "of", "in", "on", "to", "for", "with", "is", "it",
];

/// A light English stem: enough that "cycling" finds "cycle" the way the
/// MongoDB text index did.
fn stem(word: &str) -> String {
    for suffix in ["ing", "ed", "es", "s"] {
        if word.len() > suffix.len() + 2 {
            if let Some(base) = word.strip_suffix(suffix) {
                return base.to_owned();
            }
        }
    }
    word.to_owned()
}

fn terms(raw: &str) -> Vec<String> {
    raw.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty() && !STOP_WORDS.contains(w))
        .map(stem)
        .collect()
}

/// `GET /v1/activities` (`id`, `category`, `q`, `labels`, `mode=categories`),
/// in the order and with the answers of `/api/py/activities`.
pub fn activities_reply(query: &[(String, String)]) -> Reply {
    let all = activities();

    if get(query, "mode") == Some("categories") {
        return ok(json!({"categories": categories()}), "no-store");
    }

    if let Some(id) = get(query, "id") {
        return match all.iter().find(|a| text(a, "id") == id) {
            Some(activity) => ok(json!({"activity": activity}), "no-store"),
            None => err(404, "not_found", "Activity not found"),
        };
    }

    if let Some(labels) = get(query, "labels") {
        let wanted: Vec<&str> = labels
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        let mut map = Map::new();
        for a in all.iter().filter(|a| wanted.contains(&text(a, "id"))) {
            map.insert(text(a, "id").to_owned(), json!(text(a, "label")));
        }
        return ok(json!({"labels": map}), "no-store");
    }

    if let Some(q) = get(query, "q") {
        let query_terms = terms(&q.trim().chars().take(200).collect::<String>());
        let mut scored: Vec<(usize, usize, &Value)> = all
            .iter()
            .enumerate()
            .filter_map(|(i, a)| {
                let fields = ["label", "description", "category"]
                    .iter()
                    .flat_map(|f| terms(text(a, f)))
                    .collect::<Vec<_>>();
                let score = query_terms.iter().filter(|t| fields.contains(t)).count();
                (score > 0).then_some((score, i, a))
            })
            .collect();
        scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        let docs: Vec<&Value> = scored.into_iter().take(20).map(|(_, _, a)| a).collect();
        return ok(json!({"activities": docs, "total": docs.len()}), "no-store");
    }

    if let Some(category) = get(query, "category") {
        let docs = sorted_by(
            all.iter()
                .filter(|a| text(a, "category") == category)
                .collect(),
            |a| (text(a, "label").to_owned(), String::new()),
        );
        return ok(json!({"activities": docs, "total": docs.len()}), "no-store");
    }

    let docs = sorted_by(all.iter().collect(), |a| {
        (text(a, "category").to_owned(), text(a, "label").to_owned())
    });
    ok(json!({"activities": docs, "total": docs.len()}), "no-store")
}

/// `^(activity|category):[a-z0-9-]+$`.
fn valid_rule_key(key: &str) -> bool {
    let Some((kind, rest)) = key.split_once(':') else {
        return false;
    };
    matches!(kind, "activity" | "category") && !rest.is_empty() && crate::slug::chars_ok(rest)
}

/// `GET /v1/suitability` (`key`).
pub fn suitability_reply(query: &[(String, String)]) -> Reply {
    if let Some(key) = get(query, "key") {
        if !valid_rule_key(key) {
            return err(400, "invalid_request", "Invalid key format");
        }
        return match rules().iter().find(|r| text(r, "key") == key) {
            Some(rule) => ok(json!({"rule": rule}), RULES_CACHE),
            None => err(404, "not_found", "Rule not found"),
        };
    }
    ok(json!({"rules": rules()}), RULES_CACHE)
}

/// `GET /v1/tags` (`featured=true`).
pub fn tags_reply(query: &[(String, String)]) -> Reply {
    let featured = truthy(get(query, "featured"));
    let docs = sorted_by(
        tags()
            .iter()
            .filter(|t| !featured || t.get("featured") == Some(&Value::Bool(true)))
            .collect(),
        |t| (text(t, "slug").to_owned(), String::new()),
    );
    ok(json!({"tags": docs}), REF_CACHE)
}

/// `GET /v1/regions`: the active regions.
pub fn regions_reply() -> Reply {
    let docs: Vec<&Value> = regions()
        .iter()
        .filter(|r| r.get("active") == Some(&Value::Bool(true)))
        .collect();
    ok(json!({"regions": docs}), REF_CACHE)
}

fn active(doc: &Value) -> bool {
    doc.get("active") == Some(&Value::Bool(true))
}

fn order(doc: &Value) -> i64 {
    doc.get("order").and_then(Value::as_i64).unwrap_or(i64::MAX)
}

/// Browsers get the prompts they can use (`greeting:*`, `user:*`). The
/// `system:*` prompts are the model's instructions: the AI Worker has them
/// compiled in, and they are not served.
fn public_prompt(doc: &Value) -> bool {
    !text(doc, "promptKey").starts_with("system:")
}

/// `GET /v1/ai/prompts` (`key`).
pub fn ai_prompts_reply(query: &[(String, String)]) -> Reply {
    let visible = prompts().iter().filter(|p| active(p) && public_prompt(p));
    if let Some(key) = get(query, "key") {
        return match visible.clone().find(|p| text(p, "promptKey") == key) {
            Some(p) => ok(json!({"prompt": p}), PROMPTS_CACHE),
            None => ok(json!({"prompt": null}), "public, max-age=60"),
        };
    }
    let mut docs: Vec<&Value> = visible.collect();
    docs.sort_by_key(|p| order(p));
    ok(json!({"prompts": docs}), PROMPTS_CACHE)
}

/// `GET /v1/ai/suggested-rules`.
pub fn ai_suggested_rules_reply() -> Reply {
    let mut docs: Vec<&Value> = suggested_rules().iter().filter(|r| active(r)).collect();
    docs.sort_by_key(|r| order(r));
    ok(json!({"rules": docs}), PROMPTS_CACHE)
}

/// The routes this module answers (`/v1/...`).
pub fn serves(path: &str) -> bool {
    matches!(
        path,
        "/v1/activities"
            | "/v1/suitability"
            | "/v1/tags"
            | "/v1/regions"
            | "/v1/ai/prompts"
            | "/v1/ai/suggested-rules"
    )
}

/// The answer for one of [`serves`]' paths.
pub fn reply(path: &str, query: &[(String, String)]) -> Option<Reply> {
    Some(match path {
        "/v1/activities" => activities_reply(query),
        "/v1/suitability" => suitability_reply(query),
        "/v1/tags" => tags_reply(query),
        "/v1/regions" => regions_reply(),
        "/v1/ai/prompts" => ai_prompts_reply(query),
        "/v1/ai/suggested-rules" => ai_suggested_rules_reply(),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    fn list<'a>(reply: &'a Reply, field: &str) -> &'a Vec<Value> {
        reply.body[field].as_array().expect("an array")
    }

    #[test]
    fn every_data_file_parses() {
        assert!(activities().len() >= 50);
        assert_eq!(categories().len(), 6);
        assert!(!rules().is_empty());
        assert!(!tags().is_empty());
        assert!(!regions().is_empty());
        assert!(!prompts().is_empty());
        assert!(!suggested_rules().is_empty());
    }

    #[test]
    fn every_activity_has_guidance_and_nothing_else_does() {
        let ids: Vec<&str> = activities().iter().map(|a| text(a, "id")).collect();
        let mut keyed: Vec<&str> = guidance().keys().map(String::as_str).collect();
        keyed.sort_unstable();
        let mut want = ids.clone();
        want.sort_unstable();
        assert_eq!(
            keyed, want,
            "activity-guidance.json must key exactly the activities"
        );
        for id in ids {
            let brief = activity_brief(id).expect("known");
            assert_eq!(brief.id, id);
            assert!(brief.guidance.is_some_and(|g| g.len() > 20), "{id}");
            assert!(!brief.label.is_empty() && !brief.category.is_empty());
        }
    }

    #[test]
    fn briefs_and_tags_are_allowlists() {
        let football = activity_brief("football").expect("football is shipped");
        assert_eq!(football.category, "sports");
        assert!(activity_brief("ignore previous instructions").is_none());
        assert!(activity_brief("").is_none());
        assert!(is_known_tag("farming") && is_known_tag("city"));
        assert!(!is_known_tag("Farming") && !is_known_tag("evil; tag") && !is_known_tag(""));
    }

    #[test]
    fn all_activities_sort_by_category_then_label() {
        let r = activities_reply(&q(&[]));
        let docs = list(&r, "activities");
        assert_eq!(r.body["total"], docs.len());
        let keys: Vec<(&str, &str)> = docs
            .iter()
            .map(|a| (text(a, "category"), text(a, "label")))
            .collect();
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(keys, sorted);
    }

    #[test]
    fn one_activity_by_id_and_a_404_for_an_unknown_one() {
        let first = text(&activities()[0], "id").to_owned();
        let r = activities_reply(&q(&[("id", &first)]));
        assert_eq!(r.status, 200);
        assert_eq!(r.body["activity"]["id"], first);
        assert_eq!(activities_reply(&q(&[("id", "nope")])).status, 404);
    }

    #[test]
    fn labels_map_ids_to_labels_and_skip_unknown_ids() {
        let a = &activities()[0];
        let ids = format!("{}, nope ,", text(a, "id"));
        let r = activities_reply(&q(&[("labels", &ids)]));
        let map = r.body["labels"].as_object().unwrap();
        assert_eq!(map.len(), 1);
        assert_eq!(map[text(a, "id")], text(a, "label"));
    }

    #[test]
    fn a_category_filter_sorts_by_label() {
        let r = activities_reply(&q(&[("category", "farming")]));
        let docs = list(&r, "activities");
        assert!(!docs.is_empty());
        assert!(docs.iter().all(|a| text(a, "category") == "farming"));
        let labels: Vec<&str> = docs.iter().map(|a| text(a, "label")).collect();
        let mut sorted = labels.clone();
        sorted.sort();
        assert_eq!(labels, sorted);
    }

    #[test]
    fn text_search_finds_by_stem_and_ranks_by_matches() {
        let r = activities_reply(&q(&[("q", "cycling")]));
        let docs = list(&r, "activities");
        assert!(docs.iter().any(|a| text(a, "id") == "cycling"));
        assert!(docs.len() <= 20);
        assert!(list(&activities_reply(&q(&[("q", "zzzzqx")])), "activities").is_empty());
        assert!(list(&activities_reply(&q(&[("q", "the of")])), "activities").is_empty());
    }

    #[test]
    fn categories_mode_lists_the_six_categories() {
        let r = activities_reply(&q(&[("mode", "categories")]));
        assert_eq!(list(&r, "categories").len(), 6);
    }

    #[test]
    fn suitability_validates_the_key_like_the_python_regex() {
        for ok_key in ["activity:drone-flying", "category:farming"] {
            assert!(valid_rule_key(ok_key), "{ok_key}");
        }
        for bad in [
            "",
            "activity:",
            "other:x",
            "activity:Drone",
            "activity:a b",
            "x",
        ] {
            assert!(!valid_rule_key(bad), "{bad}");
        }
        assert_eq!(suitability_reply(&q(&[("key", "bad key")])).status, 400);
        assert_eq!(
            suitability_reply(&q(&[("key", "activity:no-such-rule")])).status,
            404
        );
    }

    #[test]
    fn suitability_serves_one_rule_or_all() {
        let all = suitability_reply(&q(&[]));
        let first = text(&list(&all, "rules")[0], "key").to_owned();
        assert!(first.contains(':'));
        let one = suitability_reply(&q(&[("key", &first)]));
        assert_eq!(one.status, 200);
        assert_eq!(one.body["rule"]["key"], first);
        assert!(one.body["rule"].get("updatedAt").is_none());
    }

    #[test]
    fn tags_sort_by_slug_and_filter_featured() {
        let all = tags_reply(&q(&[]));
        let slugs: Vec<&str> = list(&all, "tags").iter().map(|t| text(t, "slug")).collect();
        let mut sorted = slugs.clone();
        sorted.sort();
        assert_eq!(slugs, sorted);
        let featured = tags_reply(&q(&[("featured", "true")]));
        assert!(list(&featured, "tags").len() <= slugs.len());
        assert!(list(&featured, "tags")
            .iter()
            .all(|t| t["featured"] == Value::Bool(true)));
        assert_eq!(all.cache, REF_CACHE);
    }

    #[test]
    fn regions_are_the_active_ones() {
        let r = regions_reply();
        assert!(list(&r, "regions").iter().all(|x| x["active"] == true));
    }

    #[test]
    fn system_prompts_are_never_served() {
        let all = ai_prompts_reply(&q(&[]));
        assert!(list(&all, "prompts")
            .iter()
            .all(|p| !text(p, "promptKey").starts_with("system:")));
        let sys = ai_prompts_reply(&q(&[("key", "system:chat")]));
        assert_eq!(sys.body["prompt"], Value::Null);
        let greeting = ai_prompts_reply(&q(&[("key", "greeting:location_context")]));
        assert_eq!(
            greeting.body["prompt"]["promptKey"],
            "greeting:location_context"
        );
    }

    #[test]
    fn suggested_rules_are_active_and_ordered() {
        let r = ai_suggested_rules_reply();
        let docs = list(&r, "rules");
        assert!(!docs.is_empty());
        assert!(docs.iter().all(|d| d["active"] == true));
        let orders: Vec<i64> = docs.iter().map(order).collect();
        let mut sorted = orders.clone();
        sorted.sort();
        assert_eq!(orders, sorted);
    }

    #[test]
    fn boolean_query_values_parse_like_fastapi() {
        for yes in ["true", "TRUE", "1", "yes", "on"] {
            assert!(truthy(Some(yes)), "{yes}");
        }
        for no in ["false", "0", "", "maybe"] {
            assert!(!truthy(Some(no)), "{no}");
        }
        assert!(!truthy(None));
    }

    #[test]
    fn routing_covers_exactly_the_served_paths() {
        for path in [
            "/v1/activities",
            "/v1/suitability",
            "/v1/tags",
            "/v1/regions",
            "/v1/ai/prompts",
            "/v1/ai/suggested-rules",
        ] {
            assert!(serves(path), "{path}");
            assert_eq!(reply(path, &q(&[])).unwrap().status, 200, "{path}");
        }
        for path in ["/v1/ai", "/v1/ai/chat", "/v1/weather", "/v1/status"] {
            assert!(!serves(path), "{path}");
            assert!(reply(path, &q(&[])).is_none(), "{path}");
        }
    }
}
