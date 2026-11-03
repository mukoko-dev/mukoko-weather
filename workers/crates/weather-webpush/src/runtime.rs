//! The rules the Workers-runtime half of the sender must honour, as pure code
//! (mukoko-dev/mukoko-weather#289, step c).
//!
//! `workers/push` (`mukoko-weather-push`) holds the glue that touches the
//! runtime: WebCrypto for the key agreement ([`crate::encrypt::KeyAgreement`])
//! and the VAPID signature ([`crate::vapid::Es256Signer`]), and `fetch` for the
//! POST ([`crate::request::Transport`]). That glue cannot run natively, so it
//! is kept thin and asks this module what to do:
//!
//! - [`check_request`]: the last look at a request before it leaves. Only
//!   `https`, only a known push service (`weather_core::push::validate_endpoint`,
//!   the list the subscription was accepted against), exactly the five headers
//!   RFC 8030 and RFC 8292 call for with the values [`crate::request::build`]
//!   gives them (so a `Cookie`, an API key or any other header can never go
//!   out), a body that fits one record, a bounded deadline. A request that
//!   fails is never sent ([`TransportError::Refused`]).
//! - [`with_deadline`]: the whole exchange under one deadline; when it passes
//!   first, the in-flight request is aborted and the result is a timeout.
//! - The response is never read. [`crate::request::reads_retry_after`] decides
//!   whether the `Retry-After` header is looked at (a 429 or a 5xx only) and
//!   [`crate::request::retry_after_secs`] turns it into a number; nothing else
//!   of the answer is kept.
//! - [`agreement_from_parts`], [`signature_from_bytes`], [`import_error`] and
//!   [`VapidKeyMaterial`]: the shapes WebCrypto's bytes must have before they
//!   mean anything, and the JWK the VAPID private key is imported as, with the
//!   lengths and the uncompressed-point prefix checked.
//!
//! **No key is generated, read or stored here.** [`VapidKeyMaterial`] is a
//! pure conversion of values the CALLER passes in; its `Debug` prints nothing
//! of them. Errors are stable codes ([`Refusal::code`], [`KeyError::code`])
//! and carry no URL, header value, key or byte of a body.

use std::future::Future;

use base64::Engine;
use weather_core::external_fetch::TransportError as DeadlineError;
use weather_core::push::{self, PushError};

use crate::encrypt::{Agreement, EncryptError, HEADER_LEN, RECORD_SIZE};
use crate::request::{PushRequest, TransportError, MAX_TTL_SECS};
use crate::vapid::VapidError;
use crate::B64URL;

/// The longest deadline a transport accepts, in milliseconds. A push is one
/// small POST ([`crate::request::SEND_TIMEOUT_MS`] is 8 s); anything longer
/// would hold a Worker invocation open for a push service that is not
/// answering.
pub const MAX_TIMEOUT_MS: u32 = 30_000;
/// The smallest body that is a message at all: the 86-octet header, the
/// delimiter and the AES-GCM tag (RFC 8291 section 4).
pub const MIN_BODY_LEN: usize = HEADER_LEN + 1 + 16;
/// The largest body one record allows, which is also the most a push service
/// is required to take (RFC 8030 section 7.2).
pub const MAX_BODY_LEN: usize = RECORD_SIZE as usize;
/// The longest `Authorization` value taken: a VAPID token and key are about
/// 340 octets.
const MAX_AUTHORIZATION_LEN: usize = 1024;

/// The headers a push request carries, lower-case, in the order of `seen`.
const HEADERS: [&str; 5] = [
    "authorization",
    "content-encoding",
    "content-type",
    "ttl",
    "urgency",
];

/// Why a request was not sent. Never carries the request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// The endpoint is not `https://`.
    NotHttps,
    /// The URL has a character a push endpoint never has (whitespace, a
    /// control or non-ASCII character, a backslash, a fragment), a port other
    /// than the default, credentials, or is too long.
    BadUrl,
    /// The host is not a known push service.
    HostNotAllowed,
    /// A header other than the five a push request carries.
    HeaderNotAllowed,
    /// The same header twice.
    DuplicateHeader,
    /// One of the five headers is missing.
    MissingHeader,
    /// A header value that is not what [`crate::request::build`] writes.
    BadHeaderValue,
    /// The body is not one record (too short to be a message, or longer than
    /// 4096 octets).
    BadBody,
    /// A zero deadline, or one above [`MAX_TIMEOUT_MS`].
    BadTimeout,
}

