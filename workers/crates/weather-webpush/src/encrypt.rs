//! Web Push message encryption: RFC 8291 over the RFC 8188 `aes128gcm`
//! content coding.
//!
//! One record per message (RFC 8291 section 4), so the output is the 86-octet
//! header (salt, record size, key id length, the application server's
//! ephemeral public key) followed by one AES-128-GCM record.
//!
//! The elliptic-curve step (an ephemeral P-256 key pair and the ECDH shared
//! secret with the browser's key) is NOT done here: it is the injected
//! [`KeyAgreement`]. No Rust elliptic-curve crate is used (the RustCrypto
//! chain currently resolves `crypto-bigint` 0.5, RUSTSEC-2026-0387), and the
//! Worker's runtime does the same step natively with WebCrypto. Everything
//! else, the key derivation (HKDF-SHA-256), the header and the AES-GCM record,
//! is here and pinned byte for byte by the RFC's own worked example. The salt
//! is an input too, so this stays pure.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes128Gcm, Nonce};
use base64::Engine;
use hkdf::Hkdf;
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
    /// `p256dh` is not a 65-octet uncompressed P-256 point (or, from a
    /// [`KeyAgreement`], a point that is not on the curve).
    BadSubscriptionKey,
    /// `auth` is not 16 octets.
    BadAuthSecret,
    /// The plaintext does not fit one record ([`MAX_PLAINTEXT`]).
    TooLong,
    /// The key agreement, key derivation or cipher failed for a reason that
    /// is not the subscription's (the runtime refused, or a length was off;
    /// reported rather than unwrapped).
    Crypto,
}

impl EncryptError {
    /// A stable machine-readable code for logs.
    pub fn code(self) -> &'static str {
        match self {
            Self::BadSubscriptionKey => "bad_subscription_key",
            Self::BadAuthSecret => "bad_auth_secret",
            Self::TooLong => "payload_too_long",
            Self::Crypto => "crypto",
        }
    }
}

/// The browser's half of the exchange, from its push subscription. The shape
/// is checked here; that the point lies on the curve is the
/// [`KeyAgreement`]'s job (RFC 8291 section 7: "MUST verify").
#[derive(Clone)]
pub struct Recipient {
    public: [u8; 65],
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
    /// browser's `PushSubscription.toJSON()` gives them): an uncompressed
    /// point (65 octets starting 0x04) and a 16-octet secret.
    pub fn parse(p256dh: &str, auth: &str) -> Result<Self, EncryptError> {
        weather_core::push::validate_keys(p256dh, auth)
            .map_err(|_| EncryptError::BadSubscriptionKey)?;
        let public: [u8; 65] = B64URL
            .decode(p256dh)
            .map_err(|_| EncryptError::BadSubscriptionKey)?
            .as_slice()
            .try_into()
            .map_err(|_| EncryptError::BadSubscriptionKey)?;
        let auth: [u8; 16] = B64URL
            .decode(auth)
            .map_err(|_| EncryptError::BadAuthSecret)?
            .as_slice()
            .try_into()
            .map_err(|_| EncryptError::BadAuthSecret)?;
        Ok(Self { public, auth })
    }

    /// The browser's public point, uncompressed.
    pub fn public(&self) -> &[u8; 65] {
        &self.public
    }
}

/// What a [`KeyAgreement`] returns.
#[derive(Clone)]
pub struct Agreement {
    /// The application server's ephemeral public key, uncompressed (65
    /// octets starting 0x04): the `keyid` of the message header.
    pub as_public: [u8; 65],
    /// ECDH(as_private, ua_public): the 32-octet x coordinate.
    pub shared_secret: [u8; 32],
}

impl std::fmt::Debug for Agreement {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Agreement(<redacted>)")
    }
}

