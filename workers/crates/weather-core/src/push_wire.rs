//! The wire between the alert tick (`mukoko-weather-jobs`) and the sender
//! (`mukoko-weather-push`, `POST /send`; mukoko-dev/mukoko-weather#289, #579).
//!
//! Pure: it writes the one body the tick posts and reads the one answer back,
//! and reads the body on the sender's side with every bound a request from
//! another Worker still gets (the sender trusts nothing it is handed, even over
//! a service binding). No I/O, no clock, no key.
//!
//! **What crosses.** One subscription (the endpoint and the two keys: secrets,
//! because whoever holds all three can push to that browser), the decided
//! [`Payload`] and its [`PushOptions`]. **What comes back.** Only a classified
//! [`Outcome`], the push service's HTTP status when it answered, its
//! `Retry-After` seconds, and a stable `reason` code when the request never got
//! to a push service. Never the endpoint, a key, a header or a body, in either
//! direction of the answer.
//!
//! [`SendRequest`] has no `Debug` that prints an endpoint or a key, and no
//! error here carries a value that was refused.

use std::fmt;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::push::{self, Outcome, Payload, PushOptions, Urgency, KIND_FROST};

/// The biggest body `/send` reads. A frost alert with its subscription is
/// about 1 KiB; the bound only stops a caller from making the Worker buffer
/// something else.
pub const MAX_SEND_BODY_BYTES: usize = 8 * 1024;
/// The longest `TTL` the sender will set, in seconds: a day, the bound of
/// `weather_webpush::request::MAX_TTL_SECS` (a test there holds the two
/// together). A frost alert can ask for more (`push::MAX_PUSH_TTL_SECONDS` is
/// 36 hours), so the sender asks for a shorter life, never refuses the alert.
pub const MAX_SEND_TTL_SECONDS: u32 = 24 * 60 * 60;
const MAX_TITLE_CHARS: usize = 120;
const MAX_BODY_CHARS: usize = 400;

/// Why a body to `/send` was not accepted. Stable codes; none says what the
/// value was.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireError {
    /// Not JSON of the shape documented here, or an unknown field.
    Malformed,
    /// More than [`MAX_SEND_BODY_BYTES`].
    TooLarge,
    /// A kind or version this sender does not send.
    UnsupportedPayload,
    /// A payload field outside its bounds.
    BadPayload,
    /// `ttl_seconds` is 0.
    BadTtl,
    /// An urgency other than `normal` or `high`.
    BadUrgency,
    /// An endpoint or key that fails `push::validate_endpoint` or
    /// `push::validate_keys`.
    BadSubscription,
}

impl WireError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Malformed => "malformed_body",
            Self::TooLarge => "body_too_large",
            Self::UnsupportedPayload => "unsupported_payload",
            Self::BadPayload => "bad_payload",
            Self::BadTtl => "bad_ttl",
            Self::BadUrgency => "bad_urgency",
            Self::BadSubscription => "bad_subscription",
        }
    }
}

/// A send request, read and checked.
#[derive(Clone, PartialEq)]
pub struct SendRequest {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    pub payload: Payload,
    /// Already cut to [`MAX_SEND_TTL_SECONDS`].
    pub ttl_seconds: u32,
    pub urgency: Urgency,
}

impl fmt::Debug for SendRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SendRequest")
            .field("subscription", &push::endpoint_id(&self.endpoint))
            .field("kind", &self.payload.kind)
            .finish_non_exhaustive()
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireSubscription {
    endpoint: String,
    p256dh: String,
    auth: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WirePayload {
    v: u8,
    kind: String,
    slug: String,
    night: String,
    title: String,
    body: String,
    url: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireOptions {
    ttl_seconds: u32,
    urgency: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireSend {
    subscription: WireSubscription,
    payload: WirePayload,
    options: WireOptions,
}

/// The body the tick posts for one send.
pub fn encode_send(
    endpoint: &str,
    p256dh: &str,
    auth: &str,
    payload: &Payload,
    options: &PushOptions,
) -> Value {
    json!({
        "subscription": {"endpoint": endpoint, "p256dh": p256dh, "auth": auth},
        "payload": {
            "v": payload.v,
            "kind": payload.kind,
            "slug": payload.slug,
            "night": payload.night,
            "title": payload.title,
            "body": payload.body,
            "url": payload.url,
        },
        "options": {
            "ttl_seconds": options.ttl_seconds,
            "urgency": options.urgency.as_str(),
        },
    })
}

fn plain_text(s: &str, max_chars: usize) -> bool {
    !s.is_empty() && s.chars().count() <= max_chars && !s.chars().any(char::is_control)
}

fn is_night(s: &str) -> bool {
    s.len() == 10
        && s.bytes().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                b == b'-'
            } else {
                b.is_ascii_digit()
            }
        })
}

