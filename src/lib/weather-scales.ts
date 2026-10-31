/**
 * Weather DATA colours: one source of truth for every legend, map fill, gauge
 * and chart series that encodes a measured value.
 *
 * Rule (owner, 2026-10-31): brand minerals are for UI chrome (chips, buttons,
 * cards). A colour that encodes weather data follows the convention weather
 * users expect worldwide, so a person reading a temperature, rain, wind, air
 * quality or UV colour does not have to relearn it for this app. Tokens are
 * the `--wx-*` family in globals.css (meaning, not brand; never aliased to
 * Mzizi minerals); this module holds the breakpoints in UCUM units and the
 * static Tailwind classes that read the tokens. No hex lives here.
 *
 * STANDARD STATUS of each scale (be honest about what is published):
 *  - "published": hues, breakpoints (and, where noted, hex) are a published
 *    standard, adopted as is.
 *      aqi  US EPA AQI, six categories: green 00e400, yellow ffff00, orange
 *           ff7e00, red ff0000, purple 8f3f97, maroon 7e0023; 0-50, 51-100,
 *           101-150, 151-200, 201-300, 301+.
 *           https://docs.airnowapi.org/aq101 and the EPA "Technical Assistance
 *           Document for the Reporting of Daily Air Quality" (Sept 2018),
 *           https://www.airnow.gov/aqi/aqi-basics/
 *      uv   WHO / WMO / ICNIRP Global Solar UV Index: Low 0-2 green, Moderate
 *           3-5 yellow, High 6-7 orange, Very high 8-10 red, Extreme 11+ violet.
 *           https://www.icnirp.org/en/applications/uv-index/index.html and
 *           WHO "Global Solar UV Index: A Practical Guide". The hex values for
 *           yellow (f7e400) and orange (f85900) are read from the WHO guide;
 *           the green, red and violet hex are the commonly published WHO web
 *           colours and were NOT re-verified against a fetched copy.
 *  - "adapted": the ordering, hue progression and breakpoints follow a
 *    published convention, but the exact hex values are ours.
 *      temp   Diverging blue - pale yellow - red, ColorBrewer RdYlBu (9
 *             classes, flagged colour-blind safe by ColorBrewer), cold to hot.
 *             Hex are the ColorBrewer values. https://colorbrewer2.org/ Break-
 *             points (0 C freezing; 8, 16, 24, 30, 36, 42 C) are ours.
 *      rain   The radar progression (light green, green, dark green, yellow,
 *             orange, red, dark red, magenta) in the hue order of the NWS
 *             NEXRAD base-reflectivity legend. Breakpoints are the NOAA
 *             JetStream dBZ to rain-rate table (25/30/35/40/45/50/55 dBZ =
 *             1/3/6/12/24/47/100 mm/h; 20 dBZ is "trace", used here as 0.1).
 *             https://www.noaa.gov/jetstream/reflectivity The hex values are
 *             ours, not the NWS table's. No purple band for >205 mm/h.
 *      wind   ColorBrewer YlGnBu sequential (7 classes, colour-blind safe).
 *             Breakpoints sit on Beaufort force boundaries in km/h (F4 20,
 *             F5 29, F6 39, F7 50, F8 62, F10 89), Royal Meteorological
 *             Society table: https://www.rmets.org/metmatters/beaufort-wind-scale
 *             The first band spans F0-F3 (under 20 km/h), so that
 *             adjacent bands stay distinguishable on a map. Our grouping.
 *      flight Aviation flight categories: VFR green, MVFR blue, IFR red, LIFR
 *             magenta is the long-standing convention on US aviation charts
 *             (AWC). Hex are ours.
 *  - "ours": no published standard exists for the colour of this quantity.
 *    Marked here so it can be published in bundu-labs/bundu-standards (owner
 *    rule: if a standard does not exist we build one and publish it there).
 *    Tracking: bundu-labs/bundu-standards#39 (weather colour scales). The
 *    "adapted" scales hex values and groupings are ours too, so they go there
 *    as well. Domain colour standards override brand styling for data
 *    encodings (owner rule; mzizi-dev/mzizi-registry#588).
 *      cloud  ColorBrewer Greys, white (clear) to near-black (overcast),
 *             breakpoints at quarter cover. Convention, not a standard.
 *      frost  Three blues (advisory to severe), ColorBrewer Blues, retuned per
 *             theme so each border holds 3:1 on the card. The NWS uses its own
 *             hazard-map palette for frost/freeze products; not adopted.
 *      psi    Singapore NEA PSI: NEA's names and ranges, EPA colours where the
 *             ranges match (see PSI_SCALE).
 *
 * Colour never carries the value alone: every band has a printed range or
 * name (`label`, `name`), and legends print them.
 *
 * Contrast: the official EPA / WHO / radar fills cannot all reach 3:1 against a
 * light or dark base map or card, so every data fill carries the theme-aware
 * `--wx-outline` (map cell outlines, legend and swatch rings, bubble borders).
 * UV bands classify the RAW value (inclusive upper bounds 2, 5, 7, 10).
 *
 * Units are UCUM: Cel, km/h, mm/h, %, [AQI] and [UVI] (the UCUM-style arbitrary
 * units for the two indices; they have no registered UCUM code).
 */

