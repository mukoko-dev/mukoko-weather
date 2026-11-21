//! The frost-alert tick for one place (mukoko-dev/mukoko-weather#289, #579).
//!
//! This is glue. Every decision is pure and tested natively in `weather-core`:
//! `alert_run` (read the targets, the caps, the delivery bodies, the
//! subrequest budget), `alert_plan` (who gets what, or why not),
//! `alert_delivery` (the claim and what may be deactivated) and `push_wire`
//! (the body to the sender and its answer). What is here is the order of the
//! calls, and the order is the safety property:
//!
//! 1. **Nothing unless `ALERTS_ENABLED` is `true`.** Checked again here, not
//!    only where the tick plans: a message queued before the switch was turned
//!    off does nothing.
//! 2. Read the forecast and ask `assess_place` whether frost is ahead. No frost
//!    (or a seasonal estimate, or a place with no UTC offset) ends the job
//!    before the Nyuchi API is asked about a single person.
//! 3. Page `GET /v1/notifications/alerts/targets`, plan each page, and for each
//!    planned send **CLAIM it first**: `POST /deliveries` with status `queued`.
//!    `read_claim` fails closed; a push is sent ONLY on `Claim::Won`. The log is
//!    what stops a second push, not this code.
//! 4. Push through the `PUSH` service binding, then **log the outcome on the
//!    same row** (`sent`, `gone` or `failed`).
//! 5. Post the deactivations `plan_deactivations` allows, never "all", and
//!    never for a push service that refused every send of the batch.
//!
//! **Logging.** One summary line of counts per job. No place, person, endpoint,
//! key, header or body is ever formatted into a log line: a subscription's
//! endpoint is a bearer capability, so it is only ever handed to
//! `push_wire::encode_send`. (Tripwires in `crates/weather-webpush/src/
//! tripwire.rs` read this file for that.)
//!
//! **Not run in a Workers runtime** by anything in this repository: the calls
//! below are untested glue until the owner's first run. Treat that line as
//! load-bearing.

use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::Value;
use weather_core::alert_delivery::{
    plan_deactivations, read_claim, Claim, ClaimAnswer, SendResult,
};
use weather_core::alert_plan::{assess_place, plan_frost, PlaceInput, PlaceVerdict};
use weather_core::alert_run::{
    alert_targets, deactivate_body, delivery_body, forecast_series, parse_targets, targets_path,
    Budget, Delivery, RunCounts, RunSubscription, MAX_TARGET_PAGES, SUBREQUESTS_PER_SEND,
};
use weather_core::places::resolve_seed;
use weather_core::push::{self, Outcome};
use weather_core::push_wire::{encode_send, parse_answer, SendAnswer};
use weather_core::secrets::{ALERT_SENDER_KEY, PUSH_SEND_KEY};
use weather_edge::{config, now, post_json_with_timeout, secret};
use worker::{console_error, console_log, Env, Error, Headers, Method, RequestInit, Result};

use crate::tasks::ask_forecast;

/// The service binding to `mukoko-weather-push`.
const PUSH: &str = "PUSH";
const API_TIMEOUT: Duration = Duration::from_secs(10);
const DELIVERIES: &str = "/v1/notifications/alerts/deliveries";
const DEACTIVATE: &str = "/v1/notifications/alerts/subscriptions/deactivate";

/// The Nyuchi API and the sender's key.
struct Api {
    base: String,
    key: String,
}

impl Api {
    fn headers(&self) -> Result<Headers> {
        let h = Headers::new();
        h.set("X-API-Key", &self.key)?;
        h.set("Accept", "application/json")?;
        Ok(h)
    }

    /// `GET`; the body only when the API answered 200 with JSON.
    async fn get(&self, path: &str) -> Option<Value> {
        let headers = self.headers().ok()?;
        let url = format!("{}{path}", self.base);
        let mut resp = weather_edge::get_with_timeout(&url, Some(headers), API_TIMEOUT)
            .await
            .ok()?;
        if resp.status_code() != 200 {
            return None;
        }
        resp.json::<Value>().await.ok()
    }

