//! Device preference profiles, ported from `api/py/_devices.py`:
//!
//! ```text
//! POST  /devices       {deviceId?, preferences?} → 201 {deviceId, preferences, createdAt, updatedAt}
//! GET   /devices/{id}  → the same shape, or 404
//! PATCH /devices/{id}  a partial preferences object → the updated profile
//! ```
//!
//! The profile is a document in MongoDB (`device.device_profiles`), last write
//! wins, read and written by `mukoko-weather-mongo-bridge` through the
//! `MONGO_BRIDGE` service binding (never D1). This Worker validates the request
//! (`weather_core::community`), applies the per-client limit, and relays the
//! bridge's answer. Creating a profile without a device id is limited to 20 an
//! hour per client (D1 `rate_events`); an id the caller supplies is idempotent
//! (the existing profile is returned) and unlimited.

use serde::Deserialize;
use serde_json::json;
use weather_core::community::{
    self, apply_patch, valid_device_id, validate_preferences, Preferences, PreferencesPatch,
};
use weather_edge::{error, json};
use worker::{Env, Method, Request, Response, Result};

use crate::bridge::{self, Answer};
use crate::limits;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct CreateBody {
    device_id: Option<String>,
    preferences: Preferences,
}

fn client_ip(req: &Request) -> Option<String> {
    req.headers()
        .get("X-Mukoko-Client-IP")
        .ok()
        .flatten()
        .or_else(|| req.headers().get("CF-Connecting-IP").ok().flatten())
        .filter(|ip| !ip.is_empty())
}

fn random_id() -> Result<String> {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).map_err(|e| worker::Error::RustError(e.to_string()))?;
    // A version 4 UUID, as the Python's uuid.uuid4().
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex::encode(b);
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    ))
}

pub async fn devices(req: &mut Request, env: &Env) -> Result<Response> {
    let path = req.path();
    let id = path
        .strip_prefix("/devices")
        .map(|r| r.trim_matches('/'))
        .unwrap_or("");
    match (req.method(), id.is_empty()) {
        (Method::Post, true) => create(req, env).await,
        (Method::Get, false) => get(env, id).await,
        (Method::Patch, false) => patch(req, env, id).await,
        _ => error(
            405,
            "method_not_allowed",
            "Use POST /devices, GET or PATCH /devices/{id}.",
        ),
    }
}

/// The bridge's answer as this Worker's: its status and body (a create is
/// `201` whether the profile is new or already there; a rejection carries the
/// `{error, error_description}` envelope), or `503` when the store does not
/// answer.
fn relay(answer: Answer) -> Result<Response> {
    match answer {
        Answer::Relay { status, body } => json(status, &body),
        Answer::Unavailable => error(503, "unavailable", "Device sync is unavailable."),
    }
}

async fn create(req: &mut Request, env: &Env) -> Result<Response> {
    let Ok(body) = req.json::<CreateBody>().await else {
        return error(
            422,
            "invalid_request",
            "The body is not a valid device profile.",
        );
    };
    let fresh = body.device_id.as_deref().is_none_or(str::is_empty);
    if fresh {
        let Some(ip) = client_ip(req) else {
            return error(400, "invalid_request", "Could not determine the client.");
        };
        match limits::allow(env, &ip, "device-create", community::DEVICE_CREATE_PER_HOUR).await {
            Ok(true) => {}
            Ok(false) => {
                return error(
                    429,
                    "rate_limited",
                    "Too many device profiles created. Try again later.",
                )
            }
            // The limiter is a write; when D1 cannot take it the profile is
            // not created either, so one outage never mints unlimited ids.
            Err(_) => return error(503, "unavailable", "Device sync is unavailable."),
        }
    }
    let device_id = match body.device_id.filter(|d| !d.is_empty()) {
        Some(d) if valid_device_id(&d) => d,
        Some(_) => return error(400, "invalid_request", "Invalid device id"),
        None => random_id()?,
    };
    if let Err(detail) = validate_preferences(&body.preferences) {
        return error(400, "invalid_request", &detail);
    }
    let answer = bridge::call(
        env,
        Method::Post,
        "/devices",
        Some(&json!({"deviceId": device_id, "preferences": body.preferences})),
    )
    .await;
    relay(answer)
}

async fn get(env: &Env, id: &str) -> Result<Response> {
    if !valid_device_id(id) {
        return error(404, "not_found", "Device profile not found");
    }
    relay(bridge::call(env, Method::Get, &format!("/devices/{id}"), None).await)
}

async fn patch(req: &mut Request, env: &Env, id: &str) -> Result<Response> {
    let Ok(body) = req.json::<PreferencesPatch>().await else {
        return error(
            422,
            "invalid_request",
            "The body is not a valid preferences update.",
        );
    };
    if !valid_device_id(id) {
        return error(404, "not_found", "Device profile not found");
    }
    // The same rules as a create, and `No fields to update` for an empty
    // patch; the bridge then `$set`s only the fields present.
    if let Err(detail) = apply_patch(&Preferences::default(), &body) {
        return error(400, "invalid_request", &detail);
    }
    relay(
        bridge::call(
            env,
            Method::Patch,
            &format!("/devices/{id}"),
            Some(&json!(body)),
        )
        .await,
    )
}
