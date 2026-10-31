//! CORS for the Workers that serve browsers. The origin policy is one rule
//! (`weather_core::cors::origin_allowed`); each Worker passes its own methods,
//! request headers and exposed headers.

use weather_core::cors::origin_allowed;
use worker::{Env, Response, Result};

use crate::config;

/// The request's origin when the policy allows it: `CORS_ORIGINS`, plus the
/// local origins unless `ENVIRONMENT` is `production`.
pub fn allowed_origin(env: &Env, origin: &str) -> Option<String> {
    let allowed = config(env, "CORS_ORIGINS").unwrap_or_default();
    let allow_local = config(env, "ENVIRONMENT").as_deref() != Some("production");
    origin_allowed(origin, &allowed, allow_local).then(|| origin.to_owned())
}

/// The answer to a preflight: `204` with the Worker's methods and headers when
/// the origin is allowed, else `403` with no CORS headers.
pub fn preflight(allowed: bool, methods: &str, allow_headers: &str) -> Result<Response> {
    let resp = Response::empty()?.with_status(if allowed { 204 } else { 403 });
    if allowed {
        let h = resp.headers();
        h.set("Access-Control-Allow-Methods", methods)?;
        h.set("Access-Control-Allow-Headers", allow_headers)?;
        h.set("Access-Control-Max-Age", "86400")?;
    }
    Ok(resp)
}

/// Stamp `Vary: Origin`, and for an allowed origin the allow-origin and the
/// Worker's exposed headers.
pub fn apply(resp: Response, origin: Option<&str>, expose: Option<&str>) -> Result<Response> {
    let h = resp.headers();
    h.append("Vary", "Origin")?;
    if let Some(o) = origin {
        h.set("Access-Control-Allow-Origin", o)?;
        if let Some(expose) = expose {
            h.set("Access-Control-Expose-Headers", expose)?;
        }
    }
    Ok(resp)
}
