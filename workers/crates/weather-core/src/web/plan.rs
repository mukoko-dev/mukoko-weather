//! One request in, what to do out.
//!
//! [`plan`] looks at the method, the path and the declared body size, and
//! returns a [`Plan`]. The Worker carries it out; nothing here touches a
//! binding, so every branch is a unit test.
//!
//! Order, and why:
//!
//! 1. a path that cannot be a route is `400`, before anything reads it;
//! 2. `/health` and `/ready`, the probes;
//! 3. `OPTIONS` is answered here for every path (a `204` and `Allow`; the open
//!    CORS routes also carry their CORS headers, from `headers::security`);
//! 4. a trailing slash redirects (`308`) to the path without one: URLs here
//!    have none, which is also how Astro writes `about.html`;
//! 5. the route table, then files, then the dynamic routes (Next.js serves
//!    `public/` before a `[location]` page, and so does this);
//! 6. only `GET` and `HEAD` read a file; a route that is not migrated answers
//!    a problem, or goes to the legacy origin when one is configured.

use super::cache::{self, AssetClass};
use super::problem::Problem;
use super::routes::{RouteTable, Target};

/// The largest request body forwarded to the legacy origin.
pub const MAX_PROXY_BODY: u64 = 1 << 20;

const READ_METHODS: &str = "GET, HEAD, OPTIONS";

/// What the Worker needs to know about a request.
#[derive(Debug, Clone)]
pub struct Req<'a> {
    pub method: &'a str,
    /// The URL's path, as sent (still percent-encoded), no query.
    pub path: &'a str,
    /// `Content-Length`, when the client sent one.
    pub content_length: Option<u64>,
}

/// What the Worker is configured with.
#[derive(Debug, Clone)]
pub struct Config<'a> {
    pub routes: &'a RouteTable,
    /// The bare origin of the Next.js app, when the deployment names one
    /// (`LEGACY_ORIGIN`). `None` is the default: an un-migrated route answers a
    /// problem document instead of reaching another origin.
    pub legacy_origin: Option<String>,
}

/// What to do with a request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plan {
    /// `/health`: liveness. Answers without touching a dependency.
    Health,
    /// `/ready`: can this Worker serve what it is for.
    Ready,
    /// `OPTIONS`: `204` with `Allow`.
    Preflight { allow: &'static str },
    /// `308` to `to` (a path; the Worker appends the query).
    Redirect { to: String },
    /// Read this file (no leading slash) from the static assets.
    Asset { path: String, class: AssetClass },
    /// Forward to the legacy origin: `origin` + the request's path and query.
    Proxy { origin: String },
    /// Answer a problem document. `allow` is set for a `405`.
    Problem {
        problem: Problem,
        allow: Option<&'static str>,
    },
}

fn problem(p: Problem) -> Plan {
    Plan::Problem {
        problem: p,
        allow: None,
    }
}

fn is_read(method: &str) -> bool {
    method.eq_ignore_ascii_case("GET") || method.eq_ignore_ascii_case("HEAD")
}

/// Why a path cannot be a route, if it cannot. Rejected, never repaired: a
/// path that "means" something else after cleaning is how a traversal works.
fn bad_path(path: &str) -> Option<&'static str> {
    if !path.starts_with('/') {
        return Some("The path must start with a slash.");
    }
    if path.bytes().any(|b| b < 0x20 || b == 0x7f || b == b'\\') {
        return Some("The path has a control or backslash character.");
    }
    if path.contains("//") {
        return Some("The path has an empty segment.");
    }
    if path.split('/').any(|s| s == "." || s == "..") {
        return Some("The path has a dot segment.");
    }
    let lower = path.to_ascii_lowercase();
    if ["%2e", "%2f", "%5c", "%00"]
        .iter()
        .any(|e| lower.contains(e))
    {
        return Some("The path has an encoded dot, slash or NUL.");
    }
    None
}

/// Whether the last segment looks like a file (`sw.js`, `icon-192.png`).
fn has_extension(path: &str) -> bool {
    path.rsplit('/')
        .next()
        .is_some_and(|last| last.contains('.') && !last.starts_with('.') && !last.ends_with('.'))
}

