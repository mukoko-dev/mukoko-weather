//! `mukoko-weather-push`: the Workers-runtime half of the Web Push sender
//! (mukoko-dev/mukoko-weather#289, #579).
//!
//! The protocol is `weather-webpush` (RFC 8291 encryption, RFC 8292 VAPID,
//! RFC 8030 request): pure Rust that holds no key and opens no connection, and
//! takes the things only a runtime can do as injected traits. This crate is
//! those, over what a Worker has:
//!
//! - [`webcrypto::WebCryptoKeyAgreement`]: `KeyAgreement` over WebCrypto (an
//!   ephemeral ECDH P-256 key pair per message, the shared secret with the
//!   browser's `p256dh`).
//! - [`webcrypto::WebCryptoSigner`]: `Es256Signer` over WebCrypto (ECDSA P-256
//!   with SHA-256, the raw 64-octet `r || s` a JWT carries). The private key is
//!   a VALUE the caller passes in; nothing in the signer reads a secret
//!   binding, stores a key or logs one.
//! - [`transport::WorkerPushTransport`]: `Transport` over `fetch` (one POST to
//!   a known push service, no redirects, the answer's body never read, one
//!   deadline).
//! - [`random::salt`]: the 16-octet salt of a message.
//! - [`send::send`]: one push, start to finish, over the four above.
//!
//! **The Worker has two routes, and nothing else.**
//!
//! - `GET /health`: liveness.
//! - `POST /send`: push ONE alert, already decided and already claimed in the
//!   delivery log by the caller, to ONE subscription. The body is
//!   `weather_core::push_wire`'s; the answer is a classified outcome and the
//!   push service's status, never the endpoint, a key or a body.
//!
//! **Who can call `/send`.** Nobody from outside: no route, no `workers.dev`
//! address (`wrangler.jsonc`). The one caller is `mukoko-weather-jobs` over its
//! `PUSH` service binding, and the request must carry
//! `Authorization: Bearer <PUSH_SEND_KEY>`, the same Secrets Store value the
//! caller holds. With no key configured the route answers `503`, so it fails
//! closed; it never opens. The key is checked BEFORE the body is read.
//!
//! **Where the secrets are read: here, in the entry, and nowhere else.** This
//! file reads `PUSH_SEND_KEY` and `VAPID_PRIVATE_KEY` from the Secrets Store and
//! the public key and contact from vars, and hands each to [`send::send`] as a
//! value. The sender modules read no environment and log nothing; the tripwires
//! in `crates/weather-webpush/src/tripwire.rs` hold that line. This file logs
//! one thing, a stable failure CODE, and only for a failure of ours: never an
//! endpoint, a key, a header or a body.
//!
//! What it does NOT do: decide whether to alert, read the delivery log, know a
//! person, schedule anything or hold state. All of that is the caller's.

pub mod random;
pub mod send;
pub mod transport;
pub mod webcrypto;

use serde_json::json;
use weather_core::auth::{gate, Gate};
use weather_core::push_wire::{encode_answer, MAX_SEND_BODY_BYTES};
use weather_core::secrets::{PUSH_SEND_KEY, VAPID_PRIVATE_KEY};
use weather_edge::{config, error, json, log_throttled, now_ms, secret};
use worker::{event, Context, Env, Method, Request, Response, Result};

#[event(fetch)]
pub async fn fetch(mut req: Request, env: Env, _ctx: Context) -> Result<Response> {
    match (req.path().as_str(), req.method()) {
        ("/health", Method::Get) => json(
            200,
            &json!({"service": "mukoko-weather-push", "status": "ok"}),
        ),
        ("/send", Method::Post) => send_route(&mut req, &env).await,
        ("/health", _) => error(405, "method_not_allowed", "Only GET is served."),
        ("/send", _) => error(405, "method_not_allowed", "Only POST is served."),
        _ => error(404, "not_found", "No such route."),
    }
}

async fn send_route(req: &mut Request, env: &Env) -> Result<Response> {
    // The caller first, before anything is read: the key, in constant time.
    let expected = secret(env, PUSH_SEND_KEY).await;
    let presented = req.headers().get("Authorization").ok().flatten();
    match gate(presented.as_deref(), expected.as_deref()) {
        Gate::Allowed => {}
        Gate::NotConfigured => {
            log_throttled("push-send-key", true, "push: no send key configured");
            return error(503, "not_configured", "The sender is not configured.");
        }
        Gate::Unauthorized => {
            let resp = error(401, "unauthorized", "A valid service key is required.")?;
            resp.headers().set("WWW-Authenticate", "Bearer")?;
            return Ok(resp);
        }
    }

    // The sender's own configuration. All three are the owner's; until they are
    // set the sender cannot send and says so, once, in the log.
    let private = secret(env, VAPID_PRIVATE_KEY).await;
    let public = config(env, "VAPID_PUBLIC_KEY");
    let subject = config(env, "VAPID_SUBJECT");
    let (Some(private), Some(public), Some(subject)) = (private, public, subject) else {
        log_throttled(
            "push-not-configured",
            true,
            "push: the VAPID key, public key or contact is not set",
        );
        return error(503, "not_configured", "The sender is not configured.");
    };

    // Bounded before it is read, and again after: a declared length can lie
    // and a chunked body declares none.
    let declared = req
        .headers()
        .get("Content-Length")
        .ok()
        .flatten()
        .and_then(|v| v.trim().parse::<usize>().ok());
    if declared.is_some_and(|n| n > MAX_SEND_BODY_BYTES) {
        return error(413, "body_too_large", "The request body is too large.");
    }
    let Ok(body) = req.bytes().await else {
        return error(400, "malformed_body", "The request body could not be read.");
    };
    if body.len() > MAX_SEND_BODY_BYTES {
        return error(413, "body_too_large", "The request body is too large.");
    }

    match send::send(&body, &private, &public, &subject, now_ms() / 1000).await {
        Ok(answer) => json(200, &encode_answer(&answer)),
        Err(failure) => {
            // A 5xx is ours (a key that does not match, a contact that is not a
            // URI, a runtime without crypto): loud, by its code. A 4xx is the
            // caller's request and is not logged here.
            if failure.status >= 500 {
                log_throttled(
                    "push-unavailable",
                    true,
                    &["push: send unavailable: ", failure.code].concat(),
                );
            }
            error(
                failure.status,
                failure.code,
                if failure.status >= 500 {
                    "The sender cannot send right now."
                } else {
                    "The request was not accepted."
                },
            )
        }
    }
}
