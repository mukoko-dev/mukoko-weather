//! Developer API keys, read from a request and checked by the Nyuchi API.
//!
//! The weather backend keeps no key store. A developer sends a Nyuchi API
//! key, either combined (`X-API-Key: nyk_<id>.nys_<secret>`) or as a pair
//! (`X-Client-Id` and `X-Client-Secret`), the same forms the Nyuchi API
//! accepts. `mukoko-weather-api` forwards it to `GET /v1/weather/key`, which
//! validates it, requires the `weather` scope, enforces the monthly quota and
//! counts usage, then answers the key's identity ([`KeyContext`]).

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const CLIENT_ID_PREFIX: &str = "nyk_";
pub const SECRET_PREFIX: &str = "nys_";
/// Longest credential part we forward. Real ids are 28 and secrets 52 chars.
const MAX_PART: usize = 128;

/// What a request carried.
#[derive(Debug, PartialEq, Eq)]
pub enum Credential {
    /// No key: an anonymous caller.
    None,
    /// Something that is not a Nyuchi key.
    Malformed,
    Key {
        client_id: String,
        client_secret: String,
    },
}

fn part_ok(s: &str, prefix: &str) -> bool {
    s.len() > prefix.len()
        && s.len() <= MAX_PART
        && s.starts_with(prefix)
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn nonempty(v: Option<&str>) -> Option<&str> {
    v.map(str::trim).filter(|s| !s.is_empty())
}

impl Credential {
    /// Read the headers' values (each `None` when absent). The pair wins over
    /// the combined form, as in the Nyuchi API.
    pub fn parse(
        api_key: Option<&str>,
        client_id: Option<&str>,
        client_secret: Option<&str>,
    ) -> Credential {
        let (id, secret) = match (nonempty(client_id), nonempty(client_secret)) {
            (Some(id), Some(secret)) => (id, secret),
            (None, None) => match nonempty(api_key) {
                None => return Credential::None,
                Some(combined) => match combined.split_once('.') {
                    Some(pair) => pair,
                    None => return Credential::Malformed,
                },
            },
            _ => return Credential::Malformed,
        };
        if part_ok(id, CLIENT_ID_PREFIX) && part_ok(secret, SECRET_PREFIX) {
            Credential::Key {
                client_id: id.to_owned(),
                client_secret: secret.to_owned(),
            }
        } else {
            Credential::Malformed
        }
    }

    /// The combined `X-API-Key` value to forward, if this is a key.
    pub fn combined(&self) -> Option<String> {
        match self {
            Credential::Key {
                client_id,
                client_secret,
            } => Some(format!("{client_id}.{client_secret}")),
            _ => None,
        }
    }

    /// A SHA-256 of the credential, to cache a verification without keeping
    /// the secret itself.
    pub fn fingerprint(&self) -> Option<String> {
        let combined = self.combined()?;
        Some(hex::encode(Sha256::digest(combined.as_bytes())))
    }
}

/// The Nyuchi API's answer to `GET /v1/weather/key`. Never a secret.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KeyContext {
    pub key_id: String,
    pub client_id: String,
    #[serde(default)]
    pub key_type: Option<String>,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub plan_tier: Option<String>,
    #[serde(default)]
    pub owner_entity_id: Option<String>,
}

impl KeyContext {
    /// Read the answer; `None` unless it names a key scoped for `weather`
    /// (the API already enforces the scope; this refuses a surprising body).
    pub fn from_answer(body: &serde_json::Value) -> Option<KeyContext> {
        let ctx: KeyContext = serde_json::from_value(body.clone()).ok()?;
        (!ctx.key_id.is_empty() && ctx.scopes.iter().any(|s| s == "weather")).then_some(ctx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ID: &str = "nyk_0123456789abcdef01234567";
    const SECRET: &str = "nys_0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn no_headers_is_anonymous() {
        assert_eq!(Credential::parse(None, None, None), Credential::None);
        assert_eq!(Credential::parse(Some("  "), None, None), Credential::None);
    }

    #[test]
    fn combined_and_pair_forms_are_read() {
        let combined = format!("{ID}.{SECRET}");
        let a = Credential::parse(Some(&combined), None, None);
        let b = Credential::parse(None, Some(ID), Some(SECRET));
        assert_eq!(a, b);
        assert_eq!(a.combined().as_deref(), Some(combined.as_str()));
        assert_eq!(a.fingerprint().unwrap().len(), 64);
        assert_ne!(
            a.fingerprint(),
            Credential::parse(None, Some(ID), Some("nys_x")).fingerprint()
        );
    }

    #[test]
    fn the_pair_wins_over_the_combined_form() {
        let c = Credential::parse(Some("garbage"), Some(ID), Some(SECRET));
        assert!(matches!(c, Credential::Key { .. }));
    }

    #[test]
    fn anything_else_is_malformed() {
        for bad in [
            "mk_live_abcd1234",
            "nyk_abc",
            "nys_abc.nyk_abc",
            "nyk_abc.nys_",
            "nyk_a b.nys_c",
            "nyk_abc.nys_abc.extra",
        ] {
            assert_eq!(
                Credential::parse(Some(bad), None, None),
                Credential::Malformed,
                "{bad}"
            );
        }
        assert_eq!(
            Credential::parse(None, Some(ID), None),
            Credential::Malformed
        );
        let long = format!("nyk_{}", "a".repeat(200));
        assert_eq!(
            Credential::parse(None, Some(&long), Some(SECRET)),
            Credential::Malformed
        );
    }

    #[test]
    fn the_answer_must_carry_the_weather_scope() {
        let ok = json!({"key_id": "k1", "client_id": ID, "key_type": "external",
            "scopes": ["weather"], "plan_tier": "free", "owner_entity_id": "e1"});
        assert_eq!(KeyContext::from_answer(&ok).unwrap().key_id, "k1");
        let other = json!({"key_id": "k1", "client_id": ID, "scopes": ["news"]});
        assert!(KeyContext::from_answer(&other).is_none());
        assert!(KeyContext::from_answer(&json!({"detail": "nope"})).is_none());
    }
}
