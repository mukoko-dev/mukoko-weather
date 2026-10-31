//! Responses every Worker builds the same way. A Worker keeps its own
//! wording; the status, the code and the `Retry-After` shape are shared.

use worker::{Response, Result};

use crate::error;

/// `429` with the `rate_limited` code and a `Retry-After` in seconds. The
/// description is the Worker's own sentence for its caller.
pub fn rate_limited(retry_after_secs: u32, description: &str) -> Result<Response> {
    let resp = error(429, "rate_limited", description)?;
    resp.headers()
        .set("Retry-After", &retry_after_secs.to_string())?;
    Ok(resp)
}
