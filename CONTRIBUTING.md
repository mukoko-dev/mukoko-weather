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

### Code Standards

- **TypeScript** — all code must be typed
- **ESLint** — run `npm run lint` before committing
- **Tests** — run `npm test` and ensure all tests pass
- **No hardcoded styles** — use Tailwind classes and CSS custom properties from `globals.css`, never inline `style={{}}` or hardcoded hex/rgba values in components
- **Accessibility** — all UI changes must maintain WCAG 3.0 APCA/AAA compliance
- **Mobile-first** — design for mobile screens first, then scale up

### Commit Messages

Use conventional commits:

```
feat: add Masvingo farming forecast tips
fix: correct frost detection for sub-zero temps
docs: update README with API documentation
test: add season detection unit tests
```

### Testing

```bash
npm test           # Run all tests
npm run test:watch # Run tests in watch mode
```

Write tests for:
- All utility functions in `src/lib/`
- New location data (validate slugs, coordinates, province)
- CSS class mappings (e.g. frost severity → design tokens)
- Component contracts (e.g. embed widget uses CSS module, no inline styles)
- API route input validation and prompt configuration
- SEO metadata generation

## Adding a New Location

1. Add the location to `src/lib/locations.ts` in the appropriate section
2. Include: `slug`, `name`, `province`, `lat`, `lon`, `elevation`, and `tags`
3. Verify coordinates are within Zimbabwe bounds
4. Run the test suite to ensure no regressions

## Pre-Commit Checklist

Before every commit, complete **all** of these steps:

1. `npm test` — all tests pass
2. `npm run lint` — zero errors
3. `npx tsc --noEmit` — zero type errors
4. Add/update tests for any new or changed behavior
5. Update docs (README.md, CLAUDE.md, CONTRIBUTING.md) if your change affects APIs, structure, dependencies, styling, or workflow
6. Verify no hardcoded styles (hex colors, rgba, inline style objects) in components

## Pull Request Process

1. Complete the Pre-Commit Checklist above
2. Ensure the build succeeds: `npm run build`
3. Submit a PR with a clear description of the change and why it's needed

## Reporting Issues

Use the [GitHub Issues](https://github.com/nyuchitech/mukoko-weather/issues) page. We have templates for:
- Bug reports
- Feature requests

## Code of Conduct

Be respectful, inclusive, and constructive. We build with Ubuntu philosophy — weather is a public good, and so is a welcoming community.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
