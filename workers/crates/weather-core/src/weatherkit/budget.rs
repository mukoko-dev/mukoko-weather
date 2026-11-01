//! The WeatherKit call budget: 500,000 calls a month are included with the
//! Apple Developer Program membership, unused calls do not roll over, and one
//! HTTP request is one call however many data sets it names (so a request
//! always names all four; the official pages are silent on counting, Apple's
//! developer forums say so, verify it on the usage report).
//!
//! This module is the DECISION, as pure code, and the statements that make it
//! atomic as a documented contract. It is wired to no store. The Servers API
//! origin (Gwaihir) runs the statements on whatever store it has, or implements
//! the same numbers and the same atomicity another way.
//!
//! **Only a cache MISS spends.** A request answered from the 15-minute cache
//! ([`super::cache_key`]) costs nothing.
//!
//! **Caps** ([`BASELINE`], [`COMPARISON`]). Calendar month (UTC) 450,000: 90 %
//! of the 500,000, so a miscount or a burst cannot push the account into paid
//! overage. Rolling day 15,000 (450,000 over 30 days, a pace, so one busy day
//! cannot spend the month). Rolling hour 1,000 for the service and 60 for one
//! client (a client is the hashed key of [`crate::budget::client_key`]), so one
//! client cannot drain the day and a stampede cannot spend the day in an hour.
//!
//! **Two classes.** A person who picked Apple Weather as their forecast
//! ([`Class::Baseline`]) may use the full caps. Apple as an extra series in the
//! model comparison for someone who did not pick it ([`Class::Comparison`])
//! gets half of the month, day and service-hour caps, because that spend is
//! requested by the caller (`models=`), not chosen by a person, and must never
//! be able to use up what the people who chose Apple need.
//!
//! **Fail closed.** A count that could not be read, a result that carries no
//! change count, any error: the call does not go out ([`Decision::Unreadable`]).
//! The answer is then the blend, labelled ([`super::Unavailable`]).
//!
//! **Atomic, in this order.** The two statements below cannot be one: the
//! rolling windows are counted from `rate_events` rows, which are pruned after
//! 24 hours ([`crate::budget::prune_before`]), so a month cannot be counted
//! there, and the month lives in a counter row. So the rolling statement runs
//! FIRST and the month counter SECOND, and a call goes out only if both write.
//! Order matters: a refused call must not use up a month unit, and the month
//! counter only increments after the rolling windows have said yes. A month
//! counter that refuses after the rolling statement wrote costs a few
//! `rate_events` rows in a month that is already full, which is harmless.

use chrono::{DateTime, Datelike, Utc};

use crate::budget::HOUR_MS;

/// `rate_events.action` and `budget_counters.action` of a WeatherKit call.
pub const ACTION: &str = "weatherkit";

/// What the membership includes each month.
pub const INCLUDED_MONTHLY_CALLS: u64 = 500_000;

/// The caps of one class of spend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Caps {
    /// Calls in the calendar month (UTC).
    pub month: u64,
    /// Calls in the last 24 hours, whole service.
    pub day: u64,
    /// Calls in the last hour, whole service.
    pub hour_global: u64,
    /// Calls in the last hour, one client.
    pub hour_client: u64,
}

/// For a person who picked Apple Weather.
pub const BASELINE: Caps = Caps {
    month: 450_000,
    day: 15_000,
    hour_global: 1_000,
    hour_client: 60,
};

/// For Apple as an extra comparison series nobody picked: half of the shared
/// windows, the same per-client hour.
pub const COMPARISON: Caps = Caps {
    month: BASELINE.month / 2,
    day: BASELINE.day / 2,
    hour_global: BASELINE.hour_global / 2,
    hour_client: BASELINE.hour_client,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    /// The person picked Apple Weather as their forecast.
    Baseline,
    /// Apple was asked for as a comparison series.
    Comparison,
}

pub fn caps(class: Class) -> Caps {
    match class {
        Class::Baseline => BASELINE,
        Class::Comparison => COMPARISON,
    }
}

/// Calls already counted. `None` is a count that could not be read.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub month: Option<u64>,
    pub day: Option<u64>,
    pub hour_global: Option<u64>,
    pub hour_client: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Grant,
    MonthFull,
    DayFull,
    /// The whole service has used its hour.
    HourFull,
    /// This client has used its hour.
    ClientHourFull,
    /// A count could not be read: refused (fail closed).
    Unreadable,
}