/// Read and check a body to `/send`. Everything the tick could get wrong, and
/// everything a caller that is not the tick could try, is refused here, before
/// a key is imported or a byte is encrypted.
pub fn parse_send(body: &[u8]) -> Result<SendRequest, WireError> {
    if body.len() > MAX_SEND_BODY_BYTES {
        return Err(WireError::TooLarge);
    }
    let wire: WireSend = serde_json::from_slice(body).map_err(|_| WireError::Malformed)?;

    push::validate_endpoint(&wire.subscription.endpoint).map_err(|_| WireError::BadSubscription)?;
    push::validate_keys(&wire.subscription.p256dh, &wire.subscription.auth)
        .map_err(|_| WireError::BadSubscription)?;

    let p = wire.payload;
    // Frost is the only kind with a sender. A severe-weather kind arrives with
    // its own evaluator, and then adds its arm here, in the open.
    if p.v != 1 || p.kind != KIND_FROST {
        return Err(WireError::UnsupportedPayload);
    }
    if push::validate_slug(&p.slug).is_err()
        || !is_night(&p.night)
        || !plain_text(&p.title, MAX_TITLE_CHARS)
        || !plain_text(&p.body, MAX_BODY_CHARS)
        // The page the push opens is the place's own, nothing else: no other
        // path, host or scheme can be put in front of a person by a push.
        || p.url != format!("/{}", p.slug)
    {
        return Err(WireError::BadPayload);
    }

    if wire.options.ttl_seconds == 0 {
        return Err(WireError::BadTtl);
    }
    let urgency = match wire.options.urgency.as_str() {
        "normal" => Urgency::Normal,
        "high" => Urgency::High,
        _ => return Err(WireError::BadUrgency),
    };

    Ok(SendRequest {
        endpoint: wire.subscription.endpoint,
        p256dh: wire.subscription.p256dh,
        auth: wire.subscription.auth,
        payload: Payload {
            v: 1,
            kind: KIND_FROST,
            slug: p.slug,
            night: p.night,
            title: p.title,
            body: p.body,
            url: p.url,
        },
        ttl_seconds: wire.options.ttl_seconds.min(MAX_SEND_TTL_SECONDS),
        urgency,
    })
}

/// What the sender answers (HTTP 200) for a request it processed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SendAnswer {
    pub outcome: Outcome,
    /// The push service's HTTP status, when it answered.
    pub provider_code: Option<u16>,
    pub retry_after_secs: Option<u32>,
    /// A stable code when the request never reached a push service (a
    /// subscription that cannot be encrypted to, say). `None` otherwise.
    pub reason: Option<&'static str>,
}

fn outcome_word(o: Outcome) -> &'static str {
    match o {
        Outcome::Accepted => "accepted",
        Outcome::Expired => "expired",
        Outcome::Retry => "retry",
        Outcome::Failed => "failed",
    }
}

pub fn encode_answer(a: &SendAnswer) -> Value {
    let mut out = json!({"outcome": outcome_word(a.outcome)});
    if let Some(map) = out.as_object_mut() {
        if let Some(c) = a.provider_code {
            map.insert("provider_code".into(), json!(c));
        }
        if let Some(r) = a.retry_after_secs {
            map.insert("retry_after_secs".into(), json!(r));
        }
        if let Some(r) = a.reason {
            map.insert("reason".into(), json!(r));
        }
    }
    out
}

