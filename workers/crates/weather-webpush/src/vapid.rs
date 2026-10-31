//! Voluntary Application Server Identification: RFC 8292.
//!
//! The sender proves it is the same application server every time by signing
//! a short-lived JWT (ES256, P-256) with a key pair it keeps. The push service
//! gets the token and the public key in one `Authorization: vapid` header.
//! A browser subscribes against the PUBLIC key, and a push service answers
//! 403 to a token signed by any other key, so the pair never changes without
//! every subscription being remade.
//!
//! The private key is an argument, never a constant, and this crate never
//! reads or stores one: the push Worker takes it from its secret binding. Its
//! `Debug` prints the public key only. ES256 signing here is deterministic
//! (RFC 6979), so no random source is needed either.

use base64::Engine;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};

use crate::B64URL;

/// How long a token we sign stays valid. RFC 8292 section 2 allows at most 24
/// hours; half a day leaves room for a clock a few minutes off.
pub const TOKEN_LIFETIME_SECS: u64 = 12 * 60 * 60;
/// The JWT header RFC 8292 section 2.4 shows.
const JWT_HEADER: &str = r#"{"typ":"JWT","alg":"ES256"}"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VapidError {
    /// Not a 32-octet P-256 private scalar.
    BadKey,
    /// The contact claim is not a `mailto:` or `https:` URI (RFC 8292
    /// section 2.1), or is empty or oversized.
    BadSubject,
    /// The audience is not a bare `https://host` origin.
    BadAudience,
    /// The signer refused the input (cannot happen with a valid key).
    Signing,
}

impl VapidError {
    /// A stable machine-readable code for logs.
    pub fn code(self) -> &'static str {
        match self {
            Self::BadKey => "bad_vapid_key",
            Self::BadSubject => "bad_vapid_subject",
            Self::BadAudience => "bad_vapid_audience",
            Self::Signing => "vapid_signing",
        }
    }
}

/// The application server's signing key.
pub struct VapidKey {
    signing: SigningKey,
    public: [u8; 65],
}

impl std::fmt::Debug for VapidKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "VapidKey(public={})", self.public_b64url())
    }
}

impl VapidKey {
    /// From the raw 32-octet private scalar, the form `web-push` tooling
    /// prints and a secret store holds.
    pub fn from_bytes(private: &[u8; 32]) -> Result<Self, VapidError> {
        let signing = SigningKey::from_slice(private).map_err(|_| VapidError::BadKey)?;
        let point = signing.verifying_key().to_encoded_point(false);
        let public: [u8; 65] = point
            .as_bytes()
            .try_into()
            .map_err(|_| VapidError::BadKey)?;
        Ok(Self { signing, public })
    }

    /// From the private scalar as base64url (43 characters).
    pub fn from_b64url(private: &str) -> Result<Self, VapidError> {
        let raw: [u8; 32] = B64URL
            .decode(private.trim())
            .map_err(|_| VapidError::BadKey)?
            .as_slice()
            .try_into()
            .map_err(|_| VapidError::BadKey)?;
        Self::from_bytes(&raw)
    }

    /// The public key, base64url of the uncompressed point (87 characters):
    /// the `applicationServerKey` a browser subscribes against and the `k`
    /// parameter of the header.
    pub fn public_b64url(&self) -> String {
        B64URL.encode(self.public)
    }
}

fn is_origin(audience: &str) -> bool {
    audience
        .strip_prefix("https://")
        .is_some_and(|host| !host.is_empty() && !host.contains(['/', '?', '#', '@']))
}

fn is_contact(subject: &str) -> bool {
    let well_formed = subject.len() <= 200 && !subject.chars().any(|c| c.is_control());
    well_formed
        && (subject
            .strip_prefix("mailto:")
            .is_some_and(|a| a.contains('@') && !a.starts_with('@') && !a.ends_with('@'))
            || subject
                .strip_prefix("https://")
                .is_some_and(|h| !h.is_empty() && !h.starts_with('/')))
}

