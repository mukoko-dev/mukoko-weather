//! The WeatherKit developer token: a JWT signed with ES256.
//!
//! Apple's rules (`Request authentication for WeatherKit REST API`, checked
//! 2026-11-01):
//!
//! * header `alg: ES256`, `kid` (the 10-character key id) and `id`
//!   (`<TeamID>.<ServiceID>`);
//! * claims `iss` (the 10-character Team ID), `iat`, `exp` (seconds since the
//!   epoch, UTC) and `sub` (the Service ID), and **only those claims**;
//! * ES256 is ECDSA over P-256 with SHA-256; any other algorithm, or an
//!   unsigned token, is answered `401`;
//! * sent as `Authorization: Bearer <token>`; the private key is never
//!   distributed, so a service signs its own tokens.
//!
//! This module builds everything about the token EXCEPT the signature. The
//! signature is the injected [`Es256Signer`], which owns the private key (a
//! native crypto library on the Servers API origin, WebCrypto in a Worker), so
//! this crate never holds a key, has no `Debug` that could print one, and uses
//! no Rust elliptic-curve crate (the RustCrypto chain currently resolves
//! `crypto-bigint` 0.5, RUSTSEC-2026-0387). The same split `weather-webpush`
//! uses for VAPID.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;

/// How long a token we sign stays valid: one hour. Apple states no maximum on
/// the page; a short life is what its own guidance asks for ("shorter times
/// ensure a higher level of security").
pub const TOKEN_LIFETIME_SECS: u64 = 3600;
/// How long a signed token is reused before a new one is made: 50 minutes, so
/// a token handed to a request always has at least ten minutes left.
pub const TOKEN_REUSE_SECS: u64 = 50 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenError {
    /// The Team ID is not 10 letters or digits.
    BadTeamId,
    /// The Key ID is not 10 letters or digits.
    BadKeyId,
    /// The Service ID is empty, too long, or has a character a reverse-DNS
    /// identifier does not.
    BadServiceId,
    /// The signer refused or failed.
    Signing,
}

impl TokenError {
    /// A stable machine-readable code for logs. Never carries a value.
    pub fn code(self) -> &'static str {
        match self {
            Self::BadTeamId => "bad_weatherkit_team_id",
            Self::BadKeyId => "bad_weatherkit_key_id",
            Self::BadServiceId => "bad_weatherkit_service_id",
            Self::Signing => "weatherkit_signing",
        }
    }
}

/// The three identifiers of a WeatherKit key. They are not secrets (they
/// appear in every token), the private key is, and it is not here.
#[derive(Clone, PartialEq, Eq)]
pub struct Credentials {
    pub team_id: String,
    pub service_id: String,
    pub key_id: String,
}

fn ten_alphanumerics(s: &str) -> bool {
    s.len() == 10 && s.chars().all(|c| c.is_ascii_alphanumeric())
}

/// A Services ID is a reverse-DNS style identifier (`com.example.client`):
/// letters, digits, `.`, `-` and `_`, at most 100 characters.
fn service_id_ok(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && !s.starts_with('.')
        && !s.ends_with('.')
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

impl Credentials {
    /// Check the identifiers. Run it at startup: a mistyped id would
    /// otherwise surface as a `401` from Apple on every request.
    pub fn validate(&self) -> Result<(), TokenError> {
        if !ten_alphanumerics(&self.team_id) {
            Err(TokenError::BadTeamId)
        } else if !ten_alphanumerics(&self.key_id) {
            Err(TokenError::BadKeyId)
        } else if !service_id_ok(&self.service_id) {
            Err(TokenError::BadServiceId)
        } else {
            Ok(())
        }
    }
}

impl std::fmt::Debug for Credentials {
    /// Identifiers only, but kept out of logs anyway: nothing needs them there.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Credentials(..)")
    }
}

