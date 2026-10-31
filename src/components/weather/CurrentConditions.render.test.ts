/**
 * The open-sky hero, rendered for real (react-dom/server): what a visitor's
 * HTML contains for each condition family, with and without an eyebrow, a
 * breadcrumb, a footer and missing data. Effects do not run on the server, so
 * the clock-driven pieces (the local-time eyebrow, the activity clause) are
 * covered by hero.test.ts.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The ⋯ menu pulls in the auth client (needs the Next runtime); its own
// structure is covered in Header.test.ts.
vi.mock("@/components/layout/MobileMoreMenu", () => ({
  MobileMoreMenu: (p: { buttonClassName: string }) =>
    createElement("button", {
      type: "button",
      "aria-label": "More options",
      className: p.buttonClassName,
    }),
}));

import { CurrentConditions } from "./CurrentConditions";
import { skyFamily, type SkyFamily } from "@/lib/hero";
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

describe("CurrentConditions render — the sky hero", () => {
  it.each(CASES)("tags the %s hero with its sky family", (family, cur) => {
    expect(skyFamily(cur.weather_code ?? 0, cur.is_day !== 0)).toBe(family);
    const html = render(cur);
    expect(html).toContain(`data-sky="${family}"`);
    expect(html).toContain("data-sky-hero");
  });

  it("has no card: no baobab/acacia surface, shadow or legacy plate", () => {
    expect(render()).not.toMatch(/baobab|acacia|shadow|kori|plate/);
  });

  it("is a centred stack labelled by the place-name heading", () => {
    const html = render();
    expect(html).toContain("text-center");
    expect(html).toContain('aria-labelledby="current-conditions-heading"');
    expect(html).toMatch(/<h2 id="current-conditions-heading"[^>]*>Harare</);
  });

  it("shows the temperature as one Display-size, weight-400 numeral with the degree sign", () => {
    const html = render();
    expect(html).toContain("28 degrees Celsius");
    expect(html).toContain("text-[length:var(--text-display)]");
    expect(html).toContain("font-normal");
    expect(html).not.toContain("font-extralight");
    expect(html).toMatch(/<span aria-hidden="true">28°<\/span>/);
  });

  it("shows the condition with an aria-hidden 20px glyph, a moon at night", () => {
    const day = render({ weather_code: 0, is_day: 1 });
    const night = render({ weather_code: 0, is_day: 0 });
    expect(day).toContain('width="20"');
    expect(day).toMatch(/<span aria-hidden="true" class="shrink-0"><svg/);
    expect(day).toContain("Clear sky");
    expect(night).not.toBe(day);
  });

  it("shows H:/L: as two wrapping parts", () => {
    const html = render();
    expect(html).toContain("<span>H:28°</span><span>L:13°</span>");
    expect(html).toContain("flex-wrap");
  });

  it("omits H/L when missing, never H:NaN or zero", () => {
    const html = render({}, { daily: undefined });
    expect(html).not.toMatch(/H:/);
    expect(html).not.toContain("NaN");
  });

  it("does not repeat the outlook, feels-like or an activities call in the hero", () => {
    const html = render();
    expect(html).not.toContain("Feels");
    expect(html).not.toContain("Pick activities");
    expect(html).not.toContain("kudu");
  });

  it("puts the breadcrumb, Share and the phone ⋯ menu in the top row, before the stack", () => {
    const html = render(
      {},
      {
        breadcrumb: createElement(
          "nav",
          { "aria-label": "Breadcrumb" },
          "Home / Harare",
        ),
      },
    );
    const crumb = html.indexOf("Home / Harare");
    const share = html.indexOf('aria-label="Share weather for Harare"');
    const more = html.indexOf('aria-label="More options"');
    const name = html.indexOf('id="current-conditions-heading"');
    expect(crumb).toBeGreaterThan(-1);
    expect(crumb).toBeLessThan(share);
    expect(share).toBeLessThan(more);
    expect(more).toBeLessThan(name);
    expect(html).toContain('class="kestrel-round"');
    expect(html).toMatch(
      /<div class="relative sm:hidden"><button[^>]*kestrel-round/,
    );
  });

  it("shows the eyebrow only for current location or home, keeping the line reserved", () => {
    const plain = render();
    expect(plain).not.toContain("My Location");
    expect(plain).toContain(
      "min-h-[calc(var(--text-caption)*var(--text-caption-leading))]",
    );
    const html = render({}, { isCurrentLocation: true });
    expect(html).toContain("My Location");
    expect(html).toContain("uppercase");
  });
});
