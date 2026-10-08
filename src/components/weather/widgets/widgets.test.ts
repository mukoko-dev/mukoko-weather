import { describe, it, expect } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
    expect(html).toContain('data-marker-cx="42"');
  });

  it("clamps the marker into 0–100", () => {
    expect(
      render(h(GradientScale, { positionPct: 150, stops: "aqi" })),
    ).toContain('data-marker-cx="100"');
    expect(
      render(h(GradientScale, { positionPct: -5, stops: "aqi" })),
    ).toContain('data-marker-cx="0"');
  });

  it("draws a sub-range and uses an outlined marker", () => {
    const html = render(
      h(GradientScale, {
        positionPct: 60,
        stops: "temperature",
        rangeStartPct: 20,
        rangeEndPct: 80,
      }),
    );
    expect(html).toContain('x="20"');
    expect(html).toContain("stroke-text-primary");
    expect(html).toContain("fill-surface-card");
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
    expect(html).toContain('data-marker-cx="40"');
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

  it("InsightGrid is 2 columns on mobile and 4 on large screens", () => {
    const html = render(h(InsightGrid, null, h("div", null, "a")));
    expect(html).toContain("grid-cols-2");
    expect(html).toContain("lg:grid-cols-4");
  });

  it("InsightCardSkeleton is a labelled status region", () => {
    const html = render(h(InsightCardSkeleton, { size: "wide" }));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Loading"');
    expect(html).toContain("col-span-full");
  });

  it("maps sizes to layout classes", () => {
    expect(insightCardSizeClass("square")).toBe("aspect-square");
    expect(insightCardSizeClass("wide")).toBe("col-span-full");
    expect(insightCardSizeClass("hero")).toContain(
      "max-h-[var(--size-insight-hero-max)]",
    );
  });
});
