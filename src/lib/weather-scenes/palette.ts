import type { WeatherSceneType } from "./types";

/**
 * Weather scene palette — the ONE place sky, cloud, particle, light and fog
 * colours for the animated weather scenes live.
 *
 * The rule (owner: "use colours that actually represent the weather"): every
 * colour here is the colour that weather really is at that time of day — a
 * blue sky graded to a paler horizon, flat greys for overcast, blue-grey for
 * rain, charcoal for storms, desaturated grey for fog, warm ochre for haze,
 * deep navy at night. Brand minerals are deliberately NOT used as sky colours.
 *
 * Consumers:
 *  - `scenes/*.ts` (Three.js / WebGL) read the material + fog colours via
 *    `getScenePalette()`. WebGL needs raw colour values — CLAUDE.md allows
 *    raw hex in the weather-scenes WebGL layer, and this module keeps it in
 *    one file instead of scattered across eight builders.
 *  - `globals.css` mirrors `skyTop` / `skyHorizon` (and the dark-theme
 *    variants from `darkThemeSky()`) as `--sky-*` custom properties, so the
 *    CSS gradient behind the canvas — which is also the reduced-motion and
 *    WebGL-failure fallback — is the same sky. `palette.test.ts` fails if the
 *    two drift apart.
 */

/** Day/night plus the two twilight windows around sunrise and sunset. */
export type SkyPhase = "day" | "night" | "dawn" | "dusk";

export interface ScenePalette {
  /** Zenith colour of the sky gradient (CSS, light theme). */
  skyTop: string;
  /** Horizon colour of the sky gradient (CSS, light theme). */
  skyHorizon: string;
  /** WebGL fog colour — distant particles fade into the sky behind them. */
  fog: string;
  /** Sun or moon disc. */
  body: string;
  /** Halo around the sun or moon. */
  glow: string;
  /** Lit cloud tops. */
  cloud: string;
  /** Cloud undersides / second, lower layer. */
  cloudShade: string;
  /**
   * The scene's moving particles: dust motes (clear day), stars (clear
   * night), breeze (partly cloudy), rain streaks, snowflakes, fog wisps,
   * haze dust, wind streaks.
   */
  particle: string;
  /** Lightning flash (thunderstorm only). */
  flash?: string;
}

export type SceneTime = "day" | "night";

export const SCENE_TYPES: readonly WeatherSceneType[] = [
  "clear",
  "partly-cloudy",
  "cloudy",
  "rain",
  "thunderstorm",
  "fog",
  "haze",
  "snow",
  "windy",
] as const;

export const SCENE_PALETTE: Record<
  WeatherSceneType,
  Record<SceneTime, ScenePalette>