impl Refusal {
    /// A stable machine-readable code for logs and tests.
    pub fn code(self) -> &'static str {
        match self {
            Self::NotHttps => "not_https",
            Self::BadUrl => "bad_url",
            Self::HostNotAllowed => "host_not_allowed",
            Self::HeaderNotAllowed => "header_not_allowed",
            Self::DuplicateHeader => "duplicate_header",
            Self::MissingHeader => "missing_header",
            Self::BadHeaderValue => "bad_header_value",
            Self::BadBody => "bad_body",
            Self::BadTimeout => "bad_timeout",
        }
    }
}

/// Whether `req` may be sent (see the module doc). The transport calls this
/// before it builds anything for `fetch`, whatever the caller did before.
pub fn check_request(req: &PushRequest) -> Result<(), Refusal> {
    check_url(&req.url)?;
    check_headers(&req.headers)?;
    if !(MIN_BODY_LEN..=MAX_BODY_LEN).contains(&req.body.len()) {
        return Err(Refusal::BadBody);
    }
    if req.timeout_ms == 0 || req.timeout_ms > MAX_TIMEOUT_MS {
        return Err(Refusal::BadTimeout);
    }
    Ok(())
}

fn check_url(url: &str) -> Result<(), Refusal> {
    let rest = url.strip_prefix("https://").ok_or(Refusal::NotHttps)?;
    // A backslash is a slash to a browser's URL parser and not to ours: a URL
    // that carries one could name two hosts. Refused outright.
    if rest
        .bytes()
        .any(|b| b <= b' ' || b >= 0x7f || b == b'\\' || b == b'#')
    {
        return Err(Refusal::BadUrl);
    }
    push::validate_endpoint(url).map_err(|e| match e {
        PushError::NotHttps => Refusal::NotHttps,
        PushError::HostNotAllowed => Refusal::HostNotAllowed,
        _ => Refusal::BadUrl,
    })
}

