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
//! `weather_core::community`, applies the per-client limit (5 submissions an
//! hour, D1 `rate_events`), resolves the place and reads the forecast the page
//! already cached (KV `wx:v2:`, cache only: no provider call, no cost) to
//! cross-validate the report. The reporter and the upvoter are the first 16
//! hex characters of the SHA-256 of their address, never the address.

use serde_json::{json, Value};
use weather_core::community::{
    build_report, check_submit, clamp_hours, hash_ip, read_keys, storage_slug, valid_report_id,
    ReportPlace, Snapshot, SubmitRequest, UpvoteRequest, LIST_LIMIT, SUBMIT_PER_HOUR,
};
use weather_core::geo;
use weather_core::slug::valid_slug;
use weather_edge::{client_ip, error, json, query_pairs};
use worker::{Env, Method, Request, Response, Result};

use crate::bridge::{self, Answer};
use crate::limits;

const CACHE: &str = "CACHE";
/// The forecast Worker's KV key for a point (`forecast::chain::cache_key`).
const FORECAST_KEY_PREFIX: &str = "wx:v2:";

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
    let key = format!("{FORECAST_KEY_PREFIX}{}", geo::cache_key(lat, lon));
    let cached: Value = env.kv(CACHE).ok()?.get(&key).json().await.ok().flatten()?;
    Snapshot::from_current(cached.get("data")?.get("current")?)
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
    // The limiter is a write; when D1 cannot take it the report is not stored
    // either, so one outage never lifts the limit.
    match limits::allow(env, &ip, "weather-report", SUBMIT_PER_HOUR).await {
        Ok(true) => {}
        Ok(false) => return error(429, "rate_limited", "Too many reports. Try again later."),
        Err(_) => return error(503, "unavailable", "Community reports are unavailable."),
    }

    // A slug no place can have is unknown without asking anyone.
    if !valid_slug(&body.location_slug) {
        return error(404, "not_found", "Unknown location");
    }
    let place = match crate::find_location(env, &body.location_slug).await {
        Ok(Some(place)) => place,
        Ok(None) => return error(404, "not_found", "Unknown location"),
        Err(()) => return error(503, "places_unavailable", "Location data unavailable"),
    };

    // The seed list and the Nyuchi API's places are catalogue places and keep
    // their slug; a `{name}--{geohash}` spot is a coordinate, stored by its cell.
    let is_catalogue = matches!(place.source.as_str(), "seed" | "places");
    let storage_key = storage_slug(&body.location_slug, is_catalogue);
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
    let hours = match get("hours").map_or(Ok(24), |h| h.parse::<i64>()) {
        Ok(h) => clamp_hours(h),
        Err(_) => return error(422, "invalid_request", "`hours` must be an integer."),
    };
    // The reports of the slug itself and, for a spot, of its cell.
    let mut path = format!("/reports?hours={hours}&limit={LIST_LIMIT}");
    for key in read_keys(&location) {
        path.push_str("&slug=");
        path.push_str(&key);
    }
    match bridge::call(env, Method::Get, &path, None).await {
        Answer::Relay { status: 200, body } => json(
            200,
            &json!({"reports": body.get("reports").cloned().unwrap_or(json!([])), "location": location}),
        ),
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
