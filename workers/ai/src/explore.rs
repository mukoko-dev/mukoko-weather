//! `POST /v1/ai/explore/search`: the AI location search.
//!
//! `{query}` → `{locations: [{slug, name, province, country, tags,
//! temperature?, weatherCode?, humidity?, windSpeed?}], summary, source}`.
//! The model gets two tools, `search_locations` (the compiled-in seed
//! catalogue) and `get_weather` (the forecast Worker over its binding), and up
//! to three rounds to use them (`weather_core::ai::explore`, pinned to the
//! former Python by `tests/fixtures/explore-search.json`).
//!
//! When the model cannot answer (no guardrails block, the service-wide hour is
//! spent, a model error or a block) the answer is the plain text match,
//! `source: "text"`, as the Python's was. A client over its own hour gets
//! `429`: the model is the costly part and the hour is the client's.

use futures::future::join_all;
use serde_json::{json, Value};
use weather_core::ai::explore::{self, Brief, Entry, Session, Step, Work};
use weather_core::ai::guardrails::{system_prompt, Compiled};
use weather_core::ai::{completions, pii, Invalid};
use weather_core::budget::{Action, Decision};
use weather_edge::budget::{self, Caller};
use weather_edge::{error, json, responses};
use worker::{Env, Response, Result};

use crate::{gateway, handlers};

/// The gateway metadata route name (no user content).
const ROUTE: &str = "explore";

/// `guardrails` is `None` when the Nyuchi API's block could not be had: the
/// model is not called, but a text search needs none.
pub async fn handle(
    env: &Env,
    guardrails: Option<Compiled>,
    caller: Caller,
    body: Value,
) -> Result<Response> {
    let query = match explore::query(body["query"].as_str().unwrap_or("")) {
        Ok(q) => q,
        Err(e) => return error(400, "invalid_request", e.description()),
    };
    // Shamwari's rule: personal content never reaches cloud inference.
    if pii::contains_personal_data(&query) {
        return error(
            422,
            "personal_data_detected",
            Invalid::PersonalData.description(),
        );
    }
    let catalogue = explore::catalogue();
    let Some(guardrails) = guardrails else {
        return text_search(env, &query, catalogue).await;
    };

    match budget::take(env, Action::ExploreSearch, &caller).await {
        Decision::Allow => {}
        Decision::ClientLimit => {
            return responses::rate_limited(
                900,
                "You have used this hour's AI searches. Search by name, or try again later.",
            )
        }
        // The service's hour is spent, or the budget cannot be read (it fails
        // closed): no model call, the text match answers.
        Decision::GlobalLimit => return text_search(env, &query, catalogue).await,
    }

    match ai_search(env, &guardrails, &query, catalogue).await {
        Some(answer) => json(200, &with_source(answer, "ai")),
        None => text_search(env, &query, catalogue).await,
    }
}

fn with_source(mut answer: Value, source: &str) -> Value {
    answer["source"] = json!(source);
    answer
}

/// The model's search. `None` when a model call fails or is blocked.
async fn ai_search(
    env: &Env,
    guardrails: &Compiled,
    query: &str,
    catalogue: &[Entry],
) -> Option<Value> {
    let model = gateway::configured_model(env);
    let system = explore::system_prompt(query, catalogue);
    let mut session = Session::new(query);
    while session.begin_round() {
        let mut messages = vec![json!({"role": "system", "content": system})];
        messages.extend(session.messages().iter().cloned());
        let request = completions::Request {
            model: None,
            max_tokens: explore::MAX_TOKENS,
            messages,
            tools: explore::tools(),
        };
        let input =
            completions::build_input(&request, &model, |app| system_prompt(guardrails, app));
        let completion = gateway::complete(env, ROUTE, &model, &input).await.ok()?;
        match session.accept(&completion) {
            Step::Done => break,
            Step::Tools(calls) => {
                // Plan every call first, fetch the forecasts side by side,
                // then give the model the results in order.
                let planned: Vec<_> = calls
                    .into_iter()
                    .map(|call| {
                        let work = session.plan(&call, catalogue);
                        (call, work)
                    })
                    .collect();
                let fetched = join_all(planned.iter().map(|(_, work)| async move {
                    match work {
                        Work::Weather { slug, lat, lon } => {
                            Some(weather_for_model(env, slug, *lat, *lon).await)
                        }
                        Work::Done(_) => None,
                    }
                }))
                .await;
                for ((call, work), fetched) in planned.into_iter().zip(fetched) {
                    let result = match work {
                        Work::Done(text) => text,
                        Work::Weather { .. } => fetched.unwrap_or_default(),
                    };
                    session.record(&call, &result);
                }
            }
        }
    }
    Some(session.finish())
}

/// The `get_weather` result for a place: its current conditions from the
/// forecast Worker, or the plain "unavailable".
async fn weather_for_model(env: &Env, slug: &str, lat: f64, lon: f64) -> String {
    match handlers::weather(env, lat, lon).await {
        Some(data) if data["current"].is_object() => explore::weather_result(
            slug,
            &data["current"],
            data["baseline"]["provider"].as_str().unwrap_or("unknown"),
        ),
        _ => explore::tool_error(explore::ERR_UNAVAILABLE),
    }
    .to_string()
}

/// The text match, each of the first places with the weather the forecast
/// Worker has for it.
async fn text_search(env: &Env, query: &str, catalogue: &[Entry]) -> Result<Response> {
    let matches = explore::text_matches(query, catalogue);
    let briefs: Vec<Option<Brief>> = join_all(matches.iter().take(explore::MAX_LOCATIONS).map(
        |place| async move {
            let (lat, lon) = place.lat.zip(place.lon)?;
            let data = handlers::weather(env, lat, lon).await?;
            Brief::of(&data["current"])
        },
    ))
    .await;
    json(
        200,
        &with_source(explore::text_result(query, &matches, &briefs), "text"),
    )
}
