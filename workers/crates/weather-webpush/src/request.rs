//! Assembling and sending one push message: RFC 8030 over the encryption of
//! [`crate::encrypt`] and the identity of [`crate::vapid`].
//!
//! [`build`] turns a decided alert and one subscription into a [`PushRequest`]
//! without touching the network. [`send`] hands it to the caller's
//! [`Transport`] and classifies the answer with `weather_core::push`, whose
//! rules (an expired subscription is deactivated, a 429 or 5xx is retried on a
//! later tick, any other 4xx is not) are the single source for what each push
//! service status means.
//!
//! The endpoint in a [`PushRequest`] is a bearer capability: whoever holds it
//! (with the keys) can push to that browser. So a request prints no URL, no
//! header value and no body in `Debug`, and the only identifier this crate
//! ever hands back for logs is `weather_core::push::endpoint_id`.

use weather_core::push::{self, Outcome, Payload, PushError};

use crate::encrypt::{self, EncryptError, KeyAgreement, Recipient};
use crate::vapid::{self, Es256Signer, VapidError};

/// How long a push service may hold a message for an offline browser, at most.
/// An alert says "tonight", so a day is already generous; the caller passes a
/// shorter TTL for a message that is stale sooner.
pub const MAX_TTL_SECS: u32 = 24 * 60 * 60;
/// The whole send, for the transport to enforce.
pub const SEND_TIMEOUT_MS: u32 = 8_000;

/// RFC 8030 section 5.3: how urgently the push service should wake the
/// device. Severe frost, a safety matter for crops, is `High`; the rest is
/// `Normal`. The lowest two are for background sync and never used for an
/// alert, so they are not offered. The caller chooses it, together with the
/// TTL, from the alert it has decided to send.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Urgency {
    Normal,
    High,
}

impl Urgency {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::High => "high",
        }
    }
}

/// One browser's subscription, as the Nyuchi API's internal alert-targets
/// route returns it to the sender.
#[derive(Clone, Copy)]
pub struct Subscription<'a> {
    pub endpoint: &'a str,
    pub p256dh: &'a str,
    pub auth: &'a str,
}

impl std::fmt::Debug for Subscription<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Subscription(id={})", push::endpoint_id(self.endpoint))
    }
}

/// Who is sending, and when. The sender's Worker supplies all three.
pub struct Identity<'a, S> {
    /// Signs the VAPID token; owns the private key.
    pub signer: &'a S,
    /// The contact URI of the operator (`mailto:` or `https:`).
    pub subject: &'a str,
    /// Seconds since the Unix epoch.
    pub now_unix: u64,
}

/// Per-message delivery options.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Options {
    /// `TTL` header, seconds, 1 to [`MAX_TTL_SECS`]. RFC 8030 section 5.2
    /// makes it mandatory.
    pub ttl_secs: u32,
    pub urgency: Urgency,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuildError {
    /// The endpoint is not https on a known push service. Nothing is signed
    /// or sent for it.
    Endpoint(PushError),
    Encrypt(EncryptError),
    Vapid(VapidError),
    /// `ttl_secs` is 0 or above [`MAX_TTL_SECS`].
    Ttl,
    /// The payload did not serialise.
    Payload,
}

impl BuildError {
    /// A stable machine-readable code for logs.
    pub fn code(self) -> &'static str {
        match self {
            Self::Endpoint(e) => e.code(),
            Self::Encrypt(e) => e.code(),
            Self::Vapid(e) => e.code(),
            Self::Ttl => "bad_ttl",
            Self::Payload => "bad_payload",
        }
    }

    /// True when the SUBSCRIPTION is unusable and will be again (an endpoint
    /// we will not send to, or keys that are not a browser's): the caller
    /// deactivates it instead of retrying. The rest is our configuration, our
    /// input or our runtime, which a retry does not fix and a deactivation
    /// would wrongly punish the person for.
    pub fn subscription_is_unusable(self) -> bool {
        matches!(
            self,
            Self::Endpoint(
                PushError::NotHttps | PushError::HostNotAllowed | PushError::BadEndpoint
            ) | Self::Encrypt(EncryptError::BadSubscriptionKey | EncryptError::BadAuthSecret)
        )
    }
}

/// One HTTP POST, ready for a transport.
#[derive(Clone, PartialEq, Eq)]
pub struct PushRequest {
    pub url: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
    pub timeout_ms: u32,
}

impl std::fmt::Debug for PushRequest {
    /// No URL (a capability), no header values (a signed token), no body.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PushRequest")
            .field("endpoint_id", &push::endpoint_id(&self.url))
            .field(
                "headers",
                &self.headers.iter().map(|(k, _)| *k).collect::<Vec<_>>(),
            )
            .field("body_len", &self.body.len())
            .finish()
    }
}

