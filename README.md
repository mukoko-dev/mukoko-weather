# mukoko weather

AI-powered weather intelligence, starting with Zimbabwe and expanding globally. Accurate forecasts, frost alerts, and actionable insights for farming, mining, travel, and daily life across Zimbabwe, ASEAN countries, and developing regions.

**Live:** [weather.mukoko.com](https://weather.mukoko.com)

## Features

- **Real-time weather** — current conditions from Tomorrow.io (primary) with Open-Meteo fallback
- **7-day forecasts** — daily highs, lows, precipitation probability, and weather conditions
- **24-hour hourly forecasts** — hour-by-hour temperature and rain predictions
- **AI weather intelligence** — Claude-powered markdown-formatted summaries with farming, mining, and travel advice, plus inline follow-up chat (up to 5 messages before seamless handoff to Shamwari)
- **AI-powered explore search** — natural-language location discovery ("farming areas with low frost risk") using Claude with tool use
- **AI history analysis** — button-triggered analysis of historical weather trends, patterns, and anomalies with server-side aggregation
- **Personalised activity insights** — 30+ activities across 6 categories (farming, mining, travel, tourism, sports, casual) with mineral-colored cards showing GDD, heat stress, thunderstorm risk, visibility, and more
- **Cross-device sync** — device profile sync bridges browser localStorage with a server-side profile, so preferences survive across devices and browser resets
- **Community weather reporting** — Waze-style ground-truth observations: 10 weather types, 3 severity levels, AI-assisted clarification, cross-validation against API data, community upvoting
- **Frost alerts** — automated frost risk detection for overnight hours with severity levels
- **Dynamic locations** — 90+ seed locations in Zimbabwe, with community-driven expansion to ASEAN and developing regions via geolocation and search
- **Seasonal awareness** — Zimbabwe seasons (Masika, Chirimo, Zhizha, Munakamwe) and regional context
- **Geolocation** — automatic nearest-location detection via browser GPS, with auto-creation for new areas
- **Shamwari AI chat** — dedicated `/shamwari` page with full-viewport Claude app-style chat (search locations, check weather, get activity advice, compare cities). Contextual navigation carries weather/location data from any page
- **Suitability scoring** — database-driven weather suitability evaluation for activities (excellent/good/fair/poor ratings with structured metrics)
- **Country/region browse** — explore locations by country, province, and tag across 64 countries (54 AU + ASEAN)
- **System status** — live health dashboard for all services (MongoDB, weather APIs, AI, cache)
- **Embeddable widget** — drop-in weather widget for third-party sites
- **Dedicated detail pages** — `/harare/atmosphere` for 24h atmospheric charts, `/harare/forecast` for hourly + daily forecast detail, `/harare/map` for full-viewport interactive weather map
- **Smart theming** — light, dark, and system (auto) modes with OS preference detection
- **Historical data dashboard** — explore recorded weather trends, precipitation, and climate patterns over time, with AI-powered analysis
- **Database-driven AI configuration** — all system prompts, suggested prompt rules, and model configs stored in MongoDB for easy updates without code changes
- **Resilient architecture** — Netflix-style error isolation: per-section error boundaries, 4-stage weather fallback chain, structured observability logging
- **PWA** — installable as a standalone app on Android, iOS, and desktop

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | [Next.js 16](https://nextjs.org) (App Router, TypeScript 5) |
| Backend API | [Python FastAPI](https://fastapi.tiangolo.com) (Vercel serverless functions under `api/py/`) |
| UI Components | [shadcn/ui](https://ui.shadcn.com) (Radix UI + CVA) |
| Charts | [Chart.js 4](https://www.chartjs.org) + [react-chartjs-2](https://react-chartjs-2.js.org) (Canvas 2D) |
| Maps | [Leaflet](https://leafletjs.com) + [react-leaflet](https://react-leaflet.js.org) (Tomorrow.io tile overlays) |
| Styling | [Tailwind CSS 4](https://tailwindcss.com) with CSS custom properties |
| Markdown | [react-markdown 10](https://github.com/remarkjs/react-markdown) |
| State | [Zustand 5](https://zustand.docs.pmnd.rs) with `persist` middleware |
| AI | [Anthropic Claude SDK](https://docs.anthropic.com/en/docs) (server-side via Python FastAPI) |
| Weather API | [Tomorrow.io](https://tomorrow.io) (primary) + [Open-Meteo](https://open-meteo.com) (fallback) |
| Database | [MongoDB Atlas](https://mongodb.com/atlas) (cache, AI summaries, history, locations; Atlas Search for fuzzy queries) |
| Analytics | [Google Analytics 4](https://analytics.google.com) |
| 3D Animations | [Three.js](https://threejs.org) (weather-aware loading scenes) |
| Testing | [Vitest](https://vitest.dev) (TypeScript, v8 coverage) + [pytest](https://pytest.org) (Python) |
| CI/CD | [GitHub Actions](https://github.com/features/actions) (CI: lint → typecheck → tests; [CodeQL](https://codeql.github.com/) security scanning; Claude AI review on PRs; post-deploy DB init) |
| Deployment | [Vercel](https://vercel.com) |

## Getting Started

### Prerequisites

- Node.js 18+
- npm 9+
- Python 3.10+ (for backend tests)

### Installation

```bash
git clone https://github.com/nyuchitech/mukoko-weather.git
cd mukoko-weather
npm install
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MONGODB_URI` | Yes | MongoDB Atlas connection string for caching and data storage |
| `ANTHROPIC_API_KEY` | No | Anthropic API key for AI weather summaries. Without it, a basic fallback summary is generated |
| `DB_INIT_SECRET` | No | Protects the `/api/db-init` endpoint in production (via `x-init-secret` header) |

### Development

```bash
npm run dev           # Start dev server (http://localhost:3000)
npm run build         # Production build
npm start             # Start production server
npm test              # Run Vitest tests (single run)
npm run test:watch    # Run Vitest in watch mode
npm run test:coverage # Run Vitest with v8 coverage reporting
npm run test:python   # Run Python backend tests (pytest)
npm run test:all      # Run both TypeScript and Python tests
npm run lint          # ESLint
npx tsc --noEmit      # Type check
python -m pytest tests/py/ -v  # Run Python backend tests (direct)
```

The home page (`/`) uses smart redirect: returning users go to their saved location, new users get geolocation detection with a 3-second timeout, and the fallback is `/harare`.

## Architecture

### Routes

| Route | Description |
|-------|-------------|
| `/` | Smart redirect — saved location (returning users), geolocation (new users), or `/harare` (fallback) |
| `/[location]` | Weather overview — current conditions, AI summary, activity insights, atmospheric metric cards |
| `/[location]/atmosphere` | 24-hour atmospheric detail charts (humidity, wind, pressure, UV) |
| `/[location]/forecast` | Hourly (24h) + daily (7-day) forecast charts + sunrise/sunset |
| `/[location]/map` | Full-viewport interactive weather map with layer switcher |
| `/shamwari` | Shamwari AI chat (full-viewport, Claude app style) |
| `/explore` | Browse locations by category and country |
| `/explore/[tag]` | Browse locations filtered by tag |
| `/explore/country` | Browse locations by country index |
| `/explore/country/[code]` | Browse locations in a specific country |
| `/explore/country/[code]/[province]` | Browse locations in a specific province |
| `/status` | System health dashboard (live checks for all services) |
| `/about` | Company information |
| `/help` | User help / FAQ |
| `/history` | Historical weather data dashboard (search, multi-day charts, data table) |
| `/privacy` | Privacy policy |
| `/terms` | Terms of service |
| `/embed` | Embeddable widget documentation |

The main location page is a compact overview. Detail-heavy sections (charts, atmospheric trends, hourly/daily forecasts) live on dedicated sub-route pages. This reduces initial page load weight and prevents mobile OOM crashes.

### API

All data, AI, and CRUD operations run in **Python FastAPI** (`api/py/`), deployed as Vercel serverless functions. Routes are proxied via `vercel.json` rewrites (`/api/py/*` → `api/py/index.py`). Only the OG image and DB init routes remain in TypeScript.

**Python API (`/api/py/*`):**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/py/weather?lat=&lon=` | GET | Weather data (Tomorrow.io → Open-Meteo fallback, MongoDB cached 15-min TTL). `X-Weather-Provider` / `X-Cache` headers |
| `/api/py/ai` | POST | AI weather summary (Claude Haiku 3.5, markdown). Tiered TTL cache (30/60/120 min) |
| `/api/py/ai/followup` | POST | Inline follow-up chat for AI summaries (max 5 exchanges). Rate-limited 30 req/hour/IP |
| `/api/py/ai/prompts` | GET | Database-driven AI prompt library (system prompts + suggested prompt rules) |
| `/api/py/ai/suggested-rules` | GET | Dynamic suggested prompt rules for contextual prompts |
| `/api/py/chat` | POST | Shamwari Explorer chatbot (Claude + tool use). Rate-limited 20 req/hour/IP |
| `/api/py/search?q=&tag=&lat=&lon=` | GET | Location search (text, tag filter, geospatial nearest, pagination) |
| `/api/py/geo?lat=&lon=` | GET | Nearest location lookup (supports `autoCreate=true` for community locations) |
| `/api/py/locations` | GET | List/filter locations from MongoDB (by slug, tag, or all; includes stats mode) |
| `/api/py/locations/add` | POST | Add locations via search or coordinates. Rate-limited 5 req/hour/IP |
| `/api/py/activities` | GET | Activities (by id, category, search, labels, or categories mode) |
| `/api/py/suitability` | GET | Suitability rules from MongoDB (all or by key; key format validated) |
| `/api/py/tags` | GET | Tag metadata (all or featured) |
| `/api/py/regions` | GET | Active supported regions (bounding boxes) |
| `/api/py/status` | GET | System health checks (MongoDB, Tomorrow.io, Open-Meteo, Anthropic, cache) |
| `/api/py/history?location=&days=` | GET | Historical weather data for a location |
| `/api/py/history/analyze` | POST | AI-powered historical weather analysis (server-side aggregation + Claude). Cached 1h. Rate-limited 10 req/hour/IP |
| `/api/py/explore/search` | POST | AI-powered natural-language location search (Claude + tool use). Rate-limited 15 req/hour/IP |
| `/api/py/map-tiles?z=&x=&y=&layer=` | GET | Tile proxy for Tomorrow.io map layers (keeps API key server-side) |
| `/api/py/reports` | POST/GET | Community weather reports — submit (POST, 5/hour/IP) or list (GET) |
| `/api/py/reports/upvote` | POST | Upvote a community report (IP-based dedup) |
| `/api/py/reports/clarify` | POST | AI-generated follow-up questions for weather report clarification. Rate-limited 10 req/hour/IP |
| `/api/py/devices` | POST/GET/PATCH | Device profile sync for cross-device preferences |
| `/api/py/health` | GET | Basic health check (MongoDB + Anthropic availability) |

**TypeScript API (remaining):**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/og?title=&subtitle=&template=` | GET | Dynamic OG image generation (Edge runtime, Satori). 6 templates, in-memory rate-limited, 1-day CDN cache |
| `/api/db-init` | POST | One-time DB setup + seed data (incl. AI prompts). Protected by `DB_INIT_SECRET` in production |

### Resilience

The app follows a Netflix-style resilience philosophy — the shell never crashes, failures are isolated per-section.

**4-stage weather fallback chain:**
1. MongoDB cache (15-min TTL)
2. Tomorrow.io API (primary provider)
3. Open-Meteo API (free fallback)
4. `createFallbackWeather` seasonal estimates (always succeeds)

**3-layer error isolation:**
1. **Server-side safety net** — `page.tsx` wraps data fetching in try/catch; even if all providers fail, the page renders with seasonal estimates
2. **Per-section error boundaries** — every weather section is wrapped in `ChartErrorBoundary`; a chart crash only affects that section
3. **Page-level error boundaries** — last resort `error.tsx` pages with retry tracking (max 3 retries via sessionStorage)

**Observability:**
- Server-side: structured JSON logging (`logError`/`logWarn` in `src/lib/observability.ts`) for Vercel Log Drains
- Client-side: GA4 exception events via `reportErrorToAnalytics` in error boundaries and error pages
- Provider failure tracking: `reportProviderFailure` for weather API monitoring

### Lazy Loading

Both the location page and history page use feed-style progressive loading via `LazySection` (IntersectionObserver wrapper). Only the first section loads eagerly; everything below the fold is deferred until scrolled near.

## Project Structure

```
src/
  app/
    layout.tsx              # Root layout, metadata, JSON-LD schemas
    page.tsx                # Home — smart redirect (saved location / geolocation / harare)
    HomeRedirect.tsx        # Client: smart redirect with Zustand rehydration guard
    globals.css             # Brand System v6 (WCAG 3.0 APCA compliant)
    loading.tsx             # Root loading skeleton
    error.tsx               # Global error boundary
    robots.ts               # Dynamic robots.txt
    sitemap.ts              # Dynamic sitemap (all locations + sub-routes)
    [location]/
      page.tsx              # Dynamic weather page per location
      WeatherDashboard.tsx  # Client: all weather UI with per-section error boundaries
      loading.tsx           # Skeleton loading state
      error.tsx             # Location-specific error boundary
      not-found.tsx         # 404 with location suggestions
      FrostAlertBanner.tsx  # Frost risk alert
      WeatherUnavailableBanner.tsx  # Fallback data alert
      atmosphere/           # 24h atmospheric detail charts sub-route
      forecast/             # Hourly + daily forecast detail sub-route
      map/                  # Full-viewport weather map sub-route
    explore/                # Browse-only location/tag/country exploration
      page.tsx              # Explore page (ISR 1h, category + country browse)
      [tag]/                # Browse locations by tag
      country/              # Browse by country/province (nested [code]/[province])
    shamwari/               # Shamwari AI chat (full-viewport, Claude app style)
      page.tsx              # Server wrapper (metadata)
      ShamwariPageClient.tsx # Client: full-viewport chatbot layout
    status/                 # System health dashboard
      page.tsx
      StatusDashboard.tsx   # Client: live health checks
    about/page.tsx
    help/page.tsx
    history/
      page.tsx              # Historical data page
      HistoryDashboard.tsx  # Client: search, 7 charts, stats, data table
      error.tsx
    privacy/page.tsx
    terms/page.tsx
    embed/page.tsx
    api/                    # Remaining TypeScript API routes (most migrated to Python)
      og/route.tsx          # GET — dynamic OG image generation (Edge runtime, Satori)
      db-init/route.ts      # POST — one-time DB setup + seed data
  components/
    ui/                     # shadcn/ui primitives (button, badge, card, chart, dialog, input, skeleton, tabs)
    analytics/              # Google Analytics 4
    brand/                  # Logo, MineralsStripe, ThemeProvider, ThemeToggle
    explore/                # Shamwari chatbot + AI explore search
    layout/                 # Header (pill icon group), HeaderSkeleton, Footer
    weather/
      CurrentConditions.tsx  # Large temp display, feels-like, stats grid
      HourlyForecast.tsx     # 24-hour hourly forecast
      DailyForecast.tsx      # 7-day forecast cards
      AtmosphericSummary.tsx # 2x3 compact metric cards
      AtmosphericDetails.tsx # 4x 24h atmospheric charts
      LazySection.tsx        # TikTok-style sequential lazy-load
      ChartErrorBoundary.tsx # Error boundary for crash isolation
      StatCard.tsx           # Reusable stat card
      WelcomeBanner.tsx       # Inline welcome banner for first-time visitors
      MyWeatherModal.tsx     # Centralized preferences modal (location, activities, settings)
      AISummary.tsx          # Shamwari AI markdown summary (onSummaryLoaded callback)
      AISummaryChat.tsx      # Inline follow-up chat (max 5 messages → Shamwari)
      HistoryAnalysis.tsx    # AI-powered historical weather analysis
      ActivityInsights.tsx   # Category-specific weather insight cards
      WeatherLoadingScene.tsx # Branded Three.js weather loading animation
      reports/               # Waze-style community weather reporting
      charts/                # Reusable Canvas chart components (15 charts)
      map/                   # Leaflet map (preview, full, layer switcher, skeleton)
    embed/
      MukokoWeatherEmbed.tsx # Embeddable widget (CSS module, self-contained)
  lib/
    locations.ts            # WeatherLocation type, 90+ ZW seed locations, SUPPORTED_REGIONS
    locations-africa.ts     # African city seed data (54 AU member states)
    countries.ts            # Country/province types, 64 seed countries, flag emoji
    activities.ts           # 30+ activities, 6 categories, mineral color styles
    suitability.ts          # Database-driven suitability evaluation engine (evaluateRule)
    suitability-cache.ts    # Client-side cache for suitability rules + category styles
    tomorrow.ts             # Tomorrow.io API client + WMO normalization
    weather.ts              # Open-Meteo client, frost detection, seasons, weather utils
    weather-labels.ts       # Contextual label helpers (humidity, pressure, cloud, feels-like)
    db.ts                   # MongoDB CRUD + Atlas Search/Vector Search (18+ collections)
    mongo.ts                # MongoDB client (connection-pooled via @vercel/functions)
    observability.ts        # Structured error logging + GA4 error reporting
    store.ts                # Zustand state (theme, activities, location, hasOnboarded, ShamwariContext, reportModal)
    device-sync.ts          # Device sync — bridges Zustand localStorage with Python device profile API
    suggested-prompts.ts    # Database-driven suggested prompt generation
    geolocation.ts          # Browser Geolocation API wrapper
    weather-icons.tsx       # SVG weather + activity icon components
    i18n.ts                 # Lightweight i18n (en complete, sn/nd ready)
    error-retry.ts          # Error retry with sessionStorage tracking
    utils.ts                # Tailwind class merging (cn)
    weather-scenes/         # Weather-aware Three.js particle animations for loading screens
    seed-*.ts               # Seed data files (categories, tags, regions, seasons, suitability rules, AI prompts)
api/
  py/                       # Python FastAPI backend (Vercel serverless functions)
    index.py                # FastAPI app, router mounting, CORS, error handlers
    _db.py                  # MongoDB connection, collection accessors, rate limiting
    _weather.py             # Weather data endpoints (Tomorrow.io/Open-Meteo proxy)
    _ai.py                  # AI summary endpoint (Claude, tiered TTL cache)
    _ai_followup.py         # Inline follow-up chat endpoint
    _ai_prompts.py          # AI prompt library CRUD
    _chat.py                # Shamwari Explorer chatbot (Claude + tool use)
    _locations.py           # Location CRUD, search, geo lookup
    _history.py             # Historical weather data endpoint
    _history_analyze.py     # AI history analysis
    _explore_search.py      # AI-powered explore search
    _reports.py             # Community weather reports (submit, list, upvote, clarify)
    _suitability.py         # Suitability rules endpoint
    _data.py                # DB init, seed data, activities, tags, regions
    _devices.py             # Device sync (preferences across devices)
    _circuit_breaker.py     # Netflix Hystrix-inspired circuit breaker (per-provider)
    _embeddings.py          # Vector embedding endpoints (stub)
    _status.py              # System health checks
    _tiles.py               # Map tile proxy for Tomorrow.io
tests/
  py/                       # Python backend tests (pytest, 559 tests across 19 files)
    conftest.py             # Shared fixtures, mock pymongo/anthropic
public/
  manifest.json             # PWA manifest with app shortcuts
  icons/                    # PWA icons (192x192, 512x512)
.github/
  ISSUE_TEMPLATE/           # Bug report and feature request templates (YAML forms)
  workflows/
    ci.yml                  # Lint → typecheck → TypeScript tests → Python tests (concurrency-grouped)
    claude-code-review.yml  # Claude AI code review on PRs (token-guarded, concurrency-grouped)
    claude.yml              # Claude Code for @claude mentions in issues/PRs
    codeql.yml              # CodeQL security scanning (JS/TS, Python, Actions)
    db-init.yml             # Post-deploy DB seed data sync (Vercel deployment webhook)
```

## Accessibility

This app targets **WCAG 3.0 APCA/AAA** compliance:

- APCA-verified color contrast (Lc 106/78/62 for primary/secondary/tertiary text)
- Skip-to-main-content link (`<a href="#main-content">` in root layout, visually hidden until focused)
- ARIA landmarks on all layout components (`role="banner"`, `role="navigation"`, `role="contentinfo"`)
- Descriptive `aria-label` on navigation regions (e.g., "Main navigation", "Mobile navigation")
- `aria-current="page"` on active navigation links
- 3px `focus-visible` outlines with theme-aware colors (`--color-focus-ring`); mouse clicks suppress outlines via `focus:not(:focus-visible)`
- `prefers-reduced-motion` support (disables all animations and transitions)
- `prefers-contrast: more` support (maximum contrast overrides)
- Windows High Contrast / `forced-colors` support (uses `Highlight` system color for focus)
- Semantic HTML with proper heading hierarchy
- Keyboard-navigable location selector with Escape key support
- Minimum 44px touch targets for mobile
- Screen reader utilities (`.sr-only` class) on all loading states and decorative elements

## SEO

- Dynamic `robots.txt` and `sitemap.xml` for all locations and sub-routes
- Per-page canonical URLs, Open Graph, and Twitter cards
- FAQPage, BreadcrumbList, WebApplication, Organization, and WebSite JSON-LD schemas
- Visible breadcrumb navigation
- Semantic H1 on every location page

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on setting up your development environment, code standards, testing, and the pull request process.

## Security

See [SECURITY.md](SECURITY.md) for our security policy, vulnerability reporting process, and details on how we handle API keys, data privacy, and content security.

## Company

**mukoko weather** is a product of **Mukoko Africa**, a division of **Nyuchi Africa (PVT) Ltd**. Developed by **Nyuchi Web Services**.

## License

[MIT](LICENSE) — Nyuchi Africa (PVT) Ltd

## Links

- **Website:** [weather.mukoko.com](https://weather.mukoko.com)
- **Issues:** [GitHub Issues](https://github.com/nyuchitech/mukoko-weather/issues)
- **Twitter:** [@mukokoafrica](https://twitter.com/mukokoafrica)
- **Instagram:** [@mukoko.africa](https://instagram.com/mukoko.africa)
- **Support:** [support@mukoko.com](mailto:support@mukoko.com)
- **General:** [hi@mukoko.com](mailto:hi@mukoko.com)
- **Legal:** [legal@nyuchi.com](mailto:legal@nyuchi.com)
- **Built by:** [Nyuchi Web Services](https://nyuchi.com) / [Nyuchi Africa (PVT) Ltd](https://nyuchi.com)
