//! Blend weight overrides: `weather.modelBlendConfig` in MongoDB (read-only
//! client), as the Python `weights_for` reads them. A document
//! `{_id: <region>, weights: {<model>: <weight>}}` replaces the compiled-in
//! weights for that region without a deploy; the verification job that fits
//! weights by skill will write there.
//!
//! The rules (what counts as a usable override) are
//! `weather_core::blend::sanitize_override`. Here: a 5-minute per-isolate
//! cache (misses are cached too, so a region with no override costs one read
//! every five minutes), a short timeout, and "any problem means the compiled-in
//! weights", never a failed forecast.

use std::cell::RefCell;
use std::collections::HashMap;
use std::time::Duration;

use futures::future::{select, Either};
use serde_json::json;
use weather_core::blend::{self, Weights};
use weather_edge::now_ms;
use worker::{Delay, Env};

const DB: &str = "weather";
const COLLECTION: &str = "modelBlendConfig";
const TTL_MS: u64 = 5 * 60_000;
/// The forecast must not wait on MongoDB: past this, the compiled-in weights.
const TIMEOUT: Duration = Duration::from_millis(1_500);

thread_local! {
    static CACHE: RefCell<HashMap<String, (u64, Option<Weights>)>> = RefCell::new(HashMap::new());
}

async fn read(env: &Env, region: &str) -> Option<Weights> {
    let mongo = weather_edge::mongo(env).await?;
    let find = Box::pin(mongo.find_one(DB, COLLECTION, json!({"_id": region})));
    let timer = Box::pin(Delay::from(TIMEOUT));
    let weights = match select(find, timer).await {
        Either::Left((Ok(Some(doc)), _)) => blend::usable_override(&doc["weights"]),
        _ => None,
    };
    weights
}

/// The weights for `region`: the MongoDB override when there is a usable one,
/// else the compiled-in set.
pub async fn weights(env: &Env, region: &str) -> Weights {
    let now = now_ms();
    let cached = CACHE.with(|c| {
        c.borrow()
            .get(region)
            .filter(|(at, _)| now.saturating_sub(*at) < TTL_MS)
            .map(|(_, w)| w.clone())
    });
    let over = match cached {
        Some(w) => w,
        None => {
            let w = read(env, region).await;
            CACHE.with(|c| {
                c.borrow_mut().insert(region.to_owned(), (now, w.clone()));
            });
            w
        }
    };
    over.unwrap_or_else(|| blend::weights_for(region))
}
