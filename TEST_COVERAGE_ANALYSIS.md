# Test Coverage Analysis

**Date:** 2026-02-14
**Current state:** 10 test files, 183 passing tests, all green

---

## Current Coverage Summary

### What IS tested (10 files, ~183 tests)

| Test File | Module Tested | Tests | Coverage Quality |
|-----------|--------------|-------|-----------------|
| `lib/weather.test.ts` | Weather utilities | 45 | Excellent — frost detection, WMO codes, seasons, wind, UV, fallback data |
| `lib/locations.test.ts` | Location database | 27 | Excellent — data integrity, search, filtering, geolookup, bounds |
| `lib/activities.test.ts` | Activity system | 26 | Excellent — definitions, categories, search, filtering, styles |
| `lib/tomorrow.test.ts` | Tomorrow.io client | 22 | Good — code mapping, normalization, insights extraction |
| `components/weather/charts.test.ts` | Chart data prep | 20 | Good — hourly, daily, atmospheric data formatting |
| `app/seo.test.ts` | SEO config | 14 | Good — robots.txt, sitemap completeness |
| `app/api/ai/ai-prompt.test.ts` | AI prompt | 8 | Moderate — static string checks on prompt content |
| `app/[location]/FrostAlertBanner.test.ts` | Frost banner CSS | 8 | Good — severity class mapping, design token compliance |
| `components/embed/MukokoWeatherEmbed.test.ts` | Embed widget | 7 | Good — CSS module structure, no hardcoded colors |
| `lib/store.test.ts` | Zustand store | 6 | Basic — theme resolution, onboarding; missing activity/location state |

### What is NOT tested (94 source files)

The project has strong coverage for **pure utility functions** and **data validation** but significant gaps in **API routes**, **business logic orchestration**, **i18n**, and **error handling paths**.

---

## Priority 1: High-Impact Gaps (Pure Functions, Easy to Test)

These are exported pure functions with no external dependencies — straightforward to test with high value.

### 1. `src/lib/i18n.ts` — Internationalization

**Why it matters:** Every user-facing string goes through this module. Translation lookup failures silently return the raw key, which could ship broken UI without anyone noticing.

**What to test:**
- `t(key)` returns correct English translation for known keys
- `t(unknownKey)` falls back to returning the raw key
- `t(key, { param: value })` replaces `{param}` placeholders correctly
- `t(key, params, "sn")` falls back to English when Shona messages are empty
- `formatTemp(28.7)` rounds correctly, handles negatives
- `formatWindSpeed()`, `formatPercent()` rounding behavior
- `formatTime()` produces 24h format (not 12h AM/PM)
- `formatDayName()` returns short weekday (e.g., "Mon" not "Monday")
- `formatDate()` produces day-month-year format

**Estimated tests:** ~20

### 2. `src/lib/db.ts` — `getTtlForLocation()` and `isSummaryStale()`

**Why it matters:** These two pure functions control caching behavior. A bug in TTL assignment wastes API credits or serves stale data. A bug in staleness detection causes users to see outdated AI summaries.

**What to test:**
- `getTtlForLocation("harare")` returns tier 1 (1800s)
- `getTtlForLocation("mazowe", ["farming"])` returns tier 2 (3600s)
- `getTtlForLocation("unknown-place")` returns tier 3 (7200s)
- `isSummaryStale()` returns `true` when temperature delta > 5
- `isSummaryStale()` returns `false` when delta is exactly 5 (boundary)
- `isSummaryStale()` returns `true` when weather code changes
- `isSummaryStale()` returns `false` when both temp and code are within threshold

**Estimated tests:** ~10

### 3. `src/components/weather/AtmosphericSummary.tsx` — Label helper functions

**Why it matters:** These functions produce the contextual labels users see on every location page ("Dry", "Humid", "Low pressure", etc.). Incorrect boundary handling means misleading labels.

**What to test (requires exporting the helpers or extracting them):**
- `humidityLabel()` at all boundaries: 0, 30, 31, 60, 61, 80, 81, 100
- `pressureLabel()` at boundaries: 999, 1000, 1020, 1021
- `cloudLabel()` at all 5 tiers: 0, 10, 11, 30, 31, 70, 71, 90, 91, 100
- Feels-like context: cooler/warmer/same logic

**Estimated tests:** ~15
**Prerequisite:** Extract `humidityLabel`, `pressureLabel`, `cloudLabel` into a testable module or export them.

### 4. `src/lib/error-retry.ts` — Retry count management

**Why it matters:** This prevents infinite reload loops in error boundaries. If `getRetryCount()` always returns 0 due to a bug, the page could reload forever on error.

