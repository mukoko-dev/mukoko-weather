//! Hourly budgets for the third-party geocoders (Open-Meteo forward geocoding,
//! Nominatim reverse geocoding) and for the model calls (`mukoko-weather-ai`),
//! kept in D1 (`rate_events`, migration 0002).
//!
//! The geocoders are free and meant for light use, and a model call costs, so
//! every UNCACHED call is counted per client and for the whole service, per
//! action, so one surface (autocomplete) can never starve another (a bare name
//! in a URL). The pure parts live here, tested natively; the Workers only run
//! the SQL (`weather_edge::budget`).
//!
//! Who is "the client" is pluggable ([`client_key`]): a verified token subject
//! when the caller presents one, else the IP address. No token verifier exists
//! yet (the issuer is a platform responsibility, tracked in #148), so for now
//! every caller is keyed by IP, which is the real visitor for a browser that
//! calls the Worker directly. Only a hash is stored, never the IP or subject.

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
    /// A history request that goes to an external archive (a place).
    HistoryBackfill,
    /// The same for a bare coordinate: anonymous and unbounded in number, so
    /// tighter.
    HistoryBackfillCoords,
    /// One NASA POWER call (whole service; POWER asks for equitable use).
    HistoryNasaPower,
    /// Open-Meteo archive calls, in WEIGHTED units (`history::open_meteo_units`:
    /// a year of 19 variables is about 50). The free API's 5,000 an hour and
    /// 10,000 a day are shared with the forecast, air quality and haze.
    HistoryOpenMeteo,
    /// A place-profile request that needs an upstream (a 30-year archive
    /// request, SoilGrids): a cache hit is free.
    PlaceProfile,
    /// An AI location search (`/v1/ai/explore/search`): up to three model
    /// calls and some forecast lookups.
    ExploreSearch,
    /// An AI history analysis (`/v1/ai/history/analyze`) that calls the model:
    /// an analysis answered from the cache is free.
    HistoryAnalysis,
    /// A weather summary that goes to the model (a cache miss): the signed-in
    /// person's hour.
    AiSummary,
    /// A follow-up chat message (always a model call).
    AiFollowup,
    /// An agriculture explanation that goes to the model (a cache miss).
    AiAgriculture,
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
            Action::HistoryBackfill => "history-backfill",
            Action::HistoryBackfillCoords => "history-backfill-coords",
            Action::HistoryNasaPower => "history-nasa-power",
            Action::HistoryOpenMeteo => "history-open-meteo",
            Action::PlaceProfile => "place-profile",
            Action::ExploreSearch => "ai-explore-search",
            Action::HistoryAnalysis => "ai-history-analysis",
            Action::AiSummary => "ai-summary",
            Action::AiFollowup => "ai-followup",
            Action::AiAgriculture => "ai-agriculture",
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
            // 30 backfilling requests an hour per client (as in the Python
            // backend), 10 for bare coordinates; the service-wide caps keep
            // the providers' own limits out of reach.
            Action::HistoryBackfill => Limits {
                per_client: 30,
                global: 600,
            },
            Action::HistoryBackfillCoords => Limits {
                per_client: 10,
                global: 300,
            },
            // The provider budgets are service-wide: every caller counts
            // against the same hour, so the per-client part is only a share.
            Action::HistoryNasaPower => Limits {
                per_client: 600,
                global: 600,
            },
            // Weighted units. 250 an hour saturated is 6,000 a day, inside the
            // 10,000 a day the free API allows and leaving the forecast, air
            // quality and haze the rest; one client gets three year-long chunks.
            Action::HistoryOpenMeteo => Limits {
                per_client: 150,
                global: 250,
            },
            // 120 builds an hour per client, as in the Python backend; each
            // is one archive request (about 250 KB) and two SoilGrids calls.
            Action::PlaceProfile => Limits {
                per_client: 120,
                global: 600,
            },
            // 15 searches an hour per client, as in the Python backend. Each
            // is up to three model calls; the service-wide cap is 40 clients
            // at their limit, and past it the search answers from the text
            // match instead of the model.
            Action::ExploreSearch => Limits {
                per_client: 15,
                global: 600,
            },
            // 10 analyses an hour per client, as in the Python backend. Each
            // is one model call.
            Action::HistoryAnalysis => Limits {
                per_client: 10,
                global: 300,
            },
            // 30 model calls an hour per signed-in person for each of the
            // three, as the Python backend limited them per IP. The
            // service-wide ceilings (1,500 an hour for the summary and the
            // follow-up, 600 for agriculture) bound what the model can cost
            // if many accounts are used at once; cache hits are free and
            // never counted.
            Action::AiSummary | Action::AiFollowup => Limits {
                per_client: 30,
                global: 1_500,
            },
            Action::AiAgriculture => Limits {
                per_client: 30,
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
    crate::crypto::sha256_hex(&basis)
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
    decide_units(limits, client_count, global_count, 1)
}

