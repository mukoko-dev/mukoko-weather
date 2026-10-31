//! Web Push message encryption: RFC 8291 over the RFC 8188 `aes128gcm`
//! content coding.
//!
//! One record per message (RFC 8291 section 4), so the output is the 86-octet
//! header (salt, record size, key id length, the application server's
//! ephemeral public key) followed by one AES-128-GCM record. The salt and the
//! ephemeral private key are INPUTS: the caller draws them from its random
//! source, once per message and never reused. That keeps this function pure
//! and lets the RFC's own worked example pin it byte for byte.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes128Gcm, Nonce};
use base64::Engine;
use hkdf::Hkdf;
use p256::ecdh::diffie_hellman;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use sha2::Sha256;

use crate::B64URL;

/// The `rs` field: the record size, RFC 8291 section 4 / RFC 8188 section 2.1.
/// Greater than plaintext + delimiter + tag for every message we send, and
/// the value the RFC's example uses. A push service is not required to take
/// more than 4096 octets of body, so this is also the ceiling.
pub const RECORD_SIZE: u32 = 4096;
/// Salt (16) + record size (4) + key id length (1) + uncompressed key (65).
pub const HEADER_LEN: usize = 86;
/// The most plaintext one message can carry: 4096 - 86 (header) - 1
/// (delimiter) - 16 (tag), RFC 8291 section 4.
pub const MAX_PLAINTEXT: usize = 3993;

/// The padding delimiter of the last (here, only) record, RFC 8188 section 2.
const LAST_RECORD_DELIMITER: u8 = 0x02;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncryptError {
    /// `p256dh` is not a 65-octet uncompressed P-256 point on the curve.
    BadSubscriptionKey,
    /// `auth` is not 16 octets.
    BadAuthSecret,
    /// The ephemeral private key is not a valid P-256 scalar.
    BadEphemeralKey,
    /// The plaintext does not fit one record ([`MAX_PLAINTEXT`]).
    TooLong,
    /// The key derivation or the cipher refused its input (cannot happen
    /// with the fixed lengths used here; reported rather than unwrapped).
    Crypto,
}

impl EncryptError {
    /// A stable machine-readable code for logs.
    pub fn code(self) -> &'static str {
        match self {
            Self::BadSubscriptionKey => "bad_subscription_key",
            Self::BadAuthSecret => "bad_auth_secret",
            Self::BadEphemeralKey => "bad_ephemeral_key",
            Self::TooLong => "payload_too_long",
            Self::Crypto => "crypto",
        }
    }
}

/// The browser's half of the exchange, from its push subscription.
#[derive(Clone)]
pub struct Recipient {
    public: PublicKey,
    public_bytes: [u8; 65],
    auth: [u8; 16],
}

impl std::fmt::Debug for Recipient {
    /// Both values are secrets of the subscription (with the endpoint they
    /// let anyone push to this browser): never printed.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Recipient(<redacted>)")
    }
}

impl Recipient {
    /// Parse the `p256dh` and `auth` of a subscription (base64url, as the
    /// browser's `PushSubscription.toJSON()` gives them). The point is checked
    /// to be on the curve (RFC 8291 section 7: "MUST verify").
    pub fn parse(p256dh: &str, auth: &str) -> Result<Self, EncryptError> {
        weather_core::push::validate_keys(p256dh, auth)
            .map_err(|_| EncryptError::BadSubscriptionKey)?;
        let point = B64URL
            .decode(p256dh)
            .map_err(|_| EncryptError::BadSubscriptionKey)?;
        let public_bytes: [u8; 65] = point
            .as_slice()
            .try_into()
            .map_err(|_| EncryptError::BadSubscriptionKey)?;
        let public = PublicKey::from_sec1_bytes(&public_bytes)
            .map_err(|_| EncryptError::BadSubscriptionKey)?;
        let auth: [u8; 16] = B64URL
            .decode(auth)
            .map_err(|_| EncryptError::BadAuthSecret)?
            .as_slice()
            .try_into()
            .map_err(|_| EncryptError::BadAuthSecret)?;
        Ok(Self {
            public,
            public_bytes,
            auth,
        })
    }
}

