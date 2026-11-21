//! One push, start to finish: the body of `POST /send` in, a classified outcome
//! out. Everything it needs from the environment is an ARGUMENT: the VAPID key
//! pair, the contact and the clock are values the entry (`lib.rs`) read and
//! passed in, so nothing in this file reads a secret, a var or a binding, and
//! nothing in it logs (tripwires in `crates/weather-webpush/src/tripwire.rs`).
//!
//! The order is the safety property:
//!
//! 1. the body is read and checked by `weather_core::push_wire::parse_send`
//!    (bounds, an endpoint on the push-service allow list, keys that are keys,
//!    the frost payload and nothing else) BEFORE any key is imported;
//! 2. the VAPID key is imported and proved against its public half;
//! 3. the request is built (`weather_webpush::request::build`: the allow list
//!    again, encryption, the VAPID token for that service's origin only);
//! 4. the transport checks the request once more (`check_request`) and POSTs.
//!
//! What comes back is a [`SendAnswer`]: a class of outcome, the push service's
//! status and `Retry-After`, never the endpoint, a key or a body.

use weather_core::push_wire::{parse_send, SendAnswer};
use weather_webpush::request::{self, Identity, Options, Subscription, Urgency};

use crate::random;
use crate::transport::WorkerPushTransport;
use crate::webcrypto::{WebCryptoKeyAgreement, WebCryptoSigner};

/// Why a request got no answer from a push service. `status` is the HTTP status
/// `/send` returns and `code` a stable snake_case word; neither says what the
/// request held.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Failure {
    pub status: u16,
    pub code: &'static str,
}

/// The request is not acceptable: the caller's fault, and retrying it as it is
/// will not change anything.
const BAD_REQUEST: u16 = 422;
/// The sender cannot send right now (its key, its runtime): the caller should
/// stop sending for this tick, and a later tick will try again.
const UNAVAILABLE: u16 = 503;

/// Push one alert to one subscription.
pub async fn send(
    body: &[u8],
    vapid_private: &str,
    vapid_public: &str,
    subject: &str,
    now_unix: u64,
) -> Result<SendAnswer, Failure> {
    let wanted = parse_send(body).map_err(|e| Failure {
        status: BAD_REQUEST,
        code: e.code(),
    })?;

    let signer = WebCryptoSigner::import(vapid_private, vapid_public)
        .await
        .map_err(|e| Failure {
            status: UNAVAILABLE,
            code: e.code(),
        })?;
    let salt = random::salt().ok_or(Failure {
        status: UNAVAILABLE,
        code: "crypto_unavailable",
    })?;

    let subscription = Subscription {
        endpoint: &wanted.endpoint,
        p256dh: &wanted.p256dh,
        auth: &wanted.auth,
    };
    let identity = Identity {
        signer: &signer,
        subject,
        now_unix,
    };
    let options = Options {
        ttl_secs: wanted.ttl_seconds,
        urgency: match wanted.urgency {
            weather_core::push::Urgency::High => Urgency::High,
            _ => Urgency::Normal,
        },
    };

    match request::send(
        &WorkerPushTransport,
        &subscription,
        &wanted.payload,
        &identity,
        &options,
        &WebCryptoKeyAgreement,
        &salt,
    )
    .await
    {
        Ok(delivery) => Ok(SendAnswer {
            outcome: delivery.outcome,
            provider_code: delivery.provider_code,
            retry_after_secs: delivery.retry_after_secs,
            reason: None,
        }),
        // A subscription that cannot be encrypted to will never work: a final
        // failure of that one send, with the reason, and the batch goes on.
        Err(e) if e.subscription_is_unusable() => Ok(SendAnswer {
            outcome: weather_core::push::Outcome::Failed,
            provider_code: None,
            retry_after_secs: None,
            reason: Some(e.code()),
        }),
        // Anything else (a contact that is not a mailto or https URI, a signer
        // that failed) is ours, and every send would meet it.
        Err(e) => Err(Failure {
            status: UNAVAILABLE,
            code: e.code(),
        }),
    }
}
