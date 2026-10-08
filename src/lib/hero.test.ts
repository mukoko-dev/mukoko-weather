import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  PLATE_CLASS,
  activityDotClass,
  currentHourIndex,
  formatHighLow,
  heroActivityClause,
  heroBadgeLabel,
  heroEyebrowBadges,
  heroOutlook,
  isHomeLocation,
  plateFamily,
  type PlateFamily,
} from "./hero";
import { contrastRatio } from "./contrast";
import type { HourlyWeather } from "./weather";

describe("heroEyebrowBadges", () => {
  it("shows nothing when the place is neither current nor home", () => {
    expect(heroEyebrowBadges(false, false)).toEqual([]);
  });

  it("shows only MY LOCATION for the GPS-confirmed current place", () => {
    expect(heroEyebrowBadges(true, false)).toEqual(["current"]);
  });

  it("shows only HOME when the place is the saved home but not GPS-confirmed", () => {
    expect(heroEyebrowBadges(false, true)).toEqual(["home"]);
  });

  it("shows both badges, current first, when the place is both", () => {
    expect(heroEyebrowBadges(true, true)).toEqual(["current", "home"]);
  });
});

describe("heroBadgeLabel", () => {
  it("labels the current-location badge My Location", () => {
    expect(heroBadgeLabel("current")).toBe("My Location");
  });

  it("labels the home badge Home", () => {
    expect(heroBadgeLabel("home")).toBe("Home");
  });
});

describe("isHomeLocation", () => {
  it("matches when the slug equals the home slug", () => {
    expect(isHomeLocation("singapore-sg", "singapore-sg")).toBe(true);
  });

  it("does not match a different slug", () => {
    expect(isHomeLocation("harare", "singapore-sg")).toBe(false);
  });

  it("is false when no home is set", () => {
    expect(isHomeLocation("harare", null)).toBe(false);
    expect(isHomeLocation("harare", undefined)).toBe(false);
  });

  it("is false when the page has no slug", () => {
    expect(isHomeLocation(undefined, "harare")).toBe(false);
    expect(isHomeLocation(undefined, null)).toBe(false);
  });
});

