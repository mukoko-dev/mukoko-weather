//! SCRAM-SHA-256 (RFC 5802 with the SHA-256 profile of RFC 7677), the
//! mechanism MongoDB Atlas uses. Pure: the nonce and the clock are arguments.
//!
//! The password goes through SASLprep in the standard; here only ASCII
//! passwords are accepted (SASLprep is the identity on them), which covers
//! every Atlas-generated password. A non-ASCII password is refused rather
//! than normalised wrongly.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::{Error, Result};

type HmacSha256 = Hmac<Sha256>;

/// MongoDB refuses fewer iterations than this.
pub const MIN_ITERATIONS: u32 = 4096;
/// And a server asking for far more is a CPU attack on a Worker.
pub const MAX_ITERATIONS: u32 = 100_000;

/// `n,,`: no channel binding, no authorization identity.
const GS2_HEADER: &str = "n,,";

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC takes any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// The user name in a SCRAM message: `=` and `,` are escaped.
fn escape_user(user: &str) -> String {
    user.replace('=', "=3D").replace(',', "=2C")
}

/// The first client message and its bare part (kept for the auth message).
pub fn client_first(user: &str, client_nonce: &str) -> (String, String) {
    let bare = format!("n={},r={client_nonce}", escape_user(user));
    (format!("{GS2_HEADER}{bare}"), bare)
}

/// What the server's first message carries.
#[derive(Debug, PartialEq, Eq)]
pub struct ServerFirst {
    pub nonce: String,
    pub salt: Vec<u8>,
    pub iterations: u32,
}

pub fn parse_server_first(msg: &str, client_nonce: &str) -> Result<ServerFirst> {
    let auth = |m: &str| Error::Auth(m.to_owned());
    let mut nonce = None;
    let mut salt = None;
    let mut iterations = None;
    for part in msg.split(',') {
        match part.split_once('=') {
            Some(("r", v)) => nonce = Some(v.to_owned()),
            Some(("s", v)) => {
                salt = Some(
                    B64.decode(v)
                        .map_err(|_| auth("the server's salt is not base64"))?,
                )
            }
            Some(("i", v)) => {
                iterations = Some(v.parse::<u32>().map_err(|_| auth("bad iteration count"))?)
            }
            Some(("e", _)) => return Err(auth("the server refused the exchange")),
            _ => {}
        }
    }
    let nonce = nonce.ok_or_else(|| auth("no nonce in the server's first message"))?;
    if !nonce.starts_with(client_nonce) || nonce.len() <= client_nonce.len() {
        return Err(auth("the server's nonce does not extend ours"));
    }
    let iterations = iterations.ok_or_else(|| auth("no iteration count"))?;
    if !(MIN_ITERATIONS..=MAX_ITERATIONS).contains(&iterations) {
        return Err(auth("the iteration count is out of range"));
    }
    Ok(ServerFirst {
        nonce,
        salt: salt.ok_or_else(|| auth("no salt"))?,
        iterations,
    })
}

/// `PBKDF2-HMAC-SHA-256(password, salt, iterations)`: the slow step, which
/// callers may cache per (user, salt, iterations).
pub fn salted_password(password: &str, salt: &[u8], iterations: u32) -> Result<[u8; 32]> {
    if !password.is_ascii() {
        return Err(Error::Auth(
            "the password must be ASCII (SASLprep of other text is not supported)".into(),
        ));
    }
    let mut out = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, iterations, &mut out);
    Ok(out)
}

/// The final client message, and the signature the server must prove.
pub fn client_final(
    salted: &[u8; 32],
    client_first_bare: &str,
    server_first: &str,
    combined_nonce: &str,
) -> (String, Vec<u8>) {
    let client_key = hmac(salted, b"Client Key");
    let stored_key = Sha256::digest(&client_key);
    let without_proof = format!("c={},r={combined_nonce}", B64.encode(GS2_HEADER));
    let auth_message = format!("{client_first_bare},{server_first},{without_proof}");
    let client_signature = hmac(&stored_key, auth_message.as_bytes());
    let proof: Vec<u8> = client_key
        .iter()
        .zip(&client_signature)
        .map(|(a, b)| a ^ b)
        .collect();
    let server_key = hmac(salted, b"Server Key");
    let server_signature = hmac(&server_key, auth_message.as_bytes());
    (
        format!("{without_proof},p={}", B64.encode(proof)),
        server_signature,
    )
}

/// Check the server's final message proves it knows the password too.
pub fn verify_server_final(server_final: &str, expected: &[u8]) -> Result<()> {
    let auth = |m: &str| Error::Auth(m.to_owned());
    let got = server_final
        .split(',')
        .find_map(|p| p.strip_prefix("v="))
        .ok_or_else(|| auth("the server's final message has no signature"))?;
    let got = B64
        .decode(got)
        .map_err(|_| auth("the server's signature is not base64"))?;
    if got.ct_eq(expected).into() {
        Ok(())
    } else {
        Err(auth("the server's signature does not match"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 7677, section 3.
    const NONCE: &str = "rOprNGfwEbeRWgbNEkqO";
    const SERVER_FIRST: &str =
        "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096";

    #[test]
    fn the_rfc_7677_exchange_is_reproduced_exactly() {
        let (first, bare) = client_first("user", NONCE);
        assert_eq!(first, "n,,n=user,r=rOprNGfwEbeRWgbNEkqO");
        let sf = parse_server_first(SERVER_FIRST, NONCE).unwrap();
        assert_eq!(sf.iterations, 4096);
        let salted = salted_password("pencil", &sf.salt, sf.iterations).unwrap();
        let (fin, server_sig) = client_final(&salted, &bare, SERVER_FIRST, &sf.nonce);
        assert_eq!(
            fin,
            "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,\
             p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ="
        );
        verify_server_final(
            "v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=",
            &server_sig,
        )
        .unwrap();
        // A different signature is refused.
        assert!(verify_server_final("v=AAAA", &server_sig).is_err());
        assert!(verify_server_final("x=1", &server_sig).is_err());
    }

    #[test]
    fn user_names_are_escaped() {
        assert_eq!(client_first("a=b,c", "n").1, "n=a=3Db=2Cc,r=n");
    }

    #[test]
    fn a_hostile_server_first_message_is_refused() {
        // A nonce that does not extend ours (or only repeats it).
        assert!(parse_server_first("r=other,s=AAAA,i=4096", NONCE).is_err());
        assert!(parse_server_first(&format!("r={NONCE},s=AAAA,i=4096"), NONCE).is_err());
        // Too few and too many iterations.
        assert!(parse_server_first(&format!("r={NONCE}x,s=AAAA,i=1000"), NONCE).is_err());
        assert!(parse_server_first(&format!("r={NONCE}x,s=AAAA,i=900000000"), NONCE).is_err());
        // Missing parts, a bad salt, an error attribute.
        assert!(parse_server_first(&format!("r={NONCE}x,i=4096"), NONCE).is_err());
        assert!(parse_server_first(&format!("r={NONCE}x,s=!!,i=4096"), NONCE).is_err());
        assert!(parse_server_first("e=invalid-proof", NONCE).is_err());
    }

    #[test]
    fn a_non_ascii_password_is_refused() {
        assert!(salted_password("pässword", b"salt", 4096).is_err());
    }
}
