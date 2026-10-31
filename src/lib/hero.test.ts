import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  SKY_CLASS,
  activityDotClass,
  currentHourIndex,
  formatHighLowParts,
  skyTexture,
  heroLocalTime,
  skyReachCss,
  SKY_CLEARANCE_REM,
  SKY_FADE_REM,
  SKY_MIN_REM,
  formatHighLow,
  heroActivityClause,
  heroBadgeLabel,
  heroEyebrowBadges,
  heroOutlook,
  isHomeLocation,
  skyFamily,
  type SkyFamily,
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

describe("formatHighLowParts", () => {
  it("splits the line so it can wrap between H and L", () => {
    expect(formatHighLowParts(34.4, 24.6)).toEqual(["H:34°", "L:25°"]);
  });

  it("returns null when either value is missing or not finite (missing is never zero)", () => {
    expect(formatHighLowParts(undefined, 25)).toBeNull();
    expect(formatHighLowParts(34, null)).toBeNull();
    expect(formatHighLowParts(Number.NaN, 25)).toBeNull();
  });
});

describe("heroLocalTime", () => {
  it("reads the clock in the PLACE's offset, never the viewer's", () => {
    const now = new Date("2026-10-31T15:03:00Z");
    expect(heroLocalTime(now, 7200)).toBe("17:03 LOCAL");
    expect(heroLocalTime(now, 28800)).toBe("23:03 LOCAL");
    expect(heroLocalTime(now, -18000)).toBe("10:03 LOCAL");
  });

  it("wraps across midnight and pads", () => {
    expect(heroLocalTime(new Date("2026-10-31T23:30:00Z"), 7200)).toBe(
      "01:30 LOCAL",
    );
  });

  it("is null until there is a client clock", () => {
    expect(heroLocalTime(null, 7200)).toBeNull();
    expect(heroLocalTime(new Date(Number.NaN), 7200)).toBeNull();
  });
});

describe("skyReachCss — the sky extends with its content", () => {
  it("is the larger of one screen + 8rem, the floor and the content bottom + clearance + fade", () => {
    const css = skyReachCss(700, 16);
    const px = Math.ceil(700 + (SKY_CLEARANCE_REM + SKY_FADE_REM) * 16);
    expect(css).toBe(`max(100svh + 8rem, ${SKY_MIN_REM}rem, ${px}px)`);
    expect(px).toBe(820);
  });

  it("the floor keeps the Conditions card out of the fade before anything is measured", () => {
    // Measured card bottoms (rem): 44 at 100% text, 51 at 200% text, with the
    // outlook line. The floor must clear them plus clearance and the fade.
    for (const cardBottomRem of [44, 46, 51]) {
      expect(SKY_MIN_REM).toBeGreaterThanOrEqual(
        cardBottomRem + SKY_CLEARANCE_REM + SKY_FADE_REM,
      );
    }
    const css = readFileSync(resolve(__dirname, "../app/globals.css"), "utf-8");
    expect(css).toContain(
      `--sky-reach: max(100svh + 8rem, ${SKY_MIN_REM}rem);`,
    );
  });

  it("grows with text zoom: the margin is in root-font units", () => {
    const normal = skyReachCss(700, 16)!;
    const zoomed = skyReachCss(700, 32)!;
    const n = (s: string) => parseInt(s.match(/, (\d+)px/)![1], 10);
    expect(n(zoomed) - n(normal)).toBe(
      Math.ceil((SKY_CLEARANCE_REM + SKY_FADE_REM) * 32) -
        Math.ceil((SKY_CLEARANCE_REM + SKY_FADE_REM) * 16),
    );
  });

  it("always leaves the whole fade (6rem) below the content, so content never sits in it", () => {
    for (const rootPx of [12, 16, 24, 32]) {
      for (const bottom of [300, 667, 900, 1500]) {
        const px = parseInt(
          skyReachCss(bottom, rootPx)!.match(/, (\d+)px/)![1],
          10,
        );
        expect(px - bottom).toBeGreaterThanOrEqual(SKY_FADE_REM * rootPx);
      }
    }
  });

  it("returns null with nothing to measure or a bad root size (keep the CSS default)", () => {
    expect(skyReachCss(null, 16)).toBeNull();
    expect(skyReachCss(undefined, 16)).toBeNull();
    expect(skyReachCss(Number.NaN, 16)).toBeNull();
    expect(skyReachCss(500, 0)).toBeNull();
    expect(skyReachCss(500, Number.NaN)).toBeNull();
  });

  it("mirrors the --sky-fade token", () => {
    const css = readFileSync(resolve(__dirname, "../app/globals.css"), "utf-8");
    expect(css).toContain(`--sky-fade: ${SKY_FADE_REM}rem;`);
  });
});

describe("skyTexture", () => {
  it("puts stars on the night skies and streaks on rain and storms, nothing else", () => {
    expect(skyTexture("clear-night")).toBe("stars");
    expect(skyTexture("cloudy-night")).toBe("stars");
    expect(skyTexture("rain")).toBe("streaks");
    expect(skyTexture("storm")).toBe("streaks");
    for (const f of ["clear-day", "cloudy-day", "fog", "snow"] as const) {
      expect(skyTexture(f)).toBeNull();
    }
  });
});