describe("formatHighLow", () => {
  it("formats the hero line with two spaces between H and L", () => {
    expect(formatHighLow(34.4, 24.6)).toBe("H:34°  L:25°");
  });

  it("rounds each value to the nearest whole degree", () => {
    expect(formatHighLow(33.5, 25.49)).toBe("H:34°  L:25°");
  });

  it("returns null when either value is missing", () => {
    expect(formatHighLow(undefined, 25)).toBeNull();
    expect(formatHighLow(34, null)).toBeNull();
  });

  it("returns null for non-finite values so NaN never renders", () => {
    expect(formatHighLow(Number.NaN, 25)).toBeNull();
    expect(formatHighLow(34, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("plateFamily", () => {
  it("maps clear skies to the day or night clear plate", () => {
    expect(plateFamily(0, true)).toBe("clear-day");
    expect(plateFamily(1, true)).toBe("clear-day");
    expect(plateFamily(0, false)).toBe("clear-night");
  });

  it("maps overcast and partly cloudy codes to the cloudy plates", () => {
    expect(plateFamily(2, true)).toBe("cloudy-day");
    expect(plateFamily(3, true)).toBe("cloudy-day");
    expect(plateFamily(3, false)).toBe("cloudy-night");
  });

  it("maps fog and mist to the fog plate at any hour", () => {
    expect(plateFamily(45, true)).toBe("fog");
    expect(plateFamily(48, false)).toBe("fog");
  });

  it("maps drizzle, rain and showers to the rain plate", () => {
    expect(plateFamily(51, true)).toBe("rain");
    expect(plateFamily(63, false)).toBe("rain");
    expect(plateFamily(81, true)).toBe("rain");
  });

  it("maps storms, snow and unknown codes to their families", () => {
    expect(plateFamily(95, false)).toBe("storm");
    expect(plateFamily(73, true)).toBe("snow");
    expect(plateFamily(10, true)).toBe("cloudy-day");
  });
});

describe("PLATE_CLASS", () => {
  it("has a modifier class for every plate family", () => {
    const families: PlateFamily[] = [
      "clear-day",
      "clear-night",
      "cloudy-day",
      "cloudy-night",
      "fog",
      "rain",
      "storm",
      "snow",
    ];
    for (const f of families) {
      expect(PLATE_CLASS[f]).toBe(`kori-${f}`);
    }
  });
});

describe("activityDotClass", () => {
  it("maps each activity category to its mineral dot", () => {
    expect(activityDotClass("farming")).toBe("bg-mineral-malachite");
    expect(activityDotClass("mining")).toBe("bg-mineral-terracotta");
    expect(activityDotClass("travel")).toBe("bg-mineral-cobalt");
    expect(activityDotClass("tourism")).toBe("bg-mineral-tanzanite");
    expect(activityDotClass("sports")).toBe("bg-mineral-gold");
    expect(activityDotClass("casual")).toBe("bg-mineral-copper");
  });

  it("falls back to copper for an unknown category", () => {
    expect(activityDotClass("unknown")).toBe("bg-mineral-copper");
  });
});

/** Hourly series starting at 14:00 local on 8 Oct 2026, 1 hour apart. */
function hourlyFrom(codes: number[]): HourlyWeather {
  const base = new Date(2026, 9, 8, 14, 0, 0);
  const time = codes.map((_, i) => {
    const d = new Date(base.getTime() + i * 3600_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
  });
  const n = codes.length;
  const zeros = Array(n).fill(0);
  return {
    time,
    temperature_2m: zeros,
    apparent_temperature: zeros,
    relative_humidity_2m: zeros,
    precipitation_probability: zeros,
    precipitation: zeros,
    weather_code: codes,
    wind_speed_10m: zeros,
    wind_gusts_10m: zeros,
    visibility: zeros,
    uv_index: zeros,
    is_day: zeros,
  } as unknown as HourlyWeather;
}

describe("currentHourIndex", () => {
  it("finds the first hour at or after now on the same day", () => {
    const times = ["2026-10-08T13:00", "2026-10-08T14:00", "2026-10-08T15:00"];
    expect(currentHourIndex(times, new Date(2026, 9, 8, 14, 20))).toBe(1);
  });

  it("falls back to the start when no hour matches", () => {
    expect(
      currentHourIndex(["2026-01-01T00:00"], new Date(2026, 9, 8, 14)),
    ).toBe(0);
  });
});

describe("heroOutlook", () => {
  it("returns null without an hourly series", () => {
    expect(heroOutlook(undefined, new Date())).toBeNull();
  });

  it("states when the condition changes, from the deterministic hourly summary", () => {
    // 14:00 clear (0), 15:00 clear, 16:00 rain (63)
    const hourly = hourlyFrom([0, 0, 63, 63, 63, 63]);
    const sentence = heroOutlook(hourly, new Date(2026, 9, 8, 14, 10));
    expect(sentence).toBe("Rain expected around 16:00.");
  });

  it("says the condition will continue when nothing changes", () => {
    const hourly = hourlyFrom([0, 0, 0, 0]);
    expect(heroOutlook(hourly, new Date(2026, 9, 8, 14, 0))).toBe(
      "Clear conditions will continue for the next 4 hours.",
    );
  });
});

describe("heroActivityClause", () => {
  const p = (level: "excellent" | "good" | "fair" | "poor", h: number) => ({
    time: `2026-10-08T${String(h).padStart(2, "0")}:00`,
    level,
  });

  it("returns null when there is no series", () => {
    expect(heroActivityClause([])).toBeNull();
  });

  it("names the hour the rating changes", () => {
    const points = [p("good", 14), p("good", 15), p("fair", 16), p("fair", 17)];
    expect(heroActivityClause(points)).toBe("good until 16:00");
  });

  it("says the rating holds for the whole window when nothing changes", () => {
    const points = [p("excellent", 14), p("excellent", 15), p("excellent", 16)];
    expect(heroActivityClause(points)).toBe("excellent for the next 3 hours");
  });
});

describe("sky plate tokens — contrast", () => {
  // globals.css @imports the Mzizi tokens (the --color-<mineral> sources the
  // plate tokens resolve through), so read both in cascade order. The Mzizi
  // light block is `:root, [data-theme="light"]`; normalise it to `:root`.
  const css =
    readFileSync(resolve(__dirname, "../app/mzizi-tokens.css"), "utf-8")
      .replace(/:root,\s*\[data-theme="light"\] \{/g, ":root {") +
    "\n" +
    readFileSync(resolve(__dirname, "../app/globals.css"), "utf-8");

  /** Body of the first top-level block whose selector matches. */
  function blockBody(selector: string): string {
    const start = css.indexOf(`${selector} {`);
    if (start < 0) throw new Error(`no block: ${selector}`);
    const open = css.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === "{") depth++;
      if (css[i] === "}") {
        depth--;
        if (depth === 0) return css.slice(open + 1, i);
      }
    }
    throw new Error(`unclosed block: ${selector}`);
  }

  /** Every `--name: value` declared in all blocks with this selector. */
  function declarations(selector: string): Map<string, string> {
    const map = new Map<string, string>();
    let from = 0;
    for (;;) {
      const at = css.indexOf(`${selector} {`, from);
      if (at < 0) break;
      const open = css.indexOf("{", at);
      let depth = 0;
      let end = open;
      for (let i = open; i < css.length; i++) {
        if (css[i] === "{") depth++;
        if (css[i] === "}") {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      const body = css.slice(open + 1, end);
      for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
        map.set(m[1], m[2].trim());
      }
      from = end;
    }
    return map;
  }

  const rootVars = declarations(":root");
  const darkVars = declarations('[data-theme="dark"]');

  /** Resolve a custom property to a hex colour for one theme. */
  function resolveColour(
    name: string,
    scope: "light" | "dark",
    depth = 0,
  ): string {
    if (depth > 10) throw new Error(`cycle at ${name}`);
    const raw = (scope === "dark" && darkVars.get(name)) || rootVars.get(name);
    if (!raw) throw new Error(`undeclared token ${name} (${scope})`);
    const ref = raw.match(/^var\((--[\w-]+)\)$/);
    if (ref) return resolveColour(ref[1], scope, depth + 1);
    if (!/^#[0-9a-fA-F]{6}$/.test(raw)) {
      throw new Error(`${name} is not a resolvable hex: ${raw}`);
    }
    return raw.toLowerCase();
  }

  const families = Object.keys(PLATE_CLASS) as PlateFamily[];

  it("declares every plate family's colour and foreground token in both themes", () => {
    for (const f of families) {
      for (const scope of ["light", "dark"] as const) {
        expect(() => resolveColour(`--plate-${f}`, scope)).not.toThrow();
        expect(() => resolveColour(`--plate-${f}-fg`, scope)).not.toThrow();
      }
    }
  });

  it("wires each family modifier class to its plate token", () => {
    const body = blockBody(".kori-clear-day");
    expect(body).toContain("--kori-bg: var(--plate-clear-day)");
    for (const f of families) {
      expect(css).toContain(`.kori-${f} {`);
      expect(css).toContain(`--kori-bg: var(--plate-${f});`);
    }
  });

  it("keeps body text on every plate at WCAG AA 4.5:1 in light and dark", () => {
    for (const f of families) {
      for (const scope of ["light", "dark"] as const) {
        const ratio = contrastRatio(
          resolveColour(`--plate-${f}`, scope),
          resolveColour(`--plate-${f}-fg`, scope),
        );
        expect(ratio, `${f} ${scope}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("uses only solid mineral values: no gradients or translucent plates", () => {
    const kori = css.slice(
      css.indexOf(".kori {"),
      css.indexOf(".kori-clear-day {"),
    );
    expect(kori).not.toMatch(/gradient|blur|rgba/);
  });
});
