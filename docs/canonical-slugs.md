# Canonical slugs: the shipped seeds are `{name}--{ref}`

Tracking: #317. Owner decision (sole decider): move the shipped places to the
smart-slug model.

**Scope, in one line:** the 264 shipped seed places move to their canonical
slug and their old URLs redirect. Every other place keeps its slug and is
looked up exactly as it was.

## Why

Three slug families coexisted:

| Family                  | Example                         | Identity                 |
| ----------------------- | ------------------------------- | ------------------------ |
| Legacy seed slug        | `harare`, `nairobi-ke`          | the catalogue row        |
| Platform / community    | `harare-35c223`, `foo-ke`       | a database id            |
| Smart slug (spot/place) | `harare--ksy4dd1`, `x--osm-w12` | the coordinate / the map |

One shipped city could have several URLs. Now a shipped city has one canonical
URL and its old ones redirect to it.

## Canonical form

- **Seed place:** `{slugifyName(name)}--{geohash7(lat, lon)}` of the seed's own
  coordinate (`harare--ksy4dd1`, `nairobi--kzf0tv5`). An OSM ref
  (`{name}--osm-{ref}`) is used only where we hold a verified ref. The seed
  carries none, so none of the 264 pairs uses one.
- **Any other place keeps its slug.** A community place (`foo-ke`), a platform
  place (`harare-35c223`) and a Nyuchi API place are NOT rewritten, not even
  to a shipped city they sit next to. Their stored history, reports, country,
  province and tags are found by that slug; a `{name}--{geohash7}` slug is a
  spot, which reaches none of them (history clamped to the newest 366 days, no
  recorded days, reports filed under a `geo:` cell, the region borrowed from
  the nearest seed).
- **Already `{name}--{ref}`:** unchanged. A canonical slug is a fixed point, so
  no redirect can loop.

## The mapping table

`src/lib/slug-migration-data.ts` holds the 264 pairs, generated once and then
pinned (append-only: a published URL never changes).
`src/lib/slug-migration.test.ts` fails unless the table has exactly one row per
seed, is a bijection, equals the derivation from the seed, decodes back within
one 153 m cell of the seed, contains no legacy slug as a canonical slug and no
OSM ref. The Rust copy
(`workers/crates/weather-core/data/slug-migration.json`) is written by
`workers/scripts/gen-seed-locations.mjs` (CI runs it with `--check`), and the
Worker re-derives every canonical slug from the seed with its own geohash and
slugify implementation, so the two cannot drift.

## Redirects (308, forever)

- Only a slug in the table redirects. A legacy seed slug, a bare seed name, and
  either in the wrong case go in one hop from a table in the proxy, with no
  lookup. The sub-route (`forecast`, `atmosphere`, `map`, `agriculture`) and
  the query string are kept.
- Any other legacy slug is not redirected, whatever a lookup says about it. It
  resolves as before: the stored geography (`placesGeo`), then the Nyuchi API
  and the community records. On the places Worker, `find_location` asks the
  seed first (either spelling), then the spot, then the Nyuchi API, then the
  community records (`weather_core::locations::slug_branch`); a slug without
  the `--` delimiter can never be a spot, so an old `{city}-{cc}` or platform
  slug is never shadowed by one.
- The `lastLocation` cookie: a legacy value still resolves, and the proxy
  rewrites it to canonical on `/` (table only).

## Everywhere else

The resolvers return a shipped place with its canonical `slug`, so canonical
URLs, JSON-LD, breadcrumbs, OG, the sitemap, explore lists and links all
follow. A canonical seed slug resolves as the seed itself (its own province,
tags, elevation), not as a bare coordinate.

Saved state (`selectedLocation`, `savedLocations`, `homeLocation`,
`hiddenPresetSlugs`, `locationLabels`) is migrated by `migrateSlugPrefs` on
every path into the store, once and idempotently, then written back so
IndexedDB and the device profile follow. It maps table slugs only: a saved
community or platform place keeps its slug, its label and its place in the
list. The offline copy of a place (`recallPlace`) is found under either
spelling of a shipped place and always shown under the canonical one, so an
in-place switch to an old link lands on the canonical URL.