export type ScaleStatus = "published" | "adapted" | "ours";

export interface ScaleBand {
  /** Inclusive lower bound in the scale's unit; -Infinity for the first band. */
  from: number;
  /** Short value label printed under the legend swatch. */
  label: string;
  /** Plain-language name of the band (screen readers, tooltips, detail sheets). */
  name: string;
  /** Token in globals.css, e.g. "--wx-temp-1" (the map reads this via resolveColor). */
  token: string;
  /** Static Tailwind fill / stroke / border classes for the same token. */
  bg: string;
  stroke: string;
  border: string;
  /** Static foreground class that passes 4.5:1 on this band's fill. */
  on: string;
}

export interface WeatherScale {
  id: string;
  quantity: string;
  /** UCUM unit. */
  unit: string;
  status: ScaleStatus;
  /** Ascending by `from`. */
  bands: readonly ScaleBand[];
}

export const TEMP_SCALE: WeatherScale = {
  id: "temp",
  quantity: "air temperature",
  unit: "Cel",
  status: "adapted",
  bands: [
    {
      from: -Infinity,
      label: "<-10",
      name: "Very cold",
      token: "--wx-temp-1",
      bg: "bg-wx-temp-1",
      stroke: "stroke-wx-temp-1",
      border: "border-wx-temp-1",
      on: "text-wx-fg-light",
    },
    {
      from: -10,
      label: "-10",
      name: "Cold",
      token: "--wx-temp-2",
      bg: "bg-wx-temp-2",
      stroke: "stroke-wx-temp-2",
      border: "border-wx-temp-2",
      on: "text-wx-fg-dark",
    },
    {
      from: 0,
      label: "0",
      name: "Cool",
      token: "--wx-temp-3",
      bg: "bg-wx-temp-3",
      stroke: "stroke-wx-temp-3",
      border: "border-wx-temp-3",
      on: "text-wx-fg-dark",
    },
    {
      from: 8,
      label: "8",
      name: "Mild",
      token: "--wx-temp-4",
      bg: "bg-wx-temp-4",
      stroke: "stroke-wx-temp-4",
      border: "border-wx-temp-4",
      on: "text-wx-fg-dark",
    },
    {
      from: 16,
      label: "16",
      name: "Warm",
      token: "--wx-temp-5",
      bg: "bg-wx-temp-5",
      stroke: "stroke-wx-temp-5",
      border: "border-wx-temp-5",
      on: "text-wx-fg-dark",
    },
    {
      from: 24,
      label: "24",
      name: "Warm-hot",
      token: "--wx-temp-6",
      bg: "bg-wx-temp-6",
      stroke: "stroke-wx-temp-6",
      border: "border-wx-temp-6",
      on: "text-wx-fg-dark",
    },
    {
      from: 30,
      label: "30",
      name: "Hot",
      token: "--wx-temp-7",
      bg: "bg-wx-temp-7",
      stroke: "stroke-wx-temp-7",
      border: "border-wx-temp-7",
      on: "text-wx-fg-dark",
    },
    {
      from: 36,
      label: "36",
      name: "Very hot",
      token: "--wx-temp-8",
      bg: "bg-wx-temp-8",
      stroke: "stroke-wx-temp-8",
      border: "border-wx-temp-8",
      on: "text-wx-fg-dark",
    },
    {
      from: 42,
      label: "42+",
      name: "Extreme heat",
      token: "--wx-temp-9",
      bg: "bg-wx-temp-9",
      stroke: "stroke-wx-temp-9",
      border: "border-wx-temp-9",
      on: "text-wx-fg-light",
    },
  ],
};

