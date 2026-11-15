//! The route table: every route the Next.js app serves, and whether the web
//! Worker serves it yet. The data is `workers/web/routing/routes.json` (the
//! counterpart of the API's `routing/routes.json`); this module parses it and
//! matches paths against it, with Next.js's own pattern syntax
//! (`[param]`, `[...rest]`, `[[...rest]]`) so the table can name routes the
//! way the app's folders do.
//!
//! A test (`routes_json_names_every_next_route`) walks `src/app` and fails when
//! a route exists there that the table does not list, so a route added to the
//! Next.js app cannot be forgotten by the migration.

use serde::Deserialize;

/// Where a route stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// The built Astro output has this page; the Worker serves `asset`.
    Migrated,
    /// Only the Next.js app serves it today.
    NotMigrated,
}

/// One row of `routes.json`'s `routes`.
#[derive(Debug, Clone, Deserialize)]
pub struct Entry {
    pub pattern: String,
    /// The file in `src/app` (or the build step) that makes the route, so the
    /// table can be checked against the tree.
    pub next_file: String,
    pub status: Status,
    /// The file in the build output, for a migrated route.
    pub asset: Option<String>,
    /// The migration phase of #475 that moves it.
    pub phase: Option<String>,
}

/// A page that exists only in the Astro build (no Next.js route).
#[derive(Debug, Clone, Deserialize)]
pub struct AstroOnly {
    pub pattern: String,
    pub asset: String,
}

#[derive(Debug, Deserialize)]
struct File {
    routes: Vec<Entry>,
    astro_only: Vec<AstroOnly>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Seg {
    Static(String),
    Dynamic,
    CatchAll,
    OptionalCatchAll,
}

impl Seg {
    fn parse(raw: &str) -> Seg {
        if raw.starts_with("[[...") && raw.ends_with("]]") {
            Seg::OptionalCatchAll
        } else if raw.starts_with("[...") && raw.ends_with(']') {
            Seg::CatchAll
        } else if raw.starts_with('[') && raw.ends_with(']') {
            Seg::Dynamic
        } else {
            Seg::Static(raw.to_owned())
        }
    }

    /// Static beats dynamic beats catch-all, as in Next.js.
    fn rank(&self) -> u8 {
        match self {
            Seg::Static(_) => 3,
            Seg::Dynamic => 2,
            Seg::CatchAll | Seg::OptionalCatchAll => 1,
        }
    }
}

/// What a matched route is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// Serve this asset.
    Page { asset: String },
    /// The Next.js app serves it.
    NotMigrated,
}

/// A compiled route.
#[derive(Debug, Clone)]
pub struct Route {
    pub pattern: String,
    segs: Vec<Seg>,
    pub target: Target,
    /// Whether any segment is a parameter.
    pub dynamic: bool,
}

/// A parsed `routes.json`.
#[derive(Debug, Clone)]
pub struct RouteTable {
    routes: Vec<Route>,
}

fn path_segments(path: &str) -> Vec<&str> {
    let trimmed = path.trim_start_matches('/');
    if trimmed.is_empty() {
        Vec::new()
    } else {
        trimmed.split('/').collect()
    }
}

fn matches(pattern: &[Seg], path: &[&str]) -> bool {
    match (pattern.split_first(), path.split_first()) {
        (None, None) => true,
        (None, Some(_)) => false,
        (Some((Seg::OptionalCatchAll, _)), _) => true,
        (Some((Seg::CatchAll, _)), rest) => rest.is_some(),
        (Some(_), None) => false,
        (Some((Seg::Static(s), tail)), Some((first, rest))) => s == first && matches(tail, rest),
        (Some((Seg::Dynamic, tail)), Some((first, rest))) => {
            !first.is_empty() && matches(tail, rest)
        }
    }
}

impl RouteTable {
    /// Parse and validate `routes.json`. A table that contradicts itself is an
    /// error at start-up, never a surprise on a request.
    pub fn parse(json: &str) -> Result<Self, String> {
        let file: File = serde_json::from_str(json).map_err(|e| format!("routes.json: {e}"))?;
        let mut routes: Vec<Route> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut add = |pattern: &str, target: Target| -> Result<(), String> {
            if !pattern.starts_with('/') || (pattern.len() > 1 && pattern.ends_with('/')) {
                return Err(format!("routes.json: bad pattern {pattern:?}"));
            }
            if !seen.insert(pattern.to_owned()) {
                return Err(format!("routes.json: {pattern:?} is listed twice"));
            }
            let segs: Vec<Seg> = path_segments(pattern).into_iter().map(Seg::parse).collect();
            let catch_all_not_last = segs
                .iter()
                .take(segs.len().saturating_sub(1))
                .any(|s| matches!(s, Seg::CatchAll | Seg::OptionalCatchAll));
            if catch_all_not_last {
                return Err(format!(
                    "routes.json: {pattern:?}: a catch-all must be last"
                ));
            }
            let dynamic = segs.iter().any(|s| !matches!(s, Seg::Static(_)));
            routes.push(Route {
                pattern: pattern.to_owned(),
                segs,
                target,
                dynamic,
            });
            Ok(())
        };
        for e in &file.routes {
            let target = match (e.status, &e.asset) {
                (Status::Migrated, Some(asset)) => {
                    check_asset(asset)?;
                    Target::Page {
                        asset: asset.clone(),
                    }
                }
                (Status::Migrated, None) => {
                    return Err(format!(
                        "routes.json: {} is migrated with no asset",
                        e.pattern
                    ))
                }
                (Status::NotMigrated, None) => Target::NotMigrated,
                (Status::NotMigrated, Some(_)) => {
                    return Err(format!(
                        "routes.json: {} is not migrated but names an asset",
                        e.pattern
                    ))
                }
            };
            add(&e.pattern, target)?;
        }
        for a in &file.astro_only {
            check_asset(&a.asset)?;
            add(
                &a.pattern,
                Target::Page {
                    asset: a.asset.clone(),
                },
            )?;
        }
        Ok(Self { routes })
    }

