# Contributing to mukoko weather

Thank you for your interest in contributing to mukoko weather. This project provides free global weather intelligence — built in Zimbabwe, serving the world. Contributions from the community help us serve more people.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/<your-username>/mukoko-weather.git`
3. Install dependencies: `npm install`
4. Create a feature branch: `git checkout -b feature/your-feature`
5. Start the dev server: `npm run dev`

AI features are optional locally: without the AI env vars every AI endpoint uses its fallback. To enable them, set `WEATHER_SERVICE_URL` (`https://weather-internal.mukoko.com`, or a local `wrangler dev` of `workers/internal-api`) and the server-only service key `WEATHER_SERVICE_API_KEY` in `.env.local`. The backend never holds a Cloudflare AI token: the weather Worker runs the model through its Workers AI binding. Never prefix either with `NEXT_PUBLIC_` or read them outside `api/py`.

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
- **Accessibility** — all UI changes must maintain WCAG 3.0 APCA/AAA compliance. Layout components must use ARIA landmarks (`role="banner"`, `role="navigation"`, `role="contentinfo"`). Navigation must include `aria-current="page"` on active links. New interactive elements need `focus-visible` outlines.
- **Mobile-first** — design for mobile screens first, then scale up
- **56px touch targets** — all interactive elements must meet the minimum touch target size

### Data Standards

All data models must align with **schema.org** vocabulary and **OpenAPI** standards. See the **Data Standards & Interoperability** section in `CLAUDE.md` for the full specification.

- **Schema.org mapping** — new data entities must identify their schema.org equivalent before implementation (e.g., locations → `schema.org/Place`, weather → `schema.org/Observation`)
- **ISO standards** — country codes use ISO 3166-1 alpha-2, dates use ISO 8601, coordinates use WGS 84, measurement units follow UN/CEFACT Recommendation 20
- **OpenAPI contract** — all Python API endpoints must define Pydantic `BaseModel` request/response schemas. The auto-generated OpenAPI spec (available at `/api/py/docs` in dev) is the source of truth for API consumers
- **JSON-LD structured data** — all public-facing pages must include schema.org JSON-LD. New page types must add appropriate schemas

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
4. Verify coordinates are valid WGS 84 values (latitude -90 to 90, longitude -180 to 180)
5. Run the test suite to ensure no regressions
6. Run `POST /api/db-init` to sync locations to MongoDB

### Community locations (dynamic)

Users can add locations at runtime via geolocation auto-detection, search, or coordinates — no code change needed. These are stored in MongoDB and immediately available. Community locations are reverse-geocoded via Nominatim (OpenStreetMap) at zoom=18 (building/POI level), producing specific place names (landmarks, schools, roads, suburbs) and structured addresses (`nominatimAddress` field). Province normalization handles city-states (Singapore, Monaco, etc.) by using district-level fields instead of meaningless postal codes.

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
4. PRs are automatically checked by CI (lint → typecheck → tests), CodeQL security scanning (JS/TS, Python, Actions), and Claude AI code review — all visible as separate checks in the PR UI
5. On merge to `main`, the `db-init.yml` workflow automatically syncs seed data to MongoDB after Vercel deploys
6. Address any review feedback before requesting merge

## GitHub Workflows

All workflows use `concurrency` groups with `cancel-in-progress: true` — rapid pushes cancel stale runs instead of creating zombie checks.

