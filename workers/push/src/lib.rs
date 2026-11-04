//! `mukoko-weather-push`: the Workers-runtime half of the Web Push sender
//! (mukoko-dev/mukoko-weather#289, step c). **Dark and not deployed.**
//!
//! The protocol is `weather-webpush` (RFC 8291 encryption, RFC 8292 VAPID,
//! RFC 8030 request): pure Rust that holds no key and opens no connection, and
//! takes the three things only a runtime can do as injected traits. This crate
//! is those three, over what a Worker has:
//!
//! - [`webcrypto::WebCryptoKeyAgreement`]: `KeyAgreement` over WebCrypto (an
//!   ephemeral ECDH P-256 key pair per message, the shared secret with the
//!   browser's `p256dh`).
//! - [`webcrypto::WebCryptoSigner`]: `Es256Signer` over WebCrypto (ECDSA P-256
//!   with SHA-256, the raw 64-octet `r || s` a JWT carries). The private key is
//!   a VALUE the caller passes in; nothing here reads a secret binding, stores
//!   a key or logs one.
//! - [`transport::WorkerPushTransport`]: `Transport` over `fetch` (one POST to
//!   a known push service, no redirects, the answer's body never read, one
//!   deadline).
//!
//! Each is thin. What can be decided without a runtime is decided in
//! `weather_webpush::runtime` and tested natively there, and that crate's
//! `tripwire` tests read the source of this one to pin that it keeps to those
//! rules (the glue itself needs a Workers runtime to run).
//!
//! **What is NOT here, on purpose:** a scheduled handler, a cron trigger, a send
//! route, a route to alert targets, a queue, a Secrets Store binding, a
//! `workers.dev` address or a custom domain. The one route is `GET /health`.
//! Nothing in this repository can send a push yet; the VAPID key pair, the
//! sender key and the evaluator tick are the owner's and later steps'
//! (`workers/README.md`, "Web Push alerts").

pub mod transport;
pub mod webcrypto;

use weather_edge::{error, json};
use worker::{event, Context, Env, Method, Request, Response, Result};

#[event(fetch)]
pub async fn fetch(req: Request, _env: Env, _ctx: Context) -> Result<Response> {
    match (req.path().as_str(), req.method()) {
        ("/health", Method::Get) => json(
            200,
            &serde_json::json!({"service": "mukoko-weather-push", "status": "ok"}),
        ),
        ("/health", _) => error(405, "method_not_allowed", "Only GET is served."),
        _ => error(404, "not_found", "No such route."),
    }
}