fn asset_plan(path: &str, method: &str) -> Plan {
    if !is_read(method) {
        return Plan::Problem {
            problem: Problem::method_not_allowed(READ_METHODS),
            allow: Some(READ_METHODS),
        };
    }
    let file = path.trim_start_matches('/').to_owned();
    let class = cache::classify(&file);
    Plan::Asset { path: file, class }
}

fn legacy_plan(req: &Req<'_>, config: &Config<'_>, pattern: &str) -> Plan {
    match &config.legacy_origin {
        None => problem(Problem::not_migrated(pattern)),
        Some(origin) => {
            if req.content_length.is_some_and(|n| n > MAX_PROXY_BODY) {
                return problem(Problem::payload_too_large(MAX_PROXY_BODY));
            }
            Plan::Proxy {
                origin: origin.clone(),
            }
        }
    }
}

/// Decide what to do with `req`.
pub fn plan(req: &Req<'_>, config: &Config<'_>) -> Plan {
    let path = req.path;
    if let Some(why) = bad_path(path) {
        return problem(Problem::bad_request(why));
    }

    if path == "/health" || path == "/ready" {
        if !is_read(req.method) && !req.method.eq_ignore_ascii_case("OPTIONS") {
            return Plan::Problem {
                problem: Problem::method_not_allowed(READ_METHODS),
                allow: Some(READ_METHODS),
            };
        }
        if !req.method.eq_ignore_ascii_case("OPTIONS") {
            return if path == "/health" {
                Plan::Health
            } else {
                Plan::Ready
            };
        }
    }

    if req.method.eq_ignore_ascii_case("OPTIONS") {
        return Plan::Preflight {
            allow: READ_METHODS,
        };
    }

    if path.len() > 1 && path.ends_with('/') {
        return Plan::Redirect {
            to: path.trim_end_matches('/').to_owned(),
        };
    }

    // `/_astro/*` is the build's own folder: files only, never a route.
    if path.starts_with("/_astro/") {
        return asset_plan(path, req.method);
    }

    // The build's file names are not URLs: `/about.html` would be a second
    // address for `/about`.
    if path.ends_with(".html") {
        return problem(Problem::not_found());
    }

    let hit = config.routes.lookup(path);
    match hit {
        Some(route) if !route.dynamic => match &route.target {
            Target::Page { asset } => asset_plan_for(asset, req.method),
            Target::NotMigrated => legacy_plan(req, config, &route.pattern),
        },
        // A file under public/ wins over a dynamic route.
        _ if has_extension(path) => asset_plan(path, req.method),
        Some(route) => match &route.target {
            Target::Page { asset } => asset_plan_for(asset, req.method),
            Target::NotMigrated => legacy_plan(req, config, &route.pattern),
        },
        None => problem(Problem::not_found()),
    }
}

fn asset_plan_for(asset: &str, method: &str) -> Plan {
    asset_plan(&format!("/{asset}"), method)
}