fn check_headers(headers: &[(&'static str, String)]) -> Result<(), Refusal> {
    let mut seen = [false; HEADERS.len()];
    for (name, value) in headers {
        let lower = name.to_ascii_lowercase();
        let i = HEADERS
            .iter()
            .position(|h| *h == lower)
            .ok_or(Refusal::HeaderNotAllowed)?;
        if seen[i] {
            return Err(Refusal::DuplicateHeader);
        }
        seen[i] = true;
        if !header_value_ok(HEADERS[i], value) {
            return Err(Refusal::BadHeaderValue);
        }
    }
    if seen.iter().all(|s| *s) {
        Ok(())
    } else {
        Err(Refusal::MissingHeader)
    }
}

/// The value each header has when [`crate::request::build`] wrote it.
fn header_value_ok(name: &str, value: &str) -> bool {
    // Visible ASCII and space: no control character, so a value cannot carry a
    // line break into the request.
    if value.is_empty() || value.bytes().any(|b| !(b' '..0x7f).contains(&b)) {
        return false;
    }
    match name {
        "authorization" => value.len() <= MAX_AUTHORIZATION_LEN && value.starts_with("vapid t="),
        "content-encoding" => value == "aes128gcm",
        "content-type" => value == "application/octet-stream",
        // Digits only: `u32::from_str` also takes a leading `+`.
        "ttl" => {
            value.bytes().all(|b| b.is_ascii_digit())
                && value
                    .parse::<u32>()
                    .is_ok_and(|ttl| (1..=MAX_TTL_SECS).contains(&ttl))
        }
        "urgency" => matches!(value, "normal" | "high"),
        _ => false,
    }
}

/// Run `exchange` (the request and the reading of its status line) against
/// `deadline`. The exchange is polled first, so an answer that is ready is
/// never lost to a deadline that is ready too. When the deadline passes first,
/// `abort` is called once (it cancels the in-flight request so it does not
/// hold a subrequest slot) and the result is [`TransportError::Timeout`].
///
/// The race itself is `weather_core::external_transport::with_deadline`, the
/// one the feed transport uses; this only maps its error type onto this
/// crate's.
pub async fn with_deadline<T>(
    exchange: impl Future<Output = Result<T, TransportError>>,
    deadline: impl Future<Output = ()>,
    abort: impl FnOnce(),
) -> Result<T, TransportError> {
    weather_core::external_transport::with_deadline(
        async {
            exchange.await.map_err(|e| match e {
                TransportError::Timeout => DeadlineError::Timeout,
                TransportError::Network => DeadlineError::Network,
                TransportError::Refused => DeadlineError::Refused,
            })
        },
        deadline,
        abort,
    )
    .await
    .map_err(|e| match e {
        DeadlineError::Timeout => TransportError::Timeout,
        DeadlineError::Refused => TransportError::Refused,
        // The race only ever returns what the exchange did or a timeout, and
        // the exchange above produces only these three.
        _ => TransportError::Network,
    })
}

/// A public point: uncompressed, 65 octets.
pub const POINT_LEN: usize = 65;
/// The ECDH result: the 32-octet x coordinate.
pub const SECRET_LEN: usize = 32;
/// An ES256 signature as a JWT carries it: `r || s`, 32 octets each.
pub const SIGNATURE_LEN: usize = 64;

/// The two outputs of the WebCrypto key agreement (the exported public key
/// and the derived bits), as an [`Agreement`]. The public key must be an
/// uncompressed point (65 octets starting 0x04) and the secret 32 octets: a
/// runtime that returns anything else has failed, and the message is not
/// built from it.
pub fn agreement_from_parts(
    as_public: &[u8],
    shared_secret: &[u8],
) -> Result<Agreement, EncryptError> {
    let as_public: [u8; POINT_LEN] = as_public.try_into().map_err(|_| EncryptError::Crypto)?;
    if as_public[0] != 0x04 {
        return Err(EncryptError::Crypto);
    }
    let shared_secret: [u8; SECRET_LEN] =
        shared_secret.try_into().map_err(|_| EncryptError::Crypto)?;
    Ok(Agreement {
        as_public,
        shared_secret,
    })
}

/// The 64 octets `r || s` a JWT carries, from what WebCrypto's `sign` returned
/// (the IEEE P1363 form). Any other length (a DER signature is 8 to 72) is a
/// signer that returned the wrong form: refused, never padded or cut.
pub fn signature_from_bytes(signature: &[u8]) -> Result<[u8; SIGNATURE_LEN], VapidError> {
    signature.try_into().map_err(|_| VapidError::Signing)
}

/// What a failed `importKey` of the browser's public key means, from the
/// rejection's JS error name. The Web Crypto specification makes a point that
/// is not on the curve a `DataError`: that is the SUBSCRIPTION's fault. Any
/// other rejection is the runtime's, and must not deactivate a subscription
/// ([`crate::request::BuildError::subscription_is_unusable`]).
pub fn import_error(js_error_name: Option<&str>) -> EncryptError {
    match js_error_name {
        Some("DataError") => EncryptError::BadSubscriptionKey,
        _ => EncryptError::Crypto,
    }
}

/// The message the key pair is checked with at import: signed with the private
/// key and verified with the public one, so a pair that does not belong
/// together is found when the signer is made, not by every push service
/// answering 403.
pub const KEY_PROBE: &[u8] = b"mukoko-weather-push key check";

/// Why a VAPID key could not be made into a signer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyError {
    /// The private key is not 32 octets of base64url.
    BadPrivateKey,
    /// The public key is not an uncompressed point (65 octets starting 0x04)
    /// of base64url.
    BadPublicKey,
    /// The runtime refused the key (not a valid P-256 scalar or point).
    Import,
    /// The public key is not the private key's.
    Mismatch,
    /// The runtime has no WebCrypto, or an operation failed in it.
    Runtime,
}

impl KeyError {
    /// A stable machine-readable code for logs.
    pub fn code(self) -> &'static str {
        match self {
            Self::BadPrivateKey => "vapid_private_key_invalid",
            Self::BadPublicKey => "vapid_public_key_invalid",
            Self::Import => "vapid_key_import_failed",
            Self::Mismatch => "vapid_key_mismatch",
            Self::Runtime => "crypto_unavailable",
        }
    }
}

/// A VAPID key pair as the runtime imports it: the private key as a JWK (RFC
/// 7517) for `importKey`, and the public key as the 65 octets the signer
/// reports.
///
/// It is made from values the CALLER supplies (base64url, as the VAPID tools
/// print them) and holds nothing else; the crate generates, reads and stores
/// no key. The JWK carries the private scalar, so it exists to be handed to
/// `importKey` and dropped, and `Debug` prints neither half.
pub struct VapidKeyMaterial {
    jwk: String,
    public: [u8; POINT_LEN],
}

