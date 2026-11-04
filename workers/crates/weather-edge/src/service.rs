//! Calls to another Worker over a service binding.

use worker::{Env, Response, Result};

/// `GET`-style call to the Worker behind `binding` (a wrangler binding name
/// such as `FORECAST`). The URL host is the binding name in lower case, as
/// the callers always wrote it. `Ok(None)` when the call itself fails (the
/// Worker did not answer); any HTTP status is returned as the response.
pub async fn ask(env: &Env, binding: &str, path_and_query: &str) -> Result<Option<Response>> {
    let fetcher = env.service(binding)?;
    let host = binding.to_ascii_lowercase();
    Ok(fetcher
        .fetch(format!("https://{host}{path_and_query}"), None)
        .await
        .ok())
}
