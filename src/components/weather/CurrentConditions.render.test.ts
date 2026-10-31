/**
 * The open-sky hero, rendered for real (react-dom/server): what a visitor's
 * HTML contains for each condition family, with and without an eyebrow,
 * activities and missing data. Effects do not run on the server, so the
 * clock-driven lines (outlook, activity clause) are covered by hero.test.ts.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CurrentConditions } from "./CurrentConditions";
import { SKY_CLASS, skyFamily, type SkyFamily } from "@/lib/hero";
import type { CurrentWeather, DailyWeather } from "@/lib/weather";

const base: CurrentWeather = {
  time: "2026-10-31T10:00",
  temperature_2m: 27.6,
  relative_humidity_2m: 40,
  apparent_temperature: 26.6,
  precipitation: 0,
  weather_code: 0,
  cloud_cover: 5,
  wind_speed_10m: 8,
  wind_direction_10m: 90,
  wind_gusts_10m: 12,
  uv_index: 6,
  surface_pressure: 1015,
  is_day: 1,
};

const daily = {
  temperature_2m_max: [28.4],
  temperature_2m_min: [13.2],
} as unknown as DailyWeather;

function render(
  current: Partial<CurrentWeather> = {},
  props: Record<string, unknown> = {},
) {
  return renderToStaticMarkup(
    createElement(CurrentConditions, {
      current: { ...base, ...current },
      locationName: "Harare",
      daily,
      slug: "harare",
      ...props,
    } as never),
  );
}

const CASES: Array<[SkyFamily, Partial<CurrentWeather>]> = [
  ["clear-day", { weather_code: 0, is_day: 1 }],
  ["clear-night", { weather_code: 0, is_day: 0 }],
  ["cloudy-day", { weather_code: 3, is_day: 1 }],
  ["cloudy-night", { weather_code: 3, is_day: 0 }],
  ["fog", { weather_code: 45 }],
  ["rain", { weather_code: 63 }],
  ["storm", { weather_code: 95 }],
  ["snow", { weather_code: 73 }],
];

describe("CurrentConditions render — open sky", () => {
  it.each(CASES)("paints the %s sky band behind the hero", (family, cur) => {
    expect(skyFamily(cur.weather_code ?? 0, cur.is_day !== 0)).toBe(family);
    const html = render(cur);
    expect(html).toContain(`kestrel ${SKY_CLASS[family]}`);
    expect(html).toContain(`data-sky="${family}"`);
    expect(html).toContain("data-sky-hero");
  });

  it("has no card: no baobab/acacia surface, shadow or legacy plate", () => {
    const html = render();
    expect(html).not.toMatch(/baobab|acacia|shadow|kori|plate/);
  });

  it("marks the band decorative", () => {
    expect(render()).toMatch(/<div aria-hidden="true" data-sky="clear-day"/);
  });

  it("is left-aligned and labelled by the place-name heading", () => {
    const html = render();
    expect(html).toContain("text-left");
    expect(html).toContain('aria-labelledby="current-conditions-heading"');
    expect(html).toMatch(/<h2 id="current-conditions-heading"[^>]*>Harare</);
  });

  it("shows the temperature as the single huge Noto Serif element", () => {
    const html = render();
    expect(html).toContain("28 degrees Celsius");
    expect(html).toContain("font-heading text-[clamp(5rem,26vw,6.5rem)]");
    expect(html).toContain("tabular-nums");
  });

  it("shows H/L and Feels on one wrapping line", () => {
    const html = render();
    expect(html).toContain("H 28°  L 13°");
    expect(html).toContain("Feels 27°");
    expect(html).toContain("flex-wrap");
  });

  it("omits the H/L and Feels parts that are missing (never zero)", () => {
    const html = render(
      { apparent_temperature: Number.NaN },
      { daily: undefined },
    );
    expect(html).not.toContain("Feels");
    expect(html).not.toContain("H NaN");
    expect(html).not.toMatch(/Feels 0|H 0/);
  });

  it("renders a decorative 56px condition icon, moon at night", () => {
    const day = render({ weather_code: 0, is_day: 1 });
    const night = render({ weather_code: 0, is_day: 0 });
    expect(day).toContain('width="56"');
    expect(day).toMatch(/<span aria-hidden="true" class="shrink-0"><svg/);
    expect(night).toContain('width="56"');
    expect(night).not.toBe(day);
  });

  it("puts Share in a round 48px control with a name, at the top", () => {
    const html = render();
    expect(html).toContain('aria-label="Share weather for Harare"');
    expect(html).toContain('class="kestrel-round"');
    expect(html.indexOf("kestrel-round")).toBeLessThan(
      html.indexOf("degrees Celsius"),
    );
  });

  it("demotes the activities call to a quiet text link that is still a button", () => {
    const html = render();
    expect(html).toMatch(
      /<button type="button" class="kestrel-link mt-1">Pick activities for tailored advice<\/button>/,
    );
    expect(html).not.toContain("kudu");
  });

  it("shows the eyebrow only for current location or home", () => {
    expect(render()).not.toContain("My Location");
    const html = render({}, { isCurrentLocation: true });
    expect(html).toContain("My Location");
    expect(html).toContain("uppercase");
  });

  it("places the footer slot (season line) at the foot of the sky", () => {
    const html = render({}, { footer: createElement("span", null, "Rainy") });
    expect(html).toContain("Rainy");
    expect(html.indexOf("Rainy")).toBeGreaterThan(html.indexOf("kestrel-link"));
  });

  it("reserves the fade below its content for the overlapping hourly panel", () => {
    expect(render()).toContain("pb-[var(--sky-fade)]");
  });
});
