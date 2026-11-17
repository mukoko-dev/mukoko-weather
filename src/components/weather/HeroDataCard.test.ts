/**
 * The hero's data card, rendered for real (react-dom/server) with the place's
 * clock known (the state after mount, which a server render of the whole hero
 * cannot reach: see CurrentConditions.render.test.ts for the first paint).
 * Plus source checks for what a render cannot show.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/harare",
  useRouter: () => ({ push: () => undefined }),
}));

import { HeroDataCard, type HeroActivityLine } from "./HeroDataCard";
import type { CurrentWeather, HourlyWeather } from "@/lib/weather";

const read = (p: string) => readFileSync(resolve(__dirname, p), "utf-8");

const OFFSET = 7200;
/** 14:10 in Harare. */
const NOW = new Date(Date.UTC(2026, 10, 17, 12, 10));

const current: CurrentWeather = {
  time: "2026-11-17T14:00",
  temperature_2m: 27.6,
  relative_humidity_2m: 40,
  apparent_temperature: 26.6,
  precipitation: 0,
  weather_code: 0,
  cloud_cover: 5,
  wind_speed_10m: 12,
  wind_direction_10m: 90,
  wind_gusts_10m: 18,
  uv_index: 9,
  surface_pressure: 1015,
  is_day: 1,
};

function hourlyOf(temps: number[], from = "2026-11-17T00:00"): HourlyWeather {
  const start = Date.parse(`${from}:00Z`);
  const zeros = temps.map(() => 0);
  return {
    time: temps.map((_, i) =>
      new Date(start + i * 3_600_000).toISOString().slice(0, 16),
    ),
    temperature_2m: temps,
    apparent_temperature: zeros,
    relative_humidity_2m: zeros,
    precipitation_probability: zeros,
    precipitation: zeros,
    weather_code: zeros,
    visibility: zeros,
    cloud_cover: zeros,
    surface_pressure: zeros,
    wind_speed_10m: zeros,
    wind_direction_10m: zeros,
    wind_gusts_10m: zeros,
    uv_index: zeros,
    is_day: zeros,
  };
}

/** 48 hours, warm in the afternoon, cool before dawn. */
const DAY = Array.from({ length: 48 }, (_, i) =>
  Math.round(20 + 8 * Math.cos(((i % 24) - 14) * (Math.PI / 12))),
);

function render(
  props: Partial<Parameters<typeof HeroDataCard>[0]> = {},
): string {
  return renderToStaticMarkup(
    createElement(HeroDataCard, {
      current,
      placeName: "Harare",
      hourly: hourlyOf(DAY),
      utcOffsetSeconds: OFFSET,
      now: NOW,
      hasSelection: false,
      activityLine: null,
      ...props,
    }),
  );
}

const farming: HeroActivityLine = {
  label: "Farming",
  dot: "bg-mineral-malachite",
  clause: "good until 15:00",
};