> = {
  clear: {
    // Clear blue sky graded to a pale horizon; warm yellow-white sun.
    day: {
      skyTop: "#2f6fc0",
      skyHorizon: "#a9cdee",
      fog: "#8dbbe6",
      body: "#fff1b8",
      glow: "#ffe08a",
      cloud: "#ffffff",
      cloudShade: "#e3ebf4",
      particle: "#fff6d8",
    },
    // Deep navy; cool white stars and moon.
    night: {
      skyTop: "#0a1530",
      skyHorizon: "#1c2c52",
      fog: "#142245",
      body: "#e6ebf5",
      glow: "#9fb2d8",
      cloud: "#4a5878",
      cloudShade: "#36425e",
      particle: "#f2f6ff",
    },
  },
  "partly-cloudy": {
    // Blue sky with white and light-grey clouds.
    day: {
      skyTop: "#3b78c4",
      skyHorizon: "#b3d2ee",
      fog: "#97c0e6",
      body: "#fff0bf",
      glow: "#ffe39a",
      cloud: "#ffffff",
      cloudShade: "#d5dbe3",
      particle: "#eef2f7",
    },
    night: {
      skyTop: "#0e1a36",
      skyHorizon: "#26365a",
      fog: "#1b2848",
      body: "#dde3ee",
      glow: "#93a3c4",
      cloud: "#8592aa",
      cloudShade: "#5f6a80",
      particle: "#c9d1e0",
    },
  },
  cloudy: {
    // Overcast: flat greys, no sun.
    day: {
      skyTop: "#8d959e",
      skyHorizon: "#bcc2c8",
      fog: "#a9afb6",
      body: "#d8dce0",
      glow: "#c9cdd2",
      cloud: "#d9dde1",
      cloudShade: "#aab0b7",
      particle: "#c4c9cf",
    },
    night: {
      skyTop: "#22262c",
      skyHorizon: "#353a41",
      fog: "#2c3036",
      body: "#7d828a",
      glow: "#5c6168",
      cloud: "#5a5f67",
      cloudShade: "#464b53",
      particle: "#6a7078",
    },
  },
  rain: {
    // Blue-grey sky, darker clouds, grey-blue streaks.
    day: {
      skyTop: "#4f5e70",
      skyHorizon: "#8794a3",
      fog: "#6f7c8c",
      body: "#c3cad2",
      glow: "#a3abb5",
      cloud: "#6b7684",
      cloudShade: "#56606c",
      particle: "#a9bccf",
    },
    night: {
      skyTop: "#151b24",
      skyHorizon: "#262f3b",
      fog: "#1e2530",
      body: "#6c7685",
      glow: "#4b5463",
      cloud: "#3d4653",
      cloudShade: "#303844",
      particle: "#7f93ab",
    },
  },
  thunderstorm: {
    // Dark slate / charcoal clouds; brief white-violet lightning.
    day: {
      skyTop: "#2a2f38",
      skyHorizon: "#4a515c",
      fog: "#3a4049",
      body: "#8a909a",
      glow: "#5d636d",
      cloud: "#3a3f48",
      cloudShade: "#2d3139",
      particle: "#8fa1b6",
      flash: "#f1ecff",
    },
    night: {
      skyTop: "#0c0e13",
      skyHorizon: "#1d2129",
      fog: "#15181e",
      body: "#555b65",
      glow: "#363b44",
      cloud: "#2b2f37",
      cloudShade: "#202329",
      particle: "#6f8199",
      flash: "#e9e2ff",
    },
  },
  fog: {
    // Fog and mist: desaturated pale grey.
    day: {
      skyTop: "#b9bcbf",
      skyHorizon: "#d6d8d9",
      fog: "#cfd1d3",
      body: "#e6e7e8",
      glow: "#dcdedf",
      cloud: "#e2e3e4",
      cloudShade: "#c8cacc",
      particle: "#eceded",
    },
    night: {
      skyTop: "#2c2e31",
      skyHorizon: "#3e4043",
      fog: "#36383b",
      body: "#7a7c80",
      glow: "#55575a",
      cloud: "#5c5e62",
      cloudShade: "#4a4c50",
      particle: "#6e7174",
    },
  },
  haze: {
    // Haze, smoke, dust and sand: warm tan / ochre with a dimmed sun.
    day: {
      skyTop: "#b39c76",
      skyHorizon: "#d9c49c",
      fog: "#cbb48a",
      body: "#f3dfae",
      glow: "#e8c98a",
      cloud: "#dcc8a2",
      cloudShade: "#c4ac82",
      particle: "#c9a66b",
    },
    night: {
      skyTop: "#2e2619",
      skyHorizon: "#4a3d29",
      fog: "#3c3221",
      body: "#a8926a",
      glow: "#6e5c3f",
      cloud: "#5e4f37",
      cloudShade: "#4a3e2b",
      particle: "#7a6748",
    },
  },
  snow: {
    // Pale grey-white sky, white flakes.
    day: {
      skyTop: "#c4cad1",
      skyHorizon: "#e4e8ec",
      fog: "#d6dbe0",
      body: "#e8ecf1",
      glow: "#dde2e8",
      cloud: "#eff1f3",
      cloudShade: "#d2d8de",
      particle: "#ffffff",
    },
    night: {
      skyTop: "#1f2530",
      skyHorizon: "#343c49",
      fog: "#2a313c",
      body: "#a4acb8",
      glow: "#6c7480",
      cloud: "#4c5562",
      cloudShade: "#3c4450",
      particle: "#f0f3f8",
    },
  },
  windy: {
    // Wind: neutral streaks over the base (clear/partly-cloudy) sky.
    day: {
      skyTop: "#4d82c2",
      skyHorizon: "#b9d3ea",
      fog: "#a0c2e2",
      body: "#fff0c4",
      glow: "#ffe6a8",
      cloud: "#eef1f4",
      cloudShade: "#d3d9e0",
      particle: "#e3e7ec",
    },
    night: {
      skyTop: "#101a30",
      skyHorizon: "#26324c",
      fog: "#1b2640",
      body: "#d6dce8",
      glow: "#8c99b4",
      cloud: "#76819a",
      cloudShade: "#58627a",
      particle: "#8a93a3",
    },
  },
};

