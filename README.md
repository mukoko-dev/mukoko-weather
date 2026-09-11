# Mukoko Weather

> AI-powered weather intelligence for the developing world — real-time forecasts and locally-relevant insights for farming, mining, travel, and daily life. Built in Zimbabwe, scaling globally.

[![CI](https://github.com/nyuchi/mukoko-weather/actions/workflows/ci.yml/badge.svg)](https://github.com/nyuchi/mukoko-weather/actions/workflows/ci.yml)
[![Lint](https://github.com/nyuchi/mukoko-weather/actions/workflows/lint.yml/badge.svg)](https://github.com/nyuchi/mukoko-weather/actions/workflows/lint.yml)
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

Two things keep it honest where connectivity and upstream APIs are not. Weather
resolves through a four-stage chain — MongoDB cache, Tomorrow.io, Open-Meteo,
then seasonal estimates that always succeed — so a page never renders empty.
And the UI is error-isolated per section: a chart that crashes takes down the
chart, not the page.

Beyond the forecast, the app carries an aviation planner (METAR/TAF with
VFR/MVFR/IFR/LIFR categories and PDF pre-flight briefings from NOAA data),
Waze-style community weather reports cross-validated against API data, an EPA
air-quality index with a full pollutant breakdown, a historical dashboard with
Claude-authored trend analysis, and an embeddable widget. It installs as a PWA.

Some AI surfaces are behind flags. **Shamwari full-viewport chat is paused**
(`FLAGS.shamwari_chat` is `false`; `/shamwari` 404s); inline AI summaries,
follow-up chat, and AI explore search remain live.

## Repository layout

This repo holds three deployables, not one:

| Path               | What it is                                                                                                                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/` + `api/py/` | **The app.** Next.js 16 App Router front end; Python FastAPI backend as Vercel serverless functions under `/api/py/*`. This is what ships to `weather.mukoko.com`.                                                                              |
| `station-console/` | **Mukoko Station Console** — a second, separate Next.js app (dev port 3001) for community weather-station operators to register stations and review ingest. Added in #120; not yet on its own public domain.                                    |
| `worker/`          | **Legacy.** A Cloudflare Worker (`nyuchi-weather-api`) from an earlier architecture. Its `wrangler.toml` still carries `REPLACE_WITH_KV_NAMESPACE_ID` placeholders and it has not been touched since March 2026. Nothing deploys from it today. |

## Stack

| Layer          | Technology                                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework      | [Next.js 16](https://nextjs.org) (App Router), TypeScript 5, React 19                                                                              |
| Backend API    | [Python FastAPI](https://fastapi.tiangolo.com) — Vercel serverless functions under `api/py/`                                                       |
| Authentication | [WorkOS AuthKit](https://workos.com/docs/authkit) — hosted sign-in, signed-cookie sessions, users mirrored into `identity.persons`                 |
| Database       | [MongoDB Atlas](https://mongodb.com/atlas) — cache, AI summaries, history, locations, airports; Atlas Search for fuzzy queries                     |
| AI             | [Anthropic Claude](https://docs.anthropic.com/en/docs) (server-side, via the Python API)                                                           |
| Weather data   | [Tomorrow.io](https://tomorrow.io) primary, [Open-Meteo](https://open-meteo.com) fallback, [NOAA AWC](https://aviationweather.gov) for METAR/TAF   |
| UI             | [shadcn/ui](https://ui.shadcn.com) (Radix + CVA), [Tailwind CSS 4](https://tailwindcss.com)                                                        |
| Charts & maps  | [Chart.js 4](https://www.chartjs.org), [MapLibre GL](https://maplibre.org) + [MapTiler](https://www.maptiler.com), [Three.js](https://threejs.org) |
| State          | [Zustand 5](https://zustand.docs.pmnd.rs) with `persist`                                                                                           |
| Testing        | [Vitest](https://vitest.dev) (TS, v8 coverage) + [pytest](https://pytest.org) (Python)                                                             |
| Deployment     | [Vercel](https://vercel.com)                                                                                                                       |

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

| Variable                          | Required | Description                                                                                               |
| --------------------------------- | :------: | --------------------------------------------------------------------------------------------------------- |
| `MONGODB_URI`                     |   Yes    | MongoDB Atlas connection string                                                                           |
| `WORKOS_API_KEY`                  |   Yes    | Server-side WorkOS API key (`sk_…`) — AuthKit middleware, callback exchange, `identity.persons` upsert    |
| `WORKOS_CLIENT_ID`                |   Yes    | WorkOS Client ID (`client_…`)                                                                             |
| `WORKOS_COOKIE_PASSWORD`          |   Yes    | 32+ character session-cookie secret. Rotating it invalidates every session                                |
| `NEXT_PUBLIC_WORKOS_REDIRECT_URI` |   Yes    | OAuth callback URL; must match the WorkOS dashboard (`https://weather.mukoko.com/callback` in production) |
| `ANTHROPIC_API_KEY`               |    No    | Without it, AI summaries fall back to a basic generated summary                                           |
| `DB_INIT_SECRET`                  |    No    | Protects `/api/db-init` in production (`x-init-secret` header)                                            |
| `INTERNAL_API_BASE_URL`           |    No    | Base URL for server-to-server SSR calls into `/api/py/*`                                                  |

## Architecture

Almost all data, AI, and CRUD work runs in **Python FastAPI** under `api/py/`,
proxied by a `vercel.json` rewrite (`/api/py/*` → `api/py/index.py`). Only four
routes remain in TypeScript: OG image generation, DB init, the public embed API,
and developer API-key management.

**Four-stage weather fallback** — MongoDB cache (15-min TTL) → Tomorrow.io →
Open-Meteo → `createFallbackWeather` seasonal estimates. The last stage always
succeeds, so a request never returns nothing.

**Three-layer error isolation** — `page.tsx` wraps fetching in try/catch so the
server always renders something; each weather section sits inside a
`ChartErrorBoundary`; `error.tsx` pages are the last resort, with retry counts
tracked in `sessionStorage`. Server errors log as structured JSON for Vercel Log
Drains; client errors report as GA4 exception events.

Both the location and history pages load progressively through `LazySection`, an
IntersectionObserver wrapper — only the first section is eager, which is what
keeps low-end mobile from running out of memory.

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
([`lint.yml`](.github/workflows/lint.yml)), Claude review on PRs, and a
post-deploy DB seed sync ([`db-init.yml`](.github/workflows/db-init.yml)).

## Design

The app uses the Mukoko brand kit, whose colour ramp is drawn from the **seven
minerals** of the [Mzizi](https://mzizi.dev) palette — cobalt, tanzanite,
malachite, gold, terracotta, sodalite, copper. Those seven are one of three
families in Mzizi's twenty-one; the app does not use the heritage or
experimental families. Typography is Noto Serif / Noto Sans / JetBrains Mono,
with the Seed of Life mark. Semantic Fauna component classes (`.kudu`,
`.impala`, `.bee`, `.baobab`, `.weaver`) centralise repeated styles in
`globals.css`.

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
