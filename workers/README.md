# Mukoko Weather backend (Rust Workers)

The weather backend, moving out of the Next.js app into Cloudflare Workers written in Rust ([workers-rs](https://github.com/cloudflare/workers-rs)). The plan, the inventory and the migration order are in [#148](https://github.com/mukoko-dev/mukoko-weather/issues/148).

There is **one backend for everything weather**: the Mukoko Weather app, the public weather API, the weather stations, and other apps (through the Nyuchi API for internal callers, and mukoko-api for consumers). It is split into **several Workers, one job each**, connected by service bindings, with the shared logic in one Cargo workspace.

```text
workers/
  crates/weather-core/   pure Rust, tested natively: provider normalisation, the forecast
                         contract, places, station QC and ingest keys, circuit breaker
  crates/weather-edge/   Worker helpers: JSON errors, bearer auth, timeouts
  forecast/              mukoko-weather-forecast   provider aggregation (service binding only)
  internal-api/          mukoko-weather-internal   GET /internal/forecast for the Nyuchi API
  stations/              mukoko-weather-stations   station registration and ingest (Wunderground, Ecowitt, manual)
  places/                mukoko-weather-places     locations, search, nearest place, history (service binding only)
  public-api/            mukoko-weather-api        /v1/weather, /v1/forecast, /v1/air-quality, /v1/metar, /v1/airports/nearest,
                                                   /v1/locations, /v1/search, /v1/geo, /v1/history
  aviation/              mukoko-weather-aviation   METAR/TAF and nearest airports (service binding only)
  jobs/                  mukoko-weather-jobs       Cron Triggers: cache warming, retention, daily history
  d1/migrations/         schema of the D1 database `mukoko-weather`
  scripts/               gen-seed-locations.mjs (seed places and airports, from src/lib/locations.ts
                         and src/lib/icao-codes.ts)
```

| Worker                    | Job                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Reached at                                                                                   | Bindings                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mukoko-weather-forecast` | Gets forecasts: KV cache (15 min), then Tomorrow.io, then Open-Meteo, each behind a circuit breaker. A validated StationKit observation (50 km, 60 min) overlays `current`. Answers `503` when every provider fails, and never invents data. Also `GET /air-quality`: the EPA AQI from Open-Meteo Air Quality (KV 1 h, same breaker)                                                                                                                                                                                                                                                                                           | Service binding only (no route, no workers.dev)                                              | KV `FORECAST_CACHE`, D1 `WEATHER_DB`, secrets `TOMORROW_API_KEY`, `NYUCHI_API_KEY`, var `NYUCHI_API_URL`                                              |
| `mukoko-weather-internal` | Checks the service key and the query, then asks `forecast`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `https://weather-internal.mukoko.com`                                                        | service `FORECAST`, secret `WEATHER_SERVICE_API_KEY`                                                                                                  |
| `mukoko-weather-api`      | The public API. `GET /v1/weather` returns the app's full `WeatherData`, the same shape as `/api/py/weather`; if no provider answers, it serves the seasonal estimate labelled `fallback`. `GET /v1/forecast` returns the daily contract. `/v1/air-quality`, `/v1/metar` and `/v1/airports/nearest` keep the shapes of `/api/py/airquality`, `/api/py/metar` and `/api/py/airports/nearest`. CORS allowlist, and a rate limit of 120 requests a minute per IP. mukoko-api binds to it                                                                                                                                           | `https://weather-api.mukoko.com`                                                             | services `FORECAST` and `AVIATION`, rate limit `RATE_LIMITER`, vars `ENVIRONMENT`, `CORS_ORIGINS`                                                     |
| `mukoko-weather-stations` | Station registration and ingest on the same paths and protocols as `/api/py/stations/*`. It checks the key (PBKDF2, matching the existing hashes) and runs QC, then queues the upload. The queue consumer writes validated observations to D1 and the raw uploads, with credentials removed, to R2                                                                                                                                                                                                                                                                                                                             | `https://weather-ingest.nyuchi.com`; at cutover, also `weather.mukoko.com/api/py/stations/*` | D1 `WEATHER_DB`, Queue `OBSERVATIONS` (`weather-observations`), R2 `RAW_OBSERVATIONS`                                                                 |
| `mukoko-weather-aviation` | METARs of the last 12 h and the TAF from the Aviation Weather Center, with CheckWX as the fallback when `CHECKWX_API_KEY` is set (30 min KV cache, empty answers included). The nearest airports come from the app's ICAO catalogue, compiled in                                                                                                                                                                                                                                                                                                                                                                               | Service binding only (no route, no workers.dev)                                              | KV `CACHE` (the forecast cache namespace, `avn:` keys), optional secret `CHECKWX_API_KEY`                                                             |
| `mukoko-weather-jobs`     | Cron Triggers that only plan, and a queue consumer that does the work. Every 15 min it refreshes the forecast cache for the popular places (`WARM_PLACES`; places x 96 provider calls a day, 576 for the default six). At 21:30 UTC (23:30 in Harare) it records one `place_daily` row per seed place (up to 264 forecast calls, mostly provider calls). At 02:15 UTC it rolls yesterday's validated observations up into `station_daily`, moves D1 observations older than `RETENTION_DAYS` (90) to R2 `archive/observations/`, deletes raw uploads older than `RAW_RETENTION_DAYS` (365) and drops day-old rate-limit events | No route, no workers.dev                                                                     | service `FORECAST`, D1 `WEATHER_DB`, R2 `RAW_OBSERVATIONS`, Queue `JOBS` (`weather-jobs`), vars `WARM_PLACES`, `RETENTION_DAYS`, `RAW_RETENTION_DAYS` |

**`mukoko-weather-places`** (service binding only, from `mukoko-weather-api` as `PLACES`) serves `/v1/locations`, `/v1/search`, `/v1/geo` and `/v1/history` with the parameters and shapes of `/api/py/locations|search|geo|history`. It reads no database for places: the seed locations (with their tags) are compiled in; a `{name}--{geohash}` slug carries its own point (the app's smart slugs, which `mukoko-weather-forecast` now resolves too); canonical places come from the Nyuchi API (`/v1/places`, `/v1/places/nearby`, `/v1/places/{slug}`); geocoding comes from Open-Meteo (forward) and Nominatim (reverse, rate limited per client), all cached in KV. `geo?autoCreate=true` names the point and answers its `{name}--{geohash}` slug, but writes no canonical place. History is read from D1 `place_daily`, which `mukoko-weather-jobs` writes. Bindings: KV `CACHE` (the forecast namespace), D1 `WEATHER_DB` (read), rate limit `GEOCODE_LIMITER`, secret `NYUCHI_API_KEY`, var `NYUCHI_API_URL`.

**Developer keys.** `mukoko-weather-api` stays open to anonymous callers (120 a minute per IP). A developer may send a Nyuchi API key (`X-API-Key: nyk_….nys_…`, or `X-Client-Id` and `X-Client-Secret`) scoped for `weather`. The Worker keeps no key store: it forwards the key to the Nyuchi API's `GET /v1/weather/key`, which validates it, enforces the monthly quota and counts the call, and keeps a good answer in memory for 60 seconds (under a SHA-256 of the key), so usage is counted per check, not per request. A keyed caller is limited per key (`KEY_RATE_LIMITER`, 600 a minute). A bad key is `401`, a key without `weather` is `403`, and if the Nyuchi API cannot answer the call is refused with `503` (fail closed). Keys are created in the Nyuchi API (`POST /v1/api-keys`).

The AI Worker follows in its own PR (see #148).

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
   npx wrangler d1 create mukoko-weather                             # → forecast/wrangler.jsonc WEATHER_DB database_id
   npx wrangler d1 migrations apply mukoko-weather --remote -c forecast/wrangler.jsonc
                                                                     # same database_id in stations/, jobs/ and places/wrangler.jsonc
                                                                     # same KV id in places/wrangler.jsonc CACHE
   npx wrangler r2 bucket create mukoko-weather-raw
   npx wrangler queues create weather-observations
   npx wrangler queues create weather-observations-dlq
   npx wrangler queues create weather-jobs
   npx wrangler queues create weather-jobs-dlq
   ```

2. Set the secrets. These are names only; the values are in 1Password:

   ```bash
   (cd forecast && npx wrangler secret put TOMORROW_API_KEY)       # today in Mongo weather.api_keys "tomorrow"
   (cd forecast && npx wrangler secret put NYUCHI_API_KEY)         # internal key, places read
   (cd places && npx wrangler secret put NYUCHI_API_KEY)           # the same key
   (cd internal-api && npx wrangler secret put WEATHER_SERVICE_API_KEY)  # new random value, e.g. openssl rand -hex 32
   (cd aviation && npx wrangler secret put CHECKWX_API_KEY)        # optional; today in Mongo weather.api_keys "checkwx"
   ```

3. Deploy. `forecast` goes first, because `internal-api` binds to it:

   ```bash
   (cd forecast && npx wrangler deploy)
   (cd aviation && npx wrangler deploy)       # before public-api, which binds to it
   (cd internal-api && npx wrangler deploy)    # also attaches weather-internal.mukoko.com
   (cd public-api && npx wrangler deploy)      # also attaches weather-api.mukoko.com
   (cd stations && npx wrangler deploy)        # also attaches weather-ingest.nyuchi.com
   (cd jobs && npx wrangler deploy)            # after forecast; no route, Cron Triggers only
   (cd places && npx wrangler deploy)          # before public-api's next deploy, which binds to it
   ```

   Or use Workers Builds (Git integration), with one project per Worker. In each:
   - set the root directory to `workers/forecast`, `workers/aviation`, `workers/internal-api`, `workers/places`, `workers/public-api`, `workers/stations` or `workers/jobs`;
   - set the build command to `cargo install worker-build@^0.8 && worker-build --release`;
   - set the deploy command to `npx wrangler deploy`.

4. **Station cutover**, done once and in this order:
   1. Copy the existing stations with their key hashes: `mongoexport --uri "$MONGODB_URI" --db weather --collection stations --jsonArray --out stations.json`.
   2. Turn the export into SQL: `node workers/scripts/stations-to-d1.mjs stations.json > stations.sql`.
   3. Load it: `(cd workers/stations && npx wrangler d1 execute mukoko-weather --remote --file ../../stations.sql)`.
   4. Delete both files.
   5. Add the route `weather.mukoko.com/api/py/stations/*` to `stations/wrangler.jsonc` and deploy, so consoles already in the field land on the Worker.
   6. Point the station console's `NEXT_PUBLIC_WEATHER_API_BASE` at `https://weather-ingest.nyuchi.com`.
5. On nyuchi-api (Fly), set `WEATHER_SERVICE_URL=https://weather-internal.mukoko.com` and `WEATHER_SERVICE_API_KEY`, using the same value as in step 2.
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
