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

// My Location (the round arrow link in the phone icon group) reads the route
// and the router; its own structure is covered in MyLocationLink.test.ts.
const nav = vi.hoisted(() => ({ pathname: "/harare" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: () => undefined }),
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

  it("puts the breadcrumb, Share and My Location in the top row, before the stack", () => {
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
    const group = html.indexOf('class="hadeda sm:hidden"');
    const name = html.indexOf('id="current-conditions-heading"');
    expect(crumb).toBeGreaterThan(-1);
    expect(crumb).toBeLessThan(group);
    expect(group).toBeLessThan(name);
    // From `sm` up, Share sits in the top row on the sky.
    expect(html).toMatch(
      /<div class="hidden shrink-0 sm:block"><div class="relative"><button[^>]*kestrel-round/,
    );
    // On phones, Share and My Location are ONE fixed group, both round
    // `duiker` controls on its card surface, Share first.
    const inGroup = html.slice(group, name);
    const share = inGroup.indexOf('aria-label="Share weather for Harare"');
    const here = inGroup.indexOf('aria-label="My Location"');
    expect(share).toBeGreaterThan(-1);
    expect(share).toBeLessThan(here);
    expect(inGroup.match(/class="duiker"/g)).toHaveLength(2);
    expect(inGroup).not.toContain("kestrel-round");
    // The breadcrumb leaves room for the group on phones, none from `sm`.
    expect(html).toContain("pr-[var(--hadeda-reserve)]");
    expect(html).toContain("sm:pr-0");
  });

  it("holds My Location (a link to `/`) in the phone group and no account menu: the avatar moved to the bottom bar", () => {
    const html = render();
    const group = html.slice(
      html.indexOf('class="hadeda sm:hidden"'),
      html.indexOf('id="current-conditions-heading"'),
    );
    const link = group.match(/<a[^>]*aria-label="My Location"[^>]*>/)![0];
    expect(link).toContain('href="/"');
    expect(link).toContain('class="duiker"');
    // Not the current page on a place's own page.
    expect(link).not.toContain("aria-current");
    // The account menu (its <details>, its summary, its panel) is not in the hero.
    expect(html).not.toContain("<details");
    expect(html).not.toContain("account-menu");
    expect(html).not.toContain("Account menu");
    expect(html).not.toContain("More options");
  });

  it("marks My Location as the current page on `/`", () => {
    nav.pathname = "/";
    try {
      const html = render();
      expect(html).toMatch(
        /<a[^>]*aria-label="My Location"[^>]*aria-current="page"|<a[^>]*aria-current="page"[^>]*aria-label="My Location"/,
      );
    } finally {
      nav.pathname = "/harare";
    }
  });

  it("renders the phone Share and the desktop Share as two instances, one hidden at each width", () => {
    const html = render();
    expect(html.match(/aria-label="Share weather for Harare"/g)).toHaveLength(
      2,
    );
    expect(html.match(/<div class="hidden shrink-0 sm:block">/g)).toHaveLength(
      1,
    );
    expect(html.match(/class="hadeda sm:hidden"/g)).toHaveLength(1);
  });

  it("shows the eyebrow only for current location or home, keeping the line reserved", () => {
    // The eyebrow line, not the page: My Location is also the name of the
    // round link in the phone icon group.
    const eyebrow = (html: string) =>
      html.match(
        /<p class="flex min-h-\[calc\(var\(--text-caption\)[^"]*">([\s\S]*?)<\/p>/,
      )?.[1] ?? "";
    const plain = render();
    expect(eyebrow(plain)).not.toContain("My Location");
    expect(plain).toContain(
      "min-h-[calc(var(--text-caption)*var(--text-caption-leading))]",
    );
    const html = render({}, { isCurrentLocation: true });
    expect(eyebrow(html)).toContain("My Location");
    expect(html).toContain("uppercase");
  });
});
