//! The wire rules for the Worker `Transport` of the external station feeds
//! (`external_fetch`), as pure code. Issue #361.
//!
//! `external_fetch` says what a [`Transport`](crate::external_fetch::Transport)
//! must honour: the request's timeout for the whole exchange, `max_bytes`
//! WHILE reading, and no redirects followed. This module holds those rules in a
//! form a native `cargo test` can run, so the Worker implementation
//! (`weather_edge::feed_transport`) is only glue: it asks these functions what
//! to do and does it with `fetch`.
//!
//! - [`check_request`]: the last look at a request before it leaves. Only
//!   `https`, only the feed hosts, no query parameter that looks like a secret,
//!   no header but `User-Agent` and `Accept` (so no `Authorization`, `Cookie`
//!   or API-key header can ever be sent), a non-blank `User-Agent`, and a
//!   request that does not ask to follow redirects. A request that fails is
//!   never sent; the caller sees [`TransportError::Refused`].
//! - [`plan_response`]: what to do with the answer's status line. Only a 2xx is
//!   read. A redirect is NOT followed and its body is not read (the status goes
//!   back as it is, so a moved feed shows up as a 3xx); an error status is
//!   returned the same way. A body that declares more than `max_bytes` fails
//!   before a byte is read.
//! - [`read_bounded`]: reads a body chunk by chunk and stops at `max_bytes`.
//!   An over-long body is [`ReadError::TooLarge`] and no partial data is
//!   returned: a body is whole or it is an error.
//! - [`with_deadline`]: the whole exchange (request and body) under one
//!   deadline. When the deadline passes first, the in-flight request is
//!   aborted and the result is [`TransportError::Timeout`].
//!
//! Errors here carry a stable code and nothing else: no URL, no header value,
//! no byte of a body, so logging one cannot leak anything.

use std::future::{poll_fn, Future};
use std::pin::pin;
use std::task::Poll;

use crate::external_fetch::{HttpRequest, TransportError};

/// The hosts the feeds are read from. A request to any other host is refused,
/// so our headers never go to a host we did not choose.
pub const FEED_HOSTS: &[&str] = &["wis2.weatherzw.org.zw", "wx-api.saaopa.org"];

/// A query parameter whose (decoded, lower-cased) name contains one of these
/// words is refused: the feeds are keyless, so a parameter that looks like a
/// credential is a mistake and must never be sent.
const SECRET_WORDS: &[&str] = &[
    "key", "token", "secret", "pass", "auth", "cred", "sig", "session", "cookie", "bearer", "jwt",
];

/// Why a request was not sent. Never carries the request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// The URL is not `https://`.
    NotHttps,
    /// The URL has a character a feed URL never has (whitespace, a control or
    /// non-ASCII character, a backslash, a fragment).
    BadUrl,
    /// The host is not one of the feed hosts (this also refuses credentials in
    /// the URL, a port and a look-alike host, because the authority must be a
    /// feed host exactly).
    HostNotAllowed,
    /// A query parameter is named like a secret.
    SecretInQuery,
    /// A header other than `User-Agent` and `Accept`.
    HeaderNotAllowed,
    /// The same header twice.
    DuplicateHeader,
    /// A header value that is blank or has a control or non-ASCII character.
    BadHeaderValue,
    /// No `User-Agent`: a feed's operator must be able to tell who is calling.
    NoUserAgent,
    /// The request asks to follow redirects; this transport never does.
    FollowsRedirects,
    /// A zero timeout or a zero byte limit.
    ZeroLimit,
}

impl Refusal {
    /// A stable machine-readable code for logs and tests.
    pub fn code(self) -> &'static str {
        match self {
            Self::NotHttps => "not_https",
            Self::BadUrl => "bad_url",
            Self::HostNotAllowed => "host_not_allowed",
            Self::SecretInQuery => "secret_in_query",
            Self::HeaderNotAllowed => "header_not_allowed",
            Self::DuplicateHeader => "duplicate_header",
            Self::BadHeaderValue => "bad_header_value",
            Self::NoUserAgent => "no_user_agent",
            Self::FollowsRedirects => "follows_redirects",
            Self::ZeroLimit => "zero_limit",
        }
    }
}

/// Whether `req` may be sent to one of `allowed_hosts` (see the module doc).
pub fn check_request(req: &HttpRequest, allowed_hosts: &[&str]) -> Result<(), Refusal> {
    if req.follow_redirects {
        return Err(Refusal::FollowsRedirects);
    }
    if req.timeout_ms == 0 || req.max_bytes == 0 {
        return Err(Refusal::ZeroLimit);
    }
    check_url(&req.url, allowed_hosts)?;
    check_headers(&req.headers)
}