/// What a runtime supplies for the signature. An implementation holds the
/// WeatherKit private key (the PKCS#8 `.p8` Apple lets you download once) and:
///
/// * signs `message` with ECDSA over SHA-256 on P-256 (ES256, RFC 7518
///   section 3.4);
/// * returns the signature as the 64 octets `r || s` (the IEEE P1363 form a JWT
///   carries, which is what WebCrypto's `sign` returns; NOT ASN.1 DER, which is
///   what most native libraries return by default and must be converted).
///
/// The signature need not be deterministic. The future is not `Send`, which is
/// why the trait is not either.
#[allow(async_fn_in_trait)]
pub trait Es256Signer {
    async fn sign(&self, message: &[u8]) -> Result<[u8; 64], TokenError>;
}

fn json_string(s: &str) -> Result<String, TokenError> {
    serde_json::to_string(s).map_err(|_| TokenError::Signing)
}

/// `header.claims`, base64url without padding: the JWT signing input.
///
/// The header and claims are written by hand in the order Apple's example
/// shows (`alg`, `kid`, `id`; `iss`, `iat`, `exp`, `sub`), so the bytes never
/// depend on a serializer's map order, and they carry nothing Apple did not
/// list ("ensure that the token contains only the claims listed").
///
/// No validation here: [`developer_token`] validates first.
pub fn signing_input(creds: &Credentials, issued_at: u64) -> Result<String, TokenError> {
    let header = format!(
        "{{\"alg\":\"ES256\",\"kid\":{},\"id\":{}}}",
        json_string(&creds.key_id)?,
        json_string(&format!("{}.{}", creds.team_id, creds.service_id))?
    );
    let claims = format!(
        "{{\"iss\":{},\"iat\":{issued_at},\"exp\":{},\"sub\":{}}}",
        json_string(&creds.team_id)?,
        issued_at.saturating_add(TOKEN_LIFETIME_SECS),
        json_string(&creds.service_id)?
    );
    Ok(format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(header),
        URL_SAFE_NO_PAD.encode(claims)
    ))
}

/// The signed developer token, valid for [`TOKEN_LIFETIME_SECS`] from
/// `now_unix`. The caller keeps it for [`TOKEN_REUSE_SECS`] ([`reusable`]) and
/// never logs it.
pub async fn developer_token<S: Es256Signer>(
    signer: &S,
    creds: &Credentials,
    now_unix: u64,
) -> Result<String, TokenError> {
    creds.validate()?;
    let input = signing_input(creds, now_unix)?;
    let signature = signer.sign(input.as_bytes()).await?;
    Ok(format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature)))
}

