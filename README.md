# Mukoko Weather

> AI-powered weather intelligence for the developing world — real-time forecasts and locally-relevant insights for farming, mining, travel, and daily life. Built in Zimbabwe, scaling globally.

[![CI](https://github.com/nyuchi/mukoko-weather/actions/workflows/ci.yml/badge.svg)](https://github.com/nyuchi/mukoko-weather/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
![Next.js](https://img.shields.io/badge/Next.js-16-000000?style=flat-square&logo=nextdotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-Python_3.10+-009688?style=flat-square&logo=fastapi&logoColor=white)

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
AIFS weighted highest, then NOAA GFS, DWD ICON, ECCC GEM and Météo-France
ARPEGE) served keyless by Open-Meteo, resolved through a four-stage chain —
MongoDB cache, the blend, Open-Meteo `best_match`, then seasonal estimates that
always succeed — so a page never renders empty. Tomorrow.io only enriches the
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

| Path                | What it is                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/` + `api/py/`  | **The app.** Next.js 16 App Router front end; Python FastAPI backend as Vercel serverless functions under `/api/py/*`. This is what ships to `weather.mukoko.com`.                                                                                                                                                                                                                                            |
| `station-console/`  | **Mukoko Station Console** — a second, separate Next.js app (dev port 3001) for community weather-station operators to register stations and review ingest. Added in #120; not yet on its own public domain.                                                                                                                                                                                                  |
| `releases/`         | **Public release notes**, one Markdown file per production release (`v0.11.0.md`). Parsed at build time into `/releases` and `/releases/feed.xml`. Format and how to add one: CONTRIBUTING.md → Releases → Release notes.                                                                                                                                                                                     |
| `scripts/`          | Build helpers. `copy-maplibre-worker.mjs` runs before every `build`/`dev` (npm `prebuild`/`predev`) and copies MapLibre v6's web worker into `public/vendor/maplibre-gl/<version>/`; without it every map renders blank. `build_geoglam_calendars.py` rebuilds the GEOGLAM crop-calendar table in `api/py/data/`; `backfill_place_knowledge.py` builds place knowledge for existing places (plan by default). |
| `infra/open-meteo/` | **Not deployed yet.** Railway service definitions for a self-hosted Open-Meteo (EU West, Amsterdam): the unmodified upstream image with a sync loop limited to our models and variables, plus a Caddy gateway that checks a header key. Runbook, sizing and cost in its `README.md`.                                                                                                                          |
| `worker/`           | **Legacy.** A Cloudflare Worker (`nyuchi-weather-api`) from an earlier architecture. Its `wrangler.toml` still carries `REPLACE_WITH_KV_NAMESPACE_ID` placeholders and it has not been touched since March 2026. Nothing deploys from it today.                                                                                                                                                               |

## Stack

| Layer          | Technology                                                                                                                                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework      | [Next.js 16](https://nextjs.org) (App Router), TypeScript 5, React 19                                                                                                                                                                                         |
| Backend API    | [Python FastAPI](https://fastapi.tiangolo.com) — Vercel serverless functions under `api/py/`                                                                                                                                                                  |
| Authentication | [WorkOS AuthKit](https://workos.com/docs/authkit) — hosted sign-in, signed-cookie sessions, users mirrored into `identity.persons`                                                                                                                            |
| Database       | [MongoDB Atlas](https://mongodb.com/atlas) — cache, AI summaries, history, locations, airports; Atlas Search for fuzzy queries                                                                                                                                |
| AI             | The [Workers AI](https://developers.cloudflare.com/workers-ai/) model set in the `shamwari` [AI Gateway](https://developers.cloudflare.com/ai-gateway/) (Python backend only)                                                                                 |
| Weather data   | Global models (ECMWF, NOAA GFS, DWD ICON, ECCC GEM, Météo-France ARPEGE) via [Open-Meteo](https://open-meteo.com) as the baseline, [Tomorrow.io](https://tomorrow.io) for budgeted insights enrichment, [NOAA AWC](https://aviationweather.gov) for METAR/TAF |
| UI             | [shadcn/ui](https://ui.shadcn.com) (Radix + CVA), [Tailwind CSS 4](https://tailwindcss.com)                                                                                                                                                                   |
| Charts & maps  | [Chart.js 4](https://www.chartjs.org), [MapLibre GL](https://maplibre.org) + [MapTiler](https://www.maptiler.com), [Three.js](https://threejs.org)                                                                                                            |
| State          | [Zustand 5](https://zustand.docs.pmnd.rs) with `persist`                                                                                                                                                                                                      |
| Testing        | [Vitest](https://vitest.dev) (TS, v8 coverage) + [pytest](https://pytest.org) (Python)                                                                                                                                                                        |
| Deployment     | [Vercel](https://vercel.com)                                                                                                                                                                                                                                  |

## Getting started

```bash
git clone https://github.com/nyuchi/mukoko-weather.git
cd mukoko-weather
npm install
npm run dev            # http://localhost:3000
```

Node.js 18+, npm 9+, and Python 3.10+ (for the backend tests).

The home page (`/`) **is** the current-location weather page — Apple Weather's
MY LOCATION model with the URL kept silent. The server seeds it from a
`lastLocation` cookie or Vercel IP geo; client GPS then swaps the content in
place, without a redirect. Explicit `/{slug}` URLs remain for saved and browsed
locations.

### Environment variables

| Variable                          | Required | Description                                                                                                                                                                                                                                  |
| --------------------------------- | :------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MONGODB_URI`                     |   Yes    | MongoDB Atlas connection string                                                                                                                                                                                                              |
| `WORKOS_API_KEY`                  |   Yes    | Server-side WorkOS API key (`sk_…`) — AuthKit middleware, callback exchange, `identity.persons` upsert                                                                                                                                       |
| `WORKOS_CLIENT_ID`                |   Yes    | WorkOS Client ID (`client_…`)                                                                                                                                                                                                                |
| `WORKOS_COOKIE_PASSWORD`          |   Yes    | 32+ character session-cookie secret. Rotating it invalidates every session                                                                                                                                                                   |
| `NEXT_PUBLIC_WORKOS_REDIRECT_URI` |   Yes    | OAuth callback URL; must match the WorkOS dashboard (`https://weather.mukoko.com/callback` in production)                                                                                                                                    |
| `WEATHER_SERVICE_URL`             |    No    | Internal weather Worker origin (`https://weather-internal.mukoko.com`). Every AI call goes to its `/internal/ai/chat/completions`. Without the AI vars, summaries fall back to a basic generated summary                                     |
| `WEATHER_AI_URL`                  |    No    | Optional AI URL override (full `…/chat/completions` URL, or a base)                                                                                                                                                                          |
| `WEATHER_SERVICE_API_KEY`         |    No    | Server-only. The service key `mukoko-weather-internal` checks. Vercel holds no Cloudflare AI token; the model is set by the AI Worker                                                                                                        |
| `NYUCHI_API_URL`                  |    No    | Server-only. Nyuchi API gateway origin (`https://api.nyuchi.com`) for `/api/app-keys`. Unset = that route answers `503`                                                                                                                      |
| `NYUCHI_APP_KEYS_API_KEY`         |    No    | Server-only secret. This app's internal gateway key `nyk_….nys_…`, scoped `identity app-keys weather` only. Exchanges each user's own WorkOS token for a person token; never `NEXT_PUBLIC_*`                                                 |
| `NYUCHI_CONSOLE_WORKOS_CLIENT_ID` |    No    | The Console's WorkOS client ("Mukoko Account"), the only issuer the exchange accepts. Defaults to `client_01KV2G518HGXVMTAFQDKSVNXCW`                                                                                                        |
| `DB_INIT_SECRET`                  |    No    | Protects `/api/db-init` in production (`x-init-secret` header)                                                                                                                                                                               |
| `INTERNAL_API_BASE_URL`           |    No    | Base URL for server-to-server SSR calls into `/api/py/*`. Overrides the default: the production domain in production, the protected deployment URL plus the automation bypass header on previews                                             |
| `NEXT_PUBLIC_WEATHER_API_URL`     |    No    | Origin of the Rust weather Worker (`https://weather-api.mukoko.com`). Unset = the app keeps using the frozen `/api/py` and the Worker-only behaviour (bare-name URLs resolve to a spot) stays off. `https` only (plain `http` for localhost) |
| `OPEN_METEO_BASE_URL`             |    No    | Server-only. Origin of a self-hosted Open-Meteo (`infra/open-meteo/`); `/v1/forecast` is appended. Unset = the public API. `https` only (plain `http` for localhost)                                                                         |
| `OPEN_METEO_AQ_BASE_URL`          |    No    | Server-only. Origin of the self-hosted air-quality (CAMS) API; `/v1/air-quality` is appended. Unset = the public API. Set apart from the forecast so the two can move separately                                                             |
| `OPEN_METEO_API_KEY`              |    No    | Server-only secret. Gateway key, sent in the `X-Mukoko-OM-Key` header to the self-hosted hosts above only, never to an `open-meteo.com` host and never in a URL                                                                              |

## Architecture

Almost all data, AI, and CRUD work runs in **Python FastAPI** under `api/py/`,
proxied by a `vercel.json` rewrite (`/api/py/*` → `api/py/index.py`). Only four
routes remain in TypeScript: OG image generation, DB init, the public embed API,
and developer API-key management.

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

Climate normals (1991–2020, ERA5 via Open-Meteo) are served at `GET /api/py/normals`, with one cached table per 0.25° grid cell in `weather.climate_normals`.
**Map overlays** — tile layers from Tomorrow.io (`/api/py/map-tiles`) and NASA GIBS (satellite true colour and IMERG rain, keyless, animated); `GET /api/py/model-grid?lat&lon&model` serves one global model's 72 h temperature / rain / wind grid for the per-model map layers (behind the `model_map_layers` flag). Credits for every layer come from `src/lib/map-sources.ts`.

**Air quality map** — `GET /v1/air-quality/grid` on the Rust Worker returns current US AQI on a 7×7 grid (±40 km) from one batched Open-Meteo request, cached 30 min; the `AirQualityMapCard` paints it over a non-interactive MapLibre map.
`GET /v1/enso` on the Rust Worker returns the latest El Niño / La Niña phase from NOAA CPC's Oceanic Niño Index (12 h KV cache; `available: false` when NOAA is unreachable).
**Place knowledge** — `GET /api/py/locations/profile?slug|lat&lon` returns what we know about a place that changes slowly, with its source and licence per field: the local season calendar (with local names), crop planting, growing and harvest windows (GEOGLAM Crop Monitor calendars, CC BY 4.0; a derived growing window that names no crops where no calendar exists), climate normals and a derived Köppen class (ERA5), soil (ISRIC SoilGrids), elevation, time zone and hemisphere, plus the current season, crop phase, moon, ENSO and day length computed at read time. It is built when a place is created or first loads and stored in `places.placeKnowledge` once the platform collection exists (nyuchi/data-infra and nyuchi/api-gateway own the schema and its apply script). Every AI prompt carries a compact profile block, and the "About" card on the location page shows it.
**Agriculture** — `GET /api/py/agriculture?lat&lon[&location][&country][&crops]` (public) returns deterministic farm-weather data from one batched Open-Meteo request, cached 1 h per 0.05° grid cell: spray, plant, harvest and irrigate windows (`go` / `wait` / `avoid`); rain; soil moisture and soil temperature by depth; ET₀ against rain; GDD; frost and heat risk; and a 46-day daily series. Season and crop calendars come from the shared location profile. `POST /api/ai/agriculture` (signed in; proxied to `/api/py/ai/agriculture`) has the model explain those numbers: one line for the location-page card, or a longer briefing for `/[location]/agriculture`. Never fails: `available: false` with a `reason`. The `/[location]/agriculture` page (public; in the sitemap for farming locations) adds 16-day charts (rain vs ET₀, water balance, soil moisture and soil temperature by depth, spray hours, GDD), the crop calendar, crop-aware advice, the past 30 days against normals, and ENSO.

**Four-stage weather fallback** — MongoDB cache (15-min TTL) → Open-Meteo
Africa-weighted multi-model blend (or the user's chosen model via `?model=`) →
Open-Meteo `best_match` → `createFallbackWeather` seasonal estimates. The last
stage always succeeds, so a request never returns nothing. Activity insights
(GDD, heat index, thunderstorm proxy, dew point, UV, cloud base, moon phase)
are derived from the model data; Tomorrow.io is merged on top only when its
MongoDB-backed budget (20/hour, 400/day, with headroom reserved for seed
locations) allows. Response headers: `X-Weather-Provider`
(`open-meteo:blend` | `open-meteo:<model>` | `open-meteo:best_match` |
`fallback`), `X-Weather-Blend`, `X-Enrichment` (`tomorrow` | `skipped-budget` |
`skipped-error` | `none`) and `X-Current-Source`. Data credit: ECMWF, NOAA,
DWD, ECCC, Météo-France via Open-Meteo.com (CC BY 4.0). Open-Meteo's free API
is non-commercial only — see issue #246 for the licensing options.

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
| `npm run test:python`   | pytest — the Python backend suite     |
| `npm run test:all`      | Both suites                           |
| `npm run lint`          | ESLint                                |
| `npx tsc --noEmit`      | Type check                            |

CI runs lint → typecheck → TypeScript tests → Python tests
([`ci.yml`](.github/workflows/ci.yml)), with a separate markdown/YAML lint gate
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
