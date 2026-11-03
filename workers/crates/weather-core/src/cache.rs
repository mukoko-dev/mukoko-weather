//! How the Workers keep an answer in KV when "nothing is there" is an answer.
//!
//! `kv.get(key).json::<Option<T>>()` returns `None` both for a missing key
//! AND for a stored JSON `null`, so caching "no such place" as `null` read
//! back as a miss and the lookup repeated. A [`Slot`] wraps the answer in an
//! object, so a cached "nothing" (`{"found":null}`) is distinguishable from
//! no entry at all.

use serde::{Deserialize, Serialize};

/// A cached lookup: `found` is `None` for a cached "nothing here".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Slot<T> {
    pub found: Option<T>,
}

impl<T> Slot<T> {
    pub fn new(found: Option<T>) -> Self {
        Slot { found }
    }
}

/// How long an optional upstream that just failed or timed out is left alone.
pub const UPSTREAM_BACKOFF_SECS: u64 = 60;

/// Should an optional enrichment call go out, given whether a recent failure
/// left a back-off marker? One slow upstream must not add its timeout to
/// every request, so while the marker stands the call is skipped.
pub fn should_call_upstream(backoff_marker_present: bool) -> bool {
    !backoff_marker_present
}

/// How long to keep what a call produced: an answer (even an empty one) for
/// `answer_ttl`; a failure is never kept as an answer, only as the short
/// back-off marker (`None` for an answer means "store it", see the caller).
pub fn marker_ttl_on_failure() -> u64 {
    UPSTREAM_BACKOFF_SECS
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::locations::LocationDoc;

    /// What `kv.get(..).json::<Option<X>>()` does with a stored body.
    fn read<X: serde::de::DeserializeOwned>(body: &str) -> Option<X> {
        serde_json::from_str::<Option<X>>(body).ok().flatten()
    }

    #[test]
    fn a_bare_null_reads_back_as_a_miss_which_is_the_bug() {
        let stored = serde_json::to_string(&None::<LocationDoc>).unwrap();
        assert_eq!(stored, "null");
        assert!(read::<Option<LocationDoc>>(&stored).is_none());
    }

    #[test]
    fn a_cached_nothing_survives_the_round_trip() {
        let stored = serde_json::to_string(&Slot::<LocationDoc>::new(None)).unwrap();
        let back = read::<Slot<LocationDoc>>(&stored).expect("a hit, not a miss");
        assert_eq!(back.found, None);
    }

    #[test]
    fn a_cached_answer_round_trips() {
        let harare = crate::locations::find_seed("harare").unwrap().clone();
        let stored = serde_json::to_string(&Slot::new(Some(harare.clone()))).unwrap();
        assert_eq!(
            read::<Slot<LocationDoc>>(&stored).unwrap().found,
            Some(harare)
        );
    }

    #[test]
    fn a_missing_key_is_still_a_miss() {
        assert!(read::<Slot<LocationDoc>>("null").is_none());
        // A body from before slots (a bare doc) is not a slot: a miss, so the
        // key is looked up again and rewritten.
        assert!(read::<Slot<LocationDoc>>("\"x\"").is_none());
    }

    #[test]
    fn a_back_off_marker_skips_the_call() {
        assert!(should_call_upstream(false));
        assert!(!should_call_upstream(true));
    }

    #[test]
    fn a_failure_backs_off_for_a_minute_not_an_hour() {
        assert_eq!(marker_ttl_on_failure(), 60);
    }
}
