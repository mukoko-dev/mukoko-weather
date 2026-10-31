//! The Web Push protocol for the Mukoko Weather push Worker
//! (mukoko-dev/mukoko-weather#289, step c).
//!
//! Three published standards, and nothing of ours:
//!
//! - [`encrypt`]: RFC 8291 message encryption with the RFC 8188 `aes128gcm`
//!   content coding.
//! - [`vapid`]: RFC 8292 voluntary application server identification (an
//!   ES256 JWT in an `Authorization: vapid` header).
//! - [`request`]: RFC 8030 request assembly (`TTL`, `Urgency`, the encrypted
//!   body) and the injected [`request::Transport`] that actually POSTs it.
//!
//! The crate is pure. It holds no key, reads no clock, draws no random number,
//! does no elliptic-curve arithmetic and opens no connection. The runtime
//! injects every one of those: the VAPID signature
//! ([`vapid::Es256Signer`], which owns the private key), the ECDH key
//! agreement ([`encrypt::KeyAgreement`]), the POST ([`request::Transport`]),
//! the current time and the per-message salt. No Rust elliptic-curve crate is
//! a dependency (the RustCrypto chain currently resolves `crypto-bigint` 0.5,
//! RUSTSEC-2026-0387, and a security finding stays open until the owner
//! decides): a Worker's runtime does ECDH and ECDSA natively with WebCrypto.
//! What stays here is everything that is deterministic and checkable against
//! the RFCs: the HKDF-SHA-256 key derivation, the AES-128-GCM record, the
//! header, the JWT, the request. So the crate tests natively on the RFCs' own
//! vectors, builds for `wasm32-unknown-unknown` with no JS shim, and cannot
//! send anything by itself. Delivery is best effort: a push service may drop,
//! delay or never deliver a message, and nothing here promises otherwise.
//!
//! What decides WHETHER to alert (preferences, quiet hours, caps, dedupe) is
//! `weather_core::push`; this crate only carries a decided alert to a browser.

use base64::alphabet;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};

pub mod encrypt;
pub mod request;
pub mod vapid;

/// base64url as the Web Push specs use it (RFC 4648 section 5): no padding
/// when encoding. Decoding tolerates `=` padding and non-canonical trailing
/// bits, because browsers differ on both and a subscription that works in one
/// must not be refused in another.
pub(crate) const B64URL: GeneralPurpose = GeneralPurpose::new(
    &alphabet::URL_SAFE,
    GeneralPurposeConfig::new()
        .with_encode_padding(false)
        .with_decode_allow_trailing_bits(true)
        .with_decode_padding_mode(DecodePaddingMode::Indifferent),
);
