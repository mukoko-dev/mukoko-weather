//! The Worker `Transport` for the push request: one POST over the Workers
//! runtime's `fetch`, for `weather_webpush::request::Transport`.
//!
//! **Dark and unwired.** Nothing constructs a [`WorkerPushTransport`] yet: no
//! scheduled handler, no send route.
//!
//! This file is glue and stays thin. Every decision is made by the pure
//! `weather_webpush::runtime` (and `request`) and tested natively there; this
//! file only carries it out with `fetch`:
//!
//! - **Only a request that passes `check_request`.** https, a known push
//!   service (`weather_core::push`), exactly the five headers a push carries
//!   with the values `build` gives them, a body of one record, a bounded
//!   deadline. Anything else is `TransportError::Refused` and nothing is sent.
//! - **No redirects.** The request is made with `redirect: "manual"`, so a 3xx
//!   comes back as a 3xx and its `Location` is not looked at.
//! - **The answer's body is never read, kept or logged.** Only the status and,
//!   for a 429 or a 5xx, the `Retry-After` header are taken
//!   (`reads_retry_after`, `retry_after_secs`); the request is then aborted so
//!   the connection is released instead of left to deliver a body nobody
//!   reads. Nothing here calls `.text()`, `.bytes()`, `.json()` or opens the
//!   body stream.
//! - **One deadline.** The request runs under the request's `timeout_ms`
//!   (`with_deadline`); when it passes, the in-flight request is aborted
//!   through its `AbortSignal` and the result is a timeout.
//! - **Nothing to leak.** `fetch` in a Worker carries no cookies and this file
//!   sets no credential of its own: the headers are the request's, already
//!   checked. It logs nothing and never puts an endpoint, a header value or a
//!   byte of a body in an error: errors are the stable `TransportError`.
//!
//! The one thing not covered by a native test is this file itself (it needs the
//! Workers runtime). `weather_webpush::tripwire` pins by source scan that it
//! keeps to the rules above, which is a tripwire and not a behaviour test: the
//! first real send, which is the owner's gate, is the first run against a push
//! service.

use std::cell::Cell;
use std::time::Duration;

use js_sys::Uint8Array;
use weather_webpush::request::{
    reads_retry_after, retry_after_secs, PushRequest, PushResponse, Transport, TransportError,
};
use weather_webpush::runtime::{check_request, with_deadline};
use worker::{
    AbortController, AbortSignal, Delay, Fetch, Headers, Method, Request, RequestInit,
    RequestRedirect,
};

/// A `Transport` over the Workers runtime's `fetch`, for push services only.
#[derive(Debug, Clone, Copy, Default)]
pub struct WorkerPushTransport;

impl Transport for WorkerPushTransport {
    async fn post(&self, req: &PushRequest) -> Result<u16, TransportError> {
        self.post_with_hint(req).await.map(|answer| answer.status)
    }

    async fn post_with_hint(&self, req: &PushRequest) -> Result<PushResponse, TransportError> {
        check_request(req).map_err(|_| TransportError::Refused)?;
        let aborter = Aborter::new();
        with_deadline(
            exchange(req, &aborter),
            Delay::from(Duration::from_millis(u64::from(req.timeout_ms))),
            || aborter.abort(),
        )
        .await
    }
}

/// The request's `AbortController`. `AbortController::abort` consumes it, so it
/// is kept in a `Cell` to be fired once from whichever of the deadline and the
/// release of the connection gets there first.
struct Aborter {
    controller: Cell<Option<AbortController>>,
    signal: AbortSignal,
}

impl Aborter {
    fn new() -> Self {
        let controller = AbortController::default();
        let signal = controller.signal();
        Aborter {
            controller: Cell::new(Some(controller)),
            signal,
        }
    }

    fn abort(&self) {
        if let Some(controller) = self.controller.take() {
            controller.abort();
        }
    }
}

/// The request and the reading of its status line.
async fn exchange(req: &PushRequest, aborter: &Aborter) -> Result<PushResponse, TransportError> {
    let headers = Headers::new();
    for (name, value) in &req.headers {
        headers
            .set(name, value)
            .map_err(|_| TransportError::Refused)?;
    }
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(Uint8Array::from(&req.body[..]).into()))
        .with_redirect(RequestRedirect::Manual);
    let request = Request::new_with_init(&req.url, &init).map_err(|_| TransportError::Refused)?;
    let response = Fetch::Request(request)
        .send_with_signal(&aborter.signal)
        .await
        .map_err(|_| TransportError::Network)?;

    let status = response.status_code();
    // The header is read only where the rules read it, and nothing else of the
    // answer is: not another header, not the body.
    let retry_after = if reads_retry_after(status) {
        response.headers().get("retry-after").ok().flatten()
    } else {
        None
    };
    // The body is not read. Release the connection instead of leaving a body
    // nobody reads.
    aborter.abort();
    Ok(PushResponse {
        status,
        retry_after_secs: retry_after_secs(status, retry_after.as_deref()),
    })
}
