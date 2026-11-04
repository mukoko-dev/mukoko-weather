# Mukoko Weather

> Weather intelligence for the developing world — real-time forecasts and locally-relevant insights for farming, mining, travel, and daily life. Built in Zimbabwe, scaling globally.

[![CI](https://github.com/nyuchi/mukoko-weather/actions/workflows/ci.yml/badge.svg)](https://github.com/nyuchi/mukoko-weather/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
![Next.js](https://img.shields.io/badge/Next.js-16-000000?style=flat-square&logo=nextdotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-Cloudflare_Workers-000000?style=flat-square&logo=rust&logoColor=white)

**Live:** [weather.mukoko.com](https://weather.mukoko.com) | **Deploy:** Vercel | **Docs:** [docs.nyuchi.com](https://docs.nyuchi.com)

---

## What it is

Mukoko Weather is a consumer weather app that answers the question most weather
apps skip: _given this weather, can I do the thing I need to do today?_ Forecast
numbers are the input, not the output. Every location page turns current
conditions and the next 24 hours into a suitability rating for sixty-odd
concrete activities — planting, spraying, open-pit work, a long drive, a
football match — each with a feasibility trend and deterministic, weather-driven
advice (rain windows, spraying wind, frost, UV, heat, storm safety).

It was built for places the global providers model badly. Zimbabwe is the
reference market: 98 seed locations there, country-specific seasons under their
local names (Masika, Chirimo, Zhizha, Munakamwe), and a mining and smallholder
farming vocabulary. The same machinery now covers 265 seed locations across 64
countries, and grows by use — a search or a GPS fix in an unmapped place
reverse-geocodes through Nominatim and becomes a location.

Two things keep it honest where connectivity and upstream APIs are not. The forecast
baseline is an Africa-weighted blend of global weather models (ECMWF IFS and
AIFS weighted highest, then NOAA GFS, DWD ICON, the UK Met Office, CMA, ECCC GEM,
Météo-France ARPEGE and JMA; every model that answers is used, and at least
four must) served keyless by Open-Meteo, resolved through a chain —
cache, the blend, Open-Meteo `best_match`, MET Norway when Open-Meteo is
refusing, then seasonal estimates that always succeed — so a page never renders
empty. Tomorrow.io only enriches the
activity insights, within a call budget, and never blocks the forecast.
And the UI is error-isolated per section: a chart that crashes takes down the
chart, not the page.

Beyond the forecast, the app carries an aviation planner (METAR/TAF with
VFR/MVFR/IFR/LIFR categories and PDF pre-flight briefings from NOAA data),
Waze-style community weather reports cross-validated against API data, an EPA
air-quality index with a full pollutant breakdown, a global location-aware haze panel (smoke, dust, smog, regional seasons, official Singapore PSI), a historical dashboard with
AI trend analysis, and an embeddable widget. It installs as a PWA.
The Locations list (`/locations`) shows the current location and saved places as
live weather cards, with a Home location, in the style of iOS Weather.
Public release notes live at `/releases` (with an Atom feed at
`/releases/feed.xml`), built from the curated files in `releases/`.

**Weather display** — `/display` is a full-screen page for a TV, tablet or
monitor on a wall: clock, current conditions, air quality with plain-language
haze advice, a radar map of the area, the next hours and five days. It keeps the
screen awake, refreshes itself (weather every 10 min, air quality every 30 min)
and needs no sign-in. Configure it by URL, for example
`/display?location=singapore-sg&theme=dark` or `/display?lat=-17.83&lon=31.05`;
`layer` picks the map overlay (default `precipitationIntensity`).

Some AI surfaces are behind flags. **Shamwari full-viewport chat is paused**
(`FLAGS.shamwari_chat` is `false`; `/shamwari` 404s); inline AI summaries,
follow-up chat, and AI explore search remain live.

## Repository layout

This repo holds three deployables, not one:

| Path                | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/`              | **The app.** Next.js 16 App Router front end on Vercel (pages and a few sign-in-bound routes; no data backend). This is what ships to `weather.mukoko.com`. The backend is `workers/`; there is no Python.                                                                                                                                                                                                                                                                                                                   |
| `workers/`          | **The backend.** Rust Cloudflare Workers (`weather-api.mukoko.com` and friends) plus one TypeScript Worker (the MongoDB bridge). The logic is the pure `weather-core` crate, tested natively against the frozen fixtures in `tests/fixtures/`. See `workers/README.md`.                                                                                                                                                                                                                                                      |
| `station-console/`  | **Mukoko Station Console** — a second, separate Next.js app (dev port 3001) for community weather-station operators to register stations and review ingest. Added in #120; not yet on its own public domain. It calls the Rust stations Worker (`workers/stations`).                                                                                                                                                                                                                                                         |
| `releases/`         | **Public release notes**, one Markdown file per production release (`v0.11.0.md`). Parsed at build time into `/releases` and `/releases/feed.xml`. Format and how to add one: CONTRIBUTING.md → Releases → Release notes.                                                                                                                                                                                                                                                                                                    |
| `scripts/`          | Build helpers. `copy-maplibre-worker.mjs` runs before every `build`/`dev` (npm `prebuild`/`predev`) and copies MapLibre v6's web worker into `public/vendor/maplibre-gl/<version>/`; without it every map renders blank. `build_geoglam_calendars.py` (the one Python file left: standalone, standard library only, not run by CI) rebuilds the GEOGLAM crop-calendar table that `weather-core` compiles in `browser-check/` holds the real-browser (Playwright) checks of the PWA shell and service worker; see its README. |
| `infra/open-meteo/` | **Not deployed yet.** Railway service definitions for a self-hosted Open-Meteo (EU West, Amsterdam): the unmodified upstream image with a sync loop limited to our models and variables, plus a Caddy gateway that checks a header key. Runbook, sizing and cost in its `README.md`.                                                                                                                                                                                                                                         |

## Stack

| Layer             | Technology                                                                                                                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework         | [Next.js 16](https://nextjs.org) (App Router), TypeScript 5, React 19                                                                                                                                                                                                                                                                  |
| Backend API       | [Rust Cloudflare Workers](https://developers.cloudflare.com/workers/) (`workers/`, workers-rs) — the pure logic is the `weather-core` crate. Vercel serves the Next.js app and a few sign-in-bound routes, not the data backend; there is no Python backend (removed in #333)                                                          |
| Authentication    | [WorkOS AuthKit](https://workos.com/docs/authkit) — hosted sign-in, signed-cookie sessions, users mirrored into `identity.persons`                                                                                                                                                                                                     |
| Database          | [MongoDB Atlas](https://mongodb.com/atlas) — cache, AI summaries, history, locations, airports; Atlas Search for fuzzy queries                                                                                                                                                                                                         |
| Devices & reports | Device profiles and community weather reports live in MongoDB (`device.device_profiles`, `weather.weather_reports`), written and read by the TypeScript `mukoko-weather-mongo-bridge` Cloudflare Worker (official `mongodb` driver in a Durable Object, reached only through a service binding from the Rust `places` Worker). Not D1. |
| AI                | The [Workers AI](https://developers.cloudflare.com/workers-ai/) model set in the `shamwari` [AI Gateway](https://developers.cloudflare.com/ai-gateway/) (AI Worker only)                                                                                                                                                               |
| Weather data      | Nine global models (ECMWF IFS and AIFS, NOAA GFS, DWD ICON, ECCC GEM, Météo-France ARPEGE, UK Met Office, CMA, JMA) via [Open-Meteo](https://open-meteo.com) as the baseline, [Tomorrow.io](https://tomorrow.io) for budgeted insights enrichment, [NOAA AWC](https://aviationweather.gov) for METAR/TAF                               |
| UI                | [shadcn/ui](https://ui.shadcn.com) (Radix + CVA), [Tailwind CSS 4](https://tailwindcss.com)                                                                                                                                                                                                                                            |
| Charts & maps     | [Chart.js 4](https://www.chartjs.org), [MapLibre GL](https://maplibre.org) + [MapTiler](https://www.maptiler.com), [Three.js](https://threejs.org)                                                                                                                                                                                     |
| State             | [Zustand 5](https://zustand.docs.pmnd.rs) with `persist`                                                                                                                                                                                                                                                                               |
| Testing           | [Vitest](https://vitest.dev) (TS, v8 coverage) + `cargo test` (the Workers)                                                                                                                                                                                                                                                            |
| Deployment        | [Vercel](https://vercel.com)                                                                                                                                                                                                                                                                                                           |

## Getting started

```bash
git clone https://github.com/nyuchi/mukoko-weather.git
cd mukoko-weather
npm install
npm run dev            # http://localhost:3000
```

Node.js 18+ and npm 9+. To work on the backend (`workers/`) you also need a stable Rust toolchain with the `wasm32-unknown-unknown` target (see `workers/README.md`).

The home page (`/`) **is** the current-location weather page — Apple Weather's
MY LOCATION model with the URL kept silent. The server seeds it from a
`lastLocation` cookie or Vercel IP geo; client GPS then swaps the content in
place, without a redirect. Explicit `/{slug}` URLs remain for saved and browsed
locations.

### Environment variables

| Variable                          | Required | Description                                                                                                                                                                                                                                                              |
| --------------------------------- | :------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MONGODB_URI`                     |   Yes    | MongoDB Atlas connection string                                                                                                                                                                                                                                          |
| `WORKOS_API_KEY`                  |   Yes    | Server-side WorkOS API key (`sk_…`) — AuthKit middleware, callback exchange, `identity.persons` upsert                                                                                                                                                                   |
| `WORKOS_CLIENT_ID`                |   Yes    | WorkOS Client ID (`client_…`) of the Mukoko Account app, the one client every Mukoko app signs in through; also the only issuer the `/api/app-keys` exchange accepts (503 when unset)                                                                                    |
| `WORKOS_COOKIE_PASSWORD`          |   Yes    | 32+ character session-cookie secret. Rotating it invalidates every session                                                                                                                                                                                               |
| `NEXT_PUBLIC_WORKOS_REDIRECT_URI` |   Yes    | OAuth callback URL; must match the WorkOS dashboard (`https://weather.mukoko.com/callback` in production)                                                                                                                                                                |
| `WEATHER_SERVICE_URL`             |    No    | Internal weather Worker origin (`https://weather-internal.mukoko.com`). The signed-in `/api/ai` proxy calls its `/internal/ai/*` paths. Without the AI vars `/api/ai` answers 503 and the summary card says it is unavailable                                            |
| `WEATHER_SERVICE_API_KEY`         |    No    | Server-only. The service key `mukoko-weather-internal` checks (sent by the `/api/ai` proxy; never to the browser). Vercel holds no Cloudflare AI token; the model is set by the AI Worker                                                                                |
| `NYUCHI_API_URL`                  |    No    | Server-only. Nyuchi API gateway origin (`https://api.nyuchi.com`) for `/api/app-keys` and `/api/couch/session` (the latter hands it to the browser as the only host the CouchDB sync replicates with). Unset = those routes answer `503`                                 |
| `NYUCHI_APP_KEYS_API_KEY`         |    No    | Server-only secret. This app's internal gateway key `nyk_….nys_…`, scoped `identity app-keys weather` only. Exchanges each user's own WorkOS token for a person token (`/api/app-keys`) and for the CouchDB sync grant (`/api/couch/session`); never `NEXT_PUBLIC_*`     |
| `DB_INIT_SECRET`                  |    No    | Protects `/api/db-init` in production (`x-init-secret` header)                                                                                                                                                                                                           |
| `NEXT_PUBLIC_WEATHER_API_URL`     |    No    | Origin of the Rust weather Worker. Unset = the production default `https://weather-api.mukoko.com`, and the app holds no fallback for any route (there is no Python backend). `https` only (plain `http` for localhost)                                                  |
| `OPEN_METEO_BASE_URL`             |    No    | Server-only. Origin of a self-hosted Open-Meteo (`infra/open-meteo/`, not deployed); `/v1/forecast` is appended. Unset = the public API. `https` only (plain `http` for localhost). Only the server-side direct-fetch fallback reads it; the Workers call the public API |
| `OPEN_METEO_AQ_BASE_URL`          |    No    | Server-only. Origin of the self-hosted air-quality (CAMS) API; `/v1/air-quality` is appended. Unset = the public API. Nothing reads it today (the Workers call the public host)                                                                                          |
| `OPEN_METEO_API_KEY`              |    No    | Server-only secret. Gateway key, sent in the `X-Mukoko-OM-Key` header to the self-hosted hosts above only, never to an `open-meteo.com` host and never in a URL                                                                                                          |

## Architecture

All data, AI, and CRUD work runs in the **Rust Cloudflare Workers** in
`workers/` (`weather-api.mukoko.com` and the other `*.mukoko.com` hosts); the
Python FastAPI backend that used to sit under `api/py/` was deleted in #333.
Vercel serves the Next.js app, not the data backend. A few routes remain in TypeScript on Vercel:
OG image generation, DB init, the public embed API, the auth-gated `/api/ai`
proxy, developer API-key and device management, and the session credential of
the (flagged) CouchDB sync, `POST /api/couch/session`. A request to `/api/py/...`
is a 404 problem document (`src/app/api/retired`), except the weather-station
upload URL `/api/py/stations/ingest` that consoles in the field are configured
with: `vercel.json` rewrites that one path to the stations Worker, and the
stations Worker also takes `weather.mukoko.com/api/py/stations/*` as a route
once it is deployed with it.

**CouchDB sync (flagged, off by default).** `FLAGS.couch_sync` (#396) replicates
a person's theme, forecast model and selected activities with their own CouchDB
database `user_<personId>` through the Nyuchi API, offline first (RxDB on the
device). Only these plaintext settings sync; saved places, the home place and
history are encrypted on the device and wait for a key-custody decision. With
the flag off nothing is imported and no request is made. The credential is the
Nyuchi API's `couch:user` sync grant: the site's server trades the person's own
WorkOS access token for it (`POST /api/couch/session`, the same exchange
`/api/app-keys` uses, with this app's existing key; no new secret or variable)
and the page replicates with it. Until the owner steps are done (the key's
client id on the gateway's `COUCH_SYNC_CLIENT_IDS`, CouchDB's JWT handler) the
route answers `503` and the app stays local-only. See
[docs/couchdb-sync.md](docs/couchdb-sync.md) for the design, the gateway facts
it was checked against and the steps. The existing `/v1/devices` sync is
unchanged.

**Missing files 404.** A top-level path containing a dot that isn't a real
public file or static route, such as a deleted `/favicon-48.png`, is rewritten
(`afterFiles`, pattern in `src/lib/missing-asset.ts`) to `/api/missing-asset`,
which returns a plain 404. Without it the request would fall through to the
`[location]` page and get a 200 "Location not found".

**Unknown slugs get a real, server-rendered 404.** The proxy
(`src/proxy.ts`, gate in `src/lib/location-gate.ts`) looks up any slug that
is not a shipped seed slug or a smart-slug spot and rewrites an unknown one to
an internal path no route matches, so Next.js renders the not-found page on
the server with a 404 status. A failed or slow lookup lets the request
through, and a wrong-case URL such as `/Harare` gets a 308 to `/harare`.

Climate normals (1991–2020, ERA5 via Open-Meteo) are served by the Rust Worker at `GET /v1/normals`, with one cached table per 0.25° grid cell in KV.
**Map overlays** — tile layers from Tomorrow.io (the tiles Worker, `weather-tiles.mukoko.com/v1/map-tiles`) and NASA GIBS (satellite true colour and IMERG rain, keyless, animated; the map stops zooming past what the data holds: IMERG at map zoom 8, VIIRS at 9, `maxMapZoom` in `src/lib/map-sources.ts`); `GET /v1/model-grid (Rust Worker)?lat&lon&model` serves one global model's 72 h temperature / rain / wind grid for the per-model map layers (behind the `model_map_layers` flag). Credits for every layer come from `src/lib/map-sources.ts`.

**Air quality map** — `GET /v1/air-quality/grid` on the Rust Worker returns current US AQI on a 7×7 grid (±40 km) from one batched Open-Meteo request, cached 30 min; the `AirQualityMapCard` paints it over a non-interactive MapLibre map.
`GET /v1/enso` on the Rust Worker returns the latest El Niño / La Niña phase from NOAA CPC's Oceanic Niño Index (12 h KV cache; `available: false` when NOAA is unreachable).
**Place knowledge** — `GET /v1/locations/profile?slug|lat&lon` (the Rust Worker) returns what we know about a place that changes slowly, with its source and licence per field: the local season calendar (with local names), crop planting, growing and harvest windows (GEOGLAM Crop Monitor calendars, CC BY 4.0; a derived growing window that names no crops where no calendar exists), climate normals and a derived Köppen class (ERA5), soil (ISRIC SoilGrids), elevation, time zone and hemisphere, plus the current season, crop phase, moon, ENSO and day length computed at read time. It is built when a place is created or first loads and stored in `places.placeKnowledge` once the platform collection exists (nyuchi/data-infra and nyuchi/api-gateway own the schema and its apply script). Every AI prompt carries a compact profile block, and the "About" card on the location page shows it.
**Agriculture** — `GET /v1/agriculture?lat&lon[&location][&country][&crops]` (public; the Rust Worker, `weather-api.mukoko.com`) returns deterministic farm-weather data from one batched Open-Meteo request, cached 1 h per 0.05° grid cell in KV: spray, plant, harvest and irrigate windows (`go` / `wait` / `avoid`); rain; soil moisture and soil temperature by depth; ET₀ against rain; GDD; frost and heat risk; and a 46-day daily series. Season and crop calendars come from the shared location profile. `POST /api/ai/agriculture` (signed in; proxied to the AI Worker) has the model explain those numbers: one line for the location-page card, or a longer briefing for `/[location]/agriculture`. Never fails: `available: false` with a `reason`. The `/[location]/agriculture` page (public; in the sitemap for farming locations) adds 16-day charts (rain vs ET₀, water balance, soil moisture and soil temperature by depth, spray hours, GDD), the crop calendar, crop-aware advice, the past 30 days against normals, and ENSO.

**Report follow-up questions** — `POST /v1/reports/clarify` `{reportType, locationSlug?}` on the Rust AI Worker (`weather-api.mukoko.com`; first-party origins only) returns the one or two questions the report wizard asks about what the visitor sees. It always answers `200` with `{questions, source: "ai" | "fallback"}`: the model's questions, or a fixed pair for the report type when the model cannot answer or the hour's budget (10 per client) is spent. No text from the visitor reaches the model.

**AI search and history analysis** — `POST /v1/ai/explore/search` and `POST /v1/ai/history/analyze` on the Rust AI Worker (`weather-api.mukoko.com`; the app calls them with `postWorker`, never retried). The search gives the model two tools (the seed places, and a forecast per place) and falls back to a plain text match when it cannot answer; the analysis sends the model a compact statistical summary of the same history the page shows. Both are limited per client per hour (15 and 10) in the Workers' own D1 table, and fail closed. See `workers/README.md`.

**Weather fallback chain** (the Rust Workers) — KV cache (15-min TTL, kept a
day and served stale only when every provider fails)
→ Open-Meteo Africa-weighted multi-model blend (or the user's chosen model via
`?model=`) → Open-Meteo `best_match` → MET Norway Locationforecast (the keyless
failover, only while Open-Meteo is refusing, converted to the same shape) → the
seasonal estimate. The last stage
always succeeds, so a request never returns nothing. Activity insights (GDD,
heat index, thunderstorm proxy, dew point, UV, cloud base, moon phase) are
derived from the model data; Tomorrow.io is merged on top only when its
D1-backed budget (12/hour and 250/day for normal traffic, 20 and 400 for
priority) allows. Response headers: `X-Weather-Provider`
(`open-meteo:blend` | `open-meteo:<model>` | `open-meteo:best_match` | `met-no` |
`fallback`), `X-Weather-Blend`, `X-Enrichment` (`tomorrow` | `skipped-budget` |
`skipped-error` | `none`) and `X-Current-Source`. Data credit: ECMWF, NOAA,
DWD, ECCC, Météo-France, UK Met Office, CMA, JMA via Open-Meteo.com (CC BY 4.0); MET Norway (CC BY 4.0, converted to our format) when it is the failover. Open-Meteo's free API
is non-commercial only — see issue #246 for the licensing options. The Workers use Open-Meteo's paid ("customer") hosts whenever the subscription key is present, and the free hosts otherwise (`workers/README.md`, "Open-Meteo paid plan").

**Apple Weather (WeatherKit) — coming, off for now** ([#408](https://github.com/mukoko-dev/mukoko-weather/issues/408)) — the Apple Developer Program membership includes 500,000 WeatherKit calls a month, and `apple_weatherkit` ("Apple Weather") is being added to the model list: a model you can pick in My Weather and a series in the model comparison, not a member of the default blend. The provider rules are built and tested (`weather_core::weatherkit`: conversion to our names and units, the condition-code map, the developer token with an injected signer, the call budget, the 15-minute cache rule), but nothing serves the model yet (the weather backend is moving to Gwaihir, a server of the Nyuchi Servers API), so the picker row is behind `FLAGS.apple_weatherkit` and stays off. Wherever Apple data is shown the app credits it (Apple Weather trademark, the legal link, and a notice when the data was modified) from `src/lib/forecast-sources.ts`. Apple's account steps and the secrets are in CONTRIBUTING.md, "Apple WeatherKit".

**Three-layer error isolation** — `page.tsx` wraps fetching in try/catch so the
server always renders something; each weather section sits inside a
`ChartErrorBoundary`; `error.tsx` pages are the last resort, with retry counts
tracked in `sessionStorage`. Server errors log as structured JSON for Vercel Log
Drains; client errors report as GA4 exception events.

Both the location and history pages load progressively through `LazySection`, an
IntersectionObserver wrapper — only the first section is eager, which is what
keeps low-end mobile from running out of memory.

**Official Singapore air quality** — `GET /v1/sg-air` on the Rust Worker serves the National Environment Agency's PSI and PM2.5 readings from data.gov.sg. It is cached for 10 minutes, guarded by a circuit breaker, and returns `available: false` instead of failing. The `/display` page shows it beside the modelled AQI for Singapore.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the search and caching internals, and
[CLAUDE.md](CLAUDE.md) for the full route, component, and styling map.

## Commands

| Command                 | Description                           |
| ----------------------- | ------------------------------------- |
| `npm run dev`           | Dev server on `http://localhost:3000` |
| `npm run build`         | Production build                      |
| `npm test`              | Vitest, single run                    |
| `npm run test:coverage` | Vitest with v8 coverage               |
| `npm run lint`          | ESLint                                |
| `npx tsc --noEmit`      | Type check                            |

CI runs lint → typecheck → TypeScript tests
([`ci.yml`](.github/workflows/ci.yml)), the Rust Workers' format, clippy (native and wasm32), tests and bundle builds
([`workers.yml`](.github/workflows/workers.yml)), with a separate markdown/YAML lint gate
that the org ruleset runs on every PR, Claude review on PRs, and a
post-deploy DB seed sync ([`db-init.yml`](.github/workflows/db-init.yml)).

## Design

The app uses the Mukoko brand kit, whose colour ramp is drawn from the **seven
minerals** of the [Mzizi](https://mzizi.dev) palette — cobalt, tanzanite,
malachite, gold, terracotta, sodalite, copper. Those seven are one of three
families in Mzizi's twenty-one; the app does not use the heritage or
experimental families. Typography is Noto Serif / Noto Sans / JetBrains Mono,
with the Seed of Life mark. Semantic Fauna component classes (`.kudu`,
`.impala`, `.bee`, `.baobab`, `.weaver`) centralise repeated styles in
`globals.css`. Location-list cards use the `.oryx-*` sky classes, whose tokens are
checked to keep white text at 4.5:1 or better on every stop in both themes.

Accessibility targets **WCAG 3.0 APCA** — APCA-verified contrast (Lc 106/78/62),
ARIA landmarks throughout, 3px `focus-visible` outlines, 56px minimum touch
targets, and support for `prefers-reduced-motion`, `prefers-contrast: more`, and
`forced-colors`.

## Ecosystem

| Repo / service                                                                  | What it is                                 |
| ------------------------------------------------------------------------------- | ------------------------------------------ |
| [nyuchi/mukoko-weather-mobile](https://github.com/nyuchi/mukoko-weather-mobile) | The Expo / React Native mobile client      |
| [mukoko.com](https://mukoko.com)                                                | The Mukoko platform                        |
| [Mzizi](https://mzizi.dev)                                                      | The design system the brand kit draws from |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Licence

Licensed under the [MIT Licence](LICENSE).

**Mukoko Weather** is a product of **Mukoko Africa**, a division of **Nyuchi
Africa (PVT) Ltd**. Developed by [Nyuchi Web Services](https://nyuchi.com).

- **Issues:** [GitHub Issues](https://github.com/nyuchi/mukoko-weather/issues)
- **Support:** [support@mukoko.com](mailto:support@mukoko.com) · **General:** [hi@mukoko.com](mailto:hi@mukoko.com) · **Legal:** [legal@nyuchi.com](mailto:legal@nyuchi.com)
- **Social:** [@mukokoafrica](https://twitter.com/mukokoafrica) · [@mukoko.africa](https://instagram.com/mukoko.africa)