| Workflow                   | Trigger                                                       | Purpose                                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`                   | Push/PR to `main`                                             | Single job: lint → typecheck → TypeScript tests → Python tests. All steps appear under one check in the GitHub PR UI.                                                                         |
| `codeql.yml`               | Push/PR to `main`                                             | CodeQL security scanning for JavaScript/TypeScript, Python, and GitHub Actions workflows. Matrix strategy runs all 3 language analyses in parallel.                                           |
| `db-init.yml`              | Vercel production deploy succeeds                             | Syncs seed data to MongoDB (locations, activities, rules, prompts)                                                                                                                            |
| `release-pr.yml`           | Manual (`workflow_dispatch`)                                  | Cuts `release/<date>` from `staging`, asserts main's content is already in staging, records main with `git merge -s ours`, removes `CLAUDE.md` and `.claude/`, opens the release PR to `main` |
| `no-dev-files-on-main.yml` | PR to `main`; push to `main`                                  | Fails when `CLAUDE.md` or a `.claude/` directory is tracked, so `main` never holds development-only files                                                                                     |
| `workers.yml`              | Push/PR touching `workers/**`; called by `workers-deploy.yml` | Rust Workers: fmt, clippy (native + wasm32), test, and build every Worker bundle                                                                                                              |
| `workers-deploy.yml`       | Manual (`workflow_dispatch`)                                  | Builds and deploys the Rust Workers to Cloudflare in service-binding order, then smoke-checks each public `/health`                                                                           |

## Releases

`staging` is released to `main` with a **squash** merge. A squash commit has no parent on `staging`, so after one release the next `staging → main` PR sees main's squash commit as unknown history. GitHub then marks the PR as conflicting ("dirty"), even when the content is identical.

To open a release PR, never open `staging → main` by hand. Run the **Release PR** workflow instead (`.github/workflows/release-pr.yml`, Actions → Release PR → Run workflow). The optional `date` input defaults to today in UTC. The workflow:

1. Creates `release/<date>` from `origin/staging`. It fails if that branch already exists.
2. Asserts that main's content is already in staging. Each file on `main` must either match staging's blob at the same path or appear somewhere in staging's history. If neither holds, the workflow fails loudly and names each file, which usually means a hotfix landed on `main` without being merged back. Merge `main` into `staging` and rerun.
3. Runs `git merge -s ours origin/main -m "chore: record main in release history"`. This records `main` as a parent while the tree stays exactly staging's, and the workflow verifies that.
4. Removes the development-only files in one extra commit: every `CLAUDE.md` and every `.claude/` directory, at any depth (matched case-insensitively). `main` never holds them, because they guide development and are not production code. `staging` keeps them, and the workflow fails if any is still tracked after the commit.
5. Pushes the branch and opens the PR to `main` with `RELEASE_BUMP_TOKEN`, so CI runs on it.

Squash-merge that PR. Because `main` is already in the branch's history, the squash is always clean.

The `no-dev-files-on-main.yml` workflow backs step 4 up: it fails any PR to `main`, and any push to `main`, whose tree still tracks a `CLAUDE.md` or `.claude/` file. Make it a required status check on `main` in the repository's branch protection (an owner step) so a hand-opened PR cannot merge them. The Release PR workflow runs from `main`, so a change to it only takes effect after it has reached `main` once. That release has to remove the files by hand on its release branch.

Once the release is on `main`, tag it with the `tag-release` workflow (Actions → tag-release → Run workflow). It tags the tip of `main` as the next version (`bump`, default patch, or an explicit `vX.Y.Z`) and publishes the GitHub release, using `RELEASE_BUMP_TOKEN`.

The release PR is opened with `RELEASE_BUMP_TOKEN` (an org secret), so CI runs on it like any other PR. The workflow fails before it touches git if that secret is missing. A PR opened with `GITHUB_TOKEN` does not start CI.

### Release notes (public)

Every production release gets a public entry on [weather.mukoko.com/releases](https://weather.mukoko.com/releases) and in its Atom feed (`/releases/feed.xml`). The source is one Markdown file per release in `releases/`, named `v<version>.md`. The page is built from these files when the app builds; nothing is fetched from GitHub. `RELEASES.md` stays the technical, operator-facing history, and the automatic `vX.Y.Z (beta)` pre-releases on GitHub are never shown on the page.

Add the file in the release PR (or in a PR to `staging` just before it), so the notes ship with the release they describe:

```md
---
version: 0.12.0
date: 2026-11-02
title: A short headline people will understand
---

One or two optional sentences on what this release is about.

## New

- **Lead phrase.** One plain-language sentence on what changed for the person using the app.

## Improved

## Fixed

## Security

## Known issues
```

- `version` is the tag without the `v`, and must match the file name. `date` is the day it reached production (`YYYY-MM-DD`).
- Only those five headings are allowed, each once, in any order (the page always shows them in the order above). A heading with no bullets is left out, so you can keep the empty template headings.
- Bullets are one item each; an indented next line continues the item. `**bold**` is the only markup.
- Write for farmers, travellers and everyday users. No PR or issue numbers, file names, code, environment variables, model names, or security detail someone could misuse. Say what got better, not how.
- After `tag-release` publishes the GitHub release, add `github: https://github.com/mukoko-dev/mukoko-weather/releases/tag/v<version>` to the front matter. Any other URL fails the build.
- A malformed file fails `npm test` and `npm run build` with the file name and the problem, so it can never ship a broken page.

## Deploying the Workers

The Rust Workers in `workers/` deploy by hand only, from **Actions → Workers deploy → Run workflow** (`.github/workflows/workers-deploy.yml`). Production deploys `main` only: dispatch the run on `main` (a guard job fails it on any other ref), and it deploys exactly the commit it was dispatched on. There is no `ref` input, so the job holding the Cloudflare secrets never checks out a caller-chosen ref. Inputs:

- `worker`: `all` (default) or one Worker.
- `environment`: `production`, the only environment the wrangler configs define. The job runs in the `workers-production` GitHub Environment, so required reviewers set there gate every deploy.

`all` first runs the `workers.yml` gate (fmt, clippy, test, build), then deploys in service-binding order: `forecast`, `aviation`, `mongo-bridge`, `places`, `stations`, `tiles`, then `ai`, `internal-api`, `jobs`, then `public-api`. `mongo-bridge` (TypeScript, `workers/mongo-bridge`) comes before `places` because `places` binds it as `MONGO_BRIDGE`: the bridge is the only writer of device profiles, community weather reports and the archive days of the weather history (MongoDB, never D1), and it has no route and no workers.dev address. `places` also comes before `ai`, which binds it (`PLACES`) so the history analysis reads the same history the app shows (#268). Each Worker with a custom domain must answer `GET /health` with a 2xx, and the run summary lists every Worker's result. A single Worker skips the gate, so only deploy one alone when what it binds to is already live.

**Deploy the Workers before you promote Vercel.** A route that is ported to the Workers has its Python route deleted in the same PR, and the app calls `weather-api.mukoko.com` with no `/api/py` fallback (`src/lib/weather-api.ts`). The Workers deploy by hand and the Vercel release is promoted separately, so promoting Vercel first sends the app to a route that does not exist yet: it answers `404` and the card it feeds renders nothing. Always deploy `forecast`, then `public-api` (the order `all` uses, and the order the service bindings need; a route on the AI Worker, such as `/v1/ai/explore/search` or `/v1/ai/history/analyze`, needs `ai` before `public-api`), check each custom domain's `/health` and the new route, and only then promote the Vercel release. To roll back, roll Vercel back first; a Worker rolled back past a ported route breaks the live app the same way. Check the PR's own list of new bindings, secrets and D1 migrations as well: those must exist before the Worker that uses them deploys.

The workflow needs the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets. The token needs **Account → Secrets Store → Edit** as well as Workers edit: binding a Secrets Store secret on deploy counts as a write. The Workers' own runtime secrets live in the account's Cloudflare Secrets Store (`56f84bfa8a564c54a95dbf4f4b4281b4`), never in the workflow. Each key is one store secret, bound by every Worker that needs it (`secrets_store_secrets` in each `wrangler.jsonc`):

| Store secret                      | Bound by (`workers/<dir>`)                | Required | Value                                                                                                                |
| --------------------------------- | ----------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `MUKOKO_WEATHER_TOMORROW_API_KEY` | `forecast`, `tiles`                       | Required | Tomorrow.io key (today in Mongo `weather.api_keys` "tomorrow")                                                       |
| `MUKOKO_WEATHER_NYUCHI_API_KEY`   | `forecast`, `places`, `ai`                | Required | This app's internal Nyuchi API key: places read, plus the `ai` scope for the guardrails read                         |
| `MUKOKO_WEATHER_SERVICE_API_KEY`  | `internal-api`                            | Required | The bearer key nyuchi-api presents as `WEATHER_SERVICE_API_KEY` (e.g. `openssl rand -hex 32`)                        |
| `MUKOKO_WEATHER_MONGODB_URI`      | none yet (plain `MONGODB_URI` until then) | Optional | MongoDB seed-list connection string for the Workers' read-only client (workers/README.md, "MongoDB from a Worker")   |
| `MUKOKO_MONGODB_RW_URI`           | `mongo-bridge`                            | Required | MongoDB read-write connection string for the bridge. Not weather-specific: one store secret for the whole Mukoko app |
| `MUKOKO_WEATHER_CHECKWX_API_KEY`  | `aviation`                                | Optional | CheckWX key, the METAR fallback (today in Mongo `weather.api_keys` "checkwx")                                        |

Create each one with `npx wrangler secrets-store secret create 56f84bfa8a564c54a95dbf4f4b4281b4 --name <NAME> --scopes workers --remote`, which prompts for the value (`workers/README.md`, "Owner steps"). Transition: until every value is confirmed in the store, the Workers fall back to the plain wrangler secret of the old name (`TOMORROW_API_KEY`, `NYUCHI_API_KEY`, `WEATHER_SERVICE_API_KEY`, `CHECKWX_API_KEY`) and log a warning once per isolate; the fallback is removed once the store is confirmed. Deploys share one `concurrency` group per environment and never cancel each other.

### Patch deploys, then the minor release

Before a release goes to `main`, deploy the Workers from `staging` by hand with wrangler, using the Cloudflare token from the environment (no GitHub Actions): `npm ci` in `workers/mongo-bridge`, then `npx wrangler@4.138.0 deploy` in each Worker directory in the order above, with `CLOUDFLARE_ACCOUNT_ID` set. There are no separate staging Workers, so this is a production deploy: record each Worker's live version first (`wrangler deployments list --name <script>`) as the rollback target, stop at the first failure, and check each custom domain's `/health` (and `/health?probe=mongo` on the public API) after it. Test the changed routes against the live Workers, and delete any test data you created. Only then merge the release PR to `main`; that is the minor bump, tagged with `tag-release`.

## Reporting Issues

Use the [GitHub Issues](https://github.com/nyuchitech/mukoko-weather/issues) page. We have templates for:

- **Bug reports** — include the affected location/page, device info, and steps to reproduce
- **Feature requests** — describe the problem, proposed solution, and which category it relates to

For security vulnerabilities, email **<security@nyuchi.com>** — do not open a public issue.

## Code of Conduct

Be respectful, inclusive, and constructive. We build with Ubuntu philosophy — weather is a public good, and so is a welcoming community.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