## Backend: what is kept

For the **shipped seeds**, nothing is lost: existing history and reports live
under the legacy slug, and the Workers accept both spellings and key by the
legacy one (`weather_core::slug_migration`: `storage_slug` and `read_keys` for
the MongoDB reports and history, `history::d1_slug` for the D1 `place_daily`
days). Report reads also include the `geo:<geohash7>` cell key a visitor may
have written under while the canonical URL was only a spot. The AI Worker's
caches are keyed by the place the point resolves to, not by a slug the client
sends, so they need no mapping.

For **every other place**, nothing changes: its slug is its key, as before.
Nothing writes production data and there is no migration script.

## Deploy order (required)

Deploy the **places, forecast and ai Workers first**, then promote Vercel.

The new app sends the canonical slug of a seed. An old Worker does not know it
as a seed and reads it as a spot: history is clamped to 366 days with no
recorded days, it draws on the spot budgets (`history-backfill-coords`, 10 an
hour), archive days are written under `geo:<cell>` keys the new Workers never
read, reports are filed under `geo:<cell>` and vanish from the page until the
Workers land, and the profile and agriculture routes treat the place as a
spot. No data is destroyed, but orphaned archive documents are written. The
other order is safe: an old app on new Workers only ever sends legacy slugs,
which the new Workers still accept. `jobs` shares the crate but its behaviour
is unchanged; `mongo-bridge`, `public-api` and `internal-api` need no ordering.

## Owner decisions and risks

- **SEO:** every indexed seed URL becomes a 308 to a new URL. Google follows
  308s and transfers signals, but expect a re-crawl and a temporary ranking dip;
  the sitemap now lists only canonical URLs. Browsers cache a 308, so a revert
  would leave them redirecting to the canonical form.
- **Readability:** `harare--ksy4dd1` is less friendly to read aloud than
  `harare`.
- **Fixed forever:** a seed's canonical slug is pinned. Moving a seed's
  coordinate later does not change its URL (the test will flag the drift).
  Some pinned slugs read oddly (`lion-s-den--ksvpdty`) and cannot be changed
  later.
- **Non-seed places keep their old URLs.** One community place can still have
  both its old slug and, if someone shared a spot link to it, a spot slug.
  Merging them is a separate decision (it needs the stored data re-keyed), not
  part of this change.

## Known limits and follow-ups (not in this change)

- **Worker answers are not uniform.** `/v1/locations?slug=` answers a seed with
  its canonical slug; `/v1/search`, `/v1/geo` and the list answer the legacy
  one. The app canonicalises them where it reads them
  (`useLocationQuickSearch`, `detectUserLocation`, the home page, bare-name); a
  new caller must do the same. `resolve.rs` is the place to move them.
- **Alert keys.** `alertPlaceKey` (`src/lib/push/place-key.ts`) treats a slug
  with `--` as a spot, so a canonical seed would key as `place--ksy4d`. Nothing
  calls it yet; when #289 step (e) is wired, pass the slug through
  `storageKeySlug` first.
- **Fallback names.** Before a place's real name has been seen,
  `displayNameFromSlug` reads some canonical slugs badly (`hoi-an--…` as
  "Hoi", `n-djamena--…` as "N Djamena").
- **A stale stored page.** A service-worker copy of a legacy URL shows once
  before the redirect purges it; the place stage keeps one memory entry for
  it under the canonical slug.
- **Analytics.** Seeds are exported under their legacy catalogue name
  (`coarsenSlug`), so GA continuity holds; non-seed places are unchanged.
- **Manual checks and docs.** `scripts/browser-check/*` still navigates
  `/harare` and expects the page to be stored; the README and the developers
  page still show legacy URLs; there is no release note yet (write it at
  release time).
- **CI path filter.** `workers.yml` does not list `src/lib/slug-migration-data.ts`;
  the TypeScript parity test in `ci` still catches drift.