/// Read the sender's answer. Fails to the cautious side: anything that is not
/// the documented shape is [`Outcome::Retry`] with no code (an unknown result
/// is tried again on a later tick; it is never read as a push that was sent,
/// and never as a subscription that is gone). A provider code outside 100-599
/// is dropped, and an outcome the code contradicts is believed over the word:
/// the code is what the push service said.
pub fn parse_answer(body: &Value) -> SendAnswer {
    let unknown = SendAnswer {
        outcome: Outcome::Retry,
        provider_code: None,
        retry_after_secs: None,
        reason: None,
    };
    let code = body
        .get("provider_code")
        .and_then(Value::as_u64)
        .and_then(|c| u16::try_from(c).ok())
        .filter(|c| (100..=599).contains(c));
    let outcome = match (body.get("outcome").and_then(Value::as_str), code) {
        // The push service's own status is the authority on what it said.
        (_, Some(c)) => push::classify_status(c),
        (Some("retry"), None) => Outcome::Retry,
        // No status to stand on: only a refusal we made ourselves (`failed`)
        // is believed. `accepted` and `expired` both need a code; without one
        // they are not what the sender documents.
        (Some("failed"), None) => Outcome::Failed,
        _ => return unknown,
    };
    SendAnswer {
        outcome,
        provider_code: code,
        retry_after_secs: body
            .get("retry_after_secs")
            .and_then(Value::as_u64)
            .and_then(|r| u32::try_from(r).ok()),
        // The reason is the sender's own log field. It is not carried back:
        // nothing the tick decides depends on it.
        reason: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::push::{frost_payload, FrostAlert, Risk};

    // A real-shaped subscription: an uncompressed P-256 point (the RFC 8291
    // example's `ua_public`) and a 16-byte secret.
    const ENDPOINT: &str = "https://fcm.googleapis.com/fcm/send/abc";
    const P256DH: &str =
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const AUTH: &str = "BTBZMqHH6r4Tts7J_aSIgg";

    fn payload() -> Payload {
        frost_payload(
            "Harare",
            "harare",
            &FrostAlert {
                risk: Risk::High,
                lowest: 1.4,
                start: "2026-11-15T01:00".into(),
                end: "2026-11-15T06:00".into(),
                night: "2026-11-14".into(),
            },
        )
    }

    fn options(ttl: u32) -> PushOptions {
        PushOptions {
            ttl_seconds: ttl,
            urgency: Urgency::Normal,
            topic: "frost-2026-11-14".into(),
        }
    }

    fn body(ttl: u32) -> Vec<u8> {
        encode_send(ENDPOINT, P256DH, AUTH, &payload(), &options(ttl))
            .to_string()
            .into_bytes()
    }

    #[test]
    fn what_the_tick_writes_the_sender_reads_back() {
        let got = parse_send(&body(3600)).expect("reads");
        assert_eq!(got.endpoint, ENDPOINT);
        assert_eq!((got.p256dh.as_str(), got.auth.as_str()), (P256DH, AUTH));
        assert_eq!(got.payload, payload());
        assert_eq!(got.ttl_seconds, 3600);
        assert_eq!(got.urgency, Urgency::Normal);
    }

    #[test]
    fn high_urgency_survives_the_trip() {
        let mut o = options(60);
        o.urgency = Urgency::High;
        let b = encode_send(ENDPOINT, P256DH, AUTH, &payload(), &o).to_string();
        assert_eq!(
            parse_send(b.as_bytes()).expect("reads").urgency,
            Urgency::High
        );
    }

    #[test]
    fn a_ttl_above_a_day_is_shortened_not_refused() {
        let got = parse_send(&body(36 * 3600)).expect("reads");
        assert_eq!(got.ttl_seconds, MAX_SEND_TTL_SECONDS);
        assert_eq!(parse_send(&body(0)), Err(WireError::BadTtl));
    }

    #[test]
    fn the_bound_on_the_body_is_checked_first() {
        let big = vec![b' '; MAX_SEND_BODY_BYTES + 1];
        assert_eq!(parse_send(&big), Err(WireError::TooLarge));
        assert_eq!(parse_send(b""), Err(WireError::Malformed));
        assert_eq!(parse_send(b"[]"), Err(WireError::Malformed));
    }

    fn edit(f: impl FnOnce(&mut Value)) -> Vec<u8> {
        let mut v = encode_send(ENDPOINT, P256DH, AUTH, &payload(), &options(60));
        f(&mut v);
        v.to_string().into_bytes()
    }

    #[test]
    fn an_unknown_field_anywhere_is_refused() {
        for path in ["", "/subscription", "/payload", "/options"] {
            let b = edit(|v| {
                let target = if path.is_empty() {
                    v
                } else {
                    v.pointer_mut(path).expect("object")
                };
                target["extra"] = json!(1);
            });
            assert_eq!(parse_send(&b), Err(WireError::Malformed), "{path}");
        }
    }

    #[test]
    fn a_subscription_that_is_not_a_push_service_is_refused_before_anything() {
        for endpoint in [
            "http://fcm.googleapis.com/x",
            "https://evil.example/x",
            "https://169.254.169.254/latest",
            "https://fcm.googleapis.com:8443/x",
            "https://user@fcm.googleapis.com/x",
        ] {
            let b = edit(|v| v["subscription"]["endpoint"] = json!(endpoint));
            assert_eq!(
                parse_send(&b),
                Err(WireError::BadSubscription),
                "{endpoint}"
            );
        }
        let b = edit(|v| v["subscription"]["p256dh"] = json!("short"));
        assert_eq!(parse_send(&b), Err(WireError::BadSubscription));
        let b = edit(|v| v["subscription"]["auth"] = json!("short"));
        assert_eq!(parse_send(&b), Err(WireError::BadSubscription));
    }

    #[test]
    fn only_the_frost_payload_of_version_one_is_sent() {
        let b = edit(|v| v["payload"]["kind"] = json!("severe"));
        assert_eq!(parse_send(&b), Err(WireError::UnsupportedPayload));
        let b = edit(|v| v["payload"]["v"] = json!(2));
        assert_eq!(parse_send(&b), Err(WireError::UnsupportedPayload));
    }

    #[test]
    fn a_payload_outside_its_bounds_is_refused() {
        let cases: [(&str, Value); 8] = [
            ("/payload/slug", json!("Harare")),
            ("/payload/slug", json!("")),
            ("/payload/night", json!("2026-11-1")),
            ("/payload/night", json!("tonight!!!")),
            ("/payload/title", json!("")),
            ("/payload/title", json!("x".repeat(MAX_TITLE_CHARS + 1))),
            ("/payload/body", json!("line\nbreak")),
            ("/payload/body", json!("x".repeat(MAX_BODY_CHARS + 1))),
        ];
        for (path, value) in cases {
            let b = edit(|v| *v.pointer_mut(path).expect("field") = value.clone());
            assert_eq!(parse_send(&b), Err(WireError::BadPayload), "{path} {value}");
        }
    }

    #[test]
    fn a_push_can_only_open_the_place_it_is_about() {
        for url in [
            "https://evil.example/harare",
            "//evil.example",
            "/bulawayo",
            "/harare/../admin",
            "javascript:alert(1)",
            "harare",
        ] {
            let b = edit(|v| v["payload"]["url"] = json!(url));
            assert_eq!(parse_send(&b), Err(WireError::BadPayload), "{url}");
        }
    }

    #[test]
    fn only_normal_and_high_are_urgencies_the_sender_sets() {
        for u in ["low", "very-low", "HIGH", "", "urgent"] {
            let b = edit(|v| v["options"]["urgency"] = json!(u));
            assert_eq!(parse_send(&b), Err(WireError::BadUrgency), "{u}");
        }
    }

    #[test]
    fn nothing_that_prints_carries_an_endpoint_or_a_key() {
        let got = parse_send(&body(60)).expect("reads");
        let printed = format!("{got:?}");
        for secret in ["fcm.googleapis", "fcm/send/abc", P256DH, AUTH] {
            assert!(!printed.contains(secret), "{printed}");
        }
        for e in [
            WireError::Malformed,
            WireError::BadSubscription,
            WireError::BadPayload,
        ] {
            assert!(!e.code().contains("fcm"));
        }
    }

    #[test]
    fn error_codes_are_stable() {
        let want = [
            (WireError::Malformed, "malformed_body"),
            (WireError::TooLarge, "body_too_large"),
            (WireError::UnsupportedPayload, "unsupported_payload"),
            (WireError::BadPayload, "bad_payload"),
            (WireError::BadTtl, "bad_ttl"),
            (WireError::BadUrgency, "bad_urgency"),
            (WireError::BadSubscription, "bad_subscription"),
        ];
        for (e, code) in want {
            assert_eq!(e.code(), code);
        }
    }

    fn answer(outcome: Outcome, code: Option<u16>) -> SendAnswer {
        SendAnswer {
            outcome,
            provider_code: code,
            retry_after_secs: None,
            reason: None,
        }
    }

    #[test]
    fn an_answer_round_trips_and_says_nothing_but_the_outcome_and_a_status() {
        for (outcome, code) in [
            (Outcome::Accepted, Some(201)),
            (Outcome::Expired, Some(410)),
            (Outcome::Expired, Some(403)),
            (Outcome::Retry, Some(503)),
            (Outcome::Retry, None),
            (Outcome::Failed, Some(400)),
            (Outcome::Failed, None),
        ] {
            let a = answer(outcome, code);
            let wire = encode_answer(&a);
            assert_eq!(parse_answer(&wire), a, "{wire}");
        }
        let mut keys: Vec<_> = encode_answer(&SendAnswer {
            outcome: Outcome::Retry,
            provider_code: Some(429),
            retry_after_secs: Some(30),
            reason: Some("push_timeout"),
        })
        .as_object()
        .expect("object")
        .keys()
        .cloned()
        .collect();
        keys.sort();
        assert_eq!(
            keys,
            ["outcome", "provider_code", "reason", "retry_after_secs"]
        );
    }

    #[test]
    fn the_status_is_believed_over_the_word() {
        // A sender that said "accepted" over a 410 is read as gone, and one
        // that said "expired" over a 201 is read as sent: the status is what
        // the push service said.
        let w = json!({"outcome": "accepted", "provider_code": 410});
        assert_eq!(parse_answer(&w).outcome, Outcome::Expired);
        let w = json!({"outcome": "expired", "provider_code": 201});
        assert_eq!(parse_answer(&w).outcome, Outcome::Accepted);
    }

    #[test]
    fn an_answer_that_cannot_be_read_is_retried_never_sent_and_never_gone() {
        for w in [
            json!({}),
            json!(null),
            json!("accepted"),
            json!({"outcome": "accepted"}),
            json!({"outcome": "expired"}),
            json!({"outcome": "sent", "provider_code": "201"}),
            json!({"outcome": "accepted", "provider_code": 99}),
            json!({"outcome": "accepted", "provider_code": 70000}),
        ] {
            let a = parse_answer(&w);
            assert_eq!(a.outcome, Outcome::Retry, "{w}");
            assert_eq!(a.provider_code, None, "{w}");
        }
    }

    #[test]
    fn a_failure_of_ours_with_no_status_is_final_and_a_retry_is_a_retry() {
        let a = parse_answer(&json!({"outcome": "failed", "reason": "bad_subscription_key"}));
        assert_eq!((a.outcome, a.provider_code), (Outcome::Failed, None));
        let a = parse_answer(&json!({"outcome": "retry", "reason": "push_timeout"}));
        assert_eq!((a.outcome, a.provider_code), (Outcome::Retry, None));
    }

    #[test]
    fn the_ttl_bound_is_a_day() {
        assert_eq!(MAX_SEND_TTL_SECONDS, 86_400);
        const { assert!(MAX_SEND_TTL_SECONDS <= push::MAX_PUSH_TTL_SECONDS) };
    }
}