impl std::fmt::Debug for VapidKeyMaterial {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("VapidKeyMaterial(<redacted>)")
    }
}

impl VapidKeyMaterial {
    /// `private_b64url` is the 32-octet private scalar and `public_b64url` the
    /// uncompressed public point, both base64url (padding tolerated, and
    /// surrounding whitespace, since a secret pasted into a store often keeps
    /// a trailing newline). Only the shapes are checked here; that the point
    /// is on the curve and belongs to the scalar is the runtime's check at
    /// import ([`KeyError::Import`], [`KeyError::Mismatch`]).
    pub fn parse(private_b64url: &str, public_b64url: &str) -> Result<Self, KeyError> {
        let private: [u8; 32] = B64URL
            .decode(private_b64url.trim())
            .ok()
            .and_then(|v| v.try_into().ok())
            .ok_or(KeyError::BadPrivateKey)?;
        let public: [u8; POINT_LEN] = B64URL
            .decode(public_b64url.trim())
            .ok()
            .and_then(|v| v.try_into().ok())
            .filter(|p: &[u8; POINT_LEN]| p[0] == 0x04)
            .ok_or(KeyError::BadPublicKey)?;
        let jwk = serde_json::json!({
            "kty": "EC",
            "crv": "P-256",
            "x": B64URL.encode(&public[1..33]),
            "y": B64URL.encode(&public[33..65]),
            "d": B64URL.encode(private),
        })
        .to_string();
        Ok(Self { jwk, public })
    }

    /// The private key as a JWK string, for `importKey("jwk", ...)`.
    pub fn jwk(&self) -> &str {
        &self.jwk
    }

