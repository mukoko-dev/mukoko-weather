//! The place profile for a prompt: what is stored about a place that changes
//! slowly (season now and next, crop stage, this month's normals, climate
//! class, soil, moon, ENSO, day length), as the compact text block
//! `weather_core::place_profile::profile_prompt_block` writes.
//!
//! The one way the AI Worker reaches it, for every route that grounds a prompt
//! in the place (the summary, the follow-up, the history analysis, the chat).
//! It asks the forecast Worker (`GET /profile-block`, cache-only: no archive
//! request, no soil, no budget) over the `FORECAST` binding, never waits more
//! than [`PROFILE_TIMEOUT`], and never fails an answer: with no profile the
//! prompt is simply without the block. Callers splice the block with
//! [`weather_core::place_profile::with_profile`], which adds the grounding rule
//! (derived estimates are said with "typically", no crops are named without a
//! calendar).

use std::time::Duration;

use futures::future::{select, Either};
use serde_json::Value;
use worker::{Delay, Env};

use crate::FORECAST_BINDING;

/// The forecast Worker answers from its caches, so this bounds a cold Worker,
/// not an upstream.
pub const PROFILE_TIMEOUT: Duration = Duration::from_secs(4);

/// Wait for `fut` at most `limit`; `None` when it is slower.
async fn within<T>(limit: Duration, fut: impl std::future::Future<Output = T>) -> Option<T> {
    match select(Box::pin(fut), Box::pin(Delay::from(limit))).await {
        Either::Left((v, _)) => Some(v),
        Either::Right(_) => None,
    }
}

/// The profile block of a place, or `""`.
///
/// `slug` only for a slug the caller trusts (a seed place or one the Worker
/// resolved itself); a client-supplied slug must not be passed, since the block
/// describes the place the slug names. `country` is an ISO 3166-1 alpha-2 code
/// when the caller knows one.
pub async fn block(
    env: &Env,
    slug: Option<&str>,
    lat: f64,
    lon: f64,
    country: Option<&str>,
) -> String {
    let Ok(fetcher) = env.service(FORECAST_BINDING) else {
        return String::new();
    };
    let mut url = format!("https://forecast/profile-block?lat={lat}&lon={lon}");
    if let Some(s) = slug.filter(|s| !s.is_empty()) {
        url.push_str(&format!("&slug={s}"));
    }
    if let Some(c) =
        country.filter(|c| c.len() == 2 && c.chars().all(|ch| ch.is_ascii_alphabetic()))
    {
        url.push_str(&format!("&country={c}"));
    }
    let answer = within(PROFILE_TIMEOUT, async {
        let mut resp = fetcher.fetch(url, None).await.ok()?;
        if resp.status_code() != 200 {
            return None;
        }
        resp.json::<Value>().await.ok()
    })
    .await
    .flatten();
    answer
        .as_ref()
        .and_then(|b| b["block"].as_str())
        .unwrap_or("")
        .to_owned()
}