/// Decide a spend of `units` (a weighted call: one event row per unit). It is
/// allowed only when the whole spend fits inside both limits.
pub fn decide_units(limits: Limits, client_count: u64, global_count: u64, units: u32) -> Decision {
    let units = u64::from(units.max(1));
    if global_count + units > u64::from(limits.global) {
        Decision::GlobalLimit
    } else if client_count + units > u64::from(limits.per_client) {
        Decision::ClientLimit
    } else {
        Decision::Allow
    }
}

/// The most units one spend may write (the history caps are far below it).
pub const MAX_SPEND_UNITS: u32 = 1_000;

/// A spend's size as it is written and checked: at least one unit (nothing is
/// free) and at most [`MAX_SPEND_UNITS`].
pub fn spend_units(units: u32) -> u32 {
    units.clamp(1, MAX_SPEND_UNITS)
}

/// The whole budget decision in ONE statement, so that parallel requests
/// cannot all read the same counts and all pass. A count-then-insert pair is
/// not safe: N cold requests read the same count, each decides alone, and all
/// N spend. Here the check and the write are one atomic statement: the rows
/// are inserted only when BOTH the client's and the service's hour still have
/// room for the whole spend, and D1 reports how many rows it wrote
/// ([`spend_granted`]).
///
/// Parameters, in order: `?1` the client key, `?2` the action name, `?3` now
/// (ms), `?4` units (already [`spend_units`]), `?5` the start of the window
/// (ms, [`window_start`]), `?6` the per-client limit, `?7` the service-wide
/// limit, `?8` the service-wide client ([`GLOBAL_CLIENT`]).
///
/// A granted spend writes `units` rows for the client and `units` rows for
/// the service (one row per unit: the hourly count IS the spend); a refused
/// one writes nothing. The two counts are scalar subqueries that read the
/// table the statement writes to, so SQLite reads them from the state before
/// this statement's own rows. The recursive CTE keeps a 50-unit call to one
/// statement.
pub const SPEND_SQL: &str = "\
WITH RECURSIVE \
n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?4), \
who(client) AS (SELECT ?1 UNION ALL SELECT ?8) \
INSERT INTO rate_events (client, action, at) \
SELECT who.client, ?2, ?3 FROM n CROSS JOIN who \
WHERE (SELECT COUNT(*) FROM rate_events WHERE client = ?1 AND action = ?2 AND at >= ?5) + ?4 <= ?6 \
AND (SELECT COUNT(*) FROM rate_events WHERE client = ?8 AND action = ?2 AND at >= ?5) + ?4 <= ?7";

/// Did [`SPEND_SQL`] write its rows? D1 returns `meta.changes`: more than zero
/// rows means the spend fit (it writes all of its rows or none); zero means it
/// was refused; a missing count is treated as refused (fail closed).
pub fn spend_granted(changes: Option<usize>) -> bool {
    changes.is_some_and(|c| c > 0)
}