export const RAIN_SCALE: WeatherScale = {
  id: "rain",
  quantity: "precipitation rate",
  unit: "mm/h",
  status: "adapted",
  bands: [
    {
      from: 0.1,
      label: "0.1",
      name: "Light",
      token: "--wx-rain-1",
      bg: "bg-wx-rain-1",
      stroke: "stroke-wx-rain-1",
      border: "border-wx-rain-1",
      on: "text-wx-fg-dark",
    },
    {
      from: 1,
      label: "1",
      name: "Light-moderate",
      token: "--wx-rain-2",
      bg: "bg-wx-rain-2",
      stroke: "stroke-wx-rain-2",
      border: "border-wx-rain-2",
      on: "text-wx-fg-dark",
    },
    {
      from: 3,
      label: "3",
      name: "Moderate",
      token: "--wx-rain-3",
      bg: "bg-wx-rain-3",
      stroke: "stroke-wx-rain-3",
      border: "border-wx-rain-3",
      on: "text-wx-fg-dark",
    },
    {
      from: 6,
      label: "6",
      name: "Moderate-heavy",
      token: "--wx-rain-4",
      bg: "bg-wx-rain-4",
      stroke: "stroke-wx-rain-4",
      border: "border-wx-rain-4",
      on: "text-wx-fg-dark",
    },
    {
      from: 12,
      label: "12",
      name: "Heavy",
      token: "--wx-rain-5",
      bg: "bg-wx-rain-5",
      stroke: "stroke-wx-rain-5",
      border: "border-wx-rain-5",
      on: "text-wx-fg-dark",
    },
    {
      from: 24,
      label: "24",
      name: "Very heavy",
      token: "--wx-rain-6",
      bg: "bg-wx-rain-6",
      stroke: "stroke-wx-rain-6",
      border: "border-wx-rain-6",
      on: "text-wx-fg-dark",
    },
    {
      from: 47,
      label: "47",
      name: "Intense",
      token: "--wx-rain-7",
      bg: "bg-wx-rain-7",
      stroke: "stroke-wx-rain-7",
      border: "border-wx-rain-7",
      on: "text-wx-fg-light",
    },
    {
      from: 100,
      label: "100+",
      name: "Extreme",
      token: "--wx-rain-8",
      bg: "bg-wx-rain-8",
      stroke: "stroke-wx-rain-8",
      border: "border-wx-rain-8",
      on: "text-wx-fg-dark",
    },
  ],
};

export const WIND_SCALE: WeatherScale = {
  id: "wind",
  quantity: "10 m wind speed",
  unit: "km/h",
  status: "adapted",
  bands: [
    {
      from: 0,
      label: "0",
      name: "Calm to gentle (Beaufort 0-3)",
      token: "--wx-wind-1",
      bg: "bg-wx-wind-1",
      stroke: "stroke-wx-wind-1",
      border: "border-wx-wind-1",
      on: "text-wx-fg-dark",
    },
    {
      from: 20,
      label: "20",
      name: "Moderate breeze (4)",
      token: "--wx-wind-2",
      bg: "bg-wx-wind-2",
      stroke: "stroke-wx-wind-2",
      border: "border-wx-wind-2",
      on: "text-wx-fg-dark",
    },
    {
      from: 29,
      label: "29",
      name: "Fresh breeze (5)",
      token: "--wx-wind-3",
      bg: "bg-wx-wind-3",
      stroke: "stroke-wx-wind-3",
      border: "border-wx-wind-3",
      on: "text-wx-fg-dark",
    },
    {
      from: 39,
      label: "39",
      name: "Strong breeze (6)",
      token: "--wx-wind-4",
      bg: "bg-wx-wind-4",
      stroke: "stroke-wx-wind-4",
      border: "border-wx-wind-4",
      on: "text-wx-fg-dark",
    },
    {
      from: 50,
      label: "50",
      name: "Near gale (7)",
      token: "--wx-wind-5",
      bg: "bg-wx-wind-5",
      stroke: "stroke-wx-wind-5",
      border: "border-wx-wind-5",
      on: "text-wx-fg-dark",
    },
    {
      from: 62,
      label: "62",
      name: "Gale (8-9)",
      token: "--wx-wind-6",
      bg: "bg-wx-wind-6",
      stroke: "stroke-wx-wind-6",
      border: "border-wx-wind-6",
      on: "text-wx-fg-light",
    },
    {
      from: 89,
      label: "89+",
      name: "Storm (10+)",
      token: "--wx-wind-7",
      bg: "bg-wx-wind-7",
      stroke: "stroke-wx-wind-7",
      border: "border-wx-wind-7",
      on: "text-wx-fg-light",
    },
  ],
};