**What to test:**
- `getRetryCount()` returns 0 when sessionStorage is empty
- `getRetryCount()` returns stored count when URL matches
- `getRetryCount()` returns 0 when URL doesn't match (reset on navigation)
- `getRetryCount()` handles corrupted JSON gracefully
- `setRetryCount()` stores count and URL
- `clearRetryCount()` removes the key
- `MAX_RETRIES` equals 3

**Estimated tests:** ~8
**Note:** Requires mocking `sessionStorage` and `window.location`.

### 5. `src/lib/utils.ts` — `cn()` class merging

**Why it matters:** Used in virtually every component. Tailwind class conflict resolution is the whole point.

**What to test:**
- Merges multiple class strings
- Later Tailwind classes override earlier ones (`cn("p-4", "p-2")` → `"p-2"`)
- Filters out falsy values (`false`, `undefined`, `null`)
- Handles empty input

**Estimated tests:** ~5

---

## Priority 2: API Route Testing (Medium Difficulty, High Value)

API routes contain the core business logic orchestration. They currently have **zero test coverage**. These tests require mocking MongoDB and external API calls but protect against regressions in the most critical paths.

### 6. `src/app/api/weather/route.ts` — Weather API

**Why it matters:** This is the most-called endpoint. It has coordinate validation, fallback logic, and header-setting behavior that are all testable.

**What to test:**
- Missing lat/lon uses Harare defaults
- Invalid (NaN) coordinates return 400
- Out-of-bounds coordinates return 400 with descriptive message
- Boundary coordinate values (edges of Zimbabwe region)
- `X-Weather-Provider` header reflects the data source
- `X-Cache` header is `HIT` or `MISS`
- Unexpected errors still return 200 with fallback weather (never 500)

**Estimated tests:** ~10
**Requires:** Mocking `getWeatherForLocation` and `findNearestLocation`

### 7. `src/app/api/geo/route.ts` — Geolocation API

**What to test:**
- Missing lat/lon returns 400
- Non-numeric params return 400
- Valid coordinates with nearest location returns 200 with `nearest` and `redirectTo`
- Coordinates outside Zimbabwe return 404

**Estimated tests:** ~5
**Requires:** Mocking `findNearestLocation`

### 8. `src/app/api/history/route.ts` — History API

**What to test:**
- Missing `location` returns 400
- Unknown location returns 404
- Missing `days` defaults to 30
- `days` < 1 or > 365 returns 400
- Boundary values: `days=1` and `days=365` are valid
- Database error returns 502

**Estimated tests:** ~8
**Requires:** Mocking `getLocationBySlug` and `getWeatherHistory`

### 9. `src/app/api/ai/route.ts` — AI Summary API

**What to test:**
- Missing `weatherData` or `location` returns 400
- Cache hit with fresh summary returns cached result
- Cache hit but stale summary triggers regeneration
- No `ANTHROPIC_API_KEY` returns a basic fallback summary
- Activities array is included in the prompt when provided
- Error returns 502

**Estimated tests:** ~8
**Requires:** Mocking Anthropic SDK, `getCachedAISummary`, `setCachedAISummary`, `isSummaryStale`

### 10. `src/app/api/db-init/route.ts` — DB Init API

**What to test:**
- Production mode without secret returns 401
- Production mode with correct secret proceeds
- Non-production mode skips secret check
- API keys with empty strings are skipped
- Successful init returns location count and key names

**Estimated tests:** ~6
**Requires:** Mocking `ensureIndexes`, `syncLocations`, `setApiKey`

---

## Priority 3: Observability and Error Handling (Medium Value)

### 11. `src/lib/observability.ts` — Structured logging

**Why it matters:** If the logging functions break, production errors become invisible. Testing ensures the structured JSON output has the expected shape.

**What to test:**
- `logError()` with Error object includes `errorName` and `stack`
- `logError()` with string error includes `errorValue`
- `logWarn()` outputs `"warn"` level
- `reportErrorToAnalytics()` on server (no `window`) is a no-op
- `reportErrorToAnalytics()` truncates descriptions to 150 chars
- `reportProviderFailure()` formats description correctly

**Estimated tests:** ~10

### 12. `src/lib/store.test.ts` — Expand existing tests

**Current gap:** Only tests `resolveTheme()` and `hasOnboarded`. Missing coverage for activity toggling, location state, and My Weather modal state.

**What to add:**
- `toggleActivity()` adds/removes an activity ID
- `toggleActivity()` with duplicate ID removes it
- `selectedActivities` defaults to empty array
- `setSelectedLocation()` updates the location slug
- `openMyWeather()` / `closeMyWeather()` toggle modal state
- `myWeatherOpen` defaults to `false`

