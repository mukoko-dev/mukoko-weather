//! WebCrypto for the push sender: `KeyAgreement` (ECDH P-256) and
//! `Es256Signer` (ECDSA P-256 with SHA-256) over the Workers runtime's
//! `crypto.subtle`.
//!
//! **Dark and unwired.** Nothing constructs either type yet.
//!
//! This file is glue and stays thin. Every decision, and every check of what
//! WebCrypto handed back, is `weather_webpush::runtime` and is tested natively
//! there: the lengths and prefix of the exported public key and the shared
//! secret (`agreement_from_parts`), the 64 octets of `r || s`
//! (`signature_from_bytes`), which rejection is the subscription's fault
//! (`import_error`) and the JWK the private key is imported as
//! (`VapidKeyMaterial`). What this file adds is the calls themselves.
//!
//! - **No key is generated, read or stored.** The ECDH key pair is made for one
//!   message and dropped with it (non-extractable; its public half is exported,
//!   which WebCrypto always allows). The VAPID private key is a value the
//!   CALLER passes to [`WebCryptoSigner::import`]: it is made into a
//!   non-extractable `CryptoKey` and the string it came from is dropped. There
//!   is no secret binding, no environment access and no logging in this file.
//! - **A signer that does not match its public key never exists.**
//!   [`WebCryptoSigner::import`] signs a probe and verifies it with the public
//!   key before it returns, so a mismatched pair is `KeyError::Mismatch` at
//!   once, not a 403 from every push service afterwards.
//! - **`Debug` prints nothing of a key**, and the signer derives nothing.
//!
//! The one thing not covered by a native test is this file itself: it needs
//! `crypto.subtle`. `weather_webpush::tripwire` pins by source scan that it
//! keeps to the rules above, which is a tripwire and not a behaviour test.

use js_sys::{Array, ArrayBuffer, Object, Promise, Reflect, Uint8Array};
use wasm_bindgen_futures::JsFuture;
use weather_webpush::encrypt::{Agreement, EncryptError, KeyAgreement};
use weather_webpush::runtime::{
    agreement_from_parts, import_error, signature_from_bytes, KeyError, VapidKeyMaterial,
    KEY_PROBE, POINT_LEN,
};
use weather_webpush::vapid::{Es256Signer, VapidError};
use web_sys::{Crypto, CryptoKey, CryptoKeyPair, SubtleCrypto};
use worker::wasm_bindgen::{JsCast, JsValue};

/// `crypto.subtle` of the Worker's global scope.
fn subtle() -> Option<SubtleCrypto> {
    let crypto = Reflect::get(&js_sys::global(), &JsValue::from_str("crypto")).ok()?;
    if crypto.is_undefined() || crypto.is_null() {
        return None;
    }
    Some(crypto.unchecked_into::<Crypto>().subtle())
}

/// A plain algorithm object: `{name, ...members}`.
fn algorithm(name: &str, members: &[(&str, JsValue)]) -> Object {
    let object = Object::new();
    // Setting a property on a plain object that was just made cannot fail.
    let _ = Reflect::set(
        &object,
        &JsValue::from_str("name"),
        &JsValue::from_str(name),
    );
    for (key, value) in members {
        let _ = Reflect::set(&object, &JsValue::from_str(key), value);
    }
    object
}

fn ecdh() -> Object {
    algorithm("ECDH", &[("namedCurve", JsValue::from_str("P-256"))])
}

fn ecdsa_key() -> Object {
    algorithm("ECDSA", &[("namedCurve", JsValue::from_str("P-256"))])
}

fn ecdsa_sign() -> Object {
    algorithm("ECDSA", &[("hash", JsValue::from_str("SHA-256"))])
}

fn usages(one: &str) -> Array {
    Array::of1(&JsValue::from_str(one))
}

async fn settle(call: Result<Promise, JsValue>) -> Result<JsValue, JsValue> {
    JsFuture::from(call?).await
}

fn bytes_of(buffer: JsValue) -> Vec<u8> {
    Uint8Array::new(&buffer.unchecked_into::<ArrayBuffer>()).to_vec()
}

/// The JS error's `name` (`DataError`, `OperationError`, ...), if it has one.
/// The message is never read, so nothing a runtime says about a key can reach
/// a log through this.
fn error_name(error: &JsValue) -> Option<String> {
    Reflect::get(error, &JsValue::from_str("name"))
        .ok()?
        .as_string()
}

/// `KeyAgreement` over WebCrypto: a fresh ephemeral P-256 key pair for every
/// call, ECDH against the browser's key, nothing kept.
#[derive(Debug, Clone, Copy, Default)]
pub struct WebCryptoKeyAgreement;