export const CLOUD_SCALE: WeatherScale = {
  id: "cloud",
  quantity: "cloud cover",
  unit: "%",
  status: "ours",
  bands: [
    {
      from: 0,
      label: "0",
      name: "Clear",
      token: "--wx-cloud-1",
      bg: "bg-wx-cloud-1",
      stroke: "stroke-wx-cloud-1",
      border: "border-wx-cloud-1",
      on: "text-wx-fg-dark",
    },
    {
      from: 25,
      label: "25",
      name: "Few",
      token: "--wx-cloud-2",
      bg: "bg-wx-cloud-2",
      stroke: "stroke-wx-cloud-2",
      border: "border-wx-cloud-2",
      on: "text-wx-fg-dark",
    },
    {
      from: 50,
      label: "50",
      name: "Partly cloudy",
      token: "--wx-cloud-3",
      bg: "bg-wx-cloud-3",
      stroke: "stroke-wx-cloud-3",
      border: "border-wx-cloud-3",
      on: "text-wx-fg-dark",
    },
    {
      from: 75,
      label: "75",
      name: "Mostly cloudy",
      token: "--wx-cloud-4",
      bg: "bg-wx-cloud-4",
      stroke: "stroke-wx-cloud-4",
      border: "border-wx-cloud-4",
      on: "text-wx-fg-light",
    },
    {
      from: 90,
      label: "90+",
      name: "Overcast",
      token: "--wx-cloud-5",
      bg: "bg-wx-cloud-5",
      stroke: "stroke-wx-cloud-5",
      border: "border-wx-cloud-5",
      on: "text-wx-fg-light",
    },
  ],
};

export const AQI_SCALE: WeatherScale = {
  id: "aqi",
  quantity: "US EPA Air Quality Index",
  unit: "[AQI]",
  status: "published",
  bands: [
    {
      from: 0,
      label: "0",
      name: "Good",
      token: "--wx-aqi-1",
      bg: "bg-wx-aqi-1",
      stroke: "stroke-wx-aqi-1",
      border: "border-wx-aqi-1",
      on: "text-wx-fg-dark",
    },
    {
      from: 51,
      label: "51",
      name: "Moderate",
      token: "--wx-aqi-2",
      bg: "bg-wx-aqi-2",
      stroke: "stroke-wx-aqi-2",
      border: "border-wx-aqi-2",
      on: "text-wx-fg-dark",
    },
    {
      from: 101,
      label: "101",
      name: "Unhealthy for sensitive groups",
      token: "--wx-aqi-3",
      bg: "bg-wx-aqi-3",
      stroke: "stroke-wx-aqi-3",
      border: "border-wx-aqi-3",
      on: "text-wx-fg-dark",
    },
    {
      from: 151,
      label: "151",
      name: "Unhealthy",
      token: "--wx-aqi-4",
      bg: "bg-wx-aqi-4",
      stroke: "stroke-wx-aqi-4",
      border: "border-wx-aqi-4",
      on: "text-wx-fg-dark",
    },
    {
      from: 201,
      label: "201",
      name: "Very unhealthy",
      token: "--wx-aqi-5",
      bg: "bg-wx-aqi-5",
      stroke: "stroke-wx-aqi-5",
      border: "border-wx-aqi-5",
      on: "text-wx-fg-light",
    },
    {
      from: 301,
      label: "301+",
      name: "Hazardous",
      token: "--wx-aqi-6",
      bg: "bg-wx-aqi-6",
      stroke: "stroke-wx-aqi-6",
      border: "border-wx-aqi-6",
      on: "text-wx-fg-light",
    },
  ],
};

export const UV_SCALE: WeatherScale = {
  id: "uv",
  quantity: "UV Index",
  unit: "[UVI]",
  status: "published",
  bands: [
    {
      from: 0,
      label: "0",
      name: "Low",
      token: "--wx-uv-1",
      bg: "bg-wx-uv-1",
      stroke: "stroke-wx-uv-1",
      border: "border-wx-uv-1",
      on: "text-wx-fg-dark",
    },
    {
      from: 3,
      label: "3",
      name: "Moderate",
      token: "--wx-uv-2",
      bg: "bg-wx-uv-2",
      stroke: "stroke-wx-uv-2",
      border: "border-wx-uv-2",
      on: "text-wx-fg-dark",
    },
    {
      from: 6,
      label: "6",
      name: "High",
      token: "--wx-uv-3",
      bg: "bg-wx-uv-3",
      stroke: "stroke-wx-uv-3",
      border: "border-wx-uv-3",
      on: "text-wx-fg-dark",
    },
    {
      from: 8,
      label: "8",
      name: "Very high",
      token: "--wx-uv-4",
      bg: "bg-wx-uv-4",
      stroke: "stroke-wx-uv-4",
      border: "border-wx-uv-4",
      on: "text-wx-fg-light",
    },
    {
      from: 11,
      label: "11+",
      name: "Extreme",
      token: "--wx-uv-5",
      bg: "bg-wx-uv-5",
      stroke: "stroke-wx-uv-5",
      border: "border-wx-uv-5",
      on: "text-wx-fg-light",
    },
  ],
};

