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

/// The request headers a listed (first-party) origin may send.
pub const FIRST_PARTY_ALLOW_HEADERS: &str =
    "Content-Type, Authorization, X-Mukoko-Client, X-API-Key, X-Client-Id, X-Client-Secret";

/// The only request header a foreign website may send to an open route
/// (`CORS_POLICY.headers` in `src/lib/security-headers.ts`). Credentials and
/// API secrets never ride a request from someone else's page.
pub const OPEN_ALLOW_HEADERS: &str = "Content-Type";

/// What the API Worker sets on a response and a preflight.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    /// `Access-Control-Allow-Origin`: the listed origin itself, `*` for a
    /// foreign website reading an open route, else nothing (a preflight is then
    /// refused).
    pub allow_origin: Option<String>,
    /// `Access-Control-Allow-Methods` on a preflight.
    pub methods: &'static str,
    /// `Access-Control-Allow-Headers` on a preflight.
    pub allow_headers: &'static str,
    /// `Vary: Origin` is always stamped: the answer depends on the origin.
    pub vary_origin: bool,
}

/// The CORS decision for a request. `listed_origin` is the request's origin
/// when the `CORS_ORIGINS` allowlist admits it (`origin_allowed`). A listed
/// origin gets itself echoed everywhere, with the API's full methods and
/// headers. Any other origin gets `*` only for a read (`GET`, or the `OPTIONS`
/// preflight of one) of an [`OPEN_READ_ROUTES`] path, and then only reads and
/// `Content-Type`; a write (`POST`, `PATCH`) or a closed route (AI, devices,
/// history, locations, status) never does.
pub fn cors_decision(method: &str, path: &str, listed_origin: Option<&str>) -> Decision {
    if let Some(origin) = listed_origin {
        return Decision {
            allow_origin: Some(origin.to_owned()),
            methods: "GET, POST, PATCH, OPTIONS",
            allow_headers: FIRST_PARTY_ALLOW_HEADERS,
            vary_origin: true,
        };
    }
    let is_read = method.eq_ignore_ascii_case("GET") || method.eq_ignore_ascii_case("OPTIONS");
    Decision {
        allow_origin: (is_read && is_open_read_route(path)).then(|| "*".to_owned()),
        methods: "GET, OPTIONS",
        allow_headers: OPEN_ALLOW_HEADERS,
        vary_origin: true,
    }
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

    /// The documented public browser API (CLAUDE.md "Security headers and
    /// CORS", the developers page, `CORS_POLICY.open`): weather, geo, search and
    /// air quality with its grid, at their Worker paths.
    const DOCUMENTED: [&str; 5] = [
        "/v1/weather",
        "/v1/air-quality",
        "/v1/air-quality/grid",
        "/v1/geo",
        "/v1/search",
    ];

    #[test]
    fn the_open_routes_are_exactly_the_documented_list() {
        let mut open = OPEN_READ_ROUTES.to_vec();
        let mut documented = DOCUMENTED.to_vec();
        open.sort_unstable();
        documented.sort_unstable();
        assert_eq!(open, documented);
    }

    #[test]
    fn a_listed_origin_is_echoed_on_every_route_and_method() {
        let o = Some("https://weather.mukoko.com");
        for (method, path) in [
            ("GET", "/v1/weather"),
            ("GET", "/v1/history"),
            ("POST", "/v1/ai/chat"),
            ("POST", "/v1/devices"),
            ("PATCH", "/v1/devices/abc"),
            ("OPTIONS", "/v1/devices"),
        ] {
            let d = cors_decision(method, path, o);
            assert_eq!(d.allow_origin.as_deref(), o, "{method} {path}");
            assert_eq!(d.methods, "GET, POST, PATCH, OPTIONS");
            assert_eq!(d.allow_headers, FIRST_PARTY_ALLOW_HEADERS);
            assert!(d.vary_origin);
        }
    }

    #[test]
    fn a_foreign_origin_gets_the_wildcard_only_for_a_read_of_an_open_route() {
        for path in DOCUMENTED {
            for method in ["GET", "OPTIONS", "get"] {
                let d = cors_decision(method, path, None);
                assert_eq!(d.allow_origin.as_deref(), Some("*"), "{method} {path}");
            }
        }
    }

    #[test]
    fn a_write_never_gets_the_wildcard_not_even_on_an_open_route() {
        for method in ["POST", "PATCH", "PUT", "DELETE", "HEAD"] {
            for path in DOCUMENTED {
                assert_eq!(
                    cors_decision(method, path, None).allow_origin,
                    None,
                    "{method} {path}"
                );
            }
        }
    }

    #[test]
    fn a_closed_route_never_gets_the_wildcard() {
        for path in [
            "/v1/ai",
            "/v1/ai/summary",
            "/v1/ai/chat",
            "/v1/devices",
            "/v1/devices/abc",
            "/v1/history",
            "/v1/locations",
            "/v1/status",
            "/v1/forecast",
            "/v1/weather/",
            "/v1/weather/key",
            "/health",
            "",
        ] {
            for method in ["GET", "OPTIONS"] {
                assert_eq!(
                    cors_decision(method, path, None).allow_origin,
                    None,
                    "{method} {path}"
                );
            }
        }
    }

    #[test]
    fn a_foreign_origin_may_send_content_type_only_and_never_a_secret() {
        let d = cors_decision("OPTIONS", "/v1/weather", None);
        assert_eq!(d.allow_headers, "Content-Type");
        assert_eq!(d.methods, "GET, OPTIONS");
        for secret in [
            "Authorization",
            "X-API-Key",
            "X-Client-Id",
            "X-Client-Secret",
        ] {
            assert!(!d.allow_headers.contains(secret), "{secret}");
        }
        // The first-party list does carry them, for a listed origin only.
        assert!(FIRST_PARTY_ALLOW_HEADERS.contains("X-Client-Secret"));
    }

    #[test]
    fn vary_origin_is_always_stamped() {
        for (method, path, origin) in [
            ("GET", "/v1/weather", None),
            ("POST", "/v1/devices", None),
            ("GET", "/v1/history", None),
            ("GET", "/v1/weather", Some("https://weather.mukoko.com")),
        ] {
            assert!(cors_decision(method, path, origin).vary_origin);
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
