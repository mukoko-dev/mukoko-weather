# mukoko weather

AI-powered weather intelligence for Zimbabwe. Accurate forecasts, frost alerts, and actionable insights for farming, mining, travel, and daily life across 90+ locations.

**Live:** [weather.mukoko.com](https://weather.mukoko.com)

## Features

- **Real-time weather** — current conditions from Tomorrow.io (primary) with Open-Meteo fallback
- **7-day forecasts** — daily highs, lows, precipitation probability, and weather conditions
- **24-hour hourly forecasts** — hour-by-hour temperature and rain predictions
- **AI weather intelligence** — Claude-powered markdown-formatted summaries with farming, mining, and travel advice
- **Personalised activity insights** — 20 activities across 6 categories (farming, mining, travel, tourism, sports, casual) with mineral-colored cards showing GDD, heat stress, thunderstorm risk, visibility, and more
- **Frost alerts** — automated frost risk detection for overnight hours with severity levels
- **90+ locations** — cities, farming regions, mining areas, national parks, border posts, and travel corridors
- **Zimbabwe seasons** — Masika, Chirimo, Zhizha, and Munakamwe season awareness
- **Geolocation** — automatic nearest-location detection via browser GPS
- **Embeddable widget** — drop-in weather widget for third-party sites
- **Dedicated detail pages** — `/harare/atmosphere` for 24h atmospheric charts, `/harare/forecast` for hourly + daily forecast detail
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
| Database | [MongoDB Atlas](https://mongodb.com/atlas) (cache, AI summaries, history, locations) |
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
| `/api/geo?lat=&lon=` | GET | Nearest Zimbabwe location lookup |
| `/api/ai` | POST | AI weather summary. Body: `{ weatherData, location }`. Tiered TTL cache (30/60/120 min) |
| `/api/history?location=&days=` | GET | Historical weather data for a location |
| `/api/map-tiles?z=&x=&y=&layer=` | GET | Tile proxy for Tomorrow.io map layers (keeps API key server-side) |
| `/api/db-init` | POST | One-time DB setup + optional API key seeding. Protected by `DB_INIT_SECRET` in production |

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
        page.tsx            # Server wrapper (SEO, data fetch)
        AtmosphereDashboard.tsx  # Client: atmospheric charts
        loading.tsx         # Branded skeleton
      forecast/             # Hourly + daily forecast detail sub-route
        page.tsx            # Server wrapper (SEO, data fetch)
        ForecastDashboard.tsx  # Client: forecast charts + sun times
        loading.tsx         # Branded skeleton
    about/page.tsx          # Company info page
    help/page.tsx           # User help / FAQ
    history/
      page.tsx              # Historical data page (metadata, layout)
      HistoryDashboard.tsx  # Client: search, 7 charts, stats, data table
      error.tsx             # History page error boundary
    privacy/page.tsx        # Privacy policy
    terms/page.tsx          # Terms of service
    embed/page.tsx          # Embeddable widget documentation
    api/
      weather/route.ts      # GET — Tomorrow.io/Open-Meteo proxy + MongoDB cache
      geo/route.ts          # GET — nearest location lookup
      ai/route.ts           # POST — AI summaries (Claude, markdown-formatted)
      history/route.ts      # GET — historical weather data
      db-init/route.ts      # POST — one-time DB setup + API key seeding
  components/
    ui/                     # shadcn/ui primitives
      button.tsx            # Button (6 variants, 5 sizes, asChild support)
      badge.tsx             # Badge (4 variants)
      card.tsx              # Card, CardHeader, CardContent, etc.
      chart.tsx             # CanvasChart, resolveColor (wraps Chart.js Canvas 2D)
      dialog.tsx            # Dialog (Radix, portal, overlay, animations)
      input.tsx             # Input (CSS custom property styled)
      tabs.tsx              # Tabs (Radix, border-bottom active indicator)
    analytics/
      GoogleAnalytics.tsx   # GA4 integration via next/script
    brand/
      MukokoLogo.tsx        # Logo with text fallback
      MineralsStripe.tsx    # 5-mineral decorative stripe
      ThemeProvider.tsx     # Syncs Zustand theme to document
      ThemeToggle.tsx       # Light/dark/system mode toggle (3-state cycle)
    layout/
      Header.tsx            # Sticky header, pill icon group, My Weather modal trigger
      Footer.tsx            # Footer with site stats, copyright, Ubuntu philosophy
    weather/
      CurrentConditions.tsx  # Large temp display, feels-like, stats grid
      HourlyForecast.tsx     # 24-hour hourly forecast
      HourlyChart.tsx        # Area chart: temperature + rain over 24h
      DailyForecast.tsx      # 7-day forecast cards
      DailyChart.tsx         # Area chart: high/low temps over 7 days
      AtmosphericSummary.tsx # 2x3 compact metric cards (humidity, wind, pressure, UV, cloud, feels-like)
      AtmosphericDetails.tsx # 4x 24h atmospheric charts (used by atmosphere sub-route + history)
      LazySection.tsx        # IntersectionObserver lazy-load wrapper
      ChartErrorBoundary.tsx # Error boundary for chart crash isolation
      MyWeatherModal.tsx     # Centralized preferences modal (location, activities, settings)
      AISummary.tsx          # Shamwari AI markdown summary
      ActivityInsights.tsx   # Category-specific weather insight cards
      SeasonBadge.tsx        # Zimbabwe season indicator
      SunTimes.tsx           # Sunrise/sunset display
      LocationSelector.tsx   # Search/filter dropdown, geolocation
    map/                     # Interactive weather map (Leaflet + Tomorrow.io tiles)
      MapPreview.tsx         # Compact map card on location page
      MapModal.tsx           # Full-screen map dialog with layer switcher
      MapLayerSwitcher.tsx   # Layer toggle buttons
    embed/
      MukokoWeatherEmbed.tsx # Embeddable widget (CSS module, self-contained)
  lib/
    locations.ts            # 90+ Zimbabwe locations database
    activities.ts           # 20 activities, 6 categories, mineral color styles
    tomorrow.ts             # Tomorrow.io API client + WMO normalization
    weather.ts              # Open-Meteo client, frost detection, seasons, weather utils
    db.ts                   # MongoDB CRUD (weather_cache, ai_summaries, weather_history, locations, api_keys)
    mongo.ts                # MongoDB client (connection-pooled via @vercel/functions)
    observability.ts        # Structured error logging + GA4 error reporting
    store.ts                # Zustand state with localStorage persistence (theme, activities)
    geolocation.ts          # Browser Geolocation API wrapper
    weather-icons.tsx       # SVG weather + activity icon components
    i18n.ts                 # Lightweight i18n (en complete, sn/nd structurally ready)
    utils.ts                # Tailwind class merging helper (cn)
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

- Dynamic `robots.txt` and `sitemap.xml` for all 90+ locations and sub-routes
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