export const FROST_SCALE: WeatherScale = {
  id: "frost",
  quantity: "frost alert level",
  unit: "1",
  status: "ours",
  bands: [
    {
      from: 0,
      label: "Advisory",
      name: "Frost advisory",
      token: "--wx-frost-1",
      bg: "bg-wx-frost-1",
      stroke: "stroke-wx-frost-1",
      border: "border-wx-frost-1",
      on: "text-wx-fg-dark",
    },
    {
      from: 1,
      label: "Warning",
      name: "Frost warning",
      token: "--wx-frost-2",
      bg: "bg-wx-frost-2",
      stroke: "stroke-wx-frost-2",
      border: "border-wx-frost-2",
      on: "text-wx-fg-dark",
    },
    {
      from: 2,
      label: "Severe",
      name: "Severe frost",
      token: "--wx-frost-3",
      bg: "bg-wx-frost-3",
      stroke: "stroke-wx-frost-3",
      border: "border-wx-frost-3",
      on: "text-wx-fg-light",
    },
  ],
};

export const FLIGHT_SCALE: WeatherScale = {
  id: "flight",
  quantity: "aviation flight category",
  unit: "1",
  status: "adapted",
  bands: [
    {
      from: 0,
      label: "VFR",
      name: "VFR",
      token: "--wx-flight-1",
      bg: "bg-wx-flight-1",
      stroke: "stroke-wx-flight-1",
      border: "border-wx-flight-1",
      on: "text-wx-fg-dark",
    },
    {
      from: 1,
      label: "MVFR",
      name: "MVFR",
      token: "--wx-flight-2",
      bg: "bg-wx-flight-2",
      stroke: "stroke-wx-flight-2",
      border: "border-wx-flight-2",
      on: "text-wx-fg-light",
    },
    {
      from: 2,
      label: "IFR",
      name: "IFR",
      token: "--wx-flight-3",
      bg: "bg-wx-flight-3",
      stroke: "stroke-wx-flight-3",
      border: "border-wx-flight-3",
      on: "text-wx-fg-light",
    },
    {
      from: 3,
      label: "LIFR",
      name: "LIFR",
      token: "--wx-flight-4",
      bg: "bg-wx-flight-4",
      stroke: "stroke-wx-flight-4",
      border: "border-wx-flight-4",
      on: "text-wx-fg-light",
    },
  ],
};

export const WEATHER_SCALES: readonly WeatherScale[] = [
  TEMP_SCALE,
  RAIN_SCALE,
  WIND_SCALE,
  CLOUD_SCALE,
  AQI_SCALE,
  UV_SCALE,
  FROST_SCALE,
  FLIGHT_SCALE,
];

/** Index of the band a value falls in, or -1 (below the first band, null, NaN). */
export function scaleBandIndex(
  scale: WeatherScale,
  value: number | null | undefined,
): number {
  if (value === null || value === undefined || !Number.isFinite(value))
    return -1;
  let index = -1;
  scale.bands.forEach((band, i) => {
    if (value >= band.from) index = i;
  });
  return index;
}

export function scaleBand(
  scale: WeatherScale,
  value: number | null | undefined,
): ScaleBand | null {
  return scale.bands[scaleBandIndex(scale, value)] ?? null;
}

/** Legend segments (the shape map-layers.ts LegendSegment expects) for a scale. */
export function legendSegmentsFor(
  scale: WeatherScale,
  options: { withBounds?: boolean } = {},
): { className: string; label: string; token?: string; from?: number }[] {
  return scale.bands.map((band) =>
    options.withBounds
      ? {
          className: band.bg,
          label: band.label,
          token: band.token,
          from: band.from,
        }
      : { className: band.bg, label: band.label },
  );
}

