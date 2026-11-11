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

// The hero holds no controls of its own (the Quick actions group is the
// layout's: see QuickActions.render.test.ts); the mocks keep its imports whole.
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

  it("puts the breadcrumb in the top row, before the stack, and leaves room for the Quick actions group on phones", () => {
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
    const name = html.indexOf('id="current-conditions-heading"');
    expect(crumb).toBeGreaterThan(-1);
    expect(crumb).toBeLessThan(name);
    // The group (Share, Notifications, Locations) floats at the top right,
    // mounted once by the layout; the trail leaves room for it on phones
    // (three controls wide) and has the whole row from `sm`.
    expect(html).toContain("pr-[var(--hadeda-reserve)]");
    expect(html).toContain("sm:pr-0");
  });

  it("holds no controls of its own: no Share, no Notifications, no Locations, no group, no account menu", () => {
    const html = render();
    expect(html).not.toContain("hadeda sm:hidden");
    expect(html).not.toContain('class="hadeda');
    expect(html).not.toMatch(/aria-label="Share/);
    expect(html).not.toContain('aria-label="All locations"');
    expect(html).not.toContain("Notifications");
    expect(html).not.toContain("kestrel-round");
    expect(html).not.toContain('role="toolbar"');
    expect(html).not.toContain("<details");
    expect(html).not.toContain("account-menu");
  });

  it("is the sky hero the group watches: it carries data-sky-hero, and its first line (the eyebrow) is the element the group observes", () => {
    const html = render();
    expect(html).toContain("data-sky-hero");
    // The first line of the content stack is the eyebrow: always drawn, with
    // its height reserved, after the top row.
    expect(html).toMatch(
      /<div class="flex flex-col items-center pt-4 pb-\[26px\] text-center"><p class="flex min-h-\[calc\(var\(--text-caption\)/,
    );
  });

  it("shows the eyebrow only for current location or home, keeping the line reserved", () => {
    // The eyebrow line, not the page.
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
