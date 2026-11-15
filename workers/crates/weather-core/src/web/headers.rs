//! The security headers of the web build, ported from
//! `src/lib/security-headers.ts` (which `next.config.ts` applies today) as
//! data, so the Rust Worker sends what the Next.js app sends.
//!
//! They must not drift. `workers/web/routing/security-headers.json` is a
//! snapshot of the TypeScript table, written by
//! `workers/scripts/gen-web-headers.mjs` (CI runs it with `--check`, so the
//! snapshot is always the TypeScript's); the tests below compare this module
//! to that snapshot. Change the TypeScript, regenerate, and the Rust tests say
//! what to change here, or the other way round.

/// Where report-only violations are POSTed (`CSP_REPORT_PATH`).
pub const CSP_REPORT_PATH: &str = "/api/csp-report";

const GA: [&str; 3] = [
    "https://www.googletagmanager.com",
    "https://*.google-analytics.com",
    "https://*.analytics.google.com",
];

/// Other hosts GA4 / Google Tag use (`GA_EXTRA`).
const GA_EXTRA: [&str; 3] = [
    "https://*.googletagmanager.com",
    "https://*.g.doubleclick.net",
    "https://www.google.com",
];

/// `Permissions-Policy` (`PERMISSIONS_POLICY`).
pub const PERMISSIONS_POLICY: &str =
    "geolocation=(self), camera=(), microphone=(), payment=(), usb=()";

/// `BASELINE_HEADERS`: on every response.
pub const BASELINE: [(&str, &str); 3] = [
    ("Referrer-Policy", "strict-origin-when-cross-origin"),
    ("X-Content-Type-Options", "nosniff"),
    ("Permissions-Policy", PERMISSIONS_POLICY),
];

/// `FRAME_HEADER`: on every response except the frameable paths.
pub const FRAME: (&str, &str) = ("X-Frame-Options", "SAMEORIGIN");

/// `FRAMEABLE_PATHS`: the first path segments that may be framed.
pub const FRAMEABLE_PATHS: [&str; 2] = ["embed", "display"];

/// `CORS_POLICY.open`, as path prefixes (`/embed/:path*` is `/embed` and
/// everything under it).
pub const CORS_OPEN_PREFIXES: [&str; 2] = ["/api/embed", "/embed"];

/// `CORS_POLICY.headers`: `*`, never with credentials.
pub const CORS_OPEN_HEADERS: [(&str, &str); 3] = [
    ("Access-Control-Allow-Origin", "*"),
    ("Access-Control-Allow-Methods", "GET, OPTIONS"),
    ("Access-Control-Allow-Headers", "Content-Type"),
];

/// The paths the report-only CSP skips. Next.js skipped `_next/` and `api/`
/// (assets and API responses); `_astro/` is this build's `_next/`.
pub const CSP_EXEMPT_PREFIXES: [&str; 3] = ["/_next/", "/_astro/", "/api/"];

