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
ASTRO_SOURCEMAP=1 npm run build   # with source maps, to see what is in a chunk
npm run serve                  # dist/client over HTTP, gzipped like Cloudflare's edge
CHROME_PATH=/path/to/chrome npm run check:shell   # persistence and no-JavaScript checks
```

`check:shell` uses the runner's Chrome (`channel: "chrome"`) unless
`CHROME_PATH` names a Chromium binary.

## Not here yet

The place page (phase 1), the other static pages (phase 2), sign-in, the API
routes and the `proxy.ts` rules (phase 3), the service worker, analytics, push,
JSON-LD, the sitemap and robots (phase 4), the Quick actions group, and any
deploy or DNS change (phase 5, the owner's).
