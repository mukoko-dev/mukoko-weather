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
- **Smart theming** — light, dark, and system (auto) modes with OS preference detection
- **Historical data dashboard** — explore recorded weather trends, precipitation, and climate patterns over time
- **PWA** — installable as a standalone app on Android, iOS, and desktop

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | [Next.js 16](https://nextjs.org) (App Router) |
| Language | TypeScript 5 |
| Styling | [Tailwind CSS 4](https://tailwindcss.com) |
| State | [Zustand 5](https://zustand.docs.pmnd.rs) |
| AI | [Anthropic Claude SDK](https://docs.anthropic.com/en/docs) |
| Weather API | [Tomorrow.io](https://tomorrow.io) (primary) + [Open-Meteo](https://open-meteo.com) (fallback) |
| Database | [MongoDB Atlas](https://mongodb.com/atlas) |
| Markdown | [react-markdown](https://github.com/remarkjs/react-markdown) |
| Analytics | [Google Analytics 4](https://analytics.google.com) |
| Testing | [Vitest](https://vitest.dev) |
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

### Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The app redirects to `/harare` by default.

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MONGODB_URI` | Yes | MongoDB Atlas connection string for caching and data storage. |
| `ANTHROPIC_API_KEY` | No | Anthropic API key for AI weather summaries. Without it, a basic fallback summary is generated. |
| `DB_INIT_SECRET` | No | Protects the `/api/db-init` endpoint in production. |

### Build

```bash
npm run build
npm start
```

### Testing

```bash
npm test
```

## Project Structure

```
src/
  app/
    layout.tsx              # Root layout, metadata, JSON-LD schemas
    page.tsx                # Home — redirects to /harare
    globals.css             # Brand System v6 (WCAG 3.0 APCA compliant)
    robots.ts               # Dynamic robots.txt
    sitemap.ts              # Dynamic sitemap for 90+ locations
    [location]/
      page.tsx              # Dynamic weather page per location
      loading.tsx           # Skeleton loading state
      not-found.tsx         # 404 with location suggestions
      FrostAlertBanner.tsx  # Frost risk alert (design-system tokens)
    api/
      weather/route.ts      # GET /api/weather — Open-Meteo proxy + MongoDB cache
      geo/route.ts          # GET /api/geo — nearest location lookup
      ai/route.ts           # POST /api/ai — AI summaries (markdown-formatted)
      history/route.ts      # GET /api/history — historical weather data
      db-init/route.ts      # POST /api/db-init — one-time DB setup
    about/page.tsx          # Company info page
    embed/page.tsx          # Embeddable widget documentation
    help/page.tsx           # User help/FAQ
    history/                # Historical weather data dashboard
      page.tsx              # Page metadata and layout
      HistoryDashboard.tsx  # Client-side search, charts, and data table
    privacy/page.tsx        # Privacy policy
    terms/page.tsx          # Terms of service
  components/
    analytics/              # Google Analytics 4 integration
    brand/                  # MukokoLogo, ThemeToggle (3-state), ThemeProvider, MineralsStripe
    layout/                 # Header (pill icon group + My Weather modal), Footer
    weather/                # CurrentConditions, HourlyForecast, DailyForecast,
                            # SunTimes, SeasonBadge, AISummary, LocationSelector,
                            # MyWeatherModal, ActivityInsights, LazySection
    embed/                  # MukokoWeatherEmbed (CSS module, self-contained)
  lib/
    locations.ts            # 90+ Zimbabwe locations database
    activities.ts           # 20 activities, 6 categories, mineral color styles
    tomorrow.ts             # Tomorrow.io API client + WMO normalization
    weather.ts              # Open-Meteo client, frost detection, seasons
    db.ts                   # MongoDB CRUD operations (+ API key storage)
    mongo.ts                # MongoDB client (connection-pooled)
    geolocation.ts          # Browser geolocation detection
    store.ts                # Zustand state with localStorage persistence (theme, activities)
    weather-icons.tsx       # SVG weather + activity icon components
    i18n.ts                 # Internationalization utilities
public/
  manifest.json             # PWA manifest with app shortcuts
  icons/                    # PWA icons (192x192, 512x512)
```

## API

### `GET /api/weather?lat=-17.83&lon=31.05`

Returns weather data for the given coordinates. Uses Tomorrow.io as primary provider (with extended activity insights) and falls back to Open-Meteo. The `X-Weather-Provider` header indicates which provider served the data. Responses are cached in MongoDB. Coordinates must be within the Zimbabwe region.

### `GET /api/geo?lat=-17.83&lon=31.05`

Returns the nearest Zimbabwe location to the given coordinates.

### `POST /api/ai`

Generates a markdown-formatted AI weather summary. Body: `{ weatherData, location }`. Responses are cached in MongoDB with tiered TTL (30–120 min based on location tier).

### `GET /api/history?location=harare&days=30`

Returns historical weather data for a location.

### `POST /api/db-init`

One-time database setup: creates indexes and syncs location data to MongoDB. Optionally seeds API keys via body `{ "apiKeys": { "tomorrow": "..." } }`. Protected by `DB_INIT_SECRET` in production.

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

- Dynamic `robots.txt` and `sitemap.xml` for all 90+ locations
- Per-page canonical URLs, Open Graph, and Twitter cards
- FAQPage, BreadcrumbList, WebApplication, Organization, and WebSite JSON-LD schemas
- Visible breadcrumb navigation
- Semantic H1 on every location page

## Company

**mukoko weather** is a product of **Mukoko Africa**, a division of **Nyuchi Africa (PVT) Ltd**. Developed by **Nyuchi Web Services**.

## License

[MIT](LICENSE) — Nyuchi Africa (PVT) Ltd

## Links

- **Website:** [weather.mukoko.com](https://weather.mukoko.com)
- **Twitter:** [@mukokoafrica](https://twitter.com/mukokoafrica)
- **Instagram:** [@mukoko.africa](https://instagram.com/mukoko.africa)
- **Support:** [support@mukoko.com](mailto:support@mukoko.com)
- **General:** [hi@mukoko.com](mailto:hi@mukoko.com)
- **Legal:** [legal@nyuchi.com](mailto:legal@nyuchi.com)
- **Built by:** [Nyuchi Web Services](https://nyuchi.com) / [Nyuchi Africa (PVT) Ltd](https://nyuchi.com)