fn json_string(s: &str) -> String {
    // A string always serialises; the fallback only avoids an unwrap.
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

/// The signed JWT for one push service origin, valid for
/// [`TOKEN_LIFETIME_SECS`] from `now_unix`. `audience` is the origin of the
/// push endpoint (`weather_core::push::endpoint_origin`).
///
/// Claims are written in the order RFC 8292's example shows (`aud`, `exp`,
/// `sub`), by hand, so the bytes never depend on a serializer's map order.
pub fn token(
    key: &VapidKey,
    audience: &str,
    subject: &str,
    now_unix: u64,
) -> Result<String, VapidError> {
    if !is_origin(audience) {
        return Err(VapidError::BadAudience);
    }
    if !is_contact(subject) {
        return Err(VapidError::BadSubject);
    }
    let exp = now_unix.saturating_add(TOKEN_LIFETIME_SECS);
    let claims = format!(
        "{{\"aud\":{},\"exp\":{exp},\"sub\":{}}}",
        json_string(audience),
        json_string(subject)
    );
    let signing_input = format!(
        "{}.{}",
        B64URL.encode(JWT_HEADER),
        B64URL.encode(claims.as_bytes())
    );
    // ES256 (RFC 7518 section 3.4): the 64 octets r || s, not DER.
    let signature: Signature = key
        .signing
        .try_sign(signing_input.as_bytes())
        .map_err(|_| VapidError::Signing)?;
    Ok(format!(
        "{signing_input}.{}",
        B64URL.encode(signature.to_bytes())
    ))
}

/// The value of the `Authorization` header (RFC 8292 section 3):
/// `vapid t=<jwt>, k=<public key>`.
pub fn authorization(
    key: &VapidKey,
    audience: &str,
    subject: &str,
    now_unix: u64,
) -> Result<String, VapidError> {
    Ok(format!(
        "vapid t={}, k={}",
        token(key, audience, subject, now_unix)?,
        key.public_b64url()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Verifier;
    use p256::ecdsa::VerifyingKey;

    /// The RFC 8291 example's application server key. Published test key
    /// material, used here only to have a fixed key pair: not a secret.
    const TEST_PRIVATE: &str = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
    const TEST_PUBLIC: &str =
        "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";

    // RFC 8292 section 2.4 (Figure 1 and 2): a token an application server
    // sent and the key that signed it.
    const RFC_JWT: &str = "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1haWx0bzpwdXNoQGV4YW1wbGUuY29tIn0.i3CYb7t4xfxCDquptFOepC9GAu_HLGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA";
    const RFC_PUBLIC: &str =
        "BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs";

    fn key() -> VapidKey {
        VapidKey::from_b64url(TEST_PRIVATE).unwrap()
    }

    fn verifier(public_b64url: &str) -> VerifyingKey {
        VerifyingKey::from_sec1_bytes(&B64URL.decode(public_b64url).unwrap()).unwrap()
    }

    fn parts(jwt: &str) -> (String, String, Vec<u8>) {
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
    fn the_public_key_is_derived_from_the_private_one() {
        assert_eq!(key().public_b64url(), TEST_PUBLIC);
        assert_eq!(key().public_b64url().len(), 87);
    }

    #[test]
    fn the_rfc_8292_example_token_verifies_under_its_published_key() {
        // Proves the signing input (header.claims, base64url, no padding) and
        // the raw r||s signature format are what push services check.
        let (header, claims, sig) = parts(RFC_JWT);
        assert_eq!(header, JWT_HEADER);
        assert_eq!(
            claims,
            r#"{"aud":"https://push.example.net","exp":1453523768,"sub":"mailto:push@example.com"}"#
        );
        let signing_input = RFC_JWT.rsplit_once('.').unwrap().0;
        let sig = Signature::from_slice(&sig).unwrap();
        assert!(verifier(RFC_PUBLIC)
            .verify(signing_input.as_bytes(), &sig)
            .is_ok());
        // and not under any other key
        assert!(verifier(TEST_PUBLIC)
            .verify(signing_input.as_bytes(), &sig)
            .is_err());
    }

    #[test]
    fn our_token_has_the_rfc_shape_and_verifies_under_our_public_key() {
        let now = 1_453_480_568; // RFC 8292's example exp, minus 12 hours
        let jwt = token(
            &key(),
            "https://push.example.net",
            "mailto:push@example.com",
            now,
        )
        .unwrap();
        let (header, claims, sig) = parts(&jwt);
        assert_eq!(header, JWT_HEADER);
        assert_eq!(
            claims,
            r#"{"aud":"https://push.example.net","exp":1453523768,"sub":"mailto:push@example.com"}"#
        );
        assert_eq!(sig.len(), 64);
        let signing_input = jwt.rsplit_once('.').unwrap().0;
        assert!(verifier(TEST_PUBLIC)
            .verify(
                signing_input.as_bytes(),
                &Signature::from_slice(&sig).unwrap()
            )
            .is_ok());
    }

    #[test]
    fn a_token_never_lives_longer_than_the_rfc_allows() {
        const { assert!(TOKEN_LIFETIME_SECS < 24 * 60 * 60) };
        let jwt = token(&key(), "https://a.example", "mailto:a@b.example", 1_000).unwrap();
        let (_, claims, _) = parts(&jwt);
        assert!(claims.contains(&format!("\"exp\":{}", 1_000 + TOKEN_LIFETIME_SECS)));
    }

    #[test]
    fn signing_is_deterministic() {
        let a = token(&key(), "https://a.example", "mailto:a@b.example", 5).unwrap();
        let b = token(&key(), "https://a.example", "mailto:a@b.example", 5).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn the_authorization_header_carries_the_token_and_the_public_key() {
        let h = authorization(
            &key(),
            "https://fcm.googleapis.com",
            "mailto:weather@mukoko.com",
            1_700_000_000,
        )
        .unwrap();
        let rest = h.strip_prefix("vapid t=").unwrap();
        let (jwt, k) = rest.split_once(", k=").unwrap();
        assert_eq!(k, TEST_PUBLIC);
        assert_eq!(jwt.matches('.').count(), 2);
    }

    #[test]
    fn the_audience_must_be_a_bare_https_origin() {
        for bad in [
            "",
            "http://fcm.googleapis.com",
            "https://",
            "https://fcm.googleapis.com/fcm/send/abc",
            "https://user@fcm.googleapis.com",
            "fcm.googleapis.com",
        ] {
            assert_eq!(
                token(&key(), bad, "mailto:a@b.example", 1),
                Err(VapidError::BadAudience),
                "{bad}"
            );
        }
    }

    #[test]
    fn the_contact_must_be_a_mailto_or_https_uri() {
        for ok in [
            "mailto:weather@mukoko.com",
            "https://weather.mukoko.com/contact",
        ] {
            assert!(token(&key(), "https://a.example", ok, 1).is_ok(), "{ok}");
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
                token(&key(), "https://a.example", bad, 1),
                Err(VapidError::BadSubject),
                "{bad:?}"
            );
        }
        let long = format!("mailto:{}@mukoko.com", "a".repeat(200));
        assert_eq!(
            token(&key(), "https://a.example", &long, 1),
            Err(VapidError::BadSubject)
        );
    }

    #[test]
    fn a_bad_private_key_is_refused_and_never_printed() {
        assert_eq!(
            VapidKey::from_b64url("short").unwrap_err(),
            VapidError::BadKey
        );
        assert_eq!(
            VapidKey::from_bytes(&[0u8; 32]).unwrap_err(),
            VapidError::BadKey
        );
        let shown = format!("{:?}", key());
        assert!(!shown.contains(TEST_PRIVATE));
        assert!(shown.contains(TEST_PUBLIC));
    }
}