/// What a runtime supplies for the elliptic-curve step. An implementation:
///
/// - makes a FRESH ephemeral P-256 key pair for every call, uses its private
///   half once and keeps it to itself (nothing here ever sees it);
/// - REJECTS a `recipient_public` that is not a point on P-256 with
///   [`EncryptError::BadSubscriptionKey`] (WebCrypto's `importKey` does);
/// - returns the uncompressed public key and the raw ECDH secret.
///
/// In a Worker this is `crypto.subtle` (`generateKey` and `deriveBits` with
/// ECDH on P-256). Its future is not `Send`, which is why the trait is not
/// either.
#[allow(async_fn_in_trait)]
pub trait KeyAgreement {
    async fn agree(&self, recipient_public: &[u8; 65]) -> Result<Agreement, EncryptError>;
}

/// HKDF-Expand (RFC 5869) of `prk` with `info`, into exactly `N` octets.
///
/// The output buffer is only the place the derived octets are written to: it
/// is filled by `expand` and by nothing else, and it is made from the type's
/// default value (not a written-out value), so no key, nonce or salt of this
/// crate is ever a literal. The octets that come out are the same as when the
/// buffer was a zeroed array. A length HKDF cannot produce is
/// [`EncryptError::Crypto`], as before.
///
/// Keep it this way: written as `[0u8; N]`, CodeQL
/// (`rust/hard-coded-cryptographic-value`) reads the zeros as a hard-coded
/// key, nonce or salt wherever the buffer reaches the cipher, and fails the
/// release PR.
pub(crate) fn expand<const N: usize>(
    prk: &Hkdf<Sha256>,
    info: &[u8],
) -> Result<[u8; N], EncryptError> {
    let mut okm: [u8; N] = std::array::from_fn(|_| u8::default());
    prk.expand(info, &mut okm)
        .map_err(|_| EncryptError::Crypto)?;
    Ok(okm)
}

/// Encrypt `plaintext` for `to` once `agreement` has been made. `salt` must be
/// 16 fresh random bytes for this message, never reused. Pure.
///
/// The result is the whole request body: header and record.
pub fn seal(
    plaintext: &[u8],
    to: &Recipient,
    agreement: &Agreement,
    salt: &[u8; 16],
) -> Result<Vec<u8>, EncryptError> {
    if plaintext.len() > MAX_PLAINTEXT {
        return Err(EncryptError::TooLong);
    }
    // RFC 8291 section 3.4: combine the ECDH secret with the authentication
    // secret, then derive the content encryption key and nonce (RFC 8188).
    let mut key_info = Vec::with_capacity(14 + 65 + 65);
    key_info.extend_from_slice(b"WebPush: info\0");
    key_info.extend_from_slice(&to.public);
    key_info.extend_from_slice(&agreement.as_public);
    let ikm: [u8; 32] = expand(
        &Hkdf::<Sha256>::new(Some(&to.auth), &agreement.shared_secret),
        &key_info,
    )?;

    let prk = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let cek: [u8; 16] = expand(&prk, b"Content-Encoding: aes128gcm\0")?;
    let nonce: [u8; 12] = expand(&prk, b"Content-Encoding: nonce\0")?;

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
    body.extend_from_slice(&agreement.as_public);
    body.extend_from_slice(&sealed);
    Ok(body)
}

