# Canonical slugs: every place is `{name}--{ref}`

Tracking: #317. Owner decision (sole decider): move all slugs to the smart-slug
model.

## Why

Three slug families coexisted:

| Family                  | Example                         | Identity                 |
| ----------------------- | ------------------------------- | ------------------------ |
| Legacy seed slug        | `harare`, `nairobi-ke`          | the catalogue row        |
| Platform / community    | `harare-35c223`, `foo-ke`       | a database id            |
| Smart slug (spot/place) | `harare--ksy4dd1`, `x--osm-w12` | the coordinate / the map |

One city could have three URLs, two of them needing a database to mean
anything. Now a place has one canonical form and every other form redirects to
it.

## Canonical form

- **Seed place:** `{slugifyName(name)}--{geohash7(lat, lon)}` of the seed's own
  coordinate (`harare--ksy4dd1`, `nairobi--kzf0tv5`). An OSM ref
  (`{name}--osm-{ref}`) is used only where we hold a verified ref. The seed
  carries none, so none of the 264 pairs uses one.
- **Platform or community place:** the canonical slug of the place it resolves
  to: its seed twin (same slugified name within 25 km), else
  `{name}--{geohash7}` of its coordinate, else the slug unchanged (a URL is
  never invented without a coordinate).
- **Already `{name}--{ref}`:** unchanged. A canonical slug is a fixed point, so
  no redirect can loop.

## The mapping table

`src/lib/slug-migration-data.ts` holds the 264 pairs, generated once and then
pinned (append-only: a published URL never changes).
`src/lib/slug-migration.test.ts` fails unless the table has exactly one row per
seed, is a bijection, equals the derivation from the seed, decodes back within
one 153 m cell of the seed, contains no legacy slug as a canonical slug and no
OSM ref. The Python (`api/py/data/slug_migration.json`) and Rust
(`workers/crates/weather-core/data/slug-migration.json`) copies are written by
`workers/scripts/gen-seed-locations.mjs` (CI runs it with `--check`), and each
language re-derives every canonical slug from the seed with its own geohash and
slugify implementation, so the three cannot drift.

Platform slugs cannot be tabulated: the 6-hex id lives in the database.

## Redirects (308, forever)

- A legacy seed slug, a bare seed name, and either in the wrong case redirect
  in one hop from a table in the proxy, with no lookup. The sub-route
  (`forecast`, `atmosphere`, `map`, `agriculture`) and the query string are
  kept.
- A platform or community slug is resolved by the gate's existing lookup; if
  the place's canonical slug differs, the proxy 308s to it, with the same
  sub-route and query handling.
- The `lastLocation` cookie: a legacy value still resolves, and the proxy
  rewrites it to canonical on `/` (table only).

## Everywhere else

The resolvers return a location whose `slug` is canonical, so canonical URLs,
JSON-LD, breadcrumbs, OG, the sitemap, explore lists and links all follow. A
canonical seed slug resolves as the seed itself (its own province, tags,
elevation), not as a bare coordinate.

Saved state (`selectedLocation`, `savedLocations`, `homeLocation`,
`hiddenPresetSlugs`, `locationLabels`) is migrated by `migrateSlugPrefs` on
every path into the store, once and idempotently, then written back so
IndexedDB and the device profile follow.

## Backend: nothing is lost

Existing history, reports and AI caches live under the legacy slug. The
backends accept both spellings and key by the legacy one (Python `storage_slug`
and friends; Rust `storage_key_slug` for the D1 `place_daily` history). History
and report reads also include the `geo:<geohash7>` cell key a visitor may have
written under while the canonical URL was only a spot. The `storage_slug` rule
for spots is unchanged. Nothing writes production data and there is no
migration script.

## Owner decisions and risks

- **SEO:** every indexed seed URL becomes a 308 to a new URL. Google follows
  308s and transfers signals, but expect a re-crawl and a temporary ranking dip;
  the sitemap now lists only canonical URLs.
- **Readability:** `harare--ksy4dd1` is less friendly to read aloud than
  `harare`.
- **Fixed forever:** a seed's canonical slug is pinned. Moving a seed's
  coordinate later does not change its URL (the test will flag the drift).
