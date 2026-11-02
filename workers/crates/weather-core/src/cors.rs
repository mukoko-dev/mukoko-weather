//! Which browser origins may call the public API.

/// Whether `origin` may read responses. `allowed` is the configured list
/// (exact origins, comma-separated in the Worker's `CORS_ORIGINS`). Local
/// development origins (`http://localhost:*`, `http://127.0.0.1:*`) are
/// allowed only when `allow_local` is set (dev and staging, not production).
pub fn origin_allowed(origin: &str, allowed: &str, allow_local: bool) -> bool {
    let origin = origin.trim();
    if origin.is_empty() || origin == "null" {
        return false;
    }
    if allowed
        .split(',')
        .map(str::trim)
        .any(|a| a == "*" || (!a.is_empty() && a.eq_ignore_ascii_case(origin)))
    {
        return true;
    }
    if allow_local {
        for prefix in ["http://localhost", "http://127.0.0.1"] {
            if let Some(rest) = origin.strip_prefix(prefix) {
                return rest.is_empty()
                    || (rest.starts_with(':') && rest[1..].bytes().all(|b| b.is_ascii_digit()));
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIST: &str = "https://weather.mukoko.com, https://weatherstations.nyuchi.com";

    #[test]
    fn listed_origins_only() {
        assert!(origin_allowed("https://weather.mukoko.com", LIST, false));
        assert!(origin_allowed(
            "https://weatherstations.nyuchi.com",
            LIST,
            false
        ));
        assert!(!origin_allowed(
            "https://weather.mukoko.com.evil.io",
            LIST,
            false
        ));
        assert!(!origin_allowed("http://localhost:3000", LIST, false));
        assert!(!origin_allowed("null", "*", false));
    }

    #[test]
    fn local_dev_when_enabled() {
        assert!(origin_allowed("http://localhost:3000", LIST, true));
        assert!(origin_allowed("http://127.0.0.1:8081", LIST, true));
        assert!(!origin_allowed("http://localhost.evil.io", LIST, true));
        assert!(!origin_allowed("http://localhost:30x0", LIST, true));
    }
}
