//! Open-Meteo's paid ("customer") hosts and the subscription key.
//!
//! The free API (`api.open-meteo.com` and friends) is non-commercial and
//! refuses the Workers' shared egress address with HTTP 429 (#434). A paid
//! plan serves the same paths and parameters from its own host per product,
//! with the key as the query parameter `apikey`:
//!
//! | Free host                        | Customer host                             | Plan                |
//! | -------------------------------- | ----------------------------------------- | ------------------- |
//! | `api.open-meteo.com`             | `customer-api.open-meteo.com`             | every paid plan     |
//! | `air-quality-api.open-meteo.com` | `customer-air-quality-api.open-meteo.com` | every paid plan     |
//! | `archive-api.open-meteo.com`     | `customer-archive-api.open-meteo.com`     | Professional and up |
//!
//! The archive (historical weather) host is OPT-IN: the Standard plan does not
//! include it, so a key alone never moves archive calls (history, climate
//! normals, the place profile) off the free host. The owner sets the plain
//! Worker var [`ARCHIVE_LICENSED_VAR`] once the plan includes the archive.
//! Geocoding stays on its own host and every other host is left alone.
//!
//! This module is pure. [`paid_url`] rewrites one URL; [`Plan`] holds what a
//! Worker read from its configuration (`weather_edge::open_meteo` sets it once
//! per request and `weather_edge::get_with_timeout` applies it, so no call site
//! builds a keyed URL). The key is in the URL, so such a URL must never be
//! logged, cached or put in an error: [`scrub`] masks it in any text that might
//! carry one.

use std::cell::{Cell, RefCell};
use std::fmt;

/// Free host of the forecast API.
pub const FORECAST_HOST: &str = "api.open-meteo.com";
/// Free host of the air-quality API.
pub const AIR_QUALITY_HOST: &str = "air-quality-api.open-meteo.com";
/// Free host of the historical weather (ERA5 archive) API.
pub const ARCHIVE_HOST: &str = "archive-api.open-meteo.com";

/// The plain Worker var (not a secret) that says the plan includes the archive
/// API: `1`, `true` or `yes`. Unset means archive calls stay on the free host,
/// key or no key.
pub const ARCHIVE_LICENSED_VAR: &str = "OPEN_METEO_ARCHIVE_LICENSED";

/// What replaces a key (or a query value) in text.
pub const REDACTED: &str = "[redacted]";

/// Whether a flag var is on: `1`, `true` or `yes`, any case.
pub fn truthy(v: &str) -> bool {
    matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes")
}

/// The customer host for a free host, `None` for any other host (including a
/// host that is already a customer host). The archive host is mapped only when
/// `archive_licensed`.
fn customer_host(host: &str, archive_licensed: bool) -> Option<&'static str> {
    match host.to_ascii_lowercase().as_str() {
        FORECAST_HOST => Some("customer-api.open-meteo.com"),
        AIR_QUALITY_HOST => Some("customer-air-quality-api.open-meteo.com"),
        ARCHIVE_HOST if archive_licensed => Some("customer-archive-api.open-meteo.com"),
        _ => None,
    }
}