/// What to do when the static assets had no file for a plan that asked for one.
///
/// A page or file the table promised and the build lacks is a `404` like any
/// other (the gate in CI keeps that from shipping). A file under `public/` that
/// this build does not carry yet may still exist on the legacy origin.
pub fn asset_miss(req: &Req<'_>, config: &Config<'_>) -> Plan {
    match &config.legacy_origin {
        Some(_)
            if has_extension(req.path)
                && config.routes.lookup(req.path).is_none_or(|r| r.dynamic) =>
        {
            legacy_plan(req, config, req.path)
        }
        _ => problem(Problem::not_found()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(legacy: Option<&str>) -> Config<'static> {
        let routes: &'static RouteTable = Box::leak(Box::new(
            RouteTable::parse(include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../web/routing/routes.json"
            )))
            .unwrap(),
        ));
        Config {
            routes,
            legacy_origin: legacy.map(str::to_owned),
        }
    }

    fn run(method: &str, path: &str, cfg: &Config) -> Plan {
        plan(
            &Req {
                method,
                path,
                content_length: None,
            },
            cfg,
        )
    }

    fn asset(file: &str, class: AssetClass) -> Plan {
        Plan::Asset {
            path: file.to_owned(),
            class,
        }
    }

    fn kind(p: &Plan) -> Option<(&'static str, u16)> {
        match p {
            Plan::Problem { problem, .. } => Some((problem.kind, problem.status)),
            _ => None,
        }
    }

    #[test]
    fn about_serves_about_html_with_no_slash_and_no_redirect() {
        let cfg = config(None);
        assert_eq!(
            run("GET", "/about", &cfg),
            asset("about.html", AssetClass::Html)
        );
        assert_eq!(
            run("HEAD", "/about", &cfg),
            asset("about.html", AssetClass::Html)
        );
        assert_eq!(
            run("GET", "/shell-preview", &cfg),
            asset("shell-preview.html", AssetClass::Html)
        );
    }

    #[test]
    fn a_trailing_slash_redirects_to_the_path_without_one() {
        let cfg = config(None);
        assert_eq!(
            run("GET", "/about/", &cfg),
            Plan::Redirect {
                to: "/about".into()
            }
        );
        assert_eq!(
            run("GET", "/explore/farming/", &cfg),
            Plan::Redirect {
                to: "/explore/farming".into()
            }
        );
        // The root has no slash to drop.
        assert!(!matches!(run("GET", "/", &cfg), Plan::Redirect { .. }));
    }

    #[test]
    fn the_html_file_name_is_not_a_url() {
        let cfg = config(None);
        assert_eq!(
            kind(&run("GET", "/about.html", &cfg)),
            Some(("not-found", 404))
        );
        assert_eq!(
            kind(&run("GET", "/index.html", &cfg)),
            Some(("not-found", 404))
        );
    }

    #[test]
    fn hashed_assets_are_files_not_routes() {
        let cfg = config(None);
        assert_eq!(
            run("GET", "/_astro/client.abc.js", &cfg),
            asset("_astro/client.abc.js", AssetClass::Hashed)
        );
        // Even a name that would match a dynamic route.
        assert_eq!(
            run("GET", "/_astro/nope", &cfg),
            asset("_astro/nope", AssetClass::Hashed)
        );
    }

    #[test]
    fn service_worker_and_manifest_are_files() {
        // Not migrated yet: the table owns /sw.js until the service worker moves.
        let cfg = config(None);
        assert_eq!(
            kind(&run("GET", "/sw.js", &cfg)),
            Some(("not-migrated", 404))
        );
        assert_eq!(
            run("GET", "/manifest.json", &cfg),
            asset("manifest.json", AssetClass::Manifest)
        );
        assert_eq!(
            run("GET", "/icon-192.png", &cfg),
            asset("icon-192.png", AssetClass::Static)
        );
    }

    #[test]
    fn an_unmigrated_route_is_a_404_problem_by_default() {
        let cfg = config(None);
        for path in [
            "/",
            "/harare",
            "/harare/forecast",
            "/explore",
            "/api/keys",
            "/aviation",
        ] {
            assert_eq!(
                kind(&run("GET", path, &cfg)),
                Some(("not-migrated", 404)),
                "{path}"
            );
        }
        // Whatever the method: the route is not here.
        assert_eq!(
            kind(&run("POST", "/api/keys", &cfg)),
            Some(("not-migrated", 404))
        );
    }

    #[test]
    fn an_unmigrated_route_goes_to_the_legacy_origin_only_when_one_is_named() {
        let cfg = config(Some("https://legacy.example.test"));
        for (m, path) in [("GET", "/harare"), ("POST", "/api/keys"), ("GET", "/")] {
            assert_eq!(
                run(m, path, &cfg),
                Plan::Proxy {
                    origin: "https://legacy.example.test".into()
                },
                "{m} {path}"
            );
        }
        // A migrated page is still served here, not proxied.
        assert_eq!(
            run("GET", "/about", &cfg),
            asset("about.html", AssetClass::Html)
        );
    }

    #[test]
    fn a_proxied_body_has_a_size_limit() {
        let cfg = config(Some("https://legacy.example.test"));
        let big = plan(
            &Req {
                method: "POST",
                path: "/api/keys",
                content_length: Some(MAX_PROXY_BODY + 1),
            },
            &cfg,
        );
        assert_eq!(kind(&big), Some(("payload-too-large", 413)));
        let ok = plan(
            &Req {
                method: "POST",
                path: "/api/keys",
                content_length: Some(MAX_PROXY_BODY),
            },
            &cfg,
        );
        assert!(matches!(ok, Plan::Proxy { .. }));
    }

    #[test]
    fn unknown_paths_are_404_not_found() {
        let cfg = config(None);
        assert_eq!(
            kind(&run("GET", "/a/b/c/d", &cfg)),
            Some(("not-found", 404))
        );
        assert_eq!(
            kind(&run("GET", "/harare/nope", &cfg)),
            Some(("not-found", 404))
        );
    }

    #[test]
    fn only_get_and_head_read_files() {
        let cfg = config(None);
        for m in ["POST", "PUT", "PATCH", "DELETE"] {
            let p = run(m, "/about", &cfg);
            assert_eq!(kind(&p), Some(("method-not-allowed", 405)), "{m}");
            assert!(matches!(
                p,
                Plan::Problem {
                    allow: Some("GET, HEAD, OPTIONS"),
                    ..
                }
            ));
        }
    }

    #[test]
    fn options_is_answered_here_for_every_path() {
        for path in [
            "/about",
            "/anything",
            "/api/embed/current",
            "/health",
            "/x/",
        ] {
            assert_eq!(
                run("OPTIONS", path, &config(None)),
                Plan::Preflight {
                    allow: "GET, HEAD, OPTIONS"
                },
                "{path}"
            );
        }
    }

    #[test]
    fn probes() {
        let cfg = config(Some("https://legacy.example.test"));
        assert_eq!(run("GET", "/health", &cfg), Plan::Health);
        assert_eq!(run("HEAD", "/health", &cfg), Plan::Health);
        assert_eq!(run("GET", "/ready", &cfg), Plan::Ready);
        assert_eq!(
            kind(&run("POST", "/health", &cfg)),
            Some(("method-not-allowed", 405))
        );
    }

    #[test]
    fn hostile_paths_are_400_and_never_reach_a_file() {
        let cfg = config(Some("https://legacy.example.test"));
        for path in [
            "about",
            "",
            "/a/../b",
            "/..",
            "/a/./b",
            "//evil.example",
            "/a//b",
            "/a\\b",
            "/a\u{0}b",
            "/a\nb",
            "/%2e%2e/etc",
            "/%2E%2E%2Fetc",
            "/a%2fb",
            "/a%5Cb",
            "/a%00b",
        ] {
            assert_eq!(
                kind(&run("GET", path, &cfg)),
                Some(("bad-request", 400)),
                "{path:?}"
            );
        }
    }

    #[test]
    fn never_panics_on_any_path_or_method() {
        let cfg = config(Some("https://legacy.example.test"));
        let pieces = [
            "/",
            "..",
            ".",
            "%",
            "%2",
            "é",
            "[",
            "]",
            "[location]",
            "a.b",
            "..%2f",
            "\u{10ffff}",
            "/_astro/",
            "-",
            " ",
            "?",
            "#",
        ];
        for method in [
            "GET", "HEAD", "OPTIONS", "POST", "TRACE", "", "get", "\u{0}",
        ] {
            for a in pieces {
                for b in pieces {
                    for c in ["", "/", "/x", ".html"] {
                        let path = format!("{a}{b}{c}");
                        for len in [None, Some(0), Some(u64::MAX)] {
                            let req = Req {
                                method,
                                path: &path,
                                content_length: len,
                            };
                            let _ = plan(&req, &cfg);
                            let _ = asset_miss(&req, &cfg);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn an_asset_miss_is_a_404_unless_the_legacy_origin_may_have_the_file() {
        let none = config(None);
        let some = config(Some("https://legacy.example.test"));
        let req = Req {
            method: "GET",
            path: "/icon-192.png",
            content_length: None,
        };
        assert_eq!(kind(&asset_miss(&req, &none)), Some(("not-found", 404)));
        assert!(matches!(asset_miss(&req, &some), Plan::Proxy { .. }));
        // A page the table promised and the build lacks does not go anywhere.
        let page = Req {
            method: "GET",
            path: "/about",
            content_length: None,
        };
        assert_eq!(kind(&asset_miss(&page, &some)), Some(("not-found", 404)));
    }
}
