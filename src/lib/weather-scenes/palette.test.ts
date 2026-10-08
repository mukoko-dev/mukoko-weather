/**
 * Weather scene palette — "use colours that actually represent the weather".
 *
 *  - every WeatherSceneType × day/night has a complete palette entry
 *  - the colours behave like real weather (rain darker + greyer than clear,
 *    storms darker than rain, overcast/fog near-neutral, haze warm, night
 *    darker than day, clear day sky blue, sun warm)
 *  - globals.css mirrors the palette exactly (--weather-sky-* tokens, both
 *    themes, registered in @theme) so the CSS fallback IS the animated sky
 *  - text that sits on the sky keeps WCAG 4.5:1 in both themes
 *  - twilight phase resolution
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";
import {
  SCENE_PALETTE,
  SCENE_TYPES,
  SKY_CLASS,
  TWILIGHT_PALETTE,
  TWILIGHT_SCENES,
  darkThemeSky,
  getScenePalette,
  hexToRgb,
  luminance,
  mixHex,
  saturation,
  skyClassName,
  skyPhase,
  type ScenePalette,
} from "./palette";
import { contrastRatio } from "@/lib/contrast";

const TIMES = ["day", "night"] as const;
const FIELDS: (keyof ScenePalette)[] = [
  "skyTop",
  "skyHorizon",
  "fog",
  "body",
  "glow",
  "cloud",
  "cloudShade",
  "particle",
];
const HEX = /^#[0-9a-f]{6}$/i;

const globals = readFileSync(
  resolve(__dirname, "../../app/globals.css"),
  "utf-8",
);
const mzizi = readFileSync(
  resolve(__dirname, "../../app/mzizi-tokens.css"),
  "utf-8",
);
const createScene = readFileSync(
  resolve(__dirname, "create-scene.ts"),
  "utf-8",
);
const typesSrc = readFileSync(resolve(__dirname, "types.ts"), "utf-8");

/** Concatenated bodies of the innermost rules whose selector matches. */
function blocks(source: string, sel: RegExp): string {
  let out = "";
  const bare = source.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (sel.test(m[1].trim())) out += `\n${m[2]}`;
  }
  return out;
}

const ROOT = /(^|,)\s*:root\s*(,|$)/;
const DARK = /\[data-theme="dark"\]/;
const lightScope = blocks(mzizi + globals, ROOT);
const darkScope = lightScope + blocks(mzizi + globals, DARK);

/** Resolve a custom property to hex within a scope (last wins, follows var()). */
function token(scope: string, name: string, depth = 0): string {
  if (depth > 8) throw new Error(`alias cycle --${name}`);
  const decls = [...scope.matchAll(new RegExp(`--${name}:\\s*([^;]+);`, "g"))];
  if (!decls.length) throw new Error(`--${name} not declared`);
  const v = decls[decls.length - 1][1].trim();
  const alias = v.match(/^var\((--[\w-]+)\)$/);
  if (alias) return token(scope, alias[1].slice(2), depth + 1);
  return v;
}