    /// The best match for `path` (no query), if any.
    pub fn lookup(&self, path: &str) -> Option<&Route> {
        let segs = path_segments(path);
        self.routes
            .iter()
            .filter(|r| matches(&r.segs, &segs))
            .max_by(|a, b| {
                let ra: Vec<u8> = a.segs.iter().map(Seg::rank).collect();
                let rb: Vec<u8> = b.segs.iter().map(Seg::rank).collect();
                // On a tie the earlier row wins (`max_by` keeps the last).
                ra.cmp(&rb).then(std::cmp::Ordering::Greater)
            })
    }

    pub fn routes(&self) -> &[Route] {
        &self.routes
    }

    /// The asset of every migrated route, for a check against a build.
    pub fn assets(&self) -> Vec<&str> {
        self.routes
            .iter()
            .filter_map(|r| match &r.target {
                Target::Page { asset } => Some(asset.as_str()),
                Target::NotMigrated => None,
            })
            .collect()
    }
}

fn check_asset(asset: &str) -> Result<(), String> {
    if asset.is_empty()
        || asset.starts_with('/')
        || asset
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
        || asset.contains('\\')
    {
        return Err(format!("routes.json: bad asset path {asset:?}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::path::{Path, PathBuf};

    const TABLE: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../web/routing/routes.json"
    ));

    fn table() -> RouteTable {
        RouteTable::parse(TABLE).unwrap()
    }

    fn small() -> RouteTable {
        RouteTable::parse(
            r#"{"routes":[
              {"pattern":"/","next_file":"a","status":"not_migrated"},
              {"pattern":"/about","next_file":"a","status":"migrated","asset":"about.html"},
              {"pattern":"/[location]","next_file":"a","status":"not_migrated"},
              {"pattern":"/[location]/forecast","next_file":"a","status":"not_migrated"},
              {"pattern":"/explore","next_file":"a","status":"not_migrated"},
              {"pattern":"/explore/[tag]","next_file":"a","status":"not_migrated"},
              {"pattern":"/explore/country","next_file":"a","status":"not_migrated"},
              {"pattern":"/api/ai/[[...path]]","next_file":"a","status":"not_migrated"},
              {"pattern":"/docs/[...rest]","next_file":"a","status":"not_migrated"}
            ],"astro_only":[{"pattern":"/shell-preview","asset":"shell-preview.html"}]}"#,
        )
        .unwrap()
    }

    #[test]
    fn static_beats_dynamic() {
        let t = small();
        assert_eq!(t.lookup("/about").unwrap().pattern, "/about");
        assert_eq!(t.lookup("/harare").unwrap().pattern, "/[location]");
        assert_eq!(
            t.lookup("/explore/country").unwrap().pattern,
            "/explore/country"
        );
        assert_eq!(
            t.lookup("/explore/farming").unwrap().pattern,
            "/explore/[tag]"
        );
        assert_eq!(
            t.lookup("/harare/forecast").unwrap().pattern,
            "/[location]/forecast"
        );
        assert_eq!(t.lookup("/").unwrap().pattern, "/");
    }

    #[test]
    fn catch_alls() {
        let t = small();
        assert_eq!(t.lookup("/api/ai").unwrap().pattern, "/api/ai/[[...path]]");
        assert_eq!(
            t.lookup("/api/ai/a/b").unwrap().pattern,
            "/api/ai/[[...path]]"
        );
        // `/docs` alone is not under `/docs/[...rest]` (a catch-all needs one
        // segment); here the dynamic `/[location]` is what takes it.
        assert_eq!(t.lookup("/docs").unwrap().pattern, "/[location]");
        assert_eq!(t.lookup("/docs/a/b/c").unwrap().pattern, "/docs/[...rest]");
    }

    #[test]
    fn no_match_is_none() {
        let t = small();
        assert!(t.lookup("/a/b/c").is_none());
        assert!(t.lookup("/harare/nope").is_none());
    }

    #[test]
    fn astro_only_pages_are_pages() {
        let t = small();
        let r = t.lookup("/shell-preview").unwrap();
        assert_eq!(
            r.target,
            Target::Page {
                asset: "shell-preview.html".into()
            }
        );
        assert!(!r.dynamic);
    }

    #[test]
    fn a_contradicting_table_is_refused() {
        for bad in [
            r#"{"routes":[{"pattern":"/a","next_file":"x","status":"migrated"}],"astro_only":[]}"#,
            r#"{"routes":[{"pattern":"/a","next_file":"x","status":"not_migrated","asset":"a.html"}],"astro_only":[]}"#,
            r#"{"routes":[{"pattern":"a","next_file":"x","status":"not_migrated"}],"astro_only":[]}"#,
            r#"{"routes":[{"pattern":"/a/","next_file":"x","status":"not_migrated"}],"astro_only":[]}"#,
            r#"{"routes":[{"pattern":"/a","next_file":"x","status":"not_migrated"},{"pattern":"/a","next_file":"y","status":"not_migrated"}],"astro_only":[]}"#,
            r#"{"routes":[{"pattern":"/a/[...r]/b","next_file":"x","status":"not_migrated"}],"astro_only":[]}"#,
            r#"{"routes":[{"pattern":"/a","next_file":"x","status":"migrated","asset":"../a.html"}],"astro_only":[]}"#,
            r#"{"routes":[{"pattern":"/a","next_file":"x","status":"sometimes"}],"astro_only":[]}"#,
            "not json",
        ] {
            assert!(RouteTable::parse(bad).is_err(), "{bad}");
        }
    }

    // --- the real table -------------------------------------------------

    fn app_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../src/app")
    }

    /// The route a file under `src/app` makes, or `None` for a file that is
    /// not a route (components, tests, CSS).
    fn route_of(rel: &str) -> Option<String> {
        let (dir, file) = rel.rsplit_once('/').unwrap_or(("", rel));
        let stem_dir = if dir.is_empty() {
            String::new()
        } else {
            format!("/{dir}")
        };
        match file {
            "page.tsx" | "route.ts" | "route.tsx" => Some(if stem_dir.is_empty() {
                "/".into()
            } else {
                stem_dir
            }),
            // Metadata routes and the service worker source (built to /sw.js).
            "robots.ts" => Some(format!("{stem_dir}/robots.txt")),
            "sitemap.ts" => Some(format!("{stem_dir}/sitemap.xml")),
            "sw.ts" => Some(format!("{stem_dir}/sw.js")),
            _ => None,
        }
    }

    fn walk(dir: &Path, root: &Path, out: &mut BTreeSet<(String, String)>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(&path, root, out);
            } else {
                let rel = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                if let Some(route) = route_of(&rel) {
                    out.insert((route, format!("src/app/{rel}")));
                }
            }
        }
    }

    #[test]
    fn routes_json_names_every_next_route() {
        let root = app_dir();
        assert!(root.is_dir(), "src/app not found at {root:?}");
        let mut on_disk = BTreeSet::new();
        walk(&root, &root, &mut on_disk);
        assert!(on_disk.len() > 30, "found only {} routes", on_disk.len());

        let file: File = serde_json::from_str(TABLE).unwrap();
        let listed: BTreeSet<(String, String)> = file
            .routes
            .iter()
            .map(|e| (e.pattern.clone(), e.next_file.clone()))
            .collect();

        let missing: Vec<_> = on_disk.difference(&listed).collect();
        let stale: Vec<_> = listed.difference(&on_disk).collect();
        assert!(
            missing.is_empty(),
            "routes in src/app that workers/web/routing/routes.json does not list \
             (add them, status not_migrated): {missing:#?}"
        );
        assert!(
            stale.is_empty(),
            "routes.json lists routes that src/app no longer has \
             (the route moved or went; update the table): {stale:#?}"
        );
    }

    #[test]
    fn the_table_parses_and_every_migrated_route_has_an_asset() {
        let t = table();
        assert!(t.routes().len() > 30);
        for r in t.routes() {
            if let Target::Page { asset } = &r.target {
                assert!(!asset.is_empty(), "{}", r.pattern);
            }
        }
    }

    #[test]
    fn about_and_shell_preview_are_served_and_the_rest_is_not_yet() {
        let t = table();
        assert_eq!(
            t.lookup("/about").unwrap().target,
            Target::Page {
                asset: "about.html".into()
            }
        );
        assert_eq!(
            t.lookup("/shell-preview").unwrap().target,
            Target::Page {
                asset: "shell-preview.html".into()
            }
        );
        assert_eq!(t.lookup("/").unwrap().target, Target::NotMigrated);
        assert_eq!(t.lookup("/harare").unwrap().target, Target::NotMigrated);
        assert_eq!(
            t.lookup("/harare/forecast").unwrap().target,
            Target::NotMigrated
        );
    }
}