/**
 * Twilight sky overrides — warm orange (dawn) / pink-orange (dusk) at the
 * horizon. Applied only to scenes where the horizon is actually visible
 * (`TWILIGHT_SCENES`); under overcast, rain, storm, fog or snow the cloud
 * deck hides the sunrise, so those keep their day/night sky.
 */
export const TWILIGHT_PALETTE: Record<
  "dawn" | "dusk",
  Pick<ScenePalette, "skyTop" | "skyHorizon" | "fog" | "body" | "glow">
> = {
  dawn: {
    skyTop: "#4a6aa8",
    skyHorizon: "#f2a37a",
    fog: "#c99a8e",
    body: "#ffe2b0",
    glow: "#ffc58a",
  },
  dusk: {
    skyTop: "#3b4a86",
    skyHorizon: "#e8857a",
    fog: "#b07c86",
    body: "#ffc7a0",
    glow: "#ff9e7a",
  },
};

export const TWILIGHT_SCENES: ReadonlySet<WeatherSceneType> = new Set([
  "clear",
  "partly-cloudy",
  "windy",
]);

/** Minutes either side of sunrise/sunset that count as dawn/dusk. */
export const TWILIGHT_WINDOW_MINUTES = 40;

/**
 * Resolve the palette for a scene. `phase` defaults from `isDay`; a dawn or
 * dusk phase recolours the sky only for scenes in `TWILIGHT_SCENES`.
 */
export function getScenePalette(
  type: WeatherSceneType,
  isDay: boolean,
  phase?: SkyPhase,
): ScenePalette {
  const byTime = SCENE_PALETTE[type] ?? SCENE_PALETTE["partly-cloudy"];
  const base = byTime[isDay ? "day" : "night"];
  if ((phase === "dawn" || phase === "dusk") && TWILIGHT_SCENES.has(type)) {
    return { ...base, ...TWILIGHT_PALETTE[phase] };
  }
  return base;
}

