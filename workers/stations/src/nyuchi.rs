//! The Nyuchi backend (`STATIONS_BACKEND=nyuchi`): the Worker's calls to the
//! Nyuchi API, and nothing else. Every decision (what a status means, what is
//! cached, what a body must look like) is in `weather_core::station_service`
//! and tested natively; this file is the I/O around it.
//!
//! The API's base URL is the var `NYUCHI_API_URL`; the Worker's own internal
//! key (scoped `stations` and `stations:service`) is the secret
//! `NYUCHI_STATIONS_API_KEY`, from the Secrets Store binding
//! `MUKOKO_WEATHER_NYUCHI_STATIONS_API_KEY` (the plain wrangler secret of the
//! same plain name until the binding exists: `weather_edge::secret`). A
//! missing piece is `Failure::NotConfigured`: every station is answered `503`
//! and an `ALERT` line is logged. It is never "your key is wrong".
//!
//! The key goes in `X-API-Key`, as the other Workers send it. The legacy
//! `status` and `manual` proxies send only the station's own key, as the
//! bearer; the Worker's key is not on those calls.

use std::cell::RefCell;
use std::time::Duration;

use futures::future::{select, Either};
use serde_json::Value;
use weather_core::secrets::NYUCHI_STATIONS_API_KEY;
use weather_core::station::Metrics;
use weather_core::station_service::{
    api_base, manual_readings_body, no_answer, observations_body, parse_manual, parse_observations,
    parse_status, parse_verify, verify_body, Cached, Failure, ItemOutcome, LogThrottle,
    ManualResult, ObservationItem, Proxied, UnknownBackend, VerifyAnswer, VerifyCache, API_URL_VAR,
};
use weather_edge::{config, now_ms, secret};
use worker::wasm_bindgen::JsValue;
use worker::{
    console_error, console_warn, AbortController, Delay, Env, Fetch, Headers, Method, Request,
    RequestInit,
};

use crate::auth::Outcome;

/// The KV binding for `stations:latest`: the forecast Worker's namespace, which
/// the forecast Worker reads it from.
pub const LATEST_KV: &str = "FORECAST_CACHE";

/// The hot path waits this long for a key check; a station that gets no answer
/// uploads again on its next interval.
const VERIFY_TIMEOUT: Duration = Duration::from_secs(4);
/// The queue consumer's batch write.
const WRITE_TIMEOUT: Duration = Duration::from_secs(15);
/// The legacy proxies.
const PROXY_TIMEOUT: Duration = Duration::from_secs(8);

thread_local! {
    static VERIFIED: RefCell<VerifyCache> = RefCell::new(VerifyCache::new());
    static THROTTLE: RefCell<LogThrottle> = RefCell::new(LogThrottle::new());
}

/// Log a line, at most once per `tag` per half minute per isolate, so an
/// outage is loud but not a line per upload. `alert` lines go to
/// `console.error` (what an alert rule watches), the rest to `console.warn`.
pub fn log_throttled(tag: &'static str, alert: bool, line: &str) {
    if !THROTTLE.with(|t| t.borrow_mut().allow(tag, now_ms())) {
        return;
    }
    if alert {
        console_error!("{}", line);
    } else {
        console_warn!("{}", line);
    }
}

/// Log a failure of the API or of this mode's configuration.
pub fn report(f: &Failure) {
    log_throttled(f.tag(), f.is_alert(), &f.log_line());
}

/// Log a `STATIONS_BACKEND` value that is neither `d1` nor `nyuchi`.
pub fn report_unknown(bad: &UnknownBackend) {
    log_throttled("stations_backend_unknown", true, &bad.log_line());
}

/// What a call to the API is authenticated with.
enum Credential<'a> {
    /// The Worker's internal key: `X-API-Key`.
    Service(&'a str),
    /// A station's own key: `Authorization: Bearer`.
    Station(&'a str),
}

/// The API, with the Worker's own credential. Built by [`Service::load`], which
/// is the one place that says what `nyuchi` mode needs.
pub struct Service {
    base: String,
    key: String,
}

/// The API's base URL alone, for the proxies, which carry the station's key.
pub fn base_url(env: &Env) -> Result<String, Failure> {
    api_base(config(env, API_URL_VAR).as_deref()).ok_or(Failure::NotConfigured {
        missing: vec![API_URL_VAR],
    })
}

/// What `nyuchi` mode needs, and which of it is there (names and presence
/// only: the key's value is never read into anything that is logged).
pub struct Present {
    base: Option<String>,
    key: Option<String>,
    pub api_url: bool,
    pub api_key: bool,
    pub latest_kv: bool,
}

impl Present {
    pub async fn of(env: &Env) -> Present {
        let base = api_base(config(env, API_URL_VAR).as_deref());
        let key = secret(env, NYUCHI_STATIONS_API_KEY).await;
        Present {
            api_url: base.is_some(),
            api_key: key.is_some(),
            latest_kv: env.kv(LATEST_KV).is_ok(),
            base,
            key,
        }
    }

    /// The names of what is missing.
    pub fn missing(&self) -> Vec<&'static str> {
        let mut missing = Vec::new();
        if !self.api_url {
            missing.push(API_URL_VAR);
        }
        if !self.api_key {
            missing.push(NYUCHI_STATIONS_API_KEY);
        }
        if !self.latest_kv {
            missing.push(LATEST_KV);
        }
        missing
    }
}