/// Build the request for one subscription. `keys` makes the elliptic-curve
/// key agreement and `identity.signer` signs the token (both the runtime's);
/// `salt` is 16 fresh random bytes for this message, never reused. Nothing
/// touches the network, and an endpoint outside the allow list is refused
/// before either the key agreement or the signer is called.
pub async fn build<K: KeyAgreement, S: Es256Signer>(
    sub: &Subscription<'_>,
    payload: &Payload,
    identity: &Identity<'_, S>,
    options: &Options,
    keys: &K,
    salt: &[u8; 16],
) -> Result<PushRequest, BuildError> {
    if options.ttl_secs == 0 || options.ttl_secs > MAX_TTL_SECS {
        return Err(BuildError::Ttl);
    }
    // First: a host outside the allow list never gets a token or a byte.
    let audience = push::endpoint_origin(sub.endpoint).map_err(BuildError::Endpoint)?;
    let to = Recipient::parse(sub.p256dh, sub.auth).map_err(BuildError::Encrypt)?;
    let plaintext = serde_json::to_vec(payload).map_err(|_| BuildError::Payload)?;
    let body = encrypt::encrypt(keys, &plaintext, &to, salt)
        .await
        .map_err(BuildError::Encrypt)?;
    let authorization = vapid::authorization(
        identity.signer,
        &audience,
        identity.subject,
        identity.now_unix,
    )
    .await
    .map_err(BuildError::Vapid)?;
    Ok(PushRequest {
        url: sub.endpoint.to_string(),
        headers: vec![
            ("Authorization", authorization),
            ("Content-Encoding", "aes128gcm".to_string()),
            ("Content-Type", "application/octet-stream".to_string()),
            ("TTL", options.ttl_secs.to_string()),
            ("Urgency", options.urgency.as_str().to_string()),
        ],
        body,
        timeout_ms: SEND_TIMEOUT_MS,
    })
}

/// Why no answer came back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportError {
    Timeout,
    Network,
}

/// What a runtime supplies: one POST, under the limits of its
/// [`PushRequest`]. In a Worker this wraps `fetch`, whose future is not
/// `Send`, which is why the trait is not either. An implementation must not
/// follow redirects (a push endpoint that redirects is not one we chose) and
/// returns the status only.
#[allow(async_fn_in_trait)]
pub trait Transport {
    async fn post(&self, req: &PushRequest) -> Result<u16, TransportError>;
}

/// What came of one send.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Delivery {
    pub outcome: Outcome,
    /// The push service's HTTP status when it answered
    /// (`platform.alertDeliveries.providerCode`); `None` for a timeout or a
    /// network error.
    pub provider_code: Option<u16>,
}

/// Send a built request. A transport failure is a retry on a later tick, the
/// same as a 5xx.
pub async fn deliver<T: Transport>(transport: &T, req: &PushRequest) -> Delivery {
    match transport.post(req).await {
        Ok(status) => Delivery {
            outcome: push::classify_status(status),
            provider_code: Some(status),
        },
        Err(TransportError::Timeout | TransportError::Network) => Delivery {
            outcome: Outcome::Retry,
            provider_code: None,
        },
    }
}

