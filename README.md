# mukoko weather

AI-powered weather intelligence for Zimbabwe. Accurate forecasts, frost alerts, and actionable insights for farming, mining, travel, and daily life across 90+ locations.

**Live:** [weather.mukoko.com](https://weather.mukoko.com)

## Features

- **Real-time weather** — current conditions from Open-Meteo for any Zimbabwe location
- **7-day forecasts** — daily highs, lows, precipitation probability, and weather conditions
- **24-hour hourly forecasts** — hour-by-hour temperature and rain predictions
- **AI weather intelligence** — Claude-powered contextual summaries with farming, mining, and travel advice
- **Frost alerts** — automated frost risk detection for overnight hours with severity levels
- **90+ locations** — cities, farming regions, mining areas, national parks, border posts, and travel corridors
- **Zimbabwe seasons** — Masika, Chirimo, Zhizha, and Munakamwe season awareness
- **Geolocation** — automatic nearest-location detection via browser GPS
- **Embeddable widget** — drop-in weather widget for third-party sites
- **Dark mode** — full light/dark theme support
- **PWA** — installable as a standalone app on Android, iOS, and desktop

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | [Next.js 16](https://nextjs.org) (App Router) |
| Language | TypeScript 5 |
| Styling | [Tailwind CSS 4](https://tailwindcss.com) |
| State | [Zustand 5](https://zustand.docs.pmnd.rs) |
| AI | [Anthropic Claude SDK](https://docs.anthropic.com/en/docs) |
| Weather API | [Open-Meteo](https://open-meteo.com) |
| Testing | [Vitest](https://vitest.dev) |
| Deployment | Cloudflare Pages + Workers |

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
| `ANTHROPIC_API_KEY` | No | Anthropic API key for AI weather summaries. Without it, a basic fallback summary is generated. |

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
    globals.css             # Brand system v7 (WCAG 3.0 APCA compliant)
    robots.ts               # Dynamic robots.txt
    sitemap.ts              # Dynamic sitemap for 90+ locations
    [location]/
      page.tsx              # Dynamic weather page per location
      loading.tsx           # Skeleton loading state
      not-found.tsx         # 404 with location suggestions
      FrostAlertBanner.tsx  # Frost risk alert component
    api/
      weather/route.ts      # GET /api/weather?lat=&lon=
      geo/route.ts          # GET /api/geo?lat=&lon=
      ai/route.ts           # POST /api/ai
    embed/
      page.tsx              # Embeddable widget documentation
  components/
    brand/                  # MukokoLogo, ThemeToggle, ThemeProvider, FlagStrip
    layout/                 # Header, Footer
    weather/                # CurrentConditions, HourlyForecast, DailyForecast,
                            # SunTimes, SeasonBadge, AISummary, LocationSelector
  lib/
    locations.ts            # 90+ Zimbabwe locations database
    weather.ts              # Open-Meteo client, frost detection, seasons
    geolocation.ts          # Browser geolocation detection
    kv-cache.ts             # Cloudflare KV caching layer
    store.ts                # Zustand state management
    weather-icons.tsx        # SVG weather icon components
  types/
    cloudflare.d.ts         # KVNamespace type definitions
public/
  manifest.json             # PWA manifest with app shortcuts
  icons/                    # PWA icons (192x192, 512x512)
```

## API

### `GET /api/weather?lat=-17.83&lon=31.05`

Returns Open-Meteo weather data for the given coordinates. Coordinates must be within the Zimbabwe region.

### `GET /api/geo?lat=-17.83&lon=31.05`

Returns the nearest Zimbabwe location to the given coordinates.

### `POST /api/ai`

Generates an AI weather summary. Body: `{ weatherData, location }`.

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
