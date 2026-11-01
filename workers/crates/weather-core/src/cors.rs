//! Which browser origins may call the public API.

/// The documented public read API: `GET` routes any website may call from the
/// browser (`Access-Control-Allow-Origin: *`, never with credentials). This is
/// the policy the Python routes `/api/py/weather`, `/geo`, `/search` and
/// `/airquality/*` had (`CORS_POLICY.open` in `src/lib/security-headers.ts`),
/// carried to the Worker that replaces them. Every other route, and every
/// write (`/v1/ai/*`, `/v1/devices`), keeps the `CORS_ORIGINS` allowlist.
pub const OPEN_READ_ROUTES: [&str; 5] = [
    "/v1/weather",
    "/v1/air-quality",
    "/v1/air-quality/grid",
    "/v1/geo",
    "/v1/search",
];

/// Whether `path` is one of the [`OPEN_READ_ROUTES`] (exact match; a trailing
/// slash or a longer path is not).
pub fn is_open_read_route(path: &str) -> bool {
    OPEN_READ_ROUTES.contains(&path)
}

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
    fn the_open_read_routes_are_the_documented_public_ones() {
        for open in [
            "/v1/weather",
            "/v1/air-quality",
            "/v1/air-quality/grid",
            "/v1/geo",
            "/v1/search",
        ] {
            assert!(is_open_read_route(open), "{open}");
        }
        // Writes and first-party routes stay on the allowlist.
        for closed in [
            "/v1/ai",
            "/v1/ai/summary",
            "/v1/ai/chat",
            "/v1/devices",
            "/v1/devices/abc",
            "/v1/history",
            "/v1/locations",
            "/v1/status",
            "/v1/weather/",
            "/v1/weather/key",
            "/v1/weatherx",
            "/health",
            "",
        ] {
            assert!(!is_open_read_route(closed), "{closed}");
        }
    }

    #[test]
    fn local_dev_when_enabled() {
        assert!(origin_allowed("http://localhost:3000", LIST, true));
        assert!(origin_allowed("http://127.0.0.1:8081", LIST, true));
        assert!(!origin_allowed("http://localhost.evil.io", LIST, true));
        assert!(!origin_allowed("http://localhost:30x0", LIST, true));
    }
}
