//! Hourly budgets for the third-party geocoders (Open-Meteo forward geocoding,
//! Nominatim reverse geocoding), kept in D1 (`rate_events`, migration 0002).
//!
//! Both services are free and meant for light use, so every UNCACHED call is
//! counted per client and for the whole service, per action, so one surface
//! (autocomplete) can never starve another (a bare name in a URL). The pure
//! parts live here, tested natively; the Worker (`mukoko-weather-places`) only
//! runs the SQL.
//!
//! Who is "the client" is pluggable ([`client_key`]): a verified token subject
//! when the caller presents one, else the IP address. No token verifier exists
//! yet (the issuer is a platform responsibility, tracked in #148), so for now
//! every caller is keyed by IP, which is the real visitor for a browser that
//! calls the Worker directly. Only a hash is stored, never the IP or subject.

use sha2::{Digest, Sha256};

/// Budgets are per hour.
pub const HOUR_MS: u64 = 3_600_000;
/// `rate_events.client` of the service-wide row.
pub const GLOBAL_CLIENT: &str = "*";

/// What is being rationed. Each has its own budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Forward geocode for a bare name in a URL (`/koh-samui`).
    Resolve,
    /// Forward geocode for search and autocomplete.
    Search,
    /// Nominatim reverse geocode (policy: about one request a second for the
    /// whole app).
    Nominatim,
    /// Open-Meteo model-grid fetch (a cache miss of `/v1/model-grid`: one
    /// request carries 49 locations, and the free API allows about 10,000 a day).
    ModelGrid,
    /// A place-profile request that needs an upstream (a 30-year archive
    /// request, SoilGrids): a cache hit is free.
    PlaceProfile,
}

/// Hourly limits for one action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub per_client: u32,
    pub global: u32,
}

impl Action {
    /// The `rate_events.action` value.
    pub fn name(self) -> &'static str {
        match self {
            Action::Resolve => "geocode-resolve",
            Action::Search => "geocode-search",
            Action::Nominatim => "nominatim",
            Action::ModelGrid => "model-grid",
            Action::PlaceProfile => "place-profile",
        }
    }

    /// Conservative on purpose. Open-Meteo's free geocoder is about 10,000
    /// calls a day for everything on the app, so the two forward budgets
    /// together cap at 12,000 a day only if every hour is saturated (KV caches
    /// answers a day, so real use is far lower). Resolve is a proxy path: all
    /// its calls arrive from the site's few egress addresses, so its per-client
    /// limit is high and the proxy meters each visitor itself. Nominatim stays
    /// under one request a second service-wide (3,000 an hour is 0.83/s).
    pub fn limits(self) -> Limits {
        match self {
            Action::Resolve => Limits {
                per_client: 60,
                global: 150,
            },
            Action::Search => Limits {
                per_client: 120,
                global: 350,
            },
            Action::Nominatim => Limits {
                per_client: 60,
                global: 3_000,
            },
            // 30 misses an hour per client, as in the Python backend; the
            // service-wide cap keeps 49 locations a miss under the free API's
            // daily allowance (100 an hour is at most 4,900 locations an hour).
            Action::ModelGrid => Limits {
                per_client: 30,
                global: 100,
            },
            // 120 builds an hour per client, as in the Python backend; each
            // is one archive request (about 250 KB) and two SoilGrids calls.
            Action::PlaceProfile => Limits {
                per_client: 120,
                global: 600,
            },
        }
    }
}

/// Longest token subject accepted as a client identity.
const MAX_SUBJECT_LEN: usize = 128;

/// The stored identity of a caller: a hash of the verified token subject when
/// there is one, else of the IP address. The two never collide (different
/// prefixes), and an empty or over-long subject is ignored.
pub fn client_key(verified_subject: Option<&str>, ip: &str) -> String {
    let basis = match verified_subject.map(str::trim) {
        Some(s) if !s.is_empty() && s.len() <= MAX_SUBJECT_LEN => format!("sub:{s}"),
        _ => format!("ip:{}", ip.trim()),
    };
    hex::encode(Sha256::digest(basis.as_bytes()))
}