/// `CSP_DIRECTIVES`, in the TypeScript's order (the order is part of the
/// header value).
fn directives() -> Vec<(&'static str, Vec<&'static str>)> {
    let with_ga = |base: &[&'static str]| -> Vec<&'static str> {
        base.iter()
            .copied()
            .chain(GA.iter().copied())
            .chain(GA_EXTRA.iter().copied())
            .collect()
    };
    vec![
        ("default-src", vec!["'self'"]),
        (
            "script-src",
            vec![
                "'self'",
                "'unsafe-inline'",
                "https://www.googletagmanager.com",
            ],
        ),
        ("style-src", vec!["'self'", "'unsafe-inline'"]),
        ("font-src", vec!["'self'", "data:"]),
        (
            "img-src",
            with_ga(&[
                "'self'",
                "data:",
                "blob:",
                "https://api.maptiler.com",
                "https://*.maptiler.com",
                "https://gibs.earthdata.nasa.gov",
                "https://weather-tiles.mukoko.com",
                "https://*.googleusercontent.com",
                "https://*.workoscdn.com",
                "https://avatars.githubusercontent.com",
            ]),
        ),
        (
            "connect-src",
            with_ga(&[
                "'self'",
                "https://api.maptiler.com",
                "https://*.maptiler.com",
                "https://api.open-meteo.com",
                "https://weather-api.mukoko.com",
                "https://weather-tiles.mukoko.com",
                "https://api.nyuchi.com",
                "https://api.tomorrow.io",
                "https://gibs.earthdata.nasa.gov",
                "https://api.workos.com",
                "https://*.authkit.app",
            ]),
        ),
        ("worker-src", vec!["'self'", "blob:"]),
        ("child-src", vec!["'self'", "blob:"]),
        ("frame-src", vec!["'self'"]),
        ("object-src", vec!["'none'"]),
        ("base-uri", vec!["'self'"]),
        ("manifest-src", vec!["'self'"]),
    ]
}

/// `buildCsp(reportPath, extraConnectSrc)`: the policy string. `extra` adds
/// hosts to `connect-src` only, and never twice.
pub fn csp(report_path: &str, extra_connect_src: &[String]) -> String {
    let mut parts: Vec<String> = directives()
        .into_iter()
        .map(|(name, values)| {
            let mut values: Vec<String> = values.into_iter().map(str::to_owned).collect();
            if name == "connect-src" {
                for extra in extra_connect_src {
                    if !values.contains(extra) {
                        values.push(extra.clone());
                    }
                }
            }
            format!("{name} {}", values.join(" "))
        })
        .collect();
    parts.push(format!("report-uri {report_path}"));
    parts.join("; ")
}

/// The origin the app was told its API lives at (`parseBareOrigin` in
/// `src/lib/bare-origin.ts`): an https origin (http only for localhost) with no
/// credentials, path, query or fragment. Anything else is `None`; a value that
/// is not an origin is never fixed up into one.
pub fn parse_bare_origin(raw: &str) -> Option<String> {
    let (scheme, rest) = if let Some(r) = strip_prefix_ci(raw, "https://") {
        ("https", r)
    } else {
        ("http", strip_prefix_ci(raw, "http://")?)
    };
    if rest.contains(['@', '?', '#', '\\']) {
        return None;
    }
    let (authority, path) = match rest.find('/') {
        Some(i) => rest.split_at(i),
        None => (rest, ""),
    };
    if !path.is_empty() && path != "/" {
        return None;
    }
    let (host, port) = split_host_port(authority)?;
    let local = matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]");
    if scheme == "http" && !local {
        return None;
    }
    let default_port = if scheme == "https" { 443 } else { 80 };
    Some(match port {
        Some(p) if p != default_port => format!("{scheme}://{host}:{p}"),
        _ => format!("{scheme}://{host}"),
    })
}

fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let head = s.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| s.get(prefix.len()..))
        .flatten()
}

fn split_host_port(authority: &str) -> Option<(String, Option<u16>)> {
    let (host, port) = if authority.starts_with('[') {
        let end = authority.find(']')?;
        let host = authority.get(..=end)?;
        let after = authority.get(end + 1..)?;
        (host, after.strip_prefix(':'))
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority, None),
        }
    };
    let host = host.to_ascii_lowercase();
    let bracketed = host.starts_with('[') && host.ends_with(']');
    let valid = !host.is_empty()
        && (bracketed
            || host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.'))
        && !host.starts_with('.')
        && !host.ends_with('.');
    if !valid {
        return None;
    }
    let port = match port {
        None => None,
        Some(p) if !p.is_empty() && p.len() <= 5 && p.bytes().all(|b| b.is_ascii_digit()) => {
            Some(p.parse::<u16>().ok()?)
        }
        Some(_) => return None,
    };
    Some((host, port))
}

fn first_segment(path: &str) -> &str {
    path.trim_start_matches('/').split('/').next().unwrap_or("")
}

/// Whether `path` is under one of the open-CORS prefixes.
pub fn is_cors_open(path: &str) -> bool {
    CORS_OPEN_PREFIXES.iter().any(|p| {
        path == *p
            || path
                .strip_prefix(p)
                .is_some_and(|rest| rest.starts_with('/'))
    })
}