/// Encrypt `plaintext` for `to`. `salt` and `ephemeral_secret` must be fresh
/// random bytes for this message and are never reused.
///
/// The result is the whole request body: header and record.
pub fn encrypt(
    plaintext: &[u8],
    to: &Recipient,
    salt: &[u8; 16],
    ephemeral_secret: &[u8; 32],
) -> Result<Vec<u8>, EncryptError> {
    if plaintext.len() > MAX_PLAINTEXT {
        return Err(EncryptError::TooLong);
    }
    let secret =
        SecretKey::from_slice(ephemeral_secret).map_err(|_| EncryptError::BadEphemeralKey)?;
    let as_public = secret.public_key().to_encoded_point(false);
    let as_public = as_public.as_bytes();
    debug_assert_eq!(as_public.len(), 65);

    // RFC 8291 section 3.4: combine the ECDH secret with the authentication
    // secret, then derive the content encryption key and nonce (RFC 8188).
    let shared = diffie_hellman(secret.to_nonzero_scalar(), to.public.as_affine());

    let mut key_info = Vec::with_capacity(14 + 65 + 65);
    key_info.extend_from_slice(b"WebPush: info\0");
    key_info.extend_from_slice(&to.public_bytes);
    key_info.extend_from_slice(as_public);
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&to.auth), shared.raw_secret_bytes())
        .expand(&key_info, &mut ikm)
        .map_err(|_| EncryptError::Crypto)?;

    let prk = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let mut cek = [0u8; 16];
    prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek)
        .map_err(|_| EncryptError::Crypto)?;
    let mut nonce = [0u8; 12];
    prk.expand(b"Content-Encoding: nonce\0", &mut nonce)
        .map_err(|_| EncryptError::Crypto)?;

    let mut record = Vec::with_capacity(plaintext.len() + 1);
    record.extend_from_slice(plaintext);
    record.push(LAST_RECORD_DELIMITER);
    let sealed = Aes128Gcm::new_from_slice(&cek)
        .map_err(|_| EncryptError::Crypto)?
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &record,
                aad: &[],
            },
        )
        .map_err(|_| EncryptError::Crypto)?;

    let mut body = Vec::with_capacity(HEADER_LEN + sealed.len());
    body.extend_from_slice(salt);
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(65);
    body.extend_from_slice(as_public);
    body.extend_from_slice(&sealed);
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 8291 section 5 and Appendix A: the worked example. These are the
    // RFC's published test keys, not secrets.
    const PLAINTEXT: &str = "When I grow up, I want to be a watermelon";
    const UA_PUBLIC: &str =
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const AUTH_SECRET: &str = "BTBZMqHH6r4Tts7J_aSIgg";
    const AS_PRIVATE: &str = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
    const SALT: &str = "DGv6ra1nlYgDCS1FRnbzlw";
    const EXPECTED: &str = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

    fn b64(s: &str) -> Vec<u8> {
        B64URL.decode(s).unwrap()
    }

    fn fixed<const N: usize>(s: &str) -> [u8; N] {
        b64(s).as_slice().try_into().unwrap()
    }

    #[test]
    fn the_rfc_8291_worked_example_encrypts_byte_for_byte() {
        let to = Recipient::parse(UA_PUBLIC, AUTH_SECRET).unwrap();
        let body = encrypt(
            PLAINTEXT.as_bytes(),
            &to,
            &fixed::<16>(SALT),
            &fixed::<32>(AS_PRIVATE),
        )
        .unwrap();
        assert_eq!(B64URL.encode(&body), EXPECTED);
        // 86 (header) + 41 (text) + 1 (delimiter) + 16 (tag). The example's
        // printed "Content-Length: 145" is off by one: the body it shows
        // decodes to these 144 octets, and so does ours.
        assert_eq!(body.len(), HEADER_LEN + PLAINTEXT.len() + 1 + 16);
        assert_eq!(body.len(), 144);
    }

    #[test]
    fn the_header_is_salt_record_size_and_the_ephemeral_public_key() {
        let to = Recipient::parse(UA_PUBLIC, AUTH_SECRET).unwrap();
        let body = encrypt(b"x", &to, &[7u8; 16], &fixed::<32>(AS_PRIVATE)).unwrap();
        assert_eq!(&body[..16], &[7u8; 16]);
        assert_eq!(&body[16..20], &4096u32.to_be_bytes());
        assert_eq!(body[20], 65);
        // the key id is the RFC's published application server public key
        assert_eq!(
            B64URL.encode(&body[21..86]),
            "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
        );
        // 1 octet of plaintext + the 0x02 delimiter + the 16-octet tag
        assert_eq!(body.len(), HEADER_LEN + 1 + 1 + 16);
    }

    #[test]
    fn a_different_salt_or_ephemeral_key_gives_a_different_message() {
        let to = Recipient::parse(UA_PUBLIC, AUTH_SECRET).unwrap();
        let a = encrypt(b"same", &to, &[1u8; 16], &fixed::<32>(AS_PRIVATE)).unwrap();
        let b = encrypt(b"same", &to, &[2u8; 16], &fixed::<32>(AS_PRIVATE)).unwrap();
        let c = encrypt(b"same", &to, &[1u8; 16], &[9u8; 32]).unwrap();
        assert_ne!(a[HEADER_LEN..], b[HEADER_LEN..]);
        assert_ne!(a[21..86], c[21..86]);
        assert_ne!(a[HEADER_LEN..], c[HEADER_LEN..]);
    }

    #[test]
    fn the_largest_message_fits_exactly_one_4096_octet_body() {
        let to = Recipient::parse(UA_PUBLIC, AUTH_SECRET).unwrap();
        let full = vec![b'a'; MAX_PLAINTEXT];
        let body = encrypt(&full, &to, &[3u8; 16], &fixed::<32>(AS_PRIVATE)).unwrap();
        assert_eq!(body.len(), 4096);
        assert_eq!(
            encrypt(&vec![b'a'; MAX_PLAINTEXT + 1], &to, &[3u8; 16], &[9u8; 32]),
            Err(EncryptError::TooLong)
        );
    }

    #[test]
    fn a_subscription_with_bad_keys_is_refused_before_any_cryptography() {
        // not 65 octets of an uncompressed point
        assert_eq!(
            Recipient::parse("BAAA", AUTH_SECRET).unwrap_err(),
            EncryptError::BadSubscriptionKey
        );
        // right shape (starts 0x04, 87 characters) but not a point on P-256
        let off_curve = format!("BA{}", "A".repeat(85));
        assert_eq!(
            Recipient::parse(&off_curve, AUTH_SECRET).unwrap_err(),
            EncryptError::BadSubscriptionKey
        );
        assert_eq!(
            Recipient::parse(UA_PUBLIC, "short").unwrap_err(),
            EncryptError::BadSubscriptionKey
        );
        // the secret scalar zero is no key
        let to = Recipient::parse(UA_PUBLIC, AUTH_SECRET).unwrap();
        assert_eq!(
            encrypt(b"x", &to, &[0u8; 16], &[0u8; 32]),
            Err(EncryptError::BadEphemeralKey)
        );
    }

    #[test]
    fn padding_and_trailing_bits_from_other_browsers_are_tolerated() {
        let padded_auth = format!("{AUTH_SECRET}==");
        let padded_key = format!("{UA_PUBLIC}=");
        let a = Recipient::parse(UA_PUBLIC, AUTH_SECRET).unwrap();
        let b = Recipient::parse(&padded_key, &padded_auth).unwrap();
        let salt = fixed::<16>(SALT);
        let key = fixed::<32>(AS_PRIVATE);
        assert_eq!(
            encrypt(b"x", &a, &salt, &key).unwrap(),
            encrypt(b"x", &b, &salt, &key).unwrap()
        );
    }

    #[test]
    fn recipient_debug_never_prints_the_keys() {
        let to = Recipient::parse(UA_PUBLIC, AUTH_SECRET).unwrap();
        let shown = format!("{to:?}");
        assert!(!shown.contains(UA_PUBLIC) && !shown.contains(AUTH_SECRET));
    }
}
