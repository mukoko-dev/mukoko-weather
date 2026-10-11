# Station console (Astro)

Slice 0 of the Next.js to Astro migration
([mukoko-dev/mukoko-weather#293](https://github.com/mukoko-dev/mukoko-weather/issues/293)).
It rebuilds `station-console/` with the same behaviour: a public landing page at
`/`, WorkOS sign-in, station registration with one-time credentials and setup
text, manual readings, status, and station keys kept in the owner's browser.
The Next.js console stays untouched until cutover.

## Shape

- Astro 7, TypeScript, `@astrojs/cloudflare`. No React.
- The browser calls only the same-origin BFF (`src/pages/api/stations/*`). The
  BFF resolves the session on the server and calls a `StationsClient`.
- `MockStationsClient` is the default (`STATIONS_BACKEND=mock`).
  `NyuchiStationsClient` calls the Nyuchi API (`/v1/stations`, the proposed
  contract in #293) when `STATIONS_BACKEND=nyuchi` and `NYUCHI_API_URL` is set.
- Logic is plain TypeScript under `src/lib` with Vitest tests. The Astro files
  only compose Mzizi components.

## Commands

```bash
npm ci
npm run dev        # mock backend and mock session, http://localhost:4321
npm run dev:workos # real WorkOS (needs the WORKOS_* variables)
npm run check      # astro check
npm run lint       # tsc over the TypeScript
npm test           # Vitest
npm run build
npm run test:e2e   # Playwright smoke against the mock (chromium must be installed)
```

## Authentication

`@workos/authkit-astro` with the same WorkOS credentials as the weather app.
Register `https://weatherstations.nyuchi.com/callback` (and any preview alias)
as a redirect URI in WorkOS. `AUTH_MODE=mock` replaces it with a cookie session
for development and tests; the mock is refused on hosted builds and in
production bundles.

## Mzizi

Components are vendored with
`npx @nyuchi/mzizi-cli add <name> --target astro` into
`src/components/mzizi/`. Tokens are the upstream default `globals.css`
(`src/styles/mzizi-globals.css`), unedited; local divergence goes in
`src/styles/global.css`. Gaps found while building, to file upstream: the `.card`
class is not defined by the default globals, the segmented control's unselected
text is 4.41:1 in dark mode, and `app-button`, `app-label` and `app-card` do not
forward attributes.

## Configuration

Names only, no values in the repository. See `.env.example`.
