//! Service-key checks, kept here so they are tested natively.
//!
//! `mukoko-weather-internal` admits first-party callers (the Nyuchi API, the
//! app's Python backend) by `Authorization: Bearer <WEATHER_SERVICE_API_KEY>`.

use subtle::ConstantTimeEq;

/// Whether an `Authorization` header value carries `Bearer <expected>`,
/// compared in constant time. `false` when either side is missing or empty.
pub fn bearer_matches(header: Option<&str>, expected: &str) -> bool {
    let Some(value) = header else {
        return false;
    };
    let Some(token) = value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))
    else {
        return false;
    };
    let token = token.trim();
    !token.is_empty() && !expected.is_empty() && token.as_bytes().ct_eq(expected.as_bytes()).into()
}

/// The answer to a request on a key-protected route.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    /// No key is configured on the Worker: refuse everyone (`503`).
    NotConfigured,
    /// Missing or wrong key (`401`).
    Unauthorized,
    Allowed,
}

/// Decide a key-protected request. Fails closed when no key is configured.
pub fn gate(header: Option<&str>, expected: Option<&str>) -> Gate {
    match expected.map(str::trim).filter(|e| !e.is_empty()) {
        None => Gate::NotConfigured,
        Some(e) if bearer_matches(header, e) => Gate::Allowed,
        Some(_) => Gate::Unauthorized,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_key_must_match_exactly() {
        assert!(bearer_matches(Some("Bearer s3cret"), "s3cret"));
        assert!(bearer_matches(Some("bearer s3cret "), "s3cret"));
        assert!(!bearer_matches(Some("Bearer s3cre"), "s3cret"));
        assert!(!bearer_matches(Some("s3cret"), "s3cret"));
        assert!(!bearer_matches(Some("Bearer "), ""));
        assert!(!bearer_matches(None, "s3cret"));
    }

    #[test]
    fn the_gate_fails_closed() {
        assert_eq!(gate(Some("Bearer k"), None), Gate::NotConfigured);
        assert_eq!(gate(Some("Bearer k"), Some("  ")), Gate::NotConfigured);
        assert_eq!(gate(None, Some("k")), Gate::Unauthorized);
        assert_eq!(gate(Some("Bearer x"), Some("k")), Gate::Unauthorized);
        assert_eq!(gate(Some("Bearer k"), Some("k")), Gate::Allowed);
    }
}
