# CLAUDE.md patch note: Wildfires map layer (feat/wildfire-layer)

Not applied. CLAUDE.md is guidance for development; the owner (or a session that
owns it) applies these edits. Each block names the section and says what to
add or change. Dates are 2026-11-05 (verified live against GIBS that day).

## 1. Tech Stack, "Maps" bullet

After "...`satelliteRain` = IMERG 30-min precipitation) load keyless straight from
`gibs.earthdata.nasa.gov`...", add:

> `wildfire` = VIIRS NOAA-20 375 m thermal anomalies (`VIIRS_NOAA20_Thermal_Anomalies_375m_All`,
> day and night passes together, daily, newest three UTC days GIBS lists, never a future one).
> **GIBS publishes the fire layers as Mapbox Vector Tiles only, and its EPSG:3857
> `.mvt` endpoint answers 404 for every tile** (verified: every zoom over Harare,
> the world tile, three dates, the MODIS layers too); the vectors exist only in
> EPSG:4326 (matrix set `500m`) and EPSG:3413, which a Web Mercator map cannot
> use. So the map draws GIBS's **WMS** (`/wms/epsg3857/best/wms.cgi`, GetMap,
> 512 px tiles, `{bbox-epsg-3857}`, `service: "wms"` on the `GibsLayer`) in
> NASA's own style (red dots, rgb(240, 40, 40)). A WMS answers a date it has no
> data for with HTTP 200 and an XML error, not a 404, so a frame is only ever a
> day DescribeDomains lists (`todayFromHourUtc: null`: today is offered as soon
> as GIBS lists it; true-colour imagery still waits for 18:00 UTC). The map stops
> at zoom 10 (`maxMapZoom`): a dot is 3 px in radius at every zoom, about one
> 375 m pixel at zoom 10 around 18 degrees south, and deeper it would claim a
> precision the sensor does not have. NOAA-21 (same orbit, about 50 minutes
> apart) and Suomi NPP (listed only to 2 Nov that day) are not added.
> GIBS WMS and tiles answer `cache-control: no-store`, so MapLibre's own tile
> cache is the only cache; a Harare tile is about 9 KB at zoom 8.

## 2. Routing, `/[location]/map` bullet

Chips become "Air quality, Rain, Temperature, Wind, Cloud, Satellite, Rain
(satellite) and Wildfires (default Rain, last choice remembered in localStorage)".
Add: "Wildfires prints its marker (`LayerLegend.marker`, a swatch plus the name
'Fire detected by satellite') and its limits (`LayerLegend.limits`) in the legend
header, full width, above the collapsible body, so they stay on screen when the
sheet is folded: a dot is heat a satellite sensed, not a confirmed wildfire (a
planned burn, a gas flare or industrial heat look the same), cloud can hide a
real fire, detections lag by hours. A status line says which UTC day is on screen
('4 Nov (UTC day)', plus ', so far' for today)."

## 3. Credits

`MAP_PROVIDERS["nasa-firms"]`, label `Fire data: NASA FIRMS (LANCE, ESDIS)`, link
`https://www.earthdata.nasa.gov/data/tools/firms`. NASA's wording (read on that
page): "We acknowledge the use of data and/or imagery from NASA's Fire Information
for Resource Management System (FIRMS), part of NASA's Land, Atmosphere Near
real-time Capability for Earth observations (LANCE) and NASA's Earth Science Data
and Information System (ESDIS)." NASA supports "full and open sharing of data";
FIRMS global data is "available within 3 hours of satellite observation"; the
disclaimer says it is provided "as is". The wildfire credit list is
`["nasa-firms", "nasa-gibs", "nasa-viirs"]` after the base map.

## 4. Styling, "Data colours vs brand colours"

Add the `fire` scale to the list: "`--wx-fire-1` (`#f02828`, the same in both
themes) is NASA GIBS's own colour for its fire layers (`circle-color` of
`vector-styles/v1.0/FIRMS_VIIRS_Thermal_Anomalies.json`), so the legend swatch is
the pixel the map draws. `FIRE_SCALE` in `weather-scales.ts`, one band, status
'published' (a published layer style, not a standard), text on it
`text-wx-fg-dark` (4.75:1)."

## 5. Keyboard / chips

`WeatherLayerPanel` rows now carry `scroll-px-6` and `ps-4 pe-6` (the fade is
1.5rem) and every chip calls `scrollChipIntoView` on focus: Chrome leaves a
half-visible focused chip under the edge fade (verified: Tab to Cloud on a
1280 px screen scrolled nothing), so a keyboard user could focus a chip they
could not read.

## 6. Tests list

Add under Library tests: `map-sources.test.ts` (wildfire layer: WMS URL,
credits, frames never future, zoom cap, `utcDayLabel`), `map-layers.test.ts`
(Wildfires chip, legend marker and limits), `weather-scales.test.ts` (fire
colour), `WeatherLayerPanel.test.ts` (flame icon, focus scrolling),
`MapDashboard.test.ts` (wildfire legend).
