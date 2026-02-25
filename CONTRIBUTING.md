# Contributing to mukoko weather

Thank you for your interest in contributing to mukoko weather. This project provides free weather intelligence starting with Zimbabwe and expanding globally across ASEAN countries and developing regions. Contributions from the community help us serve more people.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/<your-username>/mukoko-weather.git`
3. Install dependencies: `npm install`
4. Create a feature branch: `git checkout -b feature/your-feature`
5. Start the dev server: `npm run dev`

## Development Workflow

### Branch Naming

- `feature/` — new features
- `fix/` — bug fixes
- `docs/` — documentation updates
- `refactor/` — code improvements without behavior changes
- `perf/` — performance improvements

### Code Standards

- **TypeScript** — all frontend code must be typed; run `npx tsc --noEmit` before committing
- **Python** — backend API code lives in `api/py/` (FastAPI); follow existing patterns for new endpoints
- **ESLint** — run `npm run lint` before committing; zero errors required (warnings acceptable)
- **Tests** — run `npm test` and ensure all tests pass
- **No hardcoded styles** — use Tailwind classes and CSS custom properties from `globals.css`, never inline `style={{}}` or hardcoded hex/rgba values
- **shadcn/ui components** — use the existing `src/components/ui/` primitives (Button, Badge, Dialog, Input, Tabs, Card, Chart) instead of writing custom equivalents
- **Accessibility** — all UI changes must maintain WCAG 3.0 APCA/AAA compliance
- **Mobile-first** — design for mobile screens first, then scale up
- **44px touch targets** — all interactive elements must meet the minimum touch target size

### Commit Messages

Use conventional commits:

```
feat: add Masvingo farming forecast tips
fix: correct frost detection for sub-zero temps
docs: update README with API documentation
test: add season detection unit tests
perf: lazy-load atmospheric charts on scroll
refactor: replace custom modal with shadcn Dialog
```

### Testing

```bash
npm test              # Run TypeScript tests (single run)
npm run test:watch    # Run TypeScript tests in watch mode
npm run test:coverage # Run TypeScript tests with v8 coverage reporting
npm run test:python   # Run Python backend tests (pytest)
npm run test:all      # Run both TypeScript and Python tests
python -m pytest tests/py/ -v  # Run Python backend tests (direct)
```

Write tests for:
- All utility functions in `src/lib/`
- New location data (validate slugs, coordinates, province)
- CSS class mappings (e.g. frost severity to design tokens)
- Component contracts (e.g. embed widget uses CSS module, no inline styles)
- API route input validation and prompt configuration
- SEO metadata generation

Tests live next to the code they test (co-located). Use the `describe`/`it`/`expect` pattern.

## Architecture Guidelines

### Frontend / backend split

Next.js serves as the **presentation layer only**. All data handling, AI operations, database CRUD, and rule evaluation run in **Python FastAPI** (`api/py/`), deployed as Vercel serverless functions. Routes are proxied via `vercel.json` rewrites (`/api/py/*` → `api/py/index.py`).

Only two TypeScript API routes remain:
- `/api/og` — dynamic OG image generation (Edge runtime, Satori)
- `/api/db-init` — one-time DB setup + seed data

### Page structure

The main location page (`/[location]`) is a compact overview. Detail-heavy features belong on **sub-route pages**:

- `/[location]/atmosphere` — atmospheric detail charts
- `/[location]/forecast` — hourly + daily forecast charts
- `/[location]/map` — full-viewport interactive weather map

Do not add heavy chart sections or data-intensive components directly to the main location page. Create a sub-route instead.

### Layered component architecture

Every component follows a strict layered architecture (bottom to top):

1. **Shared base** — `TimeSeriesChart`, `CanvasChart`, `StatCard`
2. **Domain-specific** — `HourlyChart`, `PressureChart`, `AISummary`
3. **Dashboard orchestrators** — `WeatherDashboard`, `HistoryDashboard`
4. **Isolation wrappers** — `LazySection` + `ChartErrorBoundary` per section
5. **Server page wrappers** — `page.tsx` (SEO, data fetching, error boundaries)

Components import from the layer below, never sideways or upward.

### Error handling

Follow the Netflix-style resilience pattern:

1. **Never let a component crash the page.** Wrap chart/data sections in `ChartErrorBoundary`
2. **Always provide fallbacks.** Server-side data fetching must catch errors and return seasonal estimates
3. **Log structured errors.** Use `logError`/`logWarn` from `src/lib/observability.ts` in API routes
4. **Report client-side errors.** Use `reportErrorToAnalytics` from `src/lib/observability.ts` in error boundaries
5. **Use circuit breakers.** External API calls in Python should use the circuit breaker system (`api/py/_circuit_breaker.py`)

### Lazy loading

Use `LazySection` from `src/components/weather/LazySection.tsx` for any section below the fold. Only the first visible section should load eagerly. Sections unmount when scrolled far off-screen (bidirectional) to reclaim memory.

### Styling

- All colors come from CSS custom properties in `src/app/globals.css`
- Category-specific colors use `CATEGORY_STYLES` from `src/lib/activities.ts`
- Severity/status indicators use `--color-severity-*` tokens, not generic Tailwind colors
- New color tokens must be added to both `:root` (light) and `[data-theme="dark"]` (dark) blocks, and registered in the `@theme` block
- The embed widget uses a CSS module — never use Tailwind or inline styles there

## Adding a New Location

### Seed locations (code)

1. Add the location to `src/lib/locations.ts` in the `LOCATIONS` array
2. Include: `slug`, `name`, `province`, `lat`, `lon`, `elevation`, `tags`, and optionally `country` (ISO alpha-2, defaults to `"ZW"`)
3. Tags: `city`, `farming`, `mining`, `tourism`, `education`, `border`, `travel`, `national-park`
4. Verify coordinates are within a supported region (`isInSupportedRegion` in `locations.ts`)
5. Run the test suite to ensure no regressions
6. Run `POST /api/db-init` to sync locations to MongoDB

### Community locations (dynamic)

Users can add locations at runtime via geolocation auto-detection, search, or coordinates — no code change needed. These are stored in MongoDB and immediately available.

## Pre-Commit Checklist

Before every commit, complete **all** of these steps:

1. `npm test` — all TypeScript tests pass
2. `python -m pytest tests/py/ -v` — all Python tests pass
3. `npm run lint` — zero errors
4. `npx tsc --noEmit` — zero type errors
5. `npm run build` — production build succeeds
6. Add/update tests for any new or changed behaviour
7. Update docs (README.md, CLAUDE.md, CONTRIBUTING.md) if your change affects APIs, structure, dependencies, styling, or workflow
8. Verify no hardcoded styles (hex colors, rgba, inline style objects) in components
9. Verify new components follow the layered architecture (error boundary, lazy loading, skeleton, accessibility)

## Migration Notes

### Atlas Search Indexes (post-deploy)

If your deployment already has Atlas Search indexes (`location_search`, `activity_search`) created before the analyzer name fix (`luceneStandard` → `lucene.standard`), you must drop and recreate them:

1. Delete the existing `location_search` and `activity_search` indexes in Atlas
2. Run `POST /api/db-init` to recreate them with the correct analyzer names

The old analyzer names may have silently fallen through to Atlas defaults — the corrected names ensure explicit, deterministic tokenization.

## Pull Request Process

1. Complete the Pre-Commit Checklist above
2. Ensure the build succeeds: `npm run build`
3. Submit a PR with a clear description of the change and why it's needed
4. PRs are automatically reviewed by Claude AI and checked by CI — a single `ci` job runs lint → typecheck → TypeScript tests → Python tests, all visible as named steps in one check
5. On merge to `main`, the `db-init.yml` workflow automatically syncs seed data to MongoDB after Vercel deploys
6. Address any review feedback before requesting merge

## GitHub Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | Push/PR to `main` | Single job with 4 sequential steps: lint → typecheck → TypeScript tests → Python tests. All steps appear under one check in the GitHub PR UI. |
| `claude-code-review.yml` | PR opened/updated | Claude AI reviews code quality, security, accessibility |
| `claude.yml` | `@claude` mention in issues/PRs | Claude Code responds to requests in issues and PR comments |
| `db-init.yml` | Vercel production deploy succeeds | Syncs seed data to MongoDB (locations, activities, rules, prompts) |

## Reporting Issues

Use the [GitHub Issues](https://github.com/nyuchitech/mukoko-weather/issues) page. We have templates for:
- **Bug reports** — include the affected location/page, device info, and steps to reproduce
- **Feature requests** — describe the problem, proposed solution, and which category it relates to

For security vulnerabilities, email **legal@nyuchi.com** — do not open a public issue.

## Code of Conduct

Be respectful, inclusive, and constructive. We build with Ubuntu philosophy — weather is a public good, and so is a welcoming community.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
