# Mukoko Weather backend (Rust Workers)

The weather backend, moving out of the Next.js app into Cloudflare Workers written in Rust ([workers-rs](https://github.com/cloudflare/workers-rs)). The plan, the inventory and the migration order are in [#148](https://github.com/mukoko-dev/mukoko-weather/issues/148).

There is **one backend for everything weather**: the Mukoko Weather app, the public weather API, the weather stations, and other apps (through the Nyuchi API for internal callers, and mukoko-api for consumers). It is split into **several Workers, one job each**, connected by service bindings, with the shared logic in one Cargo workspace.

```text
workers/
  crates/weather-core/   pure Rust, tested natively: provider normalisation, the forecast
                         contract, places, station QC and ingest keys, circuit breaker
  crates/weather-edge/   Worker helpers: JSON errors, bearer auth, timeouts
  forecast/              mukoko-weather-forecast   provider aggregation (service binding only)
  internal-api/          mukoko-weather-internal   GET /internal/forecast for the Nyuchi API; POST /internal/ai/chat/completions
                                                   for the app's Python backend
  stations/              mukoko-weather-stations   station registration and ingest (Wunderground, Ecowitt, manual)
  places/                mukoko-weather-places     locations, search, nearest place, history (service binding only)
  public-api/            mukoko-weather-api        /v1/weather, /v1/forecast, /v1/air-quality, /v1/metar, /v1/airports/nearest,
                                                   /v1/locations, /v1/search, /v1/geo, /v1/history
  aviation/              mukoko-weather-aviation   METAR/TAF and nearest airports (service binding only)
  jobs/                  mukoko-weather-jobs       Cron Triggers: cache warming, retention, daily history
  ai/                    mukoko-weather-ai         Shamwari Weather: summaries, chat, follow-ups, history analysis
  tiles/                 mukoko-weather-tiles      weather map overlay tiles (Tomorrow.io proxy, edge + KV cache)
  d1/migrations/         schema of the D1 database `mukoko-weather`
  scripts/               gen-seed-locations.mjs (seed places and airports, from src/lib/locations.ts
                         and src/lib/icao-codes.ts)
```

| Worker                    | Job                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Reached at                                                                                                                           | Bindings                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mukoko-weather-forecast` | Gets forecasts: KV cache (15 min), then Tomorrow.io, then Open-Meteo, each behind a circuit breaker. A validated StationKit observation (50 km, 60 min) overlays `current`. Answers `503` when every provider fails, and never invents data. Also `GET /air-quality`: the EPA AQI from Open-Meteo Air Quality (KV 1 h, same breaker)                                                                                                                                                                                                                                                                                           | Service binding only (no route, no workers.dev)                                                                                      | KV `FORECAST_CACHE`, D1 `WEATHER_DB`, secrets `TOMORROW_API_KEY`, `NYUCHI_API_KEY`, var `NYUCHI_API_URL`                                                           |
| `mukoko-weather-internal` | Checks the service key and the query, then asks `forecast`. Also the Python backend's only way to a model: `POST /internal/ai/chat/completions`, forwarded to `ai`                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `https://weather-internal.mukoko.com`                                                                                                | services `FORECAST` and `AI_SERVICE`, secret `WEATHER_SERVICE_API_KEY`                                                                                             |
| `mukoko-weather-api`      | The public API. `GET /v1/weather` returns the app's full `WeatherData`, the same shape as `/api/py/weather`; if no provider answers, it serves the seasonal estimate labelled `fallback`. `GET /v1/forecast` returns the daily contract. `/v1/air-quality`, `/v1/metar` and `/v1/airports/nearest` keep the shapes of `/api/py/airquality`, `/api/py/metar` and `/api/py/airports/nearest`. CORS allowlist, and a rate limit of 120 requests a minute per IP. mukoko-api binds to it                                                                                                                                           | `https://weather-api.mukoko.com`                                                                                                     | services `FORECAST` and `AVIATION`, rate limit `RATE_LIMITER`, vars `ENVIRONMENT`, `CORS_ORIGINS`                                                                  |
| `mukoko-weather-stations` | Station registration and ingest on the same paths and protocols as `/api/py/stations/*`. It checks the key (PBKDF2, matching the existing hashes) and runs QC, then queues the upload. The queue consumer writes validated observations to D1 and the raw uploads, with credentials removed, to R2                                                                                                                                                                                                                                                                                                                             | `https://weather-ingest.nyuchi.com`; at cutover, also `weather.mukoko.com/api/py/stations/*`                                         | D1 `WEATHER_DB`, Queue `OBSERVATIONS` (`weather-observations`), R2 `RAW_OBSERVATIONS`                                                                              |
| `mukoko-weather-aviation` | METARs of the last 12 h and the TAF from the Aviation Weather Center, with CheckWX as the fallback when `CHECKWX_API_KEY` is set (30 min KV cache, empty answers included). The nearest airports come from the app's ICAO catalogue, compiled in                                                                                                                                                                                                                                                                                                                                                                               | Service binding only (no route, no workers.dev)                                                                                      | KV `CACHE` (the forecast cache namespace, `avn:` keys), optional secret `CHECKWX_API_KEY`                                                                          |
| `mukoko-weather-jobs`     | Cron Triggers that only plan, and a queue consumer that does the work. Every 15 min it refreshes the forecast cache for the popular places (`WARM_PLACES`; places x 96 provider calls a day, 576 for the default six). At 21:30 UTC (23:30 in Harare) it records one `place_daily` row per seed place (up to 264 forecast calls, mostly provider calls). At 02:15 UTC it rolls yesterday's validated observations up into `station_daily`, moves D1 observations older than `RETENTION_DAYS` (90) to R2 `archive/observations/`, deletes raw uploads older than `RAW_RETENTION_DAYS` (365) and drops day-old rate-limit events | No route, no workers.dev                                                                                                             | service `FORECAST`, D1 `WEATHER_DB`, R2 `RAW_OBSERVATIONS`, Queue `JOBS` (`weather-jobs`), vars `WARM_PLACES`, `RETENTION_DAYS`, `RAW_RETENTION_DAYS`              |
| `mukoko-weather-ai`       | Shamwari Weather: the summary, the follow-up chat, Shamwari chat and the history analysis. Every call goes to an open-weights Workers AI model (`AI_MODEL`, `@cf/` only) through the `shamwari` AI Gateway, with the Nyuchi API's compiled guardrails first in the system prompt. With no guardrails block it answers `503` and never calls the model. Messages with email addresses, phone or card numbers are refused (`422`). Rate limit: 10 requests a minute per IP                                                                                                                                                       | Service binding only: `mukoko-weather-api` forwards `POST /v1/ai/*`; `mukoko-weather-internal` forwards `/internal/chat/completions` | AI `AI`, service `FORECAST`, KV `AI_CACHE`, D1 `WEATHER_DB` (`place_daily`), rate limit `RATE_LIMITER`, secret `NYUCHI_API_KEY`, vars `NYUCHI_API_URL`, `AI_MODEL` |
| `mukoko-weather-tiles`    | Weather map overlay tiles, ported from `/api/py/map-tiles` on the same path and query. It checks the layer, zoom, tile and timestamp, then serves from the Cache API, then KV (fresh 90 min, kept a day as a stale fallback), then Tomorrow.io behind a circuit breaker. When Tomorrow.io fails or rate limits it serves a stale tile, or else a transparent 1x1 PNG. Its own host because one map view loads dozens of tiles; 600 requests a minute per IP                                                                                                                                                                    | `https://weather-tiles.mukoko.com`                                                                                                   | KV `TILE_CACHE` (the forecast cache namespace, keys `tile:v1:`), secret `TOMORROW_API_KEY`, rate limit `RATE_LIMITER`, vars `ENVIRONMENT`, `CORS_ORIGINS`          |

**`mukoko-weather-places`** (service binding only, from `mukoko-weather-api` as `PLACES`) serves `/v1/locations`, `/v1/search`, `/v1/geo` and `/v1/history` with the parameters and shapes of `/api/py/locations|search|geo|history`. It reads no database for places: the seed locations (with their tags) are compiled in; a `{name}--{geohash}` slug carries its own point (the app's smart slugs, which `mukoko-weather-forecast` now resolves too); canonical places come from the Nyuchi API (`/v1/places`, `/v1/places/nearby`, `/v1/places/{slug}`); geocoding comes from Open-Meteo (forward) and Nominatim (reverse, rate limited per client), all cached in KV. `geo?autoCreate=true` names the point and answers its `{name}--{geohash}` slug, but writes no canonical place. History is read from D1 `place_daily`, which `mukoko-weather-jobs` writes. Bindings: KV `CACHE` (the forecast namespace), D1 `WEATHER_DB` (read), rate limit `GEOCODE_LIMITER`, secret `NYUCHI_API_KEY`, var `NYUCHI_API_URL`.

**Developer keys.** `mukoko-weather-api` stays open to anonymous callers (120 a minute per IP). A developer may send a Nyuchi API key (`X-API-Key: nyk_….nys_…`, or `X-Client-Id` and `X-Client-Secret`) scoped for `weather`. The Worker keeps no key store: it forwards the key to the Nyuchi API's `GET /v1/weather/key`, which validates it, enforces the monthly quota and counts the call, and keeps a good answer in memory for 60 seconds (under a SHA-256 of the key), so usage is counted per check, not per request. A keyed caller is limited per key (`KEY_RATE_LIMITER`, 600 a minute). A bad key is `401`, a key without `weather` is `403`, and if the Nyuchi API cannot answer the call is refused with `503` (fail closed). Keys are created in the Nyuchi API (`POST /v1/api-keys`).

## Shamwari Weather (the AI Worker)

```text
POST /v1/ai, /v1/ai/summary   {weatherData, location: {name, lat, lon, elevation, country}, activities}
                              → {insight, cached, generatedAt}
POST /v1/ai/followup          {message, locationName, locationSlug, weatherSummary, activities, season, history}
                              → {response}
POST /v1/ai/chat              {message, history, activities} → {response, references: [{slug, name, type}]}
POST /v1/ai/history/analyze   {location, days: 7..365, activities} → {analysis, stats, cached, dataPoints}
```

- **Guardrails.** `GET {NYUCHI_API_URL}/v1/ai/guardrails/compiled?applies_to=weather` with `X-API-Key`. The block is used for 60 seconds, then revalidated with `If-None-Match`. If the API can't be reached, the last block is used for up to 24 hours. With no usable block every route answers `503 guardrails_unavailable`.
- **Model calls.** `env.AI.run(model, input, {gateway: {id: "shamwari", collectLog: false, metadata}})`. The metadata names the route only, never user content. A Guardrails or DLP block (2016, 2017, 2029, 2030) is answered with a polite refusal; a gateway rate limit with `429`.
- **The summary** fetches the weather itself from `forecast`; the `weatherData` a client sends is ignored. It is cached for 30 minutes per place and activities, and redone early when the temperature moves more than 5 °C or the weather code changes. If the model fails, the plain-conditions text is served and cached for a minute.
- **The chat** has no tools. The seed places named in the message (or, failing that, earlier in the conversation) are looked up first, up to three, and their forecasts go into the prompt. `references` lists them.
- **History** reads `place_daily` in D1, written by the jobs Worker. No table or no rows gives `404 no_history`. Analyses are cached for an hour, keyed on the data.

- **The backend passthrough.** `POST /internal/chat/completions` takes an OpenAI chat-completions body (`messages`, `tools`, `max_tokens`, optional `model`) from the Python backend, through `mukoko-weather-internal` (which checks `WEATHER_SERVICE_API_KEY`; `mukoko-weather-api` never forwards this path). It rebuilds the messages from known keys, puts the guardrails first in the one system message, refuses user turns with personal data (`422`), runs `env.AI.run` through the gateway with any `tools`, and answers an OpenAI chat completion with `content` only (never `reasoning_content`) and OpenAI-shaped `tool_calls`, so the Python tool loops are unchanged. No per-IP limit here (every backend call shares one key); the backend limits per visitor. Logic: `weather-core/src/ai/completions.rs`.
- **The model and its budget.** `AI_MODEL` is `@cf/zai-org/glm-5.3-flash` (Z.ai GLM-5.3 Flash: function calling and reasoning). Only `@cf/` ids are accepted (`allowed_model`); the default is `weather_core::ai::DEFAULT_MODEL`. For reasoning models every call adds `REASONING_HEADROOM` (1024) to `max_tokens` and sends `reasoning_effort: "low"`; GLM cannot switch reasoning off, and an answer whose budget went on reasoning comes back empty (`502 model_failed`).

Not ported from the Python backend: the chat's tool loop (search beyond the seed places, places by tag, the Mongo suitability rules), `/ai/prompts`, `/ai/suggested-rules`, per-country seasons (the hemisphere rule is used) and per-tag summary cache times. The prompts are compiled in (`weather-core/src/ai/prompts.rs`).

## The internal forecast contract

This is the upstream for the Nyuchi API's `GET /v1/weather/forecast` (nyuchi/api-gateway#154). The Nyuchi API needs two settings:

- `WEATHER_SERVICE_URL=https://weather-internal.mukoko.com`;
- `WEATHER_SERVICE_API_KEY`, set to the same value as this Worker's secret.

```text
GET /internal/forecast?location=<slug|name>        (or lat=&lon=)   [&days=1..7, default 7]
Authorization: Bearer <WEATHER_SERVICE_API_KEY>

200 {"location": {"slug", "name", "lat", "lon"},
     "data": [{"date": "YYYY-MM-DD", "description", "weather_code", "high", "low",
               "precipitation_probability"}],
     "source": "tomorrow" | "open-meteo",
     "fetched_at": "RFC 3339",
     "attribution": "provider credit line"}
401 missing or wrong key       404 unknown location     422 bad query
503 no key configured here, or no provider answered (fails closed)
```

**How a place is resolved.** Locations resolve in this order:

1. the app's seed locations (compiled in), matched by slug, by name, or by the name's slug;
2. the Nyuchi API (`GET /v1/places/{slug}`, cached), because canonical place records belong to the API;
3. otherwise `404`.

**Requests by point.** A `lat`/`lon` request borrows the slug and name of a seed location within 10 km. Otherwise the slug is the rounded point and the name is `null`.

## The internal AI contract

The app's Python backend on Vercel holds `WEATHER_SERVICE_URL` and `WEATHER_SERVICE_API_KEY` and no Cloudflare AI token.

```text
POST /internal/ai/chat/completions
Authorization: Bearer <WEATHER_SERVICE_API_KEY>
{"messages": [{"role": "system"|"user"|"assistant"|"tool", ...}], "tools": [...], "max_tokens": 600, "model"?: "@cf/..."}

200 {"object": "chat.completion", "model", "choices": [{"index": 0,
     "message": {"role": "assistant", "content", "tool_calls"?}, "finish_reason"}]}
400 bad request    401 missing or wrong key    413 body over 512 KiB
422 personal_data_detected | content_blocked (gateway guardrails)    429 model busy
502 model_failed | upstream_*    503 not_configured | guardrails_unavailable
```

## Develop

```bash
cd workers
cargo test -p weather-core                                   # all the logic, native
cargo clippy --workspace --target wasm32-unknown-unknown -- -D warnings
cargo install worker-build@^0.8                              # once
cd forecast && worker-build --release                        # or internal-api
# Run both Workers locally, bound to each other:
cd ../internal-api && npx wrangler dev -c wrangler.jsonc -c ../forecast/wrangler.jsonc
```

For local secrets, put them in `.dev.vars` next to each `wrangler.jsonc`. That file is ignored by git.

After changing `src/lib/locations.ts` or `src/lib/icao-codes.ts`, regenerate the seed places and airports from the repo root:

```bash
node --experimental-strip-types workers/scripts/gen-seed-locations.mjs
```

CI (`.github/workflows/workers.yml`) fails if either file is stale.

## Owner steps

Creating Cloudflare resources and deploying are owner actions. Run these from `workers/`, signed in to the **Nyuchi Web Services** account.

1. Create the stores, then put their ids where the configs say `OWNER`:

   ```bash
   npx wrangler kv namespace create mukoko-weather-forecast-cache    # → forecast/wrangler.jsonc FORECAST_CACHE id
                                                                     #   and aviation/wrangler.jsonc CACHE id (same namespace)
                                                                     #   and tiles/wrangler.jsonc TILE_CACHE id
   npx wrangler kv namespace create mukoko-weather-ai-cache          # → ai/wrangler.jsonc AI_CACHE id
   npx wrangler d1 create mukoko-weather                             # → forecast/wrangler.jsonc WEATHER_DB database_id
   npx wrangler d1 migrations apply mukoko-weather --remote -c forecast/wrangler.jsonc
                                                                     # same database_id in stations/, jobs/, places/ and ai/wrangler.jsonc
                                                                     # same KV id in places/wrangler.jsonc CACHE
   npx wrangler r2 bucket create mukoko-weather-raw
   npx wrangler queues create weather-observations
   npx wrangler queues create weather-observations-dlq
   npx wrangler queues create weather-jobs
   npx wrangler queues create weather-jobs-dlq
   ```

2. Put the secrets in the account's Cloudflare Secrets Store (`56f84bfa8a564c54a95dbf4f4b4281b4`). Each key is one store secret, bound by every Worker that needs it (`secrets_store_secrets` in each `wrangler.jsonc`); there are no per-Worker copies. The values are in 1Password. Each command prompts for the value, so nothing lands in shell history:

   ```bash
   npx wrangler secrets-store secret create 56f84bfa8a564c54a95dbf4f4b4281b4 --name MUKOKO_WEATHER_TOMORROW_API_KEY --scopes workers --remote
   npx wrangler secrets-store secret create 56f84bfa8a564c54a95dbf4f4b4281b4 --name MUKOKO_WEATHER_NYUCHI_API_KEY --scopes workers --remote
   npx wrangler secrets-store secret create 56f84bfa8a564c54a95dbf4f4b4281b4 --name MUKOKO_WEATHER_SERVICE_API_KEY --scopes workers --remote
   npx wrangler secrets-store secret create 56f84bfa8a564c54a95dbf4f4b4281b4 --name MUKOKO_WEATHER_CHECKWX_API_KEY --scopes workers --remote  # optional
   ```

   | Store secret                      | Bound by (`workers/<dir>`) | Required | Value                                                                                         |
   | --------------------------------- | -------------------------- | -------- | --------------------------------------------------------------------------------------------- |
   | `MUKOKO_WEATHER_TOMORROW_API_KEY` | `forecast`, `tiles`        | Required | Tomorrow.io key (today in Mongo `weather.api_keys` "tomorrow")                                |
   | `MUKOKO_WEATHER_NYUCHI_API_KEY`   | `forecast`, `places`, `ai` | Required | This app's internal Nyuchi API key: places read, plus the `ai` scope for the guardrails read  |
   | `MUKOKO_WEATHER_SERVICE_API_KEY`  | `internal-api`             | Required | The bearer key nyuchi-api presents as `WEATHER_SERVICE_API_KEY` (e.g. `openssl rand -hex 32`) |
   | `MUKOKO_WEATHER_CHECKWX_API_KEY`  | `aviation`                 | Optional | CheckWX key, the METAR fallback (today in Mongo `weather.api_keys` "checkwx")                 |

   The code asks for each secret by its plain name (`TOMORROW_API_KEY`, ...) through `weather_edge::secret`, which reads the store binding and keeps the value for the isolate (`crates/weather-core/src/secrets.rs`). Transition: until every value is confirmed in the store, it falls back to a plain `wrangler secret put` secret of the plain name, logging a warning once per isolate (name and reason, never the value). Once confirmed, remove the fallback and delete the plain secrets (`npx wrangler secret delete <NAME>` in each Worker). Deploying a Worker that binds a store secret needs a token with Account → Secrets Store → Edit.

   The AI Worker also needs the `shamwari` AI Gateway on the Nyuchi Web Services account, with Guardrails on and logging off.

3. Deploy. `forecast` goes first, because `internal-api` and `ai` bind to it, and `ai` goes before `internal-api` and `public-api`, which bind to it:

   ```bash
   (cd forecast && npx wrangler deploy)
   (cd aviation && npx wrangler deploy)       # before public-api, which binds to it
   (cd ai && npx wrangler deploy)              # service binding only, no route
   (cd internal-api && npx wrangler deploy)    # after ai (binds AI_SERVICE); also attaches weather-internal.mukoko.com
   (cd public-api && npx wrangler deploy)      # also attaches weather-api.mukoko.com
   (cd stations && npx wrangler deploy)        # also attaches weather-ingest.nyuchi.com
   (cd jobs && npx wrangler deploy)            # after forecast; no route, Cron Triggers only
   (cd places && npx wrangler deploy)          # before public-api's next deploy, which binds to it
   (cd tiles && npx wrangler deploy)           # also attaches weather-tiles.mukoko.com
   ```

   Or use Workers Builds (Git integration), with one project per Worker. In each:
   - set the root directory to `workers/forecast`, `workers/aviation`, `workers/internal-api`, `workers/places`, `workers/ai`, `workers/public-api`, `workers/stations`, `workers/jobs` or `workers/tiles`;
   - set the build command to `cargo install worker-build@^0.8 && worker-build --release`;
   - set the deploy command to `npx wrangler deploy`.

4. **Station cutover**, done once and in this order:
   1. Copy the existing stations with their key hashes: `mongoexport --uri "$MONGODB_URI" --db weather --collection stations --jsonArray --out stations.json`.
   2. Turn the export into SQL: `node workers/scripts/stations-to-d1.mjs stations.json > stations.sql`.
   3. Load it: `(cd workers/stations && npx wrangler d1 execute mukoko-weather --remote --file ../../stations.sql)`.
   4. Delete both files.
   5. Add the route `weather.mukoko.com/api/py/stations/*` to `stations/wrangler.jsonc` and deploy, so consoles already in the field land on the Worker.
   6. Point the station console's `NEXT_PUBLIC_WEATHER_API_BASE` at `https://weather-ingest.nyuchi.com`.
5. On nyuchi-api (Fly), set `WEATHER_SERVICE_URL=https://weather-internal.mukoko.com` and `WEATHER_SERVICE_API_KEY`, using the same value as in step 2. On the app's Vercel project, set the same two (the Python backend's AI goes through `/internal/ai/chat/completions`) and remove `CF_AI_API_TOKEN`, `AI_GATEWAY_TOKEN`, `CF_WORKERS_AI_TOKEN`, `AI_GATEWAY_URL`, `AI_GATEWAY_ID`, `CLOUDFLARE_ACCOUNT_ID` and `AI_MODEL`, which nothing reads any more.
6. Check the result:

   ```bash
   curl -s https://weather-internal.mukoko.com/health
   curl -s -H "Authorization: Bearer $WEATHER_SERVICE_API_KEY" \
     "https://weather-internal.mukoko.com/internal/forecast?location=harare&days=3"
   ```

## Rules

- **Cloudflare only.** Work that does not fit a Worker goes to Queues, Cron Triggers, Durable Objects, Workflows or Containers, never another host.
- **No database outside the API.** The Workers keep weather data in their own D1, KV and R2. Canonical records (persons, places) go through the Nyuchi API. Nothing here connects to MongoDB (#150).
- **Keep each Worker small.** Budget its CPU, memory, bundle size and subrequests. Split a Worker, or fan out over a Queue, rather than grow one.
- **Observability.** Traces and invocation logs are on, with query strings redacted. The code never logs payloads, coordinates or keys.