describe("palette — coverage", () => {
  it("SCENE_TYPES lists every WeatherSceneType in types.ts", () => {
    const union = [...typesSrc.matchAll(/\|\s*"([a-z-]+)"/g)].map((m) => m[1]);
    expect(union.length).toBeGreaterThan(0);
    expect([...SCENE_TYPES].sort()).toEqual([...union].sort());
  });

  it("every scene type × day/night has a complete #rrggbb entry", () => {
    for (const type of SCENE_TYPES) {
      for (const time of TIMES) {
        const p = SCENE_PALETTE[type][time];
        expect(p, `${type}/${time}`).toBeDefined();
        for (const f of FIELDS) {
          expect(p[f], `${type}/${time}.${f}`).toMatch(HEX);
        }
      }
    }
  });

  it("thunderstorm carries a lightning flash colour that is white-violet", () => {
    for (const time of TIMES) {
      const flash = SCENE_PALETTE.thunderstorm[time].flash!;
      expect(flash).toMatch(HEX);
      const [r, g, b] = hexToRgb(flash);
      expect(luminance(flash)).toBeGreaterThan(0.75); // near-white
      expect(b).toBeGreaterThan(g); // violet tint
      expect(r).toBeGreaterThan(g);
    }
  });

  it("every scene type has a sky class and a scene builder", () => {
    for (const type of SCENE_TYPES) {
      for (const time of TIMES) {
        expect(globals).toContain(`.${SKY_CLASS[type][time]} {`);
      }
      expect(createScene).toContain(`case "${type}"`);
    }
  });

  it("scene builders read every colour from the palette (no colour literals)", () => {
    const dir = resolve(__dirname, "scenes");
    for (const file of readdirSync(dir)) {
      const src = readFileSync(resolve(dir, file), "utf-8");
      expect(src, file).not.toMatch(/0x[0-9a-f]{6}/i);
      expect(src, file).not.toMatch(/#[0-9a-f]{3,6}\b/i);
      expect(src, file).not.toMatch(/rgba?\(/);
      if (file !== "shared.ts") expect(src, file).toContain("getScenePalette");
    }
  });
});

describe("palette — looks like real weather", () => {
  const sky = (type: (typeof SCENE_TYPES)[number], time: "day" | "night") =>
    SCENE_PALETTE[type][time];

  it("a rain sky is darker and greyer than a clear sky (day)", () => {
    for (const f of ["skyTop", "skyHorizon"] as const) {
      expect(luminance(sky("rain", "day")[f])).toBeLessThan(
        luminance(sky("clear", "day")[f]),
      );
      expect(saturation(sky("rain", "day")[f])).toBeLessThan(
        saturation(sky("clear", "day")[f]),
      );
    }
  });

  it("a rain sky is greyer than a clear sky at night too", () => {
    for (const f of ["skyTop", "skyHorizon"] as const) {
      expect(saturation(sky("rain", "night")[f])).toBeLessThan(
        saturation(sky("clear", "night")[f]),
      );
    }
  });

  it("a thunderstorm sky is darker than a rain sky", () => {
    for (const time of TIMES) {
      expect(luminance(sky("thunderstorm", time).skyTop)).toBeLessThan(
        luminance(sky("rain", time).skyTop),
      );
      expect(luminance(sky("thunderstorm", time).cloud)).toBeLessThan(
        luminance(sky("rain", time).cloud),
      );
    }
  });

  it("night is darker than day for every scene", () => {
    for (const type of SCENE_TYPES) {
      for (const f of ["skyTop", "skyHorizon"] as const) {
        expect(luminance(sky(type, "night")[f]), `${type}.${f}`).toBeLessThan(
          luminance(sky(type, "day")[f]),
        );
      }
    }
  });

  it("clear and partly-cloudy day skies are blue, paler at the horizon", () => {
    for (const type of ["clear", "partly-cloudy", "windy"] as const) {
      const p = sky(type, "day");
      const [r, , b] = hexToRgb(p.skyTop);
      expect(b - r, type).toBeGreaterThan(80);
      expect(luminance(p.skyHorizon)).toBeGreaterThan(luminance(p.skyTop));
    }
  });

  it("clear night is deep navy (dark, blue-dominant)", () => {
    const top = sky("clear", "night").skyTop;
    const [r, g, b] = hexToRgb(top);
    expect(luminance(top)).toBeLessThan(0.02);
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
  });

  it("the sun is warm yellow-white and the stars/moon are cool white", () => {
    const sun = hexToRgb(sky("clear", "day").body);
    expect(sun[0]).toBeGreaterThanOrEqual(sun[2]); // warm
    expect(luminance(sky("clear", "day").body)).toBeGreaterThan(0.8);
    for (const c of [
      sky("clear", "night").particle,
      sky("clear", "night").body,
    ]) {
      const [r, , b] = hexToRgb(c);
      expect(b).toBeGreaterThanOrEqual(r); // cool
      expect(luminance(c)).toBeGreaterThan(0.75);
    }
  });

  it("overcast, fog and snow skies are near-neutral greys", () => {
    for (const type of ["cloudy", "fog", "snow"] as const) {
      for (const time of TIMES) {
        for (const f of ["skyTop", "skyHorizon", "cloud"] as const) {
          expect(saturation(sky(type, time)[f]), `${type}/${time}.${f}`)
            // HSL saturation inflates for very dark/light greys; 0.25 still
            // rules out any visibly coloured sky (clear day ≈ 0.6).
            .toBeLessThan(0.25);
        }
      }
    }
  });

  it("fog is pale by day", () => {
    expect(luminance(sky("fog", "day").skyHorizon)).toBeGreaterThan(0.6);
  });

  it("haze is warm tan / ochre (red > blue)", () => {
    for (const time of TIMES) {
      for (const f of ["skyTop", "skyHorizon", "particle"] as const) {
        const [r, , b] = hexToRgb(sky("haze", time)[f]);
        expect(r - b, `${time}.${f}`).toBeGreaterThan(20);
      }
    }
  });

  it("rain drops are grey-blue and snowflakes are white", () => {
    for (const time of TIMES) {
      const [r, , b] = hexToRgb(sky("rain", time).particle);
      expect(b).toBeGreaterThan(r);
      expect(saturation(sky("rain", time).particle)).toBeLessThan(0.45);
    }
    expect(luminance(sky("snow", "day").particle)).toBeGreaterThan(0.95);
  });

  it("dawn and dusk horizons are warm (orange / pink)", () => {
    for (const ph of ["dawn", "dusk"] as const) {
      const [r, g, b] = hexToRgb(TWILIGHT_PALETTE[ph].skyHorizon);
      expect(r).toBeGreaterThan(g);
      expect(r).toBeGreaterThan(b);
    }
  });
});

describe("palette — twilight", () => {
  it("skyPhase falls back to day/night without times", () => {
    expect(skyPhase(true)).toBe("day");
    expect(skyPhase(false)).toBe("night");
  });

  it("skyPhase detects dawn and dusk within the window", () => {
    const rise = "2026-10-08T05:50";
    const set = "2026-10-08T18:10";
    expect(skyPhase(true, "2026-10-08T06:15", rise, set)).toBe("dawn");
    expect(skyPhase(false, "2026-10-08T05:20", rise, set)).toBe("dawn");
    expect(skyPhase(true, "2026-10-08T17:45", rise, set)).toBe("dusk");
    expect(skyPhase(true, "2026-10-08T12:00", rise, set)).toBe("day");
    expect(skyPhase(false, "2026-10-08T22:00", rise, set)).toBe("night");
  });

  it("twilight only recolours scenes with a visible horizon", () => {
    expect(getScenePalette("clear", true, "dusk").skyHorizon).toBe(
      TWILIGHT_PALETTE.dusk.skyHorizon,
    );
    expect(getScenePalette("rain", true, "dusk")).toEqual(
      SCENE_PALETTE.rain.day,
    );
    expect(skyClassName("clear", true, "dawn")).toContain("hornbill-sky-dawn");
    expect(skyClassName("thunderstorm", true, "dawn")).not.toContain(
      "hornbill-sky-dawn",
    );
    expect(TWILIGHT_SCENES.has("cloudy")).toBe(false);
  });

  it("skyClassName always includes the base class and the scene class", () => {
    expect(skyClassName("rain", false)).toBe(
      "hornbill-sky hornbill-sky-rain-night",
    );
  });
});

describe("palette — globals.css mirrors it exactly", () => {
  const entries: [string, string][] = [];
  for (const type of SCENE_TYPES) {
    for (const time of TIMES) {
      entries.push([`${type}-${time}-top`, SCENE_PALETTE[type][time].skyTop]);
      entries.push([
        `${type}-${time}-horizon`,
        SCENE_PALETTE[type][time].skyHorizon,
      ]);
    }
  }
  for (const ph of ["dawn", "dusk"] as const) {
    entries.push([`${ph}-top`, TWILIGHT_PALETTE[ph].skyTop]);
    entries.push([`${ph}-horizon`, TWILIGHT_PALETTE[ph].skyHorizon]);
  }

  it("light theme tokens equal the palette", () => {
    for (const [name, hex] of entries) {
      expect(token(lightScope, `weather-sky-${name}`), name).toBe(hex);
    }
  });

  it("dark theme tokens are the same sky dimmed (darkThemeSky)", () => {
    for (const [name, hex] of entries) {
      const dark = token(darkScope, `weather-sky-${name}`);
      expect(dark, name).toBe(darkThemeSky(hex));
      expect(luminance(dark)).toBeLessThanOrEqual(luminance(hex));
    }
  });

  it("every sky token is registered in @theme", () => {
    // Whitespace-tolerant: the formatter wraps long declarations as
    // `var(\n    --weather-sky-…\n  )`.
    for (const [name] of entries) {
      expect(globals).toMatch(
        new RegExp(
          `--color-weather-sky-${name}:\\s*var\\(\\s*--weather-sky-${name}\\s*\\);`,
        ),
      );
    }
  });
});

describe("palette — text over the sky stays readable", () => {
  // WeatherBackdrop: sky at opacity 0.8 (opacity-80) over the page surface,
  // then the .hornbill-veil (surface-card) under the header + breadcrumb.
  // WeatherLoadingScene: same sky, text on a surface-card/85 panel.
  const veil = Number(
    globals.match(
      /\.hornbill-veil\s*\{[\s\S]*?var\(--color-surface-card\)\s*(\d+)%/,
    )?.[1],
  );

  const SKY_OPACITY = 0.8;
  const themes = [
    { name: "light", scope: lightScope, dim: (h: string) => h },
    { name: "dark", scope: darkScope, dim: darkThemeSky },
  ];
  const skies: string[] = [];
  for (const type of SCENE_TYPES)
    for (const time of TIMES)
      skies.push(
        SCENE_PALETTE[type][time].skyTop,
        SCENE_PALETTE[type][time].skyHorizon,
      );
  for (const ph of ["dawn", "dusk"] as const)
    skies.push(TWILIGHT_PALETTE[ph].skyTop, TWILIGHT_PALETTE[ph].skyHorizon);

  it("declares a veil strength", () => {
    expect(veil).toBeGreaterThanOrEqual(70);
  });

  for (const { name, scope, dim } of themes) {
    it(`text-tertiary keeps 4.5:1 over every sky (${name})`, () => {
      const base = token(scope, "color-surface-base");
      const card = token(scope, "color-surface-card");
      const text = token(scope, "color-text-tertiary");
      for (const s of skies) {
        const composite = mixHex(
          mixHex(base, dim(s), SKY_OPACITY),
          card,
          veil / 100,
        );
        expect(
          contrastRatio(text, composite),
          `${name} ${s}`,
        ).toBeGreaterThanOrEqual(4.5);
        const panel = mixHex(mixHex(base, dim(s), SKY_OPACITY), card, 0.85);
        expect(contrastRatio(text, panel)).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
