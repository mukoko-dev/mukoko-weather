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
}
