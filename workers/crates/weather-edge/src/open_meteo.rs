//! The Open-Meteo subscription, as a Worker request sees it.
//!
//! [`init`] reads the key (the Secrets Store secret `OPEN_METEO_API_KEY`, else
//! the plain Worker secret of that name) and the plan flag
//! `OPEN_METEO_ARCHIVE_LICENSED` once at the top of a request that calls
//! Open-Meteo. [`url`] then gives the URL to request: on the customer host with
//! the key when one is held and the plan covers that host, else unchanged.
//! `get_with_timeout` applies it to every outbound call, so no call site builds
//! a keyed URL and a new one on a covered host is picked up with no change.
//!
//! The rules (which hosts, the archive being opt-in, the encoding and the
//! masking) are pure and tested in `weather_core::open_meteo`. A Worker that
//! never calls [`init`] holds no key and keeps calling the free hosts.
//!
//! The key is in the URL (Open-Meteo accepts it nowhere else), so a keyed URL
//! is never logged, cached or put in an error: the error text of a failed call
//! is passed through [`scrub`] before it leaves `get_with_timeout`, and cache
//! keys are built from coordinates, never from a URL.

use weather_core::open_meteo::{self as om, Plan};
use weather_core::secrets;
use worker::Env;

thread_local! {
    /// What this isolate last read: the same on every request, so concurrent
    /// requests setting it cannot disagree.
    static PLAN: Plan = Plan::new();
}

/// Read the key and the plan flag. Cheap after the first request in an isolate
/// (the Secrets Store value is kept; the flag is a plain var).
pub async fn init(env: &Env) {
    let key = crate::secret(env, secrets::OPEN_METEO_API_KEY).await;
    let archive_licensed =
        crate::config(env, om::ARCHIVE_LICENSED_VAR).is_some_and(|v| om::truthy(&v));
    PLAN.with(|p| p.set(key, archive_licensed));
}

/// `url` as it must be requested (see the module doc).
pub fn url(url: &str) -> String {
    PLAN.with(|p| p.url(url))
}

/// Whether `status` from the customer host means the key was refused.
pub fn key_rejected(status: u16) -> bool {
    om::key_rejected(status)
}

/// Whether a key is held: forecast and air quality use the customer hosts.
pub fn is_paid() -> bool {
    PLAN.with(Plan::is_paid)
}

/// Whether archive calls use the customer host: a key and the plan flag.
pub fn archive_is_paid() -> bool {
    PLAN.with(Plan::archive_is_paid)
}

/// Whether `OPEN_METEO_ARCHIVE_LICENSED` is set (reported by `/health`).
pub fn archive_licensed() -> bool {
    PLAN.with(Plan::archive_licensed)
}

/// `text` with the held key (and any `apikey=` value) masked.
pub fn scrub(text: &str) -> String {
    PLAN.with(|p| p.scrub(text))
}
