# CLAUDE.md lines to change for PR #488 (low-memory crashes, #476)

Updated after merging staging (#474 made the live air quality card one smooth
banded image; the static card now draws that image, not 49 squares).

Not applied: CLAUDE.md is the owner's. Line numbers are those of CLAUDE.md on
`staging` at 68cf10a (the PR's base). `-` is the line as it is, `+` what it
would say. Where a line is long, only the part that changes is shown (`...` is
the unchanged rest).

## 1. Tech Stack, "Maps" line (28)

Two sentences are added at the end of the MapLibre part, before "Tomorrow.io
raster weather overlays", and one at the container-sizing end.

```diff
-- **Maps:** MapLibre GL JS + MapTiler Cloud (vector tiles direct from CDN via `NEXT_PUBLIC_MAPTILER_API_KEY` — no server proxy; GPU-rendered; theme-aware streets-v2 / streets-v2-dark styles); Tomorrow.io raster weather overlays come from ...
+- **Maps:** MapLibre GL JS + MapTiler Cloud (vector tiles direct from CDN via `NEXT_PUBLIC_MAPTILER_API_KEY` — no server proxy; GPU-rendered; theme-aware streets-v2 / streets-v2-dark styles). **MapLibre is for the interactive map only (`/[location]/map`, the `/display` radar): a card the visitor cannot pan or zoom is a picture, never a MapLibre map (#276, #476).** The location page's two cards, the weather map (`MapPreview`) and the air quality map (`AirQualityMapCard`), are four MapTiler raster tiles in an SVG (`src/lib/static-map.ts`, `StaticTileMap.tsx`), the air quality grid drawn over them as the same smooth banded image the full map shows (`aqFieldRaster` painted to an offscreen canvas by `src/lib/field-raster-image.ts`, placed as an SVG `<image>` with its band outlines as paths by `src/lib/aq-static-cells.ts`; one square per grid point where there is no canvas). A MapLibre map is a WebGL context, web workers (MapLibre keeps its worker pool for the rest of the session once any map has been opened) and 40 to 50 MB of the tab's memory; **the interactive map is created at 2x pixel ratio at most** (`MAP_MAX_PIXEL_RATIO`, `mapPixelRatioOverride` in `src/lib/map-layers.ts`, passed only above the cap so MapLibre keeps following `devicePixelRatio` elsewhere): a 3x phone's full-screen canvas was 46 MB, 20 MB at 2x. Tomorrow.io raster weather overlays come from ...
```

and, at the end of the same line, after "**Container sizing:** ...":

```diff
+ **Memory budget:** `scripts/browser-check/memory-budget.mjs` (manual, real browser, not CI; run before a release that touches the place page or the map) holds the place page, place switching, the detail sheets, the map and router navigation to a measured budget (heap, DOM nodes, listeners, canvases, WebGL contexts, web workers); a place page with a WebGL context (iPhone) or a web worker fails it.
```

## 2. File tree, `components/weather/map/` (329-331)

```diff
-│   │   │       ├── MapPreview.tsx         # Static map card on location page: 4 MapTiler raster tiles in an SVG (src/lib/static-map.ts; @2x tiles on high-DPI screens, per-tile failure tracking), no MapLibre; credits from attributionForLayer(null) via MapCredits, outside the link; links to /[location]/map
+│   │   │       ├── StaticTileMap.tsx      # useStaticTileMap (theme's raster style, @2x tiles on high-DPI screens, per-tile failure tracking) + StaticMapTiles (the tiles as SVG <image>s): what both static map cards share
+│   │   │       ├── MapPreview.tsx         # Static map card on location page: 4 MapTiler raster tiles in an SVG (StaticTileMap.tsx, src/lib/static-map.ts), no MapLibre; credits from attributionForLayer(null) via MapCredits, outside the link; links to /[location]/map
 │   │   │       ├── MapPreview.test.ts     # Renders MapPreview (react-dom/server): tiles, theme, credits from map-sources, no nested anchors, no-key fallback
-│   │   │       ├── MapCredits.tsx         # Shared credit list rendered from attributionForLayer() (MapDashboard sheet/legend + MapPreview)
+│   │   │       ├── MapCredits.tsx         # Shared credit list rendered from attributionForLayer() (MapDashboard sheet/legend + MapPreview + AirQualityMapCard)
```

`AirQualityMapCard.tsx` and its test are not in the tree today; if the tree is
to list them (next to `AirQualityCard.tsx` in `components/weather/`):

```diff
+│   │   │   ├── AirQualityMapCard.tsx  # Air Quality Map card: 4 MapTiler raster tiles + the 7x7 AQI grid as the smooth banded raster of the full map (aqFieldRaster -> offscreen canvas -> data URL -> SVG <image>, 0.55 opaque, band outlines as paths; one square per point in the EPA band's fill class where there is no canvas), no MapLibre, no WebGL, no worker (#476); text fallback with no tiles; AirQualityMapView is the rendered part
+│   │   │   ├── AirQualityMapCard.test.ts  # Rendered (react-dom/server, canvas stubbed): tiles, the raster <image> at the projected rectangle, outline paths, polygon fallback, bubble, credits (base map only when tiles are drawn), text fallback; opacity equals the full map's; source has no map library
```

## 3. File tree, `lib/` (422, 428-429, and new entries)

```diff
-│   │   ├── map-layers.ts          # Map layer config (Tomorrow.io tile layers, mineral color styles), trimmed MAPTILER_KEY + style ids
+│   │   ├── map-layers.ts          # Map layer config (Tomorrow.io tile layers, mineral color styles), trimmed MAPTILER_KEY + style ids, MAP_MAX_PIXEL_RATIO + mapPixelRatioOverride (the interactive map draws at 2x at most)
-│   │   ├── static-map.ts          # Static map preview geometry: 2×2 MapTiler raster tiles + SVG viewBox around a coordinate
+│   │   ├── static-map.ts          # Static map geometry (MapPreview, AirQualityMapCard): 2×2 MapTiler raster tiles + SVG viewBox around a coordinate, worldPixel projection
 │   │   ├── static-map.test.ts
+│   │   ├── aq-static-cells.ts     # The AQI grid in static-map world pixels: aqStaticField (the raster's rectangle via worldRect + band outline paths) and aqStaticCells (square-per-point fallback)
+│   │   ├── aq-static-cells.test.ts # Rectangle = worldRect(extent), proportions match the raster, outlines inside it, squares stay square
+│   │   ├── field-raster-image.ts  # Browser end of a field raster for a picture that is not MapLibre: rasterPalette (colours from the --wx-* tokens now) + rasterDataUrl (offscreen SOFTWARE canvas, `willReadFrequently`, -> PNG data URL, null with no canvas, canvas released; a GPU-backed canvas read back with toDataURL kept an ~8 MB transfer buffer alive in the GPU process)
+│   │   ├── field-raster-image.test.ts
```

`src/lib/aq-grid.ts` (not in the tree today) gained `AQI_BAND_FILL_CLASS`
(derived from the scale band's `fill`); `src/lib/weather-scales.ts` bands have an
optional `fill` (SVG fill class, set on the six air quality bands, spelled out
so Tailwind generates it). In "Data colours vs brand colours" (1118), after
"`border-wx-frost-1`, `text-wx-fg-dark`":

```diff
-… and the static Tailwind classes (`bg-wx-temp-3`, `stroke-wx-aqi-2`, `border-wx-frost-1`, `text-wx-fg-dark`); …
+… and the static Tailwind classes (`bg-wx-temp-3`, `stroke-wx-aqi-2`, `border-wx-frost-1`, `text-wx-fg-dark`, and on the air quality bands `fill-wx-aqi-2` for SVG cells); …
```

## 4. API section, the air quality grid client (707)

```diff
-Client: `src/lib/aq-grid.ts` (`fetchAirQualityGrid` calls the Worker via `workerApiUrl`, `gridToGeoJSON`, `aqiBand`) + `AirQualityMapCard`.
+Client: `src/lib/aq-grid.ts` (`fetchAirQualityGrid` calls the Worker via `workerApiUrl`, `gridToGeoJSON`, `aqiBand`) + `AirQualityMapCard` (a static picture: raster tiles plus the smooth banded raster as an SVG image, no MapLibre) and, on the full map, the AQI overlay and bubbles.
```

## 5. Real-browser checks (1279)

```diff
-- **Real-browser checks** (`scripts/browser-check/`, Playwright, not a dependency of the repo; see its README): `pwa-check.mjs` (...), `offline-shell.mjs` (five fresh offline launches) and `offline-retry.mjs` (the second chance). They run against `npm run build && next start` and only read the public API.
+- **Real-browser checks** (`scripts/browser-check/`, Playwright, not a dependency of the repo, run by hand and not by CI; see its README): `pwa-check.mjs` (...), `offline-shell.mjs` (five fresh offline launches), `offline-retry.mjs` (the second chance) and `memory-budget.mjs` (#476: the memory budget of the place page, place switching, the detail sheets, the map and router navigation, iPhone profile or `PROFILE=pixel`, `QUICK=1` for the short run; `memory-harness.mjs` answers every request itself so it needs no network). The first three run against `npm run build && next start` and only read the public API. The budget is for CHANGE (a regression shows here first), not a promise about a phone: it is a desktop Chromium in a phone profile.
```

## 6. Lazy loading list (1488) and Testing list (1640-1641)

```diff
-- `MapPreview` → `LazySection` + `ChartErrorBoundary` + `Suspense`
+- `MapPreview` → `LazySection` + `ChartErrorBoundary` + `Suspense` (a static picture, no MapLibre)
+- `AirQualityMapCard` → `LazySection` (`AirQualityMapSkeleton`) + `ChartErrorBoundary` + `Suspense` (a static picture, no MapLibre; the raster is painted once per grid on an unattached canvas; renders nothing when the grid is unavailable)
```

```diff
 - `src/lib/static-map.test.ts` — static preview tile geometry (...)
+- `src/lib/aq-static-cells.test.ts` — the AQI field in the static map's world pixels: the image rectangle is `worldRect(extent)` (north and south through Mercator), proportions match the raster, outlines inside the rectangle; the square-cell fallback (bands, squares stay square and about cellKm across, points with no reading dropped)
- `src/lib/field-raster-image.test.ts` — the raster's pixels on a canvas, the data URL, null without a canvas, the canvas released, the palette read from the tokens
- `src/lib/static-map.test.ts` — also `worldRect`: corners projected, latitude spaced in Mercator, 2x per zoom
 - `src/components/weather/map/MapPreview.test.ts` — MapPreview rendered for real: ...
+- `src/components/weather/AirQualityMapCard.test.ts` — the air quality card rendered for real (the canvas stubbed): 4 tiles at zoom 9, the raster image at the projected rectangle and 0.55 opacity with its outline paths, the polygon fallback, bubble, credits, text fallback with no tiles (and no base-map credits), the opacity equal to MapLibreMap's, and that its source imports no map library
+- `src/lib/map-layers.test.ts` — also `mapPixelRatioOverride`: capped at 2x above 2x, no option at or below it (MapLibre keeps following the screen), spread into the Map options only when set
```
