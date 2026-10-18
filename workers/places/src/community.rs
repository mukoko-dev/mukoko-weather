//! Device preference profiles, ported from `api/py/_devices.py`:
//!
//! ```text
//! POST  /devices       {deviceId?, preferences?} → 201 {deviceId, preferences, createdAt, updatedAt}
//! GET   /devices/{id}  → the same shape, or 404
//! PATCH /devices/{id}  a partial preferences object → the updated profile
//! ```
//!
//! The profile is kept in D1 `device_profiles` (migration 0004), last write
//! wins. Creating a profile without a device id is limited to 20 an hour per
//! client; an id the caller supplies is idempotent (the existing profile is
//! returned) and unlimited.

use serde::Deserialize;
use serde_json::{json, Value};
use weather_core::community::{
    self, apply_patch, iso_ms, valid_device_id, validate_preferences, Preferences, PreferencesPatch,
};
use weather_edge::{error, json, now_ms};
use worker::{Env, Method, Request, Response, Result};

use crate::{limits, DB};

#[derive(Deserialize)]
struct Row {
    device_id: String,
    preferences: String,
    created_at: f64,
    updated_at: f64,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct CreateBody {
    device_id: Option<String>,
    preferences: Preferences,
}

fn profile(row: &Row) -> Value {
    let prefs: Preferences = serde_json::from_str(&row.preferences).unwrap_or_default();
    json!({
        "deviceId": row.device_id,
        "preferences": prefs,
        "createdAt": iso_ms(row.created_at as u64),
        "updatedAt": iso_ms(row.updated_at as u64),
    })
}

fn client_ip(req: &Request) -> Option<String> {
    req.headers()
        .get("X-Mukoko-Client-IP")
        .ok()
        .flatten()
        .or_else(|| req.headers().get("CF-Connecting-IP").ok().flatten())
        .filter(|ip| !ip.is_empty())
}

async fn fetch_row(env: &Env, id: &str) -> Result<Option<Row>> {
    env.d1(DB)?
        .prepare(
            "SELECT device_id, preferences, created_at, updated_at \
             FROM device_profiles WHERE device_id = ?1",
        )
        .bind(&[id.into()])?
        .first::<Row>(None)
        .await
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
            // The limiter is a write; when D1 cannot take it the store cannot
            // take the profile either.
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
    let now = now_ms() as f64;
    let prefs = serde_json::to_string(&body.preferences).unwrap_or_default();
    let Ok(db) = env.d1(DB) else {
        return error(503, "unavailable", "Device sync is unavailable.");
    };
    let inserted = db
        .prepare(
            "INSERT OR IGNORE INTO device_profiles (device_id, preferences, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?3)",
        )
        .bind(&[device_id.as_str().into(), prefs.as_str().into(), now.into()])?
        .run()
        .await;
    if inserted.is_err() {
        return error(503, "unavailable", "Device sync is unavailable.");
    }
    match fetch_row(env, &device_id).await {
        Ok(Some(row)) => json(201, &profile(&row)),
        Ok(None) => error(409, "conflict", "Device profile already exists"),
        Err(_) => error(503, "unavailable", "Device sync is unavailable."),
    }
}

async fn get(env: &Env, id: &str) -> Result<Response> {
    if !valid_device_id(id) {
        return error(404, "not_found", "Device profile not found");
    }
    match fetch_row(env, id).await {
        Ok(Some(row)) => json(200, &profile(&row)),
        Ok(None) => error(404, "not_found", "Device profile not found"),
        Err(_) => error(503, "unavailable", "Device sync is unavailable."),
    }
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
    let row = match fetch_row(env, id).await {
        Ok(Some(row)) => row,
        Ok(None) => return error(404, "not_found", "Device profile not found"),
        Err(_) => return error(503, "unavailable", "Device sync is unavailable."),
    };
    let current: Preferences = serde_json::from_str(&row.preferences).unwrap_or_default();
    let next = match apply_patch(&current, &body) {
        Ok(next) => next,
        Err(detail) => return error(400, "invalid_request", &detail),
    };
    let now = now_ms() as f64;
    let prefs = serde_json::to_string(&next).unwrap_or_default();
    let updated = env
        .d1(DB)?
        .prepare(
            "UPDATE device_profiles SET preferences = ?2, updated_at = ?3 WHERE device_id = ?1",
        )
        .bind(&[id.into(), prefs.as_str().into(), now.into()])?
        .run()
        .await;
    if updated.is_err() {
        return error(503, "unavailable", "Device sync is unavailable.");
    }
    match fetch_row(env, id).await {
        Ok(Some(row)) => json(200, &profile(&row)),
        _ => error(404, "not_found", "Device profile not found"),
    }
}
