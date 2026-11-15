//! Cache rules, by what the file is.
//!
//! The rule that matters most: **no `no-store` on a page** (HTML, a problem
//! page, a redirect). `no-store` keeps a page out of the back/forward cache, so
//! Back re-fetches and re-renders instead of restoring the page as it was. A
//! page that must be fresh says `no-cache` (store it, check before reusing it),
//! and the static assets binding answers that check with a `304` from the
//! file's `ETag`. `no-store` is for the one response that is truly private and
//! must never be kept: here, only the probe endpoints, which are not pages.

/// What a served file is, which decides how long it may be reused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetClass {
    /// A page the build wrote (`about.html`).
    Html,
    /// `_astro/*`: the name carries a hash of the content, so the bytes behind
    /// a URL never change.
    Hashed,
    /// `/sw.js`: must be re-checked on every update check or a bad worker
    /// outlives its fix.
    ServiceWorker,
    /// `/manifest.json`: small, and the install surface reads it.
    Manifest,
    /// `vendor/maplibre-gl/<version>/*`: a per-version folder, like a hash.
    Versioned,
    /// Anything else in `public/` (icons, `llms.txt`): changes rarely, never
    /// has a hash in its name.
    Static,
}

/// The class of the asset at `asset_path` (no leading slash).
pub fn classify(asset_path: &str) -> AssetClass {
    let path = asset_path.trim_start_matches('/');
    if path.starts_with("_astro/") {
        AssetClass::Hashed
    } else if path == "sw.js" {
        AssetClass::ServiceWorker
    } else if path == "manifest.json" || path.ends_with(".webmanifest") {
        AssetClass::Manifest
    } else if path.starts_with("vendor/maplibre-gl/") {
        AssetClass::Versioned
    } else if path.ends_with(".html") {
        AssetClass::Html
    } else {
        AssetClass::Static
    }
}

/// `Cache-Control` for a class.
pub fn cache_control(class: AssetClass) -> &'static str {
    match class {
        AssetClass::Hashed | AssetClass::Versioned => "public, max-age=31536000, immutable",
        AssetClass::Html | AssetClass::ServiceWorker | AssetClass::Manifest => "no-cache",
        AssetClass::Static => "public, max-age=86400, stale-while-revalidate=604800",
    }
}

/// A problem document: never reused without a check (the route may move over
/// at the next deploy), and never `no-store` (see the module note).
pub const PROBLEM_CACHE_CONTROL: &str = "no-cache";

/// The trailing-slash redirect is permanent by design (URLs have no trailing
/// slash), so it may be kept for a day.
pub const REDIRECT_CACHE_CONTROL: &str = "public, max-age=86400";

/// The probes answer a question about now.
pub const PROBE_CACHE_CONTROL: &str = "no-store";

/// A `Content-Type` the Worker sets itself instead of trusting a file
/// extension, where the wrong one has a consequence.
pub fn content_type(class: AssetClass) -> Option<&'static str> {
    match class {
        // A service worker script served as anything but a JavaScript type is
        // refused by the browser.
        AssetClass::ServiceWorker => Some("text/javascript; charset=utf-8"),
        AssetClass::Manifest => Some("application/manifest+json"),
        AssetClass::Html => Some("text/html; charset=utf-8"),
        _ => None,
    }
}

/// `Service-Worker-Allowed`: the worker is served from `/`, so its scope is
/// `/` already; the header is explicit so a later move of the script cannot
/// narrow the scope silently (it is what the Next.js app sent).
pub fn service_worker_allowed(class: AssetClass) -> Option<&'static str> {
    (class == AssetClass::ServiceWorker).then_some("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_by_what_the_file_is() {
        assert_eq!(classify("_astro/client.abc123.js"), AssetClass::Hashed);
        assert_eq!(classify("sw.js"), AssetClass::ServiceWorker);
        assert_eq!(classify("manifest.json"), AssetClass::Manifest);
        assert_eq!(classify("app.webmanifest"), AssetClass::Manifest);
        assert_eq!(
            classify("vendor/maplibre-gl/5.1.0/worker.js"),
            AssetClass::Versioned
        );
        assert_eq!(classify("about.html"), AssetClass::Html);
        assert_eq!(classify("icon-192.png"), AssetClass::Static);
        assert_eq!(classify("/about.html"), AssetClass::Html);
    }

    #[test]
    fn hashed_assets_are_immutable() {
        for c in [AssetClass::Hashed, AssetClass::Versioned] {
            let v = cache_control(c);
            assert!(v.contains("immutable") && v.contains("max-age=31536000"));
        }
    }

    #[test]
    fn pages_never_say_no_store_so_back_restores_them() {
        for c in [
            AssetClass::Html,
            AssetClass::ServiceWorker,
            AssetClass::Manifest,
            AssetClass::Hashed,
            AssetClass::Versioned,
            AssetClass::Static,
        ] {
            assert!(!cache_control(c).contains("no-store"), "{c:?}");
        }
        assert!(!PROBLEM_CACHE_CONTROL.contains("no-store"));
        assert!(!REDIRECT_CACHE_CONTROL.contains("no-store"));
        assert_eq!(cache_control(AssetClass::Html), "no-cache");
    }

    #[test]
    fn service_worker_is_always_rechecked_and_scoped_to_root() {
        assert_eq!(cache_control(AssetClass::ServiceWorker), "no-cache");
        assert_eq!(service_worker_allowed(AssetClass::ServiceWorker), Some("/"));
        assert_eq!(service_worker_allowed(AssetClass::Html), None);
        assert_eq!(
            content_type(AssetClass::ServiceWorker),
            Some("text/javascript; charset=utf-8")
        );
    }

    #[test]
    fn manifest_has_its_media_type() {
        assert_eq!(
            content_type(AssetClass::Manifest),
            Some("application/manifest+json")
        );
    }
}
