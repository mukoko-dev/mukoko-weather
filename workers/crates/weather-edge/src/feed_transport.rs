//! The Worker `Transport` for the external station feeds (#361): one GET over
//! the Workers runtime's `fetch`, for `weather_core::external_fetch::Fetcher`.
//!
//! **Dark and unwired.** Nothing constructs a [`WorkerTransport`] yet: no
//! scheduled handler, no cron, no switch turned on (`FeedSwitches` is off by
//! default). It exists so the wiring PR has a transport that already holds the
//! limits `external_fetch` demands of one.
//!
//! This file is glue and stays thin. Every decision is made by the pure
//! `weather_core::external_transport` and tested natively there; this file only
//! carries it out with `fetch`:
//!
//! - **No redirects.** The request is made with `redirect: "manual"`, so a 3xx
//!   comes back as a 3xx (the fetch layer reports it as `FetchError::Status`
//!   and never counts it against the breaker). Its body is not read, and
//!   `Location` is not looked at.
//! - **Bounded body.** The body is read from the response's stream chunk by
//!   chunk (`read_bounded`) and the transfer is cancelled once it passes the
//!   request's `max_bytes`. A body is whole or it is an error: no partial data
//!   is ever returned as a success. A declared `Content-Length` over the limit
//!   fails before the first byte is read. Nothing here calls `.text()`,
//!   `.bytes()` or `.json()`, which would buffer the whole body first.
//! - **One deadline.** The request AND the reading of its body run under the
//!   request's `timeout_ms` (`with_deadline`); when it passes, the in-flight
//!   request is aborted through its `AbortSignal` and the result is a timeout.
//! - **Nothing to leak.** The only headers sent are the `User-Agent` and
//!   `Accept` the fetcher built (`check_request` refuses anything else, so no
//!   credential, cookie or API-key header can go out), the URL is refused if
//!   it is not `https` to a feed host or carries anything that looks like a
//!   secret in its query, and `fetch` in a Worker carries no cookies. Errors
//!   are a stable `TransportError` and nothing else: this file logs nothing and
//!   never puts a URL, a header or a byte of a body in an error.
//!
//! Why the body is also cancelled by dropping and aborting: `worker`'s
//! `ByteStream` turns a stream that errors with "aborted" into a clean end of
//! stream. That would read as a short body that is complete, so this transport
//! never reads after it has aborted (a deadline returns without polling the
//! exchange again, and a cancelled read returns at once), and only an abort of
//! its own making can produce that error.
//!
//! The one thing not covered by a native test is this file itself (it needs the
//! Workers runtime). `weather_core::external_transport` pins by source scan
//! that it keeps to the rules above, which is a tripwire and not a behaviour
//! test: the first scheduled call, which is the owner's gate, is the first run
//! against a real node.

use std::cell::Cell;
use std::time::Duration;

use futures::StreamExt;
use weather_core::external_fetch::{HttpRequest, HttpResponse, Transport, TransportError};
use weather_core::external_transport::{
    check_request, decode_body, plan_response, read_bounded, with_deadline, BodyPlan, ChunkSource,
    SourceError, FEED_HOSTS,
};
use worker::{
    AbortController, AbortSignal, ByteStream, Delay, Fetch, Headers, Method, Request, RequestInit,
    RequestRedirect, ResponseBody,
};

/// A `Transport` over the Workers runtime's `fetch`, for the feed hosts only.
#[derive(Debug, Clone, Copy)]
pub struct WorkerTransport {
    hosts: &'static [&'static str],
}

impl WorkerTransport {
    pub const fn new() -> Self {
        WorkerTransport { hosts: FEED_HOSTS }
    }
}

impl Default for WorkerTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl Transport for WorkerTransport {
    async fn get(&self, req: &HttpRequest) -> Result<HttpResponse, TransportError> {
        check_request(req, self.hosts).map_err(|_| TransportError::Refused)?;
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
/// is kept in a `Cell` to be fired once from whichever of the deadline and a
/// cancelled read gets there first.
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

/// The request and the reading of its body.
async fn exchange(req: &HttpRequest, aborter: &Aborter) -> Result<HttpResponse, TransportError> {
    let headers = Headers::new();
    for (name, value) in &req.headers {
        headers
            .set(name, value)
            .map_err(|_| TransportError::Refused)?;
    }
    let mut init = RequestInit::new();
    init.with_method(Method::Get)
        .with_headers(headers)
        .with_redirect(RequestRedirect::Manual);
    let request = Request::new_with_init(&req.url, &init).map_err(|_| TransportError::Refused)?;
    let mut response = Fetch::Request(request)
        .send_with_signal(&aborter.signal)
        .await
        .map_err(|_| TransportError::Network)?;

    let status = response.status_code();
    let content_length = response.headers().get("content-length").ok().flatten();
    match plan_response(status, content_length.as_deref(), req.max_bytes) {
        BodyPlan::Skip => {
            // A redirect or an error status: the status is the answer. Release
            // the connection instead of leaving a body nobody reads.
            aborter.abort();
            Ok(HttpResponse {
                status,
                body: String::new(),
            })
        }
        BodyPlan::TooLarge => {
            aborter.abort();
            Err(TransportError::TooLarge)
        }
        BodyPlan::Read => {
            let stream = if matches!(response.body(), ResponseBody::Empty) {
                None
            } else {
                Some(response.stream().map_err(|_| TransportError::Network)?)
            };
            let mut source = BodyStream { stream, aborter };
            let bytes = read_bounded(&mut source, req.max_bytes)
                .await
                .map_err(|e| e.into_transport())?;
            Ok(HttpResponse {
                status,
                body: decode_body(bytes)?,
            })
        }
    }
}

/// The response body as `read_bounded` reads it. `None` is a response with no
/// body at all (a 204, say), which is an empty body, not an error.
struct BodyStream<'a> {
    stream: Option<ByteStream>,
    aborter: &'a Aborter,
}

impl ChunkSource for BodyStream<'_> {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, SourceError> {
        let Some(stream) = self.stream.as_mut() else {
            return Ok(None);
        };
        match stream.next().await {
            Some(Ok(chunk)) => Ok(Some(chunk)),
            Some(Err(_)) => Err(SourceError),
            None => Ok(None),
        }
    }

    fn cancel(&mut self) {
        // Dropping the stream cancels its reader; aborting the signal ends the
        // transfer itself.
        self.stream = None;
        self.aborter.abort();
    }
}