    /// The public key, uncompressed.
    pub fn public(&self) -> &[u8; POINT_LEN] {
        &self.public
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encrypt::tests::{block_on, fixed, rfc};
    use crate::request::{build, Identity, Options, Subscription, Urgency};
    use crate::vapid::tests::Fake as FakeSigner;
    use std::cell::Cell;
    use std::task::{Context, Poll};
    use weather_core::push::{frost_payload, FrostAlert, Risk};

    const ENDPOINT: &str = "https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bExample";

    /// A request as `build` makes it, with the RFC 8291 browser keys and a fake
    /// signer: the realistic input of every check below.
    fn built() -> PushRequest {
        let signer = FakeSigner::new();
        let alert = FrostAlert {
            risk: Risk::Moderate,
            lowest: 1.0,
            start: "2026-07-10T22:00".into(),
            end: "2026-07-11T06:00".into(),
            night: "2026-07-10".into(),
        };
        block_on(build(
            &Subscription {
                endpoint: ENDPOINT,
                p256dh: &rfc().ua_public,
                auth: &rfc().auth,
            },
            &frost_payload("Harare", "harare", &alert),
            &Identity {
                signer: &signer,
                subject: "mailto:weather@mukoko.com",
                now_unix: 1_761_900_000,
            },
            &Options {
                ttl_secs: 3_600,
                urgency: Urgency::Normal,
            },
            &crate::encrypt::tests::Fake::rfc(),
            &fixed(&rfc().salt),
        ))
        .unwrap()
    }

    fn with_url(url: &str) -> PushRequest {
        PushRequest {
            url: url.to_string(),
            ..built()
        }
    }

    fn with_header(name: &'static str, value: &str) -> PushRequest {
        let mut r = built();
        r.headers.push((name, value.to_string()));
        r
    }

    fn set_header(name: &str, value: &str) -> PushRequest {
        let mut r = built();
        for h in &mut r.headers {
            if h.0 == name {
                h.1 = value.to_string();
            }
        }
        r
    }

    fn refusal(r: &PushRequest) -> Option<Refusal> {
        check_request(r).err()
    }

    // ---- check_request ----

    #[test]
    fn a_request_built_by_the_crate_passes_the_check() {
        assert_eq!(check_request(&built()), Ok(()));
        for urgency in [Urgency::Normal, Urgency::High] {
            let mut r = built();
            r.headers.retain(|h| h.0 != "Urgency");
            r.headers.push(("Urgency", urgency.as_str().to_string()));
            assert_eq!(check_request(&r), Ok(()), "{urgency:?}");
        }
    }

    #[test]
    fn only_https_to_a_push_service_is_allowed() {
        for url in [
            "https://fcm.googleapis.com/fcm/send/abc",
            "https://updates.push.services.mozilla.com/wpush/v2/abc",
            "https://web.push.apple.com/abc",
            "https://wns2-par02p.notify.windows.com/w/?token=abc",
            "https://fcm.googleapis.com:443/fcm/send/abc",
        ] {
            assert_eq!(refusal(&with_url(url)), None, "{url}");
        }
        for (url, why) in [
            ("http://fcm.googleapis.com/fcm/send/abc", Refusal::NotHttps),
            ("ftp://fcm.googleapis.com/x", Refusal::NotHttps),
            ("//fcm.googleapis.com/x", Refusal::NotHttps),
            ("fcm.googleapis.com/x", Refusal::NotHttps),
            ("HTTPS://fcm.googleapis.com/x", Refusal::NotHttps),
            ("", Refusal::NotHttps),
            ("https://example.com/x", Refusal::HostNotAllowed),
            (
                "https://fcm.googleapis.com.evil.example/x",
                Refusal::HostNotAllowed,
            ),
            (
                "https://evil.example/fcm.googleapis.com",
                Refusal::HostNotAllowed,
            ),
            ("https://sub.fcm.googleapis.com/x", Refusal::HostNotAllowed),
            ("https://169.254.169.254/latest", Refusal::HostNotAllowed),
            ("https://localhost/x", Refusal::HostNotAllowed),
            ("https://push.apple.com/x", Refusal::HostNotAllowed),
            ("https://.push.apple.com/x", Refusal::HostNotAllowed),
        ] {
            assert_eq!(refusal(&with_url(url)), Some(why), "{url}");
        }
    }

    #[test]
    fn credentials_a_port_and_odd_urls_are_refused() {
        for url in [
            "https://user@fcm.googleapis.com/x",
            "https://user:pw@fcm.googleapis.com/x",
            "https://evil.example@fcm.googleapis.com/x",
            "https://fcm.googleapis.com@evil.example/x",
            "https://fcm.googleapis.com:8443/x",
            "https://fcm.googleapis.com:@evil.example/x",
            // a browser reads the backslash as a slash, so the host differs
            "https://fcm.googleapis.com\\@evil.example/x",
            "https://evil.example\\@fcm.googleapis.com/x",
            "https://fcm.googleapis.com/x#frag",
            "https://fcm.googleapis.com/x y",
            "https://fcm.googleapis.com/x\n",
            "https://fcm.googleapis.com/x\t",
            "https://fcm.googleapis.com/x\u{7f}",
            "https://fcm.googleapis.com/stätions",
            "https://",
        ] {
            let got = refusal(&with_url(url));
            assert!(
                matches!(got, Some(Refusal::BadUrl | Refusal::HostNotAllowed)),
                "{url:?} -> {got:?}"
            );
        }
        let long = format!("https://fcm.googleapis.com/{}", "a".repeat(1100));
        assert_eq!(refusal(&with_url(&long)), Some(Refusal::BadUrl));
    }

    #[test]
    fn exactly_the_five_headers_and_no_other_can_be_sent() {
        for name in [
            "Cookie",
            "cookie",
            "Set-Cookie",
            "X-Api-Key",
            "Proxy-Authorization",
            "Host",
            "Content-Length",
            "User-Agent",
            "Accept",
            "Referer",
        ] {
            assert_eq!(
                refusal(&with_header(name, "x")),
                Some(Refusal::HeaderNotAllowed),
                "{name}"
            );
        }
    }

    #[test]
    fn a_header_may_not_be_sent_twice_or_left_out() {
        assert_eq!(
            refusal(&with_header("TTL", "60")),
            Some(Refusal::DuplicateHeader)
        );
        assert_eq!(
            refusal(&with_header("authorization", "vapid t=a.b.c, k=d")),
            Some(Refusal::DuplicateHeader),
            "header names are compared without case"
        );
        for name in [
            "Authorization",
            "Content-Encoding",
            "Content-Type",
            "TTL",
            "Urgency",
        ] {
            let mut r = built();
            r.headers.retain(|h| h.0 != name);
            assert_eq!(refusal(&r), Some(Refusal::MissingHeader), "{name}");
        }
    }

    #[test]
    fn header_values_are_what_build_writes() {
        for (name, value) in [
            ("Authorization", ""),
            ("Authorization", "Bearer abc"),
            ("Authorization", "vapid"),
            ("Content-Encoding", "gzip"),
            ("Content-Encoding", ""),
            ("Content-Type", "application/json"),
            ("TTL", ""),
            ("TTL", "0"),
            ("TTL", "-1"),
            ("TTL", "+60"),
            ("TTL", "6 0"),
            ("TTL", "1.5"),
            ("TTL", "86401"),
            ("TTL", "4294967296"),
            ("Urgency", "low"),
            ("Urgency", "very-low"),
            ("Urgency", "High"),
            ("Urgency", ""),
        ] {
            assert_eq!(
                refusal(&set_header(name, value)),
                Some(Refusal::BadHeaderValue),
                "{name}: {value:?}"
            );
        }
        for (name, value) in [("TTL", "1"), ("TTL", "86400"), ("Urgency", "high")] {
            assert_eq!(refusal(&set_header(name, value)), None, "{name}: {value}");
        }
    }

    #[test]
    fn a_header_value_cannot_carry_a_line_break_or_a_control_character() {
        for value in [
            "vapid t=a.b.c, k=d\r\nCookie: x",
            "vapid t=a.b.c, k=d\n",
            "vapid t=a.b.c, k=d\0",
            "vapid t=a.b.c, k=dé",
            "vapid t=a.b.c, k=d\u{7f}",
        ] {
            assert_eq!(
                refusal(&set_header("Authorization", value)),
                Some(Refusal::BadHeaderValue),
                "{value:?}"
            );
        }
        let long = format!("vapid t={}", "a".repeat(MAX_AUTHORIZATION_LEN));
        assert_eq!(
            refusal(&set_header("Authorization", &long)),
            Some(Refusal::BadHeaderValue)
        );
    }

    #[test]
    fn the_body_is_one_record() {
        for len in [0, 1, MIN_BODY_LEN - 1, MAX_BODY_LEN + 1, 100_000] {
            let mut r = built();
            r.body = vec![0u8; len];
            assert_eq!(refusal(&r), Some(Refusal::BadBody), "{len}");
        }
        for len in [MIN_BODY_LEN, 200, MAX_BODY_LEN] {
            let mut r = built();
            r.body = vec![0u8; len];
            assert_eq!(refusal(&r), None, "{len}");
        }
    }

    #[test]
    fn the_deadline_is_bounded() {
        for ms in [0, MAX_TIMEOUT_MS + 1, u32::MAX] {
            let mut r = built();
            r.timeout_ms = ms;
            assert_eq!(refusal(&r), Some(Refusal::BadTimeout), "{ms}");
        }
        for ms in [1, crate::request::SEND_TIMEOUT_MS, MAX_TIMEOUT_MS] {
            let mut r = built();
            r.timeout_ms = ms;
            assert_eq!(refusal(&r), None, "{ms}");
        }
    }

    #[test]
    fn refusal_codes_are_stable_and_say_nothing_about_the_request() {
        let all = [
            (Refusal::NotHttps, "not_https"),
            (Refusal::BadUrl, "bad_url"),
            (Refusal::HostNotAllowed, "host_not_allowed"),
            (Refusal::HeaderNotAllowed, "header_not_allowed"),
            (Refusal::DuplicateHeader, "duplicate_header"),
            (Refusal::MissingHeader, "missing_header"),
            (Refusal::BadHeaderValue, "bad_header_value"),
            (Refusal::BadBody, "bad_body"),
            (Refusal::BadTimeout, "bad_timeout"),
        ];
        for (refusal, code) in all {
            assert_eq!(refusal.code(), code);
            assert!(code.chars().all(|c| c.is_ascii_lowercase() || c == '_'));
        }
    }

    // ---- with_deadline ----

    /// A future that is pending for `n` polls, then ready.
    struct After(u32);

    impl Future for After {
        type Output = ();
        fn poll(mut self: std::pin::Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
            if self.0 == 0 {
                Poll::Ready(())
            } else {
                self.0 -= 1;
                cx.waker().wake_by_ref();
                Poll::Pending
            }
        }
    }

    async fn answers_after(n: u32, v: Result<u8, TransportError>) -> Result<u8, TransportError> {
        After(n).await;
        v
    }

    #[test]
    fn an_exchange_that_finishes_in_time_is_returned_and_nothing_is_aborted() {
        let aborted = Cell::new(0);
        let got = block_on(with_deadline(answers_after(2, Ok(7)), After(50), || {
            aborted.set(aborted.get() + 1)
        }));
        assert_eq!(got, Ok(7));
        assert_eq!(aborted.get(), 0);
    }

    #[test]
    fn an_exchange_that_outlasts_the_deadline_is_a_timeout_and_is_aborted_once() {
        let aborted = Cell::new(0);
        let got = block_on(with_deadline(answers_after(50, Ok(7)), After(2), || {
            aborted.set(aborted.get() + 1)
        }));
        assert_eq!(got, Err(TransportError::Timeout));
        assert_eq!(aborted.get(), 1);
    }

    #[test]
    fn an_answer_that_is_ready_with_the_deadline_wins() {
        let aborted = Cell::new(0);
        let got = block_on(with_deadline(answers_after(0, Ok(7)), After(0), || {
            aborted.set(aborted.get() + 1)
        }));
        assert_eq!(got, Ok(7));
        assert_eq!(aborted.get(), 0);
    }

    #[test]
    fn a_failure_before_the_deadline_keeps_its_own_classification() {
        for e in [
            TransportError::Network,
            TransportError::Refused,
            TransportError::Timeout,
        ] {
            let got = block_on(with_deadline(answers_after(1, Err(e)), After(50), || {}));
            assert_eq!(got, Err(e), "{e:?}");
        }
    }

    // ---- the shapes WebCrypto's bytes must have ----

    #[test]
    fn an_agreement_needs_an_uncompressed_point_and_a_32_octet_secret() {
        let public: [u8; POINT_LEN] = fixed(&rfc().as_public);
        let secret: [u8; SECRET_LEN] = fixed(&rfc().ecdh);
        let a = agreement_from_parts(&public, &secret).unwrap();
        assert_eq!(a.as_public, public);
        assert_eq!(a.shared_secret, secret);

        assert_eq!(
            agreement_from_parts(&public[..64], &secret).err(),
            Some(EncryptError::Crypto)
        );
        let mut long = public.to_vec();
        long.push(0);
        assert_eq!(
            agreement_from_parts(&long, &secret).err(),
            Some(EncryptError::Crypto)
        );
        let mut compressed_prefix = public;
        compressed_prefix[0] = 0x02;
        assert_eq!(
            agreement_from_parts(&compressed_prefix, &secret).err(),
            Some(EncryptError::Crypto)
        );
        assert_eq!(
            agreement_from_parts(&public, &secret[..31]).err(),
            Some(EncryptError::Crypto)
        );
        assert_eq!(
            agreement_from_parts(&public, &[]).err(),
            Some(EncryptError::Crypto)
        );
    }

    #[test]
    fn a_signature_is_exactly_64_octets_of_r_and_s() {
        let sig: Vec<u8> = (0..64u8).collect();
        assert_eq!(signature_from_bytes(&sig).unwrap().as_slice(), &sig[..]);
        for len in [0, 1, 63, 65, 70, 72] {
            assert_eq!(
                signature_from_bytes(&vec![0x30; len]),
                Err(VapidError::Signing),
                "a {len}-octet signature (DER is not what a JWT carries)"
            );
        }
    }

    #[test]
    fn only_a_data_error_is_the_subscriptions_fault() {
        assert_eq!(
            import_error(Some("DataError")),
            EncryptError::BadSubscriptionKey
        );
        for other in [
            None,
            Some(""),
            Some("OperationError"),
            Some("NotSupportedError"),
            Some("TypeError"),
            Some("InvalidAccessError"),
            Some("dataerror"),
        ] {
            assert_eq!(import_error(other), EncryptError::Crypto, "{other:?}");
        }
        // a runtime fault must never read as an unusable subscription
        assert!(
            !crate::request::BuildError::Encrypt(import_error(Some("OperationError")))
                .subscription_is_unusable()
        );
        assert!(
            crate::request::BuildError::Encrypt(import_error(Some("DataError")))
                .subscription_is_unusable()
        );
    }

    // ---- the VAPID key as a JWK ----
    //
    // The values are the RFC 8291 worked example's (published test data, read
    // from the fixture like the rest of the crate's tests): the application
    // server's public key, and the 32 octets of the ECDH result standing in
    // for a private scalar. Only shapes are checked here; that a scalar and a
    // point belong together is the runtime's check at import.

    fn private() -> String {
        rfc().ecdh.clone()
    }

    fn public() -> String {
        rfc().as_public.clone()
    }

    #[test]
    fn a_key_pair_becomes_a_p256_jwk_with_the_public_point_split_in_two() {
        let key = VapidKeyMaterial::parse(&private(), &public()).unwrap();
        let jwk: serde_json::Value = serde_json::from_str(key.jwk()).unwrap();
        let p: [u8; POINT_LEN] = fixed(&public());
        assert_eq!(jwk["kty"], "EC");
        assert_eq!(jwk["crv"], "P-256");
        assert_eq!(jwk["x"], B64URL.encode(&p[1..33]));
        assert_eq!(jwk["y"], B64URL.encode(&p[33..65]));
        assert_eq!(jwk["d"], private());
        assert_eq!(jwk.as_object().unwrap().len(), 5, "no other member");
        assert_eq!(key.public(), &p);
        // 43 characters: 32 octets, no padding, as a JWK requires
        for member in ["x", "y", "d"] {
            assert_eq!(jwk[member].as_str().unwrap().len(), 43, "{member}");
        }
    }

    #[test]
    fn padding_and_surrounding_whitespace_in_a_pasted_key_are_tolerated() {
        let plain = VapidKeyMaterial::parse(&private(), &public()).unwrap();
        for (d, p) in [
            (format!("{}\n", private()), public()),
            (format!("  {}  ", private()), format!("{}\r\n", public())),
            (format!("{}=", private()), format!("{}=", public())),
        ] {
            let key = VapidKeyMaterial::parse(&d, &p).unwrap();
            assert_eq!(key.jwk(), plain.jwk(), "{d:?} {p:?}");
            assert_eq!(key.public(), plain.public());
        }
    }

    #[test]
    fn a_private_key_is_32_octets() {
        for bad in [
            "",
            "!!!",
            &private()[..42],
            &format!("{}A", private()),
            // the public key is not a private key
            &public(),
            "not base64url at all, with spaces",
        ] {
            assert_eq!(
                VapidKeyMaterial::parse(bad, &public()).err(),
                Some(KeyError::BadPrivateKey),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn a_public_key_is_an_uncompressed_point() {
        let p: [u8; POINT_LEN] = fixed(&public());
        let mut compressed = p;
        compressed[0] = 0x02;
        let mut wrong_prefix = p;
        wrong_prefix[0] = 0x05;
        for bad in [
            String::new(),
            "!!!".to_string(),
            public()[..80].to_string(),
            format!("{}AAAA", public()),
            B64URL.encode(&p[..33]),
            B64URL.encode(compressed),
            B64URL.encode(wrong_prefix),
            // the private key is not a public key
            private(),
        ] {
            assert_eq!(
                VapidKeyMaterial::parse(&private(), &bad).err(),
                Some(KeyError::BadPublicKey),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn the_private_key_is_checked_before_the_public_one() {
        assert_eq!(
            VapidKeyMaterial::parse("", "").err(),
            Some(KeyError::BadPrivateKey)
        );
    }

    #[test]
    fn debug_of_key_material_and_of_key_errors_prints_no_key() {
        let key = VapidKeyMaterial::parse(&private(), &public()).unwrap();
        let shown = format!("{key:?}");
        assert_eq!(shown, "VapidKeyMaterial(<redacted>)");
        let p: [u8; POINT_LEN] = fixed(&public());
        for secret in [
            private(),
            public(),
            B64URL.encode(&p[1..33]),
            B64URL.encode(&p[33..65]),
        ] {
            assert!(!shown.contains(&secret), "{secret}");
        }
        for e in [
            KeyError::BadPrivateKey,
            KeyError::BadPublicKey,
            KeyError::Import,
            KeyError::Mismatch,
            KeyError::Runtime,
        ] {
            let shown = format!("{e:?} {}", e.code());
            assert!(!shown.contains(&private()) && !shown.contains(&public()));
        }
    }

    #[test]
    fn key_error_codes_are_stable() {
        assert_eq!(KeyError::BadPrivateKey.code(), "vapid_private_key_invalid");
        assert_eq!(KeyError::BadPublicKey.code(), "vapid_public_key_invalid");
        assert_eq!(KeyError::Import.code(), "vapid_key_import_failed");
        assert_eq!(KeyError::Mismatch.code(), "vapid_key_mismatch");
        assert_eq!(KeyError::Runtime.code(), "crypto_unavailable");
    }

    #[test]
    fn the_key_probe_is_not_a_vapid_signing_input() {
        // A signature made over the probe must never be usable as a token:
        // a JWT signing input is `header.claims`, which has a dot and starts
        // with a base64url JSON object.
        assert!(!KEY_PROBE.contains(&b'.'));
        assert!(!KEY_PROBE.starts_with(b"eyJ"));
    }
}