/// May a token issued at `issued_at` still be handed to a request at `now`?
/// Yes for [`TOKEN_REUSE_SECS`]; a token "from the future" (a clock that went
/// back) is not reused.
pub fn reusable(issued_at: u64, now: u64) -> bool {
    now >= issued_at && now - issued_at < TOKEN_REUSE_SECS
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::future::Future;
    use std::pin::pin;
    use std::task::{Context, Poll, Waker};

    fn creds() -> Credentials {
        Credentials {
            team_id: "DEF123GHIJ".into(),
            service_id: "com.example.weatherkit-client".into(),
            key_id: "ABC123DEFG".into(),
        }
    }

    /// A signer that records what it was asked to sign and returns a fixed
    /// 64-octet signature.
    struct Recorder {
        seen: RefCell<Vec<Vec<u8>>>,
        result: Result<[u8; 64], TokenError>,
    }

    impl Recorder {
        fn ok() -> Self {
            Recorder {
                seen: RefCell::new(vec![]),
                result: Ok(core::array::from_fn(|i| i as u8)),
            }
        }
    }

    impl Es256Signer for Recorder {
        async fn sign(&self, message: &[u8]) -> Result<[u8; 64], TokenError> {
            self.seen.borrow_mut().push(message.to_vec());
            self.result
        }
    }

    fn block_on<F: Future>(f: F) -> F::Output {
        let mut f = pin!(f);
        let mut cx = Context::from_waker(Waker::noop());
        match f.as_mut().poll(&mut cx) {
            Poll::Ready(v) => v,
            Poll::Pending => panic!("the signer never waits"),
        }
    }

    fn decode(segment: &str) -> String {
        String::from_utf8(URL_SAFE_NO_PAD.decode(segment).expect("base64url")).expect("utf8")
    }

    #[test]
    fn the_header_and_claims_are_exactly_what_apple_lists() {
        let input = signing_input(&creds(), 1_437_179_036).unwrap();
        let (h, c) = input.split_once('.').unwrap();
        // Byte for byte, in Apple's order; no `typ`, no extra claim.
        assert_eq!(
            decode(h),
            r#"{"alg":"ES256","kid":"ABC123DEFG","id":"DEF123GHIJ.com.example.weatherkit-client"}"#
        );
        assert_eq!(
            decode(c),
            r#"{"iss":"DEF123GHIJ","iat":1437179036,"exp":1437182636,"sub":"com.example.weatherkit-client"}"#
        );
        // base64url: no padding, no `+` or `/`.
        assert!(!input.contains(['=', '+', '/']));
    }

    #[test]
    fn the_token_is_three_segments_with_a_64_octet_signature() {
        let signer = Recorder::ok();
        let token = block_on(developer_token(&signer, &creds(), 1_800_000_000)).unwrap();
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3);
        let sig = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
        assert_eq!(sig.len(), 64);
        assert_eq!(sig[0], 0);
        assert_eq!(sig[63], 63);
        // The signer signed exactly `header.claims`.
        let seen = signer.seen.borrow();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0], format!("{}.{}", parts[0], parts[1]).into_bytes());
    }

    #[test]
    fn the_token_lives_one_hour() {
        let token = block_on(developer_token(&Recorder::ok(), &creds(), 1_800_000_000)).unwrap();
        let claims = decode(token.split('.').nth(1).unwrap());
        let v: serde_json::Value = serde_json::from_str(&claims).unwrap();
        assert_eq!(v["iat"], 1_800_000_000_u64);
        assert_eq!(v["exp"], 1_800_003_600_u64);
        assert_eq!(v.as_object().unwrap().len(), 4, "only iss, iat, exp, sub");
        assert_eq!(TOKEN_LIFETIME_SECS, 3600);
    }

    #[test]
    fn a_token_is_reused_for_fifty_minutes_and_never_from_the_future() {
        let t0 = 1_800_000_000;
        assert!(reusable(t0, t0));
        assert!(reusable(t0, t0 + 49 * 60 + 59));
        assert!(!reusable(t0, t0 + 50 * 60));
        assert!(!reusable(t0, t0 + 3600));
        // The clock went back: do not trust it.
        assert!(!reusable(t0, t0 - 1));
        // Always at least ten minutes of validity left when handed out.
        const { assert!(TOKEN_LIFETIME_SECS - TOKEN_REUSE_SECS >= 600) };
    }

    #[test]
    fn bad_identifiers_are_refused_before_anything_is_signed() {
        let signer = Recorder::ok();
        let mut c = creds();
        c.team_id = "SHORT".into();
        assert_eq!(
            block_on(developer_token(&signer, &c, 1)),
            Err(TokenError::BadTeamId)
        );
        let mut c = creds();
        c.key_id = "ABC123DEFG1".into();
        assert_eq!(c.validate(), Err(TokenError::BadKeyId));
        let mut c = creds();
        c.key_id = "ABC123DE-G".into();
        assert_eq!(c.validate(), Err(TokenError::BadKeyId));
        for bad in ["", ".x", "x.", "has space", "q\"uote", &"a".repeat(101)] {
            let mut c = creds();
            c.service_id = bad.into();
            assert_eq!(c.validate(), Err(TokenError::BadServiceId), "{bad:?}");
        }
        assert!(creds().validate().is_ok());
        assert!(signer.seen.borrow().is_empty(), "nothing was signed");
    }

    #[test]
    fn a_signer_failure_is_an_error_not_a_token() {
        let signer = Recorder {
            seen: RefCell::new(vec![]),
            result: Err(TokenError::Signing),
        };
        assert_eq!(
            block_on(developer_token(&signer, &creds(), 1)),
            Err(TokenError::Signing)
        );
    }

    #[test]
    fn credentials_never_print_their_values() {
        let shown = format!("{:?}", creds());
        assert!(!shown.contains("DEF123GHIJ") && !shown.contains("weatherkit-client"));
    }
}