/// Every security header for a response at `path`, in the order
/// `next.config.ts` lists them. `extra_connect_src` is the API origin the
/// deployment was told about (`NYUCHI_API_URL`), already through
/// [`parse_bare_origin`].
pub fn security(path: &str, extra_connect_src: &[String]) -> Vec<(&'static str, String)> {
    let mut out: Vec<(&'static str, String)> = BASELINE
        .iter()
        .map(|(k, v)| (*k, (*v).to_owned()))
        .collect();
    if !FRAMEABLE_PATHS.contains(&first_segment(path)) {
        out.push((FRAME.0, FRAME.1.to_owned()));
    }
    if !CSP_EXEMPT_PREFIXES.iter().any(|p| path.starts_with(p)) {
        out.push((
            "Content-Security-Policy-Report-Only",
            csp(CSP_REPORT_PATH, extra_connect_src),
        ));
    }
    if path == "/embed/widget" {
        out.push(("Content-Security-Policy", "frame-ancestors *".to_owned()));
    }
    if is_cors_open(path) {
        out.extend(CORS_OPEN_HEADERS.iter().map(|(k, v)| (*k, (*v).to_owned())));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// The TypeScript table, as `gen-web-headers.mjs` snapshots it.
    fn snapshot() -> Value {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../web/routing/security-headers.json"
        )))
        .unwrap()
    }

    fn pairs(v: &Value) -> Vec<(String, String)> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|p| {
                (
                    p["key"].as_str().unwrap().to_owned(),
                    p["value"].as_str().unwrap().to_owned(),
                )
            })
            .collect()
    }

    fn own(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn matches_the_typescript_csp_exactly() {
        let s = snapshot();
        assert_eq!(csp(CSP_REPORT_PATH, &[]), s["csp"].as_str().unwrap());
        assert_eq!(s["cspReportPath"].as_str().unwrap(), CSP_REPORT_PATH);
    }

    #[test]
    fn extra_connect_src_matches_the_typescript_and_never_repeats() {
        let s = snapshot();
        let extra = vec!["https://staging.example.test".to_owned()];
        assert_eq!(
            csp(CSP_REPORT_PATH, &extra),
            s["cspWithExtra"].as_str().unwrap()
        );
        // The production origin is already in the table: not added twice.
        let dup = vec!["https://api.nyuchi.com".to_owned()];
        assert_eq!(csp(CSP_REPORT_PATH, &dup), csp(CSP_REPORT_PATH, &[]));
    }

    #[test]
    fn matches_the_typescript_header_lists() {
        let s = snapshot();
        assert_eq!(own(&BASELINE), pairs(&s["baseline"]));
        assert_eq!(own(&[FRAME]), pairs(&s["frame"]));
        assert_eq!(own(&CORS_OPEN_HEADERS), pairs(&s["corsHeaders"]));
        let frameable: Vec<&str> = s["frameablePaths"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(frameable, FRAMEABLE_PATHS);
    }

    #[test]
    fn matches_the_typescript_cors_open_routes() {
        let s = snapshot();
        let routes: Vec<&str> = s["corsOpen"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        let ours: Vec<String> = CORS_OPEN_PREFIXES
            .iter()
            .map(|p| format!("{p}/:path*"))
            .collect();
        assert_eq!(routes, ours);
    }

    #[test]
    fn parse_bare_origin_agrees_with_the_typescript_on_every_vector() {
        let s = snapshot();
        let cases = s["bareOrigin"].as_array().unwrap();
        assert!(cases.len() >= 10, "the vectors went missing");
        for case in cases {
            let input = case["input"].as_str().unwrap();
            let want = case["origin"].as_str().map(str::to_owned);
            assert_eq!(parse_bare_origin(input), want, "input {input:?}");
        }
    }

    fn value<'a>(h: &'a [(&'static str, String)], name: &str) -> Option<&'a str> {
        h.iter().find(|(k, _)| *k == name).map(|(_, v)| v.as_str())
    }

    #[test]
    fn a_page_gets_baseline_frame_and_report_only_csp() {
        let h = security("/about", &[]);
        assert_eq!(value(&h, "X-Content-Type-Options"), Some("nosniff"));
        assert_eq!(value(&h, "X-Frame-Options"), Some("SAMEORIGIN"));
        assert!(value(&h, "Content-Security-Policy-Report-Only")
            .unwrap()
            .ends_with("report-uri /api/csp-report"));
        // Report-only: nothing is blocked, so no enforcing policy.
        assert_eq!(value(&h, "Content-Security-Policy"), None);
    }

    #[test]
    fn embed_and_display_may_be_framed() {
        for p in ["/embed", "/embed/widget", "/display", "/display/x"] {
            assert_eq!(value(&security(p, &[]), "X-Frame-Options"), None, "{p}");
        }
        // `embedded` is not `embed`.
        assert!(value(&security("/embedded", &[]), "X-Frame-Options").is_some());
        assert!(value(&security("/displays", &[]), "X-Frame-Options").is_some());
    }

    #[test]
    fn the_widget_names_who_may_frame_it() {
        let h = security("/embed/widget", &[]);
        assert_eq!(
            value(&h, "Content-Security-Policy"),
            Some("frame-ancestors *")
        );
        assert_eq!(
            value(&security("/embed", &[]), "Content-Security-Policy"),
            None
        );
    }

    #[test]
    fn assets_and_api_skip_the_page_csp_but_keep_the_baseline() {
        for p in ["/_astro/x.js", "/api/embed/current", "/api/keys"] {
            let h = security(p, &[]);
            assert_eq!(
                value(&h, "Content-Security-Policy-Report-Only"),
                None,
                "{p}"
            );
            assert_eq!(value(&h, "X-Content-Type-Options"), Some("nosniff"), "{p}");
        }
        // `/api` itself is not under `api/`: the TypeScript regexp is `api/`.
        assert!(value(
            &security("/api", &[]),
            "Content-Security-Policy-Report-Only"
        )
        .is_some());
    }

    #[test]
    fn open_cors_only_on_the_embed_routes() {
        for p in [
            "/embed",
            "/embed/widget",
            "/api/embed",
            "/api/embed/current",
        ] {
            assert_eq!(
                value(&security(p, &[]), "Access-Control-Allow-Origin"),
                Some("*"),
                "{p}"
            );
        }
        for p in ["/about", "/api/keys", "/embedded", "/api/embedded"] {
            assert_eq!(
                value(&security(p, &[]), "Access-Control-Allow-Origin"),
                None,
                "{p}"
            );
        }
        // Never with credentials.
        assert_eq!(
            value(&security("/embed", &[]), "Access-Control-Allow-Credentials"),
            None
        );
    }

    #[test]
    fn deployment_api_origin_reaches_connect_src_only() {
        let extra = vec!["https://staging.example.test".to_owned()];
        let policy = csp(CSP_REPORT_PATH, &extra);
        let connect = policy
            .split("; ")
            .find(|d| d.starts_with("connect-src "))
            .unwrap();
        assert!(connect.contains("https://staging.example.test"));
        assert_eq!(policy.matches("staging.example.test").count(), 1);
    }

    #[test]
    fn bare_origin_rejects_what_is_not_an_origin() {
        for bad in [
            "",
            "api.nyuchi.com",
            "http://example.com",
            "https://u:p@example.com",
            "https://example.com/v1",
            "https://example.com?x=1",
            "https://example.com#f",
            "https://exa mple.com",
            "https://example.com:99999",
            "https://example.com:",
            "https://",
            "ftp://example.com",
            "https://.example.com",
        ] {
            assert_eq!(parse_bare_origin(bad), None, "{bad:?}");
        }
        assert_eq!(
            parse_bare_origin("HTTPS://Example.COM:443/"),
            Some("https://example.com".to_owned())
        );
        assert_eq!(
            parse_bare_origin("http://localhost:3000"),
            Some("http://localhost:3000".to_owned())
        );
    }
}
