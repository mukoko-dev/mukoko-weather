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
//! The crate is pure. It holds no key, reads no clock, draws no random number
//! and opens no connection: the VAPID private key, the current time, the
//! per-message salt and ephemeral key all arrive as arguments, and the network
//! is the caller's [`request::Transport`]. So it tests natively against the
//! RFCs' own vectors, builds for `wasm32-unknown-unknown` with no JS shim, and
//! this crate alone cannot send anything. Delivery is best effort: a push
//! service may drop, delay or never deliver a message, and nothing here
//! promises otherwise.
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