    /// `POST`; `(status, body)`, status `0` when there was no answer.
    async fn post(&self, path: &str, body: &Value) -> (u16, Option<Value>) {
        let Ok(headers) = self.headers() else {
            return (0, None);
        };
        let url = format!("{}{path}", self.base);
        match post_json_with_timeout(&url, headers, body, API_TIMEOUT).await {
            Ok(mut resp) => {
                let status = resp.status_code();
                (status, resp.json::<Value>().await.ok())
            }
            Err(_) => (0, None),
        }
    }
}

/// What came back from the sender.
enum PushCall {
    Answered(SendAnswer),
    /// The sender did not answer 200: not configured, refused our key, or
    /// down. Every later send of this job would meet the same, so the job
    /// stops sending. The HTTP status is all that is kept.
    Down(u16),
}

/// One push, through the `PUSH` service binding.
async fn push_send(env: &Env, send_key: &str, wire: &Value) -> PushCall {
    let Ok(fetcher) = env.service(PUSH) else {
        return PushCall::Down(0);
    };
    let headers = Headers::new();
    if headers
        .set("Authorization", &["Bearer ", send_key].concat())
        .is_err()
        || headers.set("Content-Type", "application/json").is_err()
    {
        return PushCall::Down(0);
    }
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(wire.to_string().into()));
    match fetcher.fetch("https://push/send", Some(init)).await {
        Ok(mut resp) if resp.status_code() == 200 => match resp.json::<Value>().await {
            Ok(body) => PushCall::Answered(parse_answer(&body)),
            Err(_) => PushCall::Down(200),
        },
        Ok(resp) => PushCall::Down(resp.status_code()),
        Err(_) => PushCall::Down(0),
    }
}

/// A send that has been made, kept (as owned strings, since the page it came
/// from is gone) for the deactivation plan.
struct Sent {
    person_id: String,
    subscription_id: String,
    origin: String,
    outcome: Outcome,
}

#[derive(Default)]
struct Stats {
    pages: usize,
    people: usize,
    invalid: usize,
    bad_preferences: usize,
    skips: BTreeMap<&'static str, u32>,
    claims: BTreeMap<&'static str, u32>,
    accepted: u32,
    expired: u32,
    retry: u32,
    failed: u32,
    log_failed: u32,
    budget_stopped: bool,
    sender_down: Option<u16>,
    targets_unavailable: bool,
}

fn verdict_word(v: &PlaceVerdict) -> &'static str {
    match v {
        PlaceVerdict::Frost(_) => "frost",
        PlaceVerdict::NoFrost => "no_frost",
        PlaceVerdict::EstimateProvider => "estimate_provider",
        PlaceVerdict::InvalidPlace => "invalid_place",
    }
}

fn counts_line(m: &BTreeMap<&'static str, u32>) -> String {
    if m.is_empty() {
        return "none".to_owned();
    }
    m.iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join(",")
}