impl Decision {
    pub fn granted(self) -> bool {
        self == Decision::Grant
    }

    /// A stable label for logs and `/health`.
    pub fn label(self) -> &'static str {
        match self {
            Decision::Grant => "grant",
            Decision::MonthFull => "month_full",
            Decision::DayFull => "day_full",
            Decision::HourFull => "hour_full",
            Decision::ClientHourFull => "client_hour_full",
            Decision::Unreadable => "unreadable",
        }
    }
}

/// May one more call go out, given the calls already counted? The longest
/// window is checked first, so the answer names the one that will not reopen
/// soon. Every count must be readable.
pub fn decide(usage: Usage, class: Class) -> Decision {
    let (Some(month), Some(day), Some(hour_global), Some(hour_client)) =
        (usage.month, usage.day, usage.hour_global, usage.hour_client)
    else {
        return Decision::Unreadable;
    };
    let c = caps(class);
    if month >= c.month {
        Decision::MonthFull
    } else if day >= c.day {
        Decision::DayFull
    } else if hour_global >= c.hour_global {
        Decision::HourFull
    } else if hour_client >= c.hour_client {
        Decision::ClientHourFull
    } else {
        Decision::Grant
    }
}

/// `budget_counters.period` of a calendar month in UTC: `2026-11`.
pub fn month_period(now: DateTime<Utc>) -> String {
    format!("{:04}-{:02}", now.year(), now.month())
}

/// The start of the rolling day window (24 hours back), in milliseconds.
pub fn day_window_start(now_ms: u64) -> u64 {
    now_ms.saturating_sub(24 * HOUR_MS)
}

/// The rolling windows in ONE statement (the `rate_events` table of migration
/// 0002): writes a row for the client and a row for the service
/// ([`crate::budget::GLOBAL_CLIENT`]) only when the client's hour, the
/// service's hour and the service's rolling day all still have room, so
/// parallel cold requests cannot all read the same counts and all pass.
///
/// Parameters: `?1` client key, `?2` [`ACTION`], `?3` now (ms), `?4` the
/// service-wide client, `?5` the start of the hour window
/// ([`crate::budget::window_start`]), `?6` the client's hour cap, `?7` the
/// service's hour cap, `?8` the start of the day window ([`day_window_start`]),
/// `?9` the day cap. Granted when the database reports more than zero changed
/// rows ([`crate::budget::spend_granted`]); a missing change count is a refusal.
pub const ROLLING_SPEND_SQL: &str = "\
INSERT INTO rate_events (client, action, at) \
SELECT who.client, ?2, ?3 FROM (SELECT ?1 AS client UNION ALL SELECT ?4) AS who \
WHERE (SELECT COUNT(*) FROM rate_events WHERE client = ?1 AND action = ?2 AND at >= ?5) < ?6 \
AND (SELECT COUNT(*) FROM rate_events WHERE client = ?4 AND action = ?2 AND at >= ?5) < ?7 \
AND (SELECT COUNT(*) FROM rate_events WHERE client = ?4 AND action = ?2 AND at >= ?8) < ?9";