/// The oldest event that still counts.
pub fn window_start(now_ms: u64) -> u64 {
    now_ms.saturating_sub(HOUR_MS)
}

/// Events older than this are deleted on write.
pub fn prune_before(now_ms: u64) -> u64 {
    now_ms.saturating_sub(24 * HOUR_MS)
}

/// The answer to "may this call go upstream?".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allow,
    /// This client has used its hour.
    ClientLimit,
    /// The whole service has used its hour.
    GlobalLimit,
}

impl Decision {
    pub fn allowed(self) -> bool {
        self == Decision::Allow
    }
}

/// Decide from the events already counted in the last hour.
pub fn decide(limits: Limits, client_count: u64, global_count: u64) -> Decision {
    if global_count >= u64::from(limits.global) {
        Decision::GlobalLimit
    } else if client_count >= u64::from(limits.per_client) {
        Decision::ClientLimit
    } else {
        Decision::Allow
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_client_is_keyed_by_subject_when_present_else_ip() {
        let by_ip = client_key(None, "203.0.113.9");
        assert_eq!(by_ip, client_key(Some("  "), "203.0.113.9"));
        assert_eq!(by_ip, client_key(Some(&"x".repeat(129)), "203.0.113.9"));
        let by_sub = client_key(Some("person-1"), "203.0.113.9");
        assert_ne!(by_ip, by_sub);
        // The same subject is one client from any address.
        assert_eq!(by_sub, client_key(Some("person-1"), "198.51.100.1"));
        assert_ne!(by_sub, client_key(Some("person-2"), "203.0.113.9"));
    }

    #[test]
    fn the_stored_key_is_a_hash_never_the_input() {
        let k = client_key(None, "203.0.113.9");
        assert_eq!(k.len(), 64);
        assert!(!k.contains("203.0.113.9"));
        assert_ne!(k, GLOBAL_CLIENT);
        // An ip that spells a subject prefix is still an ip.
        assert_ne!(
            client_key(None, "sub:person-1"),
            client_key(Some("person-1"), "")
        );
    }

    #[test]
    fn decisions_follow_the_counts() {
        let l = Limits {
            per_client: 3,
            global: 10,
        };
        assert_eq!(decide(l, 0, 0), Decision::Allow);
        assert_eq!(decide(l, 2, 9), Decision::Allow);
        assert_eq!(decide(l, 3, 9), Decision::ClientLimit);
        assert_eq!(decide(l, 0, 10), Decision::GlobalLimit);
        // The service-wide ceiling wins when both are hit.
        assert_eq!(decide(l, 3, 10), Decision::GlobalLimit);
        assert!(Decision::Allow.allowed() && !Decision::ClientLimit.allowed());
    }

    #[test]
    fn actions_have_separate_names_and_budgets() {
        let names = [Action::Resolve, Action::Search, Action::Nominatim].map(Action::name);
        assert_eq!(
            names
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            3
        );
        // Autocomplete cannot starve a bare-name resolve: separate rows, and
        // each action's ceiling is its own.
        assert_ne!(Action::Resolve.name(), Action::Search.name());
    }

    #[test]
    fn budgets_stay_conservative() {
        let r = Action::Resolve.limits();
        let s = Action::Search.limits();
        let n = Action::Nominatim.limits();
        // Forward geocodes together stay inside a 12,000-a-day worst case.
        assert!((r.global + s.global) * 24 <= 12_000);
        // Nominatim: under one request a second for the whole service.
        assert!(n.global <= 3_600);
        assert!(r.per_client <= r.global && s.per_client <= s.global);
    }

    #[test]
    fn windows() {
        assert_eq!(window_start(HOUR_MS + 5), 5);
        assert_eq!(window_start(10), 0);
        assert_eq!(prune_before(24 * HOUR_MS + 7), 7);
    }
}