/// Evaluate frost for one seed slug and push to the people who follow it.
pub async fn run(env: &Env, slug: &str) -> Result<()> {
    // (1) The switch, again.
    if !crate::settings(env).alerts_enabled() {
        console_log!("alerts: switched off, nothing done");
        return Ok(());
    }
    let Some(place) = resolve_seed(slug) else {
        console_error!("alerts: a queued place is not a seed place");
        return Ok(());
    };

    // The configuration first, so a missing key is loud on every tick whether
    // or not there is frost tonight.
    let base = config(env, "NYUCHI_API_URL").map(|b| b.trim_end_matches('/').to_owned());
    let (base, key, send_key) = (
        base,
        secret(env, ALERT_SENDER_KEY).await,
        secret(env, PUSH_SEND_KEY).await,
    );
    let (Some(base), Some(key), Some(send_key)) = (base, key, send_key) else {
        console_error!(
            "alerts: NYUCHI_API_URL, the alert sender key or the push send key is not set"
        );
        return Err(Error::RustError("alerts not configured".into()));
    };
    let api = Api { base, key };
    let mut budget = Budget::new();

    // (2) The forecast, and whether frost is ahead at all.
    let query = format!("/weather?lat={}&lon={}", place.lat, place.lon);
    let _ = budget.take(1);
    let Some(mut resp) = ask_forecast(env, &query).await? else {
        console_error!("alerts: the forecast was not available");
        return Err(Error::RustError("forecast unavailable".into()));
    };
    let provider = resp
        .headers()
        .get("X-Weather-Provider")?
        .unwrap_or_else(|| "unknown".to_owned());
    let Ok(data) = resp.json::<Value>().await else {
        console_error!("alerts: the forecast could not be read");
        return Err(Error::RustError("forecast unreadable".into()));
    };
    let Some(series) = forecast_series(&data) else {
        console_log!("alerts: no usable hourly series or UTC offset, nothing done");
        return Ok(());
    };
    let cell = weather_core::geo::cell_key(place.lat, place.lon);
    let input = PlaceInput {
        slug: &place.slug,
        name: place.name.as_deref().unwrap_or(&place.slug),
        cell: &cell,
        provider: &provider,
        times: &series.times,
        temps: &series.temps,
        now: now(),
        utc_offset_seconds: series.utc_offset_seconds,
        stations: None,
    };
    let verdict = assess_place(&input);
    if !matches!(verdict, PlaceVerdict::Frost(_)) {
        console_log!("alerts: {}, nothing to send", verdict_word(&verdict));
        return Ok(());
    }

    // (3) to (5): who follows the place, claim, push, log.
    let mut stats = Stats::default();
    let mut counts = RunCounts::default();
    let mut sent: Vec<Sent> = Vec::new();
    let mut cursor: Option<String> = None;

    'pages: for _ in 0..MAX_TARGET_PAGES {
        let Some(path) = targets_path(&place.slug, cursor.as_deref()) else {
            break;
        };
        if !budget.take(1) {
            stats.budget_stopped = true;
            break;
        }
        let Some(body) = api.get(&path).await else {
            stats.targets_unavailable = true;
            break;
        };
        let page = parse_targets(&body);
        stats.pages += 1;
        stats.people += page.people.len();
        stats.invalid += page.invalid;

        let (targets, bad) = alert_targets(&page.people, &place.slug, &counts);
        stats.bad_preferences += bad;
        let plan = plan_frost(&input, &targets);
        for entry in &plan.entries {
            if let weather_core::alert_plan::Action::Skip(why) = &entry.action {
                *stats.skips.entry(why.code()).or_default() += 1;
            }
        }

        // The planner's target id is the subscription id.
        let mut by_id: BTreeMap<&str, (&str, &RunSubscription)> = BTreeMap::new();
        for person in &page.people {
            for sub in &person.subscriptions {
                by_id.insert(sub.id.as_str(), (person.person_id.as_str(), sub));
            }
        }

        for (target_id, planned) in plan.sends() {
            let Some(&(person_id, sub)) = by_id.get(target_id) else {
                continue;
            };
            // The claim, the push and the outcome log are reserved together:
            // a claim won with no room left to log it is a lost alert.
            if !budget.take(SUBREQUESTS_PER_SEND) {
                stats.budget_stopped = true;
                break 'pages;
            }

            let claim_body = delivery_body(&Delivery {
                person_id,
                dedupe_key: &planned.dedupe_key,
                place_slug: &place.slug,
                subscription_id: &sub.id,
                status: "queued",
                provider_code: None,
                ttl: planned.options.ttl_seconds,
                urgency: planned.options.urgency.as_str(),
                topic: &planned.options.topic,
            });
            let (status, answer) = api.post(DELIVERIES, &claim_body).await;
            let text = |k: &str| {
                answer
                    .as_ref()
                    .and_then(|b| b.get(k))
                    .and_then(Value::as_str)
            };
            let claim = read_claim(&ClaimAnswer {
                http_status: status,
                result: text("result"),
                status: text("status"),
            });
            *stats.claims.entry(claim.code()).or_default() += 1;
            // Only a won claim sends. A held, retried or refused one costs the
            // claim and nothing else.
            if claim != Claim::Won {
                budget.refund(SUBREQUESTS_PER_SEND - 1);
                continue;
            }

            let wire = encode_send(
                &sub.endpoint,
                &sub.p256dh,
                &sub.auth,
                &planned.payload,
                &planned.options,
            );
            let call = push_send(env, &send_key, &wire).await;
            let (outcome, code) = match &call {
                PushCall::Answered(a) => (a.outcome, a.provider_code),
                // Not a push service's answer: logged as a retryable failure,
                // which the log lets a later tick claim again.
                PushCall::Down(_) => (Outcome::Retry, None),
            };
            match outcome {
                Outcome::Accepted => stats.accepted += 1,
                Outcome::Expired => stats.expired += 1,
                Outcome::Retry => stats.retry += 1,
                Outcome::Failed => stats.failed += 1,
            }

            let outcome_body = delivery_body(&Delivery {
                person_id,
                dedupe_key: &planned.dedupe_key,
                place_slug: &place.slug,
                subscription_id: &sub.id,
                status: outcome.delivery_status(),
                provider_code: code,
                ttl: planned.options.ttl_seconds,
                urgency: planned.options.urgency.as_str(),
                topic: &planned.options.topic,
            });
            let mut logged = false;
            for attempt in 0..2 {
                // The retry spends from the same reservation's slack, or
                // nothing: the budget has the final say.
                if attempt == 1 && !budget.take(1) {
                    break;
                }
                let (status, _) = api.post(DELIVERIES, &outcome_body).await;
                if matches!(status, 200 | 201) {
                    logged = true;
                    break;
                }
            }
            if !logged {
                // The row stays `queued`: the documented at-most-once limit.
                stats.log_failed += 1;
            }

            if outcome == Outcome::Accepted {
                counts.record(person_id);
            }
            if let Ok(origin) = push::endpoint_origin(&sub.endpoint) {
                sent.push(Sent {
                    person_id: person_id.to_owned(),
                    subscription_id: sub.id.clone(),
                    origin,
                    outcome,
                });
            }
            if let PushCall::Down(code) = call {
                // Every later send would meet the same: stop, loudly.
                stats.sender_down = Some(code);
                break 'pages;
            }
        }

        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }

    // (5) Gone subscriptions, from an explicit list, never for a push service
    // that refused everything.
    let results: Vec<SendResult> = sent
        .iter()
        .map(|s| SendResult {
            person_id: &s.person_id,
            subscription_id: &s.subscription_id,
            origin: &s.origin,
            outcome: s.outcome,
        })
        .collect();
    let deactivations = plan_deactivations(&results);
    let mut deactivated_calls = 0usize;
    for call in &deactivations.calls {
        if !budget.take(1) {
            stats.budget_stopped = true;
            break;
        }
        let (status, _) = api.post(DEACTIVATE, &deactivate_body(call)).await;
        if status == 200 {
            deactivated_calls += 1;
        }
    }

    console_log!(
        "alerts: pages={} people={} invalid={} bad_prefs={} claims[{}] skipped[{}] \
         accepted={} expired={} retry={} failed={} log_failed={} \
         deactivate_planned={} deactivate_calls_ok={} held_back={} subrequests={}",
        stats.pages,
        stats.people,
        stats.invalid,
        stats.bad_preferences,
        counts_line(&stats.claims),
        counts_line(&stats.skips),
        stats.accepted,
        stats.expired,
        stats.retry,
        stats.failed,
        stats.log_failed,
        deactivations.total(),
        deactivated_calls,
        deactivations.held_back,
        budget.used(),
    );
    // The faults that are an operator's, each loud on its own.
    if deactivations.held_back > 0 {
        console_error!(
            "alerts: a push service refused every send as gone; nothing deactivated for it \
             (a wrong or rotated sender key, or a clock far off)"
        );
    }
    if let Some(code) = stats.sender_down {
        console_error!("alerts: the sender did not answer 200 (HTTP {code}); sending stopped");
        return Err(Error::RustError("sender unavailable".into()));
    }
    if stats.targets_unavailable {
        console_error!("alerts: the Nyuchi API targets route did not answer 200");
        return Err(Error::RustError("targets unavailable".into()));
    }
    if stats.budget_stopped {
        console_error!(
            "alerts: stopped at the subrequest budget; the rest is planned again next tick"
        );
    }
    Ok(())
}
