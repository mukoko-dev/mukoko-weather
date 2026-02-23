# Architecture

This document describes the key architectural patterns in mukoko weather. For the full project context (routes, components, styling, testing), see [CLAUDE.md](CLAUDE.md).

## Search Architecture

### Atlas Search (Fuzzy Text Search)

Location and activity search use MongoDB Atlas Search with automatic fallback to `$text` indexes.

```
User query
    |
    v
Atlas Search available?  ──no──>  $text index search
    |                              (exact + stemmed matches)
   yes
    |
    v
$search pipeline
  - fuzzy matching (maxEdits: 1, prefixLength: 1)
  - autocomplete on name field
  - compound queries (must + filter)
  - score boosting on name field
    |
    v
Results (ranked by relevance)
```

**Indexes required:**
- `location_search` — on `locations` collection (name, province, slug, tags, country with autocomplete on name)
- `activity_search` — on `activities` collection (label, description, category)

Index definitions are available via `getAtlasSearchIndexDefinitions()` in `src/lib/db.ts` and returned in the `/api/db-init` response. Indexes must be created manually in the MongoDB Atlas UI or via the Atlas Admin API.

**Time-based recovery pattern:**

When Atlas Search encounters a missing-index error (MongoDB code 40324), it disables the search path and records a timestamp. After `ATLAS_RETRY_AFTER_MS` (5 minutes), the next request retries Atlas Search automatically. If the index was created in the meantime, search auto-recovers. If not, the timer resets.

```
Atlas Search call fails
    |
    v
Is it a missing-index error?  ──no──>  Next request retries normally
    |                                     (transient errors don't disable)
   yes
    |
    v
Record timestamp (atlasSearchDisabledAt = Date.now())
    |
    v
For next ATLAS_RETRY_AFTER_MS (5 min):
  - Skip Atlas Search, use $text fallback
    |
    v
After 5 min: retry Atlas Search
  - Success? Resume Atlas Search
  - Still missing? Reset timer for another 5 min
```

This pattern applies to all three search paths: location search, activity search, and vector search.

### Vector Search (Semantic Search — Foundation)

Vector Search infrastructure is in place but requires an embedding pipeline to be wired up before it can be used in production.

**What exists:**
- `vectorSearchLocations(embedding, options)` — runs `$vectorSearch` with cosine similarity on 1024-dimension embedding vectors
- `storeLocationEmbedding(slug, embedding)` / `storeLocationEmbeddings(entries)` — stores pre-computed embeddings on location documents
- Embedding existence guard — checks for at least one document with a stored embedding before running `$vectorSearch`
- `location_vector` index definition (1024 dimensions, cosine similarity, tag/country pre-filters)

**What's needed:**
- An embedding generation pipeline (e.g., using Anthropic or OpenAI embedding models)
- A job to generate and store embeddings for all locations (could be added to db-init or run as a separate job)
- A consumer that calls `vectorSearchLocations()` with query embeddings (e.g., the Shamwari chatbot for semantic location matching)

### $facet Aggregation

`getTagCountsAndStats()` uses MongoDB's `$facet` to run tag counts and location stats in a single aggregation pipeline, reducing round trips for the explore page.

## Resilience Patterns

### Circuit Breaker System

`api/py/_circuit_breaker.py` — Netflix Hystrix-inspired circuit breaker for external API resilience. Python implementation with in-memory state that persists across Vercel warm function starts (~5-15 minutes).

```
CLOSED ──(failures >= threshold)──> OPEN ──(cooldown expires)──> HALF_OPEN
  ^                                                                  |
  |                                                                  |
  +──────────(success)──────────────────────────────────────────────+
                                                                     |
  OPEN <──────────────(failure)──────────────────────────────────────+
```

**Per-provider singletons:**

| Breaker | Provider | Failure Threshold | Cooldown | Window | Timeout |
|---------|----------|:-:|:-:|:-:|:-:|
| `tomorrow_breaker` | Tomorrow.io API | 3 | 2 min | 5 min | 5s |
| `open_meteo_breaker` | Open-Meteo API | 5 | 5 min | 5 min | 8s |
| `anthropic_breaker` | Anthropic Claude | 3 | 5 min | 10 min | 15s |

### Weather Fallback Chain

4-stage fallback ensures weather data is always available:

