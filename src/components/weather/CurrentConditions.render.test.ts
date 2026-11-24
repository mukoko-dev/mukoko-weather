/**
 * The hero, rendered for real (react-dom/server): open sky on top, one data
 * card under it. What a visitor's HTML contains for each condition family,
 * with and without an eyebrow, a breadcrumb, a country and missing data.
 * Effects do not run on the server, so this is the first paint (the place's
 * clock is not known yet); the clock-driven pieces (the local-time eyebrow,
 * the outlook, the hours, the activity clause) are covered by hero.test.ts,
 * hero-card.test.ts and HeroDataCard.test.ts.
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
import type {
  CurrentWeather,
  DailyWeather,
  HourlyWeather,
} from "@/lib/weather";

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

/** A short hourly series: only its presence matters before the clock is known. */
const hourly = {
  time: ["2026-10-31T10:00", "2026-10-31T11:00"],
  temperature_2m: [27, 28],
} as unknown as HourlyWeather;

/** The hero's sky: the section the Quick actions group watches. */
const skyOf = (html: string) =>
  html.slice(html.indexOf("<section"), html.indexOf("</section>"));
/** Everything under the sky: the data card. */
const cardOf = (html: string) => html.slice(html.indexOf("</section>"));

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

  it("keeps the sky bare of cards: no surface, shadow or legacy plate; the card below is ONE surface", () => {
    const html = render();
    expect(skyOf(html)).not.toMatch(/baobab|acacia|shadow|kori|plate/);
    expect(html).not.toMatch(/baobab|kori|plate/);
    expect(html.match(/\bacacia\b/g)).toHaveLength(1);
    expect(cardOf(html)).toContain("data-hero-card");
    // The card is a sibling of the sky, not inside it: the sky's white text
    // and focus ring are not the card's.
    expect(skyOf(html)).not.toContain("data-hero-card");
  });

  it("is a left-aligned stack labelled by the place-name heading, each identity row on its own line", () => {
    const html = render({}, { countryName: "Zimbabwe" });
    expect(html).not.toContain("text-center");
    expect(html).toContain('aria-labelledby="current-conditions-heading"');
    expect(html).toMatch(/<h2 id="current-conditions-heading"[^>]*>Harare</);
    const eyebrow = html.indexOf("col-start-1 row-start-1");
    const name = html.indexOf("col-start-1 row-start-2");
    const country = html.indexOf("col-start-1 row-start-3");
    const glyph = html.indexOf("col-start-2 row-span-3 row-start-1");
    expect(eyebrow).toBeGreaterThan(-1);
    expect(name).toBeGreaterThan(eyebrow);
    expect(country).toBeGreaterThan(name);
    expect(glyph).toBeGreaterThan(country);
    expect(html).toMatch(
      /<p class="col-start-1 row-start-3[^"]*">Zimbabwe<\/p>/,
    );
  });

  it("leaves the country row out when it is not known", () => {
    expect(render()).not.toContain("row-start-3");
  });

  it("shows the temperature as one Display-size, weight-400 numeral with the degree sign", () => {
    const html = render();
    expect(html).toContain("28 degrees Celsius");
    expect(html).toContain("text-[length:var(--text-display)]");
    expect(html).toContain("font-normal");
    expect(html).not.toContain("font-extralight");
    expect(html).toMatch(/<span aria-hidden="true">28°<\/span>/);
  });

  it("shows the condition as text and the glyph at 56px, aria-hidden, in its own column, a moon at night", () => {
    const day = render({ weather_code: 0, is_day: 1 });
    const night = render({ weather_code: 0, is_day: 0 });
    expect(day).toContain('width="56"');
    expect(day).toMatch(
      /<span aria-hidden="true" class="col-start-2 row-span-3 row-start-1 self-center block size-10 min-\[360px\]:size-14"><svg/,
    );
    expect(day).toContain("Clear sky");
    expect(night).not.toBe(day);
  });

  it("shows H:/L:/Feels as three wrapping parts", () => {
    const html = render();
    expect(html).toContain(
      "<span>H:28°</span><span>L:13°</span><span>Feels 27°</span>",
    );
    expect(html).toContain("flex-wrap");
  });

  it("omits H/L when missing and Feels when missing, each on its own, never NaN or zero", () => {
    const noDaily = render({}, { daily: undefined });
    expect(noDaily).not.toMatch(/H:/);
    expect(noDaily).toContain("<span>Feels 27°</span>");
    expect(noDaily).not.toContain("NaN");
    const noFeels = render({ apparent_temperature: Number.NaN });
    expect(noFeels).toContain("<span>H:28°</span><span>L:13°</span>");
    expect(noFeels).not.toContain("Feels 27");
    expect(noFeels).not.toContain("NaN");
    const neither = render(
      { apparent_temperature: Number.NaN },
      { daily: undefined },
    );
    expect(neither).not.toContain("tabular-nums text-[var(--sky-fg-dim)]");
  });

  it("prints a cold day with its minus signs", () => {
    const html = render({ temperature_2m: -3.2, apparent_temperature: -7.6 });
    expect(html).toContain('<span aria-hidden="true">-3°</span>');
    expect(html).toContain("Feels -8°");
    expect(html).not.toContain("NaN");
  });

  it("holds two lines for the outlook while the clock is unknown, and nothing when there is no hourly forecast", () => {
    const withHourly = render({}, { hourly, utcOffsetSeconds: 7200 });
    expect(withHourly).toContain(
      "min-h-[calc(2*var(--text-body)*var(--text-body-leading))]",
    );
    expect(render()).not.toContain("min-h-[calc(2*");
  });

  it("draws the mukoko mark alone in the top row on phones: no breadcrumb, no words, before the place's name", () => {
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
    const sky = skyOf(html);
    const mark = sky.indexOf(
      'aria-label="mukoko weather — return to home page"',
    );
    expect(mark).toBeGreaterThan(-1);
    expect(mark).toBeLessThan(sky.indexOf('id="current-conditions-heading"'));
    // A row for phones only (the site header carries the mark from `sm`), as
    // tall as the group's controls; the trail is not in it.
    expect(sky).toContain("sm:hidden");
    expect(sky).not.toContain("Home / Harare");
    // The group floats at the top right, mounted once by the layout: the row
    // no longer reserves room beside it, because nothing is drawn beside it.
    expect(html).not.toContain("pr-[var(--hadeda-reserve)]");
  });

  it("puts the breadcrumb under the data card, after the sky", () => {
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
    expect(cardOf(html)).toContain("Home / Harare");
    expect(html.indexOf("Home / Harare")).toBeGreaterThan(
      html.indexOf("</section>"),
    );
  });

  it("puts the sources above the breadcrumb, both under the card", () => {
    const html = render(
      {},
      {
        sources: createElement("p", null, "Contains information from NEA"),
        breadcrumb: createElement("nav", null, "Home / Harare"),
      },
    );
    const sources = html.indexOf("Contains information from NEA");
    expect(sources).toBeGreaterThan(html.indexOf("</section>"));
    expect(sources).toBeLessThan(html.indexOf("Home / Harare"));
  });

  it("puts the alerts under the top row and above the place's name, and draws no gap without one", () => {
    const withAlert = render(
      {},
      { notices: createElement("div", { role: "alert" }, "Frost advisory") },
    );
    const sky = skyOf(withAlert);
    const mark = sky.indexOf(
      'aria-label="mukoko weather — return to home page"',
    );
    const alert = sky.indexOf("Frost advisory");
    expect(alert).toBeGreaterThan(mark);
    expect(alert).toBeLessThan(sky.indexOf('id="current-conditions-heading"'));
    const without = skyOf(render());
    expect(without).not.toContain("space-y-3 pt-2");
    expect(without).not.toContain('role="alert"');
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
    // its height reserved, first in the identity grid after the top row.
    expect(html).toMatch(
      /<div class="pt-4 pb-\[26px\]"><div class="grid grid-cols-\[minmax\(0,1fr\)_auto\] items-start gap-x-2 min-\[360px\]:gap-x-3"><p class="col-start-1 row-start-1 flex min-h-\[calc\(var\(--text-caption\)/,
    );
  });

  it("shows the eyebrow only for current location or home, keeping the line reserved", () => {
    // The eyebrow line, not the page.
    const eyebrow = (html: string) =>
      html.match(
        /<p class="col-start-1 row-start-1 flex min-h-\[calc\(var\(--text-caption\)[^"]*">([\s\S]*?)<\/p>/,
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

  it("opens the data card under the sky: a labelled section with the first-paint strip, readings and the activities row last", () => {
    const html = render({}, { hourly, utcOffsetSeconds: 7200 });
    const card = cardOf(html);
    expect(card).toContain('aria-labelledby="hero-card-heading"');
    expect(card).toContain(
      '<h3 id="hero-card-heading" class="sr-only">Next hours and readings for Harare</h3>',
    );
    // Before the clock: "Now" with the numeral's temperature, the other four
    // hours hold their width, hidden.
    expect(card).toContain(">Now<");
    expect(card.match(/<li\b/g)).toHaveLength(5);
    expect(card.match(/<li aria-hidden="true"/g)).toHaveLength(4);
    // Feels / Wind / UV.
    expect(card).toContain("<dt");
    expect(card).toContain(">Feels<");
    expect(card).toContain(">Wind<");
    expect(card).toContain(">UV<");
    expect(card).toContain(">High<");
    // The activities row is the last thing in the card.
    const row = card.indexOf("Add your activities");
    expect(row).toBeGreaterThan(card.indexOf(">UV<"));
    expect(card.slice(row)).not.toMatch(/<(li|dl|dt|dd|ol|svg)\b/);
  });

  it("draws the activities invitation as a full-width button of at least the touch floor, with an arrow", () => {
    const card = cardOf(render());
    const button = card.match(/<button[^>]*>/)?.[0] ?? "";
    expect(button).toContain('type="button"');
    expect(button).toContain("w-full");
    expect(button).toContain("min-h-[var(--touch-target-min)]");
    expect(card).toContain("<span>Add your activities</span>");
    expect(card).toContain('<span aria-hidden="true">→</span>');
  });

  it("without an hourly forecast the hours and the curve are absent, not empty boxes, and the rest stays", () => {
    const html = render();
    const card = cardOf(html);
    expect(card).not.toContain("<ol");
    expect(card).not.toContain("<li");
    expect(card).not.toMatch(/<svg[^>]*viewBox/);
    expect(card).toContain(">Feels<");
    expect(card).toContain("Add your activities");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("undefined");
  });

  it("leaves a reading out when the payload lacks it, and the whole row when it lacks all three", () => {
    const some = cardOf(render({ wind_speed_10m: Number.NaN }));
    expect(some).toContain(">Feels<");
    expect(some).not.toContain(">Wind<");
    const none = cardOf(
      render({
        apparent_temperature: Number.NaN,
        wind_speed_10m: Number.NaN,
        uv_index: Number.NaN,
      }),
    );
    expect(none).not.toContain("<dl");
    expect(none).not.toContain("NaN");
  });

  it("is a surface made from the Mzizi tokens: card surface, line, radius, tabular figures, the floor's gaps", () => {
    const card = cardOf(render());
    expect(card).toContain("acacia");
    expect(card).toContain("tabular-nums");
    expect(card).toContain("rounded-[var(--radius-input)]");
    expect(card).toContain("gap-[var(--gap-floor)]");
    expect(card).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|style=/);
  });
});