fn check_url(url: &str, allowed_hosts: &[&str]) -> Result<(), Refusal> {
    let rest = url.strip_prefix("https://").ok_or(Refusal::NotHttps)?;
    if rest
        .bytes()
        .any(|b| b <= b' ' || b >= 0x7f || b == b'\\' || b == b'#')
    {
        return Err(Refusal::BadUrl);
    }
    // The authority runs to the first `/` or `?`. It must BE a feed host: that
    // refuses credentials (`user@host`), a port, a look-alike and a different
    // host in one comparison, with no URL parser to disagree with the runtime's.
    let (authority, tail) = match rest.find(['/', '?']) {
        Some(i) => rest.split_at(i),
        None => (rest, ""),
    };
    if !allowed_hosts.contains(&authority) {
        return Err(Refusal::HostNotAllowed);
    }
    if let Some((_, query)) = tail.split_once('?') {
        for pair in query.split('&') {
            let name = pair.split_once('=').map_or(pair, |(name, _)| name);
            let name = percent_decoded(name).to_ascii_lowercase();
            if SECRET_WORDS.iter().any(|w| name.contains(w)) {
                return Err(Refusal::SecretInQuery);
            }
        }
    }
    Ok(())
}

/// `%XX` escapes decoded (anything else as it is), so `api%5Fkey` is read as
/// `api_key`.
fn percent_decoded(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let escaped = (b[i] == b'%')
            .then(|| s.get(i + 1..i + 3))
            .flatten()
            .and_then(|h| u8::from_str_radix(h, 16).ok());
        match escaped {
            Some(byte) => {
                out.push(byte);
                i += 3;
            }
            None => {
                out.push(b[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn check_headers(headers: &[(&'static str, String)]) -> Result<(), Refusal> {
    let (mut user_agent, mut accept) = (false, false);
    for (name, value) in headers {
        let seen = match name.to_ascii_lowercase().as_str() {
            "user-agent" => &mut user_agent,
            "accept" => &mut accept,
            _ => return Err(Refusal::HeaderNotAllowed),
        };
        if *seen {
            return Err(Refusal::DuplicateHeader);
        }
        *seen = true;
        if value.trim().is_empty() || value.bytes().any(|b| !(b' '..0x7f).contains(&b)) {
            return Err(Refusal::BadHeaderValue);
        }
    }
    if user_agent {
        Ok(())
    } else {
        Err(Refusal::NoUserAgent)
    }
}

/// What to do with a response, decided from its status line and headers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyPlan {
    /// A 2xx: read the body, at most `max_bytes`.
    Read,
    /// Not a 2xx (a redirect, a client or a server error): hand back the status
    /// with an empty body and never read or follow anything.
    Skip,
    /// The response declares a body bigger than `max_bytes`: fail without
    /// reading it.
    TooLarge,
}

/// Decide from the status and the `Content-Length` header (as sent, if any)
/// what to do with the body.
pub fn plan_response(status: u16, content_length: Option<&str>, max_bytes: usize) -> BodyPlan {
    // The status comes first: a redirect is returned as it is, however big it
    // claims to be, and is never read.
    if !(200..300).contains(&status) {
        return BodyPlan::Skip;
    }
    // All digits is a declaration; one too long for a number is bigger than
    // any limit.
    let declared = content_length
        .map(str::trim)
        .filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
        .map(|v| v.parse::<u64>().unwrap_or(u64::MAX));
    let limit = u64::try_from(max_bytes).unwrap_or(u64::MAX);
    if declared.is_some_and(|n| n > limit) {
        BodyPlan::TooLarge
    } else {
        // A missing or unusable length declares nothing: the read itself is
        // bounded, whatever the header says (or does not).
        BodyPlan::Read
    }
}

/// A body read that failed in the source (the connection broke, the stream
/// errored). Carries nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceError;

/// Where body bytes come from: in a Worker, the response's `ReadableStream`.
#[allow(async_fn_in_trait)]
pub trait ChunkSource {
    /// The next chunk, `None` at the end of the body.
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, SourceError>;
    /// Stop the transfer: called once when reading ends early, so the
    /// connection is released instead of left to finish.
    fn cancel(&mut self);
}

/// Why a bounded read produced no body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadError {
    /// The body passed `max_bytes`.
    TooLarge,
    /// The source failed before the end of the body.
    Source,
}

impl ReadError {
    /// The error a `Transport` reports for this.
    pub fn into_transport(self) -> TransportError {
        match self {
            Self::TooLarge => TransportError::TooLarge,
            Self::Source => TransportError::Network,
        }
    }
}

/// Read a body from `source`, chunk by chunk, keeping at most `max_bytes`.
///
/// A chunk that would take the body past `max_bytes` is not kept: the source is
/// cancelled, nothing more is read and the answer is [`ReadError::TooLarge`],
/// never the first `max_bytes` bytes as if they were the body. Memory is
/// bounded by `max_bytes` plus the one chunk in hand.
pub async fn read_bounded<S: ChunkSource>(
    source: &mut S,
    max_bytes: usize,
) -> Result<Vec<u8>, ReadError> {
    let mut body: Vec<u8> = Vec::new();
    loop {
        match source.next_chunk().await {
            Ok(Some(chunk)) => {
                if chunk.len() > max_bytes - body.len() {
                    source.cancel();
                    return Err(ReadError::TooLarge);
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => return Ok(body),
            Err(SourceError) => {
                source.cancel();
                return Err(ReadError::Source);
            }
        }
    }
}

/// A body as text. A feed's JSON is UTF-8; anything else is not its answer.
pub fn decode_body(bytes: Vec<u8>) -> Result<String, TransportError> {
    String::from_utf8(bytes).map_err(|_| TransportError::NotText)
}

/// Run `exchange` (the request and the reading of its body) against
/// `deadline`. The exchange is polled first, so an answer that is ready is
/// never lost to a deadline that is ready too. When the deadline passes first,
/// `abort` is called once (it cancels the in-flight request so it does not hold
/// a subrequest slot) and the result is [`TransportError::Timeout`].
pub async fn with_deadline<T>(
    exchange: impl Future<Output = Result<T, TransportError>>,
    deadline: impl Future<Output = ()>,
    abort: impl FnOnce(),
) -> Result<T, TransportError> {
    let mut exchange = pin!(exchange);
    let mut deadline = pin!(deadline);
    let finished = poll_fn(|cx| {
        // The exchange first: an answer that is ready is never lost to a
        // deadline that is ready in the same poll.
        if let Poll::Ready(result) = exchange.as_mut().poll(cx) {
            return Poll::Ready(Some(result));
        }
        if deadline.as_mut().poll(cx).is_ready() {
            return Poll::Ready(None);
        }
        Poll::Pending
    })
    .await;
    match finished {
        Some(result) => result,
        None => {
            abort();
            Err(TransportError::Timeout)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::breaker::{self, Breaker};
    use crate::external_fetch::{
        wis2_url, FeedSwitches, Fetcher, HttpResponse, Transport, SAAOPA_STATIONS_URL,
        SAAOPA_STATUS_URL, WIS2_ITEMS_URL,
    };
    use chrono::{DateTime, Utc};
    use std::cell::{Cell, RefCell};
    use std::collections::{BTreeSet, VecDeque};
    use std::task::{Context, Waker};

    /// The futures here complete without a runtime (nothing waits on I/O), so
    /// polling in a loop is enough. A future still pending after a generous
    /// number of polls fails the test instead of hanging it: a deadline that
    /// stopped working must show up as a failure.
    fn block_on<F: Future>(f: F) -> F::Output {
        let mut f = std::pin::pin!(f);
        let mut cx = Context::from_waker(Waker::noop());
        for _ in 0..10_000 {
            if let Poll::Ready(v) = f.as_mut().poll(&mut cx) {
                return v;
            }
        }
        panic!("the future was still pending after 10000 polls");
    }

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    const UA: &str = "mukoko-weather-jobs/0.13.0 (+https://weather.mukoko.com; hi@mukoko.com)";

    fn request(url: &str) -> HttpRequest {
        HttpRequest {
            url: url.to_string(),
            headers: vec![
                ("User-Agent", UA.to_string()),
                ("Accept", "application/json".to_string()),
            ],
            timeout_ms: 10_000,
            max_bytes: 4 * 1024 * 1024,
            follow_redirects: false,
        }
    }

    fn with_header(mut req: HttpRequest, name: &'static str, value: &str) -> HttpRequest {
        req.headers.push((name, value.to_string()));
        req
    }

    fn refusal(req: &HttpRequest) -> Option<Refusal> {
        check_request(req, FEED_HOSTS).err()
    }

    // ---- check_request ----

    #[test]
    fn every_request_the_fetch_layer_builds_passes_the_check() {
        // A transport that records what it is asked and fails, so each feed
        // makes exactly its first request.
        struct Recorder(RefCell<Vec<HttpRequest>>);
        impl Transport for Recorder {
            async fn get(&self, req: &HttpRequest) -> Result<HttpResponse, TransportError> {
                self.0.borrow_mut().push(req.clone());
                Err(TransportError::Network)
            }
        }
        let rec = Recorder(RefCell::new(Vec::new()));
        let f = Fetcher::new(&rec, "0.13.0").with_switches(FeedSwitches {
            wis2: true,
            saaopa: true,
        });
        let now = at("2026-10-29T12:50:00Z");
        let codes: BTreeSet<String> = ["FVHP".to_string()].into();
        let _ = block_on(f.wis2(&mut Breaker::new(breaker::EXTERNAL_FEED), now));
        let _ = block_on(f.saaopa_status(&mut Breaker::new(breaker::EXTERNAL_FEED), now, &codes));
        let _ = block_on(f.saaopa_registry(&mut Breaker::new(breaker::EXTERNAL_FEED), now));
        let seen = rec.0.borrow();
        assert_eq!(seen.len(), 3, "one request per feed");
        for req in seen.iter() {
            assert_eq!(check_request(req, FEED_HOSTS), Ok(()), "{}", req.url);
        }
        // Later WIS2 pages differ only in the offset.
        let later = request(&wis2_url(now, now, 500, 1000));
        assert_eq!(check_request(&later, FEED_HOSTS), Ok(()));
    }

    #[test]
    fn the_feed_hosts_are_exactly_the_hosts_of_the_feed_urls() {
        for url in [WIS2_ITEMS_URL, SAAOPA_STATUS_URL, SAAOPA_STATIONS_URL] {
            let host = url
                .strip_prefix("https://")
                .and_then(|r| r.split('/').next())
                .unwrap();
            assert!(FEED_HOSTS.contains(&host), "{host}");
        }
        assert_eq!(FEED_HOSTS.len(), 2, "a new host is a new decision");
    }

    #[test]
    fn only_https_to_a_feed_host_is_allowed() {
        for (url, why) in [
            ("http://wx-api.saaopa.org/stations", Refusal::NotHttps),
            ("ftp://wx-api.saaopa.org/stations", Refusal::NotHttps),
            ("//wx-api.saaopa.org/stations", Refusal::NotHttps),
            ("wx-api.saaopa.org/stations", Refusal::NotHttps),
            ("HTTPS://wx-api.saaopa.org/stations", Refusal::NotHttps),
            ("https://example.com/stations", Refusal::HostNotAllowed),
            (
                "https://wx-api.saaopa.org.evil.example/s",
                Refusal::HostNotAllowed,
            ),
            (
                "https://evil.example/wx-api.saaopa.org",
                Refusal::HostNotAllowed,
            ),
            (
                "https://sub.wx-api.saaopa.org/stations",
                Refusal::HostNotAllowed,
            ),
            (
                "https://WX-API.SAAOPA.ORG/stations",
                Refusal::HostNotAllowed,
            ),
            (
                "https://wx-api.saaopa.org:8443/stations",
                Refusal::HostNotAllowed,
            ),
            (
                "https://wx-api.saaopa.org:@evil.example/s",
                Refusal::HostNotAllowed,
            ),
            ("https://", Refusal::HostNotAllowed),
        ] {
            assert_eq!(refusal(&request(url)), Some(why), "{url}");
        }
        assert_eq!(
            refusal(&request("https://wx-api.saaopa.org/stations")),
            None
        );
        assert_eq!(refusal(&request("https://wx-api.saaopa.org")), None);
        assert_eq!(
            refusal(&request("https://wx-api.saaopa.org?x=1")),
            None,
            "a query straight after the host"
        );
    }

    #[test]
    fn credentials_in_the_url_are_refused() {
        for url in [
            "https://user:pw@wx-api.saaopa.org/stations",
            "https://user@wx-api.saaopa.org/stations",
            "https://evil.example@wx-api.saaopa.org/stations",
            "https://wx-api.saaopa.org@evil.example/stations",
        ] {
            assert_eq!(
                refusal(&request(url)),
                Some(Refusal::HostNotAllowed),
                "{url}"
            );
        }
    }

    #[test]
    fn urls_with_odd_characters_are_refused() {
        for url in [
            "https://wx-api.saaopa.org/stations#frag",
            "https://wx-api.saaopa.org/sta tions",
            "https://wx-api.saaopa.org/stations\n",
            "https://wx-api.saaopa.org/stations\t",
            "https://wx-api.saaopa.org/st\\ations",
            "https://wx-api.saaopa.org/stations\u{7f}",
            "https://wx-api.saaopa.org/stätions",
            "https://wx-api.saaopa.org/stations?a=b#c",
        ] {
            assert_eq!(refusal(&request(url)), Some(Refusal::BadUrl), "{url:?}");
        }
    }

    #[test]
    fn a_query_that_looks_like_a_secret_is_refused_and_the_feed_queries_pass() {
        for q in [
            "apikey=x",
            "api_key=x",
            "api-key=x",
            "key=x",
            "token=x",
            "access_token=x",
            "password=x",
            "passkey=x",
            "PASSKEY=x",
            "secret=x",
            "client_secret=x",
            "auth=x",
            "authorization=x",
            "signature=x",
            "sessionid=x",
            "f=json&apikey=x",
            "limit=5&Token=x",
            "api%5Fkey=x",
            "%6Bey=x",
            "to%6Ben=x",
            "%41uth=x",
            "passw%6Frd=x",
            "token",
            "token&limit=5",
        ] {
            let url = format!("https://wis2.weatherzw.org.zw/oapi/items?{q}");
            assert_eq!(refusal(&request(&url)), Some(Refusal::SecretInQuery), "{q}");
        }
        let ok = "https://wis2.weatherzw.org.zw/oapi/items?f=json&datetime=2026-10-29T05:50:00Z/2026-10-29T12:50:00Z&limit=500&offset=0";
        assert_eq!(refusal(&request(ok)), None);
        // The parameter's VALUE may contain anything a name may not.
        let value = "https://wis2.weatherzw.org.zw/oapi/items?f=token";
        assert_eq!(refusal(&request(value)), None);
    }

    #[test]
    fn no_header_but_user_agent_and_accept_can_be_sent() {
        for name in [
            "Authorization",
            "authorization",
            "AUTHORIZATION",
            "Proxy-Authorization",
            "Cookie",
            "Set-Cookie",
            "X-API-Key",
            "X-Api-Key",
            "Api-Key",
            "X-Auth-Token",
            "Host",
            "Referer",
            "Origin",
            "Content-Type",
        ] {
            let req = with_header(request("https://wx-api.saaopa.org/stations"), name, "v");
            assert_eq!(refusal(&req), Some(Refusal::HeaderNotAllowed), "{name}");
        }
        // The two allowed names are matched without regard to case.
        let mut req = request("https://wx-api.saaopa.org/stations");
        req.headers = vec![
            ("user-agent", UA.to_string()),
            ("ACCEPT", "*/*".to_string()),
        ];
        assert_eq!(refusal(&req), None);
    }

    #[test]
    fn a_header_may_not_be_sent_twice() {
        let ua = with_header(request("https://wx-api.saaopa.org/s"), "user-agent", UA);
        assert_eq!(refusal(&ua), Some(Refusal::DuplicateHeader));
        let accept = with_header(request("https://wx-api.saaopa.org/s"), "Accept", "*/*");
        assert_eq!(refusal(&accept), Some(Refusal::DuplicateHeader));
    }

    #[test]
    fn a_request_without_a_user_agent_is_not_sent() {
        let mut req = request("https://wx-api.saaopa.org/stations");
        req.headers = vec![("Accept", "application/json".to_string())];
        assert_eq!(refusal(&req), Some(Refusal::NoUserAgent));
        req.headers.clear();
        assert_eq!(refusal(&req), Some(Refusal::NoUserAgent));
    }

    #[test]
    fn header_values_are_plain_visible_ascii() {
        for bad in [
            "",
            "   ",
            "a\r\nCookie: x",
            "a\nb",
            "a\0b",
            "caf\u{e9}",
            "a\u{7f}",
        ] {
            let mut req = request("https://wx-api.saaopa.org/stations");
            req.headers = vec![("User-Agent", bad.to_string())];
            assert_eq!(refusal(&req), Some(Refusal::BadHeaderValue), "{bad:?}");
            let mut req = request("https://wx-api.saaopa.org/stations");
            req.headers = vec![("User-Agent", UA.to_string()), ("Accept", bad.to_string())];
            assert_eq!(refusal(&req), Some(Refusal::BadHeaderValue), "{bad:?}");
        }
    }

    #[test]
    fn a_request_that_asks_to_follow_redirects_is_not_sent() {
        let mut req = request("https://wx-api.saaopa.org/stations");
        req.follow_redirects = true;
        assert_eq!(refusal(&req), Some(Refusal::FollowsRedirects));
        req.follow_redirects = false;
        assert_eq!(refusal(&req), None);
    }

    #[test]
    fn a_zero_timeout_or_a_zero_byte_limit_is_not_sent() {
        let mut req = request("https://wx-api.saaopa.org/stations");
        req.timeout_ms = 0;
        assert_eq!(refusal(&req), Some(Refusal::ZeroLimit));
        let mut req = request("https://wx-api.saaopa.org/stations");
        req.max_bytes = 0;
        assert_eq!(refusal(&req), Some(Refusal::ZeroLimit));
    }

    #[test]
    fn refusal_codes_are_stable_and_say_nothing_about_the_request() {
        let all = [
            (Refusal::NotHttps, "not_https"),
            (Refusal::BadUrl, "bad_url"),
            (Refusal::HostNotAllowed, "host_not_allowed"),
            (Refusal::SecretInQuery, "secret_in_query"),
            (Refusal::HeaderNotAllowed, "header_not_allowed"),
            (Refusal::DuplicateHeader, "duplicate_header"),
            (Refusal::BadHeaderValue, "bad_header_value"),
            (Refusal::NoUserAgent, "no_user_agent"),
            (Refusal::FollowsRedirects, "follows_redirects"),
            (Refusal::ZeroLimit, "zero_limit"),
        ];
        for (r, code) in all {
            assert_eq!(r.code(), code);
        }
    }

    // ---- plan_response: redirects and the declared size ----

    const MAX: usize = 4 * 1024 * 1024;

    #[test]
    fn only_a_2xx_is_read() {
        for s in [200, 201, 202, 204, 206, 299] {
            assert_eq!(plan_response(s, None, MAX), BodyPlan::Read, "{s}");
        }
    }

    #[test]
    fn a_redirect_is_never_followed_and_its_body_is_never_read() {
        for s in [300, 301, 302, 303, 304, 305, 307, 308, 399] {
            assert_eq!(plan_response(s, None, MAX), BodyPlan::Skip, "{s}");
            // However large it says it is, it is not read, so it is not "too
            // large" either: the status is what the caller needs.
            assert_eq!(
                plan_response(s, Some("999999999999"), MAX),
                BodyPlan::Skip,
                "{s}"
            );
        }
    }

    #[test]
    fn an_error_status_is_returned_without_reading_the_body() {
        for s in [100, 101, 199, 400, 401, 403, 404, 429, 500, 502, 503, 599] {
            assert_eq!(plan_response(s, None, MAX), BodyPlan::Skip, "{s}");
        }
    }

    #[test]
    fn a_declared_length_over_the_limit_fails_before_reading() {
        assert_eq!(plan_response(200, Some("4194305"), MAX), BodyPlan::TooLarge);
        assert_eq!(
            plan_response(200, Some(" 4194305 "), MAX),
            BodyPlan::TooLarge
        );
        assert_eq!(
            plan_response(200, Some("99999999999999999999999"), MAX),
            BodyPlan::TooLarge,
            "a length too long for a number is bigger than any limit"
        );
        assert_eq!(plan_response(200, Some("4194304"), MAX), BodyPlan::Read);
        assert_eq!(plan_response(200, Some("0"), MAX), BodyPlan::Read);
        assert_eq!(plan_response(200, Some("11"), 10), BodyPlan::TooLarge);
        assert_eq!(plan_response(200, Some("10"), 10), BodyPlan::Read);
    }

    #[test]
    fn a_length_header_that_is_not_a_number_is_ignored_and_the_read_stays_bounded() {
        for v in ["", "abc", "-1", "1e9", "12 34", "0x10", "+5"] {
            assert_eq!(plan_response(200, Some(v), 10), BodyPlan::Read, "{v:?}");
        }
    }

    // ---- read_bounded: stop at max_bytes ----

    struct Script {
        chunks: VecDeque<Result<Vec<u8>, SourceError>>,
        pulled: usize,
        cancelled: u32,
    }

    impl Script {
        fn new(chunks: Vec<Result<Vec<u8>, SourceError>>) -> Self {
            Script {
                chunks: chunks.into(),
                pulled: 0,
                cancelled: 0,
            }
        }
        fn of(parts: &[&[u8]]) -> Self {
            Script::new(parts.iter().map(|p| Ok(p.to_vec())).collect())
        }
    }

    impl ChunkSource for Script {
        async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, SourceError> {
            self.pulled += 1;
            match self.chunks.pop_front() {
                Some(Ok(c)) => Ok(Some(c)),
                Some(Err(e)) => Err(e),
                None => Ok(None),
            }
        }
        fn cancel(&mut self) {
            self.cancelled += 1;
        }
    }

    #[test]
    fn a_body_within_the_limit_is_returned_whole() {
        let mut s = Script::of(&[b"ab", b"", b"cd", b"e"]);
        assert_eq!(block_on(read_bounded(&mut s, 10)).unwrap(), b"abcde");
        assert_eq!(s.cancelled, 0, "a body read to its end needs no cancel");
        assert_eq!(s.pulled, 5, "the end of the body was read");
    }

    #[test]
    fn a_body_of_exactly_the_limit_is_allowed() {
        let mut s = Script::of(&[b"ab", b"cd"]);
        assert_eq!(block_on(read_bounded(&mut s, 4)).unwrap(), b"abcd");
    }

    #[test]
    fn an_empty_body_is_empty_not_an_error() {
        let mut s = Script::of(&[]);
        assert_eq!(block_on(read_bounded(&mut s, 4)).unwrap(), b"");
    }

    #[test]
    fn a_body_one_byte_over_the_limit_is_too_large_and_never_partial() {
        let mut s = Script::of(&[b"ab", b"cd", b"e"]);
        let got = block_on(read_bounded(&mut s, 4));
        assert_eq!(got, Err(ReadError::TooLarge), "no first-4-bytes success");
        assert_eq!(s.cancelled, 1, "the transfer is stopped");
    }

    #[test]
    fn reading_stops_at_the_chunk_that_passes_the_limit() {
        let chunks: Vec<&[u8]> = vec![b"aaaa"; 1000];
        let mut s = Script::of(&chunks);
        assert_eq!(block_on(read_bounded(&mut s, 10)), Err(ReadError::TooLarge));
        assert_eq!(
            s.pulled, 3,
            "4 + 4 + 4 > 10: the third chunk is the last pulled"
        );
        assert_eq!(s.chunks.len(), 997, "the rest of the body is never read");
        assert_eq!(s.cancelled, 1);
    }

    #[test]
    fn a_single_chunk_bigger_than_the_limit_is_too_large() {
        let big = vec![0u8; 100];
        let mut s = Script::new(vec![Ok(big)]);
        assert_eq!(block_on(read_bounded(&mut s, 99)), Err(ReadError::TooLarge));
        assert_eq!(s.cancelled, 1);
        let mut s = Script::new(vec![Ok(vec![0u8; 100])]);
        assert_eq!(block_on(read_bounded(&mut s, 100)).unwrap().len(), 100);
    }

    #[test]
    fn the_limit_holds_for_any_chunking_of_the_same_body() {
        let body = [7u8; 64];
        for step in [1usize, 2, 3, 7, 16, 63, 64, 65] {
            let parts: Vec<&[u8]> = body.chunks(step).collect();
            let mut s = Script::of(&parts);
            assert_eq!(
                block_on(read_bounded(&mut s, 64)).unwrap().len(),
                64,
                "{step}"
            );
            let mut s = Script::of(&parts);
            assert_eq!(
                block_on(read_bounded(&mut s, 63)),
                Err(ReadError::TooLarge),
                "{step}"
            );
        }
    }

    #[test]
    fn a_failing_source_is_a_failure_with_no_partial_body() {
        let mut s = Script::new(vec![
            Ok(b"ab".to_vec()),
            Err(SourceError),
            Ok(b"cd".to_vec()),
        ]);
        assert_eq!(block_on(read_bounded(&mut s, 10)), Err(ReadError::Source));
        assert_eq!(s.cancelled, 1);
        assert_eq!(s.pulled, 2, "nothing is read after the error");
    }

    #[test]
    fn read_errors_map_to_the_transport_errors_the_fetch_layer_knows() {
        assert_eq!(
            ReadError::TooLarge.into_transport(),
            TransportError::TooLarge
        );
        assert_eq!(ReadError::Source.into_transport(), TransportError::Network);
    }

    #[test]
    fn a_body_is_text_or_it_is_not_the_feeds_answer() {
        assert_eq!(decode_body(b"{\"a\":1}".to_vec()).unwrap(), "{\"a\":1}");
        assert_eq!(decode_body(Vec::new()).unwrap(), "");
        assert_eq!(
            decode_body("caf\u{e9}".as_bytes().to_vec()).unwrap(),
            "caf\u{e9}"
        );
        assert_eq!(decode_body(vec![0xff, 0xfe]), Err(TransportError::NotText));
        assert_eq!(decode_body(vec![b'a', 0xc3]), Err(TransportError::NotText));
    }

    // ---- with_deadline: one deadline for the whole exchange ----

    /// Pending for `n` polls, then ready.
    struct After(u32);
    impl Future for After {
        type Output = ();
        fn poll(mut self: std::pin::Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<()> {
            if self.0 == 0 {
                Poll::Ready(())
            } else {
                self.0 -= 1;
                Poll::Pending
            }
        }
    }

    /// An exchange that takes `n` polls and then answers `v`.
    async fn answers_after(n: u32, v: Result<u8, TransportError>) -> Result<u8, TransportError> {
        After(n).await;
        v
    }

    #[test]
    fn an_exchange_that_finishes_in_time_is_returned_and_nothing_is_aborted() {
        let aborted = Cell::new(0u32);
        let got = block_on(with_deadline(answers_after(2, Ok(7)), After(50), || {
            aborted.set(aborted.get() + 1)
        }));
        assert_eq!(got, Ok(7));
        assert_eq!(aborted.get(), 0);
    }

    #[test]
    fn an_exchange_that_outlasts_the_deadline_is_a_timeout_and_is_aborted_once() {
        let aborted = Cell::new(0u32);
        let got = block_on(with_deadline(answers_after(50, Ok(7)), After(2), || {
            aborted.set(aborted.get() + 1)
        }));
        assert_eq!(got, Err(TransportError::Timeout));
        assert_eq!(aborted.get(), 1, "the in-flight request is cancelled");
    }

    #[test]
    fn an_exchange_that_never_finishes_still_times_out() {
        let aborted = Cell::new(0u32);
        let got = block_on(with_deadline(
            std::future::pending::<Result<u8, TransportError>>(),
            After(3),
            || aborted.set(aborted.get() + 1),
        ));
        assert_eq!(got, Err(TransportError::Timeout));
        assert_eq!(aborted.get(), 1);
    }

    #[test]
    fn an_answer_that_is_ready_with_the_deadline_wins() {
        let aborted = Cell::new(0u32);
        let got = block_on(with_deadline(
            std::future::ready(Ok::<u8, TransportError>(9)),
            std::future::ready(()),
            || aborted.set(aborted.get() + 1),
        ));
        assert_eq!(got, Ok(9), "an answer in hand is not thrown away");
        assert_eq!(aborted.get(), 0);
    }

    #[test]
    fn a_failure_before_the_deadline_keeps_its_own_classification() {
        let aborted = Cell::new(0u32);
        for e in [
            TransportError::Network,
            TransportError::TooLarge,
            TransportError::NotText,
            TransportError::Refused,
        ] {
            let got = block_on(with_deadline(answers_after(1, Err(e)), After(50), || {
                aborted.set(aborted.get() + 1)
            }));
            assert_eq!(got, Err(e));
        }
        assert_eq!(aborted.get(), 0);
    }

    // ---- the Worker glue stays on these rules ----
    //
    // The glue (`weather_edge::feed_transport`) wraps the Workers runtime's
    // `fetch` and cannot run natively. These checks read its source: a
    // tripwire that the rules above are what it uses, not a test of its
    // behaviour. Comment lines are ignored so the glue can explain itself.

    const GLUE: &str = include_str!("../../weather-edge/src/feed_transport.rs");

    fn glue_code() -> String {
        GLUE.lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn the_glue_asks_for_manual_redirects_and_nothing_else() {
        let code = glue_code();
        assert!(code.contains("RequestRedirect::Manual"), "redirect: manual");
        assert_eq!(
            code.matches("RequestRedirect::").count(),
            code.matches("RequestRedirect::Manual").count(),
            "no other redirect mode"
        );
    }

    #[test]
    fn the_glue_sends_one_plain_get_with_a_signal() {
        let code = glue_code();
        assert!(code.contains("Method::Get"));
        assert_eq!(
            code.matches("Method::").count(),
            code.matches("Method::Get").count(),
            "only GET"
        );
        assert!(
            code.contains("send_with_signal"),
            "the abort signal is passed"
        );
        assert!(!code.contains("with_body"), "a GET has no body");
        assert!(!code.contains("with_cf_properties"), "no edge options");
    }

    #[test]
    fn the_glue_uses_the_pure_rules() {
        let code = glue_code();
        for call in [
            "check_request(",
            "plan_response(",
            "read_bounded(",
            "with_deadline(",
            "decode_body(",
        ] {
            assert!(code.contains(call), "{call}");
        }
        assert!(
            code.contains("impl Transport for"),
            "it implements the fetch layer's trait"
        );
    }

    #[test]
    fn the_glue_never_buffers_a_whole_body_or_goes_around_the_rules() {
        let code = glue_code();
        for banned in [
            ".text(",
            ".bytes(",
            ".json(",
            ".array_buffer(",
            ".form_data(",
            "get_with_timeout",
            "Fetch::Url",
        ] {
            assert!(!code.contains(banned), "{banned}");
        }
    }

    #[test]
    fn the_glue_adds_no_credentials_of_its_own() {
        let code = glue_code().to_ascii_lowercase();
        for banned in [
            "authorization",
            "cookie",
            "api-key",
            "apikey",
            "x-api",
            "credentials",
            "bearer",
            "secret(",
            "env.",
        ] {
            assert!(!code.contains(banned), "{banned}");
        }
    }

    #[test]
    fn the_glue_logs_nothing() {
        let code = glue_code();
        for banned in [
            "console_log!",
            "console_warn!",
            "console_error!",
            "console_debug!",
            "println!",
            "eprintln!",
            "dbg!",
            "tracing::",
            "log::",
        ] {
            assert!(!code.contains(banned), "{banned}");
        }
    }
}