/** "HH:MM" minutes-of-day from an ISO-8601 local timestamp, or null. */
function minutesOfDay(iso: string | undefined): number | null {
  if (!iso) return null;
  const m = iso.match(/T(\d{2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Work out the sky phase from the location's own clock. All three times must
 * be in the SAME (location-local) timezone — Open-Meteo's `current.time` and
 * `daily.sunrise/sunset` are. Missing or unparseable times fall back to
 * plain day/night from `isDay`, so callers can adopt this incrementally.
 */
export function skyPhase(
  isDay: boolean,
  nowIso?: string,
  sunriseIso?: string,
  sunsetIso?: string,
  windowMinutes = TWILIGHT_WINDOW_MINUTES,
): SkyPhase {
  const now = minutesOfDay(nowIso);
  const rise = minutesOfDay(sunriseIso);
  const set = minutesOfDay(sunsetIso);
  if (now != null && rise != null && Math.abs(now - rise) <= windowMinutes) {
    return "dawn";
  }
  if (now != null && set != null && Math.abs(now - set) <= windowMinutes) {
    return "dusk";
  }
  return isDay ? "day" : "night";
}

// ── Colour maths (shared by tests and the dark-theme derivation) ─────────

/** Parse `#rrggbb` into 0–255 channels. */
export function hexToRgb(hex: string): [number, number, number] {
  const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) throw new Error(`palette: not a #rrggbb colour: ${hex}`);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b]
    .map((c) =>
      Math.round(Math.min(255, Math.max(0, c)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** WCAG relative luminance (0 black – 1 white). */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** HSL saturation (0 grey – 1 fully saturated). */
export function saturation(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return 0;
  const d = max - min;
  return l > 0.5 ? d / (2 - max - min) : d / (max + min);
}

/** Linear sRGB mix: `amount` of `b` into `a`. */
export function mixHex(a: string, b: string, amount: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToHex([
    ca[0] + (cb[0] - ca[0]) * amount,
    ca[1] + (cb[1] - ca[1]) * amount,
    ca[2] + (cb[2] - ca[2]) * amount,
  ]);
}

/**
 * Dark-theme sky: the same weather, dimmed toward black so a bright day sky
 * doesn't glare against the dark UI (and light text above it keeps its
 * contrast). The hue — what the weather looks like — is unchanged.
 */
export const DARK_THEME_DIM = 0.5;
export function darkThemeSky(hex: string): string {
  return mixHex(hex, "#000000", DARK_THEME_DIM);
}

/**
 * Alpha mask for the soft round particle sprite (scenes/shared.ts). Not a
 * weather colour — white at full alpha fading to white at zero alpha, so the
 * material colour from the palette tints it. Kept here so no scene file
 * carries a colour literal.
 */
export const SPRITE_MASK = {
  core: "rgba(255,255,255,1)",
  mid: "rgba(255,255,255,0.45)",
  edge: "rgba(255,255,255,0)",
} as const;

/**
 * Literal `.hornbill-sky-*` modifier class per scene + day/night (globals.css).
 * Full literal names — never constructed — per the no-dynamic-classes rule.
 */
export const SKY_CLASS: Record<WeatherSceneType, Record<SceneTime, string>> = {
  clear: {
    day: "hornbill-sky-clear-day",
    night: "hornbill-sky-clear-night",
  },
  "partly-cloudy": {
    day: "hornbill-sky-partly-cloudy-day",
    night: "hornbill-sky-partly-cloudy-night",
  },
  cloudy: {
    day: "hornbill-sky-cloudy-day",
    night: "hornbill-sky-cloudy-night",
  },
  rain: { day: "hornbill-sky-rain-day", night: "hornbill-sky-rain-night" },
  thunderstorm: {
    day: "hornbill-sky-thunderstorm-day",
    night: "hornbill-sky-thunderstorm-night",
  },
  fog: { day: "hornbill-sky-fog-day", night: "hornbill-sky-fog-night" },
  haze: { day: "hornbill-sky-haze-day", night: "hornbill-sky-haze-night" },
  snow: { day: "hornbill-sky-snow-day", night: "hornbill-sky-snow-night" },
  windy: { day: "hornbill-sky-windy-day", night: "hornbill-sky-windy-night" },
};

/**
 * The sky gradient classes for a scene: base + scene/time modifier, plus the
 * twilight modifier when the phase is dawn/dusk and the horizon is visible.
 */
export function skyClassName(
  type: WeatherSceneType,
  isDay: boolean,
  phase?: SkyPhase,
): string {
  const scene = (SKY_CLASS[type] ?? SKY_CLASS["partly-cloudy"])[
    isDay ? "day" : "night"
  ];
  let twilight = "";
  if (TWILIGHT_SCENES.has(type)) {
    if (phase === "dawn") twilight = " hornbill-sky-dawn";
    else if (phase === "dusk") twilight = " hornbill-sky-dusk";
  }
  return `hornbill-sky ${scene}${twilight}`;
}