/// Percent-encoding for one query value: everything but the RFC 3986
/// unreserved characters.
fn encode_component(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    for b in v.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `url` moved to its customer host with `apikey=<key>` appended, when it is
/// an `https` URL on a free Open-Meteo host the plan covers; otherwise `url`
/// unchanged (another host, a URL already on a customer host, an empty key).
///
/// The host must match exactly: `api.open-meteo.com.example` or a URL that only
/// mentions the host in its query is not ours. The key is percent-encoded and
/// joined with `?` or `&` as the URL needs, ahead of any fragment.
pub fn paid_url(url: &str, key: &str, archive_licensed: bool) -> String {
    if key.trim().is_empty() {
        return url.to_owned();
    }
    let Some(scheme) = url.get(..8).filter(|s| s.eq_ignore_ascii_case("https://")) else {
        return url.to_owned();
    };
    let rest = &url[scheme.len()..];
    let host_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (host, tail) = rest.split_at(host_end);
    let Some(customer) = customer_host(host, archive_licensed) else {
        return url.to_owned();
    };
    let (target, fragment) = match tail.find('#') {
        Some(i) => tail.split_at(i),
        None => (tail, ""),
    };
    let join = if !target.contains('?') {
        "?"
    } else if target.ends_with('?') || target.ends_with('&') {
        ""
    } else {
        "&"
    };
    format!(
        "https://{customer}{target}{join}apikey={}{fragment}",
        encode_component(key)
    )
}

/// Whether an HTTP status from the customer host means the subscription key
/// itself was refused (invalid, revoked, or the plan lapsed), as opposed to our
/// request being wrong or the quota being spent. The call is then repeated once
/// on the free host, so a bad key degrades to what worked before the
/// subscription instead of to the seasonal estimate for every place.
pub fn key_rejected(status: u16) -> bool {
    (401..=403).contains(&status)
}

/// `text` with the key (raw and percent-encoded) and every `apikey=` query
/// value masked. Use it on anything a failed call might put in a message.
pub fn scrub(text: &str, key: Option<&str>) -> String {
    let mut out = text.to_owned();
    if let Some(k) = key.filter(|k| !k.is_empty()) {
        out = out.replace(k, REDACTED);
        let encoded = encode_component(k);
        if encoded != k {
            out = out.replace(&encoded, REDACTED);
        }
    }
    mask_apikey_values(&out)
}

/// Masks the value of every `apikey=` parameter (any case) up to the next
/// delimiter. `to_ascii_lowercase` keeps byte offsets, so positions found in
/// the lowercase copy index the original.
fn mask_apikey_values(text: &str) -> String {
    const NEEDLE: &str = "apikey=";
    let lower = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while let Some(found) = lower[at..].find(NEEDLE) {
        let value_start = at + found + NEEDLE.len();
        out.push_str(&text[at..value_start]);
        let value_end = text[value_start..]
            .find(|c: char| {
                c.is_whitespace() || matches!(c, '&' | '#' | ')' | '(' | '"' | '\'' | '<' | '>')
            })
            .map_or(text.len(), |i| value_start + i);
        if value_end > value_start {
            out.push_str(REDACTED);
        }
        at = value_end;
    }
    out.push_str(&text[at..]);
    out
}

/// What the Worker knows about the Open-Meteo subscription: the key (if any)
/// and whether the plan includes the archive API. Set once per request, read
/// by every outbound Open-Meteo call.
#[derive(Default)]
pub struct Plan {
    key: RefCell<Option<String>>,
    archive_licensed: Cell<bool>,
}

impl Plan {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replace what is held. A blank key counts as none, so removing the
    /// secret puts the next request back on the free hosts.
    pub fn set(&self, key: Option<String>, archive_licensed: bool) {
        *self.key.borrow_mut() = key.filter(|k| !k.trim().is_empty());
        self.archive_licensed.set(archive_licensed);
    }

    /// Whether a key is held (forecast and air quality use the customer hosts).
    pub fn is_paid(&self) -> bool {
        self.key.borrow().is_some()
    }

    /// Whether archive calls use the customer host: a key AND the plan flag.
    pub fn archive_is_paid(&self) -> bool {
        self.is_paid() && self.archive_licensed.get()
    }

    /// Whether the flag is set (reported by `/health`, even with no key).
    pub fn archive_licensed(&self) -> bool {
        self.archive_licensed.get()
    }

    /// `url` as it must be requested: on the customer host with the key when
    /// one is held and the plan covers that host, else unchanged.
    pub fn url(&self, url: &str) -> String {
        match self.key.borrow().as_deref() {
            Some(key) => paid_url(url, key, self.archive_licensed.get()),
            None => url.to_owned(),
        }
    }

    /// `text` with the held key masked (and any `apikey=` value).
    pub fn scrub(&self, text: &str) -> String {
        scrub(text, self.key.borrow().as_deref())
    }
}

/// Never prints the key.
impl fmt::Debug for Plan {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Plan")
            .field("paid", &self.is_paid())
            .field("archive_licensed", &self.archive_licensed.get())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_a_refused_key_falls_back_to_the_free_host() {
        for refused in [401, 402, 403] {
            assert!(key_rejected(refused));
        }
        // Our request is wrong, the quota is spent or the service is down:
        // the free host would not help (or must not be hammered).
        for other in [200, 400, 404, 429, 500, 503] {
            assert!(!key_rejected(other));
        }
    }

    use super::*;

    const KEY: &str = "om_live_AbC123xyz";

    fn forecast() -> String {
        "https://api.open-meteo.com/v1/forecast?latitude=-17.83&longitude=31.05".to_owned()
    }

    #[test]
    fn forecast_and_air_quality_map_with_and_without_the_archive_flag() {
        for licensed in [false, true] {
            assert_eq!(
                paid_url(&forecast(), KEY, licensed),
                format!("https://customer-api.open-meteo.com/v1/forecast?latitude=-17.83&longitude=31.05&apikey={KEY}")
            );
            assert_eq!(
                paid_url(
                    "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=1&hourly=us_aqi",
                    KEY,
                    licensed
                ),
                format!("https://customer-air-quality-api.open-meteo.com/v1/air-quality?latitude=1&hourly=us_aqi&apikey={KEY}")
            );
        }
    }

    #[test]
    fn the_archive_host_moves_only_when_the_plan_includes_it() {
        let url = "https://archive-api.open-meteo.com/v1/archive?latitude=1&longitude=2";
        // A key and no flag: unchanged, exactly as before the key existed.
        assert_eq!(paid_url(url, KEY, false), url);
        assert_eq!(
            paid_url(url, KEY, true),
            format!("https://customer-archive-api.open-meteo.com/v1/archive?latitude=1&longitude=2&apikey={KEY}")
        );
    }

    #[test]
    fn other_hosts_and_look_alikes_are_left_alone() {
        for url in [
            // Geocoding stays on its own host (it answers without a key).
            "https://geocoding-api.open-meteo.com/v1/search?name=harare",
            "https://ensemble-api.open-meteo.com/v1/ensemble?latitude=1",
            "https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=1",
            "https://open-meteo.com/en/docs",
            "https://api.tomorrow.io/v4/weather/forecast?location=1,2",
            "https://power.larc.nasa.gov/api/temporal/daily/point?x=1",
            // Look-alikes: the host must match exactly.
            "https://api.open-meteo.com.example.test/v1/forecast?x=1",
            "https://example.test/v1/forecast?u=https://api.open-meteo.com/v1/forecast",
            "https://user@api.open-meteo.com/v1/forecast",
            // Not https.
            "http://api.open-meteo.com/v1/forecast?x=1",
            "api.open-meteo.com/v1/forecast",
            "",
        ] {
            for licensed in [false, true] {
                assert_eq!(paid_url(url, KEY, licensed), url, "{url}");
            }
        }
    }

    #[test]
    fn a_url_on_a_customer_host_is_never_keyed_twice() {
        for url in [
            "https://customer-api.open-meteo.com/v1/forecast?x=1",
            "https://customer-air-quality-api.open-meteo.com/v1/air-quality?x=1",
            "https://customer-archive-api.open-meteo.com/v1/archive?x=1",
        ] {
            assert_eq!(paid_url(url, KEY, true), url);
        }
        let once = paid_url(&forecast(), KEY, true);
        assert_eq!(paid_url(&once, KEY, true), once, "idempotent");
    }

    #[test]
    fn no_key_leaves_the_url_unchanged() {
        assert_eq!(paid_url(&forecast(), "", true), forecast());
        assert_eq!(paid_url(&forecast(), "   ", true), forecast());
        let plan = Plan::new();
        assert_eq!(plan.url(&forecast()), forecast());
        plan.set(None, true);
        assert_eq!(plan.url(&forecast()), forecast());
        plan.set(Some("  ".into()), true);
        assert!(!plan.is_paid());
        assert_eq!(plan.url(&forecast()), forecast());
    }

    #[test]
    fn the_key_is_percent_encoded_and_joined_as_the_url_needs() {
        // Characters that would end or corrupt a query value.
        let hard = "a b&c=d/e+f%g#h?i é";
        let encoded = "a%20b%26c%3Dd%2Fe%2Bf%25g%23h%3Fi%20%C3%A9";
        assert_eq!(
            paid_url("https://api.open-meteo.com/v1/forecast?x=1", hard, false),
            format!("https://customer-api.open-meteo.com/v1/forecast?x=1&apikey={encoded}")
        );
        // No query yet: `?`.
        assert_eq!(
            paid_url("https://api.open-meteo.com/v1/forecast", KEY, false),
            format!("https://customer-api.open-meteo.com/v1/forecast?apikey={KEY}")
        );
        assert_eq!(
            paid_url("https://api.open-meteo.com", KEY, false),
            format!("https://customer-api.open-meteo.com?apikey={KEY}")
        );
        // A trailing `?` or `&` is not doubled.
        assert_eq!(
            paid_url("https://api.open-meteo.com/v1/forecast?", KEY, false),
            format!("https://customer-api.open-meteo.com/v1/forecast?apikey={KEY}")
        );
        assert_eq!(
            paid_url("https://api.open-meteo.com/v1/forecast?x=1&", KEY, false),
            format!("https://customer-api.open-meteo.com/v1/forecast?x=1&apikey={KEY}")
        );
        // A fragment stays last.
        assert_eq!(
            paid_url("https://api.open-meteo.com/v1/forecast?x=1#top", KEY, false),
            format!("https://customer-api.open-meteo.com/v1/forecast?x=1&apikey={KEY}#top")
        );
        // Scheme and host case do not matter.
        assert_eq!(
            paid_url("HTTPS://API.Open-Meteo.com/v1/forecast?x=1", KEY, false),
            format!("https://customer-api.open-meteo.com/v1/forecast?x=1&apikey={KEY}")
        );
        // The encoded key survives a URL parse as ONE value.
        let url = paid_url("https://api.open-meteo.com/v1/forecast?x=1", hard, false);
        let value = url.split("apikey=").nth(1).unwrap();
        assert!(!value.contains(['&', '=', '#', '?', ' ', '/', '+']));
    }

    #[test]
    fn the_flag_reads_like_the_other_worker_flags() {
        for on in ["1", "true", "TRUE", " yes ", "Yes"] {
            assert!(truthy(on), "{on}");
        }
        for off in ["", "0", "false", "no", "2", "licensed"] {
            assert!(!truthy(off), "{off}");
        }
    }

    #[test]
    fn the_plan_applies_the_key_the_flag_and_nothing_else() {
        let plan = Plan::new();
        let archive = "https://archive-api.open-meteo.com/v1/archive?latitude=1";
        let geo = "https://geocoding-api.open-meteo.com/v1/search?name=x";

        // Free: nothing moves.
        assert!(!plan.is_paid() && !plan.archive_is_paid());
        assert_eq!(plan.url(archive), archive);

        // Key, no flag (the Standard plan): forecast and air quality move,
        // the archive does not.
        plan.set(Some(KEY.into()), false);
        assert!(plan.is_paid() && !plan.archive_is_paid() && !plan.archive_licensed());
        assert!(plan
            .url(&forecast())
            .starts_with("https://customer-api.open-meteo.com/"));
        assert_eq!(plan.url(archive), archive);
        assert_eq!(plan.url(geo), geo);

        // Key and flag (Professional): the archive moves too.
        plan.set(Some(KEY.into()), true);
        assert!(plan.archive_is_paid());
        assert!(plan
            .url(archive)
            .starts_with("https://customer-archive-api.open-meteo.com/v1/archive?"));
        assert_eq!(plan.url(geo), geo);

        // The flag without a key changes nothing: there is no paid access.
        plan.set(None, true);
        assert!(plan.archive_licensed() && !plan.archive_is_paid());
        assert_eq!(plan.url(archive), archive);
        assert_eq!(plan.url(&forecast()), forecast());
    }

    #[test]
    fn scrub_removes_the_key_in_any_form() {
        let key = "k&y/secret+1";
        let url = paid_url(&forecast(), key, false);
        assert!(url.contains("apikey=k%26y%2Fsecret%2B1"));
        // The runtime's error text can embed the whole URL.
        let message = format!("TypeError: error sending request for url ({url}): connection reset");
        let clean = scrub(&message, Some(key));
        assert!(!clean.contains("secret"));
        assert!(!clean.contains("k%26y"));
        assert!(clean.contains("connection reset"));
        assert!(clean.contains("apikey=[redacted]"));
        // With no key in hand, an `apikey=` value is still masked.
        let blind = scrub(&message, None);
        assert!(!blind.contains("secret") && blind.contains("apikey=[redacted]"));
        // The raw key outside a parameter is masked when the key is known.
        assert_eq!(
            scrub("bad key k&y/secret+1!", Some(key)),
            "bad key [redacted]!"
        );
        // Upper-case parameter, several parameters, quotes, an empty value.
        assert_eq!(
            scrub("a?APIKEY=abc&b=1 'x?apikey=def' apikey=", None),
            "a?APIKEY=[redacted]&b=1 'x?apikey=[redacted]' apikey="
        );
        // Text with nothing to hide is returned as it was.
        assert_eq!(scrub("HTTP 429", Some(key)), "HTTP 429");
    }

    #[test]
    fn the_plan_scrubs_its_own_key_and_never_prints_it() {
        let plan = Plan::new();
        plan.set(Some(KEY.into()), true);
        let text = format!("failed: {}", plan.url(&forecast()));
        assert!(text.contains(KEY));
        let clean = plan.scrub(&text);
        assert!(!clean.contains(KEY));
        assert!(!format!("{plan:?}").contains(KEY));
        assert_eq!(
            format!("{plan:?}"),
            "Plan { paid: true, archive_licensed: true }"
        );
    }

    /// Every Open-Meteo URL the Workers build, against the hosts above: a new
    /// call on a covered host is picked up with no change at its call site,
    /// and the archive stays free unless the plan says otherwise.
    #[test]
    fn every_open_meteo_url_the_workers_build_maps_as_intended() {
        let key = KEY;
        let forecast_urls = [
            crate::normalize::OPEN_METEO_FORECAST_URL,
            crate::haze::FORECAST_URL,
            crate::agriculture::FORECAST_URL,
            crate::model_grid::OPEN_METEO_FORECAST_URL,
        ];
        for u in forecast_urls {
            assert!(u.contains(FORECAST_HOST), "{u}");
            assert!(paid_url(u, key, false).starts_with("https://customer-api.open-meteo.com/"));
        }
        let aq_urls = [
            crate::air_quality::OPEN_METEO_AQ_URL,
            crate::aq_grid::OPEN_METEO_AQ_URL,
            crate::haze::AQ_URL,
        ];
        for u in aq_urls {
            assert!(u.contains(AIR_QUALITY_HOST), "{u}");
            assert!(paid_url(u, key, false)
                .starts_with("https://customer-air-quality-api.open-meteo.com/"));
        }
        let archive_urls = [
            crate::history::ARCHIVE_URL,
            crate::normals::ARCHIVE_URL,
            crate::climate_normals::ARCHIVE_URL,
        ];
        for u in archive_urls {
            assert!(u.contains(ARCHIVE_HOST), "{u}");
            assert_eq!(paid_url(u, key, false), u, "a key alone leaves {u}");
            assert!(paid_url(u, key, true)
                .starts_with("https://customer-archive-api.open-meteo.com/v1/archive"));
        }
        // The built requests (parameters and all), not only the base URLs.
        let built = [
            crate::normals::archive_url(-17.8, 31.05),
            crate::normals::monthly_archive_url(-17.8, 31.05),
            crate::climate_normals::archive_url(-17.8, 31.05),
            crate::history::open_meteo_archive_url(-17.8, 31.05, "2026-01-01", "2026-01-31"),
        ];
        for u in built {
            assert!(u.starts_with("https://archive-api.open-meteo.com/"), "{u}");
            assert_eq!(paid_url(&u, key, false), u);
            let paid = paid_url(&u, key, true);
            assert!(paid.starts_with("https://customer-archive-api.open-meteo.com/"));
            assert!(paid.ends_with(&format!("&apikey={key}")), "{paid}");
        }
        let models = vec!["ecmwf_ifs".to_owned(), "gfs_seamless".to_owned()];
        let forecast_built = [
            crate::blend::open_meteo_url(-17.8, 31.05, &models),
            crate::normalize::open_meteo_url(-17.8, 31.05),
            crate::normalize::open_meteo_extras_url(-17.8, 31.05, &models),
            crate::model_grid::open_meteo_url(&[(1.0, 2.0)], "ecmwf_ifs"),
            crate::agriculture::forecast_url("https://api.open-meteo.com", -17.8, 31.05),
        ];
        for u in forecast_built {
            let paid = paid_url(&u, key, false);
            assert!(
                paid.starts_with("https://customer-api.open-meteo.com/"),
                "{u}"
            );
            assert!(paid.ends_with(&format!("&apikey={key}")), "{paid}");
        }
        let aq_built = [
            crate::air_quality::open_meteo_url(1.0, 2.0),
            crate::aq_grid::open_meteo_url(&[(1.0, 2.0), (1.5, 2.5)]),
        ];
        for u in aq_built {
            let paid = paid_url(&u, key, false);
            assert!(
                paid.starts_with("https://customer-air-quality-api.open-meteo.com/"),
                "{u}"
            );
            assert!(paid.ends_with(&format!("&apikey={key}")), "{paid}");
        }
    }
}
