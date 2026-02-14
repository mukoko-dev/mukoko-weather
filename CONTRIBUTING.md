# Contributing to mukoko weather

Thank you for your interest in contributing to mukoko weather. This project provides free weather intelligence for Zimbabwe, and contributions from the community help us serve more people.

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

- **TypeScript** — all code must be typed; run `npx tsc --noEmit` before committing
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
npm test           # Run all tests (single run)
npm run test:watch # Run tests in watch mode
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

### Page structure

The main location page (`/[location]`) is a compact overview. Detail-heavy features belong on **sub-route pages**:

- `/[location]/atmosphere` — atmospheric detail charts
- `/[location]/forecast` — hourly + daily forecast charts

Do not add heavy chart sections or data-intensive components directly to the main location page. Create a sub-route instead.

### Error handling

Follow the Netflix-style resilience pattern:

1. **Never let a component crash the page.** Wrap chart/data sections in `ChartErrorBoundary`
2. **Always provide fallbacks.** Server-side data fetching must catch errors and return seasonal estimates
3. **Log structured errors.** Use `logError`/`logWarn` from `src/lib/observability.ts` in API routes
4. **Report client-side errors.** Use `reportErrorToAnalytics` from `src/lib/observability.ts` in error boundaries

### Lazy loading

Use `LazySection` from `src/components/weather/LazySection.tsx` for any section below the fold. Only the first visible section should load eagerly.

### Styling

- All colors come from CSS custom properties in `src/app/globals.css`
- Category-specific colors use `CATEGORY_STYLES` from `src/lib/activities.ts`
- New color tokens must be added to both `:root` (light) and `[data-theme="dark"]` (dark) blocks, and registered in the `@theme` block
- The embed widget uses a CSS module — never use Tailwind or inline styles there

## Adding a New Location

1. Add the location to `src/lib/locations.ts` in the `LOCATIONS` array
2. Include: `slug`, `name`, `province`, `lat`, `lon`, `elevation`, and `tags`
3. Tags: `city`, `farming`, `mining`, `tourism`, `education`, `border`, `travel`, `national-park`
4. Verify coordinates are within Zimbabwe bounds
5. Run the test suite to ensure no regressions
6. Run `POST /api/db-init` to sync locations to MongoDB

## Pre-Commit Checklist

Before every commit, complete **all** of these steps:

1. `npm test` — all tests pass
2. `npm run lint` — zero errors
3. `npx tsc --noEmit` — zero type errors
4. Add/update tests for any new or changed behaviour
5. Update docs (README.md, CLAUDE.md, CONTRIBUTING.md) if your change affects APIs, structure, dependencies, styling, or workflow
6. Verify no hardcoded styles (hex colors, rgba, inline style objects) in components

## Pull Request Process

1. Complete the Pre-Commit Checklist above
2. Ensure the build succeeds: `npm run build`
3. Submit a PR with a clear description of the change and why it's needed
4. PRs are automatically reviewed by Claude AI and checked by CI (tests + lint + typecheck)
5. Address any review feedback before requesting merge

## Reporting Issues

Use the [GitHub Issues](https://github.com/nyuchitech/mukoko-weather/issues) page. We have templates for:
- **Bug reports** — include the affected location, device info, and steps to reproduce
- **Feature requests** — describe the problem, proposed solution, and which category it relates to

## Code of Conduct

Be respectful, inclusive, and constructive. We build with Ubuntu philosophy — weather is a public good, and so is a welcoming community.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
