//! Community weather reports, ported from `api/py/_reports.py`:
//!
//! ```text
//! POST /reports          {locationSlug, reportType, severity?, description?, lat?, lon?}
//!                        → 201 {id, verified, expiresIn}
//! GET  /reports?location=<slug>[&hours=1..72]   → 200 {reports, location}
//! POST /reports/upvote   {reportId}             → 200 {upvoted[, reason]}
//! ```
//!
//! (`POST /reports/clarify`, the model's follow-up questions, belongs to the AI
//! Worker and is not served here.)
//!
//! A report is a document in MongoDB (`weather.weather_reports`), written and
//! read by `mukoko-weather-mongo-bridge` through the `MONGO_BRIDGE` service
//! binding (never D1). This Worker validates the request with the rules of
//! `weather_core::community`, takes the per-client budget (5 submissions an
//! hour, ONE guarded statement in D1 `rate_events`, fails closed), resolves the
//! place (seed, spot, Nyuchi API or a community place from `placesGeo` through
//! the bridge) and reads the forecast the page already cached (KV `wx:v2:`,
//! cache only: no provider call, no cost) to cross-validate the report. The
//! reporter and the upvoter are the first 16 hex characters of the SHA-256 of
//! their address, never the address.
//!
//! Everything that can be decided without I/O is in `weather_core::community`
//! and tested natively; this file only moves bytes.

use serde_json::{json, Value};
use weather_core::budget::Action;
use weather_core::community::{
    bridge_list_path, build_report, check_submit, hash_ip, is_catalogue, limit_refusal, list_body,
    list_hours, storage_slug, valid_report_id, Limited, ReportPlace, Snapshot, SubmitRequest,
    UpvoteRequest,
};
use weather_core::geo;
use weather_core::slug::valid_slug;
use weather_edge::{client_ip, error, json, query_pairs};
use worker::{Env, Method, Request, Response, Result};

use crate::bridge::{self, Answer};
use crate::budget::{self, Caller};

const CACHE: &str = "CACHE";

pub async fn reports(req: &mut Request, env: &Env) -> Result<Response> {
    let path = req.path();
    match (req.method(), path.trim_end_matches('/')) {
        (Method::Post, "/reports") => submit(req, env).await,
        (Method::Get, "/reports") => list(req, env).await,
        (Method::Post, "/reports/upvote") => upvote(req, env).await,
        _ => error(
            405,
            "method_not_allowed",
            "Use POST /reports, GET /reports?location= or POST /reports/upvote.",
        ),
    }
}

/// The bridge's answer as this Worker's: its status and body (a rejection of
/// the request itself keeps the `{error, error_description}` envelope), or
/// `503` when the store does not answer.
fn relay(answer: Answer) -> Result<Response> {
    match answer {
        Answer::Relay { status, body } => json(status, &body),
        Answer::Unavailable { .. } => {
            error(503, "unavailable", "Community reports are unavailable.")
        }
    }
}

/// The conditions the forecast cache holds for the place right now, or `None`
/// (cold cache, unreadable value, no `current` block). A report is then
/// stored without a snapshot and cannot be verified.
async fn snapshot_at(env: &Env, lat: f64, lon: f64) -> Option<Snapshot> {
    let key = geo::forecast_cache_key(lat, lon);
    let cached: Value = env.kv(CACHE).ok()?.get(&key).json().await.ok().flatten()?;
    Snapshot::from_forecast_cache(&cached)
}

async fn submit(req: &mut Request, env: &Env) -> Result<Response> {
    let Ok(body) = req.json::<SubmitRequest>().await else {
        return error(422, "invalid_request", "The body is not a valid report.");
    };
    if let Err(detail) = check_submit(&body) {
        return error(400, "invalid_request", &detail);
    }
    let Some(ip) = client_ip(req) else {
        return error(400, "invalid_request", "Could not determine the client.");
    };
    // A slug no place can have is unknown without asking anyone.
    if !valid_slug(&body.location_slug) {
        return error(404, "not_found", "Unknown location");
    }
    // ONE guarded statement (budget::SPEND_SQL): parallel cold requests cannot
    // all read the same count and all pass. A budget D1 cannot read or write
    // refuses too (fails closed): `limit_refusal` says 429 or 503.
    let decision = budget::take(
        env,
        Action::WeatherReport,
        &Caller {
            subject: None,
            ip: ip.clone(),
        },
    )
    .await;
    if let Some(r) = limit_refusal(decision, Limited::Reports) {
        return error(r.status, r.code, r.description);
    }

    let place = match crate::find_location(env, &body.location_slug).await {
        Ok(Some(place)) => place,
        Ok(None) => return error(404, "not_found", "Unknown location"),
        Err(()) => return error(503, "places_unavailable", "Location data unavailable"),
    };

    // The seed list, the Nyuchi API and community places keep their slug; a
    // `{name}--{geohash}` spot is a coordinate, stored by its cell.
    let storage_key = storage_slug(&body.location_slug, is_catalogue(&place.source));
    let snapshot = snapshot_at(env, place.lat, place.lon).await;
    let submission = build_report(
        &body,
        ReportPlace {
            name: &place.name,
            lat: place.lat,
            lon: place.lon,
            storage_key: &storage_key,
        },
        snapshot.as_ref(),
        &hash_ip(&ip),
    );
    relay(bridge::call(env, Method::Post, "/reports", Some(&submission.body)).await)
}

async fn list(req: &Request, env: &Env) -> Result<Response> {
    let pairs = query_pairs(req)?;
    let get = |k: &str| {
        pairs
            .iter()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    };
    let Some(location) = get("location") else {
        return error(400, "invalid_request", "Missing location parameter");
    };
    if !valid_slug(&location) {
        return error(400, "invalid_request", "Invalid location slug");
    }
    let hours = match list_hours(get("hours").as_deref()) {
        Ok(h) => h,
        Err(detail) => return error(422, "invalid_request", &detail),
    };
    match bridge::call(env, Method::Get, &bridge_list_path(&location, hours), None).await {
        Answer::Relay { status: 200, body } => json(200, &list_body(&body, &location)),
        other => relay(other),
    }
}

async fn upvote(req: &mut Request, env: &Env) -> Result<Response> {
    let Some(ip) = client_ip(req) else {
        return error(400, "invalid_request", "Could not determine IP");
    };
    let Ok(body) = req.json::<UpvoteRequest>().await else {
        return error(422, "invalid_request", "The body is not a valid upvote.");
    };
    if !valid_report_id(&body.report_id) {
        return error(400, "invalid_request", "Invalid report ID");
    }
    relay(
        bridge::call(
            env,
            Method::Post,
            "/reports/upvote",
            Some(&json!({"reportId": body.report_id, "voter": hash_ip(&ip)})),
        )
        .await,
    )
}