/// The calendar month in ONE guarded upsert, on a counter row per
/// `(action, period)`:
///
/// ```sql
/// CREATE TABLE budget_counters (
///   action TEXT NOT NULL, period TEXT NOT NULL, used INTEGER NOT NULL,
///   PRIMARY KEY (action, period)
/// );
/// ```
///
/// (A contract only: no migration exists, and nothing runs it.) The first call
/// of a month inserts `used = 1`; later calls add one only while `used` is
/// below the cap; at the cap the `DO UPDATE ... WHERE` changes nothing.
///
/// Parameters: `?1` [`ACTION`], `?2` [`month_period`], `?3` the month cap.
/// Granted when the database reports more than zero changed rows.
pub const MONTH_SPEND_SQL: &str = "\
INSERT INTO budget_counters (action, period, used) VALUES (?1, ?2, 1) \
ON CONFLICT (action, period) DO UPDATE SET used = used + 1 WHERE used < ?3";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::budget::{self, GLOBAL_CLIENT};
    use chrono::TimeZone;

    fn open() -> Usage {
        Usage {
            month: Some(0),
            day: Some(0),
            hour_global: Some(0),
            hour_client: Some(0),
        }
    }

    #[test]
    fn the_numbers_are_the_owners_numbers() {
        assert_eq!(INCLUDED_MONTHLY_CALLS, 500_000);
        assert_eq!(BASELINE.month, 450_000);
        assert_eq!(BASELINE.day, 15_000);
        assert_eq!(BASELINE.hour_client, 60);
        // 90 % of the included calls, never the whole allowance.
        assert_eq!(BASELINE.month * 100 / INCLUDED_MONTHLY_CALLS, 90);
        // The day cap is the month cap spread over 30 days.
        assert_eq!(BASELINE.day * 30, BASELINE.month);
        // A day saturated for 31 days stays inside what is included.
        const { assert!(BASELINE.day * 31 <= INCLUDED_MONTHLY_CALLS) };
        // One client can never take the service's whole hour.
        const { assert!(BASELINE.hour_client * 10 < BASELINE.hour_global) };
    }

    #[test]
    fn comparison_is_half_of_the_shared_windows() {
        assert_eq!(COMPARISON.month, 225_000);
        assert_eq!(COMPARISON.day, 7_500);
        assert_eq!(COMPARISON.hour_global, 500);
        assert_eq!(COMPARISON.hour_client, BASELINE.hour_client);
    }

    #[test]
    fn an_open_budget_grants() {
        assert_eq!(decide(open(), Class::Baseline), Decision::Grant);
        assert_eq!(decide(open(), Class::Comparison), Decision::Grant);
        assert!(Decision::Grant.granted());
    }

    #[test]
    fn a_spend_is_allowed_up_to_the_cap_and_refused_at_it() {
        let at = |month, day, hour_global, hour_client| Usage {
            month: Some(month),
            day: Some(day),
            hour_global: Some(hour_global),
            hour_client: Some(hour_client),
        };
        // One below each cap still grants (the call being decided is the cap-th).
        assert_eq!(
            decide(at(449_999, 14_999, 999, 59), Class::Baseline),
            Decision::Grant
        );
        assert_eq!(
            decide(at(450_000, 0, 0, 0), Class::Baseline),
            Decision::MonthFull
        );
        assert_eq!(
            decide(at(0, 15_000, 0, 0), Class::Baseline),
            Decision::DayFull
        );
        assert_eq!(
            decide(at(0, 0, 1_000, 0), Class::Baseline),
            Decision::HourFull
        );
        assert_eq!(
            decide(at(0, 0, 0, 60), Class::Baseline),
            Decision::ClientHourFull
        );
    }

    #[test]
    fn the_longest_window_is_named_first() {
        let all_full = Usage {
            month: Some(450_000),
            day: Some(15_000),
            hour_global: Some(1_000),
            hour_client: Some(60),
        };
        assert_eq!(decide(all_full, Class::Baseline), Decision::MonthFull);
        let no_month = Usage {
            month: Some(0),
            ..all_full
        };
        assert_eq!(decide(no_month, Class::Baseline), Decision::DayFull);
        let hour_only = Usage {
            day: Some(0),
            ..no_month
        };
        assert_eq!(decide(hour_only, Class::Baseline), Decision::HourFull);
    }

    #[test]
    fn an_unreadable_count_refuses() {
        for broken in [
            Usage {
                month: None,
                ..open()
            },
            Usage {
                day: None,
                ..open()
            },
            Usage {
                hour_global: None,
                ..open()
            },
            Usage {
                hour_client: None,
                ..open()
            },
            Usage::default(),
        ] {
            let d = decide(broken, Class::Baseline);
            assert_eq!(d, Decision::Unreadable);
            assert!(!d.granted());
        }
    }

    #[test]
    fn comparison_cannot_use_what_a_person_who_picked_apple_needs() {
        // Past half of the month: comparison is refused, a pick still goes out.
        let u = Usage {
            month: Some(225_000),
            ..open()
        };
        assert_eq!(decide(u, Class::Comparison), Decision::MonthFull);
        assert_eq!(decide(u, Class::Baseline), Decision::Grant);
        let u = Usage {
            day: Some(7_500),
            ..open()
        };
        assert_eq!(decide(u, Class::Comparison), Decision::DayFull);
        assert_eq!(decide(u, Class::Baseline), Decision::Grant);
        let u = Usage {
            hour_global: Some(500),
            ..open()
        };
        assert_eq!(decide(u, Class::Comparison), Decision::HourFull);
        assert_eq!(decide(u, Class::Baseline), Decision::Grant);
        // The per-client hour is the same for both.
        let u = Usage {
            hour_client: Some(60),
            ..open()
        };
        assert_eq!(decide(u, Class::Comparison), Decision::ClientHourFull);
        assert_eq!(decide(u, Class::Baseline), Decision::ClientHourFull);
    }

    #[test]
    fn every_decision_has_a_distinct_label() {
        let all = [
            Decision::Grant,
            Decision::MonthFull,
            Decision::DayFull,
            Decision::HourFull,
            Decision::ClientHourFull,
            Decision::Unreadable,
        ];
        let labels: std::collections::BTreeSet<_> = all.iter().map(|d| d.label()).collect();
        assert_eq!(labels.len(), all.len());
        assert_eq!(all.iter().filter(|d| d.granted()).count(), 1);
    }

    #[test]
    fn the_month_is_a_calendar_month_in_utc() {
        let t = |y, m, d, h| Utc.with_ymd_and_hms(y, m, d, h, 0, 0).unwrap();
        assert_eq!(month_period(t(2026, 11, 1, 0)), "2026-11");
        assert_eq!(month_period(t(2026, 11, 30, 23)), "2026-11");
        assert_eq!(month_period(t(2026, 12, 1, 0)), "2026-12");
        assert_eq!(month_period(t(2027, 1, 15, 12)), "2027-01");
        // A new month is a new counter row: the old one is not reset or read.
        assert_ne!(
            month_period(t(2026, 11, 30, 23)),
            month_period(t(2026, 12, 1, 0))
        );
    }

    #[test]
    fn the_rolling_windows_reach_back_an_hour_and_a_day() {
        let now = 10 * 24 * HOUR_MS;
        assert_eq!(budget::window_start(now), now - HOUR_MS);
        assert_eq!(day_window_start(now), now - 24 * HOUR_MS);
        assert_eq!(day_window_start(5), 0);
        // The day window fits inside what `rate_events` keeps (24 hours), so a
        // rolling day can be counted there. A month cannot.
        assert!(budget::prune_before(now) <= day_window_start(now));
    }

    #[test]
    fn the_rolling_spend_is_one_statement_gated_on_three_counts() {
        assert!(!ROLLING_SPEND_SQL.contains(';'));
        assert_eq!(ROLLING_SPEND_SQL.matches("INSERT INTO").count(), 1);
        assert!(ROLLING_SPEND_SQL.contains("INSERT INTO rate_events (client, action, at)"));
        assert_eq!(
            ROLLING_SPEND_SQL
                .matches("SELECT COUNT(*) FROM rate_events")
                .count(),
            3
        );
        // The client's hour, the service's hour, the service's day.
        assert!(ROLLING_SPEND_SQL.contains("client = ?1 AND action = ?2 AND at >= ?5) < ?6"));
        assert!(ROLLING_SPEND_SQL.contains("client = ?4 AND action = ?2 AND at >= ?5) < ?7"));
        assert!(ROLLING_SPEND_SQL.contains("client = ?4 AND action = ?2 AND at >= ?8) < ?9"));
        // The client row and the service row are written by the same statement.
        assert!(ROLLING_SPEND_SQL.contains("SELECT ?1 AS client UNION ALL SELECT ?4"));
        for n in 1..=9 {
            assert!(ROLLING_SPEND_SQL.contains(&format!("?{n}")), "?{n}");
        }
        assert!(!ROLLING_SPEND_SQL.contains("?10"));
        // The service-wide client is the shared one.
        assert_eq!(GLOBAL_CLIENT, "*");
    }

    #[test]
    fn the_month_counter_is_one_guarded_upsert() {
        assert!(!MONTH_SPEND_SQL.contains(';'));
        assert_eq!(MONTH_SPEND_SQL.matches("INSERT INTO").count(), 1);
        assert!(MONTH_SPEND_SQL.contains(
            "ON CONFLICT (action, period) DO UPDATE SET used = used + 1 WHERE used < ?3"
        ));
        assert!(MONTH_SPEND_SQL.contains("VALUES (?1, ?2, 1)"));
        for n in 1..=3 {
            assert!(MONTH_SPEND_SQL.contains(&format!("?{n}")), "?{n}");
        }
        assert!(!MONTH_SPEND_SQL.contains("?4"));
    }

    #[test]
    fn a_missing_change_count_refuses_a_spend() {
        // The rule both statements share: more than zero changed rows, else no.
        assert!(budget::spend_granted(Some(2)));
        assert!(budget::spend_granted(Some(1)));
        assert!(!budget::spend_granted(Some(0)));
        assert!(!budget::spend_granted(None));
    }
}
