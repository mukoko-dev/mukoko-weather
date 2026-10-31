//! Voluntary Application Server Identification: RFC 8292.
//!
//! The sender proves it is the same application server every time by signing
//! a short-lived JWT (ES256, P-256) with a key pair it keeps. The push service
//! gets the token and the public key in one `Authorization: vapid` header.
//! A browser subscribes against the PUBLIC key, and a push service answers
//! 403 to a token signed by any other key, so the pair never changes without
//! every subscription being remade.
//!
//! This module builds and checks everything about the token EXCEPT the
//! signature: that is the injected [`Es256Signer`], which owns the private key
//! (in a Worker, a WebCrypto key imported from a secret binding). So this
//! crate never holds a private key, has no `Debug` that could print one, and
//! uses no Rust elliptic-curve crate (the RustCrypto chain currently resolves
//! `crypto-bigint` 0.5, RUSTSEC-2026-0387).

use base64::Engine;

use crate::B64URL;

/// How long a token we sign stays valid. RFC 8292 section 2 allows at most 24
/// hours; half a day leaves room for a clock a few minutes off.
pub const TOKEN_LIFETIME_SECS: u64 = 12 * 60 * 60;
/// The JWT header RFC 8292 section 2.4 shows.
const JWT_HEADER: &str = r#"{"typ":"JWT","alg":"ES256"}"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VapidError {
    /// The contact claim is not a `mailto:` or `https:` URI (RFC 8292
    /// section 2.1), or is empty or oversized.
    BadSubject,
    /// The audience is not the bare origin of an allowed push service.
    BadAudience,
    /// The signer refused or failed.
    Signing,
}

impl VapidError {
    /// A stable machine-readable code for logs.
    pub fn code(self) -> &'static str {
        match self {
            Self::BadSubject => "bad_vapid_subject",
            Self::BadAudience => "bad_vapid_audience",
            Self::Signing => "vapid_signing",
        }
    }
}

/// What a runtime supplies for the signature. An implementation holds the
/// application server's P-256 private key and:
///
/// - signs `message` with ECDSA over SHA-256 (ES256, RFC 7518 section 3.4);
/// - returns the signature as the 64 octets `r || s` (the IEEE P1363 form a
///   JWT carries, which is what WebCrypto's `sign` returns; NOT DER);
/// - reports the matching public key as the uncompressed point.
///
/// The signature need not be deterministic. Its future is not `Send`, which is
/// why the trait is not either.
#[allow(async_fn_in_trait)]
pub trait Es256Signer {
    /// The public key, uncompressed (65 octets starting 0x04).
    fn public_key(&self) -> [u8; 65];
    async fn sign(&self, message: &[u8]) -> Result<[u8; 64], VapidError>;
}

/// The public key as base64url of the uncompressed point (87 characters):
/// the `applicationServerKey` a browser subscribes against and the `k`
/// parameter of the header.
pub fn public_key_b64url<S: Es256Signer>(signer: &S) -> String {
    B64URL.encode(signer.public_key())
}

/// A token is only ever made for the origin of a push service we send to: the
/// same https-only, allow-listed, no-port, no-credentials rules as the
/// endpoint itself (`weather_core::push`), and in the canonical lower-case
/// form. One source of truth for what a push origin is.
fn audience_ok(audience: &str) -> bool {
    weather_core::push::endpoint_origin(&format!("{audience}/")).as_deref() == Ok(audience)
}

fn contact_ok(subject: &str) -> bool {
    let well_formed = subject.len() <= 200 && !subject.chars().any(|c| c.is_control());
    well_formed
        && (subject
            .strip_prefix("mailto:")
            .is_some_and(|a| a.contains('@') && !a.starts_with('@') && !a.ends_with('@'))
            || subject
                .strip_prefix("https://")
                .is_some_and(|h| !h.is_empty() && !h.starts_with('/')))
}

fn json_string(s: &str) -> Result<String, VapidError> {
    serde_json::to_string(s).map_err(|_| VapidError::Signing)
}

/// `header.claims`, base64url, no padding: the JWT signing input. Claims are
/// written in the order RFC 8292's example shows (`aud`, `exp`, `sub`), by
/// hand, so the bytes never depend on a serializer's map order. No policy
/// here: [`token`] checks the audience and the contact first.
pub(crate) fn signing_input(
    audience: &str,
    subject: &str,
    expires_unix: u64,
) -> Result<String, VapidError> {
    let claims = format!(
        "{{\"aud\":{},\"exp\":{expires_unix},\"sub\":{}}}",
        json_string(audience)?,
        json_string(subject)?
    );
    Ok(format!(
        "{}.{}",
        B64URL.encode(JWT_HEADER),
        B64URL.encode(claims.as_bytes())
    ))
}