/// Build and send one alert to one subscription.
pub async fn send<T: Transport, K: KeyAgreement, S: Es256Signer>(
    transport: &T,
    sub: &Subscription<'_>,
    payload: &Payload,
    identity: &Identity<'_, S>,
    options: &Options,
    keys: &K,
    salt: &[u8; 16],
) -> Result<Delivery, BuildError> {
    let req = build(sub, payload, identity, options, keys, salt).await?;
    Ok(deliver(transport, &req).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encrypt::tests::{
        block_on, fixed, Fake as FakeKeys, AS_PUBLIC, AUTH_SECRET, ECDH_SECRET, SALT, UA_PUBLIC,
    };
    use crate::encrypt::{Agreement, HEADER_LEN};
    use crate::vapid::tests::Fake as FakeSigner;
    use crate::B64URL;
    use base64::Engine;
    use std::cell::RefCell;
    use weather_core::push::{frost_payload, FrostAlert, Risk};

    const ENDPOINT: &str = "https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bExample";
    const CONTACT: &str = "mailto:weather@mukoko.com";
    const NOW: u64 = 1_761_900_000;

    struct Fake {
        answer: Result<u16, TransportError>,
        seen: RefCell<Vec<PushRequest>>,
    }

    impl Fake {
        fn new(answer: Result<u16, TransportError>) -> Self {
            Self {
                answer,
                seen: RefCell::new(Vec::new()),
            }
        }
    }

    impl Transport for Fake {
        async fn post(&self, req: &PushRequest) -> Result<u16, TransportError> {
            self.seen.borrow_mut().push(req.clone());
            self.answer
        }
    }

    fn alert() -> FrostAlert {
        FrostAlert {
            risk: Risk::Moderate,
            lowest: 1.0,
            start: "2026-07-10T22:00".into(),
            end: "2026-07-11T06:00".into(),
            night: "2026-07-10".into(),
        }
    }

    fn payload() -> Payload {
        frost_payload("Harare", "harare", &alert())
    }

    fn sub() -> Subscription<'static> {
        Subscription {
            endpoint: ENDPOINT,
            p256dh: UA_PUBLIC,
            auth: AUTH_SECRET,
        }
    }

    fn opts() -> Options {
        Options {
            ttl_secs: 3_600,
            urgency: Urgency::Normal,
        }
    }

    fn salt() -> [u8; 16] {
        fixed(SALT)
    }

    fn identity(signer: &FakeSigner) -> Identity<'_, FakeSigner> {
        Identity {
            signer,
            subject: CONTACT,
            now_unix: NOW,
        }
    }

    fn built() -> PushRequest {
        let signer = FakeSigner::new();
        block_on(build(
            &sub(),
            &payload(),
            &identity(&signer),
            &opts(),
            &FakeKeys::rfc(),
            &salt(),
        ))
        .unwrap()
    }

    fn build_with(
        s: &Subscription<'_>,
        id: &Identity<'_, FakeSigner>,
        o: &Options,
        keys: &FakeKeys,
    ) -> Result<PushRequest, BuildError> {
        block_on(build(s, &payload(), id, o, keys, &salt()))
    }

    fn header<'a>(r: &'a PushRequest, name: &str) -> &'a str {
        r.headers
            .iter()
            .find(|(k, _)| *k == name)
            .map(|(_, v)| v.as_str())
            .unwrap()
    }

    #[test]
    fn a_request_carries_the_headers_the_rfcs_require() {
        let r = built();
        assert_eq!(r.url, ENDPOINT);
        assert_eq!(header(&r, "Content-Encoding"), "aes128gcm");
        assert_eq!(header(&r, "Content-Type"), "application/octet-stream");
        assert_eq!(header(&r, "TTL"), "3600");
        assert_eq!(header(&r, "Urgency"), "normal");
        let auth = header(&r, "Authorization");
        assert!(auth.starts_with("vapid t="));
        assert!(auth.ends_with(", k=BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs"));
        assert_eq!(r.timeout_ms, SEND_TIMEOUT_MS);
    }

    #[test]
    fn the_token_names_the_push_service_origin_not_the_endpoint() {
        let r = built();
        let auth = header(&r, "Authorization");
        let jwt = auth
            .strip_prefix("vapid t=")
            .and_then(|s| s.split_once(", k="))
            .unwrap()
            .0;
        let claims =
            String::from_utf8(B64URL.decode(jwt.split('.').nth(1).unwrap()).unwrap()).unwrap();
        assert!(claims.contains(r#""aud":"https://fcm.googleapis.com""#));
        assert!(!claims.contains("dQw4w9"));
        assert!(claims.contains(&format!("\"exp\":{}", NOW + vapid::TOKEN_LIFETIME_SECS)));
    }

    #[test]
    fn the_body_is_one_record_that_only_the_browser_can_read() {
        let r = built();
        let plain = serde_json::to_vec(&payload()).unwrap();
        // header + plaintext + delimiter + tag, one record
        assert_eq!(r.body.len(), HEADER_LEN + plain.len() + 1 + 16);
        let shown = String::from_utf8_lossy(&r.body).to_string();
        assert!(!shown.contains("Frost") && !shown.contains("harare"));
        // the payload is small enough for every push service
        assert!(r.body.len() <= 4096);
    }

    #[test]
    fn a_high_urgency_message_says_so() {
        let signer = FakeSigner::new();
        let o = Options {
            ttl_secs: 600,
            urgency: Urgency::High,
        };
        let r = build_with(&sub(), &identity(&signer), &o, &FakeKeys::rfc()).unwrap();
        assert_eq!(header(&r, "Urgency"), "high");
        assert_eq!(header(&r, "TTL"), "600");
    }

    #[test]
    fn a_host_outside_the_allow_list_gets_no_token_and_no_key_agreement() {
        for endpoint in [
            "https://evil.example/x",
            "http://fcm.googleapis.com/x",
            "https://fcm.googleapis.com.evil.example/x",
            "https://169.254.169.254/latest/meta-data",
            "https://fcm.googleapis.com:8443/x",
        ] {
            let signer = FakeSigner::new();
            let keys = FakeKeys::rfc();
            let s = Subscription { endpoint, ..sub() };
            let e = build_with(&s, &identity(&signer), &opts(), &keys).unwrap_err();
            assert!(matches!(e, BuildError::Endpoint(_)), "{endpoint}");
            assert!(e.subscription_is_unusable());
            assert!(signer.signed.borrow().is_empty(), "{endpoint}");
            assert!(keys.asked.borrow().is_empty(), "{endpoint}");
        }
    }

    #[test]
    fn build_errors_say_whose_fault_they_are() {
        let signer = FakeSigner::new();
        // the browser's keys are bad: the subscription is dead
        let s = Subscription {
            p256dh: "BAAA",
            ..sub()
        };
        let e = build_with(&s, &identity(&signer), &opts(), &FakeKeys::rfc()).unwrap_err();
        assert_eq!(e, BuildError::Encrypt(EncryptError::BadSubscriptionKey));
        assert!(e.subscription_is_unusable());
        // the runtime says the point is off the curve: the subscription is dead
        let off_curve = FakeKeys {
            answer: Err(EncryptError::BadSubscriptionKey),
            ..FakeKeys::rfc()
        };
        let e = build_with(&sub(), &identity(&signer), &opts(), &off_curve).unwrap_err();
        assert!(e.subscription_is_unusable());
        // our contact claim is bad: configuration, not the person's problem
        let bad_id = Identity {
            subject: "nobody",
            ..identity(&signer)
        };
        let e = build_with(&sub(), &bad_id, &opts(), &FakeKeys::rfc()).unwrap_err();
        assert_eq!(e, BuildError::Vapid(VapidError::BadSubject));
        assert!(!e.subscription_is_unusable());
        assert_eq!(e.code(), "bad_vapid_subject");
        // our runtime failed (key agreement or signer): not the person's problem
        let failing_keys = FakeKeys {
            answer: Err(EncryptError::Crypto),
            ..FakeKeys::rfc()
        };
        let e = build_with(&sub(), &identity(&signer), &opts(), &failing_keys).unwrap_err();
        assert_eq!(e, BuildError::Encrypt(EncryptError::Crypto));
        assert!(!e.subscription_is_unusable());
        let failing_signer = FakeSigner {
            answer: Err(VapidError::Signing),
            ..FakeSigner::new()
        };
        let e = build_with(
            &sub(),
            &identity(&failing_signer),
            &opts(),
            &FakeKeys::rfc(),
        )
        .unwrap_err();
        assert_eq!(e, BuildError::Vapid(VapidError::Signing));
        assert!(!e.subscription_is_unusable());
        // never ours to punish: a TTL we got wrong, a payload that would not serialise
        assert!(!BuildError::Ttl.subscription_is_unusable());
        assert!(!BuildError::Payload.subscription_is_unusable());
        // and a PushError that is not about the endpoint is not a dead subscription
        assert!(!BuildError::Endpoint(PushError::TooManyPlaces).subscription_is_unusable());
    }

    #[test]
    fn the_ttl_is_required_and_bounded() {
        let signer = FakeSigner::new();
        for ttl_secs in [0, MAX_TTL_SECS + 1] {
            let o = Options { ttl_secs, ..opts() };
            assert_eq!(
                build_with(&sub(), &identity(&signer), &o, &FakeKeys::rfc()).unwrap_err(),
                BuildError::Ttl
            );
        }
        let o = Options {
            ttl_secs: MAX_TTL_SECS,
            ..opts()
        };
        assert!(build_with(&sub(), &identity(&signer), &o, &FakeKeys::rfc()).is_ok());
    }

    #[test]
    fn every_push_service_answer_is_classified_by_the_core_rules() {
        let cases = [
            (201, Outcome::Accepted),
            (404, Outcome::Expired),
            (410, Outcome::Expired),
            (403, Outcome::Expired),
            (429, Outcome::Retry),
            (503, Outcome::Retry),
            (400, Outcome::Failed),
            (413, Outcome::Failed),
        ];
        for (status, outcome) in cases {
            let t = Fake::new(Ok(status));
            let d = block_on(deliver(&t, &built()));
            assert_eq!(d.outcome, outcome, "{status}");
            assert_eq!(d.provider_code, Some(status));
        }
    }

    #[test]
    fn a_timeout_or_a_network_error_is_retried_with_no_code() {
        for e in [TransportError::Timeout, TransportError::Network] {
            let t = Fake::new(Err(e));
            let d = block_on(deliver(&t, &built()));
            assert_eq!(
                d,
                Delivery {
                    outcome: Outcome::Retry,
                    provider_code: None
                }
            );
        }
    }

    #[test]
    fn send_builds_then_posts_exactly_one_request() {
        let signer = FakeSigner::new();
        let t = Fake::new(Ok(201));
        let d = block_on(send(
            &t,
            &sub(),
            &payload(),
            &identity(&signer),
            &opts(),
            &FakeKeys::rfc(),
            &salt(),
        ))
        .unwrap();
        assert_eq!(d.outcome, Outcome::Accepted);
        assert_eq!(d.outcome.delivery_status(), "sent");
        let seen = t.seen.borrow();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0], built());
    }

    #[test]
    fn a_refused_build_never_reaches_the_transport() {
        let signer = FakeSigner::new();
        let s = Subscription {
            endpoint: "https://evil.example/x",
            ..sub()
        };
        let t = Fake::new(Ok(201));
        assert!(block_on(send(
            &t,
            &s,
            &payload(),
            &identity(&signer),
            &opts(),
            &FakeKeys::rfc(),
            &salt(),
        ))
        .is_err());
        assert!(t.seen.borrow().is_empty());
    }

    #[test]
    fn nothing_that_prints_carries_the_capability() {
        let r = built();
        let shown = format!("{r:?} {:?}", sub());
        for secret in [ENDPOINT, "dQw4w9", UA_PUBLIC, AUTH_SECRET, "vapid t="] {
            assert!(!shown.contains(secret), "{secret}");
        }
        assert!(shown.contains(&push::endpoint_id(ENDPOINT)));
    }

    #[test]
    fn the_payload_the_browser_reads_is_the_decided_alert() {
        // Decrypt as the browser would (RFC 8291 section 3.4, receiver side)
        // from the RFC's published ECDH secret, to prove the record carries
        // the JSON payload. The receiver side is test-only: the crate never
        // decrypts.
        use aes_gcm::aead::{Aead, KeyInit, Payload as Aead2};
        use aes_gcm::{Aes128Gcm, Nonce};
        use hkdf::Hkdf;
        use sha2::Sha256;

        let r = built();
        let salt: [u8; 16] = r.body[..16].try_into().unwrap();
        let as_public = &r.body[21..HEADER_LEN];
        assert_eq!(B64URL.encode(as_public), AS_PUBLIC);
        let mut key_info = b"WebPush: info\0".to_vec();
        key_info.extend_from_slice(&B64URL.decode(UA_PUBLIC).unwrap());
        key_info.extend_from_slice(as_public);
        let mut ikm = [0u8; 32];
        Hkdf::<Sha256>::new(
            Some(&B64URL.decode(AUTH_SECRET).unwrap()),
            &B64URL.decode(ECDH_SECRET).unwrap(),
        )
        .expand(&key_info, &mut ikm)
        .unwrap();
        let prk = Hkdf::<Sha256>::new(Some(&salt), &ikm);
        let mut cek = [0u8; 16];
        let mut nonce = [0u8; 12];
        prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek)
            .unwrap();
        prk.expand(b"Content-Encoding: nonce\0", &mut nonce)
            .unwrap();
        let record = Aes128Gcm::new_from_slice(&cek)
            .unwrap()
            .decrypt(
                Nonce::from_slice(&nonce),
                Aead2 {
                    msg: &r.body[HEADER_LEN..],
                    aad: &[],
                },
            )
            .unwrap();
        // RFC 8188: the last octet of the (only) record is the 0x02 delimiter
        assert_eq!(*record.last().unwrap(), 0x02);
        let json: serde_json::Value = serde_json::from_slice(&record[..record.len() - 1]).unwrap();
        assert_eq!(json["v"], 1);
        assert_eq!(json["kind"], "frost");
        assert_eq!(json["slug"], "harare");
        assert_eq!(json["url"], "/harare");
        assert_eq!(json["title"], "Frost alert for Harare");
        // and a different ECDH secret (a different browser) cannot read it
        let other = Agreement {
            shared_secret: [1u8; 32],
            ..crate::encrypt::tests::rfc_agreement()
        };
        let signer = FakeSigner::new();
        let keys = FakeKeys {
            answer: Ok(other),
            ..FakeKeys::rfc()
        };
        let r2 = build_with(&sub(), &identity(&signer), &opts(), &keys).unwrap();
        assert_ne!(r2.body[HEADER_LEN..], r.body[HEADER_LEN..]);
    }
}
