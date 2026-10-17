# Releases

## v0.11.0 — staging → main (fixes the slow, black-screen load on iOS)

**Date:** 2026-10-17 · **Replaces:** v0.10.0 on production · **PRs:** #300, #299, #296, #276, #274, #267

### Fixes

- **Pages hydrate again** (#300). Cloudflare Fonts rewrote the Google Fonts `<link>` into an inline `<style>`, so React threw error #418 on every page and re-rendered the whole page on the client. Fonts are now self-hosted through `next/font`, so there is nothing to rewrite and no render-blocking cross-origin CSS. The moon disc no longer reads the clock during render.
- **The header stays at the top and the bottom nav stays at the bottom** (#300). `overflow-x: hidden` on `html`, `body` and every page wrapper made each one a scroll container. They are now `overflow-x: clip`.
- **Sections appear before you reach them** (#300). Two sections mount at a time (one on Save-Data or 2 GB-or-less devices), with a 1.5-viewport load margin.
- **Lighter first load** (#300). The weather backdrop shows a static sky on reduced motion, Save-Data and low-memory devices, pauses while you scroll and uses a low-power WebGL context. Model comparison, climate normals and route prefetches no longer fire on load.
- **Even spacing** (#300). Empty sections no longer leave doubled gaps. Card padding and heading margins follow the shared tokens.
- **MapTiler and OpenStreetMap are credited once** (#296).

### Features and performance

- **Phone navigation uses the Mzizi bottom nav** (#300): Map, My Location and Locations, with the saved-place pager row above it. Swipe between places is unchanged.
- **The map card on the location page is a static raster-tile image** (#276), not a MapLibre map. About 535 KB of requests and a full map library no longer load on the location page.
- **Radar tiles answer at once when the Tomorrow.io quota is spent** (#267). The tile proxy no longer waits for a 429, and "now" tiles are edge-cached only until the UTC hour ends.
- **The location pipeline works worldwide** (#274). Search results outside Africa open real pages, home no longer shows an empty chooser, country names replace codes, and the blend region and cache country are right outside Africa. African places and slugs are unchanged.

### Security and privacy

- The report-only CSP no longer lists `fonts.googleapis.com` or `fonts.gstatic.com` (#300).
- Typed search text can reach Open-Meteo's geocoder; `/privacy` says so (#274).

### Operations and risk

- Python backend changes: tile proxy (#267), locations, weather and model blend (#274). No database migration, no new environment variable, no db-init seed change, no feature-flag change.
- New third-party host use: MapTiler raster tiles on the location page (#276). The MapTiler key's allowed HTTP origins must cover `weather.mukoko.com`, or the card falls back to text.
- Held back and not in this release: #271, #279, #285.
- Rollback: redeploy the previous production deployment in Vercel (v0.10.0). The release is one squash commit on `main`, so `git revert` of it also works. Nothing needs undoing in the database.

## PR #28 — Explore chatbot, activities expansion, and suitability rules

**Date:** 2026-02-21

### New Features

**Atlas Search integration** (`src/lib/db.ts`)

- Fuzzy text search for locations with typo tolerance (maxEdits: 1) and autocomplete on name field
- Fuzzy text search for activities across label, description, and category
- Automatic fallback to `$text` indexes when Atlas Search is unavailable
- Time-based auto-recovery: retries Atlas Search every 5 minutes after index-missing errors
- Only permanent errors (MongoDB code 40324 / index not found) disable search; transient errors retry immediately

**Vector Search infrastructure** (`src/lib/db.ts`)

- `vectorSearchLocations()` — cosine similarity search on 1024-dimension embeddings
- `storeLocationEmbedding()` / `storeLocationEmbeddings()` — store pre-computed embeddings
- Embedding existence guard prevents unnecessary Atlas errors when no pipeline is wired up
- Foundation for future semantic search in the Shamwari chatbot

**$facet aggregation** (`src/lib/db.ts`)

- `getTagCountsAndStats()` — tag counts + location stats in a single pipeline
- Atlas Search index definitions available via `getAtlasSearchIndexDefinitions()` and returned in db-init response

### Improvements

**Explore route resilience** (`src/app/api/explore/route.ts`)

- Module-level singleton Anthropic client with key-rotation invalidation (recreates client when API key changes in MongoDB)
- Dynamic activity list in system prompt (built from DB cache at request time, not hardcoded)
- Capped `list_locations_by_tag` results to 20 with count/note for Claude context awareness
- 15-second per-tool timeout (`withToolTimeout`) prevents serverless function hangs
- Typed weather cache (`Map<string, WeatherResult>` instead of `Map<string, any>`)
- In-request suitability rules cache (`rulesCache`) prevents redundant DB queries across tool iterations
- Reference deduplication (`deduplicateReferences`) prefers "location" type over "weather" type
- Weather fetch failures now logged via `logWarn` (were silently swallowed)

**Suitability rules cleanup** (`src/lib/seed-suitability-rules.ts`)

- Removed `metricTemplate` from all 7 fallback blocks — field-name placeholders (`{gdd10To30}`, `{visibility}`, etc.) would silently resolve to `undefined` when insight fields were missing
- Condition-level metric templates using `{value}` (the matched condition value) are preserved

**Input validation** (`src/app/api/suitability/route.ts`)

- Key parameter validated against `^(activity|category):[a-z0-9-]+$` regex
- Returns 400 for invalid key format, 404 for key not found
- Error responses now include `s-maxage=10` cache headers to prevent thundering herd during outages

**Error reporting** (`src/components/weather/ActivityInsights.tsx`)

- Suitability rules and category styles fetch failures now reported to GA4 via `reportErrorToAnalytics` (were silently swallowed)

**Database queries** (`src/lib/db.ts`)

- `getLocationsForContext()` sort fixed: `{ source: -1, name: 1 }` (descending) correctly prioritizes seed locations over community/geolocation
- `isAtlasSearchIndexMissing()` helper only permanently disables search on code 40324 / "index not found" — transient errors retry normally

### Security

**Sanitization approach** (`src/app/api/explore/route.ts`)

- Removed legacy `CONTEXT_BOUNDARY_RE` regex — `\n\nHuman:` / `\n\nAssistant:` markers have no special meaning in the Anthropic Messages API (structured turns, not flat text)
- Documented actual defenses inline: structured messages array, system prompt DATA GUARDRAILS, history length caps, server-controlled tool output, circuit breaker + rate limiter
- `sanitizeHistoryContent()` now focuses on what matters: enforcing `MAX_MESSAGE_LENGTH` via `.slice()`
- Current user message is sanitized consistently with history via `sanitizeHistoryContent(message)`

**Suitability engine** (`src/lib/suitability.ts`)

- `DECIMAL_FIELDS` Set replaces inline field-name checks for decimal precision (visibility, evapotranspiration)
- `eq` operator documented as safe for integer alert levels only (not continuous float measurements)

**Chatbot UI** (`src/components/explore/ExploreChatbot.tsx`)

- `MarkdownErrorBoundary` wraps ReactMarkdown rendering — malformed markdown degrades to plain text instead of crashing the chat UI
- Dynamic textarea height comment documents inline `style.height` as pragmatic exception

**Client caching** (`src/lib/suitability-cache.ts`)

- Shared TTL comment clarifies that rules and category styles deliberately use the same 10-minute TTL

### Tests

Test count increased from 1080 to 1097 with this PR's changes:

- Atlas Search time-based recovery (timestamp-based disabling, auto-retry after 5 min, permanent vs transient errors)
- Vector Search embedding guard (checks for stored embeddings, documented as future infrastructure)
- Explore route security (structured messages API defense documentation, sanitizeHistoryContent max-length enforcement)
- Explore route resilience (singleton key-rotation invalidation, dynamic activity list, tag result cap, tool timeouts)
- Suitability route key validation (regex format check, 400/404 responses, error response caching)
- Suitability engine code quality (DECIMAL_FIELDS set, eq operator documentation, decimal precision)
- ExploreChatbot error boundary (MarkdownErrorBoundary, fallback to raw text)
- Suitability fallback metric changes (metricTemplate removed from fallbacks)

### Files Changed

| File                                                | Changes                                                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/db.ts`                                     | Atlas Search, Vector Search, $facet, time-based recovery, sort fix, index-missing helper                                             |
| `src/app/api/explore/route.ts`                      | Singleton client with key-rotation, dynamic activity list, tag result cap, tool timeouts, typed caches, dedup refs, sanitize cleanup |
| `src/lib/suitability.ts`                            | DECIMAL_FIELDS set, eq operator documentation                                                                                        |
| `src/lib/seed-suitability-rules.ts`                 | Removed fallback metricTemplates                                                                                                     |
| `src/app/api/suitability/route.ts`                  | Key validation regex, error response caching                                                                                         |
| `src/components/explore/ExploreChatbot.tsx`         | MarkdownErrorBoundary, textarea comment                                                                                              |
| `src/lib/suitability-cache.ts`                      | Shared TTL comment                                                                                                                   |
| `src/components/weather/ActivityInsights.tsx`       | Error reporting, removed fetchedRef guard                                                                                            |
| `src/app/api/db-init/route.ts`                      | Atlas Search index definitions in response                                                                                           |
| `src/lib/db.test.ts`                                | Atlas Search recovery, Vector Search guard, $facet tests                                                                             |
| `src/app/api/explore/explore-route.test.ts`         | Key-rotation, dynamic activities, tag cap, security, resilience tests                                                                |
| `src/app/api/suitability/suitability-route.test.ts` | Key validation, error caching tests                                                                                                  |
| `src/lib/suitability.test.ts`                       | DECIMAL_FIELDS, eq documentation, decimal precision tests                                                                            |
| `src/components/explore/ExploreChatbot.test.ts`     | MarkdownErrorBoundary tests                                                                                                          |
| `src/app/api/db-init/db-init-route.test.ts`         | Atlas Search index definitions test                                                                                                  |