impl KeyAgreement for WebCryptoKeyAgreement {
    async fn agree(&self, recipient_public: &[u8; POINT_LEN]) -> Result<Agreement, EncryptError> {
        let subtle = subtle().ok_or(EncryptError::Crypto)?;

        // The browser's key first: a point that is not on the curve is refused
        // by `importKey` (a DataError), before any key of ours is made.
        let peer = settle(subtle.import_key_with_object(
            "raw",
            &Uint8Array::from(&recipient_public[..]),
            &ecdh(),
            false,
            &Array::new(),
        ))
        .await
        .map_err(|e| import_error(error_name(&e).as_deref()))?
        .unchecked_into::<CryptoKey>();

        // A fresh pair for this message. The private half is not extractable.
        let pair = settle(subtle.generate_key_with_object(&ecdh(), false, &usages("deriveBits")))
            .await
            .map_err(|_| EncryptError::Crypto)?
            .unchecked_into::<CryptoKeyPair>();

        let as_public = bytes_of(
            settle(subtle.export_key("raw", &pair.get_public_key()))
                .await
                .map_err(|_| EncryptError::Crypto)?,
        );

        let params = algorithm("ECDH", &[("public", peer.into())]);
        let shared = bytes_of(
            settle(subtle.derive_bits_with_object(&params, &pair.get_private_key(), 256))
                .await
                .map_err(|_| EncryptError::Crypto)?,
        );

        agreement_from_parts(&as_public, &shared)
    }
}

/// `Es256Signer` over WebCrypto: ECDSA P-256 with SHA-256 under the VAPID
/// private key, returning the raw `r || s`.
///
/// Holds a non-extractable `CryptoKey` and the public key's octets. No `Debug`
/// derive: the manual one below prints nothing of either.
pub struct WebCryptoSigner {
    key: CryptoKey,
    public: [u8; POINT_LEN],
}

impl std::fmt::Debug for WebCryptoSigner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WebCryptoSigner(<redacted>)")
    }
}

impl WebCryptoSigner {
    /// Import the VAPID key pair the caller supplies: the 32-octet private
    /// scalar and the uncompressed public point, both base64url. The pair is
    /// checked (a probe is signed and verified) before the signer is returned.
    pub async fn import(private_b64url: &str, public_b64url: &str) -> Result<Self, KeyError> {
        let material = VapidKeyMaterial::parse(private_b64url, public_b64url)?;
        let subtle = subtle().ok_or(KeyError::Runtime)?;

        let jwk = js_sys::JSON::parse(material.jwk())
            .map_err(|_| KeyError::Runtime)?
            .dyn_into::<Object>()
            .map_err(|_| KeyError::Runtime)?;
        let key = settle(subtle.import_key_with_object(
            "jwk",
            &jwk,
            &ecdsa_key(),
            false,
            &usages("sign"),
        ))
        .await
        .map_err(|_| KeyError::Import)?
        .unchecked_into::<CryptoKey>();

        // The public key must be this private key's.
        let verify_key = settle(subtle.import_key_with_object(
            "raw",
            &Uint8Array::from(&material.public()[..]),
            &ecdsa_key(),
            false,
            &usages("verify"),
        ))
        .await
        .map_err(|_| KeyError::Import)?
        .unchecked_into::<CryptoKey>();
        let signature = bytes_of(
            settle(subtle.sign_with_object_and_u8_array(&ecdsa_sign(), &key, KEY_PROBE))
                .await
                .map_err(|_| KeyError::Runtime)?,
        );
        let verified = settle(subtle.verify_with_object_and_u8_array_and_u8_array(
            &ecdsa_sign(),
            &verify_key,
            &signature,
            KEY_PROBE,
        ))
        .await
        .map_err(|_| KeyError::Runtime)?
        .as_bool()
        .unwrap_or(false);
        if !verified {
            return Err(KeyError::Mismatch);
        }

        Ok(Self {
            key,
            public: *material.public(),
        })
    }
}

impl Es256Signer for WebCryptoSigner {
    fn public_key(&self) -> [u8; POINT_LEN] {
        self.public
    }

    async fn sign(&self, message: &[u8]) -> Result<[u8; 64], VapidError> {
        let subtle = subtle().ok_or(VapidError::Signing)?;
        let signature = bytes_of(
            settle(subtle.sign_with_object_and_u8_array(&ecdsa_sign(), &self.key, message))
                .await
                .map_err(|_| VapidError::Signing)?,
        );
        signature_from_bytes(&signature)
    }
}
