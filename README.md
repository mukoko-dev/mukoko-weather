# mukoko weather

AI-powered weather intelligence, starting with Zimbabwe and expanding globally. Accurate forecasts, frost alerts, and actionable insights for farming, mining, travel, and daily life across Zimbabwe, ASEAN countries, and developing regions.

**Live:** [weather.mukoko.com](https://weather.mukoko.com)

## Features

- **Real-time weather** — current conditions from Tomorrow.io (primary) with Open-Meteo fallback
- **7-day forecasts** — daily highs, lows, precipitation probability, and weather conditions
- **24-hour hourly forecasts** — hour-by-hour temperature and rain predictions
- **AI weather intelligence** — Claude-powered markdown-formatted summaries with farming, mining, and travel advice
- **Personalised activity insights** — 20 activities across 6 categories (farming, mining, travel, tourism, sports, casual) with mineral-colored cards showing GDD, heat stress, thunderstorm risk, visibility, and more
- **Frost alerts** — automated frost risk detection for overnight hours with severity levels
- **Dynamic locations** — 90+ seed locations in Zimbabwe, with community-driven expansion to ASEAN and developing regions via geolocation and search
- **Seasonal awareness** — Zimbabwe seasons (Masika, Chirimo, Zhizha, Munakamwe) and regional context
- **Geolocation** — automatic nearest-location detection via browser GPS, with auto-creation for new areas
- **Shamwari AI chat** — dedicated `/shamwari` page with full-viewport Claude app-style chat (search locations, check weather, get activity advice, compare cities)
- **Suitability scoring** — database-driven weather suitability evaluation for activities (excellent/good/fair/poor ratings with structured metrics)
- **Country/region browse** — explore locations by country, province, and tag across 64 countries (54 AU + ASEAN)
- **System status** — live health dashboard for all services (MongoDB, weather APIs, AI, cache)
- **Embeddable widget** — drop-in weather widget for third-party sites
- **Dedicated detail pages** — `/harare/atmosphere` for 24h atmospheric charts, `/harare/forecast` for hourly + daily forecast detail, `/harare/map` for full-viewport interactive weather map
- **Smart theming** — light, dark, and system (auto) modes with OS preference detection
- **Historical data dashboard** — explore recorded weather trends, precipitation, and climate patterns over time
- **Resilient architecture** — Netflix-style error isolation: per-section error boundaries, 4-stage weather fallback chain, structured observability logging
- **PWA** — installable as a standalone app on Android, iOS, and desktop

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | [Next.js 16](https://nextjs.org) (App Router, TypeScript 5) |
| UI Components | [shadcn/ui](https://ui.shadcn.com) (Radix UI + CVA) |
| Charts | [Chart.js 4](https://www.chartjs.org) + [react-chartjs-2](https://react-chartjs-2.js.org) (Canvas 2D) |
| Maps | [Leaflet](https://leafletjs.com) + [react-leaflet](https://react-leaflet.js.org) (Tomorrow.io tile overlays) |
| Styling | [Tailwind CSS 4](https://tailwindcss.com) with CSS custom properties |
| Markdown | [react-markdown 10](https://github.com/remarkjs/react-markdown) |
| State | [Zustand 5](https://zustand.docs.pmnd.rs) with `persist` middleware |
| AI | [Anthropic Claude SDK](https://docs.anthropic.com/en/docs) (server-side only) |
| Weather API | [Tomorrow.io](https://tomorrow.io) (primary) + [Open-Meteo](https://open-meteo.com) (fallback) |
| Database | [MongoDB Atlas](https://mongodb.com/atlas) (cache, AI summaries, history, locations; Atlas Search for fuzzy queries) |
| Analytics | [Google Analytics 4](https://analytics.google.com) |
| Testing | [Vitest](https://vitest.dev) |
| CI/CD | [GitHub Actions](https://github.com/features/actions) (tests + lint + typecheck on push/PR) |
| Deployment | [Vercel](https://vercel.com) |

## Getting Started

### Prerequisites

- Node.js 18+
- npm 9+

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
npm run dev        # Start dev server (http://localhost:3000)
npm run build      # Production build
npm start          # Start production server
npm test           # Run Vitest tests (single run)
npm run test:watch # Run Vitest in watch mode
npm run lint       # ESLint
npx tsc --noEmit   # Type check
```

The app redirects `/` to `/harare` by default.

## Architecture

### Routes

| Route | Description |
|-------|-------------|
| `/` | Redirects to `/harare` |
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

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/weather?lat=&lon=` | GET | Weather data (Tomorrow.io → Open-Meteo fallback, MongoDB cached 15-min TTL). `X-Weather-Provider` header indicates source |
| `/api/ai` | POST | AI weather summary. Body: `{ weatherData, location }`. Tiered TTL cache (30/60/120 min) |
| `/api/explore` | POST | Shamwari Explorer chatbot. Body: `{ message, history }`. Rate-limited 20 req/hour/IP |
| `/api/search?q=&tag=&lat=&lon=` | GET | Location search (text, tag filter, geospatial nearest) |
| `/api/geo?lat=&lon=` | GET | Nearest location lookup (supports `autoCreate=true` for community locations) |
| `/api/locations` | GET | List/filter locations (by slug, tag, all, or stats mode) |
| `/api/locations/add` | POST | Add locations via search (`{ query }`) or coordinates (`{ lat, lon }`). Rate-limited |
| `/api/activities` | GET | Activities (by id, category, search, labels, or categories mode) |
| `/api/suitability` | GET | Suitability rules (all or by key; key format validated) |
| `/api/tags` | GET | Tag metadata (all or featured) |
| `/api/regions` | GET | Active supported regions (bounding boxes) |
| `/api/status` | GET | System health checks (MongoDB, APIs, cache) |
| `/api/history?location=&days=` | GET | Historical weather data for a location |
| `/api/map-tiles?z=&x=&y=&layer=` | GET | Tile proxy for Tomorrow.io map layers (keeps API key server-side) |
| `/api/db-init` | POST | One-time DB setup + seed data. Protected by `DB_INIT_SECRET` in production |

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
    page.tsx                # Home — redirects to /harare
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
    api/
      weather/route.ts      # GET — Tomorrow.io/Open-Meteo proxy + MongoDB cache
      ai/route.ts           # POST — AI summaries (Claude Haiku 3.5, markdown-formatted)
      explore/route.ts      # POST — Shamwari Explorer chatbot (Claude + tool use)
      search/route.ts       # GET — location search (text, tag, geo queries)
      geo/route.ts          # GET — nearest location lookup (supports autoCreate)
      locations/route.ts    # GET — list/filter locations from MongoDB
      locations/add/route.ts # POST — add locations via search or coordinates
      activities/route.ts   # GET — activities (by ID, category, search, labels)
      suitability/route.ts  # GET — suitability rules from MongoDB
      tags/route.ts         # GET — tag metadata (all or featured)
      regions/route.ts      # GET — active supported regions
      status/route.ts       # GET — system health checks
      history/route.ts      # GET — historical weather data
      map-tiles/route.ts    # GET — tile proxy for Tomorrow.io map layers
      db-init/route.ts      # POST — one-time DB setup + seed data
  components/
    ui/                     # shadcn/ui primitives (button, badge, card, chart, dialog, input, skeleton, tabs)
    analytics/              # Google Analytics 4
    brand/                  # Logo, MineralsStripe, ThemeProvider, ThemeToggle
    explore/                # ExploreChatbot (AI chat UI, typing indicator, suggested prompts)
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
      MyWeatherModal.tsx     # Centralized preferences modal
      AISummary.tsx          # Shamwari AI markdown summary
      ActivityInsights.tsx   # Category-specific weather insight cards
      charts/                # Reusable Canvas chart components (15 charts)
      map/                   # Leaflet map (preview, full, layer switcher, skeleton)
    embed/
      MukokoWeatherEmbed.tsx # Embeddable widget (CSS module, self-contained)
  lib/
    locations.ts            # WeatherLocation type, 90+ ZW seed locations, SUPPORTED_REGIONS
    locations-africa.ts     # African city seed data (54 AU member states)
    countries.ts            # Country/province types, 64 seed countries, flag emoji
    activities.ts           # 20 activities, 6 categories, mineral color styles
    suitability.ts          # Database-driven suitability evaluation engine (evaluateRule)
    suitability-cache.ts    # Client-side cache for suitability rules + category styles
    tomorrow.ts             # Tomorrow.io API client + WMO normalization
    weather.ts              # Open-Meteo client, frost detection, seasons, weather utils
    weather-labels.ts       # Contextual label helpers (humidity, pressure, cloud, feels-like)
    db.ts                   # MongoDB CRUD + Atlas Search/Vector Search (12 collections)
    geocoding.ts            # Nominatim + Open-Meteo geocoding, slug generation
    rate-limit.ts           # MongoDB-backed IP rate limiter
    mongo.ts                # MongoDB client (connection-pooled via @vercel/functions)
    circuit-breaker.ts      # Netflix Hystrix-inspired circuit breaker
    observability.ts        # Structured error logging + GA4 error reporting
    store.ts                # Zustand state (theme, activities, location)
    geolocation.ts          # Browser Geolocation API wrapper
    weather-icons.tsx       # SVG weather + activity icon components
    i18n.ts                 # Lightweight i18n (en complete, sn/nd ready)
    error-retry.ts          # Error retry with sessionStorage tracking
    utils.ts                # Tailwind class merging (cn)
    seed-*.ts               # Seed data files (categories, tags, regions, seasons, suitability rules)
public/
  manifest.json             # PWA manifest with app shortcuts
  icons/                    # PWA icons (192x192, 512x512)
.github/
  ISSUE_TEMPLATE/           # Bug report and feature request templates (YAML forms)
  workflows/
    ci.yml                  # Tests, lint, type check on push/PR
    claude-review.yml       # Claude AI code review on PRs
```

## Accessibility

This app targets **WCAG 3.0 APCA/AAA** compliance:

- APCA-verified color contrast (Lc 106/78/62 for primary/secondary/tertiary text)
- Skip-to-main-content link
- 3px focus-visible outlines with theme-aware colors
- `prefers-reduced-motion` support (disables all animations)
- `prefers-contrast: more` support (maximum contrast overrides)
- Windows High Contrast / `forced-colors` support
- Semantic HTML with proper heading hierarchy and ARIA landmarks
- Keyboard-navigable location selector with Escape key support
- Minimum 44px touch targets for mobile

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