/// The signed JWT for one push service origin, valid for
/// [`TOKEN_LIFETIME_SECS`] from `now_unix`. `audience` is the origin of the
/// push endpoint (`weather_core::push::endpoint_origin`).
pub async fn token<S: Es256Signer>(
    signer: &S,
    audience: &str,
    subject: &str,
    now_unix: u64,
) -> Result<String, VapidError> {
    if !audience_ok(audience) {
        return Err(VapidError::BadAudience);
    }
    if !contact_ok(subject) {
        return Err(VapidError::BadSubject);
    }
    let input = signing_input(
        audience,
        subject,
        now_unix.saturating_add(TOKEN_LIFETIME_SECS),
    )?;
    let signature = signer.sign(input.as_bytes()).await?;
    Ok(format!("{input}.{}", B64URL.encode(signature)))
}

/// The value of the `Authorization` header (RFC 8292 section 3):
/// `vapid t=<jwt>, k=<public key>`.
pub async fn authorization<S: Es256Signer>(
    signer: &S,
    audience: &str,
    subject: &str,
    now_unix: u64,
) -> Result<String, VapidError> {
    Ok(format!(
        "vapid t={}, k={}",
        token(signer, audience, subject, now_unix).await?,
        public_key_b64url(signer)
    ))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::encrypt::tests::block_on;
    use std::cell::RefCell;

    // RFC 8292 section 2.4 (Figures 1 and 2): a token an application server
    // sent. Its signing key is not ours and its private half is unknown; only
    // the bytes the signature covers matter here.
    const RFC_JWT: &str = "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1haWx0bzpwdXNoQGV4YW1wbGUuY29tIn0.i3CYb7t4xfxCDquptFOepC9GAu_HLGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA";
    const RFC_PUBLIC: &str =
        "BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs";
    const GOOD_AUD: &str = "https://fcm.googleapis.com";
    const GOOD_SUB: &str = "mailto:weather@mukoko.com";

    /// A signer that returns a fixed 64-octet signature, records the exact
    /// message it was asked to sign, and reports a fixed public key. (No
    /// private key exists in this crate, so the tests use no real signature.)
    pub(crate) struct Fake {
        pub(crate) public: [u8; 65],
        pub(crate) answer: Result<[u8; 64], VapidError>,
        pub(crate) signed: RefCell<Vec<Vec<u8>>>,
    }

    impl Fake {
        pub(crate) fn new() -> Self {
            Self {
                public: crate::encrypt::tests::fixed(RFC_PUBLIC),
                answer: Ok(core::array::from_fn(|i| i as u8)),
                signed: RefCell::new(Vec::new()),
            }
        }
    }

    impl Es256Signer for Fake {
        fn public_key(&self) -> [u8; 65] {
            self.public
        }
        async fn sign(&self, message: &[u8]) -> Result<[u8; 64], VapidError> {
            self.signed.borrow_mut().push(message.to_vec());
            self.answer
        }
    }

    fn segments(jwt: &str) -> (String, String, Vec<u8>) {
        let mut it = jwt.split('.');
        let header = it.next().unwrap();
        let claims = it.next().unwrap();
        let sig = it.next().unwrap();
        assert!(it.next().is_none());
        (
            String::from_utf8(B64URL.decode(header).unwrap()).unwrap(),
            String::from_utf8(B64URL.decode(claims).unwrap()).unwrap(),
            B64URL.decode(sig).unwrap(),
        )
    }

    #[test]
    fn the_signing_input_is_byte_for_byte_the_rfc_8292_example() {
        // RFC 8292 section 2.4: the JWT the signature covers is the first two
        // segments of the example token, for these claims.
        let input = signing_input(
            "https://push.example.net",
            "mailto:push@example.com",
            1_453_523_768,
        )
        .unwrap();
        assert_eq!(input, RFC_JWT.rsplit_once('.').unwrap().0);
        let (header, claims, _) = segments(RFC_JWT);
        assert_eq!(header, JWT_HEADER);
        assert_eq!(
            claims,
            r#"{"aud":"https://push.example.net","exp":1453523768,"sub":"mailto:push@example.com"}"#
        );
    }

    #[test]
    fn the_token_is_the_signing_input_plus_the_raw_signature() {
        let signer = Fake::new();
        let now = 1_453_480_568; // RFC 8292's example exp, minus 12 hours
        let jwt = block_on(token(&signer, GOOD_AUD, GOOD_SUB, now)).unwrap();
        let (header, claims, sig) = segments(&jwt);
        assert_eq!(header, JWT_HEADER);
        assert_eq!(
            claims,
            format!(
                r#"{{"aud":"{GOOD_AUD}","exp":{},"sub":"{GOOD_SUB}"}}"#,
                now + TOKEN_LIFETIME_SECS
            )
        );
        // exactly the 64 raw octets, signed over exactly header.claims
        assert_eq!(sig.as_slice(), signer.answer.unwrap().as_slice());
        let signed = signer.signed.borrow();
        assert_eq!(signed.len(), 1);
        assert_eq!(
            signed[0],
            jwt.rsplit_once('.').unwrap().0.as_bytes(),
            "the signer sees the JWT signing input and nothing else"
        );
    }

    #[test]
    fn a_token_never_lives_longer_than_the_rfc_allows() {
        const { assert!(TOKEN_LIFETIME_SECS < 24 * 60 * 60) };
        let signer = Fake::new();
        let jwt = block_on(token(&signer, GOOD_AUD, GOOD_SUB, 1_000)).unwrap();
        let (_, claims, _) = segments(&jwt);
        assert!(claims.contains(&format!("\"exp\":{}", 1_000 + TOKEN_LIFETIME_SECS)));
    }

    #[test]
    fn the_authorization_header_carries_the_token_and_the_public_key() {
        let signer = Fake::new();
        let h = block_on(authorization(&signer, GOOD_AUD, GOOD_SUB, 1_700_000_000)).unwrap();
        let rest = h.strip_prefix("vapid t=").unwrap();
        let (jwt, k) = rest.split_once(", k=").unwrap();
        assert_eq!(k, RFC_PUBLIC);
        assert_eq!(k.len(), 87);
        assert_eq!(jwt.matches('.').count(), 2);
    }

    #[test]
    fn the_audience_is_only_ever_an_allowed_push_service_origin() {
        let signer = Fake::new();
        for ok in [
            "https://fcm.googleapis.com",
            "https://updates.push.services.mozilla.com",
            "https://web.push.apple.com",
        ] {
            assert!(block_on(token(&signer, ok, GOOD_SUB, 1)).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "http://fcm.googleapis.com",
            "https://",
            "https://fcm.googleapis.com/fcm/send/abc",
            "https://fcm.googleapis.com/",
            "https://user@fcm.googleapis.com",
            "https://FCM.googleapis.com",
            "https://fcm.googleapis.com:443",
            "https://fcm.googleapis.com:8443",
            "https://a b.push.apple.com",
            "fcm.googleapis.com",
            // well formed, but not a push service we send to
            "https://push.example.net",
            "https://169.254.169.254",
        ] {
            assert_eq!(
                block_on(token(&signer, bad, GOOD_SUB, 1)),
                Err(VapidError::BadAudience),
                "{bad}"
            );
        }
        // nothing was signed for a refused audience
        assert_eq!(signer.signed.borrow().len(), 3);
    }

    #[test]
    fn the_contact_must_be_a_mailto_or_https_uri() {
        let signer = Fake::new();
        for ok in [
            "mailto:weather@mukoko.com",
            "https://weather.mukoko.com/contact",
        ] {
            assert!(block_on(token(&signer, GOOD_AUD, ok, 1)).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "weather@mukoko.com",
            "mailto:",
            "mailto:nobody",
            "mailto:@mukoko.com",
            "http://weather.mukoko.com",
            "https://",
            "mailto:a@b.example\r\nX-Evil: 1",
        ] {
            assert_eq!(
                block_on(token(&signer, GOOD_AUD, bad, 1)),
                Err(VapidError::BadSubject),
                "{bad:?}"
            );
        }
        let long = format!("mailto:{}@mukoko.com", "a".repeat(200));
        assert_eq!(
            block_on(token(&signer, GOOD_AUD, &long, 1)),
            Err(VapidError::BadSubject)
        );
    }

    #[test]
    fn a_failing_signer_fails_the_token_and_the_header() {
        let signer = Fake {
            answer: Err(VapidError::Signing),
            ..Fake::new()
        };
        assert_eq!(
            block_on(token(&signer, GOOD_AUD, GOOD_SUB, 1)),
            Err(VapidError::Signing)
        );
        assert_eq!(
            block_on(authorization(&signer, GOOD_AUD, GOOD_SUB, 1)),
            Err(VapidError::Signing)
        );
    }
}
