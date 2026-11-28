//! The per-message salt (RFC 8291 section 3.1: 16 random octets), from the
//! runtime's `crypto.getRandomValues`. One function, so the one place the
//! sender draws a random number is one place a reader can check.

use js_sys::Reflect;
use web_sys::Crypto;
use worker::wasm_bindgen::{JsCast, JsValue};

/// 16 random octets, or `None` when the runtime has no `crypto` or the call
/// fails (the caller refuses to send: a message with a guessable salt is not
/// encrypted to the standard). An all-zero answer is refused too: it is what a
/// generator that did nothing would leave in the buffer.
pub fn salt() -> Option<[u8; 16]> {
    let crypto = Reflect::get(&js_sys::global(), &JsValue::from_str("crypto")).ok()?;
    if crypto.is_undefined() || crypto.is_null() {
        return None;
    }
    let mut salt = [0u8; 16];
    crypto
        .unchecked_into::<Crypto>()
        .get_random_values_with_u8_array(&mut salt)
        .ok()?;
    (salt != [0u8; 16]).then_some(salt)
}