/**
 * WHO UV band for an index, classified on the RAW value: upper bounds
 * inclusive at 2, 5, 7 and 10 (so 2.6 is Moderate, 5.5 is High), the same
 * thresholds uvLevel() has always used. We did not find a WHO/EPA sentence we
 * could cite for rounding to a whole number first, so no rounding is applied.
 * Whole-number inputs fall on the WHO ranges (0-2, 3-5, 6-7, 8-10, 11+).
 */
export function uvBand(index: number | null | undefined): ScaleBand | null {
  if (index === null || index === undefined || !Number.isFinite(index))
    return null;
  const v = Math.max(0, index);
  const i = v <= 2 ? 0 : v <= 5 ? 1 : v <= 7 ? 2 : v <= 10 ? 3 : 4;
  return UV_SCALE.bands[i];
}

/** CSS var reference for a UV value's WHO colour (chart bars). */
export function uvBandToken(index: number | null | undefined): string {
  return `var(${(uvBand(index) ?? UV_SCALE.bands[0]).token})`;
}

/** US EPA AQI band for an index. */
export function aqiScaleBand(aqi: number | null | undefined): ScaleBand | null {
  if (aqi === null || aqi === undefined || !Number.isFinite(aqi)) return null;
  return scaleBand(AQI_SCALE, Math.round(Math.max(0, aqi)));
}

/**
 * Singapore NEA PSI (Pollutant Standards Index) bands: Good 0-50, Moderate
 * 51-100, Unhealthy 101-200, Very unhealthy 201-300, Hazardous 301+ (names and
 * ranges from https://www.nea.gov.sg/our-services/pollution-control/air-pollution/faqs).
 * Status "ours": NEA's page gives the names and ranges, and secondary sources
 * disagree on its colours, so we do not claim an NEA palette. Where a PSI range
 * equals an EPA range (0-50, 51-100, 201-300, 301+) it takes the EPA colour;
 * NEA "Unhealthy" (101-200) spans the EPA orange and red bands and takes the
 * EPA orange. Flagged for bundu-labs/bundu-standards#39.
 */
const PSI_FROM_AQI = [0, 1, 2, 4, 5] as const;
const PSI_RANGES = [
  { from: 0, label: "0", name: "Good" },
  { from: 51, label: "51", name: "Moderate" },
  { from: 101, label: "101", name: "Unhealthy" },
  { from: 201, label: "201", name: "Very unhealthy" },
  { from: 301, label: "301+", name: "Hazardous" },
] as const;
export const PSI_SCALE: WeatherScale = {
  id: "psi",
  quantity: "Singapore NEA Pollutant Standards Index",
  unit: "[PSI]",
  status: "ours",
  bands: PSI_RANGES.map((range, i) => ({
    ...AQI_SCALE.bands[PSI_FROM_AQI[i]],
    ...range,
  })),
};

/**
 * Hex of the flight-category colours for react-pdf (the briefing PDF cannot
 * read CSS custom properties). The single source for the PDF: a test pins
 * `bg` to the --wx-flight-* tokens in globals.css and `fg` to each band's
 * `on` class. The only hex outside globals.css, a documented exception.
 */
export const FLIGHT_CATEGORY_PDF: Record<string, { bg: string; fg: string }> = {
  VFR: { bg: "#2e9d4a", fg: "#0a0a0a" },
  MVFR: { bg: "#2f6fd0", fg: "#ffffff" },
  IFR: { bg: "#d62828", fg: "#ffffff" },
  LIFR: { bg: "#c026d3", fg: "#ffffff" },
};

/**
 * Chart series colours for a measured quantity drawn as one line or area
 * (CSS custom-property references, resolved by resolveColor at render time).
 * Same hue family as the matching map scale (temperature red/blue, rain blue,
 * wind teal, cloud grey ...). Series that only tell apart (model A vs model B,
 * soil depths) keep the categorical chart tokens.
 */
export const WX_SERIES = {
  temp: "var(--wx-series-temp)",
  tempLow: "var(--wx-series-temp-low)",
  feels: "var(--wx-series-feels)",
  feelsLow: "var(--wx-series-feels-low)",
  rain: "var(--wx-series-rain)",
  rainProb: "var(--wx-series-rain-prob)",
  wind: "var(--wx-series-wind)",
  gust: "var(--wx-series-gust)",
  cloud: "var(--wx-series-cloud)",
  humidity: "var(--wx-series-humidity)",
  pressure: "var(--wx-series-pressure)",
  dew: "var(--wx-series-dew)",
  visibility: "var(--wx-series-visibility)",
  storm: "var(--wx-series-storm)",
} as const;