describe("HeroDataCard — with the clock known", () => {
  it("holds Now and the next four hours in the place's time, then the curve, the readings and the activities row", () => {
    const html = render();
    const hours = html.match(/<ol[\s\S]*?<\/ol>/)?.[0] ?? "";
    expect(hours.match(/<li\b/g)).toHaveLength(5);
    for (const label of [">Now<", ">15:00<", ">16:00<", ">17:00<", ">18:00<"]) {
      expect(hours).toContain(label);
    }
    // "Now" is the numeral's temperature, not the series'.
    expect(hours).toMatch(/>Now<\/span><span[^>]*>28°<\/span>/);
    expect(hours).not.toContain("aria-hidden");
    const order = ["<ol", "<svg", "<dl", "Add your activities"].map((token) =>
      html.indexOf(token),
    );
    expect(order.every((i) => i > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("draws the curve with its sentence as the accessible name, a now dot and tick labels at the caption size token", () => {
    const html = render();
    const svg = html.match(/<svg[^>]*role="img"[\s\S]*?<\/svg>/)?.[0] ?? "";
    expect(svg).toMatch(
      /aria-label="Temperature over the next 24 hours: 28 degrees now at 14:00,/,
    );
    expect(svg).toContain("28° now");
    expect(svg).toContain(">14:00<");
    expect(svg).toContain(">20:00<");
    expect(svg).toContain("text-[length:var(--text-caption)]");
    expect(svg).toContain("<circle");
    expect(svg).not.toMatch(/NaN|undefined|Infinity/);
  });

  it("shows Feels, Wind and UV with the band word", () => {
    const html = render();
    expect(html).toContain(">Feels<");
    expect(html).toContain("<span>27°</span>");
    expect(html).toContain("<span>12</span>");
    expect(html).toContain(">km/h<");
    expect(html).toContain("<span>9</span>");
    expect(html).toContain(">Very High<");
  });

  it("is a labelled section whose heading is screen-reader only", () => {
    const html = render();
    expect(html).toContain('aria-labelledby="hero-card-heading"');
    expect(html).toContain(
      '<h3 id="hero-card-heading" class="sr-only">Next hours and readings for Harare</h3>',
    );
  });

  it("with hourly data missing, shows no hours and no curve (not empty boxes) and keeps the readings and the row", () => {
    for (const hourly of [undefined, hourlyOf([])]) {
      const html = render({ hourly });
      expect(html).not.toContain("<ol");
      expect(html).not.toMatch(/<svg[^>]*viewBox/);
      expect(html).not.toContain("<li");
      expect(html).toContain(">Feels<");
      expect(html).toContain("Add your activities");
      expect(html).not.toMatch(/NaN|undefined/);
    }
  });

  it("with an hourly forecast that ended before now, shows no hours and no curve rather than old hours as 'Now'", () => {
    const html = render({ hourly: hourlyOf(DAY, "2026-11-10T00:00") });
    expect(html).not.toContain("<ol");
    expect(html).not.toMatch(/<svg[^>]*viewBox/);
    expect(html).not.toContain(">Now<");
  });

  it("with fewer than 24 hours left, draws the curve over what there is", () => {
    const html = render({
      hourly: hourlyOf([28, 27, 26, 25, 24], "2026-11-17T14:00"),
    });
    expect(html).toContain("over the next 4 hours");
    expect(html).toContain(">14:00<");
    // The next tick is six hours out: past where the data stops.
    expect(html).not.toContain(">20:00<");
  });

  it("with a freezing day, prints minus signs and says 'minus' to a screen reader", () => {
    const cold = hourlyOf(Array.from({ length: 48 }, (_, i) => -4 - (i % 12)));
    const html = render({
      current: { ...current, temperature_2m: -4.2, apparent_temperature: -9 },
      hourly: cold,
    });
    expect(html).toContain("<span>-9°</span>");
    expect(html).toContain("-4° now");
    expect(html).toContain("minus 4 degrees now at 14:00");
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it("with an all-equal series, draws a flat curve and says it holds", () => {
    const html = render({
      hourly: hourlyOf(Array.from({ length: 48 }, () => 21)),
      current: { ...current, temperature_2m: 21 },
    });
    expect(html).toContain("holding at 21 degrees");
    expect(html).not.toMatch(/NaN|undefined|Infinity/);
  });
});

describe("HeroDataCard — the activities row", () => {
  it("is a full-width button of at least the floor's target when nothing is picked", () => {
    const html = render();
    const button = html.match(/<button[^>]*>/)?.[0] ?? "";
    expect(button).toContain('type="button"');
    expect(button).toContain("w-full");
    expect(button).toContain("min-h-[var(--touch-target-min)]");
    expect(html).toContain("<span>Add your activities</span>");
  });

  it("is the card's last row", () => {
    const html = render();
    const row = html.indexOf("<button");
    expect(html.slice(row).match(/<(li|dl|svg|ol)\b/)).toBeNull();
    expect(html.endsWith("</button></section>")).toBe(true);
  });

  it("shows the clause, not the invitation, once activities are picked", () => {
    const html = render({ hasSelection: true, activityLine: farming });
    expect(html).not.toContain("Add your activities");
    expect(html).not.toContain("<button");
    expect(html).toContain("Farming: good until 15:00");
    expect(html).toContain("bg-mineral-malachite");
    expect(html).toContain("min-h-[var(--touch-target-min)]");
  });

  it("shows no row at all when activities are picked but there is nothing to say yet", () => {
    const html = render({ hasSelection: true, activityLine: null });
    expect(html).not.toContain("Add your activities");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("border-t");
  });
});

describe("HeroDataCard — source", () => {
  const card = read("HeroDataCard.tsx");
  const curve = read("HeroDayCurve.tsx");

  it("opens the same place the activities invitation opens: My Weather, Activities tab", () => {
    expect(card).toContain('openMyWeather("activities")');
    expect(read("ActivityInvite.tsx")).toContain('openMyWeather("activities")');
  });

  it("reads the shared helpers: no second copy of the hour slicing, the UV band or the wind format", () => {
    expect(card).toContain("heroHourStrip(");
    expect(card).toContain("heroReadings(");
    expect(curve).toContain("heroDayCurve(");
    const lib = read("../../lib/hero-card.ts");
    expect(lib).toContain("uvLevel(");
    expect(lib).toContain("formatWindSpeed(");
    expect(lib).toContain("currentHourIndex(");
    expect(lib).toContain("locationClockLabel(");
    expect(card + curve).not.toMatch(/getHours|getUTCHours|toLocaleTimeString/);
  });

  it("uses no hardcoded colour, no inline style, no negative margin or transform", () => {
    for (const src of [card, curve]) {
      expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(src).not.toMatch(/rgba?\(/);
      expect(src).not.toContain("style={{");
      expect(src).not.toMatch(/(^|[\s"'`:])-m[trblxy]?-|translate|transform/);
    }
  });

  it("draws the curve's text at the caption token, in real pixels: one <text>, with its reason, and a viewBox that is the measured width", () => {
    expect(curve.match(/<text\b/g)).toHaveLength(1);
    expect(curve).toMatch(/mzizi-text-exempt:[^\n]*1 unit is 1 CSS px/);
    expect(curve).toContain("text-[length:var(--text-caption)]");
    expect(curve).toContain("getBoundingClientRect().width");
    expect(curve).toContain("viewBox={`0 0 ${curve.width} ${curve.height}`}");
    expect(curve).toContain("new ResizeObserver(measure)");
  });

  it("holds the curve's height before the clock and leaves it out when there is no series", () => {
    expect(curve).toContain("if (!reserve || source) return null;");
    expect(card).toContain("reserve={now === null && hasHourly}");
  });

  it("reserves the strip's width before the clock with the first cell real", () => {
    expect(card).toContain("strip === null");
    expect(card).toContain("Array.from({ length: HERO_STRIP_HOURS }");
  });
});