```
1. MongoDB cache (15-min TTL)
    |── hit ──> return cached data
    |── miss
    v
2. Tomorrow.io API (primary)
    |── success ──> cache + return
    |── rate-limited (429) or error
    v
3. Open-Meteo API (fallback)
    |── success ──> cache + return
    |── error
    v
4. createFallbackWeather (seasonal estimates)
    |── always succeeds ──> return
```

### Error Isolation (Per-Section)

Every weather section is independently wrapped:

```
WeatherDashboard
  ├── CurrentConditions (loads eagerly)
  ├── LazySection + ChartErrorBoundary
  │     └── AISummary (crash here only hides this section)
  ├── LazySection + ChartErrorBoundary
  │     └── ActivityInsights
  ├── LazySection + ChartErrorBoundary
  │     └── HourlyForecast
  └── ...
```

A chart crash, API timeout, or rendering error in any section only affects that section. The page shell (header, navigation, footer) and all other sections remain fully functional.

### Shamwari Chatbot Resilience

The Shamwari chatbot (`/api/py/chat`) has multiple resilience layers:

| Layer | Mechanism | Scope |
|-------|-----------|-------|
| Rate limiter | 20 req/hour/IP (MongoDB-backed) | Per-client |
| Input validation | Type + length checks, slug regex, tag allowlist | Per-request |
| Circuit breaker | `anthropic_breaker` on all Claude calls | Per-provider |
| Tool timeout | 15s per tool execution | Per-tool |
| Tool loop bound | Max 5 iterations | Per-request |
| Tool result cap | `list_locations_by_tag` capped to 20 results | Per-tool |
| Weather cache | `Map<string, WeatherResult>` | Per-request |
| Rules cache | `rulesCache` ref | Per-request |
| Location context | Module-level, 5-min TTL | Per-instance |
| Activity context | Module-level, 5-min TTL (dynamic prompt list) | Per-instance |
| Singleton client | Module-level with hash-based key-rotation detection | Per-instance |
| Markdown boundary | `MarkdownErrorBoundary` in chatbot UI | Per-message |

## Lazy Loading (TikTok-Style Sequential)

Pages use a global FIFO queue that mounts ONE section at a time. This caps peak memory regardless of section count.

```
Scroll direction ──>

[Mounted]  [Mounted]  [MOUNTING]  [Skeleton]  [Skeleton]  [Not rendered]
                          ^
                    Queue processes
                    one at a time
                    (150ms mobile /
                     50ms desktop
                     settle delay)
```

Sections also UNMOUNT when scrolled 1500px past the viewport (bidirectional), reclaiming memory on long pages.

## Database Schema

### Collections

| Collection | TTL | Purpose |
|-----------|:---:|---------|
| `weather_cache` | 15 min | Cached weather API responses |
| `ai_summaries` | 30/60/120 min | Cached AI weather summaries (tiered by location) |
| `weather_history` | None | Permanent historical weather records |
| `history_analysis` | 1 hour | Cached AI history analysis results |
| `locations` | None | Seed + community locations |
| `activities` | None | Activity definitions (30+ activities, 6 categories) |
| `activity_categories` | None | Category metadata with mineral color styles |
| `suitability_rules` | None | Condition-based weather suitability rules |
| `tags` | None | Tag metadata (slug, label, icon, featured) |
| `regions` | None | Supported geographic regions (bounding boxes) |
| `seasons` | None | Country-specific season definitions |
| `countries` | None | Country metadata (54 AU + ASEAN) |
| `provinces` | None | Province/state metadata |
| `ai_prompts` | None | Database-driven AI system prompts |
| `ai_suggested_rules` | None | Dynamic suggested prompt rules |
| `weather_reports` | TTL on `expiresAt` | Community weather reports (24h/48h/72h by severity) |
| `device_profiles` | None | Cross-device preference sync (anonymous UUID) |
| `rate_limits` | TTL on `expiresAt` | IP rate limiting (atomic findOneAndUpdate) |
| `api_keys` | None | Third-party API keys (Tomorrow.io, Stytch) |

### Atlas Search Indexes

| Index | Collection | Fields | Type |
|-------|-----------|--------|------|
| `location_search` | locations | name (text + autocomplete), province, slug, tags, country | Search |
| `activity_search` | activities | label, description, category | Search |
| `location_vector` | locations | embedding (1024d, cosine) + tag/country pre-filters | Vector |