describe("skyFamily", () => {
  it("maps clear skies to the day or night clear plate", () => {
    expect(skyFamily(0, true)).toBe("clear-day");
    expect(skyFamily(1, true)).toBe("clear-day");
    expect(skyFamily(0, false)).toBe("clear-night");
  });

  it("maps overcast and partly cloudy codes to the cloudy plates", () => {
    expect(skyFamily(2, true)).toBe("cloudy-day");
    expect(skyFamily(3, true)).toBe("cloudy-day");
    expect(skyFamily(3, false)).toBe("cloudy-night");
  });

  it("maps fog and mist to the fog plate at any hour", () => {
    expect(skyFamily(45, true)).toBe("fog");
    expect(skyFamily(48, false)).toBe("fog");
  });

  it("maps drizzle, rain and showers to the rain plate", () => {
    expect(skyFamily(51, true)).toBe("rain");
    expect(skyFamily(63, false)).toBe("rain");
    expect(skyFamily(81, true)).toBe("rain");
  });

  it("maps storms, snow and unknown codes to their families", () => {
    expect(skyFamily(95, false)).toBe("storm");
    expect(skyFamily(73, true)).toBe("snow");
    expect(skyFamily(10, true)).toBe("cloudy-day");
  });
});

describe("SKY_CLASS", () => {
  it("has a modifier class for every sky family", () => {
    const families: SkyFamily[] = [
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
      expect(SKY_CLASS[f]).toBe(`kestrel-${f}`);
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

describe("sky tokens — contrast", () => {
  // globals.css @imports the Mzizi tokens (the --color-<mineral> sources the
  // plate tokens resolve through), so read both in cascade order. The Mzizi
  // light block is `:root, [data-theme="light"]`; normalise it to `:root`.
  const css =
    readFileSync(
      resolve(__dirname, "../app/mzizi-tokens.css"),
      "utf-8",
    ).replace(/:root,\s*\[data-theme="light"\] \{/g, ":root {") +
    "\n" +
    readFileSync(resolve(__dirname, "../app/globals.css"), "utf-8").replace(
      /:root,\s*\[data-theme="light"\] \{/g,
      ":root {",
    );

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

  /** A custom property's literal value from :root. */
  const resolveRaw = (name: string) => rootVars.get(name);

  const families = Object.keys(SKY_CLASS) as SkyFamily[];
  const FG = "#ffffff";

  /** WCAG relative luminance of a #rrggbb colour. */
  function luminance(hex: string): number {
    const [r, g, b] = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  it("declares the white sky foreground once", () => {
    expect(resolveColour("--sky-fg", "light")).toBe(FG);
    expect(resolveColour("--sky-fg", "dark")).toBe(FG);
  });

  const STOPS = ["top", "mid", "bottom"] as const;

  it("declares every sky family's top, mid and bottom stop in both themes", () => {
    for (const f of families) {
      for (const scope of ["light", "dark"] as const) {
        for (const stop of STOPS) {
          expect(() =>
            resolveColour(`--sky-${f}-${stop}`, scope),
          ).not.toThrow();
        }
      }
    }
  });

  it("wires each family modifier class to its sky stops", () => {
    for (const f of families) {
      const body = blockBody(`.kestrel-${f}`);
      expect(body).toContain(`--kestrel-top: var(--sky-${f}-top)`);
      expect(body).toContain(`--kestrel-mid: var(--sky-${f}-mid)`);
      expect(body).toContain(`--kestrel-bottom: var(--sky-${f}-bottom)`);
    }
  });

  it("keeps white text at WCAG AA 4.5:1 on EVERY gradient stop (8 families x light/dark x 3 stops)", () => {
    let checked = 0;
    for (const f of families) {
      for (const scope of ["light", "dark"] as const) {
        for (const stop of STOPS) {
          const bg = resolveColour(`--sky-${f}-${stop}`, scope);
          for (const fg of ["--sky-fg", "--sky-fg-dim"]) {
            const ratio = contrastRatio(bg, resolveColour(fg, scope));
            expect(
              ratio,
              `${fg} on ${f} ${scope} ${stop} ${bg}`,
            ).toBeGreaterThanOrEqual(4.5);
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(96);
  });

  it("draws the keyboard focus ring on the sky in --sky-fg: >= 3:1 on every gradient stop (WCAG 1.4.11), where the page ring (--focus-ring) is not", () => {
    let pageRingLost = 0;
    for (const f of families) {
      for (const scope of ["light", "dark"] as const) {
        for (const stop of STOPS) {
          const bg = resolveColour(`--sky-${f}-${stop}`, scope);
          expect(
            contrastRatio(resolveColour("--sky-fg", scope), bg),
            `sky ring on ${f} ${scope} ${stop} ${bg}`,
          ).toBeGreaterThanOrEqual(3);
          if (contrastRatio(resolveColour("--focus-ring", scope), bg) < 3) {
            pageRingLost++;
          }
        }
      }
    }
    // The page ring vanishes on most sky stops (the reason the sky re-points
    // --focus-ring); if the palette ever changes so it no longer does, this
    // guard can be revisited rather than silently kept.
    expect(pageRingLost).toBeGreaterThan(0);
  });

  it("uses the owner's mockup values for the night and rain skies", () => {
    expect(resolveColour("--sky-clear-night-top", "dark")).toBe("#0b1026");
    expect(resolveColour("--sky-clear-night-mid", "dark")).toBe("#151c42");
    expect(resolveColour("--sky-clear-night-bottom", "dark")).toBe("#1c2550");
    expect(resolveColour("--sky-rain-top", "dark")).toBe("#3a4656");
    expect(resolveColour("--sky-rain-mid", "dark")).toBe("#4a5768");
    expect(resolveColour("--sky-rain-bottom", "dark")).toBe("#3e4a5a");
    expect(blockBody(".kestrel-clear-night")).toContain(
      "--kestrel-mid-at: 55%",
    );
    expect(blockBody(".kestrel-rain")).toContain("--kestrel-mid-at: 45%");
  });

  it("makes dark a real night/dusk design, never lighter than light, never a bright slab", () => {
    for (const f of families) {
      for (const stop of STOPS) {
        const light = luminance(resolveColour(`--sky-${f}-${stop}`, "light"));
        const dark = luminance(resolveColour(`--sky-${f}-${stop}`, "dark"));
        expect(dark, `${f} ${stop}`).toBeLessThanOrEqual(light);
      }
      expect(
        luminance(resolveColour(`--sky-${f}-bottom`, "dark")),
        f,
      ).toBeLessThan(0.1);
    }
    // The day sky is a different design in light and dark.
    expect(resolveColour("--sky-clear-day-top", "dark")).not.toBe(
      resolveColour("--sky-clear-day-top", "light"),
    );
  });

  it("paints a three-stop vertical gradient, static (no glass, shadow, blur or animation)", () => {
    const band = blockBody(".kestrel");
    expect(band).toContain("linear-gradient(");
    expect(band).toContain("var(--kestrel-mid) var(--kestrel-mid-at)");
    expect(band).not.toMatch(/blur|rgba|box-shadow|animation|transition/);
    expect(band).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("carries faint static texture: stars on night, streaks on rain (top 340px, 105deg, 14px gaps)", () => {
    expect(blockBody(".kestrel-stars")).toContain("radial-gradient(");
    const streaks = blockBody(".kestrel-streaks");
    expect(streaks).toContain("height: 340px");
    expect(streaks).toContain("105deg");
    expect(streaks).toContain("1px 14px");
    for (const sel of [".kestrel-stars", ".kestrel-streaks"]) {
      expect(blockBody(sel)).not.toMatch(/animation|transition|blur/);
    }
  });

  it("the Conditions card is a translucent bordered card: ~7% fill, hairline, 22px, no shadow, no blur", () => {
    const at = css.indexOf("  .kestrel-card {\n    background-color");
    const card = css.slice(at, css.indexOf("}", at));
    expect(card).toContain("var(--sky-fg) 7%, transparent");
    expect(card).toContain("border: 1px solid");
    expect(card).toContain("border-radius: var(--radius-sky-card)");
    expect(card).toContain("padding: var(--space-card)");
    expect(card).not.toMatch(/shadow|blur|backdrop/);
    expect(resolveRaw("--radius-sky-card")).toBe("1.375rem");
  });

  it("re-points the text tokens inside the sky card and the hero's season line", () => {
    const at = css.indexOf("  .kestrel-ink,");
    const ink = css.slice(at, css.indexOf("}", at));
    expect(ink).toContain(".kestrel-card");
    for (const t of [
      "--color-text-primary",
      "--color-text-secondary",
      "--color-primary",
      "--color-border",
    ]) {
      expect(ink).toContain(`${t}:`);
    }
  });

  it("the round control (Share, ⋯) is 48px, round, bordered, shadowless", () => {
    const round = blockBody(".kestrel-round");
    expect(round).toContain("w-[var(--touch-target-min)]");
    expect(round).toContain("h-[var(--touch-target-min)]");
    expect(round).toContain("rounded-full");
    expect(round).toContain("border");
    expect(round).not.toMatch(/shadow|blur/);
  });

  it("the sky box starts at the top of the page, is one screen + 8rem tall (60rem at least) and fades out over 6rem", () => {
    expect(resolveRaw("--sky-fade")).toBe("6rem");
    expect(resolveRaw("--sky-reach")).toBe("max(100svh + 8rem, 60rem)");
    const reach = blockBody(".kestrel-reach");
    expect(reach).toContain("position: absolute");
    expect(reach).toContain("top: 0");
    expect(reach).toContain("height: var(--sky-reach)");
    expect(reach).toContain("mask-image");
    // It scrolls away with the page: never fixed.
    expect(reach).not.toContain("fixed");
  });
});
