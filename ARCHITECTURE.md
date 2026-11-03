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

### Circuit Breakers

`weather_core::breaker` — Netflix Hystrix-inspired circuit breaker for external API resilience, in the Rust Workers. It is pure (time is passed in) and its state lives in the Worker isolate's memory, so it protects a provider from a burst of calls while it is failing, without any storage round trip. (The Python implementation in `api/py/_circuit_breaker.py` was deleted with the Python backend, #333.)

```
CLOSED ──(failures >= threshold)──> OPEN ──(cooldown expires)──> HALF_OPEN
  ^                                                                  |
  |                                                                  |
  +──────────(success)──────────────────────────────────────────────+
                                                                     |
  OPEN <──────────────(failure)──────────────────────────────────────+
```

**Per-provider breakers** (only a 5xx, a 429, a transport error, a timeout or an unreadable body counts as a failure; a 4xx never does):

| Breaker      | Providers                                                      | Failure Threshold | Cooldown | Window |
| ------------ | -------------------------------------------------------------- | :---------------: | :------: | :----: |
| `TOMORROW`   | Tomorrow.io (insights enrichment, map tiles)                   |         3         |  2 min   | 5 min  |
| `MET_NO`     | MET Norway Locationforecast (the failover forecast)            |         3         |  5 min   | 5 min  |
| `OPEN_METEO` | Open-Meteo (forecast, grids, air quality, haze, history, ERA5) |         5         |  5 min   | 5 min  |
| `NASA_POWER` | NASA POWER (history archive)                                   |         3         |  2 min   | 5 min  |
| `SOILGRIDS`  | ISRIC SoilGrids                                                |         3         |  15 min  | 10 min |
| `DEFAULT`    | NOAA CPC, NEA data.gov.sg, Aviation Weather Center             |         3         |  2 min   | 5 min  |

The AI Worker has no breaker: a model call is bounded by the D1 budgets, a timeout and the gateway's own limits.

`MET_NO` is the one breaker that can be tripped at once: MET Norway's terms say to stop traffic immediately when it answers `429` (and a `403` means the client is blocked), so either opens the circuit for the full cooldown (`Breaker::trip`).

AI runs only in the AI Worker, `mukoko-weather-ai`: Workers AI GLM through the `shamwari` AI Gateway with the native `env.AI` binding, the Nyuchi guardrails first in every prompt. No Cloudflare AI token exists on Vercel. The signed-in app reaches it through its own server: the Next.js `/api/ai` proxy checks the WorkOS session (`withAuth()`), then calls `{WEATHER_SERVICE_URL}/internal/ai/summary` with `Authorization: Bearer WEATHER_SERVICE_API_KEY` and the person's id and address. `mukoko-weather-internal` checks the key and forwards over a service binding; the AI Worker caches the answer in KV (30/60/120 min by tag) and counts only the calls that reach the model against the person's hour in D1 (`weather_core::budget`). No Python calls a model any more: the report wizard's follow-up questions, the last Python AI route, are `POST /v1/reports/clarify` on the AI Worker.

### Weather Fallback Chain

The forecast Worker's chain always ends in an answer, and says which stage served it (`X-Weather-Provider`):

```
1. KV cache (wx:v2:<lat>_<lon>, fresh 15 min; 5 min for a best_match answer; kept 24 h)
    |── fresh hit ──> return cached data
    |── miss, or past its fresh lifetime (kept as the last resort)
    v
2. Open-Meteo Africa-weighted blend of nine global models (served only when at least four return data)
    |── success ──> cache + return (Tomorrow.io enrichment merged on top when its budget allows)
    |── too few members, or the request fails
    v
3. Open-Meteo best_match (labelled as not a blend)
    |── success ──> cache + return
    |── error, or the breaker is open
    v
4. MET Norway Locationforecast (`met-no`, keyless failover, converted at the edge; only reached here)
    |── success ──> cache 15 min + return (the blend is asked first again after that)
    |── error, throttled or breaker open
    v
5. The stored forecast past its fresh lifetime, if any (`X-Cache: STALE`)
    |── none
    v
6. Seasonal estimate (labelled `fallback`, added by the public API)
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

The Shamwari chat is `POST /v1/ai/chat` on the Rust AI Worker (`workers/ai`); the Python `/api/py/chat` and its tool loop were deleted with the Python backend. The Worker's layers:

| Layer              | Mechanism                                                                     | Scope       |
| ------------------ | ----------------------------------------------------------------------------- | ----------- |
| Rate limiter       | 10 requests a minute per client (Workers rate-limit binding)                  | Per-client  |
| Input validation   | Message 1 to 2000 characters, last 10 turns, roles `user`/`assistant`         | Per-request |
| Personal data      | Email, phone and card numbers refused (`422`), never sent to a model          | Per-request |
| Guardrails         | The Nyuchi API's compiled block first in the system prompt; `503` without one | Per-isolate |
| Gateway            | `shamwari` AI Gateway: Guardrails and DLP blocks answered politely            | Per-call    |
| Weather for places | The seed places named in the message, up to three, from the forecast Worker   | Per-request |
| Place profile      | Each named place's profile block and the grounding rule                       | Per-request |
| Markdown boundary  | `MarkdownErrorBoundary` in the chatbot UI                                     | Per-section |

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

| Collection            |        TTL         | Purpose                                                                                   |
| --------------------- | :----------------: | ----------------------------------------------------------------------------------------- |
| `ai_summaries`        |   30/60/120 min    | Cached AI weather summaries (tiered by location). Now KV in the AI Worker; no longer read |
| `weather_history`     |        None        | Permanent historical weather records                                                      |
| `history_analysis`    |       1 hour       | Unused: AI history analyses are cached in the AI Worker's KV (`history:v1:`)              |
| `locations`           |        None        | Seed + community locations                                                                |
| `activities`          |        None        | Activity definitions (30+ activities, 6 categories)                                       |
| `activity_categories` |        None        | Category metadata with mineral color styles                                               |
| `suitability_rules`   |        None        | Condition-based weather suitability rules                                                 |
| `tags`                |        None        | Tag metadata (slug, label, icon, featured)                                                |
| `regions`             |        None        | Supported geographic regions (bounding boxes)                                             |
| `seasons`             |        None        | Country-specific season definitions                                                       |
| `countries`           |        None        | Country metadata (54 AU + ASEAN)                                                          |
| `provinces`           |        None        | Province/state metadata                                                                   |
| `ai_prompts`          |        None        | Database-driven AI system prompts                                                         |
| `ai_suggested_rules`  |        None        | Dynamic suggested prompt rules                                                            |
| `weather_reports`     | TTL on `expiresAt` | Community weather reports (24h/48h/72h by severity); written by the MongoDB bridge Worker |
| `device_profiles`     |        None        | Cross-device preference sync (anonymous UUID); written by the MongoDB bridge Worker       |
| `rate_limits`         | TTL on `expiresAt` | IP rate limiting (atomic findOneAndUpdate)                                                |
| `api_keys`            |        None        | Third-party API keys (Tomorrow.io, Stytch)                                                |

### Atlas Search Indexes

| Index             | Collection | Fields                                                    | Type   |
| ----------------- | ---------- | --------------------------------------------------------- | ------ |
| `location_search` | locations  | name (text + autocomplete), province, slug, tags, country | Search |
| `activity_search` | activities | label, description, category                              | Search |
| `location_vector` | locations  | embedding (1024d, cosine) + tag/country pre-filters       | Vector |
