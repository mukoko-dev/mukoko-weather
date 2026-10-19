//! Canonical slugs (#317): the Rust mirror of `src/lib/slug-migration.ts`.
//!
//! Every shipped seed place has a legacy slug (`harare`, `nairobi-ke`) and one
//! canonical slug (`harare--ksy4dd1`, `{name}--{geohash7}`). The pinned pairs
//! are `data/slug-migration.json`, generated from the app's
//! `src/lib/slug-migration-data.ts` by `workers/scripts/gen-seed-locations.mjs`
//! (CI runs it with `--check`).
//!
//! The Workers accept BOTH spellings of a seed and key durable data (the D1
//! `place_daily` history, cached answers) by the LEGACY slug, which is where
//! every existing row lives, so the move never splits or loses history.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Deserialize;

#[derive(Deserialize)]
struct Row {
    legacy: String,
    canonical: String,
}

struct Tables {
    to_canonical: HashMap<String, String>,
    to_legacy: HashMap<String, String>,
}

static MIGRATION_JSON: &str = include_str!("../data/slug-migration.json");

fn tables() -> &'static Tables {
    static TABLES: OnceLock<Tables> = OnceLock::new();
    TABLES.get_or_init(|| {
        let rows: Vec<Row> = serde_json::from_str(MIGRATION_JSON)
            .expect("slug-migration.json is valid (checked in CI)");
        Tables {
            to_canonical: rows
                .iter()
                .map(|r| (r.legacy.clone(), r.canonical.clone()))
                .collect(),
            to_legacy: rows
                .iter()
                .map(|r| (r.canonical.clone(), r.legacy.clone()))
                .collect(),
        }
    })
}

/// The canonical slug for `slug`: a legacy seed slug is mapped, any other slug
/// comes back unchanged. Idempotent.
pub fn canonical_slug(slug: &str) -> &str {
    tables()
        .to_canonical
        .get(slug)
        .map(String::as_str)
        .unwrap_or(slug)
}

/// The key durable data is stored under: a canonical seed slug maps back to
/// its legacy slug, any other slug is its own key. Idempotent.
pub fn storage_key_slug(slug: &str) -> &str {
    tables()
        .to_legacy
        .get(slug)
        .map(String::as_str)
        .unwrap_or(slug)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::locations::{build_smart_slug, seed_locations};

    #[test]
    fn one_pair_per_seed_and_a_bijection() {
        let t = tables();
        assert_eq!(t.to_canonical.len(), seed_locations().len());
        assert_eq!(t.to_legacy.len(), t.to_canonical.len());
        for seed in seed_locations() {
            assert!(t.to_canonical.contains_key(&seed.slug), "{}", seed.slug);
        }
        // A canonical slug is never a legacy slug, so a redirect cannot loop.
        for canonical in t.to_legacy.keys() {
            assert!(!t.to_canonical.contains_key(canonical), "{canonical}");
        }
    }

    #[test]
    fn every_pair_is_the_name_and_geohash_of_the_seed() {
        // Cross-language parity: Rust derives the same canonical slug the
        // app's TypeScript table pins, for every seed.
        for seed in seed_locations() {
            assert_eq!(
                canonical_slug(&seed.slug),
                build_smart_slug(&seed.name, seed.lat, seed.lon),
                "{}",
                seed.slug
            );
        }
    }

    #[test]
    fn the_two_helpers_are_inverse_and_idempotent() {
        for (legacy, canonical) in &tables().to_canonical {
            assert_eq!(canonical_slug(legacy), canonical);
            assert_eq!(canonical_slug(canonical), canonical);
            assert_eq!(storage_key_slug(canonical), legacy);
            assert_eq!(storage_key_slug(legacy), legacy);
        }
    }

    #[test]
    fn other_slugs_are_left_alone() {
        for slug in ["west-paddock--ksy4dd7", "x--osm-w1", "harare-35c223", ""] {
            assert_eq!(canonical_slug(slug), slug);
            assert_eq!(storage_key_slug(slug), slug);
        }
    }

    #[test]
    fn the_seed_lookups_accept_both_spellings() {
        for (legacy, canonical) in &tables().to_canonical {
            let by_legacy = crate::locations::find_seed(legacy).expect(legacy);
            let by_canonical = crate::locations::find_seed(canonical).expect(canonical);
            assert_eq!(by_legacy, by_canonical);
            // The seed is keyed by its legacy slug (the durable-data key).
            assert_eq!(&by_canonical.slug, legacy);
            let place = crate::places::resolve_seed(canonical).expect(canonical);
            assert_eq!(&place.slug, legacy);
            assert_eq!(crate::places::resolve_seed(legacy), Some(place));
        }
        assert!(crate::locations::find_seed("harare--ksy4dd7").is_none());
    }

    #[test]
    fn harare_is_pinned() {
        assert_eq!(canonical_slug("harare"), "harare--ksy4dd1");
        assert_eq!(storage_key_slug("harare--ksy4dd1"), "harare");
    }
}