/// Why a refused spend was refused, from the counts read AFTER the refusal.
/// Never `Allow`: the refusal already happened, so if the counts now look
/// open (the hour rolled over, or a row was pruned in between) the label is
/// the service-wide one rather than a contradiction.
pub fn refusal(limits: Limits, client_count: u64, global_count: u64, units: u32) -> Decision {
    match decide_units(limits, client_count, global_count, units) {
        Decision::Allow => Decision::GlobalLimit,
        refused => refused,
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
    fn model_budgets_are_the_pythons_per_person_hour() {
        for (a, name) in [
            (Action::AiSummary, "ai-summary"),
            (Action::AiFollowup, "ai-followup"),
            (Action::AiAgriculture, "ai-agriculture"),
        ] {
            assert_eq!(a.name(), name);
            assert_eq!(a.limits().per_client, 30, "{name}");
            assert!(a.limits().per_client <= a.limits().global);
        }
        // Each has its own rows: one surface cannot starve another.
        assert_ne!(Action::AiSummary.name(), Action::AiFollowup.name());
        assert_ne!(Action::AiSummary.name(), Action::AiAgriculture.name());
    }

    #[test]
    fn windows() {
        assert_eq!(window_start(HOUR_MS + 5), 5);
        assert_eq!(window_start(10), 0);
        assert_eq!(prune_before(24 * HOUR_MS + 7), 7);
    }

    #[test]
    fn a_weighted_spend_must_fit_inside_both_limits() {
        let l = Limits {
            per_client: 150,
            global: 250,
        };
        assert_eq!(decide_units(l, 0, 0, 50), Decision::Allow);
        // 100 + 50 = 150 fits; one more unit does not.
        assert_eq!(decide_units(l, 100, 100, 50), Decision::Allow);
        assert_eq!(decide_units(l, 101, 100, 50), Decision::ClientLimit);
        // The service-wide hour is checked first.
        assert_eq!(decide_units(l, 0, 201, 50), Decision::GlobalLimit);
        assert_eq!(decide_units(l, 0, 200, 50), Decision::Allow);
        // A spend bigger than a client's whole hour is never allowed.
        assert_eq!(decide_units(l, 0, 0, 151), Decision::ClientLimit);
        // One unit is the old rule.
        assert_eq!(decide(l, 149, 0), Decision::Allow);
        assert_eq!(decide(l, 150, 0), Decision::ClientLimit);
        assert_eq!(decide(l, 0, 250), Decision::GlobalLimit);
        // Zero units counts as one: nothing is free.
        assert_eq!(decide_units(l, 150, 0, 0), Decision::ClientLimit);
    }

    #[test]
    fn a_spend_is_one_atomic_statement_gated_on_both_limits() {
        // One statement: no second statement can be interleaved between the
        // check and the write.
        assert!(!SPEND_SQL.contains(';'));
        assert_eq!(SPEND_SQL.matches("INSERT INTO").count(), 1);
        assert!(SPEND_SQL.contains("INSERT INTO rate_events (client, action, at)"));
        // Both counts are read inside the statement, each with the unit cost
        // added before it is compared with its limit.
        assert_eq!(
            SPEND_SQL
                .matches("SELECT COUNT(*) FROM rate_events")
                .count(),
            2
        );
        assert!(SPEND_SQL.contains("AND at >= ?5) + ?4 <= ?6"));
        assert!(SPEND_SQL.contains("AND at >= ?5) + ?4 <= ?7"));
        // The client count uses the client key, the service count the
        // service-wide key.
        assert!(SPEND_SQL.contains("client = ?1 AND action = ?2"));
        assert!(SPEND_SQL.contains("client = ?8 AND action = ?2"));
        // Every parameter 1..=8 is used, and nothing beyond.
        for n in 1..=8 {
            assert!(SPEND_SQL.contains(&format!("?{n}")), "?{n} is unused");
        }
        assert!(!SPEND_SQL.contains("?9") && !SPEND_SQL.contains("?0"));
        // Both rows (client and service) are written by the same statement.
        assert!(SPEND_SQL.contains("SELECT ?1 UNION ALL SELECT ?8"));
    }

    #[test]
    fn a_spend_is_never_free_and_never_unbounded() {
        assert_eq!(spend_units(0), 1);
        assert_eq!(spend_units(1), 1);
        assert_eq!(spend_units(50), 50);
        assert_eq!(spend_units(u32::MAX), MAX_SPEND_UNITS);
        // Every history cap is far below the ceiling.
        assert!(crate::history::open_meteo_units(3660) <= MAX_SPEND_UNITS);
    }

    #[test]
    fn only_written_rows_grant_a_spend() {
        assert!(spend_granted(Some(100)));
        assert!(spend_granted(Some(2)));
        // Refused by the gate: nothing written.
        assert!(!spend_granted(Some(0)));
        // No count from the database: fail closed.
        assert!(!spend_granted(None));
    }

    #[test]
    fn a_refusal_is_never_labelled_allow() {
        let l = Limits {
            per_client: 150,
            global: 250,
        };
        assert_eq!(refusal(l, 101, 100, 50), Decision::ClientLimit);
        assert_eq!(refusal(l, 0, 201, 50), Decision::GlobalLimit);
        // The counts read afterwards look open (the hour rolled over): the
        // refusal stands, with the service-wide label.
        assert_eq!(refusal(l, 0, 0, 50), Decision::GlobalLimit);
        assert!(!refusal(l, 0, 0, 1).allowed());
    }

    #[test]
    fn the_ai_budgets_are_the_pythons_per_client_and_bounded_service_wide() {
        // 15 searches and 10 analyses an hour per client, as the Python had.
        assert_eq!(Action::ExploreSearch.limits().per_client, 15);
        assert_eq!(Action::HistoryAnalysis.limits().per_client, 10);
        assert_eq!(Action::ExploreSearch.name(), "ai-explore-search");
        assert_eq!(Action::HistoryAnalysis.name(), "ai-history-analysis");
        for a in [Action::ExploreSearch, Action::HistoryAnalysis] {
            let l = a.limits();
            assert!(l.per_client <= l.global);
        }
        assert_ne!(Action::ExploreSearch.name(), Action::HistoryAnalysis.name());
    }

    #[test]
    fn history_budgets_are_named_and_ordered() {
        assert_eq!(Action::HistoryOpenMeteo.name(), "history-open-meteo");
        let l = Action::HistoryOpenMeteo.limits();
        assert_eq!(l.global, 250);
        assert!(l.per_client <= l.global);
        assert_eq!(Action::HistoryBackfillCoords.limits().per_client, 10);
        assert_eq!(Action::HistoryBackfill.limits().per_client, 30);
    }
}