impl Service {
    /// The configuration of `nyuchi` mode, or exactly what is missing: the API
    /// URL, the Worker's key, and the KV binding the blend snapshot is written
    /// to. A mode that cannot work fails closed here instead of half working.
    pub async fn load(env: &Env) -> Result<Service, Failure> {
        let present = Present::of(env).await;
        let missing = present.missing();
        match (present.base, present.key) {
            (Some(base), Some(key)) if missing.is_empty() => Ok(Service { base, key }),
            _ => Err(Failure::NotConfigured { missing }),
        }
    }

    /// Whether the key `station_id`/`key` opens an active station. Asked of the
    /// API with the isolate's cache in front: a good answer is kept for ten
    /// minutes, a bad one for sixty seconds, and a failure is never kept.
    async fn verify(&self, station_id: &str, key: &str) -> Result<VerifyAnswer, Failure> {
        let body = verify_body(station_id, key).to_string();
        let (status, text) = send(
            &self.base,
            "/v1/stations/service/verify",
            Method::Post,
            Credential::Service(&self.key),
            Some(body),
            VERIFY_TIMEOUT,
            "verify",
        )
        .await?;
        parse_verify(station_id, status, &text)
    }

    /// One request of the batch write: an outcome for each item, in order.
    pub async fn write_observations(
        &self,
        items: &[&ObservationItem],
    ) -> Result<Vec<ItemOutcome>, Failure> {
        let body = observations_body(items).to_string();
        let (status, text) = send(
            &self.base,
            "/v1/stations/service/observations",
            Method::Post,
            Credential::Service(&self.key),
            Some(body),
            WRITE_TIMEOUT,
            "observations",
        )
        .await?;
        parse_observations(items.len(), status, &text)
    }
}

/// The hot path's key check. `Unavailable` means "answer 503": the reason is
/// already logged. It is never `Denied`.
pub async fn verify(env: &Env, station_id: &str, key: &str) -> worker::Result<Outcome> {
    // Fail closed first: a misconfigured mode never answers from a warm cache.
    let service = match Service::load(env).await {
        Ok(s) => s,
        Err(f) => {
            report(&f);
            return Ok(Outcome::Unavailable);
        }
    };
    let digest = VerifyCache::digest(station_id, key);
    match VERIFIED.with(|c| c.borrow().lookup(&digest, now_ms())) {
        Cached::Valid(s) => return Ok(Outcome::Station(s.identity())),
        Cached::Invalid => return Ok(Outcome::Denied),
        Cached::Miss => {}
    }
    match service.verify(station_id, key).await {
        Ok(answer) => {
            VERIFIED.with(|c| c.borrow_mut().remember(digest, &answer, now_ms()));
            Ok(match answer {
                VerifyAnswer::Valid(s) => Outcome::Station(s.identity()),
                VerifyAnswer::Invalid => Outcome::Denied,
            })
        }
        Err(f) => {
            report(&f);
            Ok(Outcome::Unavailable)
        }
    }
}

/// A legacy `manual` reading, forwarded to the API with the station's own key.
pub async fn manual(
    base: &str,
    station_id: &str,
    key: &str,
    metrics: &Metrics,
) -> Result<Proxied<ManualResult>, Failure> {
    let (status, text) = send(
        base,
        &format!("/v1/stations/{station_id}/readings"),
        Method::Post,
        Credential::Station(key),
        Some(manual_readings_body(metrics).to_string()),
        PROXY_TIMEOUT,
        "readings",
    )
    .await?;
    parse_manual(status, &text)
}

/// A legacy `status` request, forwarded to the API with the station's own key.
pub async fn status(base: &str, station_id: &str, key: &str) -> Result<Proxied<Value>, Failure> {
    let (status, text) = send(
        base,
        &format!("/v1/stations/{station_id}"),
        Method::Get,
        Credential::Station(key),
        None,
        PROXY_TIMEOUT,
        "status",
    )
    .await?;
    parse_status(station_id, status, &text)
}

/// One request, abandoned after `timeout`. `what` names the call in logs. The
/// station id in a path is `mws-` and eight hex digits (the callers check),
/// so it is safe there. The credential is set on a header and appears nowhere
/// else: not in the URL, not in an error, not in a log.
async fn send(
    base: &str,
    path: &str,
    method: Method,
    credential: Credential<'_>,
    body: Option<String>,
    timeout: Duration,
    what: &'static str,
) -> Result<(u16, String), Failure> {
    let headers = Headers::new();
    let mut ok = headers.set("Accept", "application/json").is_ok();
    ok &= match credential {
        Credential::Service(key) => headers.set("X-API-Key", key),
        Credential::Station(key) => headers.set("Authorization", &format!("Bearer {key}")),
    }
    .is_ok();
    if body.is_some() {
        ok &= headers.set("Content-Type", "application/json").is_ok();
    }
    let mut init = RequestInit::new();
    init.with_method(method).with_headers(headers);
    if let Some(b) = body {
        init.with_body(Some(JsValue::from_str(&b)));
    }
    let request = Request::new_with_init(&format!("{base}{path}"), &init);
    let (true, Ok(request)) = (ok, request) else {
        // Could not even build the request (a header the runtime refuses).
        return Err(no_answer(what));
    };

    let controller = AbortController::default();
    let signal = controller.signal();
    let call = Box::pin(async {
        let mut response = Fetch::Request(request).send_with_signal(&signal).await?;
        let status = response.status_code();
        let text = response.text().await?;
        Ok::<_, worker::Error>((status, text))
    });
    let timer = Box::pin(Delay::from(timeout));
    let outcome = select(call, timer).await;
    match outcome {
        Either::Left((Ok(answer), _)) => Ok(answer),
        Either::Left((Err(_), _)) => Err(no_answer(what)),
        Either::Right(_) => {
            controller.abort();
            Err(no_answer(what))
        }
    }
}
