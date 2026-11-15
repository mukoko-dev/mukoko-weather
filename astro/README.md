# astro/: the Astro app

Phase 0 of the move to Astro ([#475](https://github.com/mukoko-dev/mukoko-weather/issues/475)).
**Built, not deployed.** The Next.js app in `../src` still serves every route,
the Vercel project and `weather.mukoko.com`. Nothing here is routed to a visitor
until the owner points a route at it.

## What is here

- One layout (`src/layouts/Shell.astro`): the header, the footer and the phone
  bottom bar with its places lane. The client router swaps `<main>` and nothing
  else, so the header and the bar stay mounted between pages.
- The HTML is the same for everyone. Nothing in the layout reads who is signed
  in; the theme is settled from the device by an inline script before first
  paint.
- `/about`, ported from `src/app/about/page.tsx`, prerendered, no JavaScript of
  its own. The bottom bar is the only island on it.
- Astro 7 on the Cloudflare adapter, React for islands, Tailwind 4 and the
  Mzizi tokens (`src/app/mzizi-tokens.css`, through `src/app/globals.css`).
  Both pages are prerendered, so the build makes static assets and no Worker
  bundle; a Worker appears with the first page rendered on demand.

## How it reuses the Next.js app

It imports components and pure modules from `../src` through the `@/` alias,
unchanged (`MobileNav`, the Mzizi bottom nav, the places lane, `header-nav`,
`nav-destinations`). Five modules those files import cannot run here, so the
build replaces them with the files in `src/shims/`:

| Replaced          | By                    | Why                                         |
| ----------------- | --------------------- | ------------------------------------------- |
| `next/link`       | `next-link.tsx`       | a plain anchor; the client router routes it |
| `next/navigation` | `next-navigation.tsx` | pathname and `push` from the client router  |
| `@/lib/store`     | `store.ts`            | no RxDB start-up in the shell (see below)   |
| `@/lib/analytics` | `analytics.ts`        | analytics move in phase 4                   |
| `PhoneMenu`       | `PhoneMenu.tsx`       | the signed-in avatar is phase 3             |

`src/seams.test.ts` keeps this list exact and fails on any `next/*` import in
this app's own files. The rule of #475 holds: no new `next/*` import outside a
thin adapter.

The store shim answers with the first-visit defaults, so the lane shows My
Location and the suggested places. Phase 1 decides how the lane learns the
saved places without waiting for IndexedDB.

## Commands

Needs Node 22.23.4 or newer (Astro 7 stops on older Node) and the root
`npm ci` as well as this one: the shared source resolves its packages from the
root install.

```bash
npm ci                         # in the repo root
cd astro && npm ci
npm run dev                    # astro dev (workerd)
npm run check                  # astro check and tsc
npm test                       # unit tests
npm run build                  # the prerendered pages in dist/client
npm run budget                 # JavaScript and CSS of each page against js-budget.json
CHROME_PATH=/path/to/chrome npm run check:pages   # the static pages: no JavaScript needed, the FAQ, head metadata
ASTRO_SOURCEMAP=1 npm run build   # with source maps, to see what is in a chunk
npm run serve                  # dist/client over HTTP, gzipped like Cloudflare's edge
CHROME_PATH=/path/to/chrome npm run check:shell   # persistence and no-JavaScript checks
CHROME_PATH=/path/to/chrome npm run measure -- --url http://127.0.0.1:4321 --path /about --label astro --runs 3
```

`check:shell` uses the runner's Chrome (`channel: "chrome"`) unless
`CHROME_PATH` names a Chromium binary.

## Measuring

Every pull request on this track states the bytes of JavaScript and the JS heap
before and after (#475). `npm run measure` loads a page in Chromium with a
Pixel 5 profile, Slow 4G (1.6 Mbps, 150 ms) and a 4x CPU slowdown, cold and
warm, and prints the median of the runs: first and largest paint, long tasks,
JavaScript and CSS transferred and decoded, inline script bytes, script CPU
time, DOM nodes and the JS heap (after a forced garbage collection). To
compare with the Next.js build, run `npm run build` and `next start` in the
repo root with dummy sign-in settings, and run the same command against it. Use
`npm run serve` for this build: `astro preview` does not compress, and
Cloudflare's edge does. Compare two runs made on the same machine, minutes
apart; the numbers say nothing across machines.

## Route parity

Every page below is prerendered to a `.html` file with the same URL as its
Next.js route (`build.format: "file"`, no trailing slash). The body of each is
the Next.js page's own component, imported from `../src` (`TermsContent`,
`PrivacyContent`, `HelpContent`, `ReleaseEntry`, `StatusDashboard`), so the
words cannot drift; `src/pages.test.ts` checks that each pair has the same
title, description and canonical URL, and that the site-wide head (card image,
keywords, twitter description) matches `src/app/layout.tsx`.

| Next.js route        | Astro page                   | JavaScript of its own                                                                          |
| -------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `/about`             | `pages/about.astro`          | none                                                                                           |
| `/terms`             | `pages/terms.astro`          | none                                                                                           |
| `/privacy`           | `pages/privacy.astro`        | none                                                                                           |
| `/help`              | `pages/help.astro`           | 660 B inline: the FAQ buttons (the Radix accordion is not loaded)                              |
| `/releases`          | `pages/releases.astro`       | none                                                                                           |
| `/releases/feed.xml` | `pages/releases/feed.xml.ts` | none (a file written at build time)                                                            |
| `/status`            | `pages/status.astro`         | the `StatusDashboard` island, 2.8 KB gzip over the shell: it reads `/v1/status` in the browser |

Not moved, with the reason:

- `/developers`: the Next.js page is rendered per visitor. Its "API keys"
  section reads the signed-in user (`getCurrentUser`, shows their email and
  links to the key manager) and the page reads a feature flag per request. A
  prerendered page has no visitor. It moves with phase 3 (sign-in), as a static
  page with that one block as an island that asks the session.
- `/offline`: it is what the service worker precaches, and its body is
  `OfflineShell`, which shows the last place saved on the device through
  `DeviceSnapshot`: the Next.js `Header`, `CurrentConditions`, the hourly and
  daily charts, `WeatherBackdrop`, and the real store with RxDB. Those are the
  place page's components (phase 1); the shell's store shim has no RxDB, and the
  build fails on it (`hasStoreHydrated` is not exported by `src/shims/store.ts`).
  A cut-down `/offline` would lose the saved-weather view the Next.js one has.
  The worker (`src/app/sw.ts`) also finds the page's scripts by their
  `/_next/static/` URLs in the precached HTML (`src/lib/sw-shell.ts`), and an
  Astro island is not a `<script src>` under `/_astro/`: both change with the
  service worker in phase 4. Nothing in the worker is touched here.

What a static file cannot carry is left to whatever serves it: the Next.js
`/releases/feed.xml` route sets `Cache-Control: public, max-age=3600,
s-maxage=86400`; the HTML pages get the same headers `src/lib/security-headers.ts`
gives them today. The Cloudflare adapter writes `_headers` for `/_astro/*`
(immutable); the rest is the Rust Worker's rules (#579).

Differences from the Next.js pages, on purpose:

- The Open Graph title is the page's own (`Terms of Service | mukoko weather`)
  and `og:url` is the page's canonical. The Next.js pages without their own
  `openGraph` (everything here but `/releases`) inherit the home page's title
  and URL from the root layout, so a shared `/terms` link says "Global Weather
  Intelligence" and points at `/`. Only `/releases` sets its own there.
- `/help`'s FAQ is plain markup: each question is a heading with a button, the
  answer is `hidden="until-found"` (find-in-page opens it) and, with no script,
  every answer is shown.
- Terms and Privacy skip layout and paint work for every section from the third
  down (`content-visibility: auto`, see `src/styles/global.css`).

## Known gaps in what is built

- The footer's year is the year of the build (the pages are prerendered); the
  Next.js footer reads it on each request. A deploy after New Year fixes it,
  or the year moves to a line of script.
- Feature flags are read at build time (`isFeatureEnabled` sees no
  `localStorage` here), so a flag a visitor turns on in their own browser does
  not change a prerendered page the way it does in the Next.js app. Both flags
  the shell reads (`shamwari_chat`, `apple_weatherkit`) are off by default.

## Not here yet

The place page (phase 1), the rest of the static pages (phase 2: `/developers`, `/offline`, embed, explore, locations, history), sign-in, the API
routes and the `proxy.ts` rules (phase 3), the service worker, analytics, push,
JSON-LD, the sitemap and robots (phase 4), the Quick actions group, and any
deploy or DNS change (phase 5, the owner's).
