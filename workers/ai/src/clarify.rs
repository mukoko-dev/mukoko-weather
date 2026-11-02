//! `POST /v1/reports/clarify`: the report wizard's follow-up questions.
//!
//! `{locationSlug, reportType}` → `{questions: [..], source: "ai" | "fallback"}`.
//! The model gets a short prompt for the place and the report type and writes
//! one or two questions (`weather_core::ai::clarify`, pinned to the former
//! Python by `tests/fixtures/report-clarify.json`).
//!
//! The wizard works without questions, so this route never fails the visitor:
//! a request that is valid always gets `200`, with the model's questions or the
//! fixed pair for the report type (`source: "fallback"`) when
//!
//! - the Nyuchi guardrails block could not be had (the model is not called
//!   without it),
//! - the client has used its hour, or the service has (`Action::ReportClarify`),
//!   or the budget cannot be read (it fails closed),
//! - the model fails, is blocked by the gateway, answers with nothing usable,
//!   or takes longer than [`MODEL_TIMEOUT`].
//!
//! Only a request that is not `{locationSlug, reportType}` (a slug, one of the
//! 13 types) is refused, with `400`. No text from the visitor reaches the
//! prompt, so there is nothing to store and nothing to log: a failed call
//! writes the route, class and stage only (`weather_core::ai::failure`).

use std::time::Duration;

use futures::future::{select, Either};
use serde_json::Value;
use weather_core::ai::clarify::{self, Answer, Valid};
use weather_core::ai::guardrails::{system_prompt, Compiled};
use weather_core::ai::{pii, Turn};
use weather_core::budget::{Action, Decision};
use weather_edge::budget::{self, Caller};
use weather_edge::{error, json};
use worker::{Delay, Env, Response, Result};

use crate::gateway::{self, Call};

/// The gateway metadata route name (no user content).
const ROUTE: &str = "report-clarify";
/// A visitor is waiting in the wizard: past this, the fixed questions answer.
const MODEL_TIMEOUT: Duration = Duration::from_secs(8);

/// `guardrails` is `None` when the Nyuchi API's block could not be had: the
/// model is not called, and the fixed questions answer.
pub async fn handle(
    env: &Env,
    guardrails: Option<Compiled>,
    caller: &Caller,
    body: Value,
) -> Result<Response> {
    let valid = match clarify::validate(&body) {
        Ok(v) => v,
        Err(refusal) => return error(400, "invalid_request", refusal.description()),
    };
    json(200, &answer(env, guardrails, caller, &valid).await)
}

async fn answer(env: &Env, guardrails: Option<Compiled>, caller: &Caller, valid: &Valid) -> Answer {
    let place = clarify::place_name(&valid.slug);
    // Shamwari's rule: personal content never reaches cloud inference. The
    // name is made of the slug's words, so this only ever stops a slug that
    // spells a card number.
    if pii::contains_personal_data(&place) {
        return clarify::fallback(&valid.report_type);
    }
    let Some(guardrails) = guardrails else {
        return clarify::fallback(&valid.report_type);
    };
    // The model is the costly part. A client over its hour, the service over
    // its hour and a budget that cannot be read all get the fixed questions:
    // they cost nothing and the wizard carries on.
    if budget::take(env, Action::ReportClarify, caller).await != Decision::Allow {
        return clarify::fallback(&valid.report_type);
    }

    let prompt = clarify::prompt(&place, &valid.report_type);
    let system = system_prompt(&guardrails, &prompt.system);
    let call = Call {
        route: ROUTE,
        max_tokens: prompt.max_tokens,
    };
    let user = [Turn {
        role: "user".into(),
        content: prompt.user,
    }];
    let run = Box::pin(gateway::run(env, call, &system, &user));
    let timer = Box::pin(Delay::from(MODEL_TIMEOUT));
    let outcome = select(run, timer).await;
    match outcome {
        Either::Left((Ok(text), _)) => clarify::from_model(&text, &valid.report_type),
        // The gateway module has logged why (class, stage, code, status).
        Either::Left((Err(_), _)) => clarify::fallback(&valid.report_type),
        Either::Right(_) => {
            worker::console_warn!("ai model call failed: route={ROUTE} class=timeout");
            clarify::fallback(&valid.report_type)
        }
    }
}