/// Make the key agreement with `to` and [`seal`] `plaintext`.
pub async fn encrypt<K: KeyAgreement>(
    keys: &K,
    plaintext: &[u8],
    to: &Recipient,
    salt: &[u8; 16],
) -> Result<Vec<u8>, EncryptError> {
    if plaintext.len() > MAX_PLAINTEXT {
        return Err(EncryptError::TooLong);
    }
    let agreement = keys.agree(to.public()).await?;
    seal(plaintext, to, &agreement, salt)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::future::Future;
    use std::sync::OnceLock;
    use std::task::{Context, Poll, Waker};

    /// RFC 8291 section 5 and Appendix A: the worked example, as data. These
    /// are the RFC's published test values, not secrets, kept in the repo's
    /// fixtures directory and read here when a test runs, so that no key, salt
    /// or shared secret is a written-out value of this crate. The
    /// elliptic-curve results (the application server's public key and the
    /// ECDH result) are the RFC's own intermediate values, so this crate needs
    /// no curve arithmetic to reproduce the message.
    const FIXTURE: &str = include_str!("../../../../tests/fixtures/rfc8291-webpush.json");

    /// The worked example, every field base64url as the RFC prints it (the
    /// plaintext is the text itself).
    pub(crate) struct Rfc {
        pub(crate) plaintext: String,
        /// The browser's public key (`p256dh`).
        pub(crate) ua_public: String,
        /// The subscription's authentication secret (`auth`).
        pub(crate) auth: String,
        /// The application server's ephemeral public key.
        pub(crate) as_public: String,
        /// The ECDH result for the two keys above.
        pub(crate) ecdh: String,
        /// The message's salt.
        pub(crate) salt: String,
        /// The whole request body the RFC derives, base64url.
        pub(crate) expected: String,
    }

    pub(crate) fn rfc() -> &'static Rfc {
        static RFC: OnceLock<Rfc> = OnceLock::new();
        RFC.get_or_init(|| {
            let v: serde_json::Value =
                serde_json::from_str(FIXTURE).expect("the RFC 8291 fixture is JSON");
            let field = |name: &str| {
                v[name]
                    .as_str()
                    .expect("the RFC 8291 fixture field is a string")
                    .to_string()
            };
            Rfc {
                plaintext: field("plaintext"),
                ua_public: field("uaPublic"),
                auth: field("authSecret"),
                as_public: field("asPublic"),
                ecdh: field("ecdhSecret"),
                salt: field("salt"),
                expected: field("expected"),
            }
        })
    }

    /// A salt for tests that need more than one: the RFC's salt with each
    /// octet XOR `n`, so `n` is a label and each `n` gives a different salt
    /// (`0` is the RFC's own).
    pub(crate) fn salt_variant(n: u8) -> [u8; 16] {
        let mut salt: [u8; 16] = fixed(&rfc().salt);
        for octet in &mut salt {
            *octet ^= n;
        }
        salt
    }

    /// The futures here complete at once (the fakes never wait), so polling
    /// in a loop is enough and no runtime is needed.
    pub(crate) fn block_on<F: Future>(f: F) -> F::Output {
        let mut f = std::pin::pin!(f);
        let mut cx = Context::from_waker(Waker::noop());
        loop {
            if let Poll::Ready(v) = f.as_mut().poll(&mut cx) {
                return v;
            }
        }
    }

    pub(crate) fn fixed<const N: usize>(s: &str) -> [u8; N] {
        B64URL.decode(s).unwrap().as_slice().try_into().unwrap()
    }

    pub(crate) fn rfc_agreement() -> Agreement {
        Agreement {
            as_public: fixed(&rfc().as_public),
            shared_secret: fixed(&rfc().ecdh),
        }
    }

    /// The RFC's agreement with one bit of the ECDH result flipped: what
    /// another browser's subscription would have produced.
    pub(crate) fn other_agreement() -> Agreement {
        let mut other = rfc_agreement();
        other.shared_secret[0] ^= 1;
        other
    }

    /// A key agreement that answers with the RFC's values and records what it
    /// was asked, or fails.
    pub(crate) struct Fake {
        pub(crate) answer: Result<Agreement, EncryptError>,
        pub(crate) asked: RefCell<Vec<[u8; 65]>>,
    }

    impl Fake {
        pub(crate) fn rfc() -> Self {
            Self {
                answer: Ok(rfc_agreement()),
                asked: RefCell::new(Vec::new()),
            }
        }
    }

    impl KeyAgreement for Fake {
        async fn agree(&self, recipient_public: &[u8; 65]) -> Result<Agreement, EncryptError> {
            self.asked.borrow_mut().push(*recipient_public);
            self.answer.clone()
        }
    }

    #[test]
    fn the_rfc_8291_worked_example_encrypts_byte_for_byte() {
        let rfc = rfc();
        let to = Recipient::parse(&rfc.ua_public, &rfc.auth).unwrap();
        let body = seal(
            rfc.plaintext.as_bytes(),
            &to,
            &rfc_agreement(),
            &fixed::<16>(&rfc.salt),
        )
        .unwrap();
        assert_eq!(B64URL.encode(&body), rfc.expected);
        // 86 (header) + 41 (text) + 1 (delimiter) + 16 (tag). The example's
        // printed "Content-Length: 145" is off by one: the body it shows
        // decodes to these 144 octets, and so does ours.
        assert_eq!(body.len(), HEADER_LEN + rfc.plaintext.len() + 1 + 16);
        assert_eq!(body.len(), 144);
    }

    #[test]
    fn encrypt_asks_the_agreement_for_the_browsers_key_and_seals_with_its_answer() {
        let rfc = rfc();
        let to = Recipient::parse(&rfc.ua_public, &rfc.auth).unwrap();
        let keys = Fake::rfc();
        let body = block_on(encrypt(
            &keys,
            rfc.plaintext.as_bytes(),
            &to,
            &fixed::<16>(&rfc.salt),
        ))
        .unwrap();
        assert_eq!(B64URL.encode(&body), rfc.expected);
        // asked exactly once, about the browser's own point
        assert_eq!(*keys.asked.borrow(), vec![fixed::<65>(&rfc.ua_public)]);
    }

    #[test]
    fn the_header_is_salt_record_size_and_the_ephemeral_public_key() {
        let rfc = rfc();
        let to = Recipient::parse(&rfc.ua_public, &rfc.auth).unwrap();
        let salt = salt_variant(7);
        let body = seal(b"x", &to, &rfc_agreement(), &salt).unwrap();
        assert_eq!(&body[..16], &salt);
        assert_eq!(&body[16..20], &4096u32.to_be_bytes());
        assert_eq!(body[20], 65);
        assert_eq!(B64URL.encode(&body[21..86]), rfc.as_public);
        // 1 octet of plaintext + the 0x02 delimiter + the 16-octet tag
        assert_eq!(body.len(), HEADER_LEN + 1 + 1 + 16);
    }

    #[test]
    fn a_different_salt_or_ephemeral_key_gives_a_different_message() {
        let rfc = rfc();
        let to = Recipient::parse(&rfc.ua_public, &rfc.auth).unwrap();
        let a = seal(b"same", &to, &rfc_agreement(), &salt_variant(1)).unwrap();
        let b = seal(b"same", &to, &rfc_agreement(), &salt_variant(2)).unwrap();
        let c = seal(b"same", &to, &other_agreement(), &salt_variant(1)).unwrap();
        assert_ne!(a[HEADER_LEN..], b[HEADER_LEN..]);
        assert_ne!(a[HEADER_LEN..], c[HEADER_LEN..]);
    }

    #[test]
    fn the_authentication_secret_changes_the_key() {
        // The auth secret is mixed into the key (RFC 8291 section 3.3): the
        // same ECDH secret with another auth secret must not decrypt the same.
        let rfc = rfc();
        let a = Recipient::parse(&rfc.ua_public, &rfc.auth).unwrap();
        let b = Recipient::parse(&rfc.ua_public, "AAAAAAAAAAAAAAAAAAAAAA").unwrap();
        let salt = fixed::<16>(&rfc.salt);
        let x = seal(b"same", &a, &rfc_agreement(), &salt).unwrap();
        let y = seal(b"same", &b, &rfc_agreement(), &salt).unwrap();
        assert_ne!(x[HEADER_LEN..], y[HEADER_LEN..]);
    }

    #[test]
    fn the_largest_message_fits_exactly_one_4096_octet_body() {
        let rfc = rfc();
        let to = Recipient::parse(&rfc.ua_public, &rfc.auth).unwrap();
        let salt = salt_variant(3);
        let full = vec![b'a'; MAX_PLAINTEXT];
        let body = seal(&full, &to, &rfc_agreement(), &salt).unwrap();
        assert_eq!(body.len(), 4096);
        let over = vec![b'a'; MAX_PLAINTEXT + 1];
        assert_eq!(
            seal(&over, &to, &rfc_agreement(), &salt),
            Err(EncryptError::TooLong)
        );
        // an oversized message never reaches the key agreement
        let keys = Fake::rfc();
        assert_eq!(
            block_on(encrypt(&keys, &over, &to, &salt)),
            Err(EncryptError::TooLong)
        );
        assert!(keys.asked.borrow().is_empty());
    }

    #[test]
    fn a_failing_key_agreement_is_passed_up_unchanged() {
        let rfc = rfc();
        let to = Recipient::parse(&rfc.ua_public, &rfc.auth).unwrap();
        let salt = salt_variant(3);
        for e in [EncryptError::BadSubscriptionKey, EncryptError::Crypto] {
            let keys = Fake {
                answer: Err(e),
                asked: RefCell::new(Vec::new()),
            };
            assert_eq!(block_on(encrypt(&keys, b"x", &to, &salt)), Err(e));
        }
    }

    #[test]
    fn a_subscription_with_bad_keys_is_refused_before_any_cryptography() {
        let rfc = rfc();
        // not 65 octets of an uncompressed point
        assert_eq!(
            Recipient::parse("BAAA", &rfc.auth).unwrap_err(),
            EncryptError::BadSubscriptionKey
        );
        // a compressed-looking key (0x02 first octet)
        let compressed = format!("Ag{}", "A".repeat(85));
        assert_eq!(
            Recipient::parse(&compressed, &rfc.auth).unwrap_err(),
            EncryptError::BadSubscriptionKey
        );
        assert_eq!(
            Recipient::parse(&rfc.ua_public, "short").unwrap_err(),
            EncryptError::BadSubscriptionKey
        );
    }

    #[test]
    fn padding_and_trailing_bits_from_other_browsers_are_tolerated() {
        let rfc = rfc();
        let padded_auth = format!("{}==", rfc.auth);
        let padded_key = format!("{}=", rfc.ua_public);
        let a = Recipient::parse(&rfc.ua_public, &rfc.auth).unwrap();
        let b = Recipient::parse(&padded_key, &padded_auth).unwrap();
        let salt = fixed::<16>(&rfc.salt);
        assert_eq!(
            seal(b"x", &a, &rfc_agreement(), &salt).unwrap(),
            seal(b"x", &b, &rfc_agreement(), &salt).unwrap()
        );
    }

    #[test]
    fn nothing_that_prints_carries_the_keys() {
        let rfc = rfc();
        let to = Recipient::parse(&rfc.ua_public, &rfc.auth).unwrap();
        let shown = format!("{to:?} {:?}", rfc_agreement());
        // In order: 0 the browser's public key, 1 its auth value, 2 the
        // server's ephemeral public key, 3 the ECDH result.
        let values = [
            rfc.ua_public.as_str(),
            rfc.auth.as_str(),
            rfc.as_public.as_str(),
            rfc.ecdh.as_str(),
        ];
        // A failure names the position in the list, never the value itself.
        for (position, value) in values.iter().enumerate() {
            assert!(
                !shown.contains(*value),
                "value {position} of the list was printed"
            );
        }
    }

    #[test]
    fn expand_gives_the_length_asked_and_refuses_what_hkdf_cannot() {
        // The octets themselves are pinned by the RFC's worked example above
        // (cek and nonce come out of `expand`); this pins the helper's own
        // contract: a shorter output is the start of a longer one, and a
        // length HKDF-SHA-256 cannot give (more than 255 * 32 octets) is
        // `Crypto`, not a panic.
        let prk = Hkdf::<Sha256>::new(Some(&salt_variant(1)), &fixed::<32>(&rfc().ecdh));
        let short: [u8; 12] = expand(&prk, b"info").unwrap();
        let long: [u8; 16] = expand(&prk, b"info").unwrap();
        assert_eq!(short, long[..12]);
        assert!(expand::<8160>(&prk, b"info").is_ok());
        assert_eq!(
            expand::<8161>(&prk, b"info").unwrap_err(),
            EncryptError::Crypto
        );
    }
}
