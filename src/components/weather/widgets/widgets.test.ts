import { describe, it, expect } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CompassDial,
  GradientScale,
  InsightCard,
  InsightCardSkeleton,
  InsightGrid,
  MiniBars,
  MoonDisc,
  PressureDial,
  ScaleReadout,
  SunArc,
  insightCardSizeClass,
} from "./index";

const h = React.createElement;
const render = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("CompassDial", () => {
  it("labels the wind with its FROM bearing and speed", () => {
    const html = render(h(CompassDial, { directionDeg: 70, speed: 5 }));
    expect(html).toContain('aria-label="Wind 5 km/h from the ENE"');
    expect(html).toContain('role="img"');
  });

  it("rotates the needle group by exactly directionDeg", () => {
    const html = render(h(CompassDial, { directionDeg: 135, speed: 9 }));
    expect(html).toContain('transform="rotate(135 50 50)"');
    expect(html).toContain('data-needle-rotation="135"');
  });

  it("includes gust in the accessible name and centre caption", () => {
    const html = render(
      h(CompassDial, { directionDeg: 0, speed: 5, gust: 14 }),
    );
    expect(html).toContain("gusts 14 km/h");
  });
});

describe("GradientScale", () => {
  it("places the marker at positionPct", () => {
    const html = render(h(GradientScale, { positionPct: 42, stops: "uv" }));
    expect(html).toContain('data-marker-pct="42"');
    // The marker's left edge IS the value's position along the track.
    expect(html).toContain("left:42%");
  });

  it("paints one smooth gradient from the scale's tokens, not stepped bands", () => {
    const aqi = render(h(GradientScale, { positionPct: 30, stops: "aqi" }));
    // The six official EPA tokens, in order, at the middle of their bands.
    const stops = [...aqi.matchAll(/var\(--wx-aqi-(\d)\) ([\d.]+)%/g)].map(
      (m) => [Number(m[1]), Number(m[2])],
    );
    expect(stops).toEqual([
      [1, 8.33],
      [2, 25],
      [3, 41.67],
      [4, 58.33],
      [5, 75],
      [6, 91.67],
    ]);
    const uv = render(h(GradientScale, { positionPct: 30, stops: "uv" }));
    expect([...uv.matchAll(/var\(--wx-uv-(\d)\) ([\d.]+)%/g)]).toHaveLength(5);
    // One gradient element, no per-band rectangles (the old hard seams).
    expect(aqi.match(/linear-gradient\(/g)).toHaveLength(1);
    expect(aqi).not.toContain("data-band");
    expect(aqi).not.toContain("<rect");
    // No hard seam: no two adjacent stops share a position.
    const positions = stops.map(([, pct]) => pct);
    positions.forEach((p, i) => {
      if (i > 0) expect(p).toBeGreaterThan(positions[i - 1]);
    });
  });

  it("clamps the marker into 0–100", () => {
    expect(
      render(h(GradientScale, { positionPct: 150, stops: "aqi" })),
    ).toContain('data-marker-pct="100"');
    expect(
      render(h(GradientScale, { positionPct: -5, stops: "aqi" })),
    ).toContain('data-marker-pct="0"');
  });

  it("keeps the accessible text: a named image with the position", () => {
    const html = render(
      h(GradientScale, { positionPct: 24.7, stops: "aqi", label: "US AQI 74" }),
    );
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="US AQI 74: 25% along the scale"');
  });

  it("sizes the track and marker by token, never by the card's width", () => {
    const html = render(h(GradientScale, { positionPct: 50, stops: "aqi" }));
    expect(html).toContain("h-[var(--wx-scale-track-height)]");
    expect(html).toContain("size-[var(--wx-scale-marker-size)]");
    expect(html).toContain("max-w-[var(--wx-scale-max-width)]");
    // No viewBox that scales with the container (the 85px marker bug).
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("viewBox");
    expect(html).not.toContain("h-auto");
  });

  it("keeps the 3:1 outline on the track and an outlined marker", () => {
    const html = render(h(GradientScale, { positionPct: 50, stops: "aqi" }));
    expect(html).toContain("ring-wx-outline");
    expect(html).toContain("border-text-primary");
    expect(html).toContain("bg-surface-card");
  });

  it("draws a sub-range as a window onto the same full-track gradient", () => {
    const html = render(
      h(GradientScale, {
        positionPct: 60,
        stops: "temperature",
        rangeStartPct: 20,
        rangeEndPct: 80,
      }),
    );
    // Window: 20% to 80% of the track; the gradient inside is the full track
    // (100 / 0.6 = 166.67% of the window) starting 20/60 = 33.33% to the left.
    expect(html).toContain("left:20%;width:60%");
    expect(html).toContain("left:-33.33%;width:166.67%");
    expect(html).toContain("var(--wx-temp-1) 0%");
    expect(html).toContain("var(--wx-temp-9) 100%");
  });
});

describe("GradientScale source", () => {
  const src = readFileSync(join(__dirname, "GradientScale.tsx"), "utf8");

  it("has no hex, rgba or hard-coded size", () => {
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/rgba?\(/);
    // The only inline styles are computed positions and the token gradient.
    expect(src).not.toMatch(/style=\{\{[^}]*(color|fill|stroke)/);
    expect(src).not.toMatch(/\b(?:h|w|size)-\[\d/);
  });

  it("never sizes the track or marker as a share of the container", () => {
    const sizing = src.match(/className="[^"]*"/g)!.join(" ");
    expect(sizing).not.toMatch(/\bh-(full|auto|screen)\b/);
    expect(sizing).not.toMatch(/\b(?:h|size)-\[?\d+%/);
    expect(sizing).not.toMatch(/\baspect-/);
  });
});

describe("ScaleReadout", () => {
  it("shows the big value and level text above the scale", () => {
    const html = render(
      h(ScaleReadout, {
        value: 114,
        label: "Unhealthy",
        positionPct: 40,
        preset: "aqi",
      }),
    );
    expect(html).toContain(">114<");
    expect(html).toContain("Unhealthy");
    expect(html).toContain('data-marker-pct="40"');
  });
});

describe("SunArc", () => {
  it("describes daylight progress", () => {
    const html = render(
      h(SunArc, { arcPct: 50, sunrise: "06:12", sunset: "18:03" }),
    );
    expect(html).toContain("50% of daylight travelled");
    expect(html).toContain("06:12");
    expect(html).toContain('data-sun-x="100"');
  });

  it("parks the marker below the horizon at night", () => {
    const html = render(
      h(SunArc, { arcPct: null, sunrise: "06:12", sunset: "18:03" }),
    );
    expect(html).toContain("night");
    expect(html).toContain('data-sun-y="88"');
  });
});

describe("MoonDisc", () => {
  it("labels illumination and phase direction", () => {
    const html = render(h(MoonDisc, { phase: 0.3, illumination: 0.45 }));
    expect(html).toContain('aria-label="Moon, 45% illuminated, waxing"');
  });

  it("mirrors the lit side for the southern hemisphere", () => {
    const html = render(
      h(MoonDisc, { phase: 0.25, illumination: 0.5, southernHemisphere: true }),
    );
    expect(html).toContain('transform="scale(-1 1)"');
  });

  it("draws no lit path for a new moon", () => {
    const html = render(h(MoonDisc, { phase: 0, illumination: 0 }));
    expect(html).not.toContain("fill-moon-lit");
  });
});

describe("PressureDial", () => {
  it("labels the reading and trend, and prints the arrow", () => {
    const html = render(h(PressureDial, { hPa: 1013, trend: "falling" }));
    expect(html).toContain('aria-label="Pressure 1013 hPa, falling"');
    expect(html).toContain("↓");
  });

  it("renders the default 960–1050 scale ends", () => {
    const html = render(h(PressureDial, { hPa: 1000, trend: "steady" }));
    expect(html).toContain(">960<");
    expect(html).toContain(">1050<");
    expect(html).toContain("→");
  });
});

describe("text outside the SVG (the 14px floor, stage 2 of #479)", () => {
  // SVG text scales with the viewBox, so it drew at 7 to 13px in a phone-width
  // tile. The dials print their labels in HTML at text-sm (14px) instead.
  const dials = {
    CompassDial: render(
      h(CompassDial, { directionDeg: 70, speed: 5, gust: 14 }),
    ),
    PressureDial: render(h(PressureDial, { hPa: 1013, trend: "falling" })),
    SunArc: render(
      h(SunArc, { arcPct: 50, sunrise: "06:12", sunset: "18:03" }),
    ),
  };

  for (const [name, html] of Object.entries(dials)) {
    it(`${name} draws no SVG text and no size under 14px`, () => {
      expect(html).not.toContain("<text");
      expect(html).not.toContain("<tspan");
      expect(html).not.toMatch(/text-\[\d/);
      expect(html).toContain("text-sm");
    });
  }

  it("CompassDial prints N, E, S, W, the speed and the gust as HTML", () => {
    const html = dials.CompassDial;
    for (const letter of ["N", "E", "S", "W"]) {
      expect(html).toContain(`>${letter}</span>`);
    }
    expect(html).toContain(">5</span>");
    expect(html).toContain("km/h");
    expect(html).toContain("gusts 14");
    // Said once, by the SVG's own label: the HTML copy is hidden from readers.
    expect(html.match(/aria-hidden="true"/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it("PressureDial and SunArc print their scale ends and times as HTML", () => {
    expect(dials.PressureDial).toContain("<span>960</span>");
    expect(dials.PressureDial).toContain("<span>1050</span>");
    expect(dials.PressureDial).toContain("1013");
    expect(dials.SunArc).toContain("<span>06:12</span>");
    expect(dials.SunArc).toContain("<span>18:03</span>");
  });
});

describe("MiniBars", () => {
  it("renders one bar per value and emphasises the highlighted one", () => {
    const html = render(
      h(MiniBars, {
        values: [0, 2, 4],
        highlightIndex: 2,
        label: "Rain next 3 hours",
      }),
    );
    expect(html.match(/<rect/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Rain next 3 hours: 3 values"');
    expect(html.lastIndexOf('fill-primary"')).toBeGreaterThan(
      html.indexOf("fill-primary/35"),
    );
  });
});

describe("InsightCard", () => {
  it("is labelled by its heading and carries the size", () => {
    const html = render(
      h(InsightCard, {
        icon: h("span", null, "i"),
        label: "WIND",
        headingId: "wind-h",
        sentence: "Light breeze.",
        size: "hero",
        children: h("p", null, "body"),
      }),
    );
    expect(html).toContain('aria-labelledby="wind-h"');
    expect(html).toContain('id="wind-h"');
    expect(html).toContain('data-size="hero"');
    expect(html).toContain("col-span-full");
    expect(html).toContain("Light breeze.");
    expect(html).toContain('aria-hidden="true"');
  });

  it("defaults to square and omits the sentence when absent", () => {
    const html = render(
      h(InsightCard, {
        icon: null,
        label: "UV",
        headingId: "uv-h",
        children: h("p", null, "x"),
      }),
    );
    expect(html).toContain('data-size="square"');
    expect(html).not.toContain("dove leading-snug");
  });

  it("InsightGrid is 2 columns, and 4 only when its own column is wide (container query, not the viewport)", () => {
    const html = render(h(InsightGrid, null, h("div", null, "a")));
    expect(html).toContain("@container");
    expect(html).toContain("grid-cols-2");
    expect(html).toContain("@3xl:grid-cols-4");
    expect(html).not.toContain("lg:grid-cols-4");
  });

  it("InsightCardSkeleton is a labelled status region", () => {
    const html = render(h(InsightCardSkeleton, { size: "wide" }));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Loading"');
    expect(html).toContain("col-span-full");
  });

  it("maps sizes to layout classes", () => {
    // A minimum height, never a fixed 1:1 box: a square at phone width is
    // ~170px and the content overflowed it.
    expect(insightCardSizeClass("square")).toBe(
      "min-h-[var(--size-insight-square-min)]",
    );
    expect(insightCardSizeClass("wide")).toBe("col-span-full");
    expect(insightCardSizeClass("hero")).toContain(
      "max-h-[var(--size-insight-hero-max)]",
    );
  });
});