**Estimated tests:** ~8

---

## Priority 4: Icon and Mapping Completeness (Low Difficulty, Moderate Value)

### 13. `src/lib/weather-icons.tsx` — Icon mapping functions

**What to test:**
- `WeatherIcon` maps all known icon names to the correct component
- `WeatherIcon` returns `CloudIcon` for unknown names
- `ActivityIcon` maps all 20 activity IDs to the correct component
- `ActivityIcon` returns `SunIcon` for unknown IDs
- Icons accept and apply `size` and `className` props

**Estimated tests:** ~25

---

## Priority 5: Integration-Level Gaps (Higher Difficulty)

These require more setup (React testing library, DOM mocking) but cover important user-facing behavior.

### 14. `getWeatherForLocation()` — Orchestration (in `db.ts`)

The 4-stage fallback chain (cache → Tomorrow.io → Open-Meteo → seasonal fallback) is the most critical business logic in the application and has no direct tests.

**What to test (with mocked DB and API calls):**
- Cache hit returns immediately without calling APIs
- Cache miss calls Tomorrow.io first
- Tomorrow.io rate limit triggers Open-Meteo fallback
- Tomorrow.io missing API key skips to Open-Meteo
- Both APIs failing returns `createFallbackWeather`
- Result includes correct `source` field at each stage
- History recording is triggered on fresh fetches

**Estimated tests:** ~10

### 15. Error boundary components

`ChartErrorBoundary`, `error.tsx` pages — test that errors are caught and fallback UI renders.

### 16. `src/lib/geolocation.ts` — Browser geolocation wrapper

Requires mocking the Geolocation API. Tests should cover permission denied, unavailable, outside Zimbabwe, and successful detection.

---

## Summary: Recommended Test Additions by Priority

| Priority | Area | New Tests | Difficulty |
|----------|------|-----------|------------|
| **P1** | `i18n.ts` — translation + formatting | ~20 | Easy |
| **P1** | `db.ts` — `getTtlForLocation` + `isSummaryStale` | ~10 | Easy |
| **P1** | `AtmosphericSummary` label helpers | ~15 | Easy (after extraction) |
| **P1** | `error-retry.ts` — retry count management | ~8 | Easy |
| **P1** | `utils.ts` — `cn()` class merging | ~5 | Easy |
| **P2** | Weather API route (`/api/weather`) | ~10 | Medium |
| **P2** | Geo API route (`/api/geo`) | ~5 | Medium |
| **P2** | History API route (`/api/history`) | ~8 | Medium |
| **P2** | AI API route (`/api/ai`) | ~8 | Medium |
| **P2** | DB Init API route (`/api/db-init`) | ~6 | Medium |
| **P3** | `observability.ts` — logging functions | ~10 | Easy-Medium |
| **P3** | `store.test.ts` — expand existing tests | ~8 | Easy |
| **P4** | `weather-icons.tsx` — icon mapping | ~25 | Easy |
| **P5** | `getWeatherForLocation()` orchestration | ~10 | Medium-Hard |
| **P5** | Error boundaries | ~5 | Medium |
| **P5** | `geolocation.ts` — browser API wrapper | ~8 | Medium |
| | **Total** | **~161** | |

This would roughly double the test count from 183 to ~344 tests and cover the most impactful gaps first.

---

## Key Observations

1. **Strongest area:** Pure utility functions (`weather.ts`, `locations.ts`, `activities.ts`, `tomorrow.ts`) have excellent coverage with thorough edge case and boundary testing.

2. **Biggest gap:** API routes have **zero** test coverage. These contain the primary business logic (coordinate validation, caching decisions, provider fallback, error handling) and are the most likely place for regressions.

3. **Testing style is consistent and effective:** The codebase uses a pragmatic approach — testing exported logic without rendering React components, reading source files as strings for static analysis (embed/frost tests). This pattern can be extended to new tests without adding React Testing Library as a dependency.

4. **Architectural suggestion:** The `humidityLabel`, `pressureLabel`, and `cloudLabel` helpers in `AtmosphericSummary.tsx` should be extracted to a shared utility file (e.g., `src/lib/weather-labels.ts`) so they can be imported and tested directly. The same pattern used for `prepareHourlyData` (exported from chart components) would work here.

5. **Store tests are minimal:** The Zustand store has 6 tests covering only theme resolution and onboarding. Activity toggling, location state management, and modal state are untested — these directly affect user experience.

6. **i18n is completely untested:** Given that Shona and Ndebele support is "structurally ready," having tests now would catch issues when translations are actually added.
